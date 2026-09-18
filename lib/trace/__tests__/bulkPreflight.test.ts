import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROPERTY_TRACE_NO_KEY_STATUS,
  PROPERTY_TRACE_PENDING_STATUSES,
  PROPERTY_TRACE_SETTLED_STATUS,
} from "@/lib/trace/propertyTraceAttempts";
import { STALE_PROCESSING } from "@/lib/constants";
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
  TIER2_CAPACITY_REFUSAL,
  inFlightUnbilledCost,
  tracerfyCanRunTier2,
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
      node.in = track("in");
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
            ? { count: H.queuedCount, error: H.queuedError }
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
    expect(await tracerfyCanRunTier2(fakeClient(), 500)).toBe(true);
  });

  it("asks no vendor at all when the job has no tier 2 records", async () => {
    // A tier 1 only batch draws no dossier credits, so spending an HTTP round
    // trip to prove it would be a cost with no question behind it.
    expect(await tracerfyCanRunTier2(fakeClient(), 0)).toBe(true);
    expect(getAnalytics).not.toHaveBeenCalled();
  });

  it("sizes a record at the dossier's credit cost", async () => {
    // MUTATION: change the multiplicand and this goes red. 100 records is
    // 1,000 credits, so a 999 balance cannot run it and a 1,000 one can.
    H.analytics = { success: true, data: { balance: 100 * TRACERFY_DOSSIER_CREDITS } };
    expect(await tracerfyCanRunTier2(fakeClient(), 100)).toBe(true);

    H.analytics = { success: true, data: { balance: 100 * TRACERFY_DOSSIER_CREDITS - 1 } };
    expect(await tracerfyCanRunTier2(fakeClient(), 100)).toBe(false);
  });

  it("counts what is ALREADY queued, because the pool is shared", async () => {
    // THE WHOLE POINT OF THE CHECK. Sized against the raw balance, two jobs
    // that cannot both run both pass. MUTATION: drop the queued term and this
    // goes red.
    H.analytics = { success: true, data: { balance: 100 * TRACERFY_DOSSIER_CREDITS } };
    H.queuedCount = 1;
    expect(await tracerfyCanRunTier2(fakeClient(), 100)).toBe(false);
  });

  it("counts every rung of the ladder as still in flight, claimed rows included", async () => {
    // A row mid-retry and a row a worker is holding are both work the pool
    // still owes credits to.
    await tracerfyCanRunTier2(fakeClient(), 1);
    const inFilter = H.filters.find(
      (f) => f[0] === "in" && f[1] === "property_trace_status"
    );
    expect(inFilter).toBeDefined();
    expect(inFilter![2]).toEqual(PROPERTY_TRACE_PENDING_STATUSES);
    // A terminal row is finished with the pool and must not hold capacity back.
    expect(inFilter![2]).not.toContain(PROPERTY_TRACE_SETTLED_STATUS);
    expect(inFilter![2]).not.toContain(PROPERTY_TRACE_NO_KEY_STATUS);
  });

  it("refuses when it cannot read the balance, rather than assuming one", async () => {
    // An unreadable balance is not a balance of zero and it is not a balance of
    // plenty. Treating it as enough is inventing a result, which is the one
    // thing this project is least allowed to do.
    H.analytics = { success: false, error: "Tracerfy service unavailable" };
    expect(await tracerfyCanRunTier2(fakeClient(), 1)).toBe(false);
  });

  it("refuses when the response carries no balance number", async () => {
    H.analytics = { success: true, data: {} };
    expect(await tracerfyCanRunTier2(fakeClient(), 1)).toBe(false);
  });

  it("leaves the operator a log line, which is the only surface there is", async () => {
    // PTP has no alerting channel by David's explicit decision, so a console
    // line is the whole of it. MUTATION: delete the console.error and an
    // operator finds out the pool ran dry from a customer.
    H.analytics = { success: true, data: { balance: 0 } };
    await tracerfyCanRunTier2(fakeClient(), 1);
    expect(errorLogs().filter((l) => l.includes("[bulk-preflight]"))).toHaveLength(1);
  });

  it("raises our own database failure instead of answering it", async () => {
    // A vendor we cannot read is a capacity answer. Our own table failing is
    // not: it is an infrastructure failure and it belongs in the route's 500,
    // not dressed up as a refusal the customer will read as our credit pool.
    H.queuedError = { message: "connection reset" };
    await expect(tracerfyCanRunTier2(fakeClient(), 1)).rejects.toThrow(/connection reset/);
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
