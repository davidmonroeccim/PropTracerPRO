import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_FALLBACK,
  AUTH_ERROR_MESSAGES,
  authErrorMessage,
  loginErrorFromSearch,
} from "@/lib/auth/login-errors";
import { SUITE_ERROR_MESSAGES } from "@/lib/suite/login-errors";

// Before this existed, /auth/callback redirected failures to /login?error=auth_callback_error and
// the login page only read `suite_error` -- so a dead sign-in link dumped the user back on the form
// with NO message at all. That silence is what made the lockout undiagnosable; these tests fence it.

describe("authErrorMessage", () => {
  it("returns null when there is no error code (the normal login render)", () => {
    expect(authErrorMessage(null)).toBeNull();
    expect(authErrorMessage("")).toBeNull();
  });

  it("explains the code /auth/callback emits on a failed exchange", () => {
    const msg = authErrorMessage("auth_callback_error");
    expect(msg).toBe(AUTH_ERROR_MESSAGES.auth_callback_error);
    expect(msg).toBeTruthy();
  });

  it("explains both codes /auth/confirm emits", () => {
    expect(authErrorMessage("link_invalid")).toBe(AUTH_ERROR_MESSAGES.link_invalid);
    expect(authErrorMessage("link_expired")).toBe(AUTH_ERROR_MESSAGES.link_expired);
  });

  it("falls back to fixed copy for an unknown code and never echoes the raw param", () => {
    // The URL carries only an opaque code. Echoing it would let a crafted link put arbitrary
    // prose on our login page -- the same phishing hole lib/suite/login-errors.ts exists to close.
    const injected = "<script>alert(1)</script> Call 555-1234 to restore your account";
    expect(authErrorMessage(injected)).toBe(AUTH_ERROR_FALLBACK);
    expect(authErrorMessage("nope")).toBe(AUTH_ERROR_FALLBACK);
  });

  it("tells the user what to do next in every message", () => {
    for (const msg of [...Object.values(AUTH_ERROR_MESSAGES), AUTH_ERROR_FALLBACK]) {
      expect(msg.length).toBeGreaterThan(20);
    }
  });
});

describe("loginErrorFromSearch", () => {
  it("shows nothing on a clean /login", () => {
    expect(loginErrorFromSearch("")).toBeNull();
    expect(loginErrorFromSearch("?next=%2Fdashboard")).toBeNull();
  });

  it("surfaces the `error` param from /auth/callback and /auth/confirm", () => {
    // The regression guard. Read only `suite_error` -- as the page did -- and all three go null,
    // which is exactly the silent login form users were sent back to.
    expect(loginErrorFromSearch("?error=auth_callback_error")).toBe(AUTH_ERROR_MESSAGES.auth_callback_error);
    expect(loginErrorFromSearch("?error=link_expired")).toBe(AUTH_ERROR_MESSAGES.link_expired);
    expect(loginErrorFromSearch("?error=link_invalid")).toBe(AUTH_ERROR_MESSAGES.link_invalid);
  });

  it("still surfaces the Suite sign-in param", () => {
    expect(loginErrorFromSearch("?suite_error=already_linked")).toBe(SUITE_ERROR_MESSAGES.already_linked);
  });

  it("prefers the Suite message when a redirect somehow carries both", () => {
    expect(loginErrorFromSearch("?suite_error=refused&error=link_expired")).toBe(
      SUITE_ERROR_MESSAGES.refused,
    );
  });
});
