import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getChargePerTrace } from "@/lib/constants";
import { isBilledRow, TRACE_TIER } from "@/lib/trace/billedRows";
import { BLOCKED_PROPERTY_RECORD_KEYS } from "@/lib/trace/publicPropertyRecord";
import entityHitAddress from "@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json";

/**
 * Money fence for the API-key single-trace status route.
 *
 * Same defect as the session route: `deduct_wallet_balance` RETURNS BOOLEAN and
 * returns FALSE without moving money when the wallet is short, and this route
 * wrote/reported the INTENDED amount regardless. It has the same three doors --
 * `trace_history.charge`, the JSON body, and the `trace.completed` webhook --
 * and this is the surface integrators reconcile their own books against.
 */

const H = vi.hoisted(() => ({
  deductResult: true as boolean,
  apiProfile: null as unknown as Record<string, unknown>,
  integrationProfile: null as unknown as Record<string, unknown>,
  trace: null as unknown as Record<string, unknown>,
  jobStatus: null as unknown as Record<string, unknown>,
  updates: [] as Array<{
    table: string;
    payload: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>,
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
  /** What the fire-and-forget HighLevel push resolves with. */
  pushResult: { success: true, contactId: "c-1", action: "created" } as Record<
    string,
    unknown
  >,
}));

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

vi.mock("@/lib/api/auth", () => ({
  validateApiKey: async () => ({ profile: H.apiProfile }),
  isAuthError: () => false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () =>
        chainTo(table === "user_profiles" ? H.integrationProfile : H.trace),
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

const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));

beforeEach(() => {
  H.updates = [];
  H.pushResult = { success: true, contactId: "c-1", action: "created" };
  H.rpcCalls = [];
  H.deductResult = true;
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);

  H.apiProfile = {
    id: "user-1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
  };
  H.integrationProfile = {
    webhook_url: "https://integrator.example.com/hook",
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

function billingUpdate() {
  return H.updates.find(
    (u) => u.table === "trace_history" && "charge" in u.payload
  );
}

function webhookBody() {
  const call = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
  return call ? JSON.parse(call[1].body) : null;
}

describe("v1 trace/status route reports only the wallet amount actually collected", () => {
  it("records and reports 0 when deduct_wallet_balance returns false", async () => {
    H.deductResult = false;

    const { GET } = await import("@/app/api/v1/trace/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1")
    );
    const body = await res.json();

    expect(H.rpcCalls.filter((c) => c[0] === "deduct_wallet_balance")).toHaveLength(1);
    expect(H.rpcCalls[0][1].p_amount).toBe(getChargePerTrace("wallet", false));

    expect(billingUpdate()?.payload.charge).toBe(0);
    expect(body.charge).toBe(0);
    expect(webhookBody().charge).toBe(0);

    // The trace result is still persisted and still returned.
    expect(body.status).toBe("success");
    expect(body.result.phones).toHaveLength(1);
    expect(billingUpdate()?.payload.is_successful).toBe(true);
  });

  it("records and reports the full rate when the deduct succeeds", async () => {
    H.deductResult = true;

    const { GET } = await import("@/app/api/v1/trace/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1")
    );
    const body = await res.json();

    const rate = getChargePerTrace("wallet", false);
    expect(billingUpdate()?.payload.charge).toBe(rate);
    expect(body.charge).toBe(rate);
    expect(webhookBody().charge).toBe(rate);
  });

  it("stamps tier = 1 alongside the charge", async () => {
    // $0.25 is BOTH the tier 1 Pay-As-You-Go per-success rate and the tier 2
    // Pro per-record rate (lib/constants.ts:34-36), so the amount alone cannot
    // say which model produced the row.
    // MUTATION: remove `tier:` from the update payload and this goes red.
    H.deductResult = true;

    const { GET } = await import("@/app/api/v1/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.tier).toBe(TRACE_TIER.PER_SUCCESSFUL_TRACE);
  });
});

/* ====================================================================
 * A ROW THAT WAS BILLED MUST NEVER BECOME UNBILLED.
 *
 * Same lockout as the session status route. `charge` and `tier` are
 * RECEIPTS and this settle used to treat them as scratch fields, so a
 * tier 2 row reused by a later tier 1 trace came out of here reading
 * UNBILLED while a wallet_transactions row still referenced it by FK.
 * The next submit's failed sweep then raised 23503 and that address
 * answered "Failed to clear previous trace" FOREVER.
 * ==================================================================== */
describe("v1 trace/status route never writes a billed row back to unbilled", () => {
  beforeEach(() => {
    H.trace = {
      ...H.trace,
      tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      charge: 0.4,
      property_record: null,
    };
    H.jobStatus = { success: true, pending: false, results: [] };
  });

  it("keeps the 0.40 the integrator already paid", async () => {
    // WAS: 0. MUTATION: write `charge` straight from this settle again and
    // this goes red.
    const { GET } = await import("@/app/api/v1/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.charge).toBe(0.4);
  });

  it("does not downgrade tier 2 to tier 1", async () => {
    // WAS: 1. Downgrading alone breaks isCacheHitRow's `tier = 2 AND
    // charge > 0` arm, so a billed tier 2 miss silently starts re-buying.
    const { GET } = await import("@/app/api/v1/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.tier).toBe(TRACE_TIER.PER_RECORD_SUBMITTED);
  });

  it("leaves a row the delete guard still refuses to touch", async () => {
    const { GET } = await import("@/app/api/v1/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1"));

    const written = billingUpdate()!.payload;
    expect(isBilledRow({ charge: written.charge as number, property_record: null })).toBe(true);
  });

  it("reports the tier it WROTE, not the one this settle applied", async () => {
    const { GET } = await import("@/app/api/v1/trace/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1"))
    ).json();

    expect(body.tier).toBe(TRACE_TIER.PER_RECORD_SUBMITTED);
  });

  it("adds a second real collection to the first rather than replacing it", async () => {
    // Two genuine debits against one address are two rows in
    // wallet_transactions, and the dashboard SUMs trace_history.charge.
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

    const { GET } = await import("@/app/api/v1/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.charge).toBe(0.4 + getChargePerTrace("wallet", false));
  });

  it("leaves an ordinary tier 1 row exactly as it always was", async () => {
    H.trace = { ...H.trace, tier: null, charge: 0, property_record: null };

    const { GET } = await import("@/app/api/v1/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1"));

    expect(billingUpdate()?.payload.charge).toBe(0);
    expect(billingUpdate()?.payload.tier).toBe(TRACE_TIER.PER_SUCCESSFUL_TRACE);
  });
});

/**
 * Retrieving the record the integrator already paid for.
 *
 * Tier 2 bills per RECORD SUBMITTED. Polling is the documented way an API
 * caller collects an async result, and this route returned neither
 * `property_record` nor `tier`, so the 86-field county record they were charged
 * for had no retrieval path at all. Nothing below re-buys anything.
 */
describe("v1 trace/status route serves back the record already bought", () => {
  it("returns the stored property record and tier on a finished trace", async () => {
    // MUTATION: drop property_record from the completed branch and this goes red.
    H.trace = {
      ...H.trace,
      status: "success",
      tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      charge: 0.4,
      property_record: { apn: "16-18-306-029", county: "Salt Lake County" },
      trace_result: { phones: [], emails: [] },
    };

    const { GET } = await import("@/app/api/v1/trace/status/route");
    const body = await (
      await GET(
        new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1")
      )
    ).json();

    expect(body.property_record).toEqual({
      apn: "16-18-306-029",
      county: "Salt Lake County",
    });
    expect(body.tier).toBe(TRACE_TIER.PER_RECORD_SUBMITTED);
  });

  it("charges nothing to hand back a record already paid for", async () => {
    H.trace = {
      ...H.trace,
      status: "no_match",
      tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      charge: 0.4,
      property_record: { apn: "16-18-306-029" },
    };

    const { GET } = await import("@/app/api/v1/trace/status/route");
    await GET(
      new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1")
    );

    expect(H.rpcCalls).toHaveLength(0);
    expect(H.updates).toHaveLength(0);
  });

  it("reports null rather than inventing a record when there is none", async () => {
    H.trace = { ...H.trace, status: "no_match", tier: null, charge: 0 };

    const { GET } = await import("@/app/api/v1/trace/status/route");
    const body = await (
      await GET(
        new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1")
      )
    ).json();

    expect(body.property_record).toBeNull();
    expect(body.tier).toBeNull();
  });

  it("names the tier it just billed when it settles a poll", async () => {
    const { GET } = await import("@/app/api/v1/trace/status/route");
    const body = await (
      await GET(
        new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1")
      )
    ).json();

    expect(body.tier).toBe(TRACE_TIER.PER_SUCCESSFUL_TRACE);
    expect(body.property_record).toBeNull();
  });
});

/* ====================================================================
 * THE POLL IS AN EGRESS TOO, AND ON v1 IT IS A PUBLIC ONE.
 *
 * This route re-reads a record the integrator already bought. The row holds
 * the raw 86 keys; the response publishes 65. Without this the 21 blocked
 * fields would simply arrive on the POLL instead of the submit, which is not
 * a gate, it is a delay.
 * ==================================================================== */

describe("v1 trace/status route publishes 65 of the stored 86 keys", () => {
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

    const { GET } = await import("@/app/api/v1/trace/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1"))
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

    const { GET } = await import("@/app/api/v1/trace/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1"))
    ).json();

    expect(Object.keys(body.property_record)).toHaveLength(65);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(body.property_record, `${key} left PTP on a settled poll`).not.toHaveProperty(key);
    }
  });

  it("does not mutate the stored row while filtering it", async () => {
    const row: Record<string, unknown> = { ...STORED_RAW };
    H.trace = { ...H.trace, status: "success", property_record: row, trace_result: null };

    const { GET } = await import("@/app/api/v1/trace/status/route");
    await GET(new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1"));

    expect(Object.keys(row)).toHaveLength(86);
  });
});

/**
 * THE PUSH IS RECORDED ON THE TRACE ROW.
 *
 * The credential flag says whether the KEY works. It cannot answer "did THIS
 * trace reach the CRM", which is the question a customer asks and which was
 * unanswerable for eight months because every caller dropped the contactId.
 */
describe("v1 trace/status route records the push on the trace row", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("writes the contact id and the timestamp against that trace", async () => {
    H.integrationProfile = {
      ...H.integrationProfile,
      highlevel_api_key: "key-1",
      highlevel_location_id: "loc-1",
    };
    H.pushResult = { success: true, contactId: "c-9", action: "updated" };

    const { GET } = await import("@/app/api/v1/trace/status/route");
    await GET(
      new Request("https://proptracerpro.com/api/v1/trace/status?trace_id=trace-1")
    );
    await settle();

    const records = H.updates.filter(
      (u) => u.table === "trace_history" && "highlevel_pushed_at" in u.payload
    );
    expect(records).toHaveLength(1);
    expect(records[0].payload.highlevel_contact_id).toBe("c-9");
    expect(records[0].payload.highlevel_push_action).toBe("updated");
    expect(records[0].filters).toContainEqual(["eq", "id", "trace-1"]);
  });
});
