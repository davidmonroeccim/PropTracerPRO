import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The reset-password trap: /reset-password sits in publicRoutes, and the middleware redirects any
// AUTHENTICATED user away from public routes to /dashboard. But the emailed recovery link now
// establishes a session at /auth/confirm BEFORE the form renders -- so the user arrives at
// /reset-password already signed in, and the old rule bounced them to /dashboard, leaving the
// password form permanently unreachable. Fixing the code exchange without this is not a fix.

const getUser = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

function req(path: string) {
  return new NextRequest(new Request(`https://proptracerpro.com${path}`));
}
function signedIn() {
  getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
}
function signedOut() {
  getUser.mockResolvedValue({ data: { user: null } });
}
async function run(path: string) {
  const { updateSession } = await import("@/lib/supabase/middleware");
  return updateSession(req(path));
}
function locationOf(res: Response) {
  return res.headers.get("location");
}

describe("updateSession route gating", () => {
  afterEach(() => {
    getUser.mockReset();
    vi.resetModules();
  });

  it("lets an AUTHENTICATED user reach /reset-password so the password form renders", async () => {
    signedIn();
    const res = await run("/reset-password");
    expect(locationOf(res)).toBeNull();
  });

  it("lets an authenticated user reach /auth/confirm and /auth/callback", async () => {
    signedIn();
    expect(locationOf(await run("/auth/confirm"))).toBeNull();
    vi.resetModules();
    expect(locationOf(await run("/auth/callback"))).toBeNull();
  });

  it("still sends an authenticated user off /login and /forgot-password to the dashboard", async () => {
    signedIn();
    expect(locationOf(await run("/login"))).toBe("https://proptracerpro.com/dashboard");
    vi.resetModules();
    expect(locationOf(await run("/forgot-password"))).toBe("https://proptracerpro.com/dashboard");
  });

  it("still sends an unauthenticated user off a protected page to /login", async () => {
    signedOut();
    expect(locationOf(await run("/history"))).toBe("https://proptracerpro.com/login");
  });

  it("lets an unauthenticated user reach /reset-password and /login", async () => {
    signedOut();
    expect(locationOf(await run("/reset-password"))).toBeNull();
    vi.resetModules();
    expect(locationOf(await run("/login"))).toBeNull();
  });
});
