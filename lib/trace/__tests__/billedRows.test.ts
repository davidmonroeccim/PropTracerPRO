import { describe, expect, it } from "vitest";
import {
  CACHE_HIT_FILTER,
  TRACE_TIER,
  excludeBilledRows,
  isBilledRow,
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

describe("CACHE_HIT_FILTER", () => {
  it("admits both a contact success and a paid property record", () => {
    expect(CACHE_HIT_FILTER).toBe("is_successful.eq.true,property_record.not.is.null");
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
