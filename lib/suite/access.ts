import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSuiteSignInEnabled } from "./config";
import { type EntitlementProfile, fetchEntitlements, isSnapshotStale } from "./entitlements";

interface RefreshRow extends EntitlementProfile { id: string }

/** Schedule the TTL refresh AFTER the response flushes. after() throws outside a request scope,
 *  so degrade to fire-and-forget there. refreshSuiteSnapshot never rejects. */
export function scheduleSuiteRefresh(profile: RefreshRow): void {
  if (!isSuiteSignInEnabled()) return; // Kill-switch: no snapshot refresh or gateway pings when disabled.
  if (!profile.gateway_sub) return;
  try { after(() => refreshSuiteSnapshot(profile)); }
  catch { void refreshSuiteSnapshot(profile); }
}

/** Re-validate the snapshot on a 30-min TTL. Failure-tolerant: a gateway outage keeps the last
 *  snapshot (never a lockout). Entire body inside try because it is handed to after()/void. */
async function refreshSuiteSnapshot(profile: RefreshRow): Promise<void> {
  try {
    const gatewaySub = profile.gateway_sub;
    if (!gatewaySub) return;
    if (!isSnapshotStale(profile.gateway_products_checked_at)) return;
    const ent = await fetchEntitlements(gatewaySub);
    await (createAdminClient().from("user_profiles") as any)
      .update({ gateway_products: ent.products, gateway_products_checked_at: new Date().toISOString() })
      .eq("id", profile.id);
  } catch (e) {
    console.error("[suite-signin] entitlement refresh failed, keeping last snapshot:", e);
  }
}
