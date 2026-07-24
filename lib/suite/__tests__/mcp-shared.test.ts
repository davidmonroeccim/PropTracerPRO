import { describe, expect, it } from "vitest";
import { assertPtpAccess, ctx, ok, err, PTP_MCP_CAVEAT } from "@/lib/suite/mcp-shared";

describe("assertPtpAccess", () => {
  it("passes when prop-tracer-pro is present", () => {
    expect(() => assertPtpAccess(["waldo", "prop-tracer-pro"])).not.toThrow();
  });
  // MUTATION FENCE: deleting the throw in assertPtpAccess turns this red.
  it("throws when prop-tracer-pro is absent", () => {
    expect(() => assertPtpAccess(["waldo"])).toThrow(/does not include PropTracerPRO/);
  });
  it("throws on empty scopes", () => {
    expect(() => assertPtpAccess([])).toThrow();
  });
});

describe("ctx", () => {
  it("extracts userId and products", () => {
    expect(ctx({ authInfo: { scopes: ["prop-tracer-pro"], extra: { userId: "u1" } } })).toEqual({
      userId: "u1",
      products: ["prop-tracer-pro"],
    });
  });
  it("throws when unauthenticated", () => {
    expect(() => ctx({})).toThrow(/Not authenticated/);
  });
});

describe("ok/err", () => {
  it("ok appends the caveat", () => {
    const out = ok({ a: 1 });
    expect(out.content[0].text).toContain('"a": 1');
    expect(out.content[0].text).toContain(PTP_MCP_CAVEAT);
  });
  it("err marks isError and does not leak stack", () => {
    const out = err(new Error("boom"));
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("boom");
    expect(out.content[0].text).not.toMatch(/\n\s+at /);
  });
});
