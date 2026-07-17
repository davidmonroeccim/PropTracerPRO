import { expect, test } from "vitest";
import { SUITE_ERROR_FALLBACK, suiteErrorMessage } from "@/lib/suite/login-errors";

test("known codes map to fixed copy", () => {
  expect(suiteErrorMessage("unverified_email")).toMatch(/email/i);
});

test("null code -> null (nothing to show)", () => {
  expect(suiteErrorMessage(null)).toBeNull();
});

test("unknown code -> fixed fallback, never the raw code (anti-phishing)", () => {
  expect(suiteErrorMessage("<script>")).toBe(SUITE_ERROR_FALLBACK);
});
