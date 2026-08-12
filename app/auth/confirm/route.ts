import { NextResponse } from "next/server";
import { isEmailOtpType, safeNext } from "@/lib/auth/email-link";
import { createClient } from "@/lib/supabase/server";

/**
 * Landing route for emailed sign-in links (password reset and magic link).
 *
 * The Recovery and Magic Link email templates point here with a one-time `token_hash`, which
 * verifyOtp exchanges for a session server-side. Unlike the PKCE `?code=` flow this replaces, it
 * needs no code_verifier cookie from the browser that requested the link -- so the link works when
 * it is opened on a phone after being requested on a desktop.
 *
 * Signup confirmations still use {{ .ConfirmationURL }} -> /auth/callback, which additionally
 * routes first-time users through /onboarding. Returning users arriving here already onboarded, so
 * this route honours `next` and stays dumb.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeNext(searchParams.get("next"));

  if (!tokenHash || !isEmailOtpType(type)) {
    return NextResponse.redirect(`${origin}/login?error=link_invalid`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error) {
    // Expired, already consumed, or tampered with. The login page names the reason.
    return NextResponse.redirect(`${origin}/login?error=link_expired`);
  }

  // verifyOtp wrote the session cookies through the route handler's cookie store; Next attaches
  // them to this redirect.
  return NextResponse.redirect(`${origin}${next}`);
}
