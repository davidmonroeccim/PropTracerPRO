import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

/**
 * `validateApiKey` gates every v1 API call. The defect: it checked
 * `subscription_tier === 'pro' || is_acquisition_pro_member` directly, never
 * consulting a Suite Gateway grant, while the "Generate API Key" button in
 * Settings (app/api/user/generate-api-key/route.ts) gates the SAME access on
 * `effectiveIsPro`, which DOES honour the grant. A gateway-granted customer
 * could generate a key and then be refused on every call. The fix routes
 * `validateApiKey` through `effectiveIsPro` so both doors agree.
 *
 * `effectiveIsPro`'s gateway term (`hasSuiteAccess`) is itself gated by the
 * `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED` kill-switch: with the switch off, a
 * gateway grant must NOT admit anyone. That is pinned below independently of
 * the "does the fix work" test.
 */

const H = vi.hoisted(() => ({
  profile: null as Record<string, unknown> | null,
  error: null as { code?: string; message?: string } | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "user_profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: H.profile, error: H.error }),
            }),
          }),
        };
      }
      // api_logs: fire-and-forget insert, never awaited by the caller.
      return {
        insert: () => Promise.resolve({ data: null, error: null }),
      };
    },
  }),
}));

const { isAuthError, validateApiKey } = await import("@/lib/api/auth");

const DENIED_BODY =
  "API access requires a Pro subscription or AcquisitionPRO membership";

function req(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.Authorization = authHeader;
  return new Request("https://proptracerpro.com/api/v1/trace/status", { headers });
}

const PRO_PROFILE = {
  id: "user-pro",
  subscription_tier: "pro",
  is_acquisition_pro_member: false,
  gateway_products: [],
};

const ACQ_PRO_PROFILE = {
  id: "user-acq-pro",
  subscription_tier: "wallet",
  is_acquisition_pro_member: true,
  gateway_products: [],
};

const GATEWAY_GRANTED_PROFILE = {
  id: "user-gateway",
  subscription_tier: "wallet",
  is_acquisition_pro_member: false,
  gateway_products: ["prop-tracer-pro"],
};

const NO_ENTITLEMENT_PROFILE = {
  id: "user-none",
  subscription_tier: "wallet",
  is_acquisition_pro_member: false,
  gateway_products: [],
};

let ORIGINAL_FLAG: string | undefined;

beforeEach(() => {
  ORIGINAL_FLAG = process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  H.profile = null;
  H.error = null;
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = ORIGINAL_FLAG;
  }
});

describe("validateApiKey — entitlement gate", () => {
  it("admits a Pro-tier account (unchanged behaviour)", async () => {
    H.profile = PRO_PROFILE;

    const result = await validateApiKey(req("Bearer key-1"));

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect(result.profile.id).toBe("user-pro");
    }
  });

  it("admits an AcquisitionPRO member account (unchanged behaviour)", async () => {
    H.profile = ACQ_PRO_PROFILE;

    const result = await validateApiKey(req("Bearer key-2"));

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect(result.profile.id).toBe("user-acq-pro");
    }
  });

  it("admits a gateway-granted account when the Suite sign-in flag is 'true' (THE FIX)", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = GATEWAY_GRANTED_PROFILE;

    const result = await validateApiKey(req("Bearer key-3"));

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect(result.profile.id).toBe("user-gateway");
    }
  });

  it("refuses the SAME gateway-granted account with 403 when the flag is not 'true' (THE KILL-SWITCH)", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "false";
    H.profile = GATEWAY_GRANTED_PROFILE;

    const result = await validateApiKey(req("Bearer key-3"));

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.error).toBe(DENIED_BODY);
    }
  });

  it("refuses the same gateway-granted account with 403 when the flag is simply unset (KILL-SWITCH default)", async () => {
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    H.profile = GATEWAY_GRANTED_PROFILE;

    const result = await validateApiKey(req("Bearer key-3"));

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.response.status).toBe(403);
    }
  });

  it("refuses an account with no grant, not Pro, not AcquisitionPRO — 403 with today's exact wording", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = NO_ENTITLEMENT_PROFILE;

    const result = await validateApiKey(req("Bearer key-4"));

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body).toEqual({ success: false, error: DENIED_BODY });
    }
  });
});

describe("validateApiKey — key lookup", () => {
  it("refuses an unknown API key with 401", async () => {
    H.profile = null;
    H.error = { code: "PGRST116", message: "no rows" };

    const result = await validateApiKey(req("Bearer nonexistent-key"));

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body).toEqual({ success: false, error: "Invalid API key" });
    }
  });

  it("refuses a missing Authorization header with 401", async () => {
    const result = await validateApiKey(req(undefined));

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.response.status).toBe(401);
    }
  });

  it("refuses a malformed Authorization header (not 'Bearer ...') with 401", async () => {
    const result = await validateApiKey(req("Basic abc123"));

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns 500, not 401, on a Supabase error that is not PGRST116 (pinned existing behaviour)", async () => {
    H.profile = null;
    H.error = { code: "08006", message: "connection failure" };

    const result = await validateApiKey(req("Bearer key-5"));

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.response.status).toBe(500);
      const body = await result.response.json();
      expect(body).toEqual({ success: false, error: "Internal server error" });
    }
  });
});
