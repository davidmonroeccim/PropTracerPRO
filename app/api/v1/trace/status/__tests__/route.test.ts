import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getChargePerTrace } from "@/lib/constants";
import { TRACE_TIER } from "@/lib/trace/billedRows";

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
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
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
