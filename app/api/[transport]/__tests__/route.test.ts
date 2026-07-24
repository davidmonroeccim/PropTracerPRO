import { afterEach, describe, expect, it, vi } from "vitest";

// Dormant kill-switch fence for the MCP transport route: GET/POST must 404
// BEFORE any mcp-handler/auth machinery runs whenever SUITE_MCP_ENABLED is not
// exactly "true" (unset, "false", or anything else). The env gate short-circuits
// ahead of withMcpAuth/createMcpHandler, so no mcp-handler mocking is needed.

describe("/api/[transport] dormant gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("GET 404s when SUITE_MCP_ENABLED is unset", async () => {
    vi.stubEnv("SUITE_MCP_ENABLED", undefined as unknown as string);
    delete process.env.SUITE_MCP_ENABLED;
    const { GET } = await import("@/app/api/[transport]/route");
    const res = await GET(new Request("https://proptracerpro.com/api/mcp"));
    expect(res.status).toBe(404);
  });

  it("GET 404s when SUITE_MCP_ENABLED=false", async () => {
    vi.stubEnv("SUITE_MCP_ENABLED", "false");
    const { GET } = await import("@/app/api/[transport]/route");
    const res = await GET(new Request("https://proptracerpro.com/api/mcp"));
    expect(res.status).toBe(404);
  });

  it("POST 404s when SUITE_MCP_ENABLED is not \"true\"", async () => {
    vi.stubEnv("SUITE_MCP_ENABLED", "false");
    const { POST } = await import("@/app/api/[transport]/route");
    const res = await POST(new Request("https://proptracerpro.com/api/mcp", { method: "POST" }));
    expect(res.status).toBe(404);
  });
});
