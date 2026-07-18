import { afterEach, expect, test } from "vitest";
import { PRICING } from "@/lib/constants";
import { chargePerTrace } from "@/lib/suite/pricing";

// The flag is a kill-switch: the grant-aware $0.07 rate applies ONLY while Suite sign-in is enabled.
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
