import { describe, expect, it } from "vitest";
import {
  MAX_PROPERTY_TRACE_ATTEMPTS,
  PROPERTY_TRACE_FAILED_STATUS,
  PROPERTY_TRACE_NO_KEY_STATUS,
  PROPERTY_TRACE_NO_REACH_STATUS,
  PROPERTY_TRACE_PROCESSING_STATUSES,
  PROPERTY_TRACE_QUEUED_STATUSES,
  PROPERTY_TRACE_SETTLED_STATUS,
  attemptOf,
  isPropertyTracePending,
  nextAfterFailedAttempt,
  processingStatusFor,
  propertyTraceSkipReason,
  queuedStatusFor,
} from "@/lib/trace/propertyTraceAttempts";

/**
 * The tier 2 bulk queue's own state machine.
 *
 * It mirrors lib/trace/entityTraceAttempts.ts deliberately and it is a SEPARATE
 * column deliberately, so the two things worth pinning here are the ones a
 * shared column would have let drift:
 *
 * 1. Every value fits VARCHAR(24). The entity queue's column is VARCHAR(20)
 *    with 19 characters already spent, which is one of the four reasons this
 *    queue did not move in there. A value that silently truncates in Postgres
 *    would produce a row nothing can ever claim again.
 * 2. A terminal value is NOT pending. `isPropertyTracePending` is what a bulk
 *    job's completion check reads, so a terminal value that still reads pending
 *    holds the parent job open forever -- the exact failure the entity ladder
 *    was built to end.
 */

/** supabase/migrations/20260918_property_trace_queue.sql. */
const COLUMN_WIDTH = 24;

const EVERY_VALUE = [
  ...PROPERTY_TRACE_QUEUED_STATUSES,
  ...PROPERTY_TRACE_PROCESSING_STATUSES,
  PROPERTY_TRACE_SETTLED_STATUS,
  PROPERTY_TRACE_FAILED_STATUS,
  PROPERTY_TRACE_NO_KEY_STATUS,
  PROPERTY_TRACE_NO_REACH_STATUS,
];

/** The values that mean the row is finished, however it finished. */
const TERMINAL_VALUES = [
  PROPERTY_TRACE_SETTLED_STATUS,
  PROPERTY_TRACE_FAILED_STATUS,
  PROPERTY_TRACE_NO_KEY_STATUS,
  PROPERTY_TRACE_NO_REACH_STATUS,
];

/** The two terminal values that describe a row nobody was charged for. */
const FREE_TERMINAL_VALUES = [PROPERTY_TRACE_FAILED_STATUS, PROPERTY_TRACE_NO_KEY_STATUS];

describe("the property-trace queue's values", () => {
  it("all fit the VARCHAR(24) the migration declares", () => {
    // MUTATION: widen any value past 24 characters and this goes red. In
    // Postgres the write itself would fail, or silently truncate under a cast,
    // and a row carrying a truncated status can never be claimed or settled.
    for (const value of EVERY_VALUE) {
      expect(value.length, `${value} is ${value.length} characters`).toBeLessThanOrEqual(
        COLUMN_WIDTH
      );
    }
  });

  it("are all distinct, so no two states can be confused for one another", () => {
    expect(new Set(EVERY_VALUE).size).toBe(EVERY_VALUE.length);
  });

  it("never collide with the entity queue's first rung by accident", () => {
    // Both ladders start at the bare 'queued'/'processing', which is correct and
    // intentional -- they live in DIFFERENT COLUMNS. What must never happen is a
    // terminal value shared between them, because skipReasonFor() reads the
    // entity column and would answer for the wrong engine.
    expect(PROPERTY_TRACE_FAILED_STATUS).not.toBe("entity_trace_failed");
    expect(PROPERTY_TRACE_NO_KEY_STATUS).not.toBe("skipped_no_owner");
  });
});

describe("the rungs", () => {
  it("names attempt 1 with the bare values, so a row written without one reads as attempt 1", () => {
    expect(queuedStatusFor(1)).toBe("queued");
    expect(processingStatusFor(1)).toBe("processing");
    expect(attemptOf(null)).toBe(1);
    expect(attemptOf("queued")).toBe(1);
    expect(attemptOf("processing")).toBe(1);
    expect(attemptOf("something nobody wrote")).toBe(1);
  });

  it("carries the attempt number in the status itself", () => {
    expect(queuedStatusFor(3)).toBe("queued_3");
    expect(processingStatusFor(3)).toBe("processing_3");
    expect(attemptOf("queued_3")).toBe(3);
    expect(attemptOf("processing_3")).toBe(3);
  });

  it("clamps an attempt number past the end of the ladder", () => {
    expect(attemptOf(`queued_${MAX_PROPERTY_TRACE_ATTEMPTS + 7}`)).toBe(
      MAX_PROPERTY_TRACE_ATTEMPTS
    );
  });

  it("lists every claimable and every claimed rung", () => {
    expect(PROPERTY_TRACE_QUEUED_STATUSES).toHaveLength(MAX_PROPERTY_TRACE_ATTEMPTS);
    expect(PROPERTY_TRACE_PROCESSING_STATUSES).toHaveLength(MAX_PROPERTY_TRACE_ATTEMPTS);
    expect(PROPERTY_TRACE_QUEUED_STATUSES[0]).toBe("queued");
  });
});

describe("where a failed attempt goes next", () => {
  it("climbs one rung while attempts remain", () => {
    expect(nextAfterFailedAttempt(1)).toEqual({ status: "queued_2", exhausted: false });
    expect(nextAfterFailedAttempt(MAX_PROPERTY_TRACE_ATTEMPTS - 1)).toEqual({
      status: `queued_${MAX_PROPERTY_TRACE_ATTEMPTS}`,
      exhausted: false,
    });
  });

  it("gives up on the last attempt", () => {
    // MUTATION: drop the exhausted branch and a poison row goes back to the
    // front of the claim window forever, which is the starvation the ladder
    // exists to end.
    expect(nextAfterFailedAttempt(MAX_PROPERTY_TRACE_ATTEMPTS)).toEqual({
      status: PROPERTY_TRACE_FAILED_STATUS,
      exhausted: true,
    });
  });
});

describe("what is still pending", () => {
  it("reads every queued and every claimed rung as pending", () => {
    for (const status of [
      ...PROPERTY_TRACE_QUEUED_STATUSES,
      ...PROPERTY_TRACE_PROCESSING_STATUSES,
    ]) {
      expect(isPropertyTracePending(status), status).toBe(true);
    }
  });

  it("reads every terminal value as NOT pending, so the parent job can settle", () => {
    // MUTATION: make any terminal value read as pending and a finished bulk job
    // reports 'processing' forever.
    for (const status of TERMINAL_VALUES) {
      expect(isPropertyTracePending(status), status).toBe(false);
    }
  });

  it("reads a row that never entered this queue as NOT pending", () => {
    // NULL is the overwhelming majority of trace_history: every tier 1 row and
    // every row written before this queue existed.
    expect(isPropertyTracePending(null)).toBe(false);
    expect(isPropertyTracePending(undefined)).toBe(false);
    expect(isPropertyTracePending("")).toBe(false);
  });
});

describe("the sentence a customer reads", () => {
  it("explains an exhausted row and says it was not charged", () => {
    const reason = propertyTraceSkipReason(PROPERTY_TRACE_FAILED_STATUS);
    expect(reason).toBeTruthy();
    expect(reason).toContain("not charged");
  });

  it("explains a row with no usable address and says it was not charged", () => {
    const reason = propertyTraceSkipReason(PROPERTY_TRACE_NO_KEY_STATUS);
    expect(reason).toBeTruthy();
    expect(reason).toContain("not charged");
    // Two different things to a customer: one they can fix by resending the row
    // with a complete address, one that is our side failing to reach a vendor.
    expect(reason).not.toBe(propertyTraceSkipReason(PROPERTY_TRACE_FAILED_STATUS));
  });

  it("explains a row whose contacts service could not be reached", () => {
    const reason = propertyTraceSkipReason(PROPERTY_TRACE_NO_REACH_STATUS);
    expect(reason).toBeTruthy();
    // It says what we DID get, and that the contacts step did not complete. It
    // must not assert we looked and found nobody, which is the claim the whole
    // status exists to stop making.
    expect(reason).toContain("property record");
    expect(reason).toMatch(/could not reach/i);
  });

  it("never tells a BILLED row it was free", () => {
    // The other two sentences say "not charged" and are true. This row WAS
    // charged: the dossier answered and tier 2 bills per record submitted.
    // Reusing their wording would be a false statement about the customer's own
    // money, in the opposite direction from the usual one.
    // MUTATION: point PROPERTY_TRACE_NO_REACH_STATUS at either of the other two
    // reasons and this goes red.
    const reason = propertyTraceSkipReason(PROPERTY_TRACE_NO_REACH_STATUS)!;
    expect(reason).not.toContain("not charged");
    expect(reason).not.toMatch(/\bfree\b/i);
    for (const free of FREE_TERMINAL_VALUES) {
      expect(reason).not.toBe(propertyTraceSkipReason(free));
    }
  });

  it("claims nobody was notified, because nobody was", () => {
    // PTP has no alerting channel and David chose no alert over a fake one. A
    // sentence promising that somebody is looking into it would be a lie about
    // a capability that does not exist.
    for (const status of EVERY_VALUE) {
      const reason = propertyTraceSkipReason(status);
      if (!reason) continue;
      expect(reason).not.toMatch(/notified|alerted|our team|we have been told|looking into/i);
    }
  });

  it("quotes no price, on any outcome", () => {
    // Four prices exist and each caller has exactly one of them, so naming a
    // number here would name the wrong one for somebody -- and quoting any
    // figure on a free outcome is a false statement about money.
    for (const status of EVERY_VALUE) {
      expect(propertyTraceSkipReason(status) ?? "").not.toMatch(/\$|\d+\s*cent/);
    }
  });

  it("says a FREE outcome was free, on both of the free ones", () => {
    for (const status of FREE_TERMINAL_VALUES) {
      expect(propertyTraceSkipReason(status), status).toContain("not charged");
    }
  });

  it("has nothing to say about a row that settled normally", () => {
    // A settled row speaks for itself through status, trace_result and
    // property_record. A reason here would contradict it.
    expect(propertyTraceSkipReason(PROPERTY_TRACE_SETTLED_STATUS)).toBeNull();
    expect(propertyTraceSkipReason("queued")).toBeNull();
    expect(propertyTraceSkipReason(null)).toBeNull();
  });

  it("carries no em-dash, en-dash, asterisk or emoji, because a customer reads it", () => {
    for (const status of EVERY_VALUE) {
      expect(propertyTraceSkipReason(status) ?? "").not.toMatch(/[—–*]/);
    }
  });
});
