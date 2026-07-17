import { expect, test } from "vitest";
import { PRICING } from "@/lib/constants";
import { chargePerTrace } from "@/lib/suite/pricing";

test("grant-holder is charged the pro rate", () => {
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
