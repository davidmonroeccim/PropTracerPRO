import { describe, expect, it } from "vitest";
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
 * CHARACTERIZATION, 2026-09-17. Passes today, and describes the defect:
 * a short wallet and a broken RPC are the same answer, so every caller
 * tells the customer the same thing about two different events. One of
 * them is our failure, not their balance.
 * ==================================================================== */
describe("CHARACTERIZATION — the two failures are indistinguishable", () => {
  it("answers 0 for both, with nothing to tell them apart", async () => {
    const short = await deductOrZero(clientReturning({ data: false, error: null }), ARGS);
    const broken = await deductOrZero(
      clientReturning({ data: null, error: { message: "connection reset" } }),
      ARGS
    );

    expect(short).toBe(broken);
    expect(short).toBe(0);
  });
});
