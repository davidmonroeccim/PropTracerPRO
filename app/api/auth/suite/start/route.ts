import { NextResponse } from "next/server";
import { isSuiteSignInEnabled, suiteConfig } from "@/lib/suite/config";
import { challengeFor, newVerifier, randomToken } from "@/lib/suite/pkce";

const TEN_MINUTES = 60 * 10;

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
    maxAge: TEN_MINUTES,
  };
  res.cookies.set("suite_state", state, opts);
  res.cookies.set("suite_verifier", verifier, opts);
  res.cookies.set("suite_nonce", nonce, opts);
  return res;
}
