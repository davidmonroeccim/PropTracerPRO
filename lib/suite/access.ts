import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSuiteSignInEnabled } from "./config";
import { type EntitlementProfile, fetchEntitlements, isSnapshotStale } from "./entitlements";

export interface RefreshRow extends EntitlementProfile { id: string }

type SnapshotFields = Pick<EntitlementProfile, "gateway_products" | "gateway_products_checked_at">;

/**
 * Single write path for the gateway entitlement snapshot on user_profiles, shared by both
 * refreshers below. createAdminClient() (lib/supabase/admin.ts) builds its client with no
 * Database generic, so every table/column on it already types as `any` — there is no `any` to
 * cast away here. This throws on failure rather than swallowing it; each call site below keeps
 * its own try/catch and its own fail-open behaviour around the call.
 */
async function persistSnapshot(userId: string, snapshot: SnapshotFields): Promise<void> {
  await createAdminClient().from("user_profiles").update(snapshot).eq("id", userId);
}

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
    await persistSnapshot(profile.id, {
      gateway_products: ent.products,
      gateway_products_checked_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[suite-signin] entitlement refresh failed, keeping last snapshot:", e);
  }
}

/**
 * Blocking sibling of scheduleSuiteRefresh, for the one surface that has no session, no page
 * render and so nothing else to ever call scheduleSuiteRefresh for it: the v1 API key gate
 * (lib/api/auth.ts). AWAITS the TTL check and, when stale, the gateway call, so a revocation
 * takes effect on the very request that would otherwise still admit it. A fresh snapshot (within
 * TTL) returns immediately with no gateway call at all — the common case costs nothing.
 *
 * Same fail-open doctrine as refreshSuiteSnapshot: a gateway error keeps the last snapshot
 * (never a lockout) and is logged, not thrown. A failed persist is logged and never fails the
 * caller either, but — unlike a gateway error — does NOT roll back the refreshed values: the
 * gateway already answered, so the caller gates on that answer even if writing it back failed.
 *
 * The caller MUST gate on the returned fields, not the ones it passed in: on success they are
 * the freshly fetched values, not the stale row.
 */
export async function refreshSuiteSnapshotBlocking(profile: RefreshRow): Promise<SnapshotFields> {
  const fallback: SnapshotFields = {
    gateway_products: profile.gateway_products,
    gateway_products_checked_at: profile.gateway_products_checked_at,
  };
  if (!isSuiteSignInEnabled()) return fallback; // Kill-switch: never a gateway call while disabled.
  if (!profile.gateway_sub) return fallback; // Nothing to refresh against.
  if (!isSnapshotStale(profile.gateway_products_checked_at)) return fallback; // Still fresh.

  let refreshed: SnapshotFields;
  try {
    const ent = await fetchEntitlements(profile.gateway_sub);
    refreshed = { gateway_products: ent.products, gateway_products_checked_at: new Date().toISOString() };
  } catch (e) {
    console.error("[suite-signin] blocking entitlement refresh failed, keeping last snapshot:", e);
    return fallback;
  }

  try {
    await persistSnapshot(profile.id, refreshed);
  } catch (e) {
    console.error("[suite-signin] blocking entitlement snapshot persist failed:", e);
  }

  return refreshed;
}
