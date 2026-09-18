import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  updates: [] as Array<{
    table: string;
    payload: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>,
  settleBulkJobSpy: vi.fn(),
  /** Callbacks handed to `after()`, run explicitly by flushDeferred(). */
  scheduled: [] as Array<() => unknown>,
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
  const filters: Array<[string, ...unknown[]]> = [];
  H.updates.push({ table, payload, filters });
  const node: Record<string, unknown> = {};
  for (const m of ["eq", "in", "or", "is"])
    node[m] = (...args: unknown[]) => {
      filters.push([m, ...args]);
      return node;
    };
  node.then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(res);
  return node;
};

/**
 * `after()` is captured, not executed. The credential health write and the push
 * record are handed to it so they outlive the response.
 */
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    H.scheduled.push(fn);
  },
}));

/** Drain everything `after()` was handed, in order. */
async function flushDeferred(): Promise<void> {
  while (H.scheduled.length > 0) await H.scheduled.shift()!();
}

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
  H.scheduled = [];
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
 * THE SIZE FENCE ON THE v1 PAYLOAD, AND IT IS ADDITIVE.
 *
 * Restoring parity with the MCP twin in 5c-3B put a 65-key `property_record` on
 * every row of this response, on all three emitting exits. Rows that were thin on
 * a surface sized for thin rows became fat.
 *
 * The default limit is the 500-record SUBMIT CAP, not a page size, and the first
 * test below is the reason: a bulk job cannot exceed 500 records on any submit
 * surface, so this response is already bounded by construction, and defaulting to
 * a small page would bound it a second time at the cost of breaking every
 * existing API-key consumer. Paging is something a caller can now ASK for, not
 * something done to them.
 *
 * The MCP twin stays at 25 / 200 and the numbers are deliberately different: that
 * consumer is a model with a context budget, this one is a program receiving
 * bytes it asked for.
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

  it("AN EXISTING CALLER SEES EXACTLY WHAT IT SAW BEFORE", async () => {
    // THE WHOLE POINT OF THE DEFAULT. A consumer that reads `results` and passes
    // no query string gets every row of the job, as it always did. Any job is at
    // most 500 records on every submit surface, so the default covers all of
    // them and the response is bounded by the cap rather than by a page size.
    // MUTATION: set RESULTS_DEFAULT_LIMIT to a page size like 25 and this goes
    // red, which is the silent breakage it exists to prevent.
    const body = await get("");
    expect(body.results).toHaveLength(300);
    expect(body.results[0].address).toBe("ROW 0");
    expect(body.results[299].address).toBe("ROW 299");
  });

  it("reports the totals anyway, so truncation is never silent when it does happen", async () => {
    // Always present, not only when a page was taken: two numbers that disagree
    // are detectable, a short array on its own is not.
    const body = await get("");
    expect(body.results_total).toBe(300);
    expect(body.results_returned).toBe(300);
    expect(body.results_offset).toBe(0);
  });

  it("still lets a caller ASK for a page", async () => {
    // Additive: the capability is there for a consumer that wants it, it is just
    // not imposed on one that does not.
    const body = await get("&limit=25");
    expect(body.results).toHaveLength(25);
    expect(body.results_total).toBe(300);
    expect(body.results_returned).toBe(25);
  });

  it("clamps an oversized limit to the 500-record cap", async () => {
    const body = await get("&limit=5000");
    expect(body.results).toHaveLength(300);
  });

  it("reaches rows past a requested page, so nothing paid for is unreachable", async () => {
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
    expect(body.results).toHaveLength(300);
    expect(body.results_offset).toBe(0);
  });

  it("pages the freshly-finalized exit too, not only the already-completed one", async () => {
    // This route has three exits that emit results. A cap on one of them is not
    // a cap: the first caller to finish a job hits a different one.
    H.job = { ...completedJob, status: "processing" };
    const body = await get("&limit=25");
    expect(body.status).toBe("completed");
    expect(body.results).toHaveLength(25);
    expect(body.results_total).toBe(300);
  });
});

/**
 * The v1 default is DERIVED from the submit cap, not a coincidence that happens
 * to share its digits, and the asymmetry with the MCP twin is a decision rather
 * than drift. Both are asserted at the source, because both are the kind of thing
 * a later reader "tidies up".
 */
describe("the two results limits, and why they differ", () => {
  const read = (path: string) =>
    readFileSync(join(process.cwd(), path), "utf8");

  it("defaults to the same number the submit surfaces cap a job at", () => {
    // IF THE CAP MOVES, THIS MUST MOVE WITH IT. The default is only non-breaking
    // because no job can exceed it. Raise MAX_RECORDS to 1000 and leave this at
    // 500 and the route starts silently truncating jobs it used to return whole,
    // which is the exact harm the default was chosen to avoid.
    const caps = [
      "app/api/trace/bulk/route.ts",
      "app/api/v1/trace/bulk/route.ts",
      "lib/suite/mcp-tools.ts",
    ].map((path) => read(path).match(/MAX_RECORDS = (\d+)/)![1]);

    const status = read("app/api/v1/trace/bulk/status/route.ts");
    const def = status.match(/RESULTS_DEFAULT_LIMIT = (\d+)/)![1];
    const max = status.match(/RESULTS_MAX_LIMIT = (\d+)/)![1];

    expect(new Set(caps).size, `submit caps disagree: ${caps.join(", ")}`).toBe(1);
    expect(def, "the v1 default must cover a full-size job").toBe(caps[0]);
    expect(max).toBe(caps[0]);
  });

  it("does NOT match the MCP twin, and says why in the source", () => {
    // MUTATION: make the two surfaces share numbers "for consistency" and this
    // goes red. The MCP bounds a model's context; this bounds bytes to a program
    // that asked for them. Matching them would break v1 callers to solve a
    // problem v1 does not have.
    const mcp = read("lib/suite/mcp-tools.ts");
    expect(mcp).toContain("BULK_STATUS_DEFAULT_LIMIT = 25");
    expect(mcp).toContain("BULK_STATUS_MAX_LIMIT = 200");

    // THE REASON HAS TO BE WRITTEN DOWN ON BOTH SIDES, or the difference reads as
    // an oversight to whoever opens one file without the other. An earlier
    // version of this test checked each file for its OWN reason only, which let a
    // mutation delete v1's account of why the MCP differs while staying green:
    // the half most likely to be "tidied up" was the half nothing guarded.
    const v1 = read("app/api/v1/trace/bulk/status/route.ts");
    for (const source of [mcp, v1]) {
      expect(source).toMatch(/context budget/);
      expect(source).toMatch(/bytes over the wire/i);
    }
  });
});

/* ------------------------------------------------------------------ *
 * DOUBLE-PUSH RESTS ON A FACT ABOUT THE ROW, NOT ON A CODE PATH.
 *
 * sweep-property-traces now pushes a tier 2 row the moment it settles. This
 * route's finalize push reads every ROW of the job, so without a skip it pushes
 * those same rows a second time. The skip is `highlevel_pushed_at IS NOT NULL`,
 * which is the whole reason that column exists: a filter on `tier` or on
 * `property_trace_status` would be guessing at which code path owned the row,
 * while the timestamp is the record of what actually happened.
 * ------------------------------------------------------------------ */
describe("a row that already reached the CRM is not pushed again", () => {
  const CONNECTED = {
    id: "user-abc",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    highlevel_api_key: "hl-key",
    highlevel_location_id: "loc-1",
  };

  const DONE_JOB = {
    id: "job-1",
    status: "processing",
    records_submitted: 2,
    created_at: new Date().toISOString(),
  };

  /** A settled tier 2 row the cron already pushed. */
  const PUSHED_ROW = {
    id: "row-pushed",
    status: "success",
    tracerfy_job_id: null,
    normalized_address: "100 MAIN ST|AUSTIN|TX",
    city: "Austin",
    state: "TX",
    ai_research_status: null,
    property_trace_status: "property_trace_done",
    is_successful: true,
    trace_result: { owner_name: "Pushed Owner", phones: [], emails: [] },
    charge: 0.4,
    highlevel_contact_id: "hl-earlier",
    highlevel_pushed_at: "2026-09-18T10:00:00.000Z",
  };

  /** A tier 1 row nothing has pushed. */
  const UNPUSHED_ROW = {
    id: "row-fresh",
    status: "success",
    tracerfy_job_id: null,
    normalized_address: "200 OAK AVE|AUSTIN|TX",
    city: "Austin",
    state: "TX",
    ai_research_status: null,
    is_successful: true,
    trace_result: { owner_name: "Fresh Owner", phones: [], emails: [] },
    charge: 0.15,
    highlevel_pushed_at: null,
  };

  it("skips the recorded row and still pushes the one nothing has touched", async () => {
    H.profile = { ...CONNECTED };
    H.job = { ...DONE_JOB };
    H.rows = [{ ...PUSHED_ROW }, { ...UNPUSHED_ROW }];

    const { pushTraceToHighLevel } = await import("@/lib/highlevel/client");
    vi.mocked(pushTraceToHighLevel).mockClear();
    vi.mocked(pushTraceToHighLevel).mockResolvedValue({
      success: true,
      contactId: "hl-new",
      action: "created",
    });

    const { GET } = await import("@/app/api/v1/trace/bulk/status/route");
    await GET(new Request("https://proptracerpro.com/api/v1/trace/bulk/status?job_id=job-1"));

    // Exactly one push, and it is the row with no record of one.
    expect(pushTraceToHighLevel).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(pushTraceToHighLevel).mock.calls[0][0];
    expect(arg.traceResult.owner_name).toBe("Fresh Owner");
  });

  it("records the push it does make against that row's own id", async () => {
    // Without the id the push happens and nothing on the row ever says so, and
    // the next finalize has no fact to skip on.
    H.profile = { ...CONNECTED };
    H.job = { ...DONE_JOB };
    H.rows = [{ ...UNPUSHED_ROW }];

    const { pushTraceToHighLevel } = await import("@/lib/highlevel/client");
    vi.mocked(pushTraceToHighLevel).mockClear();
    vi.mocked(pushTraceToHighLevel).mockResolvedValue({
      success: true,
      contactId: "hl-new",
      action: "created",
    });

    const { GET } = await import("@/app/api/v1/trace/bulk/status/route");
    await GET(new Request("https://proptracerpro.com/api/v1/trace/bulk/status?job_id=job-1"));
    await flushDeferred();

    const records = H.updates.filter(
      (u) => u.table === "trace_history" && "highlevel_pushed_at" in u.payload
    );
    expect(records).toHaveLength(1);
    expect(records[0].payload.highlevel_contact_id).toBe("hl-new");
    expect(records[0].filters).toContainEqual(["eq", "id", "row-fresh"]);
  });
});
