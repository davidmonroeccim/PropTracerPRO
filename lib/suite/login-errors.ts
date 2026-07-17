/**
 * Fixed, developer-authored copy for every code the Suite callback can emit. The URL carries only
 * an opaque code, never prose, so this object alone decides what a visitor sees. Never widen this
 * to fall back on the raw query param: that recreates the phishing hole it exists to close.
 */
export const SUITE_ERROR_MESSAGES: Record<string, string> = {
  invalid_request: "This sign-in request could not be verified. Please try again below.",
  cancelled: "Sign-in was cancelled. You can try again, or sign in with your email below.",
  unverified_email:
    "We could not confirm your email address for Suite sign-in. Please sign in with your email below.",
  already_linked:
    "This account is already linked to a different Suite sign-in identity. Please sign in with your email below.",
  refused: "We could not complete Suite sign-in for this account. Please sign in with your email below.",
  failed: "Suite sign-in failed. You can still sign in with your email below.",
};

export const SUITE_ERROR_FALLBACK =
  "Suite sign-in did not go through. You can still sign in with your email below.";

export function suiteErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return SUITE_ERROR_MESSAGES[code] ?? SUITE_ERROR_FALLBACK;
}
