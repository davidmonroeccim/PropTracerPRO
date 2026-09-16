import { afterEach, expect, test } from "vitest";
import { PRICING } from "@/lib/constants";
import { chargePerTrace } from "@/lib/suite/pricing";

// The grant-aware pro rate (PRICING.CHARGE_PER_SUCCESS) is a kill-switchable feature: it holds
// while Suite sign-in is enabled (the launch state). See pricing.test.ts for the flag-off
// (kill-switch) side of the contract. Named by constant, not by number, so a reprice does not
// leave this comment lying.
const FLAG = "NEXT_PUBLIC_SUITE_SIGNIN_ENABLED";
const original = process.env[FLAG];
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

test("cohort grant-holder pays the pro per-success rate on a session trace (Suite enabled)", () => {
  process.env[FLAG] = "true";
  expect(
    chargePerTrace({
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["prop-tracer-pro"],
    }),
  ).toBe(PRICING.CHARGE_PER_SUCCESS);
});
