import { PRICING } from "@/lib/constants";
import { PRICE, type PricePlan } from "@/lib/routing/ownerRoute";
import { effectiveIsPro, type EntitlementProfile } from "./entitlements";

/**
 * Per-successful-trace charge for a SESSION-side or cron flow, grant-aware.
 * Track A only: the /api/v1/* API-key surface keeps the raw getChargePerTrace (that is Track B).
 * A grant can only LOWER the rate (CHARGE_PER_SUCCESS_WALLET -> CHARGE_PER_SUCCESS); it can never
 * mint money (the wallet balance
 * gate still 402s at $0), so this is safe.
 */
export function chargePerTrace(profile: EntitlementProfile): number {
  return effectiveIsPro(profile) ? PRICING.CHARGE_PER_SUCCESS : PRICING.CHARGE_PER_SUCCESS_WALLET;
}

/**
 * Which column of the price table this caller pays, for a SESSION-side flow.
 *
 * planRoute() takes the plan as a REQUIRED argument precisely so that no route
 * can quietly bill the wrong column (see FAILSAFE_PRICE_PLAN in
 * lib/routing/ownerRoute.ts: a default of 'pro' once billed pay-as-you-go
 * customers 40% under rate, silently, because nobody reports being
 * undercharged). This is the one place a PTP profile is turned into that
 * argument.
 *
 * Derived from exactly the same predicate as chargePerTrace() above --
 * effectiveIsPro(), which is additive and grant-aware -- so the two can never
 * disagree about who is a pro. 'pro' and 'acqPro' price identically; they are
 * kept apart only so the route reports which entitlement paid.
 *
 * A caller with no entitlement gets 'wallet', which is also the dearest column.
 */
export function pricePlanFor(profile: EntitlementProfile): PricePlan {
  if (profile.is_acquisition_pro_member === true) return "acqPro";
  return effectiveIsPro(profile) ? "pro" : "wallet";
}

/**
 * Tier 2 (Full Property Trace) per RECORD SUBMITTED, for a session-side flow.
 *
 * Not a per-success rate: it is owed whether or not the county has a parcel at
 * that address. Used for the pre-flight balance gate as well as the charge, so
 * a wallet that cannot cover one record is refused before any vendor is asked.
 */
export function chargePerRecord(profile: EntitlementProfile): number {
  return PRICE[pricePlanFor(profile)].tier2PerRecord;
}
