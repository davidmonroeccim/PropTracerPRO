import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// /auth/confirm is the landing route for emailed sign-in links. It consumes the one-time
// `token_hash` from the Recovery / Magic Link templates via verifyOtp, which -- unlike the PKCE
// `?code=` flow it replaces -- needs NO browser-held code_verifier. That is what makes a link
// work when it is opened on a different device from the one that requested it.
//
// The bug this route fixes: the recovery link used to land on /reset-password, a client page that
// never exchanged anything, so updateUser({password}) failed with "Auth session missing!" and
// forgot-password was broken for every user.

const verifyOtp = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp } }),
}));

function url(qs: string) {
  return `https://proptracerpro.com/auth/confirm${qs}`;
}

async function get(qs: string) {
  const { GET } = await import("@/app/auth/confirm/route");
  return GET(new Request(url(qs)));
}

describe("/auth/confirm", () => {
  beforeEach(() => {
    verifyOtp.mockReset();
    verifyOtp.mockResolvedValue({ error: null });
  });
  afterEach(() => vi.resetModules());

  it("verifies the token and redirects to next on success", async () => {
    const res = await get("?token_hash=pkce_abc123&type=recovery&next=%2Freset-password");

    expect(verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "pkce_abc123" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://proptracerpro.com/reset-password");
  });

  it("accepts a pkce_-prefixed token_hash (GoTrue prefixes tokens minted for a PKCE request)", async () => {
    // Verified against the live project: POST /auth/v1/verify with a pkce_-prefixed recovery
    // token_hash returns a full session, so the app never needs the code_verifier.
    const res = await get("?token_hash=pkce_4b9c3caae5&type=magiclink&next=%2Fdashboard");
    expect(verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "pkce_4b9c3caae5" });
    expect(res.headers.get("location")).toBe("https://proptracerpro.com/dashboard");
  });

  it("defaults to /dashboard when next is absent", async () => {
    const res = await get("?token_hash=t&type=magiclink");
    expect(res.headers.get("location")).toBe("https://proptracerpro.com/dashboard");
  });

  it("sends an expired or reused link to the login page with link_expired", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });
    const res = await get("?token_hash=stale&type=recovery&next=%2Freset-password");
    expect(res.headers.get("location")).toBe("https://proptracerpro.com/login?error=link_expired");
  });

  it("rejects a missing token_hash without calling GoTrue", async () => {
    const res = await get("?type=recovery");
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("https://proptracerpro.com/login?error=link_invalid");
  });

  it("rejects an unknown type without calling GoTrue", async () => {
    const res = await get("?token_hash=t&type=not_a_type");
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("https://proptracerpro.com/login?error=link_invalid");
  });

  it("never redirects off-origin, even on success", async () => {
    // A verified session rides on this redirect; an off-origin next would hand a signed-in user
    // to an attacker's site. Delete the safeNext() call and this test must go red.
    const res = await get("?token_hash=t&type=magiclink&next=https%3A%2F%2Fevil.example.com%2Fx");
    expect(res.headers.get("location")).toBe("https://proptracerpro.com/dashboard");

    const proto = await get("?token_hash=t&type=magiclink&next=%2F%2Fevil.example.com%2Fx");
    expect(proto.headers.get("location")).toBe("https://proptracerpro.com/dashboard");
  });
});
