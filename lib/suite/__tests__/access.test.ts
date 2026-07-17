import { afterEach, expect, test, vi } from "vitest";
const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({ update }) }) }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
const fetchEntitlements = vi.fn();
vi.mock("@/lib/suite/entitlements", async (orig) => ({ ...(await orig() as object), fetchEntitlements }));
afterEach(() => vi.clearAllMocks());

test("no gateway_sub -> no refresh, no gateway call", async () => {
  const { scheduleSuiteRefresh } = await import("@/lib/suite/access");
  scheduleSuiteRefresh({ id: "U1", gateway_sub: null });
  expect(fetchEntitlements).not.toHaveBeenCalled();
});
test("fresh snapshot -> no gateway call", async () => {
  const { scheduleSuiteRefresh } = await import("@/lib/suite/access");
  scheduleSuiteRefresh({ id: "U1", gateway_sub: "S1", gateway_products_checked_at: new Date().toISOString() });
  expect(fetchEntitlements).not.toHaveBeenCalled();
});
