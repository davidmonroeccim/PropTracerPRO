import { describe, expect, it } from "vitest";
import {
  CACHE_HIT_FILTER,
  TRACE_TIER,
  excludeBilledRows,
  isBilledRow,
  isCacheHitRow,
} from "@/lib/trace/billedRows";
import { PRICING } from "@/lib/constants";

/**
 * The single definition of "this row has been paid for". Everything that
 * deletes a trace_history row routes through here, so a hole in these tests is
 * a hole in the billing guarantee.
 */

describe("isBilledRow", () => {
  it("is false for a plain failed row with nothing paid", () => {
    expect(
      isBilledRow({ charge: 0, ai_research_charge: 0, property_record: null })
    ).toBe(false);
  });

  it("is true once a trace charge was collected", () => {
    expect(isBilledRow({ charge: PRICING.CHARGE_PER_SUCCESS })).toBe(true);
  });

  it("is true once an AI research charge was collected", () => {
    // 1,301 historical rows carry this. They are customer data, paid for.
    expect(isBilledRow({ charge: 0, ai_research_charge: 0.15 })).toBe(true);
  });

  it("is true for a property_record at charge 0", () => {
    // THE TIER 2 SHAPE. The property record IS what was bought; the contact
    // step that sets `charge` may never have run.
    // MUTATION: drop the property_record arm and this goes red.
    expect(
      isBilledRow({ charge: 0, ai_research_charge: 0, property_record: { parcel_id: "x" } })
    ).toBe(true);
  });

  it("is true for an EMPTY property_record object", () => {
    // A county that published nothing still cost $0.20 to ask. Empty is not
    // absent, and treating {} as unbilled would delete a row they paid for.
    expect(isBilledRow({ property_record: {} })).toBe(true);
  });

  it("treats DECIMAL columns arriving as strings as numbers", () => {
    // PostgREST can hand back numeric/DECIMAL as a string. "0.25" > 0 is true
    // in JS by coercion but "0.25" > 0 via a naive `> 0` on a union type is a
    // trap worth pinning.
    expect(isBilledRow({ charge: "0.2500" })).toBe(true);
    expect(isBilledRow({ charge: "0.0000" })).toBe(false);
  });

  it("is false for null, undefined and an empty row", () => {
    expect(isBilledRow(null)).toBe(false);
    expect(isBilledRow(undefined)).toBe(false);
    expect(isBilledRow({})).toBe(false);
  });

  it("does not treat a negative charge as billed", () => {
    expect(isBilledRow({ charge: -1 })).toBe(false);
  });
});

describe("excludeBilledRows", () => {
  it("emits the exact NOT-billed predicate, pushed to the database", () => {
    // Evaluated in Postgres rather than here, so there is no read-then-delete
    // race. The IS NULL arms matter: a NULL amount is not `<= 0` in SQL.
    const calls: Array<[string, ...unknown[]]> = [];
    const query = {
      or(filters: string) {
        calls.push(["or", filters]);
        return this;
      },
      is(column: string, value: null) {
        calls.push(["is", column, value]);
        return this;
      },
    };

    const returned = excludeBilledRows(query);

    expect(returned).toBe(query);
    expect(calls).toEqual([
      ["or", "charge.is.null,charge.lte.0"],
      ["or", "ai_research_charge.is.null,ai_research_charge.lte.0"],
      ["is", "property_record", null],
    ]);
  });

  it("covers every marker isBilledRow checks", () => {
    // Guards against the two drifting apart: a row the JS guard calls billed
    // must also be excluded by the SQL predicate.
    const calls: string[] = [];
    const query = {
      or(filters: string) {
        calls.push(filters);
        return this;
      },
      is(column: string) {
        calls.push(column);
        return this;
      },
    };

    excludeBilledRows(query);
    const emitted = calls.join(" ");

    for (const marker of ["charge", "ai_research_charge", "property_record"]) {
      expect(emitted).toContain(marker);
    }
  });
});

/* ------------------------------------------------------------------ *
 * CACHE_HIT_FILTER
 *
 * The filter is a string sent to PostgREST, so asserting the string alone
 * pins the spelling and nothing about the meaning. The evaluator below runs
 * the real filter against real row shapes, which is what makes "someone
 * deleted an arm" fail with a sentence a reader can act on.
 * ------------------------------------------------------------------ */

/** Split on top-level commas only, so `and(a,b)` survives as one arm. */
function splitArms(filter: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of filter) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

type Row = Record<string, unknown>;

/** Evaluate one PostgREST arm: `col.op.value`, `col.not.op.value`, or `and(...)`. */
function evalArm(arm: string, row: Row): boolean {
  if (arm.startsWith("and(")) {
    return splitArms(arm.slice(4, -1)).every((inner) => evalArm(inner, row));
  }
  const dot = arm.indexOf(".");
  const column = arm.slice(0, dot);
  let rest = arm.slice(dot + 1);
  let negate = false;
  if (rest.startsWith("not.")) {
    negate = true;
    rest = rest.slice(4);
  }
  const opEnd = rest.indexOf(".");
  const op = rest.slice(0, opEnd);
  const literal = rest.slice(opEnd + 1);
  const cell = row[column] ?? null;

  let result: boolean;
  switch (op) {
    case "is":
      result = literal === "null" ? cell === null : String(cell) === literal;
      break;
    case "eq":
      result = cell !== null && String(cell) === literal;
      break;
    case "gt":
      result = cell !== null && Number(cell) > Number(literal);
      break;
    case "lte":
      result = cell !== null && Number(cell) <= Number(literal);
      break;
    default:
      throw new Error(`test evaluator does not understand PostgREST op "${op}"`);
  }
  return negate ? !result : result;
}

/** The whole `or=` filter: any arm matching is a match. */
const matchesFilter = (row: Row): boolean =>
  splitArms(CACHE_HIT_FILTER).some((arm) => evalArm(arm, row));

/** A tier 1 trace that delivered contacts. */
const TIER1_SUCCESS: Row = {
  is_successful: true,
  property_record: null,
  tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
  charge: PRICING.CHARGE_PER_SUCCESS,
};
/** Tier 2 where the dossier hit: the 86-field record was delivered. */
const TIER2_RECORD: Row = {
  is_successful: false,
  property_record: { apn: "10-000052" },
  tier: TRACE_TIER.PER_RECORD_SUBMITTED,
  charge: PRICING.TIER2_PER_RECORD_SUBMITTED_PRO,
};
/** THE SHAPE THE THIRD ARM EXISTS FOR: billed, and carrying nothing at all. */
const TIER2_BILLED_MISS: Row = {
  is_successful: false,
  property_record: null,
  status: "no_match",
  tier: TRACE_TIER.PER_RECORD_SUBMITTED,
  charge: PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET,
};
/** A plain tier 1 failure. Nothing was collected, so it must re-trace. */
const UNBILLED_FAILURE: Row = {
  is_successful: false,
  property_record: null,
  tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
  charge: 0,
};
/** Tier 2 where the wallet deduct returned false: no money moved. */
const TIER2_UNCOLLECTED: Row = {
  is_successful: false,
  property_record: null,
  tier: TRACE_TIER.PER_RECORD_SUBMITTED,
  charge: 0,
};

describe("CACHE_HIT_FILTER", () => {
  it("admits a contact success, a paid property record, and a billed tier 2 row", () => {
    expect(CACHE_HIT_FILTER).toBe(
      "is_successful.eq.true,property_record.not.is.null,and(tier.eq.2,charge.gt.0)"
    );
  });

  it("serves a BILLED TIER 2 MISS from the database", () => {
    // The row carries no property_record and is_successful is false, so only
    // the third arm can match it. Without that arm the next submit re-runs the
    // dossier and bills the customer a second time for the same absence.
    // MUTATION: drop `and(tier.eq.2,charge.gt.0)` and this goes red.
    expect(matchesFilter(TIER2_BILLED_MISS)).toBe(true);
  });

  it("still admits the two shapes it always did", () => {
    expect(matchesFilter(TIER1_SUCCESS)).toBe(true);
    expect(matchesFilter(TIER2_RECORD)).toBe(true);
  });

  it("does not turn into 'everything is a cache hit'", () => {
    // The guard on the guard: a plain failure must still re-trace, or a user
    // whose first attempt failed can never trace that address again.
    expect(matchesFilter(UNBILLED_FAILURE)).toBe(false);
  });

  it("re-buys a tier 2 row where the deduct collected nothing", () => {
    // charge.gt.0, not charge.not.is.null. No money moved, so there is no
    // purchase to serve back.
    // MUTATION: relax the third arm to `tier.eq.2` and this goes red.
    expect(matchesFilter(TIER2_UNCOLLECTED)).toBe(false);
  });

  it("does not admit a tier 1 charge through the tier 2 arm", () => {
    // charge > 0 is true of almost every tier 1 row. Pairing it with tier = 2
    // is what stops the third arm swallowing tier 1's free-on-miss rule.
    expect(
      matchesFilter({
        is_successful: false,
        property_record: null,
        tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
        charge: PRICING.CHARGE_PER_SUCCESS_WALLET,
      })
    ).toBe(false);
  });
});

describe("isCacheHitRow", () => {
  it("agrees with the SQL filter on every row shape that matters", () => {
    // The JS twin decides whether a route SERVES the row; the SQL decides
    // whether the route ever sees it. Drift between them is a double charge.
    for (const row of [
      TIER1_SUCCESS,
      TIER2_RECORD,
      TIER2_BILLED_MISS,
      UNBILLED_FAILURE,
      TIER2_UNCOLLECTED,
    ]) {
      expect(isCacheHitRow(row)).toBe(matchesFilter(row));
    }
  });

  it("reads a DECIMAL charge and a tier arriving as strings", () => {
    // PostgREST hands numeric/DECIMAL back as a string in some configurations.
    expect(isCacheHitRow({ is_successful: false, tier: "2", charge: "0.4000" })).toBe(true);
    expect(isCacheHitRow({ is_successful: false, tier: "2", charge: "0.0000" })).toBe(false);
  });

  it("is false for null, undefined and an empty row", () => {
    expect(isCacheHitRow(null)).toBe(false);
    expect(isCacheHitRow(undefined)).toBe(false);
    expect(isCacheHitRow({})).toBe(false);
  });
});

describe("TRACE_TIER", () => {
  it("names the two billing models the ledger has to tell apart", () => {
    expect(TRACE_TIER.PER_SUCCESSFUL_TRACE).toBe(1);
    expect(TRACE_TIER.PER_RECORD_SUBMITTED).toBe(2);
  });

  it("exists because the two rates it separates are numerically identical", () => {
    // This is the whole reason the column exists. If this ever stops being
    // true, re-read lib/constants.ts:34-36 before deleting anything.
    expect(PRICING.CHARGE_PER_SUCCESS_WALLET).toBe(PRICING.TIER2_PER_RECORD_SUBMITTED_PRO);
  });
});
