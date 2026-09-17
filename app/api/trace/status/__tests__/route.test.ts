import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { TRACE_TIER } from "@/lib/trace/billedRows";

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
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
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
        H.updates.push({ table, payload });
        return chainTo(null);
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
vi.mock("@/lib/highlevel/client", () => ({ pushTraceToHighLevel: vi.fn() }));

const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));

beforeEach(() => {
  H.updates = [];
  H.rpcCalls = [];
  H.deductResult = true;
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
