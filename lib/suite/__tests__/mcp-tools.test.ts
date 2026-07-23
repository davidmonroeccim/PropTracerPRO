import { describe, expect, it, vi } from "vitest";
import { resolvePtpProfile } from "@/lib/suite/mcp-shared";
import { walletBalance, listTraces, skipTraceQuote, worstCaseCost, MAX_RECORDS } from "@/lib/suite/mcp-tools";

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

describe("worstCaseCost", () => {
  const proProfile = { subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"] } as never;
  it("prices persons at the grant rate and entities at the $0.25 ceiling", () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    const out = worstCaseCost(
      [
        { owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" },
        { owner_name: "Acme LLC", address: "2 B St", city: "X", state: "TX", zip: "75001" },
      ],
      proProfile,
    );
    expect(out.persons).toBeCloseTo(0.07);
    expect(out.entities).toBeCloseTo(0.25);
    expect(out.total).toBeCloseTo(0.32);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });
});

/** skipTraceQuote's return type is a union of the quote payload and the readonly UNLINKED_MESSAGE
 *  literal; narrow to the quote branch so tests can access its fields without an `any`/`as` escape
 *  hatch. Throws (failing the test loudly) if a "linked" fixture unexpectedly comes back unlinked. */
function expectQuote(out: Awaited<ReturnType<typeof skipTraceQuote>>) {
  if ("error" in out) throw new Error(`expected a quote, got the unlinked message: ${out.message}`);
  return out;
}

describe("skip_trace_quote", () => {
  it("dedups, splits, and returns worst-case + balance + over-cap flag", async () => {
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"], wallet_balance: 1.0 } });
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    const out = await skipTraceQuote(admin, "sub-1", {
      records: [{ owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" }],
    });
    expect(out).toMatchObject({ wallet_balance: 1.0, over_cap: false });
    expect(expectQuote(out).worst_case_cost).toBeGreaterThan(0);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });
  it("flags a list over the 500 cap", async () => {
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"], wallet_balance: 0 } });
    const records = Array.from({ length: MAX_RECORDS + 1 }, (_, i) => ({ owner_name: `X ${i}`, address: `${i} A`, city: "X", state: "TX", zip: "75001" }));
    const out = await skipTraceQuote(admin, "sub-1", { records });
    expect(expectQuote(out).over_cap).toBe(true);
  });
  it("returns the setup message for an unlinked user", async () => {
    const admin = adminStub({ profile: null });
    const out = await skipTraceQuote(admin, "sub-x", { records: [{ owner_name: "A", address: "1", city: "X", state: "TX", zip: "1" }] });
    expect(JSON.stringify(out)).toMatch(/Sign into PropTracerPRO/i);
  });
  it("collapses duplicate addresses before pricing (real dedup, not a pass-through)", async () => {
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"], wallet_balance: 5 } });
    const dupe = { owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" };
    const out = expectQuote(await skipTraceQuote(admin, "sub-1", { records: [dupe, { ...dupe }, { ...dupe }] }));
    expect(out.submitted).toBe(3);
    expect(out.after_dedup).toBe(1);
    expect(out.duplicates_removed).toBe(2);
    expect(out.persons).toBe(1);
    expect(out.entities).toBe(0);
  });
  it("splits a mixed batch into the correct person/entity counts", async () => {
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"], wallet_balance: 5 } });
    const out = expectQuote(
      await skipTraceQuote(admin, "sub-1", {
        records: [
          { owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" },
          { owner_name: "Acme LLC", address: "2 B St", city: "X", state: "TX", zip: "75001" },
          { owner_name: "Jane Realty Holdings", address: "3 C St", city: "X", state: "TX", zip: "75001" },
          { address: "4 D St", city: "X", state: "TX", zip: "75001" },
        ],
      }),
    );
    expect(out.persons).toBe(2);
    expect(out.entities).toBe(2);
    expect(out.after_dedup).toBe(4);
  });
});
