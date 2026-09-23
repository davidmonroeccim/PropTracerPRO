import { afterEach, describe, expect, it } from "vitest";
import { PRICING } from "@/lib/constants";
import { PRICE } from "@/lib/routing/ownerRoute";
import { chargePerRecord, chargePerTrace, pricePlanFor } from "@/lib/suite/pricing";

/**
 * THE ONE PRICE DERIVATION, AND THE INVARIANT THAT MADE COLLAPSING TO IT SAFE.
 *
 * WHAT THIS FILE USED TO BE. It pinned a DIVERGENCE: `lib/api/pricing.ts` held RAW twins
 * (`rawPricePlanFor` / `rawChargePerRecord`) that the /api/v1/* surface priced on, deliberately
 * blind to a Suite Gateway grant, and a test here asserted "is a DIFFERENT answer from Track A for
 * the same profile" with the note "if a refactor ever points v1 at the Track A helpers, this is
 * what says so". That refactor is now done, on David's named decision, 2026-09-23: "One price:
 * make the API grant-aware." So this file pins the OPPOSITE invariant, in the same place, rather
 * than being deleted — an unguarded price is how the divergence arose in the first place.
 *
 * THE CANONICAL MODEL (lessons.md L-030, David's words, not to be re-derived). Two buckets, four
 * numbers, and a Suite Gateway grant is in the FIRST bucket:
 *
 *   | | tier 1, per success | tier 2, per record submitted |
 *   | pro, AcquisitionPRO, gateway grant | $0.15 | $0.25 |
 *   | pay-as-you-go                      | $0.25 | $0.40 |
 *
 * Owner type selects the VENDOR, never the price (L-005), so no test here names a vendor.
 *
 * WHAT THE MATRIX BELOW IS FOR. Every one of the ten price sites the collapse touched consumes
 * exactly one of three derivations, so pinning the three across every profile shape pins all ten:
 *
 *   chargePerTrace   tier 1 per success   v1 single (balance gate + charge), v1 bulk tier1Rate,
 *                                         v1 status settle, v1 bulk/status settle,
 *                                         sweep-business-traces, sweep-entity-traces,
 *                                         sweep-stale-traces
 *   chargePerRecord  tier 2 per record    v1 single (balance gate + charge), v1 bulk tier2Rate
 *   pricePlanFor     the planRoute plan   v1 single (x3), sweep-property-traces
 *
 * EVERY EXPECTED NUMBER BELOW IS TODAY'S NUMBER. Verified empirically at BASE d2752fa against the
 * RAW derivation before a line of production code moved: all ten shapes answered identically on
 * both tracks, so collapsing them cannot move any of these bills. Only GRANT_ONLY with the
 * kill-switch ON changed, and it changed to the pro rate, which is the whole point of the task.
 */

const FLAG = "NEXT_PUBLIC_SUITE_SIGNIN_ENABLED";
const original = process.env[FLAG];
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

const PRO_T1 = PRICING.CHARGE_PER_SUCCESS; // 0.15
const PAYG_T1 = PRICING.CHARGE_PER_SUCCESS_WALLET; // 0.25
const PRO_T2 = PRICING.TIER2_PER_RECORD_SUBMITTED_PRO; // 0.25
const PAYG_T2 = PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET; // 0.40

const GRANT = ["prop-tracer-pro"];

interface Shape {
  name: string;
  /** The kill-switch state this shape is asserted under. `false` means the env var is absent. */
  suiteSignIn: boolean;
  profile: Record<string, unknown>;
  plan: "pro" | "acqPro" | "wallet";
  tier1: number;
  tier2: number;
  /** True for the ONE shape whose price this task deliberately moved. */
  moved: boolean;
}

/**
 * Every profile shape that can reach a price site. `moved` is false on nine of the ten: those
 * numbers are what the v1 surface and the crons charged before the collapse and must charge after
 * it. Break any one of them and this file goes red — that is what says no existing bill moved.
 */
const SHAPES: Shape[] = [
  {
    name: "a native pro",
    suiteSignIn: true,
    profile: { subscription_tier: "pro", is_acquisition_pro_member: false, gateway_products: [] },
    plan: "pro",
    tier1: PRO_T1,
    tier2: PRO_T2,
    moved: false,
  },
  {
    name: "an AcquisitionPRO member",
    suiteSignIn: true,
    profile: { subscription_tier: "wallet", is_acquisition_pro_member: true, gateway_products: [] },
    plan: "acqPro",
    tier1: PRO_T1,
    tier2: PRO_T2,
    moved: false,
  },
  {
    name: "a pay-as-you-go caller",
    suiteSignIn: true,
    profile: { subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: [] },
    plan: "wallet",
    tier1: PAYG_T1,
    tier2: PAYG_T2,
    moved: false,
  },
  {
    name: "an unrecognised tier, which pays the DEAREST column",
    suiteSignIn: true,
    profile: { subscription_tier: "starter", is_acquisition_pro_member: false, gateway_products: [] },
    plan: "wallet",
    tier1: PAYG_T1,
    tier2: PAYG_T2,
    moved: false,
  },
  {
    name: "an empty profile, which pays the DEAREST column",
    suiteSignIn: true,
    profile: {},
    plan: "wallet",
    tier1: PAYG_T1,
    tier2: PAYG_T2,
    moved: false,
  },
  {
    name: "all-null columns, which pay the DEAREST column",
    suiteSignIn: true,
    profile: { subscription_tier: null, is_acquisition_pro_member: null, gateway_products: null },
    plan: "wallet",
    tier1: PAYG_T1,
    tier2: PAYG_T2,
    moved: false,
  },
  {
    name: "a grant for ANOTHER product, which is not a PTP entitlement",
    suiteSignIn: true,
    profile: {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["some-other-app"],
    },
    plan: "wallet",
    tier1: PAYG_T1,
    tier2: PAYG_T2,
    moved: false,
  },
  {
    name: "a pro who ALSO holds a grant",
    suiteSignIn: true,
    profile: { subscription_tier: "pro", is_acquisition_pro_member: false, gateway_products: GRANT },
    plan: "pro",
    tier1: PRO_T1,
    tier2: PRO_T2,
    moved: false,
  },
  {
    name: "an AcquisitionPRO member who ALSO holds a grant",
    suiteSignIn: true,
    profile: { subscription_tier: "wallet", is_acquisition_pro_member: true, gateway_products: GRANT },
    plan: "acqPro",
    tier1: PRO_T1,
    tier2: PRO_T2,
    moved: false,
  },
  {
    name: "gateway-grant-only with the kill-switch OFF",
    suiteSignIn: false,
    profile: { subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: GRANT },
    plan: "wallet",
    tier1: PAYG_T1,
    tier2: PAYG_T2,
    moved: false,
  },
  {
    name: "gateway-grant-only with the kill-switch ON — THE ONE SHAPE THAT MOVED",
    suiteSignIn: true,
    profile: { subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: GRANT },
    plan: "pro",
    tier1: PRO_T1,
    tier2: PRO_T2,
    moved: true,
  },
];

function underFlag<T>(on: boolean, fn: () => T): T {
  if (on) process.env[FLAG] = "true";
  else delete process.env[FLAG];
  return fn();
}

describe("the invariant matrix: profile shapes x the three price derivations", () => {
  for (const s of SHAPES) {
    describe(s.name, () => {
      it(`pays the ${s.plan} plan (site: planRoute in v1 single, sweep-property-traces)`, () => {
        expect(underFlag(s.suiteSignIn, () => pricePlanFor(s.profile))).toBe(s.plan);
      });

      it(`pays $${s.tier1} per tier 1 success (site: v1 single/bulk/status, three crons)`, () => {
        expect(underFlag(s.suiteSignIn, () => chargePerTrace(s.profile))).toBe(s.tier1);
      });

      it(`pays $${s.tier2} per tier 2 record submitted (site: v1 single, v1 bulk)`, () => {
        expect(underFlag(s.suiteSignIn, () => chargePerRecord(s.profile))).toBe(s.tier2);
      });
    });
  }

  it("moves exactly ONE shape, and it is the gateway-grant-only one", () => {
    // Guards the matrix against itself. If a future edit quietly flips another row's `moved`
    // flag to buy itself a green run, this says so: exactly one row may carry it, and it must be
    // the shape whose only entitlement is a gateway grant with the kill-switch on.
    const moved = SHAPES.filter((s) => s.moved);
    expect(moved).toHaveLength(1);
    expect(moved[0].profile).toEqual({
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: GRANT,
    });
    expect(moved[0].suiteSignIn).toBe(true);
  });

  it("prices every UNMOVED shape identically to the retired RAW derivation", () => {
    // The retired twins were: plan = acqPro if the flag is set, else pro when the tier is 'pro',
    // else wallet; tier 1 = PRICE[plan].tier1PerSuccess; tier 2 = PRICE[plan].tier2PerRecord.
    // Inlined here rather than imported because lib/api/pricing.ts is gone — this is the oracle
    // that says the collapse was a no-op for everybody except the one shape above.
    const retiredRawPlan = (p: Record<string, unknown>) =>
      p.is_acquisition_pro_member === true
        ? "acqPro"
        : p.subscription_tier === "pro"
          ? "pro"
          : "wallet";

    for (const s of SHAPES) {
      if (s.moved) continue;
      const raw = retiredRawPlan(s.profile);
      expect(underFlag(s.suiteSignIn, () => pricePlanFor(s.profile))).toBe(raw);
      expect(underFlag(s.suiteSignIn, () => chargePerTrace(s.profile))).toBe(
        PRICE[raw].tier1PerSuccess,
      );
      expect(underFlag(s.suiteSignIn, () => chargePerRecord(s.profile))).toBe(
        PRICE[raw].tier2PerRecord,
      );
    }
  });
});

describe("there is no second derivation left to disagree with", () => {
  it("prices the gateway-grant-only shape the SAME as a native pro, everywhere", () => {
    // The replacement for the retired "is a DIFFERENT answer from Track A for the same profile".
    // lib/suite/pricing.ts:8-15 states the rule this pins: two prices for one piece of work is
    // the thing that must never happen.
    //
    // WHAT THIS FILE PINS, AND WHAT IT DOES NOT. This file imports only the three derivation
    // functions -- it never calls a route or a cron, so it cannot notice one being re-pointed at a
    // raw, grant-blind rate. What it pins is the derivation's NUMBERS: every profile shape answers
    // exactly what it answered before the collapse, and the gateway-grant-only shape matches native
    // pro. The WIRING -- that each call site actually reads chargePerTrace / chargePerRecord /
    // pricePlanFor rather than some other rate -- is pinned by the per-site tests that mock a route
    // or cron and assert on the dollar amount it bills: the route test files under
    // app/api/v1/trace/*/__tests__ and app/api/trace/*/__tests__, and the cron test files under
    // app/api/cron/sweep-*/__tests__.
    const GRANT_ONLY = {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: GRANT,
    };
    const NATIVE_PRO = {
      subscription_tier: "pro",
      is_acquisition_pro_member: false,
      gateway_products: [] as string[],
    };
    underFlag(true, () => {
      expect(pricePlanFor(GRANT_ONLY)).toBe(pricePlanFor(NATIVE_PRO));
      expect(chargePerTrace(GRANT_ONLY)).toBe(chargePerTrace(NATIVE_PRO));
      expect(chargePerRecord(GRANT_ONLY)).toBe(chargePerRecord(NATIVE_PRO));
      expect(chargePerTrace(GRANT_ONLY)).toBe(PRO_T1);
      expect(chargePerRecord(GRANT_ONLY)).toBe(PRO_T2);
    });
  });

  it("keeps the kill-switch load-bearing, so the assertion above is not a tautology", () => {
    // NEXT_PUBLIC_SUITE_SIGNIN_ENABLED is absent in this environment and TRUE in production. With
    // it absent a grant counts for nothing and a grant-only caller prices as pay-as-you-go, which
    // is what every test above that leaves it alone would be measuring. L-009, earned twice here.
    const GRANT_ONLY = {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: GRANT,
    };
    expect(underFlag(false, () => chargePerTrace(GRANT_ONLY))).toBe(PAYG_T1);
    expect(underFlag(false, () => chargePerRecord(GRANT_ONLY))).toBe(PAYG_T2);
    expect(underFlag(true, () => chargePerTrace(GRANT_ONLY))).toBe(PRO_T1);
    expect(underFlag(true, () => chargePerRecord(GRANT_ONLY))).toBe(PRO_T2);
  });

  it("keeps the tier 2 rate dearer than the tier 1 rate for every shape", () => {
    for (const s of SHAPES) {
      expect(underFlag(s.suiteSignIn, () => chargePerRecord(s.profile))).toBeGreaterThan(
        underFlag(s.suiteSignIn, () => chargePerTrace(s.profile)),
      );
    }
  });

  it("never returns a plan outside the closed PricePlan set", () => {
    // PricePlan stays 'pro' | 'acqPro' | 'wallet'. No 'gateway' member: lib/api/auth.ts skips the
    // entitlement refresh for a locally entitled caller, which is safe only while the LOCAL terms
    // dominate the derivation, so a grant-specific label would report an unboundedly stale
    // snapshot. It would be a reporting error, never a rate error, and it is not this task's to
    // make — see the Task 3 review's carried trap.
    for (const s of SHAPES) {
      expect(["pro", "acqPro", "wallet"]).toContain(
        underFlag(s.suiteSignIn, () => pricePlanFor(s.profile)),
      );
    }
  });
});
