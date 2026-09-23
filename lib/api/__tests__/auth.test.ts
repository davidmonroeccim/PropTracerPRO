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
  lastUpdate: null as Record<string, unknown> | null,
  updateError: null as Error | null,
  // A DB-level write failure, e.g. a missing GRANT (42501): supabase-js RESOLVES the query with
  // this shape rather than rejecting (see lib/suite/access.ts persistSnapshot). Distinct from
  // `updateError` above, which models a rejection — a mode a real supabase-js query builder
  // cannot produce without `.throwOnError()`, which persistSnapshot does not chain.
  updateResolvedError: null as { code?: string; message?: string } | null,
}));

/**
 * POSTGREST COLUMN PROJECTION, EMULATED, for the user_profiles select in lib/api/auth.ts.
 *
 * A column the query never asked for does not come back, and a stub that ignores
 * `.select(...)` hides exactly that. `.select('*')` at lib/api/auth.ts:63 is what feeds
 * `effectiveIsPro()` the `gateway_products` column the whole gate fix depends on; if that
 * select is ever narrowed to a column list that drops `gateway_products`, the gate must
 * stop seeing the grant, and a test here must go red. Same pattern as
 * app/api/v1/trace/single/__tests__/route.test.ts.
 */
function projectRow(row: Record<string, unknown> | null, select: unknown): Record<string, unknown> | null {
  if (!row || typeof select !== "string" || select.trim() === "*") return row;
  const columns = new Set(select.split(",").map((c) => c.trim()));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (columns.has(key)) out[key] = value;
  }
  return out;
}

// fetchEntitlements: the gateway call made by refreshSuiteSnapshotBlocking (lib/suite/access.ts)
// when a v1 caller's snapshot is stale. Mocked at the module lib/suite/access.ts itself imports
// from (a relative "./entitlements" that resolves to the same file as this alias), same
// technique as lib/suite/__tests__/access.test.ts.
const fetchEntitlements = vi.fn();
vi.mock("@/lib/suite/entitlements", async (orig) => ({
  ...((await orig()) as object),
  fetchEntitlements,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "user_profiles") {
        return {
          select: (columns?: string) => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: projectRow(H.profile, columns), error: H.error }),
            }),
          }),
          // The snapshot persist made by refreshSuiteSnapshotBlocking on a successful refresh.
          update: (fields: Record<string, unknown>) => ({
            eq: () => {
              if (H.updateError) return Promise.reject(H.updateError);
              H.lastUpdate = fields;
              if (H.updateResolvedError) {
                return Promise.resolve({ data: null, error: H.updateResolvedError });
              }
              return Promise.resolve({ data: null, error: null });
            },
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
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ORIGINAL_FLAG = process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  H.profile = null;
  H.error = null;
  H.lastUpdate = null;
  H.updateError = null;
  H.updateResolvedError = null;
  fetchEntitlements.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = ORIGINAL_FLAG;
  }
  consoleErrorSpy.mockRestore();
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

/**
 * The v1 API is the ONLY surface that reads the gateway entitlement snapshot with nothing to
 * refresh it: no session, no dashboard render, so scheduleSuiteRefresh (app/(dashboard)/layout.tsx)
 * never runs for an API-key-only customer. Left alone, a revoked gateway grant would keep
 * admitting v1 calls forever. validateApiKey now runs a blocking, TTL-checked refresh
 * (lib/suite/access.ts refreshSuiteSnapshotBlocking) before gating, mirroring the MCP surface's
 * live-per-call resolution (lib/suite/mcp-auth.ts).
 */
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

const TTL_MINUTES = 30;

describe("validateApiKey — entitlement TTL refresh (v1 has no other refresher)", () => {
  it("a fresh snapshot (within TTL) makes no gateway call and admits as before", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-fresh",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-fresh",
      gateway_products: ["prop-tracer-pro"],
      gateway_products_checked_at: minutesAgo(1),
    };

    const result = await validateApiKey(req("Bearer key-fresh"));

    expect(isAuthError(result)).toBe(false);
    expect(fetchEntitlements).not.toHaveBeenCalled();
    expect(H.lastUpdate).toBeNull();
  });

  it("a stale snapshot whose refresh still returns the grant: admits, and the row is updated", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    const staleCheckedAt = minutesAgo(TTL_MINUTES + 1);
    H.profile = {
      id: "user-stale-still-granted",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-stale-1",
      gateway_products: ["prop-tracer-pro"],
      gateway_products_checked_at: staleCheckedAt,
    };
    fetchEntitlements.mockResolvedValue({ products: ["prop-tracer-pro"], expires_hint: null });

    const result = await validateApiKey(req("Bearer key-stale-1"));

    expect(isAuthError(result)).toBe(false);
    expect(fetchEntitlements).toHaveBeenCalledWith("gw-stale-1");
    expect(H.lastUpdate).toMatchObject({ gateway_products: ["prop-tracer-pro"] });
    // Not just gateway_products: the TTL clock itself must move forward on a successful
    // refresh, or every subsequent request re-fetches the gateway forever even though nothing
    // changed.
    const advancedCheckedAt = H.lastUpdate?.gateway_products_checked_at;
    expect(typeof advancedCheckedAt).toBe("string");
    expect(Date.parse(advancedCheckedAt as string)).toBeGreaterThan(Date.parse(staleCheckedAt));
  });

  it("an admitted refresh where the values differ from the stale row: the RETURNED profile carries the new value, not the stale one", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-stale-newly-granted",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-newly-granted",
      gateway_products: [], // stale row shows no grant yet
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };
    fetchEntitlements.mockResolvedValue({ products: ["prop-tracer-pro"], expires_hint: null });

    const result = await validateApiKey(req("Bearer key-newly-granted"));

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect((result.profile as unknown as { gateway_products: string[] }).gateway_products).toEqual([
        "prop-tracer-pro",
      ]);
    }
  });

  it("a stale snapshot whose refresh returns NO grant: refused 403, and the profile no longer carries the stale grant (THE FIX)", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-stale-revoked",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-stale-2",
      gateway_products: ["prop-tracer-pro"], // stale row still shows the (now-revoked) grant
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };
    fetchEntitlements.mockResolvedValue({ products: [], expires_hint: null });

    const result = await validateApiKey(req("Bearer key-stale-2"));

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.error).toBe(DENIED_BODY);
    }
    // The gate must decide on the REFRESHED value, and no downstream code may read a grant
    // that was just revoked — assert directly on the profile object the gate examined.
    expect(H.profile?.gateway_products).toEqual([]);
    expect(H.lastUpdate).toMatchObject({ gateway_products: [] });
  });

  it("a stale snapshot whose refresh THROWS: admitted on the last snapshot, nothing written, no exception escapes", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-stale-throws",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-stale-3",
      gateway_products: ["prop-tracer-pro"],
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };
    fetchEntitlements.mockRejectedValue(new Error("gateway timeout"));

    const result = await validateApiKey(req("Bearer key-stale-3"));

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect((result.profile as unknown as { gateway_products: string[] }).gateway_products).toEqual(["prop-tracer-pro"]);
    }
    expect(H.lastUpdate).toBeNull();
  });

  /**
   * FIX 1: the gateway has a documented habit of answering 200 with a malformed body. Both
   * shapes below parse fine but carry no usable `products` array, and must be treated as a
   * FAILURE (fail open on the last snapshot), never as an implicit revocation — a well-formed
   * `{ products: [] }` is the only shape allowed to actually revoke (covered above).
   */
  it("a stale snapshot whose refresh returns a 200 with {} (malformed body): admitted on the last snapshot, nothing persisted, logged", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-stale-empty-body",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-empty-body",
      gateway_products: ["prop-tracer-pro"],
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };
    fetchEntitlements.mockResolvedValue({});

    const result = await validateApiKey(req("Bearer key-empty-body"));

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect((result.profile as unknown as { gateway_products: string[] }).gateway_products).toEqual(["prop-tracer-pro"]);
    }
    expect(H.lastUpdate).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("a stale snapshot whose refresh returns { products: null }: admitted on the last snapshot, nothing persisted, logged", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-stale-null-products",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-null-products",
      gateway_products: ["prop-tracer-pro"],
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };
    fetchEntitlements.mockResolvedValue({ products: null, expires_hint: null });

    const result = await validateApiKey(req("Bearer key-null-products"));

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect((result.profile as unknown as { gateway_products: string[] }).gateway_products).toEqual(["prop-tracer-pro"]);
    }
    expect(H.lastUpdate).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("no gateway_sub: no gateway call", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-no-sub",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: null,
      gateway_products: ["prop-tracer-pro"],
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };

    const result = await validateApiKey(req("Bearer key-no-sub"));

    expect(isAuthError(result)).toBe(false);
    expect(fetchEntitlements).not.toHaveBeenCalled();
  });

  it("kill-switch off: no gateway call, and a gateway-granted caller still refused", async () => {
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    H.profile = {
      id: "user-killswitch",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-killswitch",
      gateway_products: ["prop-tracer-pro"],
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };

    const result = await validateApiKey(req("Bearer key-killswitch"));

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.response.status).toBe(403);
    }
    expect(fetchEntitlements).not.toHaveBeenCalled();
  });

  it("a pro-tier caller is unaffected, and no gateway call is needed to admit them", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-pro-with-stale-gateway",
      subscription_tier: "pro",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-pro",
      gateway_products: [],
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };

    const result = await validateApiKey(req("Bearer key-pro-stale"));

    expect(isAuthError(result)).toBe(false);
    expect(fetchEntitlements).not.toHaveBeenCalled();
  });

  it("an AcquisitionPRO caller is unaffected, and no gateway call is needed to admit them", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-acqpro-with-stale-gateway",
      subscription_tier: "wallet",
      is_acquisition_pro_member: true,
      gateway_sub: "gw-acqpro",
      gateway_products: [],
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };

    const result = await validateApiKey(req("Bearer key-acqpro-stale"));

    expect(isAuthError(result)).toBe(false);
    expect(fetchEntitlements).not.toHaveBeenCalled();
  });

  // Defensive: models persistSnapshot's write REJECTING outright. A real supabase-js query
  // builder without `.throwOnError()` cannot actually do this (see the resolved-error test
  // below for the mode production can produce) — kept because the only thing that can reject
  // here is createAdminClient() itself throwing (e.g. a missing env var), which this still
  // exercises end-to-end.
  it("the persist rejecting outright: request still succeeds", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-persist-fails",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-persist-fail",
      gateway_products: ["prop-tracer-pro"],
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };
    fetchEntitlements.mockResolvedValue({ products: ["prop-tracer-pro"], expires_hint: null });
    H.updateError = new Error("db write failed");

    const result = await validateApiKey(req("Bearer key-persist-fail"));

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect((result.profile as unknown as { gateway_products: string[] }).gateway_products).toEqual(["prop-tracer-pro"]);
    }
  });

  /**
   * FIX 2, the reachable mode: a supabase-js query without `.throwOnError()` never rejects for a
   * DB-level failure (e.g. the 42501 grant-class error this repo's CLAUDE.md documents at
   * length) — it RESOLVES with `{ error }`. Before Fix 2 that error was discarded with no log at
   * all, so a persistently failing write called the gateway forever with nothing to see it by.
   */
  it("the persist RESOLVING with { error } (the mode production can actually produce): request still succeeds AND the error is logged", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      id: "user-persist-resolves-error",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_sub: "gw-persist-resolved-error",
      gateway_products: ["prop-tracer-pro"],
      gateway_products_checked_at: minutesAgo(TTL_MINUTES + 1),
    };
    fetchEntitlements.mockResolvedValue({ products: ["prop-tracer-pro"], expires_hint: null });
    H.updateResolvedError = { code: "42501", message: "permission denied for table user_profiles" };

    const result = await validateApiKey(req("Bearer key-persist-resolved-error"));

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      // The gateway already answered, so the caller gates on that answer even though writing
      // it back failed.
      expect((result.profile as unknown as { gateway_products: string[] }).gateway_products).toEqual(["prop-tracer-pro"]);
    }
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
