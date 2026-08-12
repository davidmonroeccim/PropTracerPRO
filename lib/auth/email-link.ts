/**
 * Parsing for emailed sign-in links, kept pure so every branch is testable.
 *
 * Emailed links carry a one-time `token_hash` (see the Supabase Recovery / Magic Link templates)
 * rather than a PKCE `?code=`. A token_hash is verified server-side with no browser-held
 * code_verifier, so the link still works when it is opened on a different device from the one that
 * requested it -- the case PKCE structurally cannot serve, and the one that locked users out.
 *
 * Both values below arrive from a URL a stranger can craft, so both are gates, not conveniences.
 */

/** The only verifyOtp types an emailed link may drive. Anything else is refused rather than
 *  forwarded to GoTrue. */
export const EMAIL_OTP_TYPES = [
  "recovery",
  "magiclink",
  "signup",
  "invite",
  "email",
  "email_change",
] as const;

export type EmailOtpType = (typeof EMAIL_OTP_TYPES)[number];

export function isEmailOtpType(value: string | null | undefined): value is EmailOtpType {
  return !!value && (EMAIL_OTP_TYPES as readonly string[]).includes(value);
}

/**
 * Only same-origin relative paths may be used as a post-confirm redirect target.
 *
 * A verified session rides on this redirect, so an off-origin target would hand an attacker a
 * freshly signed-in user. Mirrors suite-gateway's lib/safe-next.ts deliberately: same rule, same
 * shape, so the two apps cannot drift apart on it.
 */
export function safeNext(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}
