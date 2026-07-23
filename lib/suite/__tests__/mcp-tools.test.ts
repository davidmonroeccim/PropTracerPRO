import { describe, expect, it, vi } from "vitest";
import { resolvePtpProfile } from "@/lib/suite/mcp-shared";
import { walletBalance, listTraces } from "@/lib/suite/mcp-tools";

/** Admin stub whose from().select().eq().maybeSingle() resolves to `profile` (or `profileError` when
 *  set), whose from().select().eq().order().limit() resolves to `traces`, and whose
 *  from().select().eq().eq().gte() (walletBalance's today's-spend query) also resolves to `traces`
 *  (unused by the walletBalance tests below, which don't assert on mcp_spend_today).
 *  NOTE: adjusted from the brief's stub to add the `gte` terminal (walletBalance's actual chain awaits
 *  `.gte()` directly, not `.limit()` or `.maybeSingle()`); the implementation is the source of truth.
 *  `limitFn` lets a test capture the clamped value passed to `.limit(n)`. */
function adminStub({
  profile = null,
  profileError = null,
  traces = [],
  limitFn,
}: {
  profile?: unknown;
  profileError?: { message: string } | null;
  traces?: unknown[];
  limitFn?: (n: number) => void;
}) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    maybeSingle: async () => ({ data: profile, error: profileError }),
    limit: async (n: number) => {
      limitFn?.(n);
      return { data: traces, error: null };
    },
    gte: async () => ({ data: traces, error: null }),
  };
  return { from: () => chain } as never;
}

describe("resolvePtpProfile", () => {
  it("returns the linked profile", async () => {
    const admin = adminStub({ profile: { id: "p1", wallet_balance: 5 } });
    expect(await resolvePtpProfile(admin, "sub-1")).toMatchObject({ id: "p1", wallet_balance: 5 });
  });
  it("returns null for an unlinked gateway sub (genuine no-row: error null, data null)", async () => {
    const admin = adminStub({ profile: null, profileError: null });
    expect(await resolvePtpProfile(admin, "sub-x")).toBeNull();
  });
  it("throws (does not return null) on a real DB error, distinct from the no-row case", async () => {
    const admin = adminStub({ profile: null, profileError: { message: "db down" } });
    await expect(resolvePtpProfile(admin, "sub-1")).rejects.toThrow(/db down/);
  });
});

describe("walletBalance", () => {
  it("returns the balance for a linked user", async () => {
    const admin = adminStub({ profile: { id: "p1", wallet_balance: 12.5 } });
    const out = await walletBalance(admin, "sub-1");
    expect(out).toMatchObject({ wallet_balance: 12.5 });
  });
  it("returns the setup message for an unlinked user", async () => {
    const admin = adminStub({ profile: null });
    const out = await walletBalance(admin, "sub-x");
    expect(JSON.stringify(out)).toMatch(/Sign into PropTracerPRO/i);
  });
});

describe("listTraces", () => {
  it("returns the caller's own past traces", async () => {
    const admin = adminStub({ profile: { id: "p1", wallet_balance: 0 }, traces: [{ id: "t1" }] });
    const out = await listTraces(admin, "sub-1", { limit: 10 });
    expect(out).toMatchObject({ traces: [{ id: "t1" }] });
  });
  it("returns the setup message for an unlinked user", async () => {
    const admin = adminStub({ profile: null });
    const out = await listTraces(admin, "sub-x", {});
    expect(JSON.stringify(out)).toMatch(/Sign into PropTracerPRO/i);
  });

  describe("limit clamp", () => {
    it("clamps 0 up to the floor of 1", async () => {
      const limitFn = vi.fn();
      const admin = adminStub({ profile: { id: "p1", wallet_balance: 0 }, limitFn });
      await listTraces(admin, "sub-1", { limit: 0 });
      expect(limitFn).toHaveBeenCalledWith(1);
    });
    it("clamps 5000 down to the ceiling of 200", async () => {
      const limitFn = vi.fn();
      const admin = adminStub({ profile: { id: "p1", wallet_balance: 0 }, limitFn });
      await listTraces(admin, "sub-1", { limit: 5000 });
      expect(limitFn).toHaveBeenCalledWith(200);
    });
    it("defaults to 25 when no limit is given", async () => {
      const limitFn = vi.fn();
      const admin = adminStub({ profile: { id: "p1", wallet_balance: 0 }, limitFn });
      await listTraces(admin, "sub-1", {});
      expect(limitFn).toHaveBeenCalledWith(25);
    });
  });
});
