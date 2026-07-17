# PropTracerPRO Track A — Suite Sign-in: Design

**Date:** 2026-07-17
**Status:** Design approved by David in conversation 2026-07-17. This written spec is pending his
review. Implementation plan to follow via the writing-plans skill.
**Scope:** PropTracerPRO browser "Suite sign-in" (Track A only). Federates PTP to the Suite Gateway
OIDC identity provider so one gateway login mints a genuine *local* PTP Supabase session. Additive,
feature-flagged, no user migration, no RLS changes.
**Builds on:**
- Umbrella spec `suite-gateway/docs/superpowers/specs/2026-07-14-suite-gateway-sso-design.md`
  (§7 Track A, §7.4 linking rules, §7.5/§7.5.1 entitlements + grant-tier amendment, D1–D8).
- The proven Maturr and ScriptGeneratorPRO Track A implementations (both canaried green, 8/8).
- MPS gateway entitlement design `Multifamily Property Search/docs/superpowers/specs/2026-07-13-multifamily-db-suite-gateway-design.md` (§2 stacked grants).
- PTP ground-truth research (2026-07-16) + code recon (2026-07-17), cited inline as `file:line`.

---

## 1. Problem & context

The AI-Powered Multifamily Intensive cohort is sold **one Suite**; PropTracerPRO is one of four apps
behind four separate logins. Suite sign-in lets a single gateway login mint a real local PTP session,
with access governed by the gateway's `grants` table **additively** to PTP's own plan. No user is
migrated; no RLS policy is touched.

**PTP's distinctive property (the safest fact for this build):** PTP is a wallet / pay-per-use product.
Tier does **not** grant money and does **not** bypass the wallet balance gate — every tier hits
`deduct_wallet_balance`, and a pro user with a $0 wallet gets a 402 like anyone else. Tier only selects
the per-trace **rate**. Therefore a gateway grant **structurally cannot mint money**; the worst case a
misapplied grant can produce is a cheaper trace rate.

---

## 2. Verified current state (recon 2026-07-16 + 2026-07-17)

| Fact | Value | Source |
|---|---|---|
| Repo / stack | `/Users/davidmonroe/PropTracerPRO`, Next.js 16, npm, TS strict, alias `@/*` → repo root, no `src/` | recon |
| Supabase project | `rmmwkjmjchpfebxroyoo`, prod `proptracerpro.com` | ground truth |
| **Prod canonical host** | **apex `proptracerpro.com` serves 200; `www.` 308-redirects to apex** (inverse of Maturr/SGP) | recon (curl) |
| Login UI | `app/(auth)/login/page.tsx` (client), Password + Magic Link tabs; sign-up at `app/(auth)/register/page.tsx` | `login/page.tsx:28,48`; `register/page.tsx:42` |
| Existing OAuth callback | `app/auth/callback/route.ts` (existing magic-link/password) — **not touched**; Suite callback is a new sibling | `app/auth/callback/route.ts:11` |
| Middleware public allowlist | `lib/supabase/middleware.ts:46` (`publicRoutes`) — new Suite routes must be added | recon |
| Pro access predicate | **inlined** `subscription_tier === 'pro' \|\| is_acquisition_pro_member` at ~6 session sites; **no** central session helper | `generate-api-key/route.ts:22`, `highlevel/push/route.ts:31`, `settings/api-keys/page.tsx:46`, `settings/integrations/page.tsx:197`, `settings/profile/page.tsx:105` |
| API-key access facade | `lib/api/auth.ts` (`validateApiKey`, predicate at `:95`) — **Track B surface, NOT touched by Track A** | recon |
| Price function | `getChargePerTrace(subscriptionTier, isAcquisitionProMember)` → `0.07` pro / `0.11` wallet | `lib/constants.ts:119-127,12,13` |
| Business-search charge | `AI_RESEARCH.CHARGE_PER_RECORD = 0.15`, **flat / tier-independent** (not routed through the price fn) | `lib/constants.ts:107` |
| Supabase clients | `createClient()` for both server (`lib/supabase/server.ts:4`) and browser (`client.ts:3`); admin `createAdminClient()` (`admin.ts:8`) | recon |
| Cookie policy | `SameSite=None; Secure` **unconditional** in all 3 cookie-setting clients | `server.ts:20-21`, `client.ts:9-10`, `middleware.ts:31-32` |
| Provisioning trigger | `handle_new_user()` `AFTER INSERT ON auth.users` inserts `user_profiles(id,email)`; tier falls to DEFAULT `'wallet'` | `supabase/schema.sql:379-392,19` |
| `user_profiles` | PK `id` (→ `auth.users(id)`); `subscription_tier` default `'wallet'` CHECK wallet\|starter\|pro; `is_acquisition_pro_member` default false; `api_key`; `wallet_balance` | `supabase/schema.sql:9,19,14,24,36` |
| Gateway columns | **none exist** (`gateway_sub` / `gateway_products` / `gateway_products_checked_at` all absent) | recon |
| Feature-flag convention | **none**; env access is inline `process.env.X` with `\|\|` fallback idiom; declarations in `.env.example` | recon |
| GHL `frame-ancestors` | duplicated byte-for-byte at `next.config.ts:11` AND `lib/supabase/middleware.ts:4` | recon |
| Tests | **zero** — no vitest/jest config, no test files, no test deps | recon |

`starter` is a legal DB tier with no TS representation (`SubscriptionTier = 'wallet' \| 'pro'`,
`types/index.ts:7`); it is dead and irrelevant here. The SQL `has_api_access()` function
(`schema.sql:52-57`) is dead code, never called; the real gates are the inline TS predicates above.

---

## 3. Goals & non-goals

### Goals
- One gateway login mints a genuine local PTP session; the 20 `auth.uid()` RLS policies are satisfied
  unchanged.
- A cohort/Suite/lifetime grant confers **effective `pro`** on PTP: pro features **and** the $0.07 trace
  rate.
- Access is additive: local plan **OR** grant. A gateway outage never causes a lockout.
- Rollback is flipping an env var, not a redeploy.

### Non-goals (explicit)
- **No user migration; no RLS changes; no billing changes.** Stripe and the wallet ledger are untouched.
- **The API-key / agent surface is Track B.** `lib/api/auth.ts` and `/api/v1/*` are not rewired here,
  even though a grant tier would otherwise unlock them (umbrella §7.5.1 scope boundary).
- **The GoHighLevel iframe retirement + tightening global cookies to `SameSite=Lax` is deferred** to a
  separate change after Suite sign-in is proven (umbrella D8 / §11), gated on a pre-flight that no live
  GHL menu link still points at PTP.
- **The grant tier is never written** into `subscription_tier` (Stripe-owned). It is computed at read
  time.

---

## 4. Decisions

| # | Decision | Rejected alternative / why |
|---|---|---|
| P1 | **Federation, not replacement** (inherit umbrella D1–D4). PTP keeps Supabase Auth as its session authority; the gateway is an upstream OIDC provider. | Gateway-issued JWTs used directly: PTP RLS requires a token signed by PTP's own project. Consolidation: rewrites 20 policies + migrates UUIDs on a live money app. |
| P2 | **Effective tier is binary (pro / free), computed at read time, never written.** | Stamping `subscription_tier`: corrupts the Stripe-owned column, fights the webhook, misreports billing, and re-introduces the cohort-cutoff un-stamping problem §10 exists to avoid. |
| P3 | **Pro if the verified email resolves to any of: native PTP pro (`subscription_tier==='pro'`), the AcquisitionPRO GHL tag (`is_acquisition_pro_member`), or a gateway grant covering PTP** (the Suite/Cohort, an additional Suite purchase, or a lifetime award — all one product-grant to PTP). Otherwise **free (wallet)**. | A billing bounce for no-grant users: PTP has no account-level gate — the wallet already works for everyone, so a no-grant Suite sign-in should land in a functional free account, not a wall. |
| P4 | **Centralize the ~6 inline predicates through one pure function `effectiveIsPro(profile)`** over columns already on the profile row (incl. the `gateway_products` snapshot). | Leaving them inline: they cannot see the grant, and duplicating the 3-way OR six times is error-prone. Centralizing also makes the money-debiting crons grant-aware with **no gateway round-trip** (they read the snapshot on the row they already load). |
| P5 | **`redirect_uri` = apex `https://proptracerpro.com/api/auth/suite/callback`** (+ `http://localhost:3000/...` for the canary). | `www.` 308-redirects to apex, and a cross-host redirect drops the host-only PKCE state/verifier/nonce cookies — the exact failure that trimmed Maturr's redirect list. |
| P6 | **The Suite flow's own `state`/`nonce`/`verifier` cookies are `SameSite=Lax; httpOnly; Secure`, set in the new routes; PTP's global `SameSite=None` session cookies are untouched.** | Reusing `None`: unnecessary; the callback return is a top-level same-site navigation, for which `Lax` is correct and safer. Changing the global policy: that is the deferred iframe cleanup (non-goal). |
| P7 | **Create branch: `admin.createUser({email, email_confirm:true})` → the `handle_new_user` trigger auto-creates a wallet-tier profile; session minted via the resolved user id (`getUserById`).** | Minting by raw claim email via `generateLink` create-on-unknown: the account-stranding bug (fixed in the umbrella plan) — signs an email-changed user into a fresh empty account. |
| P8 | **Stand up a minimal vitest harness covering only the security/entitlement-critical files, each test mutation-fenced.** | No tests: PTP has zero today, and the standing lesson is that four safety mechanisms once passed CI green while broken. Backfilling the whole app: out of scope. |

---

## 5. Architecture

The gateway's Supabase project is the OIDC IdP. PTP redirects a human to it, receives an authorization
code, and mints a **local** PTP session. Entitlements are read from the gateway's `/api/v1/entitlements`
and snapshotted onto the PTP profile row.

```
 login page ──"Sign in with Suite"──▶ GET /api/auth/suite/start
                                          │  (PKCE S256, state/nonce/verifier cookies)
                                          ▼
                                Gateway IdP  ngqmcdefmlyjwgpjihch
                                (authorize → user auth → code)
                                          │
                                          ▼
 GET /api/auth/suite/callback ◀───────────┘
   validate state → exchange code → verify ID token (JWKS ES256, iss/aud/exp/nonce)
   → enforce email_verified===true → link-or-create local account (§8)
   → mint local Supabase session → snapshot gateway_products + checked_at → /dashboard
```

### New / changed files

**New:**
- `app/api/auth/suite/start/route.ts` — build authorize URL, set cookies.
- `app/api/auth/suite/callback/route.ts` — the callback flow (§7).
- `lib/suite/entitlements.ts` — `effectiveIsPro(profile)`, `PTP_PRODUCT_KEY`, TTL refresh helper.
- `lib/suite/linking.ts` — the identity-linking rules (§8), the one file most heavily unit-tested.
- `lib/suite/session.ts` — local session mint (`generateLink` → `verifyOtp` on the SSR cookie client).
- `lib/suite/config.ts` — env-var reads + the feature flag.
- `lib/suite/alert.ts` — `alertSuite()` for the refuse/log/alert path (channel wiring a deferred minor).
- Migration `supabase/migrations/<ts>_suite_signin_columns.sql` (§9).
- `vitest.config.ts` + `lib/suite/__tests__/*` (§14).

**Changed (minimal):**
- `app/(auth)/login/page.tsx` — add the "Sign in with Suite" button (flag-gated).
- `lib/supabase/middleware.ts` — add `/api/auth/suite/start` + `/callback` to `publicRoutes` (`:46`).
- The ~6 pro-predicate sites (§2) — replace the inline predicate with `effectiveIsPro(profile)` and add
  `gateway_products` to their profile `select`.
- The trace-price path — feed the effective tier to `getChargePerTrace` (§6).

---

## 6. Entitlement resolver (the PTP-specific core)

A single pure function, over columns already on the profile row:

```ts
// lib/suite/entitlements.ts
export const PTP_PRODUCT_KEY = 'prop-tracer-pro'  // confirm against gateway resolveProducts() in the plan

export function effectiveIsPro(p: {
  subscription_tier: string | null
  is_acquisition_pro_member: boolean | null
  gateway_products: string[] | null
}): boolean {
  return p.subscription_tier === 'pro'
      || p.is_acquisition_pro_member === true
      || (p.gateway_products?.includes(PTP_PRODUCT_KEY) ?? false)
}
```

- **Access:** the ~6 session sites call `effectiveIsPro(profile)` (each already selects the profile;
  add `gateway_products` to the `select`).
- **Price:** the trace-charge path passes the **effective** tier to `getChargePerTrace`, so a
  grant-holder pays **$0.07**. Because the resolver reads only the profile row (including the
  `gateway_products` snapshot), the 3 money-debiting crons — which run with **no user session** — compute
  the correct charge from the row they already load, with **no gateway round-trip and no perturbation of
  row identity**. Business-search stays flat **$0.15** (tier-independent; untouched).
- **Compute, never write:** `subscription_tier` stays Stripe-owned. Every billing / subscription surface
  keeps reading the raw column. A native pro is never lowered by a grant (the OR only ever adds).

---

## 7. Routes & callback flow

**`GET /api/auth/suite/start`** — build the authorize URL: `response_type=code`, `client_id`,
`redirect_uri` (apex), `scope=openid email profile`, PKCE `S256`, a random `state` and `nonce`. Set
`state`, `nonce`, and the PKCE `code_verifier` as `httpOnly; SameSite=Lax; Secure` cookies. Redirect to
the gateway.

**`GET /api/auth/suite/callback`:**
1. Validate `state` against the cookie (CSRF); missing/mismatch → `/login?suite_error=invalid_request`
   (fixed copy, never raw param text).
2. Exchange the code at the gateway `token_endpoint` (`client_secret_post` + PKCE `code_verifier`).
3. Verify the ID token: signature against the gateway JWKS (**ES256**), plus `iss`, `aud` (= our
   `client_id`), `exp`, `nonce`.
4. **Enforce `email_verified === true`** (§8) — else refuse.
5. Link-or-create the local account (§8) → a concrete `userId`.
6. Mint a genuine local session, **stranding-safe**: fetch the resolved account with
   `admin.getUserById(userId)` and call `admin.generateLink({type:'magiclink', email: <that account's
   email>})` — never the raw claim email, so an email-changed user cannot conjure a fresh empty account.
   Consume the returned `token_hash` server-side via `verifyOtp` on the SSR cookie client. Ordinary PTP
   session; RLS/FK/trigger/Stripe linkage untouched.
7. Snapshot `gateway_products` + `gateway_products_checked_at` onto the profile **via the admin
   (service_role) client** — after the 2026-07-16 wallet lockdown column-scoped `user_profiles`,
   `authenticated` cannot write these columns from the browser, and the snapshot is a server-side write
   regardless.
8. Redirect to `/dashboard` (or `/onboarding` if `onboarding_completed` is false, matching the existing
   callback's behavior).

**Failure modes**

| Condition | Behavior |
|---|---|
| `email_verified` not true | Block this login, explicit message. Password/magic-link login unaffected. |
| `gateway_sub` conflict | Block, log, `alertSuite`. Never re-point. |
| Token exchange / minting fails | Back to `/login` with a sanitized error. |
| Gateway unreachable at login | Suite sign-in errors gracefully; **local login still works**. |
| Gateway unreachable at TTL re-check | Last snapshot + local plan. **No lockout.** |

---

## 8. Identity linking rules (inherit umbrella §7.4 — hard rules, not guidance)

- **`email_verified` must be exactly `true`.** Absent or false → login refused. No fallback trusts the
  email anyway. (Blocking test T1 already proved the gateway emits `email_verified: true` for
  magic-link users.)
- Link by verified email **once** (`.eq("email", claim)` — both sides lowercase; never `.ilike`, the
  fixed account-takeover bug), then pin the local account to `gateway_sub` **permanently**.
- After pinning, **`gateway_sub` is authoritative, not email.** A later gateway email change does not
  re-link to a different local account.
- Gateway email matches a local account carrying a **different** `gateway_sub` → **refuse, log, alert.**
  Never silently re-point.
- **No local match → create** (`admin.createUser`, P7): the `handle_new_user` trigger provisions a
  wallet-tier profile; pro rides on top as the computed grant.

---

## 9. Migration (additive only)

On `public.user_profiles`:
- `gateway_sub text unique`
- `gateway_products text[]`
- `gateway_products_checked_at timestamptz`

Columns added only — no drops, no type changes, no FK changes, no RLS changes. Per CLAUDE.md Rule 9:
no new `anon` grant (these are not public-readable); the existing `authenticated` / `service_role`
grants on `user_profiles` already cover the additive columns (verify column-level grants in the plan,
since the 2026-07-16 wallet lockdown column-scoped that table). Rollback is the feature flag, not a
down-migration. Applied via `supabase db query --linked --file` (migration-history drift makes
`db push` unusable); the migration file is documentation, the DB change is the fix.

---

## 10. Entitlement freshness & the no-lockout rule (umbrella §7.5)

- Snapshot `gateway_products` at login; re-check against `/api/v1/entitlements` on a **30-minute TTL**.
- The TTL refresh runs for **any** user with a `gateway_sub`, not only those already passing the gate
  (the fixed one-way-revocation bug), so a late/renewed grant propagates and a lapsed cohort seat drops
  within the TTL. Because the gateway skips expired/revoked grants, the cohort cutoff enforces itself
  and lifetime grants (`expires_at = NULL`) are simply never affected.
- **Inviolable:** if the gateway is unreachable, degrade to the last snapshot plus the local plan.
  **Never a lockout.** A gateway outage must not take PTP's wallet revenue offline.

---

## 11. Feature flag & config

- `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED` (client) gates the login-page button.
- `SUITE_*` server vars: OAuth `client_id` / `client_secret`, gateway issuer / token / JWKS / userinfo
  endpoints, `/api/v1/entitlements` URL + `x-api-key`, and the apex `redirect_uri`.
- Read inline via `process.env` (matching PTP's idiom); declared in `.env.example`. **Flag OFF
  everywhere; production has zero `SUITE_*` vars until David's explicit go**, so `start`/`callback` 404
  in prod and no user can reach the flow.

---

## 12. Gateway-side prerequisites (suite-gateway repo)

1. Register PTP's confidential OAuth client (redirect_uris = apex prod + localhost, `client_secret_post`);
   client secret stored only in PTP's env.
2. Mint an `api_keys` row for PTP (product `prop-tracer-pro`), revocable per app.
3. Add PTP's client id to `NEXT_PUBLIC_TRUSTED_CLIENT_IDS` (Prod + Dev) for consent auto-approve;
   redeploy the gateway.

---

## 13. Testing

Stand up **vitest** (minimal). Cover only the security/entitlement-critical files, each test
**mutation-fenced** (deleting the guard turns it red):
- **`lib/suite/linking.ts`** — every branch: verified, unverified, absent claim, existing email with no
  `gateway_sub`, existing `gateway_sub`, conflicting `gateway_sub`, no match at all.
- **`effectiveIsPro`** — all OR combinations: native pro, GHL member, gateway grant, none → free,
  native-pro-not-lowered, unknown product key ignored.
- **Session mint** — resolves via user id, never conjures an account.
- **Callback** — state mismatch, token/`aud`/`nonce`/`email_verified` failures each blocked.
- **Regression** — existing password + magic-link login unaffected with the flag both on and off.

---

## 14. Canary (localhost:3000, throwaway account, David + Claude)

Run on `localhost:3000` (a Vercel preview cannot: the gateway rejects unregistered redirect_uris).
The 8-check suite proven on Maturr/SGP:
1. link / no duplicate account, 2. revoke ↔ re-grant recovery, 3. grant-after-first-signin,
4. kill-gateway-mid-flow (sign-in survives, access returns), 5. paying/native-pro user with gateway
down (unaffected), 6. gateway email change (same account, no dup), 7. direct callback with bogus
`code`/`state` → `invalid_request`, 8. consent auto-approve (trusted client).

**PTP-specific additions:**
- A grant makes a trace bill **$0.07** (not merely unlock access).
- A no-grant Suite sign-in lands in a working **wallet** account (no wall).
- The wallet **cannot** be minted by a grant (balance gate still 402s at $0).
- The 3 money-debiting crons run unperturbed (row identity intact).

All artifacts cleaned; flag stays OFF; nothing merged; no prod `SUITE_*` vars set.

---

## 15. Implementation order (for the plan)

1. Gateway prerequisites (§12). 2. Migration (§9). 3. `config.ts` + flag (§11).
4. `entitlements.ts` (`effectiveIsPro`) + wire the ~6 access sites + the price path (§6).
5. `start` / `callback` / `linking` / `session` (§7–§8). 6. Login button + middleware allowlist (§5).
7. vitest + tests (§13). 8. Canary (§14). 9. *(Later, separate, David's go each)* merge → PROD deploy →
   Track B (agent federation) → GHL-iframe retirement + global cookie tightening.

---

## 16. Open items to confirm during the plan

- Confirm `PTP_PRODUCT_KEY` (`'prop-tracer-pro'`) against the gateway's `resolveProducts()` output.
- Confirm gateway client-registration mechanics and secret storage.
- Confirm the post-lockdown column-level grants on `user_profiles` cover the 3 additive columns for
  `authenticated` reads / `service_role` writes.
- `alertSuite` channel wiring is a deferred minor (as on SGP), not a blocker for the canary.
