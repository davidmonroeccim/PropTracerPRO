import { afterEach, expect, test } from "vitest";
import { PRICING } from "@/lib/constants";
import { chargePerRecord, chargePerTrace, pricePlanFor } from "@/lib/suite/pricing";
import { PRICE } from "@/lib/routing/ownerRoute";

// The flag is a kill-switch: the grant-aware pro rate (PRICING.CHARGE_PER_SUCCESS) applies ONLY
// while Suite sign-in is enabled. Named by constant, not by number, so a reprice does not leave
// this comment lying.
const FLAG = "NEXT_PUBLIC_SUITE_SIGNIN_ENABLED";
const original = process.env[FLAG];
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

test("grant-holder is charged the pro rate (Suite enabled)", () => {
  process.env[FLAG] = "true";
  expect(
    chargePerTrace({
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["prop-tracer-pro"],
    }),
  ).toBe(PRICING.CHARGE_PER_SUCCESS);
});

test("no entitlement is charged the wallet rate", () => {
  expect(
    chargePerTrace({
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: [],
    }),
  ).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
});

test("kill-switch: a grant-holder pays the wallet rate when Suite is disabled", () => {
  delete process.env[FLAG];
  expect(
    chargePerTrace({
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["prop-tracer-pro"],
    }),
  ).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
});

/* ------------------------------------------------------------------ *
 * pricePlanFor / chargePerRecord — the tier 2 column
 *
 * planRoute() takes the price plan as a REQUIRED argument so that no route can
 * silently bill the wrong column. These pin the one function that supplies it.
 * ------------------------------------------------------------------ */

const PAYG = {
  subscription_tier: "wallet",
  is_acquisition_pro_member: false,
  gateway_products: [] as string[],
};
const NATIVE_PRO = { ...PAYG, subscription_tier: "pro" };
const ACQ_PRO = { ...PAYG, is_acquisition_pro_member: true };
const GRANT_HOLDER = { ...PAYG, gateway_products: ["prop-tracer-pro"] };

test("pay-as-you-go pays the wallet column, which is the dearest", () => {
  // MUTATION: make pricePlanFor return 'pro' unconditionally and this goes red.
  // That mutation is the exact bug FAILSAFE_PRICE_PLAN was written against:
  // a 40% undercharge that produces no error and no complaint.
  expect(pricePlanFor(PAYG)).toBe("wallet");
  expect(chargePerRecord(PAYG)).toBe(PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET);
});

test("a native pro pays the pro column", () => {
  expect(pricePlanFor(NATIVE_PRO)).toBe("pro");
  expect(chargePerRecord(NATIVE_PRO)).toBe(PRICING.TIER2_PER_RECORD_SUBMITTED_PRO);
});

test("an AcquisitionPRO member is named apart but priced the same", () => {
  expect(pricePlanFor(ACQ_PRO)).toBe("acqPro");
  expect(chargePerRecord(ACQ_PRO)).toBe(PRICING.TIER2_PER_RECORD_SUBMITTED_PRO);
});

test("a gateway grant-holder pays the pro column while Suite is enabled", () => {
  process.env[FLAG] = "true";
  expect(pricePlanFor(GRANT_HOLDER)).toBe("pro");
  expect(chargePerRecord(GRANT_HOLDER)).toBe(PRICING.TIER2_PER_RECORD_SUBMITTED_PRO);
});

test("kill-switch: a grant-holder pays the wallet column when Suite is disabled", () => {
  delete process.env[FLAG];
  expect(pricePlanFor(GRANT_HOLDER)).toBe("wallet");
  expect(chargePerRecord(GRANT_HOLDER)).toBe(PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET);
});

test("the plan it picks prices tier 1 exactly as chargePerTrace does", () => {
  // Anti-drift. pricePlanFor decides which COLUMN of PRICE a caller pays; if
  // that column's tier 1 rate ever disagreed with the rate the poll route
  // actually charges, one of the two tiers would be billing the wrong plan.
  process.env[FLAG] = "true";
  for (const profile of [PAYG, NATIVE_PRO, ACQ_PRO, GRANT_HOLDER]) {
    expect(PRICE[pricePlanFor(profile)].tier1PerSuccess).toBe(chargePerTrace(profile));
  }
});
