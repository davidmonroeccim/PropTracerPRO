import { afterEach, expect, test, vi } from "vitest";

const getUserById = vi.fn();
const generateLink = vi.fn();
const verifyOtp = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { getUserById, generateLink } } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp } }),
}));

afterEach(() => vi.clearAllMocks());

test("mints by the account's OWN email resolved by id, then verifies the OTP", async () => {
  getUserById.mockResolvedValue({ data: { user: { email: "real@acct.com" } }, error: null });
  generateLink.mockResolvedValue({ data: { properties: { hashed_token: "H" } }, error: null });
  verifyOtp.mockResolvedValue({ error: null });

  const { mintLocalSession } = await import("@/lib/suite/session");
  await mintLocalSession({ userId: "U1", email: "STALE@claim.com" });

  expect(getUserById).toHaveBeenCalledWith("U1");
  expect(generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "real@acct.com" });
  expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "H", type: "magiclink" });
});

test("throws (never signs in) when the account cannot be resolved", async () => {
  getUserById.mockResolvedValue({ data: { user: null }, error: { message: "x" } });
  const { mintLocalSession } = await import("@/lib/suite/session");
  await expect(mintLocalSession({ userId: "U1", email: "a@c.com" })).rejects.toThrow();
  expect(generateLink).not.toHaveBeenCalled();
});
