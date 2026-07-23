import { afterEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const fetchEntitlements = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/suite/entitlements", async (orig) => ({
  ...((await orig()) as object),
  fetchEntitlements: (sub: string) => fetchEntitlements(sub),
}));

function stubEnv() {
  vi.stubEnv("SUITE_ISSUER", "https://ngqmcdefmlyjwgpjihch.supabase.co/auth/v1");
  vi.stubEnv("SUITE_CLIENT_ID", "x");
  vi.stubEnv("SUITE_CLIENT_SECRET", "x");
  vi.stubEnv("SUITE_GATEWAY_API_KEY", "x");
  vi.stubEnv("SUITE_GATEWAY_URL", "https://suite-gateway.vercel.app");
  vi.stubEnv("SUITE_REDIRECT_URI", "https://proptracerpro.com/api/auth/suite/callback");
  vi.stubEnv("SUITE_GATEWAY_SUPABASE_ANON_KEY", "anon-key");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("verifyToken", () => {
  it("returns undefined when no bearer token", async () => {
    stubEnv();
    const { verifyToken } = await import("@/lib/suite/mcp-auth");
    expect(await verifyToken(new Request("https://x"), undefined)).toBeUndefined();
  });

  it("returns undefined when the gateway rejects the token", async () => {
    stubEnv();
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad" } });
    const { verifyToken } = await import("@/lib/suite/mcp-auth");
    expect(await verifyToken(new Request("https://x"), "tok")).toBeUndefined();
  });

  it("returns AuthInfo with products as scopes for a valid token", async () => {
    stubEnv();
    getUser.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.com" } }, error: null });
    fetchEntitlements.mockResolvedValue({ products: ["prop-tracer-pro"], expires_hint: null });
    const { verifyToken } = await import("@/lib/suite/mcp-auth");
    const info = await verifyToken(new Request("https://x"), "tok");
    expect(info).toMatchObject({
      token: "tok",
      scopes: ["prop-tracer-pro"],
      clientId: "suite-gateway",
      extra: { userId: "u1", email: "a@b.com" },
    });
    expect(fetchEntitlements).toHaveBeenCalledWith("u1");
  });

  it("returns AuthInfo with empty scopes when the user holds no grants", async () => {
    stubEnv();
    getUser.mockResolvedValue({ data: { user: { id: "u2", email: null } }, error: null });
    fetchEntitlements.mockResolvedValue({ products: [], expires_hint: null });
    const { verifyToken } = await import("@/lib/suite/mcp-auth");
    const info = await verifyToken(new Request("https://x"), "tok");
    expect(info?.scopes).toEqual([]);
  });
});
