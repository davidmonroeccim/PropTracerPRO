import { protectedResourceHandler } from "mcp-handler";
import { NextResponse } from "next/server";
import { suiteConfig } from "@/lib/suite/config";

// Ship dormant: 404 until SUITE_MCP_ENABLED=true, mirroring the /api/[transport] gate so BOTH MCP
// routes are dormant when the flag is off -- behaviorally identical to origin/main, which 404s this
// path entirely. The handler is built lazily (inside GET) so the flag-off path never evaluates the
// issuer config, and so a missing SUITE_ISSUER fails loudly via suiteConfig() only when the feature
// is actually on.
export async function GET(req: Request): Promise<Response> {
  if (process.env.SUITE_MCP_ENABLED !== "true") {
    return NextResponse.json({ error: "PropTracerPRO MCP is not enabled." }, { status: 404 });
  }
  // suiteConfig().issuer throws a clear "Suite sign-in is misconfigured" error if SUITE_ISSUER is
  // unset, instead of the generic TypeError that raw process.env.SUITE_ISSUER!.replace(...) throws.
  // The gateway Supabase is the authorization server (SUITE_ISSUER = <gateway supabase>/auth/v1);
  // keep the same URL derivation (strip a trailing /auth/v1, then re-suffix it).
  const authServerUrl = suiteConfig().issuer.replace(/\/auth\/v1\/?$/, "") + "/auth/v1";
  const handler = protectedResourceHandler({ authServerUrls: [authServerUrl] });
  return handler(req);
}
