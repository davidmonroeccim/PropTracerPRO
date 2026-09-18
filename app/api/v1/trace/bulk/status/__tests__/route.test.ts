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
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  settleBulkJobSpy: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  validateApiKey: vi.fn(async () => ({ profile: H.profile })),
  isAuthError: () => false,
}));

/** An update chain that records its payload and swallows its filters. Added when
 *  the completion gate made the FINALIZE path reachable from these tests: before
 *  that every case returned while a row was still 'processing', so the route
 *  never wrote a trace_jobs row and the stub never needed one. */
const updateChain = (table: string) => (payload: Record<string, unknown>) => {
  H.updates.push({ table, payload });
  const node: Record<string, unknown> = {};
  for (const m of ["eq", "in", "or", "is"]) node[m] = () => node;
  node.then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(res);
  return node;
};

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
            update: updateChain("trace_jobs"),
          }
        : {
            // trace_history: .select().eq().eq() is awaited directly. The
            // finalize path issues a second, narrower read with `.in('id', ...)`
            // for the business-trace join, so the second `.eq()` is thenable AND
            // chainable rather than a bare promise.
            select: () => {
              const node: Record<string, unknown> = {};
              node.eq = () => node;
              node.in = () => node;
              node.then = (res: (v: unknown) => unknown) =>
                Promise.resolve({ data: H.rows, error: null }).then(res);
              return node;
            },
            update: updateChain("trace_history"),
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
// effects, e.g. auto-rebill -> stripe/client). These now resolve rather than
// returning undefined: the completion-gate tests below reach the finalize path,
// where the route calls `.catch()` on this fire-and-forget handle.
vi.mock("@/lib/utils/auto-rebill", () => ({
  triggerAutoRebillIfNeeded: vi.fn(async () => undefined),
}));
vi.mock("@/lib/highlevel/client", () => ({ pushTraceToHighLevel: vi.fn() }));

beforeEach(() => {
  H.updates = [];
  H.settleBulkJobSpy.mockReset();
  H.settleBulkJobSpy.mockResolvedValue({ stalledErrorReason: null });
});

describe("v1 bulk-status route personRate wiring", () => {
  it("passes getChargePerTrace(tier, flag) as settleBulkJob's personRate", async () => {
    // wallet tier + not acquisition-pro => getChargePerTrace = CHARGE_PER_SUCCESS_WALLET,
    // which is deliberately DIFFERENT from the pro/grant rate (CHARGE_PER_SUCCESS). So the
    // assertion catches a wire-up to 0, to the grant rate, or to any hardcoded constant.
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
    const expectedRate = getChargePerTrace("wallet", false); // CHARGE_PER_SUCCESS_WALLET

    // The route must pass its tier-aware rate through verbatim.
    expect(passedArgs.personRate).toBe(expectedRate);
    // Sharpen the fence against the three named wrong-wirings.
    expect(passedArgs.personRate).not.toBe(0);
    expect(passedArgs.personRate).not.toBe(PRICING.CHARGE_PER_SUCCESS); // the grant/pro rate
    // Wallet owner is always the local profile id.
    expect(passedArgs.userId).toBe("user-abc");
  });
});

/**
 * THE JOB MAY NOT FINISH OVER WORK THAT HAS NOT RUN.
 *
 * This route already waits on the entity queue. Phase 5c added a second one,
 * `property_trace_status`, which settles a DIFFERENT billing model: tier 1 bills
 * per successful trace and a miss is free, tier 2 bills per record submitted and
 * a miss is billed. Without the matching gate the job finalizes the moment the
 * Tracerfy leg lands, and the caller gets `completed` plus a results payload
 * short by exactly the rows they are about to be charged for.
 */
describe("the tier 2 queue holds the job open too", () => {
  beforeEach(() => {
    H.profile = { id: "user-abc", subscription_tier: "wallet", is_acquisition_pro_member: false };
    H.job = {
      id: "job-1",
      status: "processing",
      records_submitted: 1,
      created_at: new Date().toISOString(),
    };
  });

  it("reports processing while a tier 2 row is queued, with everything else settled", async () => {
    // Deliberately NOT status 'processing' and NOT entity-queued, so the two
    // pre-existing gates cannot see this row. MUTATION: delete the
    // isPropertyTracePending arm and this goes red.
    H.rows = [
      {
        id: "row-1",
        status: "no_match",
        tracerfy_job_id: null,
        city: "Austin",
        state: "TX",
        ai_research_status: null,
        property_trace_status: "queued",
      },
    ];

    const { GET } = await import("@/app/api/v1/trace/bulk/status/route");
    const body = await (
      await GET(
        new Request("https://proptracerpro.com/api/v1/trace/bulk/status?job_id=job-1")
      )
    ).json();

    expect(body.status).toBe("processing");
    expect(body.records_pending_property_trace).toBe(1);
  });

  it("counts a RETRIED row as pending, because the attempt rides in the column", async () => {
    // A literal comparison against 'queued' would read queued_4 as terminal and
    // finish the job four attempts early.
    H.rows = [
      {
        id: "row-1",
        status: "no_match",
        tracerfy_job_id: null,
        city: "Austin",
        state: "TX",
        ai_research_status: null,
        property_trace_status: "queued_4",
      },
    ];

    const { GET } = await import("@/app/api/v1/trace/bulk/status/route");
    const body = await (
      await GET(
        new Request("https://proptracerpro.com/api/v1/trace/bulk/status?job_id=job-1")
      )
    ).json();

    expect(body.status).toBe("processing");
  });

  it("lets the job finish once the tier 2 row reaches a terminal value", async () => {
    // The other side of the fence: a terminal value must read as NOT pending, or
    // the job is held open forever and never reports at all.
    H.rows = [
      {
        id: "row-1",
        status: "no_match",
        tracerfy_job_id: null,
        city: "Austin",
        state: "TX",
        ai_research_status: null,
        property_trace_status: "property_trace_done",
        is_successful: false,
        charge: 0.4,
      },
    ];

    const { GET } = await import("@/app/api/v1/trace/bulk/status/route");
    const body = await (
      await GET(
        new Request("https://proptracerpro.com/api/v1/trace/bulk/status?job_id=job-1")
      )
    ).json();

    expect(body.status).toBe("completed");
    // A billed tier 2 miss is the normal shape here: is_successful false with a
    // charge above zero. The total has to carry it.
    expect(body.total_charge).toBeCloseTo(0.4, 10);
  });
});

/**
 * THE SIZE FENCE ON THE v1 PAYLOAD.
 *
 * Restoring parity with the MCP twin in 5c-3B put a 65-key `property_record` on
 * every row of this response, on all three emitting exits, with no bound. That is
 * the same uncapped shape the brief called "a very large response" on the MCP
 * side and bounded there, so parity had copied the flaw to a second surface: a
 * 500-record tier 2 job became a 500-dossier response under a 60 s maxDuration.
 *
 * Capping an existing API surface is a behaviour change for callers that read
 * `results` and nothing else, which is exactly why the three count fields are
 * ALWAYS present rather than only on truncation. A short array a consumer cannot
 * detect is the failure this codebase treats as worse than a big response.
 */
describe("the v1 per-record payload is paged", () => {
  const completedJob = {
    id: "job-1",
    status: "completed",
    records_submitted: 300,
    records_matched: 300,
    error_message: null,
    created_at: new Date().toISOString(),
  };

  const manyRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `row-${i}`,
      status: "no_match",
      tracerfy_job_id: null,
      normalized_address: `ROW ${i}`,
      city: "Austin",
      state: "TX",
      charge: 0,
      ai_research_status: null,
      property_trace_status: "property_trace_done",
    }));

  const get = async (query: string) => {
    const { GET } = await import("@/app/api/v1/trace/bulk/status/route");
    return (
      await GET(
        new Request(`https://proptracerpro.com/api/v1/trace/bulk/status?job_id=job-1${query}`)
      )
    ).json();
  };

  beforeEach(() => {
    H.profile = { id: "user-abc", subscription_tier: "wallet", is_acquisition_pro_member: false };
    H.job = completedJob;
    H.rows = manyRows(300);
  });

  it("returns 25 rows by default rather than every row of the job", async () => {
    // MUTATION: drop pageResults from the already-completed exit and this goes red.
    const body = await get("");
    expect(body.results).toHaveLength(25);
  });

  it("always reports the total, so a truncated array is never silent", async () => {
    // The part that makes this survivable for an existing consumer: two numbers
    // that disagree are detectable, a short array on its own is not.
    const body = await get("");
    expect(body.results_total).toBe(300);
    expect(body.results_returned).toBe(25);
    expect(body.results_offset).toBe(0);
  });

  it("clamps an oversized limit to the same 200 the MCP twin uses", async () => {
    const body = await get("&limit=5000");
    expect(body.results).toHaveLength(200);
  });

  it("reaches the rows past the max, so a 500-record job stays fully readable", async () => {
    const body = await get("&limit=200&offset=200");
    expect(body.results).toHaveLength(100);
    expect(body.results[0].address).toBe("ROW 200");
    expect(body.results_offset).toBe(200);
  });

  it("floors a negative offset instead of slicing from the end", async () => {
    // A negative offset would silently return the WRONG rows rather than fail.
    const body = await get("&offset=-5");
    expect(body.results[0].address).toBe("ROW 0");
    expect(body.results_offset).toBe(0);
  });

  it("ignores junk in the query rather than returning nothing", async () => {
    const body = await get("&limit=abc&offset=abc");
    expect(body.results).toHaveLength(25);
    expect(body.results_offset).toBe(0);
  });

  it("pages the freshly-finalized exit too, not only the already-completed one", async () => {
    // This route has three exits that emit results. A cap on one of them is not
    // a cap: the first caller to finish a job hits a different one.
    H.job = { ...completedJob, status: "processing" };
    const body = await get("");
    expect(body.status).toBe("completed");
    expect(body.results).toHaveLength(25);
    expect(body.results_total).toBe(300);
  });
});
