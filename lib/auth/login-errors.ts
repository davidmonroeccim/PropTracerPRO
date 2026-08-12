import { suiteErrorMessage } from "@/lib/suite/login-errors";

/**
 * Fixed, developer-authored copy for every `error` code the auth routes can put on /login.
 *
 * This exists because the failure was SILENT: /auth/callback redirected to
 * /login?error=auth_callback_error while the login page only read `suite_error`, so a dead sign-in
 * link dropped the user back on the form with no explanation at all. That silence is what made a
 * real lockout look like "nothing happens", and what kept it undiagnosed.
 *
 * The URL carries only an opaque code, never prose. Never widen this to fall back on the raw query
 * param: that would let a crafted link put arbitrary text on our login page (see the same note in
 * lib/suite/login-errors.ts).
 */
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  auth_callback_error:
    "That sign-in link could not be completed. It may have expired, already been used, or been opened in a different browser. Request a new one below.",
  link_invalid:
    "That sign-in link is missing information, which usually means the email client altered it. Request a new one below.",
  link_expired:
    "That link has expired or was already used. Links are valid for one hour and one use. Request a new one below.",
};

export const AUTH_ERROR_FALLBACK =
  "That sign-in link did not work. Request a new one below, or sign in with your password.";

export function authErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return AUTH_ERROR_MESSAGES[code] ?? AUTH_ERROR_FALLBACK;
}

/**
 * Resolve the banner for a /login URL's query string.
 *
 * The login page delegates to this so the "which params do we read" decision is unit-testable
 * rather than buried in a useEffect. It must read BOTH `suite_error` (Suite sign-in) and `error`
 * (magic link / recovery); reading only the first is the bug that made failed links silent.
 */
export function loginErrorFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  return suiteErrorMessage(params.get("suite_error")) ?? authErrorMessage(params.get("error"));
}
