import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { isBilledRow, TRACE_TIER } from "@/lib/trace/billedRows";
import { BLOCKED_PROPERTY_RECORD_KEYS } from "@/lib/trace/publicPropertyRecord";
import entityHitAddress from "@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json";

/**
 * Money fence for the session-side single-trace status route.
 *
 * `deduct_wallet_balance` RETURNS BOOLEAN and returns FALSE **without moving
 * any money** when the wallet is short (supabase/schema.sql:290). This route is
 * the worst place to ignore that answer, because the charge it computes leaves
 * the process through THREE doors:
 *   1. `trace_history.charge`   (the ledger the dashboard SUMs)
 *   2. the JSON response body   (what the customer's UI shows)
 *   3. the `trace.completed` webhook payload (what a third-party system books)
 *
 * These tests pin all three to the amount ACTUALLY collected. Delete the guard
 * in lib/wallet/deduct.ts and the false-path test must go red.
 */

const H = vi.hoisted(() => ({
  /** Envelope `deduct_wallet_balance` resolves with. false => wallet short. */
  deductResult: true as boolean,
  profile: null as unknown as Record<string, unknown>,
  trace: null as unknown as Record<string, unknown>,
  jobStatus: null as unknown as Record<string, unknown>,
  updates: [] as Array<{
    table: string;
    payload: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>,
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
  /** What the fire-and-forget HighLevel push resolves with. */
  pushResult: { success: true, contactId: "c-1", action: "created" } as Record<string, unknown>,
}));

/** Minimal PostgREST-shaped builder: chainable AND awaitable, like the real one. */
function chainTo(data: unknown) {
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.eq = self;
  node.ilike = self;
  node.limit = () => Promise.resolve({ data, error: null });
  node.single = () => Promise.resolve({ data, error: null });
  node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(res, rej);
  return node;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => chainTo(table === "user_profiles" ? H.profile : H.trace),
      update: (payload: Record<string, unknown>) => {
        // The filters are recorded, not swallowed: a push record has to name
        // the row it belongs to, and the payload alone cannot say which.
        const filters: Array<[string, ...unknown[]]> = [];
        H.updates.push({ table, payload, filters });
        const node = chainTo(null) as Record<string, unknown>;
        node.eq = (...args: unknown[]) => {
          filters.push(["eq", ...args]);
          return node;
        };
        return node;
      },
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      H.rpcCalls.push([fn, args]);
      return Promise.resolve(
        fn === "deduct_wallet_balance"
          ? { data: H.deductResult, error: null }
          : { data: null, error: null }
      );
    },
  }),
}));

vi.mock("@/lib/tracerfy/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tracerfy/client")>();
  return { ...actual, getJobStatus: async () => H.jobStatus };
});

vi.mock("@/lib/utils/auto-rebill", () => ({
  triggerAutoRebillIfNeeded: vi.fn(async () => {}),
}));
vi.mock("@/lib/highlevel/client", () => ({
  pushTraceToHighLevel: vi.fn(async () => H.pushResult),
}));

/**
 * The handle the fence at the bottom of this file asserts on. The mock stays
 * even though nothing calls it: it is what makes "was HighLevel called" a
 * question this file can ask at all.
 */
const { pushTraceToHighLevel } = await import("@/lib/highlevel/client");

const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));

beforeEach(() => {
  H.updates = [];
  H.rpcCalls = [];
  H.deductResult = true;
  H.pushResult = { success: true, contactId: "c-1", action: "created" };
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);

  // Pay-as-you-go wallet user => chargePerTrace = CHARGE_PER_SUCCESS_WALLET.
  // Both user_profiles selects (pricing columns, then integration columns)
  // read this same object, so it carries every column either one asks for.
  H.profile = {
    id: "user-1",
    subscription_tier: "wallet",
    wallet_balance: 0,
    wallet_low_balance_threshold: 5,
    wallet_auto_rebill_enabled: false,
    is_acquisition_pro_member: false,
    gateway_products: null,
    webhook_url: "https://customer.example.com/hook",
    highlevel_api_key: null,
    highlevel_location_id: null,
  };

  H.trace = {
    id: "trace-1",
    user_id: "user-1",
    status: "processing",
    tracerfy_job_id: "tj-1",
    created_at: new Date().toISOString(),
    normalized_address: "123 MAIN ST",
    city: "Austin",
    state: "TX",
    zip: "78701",
    ai_research: null,
  };

  // A real, contact-bearing Tracerfy row => isSuccessful === true => billable.
  H.jobStatus = {
    success: true,
    pending: false,
    results: [
      {
        address: "123 MAIN ST",
        city: "Austin",
        state: "TX",
        first_name: "Jane",
        last_name: "Doe",
        primary_phone: "5125550100",
        email_1: "jane@example.com",
      },
    ],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The billing update is the one carrying a `charge` key. */
function billingUpdate() {
  return H.updates.find(
    (u) => u.table === "trace_history" && "charge" in u.payload
  );
}

/** Body of the fire-and-forget `trace.completed` webhook POST. */
function webhookBody() {
  const call = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
  return call ? JSON.parse(call[1].body) : null;
}

describe("trace/status route reports only the wallet amount actually collected", () => {
  it("records and reports 0 when deduct_wallet_balance returns false", async () => {
    H.deductResult = false;

    const { GET } = await import("@/app/api/trace/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1")
    );
    const body = await res.json();

    // A deduct was genuinely attempted at the intended rate...
    expect(H.rpcCalls.filter((c) => c[0] === "deduct_wallet_balance")).toHaveLength(1);
    expect(H.rpcCalls[0][1].p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);

    // ...but nothing moved, so nothing may be recorded or reported.
    // Door 1: the ledger row.
    expect(billingUpdate()?.payload.charge).toBe(0);
    // Door 2: the HTTP response body.
    expect(body.charge).toBe(0);
    // Door 3: the outbound webhook payload.
    expect(webhookBody().charge).toBe(0);

    // The customer's data survives a short wallet.
    expect(body.status).toBe("success");
    expect(body.result.phones).toHaveLength(1);
    expect(billingUpdate()?.payload.status).toBe("success");
    expect(billingUpdate()?.payload.is_successful).toBe(true);
  });

  it("never sends the internal parcel key as the webhook's address (D38)", async () => {
    // MUTATION: send `address: trace.normalized_address` again and this goes red.
    H.deductResult = true;
    H.trace = {
      ...H.trace,
      normalized_address: "APN|0123-456|TRAVIS|TX",
      city: null,
      state: "TX",
      parcel_id_local: "0123-456",
      county: "Travis",
    };

    const { GET } = await import("@/app/api/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"));

    expect(webhookBody().address).toBe("Parcel 0123-456, Travis County");
  });

  it("records and reports the full rate when the deduct succeeds", async () => {
    H.deductResult = true;

    const { GET } = await import("@/app/api/trace/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1")
    );
    const body = await res.json();

    const rate = PRICING.CHARGE_PER_SUCCESS_WALLET;
    expect(billingUpdate()?.payload.charge).toBe(rate);
    expect(body.charge).toBe(rate);
    expect(webhookBody().charge).toBe(rate);
  });
});

describe("trace/status route stamps the billing model onto the ledger row", () => {
  it("writes tier = 1 alongside the charge", async () => {
    // $0.25 is BOTH the tier 1 Pay-As-You-Go per-success rate and the tier 2
    // Pro per-record rate (lib/constants.ts:34-36). Without `tier` the row is
    // ambiguous and no refund or revenue split can be computed from it.
    // MUTATION: remove `tier:` from the update payload and this goes red.
    H.deductResult = true;

    const { GET } = await import("@/app/api/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.tier).toBe(TRACE_TIER.PER_SUCCESSFUL_TRACE);
  });

  it("writes tier = 1 on a no-match too, where the charge is 0", async () => {
    // Tier is a property of the BILLING MODEL, not of the outcome. A free
    // no-match is still "tier 1 rules applied", and that is the fact a tier 2
    // billed miss has to be distinguishable from.
    H.deductResult = true;
    H.jobStatus = { success: true, pending: false, results: [] };

    const { GET } = await import("@/app/api/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.charge).toBe(0);
    expect(billingUpdate()?.payload.tier).toBe(TRACE_TIER.PER_SUCCESSFUL_TRACE);
  });
});

/* ====================================================================
 * A ROW THAT WAS BILLED MUST NEVER BECOME UNBILLED.
 *
 * `charge` and `tier` are RECEIPTS, and until 2026-09-17 this settle
 * treated them as scratch fields. The sequence needed no error at all:
 * trace an address with no owner, tier 2 charges per record submitted,
 * the county has no parcel, and the row lands
 * `tier = 2, charge > 0, property_record = NULL, status = no_match`.
 * Trace the SAME address again WITH an owner name, it goes tier 1,
 * settles here, and both receipt columns were overwritten.
 *
 * The row then read UNBILLED to excludeBilledRows while a
 * wallet_transactions row still referenced it by FK, so the next submit's
 * failed sweep raised 23503, runDelete collected it, and that address
 * answered "Failed to clear previous trace" FOREVER.
 * ==================================================================== */
describe("trace/status route never writes a billed row back to unbilled", () => {
  beforeEach(() => {
    // The row as the tier 2 submit left it, now being polled after a tier 1
    // resubmit reused it.
    H.trace = {
      ...H.trace,
      tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      charge: 0.25,
      property_record: null,
    };
    // Tier 1 found nothing, so this settle collects nothing.
    H.jobStatus = { success: true, pending: false, results: [] };
  });

  it("keeps the 0.25 the customer already paid", async () => {
    // WAS: 0. MUTATION: write `charge` straight from this settle again and
    // this goes red.
    const { GET } = await import("@/app/api/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.charge).toBe(0.25);
  });

  it("does not downgrade tier 2 to tier 1", async () => {
    // WAS: 1. Downgrading alone breaks isCacheHitRow's `tier = 2 AND
    // charge > 0` arm, so a billed tier 2 miss silently starts re-buying.
    // MUTATION: write TRACE_TIER.PER_SUCCESSFUL_TRACE again and this goes red.
    const { GET } = await import("@/app/api/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.tier).toBe(TRACE_TIER.PER_RECORD_SUBMITTED);
  });

  it("leaves a row the delete guard still refuses to touch", async () => {
    // The lockout, asserted through the guard that was failing rather than
    // through the columns it reads.
    const { GET } = await import("@/app/api/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"));

    const written = billingUpdate()!.payload;
    expect(isBilledRow({ charge: written.charge as number, property_record: null })).toBe(true);
  });

  it("reports the tier it WROTE, not the one this settle applied", async () => {
    const { GET } = await import("@/app/api/trace/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"))
    ).json();

    expect(body.tier).toBe(TRACE_TIER.PER_RECORD_SUBMITTED);
  });

  it("adds a second real collection to the first rather than replacing it", async () => {
    // Two genuine debits against one address are two rows in
    // wallet_transactions, and the dashboard SUMs trace_history.charge. Writing
    // only the latest would under-report what the customer was charged.
    // MUTATION: replace instead of fold and this goes red.
    H.jobStatus = {
      success: true,
      pending: false,
      results: [
        {
          address: "123 MAIN ST",
          city: "Austin",
          state: "TX",
          first_name: "Jane",
          last_name: "Doe",
          primary_phone: "5125550100",
          email_1: "jane@example.com",
        },
      ],
    };

    const { GET } = await import("@/app/api/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.charge).toBe(0.25 + PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("leaves an ordinary tier 1 row exactly as it always was", async () => {
    // The fold must be invisible to the row shape that has no receipt yet,
    // which is almost every row.
    H.trace = { ...H.trace, tier: null, charge: 0, property_record: null };

    const { GET } = await import("@/app/api/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.charge).toBe(0);
    expect(billingUpdate()?.payload.tier).toBe(TRACE_TIER.PER_SUCCESSFUL_TRACE);
  });
});

describe("trace/status route tells the truth about which failure happened", () => {
  it("does not blame the balance when the deduct RPC itself errored", async () => {
    // lib/wallet/deduct.ts used to answer 0 for an insufficient balance AND for
    // a transport or Postgres error, so a customer with a full wallet was told
    // they were short. Here the only visible surface is the log and the amount,
    // and the amount must still be the one that moved: nothing.
    // MUTATION: collapse the two outcomes back into one and the log line goes.
    const { deductWallet } = await import("@/lib/wallet/deduct");
    const broken = await deductWallet(
      { rpc: async () => ({ data: null, error: { message: "connection reset" } }) },
      { p_user_id: "user-1", p_amount: 0.25, p_description: "x" }
    );
    const short = await deductWallet(
      { rpc: async () => ({ data: false, error: null }) },
      { p_user_id: "user-1", p_amount: 0.25, p_description: "x" }
    );

    expect(broken.outcome).toBe("error");
    expect(short.outcome).toBe("insufficient_balance");
    expect(broken.collected).toBe(0);
    expect(short.collected).toBe(0);
  });
});

/**
 * Retrieving the record the customer already paid for.
 *
 * A Full Property Trace bills per RECORD SUBMITTED, so a Pay-As-You-Go customer
 * is charged $0.40 the moment they submit. Close the tab before the page
 * renders and the 86-field county record was unreachable: this route returned
 * neither `property_record` nor `tier`, and the trace page reads both off this
 * response and was handed null every time. Nothing below re-buys anything.
 */
describe("trace/status route serves back the record already bought", () => {
  it("returns the stored property record and tier on a finished trace", async () => {
    // MUTATION: drop property_record from the completed branch and this goes
    // red, which is the state the customer was actually in.
    H.trace = {
      ...H.trace,
      status: "success",
      tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      charge: 0.4,
      property_record: { apn: "16-18-306-029", county: "Salt Lake County" },
      trace_result: { phones: [], emails: [] },
    };

    const { GET } = await import("@/app/api/trace/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1")
    );
    const body = await res.json();

    expect(body.property_record).toEqual({
      apn: "16-18-306-029",
      county: "Salt Lake County",
    });
    expect(body.tier).toBe(TRACE_TIER.PER_RECORD_SUBMITTED);
    expect(body.charge).toBe(0.4);
  });

  it("charges nothing to hand back a record already paid for", async () => {
    // Retrieval is not a purchase. No vendor call, no deduct, no second bill.
    H.trace = {
      ...H.trace,
      status: "no_match",
      tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      charge: 0.4,
      property_record: { apn: "16-18-306-029" },
    };

    const { GET } = await import("@/app/api/trace/status/route");
    await GET(
      new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1")
    );

    expect(H.rpcCalls).toHaveLength(0);
    expect(H.updates).toHaveLength(0);
  });

  it("reports null rather than inventing a record when there is none", async () => {
    H.trace = { ...H.trace, status: "no_match", tier: null, charge: 0 };

    const { GET } = await import("@/app/api/trace/status/route");
    const body = await (
      await GET(
        new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1")
      )
    ).json();

    expect(body.property_record).toBeNull();
    expect(body.tier).toBeNull();
  });

  it("names the tier it just billed when it settles a poll", async () => {
    const { GET } = await import("@/app/api/trace/status/route");
    const body = await (
      await GET(
        new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1")
      )
    ).json();

    expect(body.tier).toBe(TRACE_TIER.PER_SUCCESSFUL_TRACE);
    expect(body.property_record).toBeNull();
  });
});

/* ====================================================================
 * THE POLL IS AN EGRESS TOO.
 *
 * This route re-reads a record the customer already bought. The row holds
 * the raw 86 keys; the response publishes 65. Without this the 21 blocked
 * fields would simply arrive on the SECOND request instead of the first,
 * which is not a gate, it is a delay.
 * ==================================================================== */

describe("trace/status route publishes 65 of the stored 86 keys", () => {
  const STORED_RAW = (
    entityHitAddress as { response: { property: Record<string, unknown> } }
  ).response.property;

  it("carries no blocked key on a finished trace", async () => {
    // MUTATION: drop toPublicPropertyRecord from the completed branch and this
    // goes red.
    H.trace = {
      ...H.trace,
      status: "success",
      tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      charge: 0.4,
      property_record: STORED_RAW,
      trace_result: { phones: [], emails: [] },
    };

    const { GET } = await import("@/app/api/trace/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"))
    ).json();

    expect(Object.keys(body.property_record)).toHaveLength(65);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(body.property_record, `${key} left PTP on a poll`).not.toHaveProperty(key);
    }
    expect(body.property_record.assessed_value).toBe(STORED_RAW.assessed_value);
  });

  it("carries no blocked key on the branch that settles a tier 1 poll", async () => {
    // MUTATION: drop toPublicPropertyRecord from the settle branch and this
    // goes red. A row is not supposed to arrive here with a record on it, but
    // if one does it must not be the one door that publishes 86.
    H.trace = { ...H.trace, property_record: STORED_RAW };

    const { GET } = await import("@/app/api/trace/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"))
    ).json();

    expect(Object.keys(body.property_record)).toHaveLength(65);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(body.property_record, `${key} left PTP on a settled poll`).not.toHaveProperty(key);
    }
  });

  it("does not mutate the stored row while filtering it", async () => {
    const row: Record<string, unknown> = { ...STORED_RAW };
    H.trace = { ...H.trace, status: "success", property_record: row, trace_result: null };

    const { GET } = await import("@/app/api/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1"));

    expect(Object.keys(row)).toHaveLength(86);
  });
});

/**
 * THE FENCE. THIS ROUTE MUST NEVER CALL HIGHLEVEL.
 *
 * PTP's own push only ever creates Contacts. Most PTP users reach their CRM
 * through the Suite Gateway, which holds the GoHighLevel snapshot and knows the
 * object model: an entity owner is a Company, a person is a Contact and only
 * when there is a phone or an email, and the property hangs on a property
 * custom object. An automatic push from here writes the WRONG OBJECT TYPE into
 * that snapshot, and for a user with no gateway there is no snapshot for it to
 * populate at all.
 *
 * So the rule is a single sentence: PTP never calls HighLevel unless a person
 * asked it to. The only thing that asks is the Push to CRM button, which is
 * app/api/integrations/highlevel/push.
 *
 * This test sets up EXACTLY the conditions that used to push -- credentials on
 * the profile, a successful trace with contacts on it -- and asserts the client
 * was not called. Re-adding a push here turns it red.
 */
describe("trace/status never pushes to HighLevel", () => {
  /** One macrotask tick, which flushes every pending microtask in these mocks. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    // The conditions under which this route USED to push.
    H.profile = {
      ...H.profile,
      highlevel_api_key: "key-1",
      highlevel_location_id: "loc-1",
    };
    vi.mocked(pushTraceToHighLevel).mockClear();
  });

  it("does not call HighLevel on a successful trace, credentials and all", async () => {
    const { GET } = await import("@/app/api/trace/status/route");
    await GET(
      new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1")
    );
    await settle();

    expect(pushTraceToHighLevel).not.toHaveBeenCalled();
  });

  it("writes no push record and no credential verdict, because nothing was pushed", async () => {
    // The two writes a push used to leave behind. Neither may appear when
    // nothing reached the CRM: a row that reads as pushed is a lie, and a
    // credential verdict from a call nobody made is a verdict on nothing.
    const { GET } = await import("@/app/api/trace/status/route");
    await GET(
      new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1")
    );
    await settle();

    expect(
      H.updates.filter(
        (u) => u.table === "trace_history" && "highlevel_pushed_at" in u.payload
      )
    ).toEqual([]);
    expect(
      H.updates.filter(
        (u) => u.table === "user_profiles" && "highlevel_invalid_at" in u.payload
      )
    ).toEqual([]);
  });

  it("still settles the trace and returns the result the customer paid for", async () => {
    // The removal took the push out, not the trace. A green fence on a route
    // that stopped working would be worthless.
    const { GET } = await import("@/app/api/trace/status/route");
    const body = await (
      await GET(
        new Request("https://proptracerpro.com/api/trace/status?trace_id=trace-1")
      )
    ).json();
    await settle();

    expect(body.success).toBe(true);
    expect(body.status).toBe("success");
    expect(body.result.phones).toHaveLength(1);
  });
});
