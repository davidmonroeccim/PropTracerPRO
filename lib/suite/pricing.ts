import { PRICING } from "@/lib/constants";
import { effectiveIsPro, type EntitlementProfile } from "./entitlements";

/**
 * Per-successful-trace charge for a SESSION-side or cron flow, grant-aware.
 * Track A only: the /api/v1/* API-key surface keeps the raw getChargePerTrace (that is Track B).
 * A grant can only LOWER the rate ($0.11 -> $0.07); it can never mint money (the wallet balance
 * gate still 402s at $0), so this is safe.
 */
export function chargePerTrace(profile: EntitlementProfile): number {
  return effectiveIsPro(profile) ? PRICING.CHARGE_PER_SUCCESS : PRICING.CHARGE_PER_SUCCESS_WALLET;
}
