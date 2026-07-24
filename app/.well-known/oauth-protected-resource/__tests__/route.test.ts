import { afterEach, describe, expect, it, vi } from "vitest";

// Dormant kill-switch fence for the OAuth discovery route. It must 404 whenever SUITE_MCP_ENABLED
// is not exactly "true" (unset, "false", or anything else), mirroring the /api/[transport] gate so
// BOTH MCP routes are dormant/404 when the flag is off -- behaviorally identical to origin/main,
// which 404s this path entirely. When the flag is on, it returns the OAuth protected-resource
// metadata derived from suiteConfig().issuer.

describe("/.well-known/oauth-protected-resource dormant gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("404s when SUITE_MCP_ENABLED is unset", async () => {
    vi.stubEnv("SUITE_MCP_ENABLED", undefined as unknown as string);
    delete process.env.SUITE_MCP_ENABLED;
    const { GET } = await import("@/app/.well-known/oauth-protected-resource/route");
    const res = await GET(new Request("https://proptracerpro.com/.well-known/oauth-protected-resource"));
    expect(res.status).toBe(404);
  });

  it("404s when SUITE_MCP_ENABLED=false", async () => {
    vi.stubEnv("SUITE_MCP_ENABLED", "false");
    const { GET } = await import("@/app/.well-known/oauth-protected-resource/route");
    const res = await GET(new Request("https://proptracerpro.com/.well-known/oauth-protected-resource"));
    expect(res.status).toBe(404);
  });

  it("does NOT touch the issuer config on the flag-off path (404s even when SUITE_ISSUER is unset)", async () => {
    // Regression guard: the flag-off 404 must short-circuit BEFORE suiteConfig() is evaluated, so a
    // dormant deploy with no SUITE_ISSUER still 404s cleanly rather than 500ing.
    vi.stubEnv("SUITE_MCP_ENABLED", "false");
    vi.stubEnv("SUITE_ISSUER", undefined as unknown as string);
    delete process.env.SUITE_ISSUER;
    const { GET } = await import("@/app/.well-known/oauth-protected-resource/route");
    const res = await GET(new Request("https://proptracerpro.com/.well-known/oauth-protected-resource"));
    expect(res.status).toBe(404);
  });

  it("returns the protected-resource metadata (200) when SUITE_MCP_ENABLED=true", async () => {
    vi.stubEnv("SUITE_MCP_ENABLED", "true");
    // suiteConfig() validates the whole Suite sign-in config, so provide all six required vars.
    vi.stubEnv("SUITE_ISSUER", "https://gateway.supabase.co/auth/v1");
    vi.stubEnv("SUITE_CLIENT_ID", "client-id");
    vi.stubEnv("SUITE_CLIENT_SECRET", "client-secret");
    vi.stubEnv("SUITE_GATEWAY_API_KEY", "gateway-api-key");
    vi.stubEnv("SUITE_GATEWAY_URL", "https://gateway.example.com");
    vi.stubEnv("SUITE_REDIRECT_URI", "https://proptracerpro.com/auth/suite/callback");
    const { GET } = await import("@/app/.well-known/oauth-protected-resource/route");
    const res = await GET(new Request("https://proptracerpro.com/.well-known/oauth-protected-resource"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // URL derivation: strip a trailing /auth/v1, re-suffix /auth/v1.
    expect(body.authorization_servers).toEqual(["https://gateway.supabase.co/auth/v1"]);
  });

  it("fails loudly with the clear misconfig error (not a generic TypeError) when the flag is on but SUITE_ISSUER is unset", async () => {
    vi.stubEnv("SUITE_MCP_ENABLED", "true");
    vi.stubEnv("SUITE_ISSUER", undefined as unknown as string);
    delete process.env.SUITE_ISSUER;
    const { GET } = await import("@/app/.well-known/oauth-protected-resource/route");
    await expect(
      GET(new Request("https://proptracerpro.com/.well-known/oauth-protected-resource")),
    ).rejects.toThrow(/Suite sign-in is misconfigured/);
  });
});
