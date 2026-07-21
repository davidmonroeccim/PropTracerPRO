import { type NextRequest, NextResponse } from "next/server";
import { isSuiteSignInEnabled } from "@/lib/suite/config";
import { fetchEntitlements } from "@/lib/suite/entitlements";
import {
  ALREADY_LINKED_ELSEWHERE,
  EMAIL_NOT_VERIFIED_REASON,
  resolveSuiteUser,
  SuiteLinkError,
} from "@/lib/suite/link";
import { exchangeCode, mintLocalSession } from "@/lib/suite/session";
import { verifyIdToken } from "@/lib/suite/verify";
import { createAdminClient } from "@/lib/supabase/admin";

const SUITE_COOKIES = ["suite_state", "suite_verifier", "suite_nonce"] as const;

export type SuiteErrorCode =
  | "invalid_request"
  | "cancelled"
  | "unverified_email"
  | "already_linked"
  | "refused"
  | "failed";

function codeForLinkError(e: SuiteLinkError): SuiteErrorCode {
  if (e.kind === "failed") return "failed"; // transient DB/link error -> retry-friendly copy
  if (e.message === EMAIL_NOT_VERIFIED_REASON) return "unverified_email";
  if (e.message === ALREADY_LINKED_ELSEWHERE) return "already_linked";
  return "refused";
}
function clearSuiteCookies(res: NextResponse): NextResponse {
  for (const c of SUITE_COOKIES) res.cookies.set(c, "", { path: "/api/auth/suite", maxAge: 0 });
  return res;
}
function fail(req: NextRequest, code: SuiteErrorCode) {
  const url = new URL("/login", req.url);
  url.searchParams.set("suite_error", code);
  return clearSuiteCookies(NextResponse.redirect(url));
}

export async function GET(req: NextRequest) {
  if (!isSuiteSignInEnabled()) {
    return clearSuiteCookies(
      NextResponse.json({ error: "Suite sign-in is not enabled." }, { status: 404 }),
    );
  }
  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail(req, "cancelled");

  const code = params.get("code");
  const state = params.get("state");
  const cookieState = req.cookies.get("suite_state")?.value;
  const verifier = req.cookies.get("suite_verifier")?.value;
  const nonce = req.cookies.get("suite_nonce")?.value;
  if (!code || !state || !cookieState || !verifier || !nonce || state !== cookieState) {
    return fail(req, "invalid_request");
  }

  try {
    const idToken = await exchangeCode(code, verifier);
    const claims = await verifyIdToken(idToken, nonce);
    const identity = await resolveSuiteUser(claims); // throws SuiteLinkError on refusal
    await mintLocalSession(identity);

    // Best-effort entitlement snapshot (service_role write). A gateway hiccup must not block a
    // sign-in that already succeeded.
    try {
      const ent = await fetchEntitlements(claims.sub);
      await (createAdminClient().from("user_profiles") as any)
        .update({ gateway_products: ent.products, gateway_products_checked_at: new Date().toISOString() })
        .eq("id", identity.userId);
    } catch (e) {
      console.error("[suite-signin] entitlement snapshot failed (continuing):", e);
    }

    return clearSuiteCookies(NextResponse.redirect(new URL("/dashboard", req.url)));
  } catch (e) {
    if (e instanceof SuiteLinkError) return fail(req, codeForLinkError(e));
    console.error("[suite-signin] callback failed:", e);
    return fail(req, "failed");
  }
}
