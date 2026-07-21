# PropTracerPRO Track A — Suite Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Suite sign-in" to PropTracerPRO — one gateway (OIDC) login mints a genuine local PTP session, and a cohort/Suite/lifetime grant confers effective `pro` (pro features + the $0.07 trace rate) additively to PTP's own plan.

**Architecture:** Federation, not replacement (umbrella D1). New `/api/auth/suite/{start,callback}` routes redirect to the gateway IdP, verify the ID token (jose, ES256), link-or-create a local account by verified email, and mint an ordinary Supabase session via `admin.generateLink` → `verifyOtp`. Entitlements are snapshotted onto `user_profiles.gateway_products` and read by a single pure resolver `effectiveIsPro(profile)` that drives both the access gate and the trace price. Compute-never-write: `subscription_tier` is never touched.

**Tech Stack:** Next.js 16 (App Router, `npm`, TS strict, alias `@/*` → repo root, no `src/`), `@supabase/ssr` + `@supabase/supabase-js`, `jose` (new dep), `vitest` (new dep). Gateway IdP = Supabase project `ngqmcdefmlyjwgpjihch`.

## Global Constraints

- **Additive & flag-gated.** Everything is behind `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED` (must equal the exact string `"true"`; anything else = off). Rollback is flipping the env var, never a down-migration.
- **No user migration. No RLS policy created/altered/dropped. No FK changes. No billing/Stripe changes.**
- **Compute, never write.** The grant tier is never written to `subscription_tier` (Stripe-owned). It is computed at read time by `effectiveIsPro`.
- **The API-key / agent surface is Track B — do NOT modify it.** `lib/api/auth.ts` and every `app/api/v1/*` route (including their `getChargePerTrace` calls) stay exactly as they are.
- **The GHL iframe retirement + global `SameSite=Lax` cookie change is out of scope** (umbrella D8/§11, a separate later change). PTP's global `SameSite=None` session cookies are untouched; only the new Suite-flow cookies are `Lax`.
- **`redirect_uri` is the apex** `https://proptracerpro.com/api/auth/suite/callback` — `www.` 308-redirects to apex and would drop the PKCE cookies.
- **The snapshot write goes through `service_role`** (`createAdminClient()`), because the 2026-07-16 wallet lockdown column-scoped `user_profiles` UPDATE — `authenticated` cannot write `gateway_*`.
- **Apply migrations via** `supabase db query --linked --file <abs path>` from the PTP repo (migration-history drift makes `db push` unusable); verify with a `has_column_privilege` before/after check.
- **Mutation-fence every security test** (it must fail if the guard is deleted). PTP has zero tests today; this plan stands up vitest.
- **Nothing merged, nothing pushed, no prod env var set, no flag flipped without David's explicit go.** PTP `main` auto-deploys on push.
- **Reference implementation:** the already-canaried ScriptGeneratorPRO Track A (`ScriptGeneratorPRO` repo, branch `feature/sgp-suite-signin`). This plan adapts it; a reviewer can diff against those files.

---

## File Structure

**New files (all under repo root, `@/` alias):**
- `lib/suite/config.ts` — env + flag + `SUITE_PRODUCT`.
- `lib/suite/pkce.ts` — PKCE verifier/challenge + random tokens.
- `lib/suite/verify.ts` — jose JWKS/JWT verification → `SuiteClaims`.
- `lib/suite/entitlements.ts` — `hasSuiteAccess`, `isSnapshotStale`, `fetchEntitlements`, **`effectiveIsPro`** (the PTP binary resolver).
- `lib/suite/pricing.ts` — `chargePerTrace(profile)` (grant-aware, Track-A session/cron only).
- `lib/suite/access.ts` — `scheduleSuiteRefresh` / `refreshSuiteSnapshot` (30-min TTL, service_role write).
- `lib/suite/link.ts` — `decideLink` (pure) + `resolveSuiteUser` (link-or-create).
- `lib/suite/session.ts` — `exchangeCode` + `mintLocalSession` (stranding-safe).
- `lib/suite/alert.ts` — `alertSuite`.
- `lib/suite/login-errors.ts` — fixed `suite_error` copy map.
- `app/api/auth/suite/start/route.ts`, `app/api/auth/suite/callback/route.ts`.
- `supabase/migrations/<ts>_suite_signin.sql`.
- `vitest.config.ts` + `lib/suite/__tests__/*.test.ts`.

**Modified (minimal):**
- `app/(auth)/login/page.tsx` — flag-gated "Sign in with Suite" button + `suite_error` message.
- `lib/supabase/middleware.ts` — add the two suite routes to `publicRoutes` (`:46`).
- `app/(dashboard)/layout.tsx` — schedule the TTL refresh for gateway-linked users (single wiring point).
- 5 access-predicate sites → `effectiveIsPro(profile)`.
- Session-side trace routes (`app/api/trace/*`), the 3 crons (`app/api/cron/sweep-*`), and 4 display pages → `chargePerTrace(profile)`. **`app/api/v1/*` untouched.**
- `package.json` (+ `jose`, `+ vitest`, `+ test` scripts), `.env.example`.

---

## Task 0: Gateway prerequisites (suite-gateway repo, operational)

**Files:** none in PTP. Work in `/Users/davidmonroe/suite-gateway`.

**Interfaces:**
- Produces: `SUITE_CLIENT_ID`, `SUITE_CLIENT_SECRET`, `SUITE_GATEWAY_API_KEY`, and the confirmed `SUITE_PRODUCT` slug — consumed by every later task's `.env.local`.

- [ ] **Step 1:** Register PTP's confidential OAuth client in the gateway IdP with redirect_uris **exactly** `https://proptracerpro.com/api/auth/suite/callback` and `http://localhost:3000/api/auth/suite/callback`, `token_endpoint_auth_method = client_secret_post`. Record the client id + secret. (Mirror how Maturr/SGP clients were registered; see `suite-gateway/.superpowers/sdd/progress.md`.)
- [ ] **Step 2:** Mint a gateway `api_keys` row scoped to PTP's product; record the key.
- [ ] **Step 3:** Add PTP's client id to the gateway's `NEXT_PUBLIC_TRUSTED_CLIENT_IDS` (Production + Development) for consent auto-approve; redeploy the gateway.
- [ ] **Step 4: Confirm the product slug.** Inspect the gateway's `resolveProducts()` / `grants` data (or call `GET {gateway}/api/v1/entitlements?user=<a real PTP grant-holder>` with the new key) and confirm the exact string for PropTracerPRO. Expected `prop-tracer-pro`. **This exact string becomes `SUITE_PRODUCT` in Task 3.**

Run: `curl -s -H "x-api-key: <key>" "https://suite-gateway.vercel.app/api/v1/entitlements?user=<gateway_sub>"`
Expected: `{ "products": [...], "expires_hint": ... }` — note the PTP slug in `products`.

---

## Task 1: Stand up vitest + jose

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Test: `lib/suite/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` runs vitest in the node environment with the `@` → repo-root alias.

- [ ] **Step 1: Add deps.** `npm install --save-exact jose@6.2.3 && npm install --save-dev --save-exact vitest@4.1.10`
- [ ] **Step 2: Create `vitest.config.ts`:**

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
```

- [ ] **Step 3: Add scripts** to `package.json` (after `"type-check": "tsc --noEmit"`):

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Write the smoke test** `lib/suite/__tests__/smoke.test.ts`:

```ts
import { expect, test } from "vitest";
test("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 5: Run.** `npm test` — Expected: 1 passing.
- [ ] **Step 6: Commit.** `git add vitest.config.ts package.json package-lock.json lib/suite/__tests__/smoke.test.ts && git commit -m "chore(suite): stand up vitest + jose for Track A"`

---

## Task 2: Migration — additive gateway columns

**Files:**
- Create: `supabase/migrations/<YYYYMMDDHHMMSS>_suite_signin.sql`

**Interfaces:**
- Produces: `user_profiles.gateway_sub text unique(partial)`, `gateway_products text[] not null default '{}'`, `gateway_products_checked_at timestamptz` — read by the resolver, written by service_role.

- [ ] **Step 1: Capture the before-state grant matrix** (prove `authenticated` cannot already write and can read the table). Run via `supabase db query --linked`:

```sql
select has_table_privilege('authenticated','public.user_profiles','SELECT') as auth_select,
       has_table_privilege('authenticated','public.user_profiles','UPDATE') as auth_update_tablewide;
```
Expected: `auth_select = true`, `auth_update_tablewide = false` (table-wide UPDATE was revoked by the wallet lockdown; only specific columns are granted).

- [ ] **Step 2: Write the migration file:**

```sql
-- Suite sign-in: federate identity to the Suite Gateway IdP.
-- ADDITIVE ONLY. No RLS policy created/altered/dropped. No FK changes.
-- Rollback is the NEXT_PUBLIC_SUITE_SIGNIN_ENABLED flag, not a down-migration.
--
-- GRANTS: user_profiles was column-locked on 2026-07-16 (REVOKE UPDATE/INSERT/DELETE
-- FROM authenticated,anon; GRANT UPDATE(<7 wallet/profile cols>)). Table-level SELECT
-- to authenticated was NOT revoked, so the new columns are readable by the browser
-- session client. The new gateway_* columns are deliberately NOT added to the
-- authenticated UPDATE grant: only service_role writes them (the snapshot path).

alter table public.user_profiles
  add column if not exists gateway_sub text,
  add column if not exists gateway_products text[] not null default '{}',
  add column if not exists gateway_products_checked_at timestamptz;

-- One gateway identity maps to at most one PTP account: makes the "refuse on conflict"
-- linking rule enforceable at the database level.
create unique index if not exists user_profiles_gateway_sub_key
  on public.user_profiles (gateway_sub)
  where gateway_sub is not null;

-- The email lookup fails closed on a multi-row result; a case-variant duplicate would
-- lock that address out of Suite sign-in. GoTrue lowercases auth.users.email and the
-- handle_new_user trigger copies it verbatim, so this enforces an invariant that already holds.
create unique index if not exists user_profiles_email_lower_key
  on public.user_profiles (lower(email))
  where email is not null;

comment on column public.user_profiles.gateway_sub is
  'Suite Gateway auth.users.id. Authoritative for identity after first link.';
```

- [ ] **Step 3: Apply.** `supabase db query --linked --file supabase/migrations/<file>.sql`
- [ ] **Step 4: Verify after-state.** Run via `supabase db query --linked`:

```sql
select has_column_privilege('authenticated','public.user_profiles','gateway_products','SELECT') as auth_can_read,
       has_column_privilege('authenticated','public.user_profiles','gateway_products','UPDATE') as auth_can_write,
       has_column_privilege('service_role','public.user_profiles','gateway_products','UPDATE') as svc_can_write;
```
Expected: `auth_can_read = true`, `auth_can_write = false`, `svc_can_write = true`. **If `auth_can_read` is false**, the wallet lockdown also column-scoped SELECT — STOP and add `GRANT SELECT (gateway_sub, gateway_products, gateway_products_checked_at) ON public.user_profiles TO authenticated;` to the migration, re-apply, re-verify.
- [ ] **Step 5: Commit.** `git add supabase/migrations/<file>.sql && git commit -m "feat(suite): additive gateway_* columns on user_profiles"`

---

## Task 3: Config, PKCE, env

**Files:**
- Create: `lib/suite/config.ts`, `lib/suite/pkce.ts`
- Modify: `.env.example`
- Test: `lib/suite/__tests__/config.test.ts`

**Interfaces:**
- Produces: `SUITE_PRODUCT`, `isSuiteSignInEnabled()`, `suiteConfig(): SuiteConfig`; `newVerifier()`, `challengeFor(v)`, `randomToken()`.

- [ ] **Step 1: Write the failing test** `lib/suite/__tests__/config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isSuiteSignInEnabled, suiteConfig } from "@/lib/suite/config";

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; vi.restoreAllMocks(); });

describe("isSuiteSignInEnabled", () => {
  test("only the exact string 'true' enables", () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    expect(isSuiteSignInEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "TRUE";
    expect(isSuiteSignInEnabled()).toBe(false);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    expect(isSuiteSignInEnabled()).toBe(false);
  });
});

describe("suiteConfig", () => {
  test("throws loudly when a var is missing", () => {
    delete process.env.SUITE_ISSUER;
    expect(() => suiteConfig()).toThrow(/misconfigured: issuer/);
  });
  test("returns all six when set", () => {
    Object.assign(process.env, {
      SUITE_ISSUER: "i", SUITE_CLIENT_ID: "c", SUITE_CLIENT_SECRET: "s",
      SUITE_GATEWAY_API_KEY: "k", SUITE_GATEWAY_URL: "u",
      SUITE_REDIRECT_URI: "r",
    });
    expect(suiteConfig()).toEqual({
      issuer: "i", clientId: "c", clientSecret: "s",
      gatewayApiKey: "k", gatewayUrl: "u", redirectUri: "r",
    });
  });
});
```

- [ ] **Step 2: Run — Expected FAIL** (module not found). `npm test -- config`
- [ ] **Step 3: Write `lib/suite/config.ts`:**

```ts
/**
 * Suite sign-in: PropTracerPRO federates identity to the Suite Gateway's Supabase (an OIDC
 * provider). This is NOT an enterprise "bring your own IdP" feature — different thing.
 */

/** PTP's product name in the gateway's grants table. CONFIRMED in Task 0 (expected 'prop-tracer-pro'). */
export const SUITE_PRODUCT = "prop-tracer-pro";

/** Feature flag. Rollback is flipping this to anything but "true". */
export function isSuiteSignInEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED === "true";
}

export interface SuiteConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  gatewayApiKey: string;
  gatewayUrl: string;
  redirectUri: string;
}

/** Server-only. Throws if misconfigured so a broken deploy fails loudly, not silently. */
export function suiteConfig(): SuiteConfig {
  const required = {
    issuer: process.env.SUITE_ISSUER,
    clientId: process.env.SUITE_CLIENT_ID,
    clientSecret: process.env.SUITE_CLIENT_SECRET,
    gatewayApiKey: process.env.SUITE_GATEWAY_API_KEY,
    gatewayUrl: process.env.SUITE_GATEWAY_URL,
    redirectUri: process.env.SUITE_REDIRECT_URI,
  };
  for (const [k, v] of Object.entries(required)) {
    if (!v) throw new Error(`Suite sign-in is misconfigured: ${k} is not set.`);
  }
  return required as SuiteConfig;
}
```

- [ ] **Step 4: Write `lib/suite/pkce.ts`:**

```ts
import { createHash, randomBytes } from "node:crypto";

export function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
export function randomToken(): string {
  return randomBytes(16).toString("base64url");
}
```

- [ ] **Step 5: Append to `.env.example`:**

```
# ============================================================
# Suite sign-in (Track A): federated login via the Suite Gateway OIDC IdP.
# Additive to the wallet/plan (local pro OR AcquisitionPRO tag OR a gateway grant). Flag OFF until enabled.
# ============================================================
NEXT_PUBLIC_SUITE_SIGNIN_ENABLED=false
SUITE_ISSUER=https://ngqmcdefmlyjwgpjihch.supabase.co/auth/v1
SUITE_GATEWAY_URL=https://suite-gateway.vercel.app
SUITE_REDIRECT_URI=http://localhost:3000/api/auth/suite/callback   # prod: https://proptracerpro.com/api/auth/suite/callback
SUITE_CLIENT_ID=...          # from gateway OAuth client registration (Task 0)
SUITE_CLIENT_SECRET=...      # confidential; from gateway OAuth client registration (Task 0)
SUITE_GATEWAY_API_KEY=...    # gateway api_keys row; used by /api/v1/entitlements (Task 0)
```

- [ ] **Step 6: Run — Expected PASS.** `npm test -- config`
- [ ] **Step 7: Commit.** `git add lib/suite/config.ts lib/suite/pkce.ts lib/suite/__tests__/config.test.ts .env.example && git commit -m "feat(suite): config, flag, PKCE helpers"`

---

## Task 4: ID-token verification (jose)

**Files:**
- Create: `lib/suite/verify.ts`
- Test: `lib/suite/__tests__/verify.test.ts`

**Interfaces:**
- Consumes: `suiteConfig()`.
- Produces: `SuiteClaims { sub: string; email: string; emailVerified: boolean }`; `verifyIdToken(idToken, expectedNonce, keyResolver?)`.

- [ ] **Step 1: Write the failing test** `lib/suite/__tests__/verify.test.ts` (signs tokens locally; `keyResolver` is injectable):

```ts
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { verifyIdToken } from "@/lib/suite/verify";

const ISSUER = "https://gw.example/auth/v1";
const CLIENT = "ptp-client";

beforeEach(() => {
  Object.assign(process.env, { SUITE_ISSUER: ISSUER, SUITE_CLIENT_ID: CLIENT,
    SUITE_CLIENT_SECRET: "s", SUITE_GATEWAY_API_KEY: "k", SUITE_GATEWAY_URL: "u", SUITE_REDIRECT_URI: "r" });
});
afterEach(() => vi.restoreAllMocks());

async function make(alg: string, claims: Record<string, unknown>) {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  const jwt = await new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setIssuer(ISSUER).setAudience(CLIENT).setExpirationTime("5m").sign(privateKey);
  const jwk = await exportJWK(publicKey);
  const resolver = async () => ({ ...jwk, alg } as any);
  return { jwt, resolver };
}

test("accepts a valid ES256 token and lowercases email", async () => {
  const { jwt, resolver } = await make("ES256",
    { sub: "S1", email: "Alice@Corp.com", email_verified: true, nonce: "N" });
  await expect(verifyIdToken(jwt, "N", resolver)).resolves.toEqual(
    { sub: "S1", email: "alice@corp.com", emailVerified: true });
});

test("rejects a non-ES256 algorithm (alg-substitution defense)", async () => {
  const { jwt, resolver } = await make("RS256",
    { sub: "S1", email: "a@c.com", email_verified: true, nonce: "N" });
  await expect(verifyIdToken(jwt, "N", resolver)).rejects.toThrow();
});

test("rejects on nonce mismatch", async () => {
  const { jwt, resolver } = await make("ES256",
    { sub: "S1", email: "a@c.com", email_verified: true, nonce: "N" });
  await expect(verifyIdToken(jwt, "WRONG", resolver)).rejects.toThrow(/nonce/);
});

test("reports emailVerified=false when the claim is not exactly true", async () => {
  const { jwt, resolver } = await make("ES256",
    { sub: "S1", email: "a@c.com", email_verified: "true", nonce: "N" });
  const claims = await verifyIdToken(jwt, "N", resolver);
  expect(claims.emailVerified).toBe(false);
});
```

- [ ] **Step 2: Run — Expected FAIL.** `npm test -- verify`
- [ ] **Step 3: Write `lib/suite/verify.ts`:**

```ts
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { suiteConfig } from "./config";

export interface SuiteClaims {
  sub: string;
  email: string;
  /** Reported, not enforced here. link.ts's decideLink refuses on false. */
  emailVerified: boolean;
}

let cachedJwks: JWTVerifyGetKey | undefined;
function jwks(): JWTVerifyGetKey {
  const { issuer } = suiteConfig();
  cachedJwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return cachedJwks;
}

/** Verify a gateway ID token: signature (JWKS), iss, aud, exp, ES256 allowlist, nonce. */
export async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
  keyResolver: JWTVerifyGetKey = jwks(),
): Promise<SuiteClaims> {
  const { issuer, clientId } = suiteConfig();

  const { payload } = await jwtVerify(idToken, keyResolver, {
    issuer,
    audience: clientId,
    algorithms: ["ES256"],
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error("Suite sign-in: nonce mismatch. The sign-in request could not be verified.");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Suite sign-in: the ID token has no subject.");
  }
  if (typeof payload.email !== "string" || !payload.email) {
    throw new Error("Suite sign-in: the ID token has no email.");
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
  };
}
```

- [ ] **Step 4: Run — Expected PASS.** `npm test -- verify`
- [ ] **Step 5: Mutation-fence check.** Temporarily change `algorithms: ["ES256"]` to `["ES256","RS256"]`; run `npm test -- verify`; the RS256 test must go RED. Revert.
- [ ] **Step 6: Commit.** `git add lib/suite/verify.ts lib/suite/__tests__/verify.test.ts && git commit -m "feat(suite): ID-token verification (jose, ES256)"`

---

## Task 5: Alert + login-error copy

**Files:**
- Create: `lib/suite/alert.ts`, `lib/suite/login-errors.ts`
- Test: `lib/suite/__tests__/login-errors.test.ts`

**Interfaces:**
- Produces: `alertSuite(kind, reason, context?)`; `suiteErrorMessage(code): string | null`, `SUITE_ERROR_MESSAGES`, `SUITE_ERROR_FALLBACK`.

- [ ] **Step 1: Write the failing test** `lib/suite/__tests__/login-errors.test.ts`:

```ts
import { expect, test } from "vitest";
import { SUITE_ERROR_FALLBACK, suiteErrorMessage } from "@/lib/suite/login-errors";

test("known codes map to fixed copy", () => {
  expect(suiteErrorMessage("unverified_email")).toMatch(/email/i);
});
test("null code -> null (nothing to show)", () => {
  expect(suiteErrorMessage(null)).toBeNull();
});
test("unknown code -> fixed fallback, never the raw code (anti-phishing)", () => {
  expect(suiteErrorMessage("<script>")).toBe(SUITE_ERROR_FALLBACK);
});
```

- [ ] **Step 2: Run — Expected FAIL.** `npm test -- login-errors`
- [ ] **Step 3: Write `lib/suite/alert.ts`:**

```ts
/**
 * PTP has no Sentry. This is the structured alert channel the suite modules call on every
 * refusal, operational failure, or self-heal (one tagged console.error, greppable in Vercel logs).
 *
 * PROD-ENABLE PREREQUISITE: wire to a real channel before flipping the flag on in production.
 * context carries opaque ids only (gateway sub, user id, error code) — never email/token/secret.
 */
export function alertSuite(kind: string, reason: string, context: Record<string, string> = {}): void {
  console.error("[suite-signin][ALERT]", { kind, reason, ...context });
}
```

- [ ] **Step 4: Write `lib/suite/login-errors.ts`:**

```ts
/**
 * Fixed, developer-authored copy for every code the Suite callback can emit. The URL carries only
 * an opaque code, never prose, so this object alone decides what a visitor sees. Never widen this
 * to fall back on the raw query param: that recreates the phishing hole it exists to close.
 */
export const SUITE_ERROR_MESSAGES: Record<string, string> = {
  invalid_request: "This sign-in request could not be verified. Please try again below.",
  cancelled: "Sign-in was cancelled. You can try again, or sign in with your email below.",
  unverified_email:
    "We could not confirm your email address for Suite sign-in. Please sign in with your email below.",
  already_linked:
    "This account is already linked to a different Suite sign-in identity. Please sign in with your email below.",
  refused: "We could not complete Suite sign-in for this account. Please sign in with your email below.",
  failed: "Suite sign-in failed. You can still sign in with your email below.",
};

export const SUITE_ERROR_FALLBACK =
  "Suite sign-in did not go through. You can still sign in with your email below.";

export function suiteErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return SUITE_ERROR_MESSAGES[code] ?? SUITE_ERROR_FALLBACK;
}
```

- [ ] **Step 5: Run — Expected PASS.** `npm test -- login-errors`
- [ ] **Step 6: Commit.** `git add lib/suite/alert.ts lib/suite/login-errors.ts lib/suite/__tests__/login-errors.test.ts && git commit -m "feat(suite): alert channel + fixed login-error copy"`

---

## Task 6: Entitlement resolver + grant-aware pricing (PTP core)

**Files:**
- Create: `lib/suite/entitlements.ts`, `lib/suite/pricing.ts`
- Test: `lib/suite/__tests__/entitlements.test.ts`, `lib/suite/__tests__/pricing.test.ts`

**Interfaces:**
- Consumes: `SUITE_PRODUCT`, `suiteConfig()`, `PRICING` (from `@/lib/constants`).
- Produces: `EntitlementProfile`, `hasSuiteAccess(p)`, `isSnapshotStale(checkedAt, now?)`, `fetchEntitlements(gatewaySub)`, **`effectiveIsPro(p): boolean`**; `chargePerTrace(p): number`.

- [ ] **Step 1: Write the failing tests** `lib/suite/__tests__/entitlements.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { effectiveIsPro, hasSuiteAccess, isSnapshotStale } from "@/lib/suite/entitlements";

describe("effectiveIsPro (binary, additive OR — never downgrades)", () => {
  const base = { subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: [] as string[] };
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
    expect(effectiveIsPro({ subscription_tier: null, is_acquisition_pro_member: null, gateway_products: null })).toBe(false);
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
```

`lib/suite/__tests__/pricing.test.ts`:

```ts
import { expect, test } from "vitest";
import { PRICING } from "@/lib/constants";
import { chargePerTrace } from "@/lib/suite/pricing";

test("grant-holder is charged the pro rate", () => {
  expect(chargePerTrace({ subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"] }))
    .toBe(PRICING.CHARGE_PER_SUCCESS);
});
test("no entitlement is charged the wallet rate", () => {
  expect(chargePerTrace({ subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: [] }))
    .toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
});
```

- [ ] **Step 2: Run — Expected FAIL.** `npm test -- entitlements pricing`
- [ ] **Step 3: Write `lib/suite/entitlements.ts`:**

```ts
import { SUITE_PRODUCT, suiteConfig } from "./config";

const TTL_MS = 30 * 60 * 1000;

export interface EntitlementProfile {
  subscription_tier?: string | null;
  is_acquisition_pro_member?: boolean | null;
  gateway_sub?: string | null;
  gateway_products?: string[] | null;
  gateway_products_checked_at?: string | null;
}

/** Does the gateway grant this user PTP? Additive: the caller ORs it with local pro. */
export function hasSuiteAccess(p: EntitlementProfile): boolean {
  return (p.gateway_products ?? []).includes(SUITE_PRODUCT);
}

export function isSnapshotStale(checkedAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!checkedAt) return true;
  return now.getTime() - Date.parse(checkedAt) > TTL_MS;
}

/** Ask the gateway what this user is entitled to. Throws on failure; callers degrade, never lock out. */
export async function fetchEntitlements(
  gatewaySub: string,
): Promise<{ products: string[]; expires_hint: string | null }> {
  const { gatewayUrl, gatewayApiKey } = suiteConfig();
  const url = new URL("/api/v1/entitlements", gatewayUrl);
  url.searchParams.set("user", gatewaySub);
  const res = await fetch(url, {
    headers: { "x-api-key": gatewayApiKey },
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`entitlements lookup failed (${res.status})`);
  return (await res.json()) as { products: string[]; expires_hint: string | null };
}

/**
 * PTP effective pro: a single, binary, ADDITIVE rule. Pro if the local tier is pro, OR the
 * AcquisitionPRO (GoHighLevel) tag is set, OR a gateway grant covers PTP. Never downgrades
 * (a native pro stays pro). Computed at read time; subscription_tier is never written.
 */
export function effectiveIsPro(p: EntitlementProfile): boolean {
  return p.subscription_tier === "pro"
    || p.is_acquisition_pro_member === true
    || hasSuiteAccess(p);
}
```

- [ ] **Step 4: Write `lib/suite/pricing.ts`:**

```ts
import { PRICING } from "@/lib/constants";
import { effectiveIsPro, type EntitlementProfile } from "./entitlements";

/**
 * Per-successful-trace charge for a SESSION-side or cron flow, grant-aware.
 * Track A only: the /api/v1/* API-key surface keeps the raw getChargePerTrace (that is Track B).
 * A grant can only LOWER the rate ($0.11 -> $0.07); it can never mint money (the wallet balance
 * gate still 402s at $0), so this is safe.
 */
export function chargePerTrace(profile: EntitlementProfile): number {
  return effectiveIsPro(profile) ? PRICING.CHARGE_PER_SUCCESS : PRICING.CHARGE_PER_SUCCESS_WALLET;
}
```

- [ ] **Step 5: Run — Expected PASS.** `npm test -- entitlements pricing`
- [ ] **Step 6: Mutation-fence check.** Delete the `|| hasSuiteAccess(p)` term; the "gateway grant -> true" and grant-pricing tests must go RED. Revert.
- [ ] **Step 7: Commit.** `git add lib/suite/entitlements.ts lib/suite/pricing.ts lib/suite/__tests__/entitlements.test.ts lib/suite/__tests__/pricing.test.ts && git commit -m "feat(suite): effectiveIsPro resolver + grant-aware chargePerTrace"`

---

## Task 7: Identity linking

**Files:**
- Create: `lib/suite/link.ts`
- Test: `lib/suite/__tests__/link.test.ts`

**Interfaces:**
- Consumes: `createAdminClient()` (`@/lib/supabase/admin`), `alertSuite`, `SuiteClaims`.
- Produces: `decideLink(claims, bySub, byEmail): LinkDecision` (pure); `resolveSuiteUser(claims): Promise<SuiteIdentity>`; `SuiteLinkError`, `EMAIL_NOT_VERIFIED_REASON`, `ALREADY_LINKED_ELSEWHERE`, `SuiteIdentity { userId; email }`.

- [ ] **Step 1: Write the failing test** `lib/suite/__tests__/link.test.ts` (the pure rule — every branch, mutation-fenced):

```ts
import { describe, expect, test } from "vitest";
import { ALREADY_LINKED_ELSEWHERE, decideLink, EMAIL_NOT_VERIFIED_REASON } from "@/lib/suite/link";

const claims = (over = {}) => ({ sub: "S1", email: "a@c.com", emailVerified: true, ...over });
const prof = (over = {}) => ({ id: "U1", gateway_sub: null as string | null, email: "a@c.com", ...over });

describe("decideLink", () => {
  test("unverified email -> refuse", () => {
    expect(decideLink(claims({ emailVerified: false }), null, null))
      .toEqual({ action: "refuse", reason: EMAIL_NOT_VERIFIED_REASON });
  });
  test("match by sub -> use (authoritative, ignores email)", () => {
    expect(decideLink(claims(), prof({ id: "U9", gateway_sub: "S1", email: "old@c.com" }), null))
      .toEqual({ action: "use", userId: "U9", email: "old@c.com" });
  });
  test("email match, no sub yet -> link", () => {
    expect(decideLink(claims(), null, prof()))
      .toEqual({ action: "link", userId: "U1", email: "a@c.com" });
  });
  test("email match with a DIFFERENT sub -> refuse (never re-point)", () => {
    expect(decideLink(claims(), null, prof({ gateway_sub: "OTHER" })))
      .toEqual({ action: "refuse", reason: ALREADY_LINKED_ELSEWHERE });
  });
  test("no match -> create", () => {
    expect(decideLink(claims(), null, null)).toEqual({ action: "create" });
  });
});
```

- [ ] **Step 2: Run — Expected FAIL.** `npm test -- link`
- [ ] **Step 3: Write `lib/suite/link.ts`** (adapted from the SGP reference; table is `user_profiles`; the `handle_new_user` trigger inserts `(id, email)` at `subscription_tier` default `'wallet'`, so a created account is a free wallet account):

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { alertSuite } from "./alert";
import type { SuiteClaims } from "./verify";

export interface MatchedProfile {
  id: string;
  gateway_sub: string | null;
  email: string;
}

/** The PTP account gateway claims resolved to. `email` is the RESOLVED ACCOUNT's own email,
 *  never claims.email (they diverge when a linked user changes their gateway email). */
export interface SuiteIdentity {
  userId: string;
  email: string;
}

export type LinkDecision =
  | { action: "use"; userId: string; email: string }
  | { action: "link"; userId: string; email: string }
  | { action: "create" }
  | { action: "refuse"; reason: string };

export const ALREADY_LINKED_ELSEWHERE =
  "This PropTracerPRO account is already linked to a different Suite Gateway identity.";
const LOOKUP_FAILED = "Could not verify your PropTracerPRO account right now. Please try again.";
export const EMAIL_NOT_VERIFIED_REASON =
  "The Suite Gateway did not confirm this email address as verified.";

/**
 * The linking rule. Pure, so every branch is testable.
 * 1. email_verified must be exactly true, or refuse.
 * 2. gateway_sub is authoritative once set (a changed gateway email never re-links elsewhere).
 * 3. An email matching an account already claimed by a different gateway_sub is refused (takeover).
 * Every non-refusing decision carries the MATCHED ACCOUNT's email, not the claim's.
 */
export function decideLink(
  claims: SuiteClaims,
  bySub: MatchedProfile | null,
  byEmail: MatchedProfile | null,
): LinkDecision {
  if (!claims.emailVerified) return { action: "refuse", reason: EMAIL_NOT_VERIFIED_REASON };
  if (bySub) return { action: "use", userId: bySub.id, email: bySub.email };
  if (byEmail) {
    if (byEmail.gateway_sub && byEmail.gateway_sub !== claims.sub) {
      return { action: "refuse", reason: ALREADY_LINKED_ELSEWHERE };
    }
    return { action: "link", userId: byEmail.id, email: byEmail.email };
  }
  return { action: "create" };
}

export class SuiteLinkError extends Error {
  constructor(reason: string) { super(reason); this.name = "SuiteLinkError"; }
}

function deny(kind: "refused" | "failed", reason: string, context: Record<string, string>): never {
  console.error(`[suite-signin] ${kind}:`, reason, context);
  alertSuite(kind, reason, context);
  throw new SuiteLinkError(reason);
}
function refuse(reason: string, context: Record<string, string>): never { deny("refused", reason, context); }
function fail(reason: string, context: Record<string, string>): never { deny("failed", reason, context); }

/** Resolve verified gateway claims to a PTP account, linking or creating as needed.
 *  Returns the RESOLVED ACCOUNT's identity; callers must mint from THAT, never claims.email. */
export async function resolveSuiteUser(claims: SuiteClaims): Promise<SuiteIdentity> {
  const admin = createAdminClient();

  const { data: bySub, error: bySubErr } = await admin
    .from("user_profiles").select("id, gateway_sub, email")
    .eq("gateway_sub", claims.sub).maybeSingle();
  if (bySubErr) fail(LOOKUP_FAILED, { sub: claims.sub, lookup: "sub", code: bySubErr.code });

  // Exact match, and it MUST stay exact (both sides already lowercase). NEVER .ilike(): PostgREST
  // passes the value straight into a SQL LIKE pattern, so `_`/`%` in an attacker's gateway email
  // become wildcards -> a verified john_doe@corp.com matches victim john.doe@corp.com = takeover.
  const { data: byEmail, error: byEmailErr } = await admin
    .from("user_profiles").select("id, gateway_sub, email")
    .eq("email", claims.email).maybeSingle();
  if (byEmailErr) fail(LOOKUP_FAILED, { sub: claims.sub, lookup: "email", code: byEmailErr.code });

  const decision = decideLink(claims, bySub as MatchedProfile | null, byEmail as MatchedProfile | null);

  switch (decision.action) {
    case "refuse":
      return refuse(decision.reason, { sub: claims.sub });
    case "use":
      return { userId: decision.userId, email: decision.email };
    case "link": {
      const { data: linked, error } = await (admin.from("user_profiles") as any)
        .update({ gateway_sub: claims.sub }).eq("id", decision.userId)
        .is("gateway_sub", null).select("id");
      if (error) fail("Could not link this account. Please try again.",
        { sub: claims.sub, userId: decision.userId, code: error.code });
      if (!linked?.length) {
        const { data: current, error: rereadErr } = await (admin.from("user_profiles") as any)
          .select("gateway_sub").eq("id", decision.userId).maybeSingle();
        if (rereadErr) fail(LOOKUP_FAILED,
          { sub: claims.sub, userId: decision.userId, lookup: "race-reread", code: rereadErr.code });
        if (current?.gateway_sub !== claims.sub)
          refuse(ALREADY_LINKED_ELSEWHERE, { sub: claims.sub, userId: decision.userId });
      }
      return { userId: decision.userId, email: decision.email };
    }
    case "create": {
      const { data: created, error } = await admin.auth.admin.createUser({
        email: claims.email, email_confirm: true, // the gateway already proved they control it
      });
      if (error || !created.user) fail("Could not create your PropTracerPRO account. Please try again.",
        { sub: claims.sub, code: error?.code ?? "no_user_returned" });

      // handle_new_user() should have made the (wallet-tier) profile row. Confirm the pin landed.
      const { data: pinned, error: linkErr } = await (admin.from("user_profiles") as any)
        .update({ gateway_sub: claims.sub }).eq("id", created!.user!.id).select("id");
      if (linkErr) fail("Could not link your new account. Please try again.",
        { sub: claims.sub, userId: created!.user!.id, code: linkErr.code });

      // Zero rows means the trigger silently failed; heal it rather than strand a confirmed
      // auth.users row (the retry would find the email taken and lock the user out forever).
      if (!pinned?.length) {
        const { error: healErr } = await (admin.from("user_profiles") as any).upsert(
          { id: created!.user!.id, email: claims.email, gateway_sub: claims.sub }, { onConflict: "id" });
        if (healErr) fail("Could not finish setting up your PropTracerPRO account. Please try again.",
          { sub: claims.sub, userId: created!.user!.id, code: healErr.code, healed: "false" });
        alertSuite("trigger_missed", "profile trigger missed, row healed in app",
          { userId: created!.user!.id, sub: claims.sub });
      }
      return { userId: created!.user!.id, email: claims.email };
    }
  }
}
```

- [ ] **Step 4: Run — Expected PASS.** `npm test -- link`
- [ ] **Step 5: Mutation-fence check.** In `decideLink`, change `byEmail.gateway_sub !== claims.sub` to `=== `; the "different sub -> refuse" test must go RED. Revert.
- [ ] **Step 6: Commit.** `git add lib/suite/link.ts lib/suite/__tests__/link.test.ts && git commit -m "feat(suite): identity linking rule + resolveSuiteUser"`

---

## Task 8: Session minting

**Files:**
- Create: `lib/suite/session.ts`
- Test: `lib/suite/__tests__/session.test.ts`

**Interfaces:**
- Consumes: `createAdminClient()`, `createClient()` (`@/lib/supabase/server`), `suiteConfig()`, `SuiteIdentity`.
- Produces: `exchangeCode(code, verifier): Promise<string>` (returns id_token); `mintLocalSession(identity): Promise<void>`.

- [ ] **Step 1: Write the failing test** `lib/suite/__tests__/session.test.ts` (verifies the stranding-safe property: it mints for the account's OWN email fetched by id, never the passed identity email):

```ts
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
```

- [ ] **Step 2: Run — Expected FAIL.** `npm test -- session`
- [ ] **Step 3: Write `lib/suite/session.ts`:**

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { suiteConfig } from "./config";
import type { SuiteIdentity } from "./link";

/** Exchange the authorization code for tokens. Returns the raw id_token. */
export async function exchangeCode(code: string, verifier: string): Promise<string> {
  const { issuer, clientId, clientSecret, redirectUri } = suiteConfig();
  const res = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code, redirect_uri: redirectUri, client_id: clientId,
      client_secret: clientSecret, code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Suite sign-in: token exchange failed (${res.status}).`);
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("Suite sign-in: the gateway returned no ID token.");
  return tokens.id_token;
}

/**
 * Mint a GENUINE local Supabase session for an EXISTING PTP user. Resolves the address from
 * auth.users BY ID, so the only email ever passed to generateLink is one an account already has —
 * making "conjure a new account from a stale claim email" structurally impossible (the stranding bug).
 * generateLink is verified side-effect-free (Phase 0 T2).
 */
export async function mintLocalSession(identity: SuiteIdentity): Promise<void> {
  const admin = createAdminClient();
  const { data: found, error: lookupError } = await admin.auth.admin.getUserById(identity.userId);
  const email = found?.user?.email;
  if (lookupError || !email) {
    throw new Error("Suite sign-in: could not establish your PropTracerPRO session.");
  }
  if (email !== identity.email) {
    console.warn("[suite-signin] user_profiles.email diverges from auth.users.email; minted by id.",
      { userId: identity.userId });
  }
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) {
    throw new Error("Suite sign-in: could not establish your PropTracerPRO session.");
  }
  const supabase = await createClient();
  const { error: otpError } = await supabase.auth.verifyOtp({
    token_hash: data.properties.hashed_token, type: "magiclink",
  });
  if (otpError) throw new Error("Suite sign-in: could not establish your PropTracerPRO session.");
}
```

- [ ] **Step 4: Run — Expected PASS.** `npm test -- session`
- [ ] **Step 5: Commit.** `git add lib/suite/session.ts lib/suite/__tests__/session.test.ts && git commit -m "feat(suite): stranding-safe local session mint"`

---

## Task 9: Start + callback routes

**Files:**
- Create: `app/api/auth/suite/start/route.ts`, `app/api/auth/suite/callback/route.ts`
- Test: `lib/suite/__tests__/callback-flagoff.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `GET /api/auth/suite/start`, `GET /api/auth/suite/callback`.

- [ ] **Step 1: Write the failing test** `lib/suite/__tests__/callback-flagoff.test.ts` (flag off ⇒ 404 and cookies cleared; no gateway contact):

```ts
import { afterEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

afterEach(() => { delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED; vi.restoreAllMocks(); });

test("callback returns 404 and clears cookies when the flag is off", async () => {
  delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  const { GET } = await import("@/app/api/auth/suite/callback/route");
  const req = new NextRequest("https://proptracerpro.com/api/auth/suite/callback?code=x&state=y");
  const res = await GET(req);
  expect(res.status).toBe(404);
  expect(res.cookies.get("suite_state")?.value).toBe("");
});

test("start returns 404 when the flag is off", async () => {
  delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  const { GET } = await import("@/app/api/auth/suite/start/route");
  const res = await GET();
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run — Expected FAIL.** `npm test -- callback-flagoff`
- [ ] **Step 3: Write `app/api/auth/suite/start/route.ts`:**

```ts
import { NextResponse } from "next/server";
import { isSuiteSignInEnabled, suiteConfig } from "@/lib/suite/config";
import { challengeFor, newVerifier, randomToken } from "@/lib/suite/pkce";

const TEN_MINUTES = 60 * 10;

export async function GET() {
  if (!isSuiteSignInEnabled()) {
    return NextResponse.json({ error: "Suite sign-in is not enabled." }, { status: 404 });
  }
  const { issuer, clientId, redirectUri } = suiteConfig();
  const verifier = newVerifier();
  const state = randomToken();
  const nonce = randomToken();

  const authorize = new URL(`${issuer}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    scope: "openid email profile", state, nonce,
    code_challenge: challengeFor(verifier), code_challenge_method: "S256",
  }).toString();

  const res = NextResponse.redirect(authorize);
  const opts = {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const, path: "/api/auth/suite", maxAge: TEN_MINUTES,
  };
  res.cookies.set("suite_state", state, opts);
  res.cookies.set("suite_verifier", verifier, opts);
  res.cookies.set("suite_nonce", nonce, opts);
  return res;
}
```

- [ ] **Step 4: Write `app/api/auth/suite/callback/route.ts`** (snapshot written via `createAdminClient` on `user_profiles`; destination `/dashboard`):

```ts
import { type NextRequest, NextResponse } from "next/server";
import { isSuiteSignInEnabled } from "@/lib/suite/config";
import { fetchEntitlements } from "@/lib/suite/entitlements";
import {
  ALREADY_LINKED_ELSEWHERE, EMAIL_NOT_VERIFIED_REASON, resolveSuiteUser, SuiteLinkError,
} from "@/lib/suite/link";
import { exchangeCode, mintLocalSession } from "@/lib/suite/session";
import { verifyIdToken } from "@/lib/suite/verify";
import { createAdminClient } from "@/lib/supabase/admin";

const SUITE_COOKIES = ["suite_state", "suite_verifier", "suite_nonce"] as const;

export type SuiteErrorCode =
  | "invalid_request" | "cancelled" | "unverified_email" | "already_linked" | "refused" | "failed";

function codeForLinkError(e: SuiteLinkError): SuiteErrorCode {
  if (e.message === EMAIL_NOT_VERIFIED_REASON) return "unverified_email";
  if (e.message === ALREADY_LINKED_ELSEWHERE) return "already_linked";
  return "refused";
}
function clearSuiteCookies(res: NextResponse): NextResponse {
  for (const c of SUITE_COOKIES) res.cookies.set(c, "", { path: "/api/auth/suite", maxAge: 0 });
  return res;
}
function fail(req: NextRequest, code: SuiteErrorCode) {
  const url = new URL("/login", req.url);
  url.searchParams.set("suite_error", code);
  return clearSuiteCookies(NextResponse.redirect(url));
}

export async function GET(req: NextRequest) {
  if (!isSuiteSignInEnabled()) {
    return clearSuiteCookies(NextResponse.json({ error: "Suite sign-in is not enabled." }, { status: 404 }));
  }
  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail(req, "cancelled");

  const code = params.get("code");
  const state = params.get("state");
  const cookieState = req.cookies.get("suite_state")?.value;
  const verifier = req.cookies.get("suite_verifier")?.value;
  const nonce = req.cookies.get("suite_nonce")?.value;
  if (!code || !state || !cookieState || !verifier || !nonce || state !== cookieState) {
    return fail(req, "invalid_request");
  }

  try {
    const idToken = await exchangeCode(code, verifier);
    const claims = await verifyIdToken(idToken, nonce);
    const identity = await resolveSuiteUser(claims); // throws SuiteLinkError on refusal
    await mintLocalSession(identity);

    // Best-effort entitlement snapshot (service_role write). A gateway hiccup must not block a
    // sign-in that already succeeded.
    try {
      const ent = await fetchEntitlements(claims.sub);
      await (createAdminClient().from("user_profiles") as any)
        .update({ gateway_products: ent.products, gateway_products_checked_at: new Date().toISOString() })
        .eq("id", identity.userId);
    } catch (e) {
      console.error("[suite-signin] entitlement snapshot failed (continuing):", e);
    }

    return clearSuiteCookies(NextResponse.redirect(new URL("/dashboard", req.url)));
  } catch (e) {
    if (e instanceof SuiteLinkError) return fail(req, codeForLinkError(e));
    console.error("[suite-signin] callback failed:", e);
    return fail(req, "failed");
  }
}
```

- [ ] **Step 5: Run — Expected PASS.** `npm test -- callback-flagoff`
- [ ] **Step 6: Type-check.** `npm run type-check` — Expected: clean.
- [ ] **Step 7: Commit.** `git add app/api/auth/suite lib/suite/__tests__/callback-flagoff.test.ts && git commit -m "feat(suite): start + callback routes"`

---

## Task 10: Wire the entitlement resolver into the access gates

**Files (modify — replace the inline `subscription_tier === 'pro' || is_acquisition_pro_member` with `effectiveIsPro(profile)`, and add `gateway_products` to each profile `select`):**
- `app/api/user/generate-api-key/route.ts:22`
- `app/api/integrations/highlevel/push/route.ts:31`
- `app/(dashboard)/settings/api-keys/page.tsx:46`
- `app/(dashboard)/settings/integrations/page.tsx:197`
- `app/(dashboard)/settings/profile/page.tsx:105`

**Do NOT touch** `lib/api/auth.ts:95` (API-key / Track B) or any `app/api/v1/*` route.

**Interfaces:** Consumes `effectiveIsPro` from `@/lib/suite/entitlements`.

- [ ] **Step 1:** For each file above, open it and locate the profile `.select(...)` feeding the predicate. Add `gateway_products` to the selected columns (e.g. `.select("subscription_tier, is_acquisition_pro_member")` → `.select("subscription_tier, is_acquisition_pro_member, gateway_products")`). If it selects `*`, no change needed.
- [ ] **Step 2:** Add `import { effectiveIsPro } from "@/lib/suite/entitlements";` and replace the inline predicate. Example (generate-api-key/route.ts:22):

```ts
// before:
const hasApiAccess = profile.subscription_tier === 'pro' || profile.is_acquisition_pro_member;
// after:
const hasApiAccess = effectiveIsPro(profile);
```
Apply the analogous one-line swap at each of the five sites (variable names `hasApiAccess` / `hasProAccess` etc. stay the same).

- [ ] **Step 3: Type-check.** `npm run type-check` — Expected: clean (adjust the local `profile` type to include `gateway_products?: string[] | null` if the file declares an explicit type).
- [ ] **Step 4: Write a guard test** `lib/suite/__tests__/access-wiring.test.ts` asserting the shared predicate is exactly `effectiveIsPro` (a lightweight fence that the sites use the resolver, not a re-inlined copy):

```ts
import { expect, test } from "vitest";
import { effectiveIsPro } from "@/lib/suite/entitlements";
// Documents the contract the 5 access sites depend on: a PTP gateway grant alone admits.
test("a gateway grant alone grants pro access", () => {
  expect(effectiveIsPro({ subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"] })).toBe(true);
});
```

- [ ] **Step 5: Run + commit.** `npm test && git add -A && git commit -m "feat(suite): route pro-access gates through effectiveIsPro"`

---

## Task 11: Wire grant-aware pricing into session + cron trace charges

**Files (modify — swap `getChargePerTrace(x.subscription_tier, x.is_acquisition_pro_member)` → `chargePerTrace(x)`, and ensure `gateway_products` is in `x`'s select). `x` is the local profile variable named at each site:**
- `app/api/trace/single/route.ts:51` (`profile`)
- `app/api/trace/status/route.ts:165` (`profile`)
- `app/api/trace/bulk/route.ts:81` (`profile`)
- `app/api/trace/bulk/status/route.ts:61` (`doneProfile`), `:170` (`profile`)
- `app/api/cron/sweep-stale-traces/route.ts:101` and `:233` (`profile`)
- Display: `app/(dashboard)/settings/billing/page.tsx:183` (`profile`), `app/(dashboard)/dashboard/page.tsx:107` (`userProfile`), `app/(dashboard)/history/page.tsx:80` (`userProfile`), `app/(dashboard)/trace/bulk/page.tsx:192` (`data`)

**Do NOT touch** `app/api/v1/trace/*` (API-key / Track B) — they keep `getChargePerTrace`.

**Interfaces:** Consumes `chargePerTrace` from `@/lib/suite/pricing`.

- [ ] **Step 1:** For each file, add `import { chargePerTrace } from "@/lib/suite/pricing";` and add `gateway_products` to the profile `.select(...)` that populates the named variable (skip if it selects `*`).
- [ ] **Step 2:** Replace each `getChargePerTrace(<var>.subscription_tier, <var>.is_acquisition_pro_member)` with `chargePerTrace(<var>)`. Remove the now-unused `getChargePerTrace` import from a file **only if** it has no remaining `getChargePerTrace` call (the trace/bulk/status files may keep it if a v1-shared helper remains — verify per file).
- [ ] **Step 3:** For `app/(dashboard)/trace/bulk/page.tsx:192` (client component reading `data` from an API), ensure the API it calls returns `gateway_products` (it fetches its own profile rate). If that endpoint is `app/api/user/*`, add `gateway_products` to its select too.
- [ ] **Step 4: Type-check.** `npm run type-check` — Expected: clean.
- [ ] **Step 5: Regression test** `lib/suite/__tests__/pricing-contract.test.ts` (documents that a grant-holder's session trace is the pro rate):

```ts
import { expect, test } from "vitest";
import { PRICING } from "@/lib/constants";
import { chargePerTrace } from "@/lib/suite/pricing";
test("cohort grant-holder pays the $0.07 pro rate on a session trace", () => {
  expect(chargePerTrace({ subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"] }))
    .toBe(PRICING.CHARGE_PER_SUCCESS);
});
```

- [ ] **Step 6: Run + commit.** `npm test && git add -A && git commit -m "feat(suite): grant-aware trace pricing on session + cron paths (v1 untouched)"`

---

## Task 12: TTL refresh wiring + login button + middleware allowlist

**Files:**
- Create: `lib/suite/access.ts`
- Modify: `app/(dashboard)/layout.tsx`, `app/(auth)/login/page.tsx`, `lib/supabase/middleware.ts`
- Test: `lib/suite/__tests__/access.test.ts`

**Interfaces:**
- Produces: `scheduleSuiteRefresh(profile)` — schedules an off-critical-path 30-min TTL refresh (service_role write); no-op unless `gateway_sub` present and snapshot stale.

- [ ] **Step 1: Write `lib/suite/access.ts`:**

```ts
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { type EntitlementProfile, fetchEntitlements, isSnapshotStale } from "./entitlements";

interface RefreshRow extends EntitlementProfile { id: string }

/** Schedule the TTL refresh AFTER the response flushes. after() throws outside a request scope,
 *  so degrade to fire-and-forget there. refreshSuiteSnapshot never rejects. */
export function scheduleSuiteRefresh(profile: RefreshRow): void {
  if (!profile.gateway_sub) return;
  try { after(() => refreshSuiteSnapshot(profile)); }
  catch { void refreshSuiteSnapshot(profile); }
}

/** Re-validate the snapshot on a 30-min TTL. Failure-tolerant: a gateway outage keeps the last
 *  snapshot (never a lockout). Entire body inside try because it is handed to after()/void. */
async function refreshSuiteSnapshot(profile: RefreshRow): Promise<void> {
  try {
    const gatewaySub = profile.gateway_sub;
    if (!gatewaySub) return;
    if (!isSnapshotStale(profile.gateway_products_checked_at)) return;
    const ent = await fetchEntitlements(gatewaySub);
    await (createAdminClient().from("user_profiles") as any)
      .update({ gateway_products: ent.products, gateway_products_checked_at: new Date().toISOString() })
      .eq("id", profile.id);
  } catch (e) {
    console.error("[suite-signin] entitlement refresh failed, keeping last snapshot:", e);
  }
}
```

- [ ] **Step 2: Write the test** `lib/suite/__tests__/access.test.ts`:

```ts
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
```

- [ ] **Step 3: Wire the refresh** in `app/(dashboard)/layout.tsx`. After the existing profile fetch, select `gateway_sub, gateway_products_checked_at` alongside whatever it already reads, then:

```ts
import { scheduleSuiteRefresh } from "@/lib/suite/access";
// ...after the profile is loaded (server component):
scheduleSuiteRefresh({ id: user.id, gateway_sub: profile?.gateway_sub, gateway_products_checked_at: profile?.gateway_products_checked_at });
```
Add `gateway_sub, gateway_products_checked_at` to that layout's profile `.select(...)`.

- [ ] **Step 4: Add the login button** to `app/(auth)/login/page.tsx`. At the top of the component add the `suite_error` surfacer, and render the flag-gated button above the existing form:

```tsx
import { isSuiteSignInEnabled } from "@/lib/suite/config";
import { suiteErrorMessage } from "@/lib/suite/login-errors";
// inside the component:
useEffect(() => {
  const code = new URLSearchParams(window.location.search).get("suite_error");
  const msg = suiteErrorMessage(code);
  if (msg) setError(msg);   // reuse the page's existing error state
}, []);
// in the JSX, above the tabs/form:
{isSuiteSignInEnabled() && (
  <a href="/api/auth/suite/start" className="block w-full text-center rounded-md border px-4 py-2 mb-4">
    Sign in with Suite
  </a>
)}
```
(Use PTP's existing Button component if the file already imports one; a plain styled `<a>` full-navigation is required so the OAuth redirect works. Match the file's existing `useState` error variable name.)

- [ ] **Step 5: Allowlist the routes** in `lib/supabase/middleware.ts` (`publicRoutes`, ~`:46`). Add `"/api/auth/suite/start"` and `"/api/auth/suite/callback"` (or the prefix `"/api/auth/suite"`) to the list so they are reachable pre-session.

- [ ] **Step 6: Run + type-check.** `npm test && npm run type-check` — Expected: pass + clean.
- [ ] **Step 7: Build.** `npm run build` — Expected: succeeds.
- [ ] **Step 8: Commit.** `git add -A && git commit -m "feat(suite): TTL refresh wiring, login button, route allowlist"`

---

## Task 13: Canary (localhost:3000, David + Claude)

**Files:** none. Manual, with a throwaway account. **Flag stays OFF in prod; no prod SUITE_* vars set.**

**Setup:** put all seven `SUITE_*` vars (from Task 0) into PTP's local `.env.local` with `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED=true`; run `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED=true npm run dev`; open `http://localhost:3000/login`. Run on localhost, not a preview (the gateway rejects unregistered redirect_uris).

- [ ] **Step 1:** The 8 proven checks: (1) link / no duplicate account; (2) revoke ↔ re-grant recovery (revoke in gateway, null `gateway_products_checked_at`, reload → access drops, re-grant → returns); (3) grant after first sign-in; (4) kill gateway mid-flow (block `/api/v1/*`, sign-in still succeeds, access returns when back); (5) native-pro / AcquisitionPRO user with gateway down is unaffected; (6) gateway email change → same account, no dup; (7) direct callback with bogus `code`/`state` → `/login?suite_error=invalid_request` (fixed copy); (8) consent auto-approve (trusted client).
- [ ] **Step 2: PTP-specific checks:**
  - A grant-holder's session trace bills **$0.07** (check `wallet_balance` delta or the charge log), a no-grant user's bills **$0.11**.
  - A no-grant Suite sign-in lands in a **working wallet account** (dashboard loads, can attempt a trace, 402 only at $0 balance).
  - Confirm the grant did **not** change `wallet_balance` and cannot (self-mint is impossible).
  - The 3 crons (`sweep-stale-traces`, `sweep-business-traces`, `sweep-bulk-research`) run without error against a linked user (trigger manually with the `CRON_SECRET`).
- [ ] **Step 3: Verify no duplicate account** after the link branch:

```sql
select count(*) from public.user_profiles where lower(email) = lower('<canary email>');
```
Expected: `1`.

- [ ] **Step 4: Clean up.** Delete the throwaway auth user + profile row; restore the gateway grant/email; confirm `.env.local` flag back to `false` (or vars removed). Nothing merged, nothing pushed.

---

## Task 14: Prod-enable prerequisites (do NOT execute without David's explicit go)

Documented here so the merge/enable is a checklist, not a discovery. Each item is David's call.

- [ ] Wire `alertSuite` to a real channel (email/webhook/Sentry) — the no-lockout paging path.
- [ ] Set the seven `SUITE_*` vars in PTP **production** with `SUITE_REDIRECT_URI=https://proptracerpro.com/api/auth/suite/callback`; keep `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED=false` until the moment of enable.
- [ ] Merge `feature/suite-signin` → `main` (PROD DEPLOY) with the flag OFF; verify `/api/auth/suite/start` 404s in prod (config absent or flag off).
- [ ] Flip `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED=true` in prod only after a green prod smoke.
- [ ] (Later, separate changes) Track B agent federation; then the GHL-iframe retirement + global `SameSite=Lax` (pre-flight: no live GHL menu link points at PTP).

---

## Self-Review

**Spec coverage:** entitlement resolver (Task 6 ✓ spec §6), routes/flow (Task 9 ✓ §7), linking rules (Task 7 ✓ §8), migration (Task 2 ✓ §9), freshness/no-lockout (Task 12 access.ts ✓ §10), flag/config (Task 3 ✓ §11), apex redirect + Lax cookies (Task 3 env + Task 9 start ✓ §5/§12), gateway prereqs (Task 0 ✓ §12/§13), tests (Tasks 1,3–12 ✓ §13/§14), canary (Task 13 ✓ §14/§15), price path incl. crons + v1-untouched (Task 11 ✓ §6 + non-goal), provisioning via trigger (Task 7 create branch ✓ §5/§8), snapshot via service_role (Task 9 ✓ constraint). No spec section is unmapped.

**Type consistency:** `EntitlementProfile` (Task 6) is the shared shape used by `effectiveIsPro`, `hasSuiteAccess`, `chargePerTrace`, and `access.ts`. `SuiteIdentity {userId,email}` (Task 7) is consumed by `mintLocalSession` (Task 8) and the callback (Task 9). `SuiteClaims` (Task 4) flows verify → link → callback. `SUITE_PRODUCT` (Task 3) is the one slug used by `hasSuiteAccess`. Function names match across tasks.

**Placeholder scan:** the only deferred value is `SUITE_PRODUCT`'s exact slug, gated behind Task 0 Step 4's confirmation with an expected default (`prop-tracer-pro`) and a concrete verification command — not an open TODO. Migration filename timestamp is the standard `<YYYYMMDDHHMMSS>` convention.
