# PropTracerPRO — Project History

A running log of completed tasks, changes, and decisions. Updated after every task.

---

## 2026-09-04

### ZIP is optional; the dedup key drops to STREET|CITY|STATE

- **Why:** the property-registry is being wired into the suite gateway for owner enrichment and
  could not clear the door. ZIP was required on every record — and `skipTraceBulk` fails the
  ENTIRE batch if one record is invalid — while never reaching either vendor. The Tracerfy
  person CSV has no zip column (`lib/tracerfy/client.ts:54`) and FastAppend submits
  `business_name,state` only. The registry supplies a situs city for 804 counties and a ZIP for
  766, so requiring it made **241 counties / 16,062,225 parcels** untraceable for a field
  nothing downstream reads.
- **Code:** `normalizeAddress` now returns `STREET|CITY|STATE` and its `zip` parameter was
  REMOVED rather than ignored, so TypeScript forced every one of the 12 call sites across 9
  files to be revisited. `validateAddressInput` takes `zip?` — absent is valid, supplied and
  malformed still errors. `recordSchema.zip` and `AddressInput.zip` are optional.
  `checkSingleDuplicate` lost its now-unused `zip` parameter.
- **Tests:** `address-normalizer.ts` had **no test coverage at all**; it now has 13. Suite
  138 → **151 passing**, `tsc` clean, build clean, eslint unchanged from `main` (55 pre-existing).
  Both fences mutation-proved: restoring the ZIP requirement reds 2 tests, putting ZIP back in
  the key reds 4, reverting is green.
- **Migration `20260904_zip_optional_three_part_dedup.sql`**, applied and independently verified.
  Re-keys 3,617 rows; **deletes nothing**.
- ⚠️ **The first draft was wrong and Postgres caught it.** It deleted the redundant row of each
  colliding group and hit `23503: violates foreign key constraint
  wallet_transactions_trace_history_id_fkey`. **7 of the 15 redundant rows are referenced by the
  billing ledger** — they are receipts. The transaction rolled back with nothing changed. The
  shipped version re-keys only each group's survivor and leaves the 15 non-survivors
  byte-identical, which is safe by construction: a 4-part string cannot hash to a 3-part one, so
  `UNIQUE(user_id, address_hash)` holds automatically.
- **Verified after applying:** 3,632 rows total (unchanged), 3,617 three-part, 15 four-part by
  design, 0 hash mismatches, 0 duplicate keys, 2,591 wallet rows unchanged, **0 orphaned wallet
  references**.
- **It fixed a billing defect, not just a blocker.** The 15 collisions are not distinct
  properties — `3661 AIRPORT BLVD|MOBILE|AL` under both 36608 and 36609, `1850 MAGWOOD DR|
  CHARLESTON|SC` under both 29414 and 29403. The old four-part key was letting the same property
  be traced and charged twice.
- **Docs:** `docs/AGENT_BULK_INTEGRATION.md` said ZIP was required. Corrected.
- **Found, not fixed here:** `suite-gateway/lib/tools/crm-push-owners.ts:493-499` reads five
  field names PTP does not emit (`owner_name`, `email`, `phone`, `cost`, `is_entity` versus the
  real `input_owner_name`, `owner_contact_name`, `owner_contact_source`, `charge`, `phone_count`,
  `email_count`), so enrichment always reports found-nothing with `spent: 0`. Its poll budget is
  also 2.4 seconds against jobs that run 5 to 30 minutes.

---

## 2026-08-17

### Resolved owner contact (person) now has a name in the payload

- **Problem:** Suite Gateway consumers were delivering the company name, its phone and the
  owner's email into a spreadsheet, but never the owner contact person. Reported as "PTP is only
  returning the company name and phone and email, not the owner contact (Person)."
- **Root cause: not a data problem — a naming problem.** PTP was resolving the person all along.
  The per-record payload carried FOUR keys named some variant of "owner name" at three nesting
  levels, meaning two different things: `input_owner_name` and `research.owner_name` are the
  ENTITY, while `trace_result.owner_name` and `contacts.owner_name` are the PERSON. Consumers
  mapping a column called "owner name" matched the company they already had and discarded the
  person. Nothing in the payload was named for the thing an entity skip trace exists to produce.
- **Proof:** in the 2026-08-13 Dallas run, 45 of 77 traces resolved a real human and 0 of them
  reached the delivered CSV, while those same people's *personal emails* did
  (`dhamann2@gmail.com` next to "Magnolia Property Company", `joebeardjr@yahoo.com` next to
  "Westdale"). David independently confirmed it by re-running Houston with "including the owner
  contact, the person" appended to the prompt: same code, 66 of 83 names delivered.
- **Changes:**
  - New `resolveOwnerContact()` in `lib/ai-research/contacts.ts` — one definition of "who is the
    human behind this owner", returning `owner_contact_name` + `owner_contact_source`
    (`fastappend` | `person_trace` | `ai_research`). Never returns a company name.
  - `owner_contact_name` / `owner_contact_source` added at the top level of the per-record payload
    in both the MCP surface (`lib/suite/mcp-tools.ts`) and its REST twin
    (`app/api/v1/trace/bulk/status/route.ts`), which stay line-for-line identical by design.
  - `list_traces` now includes the resolved contact; it previously returned the company name plus
    bare phone/email counts and no contact at all.
  - `sweep-bulk-research`'s inline `resolvedPerson` chain collapsed onto the shared helper
    (behavior-preserving — no `trace_result` exists at that point).
  - Tool descriptions + API docs page now state that the two owner-name fields are different and
    that the company must never be substituted for the contact person.
- **Verification:** TDD throughout (every test watched fail first). Mutation test: deleting the
  `owner_type === 'individual'` guard makes the payload emit "Fountain Parc Apartments LLC" as a
  contact person and turns the test red. Replayed all 77 real Dallas rows through the shipped
  helper: 56 resolve a human, including every name the sheet lost, with no re-trace and no wallet
  spend. 138 tests pass, `tsc --noEmit` clean.
- **Not changed:** `suite-gateway` (it proxies `ptp_*` verbatim and needed no edit).

---

## 2026-08-12

### Fix the emailed sign-in links: password reset was broken for every user
- **Problem:** A member (`ventexproperty@gmail.com`) could not sign in by password, magic link, or the Suite button, and forgot-password did nothing. Reported as one user's lockout; three of the four causes turned out to affect every user.
- **Evidence gathered before changing anything:** His account was healthy on both sides (PTP confirmed Feb 5, bcrypt password set, not banned; gateway account confirmed Aug 11 with a lifetime grant including `prop-tracer-pro`; `user_profiles.email` matching exactly and `gateway_sub` NULL, so linking would be a clean link, not a refusal). Email delivery was working: every `auth.flow_state` row had `auth_code_issued_at` set 20–30s after the send, meaning he clicked each link promptly. Four clicked links (08-10 signup, 08-12 magiclink, 08-12 recovery, 08-12 magiclink) produced **zero** rows in `auth.sessions` — newest session was 08-09. So the PKCE code was reaching the app and never being exchanged. `last_sign_in_at` still 08-09 confirmed his password attempts genuinely failed the credential check (probing the endpoint returned a normal `invalid_credentials`). No deploy since ~07-24, so nothing had regressed in code.
- **Root cause A — `/reset-password` never exchanged the code.** `resetPasswordForEmail` sent `redirectTo: /reset-password`, and `@supabase/ssr`'s `createBrowserClient` hardcodes `flowType: 'pkce'`, so the recovery link landed with `?code=`. But `app/(auth)/reset-password/page.tsx` is a client page that only calls `updateUser({ password })` — nothing ever called `exchangeCodeForSession`, so with no session it failed "Auth session missing!". Forgot-password had never worked for anyone.
- **Root cause B — the middleware then bounced the page.** `/reset-password` sits in `publicRoutes`, and the middleware redirected any authenticated user off public routes to `/dashboard`. Confirmed live in Chrome (`/forgot-password` → `/dashboard`). Since the fix establishes a session *before* the form renders, fixing A without B would just have moved the wall.
- **Root cause C — failures were silent.** `/auth/callback` redirected to `/login?error=auth_callback_error`, but `login/page.tsx` only read `suite_error`. Users were dumped back on a bare login form with no message, which is why this read as "nothing happens" and stayed undiagnosed.
- **Root cause D — Suite consent window too short.** `api/auth/suite/start` gave `suite_state`/`suite_verifier`/`suite_nonce` a 10-minute TTL. The gateway is invite-only and passwordless, so a first-time member must leave for their inbox mid-flow; past 10 minutes the callback fails `invalid_request`. The rest of the OAuth chain checked out (client registered, redirect_uri matching, consent page reachable, `next` preserved through gateway login, grant valid). `email_verified` was a red herring — working accounts carry the same `identity_data.email_verified: false`.
- **Changes:**
  - `app/auth/confirm/route.ts` (new) — server route consuming the one-time `token_hash` via `verifyOtp`, then redirecting to a validated `next`. Needs no browser-held `code_verifier`, so a link requested on a desktop works when opened on a phone. That cross-device case is what PKCE structurally cannot serve.
  - `lib/auth/email-link.ts` (new) — `isEmailOtpType` allowlists `type` before it reaches GoTrue; `safeNext` restricts the post-confirm redirect to same-origin relative paths (a verified session rides on that redirect). Mirrors suite-gateway's `lib/safe-next.ts` deliberately so the two apps cannot drift.
  - `lib/auth/login-errors.ts` (new) — fixed developer-authored copy per error code, plus `loginErrorFromSearch` which reads **both** `suite_error` and `error`. Never echoes the raw param (same phishing hole `lib/suite/login-errors.ts` exists to close).
  - `app/(auth)/forgot-password/page.tsx`, `app/(auth)/login/page.tsx` — point at `/auth/confirm?next=…`; login delegates its banner to `loginErrorFromSearch`.
  - `lib/supabase/middleware.ts` — added `authedAllowedRoutes` so an authenticated user can reach `/reset-password` and any `/auth/*` route. Replaces the old exact-match `!== '/auth/callback'` exemption.
  - `lib/supabase/client.ts`, `server.ts`, `middleware.ts` — `SameSite=None` → `Lax`. None existed only for the AcquisitionPRO/GoHighLevel iframe embed, which was removed weeks ago; a `SameSite=None` cookie is a third-party cookie, exactly the kind browsers now restrict, and the most likely reason the PKCE verifier went missing. Lax still covers the top-level navigation an emailed link performs.
  - `app/api/auth/suite/start/route.ts` — consent window 10 → 30 minutes.
- **Supabase config (Management API, applied to prod):** Recovery and Magic Link templates now use `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=…`; `uri_allow_list` widened to `http://localhost:3001/**,https://proptracerpro.com/**` so `/auth/confirm?next=…` matches with its query string. Deliberately **no** `proptracerpro-*.vercel.app` glob: anyone who registered such a name could receive a `token_hash`. Prior values snapshotted before patching.
- **Verified:** 129 tests pass across 23 files, `tsc --noEmit` clean. Each of the three new guards was deleted in turn to confirm the tests go red (open-redirect guard → 1 failure; middleware reset-password allowance → 2; reading the `error` param → 1). Confirmed empirically against the live project that `POST /auth/v1/verify` with a `pkce_`-prefixed `token_hash` returns a full session, which is why no separate non-PKCE request path was needed. A real recovery email was sent to a throwaway account and inspected in Gmail to confirm `{{ .RedirectTo }}` renders a well-formed link.
- **Left alone:** signup confirmations still use `{{ .ConfirmationURL }}` → `/auth/callback`, which also routes first-time users through `/onboarding`. The CSP `frame-ancestors` allowlist still names the GoHighLevel domains; it is now dead config but harmless, and removing it was out of scope for this fix.

---

## 2026-05-11

### Stall-detect Tracerfy upstream failures so callers stop polling 'processing' forever
- **Problem:** Both bulk and single skip-trace sessions were sitting at `status: 'processing'` for 20–30+ minutes from the caller's perspective. The Lead-Gen Agent was retrying traces at its internal 20-minute timeout, believing PTP failed and generating duplicate `trace_history` rows + duplicate Tracerfy submissions. Last week's fixes (`d780e9d` research-cron stale claims; `5407f2e` v1 bulk status timeout + parallel polling) targeted two unrelated paths; this is a third latent bug that becomes visible under Tracerfy upstream pressure.
- **Root cause:** `lib/tracerfy/client.ts` `getJobStatus()` silently coerced *every* non-success Tracerfy response — 503, 429, unknown response shape — into `{ success: true, pending: true }`. All four status endpoints (v1 single, v1 bulk, dashboard single, dashboard bulk) then treated "Tracerfy is genuinely working" and "Tracerfy is broken / rate-limiting us / returning garbage" as the same state and returned `status: 'processing'` to the caller indefinitely. `sweep-stale-traces` is the only server-side recovery and doesn't kick in until 60 minutes (per `STALE_PROCESSING.CRON_TIMEOUT_MINUTES`) — way past the agent's retry window. Callers had no diagnostic signal at all.
- **Changes:**
  - `lib/constants.ts` — added `TRACERFY_STALL_MINUTES = 15` under `STALE_PROCESSING`. Long enough to absorb normal Tracerfy queue depth, short enough that the Lead-Gen Agent's 20-min retry isn't tripped. Left `CRON_TIMEOUT_MINUTES` at 60 (different purpose — second-line "give up entirely" deadline used by the cron).
  - `lib/tracerfy/client.ts` — exported new `TracerfyErrorReason` union (`'rate_limited' | 'upstream_unavailable' | 'malformed_response' | 'network_error' | 'auth_error'`). `getJobStatus()` now tags returns with `errorReason` on 429 (`rate_limited`), 503 (`upstream_unavailable`), 401/403 (`auth_error`, also flips `success: false`), unknown response shape (`malformed_response`), and caught fetch errors (`network_error`). The `pending: true` contract is preserved — the tag is purely additive diagnostic info so callers can distinguish "still patiently waiting" from "Tracerfy is unhealthy and we're polling through it".
  - `app/api/v1/trace/status/route.ts` — after `getJobStatus()`, compute `ageMinutes` from `trace.created_at`. If `errorReason` set AND age ≥ 15min → update row to `status: 'error'`, return `{ success: false, status: 'error', error, tracerfy_state, age_minutes }`. The existing `'processing'` branch now includes `tracerfy_state` (errorReason or `'pending'`) and `age_minutes` in every response so the agent sees Tracerfy health even while still waiting.
  - `app/api/v1/trace/bulk/status/route.ts` — `resolveOne` records the `errorReason` per `tracerfyJobId` in a `stalledByErrorReason: Map` when polls come back unhealthy. After the parallel batch completes, if the parent `traceJob.created_at` is past the threshold AND any stalled buckets exist, those rows get promoted to `error` via a single `.in('id', stalledRowIds)` update. If no rows remain processing after stall promotion, the parent `trace_jobs` is finalized as `failed` with a descriptive `error_message`. Imported `TracerfyErrorReason` from the client. Pending-state response now also surfaces `tracerfy_state` + `age_minutes`.
  - `app/api/trace/status/route.ts` (dashboard single) — mirror of the v1 single endpoint fix. The `_debug` payload gains `tracerfy_error_reason` for in-browser diagnostics.
  - `app/api/trace/bulk/status/route.ts` (dashboard bulk) — simpler than v1 because the dashboard bulk endpoint polls one shared `tracerfy_job_id`. If `errorReason` set AND job age ≥ 15min → finalize `trace_jobs` as `failed` with `error_message`, bulk-update all still-processing `trace_history` rows for that `tracerfy_job_id` to `error`. Existing pending responses gain `tracerfy_state` + `age_minutes`.
- **No schema migration.** `trace_history.error_message` doesn't exist; per-row error reasoning is surfaced in the API response + Vercel logs (`console.error` with `[v1/trace/status] stall: trace=… reason=… age=…`). `trace_jobs.error_message` already existed and gets the bulk stall reason.
- **Stall threshold is gated on `errorReason` being set** — a genuine `pending: true` from Tracerfy with no `errorReason` keeps the row in `processing` regardless of age. We only promote to `error` when Tracerfy is *actively* unhealthy AND the row is old. This avoids false-erroring legitimate slow Tracerfy jobs.
- **Verified:** `npx tsc --noEmit` clean. `npm run lint` — 35 pre-existing errors, 12 pre-existing warnings, none introduced by this change (the one prefer-const error my first pass introduced was fixed before committing).
- **Why this didn't surface in last week's fixes:** `d780e9d` and `5407f2e` were targeting PTP-side internal failures (cron stale claims, status endpoint timeouts). Neither investigated the `getJobStatus()` return-shape problem because the failure mode at the time was internal, not external. The error-masking pattern has been in the code since the initial Tracerfy integration; it only becomes visible under Tracerfy upstream pressure.

---

## 2026-05-09

### Bundle FastAppend business-trace charges into a single $0.25 per successful row
- **Problem:** After the morning fix that started crediting FastAppend successes, the bulk run on `ea6a10f0` showed 7 of 14 successes credited at $0.07 each — math correct relative to the per-trace fee, but not the user's intended pricing model. The user wants FastAppend successes billed as a single bundled $0.25 (covering AI research + trace combined) per credited row, not as separate $0.15 + $0.07 entries. Additionally, 7 of the 14 successes never got credited at all because they came in via the async FastAppend recovery path (`sweep-business-traces`), which my morning fix didn't touch.
- **Root cause:** Two issues. (1) The trace-credit charge for FastAppend rows used the tier-aware `chargePerTrace` ($0.07/$0.11), and the AI research $0.15 was always booked as a separate ledger entry. There was no concept of a bundled price. (2) The async recovery cron (`sweep-business-traces`) only merged FastAppend contacts into `ai_research` — it never re-evaluated the row's `is_successful` / `charge` / `status` fields, and never bumped the parent `trace_jobs.records_matched`. So when FastAppend lands after the bulk job has already finalised, the row stays as no_match in the user's history with $0.15 of research charge and no successful credit.
- **Changes:**
  - `lib/constants.ts` — new `PRICING.CHARGE_PER_FASTAPPEND_SUCCESS = 0.25` constant. Single flat price (not tier-aware) for any row whose contacts come from FastAppend.
  - `app/api/cron/sweep-bulk-research/route.ts` — restructured the per-row processing. **Before submitting Tracerfy or charging AI research**, the cron now checks whether FastAppend's inline business-trace poll already returned phones/emails (`traceCreditFromFastAppend()`). If yes: persists research with `ai_research_charge: 0`, marks the row `success` with `charge: $0.25`, deducts a single $0.25 from the wallet (`'FastAppend business-trace contacts (bundled research + trace)'`), and **skips Tracerfy submission entirely** — FastAppend already has the commercial-DB owner contacts the user paid for. Only when FastAppend has nothing does the cron fall through to the original flow (charge $0.15 research, submit Tracerfy or mark no_match). Removed the now-dead `chargePerTraceByUser` cache and `getUserChargePerTrace` helper from the morning fix.
  - `app/api/v1/trace/bulk/status/route.ts` — single-row entity finalisation now branches on (a) Tracerfy has contacts → charge $0.07/$0.11 trace fee on top of the $0.15 research already booked (Tracerfy total: $0.22), (b) Tracerfy has nothing but FastAppend contacts arrived async between cron and status → **refund** the $0.15 research (`credit_wallet_balance` with description naming the bundle) then **deduct** the bundled $0.25, set `ai_research_charge: 0` and `charge: $0.25` on the row, (c) neither has contacts → mark no_match, leave the $0.15 research charge in place (will be refunded later if FastAppend lands via async recovery).
  - `app/api/cron/sweep-business-traces/route.ts` — after merging FastAppend results into `ai_research`, re-evaluates billing. When the row is currently `is_successful=false` and FastAppend now provides phones/emails, the cron refunds the prior `ai_research_charge` (if any), deducts $0.25 bundled, updates the row to `status: 'success'` with `charge: $0.25` and `ai_research_charge: 0`, and bumps the parent `trace_jobs.records_matched` so the bulk-job totals stay consistent. Rows already credited as success are left alone (just merge contacts as before).
- **Per-row billing matrix after this change:**
  - FastAppend success (sync, in cron): `charge=$0.25, ai_research_charge=0`. One ledger entry: $0.25.
  - Tracerfy success after AI research (no FastAppend): `charge=$0.07/$0.11, ai_research_charge=$0.15`. Two ledger entries totalling $0.22/$0.26.
  - Tracerfy no_match, FastAppend lands async between cron and status: `charge=$0.25, ai_research_charge=0`. Three ledger entries (debit $0.15, credit $0.15 refund, debit $0.25) net $0.25.
  - Tracerfy no_match, FastAppend lands async after status finalised: same net $0.25 via `sweep-business-traces`. `trace_jobs.records_matched` bumped to keep parent totals correct.
  - Research found owner but no contacts anywhere: `charge=0, ai_research_charge=$0.15`. One ledger entry: $0.15.
  - No owner found: no charge.
- **Verified:** `npx tsc --noEmit` clean. `npx eslint` on changed files: only the pre-existing `'erroredStale' should be const` warning in sweep-business-traces, untouched by this change. Full `npx next build` completes without errors.

### Credit FastAppend business-trace contacts as successful traces in bulk runs
- **Problem:** Bulk job `f3b1e32a-04f5-457f-a922-8461fd68b0c6` (20 Lafayette Parish LLC leads) returned 14 records with real contact name + email/phone — sourced via FastAppend's business-trace path during AI research — but `trace_history` only marked **1** of those as `is_successful=true` with a `$0.07` trace charge. The remaining 13 were stored as `status='no_match', is_successful=false, charge=0`, so the user got the contacts they paid for but wasn't credited or billed for the trace. AI research charges ($0.15/owner found) were applied correctly; the gap was specifically on the per-row trace credit.
- **Root cause:** Three places downstream of FastAppend ignored `ai_research.business_trace_contacts` when deciding whether a row was a successful trace and only looked at the Tracerfy person-skip-trace result. (1) In `app/api/v1/trace/bulk/status/route.ts:140-185`, the single-row entity finalization derived `isSuccessful` purely from the Tracerfy parsed result; if Tracerfy returned no contacts, the row was finalized as no_match even when FastAppend had already produced phones/emails on the same row. (2) In `app/api/cron/sweep-bulk-research/route.ts`, both the no-`resolvedPerson` branch and the Tracerfy-submit-failed branch jumped straight to `status: 'no_match', is_successful: false, charge: 0` without checking whether FastAppend had already delivered contacts. The comment at the submit-failed branch acknowledged the issue ("business_trace_contacts may still carry FastAppend phones/emails which are valid results") but the code didn't credit them. With LLC properties — where Tracerfy commercial coverage often misses the principal but FastAppend doesn't — this pattern hit ~all rows.
- **Changes:**
  - `lib/ai-research/contacts.ts` — new shared helper `traceCreditFromFastAppend(research)` that returns `{ trace_result, phone_count, email_count }` shaped like a Tracerfy `TraceResult` if `business_trace_contacts` has at least one phone or email, or `null` otherwise. Phone-type strings are normalised onto the internal `'mobile' | 'landline' | 'voip' | 'unknown'` union so downstream consumers don't have to defensive-cast. Storing FastAppend contacts in the same `trace_result` shape keeps the history page and per-record API response consistent regardless of which provider the data came from.
  - `app/api/v1/trace/bulk/status/route.ts` — when finalising a single-row entity submission and Tracerfy returned no contacts, fall back to `traceCreditFromFastAppend(row.ai_research)`. If FastAppend has data, `is_successful: true`, `phone_count` / `email_count` reflect the FastAppend payload, `trace_result` stores the FastAppend-shaped record, and `chargePerTrace` is deducted via `deduct_wallet_balance` with description `'Bulk skip trace - FastAppend contacts (entity row)'`. If FastAppend also has nothing, prior behaviour is preserved (`no_match`, no charge).
  - `app/api/cron/sweep-bulk-research/route.ts` — same fallback applied at both the no-`resolvedPerson` branch and the Tracerfy-submit-failed branch. Adds a per-run `chargePerTraceByUser` cache keyed on `user_id` so the user_profiles lookup happens once per cron run instead of per row (cron typically processes 5 rows from the same user). Response body gains a `fastAppendCredited` counter for observability alongside the existing `processed`, `resolvedToPerson`, `noMatch`, `errored`, `staleReverted` fields.
- **Idempotency:** No double-charge risk. The bulk status endpoint only re-polls rows where `status='processing'`; once a row is finalised (either Tracerfy success, FastAppend success, or no_match) it's skipped on subsequent calls. The cron only processes rows with `ai_research_status='queued'`; once it sets `'found'`/`'not_found'`, the row exits the cron's purview. AI research charges ($0.15/owner) and trace charges ($0.07/$0.11) remain separate ledger entries.
- **Out of scope (follow-up):** The async-FastAppend recovery path (`app/api/cron/sweep-business-traces/route.ts`) doesn't yet update `is_successful`, `charge`, or the parent `trace_jobs.records_matched` when FastAppend contacts arrive after the bulk job has already finalised. That edge case requires re-summing per-row charges into the parent job and isn't part of this fix; user's most recent test ran in 6.5 min with sync FastAppend so it didn't hit that path. Will revisit if it surfaces.
- **Verified:** `npx tsc --noEmit` clean. `npx eslint` on `lib/ai-research/contacts.ts`, `app/api/cron/sweep-bulk-research/route.ts`, `app/api/v1/trace/bulk/status/route.ts` clean. Full `npx next build` completes without errors.

### Fix bulk trace jobs stuck in `processing` after row work completes (research-side stale claims)
- **Problem:** A bulk trace job sat in `processing` for 23 minutes even though all underlying Tracerfy + FastAppend work finished within ~6 minutes. The Lead-Gen Agent's external timeout fired and triggered its "system failed" workaround. Same symptom as the 2026-05-01 fix, but with a different root cause — the previous fix addressed the status-endpoint side; this one addresses the research-side.
- **Root cause:** `app/api/cron/sweep-bulk-research/route.ts` claimed rows by flipping `ai_research_status: 'queued' → 'processing'` but had no recovery path for claims that never finished. If a cron invocation was killed externally — Vercel `maxDuration` timeout, OOM, deploy restart — the in-process `try/catch` that reverts a failed claim never ran, leaving the row stranded in `'processing'` forever. The next cron run only looked at `'queued'` rows, so the stranded row was never re-claimed and never finished. The status endpoint at `app/api/v1/trace/bulk/status/route.ts` treats any row with `ai_research_status IN ('queued', 'processing')` as "job not done", so a single stranded row kept the entire bulk wrapper in `'processing'` indefinitely. Risk grew after dd17741 / f4bfaef added the async FastAppend recovery path, which extended per-row research time and pushed cron runs closer to their `maxDuration` cap.
- **Changes:**
  - `supabase/migrations/20260509_add_ai_research_claimed_at.sql` — new migration adding `trace_history.ai_research_claimed_at TIMESTAMPTZ` plus a partial index on `(ai_research_claimed_at) WHERE ai_research_status = 'processing'` for cheap stale-claim lookups.
  - `app/api/cron/sweep-bulk-research/route.ts` — at the top of every cron run, revert any `ai_research_status='processing'` rows whose `ai_research_claimed_at` is older than 5 minutes back to `'queued'` (clearing the timestamp). The claim UPDATE now sets `ai_research_claimed_at: now`. The result-persisting and catch-block-revert UPDATEs both clear `ai_research_claimed_at` so the row's lifecycle ends cleanly. Response payload gains a `staleReverted` counter for observability.
  - `app/(dashboard)/settings/api-keys/docs/page.tsx` — public API docs at `https://proptracerpro.com/settings/api-keys/docs` now reflect what `/trace/bulk/status` actually returns: completed responses include the `results` array with per-record `status`, `result`, `research`, `contacts`, `business_trace_pending`, and `business_trace_job_id`; processing responses include `records_submitted`, `records_pending_research`, `records_pending_trace`. Polling callout adds an SLA note that stuck jobs auto-recover within 5 minutes, and a new amber callout explains how to retrieve delayed FastAppend contacts via `/research/status`.
- **Impact:** Bulk jobs now reliably finalise within minutes of their last row completing. Stranded claims from killed cron runs are picked up automatically on the next minute's cron tick — no manual intervention needed. Existing in-flight bulk jobs benefit immediately once the migration runs and the cron deploys (the next sweep will revert any pre-existing stale claims). Verified with `npx tsc --noEmit` (no errors) and `npx eslint` on changed files (no new errors — the docs page's pre-existing `react-hooks/static-components` warnings are unchanged).

---

## 2026-05-01

### Fix bulk trace v1 status endpoint timing out, leaving jobs stuck in `processing`
- **Problem:** A 14-record bulk run via `POST /api/v1/trace/bulk` sat in `processing` for 30+ minutes even though all 14 Tracerfy result emails arrived within ~5 minutes. Caller's polling against `/api/v1/trace/bulk/status` was failing, blocking inbound API requests in the user's Lead-Gen Agent integration.
- **Root cause:** Two compounding bugs in `app/api/v1/trace/bulk/status/route.ts`. (1) The route declared no `maxDuration`, so Vercel killed it at the platform default (~10 s). (2) The Tracerfy poll loop ran sequentially — for entity-owned bulks, every row owns its own `tracerfy_job_id`, so the endpoint had to make N serialized `getJobStatus()` calls before reaching the "mark job completed" block. Together, the function never survived long enough to commit results; rows stayed `status='processing'` indefinitely no matter how many times the caller polled. AI research, FastAppend, and Tracerfy themselves were finishing fine — only the finalizer was broken.
- **Changes:**
  - `app/api/v1/trace/bulk/status/route.ts` — added `export const maxDuration = 60` (matches the bulk submit route). Replaced the sequential `for (const [tracerfyJobId, bucketRows] of unresolvedByJobId.entries())` loop with a parallel `Promise.all` over batches of `POLL_CONCURRENCY = 25`. Per-row work (poll, parse, update DB row, deduct wallet, mutate local copy for the completion check) is unchanged; only orchestration is parallel. Concurrency is capped to stay friendly to Tracerfy at higher record counts (e.g., a 200-record bulk).
- **Impact:** Today's stuck job will finalize on the next status poll. Future bulk runs with up to ~200 entity rows now finish a single status request in roughly the latency of one Tracerfy poll instead of N. No DB migrations, no contract changes, no new dependencies. Throughput-wise the upstream `sweep-bulk-research` cron (5 rows/min) and FastAppend (5–7 results/min) are unchanged — they already report progress correctly via `records_pending_research` / `records_pending_trace` while the bulk job sits in `processing`.

---

## 2026-04-27

### Fix v1 API failures surfaced by Lead-Gen Agent test
- **Problem:** End-to-end test of the user's Lead Generation AI Agent against the v1 API hit three blocking failures on the same 50-lead run: `POST /api/v1/trace/bulk` returned an opaque HTTP 500, and both `POST /api/v1/research/single` and `POST /api/v1/trace/single?aiResearch=true` timed out for entity-owned (LLC/LP/Trust) properties (48 of 50 records). Net result: 0 CRM-ready leads.
- **Root causes:**
  - **Bulk 500:** `app/api/v1/trace/bulk/route.ts` only validated that `records` was a non-empty array. Per-record fields were unchecked, so any record missing `address` / `city` / `state` / `zip` threw inside `normalizeAddress()` and the whole batch was caught by the generic try/catch and returned as 500. Agent's test data had a mix of leads with and without zip — first one without crashed the request.
  - **Entity research timeout:** `lib/ai-research/client.ts` polled FastAppend up to 15 × 3 s = 45 s per entity, recursing up to 3 levels. With Claude calls layered on top, total runtime could exceed Vercel's default function timeout. Neither sync route declared a `maxDuration`, so they got killed before async recovery could persist a `business_trace_jobs` row.
- **Changes:**
  - `lib/ai-research/client.ts` — added optional `pollBudgetMs` parameter on `researchProperty()` and `resolveEntityChain()`. Default 45 000 ms preserves the cron sweeper's existing behavior; sync routes now pass 15 000 ms so the request returns inside the function timeout. Anything slower falls through to the existing async-recovery path that persists to `business_trace_jobs`.
  - `app/api/v1/trace/bulk/route.ts` — added per-record validation using existing `validateAddressInput()`. Bad records now return a structured 400 with `invalidRecords: [{ index, error }]` instead of an opaque 500. Outer catch now includes the actual error message in the response (matching the `/research/single` pattern). Added `export const maxDuration = 60` for consistency.
  - `app/api/v1/research/single/route.ts` — added `maxDuration = 60` and passes `SYNC_POLL_BUDGET_MS = 15000` to `researchProperty()`.
  - `app/api/v1/trace/single/route.ts` — same treatment.
- **Impact:** A bulk submission with malformed records now returns an actionable 400 telling the caller exactly which records failed and why, instead of a silent 500. Entity research on the sync routes now returns within ~50 s with either inline contacts (if FastAppend resolved within 15 s) or a `business_trace_pending: true` + `business_trace_job_id` for the caller to poll, instead of hanging until the function is killed. No DB migrations, no API contract changes, no new dependencies.

## 2026-04-11

### Bulk trace: AI research + FastAppend parity with single trace
- **Problem:** Yesterday's fast-path FastAppend merge fixed the single-trace API but left `/api/v1/trace/bulk` completely bypassed. Bulk had zero entity detection, no `researchProperty()` call, no `ai_research` persisted on history rows, and no structured contacts in the `bulk_job.completed` webhook. Every entity-owned property in a bulk upload silently lost its decision-maker contacts: an LLC name like "Extra Space Storage" was naïvely split on space and sent to Tracerfy's person skip trace as `first_name="Extra"`, `last_name="Space Storage"`, guaranteeing a miss. This contradicted `docs/AGENT_INTEGRATION.md`, which promises agents the same structured FastAppend output for bulk as for single trace.
- **Design constraint:** Bulk accepts up to 10k records. An HTTP POST cannot block for `N × 45 s` of inline AI research, so the work had to move to a background cron worker, modeled on the existing `sweep-business-traces` pattern.
- **Changes:**
  - Migration `supabase/migrations/20260411_bulk_trace_research.sql` — adds `trace_job_id UUID REFERENCES trace_jobs(id)` to `trace_history`, plus two partial indexes: one for the cron worker to find queued research rows quickly, one for the status endpoint to aggregate per-record state by parent bulk job.
  - `lib/ai-research/client.ts` — `isLikelyBusiness` is now exported so the bulk route can use the same detection heuristics as `resolveEntityChain()`.
  - `app/api/v1/trace/bulk/route.ts` — full rewrite. After dedupe, records are split into `personRecords` (owner_name set AND not business-looking) and `entityRecords` (empty OR business-looking). Wallet balance now covers worst-case research cost in addition to trace cost. All history rows are inserted up front, linked via the new `trace_job_id` column. Person records are still submitted as a single Tracerfy bulk CSV (fast path preserved). Entity records are inserted with `ai_research_status='queued'` and no `tracerfy_job_id` — the cron picks them up. Response now includes `recordsDirectTrace`, `recordsPendingResearch`, and a message indicating how many rows are queued for research.
  - `app/api/cron/sweep-bulk-research/route.ts` — new cron worker. Authenticates via `CRON_SECRET`, pulls up to 5 queued rows per run (throttled because `researchProperty` can take ~45 s per call with inline FastAppend poll), atomically claims each row by flipping `ai_research_status` from `queued` → `processing` to avoid double-processing. For each claimed row: splits the pipe-delimited `normalized_address` back into its street portion, calls `researchProperty()` with an `asyncRecovery` context (so timed-out FastAppend business traces get queued into `business_trace_jobs` for the existing slow-path sweeper), persists the full `AIResearchResult` + charges the $0.15 research fee if an owner was found, picks the best person name to trace (preferring `business_trace_contacts.owner_name`, then `individual_behind_business`, then `owner_name` if the type is individual), and if a person resolved, submits a per-row `submitSingleTrace()` and stores the returned `tracerfy_job_id` on the row. Rows with no resolved person are marked `no_match` immediately so the bulk job can finalize. Transient errors revert the row back to `queued` for the next cron run. `maxDuration = 300`.
  - `vercel.json` — registers `/api/cron/sweep-bulk-research` on `* * * * *` (every minute, because the small batch size means quick churn).
  - `app/api/v1/trace/bulk/status/route.ts` — full rewrite. Now aggregates state across all `trace_history` rows linked to the bulk job via `trace_job_id` instead of reading only the stored summary. Collects unresolved Tracerfy jobs (both the shared bulk job for person rows and the individual per-entity jobs for post-research submits), polls each, persists per-row results, deducts charges, and computes overall completion. While any row is still queued/processing for research OR awaiting a Tracerfy result, returns `status='processing'` with `records_pending_research` and `records_pending_trace` counts. When everything is finalized, marks the job completed, looks up any pending `business_trace_jobs` rows keyed by address hash, and fires a single `bulk_job.completed` webhook whose `results` array now includes per-record `research`, `contacts` (the FastAppend sidecar), `business_trace_pending`, and `business_trace_job_id` — matching `docs/AGENT_INTEGRATION.md`. The existing `sweep-business-traces` cron continues to fire per-record `business_trace.completed` webhooks for rows whose FastAppend job finishes later.
- **Impact:** A bulk upload of 100 properties — say 20 individuals and 80 LLCs — now runs AI research + entity resolution on all 80 entity rows before any Tracerfy person trace, exactly as the single-trace flow does. Agents receive structured decision-maker contacts for business-owned properties in the bulk webhook, plus delayed `business_trace.completed` webhooks for any rows whose FastAppend takes longer than 45 s. Person-named records still hit the original Tracerfy bulk fast path with zero added latency.

## 2026-04-09

### Fix fast-path FastAppend merge (structured contacts were being dropped)
- **Bug:** After the async recovery shipped earlier today, live agent tests revealed a deeper bug: when the inline 45 s FastAppend poll *succeeded* (fast path), the returned `AIResearchResult` still had no structured phones/emails/mailing_address. `resolveEntityChain()` was formatting the FastAppend payload as a text context block for Claude to re-read, but Claude's output schema has no contact fields, so the structured data was silently dropped. Response showed `business_trace_status: "Found: Gwyn McNeal (5 phones, 3 emails)"` but zero contacts in the body — agents were charged $0.15 per call and got nothing usable.
- **Root cause:** The slow-path cron sweeper correctly attaches a `business_trace_contacts` sidecar to `trace_history.ai_research`, but the equivalent fast-path merge was never implemented inside `resolveEntityChain()`.
- **Fix:**
  - `types/index.ts` — `business_trace_contacts` is now a first-class field on `AIResearchResult` (was previously only a cast hack in the cron sweeper).
  - `lib/ai-research/client.ts` — `resolveEntityChain()` now tracks the most recent successful `traceResult` across iterations and, after the Claude re-extraction loop, attaches it to `currentResult.business_trace_contacts`. When Claude didn't identify an owner, the FastAppend owner name is promoted to `owner_name` + `individual_behind_business` (mirroring the cron sweeper). The deceased pass in `researchProperty()` now preserves `business_trace_contacts`, `business_trace_status`, and `pending_business_trace` through its final Claude re-extract (those fields would otherwise be dropped).
  - `app/api/v1/research/single/route.ts` — surfaces `contacts` at the top level of the response and webhook payload, mirroring the shape of `/api/v1/research/status`. The same data is also present at `research.business_trace_contacts`.
  - `docs/AGENT_INTEGRATION.md` and `app/(dashboard)/settings/api-keys/docs/page.tsx` — updated fast-path response examples to show where `phones[]`, `emails[]`, `address` land in the payload, and added a common-mistake note that contact data lives under `business_trace_contacts` (not on the core `research` object).
- **Impact:** Agents calling `/api/v1/research/single` on business/LLC-owned properties now receive structured contact data inline whenever FastAppend responds within 45 s. No more "paid $0.15 and got an empty string" surprise.

### Async FastAppend business trace recovery
- **Problem:** AI research via `/api/v1/research/single` polls FastAppend's business-trace API for only ~45 s in `resolveEntityChain()`. For business/LLC-owned properties, FastAppend usually takes longer — the poll times out, the API returns without contacts, and FastAppend emails the completed CSV to the user's account. Those delayed results never re-entered PTP, so AI agents calling the API (e.g., Cowork finding Mecklenburg County self-storage owners) never saw the phones/emails.
- **Design:** Keep the 45 s inline poll as a fast path (no change for quick cases). When it exhausts, persist the FastAppend `queue_id` to a new `business_trace_jobs` table, surface `business_trace_pending` + `business_trace_job_id` in the API response, and let a cron sweeper poll FastAppend every 5 min, merge contacts into `trace_history.ai_research`, and fire a `business_trace.completed` webhook.
- **Changes:**
  - Migration `supabase/migrations/20260409_business_trace_jobs.sql` — new `business_trace_jobs` table with partial index on `(status='pending', created_at)` and RLS read policy.
  - `types/index.ts` — `pending_business_trace?` field on `AIResearchResult`; new `BusinessTraceJob` interface.
  - `lib/ai-research/client.ts` — `resolveEntityChain()` now accepts an optional `AsyncRecoveryContext`. When the inline poll exhausts with FastAppend still pending, it inserts a `business_trace_jobs` row via admin client and stamps `pending_business_trace` on the returned result. `researchProperty()` forwards the context through discovery-pass and deceased-pass code paths.
  - `app/api/v1/research/single/route.ts` — passes user/address context into `researchProperty`, strips `pending_business_trace` from the persisted research payload, surfaces `business_trace_pending` + `business_trace_job_id` in the response and the `research.completed` webhook.
  - `app/api/research/single/route.ts` — same async-recovery plumbing for the session-auth dashboard endpoint (silent; UI doesn't surface the pending state).
  - `app/api/cron/sweep-business-traces/route.ts` — new cron. Marks rows older than 24 h as errored, polls FastAppend for each pending job, downloads results, updates the job row, merges contacts into `trace_history.ai_research` (appends to `decision_makers`, promotes owner_name if AI didn't find one, adds a `business_trace_contacts` sidecar), and fires `business_trace.completed` webhook.
  - `vercel.json` — registers the new cron on `*/5 * * * *`.
  - `app/api/v1/research/status/route.ts` — new API-key-authenticated status endpoint. Takes `?job_id=<uuid>`, returns `{ status, contacts, research, ... }` where `research` is the merged trace_history snapshot.
  - `app/(dashboard)/settings/api-keys/docs/page.tsx` — documents the new fields, the status endpoint, and the `business_trace.completed` webhook event with a concrete Extra Space Storage example.
  - `docs/AGENT_INTEGRATION.md` — new agent-facing guide covering fast path vs. slow path, polling strategy, webhook alternative, bulk processing, and common mistakes.
- **Billing:** Unchanged. `ai_research_charge` is still deducted on the initial request based on whether the AI found an owner; the delayed merge only enriches contact data.

---

## 2026-04-06

### Fix single trace 500 when re-tracing same address with different owner name
- **Bug:** `trace_history` has `UNIQUE(user_id, address_hash)` but the hash is address-only (no owner_name). When AI Agent resolves a person from an LLC and re-traces the same address with the person's name, the INSERT hits a unique constraint violation → 500
- **Fix:** Before inserting, if `ownerName` is provided, delete any existing trace for that address with a *different* `input_owner_name`. This allows the 2-step research→trace flow to work correctly.
- **Files changed:** `app/api/v1/trace/single/route.ts`, `app/api/trace/single/route.ts`

### Fix API auth returning 401 for server-side errors
- **Bug:** `validateApiKey` in `lib/api/auth.ts` treated all Supabase query errors (connection failures, bad service role key, etc.) as "Invalid API key" (401), masking server-side issues and telling callers their key is wrong when it isn't
- **Fix:** Differentiate PGRST116 (key not found → 401) from other Supabase errors (→ 500 "Internal server error") with server-side `console.error` logging of the actual error code/message. Also wrapped `createAdminClient()` in try/catch for missing env vars.
- **File changed:** `lib/api/auth.ts`

---

## 2026-04-03

### Fix single trace stuck in Processing when Tracerfy returns no data
- **Bug:** When Tracerfy finished processing but returned empty results or only padding rows, both status routes (`/api/trace/status` and `/api/v1/trace/status`) kept returning `processing` instead of finalizing as `no_match`
- **Fix:** Removed early-return `processing` responses for empty/padding-only results; now falls through to existing finalization logic that correctly marks as `no_match`
- **Impact:** Traces that previously spun for up to 60 min (until cron marked them as `error`) now finalize immediately on the next status poll

---

## 2026-04-02

### Update API documentation for bulk import changes
- Updated bulk trace endpoint docs (`/trace/bulk`) with accurate request/response formats including `owner_name`, `mailing_address` optional fields
- Fixed bulk status endpoint path: was `/trace/jobs/:jobId` (non-existent), now `/trace/bulk/status?job_id=uuid`
- Created new v1 bulk status endpoint at `app/api/v1/trace/bulk/status/route.ts` (API key auth wrapper matching internal route logic)
- Added deduplication info (90-day window, batch dedup) and max 10,000 records limit to docs
- Added processing/completed response examples for bulk status polling
- Added bulk trace cURL examples to the integration examples tab
- Fixed v1 bulk route response message to reference correct `/api/v1/trace/bulk/status` path

---

## 2026-03-27

### Fix bulk upload, Stripe wallet top-up, and auto-rebill
- Fixed "Failed to check duplicates: Bad Request" error by batching `.in()` queries into chunks of 100 hashes (was exceeding PostgREST URL length limit with 600+ records)
- Added manual column mapping dropdowns to bulk upload page — users can now override auto-detected column mappings via `<select>` dropdowns
- Surfaced actual Stripe error messages in wallet-topup and create-checkout API routes (was returning generic "Failed to create checkout")
- Added error display to billing page UI so users see meaningful messages when Stripe checkout fails
- Added `setup_future_usage: 'off_session'` to wallet top-up checkout sessions so Stripe saves the payment method for future off-session charges
- Webhook now saves `wallet_payment_method_id` to user profile after successful wallet top-up
- Created `lib/utils/auto-rebill.ts` utility that checks `check_wallet_needs_rebill` and calls `chargePaymentMethod` when wallet balance drops below threshold
- Wired auto-rebill trigger (fire-and-forget) into all trace status endpoints and the cron sweep job

---

## 2026-03-24

### Add forgot password flow to login page
- Added "Forgot password?" link to the password tab on the login page
- Created `/forgot-password` page that sends a Supabase password reset email
- Created `/reset-password` page where users set a new password after clicking the email link
- Added both routes to middleware public routes list

---

## 2026-03-23

### Fix stuck "Processing" traces and add background sweep

**Problem:** Traces submitted Mar 22 stuck in "Processing" for 24+ hours, blocking all future requests.

**Root cause:** System is entirely poll-based with no background recovery. When client stops polling (after ~65s timeout), DB records stay in `processing` forever. Stuck records then block new submissions via unique constraint (single) and dedup logic (bulk).

**Changes:**
- Added `STALE_PROCESSING` constants (10min stale threshold, 60min cron timeout) in `lib/constants.ts`
- Created Vercel Cron job `app/api/cron/sweep-stale-traces/route.ts` — runs every 5 minutes, checks Tracerfy for results on stuck records, finalizes or marks as error
- Fixed `app/api/trace/single/route.ts` — now deletes stale processing records (>10min) before inserting new ones, so stuck records no longer block retries
- Fixed `lib/utils/deduplication.ts` — bulk dedup now excludes stale processing records so they don't prevent reprocessing
- Created `vercel.json` with cron schedule configuration

**Files created:** `app/api/cron/sweep-stale-traces/route.ts`, `vercel.json`
**Files modified:** `lib/constants.ts`, `app/api/trace/single/route.ts`, `lib/utils/deduplication.ts`

---

## 2026-03-09

### Add History.md and update CLAUDE.md workflow rule
- Created `History.md` to track completed tasks across sessions.
- Updated `CLAUDE.md` to add Rule 9: update `History.md` after every task before moving to the next.

---
