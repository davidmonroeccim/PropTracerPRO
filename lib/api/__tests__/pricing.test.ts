import { describe, expect, it } from "vitest";
import { rawChargePerRecord, rawPricePlanFor } from "@/lib/api/pricing";
import { getChargePerTrace } from "@/lib/constants";
import { PRICE } from "@/lib/routing/ownerRoute";
import { chargePerRecord, pricePlanFor } from "@/lib/suite/pricing";

/**
 * TRACK B price derivation. Four numbers exist and no more (lessons.md L-005):
 * tier 1 is $0.15 pro / AcquisitionPRO and $0.25 pay-as-you-go; tier 2 is $0.25
 * and $0.40. Owner type selects the VENDOR, never the price, so no test here
 * mentions a vendor.
 */

const WALLET = { subscription_tier: "wallet", is_acquisition_pro_member: false };
const PRO = { subscription_tier: "pro", is_acquisition_pro_member: false };
const ACQ_PRO = { subscription_tier: "wallet", is_acquisition_pro_member: true };

describe("rawPricePlanFor", () => {
  it("prices a pay-as-you-go caller on the wallet column", () => {
    expect(rawPricePlanFor(WALLET)).toBe("wallet");
  });

  it("prices a pro caller on the pro column", () => {
    expect(rawPricePlanFor(PRO)).toBe("pro");
  });

  it("prices an AcquisitionPRO member on the acqPro column", () => {
    expect(rawPricePlanFor(ACQ_PRO)).toBe("acqPro");
  });

  it("falls to the DEAREST column for an unrecognised or missing tier", () => {
    // FAILSAFE_PRICE_PLAN's reasoning: an overcharge is visible on a statement and
    // gets reported; an undercharge is invisible to both sides and compounds.
    expect(rawPricePlanFor({ subscription_tier: "starter", is_acquisition_pro_member: false }))
      .toBe("wallet");
    expect(rawPricePlanFor({})).toBe("wallet");
    expect(rawPricePlanFor({ subscription_tier: null, is_acquisition_pro_member: null }))
      .toBe("wallet");
  });

  it("agrees with getChargePerTrace on tier 1 across the whole matrix", () => {
    // The invariant that keeps Track B's plan derivation and Track B's tier 1 rate
    // from drifting apart. MUTATION: flip either branch and this goes red.
    for (const tier of ["wallet", "pro", "starter", ""]) {
      for (const acq of [true, false]) {
        const profile = { subscription_tier: tier, is_acquisition_pro_member: acq };
        expect(PRICE[rawPricePlanFor(profile)].tier1PerSuccess).toBe(
          getChargePerTrace(tier, acq)
        );
      }
    }
  });
});

describe("rawChargePerRecord", () => {
  it("charges a pay-as-you-go caller $0.40 per record submitted", () => {
    expect(rawChargePerRecord(WALLET)).toBe(0.4);
  });

  it("charges a pro caller $0.25 per record submitted", () => {
    expect(rawChargePerRecord(PRO)).toBe(0.25);
  });

  it("charges an AcquisitionPRO member $0.25 per record submitted", () => {
    expect(rawChargePerRecord(ACQ_PRO)).toBe(0.25);
  });

  it("is always dearer than the tier 1 rate for the same caller", () => {
    for (const profile of [WALLET, PRO, ACQ_PRO]) {
      expect(rawChargePerRecord(profile)).toBeGreaterThan(
        getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member)
      );
    }
  });
});

describe("Track B is NOT Track A", () => {
  /**
   * The gateway grant is the whole difference. A caller with no local pro tier and no
   * AcquisitionPRO flag, but a Suite Gateway product grant, is a pro on Track A and a
   * pay-as-you-go on Track B. If these two ever return the same thing for this profile,
   * one track has been wired to the other and an existing API-key caller's bill moved.
   */
  const GRANTED = {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: ["prop-tracer-pro"],
    gateway_products_checked_at: new Date().toISOString(),
  };

  /**
   * NEXT_PUBLIC_SUITE_SIGNIN_ENABLED is the kill-switch hasSuiteAccess() reads, and it
   * is OFF by default in this environment. With it off the two tracks AGREE, so a test
   * that does not set it passes under either implementation and proves nothing. It is
   * set explicitly below for exactly that reason.
   */
  function withSuiteSignIn<T>(fn: () => T): T {
    const prev = process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    try {
      return fn();
    } finally {
      process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = prev;
    }
  }

  it("keeps the RAW twin blind to a gateway grant", () => {
    withSuiteSignIn(() => {
      expect(rawPricePlanFor(GRANTED)).toBe("wallet");
      expect(rawChargePerRecord(GRANTED)).toBe(0.4);
    });
  });

  it("is a DIFFERENT answer from Track A for the same profile", () => {
    // Not an assertion about which is RIGHT: they are different tracks on purpose.
    // This pins that they are still DIFFERENT, which is the property that matters --
    // if a refactor ever points v1 at the Track A helpers, this is what says so.
    withSuiteSignIn(() => {
      expect(pricePlanFor(GRANTED)).toBe("pro");
      expect(chargePerRecord(GRANTED)).toBe(0.25);
      expect(rawPricePlanFor(GRANTED)).toBe("wallet");
      expect(rawChargePerRecord(GRANTED)).toBe(0.4);
    });
  });

  it("collapses to the same answer when the Suite kill-switch is off", () => {
    // The flag is a rollback lever: flipping it off makes every grant-derived
    // decision revert to the user's native plan, on both tracks.
    const prev = process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "false";
    try {
      expect(pricePlanFor(GRANTED)).toBe("wallet");
      expect(chargePerRecord(GRANTED)).toBe(rawChargePerRecord(GRANTED));
    } finally {
      process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = prev;
    }
  });
});
