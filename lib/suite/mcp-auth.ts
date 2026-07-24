import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { suiteConfig } from "@/lib/suite/config";
import { fetchEntitlements } from "@/lib/suite/entitlements";

/** Client for the GATEWAY Supabase project (not PTP's own). Its base URL is the
 *  SUITE_ISSUER with the trailing /auth/v1 removed; the anon key is public. Used only to
 *  validate an inbound MCP bearer token via getUser. */
export function gatewaySupabase(): SupabaseClient {
  const base = suiteConfig().issuer.replace(/\/auth\/v1\/?$/, "");
  const anon = process.env.SUITE_GATEWAY_SUPABASE_ANON_KEY;
  if (!anon) {
    throw new Error("Suite MCP is misconfigured: SUITE_GATEWAY_SUPABASE_ANON_KEY is not set.");
  }
  return createClient(base, anon, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Entitlements cache TTL: <=60s, consistent with the suite's snapshot-TTL model. Bounds the
 *  gateway round-trip to once per user per minute while keeping a revoked grant propagating within
 *  the TTL. */
const ENTITLEMENTS_TTL_MS = 60_000;
const entitlementsCache = new Map<string /* gateway sub */, { products: string[]; at: number }>();

/** Validate a gateway-issued bearer, resolve the caller's suite products, and expose them as MCP
 *  scopes. Mirrors the gateway's own verifier but resolves entitlements over REST, cached for
 *  ENTITLEMENTS_TTL_MS so a gateway blip does not fail every tool call. */
export async function verifyToken(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  const { data, error } = await gatewaySupabase().auth.getUser(bearerToken);
  if (error || !data.user) return undefined;

  const userId = data.user.id;
  const cached = entitlementsCache.get(userId);
  let products: string[];
  if (cached && Date.now() - cached.at < ENTITLEMENTS_TTL_MS) {
    products = cached.products;
  } else {
    ({ products } = await fetchEntitlements(userId));
    entitlementsCache.set(userId, { products, at: Date.now() });
  }

  return {
    token: bearerToken,
    scopes: products,
    clientId: "suite-gateway",
    extra: { userId, email: data.user.email },
  };
}
