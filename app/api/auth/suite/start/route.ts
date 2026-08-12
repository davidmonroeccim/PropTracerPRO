import { NextResponse } from "next/server";
import { isSuiteSignInEnabled, suiteConfig } from "@/lib/suite/config";
import { challengeFor, newVerifier, randomToken } from "@/lib/suite/pkce";

// 30 minutes, not 10. The gateway is invite-only and passwordless, so a member signing in there for
// the first time has to leave for their email inbox and come back mid-flow. Ten minutes did not
// cover that round trip, and when these cookies expired the callback failed `invalid_request` --
// which reads to the member as "the Suite button doesn't work".
const CONSENT_WINDOW = 60 * 30;

export async function GET() {
  if (!isSuiteSignInEnabled()) {
    return NextResponse.json({ error: "Suite sign-in is not enabled." }, { status: 404 });
  }
  const { issuer, clientId, redirectUri } = suiteConfig();
  const verifier = newVerifier();
  const state = randomToken();
  const nonce = randomToken();

  const authorize = new URL(`${issuer}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
  }).toString();

  const res = NextResponse.redirect(authorize);
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/auth/suite",
    maxAge: CONSENT_WINDOW,
  };
  res.cookies.set("suite_state", state, opts);
  res.cookies.set("suite_verifier", verifier, opts);
  res.cookies.set("suite_nonce", nonce, opts);
  return res;
}
