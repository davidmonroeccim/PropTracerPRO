import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChargePerTrace, PRICING } from "@/lib/constants";

// Mutation fence for the route -> settleBulkJob money SEAM: proves the v1 bulk
// status route passes its tier-aware getChargePerTrace(...) value as the
// personRate, not 0, a hardcoded constant, or the grant-aware rate by mistake.
// settleBulkJob itself is fenced by lib/trace/__tests__/settleBulkJob.test.ts;
// this guards the caller's CHOICE of rate, which no other test observes.

// Shared, mutable holder so the mock factories (hoisted above imports) read
// per-test data lazily at call time.
const H = vi.hoisted(() => ({
  profile: null as unknown as Record<string, unknown>,
  job: null as unknown as Record<string, unknown>,
  rows: null as unknown as Array<Record<string, unknown>>,
  settleBulkJobSpy: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  validateApiKey: vi.fn(async () => ({ profile: H.profile })),
  isAuthError: () => false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) =>
      table === "trace_jobs"
        ? {
            select: () => ({
              eq: () => ({
                eq: () => ({ single: () => Promise.resolve({ data: H.job }) }),
              }),
            }),
          }
        : {
            // trace_history: .select().eq().eq() is awaited directly.
            select: () => ({
              eq: () => ({ eq: () => Promise.resolve({ data: H.rows }) }),
            }),
          },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
}));

// The settlement function is the unit under a DIFFERENT test; here we only spy
// on HOW the route calls it. Return a benign SettleResult so the route's
// stall-detect forEach does not throw.
vi.mock("@/lib/trace/settleBulkJob", () => ({
  settleBulkJob: H.settleBulkJobSpy,
}));

// Neutralize downstream fire-and-forget deps (and their import-time side
// effects, e.g. auto-rebill -> stripe/client). Not reached anyway: with the
// row left 'processing' the route returns before finalize.
vi.mock("@/lib/utils/auto-rebill", () => ({ triggerAutoRebillIfNeeded: vi.fn() }));
vi.mock("@/lib/highlevel/client", () => ({ pushTraceToHighLevel: vi.fn() }));

beforeEach(() => {
  H.settleBulkJobSpy.mockReset();
  H.settleBulkJobSpy.mockResolvedValue({ stalledErrorReason: null });
});

describe("v1 bulk-status route personRate wiring", () => {
  it("passes getChargePerTrace(tier, flag) as settleBulkJob's personRate", async () => {
    // wallet tier + not acquisition-pro => getChargePerTrace = $0.11, which is
    // deliberately DIFFERENT from the pro/grant rate ($0.07). So the assertion
    // catches a wire-up to 0, to the grant rate, or to any hardcoded constant.
    H.profile = { id: "user-abc", subscription_tier: "wallet", is_acquisition_pro_member: false };
    H.job = {
      id: "job-1",
      status: "processing",
      records_submitted: 1,
      created_at: new Date().toISOString(),
    };
    H.rows = [
      {
        id: "row-1",
        status: "processing",
        tracerfy_job_id: "tj-1",
        city: "Austin",
        state: "TX",
        ai_research_status: null,
      },
    ];

    const { GET } = await import("@/app/api/v1/trace/bulk/status/route");
    const req = new Request("https://proptracerpro.com/api/v1/trace/bulk/status?job_id=job-1");
    await GET(req);

    expect(H.settleBulkJobSpy).toHaveBeenCalledTimes(1);
    const passedArgs = H.settleBulkJobSpy.mock.calls[0][1];
    const expectedRate = getChargePerTrace("wallet", false); // 0.11

    // The route must pass its tier-aware rate through verbatim.
    expect(passedArgs.personRate).toBe(expectedRate);
    // Sharpen the fence against the three named wrong-wirings.
    expect(passedArgs.personRate).not.toBe(0);
    expect(passedArgs.personRate).not.toBe(PRICING.CHARGE_PER_SUCCESS); // 0.07 grant/pro rate
    // Wallet owner is always the local profile id.
    expect(passedArgs.userId).toBe("user-abc");
  });
});
