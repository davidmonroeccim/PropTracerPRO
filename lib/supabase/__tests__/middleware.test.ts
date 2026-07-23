import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Narrow-exemption fence for the /.well-known/ login-redirect fix: an
// unauthenticated MCP client must be able to fetch the OAuth discovery doc
// WITHOUT being bounced to /login, while every other protected path keeps
// redirecting unauthenticated visitors exactly as before.

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
  }),
}));

describe("updateSession middleware: /.well-known/ exemption", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("does NOT redirect an unauthenticated request to /.well-known/oauth-protected-resource", async () => {
    const { updateSession } = await import("@/lib/supabase/middleware");
    const req = new NextRequest("https://proptracerpro.com/.well-known/oauth-protected-resource");
    const res = await updateSession(req);
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  // MUTATION FENCE (narrowness): a protected, non-exempt path must still
  // redirect unauthenticated visitors to /login -- proves the new exemption
  // is scoped to /.well-known/ and did not weaken auth generally.
  it("still redirects an unauthenticated request to /dashboard to /login", async () => {
    const { updateSession } = await import("@/lib/supabase/middleware");
    const req = new NextRequest("https://proptracerpro.com/dashboard");
    const res = await updateSession(req);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});
