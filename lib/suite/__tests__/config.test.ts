import { afterEach, describe, expect, test, vi } from "vitest";
import { isSuiteSignInEnabled, suiteConfig } from "@/lib/suite/config";

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

describe("isSuiteSignInEnabled", () => {
  test("only the exact string 'true' enables", () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    expect(isSuiteSignInEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "TRUE";
    expect(isSuiteSignInEnabled()).toBe(false);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    expect(isSuiteSignInEnabled()).toBe(false);
  });
});

describe("suiteConfig", () => {
  test("throws loudly when a var is missing", () => {
    delete process.env.SUITE_ISSUER;
    expect(() => suiteConfig()).toThrow(/misconfigured: issuer/);
  });

  test("returns all six when set", () => {
    Object.assign(process.env, {
      SUITE_ISSUER: "i",
      SUITE_CLIENT_ID: "c",
      SUITE_CLIENT_SECRET: "s",
      SUITE_GATEWAY_API_KEY: "k",
      SUITE_GATEWAY_URL: "u",
      SUITE_REDIRECT_URI: "r",
    });
    expect(suiteConfig()).toEqual({
      issuer: "i",
      clientId: "c",
      clientSecret: "s",
      gatewayApiKey: "k",
      gatewayUrl: "u",
      redirectUri: "r",
    });
  });
});
