import { describe, expect, it, vi } from "vitest";
import { collectedChargeFor, collectedChargesFor } from "@/lib/wallet/collectedCharge";

/**
 * WHAT `collectedChargeFor` PROMISES, AND WHY THE NUMBER HAS TO BE A TOTAL.
 *
 * Three settle sites write its answer into `trace_history.charge` RAW -- not
 * folded -- on the grounds that the value already IS the money. That is the
 * whole justification for their ALLOWED_RAW_WRITES exemption, and it only holds
 * if the answer is everything the ledger holds for that row.
 *
 * It used to be `.limit(1)` with no ORDER BY and no aggregate, so on a row
 * carrying two debits Postgres returned whichever one it liked and the site
 * wrote that single amount over the row. A row that had genuinely collected
 * $0.50 was then recorded as having collected $0.25, which under-reports what
 * the customer paid on every surface that SUMs the column.
 *
 * TWO DEBITS ON ONE ROW IS NOT EXOTIC. `UNIQUE(user_id, address_hash)` means
 * the row is reused rather than re-inserted, so a tier 2 record purchase and a
 * later tier 1 contact charge against the same address are two real debits
 * pointing at one trace_history row.
 *
 * AND WHY IT IS A **NET** AS OF 2026-09-17. Two settle sites refund a historical
 * AI-research fee and then ask this helper what the row has collected. The
 * refund is a CREDIT, and until migration 20260917 `credit_wallet_balance` did
 * not take a trace_history_id at all, so a credit could not name the row it
 * belonged to and this helper summed debits alone. Money that had been HANDED
 * BACK still counted as collected: the probe answered non-null, the deduct was
 * skipped, and the customer got the contacts free while `trace_history.charge`
 * reported an amount that was no longer in our pocket. Now the credit links, and
 * the only honest reading of a ledger holding both is the difference.
 */

/** A wallet_transactions row as the helper sees it. `type` is now load-bearing. */
type LedgerRow = { amount: number | string | null; type?: string };

/** A wallet_transactions stub that answers the exact chain the helper builds. */
function admin(rows: LedgerRow[] | null) {
  const calls: Array<[string, ...unknown[]]> = [];
  const node: Record<string, unknown> = {};
  const add =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push([method, ...args]);
      return node;
    };
  for (const m of ["select", "eq", "order", "limit"]) node[m] = add(m);
  node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(res, rej);
  return {
    client: { from: vi.fn(() => node) } as never,
    calls,
  };
}

/** Shorthands, so a fixture reads as the ledger rather than as object literals. */
const debit = (amount: number | string | null): LedgerRow => ({ amount, type: "debit" });
const credit = (amount: number | string | null): LedgerRow => ({ amount, type: "credit" });

describe("collectedChargeFor totals what the ledger holds for the row", () => {
  it("returns null when the ledger holds NOTHING for the row", async () => {
    // Null and 0 are different answers, and the difference is not academic:
    // null means the row has never been touched by the wallet at all, while 0
    // means money moved in both directions and settled back to nothing.
    const { client } = admin([]);
    expect(await collectedChargeFor(client, "row-1")).toBeNull();
  });

  it("returns the single amount when there is exactly one debit", async () => {
    const { client } = admin([debit(0.25)]);
    expect(await collectedChargeFor(client, "row-1")).toBe(0.25);
  });

  it("SUMS every debit against the row, not an arbitrary one", async () => {
    // A tier 2 record purchase plus a later tier 1 contact charge on the same
    // reused row. The customer paid 0.50 and the row must say so.
    // MUTATION: put `.limit(1)` back and this goes red.
    const { client } = admin([debit(0.25), debit(0.25)]);
    expect(await collectedChargeFor(client, "row-1")).toBe(0.5);
  });

  it("does not ask the database for a single row", async () => {
    // A `.limit(1)` cannot be corrected by summing what comes back, because the
    // rows that would have made up the total were never returned.
    const { client, calls } = admin([debit(0.25), debit(0.25)]);
    await collectedChargeFor(client, "row-1");
    expect(calls.some(([m, n]) => m === "limit" && n === 1)).toBe(false);
  });

  it("coerces the PostgREST decimal-as-string form before adding", async () => {
    // Postgres DECIMAL arrives as a string in some client configurations, and
    // '0.25' + '0.25' is '0.250.25'.
    const { client } = admin([debit("0.25"), debit("0.25")]);
    expect(await collectedChargeFor(client, "row-1")).toBe(0.5);
  });

  it("rounds to cents rather than carrying float noise into a money column", async () => {
    // 0.1 + 0.2 is 0.30000000000000004, and this value is written to a DECIMAL
    // column and shown to the customer as money.
    const { client } = admin([debit(0.1), debit(0.2)]);
    expect(await collectedChargeFor(client, "row-1")).toBe(0.3);
  });

  it("treats an unreadable amount as zero rather than NaN", async () => {
    // NaN written into `charge` poisons every SUM downstream of it.
    const { client } = admin([debit(null), debit(0.25)]);
    expect(await collectedChargeFor(client, "row-1")).toBe(0.25);
  });

  it("asks about THIS row only", async () => {
    // Keyed on user_id it would refuse to charge any second row of a bulk job.
    const { client, calls } = admin([debit(0.25)]);
    await collectedChargeFor(client, "row-7");
    expect(
      calls.some(([m, col, val]) => m === "eq" && col === "trace_history_id" && val === "row-7")
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * A REFUND IS NOT A COLLECTION.
 *
 * Migration 20260917 gave `credit_wallet_balance` a `p_trace_history_id`, so a
 * refund can finally name the row it refunds. Before it, the two settle sites
 * that refund a historical AI-research fee and then probe this helper were told
 * the refunded money was still collected -- so they skipped the deduct and the
 * customer got the contacts for nothing while the row reported a charge that had
 * been handed back.
 * ------------------------------------------------------------------ */
describe("collectedChargeFor nets what was handed back", () => {
  it("subtracts a linked credit from the linked debits", async () => {
    // $0.40 taken, $0.15 given back. The customer is out $0.25 and no reader of
    // this number may be told otherwise.
    // MUTATION: sum the debits alone (the pre-20260917 behaviour) and this goes
    // red at 0.4.
    const { client } = admin([debit(0.25), debit(0.15), credit(0.15)]);
    expect(await collectedChargeFor(client, "row-1")).toBe(0.25);
  });

  it("answers 0, NOT null, on a fully refunded row", async () => {
    // This is the exact shape the defect lived in: one $0.15 research debit and
    // the refund that handed it straight back. 0 and null are both "go ahead and
    // charge" to a caller, but they are different FACTS -- null is a row the
    // wallet never touched, 0 is a row that paid and was made whole -- and
    // collapsing them here would leave the helper unable to say which happened.
    const { client } = admin([debit(0.15), credit(0.15)]);
    expect(await collectedChargeFor(client, "row-1")).toBe(0);
    expect(await collectedChargeFor(client, "row-1")).not.toBeNull();
  });

  it("goes NEGATIVE rather than clamping when only the credit is linked", async () => {
    // The honest reading of a ledger whose debit predates the migration and so
    // could never be linked. Clamping to 0 would be inventing a fact; callers
    // gate on `> 0`, so a negative and a zero send them down the same road.
    const { client } = admin([credit(0.15)]);
    expect(await collectedChargeFor(client, "row-1")).toBe(-0.15);
  });

  it("counts every non-debit type as money returned", async () => {
    // wallet_transactions.type is CHECKed to ('credit','debit','refund',
    // 'auto_rebill') and three of those four ADD balance. Reading an unknown
    // type as a collection would skip a charge the customer never paid; reading
    // it as a return can only ever charge money that is genuinely owed, which is
    // the safe direction for a guard whose failure mode is billing twice.
    const { client } = admin([debit(0.25), { amount: 0.25, type: "refund" }]);
    expect(await collectedChargeFor(client, "row-1")).toBe(0);
  });

  it("must not filter the query down to debits", async () => {
    // MUTATION: put `.eq('type','debit')` back and this goes red. A credit that
    // never comes back cannot be subtracted, which is the whole defect: the
    // filter, not the arithmetic, is what hid the refund.
    const { client, calls } = admin([debit(0.25)]);
    await collectedChargeFor(client, "row-1");
    expect(calls.some(([m, col]) => m === "eq" && col === "type")).toBe(false);
  });

  it("selects the type column it classifies on", async () => {
    // PostgREST returns only what the select names. Ask for `amount` alone and
    // every row comes back with `type: undefined`, every one is read as a
    // non-debit, and the helper answers the NEGATIVE of the truth.
    const { client, calls } = admin([debit(0.25)]);
    await collectedChargeFor(client, "row-1");
    const select = calls.find(([m]) => m === "select");
    expect(String(select?.[1])).toContain("type");
    expect(String(select?.[1])).toContain("amount");
  });
});

/*
 * AND THE WINDOW, ADDED 2026-09-18 BY THE FINAL PHASE 5c REVIEW (F2).
 *
 * The total answers "what has this row collected", which is the right question
 * for what to PERSIST and the wrong one for whether to CHARGE. A trace_history
 * row is UNIQUE(user_id, address_hash) and is reused, so a second submit of the
 * same address re-enqueues it for a second, genuine piece of vendor work. Decided
 * on the total, the caller sees the FIRST submit's debit, skips the deduct, and
 * buys the dossier again for nothing -- repeatably, because that state never
 * changes. The window is what separates the crash window this guard was built for
 * (deduct, throw, requeue, re-claim, all inside one job) from a resubmit.
 */
describe("collectedChargesFor bounds the decision without moving the total", () => {
  const withTime = (row: LedgerRow, created_at: string) => ({ ...row, created_at });
  const OLD = "2026-08-01T09:00:00.000Z";
  const NOW = "2026-09-18T10:00:05.000Z";
  const JOB_START = "2026-09-18T10:00:00.000Z";

  it("answers both questions with the total when no window is given", async () => {
    // The default has to stay the old behaviour exactly: unbounded can only
    // refuse a charge, and a caller that cannot resolve its own start must be
    // able to ask without one.
    const { client } = admin([withTime(debit(0.4), OLD)]);
    expect(await collectedChargesFor(client, "row-1")).toEqual({ total: 0.4, inWindow: 0.4 });
  });

  it("leaves an EARLIER submit's debit out of the window and in the total", async () => {
    // MUTATION: return the total for both and this goes red. That single value
    // is the F2 defect: the deduct is skipped on work PTP is actually doing.
    const { client } = admin([withTime(debit(0.4), OLD)]);
    expect(await collectedChargesFor(client, "row-1", JOB_START)).toEqual({
      total: 0.4,
      inWindow: null,
    });
  });

  it("counts a debit booked inside the window, which is the crash window", async () => {
    // Deduct, throw, requeue, re-claim, all within one job. This is the sequence
    // the guard exists for and the narrowing must not break it.
    const { client } = admin([withTime(debit(0.4), NOW)]);
    expect(await collectedChargesFor(client, "row-1", JOB_START)).toEqual({
      total: 0.4,
      inWindow: 0.4,
    });
  });

  it("nets a refund inside the window, and keeps both ends of the total", async () => {
    // A window that summed debits alone would report money handed back as still
    // collected, which is the same defect the type filter once caused.
    const { client } = admin([
      withTime(debit(0.4), OLD),
      withTime(debit(0.4), NOW),
      withTime(credit(0.4), NOW),
    ]);
    expect(await collectedChargesFor(client, "row-1", JOB_START)).toEqual({
      total: 0.4,
      inWindow: 0,
    });
  });

  it("treats a row with no timestamp as outside every window, the way NULL is in SQL", async () => {
    const { client } = admin([debit(0.4)]);
    expect(await collectedChargesFor(client, "row-1", JOB_START)).toEqual({
      total: 0.4,
      inWindow: null,
    });
  });

  it("answers null for both when the wallet has never touched the row", async () => {
    const { client } = admin([]);
    expect(await collectedChargesFor(client, "row-1", JOB_START)).toEqual({
      total: null,
      inWindow: null,
    });
  });

  it("selects created_at, or every row falls outside every window", async () => {
    // PostgREST returns only what the select names, so an unselected created_at
    // arrives undefined on every row, the window matches nothing, and the guard
    // charges a second time inside the crash window it was written for.
    const { client, calls } = admin([withTime(debit(0.4), NOW)]);
    await collectedChargesFor(client, "row-1", JOB_START);
    expect(String(calls.find(([m]) => m === "select")?.[1])).toContain("created_at");
  });
});
