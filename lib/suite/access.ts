import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSuiteSignInEnabled } from "./config";
import { type EntitlementProfile, fetchEntitlements, isSnapshotStale } from "./entitlements";

interface RefreshRow extends EntitlementProfile { id: string }

type SnapshotFields = Pick<EntitlementProfile, "gateway_products" | "gateway_products_checked_at">;

/**
 * Single write path for the gateway entitlement snapshot on user_profiles, shared by both
 * refreshers below. createAdminClient() (lib/supabase/admin.ts) builds its client with no
 * Database generic, so every table/column on it already types as `any` — there is no `any` to
 * cast away here. A supabase-js query without `.throwOnError()` never rejects for a DB-level
 * failure (e.g. a missing GRANT) — it resolves with `{ error }` — so that case is inspected and
 * logged right here rather than swallowed. Only createAdminClient() itself throwing (e.g. a
 * missing env var) escapes this function as a rejection; each call site below keeps its own
 * try/catch and its own fail-open behaviour around that.
 */
async function persistSnapshot(userId: string, snapshot: SnapshotFields): Promise<void> {
  const { error } = await createAdminClient().from("user_profiles").update(snapshot).eq("id", userId);
  if (error) {
    console.error("[suite-signin] entitlement snapshot persist failed:", error);
  }
}

/** A malformed entitlements response is a FAILURE, not a revocation: only a genuine array of
 *  product slugs is believed, including a well-formed empty one (`[]`), which IS a real
 *  revocation and must still be honoured. Anything else (`undefined`, `null`, a non-array) throws
 *  so the caller's existing fail-open catch handles it uniformly: admitted on the last snapshot,
 *  nothing persisted, logged. */
function assertValidProducts(products: unknown): asserts products is string[] {
  if (!Array.isArray(products)) {
    throw new Error("entitlements response malformed: products is not an array");
  }
}

// No in-flight coalescing for concurrent stale-snapshot refreshes: two simultaneous requests for
// the same stale user both call the gateway. Left this way on purpose rather than by omission —
// the first successful persist advances gateway_products_checked_at (so it self-heals within one
// request's TTL window), and Fix 1 above removes the unbounded case (a malfunctioning gateway can
// no longer wedge the row into permanent staleness, which was the scenario that made repeated
// concurrent calls unbounded rather than just a brief burst).

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
    assertValidProducts(ent.products);
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
    assertValidProducts(ent.products);
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
