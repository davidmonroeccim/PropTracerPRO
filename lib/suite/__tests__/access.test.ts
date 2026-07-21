import { afterEach, beforeEach, expect, test, vi } from "vitest";

const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({ update }) }) }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
const fetchEntitlements = vi.fn();
vi.mock("@/lib/suite/entitlements", async (orig) => ({ ...((await orig()) as object), fetchEntitlements }));

const FLAG = "NEXT_PUBLIC_SUITE_SIGNIN_ENABLED";
const original = process.env[FLAG];
beforeEach(() => {
  process.env[FLAG] = "true"; // Suite enabled unless a test opts out (the kill-switch case).
});
afterEach(() => {
  vi.clearAllMocks();
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

test("no gateway_sub -> no refresh, no gateway call", async () => {
  const { scheduleSuiteRefresh } = await import("@/lib/suite/access");
  scheduleSuiteRefresh({ id: "U1", gateway_sub: null });
  expect(fetchEntitlements).not.toHaveBeenCalled();
});

test("fresh snapshot -> no gateway call", async () => {
  const { scheduleSuiteRefresh } = await import("@/lib/suite/access");
  scheduleSuiteRefresh({
    id: "U1",
    gateway_sub: "S1",
    gateway_products_checked_at: new Date().toISOString(),
  });
  expect(fetchEntitlements).not.toHaveBeenCalled();
});

test("stale snapshot + gateway_sub -> fetches and writes the refreshed snapshot", async () => {
  fetchEntitlements.mockResolvedValue({ products: ["prop-tracer-pro"], expires_hint: null });
  const { scheduleSuiteRefresh } = await import("@/lib/suite/access");
  scheduleSuiteRefresh({ id: "U1", gateway_sub: "S1", gateway_products_checked_at: null });
  await vi.waitFor(() => expect(update).toHaveBeenCalled());
  expect(fetchEntitlements).toHaveBeenCalledWith("S1");
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ gateway_products: ["prop-tracer-pro"] }),
  );
});

test("kill-switch: Suite disabled -> no refresh even with a stale snapshot", async () => {
  delete process.env[FLAG];
  fetchEntitlements.mockResolvedValue({ products: ["prop-tracer-pro"], expires_hint: null });
  const { scheduleSuiteRefresh } = await import("@/lib/suite/access");
  scheduleSuiteRefresh({ id: "U1", gateway_sub: "S1", gateway_products_checked_at: null });
  expect(fetchEntitlements).not.toHaveBeenCalled();
});
