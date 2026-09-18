import { beforeEach, describe, expect, it, vi } from "vitest";
import { deductOrZero } from "@/lib/wallet/deduct";

/**
 * The wallet deduct is the one call in PTP that moves real money, and its answer
 * is what the row, the response body and the trace.completed webhook all report.
 *
 * Written as characterization FIRST (2026-09-17) because the helper was about to
 * be changed on the billing path and had no coverage of its own: it was only
 * ever exercised through four routes, so nothing pinned the helper's own
 * contract.
 */

type Envelope = { data?: unknown; error?: unknown } | null | undefined;

function clientReturning(envelope: Envelope) {
  return {
    rpc: async () => envelope,
  };
}

const ARGS = {
  p_user_id: "user-1",
  p_amount: 0.25,
  p_trace_history_id: "trace-1",
  p_description: "Full Property Trace",
};

describe("deductOrZero", () => {
  it("returns the requested amount when the function returns true", async () => {
    expect(await deductOrZero(clientReturning({ data: true, error: null }), ARGS)).toBe(0.25);
  });

  it("returns 0 when the wallet was short", async () => {
    // deduct_wallet_balance RETURNS BOOLEAN and returns FALSE without moving
    // any money (supabase/schema.sql:290).
    expect(await deductOrZero(clientReturning({ data: false, error: null }), ARGS)).toBe(0);
  });

  it("returns 0 when the RPC itself errored", async () => {
    expect(
      await deductOrZero(clientReturning({ data: null, error: { message: "fetch failed" } }), ARGS)
    ).toBe(0);
  });

  it("treats a loose test double's missing envelope as success", async () => {
    // Deliberate, and documented at the helper: production supabase-js always
    // resolves { data, error } and `data` is the literal boolean, so a bare
    // undefined can only come from a test double. Failing closed there would
    // silently rewrite every such test's expectation to charge 0.
    expect(await deductOrZero(clientReturning(undefined), ARGS)).toBe(0.25);
    expect(await deductOrZero(clientReturning({}), ARGS)).toBe(0.25);
  });
});

/* ====================================================================
 * THE ANSWER IS THE SAME NUMBER AND THAT IS CORRECT. What was wrong was
 * that it was the same EVENT.
 *
 * `collected` means "the amount that actually moved", and nothing moved
 * in either case, so 0 is right for both and callers that only write the
 * number into a row were never misled. What the two failures owe is
 * different TREATMENT: a short wallet is an expected business outcome,
 * and an RPC error is an infrastructure failure. Both were silent, so a
 * row could settle DELIVERED at charge 0 -- shared-pool vendor credits
 * spent, nothing collected -- with no log, no counter and no warning
 * anywhere. PTP has no alerting channel, so a console line is the whole
 * of what an operator can ever see.
 * ==================================================================== */
describe("the two failures reach an operator differently", () => {
  const logs = () => vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(" "));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("still answers 0 for both, because nothing moved either time", async () => {
    const short = await deductOrZero(clientReturning({ data: false, error: null }), ARGS);
    const broken = await deductOrZero(
      clientReturning({ data: null, error: { message: "connection reset" } }),
      ARGS
    );
    expect(short).toBe(broken);
    expect(short).toBe(0);
  });

  it("names an RPC failure as ours, carrying the error and the row", async () => {
    // MUTATION: drop the outcome check and log one line for both, and the
    // assertion below that the two lines differ goes red.
    await deductOrZero(
      clientReturning({ data: null, error: { message: "connection reset" } }),
      ARGS
    );
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toContain("connection reset");
    expect(logs()[0]).toContain("trace-1");
  });

  it("records a short wallet separately, because it is not a failure of ours", async () => {
    await deductOrZero(clientReturning({ data: false, error: null }), ARGS);
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toContain("trace-1");
  });

  it("does not let the two read as the same event", async () => {
    // The point of the whole change. An operator with no alerting channel has
    // only these lines to tell an empty wallet from a broken database.
    await deductOrZero(clientReturning({ data: false, error: null }), ARGS);
    const short = logs()[0];
    vi.clearAllMocks();
    await deductOrZero(
      clientReturning({ data: null, error: { message: "connection reset" } }),
      ARGS
    );
    expect(logs()[0]).not.toBe(short);
  });

  it("says nothing at all when the money moved", async () => {
    // A log on the happy path would bury the two that matter.
    await deductOrZero(clientReturning({ data: true, error: null }), ARGS);
    expect(logs()).toHaveLength(0);
  });
});
