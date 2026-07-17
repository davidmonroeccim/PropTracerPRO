import { expect, test } from "vitest";
import { PRICING } from "@/lib/constants";
import { chargePerTrace } from "@/lib/suite/pricing";
test("cohort grant-holder pays the $0.07 pro rate on a session trace", () => {
  expect(chargePerTrace({ subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"] }))
    .toBe(PRICING.CHARGE_PER_SUCCESS);
});
