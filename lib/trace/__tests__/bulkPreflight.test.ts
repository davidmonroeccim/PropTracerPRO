import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROPERTY_TRACE_NO_KEY_STATUS,
  PROPERTY_TRACE_PENDING_STATUSES,
  PROPERTY_TRACE_SETTLED_STATUS,
} from "@/lib/trace/propertyTraceAttempts";
import { STALE_PROCESSING } from "@/lib/constants";
import {
  TIER1_FAILED_STATUS,
  TIER1_PENDING_STATUSES,
  TIER1_SETTLED_STATUS,
} from "@/lib/trace/tier1Queue";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * THE TWO PRE-FLIGHT CHECKS, AND THE ONE THING THEY MUST NEVER DO: SWAP
 * SENTENCES.
 *
 * One asks whether the CUSTOMER can pay and answers with a 402 that tells them
 * to add funds. The other asks whether PTP can EXECUTE and must never mention
 * the customer's funds at all, because it is our credit pool that is short, not
 * their wallet. Billing a customer for a job we cannot run is the outcome the
 * second one exists to prevent, and blaming them for our shortage is the
 * outcome its wording exists to prevent.
 */

const H = vi.hoisted(() => ({
  analytics: { success: true, data: { balance: 10694 } } as Record<string, unknown>,
  queuedCount: 0 as number | null,
  queuedError: null as { message: string } | null,
  // The TIER 1 queue's own count and its own error, kept SEPARATE from the tier 2 pair above.
  // Separate so the "raises OUR failure on the Tier 1 count too" test can fence that branch on its
  // own: with one shared error field the tier 2 query throws first and the Tier 1 branch is never
  // reached, which would be a test that passes without fencing anything.
  queuedTier1Count: 0 as number | null,
  queuedTier1Error: null as { message: string } | null,
  inFlightRows: [] as Array<Record<string, unknown>>,
  inFlightError: null as { message: string } | null,
  filters: [] as Array<[string, unknown, unknown]>,
}));

vi.mock("@/lib/tracerfy/client", () => ({
  getAnalytics: vi.fn(async () => H.analytics),
}));

const { getAnalytics } = await import("@/lib/tracerfy/client");
const {
  TRACERFY_DOSSIER_CREDITS,
  TRACERFY_TIER1_CREDITS,
  TIER2_CAPACITY_REFUSAL,
  inFlightUnbilledCost,
  tracerfyCanRun,
} = await import("@/lib/trace/bulkPreflight");

/** A client that records its filters and answers the two shapes this module uses. */
function fakeClient() {
  return {
    from() {
      const node: Record<string, unknown> = {};
      const track = (name: string) => (a: unknown, b: unknown) => {
        H.filters.push([name, a, b]);
        return node;
      };
      // WHICH QUEUE WAS ASKED ABOUT. tracerfyCanRun makes TWO head+count queries, one per queue, and
      // a harness that answers the same number to both cannot tell a per-tier bug from a correct
      // answer. Recorded here rather than inferred from call order, because order is not the contract.
      let countColumn: string | null = null;
      node.in = (a: unknown, b: unknown) => {
        H.filters.push(["in", a, b]);
        countColumn = String(a);
        return node;
      };
      node.eq = track("eq");
      node.or = track("or");
      // A head+count select answers `{ count, error }`; a plain one answers
      // `{ data, error }`. Both are awaited at the END of the chain, after the
      // filters, which is the order the real builder takes them in.
      let counting = false;
      node.select = (_cols: string, opts?: { count?: string; head?: boolean }) => {
        counting = opts?.head === true;
        return node;
      };
      node.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          counting
            ? countColumn === "ai_research_status"
              ? { count: H.queuedTier1Count, error: H.queuedTier1Error }
              : { count: H.queuedCount, error: H.queuedError }
            : { data: H.inFlightRows, error: H.inFlightError }
        ).then(res);
      return node;
    },
  } as unknown as SupabaseClient;
}

const errorLogs = () =>
  vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(" "));

beforeEach(() => {
  vi.clearAllMocks();
  H.analytics = { success: true, data: { balance: 10694 } };
  H.queuedCount = 0;
  H.queuedError = null;
  H.queuedTier1Count = 0;
  H.queuedTier1Error = null;
  H.inFlightRows = [];
  H.inFlightError = null;
  H.filters = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/* ------------------------------------------------------------------ *
 * CHECK 2: CAN PTP EXECUTE?
 * ------------------------------------------------------------------ */

describe("the Tracerfy capacity check", () => {
  it("lets a job through when the pool covers it", async () => {
    expect(await tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 500 })).toBe(true);
  });

  it("asks no vendor at all when the job is empty on BOTH tiers", async () => {
    // An empty batch draws nothing from either pool, so spending an HTTP round
    // trip to prove it would be a cost with no question behind it.
    expect(await tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 0 })).toBe(true);
    expect(getAnalytics).not.toHaveBeenCalled();
  });

  it("sizes a record at the dossier's credit cost", async () => {
    // MUTATION: change the multiplicand and this goes red. 100 records is
    // 1,000 credits, so a 999 balance cannot run it and a 1,000 one can.
    H.analytics = { success: true, data: { balance: 100 * TRACERFY_DOSSIER_CREDITS } };
    expect(await tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 100 })).toBe(true);

    H.analytics = { success: true, data: { balance: 100 * TRACERFY_DOSSIER_CREDITS - 1 } };
    expect(await tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 100 })).toBe(false);
  });

  it("counts what is ALREADY queued, because the pool is shared", async () => {
    // THE WHOLE POINT OF THE CHECK. Sized against the raw balance, two jobs
    // that cannot both run both pass. MUTATION: drop the queued term and this
    // goes red.
    H.analytics = { success: true, data: { balance: 100 * TRACERFY_DOSSIER_CREDITS } };
    H.queuedCount = 1;
    expect(await tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 100 })).toBe(false);
  });

  it("counts every rung of the ladder as still in flight, claimed rows included", async () => {
    // A row mid-retry and a row a worker is holding are both work the pool
    // still owes credits to.
    await tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 1 });
    const inFilter = H.filters.find(
      (f) => f[0] === "in" && f[1] === "property_trace_status"
    );
    expect(inFilter).toBeDefined();
    expect(inFilter![2]).toEqual(PROPERTY_TRACE_PENDING_STATUSES);
    // A terminal row is finished with the pool and must not hold capacity back.
    expect(inFilter![2]).not.toContain(PROPERTY_TRACE_SETTLED_STATUS);
    expect(inFilter![2]).not.toContain(PROPERTY_TRACE_NO_KEY_STATUS);

    // TWO LADDERS NOW, so the twin assertion for the Tier 1 queue. A Tier 1 row mid-retry owes the
    // same pool its person lookup, so it holds capacity back exactly as a tier 2 row does.
    const tier1Filter = H.filters.find((f) => f[0] === "in" && f[1] === "ai_research_status");
    expect(tier1Filter).toBeDefined();
    expect(tier1Filter![2]).toEqual(TIER1_PENDING_STATUSES);
    // A terminal Tier 1 row is finished with the pool and must not hold capacity back.
    expect(tier1Filter![2]).not.toContain(TIER1_SETTLED_STATUS);
    expect(tier1Filter![2]).not.toContain(TIER1_FAILED_STATUS);
  });

  it("refuses when it cannot read the balance, rather than assuming one", async () => {
    // An unreadable balance is not a balance of zero and it is not a balance of
    // plenty. Treating it as enough is inventing a result, which is the one
    // thing this project is least allowed to do.
    H.analytics = { success: false, error: "Tracerfy service unavailable" };
    expect(await tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 1 })).toBe(false);
  });

  it("refuses when the response carries no balance number", async () => {
    H.analytics = { success: true, data: {} };
    expect(await tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 1 })).toBe(false);
  });

  it("leaves the operator a log line, which is the only surface there is", async () => {
    // PTP has no alerting channel by David's explicit decision, so a console
    // line is the whole of it. MUTATION: delete the console.error and an
    // operator finds out the pool ran dry from a customer.
    H.analytics = { success: true, data: { balance: 0 } };
    await tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 1 });
    expect(errorLogs().filter((l) => l.includes("[bulk-preflight]"))).toHaveLength(1);
  });

  it("raises our own database failure instead of answering it", async () => {
    // A vendor we cannot read is a capacity answer. Our own table failing is
    // not: it is an infrastructure failure and it belongs in the route's 500,
    // not dressed up as a refusal the customer will read as our credit pool.
    H.queuedError = { message: "connection reset" };
    await expect(tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 1 })).rejects.toThrow(
      /connection reset/
    );
  });
});

describe("tracerfyCanRun and a TIER 1 batch", () => {
  it("reads the balance for a tier-1-only batch, which it used to skip entirely", async () => {
    // THE GAP THIS STEP CLOSES. The old tier-2-only capacity check, which took a tier 2 count and
    // nothing else, returned true unconditionally for `newRecords <= 0`, so a 500-record
    // all-tier-1 batch never read the balance at all. Its own docstring recorded that as
    // deliberate, and it WAS, while tier 1 posted to the BATCH endpoint.
    H.analytics = { success: true, data: { balance: 100 } };
    expect(await tracerfyCanRun(fakeClient(), { tier1: 500, tier2: 0 })).toBe(false);
    expect(getAnalytics).toHaveBeenCalled();
  });

  it("sizes a tier 1 record at the person lookup it spends", async () => {
    // 10 records x TRACERFY_TIER1_CREDITS = 50, exactly the balance.
    H.analytics = { success: true, data: { balance: 10 * TRACERFY_TIER1_CREDITS } };
    expect(await tracerfyCanRun(fakeClient(), { tier1: 10, tier2: 0 })).toBe(true);
    expect(await tracerfyCanRun(fakeClient(), { tier1: 11, tier2: 0 })).toBe(false);
  });

  it("adds the two tiers rather than sizing on whichever is larger", async () => {
    // 4 tier 1 (20) + 3 tier 2 (30) = 50.
    H.analytics = {
      success: true,
      data: { balance: 4 * TRACERFY_TIER1_CREDITS + 3 * TRACERFY_DOSSIER_CREDITS },
    };
    expect(await tracerfyCanRun(fakeClient(), { tier1: 4, tier2: 3 })).toBe(true);
    expect(await tracerfyCanRun(fakeClient(), { tier1: 4, tier2: 4 })).toBe(false);
  });

  it("counts the rows ALREADY queued on BOTH queues, not just the new ones", async () => {
    // THE POINT OF THE CHECK, now doubled. Sized against the raw balance, two jobs that cannot both
    // run both pass. Sized against ONE queue, a customer with 5 tier 1 rows already queued passes a
    // batch the pool cannot cover.
    H.analytics = { success: true, data: { balance: 50 } };
    H.queuedTier1Count = 5;
    H.queuedCount = 2;
    // queued: 5 x 5 + 2 x 10 = 45. One more tier 1 record is 50; two is 55.
    expect(await tracerfyCanRun(fakeClient(), { tier1: 1, tier2: 0 })).toBe(true);
    expect(await tracerfyCanRun(fakeClient(), { tier1: 2, tier2: 0 })).toBe(false);
  });

  it("asks nothing when the batch is empty on both tiers", async () => {
    expect(await tracerfyCanRun(fakeClient(), { tier1: 0, tier2: 0 })).toBe(true);
    expect(getAnalytics).not.toHaveBeenCalled();
  });

  it("refuses rather than assuming plenty when the balance cannot be read", async () => {
    H.analytics = { success: false, error: "timeout" };
    expect(await tracerfyCanRun(fakeClient(), { tier1: 1, tier2: 0 })).toBe(false);
  });

  it("raises OUR failure on the Tier 1 count too, never answers it", async () => {
    // Same rule as the tier 2 count above: a vendor we cannot read is a capacity answer, our own
    // table failing is an infrastructure failure and belongs in the route's 500. The error is set on
    // the TIER 1 pair specifically, so the tier 2 query succeeds and this reaches the branch it is
    // written for. With one shared error field it would pass without fencing anything.
    H.queuedTier1Error = { message: "connection reset on the tier 1 count" };
    await expect(tracerfyCanRun(fakeClient(), { tier1: 1, tier2: 0 })).rejects.toThrow(
      /connection reset on the tier 1 count/
    );
  });
});

describe("what the customer is told when PTP cannot execute", () => {
  it("never mentions their funds, their wallet or their balance", async () => {
    // David, 2026-09-18, binding: it is PTP's balance that is short, not
    // theirs. MUTATION: reuse the 402 copy here and this goes red.
    expect(TIER2_CAPACITY_REFUSAL.toLowerCase()).not.toMatch(
      /add funds|your (wallet|balance)|top up|insufficient/
    );
  });

  it("never claims anyone was notified, because nobody is", async () => {
    expect(TIER2_CAPACITY_REFUSAL.toLowerCase()).not.toMatch(
      /notif|alerted|our team|we have been told|support has/
    );
  });

  it("says they were not charged, and quotes no price", async () => {
    expect(TIER2_CAPACITY_REFUSAL).toContain("not charged");
    expect(TIER2_CAPACITY_REFUSAL).not.toMatch(/\$|\d+\s*cent/);
  });

  it("carries no formatting artifacts", async () => {
    expect(TIER2_CAPACITY_REFUSAL).not.toMatch(/[—–*]/);
  });
});

/* ------------------------------------------------------------------ *
 * CHECK 1, THE HALF THAT WAS ADVISORY: IN-FLIGHT UNBILLED WORK
 * ------------------------------------------------------------------ */

describe("in-flight unbilled work", () => {
  const RATES = { tier1: 0.25, tier2: 0.4 };

  it("is nothing when the user has no unsettled rows", async () => {
    expect(await inFlightUnbilledCost(fakeClient(), "u1", RATES)).toBe(0);
  });

  it("counts a queued tier 2 row at the tier 2 rate", async () => {
    H.inFlightRows = [{ status: "processing", property_trace_status: "queued" }];
    expect(await inFlightUnbilledCost(fakeClient(), "u1", RATES)).toBeCloseTo(RATES.tier2);
  });

  it("counts a tier 2 row ONCE, not once per column it appears in", async () => {
    // A queued tier 2 row is ALSO status 'processing'. Adding both rates would
    // reserve $0.65 for a row that can only ever cost $0.40, and would 402 a
    // wallet that can afford the batch. MUTATION: turn the else-if into a
    // second if and this goes red.
    H.inFlightRows = [{ status: "processing", property_trace_status: "queued_3" }];
    expect(await inFlightUnbilledCost(fakeClient(), "u1", RATES)).toBeCloseTo(RATES.tier2);
  });

  it("counts an unsettled tier 1 row at the tier 1 rate", async () => {
    H.inFlightRows = [{ status: "processing", property_trace_status: null }];
    expect(await inFlightUnbilledCost(fakeClient(), "u1", RATES)).toBeCloseTo(RATES.tier1);
  });

  it("ignores a row whose tier 2 work already settled", async () => {
    // Settled means billed. Reserving for it a second time would refuse a
    // wallet that has already paid.
    H.inFlightRows = [
      { status: "no_match", property_trace_status: PROPERTY_TRACE_SETTLED_STATUS },
    ];
    expect(await inFlightUnbilledCost(fakeClient(), "u1", RATES)).toBe(0);
  });

  it("asks only about THIS user's rows", async () => {
    await inFlightUnbilledCost(fakeClient(), "u1", RATES);
    expect(H.filters.some((f) => f[0] === "eq" && f[1] === "user_id" && f[2] === "u1")).toBe(
      true
    );
  });

  it("bounds the TIER 1 arm by age, so an orphan cannot reserve forever", async () => {
    // A tier 1 row can be orphaned at 'processing': a billed row inside a job
    // already marked completed is invisible to both stages of
    // sweep-stale-traces, so nothing ever resolves it. Unbounded, 40 of those
    // reserve $10 of a customer's wallet permanently and their 402 describes
    // traces as still running that never will.
    // MUTATION: drop the `and(...)` wrapper and this goes red.
    await inFlightUnbilledCost(fakeClient(), "u1", RATES);
    const or = H.filters.find((f) => f[0] === "or");
    expect(or).toBeDefined();
    expect(String(or![1])).toContain("and(status.eq.processing,created_at.gte.");
  });

  it("does NOT bound the tier 2 arm, because that one is bounded already", async () => {
    // The ladder and the cron's stale-claim recovery guarantee a tier 2 row
    // reaches a terminal value, so an age bound there would stop reserving for a
    // row that IS going to be billed. Under-reserving certain money is the wrong
    // direction to fail in.
    await inFlightUnbilledCost(fakeClient(), "u1", RATES);
    const clause = String(H.filters.find((f) => f[0] === "or")![1]);
    const tier2Part = clause.slice(clause.indexOf("property_trace_status.in."));
    expect(tier2Part).not.toContain("created_at");
  });

  it("uses the age at which the system itself calls a processing row stale", async () => {
    // Not a number picked here. Past CRON_TIMEOUT_MINUTES the sweeper resolves
    // such a row, so beyond it a row still sitting there is orphaned by the
    // system's own definition, and the reserve and the sweep agree about what
    // "still running" means instead of each having a private answer.
    const before = Date.now();
    await inFlightUnbilledCost(fakeClient(), "u1", RATES);
    const clause = String(H.filters.find((f) => f[0] === "or")![1]);
    const cutoff = Date.parse(
      clause.slice(clause.indexOf("created_at.gte.") + "created_at.gte.".length).split(")")[0]
    );
    const expected = before - STALE_PROCESSING.CRON_TIMEOUT_MINUTES * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000);
  });

  it("raises rather than reporting zero when the query fails", async () => {
    // Zero in-flight is a claim that nothing is owed. Making that claim because
    // a query failed is exactly the fabricated result the reserve exists to
    // stop being acted on.
    H.inFlightError = { message: "statement timeout" };
    await expect(inFlightUnbilledCost(fakeClient(), "u1", RATES)).rejects.toThrow(
      /statement timeout/
    );
  });
});

/* ------------------------------------------------------------------ *
 * THE TIER 1 QUEUE (spec 6.2). A web bulk job's rows are queued on
 * ai_research_status rather than submitted to Tracerfy, so this column has to
 * reserve too, or two batches sent back to back can both pass on the same
 * dollars.
 * ------------------------------------------------------------------ */

describe("inFlightUnbilledCost and the Tier 1 queue (spec 6.2)", () => {
  const RATES = { tier1: 0.15, tier2: 0.25 };

  it("reserves the tier 1 rate for a QUEUED Tier 1 bulk row", async () => {
    // Spec 6.2: "inFlightUnbilledCost counts queued Tier 1 records as well as processing ones, so
    // two batches sent back to back cannot both pass on the same dollars."
    H.inFlightRows = [
      { status: "processing", property_trace_status: null, ai_research_status: "tier1_queued" },
    ];
    expect(await inFlightUnbilledCost(fakeClient(), "u1", RATES)).toBeCloseTo(0.15, 4);
  });

  it("keeps reserving for a Tier 1 queue row OLDER than the stale-processing bound", async () => {
    // THE ASYMMETRY IS THE POINT, and it is the tier 2 argument arriving on the tier 1 column. The
    // age bound exists for an ORPHANED single-trace row that nothing will ever resolve. A queued
    // bulk row is not orphaned: the ladder and the stale-claim sweep guarantee it reaches a
    // terminal, so it WILL be billed, and under-reserving certain money is the wrong direction to
    // fail in.
    //
    // WHAT THIS TEST ACTUALLY FENCES, AND WHAT IT DOES NOT. It proves that an old, still-queued
    // Tier 1 row is PRESENT in the reserved total at all (0.15, not silently 0) -- the shape that
    // matters is a row this old reaching the customer's reserve rather than falling out of it.
    // It does NOT fence the isTier1QueuePending loop arm's own presence: deleting that arm alone
    // is an EQUIVALENT MUTANT at this level (confirmed by running it) -- a Tier 1 queued row always
    // carries status: 'processing' (Task 3), so the loop's bare `else if (row.status ===
    // 'processing') total += rates.tier1` arm reserves the identical rate for the identical row
    // whether or not the isTier1QueuePending arm exists, and fakeClient() returns whatever
    // H.inFlightRows holds regardless of the `.or()` clause content, so this test cannot see the
    // difference either way. The real "not age-bounded" guarantee lives in the SQL clause, not the
    // loop, and the two tests below (`puts the Tier 1 queue statuses in the OR clause`, `does NOT
    // bound the Tier 1 queue arm by age either`) are what actually fence it -- they inspect the
    // `.or()` string itself and go red when the clause is dropped or age-wrapped.
    H.inFlightRows = [
      {
        status: "processing",
        property_trace_status: null,
        ai_research_status: "tier1_processing_2",
        created_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      },
    ];
    expect(await inFlightUnbilledCost(fakeClient(), "u1", RATES)).toBeCloseTo(0.15, 4);
  });

  it("prices a Tier 1 queue row ONCE, at the tier 1 rate, never at both rates", async () => {
    // A queued row is ALSO status 'processing', so two ifs instead of an else-if chain would
    // reserve the two rates added together for a row that can only ever cost one of them and 402
    // a wallet that can afford the batch. MUTATION: turn the else-if chain into three plain ifs and
    // this goes red.
    H.inFlightRows = [
      { status: "processing", property_trace_status: null, ai_research_status: "tier1_queued" },
    ];
    expect(await inFlightUnbilledCost(fakeClient(), "u1", RATES)).toBeCloseTo(0.15, 4);
  });

  it("reserves the TIER 2 rate when a row is somehow on both columns", async () => {
    // Tier 2 outranks, exactly as rowSkipReason orders the two queues, because tier 2 is certain
    // money: the cron will bill it whatever it finds. MUTATION: move the Tier 1 arm above the tier 2
    // arm and this goes red.
    H.inFlightRows = [
      {
        status: "processing",
        property_trace_status: "queued",
        ai_research_status: "tier1_queued",
      },
    ];
    expect(await inFlightUnbilledCost(fakeClient(), "u1", RATES)).toBeCloseTo(0.25, 4);
  });

  it("reserves nothing for a SETTLED Tier 1 queue row", async () => {
    H.inFlightRows = [
      { status: "success", property_trace_status: null, ai_research_status: "tier1_done" },
    ];
    expect(await inFlightUnbilledCost(fakeClient(), "u1", RATES)).toBe(0);
  });

  /* ------------------------------------------------------------------ *
   * THE ACTUAL "NOT AGE-BOUNDED" GUARANTEE LIVES IN THE SQL CLAUSE, NOT THE LOOP.
   *
   * A Tier 1 queued row always carries status: 'processing' (Task 3), so the loop's bare
   * `else if (row.status === 'processing') total += rates.tier1` arm reserves the SAME rate for it
   * as the isTier1QueuePending arm does -- the two tests above pass whether or not that loop arm
   * exists, because fakeClient() returns whatever stubRows() holds regardless of the `.or()`
   * string, exactly as a real Postgres query WOULD exclude an old row that only the loop, not the
   * query, tries to rescue. What actually keeps an old queued row IN the result set at all is the
   * query's own ai_research_status.in.(...) clause carrying no created_at wrapper. These two tests
   * fence THAT, the same way the sibling tier 2 test above fences its own arm.
   * ------------------------------------------------------------------ */
  it("puts the Tier 1 queue statuses in the OR clause", async () => {
    // MUTATION: drop the ai_research_status.in.(...) branch from the query and this goes red.
    await inFlightUnbilledCost(fakeClient(), "u1", RATES);
    const clause = String(H.filters.find((f) => f[0] === "or")![1]);
    expect(clause).toContain("ai_research_status.in.(");
  });

  it("does NOT bound the Tier 1 queue arm by age either", async () => {
    // MUTATION: wrap ai_research_status.in.(...) in an and(...) with created_at, the way the bare
    // processing arm is wrapped, and this goes red.
    await inFlightUnbilledCost(fakeClient(), "u1", RATES);
    const clause = String(H.filters.find((f) => f[0] === "or")![1]);
    const tier1QueuePart = clause.slice(clause.indexOf("ai_research_status.in."));
    expect(tier1QueuePart).not.toContain("created_at");
  });
});
