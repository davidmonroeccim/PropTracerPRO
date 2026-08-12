import { describe, expect, it } from "vitest";
import { isEmailOtpType, safeNext } from "@/lib/auth/email-link";

// Emailed links carry a one-time `token_hash` instead of a PKCE `?code=`, so /auth/confirm is
// reachable with attacker-chosen query values. Both parsers below are the gate: `type` is
// allowlisted before it reaches GoTrue, and `next` may only ever be a same-origin relative path.

describe("isEmailOtpType", () => {
  it("accepts the types an emailed link can legitimately drive", () => {
    for (const t of ["recovery", "magiclink", "signup", "invite", "email", "email_change"]) {
      expect(isEmailOtpType(t)).toBe(true);
    }
  });

  it("rejects null, empty, and unknown types rather than forwarding them to GoTrue", () => {
    expect(isEmailOtpType(null)).toBe(false);
    expect(isEmailOtpType("")).toBe(false);
    expect(isEmailOtpType("sms")).toBe(false);
    expect(isEmailOtpType("phone_change")).toBe(false);
    expect(isEmailOtpType("RECOVERY")).toBe(false);
  });
});

describe("safeNext", () => {
  it("passes through a same-origin relative path", () => {
    expect(safeNext("/reset-password")).toBe("/reset-password");
    expect(safeNext("/dashboard")).toBe("/dashboard");
    expect(safeNext("/history?page=2")).toBe("/history?page=2");
  });

  it("falls back when absent", () => {
    expect(safeNext(null)).toBe("/dashboard");
    expect(safeNext(undefined)).toBe("/dashboard");
    expect(safeNext("")).toBe("/dashboard");
  });

  it("refuses off-origin targets so a mailed link cannot become an open redirect", () => {
    // A confirmed session rides on this redirect. Sending it to an attacker's origin would hand
    // them a freshly signed-in user, so every non-relative shape must fall back.
    expect(safeNext("https://evil.example.com/x")).toBe("/dashboard");
    expect(safeNext("//evil.example.com/x")).toBe("/dashboard");
    expect(safeNext("/\\evil.example.com")).toBe("/dashboard");
    expect(safeNext("http://proptracerpro.com.evil.example.com")).toBe("/dashboard");
  });

  it("honours an explicit fallback", () => {
    expect(safeNext(null, "/reset-password")).toBe("/reset-password");
    expect(safeNext("https://evil.example.com", "/reset-password")).toBe("/reset-password");
  });
});
