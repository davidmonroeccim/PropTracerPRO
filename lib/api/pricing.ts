/**
 * TRACK B pricing: the /api/v1/* public API-key surface, and nothing else.
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT MAY NOT BE MERGED WITH lib/suite/pricing.ts.
 *
 * PTP has two price-derivation tracks and the split is deliberate, documented at
 * lib/suite/pricing.ts:5-11:
 *
 *   Track A  session-side and cron flows. GRANT-AWARE: effectiveIsPro() also counts a
 *            Suite Gateway product grant, so a gateway-entitled user pays the pro rate.
 *            That is chargePerTrace() / pricePlanFor() / chargePerRecord().
 *   Track B  this surface. RAW: it derives from getChargePerTrace(subscription_tier,
 *            is_acquisition_pro_member) in lib/constants.ts and deliberately does NOT
 *            consult the gateway snapshot.
 *
 * Track A and Track B agree on a pro-tier profile and on an AcquisitionPRO member profile
 * (both price 'pro' / 'acqPro' either way). They disagree on a wallet-tier profile whose only
 * entitlement is a Suite Gateway grant: Track A prices it 'pro', Track B prices it 'wallet'.
 * Before the gate fix in lib/api/auth.ts that shape could not reach the v1 API at all; now it
 * can. The functions below are the RAW twins of
 * pricePlanFor() and chargePerRecord(), and they exist so the v1 route can name its plan
 * instead of guessing one.
 *
 * WHY NOT JUST DEFAULT THE PLAN. lib/routing/ownerRoute.ts documents FAILSAFE_PRICE_PLAN:
 * a default of 'pro' once billed pay-as-you-go customers 40% under rate, with no error,
 * no log line and no complaint, because nobody reports being undercharged. planRoute()
 * takes the plan as a REQUIRED argument for that reason. This is the one place a Track B
 * profile is turned into that argument.
 *
 * PRICE HAS TWO AXES AND ONLY TWO: tier and plan. Four numbers, all of them in PRICE.
 * Owner type selects the VENDOR, never the price (lessons.md L-005).
 */
import { PRICE, type PricePlan } from "@/lib/routing/ownerRoute";

/** The two profile columns Track B prices on. Exactly getChargePerTrace's arguments. */
export interface RawPricingProfile {
  subscription_tier?: string | null;
  is_acquisition_pro_member?: boolean | null;
}

/**
 * Which column of the price table a Track B caller pays.
 *
 * MUST agree with getChargePerTrace(), which returns the pro rate when the tier is 'pro'
 * OR the AcquisitionPRO flag is set, and the wallet rate otherwise. 'pro' and 'acqPro'
 * price identically; they are kept apart only so a route can report which entitlement
 * paid. Anything that is not one of those two is 'wallet', which is also the dearest
 * column -- the safe direction for an unrecognised tier, same reasoning as
 * FAILSAFE_PRICE_PLAN.
 *
 * A test in __tests__/pricing.test.ts asserts this against getChargePerTrace across the
 * whole matrix, so the two cannot drift.
 */
export function rawPricePlanFor(profile: RawPricingProfile): PricePlan {
  if (profile.is_acquisition_pro_member === true) return "acqPro";
  return profile.subscription_tier === "pro" ? "pro" : "wallet";
}

/**
 * Tier 2 (Full Property Trace) per RECORD SUBMITTED, for a Track B caller.
 *
 * Not a per-success rate: it is owed whether or not the county has a parcel at that
 * address. Used for the pre-flight balance gate as well as the charge, so a wallet that
 * cannot cover one record is refused before any vendor is asked.
 */
export function rawChargePerRecord(profile: RawPricingProfile): number {
  return PRICE[rawPricePlanFor(profile)].tier2PerRecord;
}
