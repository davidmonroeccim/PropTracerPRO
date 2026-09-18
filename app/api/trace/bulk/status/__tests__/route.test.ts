import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { BLANK_OWNER_SKIP_STATUS } from "@/lib/trace/blankOwnerSkip";
import { ENTITY_TRACE_FAILED_STATUS } from "@/lib/trace/entityTraceAttempts";

/**
 * Money fence for the session-side BULK status route.
 *
 * This route loops the Tracerfy result set, writes a per-row
 * `trace_history.charge`, and accumulates `totalCharge` -- which it then ships
 * out as `total_charge` in BOTH the `bulk_job.completed` webhook and the HTTP
 * response. The per-row deduct was unchecked, so a short wallet produced a
 * ledger full of uncollected charges and a job summary claiming money that was
 * never taken. Both the row and the running total must count only what moved.
 */

const H = vi.hoisted(() => ({
  deductResult: true as boolean,
  job: null as unknown as Record<string, unknown>,
  profile: null as unknown as Record<string, unknown>,
  historyRows: [] as Array<Record<string, unknown>>,
  // Every trace_history row belonging to the JOB, which is a different read
  // from the per-result `id` lookup above: it is scoped by trace_job_id and is
  // the only read that can see a skipped row (a skipped row never gets a
  // tracerfy_job_id, so the result loop cannot reach it).
  jobRows: [] as Array<Record<string, unknown>>,
  jobStatus: null as unknown as Record<string, unknown>,
  // `filters` records every filter method called on an update chain, in order.
  // The trailing blanket sweep is identified by having no `trace_result`, and
  // the guard that has to narrow it (excludeBilledRows) is a pair of `.or()`s
  // plus an `.is()`, so the filters matter as much as the payload.
  updates: [] as Array<{
    table: string;
    payload: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>,
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
}));

/**
 * POSTGREST COLUMN PROJECTION, EMULATED. Adopted from the phase 4b stubs in
 * lib/suite/__tests__/mcp-tools.test.ts.
 *
 * A column the query never asked for does not come back, and a stub that
 * ignores `.select(...)` hides exactly that. This route's per-result settle
 * FOLDS onto `charge` and `tier`; narrow its select to `id` and the fold folds
 * onto `undefined`, writes only this settle's amount, and performs the precise
 * erasure the fold exists to prevent -- while every assertion here stayed green.
 * The select list is load-bearing production behaviour and has to be pinned.
 *
 * `*` passes everything through. Only keys the row actually carries are copied,
 * so an absent column stays absent rather than becoming an explicit `undefined`.
 */
function projectRow(row: unknown, select: string): unknown {
  if (row === null || row === undefined) return row;
  if (select.trim() === "*") return row;
  const columns = new Set(select.split(",").map((c) => c.trim()));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (columns.has(key)) out[key] = value;
  }
  return out;
}

function project(data: unknown, select: string | undefined): unknown {
  if (typeof select !== "string") return data;
  return Array.isArray(data)
    ? data.map((r) => projectRow(r, select))
    : projectRow(data, select);
}

function chainTo(data: unknown, select?: string) {
  const projected = project(data, select);
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.eq = self;
  node.ilike = self;
  node.limit = () => Promise.resolve({ data: projected, error: null });
  node.single = () => Promise.resolve({ data: projected, error: null });
  node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: projected, error: null }).then(res, rej);
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
      select: (cols?: string) =>
        chainTo(
          table === "trace_jobs"
            ? H.job
            : table === "user_profiles"
              ? H.profile
              : typeof cols === "string" && cols.includes("ai_research_status")
                ? H.jobRows
                : H.historyRows,
          // trace_jobs is read with select('*'); everything else names its
          // columns and is projected through them.
          cols
        ),
      update: (payload: Record<string, unknown>) => {
        const filters: Array<[string, ...unknown[]]> = [];
        H.updates.push({ table, payload, filters });
        const node: Record<string, unknown> = {};
        const add =
          (method: string) =>
          (...args: unknown[]) => {
            filters.push([method, ...args]);
            return node;
          };
        for (const m of ["eq", "in", "or", "is", "ilike"]) node[m] = add(m);
        node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(res, rej);
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
vi.mock("@/lib/highlevel/client", () => ({ pushTraceToHighLevel: vi.fn() }));

const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));

beforeEach(() => {
  H.updates = [];
  H.rpcCalls = [];
  H.deductResult = true;
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);

  H.job = {
    id: "job-1",
    user_id: "user-1",
    status: "processing",
    tracerfy_job_id: "tj-1",
    records_submitted: 2,
    created_at: new Date().toISOString(),
  };

  H.profile = {
    id: "user-1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: null,
    webhook_url: "https://customer.example.com/hook",
    highlevel_api_key: null,
    highlevel_location_id: null,
  };

  // Every address resolves to a real trace_history row, so the billing branch
  // is reached for both results.
  H.historyRows = [{ id: "hist-1" }];

  // Two traced rows, nothing skipped, unless a test says otherwise.
  H.jobRows = [
    { charge: null, ai_research_status: null },
    { charge: null, ai_research_status: null },
  ];

  // Two contact-bearing rows => two billable matches.
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
      },
      {
        address: "456 OAK AVE",
        city: "Austin",
        state: "TX",
        first_name: "John",
        last_name: "Roe",
        email_1: "john@example.com",
      },
    ],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Per-row billing updates only. The trailing "sweep the leftovers to no_match"
 * update also carries `charge`, but never `trace_result`, so keying on
 * trace_result isolates the rows this loop actually settled.
 */
function billingUpdates() {
  return H.updates.filter(
    (u) => u.table === "trace_history" && "trace_result" in u.payload
  );
}

function webhookBody() {
  const call = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
  return call ? JSON.parse(call[1].body) : null;
}

/**
 * WHERE `total_charge` COMES FROM, AND WHY IT MOVED ON 2026-09-18.
 *
 * It used to be what THIS poll's loop collected. That number can only ever see
 * the Tracerfy leg, and since phase 5c a bulk job also carries tier 2 rows that
 * sweep-property-traces bills on its own. A job finishing after those rows
 * settled would have reported the money it collected this poll, which is zero,
 * while the customer's wallet said otherwise.
 *
 * So it is now the SUM OF THE STORED PER-ROW CHARGES, read back after the loop
 * has written them. That is still only money that actually moved -- the row
 * write persists what deductOrZero returned, not what was intended -- so the
 * fence below is the same fence. It is also exactly what the already-completed
 * branch at the top of the handler reports, so the two branches stopped
 * answering the same question two different ways.
 *
 * The `jobRows` fixtures in each test therefore carry the charges the loop just
 * wrote, which is what the database holds by the time the read happens.
 */
describe("bulk/status route totals only the wallet amount actually collected", () => {
  it("records and reports 0 when deduct_wallet_balance returns false", async () => {
    H.deductResult = false;
    // Nothing moved, so nothing is on the rows to read back.
    H.jobRows = [
      { charge: 0, ai_research_status: null },
      { charge: 0, ai_research_status: null },
    ];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1")
    );
    const body = await res.json();

    // Both rows attempted a deduct at the real rate...
    const deducts = H.rpcCalls.filter((c) => c[0] === "deduct_wallet_balance");
    expect(deducts).toHaveLength(2);
    expect(deducts[0][1].p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);

    // ...and none of it moved.
    const rows = billingUpdates();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.payload.charge).toBe(0);
      // The trace result itself survives.
      expect(row.payload.status).toBe("success");
      expect(row.payload.is_successful).toBe(true);
    }

    // The job summary must not claim money either -- on both doors.
    expect(body.total_charge).toBe(0);
    expect(webhookBody().total_charge).toBe(0);

    // The matches themselves still happened; only the billing did not.
    expect(body.records_matched).toBe(2);
  });

  it("records and reports the full total when the deducts succeed", async () => {
    H.deductResult = true;
    // Both deducts moved, so both rows carry their charge when they are read
    // back for the job summary.
    H.jobRows = [
      { charge: PRICING.CHARGE_PER_SUCCESS_WALLET, ai_research_status: null },
      { charge: PRICING.CHARGE_PER_SUCCESS_WALLET, ai_research_status: null },
    ];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1")
    );
    const body = await res.json();

    const rate = PRICING.CHARGE_PER_SUCCESS_WALLET;
    for (const row of billingUpdates()) {
      expect(row.payload.charge).toBe(rate);
    }
    expect(body.total_charge).toBeCloseTo(rate * 2, 10);
    expect(webhookBody().total_charge).toBeCloseTo(rate * 2, 10);
  });
});

/* ------------------------------------------------------------------ *
 * THE JOB MAY NOT FINISH OVER WORK THAT HAS NOT RUN.
 *
 * A MIXED job carries tier 1 rows this route settles and tier 2 rows
 * sweep-property-traces is still working. The tier 2 rows are invisible
 * to the result loop, because a queued row never gets a
 * tracerfy_job_id, so before phase 5c-3 this route would mark the job
 * completed the moment Tracerfy answered. The branch at the top of the
 * handler short-circuits a completed job, so it is never polled again:
 * the customer keeps a summary and a downloadable CSV that are short by
 * exactly the rows they are about to be billed for.
 * ------------------------------------------------------------------ */

describe("a job whose tier 2 rows are still queued", () => {
  it("stays processing rather than completing over them", async () => {
    // MUTATION: delete the isPropertyTracePending gate and this goes red.
    H.jobRows = [
      { charge: PRICING.CHARGE_PER_SUCCESS_WALLET, ai_research_status: null },
      { charge: null, ai_research_status: null, property_trace_status: "queued" },
    ];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1")
    );
    const body = await res.json();

    expect(body.status).toBe("processing");
    expect(body.records_pending_property_trace).toBe(1);
    // The job row is NOT written completed, which is what would stop it ever
    // being polled again.
    const completed = H.updates.filter(
      (u) => u.table === "trace_jobs" && u.payload.status === "completed"
    );
    expect(completed).toHaveLength(0);
  });

  it("still settles the tier 1 rows on that same poll", async () => {
    // Waiting on the job is not a reason to leave a paid Tracerfy row at
    // 'processing'. sweep-stale-traces would later claim such a row and settle
    // it against whichever OTHER property in the shared batch came back with a
    // phone. Only the JOB-level completion waits.
    H.jobRows = [{ charge: null, ai_research_status: null, property_trace_status: "queued" }];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1"));

    expect(billingUpdates().length).toBeGreaterThan(0);
    expect(H.rpcCalls.filter((c) => c[0] === "deduct_wallet_balance").length).toBe(2);
  });

  it("completes once every tier 2 row is terminal, counting its matches and money", async () => {
    // The other side of the fence. A terminal value must read as NOT pending or
    // the job is held open forever, and the tier 2 charge the cron booked has to
    // reach the total: the result loop above can never see it.
    H.jobRows = [
      { charge: PRICING.CHARGE_PER_SUCCESS_WALLET, ai_research_status: null },
      {
        charge: 0.4,
        ai_research_status: null,
        property_trace_status: "property_trace_done",
        is_successful: true,
      },
    ];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1")
    );
    const body = await res.json();

    expect(body.status).toBe("completed");
    expect(body.total_charge).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET + 0.4, 10);
    // Two tier 1 matches from the result loop plus the one tier 2 row that found
    // contacts. MUTATION: count only the loop's matches and this goes red.
    expect(body.records_matched).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * THE STALL PATH IS A VERDICT ON THE WHOLE JOB TOO.
 *
 * When Tracerfy has been unhealthy for 15 minutes this route marks the
 * job failed. That says nothing about the dossier queue, which is a
 * different vendor endpoint on a different clock, and whose rows keep
 * running and keep billing. Declaring the job failed over them hands the
 * customer a terminal verdict on work they are still being charged for,
 * and the top of this handler then short-circuits the job so it is never
 * polled again.
 * ------------------------------------------------------------------ */

describe("a Tracerfy stall on a job with tier 2 rows", () => {
  beforeEach(() => {
    H.job = {
      ...H.job,
      created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    };
    H.jobStatus = { success: false, pending: false, errorReason: "rate_limited" };
  });

  const jobStatusWrites = () =>
    H.updates.filter((u) => u.table === "trace_jobs");

  it("does NOT fail the job while the queue is still working", async () => {
    // MUTATION: mark the job failed unconditionally again and this goes red.
    H.jobRows = [{ charge: null, ai_research_status: null, property_trace_status: "queued" }];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1"))
    ).json();

    expect(body.status).toBe("processing");
    expect(body.records_pending_property_trace).toBe(1);
    expect(jobStatusWrites()).toHaveLength(0);
  });

  it("still errors the stalled tier 1 rows, which really are stuck", async () => {
    // Holding the job open is not a reason to leave a tier 1 row at
    // 'processing' for another cron to settle against a stranger's contacts.
    H.jobRows = [{ charge: null, ai_research_status: null, property_trace_status: "queued" }];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1"));

    const errored = H.updates.filter(
      (u) => u.table === "trace_history" && u.payload.status === "error"
    );
    expect(errored).toHaveLength(1);
  });

  it("tells the caller the Tracerfy half died, rather than hiding it", async () => {
    H.jobRows = [{ charge: null, ai_research_status: null, property_trace_status: "queued" }];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1"))
    ).json();

    expect(body.tracerfy_state).toBe("rate_limited");
    expect(body.error_message).toContain("unhealthy");
  });

  it("STILL fails the job when no tier 2 row is running", async () => {
    // The guard must not become a blanket refusal to ever fail a stalled job.
    H.jobRows = [{ charge: null, ai_research_status: null }];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1"))
    ).json();

    expect(body.status).toBe("failed");
    expect(jobStatusWrites()).toHaveLength(1);
    expect(jobStatusWrites()[0].payload.status).toBe("failed");
  });
});

/* ------------------------------------------------------------------ *
 * A JOB WITH NO TRACERFY JOB ID USED TO MEAN ONE THING AND NOW MEANS
 * TWO.
 *
 * It used to mean the submit had nothing to send, and the submit route
 * closed such a job itself. Since phase 5c it is also the normal shape
 * of a job whose rows are ALL tier 2: no person CSV, the cron owns every
 * row, and this route is the only thing that can notice when it is done.
 * The old branch returned a bare 'processing' unconditionally, which
 * would park that job at processing for good.
 * ------------------------------------------------------------------ */

describe("a job whose rows are all tier 2", () => {
  beforeEach(() => {
    H.job = { ...H.job, tracerfy_job_id: null, records_submitted: 1 };
  });

  it("reports processing while the queue still owes work", async () => {
    H.jobRows = [{ charge: null, ai_research_status: null, property_trace_status: "queued_2" }];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1"))
    ).json();

    expect(body.status).toBe("processing");
    expect(body.records_pending_property_trace).toBe(1);
  });

  it("FINISHES the job once the queue drains, instead of polling forever", async () => {
    // MUTATION: restore the unconditional `return processing` for a job with no
    // tracerfy_job_id and this goes red. Without it the job never completes, the
    // page polls to exhaustion, and History shows it processing for good.
    H.jobRows = [
      {
        charge: 0.4,
        ai_research_status: null,
        property_trace_status: "property_trace_done",
        is_successful: true,
      },
    ];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const body = await (
      await GET(new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1"))
    ).json();

    expect(body.status).toBe("completed");
    expect(body.records_matched).toBe(1);
    // The money the cron booked reaches the summary. A per-poll total could only
    // ever have reported 0 here, on a job the customer really was charged for.
    expect(body.total_charge).toBeCloseTo(0.4, 10);
    const completed = H.updates.filter(
      (u) => u.table === "trace_jobs" && u.payload.status === "completed"
    );
    expect(completed).toHaveLength(1);
  });

  it("asks no vendor at all, because there is no Tracerfy job to poll", async () => {
    H.jobRows = [{ charge: null, ai_research_status: null, property_trace_status: "queued" }];

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    await GET(new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1"));

    expect(H.rpcCalls.filter((c) => c[0] === "deduct_wallet_balance")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * RECEIPTS SURVIVE THIS SETTLE.
 *
 * Every row here is REUSED, not re-inserted -- UNIQUE(user_id, address_hash) --
 * and wallet_transactions references it with ON DELETE NO ACTION. Under bulk
 * tier 2 a billed miss is `tier = 2, charge > 0, is_successful = false`, which
 * is exactly what both writes below land on: the per-result settle REPLACES
 * `charge` with whatever this round collected, and the trailing sweep writes a
 * flat `charge: 0, tier: 1` over every row still processing, by job id, having
 * read none of them.
 * ------------------------------------------------------------------ */
describe("bulk/status never erases a receipt already on the row", () => {
  const GET = async () => {
    const mod = await import("@/app/api/trace/bulk/status/route");
    return mod.GET(
      new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1")
    );
  };

  beforeEach(() => {
    // One result, so exactly one row settles through the per-result branch.
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
        },
      ],
    };
    // The row the loop finds already carries a $0.25 tier 2 receipt.
    H.historyRows = [{ id: "hist-1", charge: 0.25, tier: 2 }];
  });

  it("site 288 (successful match): ACCUMULATES the new debit onto the old one", async () => {
    await GET();
    const settle = billingUpdates()[0].payload;
    // MUTATION: write the bare `charge` instead of `billing.charge` and this
    // goes red -- the first debit disappears from the row.
    expect(settle.charge).toBe(0.5);
    expect(settle.charge).not.toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(settle.tier).toBe(2);
  });

  it("site 288 (no-match result): keeps the charge and the tier", async () => {
    // A tier 1 miss collects nothing further. It does not make the row free.
    H.jobStatus = {
      success: true,
      pending: false,
      results: [{ address: "123 MAIN ST", city: "Austin", state: "TX" }],
    };
    await GET();
    const settle = billingUpdates()[0].payload;
    // MUTATION: unfold and this goes red -- a paid row is declared free.
    expect(settle.charge).toBe(0.25);
    expect(settle.tier).toBe(2);
  });

  /* ---------------------------------------------------------------- *
   * SITE 302, THE BLANKET LEFTOVER SWEEP.
   *
   * STATUS IS NOT A RECEIPT. excludeBilledRows protects `charge` and `tier`;
   * `status` and `is_successful` are DELIVERY facts. Behind the same guard, a
   * billed tier 2 row that Tracerfy returned nothing for is skipped and keeps
   * `status = 'processing'` -- and the very next statement marks the job
   * `completed`, whose early-return means this job is never polled again. An
   * hour later sweep-stale-traces stage 1 claims that row (status +
   * created_at, no trace_job_id restriction) and settles it against whichever
   * OTHER record of the shared Tracerfy batch carried a phone. Second charge,
   * stranger's contacts on the customer's parcel, pushed to their CRM.
   *
   * Two statements. Money behind the guard, delivery in front of it.
   * ---------------------------------------------------------------- */
  const blanketStatements = () => {
    const blanket = H.updates.filter(
      (u) => u.table === "trace_history" && !("trace_result" in u.payload)
    );
    return {
      guarded: blanket.filter((u) => u.filters.some((f) => f[0] === "or")),
      unguarded: blanket.filter((u) => !u.filters.some((f) => f[0] === "or")),
    };
  };

  it("site 302: the GUARDED statement carries the money and no delivery facts", async () => {
    await GET();
    const { guarded } = blanketStatements();
    expect(guarded).toHaveLength(1);
    // MUTATION: unwrap the excludeBilledRows() call and these go red.
    expect(guarded[0].filters.filter((f) => f[0] === "or")).toHaveLength(2);
    expect(
      guarded[0].filters.some((f) => f[0] === "is" && f[1] === "property_record")
    ).toBe(true);
    // MONEY ONLY. Safe precisely because the guard means the statement cannot
    // match a row that collected anything.
    expect(guarded[0].payload.charge).toBe(0);
    expect(guarded[0].payload.tier).toBe(1);
    // MUTATION: move `status` into this payload and this goes red -- that is
    // the change that strands a paid row.
    expect(Object.keys(guarded[0].payload)).not.toContain("status");
    expect(Object.keys(guarded[0].payload)).not.toContain("is_successful");
  });

  it("site 302: an UNGUARDED statement resolves every row, billed or not", async () => {
    await GET();
    const { unguarded } = blanketStatements();
    // MUTATION: delete this statement, or wrap it in excludeBilledRows, and
    // this goes red -- a billed row is then left in 'processing' inside a job
    // this handler marks completed on the very next statement, where only
    // sweep-stale-traces can reach it, and it settles that row against another
    // property's contacts from the shared batch.
    expect(unguarded).toHaveLength(1);
    expect(unguarded[0].payload.status).toBe("no_match");
    expect(unguarded[0].payload.is_successful).toBe(false);
    // And it carries no money, or the guard above was pointless.
    expect(Object.keys(unguarded[0].payload)).not.toContain("charge");
    expect(Object.keys(unguarded[0].payload)).not.toContain("tier");
  });

  /* ---------------------------------------------------------------- *
   * "UNGUARDED" MEANS NO RECEIPT GUARD. IT DOES NOT MEAN UNFILTERED.
   *
   * This statement is a BLANKET write keyed on (user, tracerfy_job_id): it
   * names no row and reads none. The only thing separating "the leftovers" from
   * "every row of this job" is `status = 'processing'`, and the per-result loop
   * directly above has just moved the matched rows to 'success'.
   *
   * Without that filter this statement stamps `no_match, is_successful: false,
   * phone/email counts untouched` over rows that were settled seconds earlier
   * WITH REAL CONTACTS ON THEM -- and it does so after the money statement has
   * already run, so the customer is charged and then told there was no match.
   * Every surface reads the row as a failure while `charge` says they paid.
   * ---------------------------------------------------------------- */
  it("site 302: the UNGUARDED statement touches only rows still processing", async () => {
    await GET();
    const { unguarded } = blanketStatements();
    // MUTATION: delete the `.eq('status','processing')` from this statement and
    // this goes red -- the sweep resets the rows that just succeeded.
    expect(
      unguarded[0].filters.some(
        (f) => f[0] === "eq" && f[1] === "status" && f[2] === "processing"
      )
    ).toBe(true);
  });

  /* ---------------------------------------------------------------- *
   * THE ORDER OF THE TWO STATEMENTS IS LOAD-BEARING.
   *
   * Both select on `status = 'processing'`, and the delivery statement is what
   * ENDS that status. Run delivery first and the money statement matches
   * nothing: every unbilled leftover row keeps a NULL `charge` and an unstamped
   * `tier` instead of being normalised to `charge: 0, tier: 1`.
   *
   * That is not cosmetic. `tier` is what isCacheHitRow's third arm reads, and a
   * NULL `charge` is what excludeBilledRows' `charge.is.null` arm exists to
   * catch. Neither statement says a word about the other, so nothing but this
   * test stops a later edit from moving the delivery write above the money one.
   * ---------------------------------------------------------------- */
  it("site 302: the MONEY statement runs FIRST, while the rows are still processing", async () => {
    await GET();
    const { guarded, unguarded } = blanketStatements();
    // MUTATION: swap the two statements in the source and this goes red.
    expect(H.updates.indexOf(guarded[0])).toBeGreaterThanOrEqual(0);
    expect(H.updates.indexOf(guarded[0])).toBeLessThan(H.updates.indexOf(unguarded[0]));
  });
});

/**
 * David's rule for a bulk row that arrived with no owner name: accept the file,
 * skip the row with a reason, charge nothing, and put the reason in the job
 * summary AND the CSV. The CSV half shipped; this is the job summary half.
 *
 * Without it the dashboard shows a finished job whose skipped rows read as a
 * bare no_match, which tells the customer we looked and found nobody when no
 * vendor was ever asked. The v1 status route and the MCP tool already serve
 * skipReasonFor() on every record; this route serves the same accessor, so the
 * three surfaces cannot drift on the wording.
 */
describe("the job summary says how many rows were skipped and why", () => {
  const GET = async () => {
    const mod = await import("@/app/api/trace/bulk/status/route");
    return mod.GET(
      new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1")
    );
  };

  it("reports the skipped count and reason on a job that finishes this poll", async () => {
    // MUTATION: drop records_skipped / skip_reason from the completed response
    // and this goes red -- the user is back to downloading the CSV to find out
    // why rows came back empty.
    H.jobRows = [
      { charge: PRICING.CHARGE_PER_SUCCESS_WALLET, ai_research_status: null },
      { charge: null, ai_research_status: BLANK_OWNER_SKIP_STATUS },
      { charge: null, ai_research_status: BLANK_OWNER_SKIP_STATUS },
    ];

    const body = await (await GET()).json();

    expect(body.status).toBe("completed");
    expect(body.records_skipped).toBe(2);
    expect(body.skip_reason).toContain("No owner name came in");
  });

  it("tells the user in the same sentence that they were not charged", async () => {
    // The row is free. A reason that does not say so leaves the customer
    // checking their wallet against a job summary that never mentions it.
    H.jobRows = [{ charge: null, ai_research_status: BLANK_OWNER_SKIP_STATUS }];
    const body = await (await GET()).json();
    expect(body.skip_reason).toContain("not charged");
  });

  it("reports them on a job that was already finished before this poll", async () => {
    // The stored-stats branch is what every poll after the first one hits, and
    // what a user who reloads the page sees. It must say the same thing.
    H.job = { ...H.job, status: "completed", records_matched: 1 };
    H.jobRows = [
      { charge: PRICING.CHARGE_PER_SUCCESS_WALLET, ai_research_status: null },
      { charge: null, ai_research_status: BLANK_OWNER_SKIP_STATUS },
    ];

    const body = await (await GET()).json();

    expect(body.records_skipped).toBe(1);
    expect(body.skip_reason).toContain("not charged");
    // The skipped row contributes nothing to the money, which is the claim the
    // reason is making.
    expect(body.total_charge).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET, 10);
  });

  it("says nothing was skipped when nothing was", async () => {
    // A reason on a job where every row was traced would be a false statement
    // in the other direction.
    const body = await (await GET()).json();
    expect(body.records_skipped).toBe(0);
    expect(body.skip_reason).toBeNull();
  });

  it("carries a vendor-exhausted row's own reason, not the blank-owner one", async () => {
    // Two different things end up as an untraced row and they are not the same
    // to a customer: a blank owner is something they can fix by resending the
    // row, an exhausted entity trace is our side failing to reach a vendor.
    // Both are free. skipReasonFor() is what keeps them distinct.
    H.jobRows = [{ charge: null, ai_research_status: ENTITY_TRACE_FAILED_STATUS }];
    const body = await (await GET()).json();
    expect(body.records_skipped).toBe(1);
    expect(body.skip_reason).toContain("business records service");
    expect(body.skip_reason).not.toContain("No owner name came in");
  });
});
