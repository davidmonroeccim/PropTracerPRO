import { SUITE_PRODUCT, suiteConfig } from "./config";

const TTL_MS = 30 * 60 * 1000;

export interface EntitlementProfile {
  subscription_tier?: string | null;
  is_acquisition_pro_member?: boolean | null;
  gateway_sub?: string | null;
  gateway_products?: string[] | null;
  gateway_products_checked_at?: string | null;
}

/** Does the gateway grant this user PTP? Additive: the caller ORs it with local pro. */
export function hasSuiteAccess(p: EntitlementProfile): boolean {
  return (p.gateway_products ?? []).includes(SUITE_PRODUCT);
}

export function isSnapshotStale(checkedAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!checkedAt) return true;
  return now.getTime() - Date.parse(checkedAt) > TTL_MS;
}

/** Ask the gateway what this user is entitled to. Throws on failure; callers degrade, never lock out. */
export async function fetchEntitlements(
  gatewaySub: string,
): Promise<{ products: string[]; expires_hint: string | null }> {
  const { gatewayUrl, gatewayApiKey } = suiteConfig();
  const url = new URL("/api/v1/entitlements", gatewayUrl);
  url.searchParams.set("user", gatewaySub);
  const res = await fetch(url, {
    headers: { "x-api-key": gatewayApiKey },
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`entitlements lookup failed (${res.status})`);
  return (await res.json()) as { products: string[]; expires_hint: string | null };
}

/**
 * PTP effective pro: a single, binary, ADDITIVE rule. Pro if the local tier is pro, OR the
 * AcquisitionPRO (GoHighLevel) tag is set, OR a gateway grant covers PTP. Never downgrades
 * (a native pro stays pro). Computed at read time; subscription_tier is never written.
 */
export function effectiveIsPro(p: EntitlementProfile): boolean {
  return p.subscription_tier === "pro" || p.is_acquisition_pro_member === true || hasSuiteAccess(p);
}
