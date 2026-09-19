import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHAT STAGE 1 IS ALLOWED TO CLAIM.
 *
 * Stage 1 says it sweeps stale SINGLE traces, and until 2026-09-17 it did not
 * actually restrict itself to them: it selected on `status = 'processing'` plus
 * `created_at < cutoff` and nothing else, so a BULK row qualified too.
 *
 * That is only latent while every bulk row is guaranteed to leave its status
 * route resolved. The moment a bulk row can be left in 'processing' -- which is
 * exactly what putting `status` behind excludeBilledRows did -- stage 1 becomes
 * a live billing defect, because it finalizes a claimed row against
 *
 *   nonPaddingResults.find(r => r.primary_phone || r.mobile_1 || r.email_1)
 *
 * and for a bulk row the Tracerfy job is SHARED across the whole batch. The
 * "first result carrying a phone" is then whichever OTHER property in the file
 * came back, so the customer is charged a second time and handed a stranger's
 * phone and email attributed to their parcel -- which is then pushed to their
 * GoHighLevel CRM.
 *
 * The blanket-update split is the real fix. This narrowing is the second lock
 * on the same door: a bulk row is settled by its own job's status route and by
 * lib/trace/settleBulkJob, never by the single-trace sweep.
 */

type Filter = [string, ...unknown[]];

interface Op {
  table: string;
  op: "select" | "update";
  payload?: Record<string, unknown>;
  filters: Filter[];
}

const H = vi.hoisted(() => ({
  ops: [] as Array<{
    table: string;
    op: "select" | "update";
    payload?: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>,
  /** Stale BULK jobs for stage 2. Empty by default so stage 2 does no work. */
  staleJobs: [] as Array<Record<string, unknown>>,
  /** The per-result trace_history lookup inside stage 2's settle loop. */
  historyRows: [] as Array<Record<string, unknown>>,
  profile: null as Record<string, unknown> | null,
  jobStatus: { success: false, pending: true } as Record<string, unknown>,
  /** Stale SINGLE traces for stage 1. Empty by default so stage 1 does no work. */
  staleSingles: [] as Array<Record<string, unknown>>,
  /** What the mocked HighLevel client answers. */
  pushResult: { success: true, contactId: "c-1", action: "created" } as Record<
    string,
    unknown
  >,
  /** Callbacks handed to `after()`, run explicitly by flushDeferred(). */
  scheduled: [] as Array<() => unknown>,
}));

/** Records every query and resolves each terminal from H, so a test can drive
 *  stage 2's settle loop without either stage inventing data of its own. */
function recordingClient() {
  return {
    rpc: async () => ({ data: true, error: null }),
    from(table: string) {
      const node: Record<string, unknown> = {};
      let rec: Op | null = null;
      const add =
        (method: string) =>
        (...args: unknown[]) => {
          rec?.filters.push([method, ...args]);
          return node;
        };
      for (const m of ["select", "eq", "lt", "gt", "or", "order", "limit", "in", "is", "not", "ilike"])
        node[m] = add(m);

      const settle = () => {
        // Stage 1 selects trace_history filtered on a processing status; stage 2
        // selects trace_jobs. Stage 1 stays empty so only stage 2 runs.
        if (table === "trace_jobs" && rec?.op === "select") return { data: H.staleJobs, error: null };
        if (table === "trace_history" && rec?.op === "select") {
          const cols = String(rec.filters[0]?.[1] ?? "");
          return {
            data: cols.includes("normalized_address") ? H.staleSingles : H.historyRows,
            error: null,
          };
        }
        return { data: [], error: null };
      };

      node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(settle()).then(res, rej);
      node.single = async () => ({
        data: table === "user_profiles" ? H.profile : null,
        error: null,
      });
      node.maybeSingle = async () => ({ data: null, error: null });
      return {
        select: (...args: unknown[]) => {
          rec = { table, op: "select", filters: [["select", ...args]] };
          H.ops.push(rec);
          return node;
        },
        update: (payload: Record<string, unknown>) => {
          rec = { table, op: "update", payload, filters: [] };
          H.ops.push(rec);
          return node;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => recordingClient() }));
vi.mock("@/lib/tracerfy/client", () => ({
  getJobStatus: vi.fn(async () => H.jobStatus),
  parseTracerfyResult: vi.fn((r: unknown) => r),
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

/**
 * `after()` is captured, not executed, so anything this cron defers is drained
 * explicitly by flushDeferred() rather than read as a race.
 */
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    H.scheduled.push(fn);
  },
}));
vi.mock("@/lib/utils/auto-rebill", () => ({
  triggerAutoRebillIfNeeded: vi.fn(async () => {}),
}));

const { GET } = await import("@/app/api/cron/sweep-stale-traces/route");

/** Drain everything `after()` was handed, in order. */
async function flushDeferred(): Promise<void> {
  while (H.scheduled.length > 0) await H.scheduled.shift()!();
}

function run(secret = "s3cret") {
  return GET(
    new Request("http://localhost/api/cron/sweep-stale-traces", {
      headers: { authorization: `Bearer ${secret}` },
    })
  );
}

/** The stage 1 select: trace_history, filtered on a processing status. */
const stage1Select = () =>
  H.ops.find(
    (o) =>
      o.table === "trace_history" &&
      o.op === "select" &&
      o.filters.some((f) => f[0] === "eq" && f[1] === "status" && f[2] === "processing")
  );

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  H.ops = [];
  H.staleJobs = [];
  H.historyRows = [];
  H.staleSingles = [];
  H.scheduled = [];
  H.pushResult = { success: true, contactId: "c-1", action: "created" };
  H.profile = {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: [],
    webhook_url: null,
    highlevel_api_key: null,
    highlevel_location_id: null,
  };
  H.jobStatus = { success: false, pending: true };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("auth", () => {
  it("401s without the cron secret and touches nothing", async () => {
    const res = await run("wrong");
    expect(res.status).toBe(401);
    expect(H.ops).toHaveLength(0);
  });
});

describe("stage 1 claims single traces only", () => {
  it("restricts itself to rows with no parent bulk job", async () => {
    await run();
    const select = stage1Select();
    expect(select).toBeDefined();
    // MUTATION: remove the `.is('trace_job_id', null)` and this goes red -- the
    // sweep is free to claim a bulk row and settle it against another
    // property's contacts from the shared Tracerfy batch.
    expect(
      select!.filters.some((f) => f[0] === "is" && f[1] === "trace_job_id" && f[2] === null)
    ).toBe(true);
  });

  it("still bounds itself by the stale cutoff and a row limit", async () => {
    // The narrowing must not cost the sweep its other bounds.
    await run();
    const select = stage1Select();
    expect(select!.filters.some((f) => f[0] === "lt" && f[1] === "created_at")).toBe(true);
    expect(select!.filters.some((f) => f[0] === "limit")).toBe(true);
  });

  it("still selects the receipt columns it folds onto", async () => {
    // (see below for stage 2's blanket sweep)
    // Stage 1 reaches REUSED rows, so its settle folds rather than overwrites.
    // Dropping either column from the select makes the fold fold onto undefined.
    await run();
    const cols = String(stage1Select()!.filters[0][1]);
    expect(cols).toContain("charge");
    expect(cols).toContain("tier");
  });
});

/* ------------------------------------------------------------------ *
 * STAGE 2'S BLANKET LEFTOVER SWEEP.
 *
 * This is where the excludeBilledRows-on-a-blanket-update pattern was first
 * written, and it carries the same flaw the two bulk settles did: `status` and
 * `is_successful` are DELIVERY facts sitting behind a guard that exists to
 * protect `charge` and `tier`.
 *
 * A billed tier 2 row fails the guard, so it is skipped and keeps
 * `status = 'processing'` -- and the very next statement marks its job
 * `completed`, after which nothing re-sweeps it: stage 2 only claims jobs that
 * are still 'processing', and stage 1 is now restricted to rows with no parent
 * job. The row is stranded permanently, reported as 'processing' inside a
 * completed job by every surface that reads it.
 *
 * Two statements. Money behind the guard, delivery in front of it.
 * ------------------------------------------------------------------ */
describe("stage 2 resolves every row of a stale bulk job", () => {
  beforeEach(() => {
    H.staleJobs = [
      { id: "job-1", user_id: "user-1", tracerfy_job_id: "tf-1", records_submitted: 2 },
    ];
    // Tracerfy answered, so the loop reaches the blanket sweep at the end.
    H.jobStatus = {
      success: true,
      pending: false,
      results: [{ address: "1 MAIN ST", city: "AUSTIN", state: "TX" }],
    };
    // No trace_history row matches the result, so nothing settles per-row and
    // every row of the job falls into the blanket.
    H.historyRows = [];
  });

  const blanket = () => {
    const writes = H.ops.filter(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.filters.some((f) => f[0] === "eq" && f[1] === "status" && f[2] === "processing")
    );
    return {
      guarded: writes.filter((w) => w.filters.some((f) => f[0] === "or")),
      unguarded: writes.filter((w) => !w.filters.some((f) => f[0] === "or")),
    };
  };

  it("keeps the money behind the guard and nothing else", async () => {
    await run();
    const { guarded } = blanket();
    expect(guarded).toHaveLength(1);
    expect(
      guarded[0].filters.some((f) => f[0] === "is" && f[1] === "property_record")
    ).toBe(true);
    expect(guarded[0].payload!.charge).toBe(0);
    expect(guarded[0].payload!.tier).toBe(1);
    // MUTATION: move `status` into this payload and this goes red.
    expect(Object.keys(guarded[0].payload!)).not.toContain("status");
    expect(Object.keys(guarded[0].payload!)).not.toContain("is_successful");
  });

  it("resolves the status of every row, billed or not", async () => {
    await run();
    const { unguarded } = blanket();
    // MUTATION: delete this statement, or wrap it in excludeBilledRows, and
    // this goes red -- a paid row is stranded in 'processing' inside a job that
    // is marked completed on the very next statement, and nothing re-sweeps it.
    expect(unguarded).toHaveLength(1);
    expect(unguarded[0].payload!.status).toBe("no_match");
    expect(unguarded[0].payload!.is_successful).toBe(false);
    expect(Object.keys(unguarded[0].payload!)).not.toContain("charge");
  });

  /* ---------------------------------------------------------------- *
   * THE ORDER OF THE TWO STATEMENTS IS LOAD-BEARING.
   *
   * Both select on `status = 'processing'`, and the delivery statement is what
   * ENDS that status. Run delivery first and the money statement matches
   * nothing: every unbilled leftover row keeps a NULL `charge` and an unstamped
   * `tier` instead of being normalised to `charge: 0, tier: 1`.
   *
   * `tier` is what isCacheHitRow's third arm reads and a NULL `charge` is what
   * excludeBilledRows' `charge.is.null` arm exists to catch, so the rows this
   * silently skips are exactly the ones the delete guard and the cache filter
   * go on to misread. Neither statement says a word about the other, so nothing
   * but this test stops a later edit from reordering them.
   *
   * The same fence is on bulk/status and settleBulkJob, the two files that
   * carry the identical pair.
   * ---------------------------------------------------------------- */
  it("runs the MONEY statement first, while the rows are still processing", async () => {
    await run();
    const { guarded, unguarded } = blanket();
    // MUTATION: swap the two statements in the source and this goes red.
    expect(H.ops.indexOf(guarded[0])).toBeGreaterThanOrEqual(0);
    expect(H.ops.indexOf(guarded[0])).toBeLessThan(H.ops.indexOf(unguarded[0]));
  });
});

/**
 * A STALE BULK JOB WITH NO TRACERFY JOB ID USED TO MEAN ONE THING AND NOW MEANS
 * TWO, AND THE SECOND ONE IS BILLED.
 *
 * Until phase 5c it could only be a submit that failed silently, so failing the
 * job after the 60-minute cutoff was the honest answer. Since the submit routes
 * learned to enqueue, it is also the normal shape of a job whose rows are ALL
 * tier 2: there is no person CSV, sweep-property-traces owns every row, and the
 * job legitimately outlives that cutoff whenever the queue is under contention.
 *
 * Failing THAT job is the worst outcome available here. Its rows are billed as
 * each dossier answers, so the customer would be charged for a job this cron
 * told them had failed, while the cron actually doing the work carried on.
 */
describe("a stale bulk job carrying tier 2 rows", () => {
  const jobWrites = () =>
    H.ops.filter((o) => o.table === "trace_jobs" && o.op === "update");

  beforeEach(() => {
    H.staleJobs = [
      { id: "job-1", user_id: "user-1", tracerfy_job_id: null, records_submitted: 2 },
    ];
  });

  it("is LEFT ALONE while its queue still owes work", async () => {
    // MUTATION: drop the isPropertyTracePending check and this goes red -- the
    // job is failed out from under the cron that is still working it.
    H.historyRows = [
      { property_trace_status: "queued_2", is_successful: null },
      { property_trace_status: "property_trace_done", is_successful: true },
    ];
    await run();
    expect(jobWrites()).toHaveLength(0);
  });

  it("is COMPLETED, not failed, once its queue has drained", async () => {
    // The status route finalizes this job when it is polled. A customer who
    // closed the tab never polls it, so without this the job sits at processing
    // for good. MUTATION: fall through to the 'No Tracerfy job ID' failure and
    // this goes red.
    H.historyRows = [
      { property_trace_status: "property_trace_done", is_successful: true },
      { property_trace_status: "property_trace_no_key", is_successful: false },
    ];
    await run();
    expect(jobWrites()).toHaveLength(1);
    expect(jobWrites()[0].payload).toMatchObject({ status: "completed", records_matched: 1 });
    expect(jobWrites()[0].payload?.error_message).toBeUndefined();
  });

  it("still fails a job that has no tier 2 rows at all", async () => {
    // The original case, unchanged: the submit never reached a vendor and there
    // is nothing behind the job. The guard must not become a blanket refusal to
    // ever fail anything.
    H.historyRows = [{ property_trace_status: null, is_successful: null }];
    await run();
    expect(jobWrites()).toHaveLength(1);
    expect(jobWrites()[0].payload).toMatchObject({
      status: "failed",
      error_message: "No Tracerfy job ID",
    });
  });
});

/**
 * THE SAME GUARD, ON THE BRANCH THAT ALREADY HAD A TRACERFY JOB.
 *
 * The loop writes a terminal trace_jobs.status in four places, and all four are
 * verdicts on the WHOLE job. A MIXED job -- tier 1 rows this cron settles, tier 2
 * rows sweep-property-traces is still working -- reaches the 60-minute cutoff
 * with its queue pending as a matter of course under contention. Finalizing it
 * there writes a status the bulk status route's top-of-handler short-circuit
 * then makes permanent, so the customer's CSV is short by exactly the rows they
 * are about to be charged for.
 */
describe("a stale MIXED bulk job, whose Tracerfy half is ready", () => {
  const jobWrites = () =>
    H.ops.filter((o) => o.table === "trace_jobs" && o.op === "update");

  beforeEach(() => {
    H.staleJobs = [
      { id: "job-1", user_id: "user-1", tracerfy_job_id: "tf-1", records_submitted: 2 },
    ];
  });

  it("is not COMPLETED over a pending tier 2 row", async () => {
    // MUTATION: move the guard back inside the !tracerfy_job_id branch and this
    // goes red.
    H.jobStatus = {
      success: true,
      pending: false,
      results: [{ address: "1 MAIN ST", city: "AUSTIN", state: "TX" }],
    };
    H.historyRows = [{ property_trace_status: "queued", is_successful: null }];
    await run();
    expect(jobWrites()).toHaveLength(0);
  });

  it("is not FAILED over a pending tier 2 row when Tracerfy times out", async () => {
    // The fourth terminal verdict in the same loop. A stalled Tracerfy bulk says
    // nothing about the dossier queue, which is a different endpoint on a
    // different clock and is still billing.
    H.jobStatus = { success: false, pending: true };
    H.historyRows = [{ property_trace_status: "processing_2", is_successful: null }];
    await run();
    expect(jobWrites()).toHaveLength(0);
  });

  it("is finalized normally once the queue has drained", async () => {
    // The guard defers, it does not disable: the job stays processing, so the
    // next run picks it up. It must not hold a job open for good.
    H.jobStatus = { success: false, pending: true };
    H.historyRows = [{ property_trace_status: "property_trace_done", is_successful: true }];
    await run();
    expect(jobWrites().length).toBeGreaterThan(0);
  });

  it("is finalized normally when it carries no tier 2 rows at all", async () => {
    // Pre-5c shape, untouched.
    H.jobStatus = { success: false, pending: true };
    H.historyRows = [{ property_trace_status: null, is_successful: null }];
    await run();
    expect(jobWrites().length).toBeGreaterThan(0);
  });
});

/**
 * THE FENCE. THIS CRON MUST NEVER CALL HIGHLEVEL.
 *
 * PTP's own push only ever creates Contacts. Most PTP users reach their CRM
 * through the Suite Gateway, which holds the GoHighLevel snapshot and knows the
 * object model: an entity owner is a Company, a person is a Contact and only
 * when there is a phone or an email, and the property hangs on a property
 * custom object. An automatic push from here writes the WRONG OBJECT TYPE into
 * that snapshot, and for a user with no gateway there is no snapshot for it to
 * populate at all.
 *
 * PTP never calls HighLevel unless a person asked it to, and a cron is the
 * furthest thing from a person asking: this one runs an hour after the fact
 * with nobody on a page. A recovered trace reaches the CRM through the Push to
 * CRM button, app/api/integrations/highlevel/push.
 *
 * Set up with EXACTLY the conditions that used to push: a credential on the
 * profile and a stale single that sweeps into a successful, contact-bearing
 * result. Re-adding a push turns it red.
 */
describe("the stale sweep never pushes to HighLevel", () => {
  beforeEach(() => {
    H.staleSingles = [
      {
        id: "trace-1",
        user_id: "user-1",
        tracerfy_job_id: "tf-1",
        normalized_address: "100 MAIN ST",
        city: "Austin",
        state: "TX",
        zip: "78701",
        charge: null,
        tier: null,
      },
    ];
    H.profile = {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: [],
      webhook_url: null,
      highlevel_api_key: "key-1",
      highlevel_location_id: "loc-1",
    };
    // parseTracerfyResult is mocked to identity in this file, so the row IS the
    // parsed result.
    H.jobStatus = {
      success: true,
      pending: false,
      results: [
        {
          address: "100 MAIN ST",
          primary_phone: "5125550100",
          phones: [{ number: "5125550100", type: "mobile" }],
          emails: [],
        },
      ],
    };
    vi.mocked(pushTraceToHighLevel).mockClear();
  });

  it("does not call HighLevel on a stale single it just recovered", async () => {
    await run();
    await flushDeferred();

    expect(pushTraceToHighLevel).not.toHaveBeenCalled();
  });

  it("writes no push record and no credential verdict, because nothing was pushed", async () => {
    await run();
    await flushDeferred();

    expect(
      H.ops.filter(
        (o) =>
          o.table === "trace_history" &&
          o.op === "update" &&
          o.payload !== undefined &&
          "highlevel_pushed_at" in o.payload
      )
    ).toEqual([]);
    expect(
      H.ops.filter(
        (o) =>
          o.table === "user_profiles" &&
          o.op === "update" &&
          o.payload !== undefined &&
          "highlevel_invalid_at" in o.payload
      )
    ).toEqual([]);
  });

  it("still settles the stale trace it swept", async () => {
    // The removal took the push out, not the sweep. A green fence on a cron
    // that stopped working would be worthless.
    await run();
    await flushDeferred();

    const settles = H.ops.filter(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload !== undefined &&
        o.payload.is_successful === true
    );
    expect(settles).toHaveLength(1);
    expect(settles[0].filters).toContainEqual(["eq", "id", "trace-1"]);
  });
});
