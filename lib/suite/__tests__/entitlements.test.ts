import { describe, expect, test } from "vitest";
import { effectiveIsPro, hasSuiteAccess, isSnapshotStale } from "@/lib/suite/entitlements";

describe("effectiveIsPro (binary, additive OR — never downgrades)", () => {
  const base = {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: [] as string[],
  };
  test("wallet + no member + no grant -> false", () => {
    expect(effectiveIsPro(base)).toBe(false);
  });
  test("native pro -> true", () => {
    expect(effectiveIsPro({ ...base, subscription_tier: "pro" })).toBe(true);
  });
  test("AcquisitionPRO tag -> true", () => {
    expect(effectiveIsPro({ ...base, is_acquisition_pro_member: true })).toBe(true);
  });
  test("gateway grant for PTP -> true", () => {
    expect(effectiveIsPro({ ...base, gateway_products: ["prop-tracer-pro"] })).toBe(true);
  });
  test("gateway grant for a DIFFERENT product -> false", () => {
    expect(effectiveIsPro({ ...base, gateway_products: ["maturr"] })).toBe(false);
  });
  test("nulls are safe", () => {
    expect(
      effectiveIsPro({ subscription_tier: null, is_acquisition_pro_member: null, gateway_products: null }),
    ).toBe(false);
  });
});

describe("hasSuiteAccess / isSnapshotStale", () => {
  test("hasSuiteAccess matches only the PTP slug", () => {
    expect(hasSuiteAccess({ gateway_products: ["prop-tracer-pro"] })).toBe(true);
    expect(hasSuiteAccess({ gateway_products: ["waldo"] })).toBe(false);
    expect(hasSuiteAccess({ gateway_products: null })).toBe(false);
  });
  test("missing checkedAt is stale; fresh within 30m is not", () => {
    const now = new Date("2026-07-17T12:00:00Z");
    expect(isSnapshotStale(null, now)).toBe(true);
    expect(isSnapshotStale("2026-07-17T11:45:00Z", now)).toBe(false);
    expect(isSnapshotStale("2026-07-17T11:20:00Z", now)).toBe(true);
  });
});
