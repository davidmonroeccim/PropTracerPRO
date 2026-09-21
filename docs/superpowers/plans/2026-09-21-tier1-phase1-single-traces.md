# Tier 1 Phase 1: Single Traces Through planRoute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web or API single trace with a supplied owner runs `planRoute()` + `executeRoute()` inline and returns the finished result, with an outcome code, a one-sentence reason and the key that found the owner; a Tier 2 single trace tries every owner the dossier names before falling back to the dossier's own contacts, labelled not name-verified.

**Architecture:** The routing library (`lib/routing/ownerRoute.ts`, `lib/routing/executeRoute.ts`) gains the Tier 1 ladders, the D6 name match (in the Tracerfy parser), a step log, a request time budget and D21. One new helper, `lib/trace/singleTier1.ts`, owns the Tier 1 billing gate, ledger probe, fold and persist, so both single routes share one fenced implementation and keep only auth, price, casing and webhook. One migration adds three nullable `trace_history` columns and an index. The deprecated batch submit (`submitSingleTrace`) is no longer called by either single route; the status poll routes stay for rows already in flight.

**Tech Stack:** Next.js 16 route handlers, Supabase (service-role client for every write), TypeScript strict, vitest 4.1 (node environment; components rendered with `react-dom/server` `renderToStaticMarkup`).

**Spec:** `docs/superpowers/specs/2026-09-21-tier1-planroute-design.md` (Section 2, D1-D26, is binding; D21 amends D15, D22 amends D18, D23 amends D5). Code map with file:line facts: `.superpowers/sdd/phase1-research.md`. Read both before Task 1.

---

## Hard stops

1. **Before Task 1:** the owner approves this plan and answers the two Open questions below.
2. **Before the live check in Task 12:** the owner names a dollar amount.

Nothing else stops the executor except a genuine plan defect (a step that cannot work as written, or a finding that changes what is charged, reported or measured). That goes to the owner as a QUESTION with where it came from (lessons L-021), never as a silent ruling in a ledger.

## Open questions for the owner

**Q1. A lookup that finds the owner (name matched) but returns no phone and no email.** D8 makes it free; the spec gives it no outcome code. Rare: every matched person in Phase 0 carried phones.
- **(a) Treat it as a no-contact result.** The next step in the ladder runs; if nothing else finds contacts the record ends `no_match` ("We looked this owner up by address and found no match. You were not charged."). Cost: at most one more $0.10 vendor lookup on those records, and the sentence says "no match" when the owner was found without contacts.
- **(b) Stop the ladder there** and add an eighth code, `found_no_contacts`: "We found this owner, but there was no phone number or email to return. You were not charged." Cost: no extra lookup; one more code that Phase 2 and the gateway must map.
- The plan is written for (a). Under (b): Task 5 changes one line in `runStage` (`if (call.hit && delivered) hit = call` becomes `if (call.hit && !call.nameNotMatched) hit = call`), and Task 7 adds `FOUND_NO_CONTACTS: 'found_no_contacts'` to `TIER1_OUTCOME`, returns it from `tier1OutcomeFor` when a step has `outcome === 'hit' && noContacts`, and adds its sentence to `outcomeSentence` and the copy-rule list. Three tests pin (a) and change with it: Task 5 `'moves on after a matched hit that carries no phone and no email (Q1 a)'`, Task 7 `'answered misses, and a contactless hit (Q1 a), are no_match'`, and Task 8 `'charges nothing for a matched owner with no phone and no email'` (its expected outcome becomes `found_no_contacts`; it stays free).

**Q2. Two common trust-name words are not in the spec's fixed trust-word list (spec 4.2): `THE` and `ESTATE OF`.** With the list as written, "The Smith Family Trust" strips to "The Smith", so a person lookup runs with first name THE; the match (first initial T, last name Smith) then accepts any Smith at that address whose first name starts with T, and that result is charged. "Estate of John Smith" sends ESTATE as the first name.
- **(a) Add `THE` and `ESTATE OF` to the list.** "The Smith Family Trust" goes straight to FastAppend (D16); "Estate of John Smith" runs the person steps on John Smith. Cost: none.
- **(b) Keep the spec's list exactly.** Cost: the false-match risk above, charged at the Tier 1 rate when it happens, plus a $0.10 vendor lookup on each such name.
- Only Task 2 depends on this: the `TRUST_WORDS` constant and two test rows. Both versions are written out there.

## Global Constraints

Every task's requirements include this section.

**Decisions.** D1-D26 are settled. Implement them; do not reopen them. Where a later decision amends an earlier one, the later wins (D21 over D15, D22 over D18, D23 over D5).

**Scope.** Single traces only: `app/api/trace/single` (web) and `app/api/v1/trace/single` (API). Bulk surfaces (MCP, API bulk, web upload, the Tier 1 queue and cron, CSV columns, the bulk page) are Phase 2 and are not edited, EXCEPT through shared library code this plan changes: `planRoute` (Task 2), the vendor clients (Tasks 3, 4), `executeRoute` (Tasks 5, 6), `traceResultFor` (Task 6) and `rowSkipReason` (Task 7). The Tier 2 cron `app/api/cron/sweep-property-traces` runs that shared code; its suite stays green and Task 6 adds coverage for it. The status poll routes (`app/api/trace/status`, `app/api/v1/trace/status`) and `sweep-stale-traces` are unchanged and keep serving rows already in flight. `submitSingleTrace` stays exported (Phase 4 deletes it); no single route calls it.

**Prices (unchanged).** Tier 1, per successful trace: $0.15 Pro and AcquisitionPRO, $0.25 Pay-As-You-Go. Web charges `chargePerTrace(profile)` (Track A, `lib/suite/pricing.ts:41`); API charges `getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member)` (Track B, `lib/constants.ts:166`). Tier 2, per record submitted: $0.25 and $0.40, unchanged. Owner type never changes the price. No sentence quotes a price.

**Billing gate (spec 6.1, D8).** A Tier 1 record is charged once, only when a name-matched result carries at least one phone or email: `hasContactData(traceResultFor(execution))` (`lib/trace/fullPropertyTrace.ts:165`). Free: `no_match`, `owner_name_not_matched`, `no_lookup_key`, `busy_try_again`. Before charging, ask the ledger (`collectedChargeFor`); a debit the row does not yet show is recorded, never taken again. Money is written through `foldBillingWrite(row, { charge, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE })`. Ledger description: `Skip trace - successful match`. `contact_vendor` is written from `contactVendorFrom(execution.steps)` on every single row, Tier 1 and Tier 2.

**Outcome codes (spec 7.1), exact strings.** `found_by_address`, `found_by_parcel_id`, `found_by_company_name`, `no_match`, `owner_name_not_matched`, `no_lookup_key`, `busy_try_again`. `found_by` values: `address`, `parcel_id`, `company_name` (the KEY, never the vendor; the vendor stays in `contact_vendor`). Tier 2 rows carry `outcome_code` and `found_by` NULL in Phase 1.

**Sentences, exact strings.**
- `busy_try_again`: `The system is busy. Try again in 5 minutes. You were not charged.`
- `owner_name_not_matched`: `We found people linked to this property, but none matched the owner name, so no contacts were returned. You were not charged.`
- `no_match`: `We looked this owner up by {keys} and found no match. You were not charged.` where `{keys}` names only the keys actually answered, in step order, from `address`, `parcel ID`, `company name`, joined "X", "X and Y" or "X, Y and Z".
- `no_lookup_key`: `This record is missing {missing}, so it could not be looked up. You were not charged. Send it again with {resend}.` with the pairs: (`the city and the parcel ID`, `the city or the parcel ID`), (`a valid state`, `a valid two-letter state`), (`a street address and the parcel ID`, `the street address or the parcel ID`).
- No sentence says a parcel ID was "not recognized": Phase 0 measured an unknown parcel id as an ordinary `hit:false` (tasks/phase0-small-sample.md, t1_nothing_found).

**Copy rules (spec 7.3), enforced by tests.** Every sentence states the charge. No price, no `$`, no em dash, no en dash, no asterisk, no emoji. None of "notified", "our team", "looking into", "add funds", "top up", "insufficient". "Not charged" only where true. Resend advice ("send it again", "try again") on exactly two outcomes: `no_lookup_key` and `busy_try_again`. No em dashes anywhere in copy this plan writes, History.md included.

**Step log (spec 5.2).** `trace_history.trace_steps` holds `execution.steps`: one `StepReport` per step with `kind`, `outcome` (`hit` / `miss` / `name_not_matched` / `failed` / `skipped`), `cost`, `creditsDeducted` (as the vendor reported it), `at` (ISO time of the answer), `requestKey` (the exact question asked), `people` (names only, on a billed non-match), `noContacts` (a hit with no phone and no email), `reused` (copied from the log instead of asked again). It is internal: never in a customer response or webhook. Phase 1 writes it once per request, after the ladder finishes; the per-arrival write that crash recovery needs belongs to the Phase 2 queue, and Phase 1's request budget (below) guarantees the request finishes.

**busy_try_again (D7, spec 5.1, 5.2).** A vendor failure (5xx, 429, timeout, transport, or a lookup the request budget could not start) ends a Tier 1 record `busy_try_again`: `status 'error'`, free, HTTP 503 with `Retry-After: 300`, no webhook. Our own input problems (no name, no city, a parcel with no state) are refusals marked `inputError` and never become busy. A resend of a busy row within 24 hours reuses the answered steps, judged by each log entry's own `at` (a reused row keeps its original `created_at`). No single-route sweep may delete a busy row.

**Duplicate key (spec 6.3, D9).** A record with a city: `STREET|CITY|STATE`, unchanged. API record with no city but a parcel id and county: `APN|<parcel>|<COUNTY>|<STATE>`, the parcel trimmed, uppercased, leading `#` removed, dashes and spaces kept. Neither: `STREET||STATE` (today's behaviour; spec 6.3 records its collision risk rather than solving it). The vendor is sent the parcel id as the caller sent it, trimmed, exactly as the MCP path does today.

**D25.** The 90-day cache serves a supplied owner an earlier row only when `ownerNamesMatch(row.input_owner_name, requestOwner)`. A Full Property Trace request (no owner, or the opt-in) is served as today.

**Latency budget.** `VENDOR_TIMEOUT = { CALL_MS: 25_000, SINGLE_ROUTE_BUDGET_MS: 50_000, MIN_CALL_MS: 5_000 }`; arithmetic below. `maxDuration` stays 60 on both single routes.

**Tests.** Written before the code, and run to watch them fail first. Every money or matching guard gets a mutation step: delete or break the guard, run the named test, watch it go RED, restore, watch it go green (L-015). A mutation caught only by `tsc` is reported as such, not counted as a test kill (L-020). An equivalent mutant is reported with its evidence (L-018). Every call site is mutated, not one representative (L-018). No test calls a live vendor. No test reads `tasks/research-test/`; fixtures are sanitized files under `lib/tracerfy/__tests__/fixtures/`. Clear any spy you assert on (L-013).

**Commands.**
- Tests: `npx vitest run <path>` for a file, `npx vitest run` for the suite.
- Types: `npx tsc --noEmit` (0 errors).
- Lint: `npx eslint app lib components`. Baseline 47 problems; the count must not rise. Never bare `npm run lint` (it scans untracked worktrees).
- Build: `npx next build`.

**Migrations.** Applied by the executor with `supabase db query --linked --file <file>` from the repo root, then read back (`information_schema.columns`, `pg_indexes`, `pg_class.relacl`). ADD COLUMN on `trace_history` needs no GRANT; nothing is granted to `anon` or `authenticated`; `trace_history` writes stay locked (20260918_lock_trace_history_writes.sql). Read the ACL back and account for every value you did not predict (L-017).

**Repo rules (CLAUDE.md).** Every change as small as possible (rule 6). NEVER create fallback, fake or made-up data or results (rule 7): a missing sentence is `null`, not a plausible guess. After every task, a History.md entry at the top, directly after the header rule, house style `## <date> (<letter>): <title>` then bullets, where `<date>` is the day the task finished and `<letter>` the next unused letter for that date (rule 9). Tick the task in `tasks/todo.md` (rules 2, 4).

**Git.** Work on branch `feat/tier1-phase1-single-traces`. One commit per task, message ending with the trailer line `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Never push, merge or deploy; that waits for the owner.

## Latency budget (the worst-case arithmetic)

Measured in Phase 0 (tasks/phase0-small-sample.md): Instant 1.26 s and **20.42 s** (a real answer, the D15 second lookup on Wicomico); parcel lookup 0.23 to 1.00 s; FastAppend 0.65 to 5.22 s; dossier 0.29 to 1.96 s.

- **Per-call ceiling 25 s** (`VENDOR_TIMEOUT.CALL_MS`): the slowest real answer seen, 20.4 s, plus about 20 percent. A call not answered by then is a vendor failure (D7). Added with an `AbortController` to the Tracerfy person, FastAppend and dossier clients (Task 4). The crons get it too; their calls were unbounded before.
- **Request budget 50 s** (`VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS`): each single route passes `deadlineMs = request start + 50,000`. `executeRoute` starts a vendor call only when at least 5 s (`MIN_CALL_MS`) of budget remains, and gives it `min(25 s, budget left)`. So the last vendor answer arrives by request start + 50 s at the latest, leaving 10 s inside `maxDuration = 60` for our own work after the ladder (ledger probe, deduct RPC, persist: three database round trips; the webhook and auto-rebill are not awaited).
- **Worst cases if every call ran to its ceiling:**
  - Web Tier 1: person, 1 call = 25 s; company, 1 call = 25 s; trust or unknown, Instant + FastAppend = 2 x 25 = 50 s, exactly the budget.
  - API Tier 1 with a city and a parcel id: trust, Instant + parcel + FastAppend = 3 x 25 = **75 s**, over budget. The deadline clips it: the call that cannot finish in time is not started (or is cut at the deadline), the record ends `busy_try_again`, free, and a resend within 24 hours reuses the two answered steps and runs only the third (at most 25 s).
  - Tier 2 single with D21: APN dossier + address dossier, then for EACH owner its own ladder (an individual up to 2 calls, Instant and parcel; an entity 1; a trust up to 3) = **(2 + up to 3N) x 25 s**, unbounded in the number of owners N. The same deadline clips it; an owner the budget cannot reach is a vendor failure, which a Tier 2 single already answers with 502 and no charge.
- **With the measured latencies nothing is clipped:** API trust ladder 20.4 + 1.0 + 5.2 = 26.6 s; Tier 2 with two individual owners and both keys 2.0 + 2.0 + 2 x (20.4 + 1.0) = 46.8 s.
- **Why bound the ladder rather than raise `maxDuration`:** the crons prove this project can run 300 s functions, but a browser does not wait five minutes for one trace, and D21's per-owner loop would still need a bound. The deadline bounds every ladder, for any number of owners, inside the existing 60 s.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `supabase/migrations/20260922_trace_history_tier1_outcome.sql` | Create (T1) | `outcome_code`, `found_by`, `trace_steps`, index `(user_id, parcel_id_local, county)` |
| `types/index.ts` | Modify (T1) | `TraceResult.name_verified`; new `TraceHistory` columns |
| `lib/routing/ownerRoute.ts` | Modify (T2) | Classifier fix (TR/TTEE), trust words, Tier 1 ladders, D16 |
| `lib/tracerfy/client.ts` | Modify (T3, T4) | D6 name match, credits, `inputError`, per-call timeout |
| `lib/tracerfy/fetchWithTimeout.ts` | Create (T4) | `AbortController` fetch that reads the body inside the window |
| `lib/tracerfy/dossier.ts` | Modify (T4, T6) | Timeout; the nameless contacts block for D21 (b) |
| `lib/constants.ts` | Modify (T4) | `VENDOR_TIMEOUT` |
| `lib/routing/executeRoute.ts` | Modify (T3, T5, T6) | Contract fields, step log, reuse, budget, D21 |
| `lib/trace/fullPropertyTrace.ts` | Modify (T6, T10) | Tier 1 owner not labelled county roll; `name_verified`; parcel builder tolerates no street/city |
| `lib/trace/tier1Outcome.ts` | Create (T7) | Outcome codes, sentences, missing-key phrase, row reader |
| `lib/trace/rowSkipReason.ts` | Modify (T7) | Reads the Tier 1 outcome |
| `lib/trace/traceCompletedWebhook.ts` | Modify (T7) | `tier` parameter and the three outcome keys |
| `lib/trace/singleTier1.ts` | Create (T8) | Tier 1 inline: plan, execute, gate, probe, fold, persist |
| `lib/utils/ownerName.ts` | Create (T9) | D25 owner-name comparison |
| `app/api/trace/single/route.ts` | Modify (T7, T9) | Inline Tier 1, D25, busy exemption, budget, Tier 2 `contact_vendor` |
| `lib/utils/address-normalizer.ts` | Modify (T10) | `traceKeyFor`, `normalizeParcelId` |
| `lib/utils/deduplication.ts` | Modify (T10) | `checkSingleDuplicateByHash` |
| `app/api/v1/trace/single/route.ts` | Modify (T7, T10) | As web, plus D23 input and validation, D24, APN key |
| `app/(dashboard)/settings/api-keys/docs/page.tsx` | Modify (T10) | Synchronous contract |
| `lib/trace/historyDisplay.ts` | Create (T11) | `foundByLabel`, `bulkRowExclusion` |
| `components/trace/TraceResultCard.tsx` | Modify (T11) | Found by, real reason, Free label, not-name-verified |
| `app/(dashboard)/trace/single/page.tsx` | Modify (T11) | No polling; passes the new fields |
| `app/(dashboard)/history/page.tsx`, `app/(dashboard)/dashboard/page.tsx` | Modify (T11) | Found by column, reason, NULL-safe filter |
| `tasks/research-scripts/phase1/run-live.ts` | Create (T12) | One record per path, behind the approved amount |

---

### Task 1: Branch, schema and types

**Files:**
- Create: `supabase/migrations/20260922_trace_history_tier1_outcome.sql`
- Modify: `types/index.ts:70-129` (`TraceResult`, `TraceHistory`)
- Modify: `tasks/todo.md` (Phase 1 line)
- Modify: `History.md`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `trace_history.outcome_code VARCHAR(32)`, `found_by VARCHAR(16)`, `trace_steps JSONB` (all nullable), index `idx_trace_history_user_parcel_county`; `TraceResult.name_verified?: boolean`; `TraceHistory.outcome_code?`, `found_by?`, `trace_steps?: unknown`, `parcel_id_local?`, `county?`, `contact_vendor?` (all `string | null` except `trace_steps`).

- [ ] **Step 1: Branch and record the baseline**

```bash
cd /Users/davidmonroe/PropTracerPRO
git checkout -b feat/tier1-phase1-single-traces main
npx vitest run 2>&1 | tail -5
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
```

Expected: vitest reports 0 failed (write the passing count down: it is this phase's baseline); `tsc exit 0`; eslint ends `47 problems`. If any of the three differs, stop and tell the owner before changing code.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/20260922_trace_history_tier1_outcome.sql`:

```sql
-- Tier 1 single traces through planRoute (spec 2026-09-21, Section 8, Phase 1).
--
-- outcome_code  One of found_by_address, found_by_parcel_id, found_by_company_name, no_match,
--               owner_name_not_matched, no_lookup_key, busy_try_again (spec 7.1). NULL on every
--               row written before this change, and on tier 2 rows, whose reason lives in
--               property_trace_status. status keeps its six-value CHECK (spec 7.1).
-- found_by      The KEY that found the owner: address, parcel_id or company_name. Never the vendor;
--               the vendor stays in contact_vendor.
-- trace_steps   The step log (spec 5.2): one entry per step with kind, outcome, cost, the credits
--               the vendor reported, a timestamp, the question asked, and the names returned on a
--               billed non-match. INTERNAL: never sent in a customer payload. A busy_try_again
--               resend within 24 hours reuses the answered entries instead of buying them again,
--               judged by each entry's own timestamp because a reused row keeps its created_at.
-- index         (user_id, parcel_id_local, county). The API single route now writes both columns
--               for a record sent by parcel id (spec 6.3, D23).
--
-- NOT HERE: widening the ai_research_status queue index (spec 8). That serves the Phase 2 queue.
--
-- GRANTS: none. ADD COLUMN on a pre-existing table inherits its ACL, and
-- 20260918_lock_trace_history_writes.sql left anon and authenticated with SELECT only.
-- Read the ACL back after applying anyway (L-017).

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS outcome_code VARCHAR(32) DEFAULT NULL;

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS found_by VARCHAR(16) DEFAULT NULL;

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS trace_steps JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_trace_history_user_parcel_county
  ON public.trace_history (user_id, parcel_id_local, county);

COMMENT ON COLUMN public.trace_history.outcome_code IS
  'Tier 1 outcome (spec 7.1). NULL before 2026-09-22 and on tier 2 rows.';
COMMENT ON COLUMN public.trace_history.found_by IS
  'The key that found the owner: address, parcel_id or company_name. Never the vendor.';
COMMENT ON COLUMN public.trace_history.trace_steps IS
  'Step log (spec 5.2). Internal only; never returned to a customer.';
```

- [ ] **Step 3: Read the table ACL before applying**

```bash
supabase db query --linked "select unnest(relacl)::text from pg_class where oid = 'public.trace_history'::regclass"
```

Expected: `anon` and `authenticated` each carry only `r` (SELECT); `service_role` carries `arwdDxtm`; `postgres` may also appear. Write the output down.

- [ ] **Step 4: Apply**

```bash
supabase db query --linked --file supabase/migrations/20260922_trace_history_tier1_outcome.sql
```

Expected: no error.

- [ ] **Step 5: Read it back**

```bash
supabase db query --linked "select column_name, data_type, character_maximum_length, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'trace_history' and column_name in ('outcome_code','found_by','trace_steps') order by column_name"
supabase db query --linked "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'trace_history' and indexname = 'idx_trace_history_user_parcel_county'"
supabase db query --linked "select unnest(relacl)::text from pg_class where oid = 'public.trace_history'::regclass"
supabase db query --linked "select has_column_privilege('authenticated', 'public.trace_history', 'outcome_code', 'UPDATE') as auth_update, has_column_privilege('anon', 'public.trace_history', 'trace_steps', 'INSERT') as anon_insert"
```

Expected: three rows (`found_by` character varying 16 YES, `outcome_code` character varying 32 YES, `trace_steps` jsonb YES); one index row `CREATE INDEX idx_trace_history_user_parcel_county ON public.trace_history USING btree (user_id, parcel_id_local, county)`; the ACL identical to Step 3; `auth_update false`, `anon_insert false`. Any other value is a finding: stop and report it.

- [ ] **Step 6: Types**

In `types/index.ts`, inside `TraceResult`, after `match_confidence: number; // 0-100` add:

```ts
  /**
   * FALSE only when the contacts came from the county dossier's own contacts block after every
   * named owner's lookup missed (spec D21 b). That block carries no name, so the owner test cannot
   * run on it, and every surface shows it as "not name-verified". Absent on every other result.
   */
  name_verified?: boolean;
```

Inside `TraceHistory`, after `property_trace_status?: string | null;` add:

```ts
  /** Tier 1 outcome (spec 7.1). NULL before 2026-09-22 and on tier 2 rows. See lib/trace/tier1Outcome.ts. */
  outcome_code?: string | null;
  /** The KEY that found the owner: address, parcel_id or company_name. Never the vendor. */
  found_by?: string | null;
  /** The step log (spec 5.2). Internal; never in a customer payload. Read it with stepLogFrom(). */
  trace_steps?: unknown;
  /** Caller-supplied parcel id and bare county name (migration 20260919). */
  parcel_id_local?: string | null;
  county?: string | null;
  /** Which contact vendor was asked: fastappend, tracerfy, or NULL (migration 20260921). */
  contact_vendor?: string | null;
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit; echo "tsc exit $?"`
Expected: `tsc exit 0`.

- [ ] **Step 8: todo.md, History.md, commit**

In `tasks/todo.md` replace the line `- [ ] Phase 1: single traces. Plan: \`docs/superpowers/plans/2026-09-21-tier1-phase1-single-traces.md\` (being written)` with:

```markdown
- [ ] Phase 1: single traces. Plan: `docs/superpowers/plans/2026-09-21-tier1-phase1-single-traces.md`
  - [x] Task 1: schema columns and types
  - [ ] Task 2: one classifier and the Tier 1 ladders
  - [ ] Task 3: D6 name match and client signals
  - [ ] Task 4: per-call vendor timeouts
  - [ ] Task 5: step log, resend reuse and the request budget
  - [ ] Task 6: D21, every owner then the dossier contacts
  - [ ] Task 7: outcome codes, sentences, rowSkipReason, webhook tier
  - [ ] Task 8: shared Tier 1 settle helper
  - [ ] Task 9: web single route inline
  - [ ] Task 10: API single route inline, D23 and D24, docs
  - [ ] Task 11: result card, single page, History
  - [ ] Task 12: suite gates and the live check
```

Add at the top of `History.md`, directly after the header rule:

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 1: outcome, found-by and step-log columns.

- Migration 20260922_trace_history_tier1_outcome.sql adds trace_history.outcome_code, found_by and
  trace_steps (all nullable) and an index on (user_id, parcel_id_local, county). Applied with
  supabase db query and read back: three columns, the index, and anon and authenticated still
  SELECT only.
- types/index.ts gains TraceResult.name_verified (D21 b) and the new TraceHistory columns.
```

```bash
git add supabase/migrations/20260922_trace_history_tier1_outcome.sql types/index.ts tasks/todo.md History.md
git commit -m "$(cat <<'EOF'
feat(schema): trace_history outcome_code, found_by, trace_steps and the parcel index

Tier 1 Phase 1, Task 1. Applied and read back; no grants changed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: One classifier and the Tier 1 ladders (spec 4.1, 4.2, D2, D3, D4, D16, D22)

**Waits on Q2** (only the `TRUST_WORDS` constant and two test rows differ).

**Files:**
- Modify: `lib/routing/ownerRoute.ts:152-161` (patterns), `:311-312` (`hasSitus` export), `:376-451` (Tier 1 half of `planRoute`)
- Test: `lib/routing/__tests__/ownerRoute.test.ts`
- Test: `lib/routing/__tests__/executeRoute.test.ts` (two trust-only expectations change, because a trust-only owner now reaches FastAppend)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export const TRUST_WORDS: readonly string[]`
  - `export function stripTrustWords(name: string): string`
  - `export const hasSitus: (p: ParcelInput) => boolean` (was private)
  - `planRoute` Tier 1 steps: person `[TRACERFY_INSTANT_NAMED if street+city, TRACERFY_PARCEL_APN if apn+county]`; company `[FASTAPPEND_ENTITY]`; trust and unknown: the person steps on the stripped (trust) or as-given (unknown) name, then `FASTAPPEND_ENTITY` on the full name; D16 (no first name or initial left): `[FASTAPPEND_ENTITY]` only; no usable key for a person, trust or unknown with a first name: `[]`; a name with no letters: `[]`. The `TRACERFY_PARCEL_APN` request now carries `first_name` and `last_name` (for the match only; Task 3 pins that the client never sends them).

- [ ] **Step 1: Write the failing tests**

Append to `lib/routing/__tests__/ownerRoute.test.ts` (it already has `parcel()` and `routeFor()` helpers; `parcel()` carries a situs and a parcel id), and add `stripTrustWords` to its import from `'../ownerRoute'`:

```ts
describe('Tier 1 ladders (spec 4.2; D2, D3, D4, D16)', () => {
  const t1 = (ownerName: string, over: Partial<ParcelInput> = {}) =>
    planRoute(parcel({ ownerName, ...over }), 'wallet')
  const kinds = (r: RoutePlan) => r.steps.map(s => s.kind)

  it('classifies a trailing TR or TTEE as a trust, so the name reaches the trust ladder (spec 4.1)', () => {
    // MUTATION: put TR|TTEE|TRS back into ENTITY_TRAILING and this goes red.
    expect(classifyOwnerName('SMITH JOHN TR')).toBe('trust')
    expect(classifyOwnerName('SMITH JOHN TTEE')).toBe('trust')
    expect(classifyOwnerName('Mary Jones Revocable Trust U/A')).toBe('trust')
    expect(classifyOwnerName('Storage Trust Properties')).toBe('entity')
  })

  it('person: the Instant lookup at the street and city first, then the parcel lookup', () => {
    expect(kinds(t1('Marcus T Halloway'))).toEqual(['TRACERFY_INSTANT_NAMED', 'TRACERFY_PARCEL_APN'])
  })

  it('person with no city: the parcel lookup only', () => {
    expect(kinds(t1('Marcus T Halloway', { situsCity: null }))).toEqual(['TRACERFY_PARCEL_APN'])
  })

  it('the parcel step carries the owner names for the match (L-020)', () => {
    // MUTATION: drop `...who` from the parcel step request and this goes red.
    expect(t1('Marcus T Halloway').steps[1].request).toEqual({
      parcel_id: '16183060290000', county: 'Salt Lake', state: 'UT',
      first_name: 'Marcus', last_name: 'Halloway',
    })
  })

  it('company: FastAppend on name and state only, and the lane stops there (D4)', () => {
    const r = t1('Abc Rentals Llc')
    expect(kinds(r)).toEqual(['FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toEqual({ company_name: 'Abc Rentals Llc', state: 'UT' })
  })

  it('trust: the person steps on the stripped name, then FastAppend on the full name (D3)', () => {
    // MUTATION: run the person steps on the unstripped name and last_name becomes "Trust".
    // MUTATION: drop the trailing FastAppend push and the third kind disappears.
    const r = t1('Marcus Halloway Revocable Trust')
    expect(r.ownerType).toBe('trust')
    expect(kinds(r)).toEqual(['TRACERFY_INSTANT_NAMED', 'TRACERFY_PARCEL_APN', 'FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toMatchObject({ first_name: 'Marcus', last_name: 'Halloway' })
    expect(r.steps[2].request).toEqual({ company_name: 'Marcus Halloway Revocable Trust', state: 'UT' })
  })

  it('D16: a trust that leaves no first name or initial goes to FastAppend only', () => {
    // MUTATION: drop the personNameFor gate and a person step runs on "Smith".
    const r = t1('Smith Family Trust')
    expect(kinds(r)).toEqual(['FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toEqual({ company_name: 'Smith Family Trust', state: 'UT' })
  })

  it('unknown, one word: FastAppend only (D16)', () => {
    const r = t1('Halloway')
    expect(r.ownerType).toBe('unknown')
    expect(kinds(r)).toEqual(['FASTAPPEND_ENTITY'])
  })

  it('unknown, five words: the person steps on the name as given, then FastAppend', () => {
    const r = t1('Alpha Bravo Charlie Delta Echo')
    expect(r.ownerType).toBe('unknown')
    expect(kinds(r)).toEqual(['TRACERFY_INSTANT_NAMED', 'TRACERFY_PARCEL_APN', 'FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toMatchObject({ first_name: 'Alpha', last_name: 'Echo' })
  })

  it('a trust with a first name and no lookup key gets no step at all (spec 4.2)', () => {
    const r = t1('Marcus Halloway Revocable Trust', {
      situsAddress: null, situsCity: null, situsState: null, parcelIdLocal: null, county: null,
    })
    expect(r.steps).toEqual([])
    expect(r.warnings.join(' ')).toMatch(/No lookup key/)
  })

  it('keeps today name order for single traces (D22): SMITH JOHN is sent as first SMITH', () => {
    expect(t1('SMITH JOHN').steps[0].request).toMatchObject({ first_name: 'SMITH', last_name: 'JOHN' })
  })

  it('never says the parcel id is cheaper or more accurate (spec 4.2)', () => {
    expect(JSON.stringify(t1('Marcus T Halloway'))).not.toMatch(/cheaper|more accurate/i)
  })
})

describe('stripTrustWords (the fixed list, spec 4.2)', () => {
  it.each([
    ['John Smith Revocable Trust', 'John Smith'],
    ['SMITH JOHN TR', 'SMITH JOHN'],
    ['JOHN SMITH TTEE', 'JOHN SMITH'],
    ['Mary Jones Irrevocable Living Trust U/A 5/1/99', 'Mary Jones'],
    ['JOHN SMITH FAMILY TRUST DTD 01/02/2003', 'JOHN SMITH'],
    ['Smith Family Trust', 'Smith'],
    ['Trustman John', 'Trustman John'],
  ])('%s strips to %s', (input, out) => {
    expect(stripTrustWords(input)).toBe(out)
  })
})
```

Add to the same `it.each` table the two rows for the owner's Q2 answer:
- Q2 (a): `['The Smith Family Trust', 'Smith']` and `['Estate of John Smith', 'John Smith']`.
- Q2 (b): `['The Smith Family Trust', 'The Smith']` and `['Estate of John Smith', 'Estate of John Smith']`.

Replace the existing test `'sends a trust-only owner to manual review rather than guessing a vendor'` in the `planRoute` describe with:

```ts
  it('sends a trust-only owner with no first name to FastAppend on the full name (D16)', () => {
    const r = routeFor(parcel({ ownerName: 'Halloway Living Trust' }))
    expect(r.ownerType).toBe('trust')
    expect(r.steps.map(s => s.kind)).toEqual(['FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toMatchObject({ company_name: 'Halloway Living Trust' })
  })
```

Leave `'never invents a vendor for an unclassifiable owner'` (`'???'`) as it is: a name with no letters still gets no step and a manual-review warning.

In `lib/routing/__tests__/executeRoute.test.ts` replace the test `'sends a trust-only owner to manual review and asks no contact vendor'` with:

```ts
  it('sends a trust-only owner to FastAppend on the full trust name (D16)', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_TRUST_ONLY) })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.ownerFound).toBe(true)
    expect(r.ownerType).toBe('trust')
    expect(d.tracePerson).not.toHaveBeenCalled()
    expect(d.traceEntity).toHaveBeenCalledWith({ company_name: 'Placeholder Family Living Trust', state: 'UT' })
    expect(r.needsManualReview).toBe(false)
    expect(r.property).not.toBeNull()
  })
```

and replace `'records nothing for a trust, because no vendor was asked'` with:

```ts
  it('records fastappend for a trust-only owner, which D16 sends to FastAppend', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_TRUST_ONLY) })
    const r = await executeRoute(tier2Plan(), d)

    expect(d.traceEntity).toHaveBeenCalledTimes(1)
    expect(contactVendorFrom(r.steps)).toBe('fastappend')
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run lib/routing/__tests__/ownerRoute.test.ts lib/routing/__tests__/executeRoute.test.ts`
Expected: FAIL. `stripTrustWords` is not exported; the ladder tests fail on step kinds; the two executeRoute tests fail because `traceEntity` was not called.

- [ ] **Step 3: Implement in `lib/routing/ownerRoute.ts`**

Replace the `ENTITY_TRAILING` and `TRUST_MARKER` lines (`:155-158`) with:

```ts
/**
 * Ambiguous tokens that only count as entity markers at the END of the name.
 *
 * TR, TRS and TTEE are NOT here. They mark a TRUSTEE, and because this pattern is tested before
 * TRUST_MARKER, "SMITH JOHN TR" used to classify as an entity and went straight to FastAppend,
 * never reaching the trust ladder (spec 4.1, 4.2).
 */
const ENTITY_TRAILING = /\b(CO|PA|PC|ET AL CO)\.?$/i

const TRUST_MARKER =
  /\b(TRUST|TTEE|TRUSTEE|TRS|REVOCABLE|IRREVOCABLE|LIVING TRUST|FAMILY TRUST|ESTATE OF|DTD)\b|\bU\/A\b|\bTR\.?$/i
```

After the `splitOwners` declaration add:

```ts
/**
 * The fixed trust-word list (spec 4.2). A trust's person steps run on the name with these
 * removed: "John Smith Revocable Trust" becomes "John Smith". A multi-word entry matches as a
 * phrase. A trailing date ("DTD 01/02/2003", "U/A 5-1-99") goes with the words before it.
 */
export const TRUST_WORDS: readonly string[] = [
  'TRUST', 'REVOCABLE', 'IRREVOCABLE', 'LIVING', 'FAMILY', 'TRUSTEE', 'TTEE', 'TR', 'U/A', 'DTD',
]

const escapeWord = (w: string): string =>
  w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')

const TRUST_WORD_RE = new RegExp(
  `(^|\\s)(?:${TRUST_WORDS.map(escapeWord).join('|')})\\.?(?=\\s|$)`,
  'gi',
)

const TRAILING_DATE_RE = /\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\s*$/

/** The name a trust's person steps run on (spec 4.2). */
export function stripTrustWords(name: string): string {
  return name
    .replace(TRAILING_DATE_RE, ' ')
    .replace(TRUST_WORD_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
```

If the owner chose Q2 (a), the list is instead:

```ts
export const TRUST_WORDS: readonly string[] = [
  'TRUST', 'REVOCABLE', 'IRREVOCABLE', 'LIVING', 'FAMILY', 'TRUSTEE', 'TTEE', 'TR', 'U/A', 'DTD',
  'THE', 'ESTATE OF',
]
```

Change `const hasSitus = (p: ParcelInput): boolean =>` to `export const hasSitus = (p: ParcelInput): boolean =>`.

In `planRoute`, replace everything from `const ownerName = parcel.ownerName!.trim()` down to (not including) the Tier 1 `return {` with:

```ts
  const ownerName = parcel.ownerName!.trim()
  const ownerType = classifyOwnerName(ownerName)

  if (!/[A-Za-z]/.test(ownerName)) {
    warnings.push(
      `Owner name "${ownerName}" has no letters, so no vendor can look it up. ` +
      'Route to manual review rather than guessing a vendor.',
    )
  } else if (ownerType === 'entity') {
    // D4: FastAppend on name and state, and the lane stops there.
    steps.push(entityStep(parcel, ownerName, warnings))
  } else {
    // Person, trust and unknown share one ladder (spec 4.2; D2, D3). A trust runs its person
    // steps on the name with the trust words removed; an unknown name runs them as given.
    const who = personNameFor(ownerType === 'trust' ? stripTrustWords(ownerName) : ownerName)
    if (!who) {
      // D16: no first name or initial left, so no person step can be asked. FastAppend on the
      // FULL name, as an entity.
      steps.push(entityStep(parcel, ownerName, warnings))
    } else {
      steps.push(...personSteps(parcel, who, warnings))
      if (!steps.length) {
        warnings.push(
          'No lookup key: neither a street and city nor a parcel id with county. ' +
          'Route to manual review.',
        )
      } else if (ownerType !== 'individual') {
        // D3: the full trust (or unreadable) name goes to FastAppend if both person steps missed.
        steps.push(entityStep(parcel, ownerName, warnings))
      }
    }
  }
```

In the Tier 1 `return`, replace `maxVendorCost: steps.reduce((a, s) => a + s.costOnHit, 0),` with:

```ts
    // Every step can bill: a person hit whose people are not the owner still costs the vendor
    // (D6), so the ceiling is the sum of the steps, not one of them.
    maxVendorCost: steps.reduce((a, s) => a + s.costOnHit, 0),
```

Add after `planRoute` (before the `splitPersonName` docblock):

```ts
const pushOnce = (warnings: string[], w: string): void => {
  if (!warnings.includes(w)) warnings.push(w)
}

/** D4: company name plus state of registration, no address. Also the D3 and D16 fallback. */
function entityStep(parcel: ParcelInput, name: string, warnings: string[]): RouteStep {
  const state = parcel.registrationState?.trim() || parcel.state
  if (!parcel.registrationState?.trim()) {
    pushOnce(
      warnings,
      'Sending the property state. FastAppend keys on STATE OF REGISTRATION; an out-of-state ' +
      'entity may miss. Measured: 13/22 entities matched using the property state.',
    )
  }
  pushOnce(
    warnings,
    'Read role and is_registered_agent on the response. A registered agent is a service of process, not necessarily a principal.',
  )
  return {
    kind: 'FASTAPPEND_ENTITY',
    endpoint: 'POST https://app.fastappend.com/v1/api/business-trace/lookup/',
    request: { company_name: name, state },
    costOnHit: VENDOR_COST.FASTAPPEND_ENTITY,
    freeOnMiss: true,
    why: 'company name plus state; no address needed',
  }
}

/** A first name or initial AND a last name, or null when the name leaves no such pair (D16). */
function personNameFor(name: string): { first_name: string; last_name: string } | null {
  const who = splitPersonName(name)
  return who.first_name && who.last_name ? who : null
}

/**
 * D2: the named Instant lookup when the record has a street and a city, then the parcel lookup
 * when it has a parcel id and county. executeRoute stops at the first contact, so the parcel step
 * runs only when there was no city or the Instant lookup found no contact. Both cost $0.10 on a
 * hit. The order comes from the evidence and the owner's decision, never from a claim about which
 * key is more accurate.
 */
function personSteps(
  parcel: ParcelInput,
  who: { first_name: string; last_name: string },
  warnings: string[],
): RouteStep[] {
  const steps: RouteStep[] = []
  if (hasSitus(parcel)) {
    steps.push({
      kind: 'TRACERFY_INSTANT_NAMED',
      endpoint: 'POST https://tracerfy.com/v1/api/trace/lookup/',
      request: {
        address: parcel.situsAddress, city: parcel.situsCity, state: parcel.situsState,
        ...(parcel.situsZip ? { zip: parcel.situsZip } : {}),
        find_owner: false, ...who,
      },
      costOnHit: VENDOR_COST.TRACERFY_INSTANT,
      freeOnMiss: true,
      why: 'named lookup at the street and city (D2, D13); not find_owner',
    })
    pushOnce(
      warnings,
      'Do NOT filter on property_owner. It returned false for the verified owner of record ' +
      'on an absentee-owned parcel. Match on the name instead.',
    )
    if (!parcel.situsZip?.trim()) {
      pushOnce(warnings, 'No zip. Tracerfy calls it strongly recommended; without it a similar address in the same city can match.')
    }
  }
  if (hasApn(parcel)) {
    steps.push({
      kind: 'TRACERFY_PARCEL_APN',
      endpoint: 'POST https://tracerfy.com/v1/api/trace/parcel/lookup/',
      // The names ride on the step for the NAME MATCH only. lookupPersonTrace sends Tracerfy
      // parcel_id, county and state and nothing else (docs/vendor/tracerfy-api.md:1352-1356).
      request: { parcel_id: parcel.parcelIdLocal, county: parcel.county, state: parcel.state, ...who },
      costOnHit: VENDOR_COST.TRACERFY_PARCEL,
      freeOnMiss: true,
      why: hasSitus(parcel)
        ? 'parcel lookup after the address lookup found no named contact (D2)'
        : 'parcel lookup; the record has no street and city (D2)',
    })
  }
  return steps
}
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run lib/routing`
Expected: PASS, 0 failed.

- [ ] **Step 5: Mutations (each: apply, run the named test, watch RED, restore, watch green)**

1. Put `TR|TTEE|TRS` back into `ENTITY_TRAILING` (and take `\bTR\.?$` out of `TRUST_MARKER`): `'classifies a trailing TR or TTEE as a trust'` goes red.
2. Replace `const who = personNameFor(...)` so it always returns `splitPersonName(...)`: `'D16: a trust that leaves no first name'` goes red.
3. Pass `ownerName` instead of `stripTrustWords(ownerName)`: `'trust: the person steps on the stripped name'` goes red.
4. Remove `...who` from the parcel step request: `'the parcel step carries the owner names'` goes red.
5. Delete the `else if (ownerType !== 'individual')` FastAppend push: the trust ladder test goes red.

Run for each: `npx vitest run lib/routing/__tests__/ownerRoute.test.ts`. Record the five results for the Task 12 table.

- [ ] **Step 6: Suite, History, commit**

Run: `npx vitest run` and `npx tsc --noEmit`. Expected: 0 failed, 0 errors. Any other failure is a test that pinned the old trust-only or exclusive-APN behaviour: fix its expectation to the new ladder only if the new behaviour is what spec 4.2 says, and name it in the History entry.

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 2: one classifier and the Tier 1 ladders.

- classifyOwnerName: a trailing TR, TRS or TTEE is a trust, not an entity, so trustee names reach
  the trust ladder. TRUST_MARKER also knows REVOCABLE, IRREVOCABLE, U/A and DTD.
- planRoute Tier 1: person gets the Instant lookup then the parcel lookup (D2); company gets
  FastAppend only (D4); trust and unknown get the person steps (trust words stripped) then
  FastAppend on the full name (D3); no first name or initial left goes to FastAppend only (D16).
  The parcel step now carries the owner names for the match. The "cheaper address-keyed path"
  warning is gone.
- A trust-only dossier owner now reaches FastAppend in the Tier 2 second pass (two executeRoute
  tests updated). Mutations: five, all red.
```

```bash
git add lib/routing/ownerRoute.ts lib/routing/__tests__/ownerRoute.test.ts lib/routing/__tests__/executeRoute.test.ts History.md tasks/todo.md
git commit -m "$(cat <<'EOF'
feat(routing): Tier 1 ladders for person, company, trust and unknown owners (spec 4.2, D16)

Tier 1 Phase 1, Task 2.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 3: D6 name match and the client's signals (spec 4.3, D6, D22, 5.1)

**Files:**
- Modify: `lib/routing/executeRoute.ts:69-76` (`ContactResult` gains four optional fields)
- Modify: `lib/tracerfy/client.ts:376-384` (helpers), `:464-508` (`parseBusinessTraceResponse`), `:518-523` (business refusals), `:569-614` (`parsePersonTraceResponse`), `:638-651` (person refusals)
- Create: `lib/tracerfy/__tests__/fixtures/apn-person-hit.json`, `lib/tracerfy/__tests__/fixtures/apn-miss.json`
- Modify: `lib/tracerfy/__tests__/fixtures/README.md` (append)
- Test: `lib/tracerfy/__tests__/contactLookups.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `ContactResult` gains `nameNotMatched?: boolean`, `people?: Array<{ first_name: string; last_name: string }>`, `creditsDeducted?: number`, `inputError?: boolean`.
  - `export function personMatchesName(person: Record<string, unknown>, want: { first_name?: string; last_name?: string }): boolean` in `lib/tracerfy/client.ts`.
  - `parsePersonTraceResponse` never falls back to `persons[0]`: a hit with no name-matched person returns `{ success: true, hit: true, contacts: null, nameNotMatched: true, people, creditsDeducted }`.
  - Every refusal of our own input (`lookupPersonTrace`: no name, no address/city/state, parcel without state; `lookupBusinessTrace`: blank name or state) returns `success: false, inputError: true`. A missing API key does not set `inputError`.

- [ ] **Step 1: Add the two constructed APN fixtures**

`lib/tracerfy/__tests__/fixtures/apn-person-hit.json`:

```json
{
  "request": { "parcel_id": "000-000-0000", "county": "Placeholder", "state": "ZZ" },
  "response": {
    "parcel_id": "000-000-0000",
    "county": "Placeholder",
    "state": "ZZ",
    "hit": true,
    "persons_count": 2,
    "credits_deducted": 5,
    "persons": [
      {
        "first_name": "Someoneelse",
        "last_name": "Different",
        "full_name": "Someoneelse Different",
        "dob": "",
        "age": "00",
        "deceased": false,
        "property_owner": false,
        "litigator": false,
        "mailing_address": { "street": "100 Placeholder Way", "city": "Redacted", "state": "ZZ", "zip": "00000" },
        "phones": [
          { "number": "5550000701", "type": "mobile", "dnc": false, "tcpa": false, "carrier": "Placeholder Wireless", "rank": 1 }
        ],
        "emails": [{ "email": "other@example.invalid", "rank": 1 }]
      },
      {
        "first_name": "Testowner",
        "last_name": "Placeholder",
        "full_name": "Testowner Placeholder",
        "dob": "",
        "age": "00",
        "deceased": false,
        "property_owner": true,
        "litigator": false,
        "mailing_address": { "street": "100 Placeholder Way", "city": "Redacted", "state": "ZZ", "zip": "00000" },
        "phones": [
          { "number": "5550000801", "type": "mobile", "dnc": false, "tcpa": false, "carrier": "Placeholder Wireless", "rank": 1 },
          { "number": "5550000802", "type": "landline", "dnc": false, "tcpa": false, "carrier": "Placeholder Telco", "rank": 2 }
        ],
        "emails": [{ "email": "apnowner@example.invalid", "rank": 1 }]
      }
    ],
    "meta": { "request_id": "req_00000000000000000000000000000006", "timestamp": "2026-09-21T00:00:00Z", "api_version": "2026-03-21" }
  }
}
```

`lib/tracerfy/__tests__/fixtures/apn-miss.json`:

```json
{
  "request": { "parcel_id": "999-999-9999", "county": "Placeholder", "state": "ZZ" },
  "response": {
    "parcel_id": "999-999-9999",
    "county": "Placeholder",
    "state": "ZZ",
    "hit": false,
    "persons_count": 0,
    "credits_deducted": 0,
    "persons": [],
    "meta": { "request_id": "req_00000000000000000000000000000007", "timestamp": "2026-09-21T00:00:00Z", "api_version": "2026-03-21" }
  }
}
```

Append to `lib/tracerfy/__tests__/fixtures/README.md`:

```markdown

---

# Parcel person-lookup fixtures, added for Tier 1 Phase 1

Two files for `POST tracerfy.com/v1/api/trace/parcel/lookup/`, which had no fixture. They are
CONSTRUCTED, not derived from a saved response: the envelope keys are the ones Phase 0 recorded for
this endpoint (`parcel_id, county, state, hit, persons_count, credits_deducted, persons, meta`,
tasks/phase0-small-sample.md) and the person object is copied key for key from `person-hit.json`.
Every value is a placeholder. Nothing here came from tasks/research-test/.

| File | Shape it exists to cover |
|---|---|
| `apn-person-hit.json` | A parcel hit returning two people. The owner we ask for is NOT `persons[0]`, and here `property_owner` is on the owner, the reverse of `person-hit.json`, so only a parser that trusts neither the order nor the flag passes both. |
| `apn-miss.json` | An unknown parcel id: HTTP 200, `hit:false`, `credits_deducted:0`, `persons: []`, the shape Phase 0 measured (t1_nothing_found). |
```

- [ ] **Step 2: Write the failing tests**

In `lib/tracerfy/__tests__/contactLookups.test.ts`, add the imports:

```ts
import apnHit from './fixtures/apn-person-hit.json'
import apnMiss from './fixtures/apn-miss.json'
```

and `personMatchesName` to the import from `'@/lib/tracerfy/client'`.

Replace the test `'takes the first person when there is no name to match on'` and the test `'falls back to the first person when the requested name is absent'` with:

```ts
  it('returns NO contacts when no person matches the owner name (D6)', () => {
    // A hit is somebody's phone numbers. If nobody returned is the owner, they are not the owner's.
    // MUTATION: put `?? persons[0]` back and this goes red.
    const res = parsePersonTraceResponse(personHit.response, { first_name: 'Nobody', last_name: 'Nothere' })
    expect(res).toMatchObject({ success: true, hit: true, contacts: null, nameNotMatched: true, creditsDeducted: 5 })
    expect(res.people).toEqual([
      { first_name: 'Someoneelse', last_name: 'Different' },
      { first_name: 'Testowner', last_name: 'Placeholder' },
    ])
  })

  it('refuses to pick a person when there is no name to match on (D6 removed persons[0])', () => {
    const res = parsePersonTraceResponse(personHit.response)
    expect(res.contacts).toBeNull()
    expect(res.nameNotMatched).toBe(true)
  })

  it.each([
    ['a stray comma', { first_name: 'Testowner,', last_name: 'Placeholder' }],
    ['a suffix', { first_name: 'Testowner', last_name: 'Placeholder Jr' }],
    ['upper case', { first_name: 'TESTOWNER', last_name: 'PLACEHOLDER' }],
    ['a middle initial', { first_name: 'Testowner Q', last_name: 'Placeholder' }],
    ['a first initial only', { first_name: 'T', last_name: 'Placeholder' }],
  ])('still matches the owner through %s (spec 4.3)', (_why, want) => {
    // MUTATION: drop the punctuation strip or the suffix filter in nameTokens and a row goes red.
    expect(parsePersonTraceResponse(personHit.response, want).contacts?.ownerName).toBe('Testowner Placeholder')
  })

  it('does not swap first and last name (D22 keeps single-trace name order)', () => {
    // MUTATION: accept the reversed pair as a match and this goes red.
    const res = parsePersonTraceResponse(personHit.response, { first_name: 'Placeholder', last_name: 'Testowner' })
    expect(res.contacts).toBeNull()
    expect(res.nameNotMatched).toBe(true)
  })

  it('personMatchesName needs both halves of both names', () => {
    expect(personMatchesName({ first_name: 'Testowner', last_name: 'Placeholder' }, { last_name: 'Placeholder' })).toBe(false)
    expect(personMatchesName({ first_name: '', last_name: 'Placeholder' }, { first_name: 'T', last_name: 'Placeholder' })).toBe(false)
  })
```

Change the three exact-equality expectations that now also carry the vendor's credits:
- `'a hit with no people and no company contacts returns no contacts, still a hit'`: `expect(res).toEqual({ success: true, hit: true, contacts: null, creditsDeducted: 1 })`
- the FastAppend 404 test that expects a miss: `expect(res).toEqual({ success: true, hit: false, contacts: null, creditsDeducted: 0 })`
- `'a miss is an answer'` (person): `expect(res).toEqual({ success: true, hit: false, contacts: null, creditsDeducted: 0 })`

Append these describes:

```ts
describe('the parcel lookup, trace/parcel/lookup/ (spec 4.2)', () => {
  const APN_PERSON = {
    first_name: 'Testowner', last_name: 'Placeholder',
    parcel_id: '000-000-0000', county: 'Placeholder', state: 'ZZ',
  }

  it('sends Tracerfy only parcel_id, county and state, whatever names ride on the step (L-020)', async () => {
    // A malformed parcel key is a FREE, SILENT miss, so the request shape is pinned.
    // MUTATION: add first_name and last_name to the parcel payload and this goes red.
    fetchMock.mockResolvedValue(okResponse(apnHit.response))
    await lookupPersonTrace(APN_PERSON)
    expect(fetchMock.mock.calls[0][0]).toBe(TRACERFY_PARCEL_URL)
    expect(sentBody()).toEqual({ parcel_id: '000-000-0000', county: 'Placeholder', state: 'ZZ' })
  })

  it('matches the owner by name among the people a parcel returns', async () => {
    fetchMock.mockResolvedValue(okResponse(apnHit.response))
    const res = await lookupPersonTrace(APN_PERSON)
    expect(res.contacts?.ownerName).toBe('Testowner Placeholder')
    expect(res.contacts?.emails).toEqual(['apnowner@example.invalid'])
    expect(res.creditsDeducted).toBe(5)
  })

  it('an unknown parcel id is an ordinary free miss, so the next step runs', async () => {
    fetchMock.mockResolvedValue(okResponse(apnMiss.response))
    expect(await lookupPersonTrace(APN_PERSON)).toEqual({ success: true, hit: false, contacts: null, creditsDeducted: 0 })
  })
})

describe('our own input problems are refusals, never vendor failures (spec 5.1)', () => {
  it.each([
    ['a nameless address lookup', { ...PERSON, first_name: '', last_name: '' }],
    ['an address lookup with no city', { ...PERSON, city: '' }],
    ['a parcel lookup with no state', { first_name: 'Testowner', last_name: 'Placeholder', parcel_id: '1', county: 'X', state: '' }],
  ])('%s is refused before spending and marked inputError', async (_why, req) => {
    // MUTATION: return contactFailure instead of inputRefused at that refusal and this goes red.
    const res = await lookupPersonTrace(req)
    expect(res).toMatchObject({ success: false, inputError: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a business trace with no state is refused the same way', async () => {
    const res = await lookupBusinessTrace({ company_name: 'X Llc', state: ' ' })
    expect(res).toMatchObject({ success: false, inputError: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a missing API key is NOT an input error: the customer did nothing wrong', async () => {
    delete process.env.TRACERFY_API_KEY
    expect((await lookupPersonTrace(PERSON)).inputError).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run lib/tracerfy/__tests__/contactLookups.test.ts`
Expected: FAIL (`personMatchesName` is not exported; the D6 tests get `persons[0]`; the refusals carry no `inputError`; the credits are absent).

- [ ] **Step 4: Implement**

In `lib/routing/executeRoute.ts`, replace the `ContactResult` interface with:

```ts
export interface ContactResult {
  /** False ONLY when we could not ask. A no-match is success:true, hit:false. */
  success: boolean
  /** True when the vendor matched. A hit costs the step's costOnHit; a miss is free. */
  hit: boolean
  contacts: OwnerContacts | null
  error?: string
  /**
   * D6: the vendor returned people and none matched the owner's name. The vendor billed the hit,
   * nothing is returned, and the route moves on to its next step. Tracerfy person lookups only.
   */
  nameNotMatched?: boolean
  /** The names the vendor returned on that billed non-match. Internal: the step log only. */
  people?: Array<{ first_name: string; last_name: string }>
  /** `credits_deducted` exactly as the vendor reported it, when it did. */
  creditsDeducted?: number
  /**
   * The client refused OUR request before spending: no name, no city, no state. Never a vendor
   * failure, so never busy_try_again (spec 5.1). `success` is false alongside it.
   */
  inputError?: boolean
}
```

In `lib/tracerfy/client.ts`, after `const MISSED: ContactResult = { success: true, hit: false, contacts: null };` add:

```ts
/** OUR input, refused before spending. Not a vendor failure: executeRoute never reports it busy. */
const inputRefused = (error: string): ContactResult => ({ ...contactFailure(error), inputError: true });

/** `credits_deducted` as the vendor reported it. Read, never inferred from `hit`. */
const creditsOf = (body: Record<string, unknown>): { creditsDeducted?: number } =>
  typeof body.credits_deducted === 'number' ? { creditsDeducted: body.credits_deducted } : {};

/** The generational suffixes a name match ignores (spec 4.3). */
const NAME_SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV']);

/**
 * A name as comparable tokens: upper case, letters and spaces only (a stray comma, a period, an
 * apostrophe or a hyphen is dropped), generational suffixes removed.
 */
function nameTokens(v: unknown): string[] {
  return text(v)
    .toUpperCase()
    .replace(/[^A-Z\s]/g, '')
    .split(/\s+/)
    .filter((t) => t !== '' && !NAME_SUFFIXES.has(t));
}

/**
 * D6 (spec 4.3): is this returned person the owner we asked about?
 *
 * The last word of each last name must be equal and the first names must share a first letter.
 * Only the first word of a first name is read, so a middle name or initial on either side does not
 * matter. The ORDER is not swapped: single traces keep today's name order (D22), so an owner asked
 * as first SMITH, last JOHN does not match a vendor JOHN SMITH.
 */
export function personMatchesName(
  person: Record<string, unknown>,
  want: { first_name?: string; last_name?: string }
): boolean {
  const wantLast = nameTokens(want.last_name);
  const wantFirst = nameTokens(want.first_name);
  const gotLast = nameTokens(person.last_name);
  const gotFirst = nameTokens(person.first_name);
  if (!wantLast.length || !wantFirst.length || !gotLast.length || !gotFirst.length) return false;
  return (
    wantLast[wantLast.length - 1] === gotLast[gotLast.length - 1] &&
    wantFirst[0].charAt(0) === gotFirst[0].charAt(0)
  );
}
```

In `parseBusinessTraceResponse`, replace `if (!body.hit) return MISSED;` with:

```ts
  const credits = creditsOf(body);
  if (!body.hit) return { ...MISSED, ...credits };
```

and add `...credits,` as the last property of each of its three hit returns (the principal return, `{ success: true, hit: true, contacts: null }`, and the company-level return).

In `lookupBusinessTrace`, change `return contactFailure('Business trace requires a company name and a state');` to `return inputRefused('Business trace requires a company name and a state');`.

Replace `parsePersonTraceResponse` (its docblock too) with:

```ts
/**
 * Parse a Tracerfy trace/lookup/ or trace/parcel/lookup/ body. One parser: the two endpoints
 * return the same envelope, `{ hit, persons_count, persons[], credits_deducted }`, and differ only
 * in the request keys echoed back.
 *
 * `want` is the owner we asked about. A person counts ONLY when they match it (D6, spec 4.3):
 * never `property_owner` (trap 3) and never `persons[0]`.
 */
export function parsePersonTraceResponse(
  body: unknown,
  want?: { first_name?: string; last_name?: string }
): ContactResult {
  // The research harness saw an array wrapper on this endpoint once; unwrap it.
  const one = Array.isArray(body) ? body[0] : body;
  if (!isObj(one)) return contactFailure('Malformed person trace response');
  if (typeof one.hit !== 'boolean') return contactFailure('Person trace response missing hit flag');
  const credits = creditsOf(one);
  if (!one.hit) return { ...MISSED, ...credits };

  const persons = Array.isArray(one.persons) ? one.persons.filter(isObj) : [];
  if (!persons.length) return { success: true, hit: true, contacts: null, ...credits };

  // D6. NO persons[0] FALLBACK. A hit whose people do not include the owner is somebody else's
  // phone numbers. The vendor still billed us, so the step log keeps the answer; the customer
  // gets nothing and pays nothing, and the route moves on to its next step.
  const person = want ? persons.find((p) => personMatchesName(p, want)) : undefined;
  if (!person) {
    return {
      success: true,
      hit: true,
      contacts: null,
      nameNotMatched: true,
      people: persons.map((p) => ({ first_name: text(p.first_name), last_name: text(p.last_name) })),
      ...credits,
    };
  }

  return {
    success: true,
    hit: true,
    contacts: {
      ownerName: fullName(person) || null,
      phones: readPhones(person.phones),
      emails: readEmails(person.emails),
      mailingAddress: flattenMailing(person.mailing_address),
    },
    ...credits,
  };
}
```

In `lookupPersonTrace`, change the three refusals: `return contactFailure('Parcel lookup requires a state');`, `return contactFailure('Person trace requires a first or last name');` and `return contactFailure('Person trace requires address, city and state');` each to `return inputRefused(...)` with the same message. Leave `'Tracerfy API key not configured'` as `contactFailure`.

- [ ] **Step 5: Run to see them pass**

Run: `npx vitest run lib/tracerfy lib/routing`
Expected: PASS, 0 failed.

- [ ] **Step 6: Mutations**

1. In `parsePersonTraceResponse` use `const person = (want ? persons.find(...) : undefined) ?? persons[0]`: `'returns NO contacts when no person matches'` goes red.
2. Remove `.replace(/[^A-Z\s]/g, '')` from `nameTokens`: the `'a stray comma'` row goes red. Separately remove `&& !NAME_SUFFIXES.has(t)`: the `'a suffix'` row goes red.
3. Make `personMatchesName` also return true when `wantLast` equals the got FIRST name and `wantFirst` shares the got last name's initial: `'does not swap first and last name'` goes red.
4. Change the `'Person trace requires address, city and state'` refusal back to `contactFailure`: the `'an address lookup with no city'` row goes red. Repeat for each of the other three refusals (L-018: every site).
5. Add `first_name: req.first_name, last_name: req.last_name` to the parcel payload: `'sends Tracerfy only parcel_id, county and state'` goes red.

Run: `npx vitest run lib/tracerfy/__tests__/contactLookups.test.ts` for each.

- [ ] **Step 7: Suite, History, commit**

Run: `npx vitest run` and `npx tsc --noEmit`. Expected: 0 failed, 0 errors. (The route suites mock the clients, so they do not see the parser; the Tier 2 cron mocks them too.)

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 3: D6 name match, no persons[0] fallback.

- parsePersonTraceResponse returns a person only when the name matches the owner we asked about
  (last name equal, first initial equal, after dropping case, punctuation, JR/SR/II/III/IV and
  middle names; order not swapped, D22). A hit with no match returns no contacts, nameNotMatched,
  the returned names and the vendor's credits, for the step log.
- Both contact parsers read credits_deducted. Every refusal of our own input (no name, no city, no
  state) is marked inputError so it can never be reported busy.
- New constructed fixtures for trace/parcel/lookup/ (hit and miss); the parcel request shape is
  pinned to parcel_id, county and state. Mutations: all red.
```

```bash
git add lib/routing/executeRoute.ts lib/tracerfy/client.ts lib/tracerfy/__tests__/contactLookups.test.ts lib/tracerfy/__tests__/fixtures/apn-person-hit.json lib/tracerfy/__tests__/fixtures/apn-miss.json lib/tracerfy/__tests__/fixtures/README.md History.md tasks/todo.md
git commit -m "$(cat <<'EOF'
feat(tracerfy): D6 name match with no persons[0] fallback; credits and input refusals

Tier 1 Phase 1, Task 3.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Per-call vendor timeouts (D7)

**Files:**
- Modify: `lib/constants.ts` (append `VENDOR_TIMEOUT` after the `FASTAPPEND` block)
- Create: `lib/tracerfy/fetchWithTimeout.ts`
- Modify: `lib/tracerfy/client.ts` (`lookupBusinessTrace`, `lookupPersonTrace`), `lib/tracerfy/dossier.ts` (`lookupDossier`)
- Test: create `lib/tracerfy/__tests__/fetchWithTimeout.test.ts`; modify `lib/tracerfy/__tests__/contactLookups.test.ts`, `lib/tracerfy/__tests__/dossier.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export const VENDOR_TIMEOUT = { CALL_MS: 25_000, SINGLE_ROUTE_BUDGET_MS: 50_000, MIN_CALL_MS: 5_000 } as const` (`lib/constants.ts`)
  - `export interface VendorCallOptions { timeoutMs?: number }`, `export class VendorTimeoutError extends Error`, `export interface TimedResponse { status: number; ok: boolean; text: string }`, `export async function fetchTextWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<TimedResponse>`, `export function callTimeoutMs(requested?: number): number` (`lib/tracerfy/fetchWithTimeout.ts`)
  - `lookupPersonTrace(req, opts?: VendorCallOptions)`, `lookupBusinessTrace(req, opts?: VendorCallOptions)`, `lookupDossier(key, opts?: VendorCallOptions)`. A timeout returns the client's normal failure shape with error `Tracerfy did not answer within 25 s`, `FastAppend did not answer within 25 s` or `Tracerfy dossier did not answer within 25 s` (the seconds follow the timeout used).

- [ ] **Step 1: Write the failing tests**

Create `lib/tracerfy/__tests__/fetchWithTimeout.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callTimeoutMs, fetchTextWithTimeout, VendorTimeoutError } from '@/lib/tracerfy/fetchWithTimeout'
import { VENDOR_TIMEOUT } from '@/lib/constants'

/** A fetch that never answers, and rejects only when its signal aborts, as the real one does. */
const hangingFetch = () =>
  vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        )
      })
  )

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('fetchTextWithTimeout', () => {
  it('aborts a call that never answers and says it timed out', async () => {
    // MUTATION: delete the setTimeout that aborts, and this test hangs until vitest fails it.
    vi.stubGlobal('fetch', hangingFetch())
    const pending = fetchTextWithTimeout('https://vendor.example.invalid/x', { method: 'POST' }, 1_000)
    const settled = expect(pending).rejects.toBeInstanceOf(VendorTimeoutError)
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
  })

  it('reads the body inside the timed window and returns status and text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 404, ok: false, text: async () => '{"hit":false}' }) as unknown as Response)
    )
    await expect(fetchTextWithTimeout('https://vendor.example.invalid/x', {}, 1_000)).resolves.toEqual({
      status: 404,
      ok: false,
      text: '{"hit":false}',
    })
  })

  it('passes a real transport error through unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(fetchTextWithTimeout('https://vendor.example.invalid/x', {}, 1_000)).rejects.toThrow('fetch failed')
  })
})

describe('callTimeoutMs', () => {
  it('never exceeds the per-call ceiling and honours a tighter request budget', () => {
    // MUTATION: return `requested` unclamped and the 60_000 row goes red.
    expect(callTimeoutMs()).toBe(VENDOR_TIMEOUT.CALL_MS)
    expect(callTimeoutMs(60_000)).toBe(VENDOR_TIMEOUT.CALL_MS)
    expect(callTimeoutMs(7_000)).toBe(7_000)
    expect(callTimeoutMs(0)).toBe(VENDOR_TIMEOUT.CALL_MS)
  })
})
```

Append to `lib/tracerfy/__tests__/contactLookups.test.ts` (add `import { VENDOR_TIMEOUT } from '@/lib/constants'` at the top):

```ts
describe('the per-call ceiling (D7: a timeout is a vendor failure, never a miss)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const hang = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })

  it('ends a hung Tracerfy person lookup as a FAILURE', async () => {
    // MUTATION: call fetch directly in lookupPersonTrace instead of fetchTextWithTimeout and this hangs red.
    vi.useFakeTimers()
    fetchMock.mockImplementation(hang)
    const pending = lookupPersonTrace(PERSON)
    await vi.advanceTimersByTimeAsync(VENDOR_TIMEOUT.CALL_MS)
    const res = await pending
    expect(res).toMatchObject({ success: false, hit: false, contacts: null, error: 'Tracerfy did not answer within 25 s' })
    expect(res.inputError).toBeUndefined()
  })

  it('ends a hung FastAppend lookup as a FAILURE', async () => {
    // MUTATION: call fetch directly in lookupBusinessTrace and this hangs red.
    vi.useFakeTimers()
    fetchMock.mockImplementation(hang)
    const pending = lookupBusinessTrace(ENTITY)
    await vi.advanceTimersByTimeAsync(VENDOR_TIMEOUT.CALL_MS)
    expect(await pending).toMatchObject({ success: false, error: 'FastAppend did not answer within 25 s' })
  })

  it('honours a tighter budget from the caller', async () => {
    // MUTATION: ignore opts.timeoutMs in lookupPersonTrace and this goes red at 5 s.
    vi.useFakeTimers()
    fetchMock.mockImplementation(hang)
    const pending = lookupPersonTrace(PERSON, { timeoutMs: 5_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toMatchObject({ success: false, error: 'Tracerfy did not answer within 5 s' })
  })
})
```

Append to `lib/tracerfy/__tests__/dossier.test.ts` (add `import { VENDOR_TIMEOUT } from '@/lib/constants'`):

```ts
describe('lookupDossier: the per-call ceiling (D7)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ends a hung dossier call as a FAILURE, never a miss', async () => {
    // MUTATION: call fetch directly in lookupDossier and this hangs red.
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    const pending = lookupDossier(APN_KEY)
    await vi.advanceTimersByTimeAsync(VENDOR_TIMEOUT.CALL_MS)
    const result = await pending
    expect(result).toMatchObject({ success: false, hit: false, error: 'Tracerfy dossier did not answer within 25 s' })
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run lib/tracerfy`
Expected: FAIL (`@/lib/tracerfy/fetchWithTimeout` does not exist; the hung-client tests time out).

- [ ] **Step 3: Implement**

Append to `lib/constants.ts`, after the `FASTAPPEND` block:

```ts
/**
 * Vendor call ceilings (spec D7, Tier 1 Phase 1). The arithmetic is in
 * docs/superpowers/plans/2026-09-21-tier1-phase1-single-traces.md, "Latency budget".
 *
 * CALL_MS                 one vendor call. Phase 0's slowest REAL answer was an Instant lookup
 *                         at 20.4 s; this is that plus about 20 percent.
 * SINGLE_ROUTE_BUDGET_MS  a single-trace route starts no vendor call after this long, which
 *                         leaves 10 s of its 60 s maxDuration for our own writes.
 * MIN_CALL_MS             a call is not started with less budget than this left.
 */
export const VENDOR_TIMEOUT = {
  CALL_MS: 25_000,
  SINGLE_ROUTE_BUDGET_MS: 50_000,
  MIN_CALL_MS: 5_000,
} as const;
```

Create `lib/tracerfy/fetchWithTimeout.ts`:

```ts
/**
 * One vendor HTTP call with a ceiling (spec D7).
 *
 * WHY THE BODY IS READ IN HERE. A vendor can send its headers promptly and then stall the body.
 * A timer cleared when fetch() resolves would not cover that, so the text is read inside the same
 * window and the caller parses the string.
 *
 * A call that runs out of time throws VendorTimeoutError, and each client turns that into its own
 * failure shape. A timeout is a vendor FAILURE: free, never a miss, and on a Tier 1 record it ends
 * busy_try_again.
 */
import { VENDOR_TIMEOUT } from '@/lib/constants';

/** What a caller with a request budget may ask of a vendor client. */
export interface VendorCallOptions {
  /** A tighter ceiling than VENDOR_TIMEOUT.CALL_MS. Never a looser one. */
  timeoutMs?: number;
}

export class VendorTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`did not answer within ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'VendorTimeoutError';
  }
}

export interface TimedResponse {
  status: number;
  ok: boolean;
  text: string;
}

/** The ceiling a client applies: the caller's when it is tighter, never looser. */
export function callTimeoutMs(requested?: number): number {
  return typeof requested === 'number' && requested > 0
    ? Math.min(requested, VENDOR_TIMEOUT.CALL_MS)
    : VENDOR_TIMEOUT.CALL_MS;
}

export async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<TimedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  } catch (error) {
    if (controller.signal.aborted) throw new VendorTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
```

In `lib/tracerfy/client.ts` add to the imports:

```ts
import {
  callTimeoutMs,
  fetchTextWithTimeout,
  VendorTimeoutError,
  type VendorCallOptions,
} from '@/lib/tracerfy/fetchWithTimeout';
```

Change the signature of `lookupBusinessTrace` to `export async function lookupBusinessTrace(req: EntityTraceRequest, opts: VendorCallOptions = {}): Promise<ContactResult> {` and replace its whole `try { ... } catch (error) { ... }` block with (keep the long 404 comment above the `>= 500` check):

```ts
  try {
    const res = await fetchTextWithTimeout(
      `${FASTAPPEND.BASE_URL}business-trace/lookup/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ company_name: req.company_name, state: req.state }),
      },
      callTimeoutMs(opts.timeoutMs)
    );

    if (res.status >= 500) {
      console.error('FastAppend business trace lookup error:', res.status, res.text);
      return contactFailure(transportError('FastAppend', res.status));
    }

    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      console.error('FastAppend business trace lookup error:', res.status, res.text);
      return contactFailure('Malformed business trace response');
    }

    return parseBusinessTraceResponse(body);
  } catch (error) {
    if (error instanceof VendorTimeoutError) return contactFailure(`FastAppend ${error.message}`);
    console.error('FastAppend business trace lookup error:', error);
    return contactFailure('FastAppend service unavailable');
  }
```

Change the signature of `lookupPersonTrace` to `export async function lookupPersonTrace(req: PersonTraceRequest, opts: VendorCallOptions = {}): Promise<ContactResult> {` and replace its `try { ... } catch` block with:

```ts
  try {
    const res = await fetchTextWithTimeout(
      `${baseUrl}${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      },
      callTimeoutMs(opts.timeoutMs)
    );

    if (!res.ok) {
      console.error('Tracerfy person lookup error:', res.status, res.text);
      return contactFailure(transportError('Tracerfy', res.status));
    }

    return parsePersonTraceResponse(JSON.parse(res.text), {
      first_name: req.first_name,
      last_name: req.last_name,
    });
  } catch (error) {
    if (error instanceof VendorTimeoutError) return contactFailure(`Tracerfy ${error.message}`);
    console.error('Tracerfy person lookup error:', error);
    return contactFailure('Tracerfy service unavailable');
  }
```

In `lib/tracerfy/dossier.ts` add:

```ts
import {
  callTimeoutMs,
  fetchTextWithTimeout,
  VendorTimeoutError,
  type VendorCallOptions,
} from './fetchWithTimeout'
```

change the signature to `export async function lookupDossier(key: DossierKey, opts: VendorCallOptions = {}): Promise<DossierResult> {` and replace its `try { ... } catch` block with:

```ts
  try {
    const res = await fetchTextWithTimeout(
      `${baseUrl}${ENDPOINT_PATH}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildDossierRequest(key)),
      },
      callTimeoutMs(opts.timeoutMs)
    )

    if (!res.ok) {
      console.error('Tracerfy dossier lookup error:', res.status, res.text)

      if (res.status === 429) {
        // The 500/min counter is SHARED with the other Tracerfy lookup endpoints, so this
        // can fire even when the dossier itself is running well under its own volume.
        return failure('Rate limit exceeded. Please wait a moment before trying again.')
      }
      if (res.status === 503) {
        return failure('Tracerfy service unavailable (503)')
      }
      if (res.status === 401 || res.status === 403) {
        return failure(`Tracerfy auth failed (${res.status})`)
      }

      return failure(`Dossier lookup failed (${res.status})`)
    }

    return parseDossierResponse(JSON.parse(res.text))
  } catch (error) {
    if (error instanceof VendorTimeoutError) return failure(`Tracerfy dossier ${error.message}`)
    console.error('Tracerfy dossier lookup error:', error)
    return failure('Tracerfy service unavailable')
  }
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run lib/tracerfy`
Expected: PASS, 0 failed.

- [ ] **Step 5: Mutations**

1. In `fetchTextWithTimeout` delete `const timer = setTimeout(() => controller.abort(), timeoutMs);` and its `clearTimeout`: `'aborts a call that never answers'` and the three client ceiling tests go red (by timeout).
2. In `lookupPersonTrace` replace the `fetchTextWithTimeout(...)` call with `await fetch(\`${baseUrl}${path}\`, { method: 'POST', headers: { Authorization: \`Bearer ${apiKey}\`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) }).then(async (r) => ({ status: r.status, ok: r.ok, text: await r.text() }))`: `'ends a hung Tracerfy person lookup as a FAILURE'` goes red. Do the same mutation in `lookupBusinessTrace` and in `lookupDossier` (L-018, all three clients); each one's own test goes red.
3. Replace `callTimeoutMs(opts.timeoutMs)` with `callTimeoutMs()` in `lookupPersonTrace`: `'honours a tighter budget'` goes red.
4. In `callTimeoutMs` return `requested` unclamped when given: the `60_000` row goes red.

- [ ] **Step 6: Suite, History, commit**

Run: `npx vitest run` and `npx tsc --noEmit`. Expected: 0 failed, 0 errors.

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 4: a 25 second ceiling on every vendor call.

- New lib/tracerfy/fetchWithTimeout.ts: an AbortController fetch that reads the body inside the
  window. The Tracerfy person, FastAppend and dossier clients use it; a call not answered in
  25 s (Phase 0's slowest real answer was 20.4 s) is a vendor failure, never a miss.
- Each client takes an optional tighter timeout from a caller with a request budget.
  VENDOR_TIMEOUT in lib/constants.ts. Mutations: every client, all red.
```

```bash
git add lib/constants.ts lib/tracerfy/fetchWithTimeout.ts lib/tracerfy/client.ts lib/tracerfy/dossier.ts lib/tracerfy/__tests__/fetchWithTimeout.test.ts lib/tracerfy/__tests__/contactLookups.test.ts lib/tracerfy/__tests__/dossier.test.ts History.md tasks/todo.md
git commit -m "$(cat <<'EOF'
feat(tracerfy): per-call vendor timeout on the person, FastAppend and dossier clients (D7)

Tier 1 Phase 1, Task 4.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The step log, resend reuse and the request budget (spec 4.3, 5.1, 5.2)

**Waits on Q1** only for one line of `runStage`; the plan below is option (a).

**Files:**
- Modify: `lib/routing/executeRoute.ts` (types `:98-128`, `contactVendorFrom` `:176-201`, `callVendor` `:256-318`, `runStage` `:320-373`, `executeRoute` signature and its two `runStage` calls `:415-513`)
- Test: `lib/routing/__tests__/executeRoute.test.ts`

**Interfaces:**
- Consumes: `ContactResult.nameNotMatched`, `.people`, `.creditsDeducted`, `.inputError` (Task 3); `VendorCallOptions` from `lib/tracerfy/fetchWithTimeout` and `VENDOR_TIMEOUT` (Task 4).
- Produces:
  - `RouteDeps` members take an optional second argument `opts?: VendorCallOptions`, passed only when the caller set a deadline.
  - `StepOutcome = 'hit' | 'miss' | 'name_not_matched' | 'failed' | 'skipped'`.
  - `StepReport` gains `at?: string`, `requestKey?: string`, `people?: Array<{ first_name: string; last_name: string }>`, `noContacts?: boolean`, `reused?: boolean` (`creditsDeducted` now set on contact steps too).
  - `export interface ExecuteOptions { deadlineMs?: number; priorSteps?: StepReport[] | null; now?: () => number }`
  - `export const STEP_REUSE_WINDOW_MS = 86_400_000`
  - `export function requestKeyFor(step: RouteStep): string`
  - `export function stepLogFrom(raw: unknown): StepReport[]`
  - `executeRoute(plan: RoutePlan, deps: RouteDeps, options?: ExecuteOptions): Promise<ExecutionResult>`
  - A contact step ends its stage only with a name-matched phone or email. `contactVendorFrom` names the vendor that produced the contacts when one did, else the first vendor asked.

- [ ] **Step 1: Write the failing tests**

In `lib/routing/__tests__/executeRoute.test.ts`, extend the import from `'../executeRoute'` with `requestKeyFor, stepLogFrom, STEP_REUSE_WINDOW_MS, type StepReport`, and add after the `deps` helper:

```ts
/** Resolve the nth contact call's result, then miss. */
const contactSequence = (...results: ContactResult[]) => {
  const fn = vi.fn()
  for (const r of results) fn.mockResolvedValueOnce(r)
  fn.mockResolvedValue(CONTACT_MISS)
  return fn as unknown as RouteDeps['tracePerson']
}
```

Append:

```ts
describe('executeRoute: the Tier 1 ladder and its step log (spec 4.3, 5.2)', () => {
  const NOW = Date.parse('2026-09-22T12:00:00.000Z')
  const clock = () => NOW
  /** parcel() carries a street, a city and a parcel id: Instant, then the parcel lookup. */
  const personPlan = () => planRoute(parcel({ ownerName: 'Marcus T Halloway' }), 'wallet')

  const NOT_MATCHED: ContactResult = {
    success: true, hit: true, contacts: null, nameNotMatched: true,
    people: [{ first_name: 'Someoneelse', last_name: 'Different' }], creditsDeducted: 5,
  }
  const CONTACTLESS: ContactResult = {
    success: true, hit: true,
    contacts: { ownerName: 'Marcus Halloway', phones: [], emails: [], mailingAddress: null },
  }

  it('moves on after a person hit whose people are not the owner (D6)', async () => {
    // MUTATION: end the stage on any contact hit (`if (call.hit) hit = call`) and this goes red.
    const d = deps({ tracePerson: contactSequence(NOT_MATCHED, CONTACT_HIT) })
    const r = await executeRoute(personPlan(), d, { now: clock })
    expect(r.steps.map(s => [s.kind, s.outcome])).toEqual([
      ['TRACERFY_INSTANT_NAMED', 'name_not_matched'],
      ['TRACERFY_PARCEL_APN', 'hit'],
    ])
    expect(r.steps[0]).toMatchObject({
      cost: VENDOR_COST.TRACERFY_INSTANT, creditsDeducted: 5,
      people: [{ first_name: 'Someoneelse', last_name: 'Different' }],
    })
    expect(r.contactsFound).toBe(true)
    expect(r.vendorSpend).toBe(0.2)
  })

  it('moves on after a matched hit that carries no phone and no email (Q1 a)', async () => {
    // MUTATION: end the stage on any contact hit and this goes red.
    const d = deps({ tracePerson: contactSequence(CONTACTLESS, CONTACT_MISS) })
    const r = await executeRoute(personPlan(), d, { now: clock })
    expect(d.tracePerson).toHaveBeenCalledTimes(2)
    expect(r.steps[0]).toMatchObject({ outcome: 'hit', noContacts: true })
    expect(r.contactsFound).toBe(false)
    expect(r.contacts).toBeNull()
  })

  it('stamps every asked step with the time and the exact question it answered', async () => {
    const plan = personPlan()
    const r = await executeRoute(plan, deps(), { now: clock })
    expect(r.steps.map(s => s.at)).toEqual(['2026-09-22T12:00:00.000Z', '2026-09-22T12:00:00.000Z'])
    expect(r.steps.map(s => s.requestKey)).toEqual(plan.steps.map(requestKeyFor))
  })

  it('treats our own refused request as not asked, never as a vendor failure (spec 5.1)', async () => {
    // MUTATION: delete the inputError branch in runStage and success flips to false.
    const refused: ContactResult = {
      success: false, hit: false, contacts: null,
      error: 'Person trace requires address, city and state', inputError: true,
    }
    const d = deps({ tracePerson: contactSequence(refused, CONTACT_HIT) })
    const r = await executeRoute(personPlan(), d, { now: clock })
    expect(r.success).toBe(true)
    expect(r.steps[0]).toMatchObject({ outcome: 'skipped', cost: 0 })
    expect(r.steps[0].note).toMatch(/not sent/)
    expect(r.steps[1].outcome).toBe('hit')
  })

  it('does not start a call it cannot finish inside the request budget', async () => {
    // MUTATION: delete the MIN_CALL_MS check and tracePerson is called twice.
    let t = NOW
    const d = deps({ tracePerson: vi.fn(async () => { t += 46_000; return CONTACT_MISS }) })
    const r = await executeRoute(personPlan(), d, { now: () => t, deadlineMs: NOW + 50_000 })
    expect(d.tracePerson).toHaveBeenCalledTimes(1)
    expect(r.success).toBe(false)
    expect(r.steps[1]).toMatchObject({ kind: 'TRACERFY_PARCEL_APN', outcome: 'failed' })
    expect(r.steps[1].error).toMatch(/ran out of time/)
  })

  it('gives each call only the budget that is left', async () => {
    const d = deps()
    await executeRoute(personPlan(), d, { now: clock, deadlineMs: NOW + 40_000 })
    expect(d.tracePerson).toHaveBeenNthCalledWith(1, expect.anything(), { timeoutMs: 40_000 })
  })

  it('calls the vendors with ONE argument when there is no budget (the crons)', async () => {
    const d = deps()
    await executeRoute(personPlan(), d, { now: clock })
    expect(vi.mocked(d.tracePerson).mock.calls[0]).toHaveLength(1)
  })

  describe('a resend reuses what already answered (spec 5.2)', () => {
    const logged = (
      plan: ReturnType<typeof personPlan>, ageMs: number, outcome: StepReport['outcome'] = 'miss',
    ): StepReport[] => [{
      kind: 'TRACERFY_INSTANT_NAMED', outcome, cost: 0,
      at: new Date(NOW - ageMs).toISOString(), requestKey: requestKeyFor(plan.steps[0]),
    }]

    it('does not buy an answered step again inside 24 hours', async () => {
      // MUTATION: skip the reusableAnswer lookup and the Instant step is bought again.
      const plan = personPlan()
      const d = deps()
      const r = await executeRoute(plan, d, { now: clock, priorSteps: logged(plan, 60 * 60 * 1000) })
      expect(d.tracePerson).toHaveBeenCalledTimes(1)
      expect(d.tracePerson).toHaveBeenCalledWith(expect.objectContaining({ parcel_id: '16183060290000' }))
      expect(r.steps[0]).toMatchObject({ outcome: 'miss', reused: true })
      // The entry keeps its OWN time, so the 24 hours run from the original answer.
      expect(r.steps[0].at).toBe(new Date(NOW - 60 * 60 * 1000).toISOString())
    })

    it('buys it again once the answer is 24 hours old', async () => {
      // MUTATION: drop the age test in reusableAnswer and this goes red.
      const plan = personPlan()
      const d = deps()
      await executeRoute(plan, d, { now: clock, priorSteps: logged(plan, STEP_REUSE_WINDOW_MS) })
      expect(d.tracePerson).toHaveBeenCalledTimes(2)
    })

    it('never reuses an answer to a different question', async () => {
      // MUTATION: match on the step kind alone and this goes red.
      const plan = personPlan()
      const other = planRoute(parcel({ ownerName: 'Gerald Pentland' }), 'wallet')
      const d = deps()
      await executeRoute(plan, d, { now: clock, priorSteps: logged(other, 1000) })
      expect(d.tracePerson).toHaveBeenCalledTimes(2)
    })

    it('never reuses a failed step', async () => {
      const plan = personPlan()
      const d = deps()
      await executeRoute(plan, d, { now: clock, priorSteps: logged(plan, 1000, 'failed') })
      expect(d.tracePerson).toHaveBeenCalledTimes(2)
    })

    it('reuses a billed non-match without spending on it again', async () => {
      const plan = personPlan()
      const prior: StepReport[] = [{
        kind: 'TRACERFY_INSTANT_NAMED', outcome: 'name_not_matched', cost: 0.1,
        at: new Date(NOW - 1000).toISOString(), requestKey: requestKeyFor(plan.steps[0]), people: [],
      }]
      const r = await executeRoute(plan, deps(), { now: clock, priorSteps: prior })
      expect(r.steps[0]).toMatchObject({ outcome: 'name_not_matched', reused: true, cost: 0.1 })
      expect(r.vendorSpend).toBe(0)
    })
  })

  describe('stepLogFrom', () => {
    it('reads back exactly what executeRoute wrote', async () => {
      const r = await executeRoute(personPlan(), deps({ tracePerson: contactSequence(NOT_MATCHED) }), { now: clock })
      expect(stepLogFrom(JSON.parse(JSON.stringify(r.steps)))).toEqual(r.steps)
    })

    it('drops anything that is not a step', () => {
      expect(stepLogFrom(null)).toEqual([])
      expect(stepLogFrom([{ kind: 'NOPE', outcome: 'miss' }, 'x', { kind: 'FASTAPPEND_ENTITY', outcome: 'maybe' }])).toEqual([])
    })
  })
})

describe('contactVendorFrom: the vendor that produced the contacts wins', () => {
  it('names fastappend when a trust ladder missed at Tracerfy and hit at FastAppend', () => {
    // MUTATION: drop the hit-first loop and this answers tracerfy.
    expect(contactVendorFrom([
      { kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss', cost: 0 },
      { kind: 'FASTAPPEND_ENTITY', outcome: 'hit', cost: 0.1 },
    ])).toBe('fastappend')
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run lib/routing/__tests__/executeRoute.test.ts`
Expected: FAIL (`requestKeyFor`, `stepLogFrom`, `STEP_REUSE_WINDOW_MS` are not exported; the ladder stops at the non-matched hit).

- [ ] **Step 3: Implement in `lib/routing/executeRoute.ts`**

Add imports:

```ts
import { VENDOR_TIMEOUT } from '@/lib/constants'
import type { VendorCallOptions } from '@/lib/tracerfy/fetchWithTimeout'
```

In the module docblock, replace rule 1's first sentence with: `1. STOP AT THE FIRST HIT. A dossier hit ends its stage; a contact step ends it only with a name-matched phone or email (D6, spec 4.3), so a non-matched or contactless answer lets the next step run.`

Replace `RouteDeps` with:

```ts
export interface RouteDeps {
  lookupDossier: (key: DossierKey, opts?: VendorCallOptions) => Promise<DossierResult>
  traceEntity: (req: EntityTraceRequest, opts?: VendorCallOptions) => Promise<ContactResult>
  tracePerson: (req: PersonTraceRequest, opts?: VendorCallOptions) => Promise<ContactResult>
}
```

Replace `StepOutcome` and `StepReport` with:

```ts
export type StepOutcome =
  /** The vendor matched and charged. */
  | 'hit'
  /** The vendor answered, with no record. Free and final. */
  | 'miss'
  /** D6: the vendor returned people and charged, and none was the owner. Nothing is delivered. */
  | 'name_not_matched'
  /** We could not ask. Free, not final, and not billable. */
  | 'failed'
  /** Never put to a vendor: an earlier step hit or failed, or our own request was refused. */
  | 'skipped'

export interface StepReport {
  kind: StepKind
  outcome: StepOutcome
  /** Dollars actually spent on this step. Zero on a miss, a failure and a skip. */
  cost: number
  /** Credits the vendor said it deducted, read from its own answer. */
  creditsDeducted?: number
  error?: string
  /** Why a step was skipped. */
  note?: string
  /** When the vendor answered, or the call failed. Absent on a skip. */
  at?: string
  /** requestKeyFor(step): the exact question this answer belongs to. */
  requestKey?: string
  /** The names returned on a billed non-match (D6). Internal: the step log only. */
  people?: Array<{ first_name: string; last_name: string }>
  /** A contact hit that carried no phone and no email. */
  noContacts?: boolean
  /** Copied from a busy_try_again row's step log instead of asked again (spec 5.2). */
  reused?: boolean
}

/** What a caller may tell executeRoute beyond the plan. */
export interface ExecuteOptions {
  /** Epoch ms after which no vendor call may start. The single routes pass one; the crons do not. */
  deadlineMs?: number
  /** A busy_try_again row's step log. Answered entries younger than 24 hours are reused. */
  priorSteps?: StepReport[] | null
  /** The clock, injectable for tests. */
  now?: () => number
}

/** A logged answer older than this is never reused; the record runs fresh instead (spec 5.2). */
export const STEP_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The question a step asked, as a string: its kind plus its request, which already carries the
 * owner's name and every key sent. A resend reuses a logged answer only for the IDENTICAL question,
 * so a different owner, address or parcel id always asks again.
 */
export function requestKeyFor(step: RouteStep): string {
  return `${step.kind}:${JSON.stringify(step.request)}`
}
```

Replace `contactVendorFrom` (keep the `CONTACT_VENDOR_BY_STEP` table and its docblock; in the function's docblock replace the paragraph starting "At most one vendor family can appear in a run" with "A trust or unreadable name can ask BOTH vendors (spec 4.2, D3). The vendor whose answer produced the contacts wins; when none did, the first vendor asked answers the routing question.") with:

```ts
export function contactVendorFrom(steps: StepReport[]): ContactVendor | null {
  for (const step of steps) {
    if (step.outcome !== 'hit' || step.noContacts) continue
    const vendor = CONTACT_VENDOR_BY_STEP[step.kind]
    if (vendor) return vendor
  }
  for (const step of steps) {
    if (step.outcome === 'skipped') continue
    const vendor = CONTACT_VENDOR_BY_STEP[step.kind]
    if (vendor) return vendor
  }
  return null
}

const STEP_OUTCOMES: ReadonlySet<string> = new Set(['hit', 'miss', 'name_not_matched', 'failed', 'skipped'])

const isNamePair = (v: unknown): v is { first_name: string; last_name: string } =>
  typeof v === 'object' && v !== null &&
  typeof (v as Record<string, unknown>).first_name === 'string' &&
  typeof (v as Record<string, unknown>).last_name === 'string'

/**
 * A step log read back from trace_history.trace_steps (JSONB, so anything). Keeps only entries
 * that are well-formed steps; a resend decides what NOT to buy from this, so a malformed entry is
 * dropped rather than trusted.
 */
export function stepLogFrom(raw: unknown): StepReport[] {
  if (!Array.isArray(raw)) return []
  const out: StepReport[] = []
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue
    const r = e as Record<string, unknown>
    if (typeof r.kind !== 'string' || !Object.prototype.hasOwnProperty.call(CONTACT_VENDOR_BY_STEP, r.kind)) continue
    if (typeof r.outcome !== 'string' || !STEP_OUTCOMES.has(r.outcome)) continue
    out.push({
      kind: r.kind as StepKind,
      outcome: r.outcome as StepOutcome,
      cost: typeof r.cost === 'number' ? r.cost : 0,
      ...(typeof r.creditsDeducted === 'number' ? { creditsDeducted: r.creditsDeducted } : {}),
      ...(typeof r.error === 'string' ? { error: r.error } : {}),
      ...(typeof r.note === 'string' ? { note: r.note } : {}),
      ...(typeof r.at === 'string' ? { at: r.at } : {}),
      ...(typeof r.requestKey === 'string' ? { requestKey: r.requestKey } : {}),
      ...(Array.isArray(r.people) ? { people: r.people.filter(isNamePair) } : {}),
      ...(r.noContacts === true ? { noContacts: true } : {}),
      ...(r.reused === true ? { reused: true } : {}),
    })
  }
  return out
}
```

Add `nameNotMatched?: boolean`, `people?: Array<{ first_name: string; last_name: string }>` and `inputError?: boolean` to the private `VendorCall` interface. Replace `callVendor` with:

```ts
/** A contact vendor's answer, normalised. A hit costs costOnHit whether or not a name matched. */
function contactCall(step: RouteStep, res: ContactResult, fallbackError: string): VendorCall {
  if (!res.success) {
    return {
      success: false, hit: false, cost: 0, error: res.error ?? fallbackError,
      ...(res.inputError ? { inputError: true } : {}),
    }
  }
  return {
    success: true,
    hit: res.hit,
    // The vendor bills a hit whether or not a returned person was the owner (D6).
    cost: res.hit ? step.costOnHit : 0,
    contacts: res.contacts,
    ...(res.creditsDeducted === undefined ? {} : { creditsDeducted: res.creditsDeducted }),
    ...(res.nameNotMatched ? { nameNotMatched: true, people: res.people ?? [] } : {}),
  }
}

async function callVendor(step: RouteStep, deps: RouteDeps, opts?: VendorCallOptions): Promise<VendorCall> {
  // Only a caller with a request budget passes opts. The crons pass none, and their vendor calls
  // keep the one-argument shape their tests pin.
  try {
    switch (step.kind) {
      case 'DOSSIER_APN':
      case 'DOSSIER_ADDRESS': {
        const key = dossierKeyFor(step)
        if (!key) return { success: false, hit: false, cost: 0, error: `Cannot key ${step.kind}` }

        const res = opts ? await deps.lookupDossier(key, opts) : await deps.lookupDossier(key)
        if (!res.success) {
          return { success: false, hit: false, cost: 0, error: res.error ?? `${step.kind} failed` }
        }
        // Charge what the vendor says it deducted, not what we assume a hit costs.
        const cost = res.hit
          ? round2((res.creditsDeducted / DOSSIER_CREDITS_PER_HIT) * step.costOnHit)
          : 0
        return { success: true, hit: res.hit, cost, creditsDeducted: res.creditsDeducted, dossier: res }
      }

      case 'FASTAPPEND_ENTITY': {
        const req = entityRequest(step)
        const res = opts ? await deps.traceEntity(req, opts) : await deps.traceEntity(req)
        return contactCall(step, res, 'Entity trace failed')
      }

      case 'TRACERFY_INSTANT_NAMED':
      case 'TRACERFY_PARCEL_APN': {
        const req = personRequest(step)
        const res = opts ? await deps.tracePerson(req, opts) : await deps.tracePerson(req)
        return contactCall(step, res, 'Person trace failed')
      }
    }
  } catch (error) {
    // A vendor that throws could not be asked. That is a failure, never a miss.
    return {
      success: false,
      hit: false,
      cost: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
```

Replace `runStage` (and its docblock) with:

```ts
interface StageContext {
  deadlineMs?: number
  prior: StepReport[]
  now: () => number
}

const isContactStep = (kind: StepKind): boolean => CONTACT_VENDOR_BY_STEP[kind] !== null

const hasPhoneOrEmail = (c: OwnerContacts | null | undefined): boolean =>
  Boolean(c && (c.phones.length > 0 || c.emails.length > 0))

/** An answer that can stand in for asking again: the vendor answered and nothing was delivered. */
const isReusableAnswer = (e: StepReport): boolean =>
  e.outcome === 'miss' || e.outcome === 'name_not_matched' || (e.outcome === 'hit' && e.noContacts === true)

/** The logged answer to exactly this question, if it is younger than 24 hours by its OWN time. */
function reusableAnswer(ctx: StageContext, requestKey: string): StepReport | null {
  for (const e of ctx.prior) {
    if (e.requestKey !== requestKey || !e.at || !isReusableAnswer(e)) continue
    const age = ctx.now() - Date.parse(e.at)
    if (Number.isFinite(age) && age >= 0 && age < STEP_REUSE_WINDOW_MS) return e
  }
  return null
}

/**
 * Run one stage's steps in order, stopping at the first step that DELIVERS: a dossier hit, or a
 * contact hit with a name-matched phone or email.
 *
 * A failure also stops the stage. We cannot tell a transient outage from a key-specific rejection
 * here, and continuing through an incident both compounds load on a rate limit that is SHARED across
 * Tracerfy's endpoints and produces a half-run record the caller cannot safely bill.
 */
async function runStage(steps: RouteStep[], deps: RouteDeps, ctx: StageContext): Promise<StageResult> {
  const reports: StepReport[] = []
  let spend = 0
  let hit: VendorCall | null = null
  let failure: string | null = null

  for (const step of steps) {
    if (hit || failure) {
      reports.push({
        kind: step.kind,
        outcome: 'skipped',
        cost: 0,
        note: hit ? 'an earlier step hit; this one would have been a wasted charge'
                  : 'an earlier step failed; not attempted',
      })
      continue
    }

    const requestKey = requestKeyFor(step)

    // RESUME (spec 5.2). An answer this record already bought, inside 24 hours, is not bought again.
    // It keeps its own time and cost, and adds nothing to this run's spend.
    const prior = reusableAnswer(ctx, requestKey)
    if (prior) {
      reports.push({ ...prior, reused: true })
      continue
    }

    // THE REQUEST BUDGET. A call that cannot finish before the deadline is not started: the record
    // ends busy_try_again and the resend picks up at this step.
    const left = ctx.deadlineMs === undefined ? undefined : ctx.deadlineMs - ctx.now()
    if (left !== undefined && left < VENDOR_TIMEOUT.MIN_CALL_MS) {
      failure = 'The request ran out of time before this lookup could start.'
      reports.push({
        kind: step.kind, outcome: 'failed', cost: 0, error: failure,
        at: new Date(ctx.now()).toISOString(), requestKey,
      })
      continue
    }

    const call = await callVendor(step, deps, left === undefined ? undefined : { timeoutMs: left })
    const at = new Date(ctx.now()).toISOString()

    if (call.inputError) {
      // OUR request, refused before spending (no name, no city, no state). Not a vendor failure, so
      // never busy_try_again (spec 5.1): recorded as not asked, and the next step runs.
      reports.push({
        kind: step.kind, outcome: 'skipped', cost: 0,
        note: `not sent: ${call.error ?? 'refused'}`, at, requestKey,
      })
      continue
    }

    if (!call.success) {
      failure = call.error ?? `${step.kind} failed`
      reports.push({ kind: step.kind, outcome: 'failed', cost: 0, error: failure, at, requestKey })
      continue
    }

    spend = round2(spend + call.cost)
    const delivered = !isContactStep(step.kind) || hasPhoneOrEmail(call.contacts)
    reports.push({
      kind: step.kind,
      outcome: call.nameNotMatched ? 'name_not_matched' : call.hit ? 'hit' : 'miss',
      cost: call.cost,
      at,
      requestKey,
      ...(call.creditsDeducted === undefined ? {} : { creditsDeducted: call.creditsDeducted }),
      ...(call.nameNotMatched ? { people: call.people ?? [] } : {}),
      ...(call.hit && !call.nameNotMatched && !delivered ? { noContacts: true } : {}),
    })
    // A dossier hit ends its stage. A contact step ends it only with a name-matched phone or email:
    // a non-matched person (D6) or a matched one with neither is a no-contact result, and the next
    // step runs (spec 4.3).
    if (call.hit && delivered) hit = call
  }

  return { reports, spend, hit, failure }
}
```

Change the `executeRoute` signature and add the context at the top of its body:

```ts
export async function executeRoute(
  plan: RoutePlan,
  deps: RouteDeps,
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const ctx: StageContext = {
    deadlineMs: options.deadlineMs,
    prior: options.priorSteps ?? [],
    now: options.now ?? Date.now,
  }
```

and change its two calls to `runStage(plan.steps, deps, ctx)` and `runStage(contactPlan.steps, deps, ctx)`.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run lib/routing`
Expected: PASS, 0 failed.

- [ ] **Step 5: Mutations**

1. `if (call.hit && delivered) hit = call` becomes `if (call.hit) hit = call`: `'moves on after a person hit whose people are not the owner'` and `'moves on after a matched hit that carries no phone and no email'` go red.
2. Delete the `if (call.inputError) { ... }` block: `'treats our own refused request as not asked'` goes red.
3. Delete the `MIN_CALL_MS` check: `'does not start a call it cannot finish'` goes red.
4. In `reusableAnswer`, drop `&& age < STEP_REUSE_WINDOW_MS`: `'buys it again once the answer is 24 hours old'` goes red.
5. In `reusableAnswer`, compare `e.kind` to the step kind instead of `e.requestKey` (pass `step.kind` in): `'never reuses an answer to a different question'` goes red.
6. Delete the `const prior = reusableAnswer(...)` block: `'does not buy an answered step again inside 24 hours'` goes red.
7. Delete the first loop of `contactVendorFrom`: `'names fastappend when a trust ladder missed at Tracerfy'` goes red.

- [ ] **Step 6: Suite, History, commit**

Run: `npx vitest run` and `npx tsc --noEmit`. Expected: 0 failed, 0 errors. The Tier 2 cron and both route suites must stay green: they pass no options, so their calls keep one argument.

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 5: step log, resend reuse, request budget.

- executeRoute records every step with its outcome (hit, miss, name_not_matched, failed,
  skipped), cost, the vendor's credits, the time, the exact question asked, and the names returned
  on a billed non-match. A contact step now ends the ladder only with a name-matched phone or email.
- A resend given a busy row's log reuses answered steps younger than 24 hours by their own
  timestamp, for the identical question only. Our own refused input is recorded as not asked,
  never as a failure.
- A request deadline: no call starts with under 5 s left, and each call gets only what is left.
  The crons pass none and are unchanged. contactVendorFrom names the vendor that produced the
  contacts. Mutations: seven, all red.
```

```bash
git add lib/routing/executeRoute.ts lib/routing/__tests__/executeRoute.test.ts History.md tasks/todo.md
git commit -m "$(cat <<'EOF'
feat(routing): step log, 24 hour resend reuse and a request budget in executeRoute

Tier 1 Phase 1, Task 5.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: D21, every owner, the mailing address, then the dossier's own contacts

**Files:**
- Modify: `lib/tracerfy/dossier.ts` (`DossierResult`, `parseDossierResponse`, module and function docblocks)
- Modify: `lib/routing/executeRoute.ts` (`ExecutionResult.contactsNameVerified`, owner helpers, the Tier 2 half of `executeRoute` from `// ---- Tier 2. What the $0.20 bought. ----` to the end of the function)
- Modify: `lib/trace/fullPropertyTrace.ts:134-162` (`traceResultFor`)
- Test: `lib/tracerfy/__tests__/dossier.test.ts`, `lib/routing/__tests__/executeRoute.test.ts`, `lib/trace/__tests__/fullPropertyTrace.test.ts`, `app/api/cron/sweep-property-traces/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `hasSitus` (Task 2), `ExecuteOptions`/`StageContext`/`runStage` with `ctx` and `hasPhoneOrEmail` (Task 5).
- Produces:
  - `DossierResult.contacts?: OwnerContacts | null` (the nameless block, `ownerName: null`, `mailingAddress: null`; null when it holds no phone and no email; absent on a miss or failure).
  - `ExecutionResult.contactsNameVerified: boolean` (false only for the D21 (b) fallback).
  - `traceResultFor`: `owner_name_2` is set only when `execution.tier === 2`; `name_verified: false` is added only when `contactsNameVerified === false`.
  - Tier 2 second pass: every dossier owner in order, each through its own `planRoute`; an individual owner on a property with no street or city is searched at the dossier's mailing address; the fallback runs only when every owner was asked, none delivered, and the dossier's owners classify `individual` (D14).

- [ ] **Step 1: Write the failing tests**

Append to `lib/tracerfy/__tests__/dossier.test.ts`:

```ts
describe('parseDossierResponse: the contacts block (D21 b)', () => {
  it('surfaces the nameless contacts on a hit', () => {
    const result = parseDossierResponse(individualHit.response)
    expect(result.contacts).toEqual({
      ownerName: null,
      phones: [
        { number: '5555550100', type: 'mobile' },
        { number: '5555550101', type: 'landline' },
      ],
      emails: ['redacted@example.invalid'],
      mailingAddress: null,
    })
  })

  it('carries none on a miss', () => {
    expect(parseDossierResponse(missApn.response).contacts ?? null).toBeNull()
  })

  it('returns null for a block with no phone and no email', () => {
    const body = { ...individualHit.response, contacts: { has_contact: false, phones: [], emails: [] } }
    expect(parseDossierResponse(body).contacts).toBeNull()
  })
})
```

Append to `lib/routing/__tests__/executeRoute.test.ts`:

```ts
describe('executeRoute: D21, every owner, the mailing address, then the dossier contacts', () => {
  const TWO_INDIVIDUALS: DossierResult = {
    ...HIT_INDIVIDUAL,
    owners: [
      { first_name: 'Testowner', last_name: 'Placeholder', age: '00' },
      { first_name: 'Secondowner', last_name: 'Placeholder', age: '00' },
    ],
  }

  it('asks about every owner the dossier names, in order, until one has contacts', async () => {
    // MUTATION: loop over ownerNamesFrom(dossier).slice(0, 1) and this goes red.
    // tier2Plan() has a street, a city and a parcel id, so each individual gets Instant then parcel.
    const d = deps({
      lookupDossier: dossierSequence(TWO_INDIVIDUALS),
      tracePerson: contactSequence(CONTACT_MISS, CONTACT_MISS, CONTACT_HIT),
    })
    const r = await executeRoute(tier2Plan(), d)
    expect(d.tracePerson).toHaveBeenCalledTimes(3)
    expect(vi.mocked(d.tracePerson).mock.calls[2][0]).toMatchObject({ first_name: 'Secondowner', last_name: 'Placeholder' })
    expect(r.contacts).toBe(CONTACT_HIT.contacts)
    expect(r.contactsNameVerified).toBe(true)
  })

  it('sends an entity co-owner to FastAppend and an individual to Tracerfy (D14)', async () => {
    const MIXED: DossierResult = {
      ...HIT_INDIVIDUAL,
      owners: [
        { first_name: 'Testowner', last_name: 'Placeholder', age: '00' },
        { first_name: '', last_name: 'Acme Holdings Llc', age: '' },
      ],
    }
    const d = deps({ lookupDossier: dossierSequence(MIXED), traceEntity: vi.fn(async () => CONTACT_HIT) })
    const r = await executeRoute(tier2Plan(), d)
    expect(d.tracePerson).toHaveBeenCalledTimes(2)
    expect(d.traceEntity).toHaveBeenCalledWith({ company_name: 'Acme Holdings Llc', state: 'UT' })
    expect(r.contactsFound).toBe(true)
  })

  it('searches an individual at the dossier mailing address when the property has no street or city (D21 c)', async () => {
    // MUTATION: return `base` unconditionally from contactParcelFor and the parcel lookup runs instead.
    const plan = tier2Plan({ situsAddress: null, situsCity: null, situsState: null })
    const d = deps({ lookupDossier: dossierSequence(HIT_INDIVIDUAL), tracePerson: vi.fn(async () => CONTACT_HIT) })
    await executeRoute(plan, d)
    expect(d.tracePerson).toHaveBeenCalledTimes(1)
    expect(d.tracePerson).toHaveBeenCalledWith({
      first_name: 'Testowner', last_name: 'Placeholder',
      address: '100 Placeholder Way', city: 'Redacted', state: 'ZZ', zip: '00000',
      find_owner: false,
    })
  })

  it("returns the dossier's own contacts, labelled not name-verified, only after every owner missed (D21 b)", async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_INDIVIDUAL) })
    const r = await executeRoute(tier2Plan(), d)
    expect(d.tracePerson).toHaveBeenCalledTimes(2)
    expect(r.contactsFound).toBe(true)
    expect(r.contactsNameVerified).toBe(false)
    expect(r.contacts).toEqual(HIT_INDIVIDUAL.contacts)
    expect(r.contacts?.ownerName).toBeNull()
  })

  it("prefers a name-matched hit over the dossier's contacts", async () => {
    // MUTATION: take the dossier contacts before the owner loop and this goes red.
    const d = deps({ lookupDossier: dossierSequence(HIT_INDIVIDUAL), tracePerson: vi.fn(async () => CONTACT_HIT) })
    const r = await executeRoute(tier2Plan(), d)
    expect(r.contacts).toBe(CONTACT_HIT.contacts)
    expect(r.contactsNameVerified).toBe(true)
  })

  it('never falls back when a lookup FAILED, because not every owner was asked', async () => {
    const d = deps({
      lookupDossier: dossierSequence(HIT_INDIVIDUAL),
      tracePerson: vi.fn(async () => ({ success: false, hit: false, contacts: null, error: 'Tracerfy service unavailable' })),
    })
    const r = await executeRoute(tier2Plan(), d)
    expect(r.success).toBe(false)
    expect(r.contacts).toBeNull()
  })

  it('never gives an ENTITY owner the dossier contacts (D14)', async () => {
    // HIT_ENTITY_APN carries the same synthetic contacts block (fixtures README).
    // MUTATION: drop `result.ownerType === 'individual'` from the fallback and this goes red.
    const d = deps({ lookupDossier: dossierSequence(HIT_ENTITY_APN) })
    const r = await executeRoute(tier2Plan(), d)
    expect(r.contactsFound).toBe(false)
    expect(r.contacts).toBeNull()
  })
})
```

Append to `lib/trace/__tests__/fullPropertyTrace.test.ts` (inside the `traceResultFor` describe), and add `contactsNameVerified: true,` to the object the file's `execution()` helper returns:

```ts
  it('never labels a SUPPLIED tier 1 owner as the owner of record (spec 7.2)', () => {
    // MUTATION: drop the tier test in traceResultFor and this goes red.
    expect(traceResultFor(execution({ tier: 1, ownerName: 'Acme Holdings Llc', contacts: null }))).toBeNull()
    expect(traceResultFor(execution({ tier: 1, ownerName: 'Acme Holdings Llc', contacts: CONTACTS }))!.owner_name_2).toBeNull()
  })

  it('labels the dossier contacts not name-verified (D21 b), and nothing else', () => {
    expect(traceResultFor(execution({ ownerName: 'X', contacts: CONTACTS, contactsNameVerified: false }))!.name_verified).toBe(false)
    expect(traceResultFor(execution({ ownerName: 'X', contacts: CONTACTS }))).not.toHaveProperty('name_verified')
  })
```

(`CONTACTS` is the contacts constant the file already uses at its `hasContactData` test; if it is declared inside a nested scope, move it to module scope.)

Append to `app/api/cron/sweep-property-traces/__tests__/route.test.ts` (the Tier 2 cron shares executeRoute, L-018):

```ts
describe("D21 in the tier 2 cron: every owner, then the dossier's own contacts", () => {
  const TWO_INDIVIDUALS = {
    ...ENTITY_HIT,
    owners: [
      { first_name: "Testowner", last_name: "Placeholder", age: "00" },
      { first_name: "Secondowner", last_name: "Placeholder", age: "00" },
    ],
    contacts: {
      ownerName: null,
      phones: [{ number: "5550000901", type: "mobile" }],
      emails: [],
      mailingAddress: null,
    },
  };

  beforeEach(() => {
    H.dossier = TWO_INDIVIDUALS;
  });

  it("asks about the second owner when the first misses", async () => {
    vi.mocked(lookupPersonTrace)
      .mockResolvedValueOnce({ ...CONTACTS_MISS })
      .mockResolvedValueOnce({ ...CONTACTS_HIT });
    await run();
    expect(lookupPersonTrace).toHaveBeenCalledTimes(2);
    expect(vi.mocked(lookupPersonTrace).mock.calls[1][0]).toMatchObject({ first_name: "Secondowner" });
    expect(finalWrite()).toMatchObject({ status: "success", is_successful: true, contact_vendor: "tracerfy" });
    expect((finalWrite().trace_result as Record<string, unknown>).name_verified).toBeUndefined();
  });

  it("falls back to the dossier contacts, labelled not name-verified, after every owner missed", async () => {
    H.personContacts = { ...CONTACTS_MISS };
    await run();
    expect(lookupPersonTrace).toHaveBeenCalledTimes(2);
    expect(finalWrite()).toMatchObject({ status: "success", is_successful: true, phone_count: 1 });
    expect((finalWrite().trace_result as Record<string, unknown>).name_verified).toBe(false);
  });
});
```

(The cron's `ROW` has a street and city and no parcel id, so each individual gets one Instant lookup.)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run lib/tracerfy/__tests__/dossier.test.ts lib/routing lib/trace/__tests__/fullPropertyTrace.test.ts app/api/cron/sweep-property-traces`
Expected: FAIL (`contacts` is not parsed; only the first owner or the joined string is tried; `contactsNameVerified` does not exist).

- [ ] **Step 3: Implement**

In `lib/tracerfy/dossier.ts` add `import type { OwnerContacts } from '@/lib/routing/executeRoute'`, and in `DossierResult` after `mailingAddress` add:

```ts
  /**
   * The dossier's OWN contacts block, which carries no name (spec D21 b). Used only as the last
   * resort after every owner's name-matched lookup missed, and always labelled not name-verified.
   * Null when the block holds no phone and no email; absent on a miss or a failure.
   */
  contacts?: OwnerContacts | null
```

Replace the sentence in the `parseDossierResponse` docblock "`response.contacts` is deliberately not surfaced..." with: "`response.contacts` is surfaced as `contacts` only for the D21 (b) fallback in executeRoute: it has no name, so it is never used while a name-matched lookup can still answer." Add above `parseDossierResponse`:

```ts
/** The nameless contacts block, deduplicated and capped the way the contact clients cap theirs. */
function dossierContacts(v: unknown): OwnerContacts | null {
  if (!isRecord(v)) return null
  const phones: Array<{ number: string; type: string }> = []
  for (const p of Array.isArray(v.phones) ? v.phones : []) {
    if (!isRecord(p)) continue
    const number = str(p.number).trim()
    if (number && !phones.some((x) => x.number === number)) {
      phones.push({ number, type: str(p.type).trim().toLowerCase() || 'unknown' })
    }
  }
  const emails: string[] = []
  for (const e of Array.isArray(v.emails) ? v.emails : []) {
    const email = (isRecord(e) ? str(e.email) : str(e)).trim()
    if (email && !emails.includes(email)) emails.push(email)
  }
  if (!phones.length && !emails.length) return null
  return {
    ownerName: null,
    phones: phones.slice(0, TRACERFY.MAX_PHONES),
    emails: emails.slice(0, TRACERFY.MAX_EMAILS),
    mailingAddress: null,
  }
}
```

and change the hit return of `parseDossierResponse` to:

```ts
  return {
    success: true, hit: true, owners, property, mailingAddress, creditsDeducted,
    contacts: dossierContacts(body.contacts),
  }
```

In `lib/routing/executeRoute.ts`: add `hasSitus` to the import from `'./ownerRoute'`. In `ExecutionResult`, after `contacts: OwnerContacts | null` add:

```ts
  /**
   * False only when `contacts` came from the dossier's own nameless contacts block after every
   * named owner's lookup missed (D21 b). Every surface shows it as "not name-verified".
   */
  contactsNameVerified: boolean
```

and add `contactsNameVerified: true,` to the initial `result` object after `contacts: null,`. Replace `ownerNameFrom` with:

```ts
/** Each owner the dossier names, as the one string classifyOwnerName() and splitPersonName() parse.
 *  An entity arrives with its whole name in last_name and first_name empty. */
function ownerNamesFrom(dossier: DossierResult): string[] {
  const names: string[] = []
  for (const o of dossier.owners) {
    const name = [o.first_name, o.last_name].map(s => s.trim()).filter(Boolean).join(' ')
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** All owners joined with " | ", the shape ExecutionResult.ownerName reports. */
const ownerNameFrom = (dossier: DossierResult): string => ownerNamesFrom(dossier).join(' | ')

/**
 * The parcel one dossier owner's contacts are looked up on.
 *
 * D21 (c): when the property has no street or city, an INDIVIDUAL owner is searched by name at the
 * dossier's MAILING address with the Instant lookup, instead of the parcel lookup. Every other owner
 * keeps the property's own keys.
 */
function contactParcelFor(
  parcel: ParcelInput,
  owner: string,
  situsZip: string | null,
  mailing: DossierMailingAddress | null,
): ParcelInput {
  const base: ParcelInput = { ...parcel, ownerName: owner, situsZip }
  const mailingComplete =
    mailing !== null && Boolean(mailing.address.trim() && mailing.city.trim() && mailing.state.trim())
  if (!hasSitus(parcel) && mailingComplete && classifyOwnerName(owner) === 'individual') {
    return {
      ...base,
      situsAddress: mailing!.address.trim(),
      situsCity: mailing!.city.trim(),
      situsState: mailing!.state.trim(),
      situsZip: mailing!.zip.trim() || null,
      parcelIdLocal: null,
      county: null,
    }
  }
  return base
}
```

Replace everything in `executeRoute` from `// ---- Tier 2. What the $0.20 bought. ----` to the end of the function with:

```ts
  // ---- Tier 2. What the $0.20 bought. ----
  const dossier = pass1.hit?.dossier
  if (!dossier) {
    // Every key missed. Asked and answered: there is no record to route.
    result.needsManualReview = plan.steps.length === 0
    return result
  }

  // RAW, by reference. Not copied, not subsetted, not renamed.
  result.property = dossier.property
  result.mailingAddress = dossier.mailingAddress

  const discovered = ownerNameFrom(dossier)
  if (!discovered) {
    // We paid for a property record that names no owner. Real, and not routable.
    result.needsManualReview = true
    warnings.push('The dossier hit but returned no owner name, so no contact vendor can be chosen.')
    return result
  }

  result.ownerName = discovered
  result.ownerFound = true
  // From the NAME. Never from property.corporate_owned, which lies.
  result.ownerType = classifyOwnerName(discovered)

  // ---- Pass 2 (D21). Every owner the dossier names, each classified on its own. ----
  //
  // ZIP BACKFILL. The $0.20 we just spent bought the property's own zip, and the contact step is
  // the one that decides whether the customer gets a phone number at all: Tracerfy calls the zip
  // strongly recommended for the named lookup. THE CALLER'S OWN ZIP WINS: they may know something
  // the county file does not.
  const callerZip = plan.parcel.situsZip?.trim() || ''
  const learnedZip = callerZip ? null : situsZipFrom(result.property)
  result.learnedZip = learnedZip

  let asked = false
  for (const owner of ownerNamesFrom(dossier)) {
    const contactPlan = planRoute(
      contactParcelFor(plan.parcel, owner, callerZip || learnedZip, result.mailingAddress),
      plan.pricePlan,
    )
    for (const w of contactPlan.warnings) if (!warnings.includes(w)) warnings.push(w)
    if (contactPlan.steps.length === 0) continue
    asked = true

    const stage = await runStage(contactPlan.steps, deps, ctx)
    result.steps = [...result.steps, ...stage.reports]
    result.vendorSpend = round2(result.vendorSpend + stage.spend)

    if (stage.failure) {
      // The dossier spend above stands and the record is good. An owner we could not ask is not a
      // miss, so the dossier's own contacts are not used either.
      result.success = false
      result.error = stage.failure
      return result
    }
    if (stage.hit?.contacts) {
      result.contacts = stage.hit.contacts
      result.contactsFound = true
      return result
    }
  }

  // D21 (b). Every owner was asked and none came back with contacts. The dossier's own block has
  // no name, so it is returned LABELLED not name-verified, and only when the dossier found
  // individual owners: D14 says Tracerfy never supplies an entity's contacts.
  if (result.ownerType === 'individual' && hasPhoneOrEmail(dossier.contacts)) {
    result.contacts = dossier.contacts!
    result.contactsFound = true
    result.contactsNameVerified = false
    return result
  }

  // No owner had a usable name or key: a person has to take it.
  if (!asked) result.needsManualReview = true
  return result
}
```

In `lib/trace/fullPropertyTrace.ts`, in `traceResultFor`, replace `const ownerOfRecord = execution.ownerName?.trim() || null` with:

```ts
  // The OWNER OF RECORD is what a Full Property Trace bought from the county. On a tier 1 trace the
  // owner was SUPPLIED by the caller, and labelling it "the name on the county roll" would be
  // false (spec 7.2), so a tier 1 result carries no owner_name_2 and a tier 1 miss is null.
  const ownerOfRecord = execution.tier === 2 ? execution.ownerName?.trim() || null : null
```

and replace the final `match_confidence` line of the returned object with:

```ts
    match_confidence: phones.length > 0 || emails.length > 0 ? 80 : 0,
    // D21 (b): contacts from the dossier's nameless block after every owner's lookup missed.
    ...(execution.contactsNameVerified === false ? { name_verified: false } : {}),
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run lib app/api/cron/sweep-property-traces` then `npx tsc --noEmit`.
Expected: PASS, 0 errors. If `tsc` names another test that builds an `ExecutionResult` literal, add `contactsNameVerified: true` to it. If an existing test with an INDIVIDUAL dossier owner and a contact miss now sees the dossier contacts, that is D21 (b) working: update its expectation to `contactsFound: true, contactsNameVerified: false` and name it in the History entry.

- [ ] **Step 5: Mutations**

1. Loop over `ownerNamesFrom(dossier).slice(0, 1)`: `'asks about every owner the dossier names'` (executeRoute) and `'asks about the second owner when the first misses'` (cron) go red.
2. `return base` unconditionally in `contactParcelFor`: `'searches an individual at the dossier mailing address'` goes red.
3. Move the D21 (b) block above the owner loop: `"prefers a name-matched hit over the dossier's contacts"` goes red.
4. Drop `result.ownerType === 'individual' &&` from the fallback: `'never gives an ENTITY owner the dossier contacts'` and the existing `'reports a genuine contact MISS as a completed, cheaper run'` go red.
5. Drop `execution.tier === 2 ?` in `traceResultFor`: `'never labels a SUPPLIED tier 1 owner'` goes red.
6. Delete `contacts: dossierContacts(body.contacts)`: `'surfaces the nameless contacts on a hit'` and the D21 (b) tests go red.

- [ ] **Step 6: Suite, History, commit**

Run: `npx vitest run`. Expected: 0 failed.

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 6: D21, every owner, then the dossier's own contacts.

- The Tier 2 second pass now tries every owner the dossier names, each classified on its own
  (individual to Tracerfy, entity to FastAppend, D14). When the property has no street or city, an
  individual owner is searched at the dossier's mailing address with Instant, instead of the
  nameless parcel lookup.
- Only when every owner was asked and none came back with contacts, and the owners are individuals,
  the dossier's own contacts block is returned with name_verified false. The dossier parser now
  surfaces that block.
- traceResultFor no longer labels a supplied Tier 1 owner as the owner of record, so a Tier 1 miss
  is a null result. Shared with the Tier 2 cron: two new cron tests. Mutations: six, all red.
```

```bash
git add lib/tracerfy/dossier.ts lib/routing/executeRoute.ts lib/trace/fullPropertyTrace.ts lib/tracerfy/__tests__/dossier.test.ts lib/routing/__tests__/executeRoute.test.ts lib/trace/__tests__/fullPropertyTrace.test.ts app/api/cron/sweep-property-traces/__tests__/route.test.ts History.md tasks/todo.md
git commit -m "$(cat <<'EOF'
feat(routing): D21, every dossier owner, the mailing-address search, then labelled dossier contacts

Tier 1 Phase 1, Task 6.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 7: Outcome codes, sentences, rowSkipReason and the webhook's tier (spec 7.1, 7.2, 7.3)

**Waits on Q1** only for the `found_no_contacts` code under option (b).

**Files:**
- Create: `lib/trace/tier1Outcome.ts`
- Modify: `lib/trace/rowSkipReason.ts`
- Modify: `lib/trace/traceCompletedWebhook.ts`
- Modify: `app/api/trace/single/route.ts` and `app/api/v1/trace/single/route.ts` (one line each: the existing Tier 2 `dispatchTraceCompleted` call gains `tier`)
- Modify: `lib/trace/__tests__/propertyRecordEgress.test.ts` (its `dispatch()` call gains `tier: 2`)
- Test: create `lib/trace/__tests__/tier1Outcome.test.ts`, `lib/trace/__tests__/traceCompletedWebhook.test.ts`; modify `lib/trace/__tests__/rowSkipReason.test.ts`, `lib/trace/__tests__/exportCsv.test.ts`

**Interfaces:**
- Consumes: `ExecutionResult`, `StepReport` (with `noContacts`), `stepLogFrom` (Tasks 5, 6).
- Produces (`lib/trace/tier1Outcome.ts`):
  - `export const TIER1_OUTCOME` (seven codes); `export type Tier1OutcomeCode`; `export type FoundBy = 'address' | 'parcel_id' | 'company_name'`
  - `export function tier1OutcomeFor(execution: ExecutionResult): { outcome: Tier1OutcomeCode; foundBy: FoundBy | null }`
  - `export const BUSY_TRY_AGAIN_REASON`, `export const OWNER_NAME_NOT_MATCHED_REASON`
  - `export function noMatchReason(steps: StepReport[]): string | null`
  - `export type MissingLookupKey = 'city_and_parcel' | 'state' | 'street_and_parcel'`
  - `export function missingLookupKey(input: { address?: string | null; city?: string | null; state?: string | null; apn?: string | null; county?: string | null }): MissingLookupKey | null`
  - `export function noLookupKeyReason(missing: MissingLookupKey): string`
  - `export function outcomeSentence(outcome: Tier1OutcomeCode, steps: StepReport[], missing: MissingLookupKey | null): string | null`
  - `export interface Tier1OutcomeRow` and `export function tier1OutcomeReason(row: Tier1OutcomeRow): string | null`
- Produces (webhook): `TraceCompletedWebhookInput` gains `tier: 1 | 2` (required), `foundBy?`, `outcomeCode?`, `skipReason?` (`string | null`); the payload always carries `tier`, `found_by`, `outcome_code`, `skip_reason`.
- `rowSkipReason(row)` = `propertyTraceSkipReason(...) ?? tier1OutcomeReason(row) ?? skipReasonFor(...)`.

- [ ] **Step 1: Write the failing tests**

Create `lib/trace/__tests__/tier1Outcome.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ExecutionResult, StepReport } from '@/lib/routing/executeRoute'
import {
  BUSY_TRY_AGAIN_REASON,
  missingLookupKey,
  noLookupKeyReason,
  noMatchReason,
  OWNER_NAME_NOT_MATCHED_REASON,
  outcomeSentence,
  tier1OutcomeFor,
  tier1OutcomeReason,
} from '@/lib/trace/tier1Outcome'

const step = (kind: StepReport['kind'], outcome: StepReport['outcome'], extra: Partial<StepReport> = {}): StepReport =>
  ({ kind, outcome, cost: 0, ...extra })

const exec = (steps: StepReport[], contactsFound = false): ExecutionResult => ({
  success: !steps.some(s => s.outcome === 'failed'),
  ownerFound: true, learnedZip: null, ownerName: 'Marcus Halloway', ownerType: 'individual',
  property: null, mailingAddress: null, contactsFound, contactsNameVerified: true,
  contacts: contactsFound
    ? { ownerName: 'Marcus Halloway', phones: [{ number: '5550000101', type: 'mobile' }], emails: [], mailingAddress: null }
    : null,
  tier: 1, vendorSpend: 0, steps, needsManualReview: false, warnings: [],
})

describe('tier1OutcomeFor (spec 7.1)', () => {
  it.each([
    ['TRACERFY_INSTANT_NAMED', 'found_by_address', 'address'],
    ['TRACERFY_PARCEL_APN', 'found_by_parcel_id', 'parcel_id'],
    ['FASTAPPEND_ENTITY', 'found_by_company_name', 'company_name'],
  ] as const)('a %s hit with contacts is %s', (kind, outcome, foundBy) => {
    expect(tier1OutcomeFor(exec([step(kind, 'hit')], true))).toEqual({ outcome, foundBy })
  })

  it('names the key that FOUND the owner, not a step before it', () => {
    expect(tier1OutcomeFor(exec([step('TRACERFY_INSTANT_NAMED', 'miss'), step('TRACERFY_PARCEL_APN', 'hit')], true)).foundBy)
      .toBe('parcel_id')
  })

  it('any failed step is busy_try_again, whatever answered before it', () => {
    // MUTATION: delete the failed-step test and this reads no_match.
    expect(tier1OutcomeFor(exec([step('TRACERFY_INSTANT_NAMED', 'miss'), step('FASTAPPEND_ENTITY', 'failed')])).outcome)
      .toBe('busy_try_again')
  })

  it('a billed non-match with nothing delivered is owner_name_not_matched', () => {
    expect(tier1OutcomeFor(exec([step('TRACERFY_INSTANT_NAMED', 'name_not_matched'), step('FASTAPPEND_ENTITY', 'miss')])).outcome)
      .toBe('owner_name_not_matched')
  })

  it('answered misses, and a contactless hit (Q1 a), are no_match', () => {
    expect(tier1OutcomeFor(exec([step('FASTAPPEND_ENTITY', 'miss')])).outcome).toBe('no_match')
    expect(tier1OutcomeFor(exec([step('TRACERFY_INSTANT_NAMED', 'hit', { noContacts: true })])).outcome).toBe('no_match')
  })

  it('nothing asked, or only our own refused input, is no_lookup_key', () => {
    expect(tier1OutcomeFor(exec([])).outcome).toBe('no_lookup_key')
    expect(tier1OutcomeFor(exec([step('TRACERFY_INSTANT_NAMED', 'skipped', { note: 'not sent: x' })])).outcome).toBe('no_lookup_key')
  })
})

describe('the sentences (spec 7.1)', () => {
  it('no_match names only the keys that answered, in order', () => {
    expect(noMatchReason([step('TRACERFY_INSTANT_NAMED', 'miss')]))
      .toBe('We looked this owner up by address and found no match. You were not charged.')
    expect(noMatchReason([step('TRACERFY_INSTANT_NAMED', 'miss'), step('TRACERFY_PARCEL_APN', 'miss')]))
      .toBe('We looked this owner up by address and parcel ID and found no match. You were not charged.')
    expect(noMatchReason([step('FASTAPPEND_ENTITY', 'miss')]))
      .toBe('We looked this owner up by company name and found no match. You were not charged.')
    expect(noMatchReason([
      step('TRACERFY_INSTANT_NAMED', 'miss'), step('TRACERFY_PARCEL_APN', 'name_not_matched'), step('FASTAPPEND_ENTITY', 'miss'),
    ])).toBe('We looked this owner up by address, parcel ID and company name and found no match. You were not charged.')
    // A skipped or failed step was never an answer.
    expect(noMatchReason([step('TRACERFY_INSTANT_NAMED', 'miss'), step('FASTAPPEND_ENTITY', 'skipped')]))
      .toBe('We looked this owner up by address and found no match. You were not charged.')
    expect(noMatchReason([])).toBeNull()
  })

  it('no_lookup_key names what is missing and what to send', () => {
    expect(noLookupKeyReason('city_and_parcel')).toBe(
      'This record is missing the city and the parcel ID, so it could not be looked up. You were not charged. Send it again with the city or the parcel ID.'
    )
    expect(noLookupKeyReason('state')).toBe(
      'This record is missing a valid state, so it could not be looked up. You were not charged. Send it again with a valid two-letter state.'
    )
    expect(noLookupKeyReason('street_and_parcel')).toBe(
      'This record is missing a street address and the parcel ID, so it could not be looked up. You were not charged. Send it again with the street address or the parcel ID.'
    )
  })

  it('missingLookupKey reads the record, state first', () => {
    expect(missingLookupKey({ state: 'Texas', city: 'Austin', address: '1 A St' })).toBe('state')
    expect(missingLookupKey({ state: 'TX' })).toBe('city_and_parcel')
    expect(missingLookupKey({ state: 'TX', city: 'Austin' })).toBe('street_and_parcel')
    expect(missingLookupKey({ state: 'TX', apn: '12-3', county: 'Travis' })).toBeNull()
    expect(missingLookupKey({ state: 'TX', apn: '12-3' })).toBe('city_and_parcel')
    expect(missingLookupKey({ state: 'TX', city: 'Austin', address: '1 A St' })).toBeNull()
  })

  it('found_by outcomes carry no sentence: the contacts are shown', () => {
    expect(outcomeSentence('found_by_address', [], null)).toBeNull()
  })

  it('never says a parcel ID was "not recognized": Tracerfy never tells us so', () => {
    for (const s of [BUSY_TRY_AGAIN_REASON, OWNER_NAME_NOT_MATCHED_REASON, noMatchReason([step('TRACERFY_PARCEL_APN', 'miss')])!]) {
      expect(s).not.toMatch(/recogni/i)
    }
  })
})

describe('copy rules (spec 7.3) on every new sentence', () => {
  const ALL = [
    BUSY_TRY_AGAIN_REASON,
    OWNER_NAME_NOT_MATCHED_REASON,
    noMatchReason([step('TRACERFY_INSTANT_NAMED', 'miss'), step('TRACERFY_PARCEL_APN', 'miss'), step('FASTAPPEND_ENTITY', 'miss')])!,
    noLookupKeyReason('city_and_parcel'),
    noLookupKeyReason('state'),
    noLookupKeyReason('street_and_parcel'),
  ]

  it('every one states the charge', () => {
    for (const s of ALL) expect(s, s).toMatch(/charged/)
  })

  it('none quotes a price, claims anyone was notified, or asks for funds', () => {
    for (const s of ALL) {
      expect(s, s).not.toMatch(/\$|\d+\s*cent/)
      expect(s, s).not.toMatch(/notified|alerted|our team|looking into/i)
      expect(s, s).not.toMatch(/add funds|top up|insufficient/i)
    }
  })

  it('none carries an em dash, en dash, asterisk or emoji', () => {
    for (const s of ALL) {
      expect(s, s).not.toMatch(/[—–*]/)
      expect(s, s).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    }
  })

  it('resend advice appears on exactly busy_try_again and no_lookup_key', () => {
    // MUTATION: append " Try again later." to OWNER_NAME_NOT_MATCHED_REASON and this goes red.
    expect(BUSY_TRY_AGAIN_REASON).toMatch(/try again/i)
    for (const m of ['city_and_parcel', 'state', 'street_and_parcel'] as const) {
      expect(noLookupKeyReason(m)).toMatch(/send it again/i)
    }
    for (const s of [OWNER_NAME_NOT_MATCHED_REASON, noMatchReason([step('TRACERFY_INSTANT_NAMED', 'miss')])!]) {
      expect(s, s).not.toMatch(/send it again|send them again|try again|upload it again/i)
    }
  })
})

describe('tier1OutcomeReason: the sentence read back off a stored row', () => {
  it('reads each outcome', () => {
    expect(tier1OutcomeReason({ outcome_code: 'no_match', trace_steps: [step('FASTAPPEND_ENTITY', 'miss')], is_successful: false }))
      .toBe('We looked this owner up by company name and found no match. You were not charged.')
    expect(tier1OutcomeReason({ outcome_code: 'busy_try_again', is_successful: false })).toBe(BUSY_TRY_AGAIN_REASON)
    expect(tier1OutcomeReason({ outcome_code: 'owner_name_not_matched', is_successful: false })).toBe(OWNER_NAME_NOT_MATCHED_REASON)
    expect(tier1OutcomeReason({ outcome_code: 'no_lookup_key', state: 'OH', city: null, parcel_id_local: null, is_successful: false }))
      .toBe(noLookupKeyReason('city_and_parcel'))
  })

  it('says nothing about a row that delivered contacts, or a row with no outcome', () => {
    expect(tier1OutcomeReason({ outcome_code: 'no_match', trace_steps: [], is_successful: true })).toBeNull()
    expect(tier1OutcomeReason({ outcome_code: null })).toBeNull()
  })
})
```

Create `lib/trace/__tests__/traceCompletedWebhook.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTraceCompleted } from '@/lib/trace/traceCompletedWebhook'

let posts: Array<Record<string, unknown>> = []

beforeEach(() => {
  posts = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: unknown, init: unknown) => {
    posts.push(JSON.parse(String((init as RequestInit).body)))
    return new Response('{}', { status: 200 })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const base = {
  webhookUrl: 'https://customer.example.invalid/hook',
  traceId: 't-1',
  status: 'no_match' as const,
  result: null,
  charge: 0,
  propertyRecord: null,
  ownerType: 'individual',
}

describe('trace.completed carries the tier and the Tier 1 outcome', () => {
  it('stamps tier 1 and the three outcome keys on a supplied-owner trace', () => {
    // MUTATION: hard-code `tier: TRACE_TIER.PER_RECORD_SUBMITTED` back into the payload and this goes red.
    dispatchTraceCompleted({
      ...base, tier: 1, foundBy: null, outcomeCode: 'no_match',
      skipReason: 'We looked this owner up by address and found no match. You were not charged.',
    })
    expect(posts[0]).toMatchObject({
      event: 'trace.completed', tier: 1, found_by: null, outcome_code: 'no_match',
      skip_reason: 'We looked this owner up by address and found no match. You were not charged.',
      property_record: null,
    })
  })

  it('keeps tier 2 on a Full Property Trace, with the outcome keys present and null', () => {
    dispatchTraceCompleted({ ...base, tier: 2 })
    expect(posts[0]).toMatchObject({ tier: 2, found_by: null, outcome_code: null, skip_reason: null })
    expect(Object.keys(posts[0])).toEqual(expect.arrayContaining(['found_by', 'outcome_code', 'skip_reason']))
  })
})
```

In `lib/trace/__tests__/rowSkipReason.test.ts` add the import `import { BUSY_TRY_AGAIN_REASON, OWNER_NAME_NOT_MATCHED_REASON } from '@/lib/trace/tier1Outcome';` and append:

```ts
describe('the Tier 1 outcome through the one accessor (spec 7.2)', () => {
  it('serves the Tier 1 sentence on a single-trace row', () => {
    expect(rowSkipReason({ outcome_code: 'owner_name_not_matched', is_successful: false })).toBe(OWNER_NAME_NOT_MATCHED_REASON);
  });

  it('lets a Tier 2 terminal status win over a stale Tier 1 outcome', () => {
    // A single-trace row can be re-enqueued by a bulk tier 2 submit (the row is REUSED); its stale
    // "not charged" sentence must never answer for a row tier 2 billed.
    // MUTATION: put tier1OutcomeReason first in rowSkipReason and this goes red.
    expect(
      rowSkipReason({ outcome_code: 'no_match', trace_steps: [], is_successful: false, property_trace_status: PROPERTY_TRACE_NO_REACH_STATUS })
    ).toBe(PROPERTY_TRACE_NO_REACH_REASON);
  });

  it('lets the Tier 1 outcome win over a stale ai_research_status', () => {
    // MUTATION: put skipReasonFor before tier1OutcomeReason and this goes red.
    expect(
      rowSkipReason({ outcome_code: 'busy_try_again', is_successful: false, ai_research_status: BLANK_OWNER_SKIP_STATUS })
    ).toBe(BUSY_TRY_AGAIN_REASON);
  });
});
```

In `lib/trace/__tests__/exportCsv.test.ts` add `import { OWNER_NAME_NOT_MATCHED_REASON } from '@/lib/trace/tier1Outcome';` and, next to the other `skip_reason` tests:

```ts
  it('carries a single trace Tier 1 sentence in the existing skip_reason column', () => {
    const c = cells(row({ outcome_code: 'owner_name_not_matched', is_successful: false }));
    expect(c.skip_reason).toBe(`"${OWNER_NAME_NOT_MATCHED_REASON}"`);
  });
```

In `lib/trace/__tests__/propertyRecordEgress.test.ts`, inside its `dispatch()` helper's `dispatchTraceCompleted({ ... })` object add `tier: 2,` after `ownerType: 'entity',`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run lib/trace`
Expected: FAIL (`@/lib/trace/tier1Outcome` does not exist; the webhook payload has no outcome keys).

- [ ] **Step 3: Implement**

Create `lib/trace/tier1Outcome.ts`:

```ts
/**
 * Every Tier 1 record ends with one outcome code, one sentence, and the key that found the owner
 * (spec 7.1, D10). Pure: no I/O. The codes live in trace_history.outcome_code; the sentences are
 * rebuilt from the row whenever a surface shows one, so the copy has exactly one source.
 *
 * COPY RULES (spec 7.3), enforced in lib/trace/__tests__/tier1Outcome.test.ts: every sentence
 * states the charge; no price, dollar sign, dash or emoji; resend advice only on busy_try_again
 * and no_lookup_key. A sentence never says a parcel ID was "not recognized": Tracerfy answers an
 * unknown parcel id with an ordinary hit:false (Phase 0, t1_nothing_found).
 */
import { stepLogFrom, type ExecutionResult, type StepReport } from '@/lib/routing/executeRoute'
import type { StepKind } from '@/lib/routing/ownerRoute'

export const TIER1_OUTCOME = {
  FOUND_BY_ADDRESS: 'found_by_address',
  FOUND_BY_PARCEL_ID: 'found_by_parcel_id',
  FOUND_BY_COMPANY_NAME: 'found_by_company_name',
  NO_MATCH: 'no_match',
  OWNER_NAME_NOT_MATCHED: 'owner_name_not_matched',
  NO_LOOKUP_KEY: 'no_lookup_key',
  BUSY_TRY_AGAIN: 'busy_try_again',
} as const

export type Tier1OutcomeCode = (typeof TIER1_OUTCOME)[keyof typeof TIER1_OUTCOME]

/** The KEY that found the owner. Never the vendor, which stays in contact_vendor. */
export type FoundBy = 'address' | 'parcel_id' | 'company_name'

const FOUND_BY_STEP: Partial<Record<StepKind, FoundBy>> = {
  TRACERFY_INSTANT_NAMED: 'address',
  TRACERFY_PARCEL_APN: 'parcel_id',
  FASTAPPEND_ENTITY: 'company_name',
}

const FOUND_BY_OUTCOME: Record<FoundBy, Tier1OutcomeCode> = {
  address: TIER1_OUTCOME.FOUND_BY_ADDRESS,
  parcel_id: TIER1_OUTCOME.FOUND_BY_PARCEL_ID,
  company_name: TIER1_OUTCOME.FOUND_BY_COMPANY_NAME,
}

const KEY_WORDS: Record<FoundBy, string> = {
  address: 'address',
  parcel_id: 'parcel ID',
  company_name: 'company name',
}

/** A step the vendor actually answered. A skipped or failed step never was. */
const answered = (s: StepReport): boolean =>
  s.outcome === 'hit' || s.outcome === 'miss' || s.outcome === 'name_not_matched'

/** The one outcome for a Tier 1 execution, in precedence order. */
export function tier1OutcomeFor(execution: ExecutionResult): { outcome: Tier1OutcomeCode; foundBy: FoundBy | null } {
  const steps = execution.steps
  // D7: any vendor failure ends the record busy_try_again, whatever answered before it.
  if (steps.some(s => s.outcome === 'failed')) return { outcome: TIER1_OUTCOME.BUSY_TRY_AGAIN, foundBy: null }
  if (execution.contactsFound) {
    const delivering = steps.find(s => s.outcome === 'hit' && !s.noContacts)
    const foundBy = delivering ? FOUND_BY_STEP[delivering.kind] ?? null : null
    if (foundBy) return { outcome: FOUND_BY_OUTCOME[foundBy], foundBy }
  }
  if (steps.some(s => s.outcome === 'name_not_matched')) {
    return { outcome: TIER1_OUTCOME.OWNER_NAME_NOT_MATCHED, foundBy: null }
  }
  if (steps.some(answered)) return { outcome: TIER1_OUTCOME.NO_MATCH, foundBy: null }
  return { outcome: TIER1_OUTCOME.NO_LOOKUP_KEY, foundBy: null }
}

export const BUSY_TRY_AGAIN_REASON = 'The system is busy. Try again in 5 minutes. You were not charged.'

export const OWNER_NAME_NOT_MATCHED_REASON =
  'We found people linked to this property, but none matched the owner name, so no contacts were returned. You were not charged.'

const joinKeys = (keys: string[]): string =>
  keys.length <= 2 ? keys.join(' and ') : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`

/** "We looked this owner up by ..." naming only the keys that answered, or null when none did. */
export function noMatchReason(steps: StepReport[]): string | null {
  const keys: string[] = []
  for (const s of steps) {
    if (!answered(s)) continue
    const key = FOUND_BY_STEP[s.kind]
    if (key && !keys.includes(KEY_WORDS[key])) keys.push(KEY_WORDS[key])
  }
  if (!keys.length) return null
  return `We looked this owner up by ${joinKeys(keys)} and found no match. You were not charged.`
}

export type MissingLookupKey = 'city_and_parcel' | 'state' | 'street_and_parcel'

const MISSING_WORDS: Record<MissingLookupKey, { missing: string; resend: string }> = {
  city_and_parcel: { missing: 'the city and the parcel ID', resend: 'the city or the parcel ID' },
  state: { missing: 'a valid state', resend: 'a valid two-letter state' },
  street_and_parcel: { missing: 'a street address and the parcel ID', resend: 'the street address or the parcel ID' },
}

export function noLookupKeyReason(missing: MissingLookupKey): string {
  const w = MISSING_WORDS[missing]
  return `This record is missing ${w.missing}, so it could not be looked up. You were not charged. Send it again with ${w.resend}.`
}

/**
 * What a person, trust or unknown owner's record lacks to be looked up, or null when it has a key.
 * A parcel id counts only with its county. A company never needs this: it needs only a state.
 */
export function missingLookupKey(input: {
  address?: string | null
  city?: string | null
  state?: string | null
  apn?: string | null
  county?: string | null
}): MissingLookupKey | null {
  const has = (v?: string | null): boolean => typeof v === 'string' && v.trim() !== ''
  if (!/^[A-Za-z]{2}$/.test((input.state ?? '').trim())) return 'state'
  if (has(input.apn) && has(input.county)) return null
  if (!has(input.city)) return 'city_and_parcel'
  if (!has(input.address)) return 'street_and_parcel'
  return null
}

/** The sentence for an outcome, or null when there is nothing to explain. */
export function outcomeSentence(
  outcome: Tier1OutcomeCode,
  steps: StepReport[],
  missing: MissingLookupKey | null,
): string | null {
  switch (outcome) {
    case TIER1_OUTCOME.BUSY_TRY_AGAIN:
      return BUSY_TRY_AGAIN_REASON
    case TIER1_OUTCOME.OWNER_NAME_NOT_MATCHED:
      return OWNER_NAME_NOT_MATCHED_REASON
    case TIER1_OUTCOME.NO_MATCH:
      return noMatchReason(steps)
    case TIER1_OUTCOME.NO_LOOKUP_KEY:
      return missing ? noLookupKeyReason(missing) : null
    default:
      // found_by_*: the contacts are shown, there is nothing to explain.
      return null
  }
}

/** The columns tier1OutcomeReason reads. Structural and optional, like SkipReasonRow. */
export interface Tier1OutcomeRow {
  outcome_code?: string | null
  trace_steps?: unknown
  is_successful?: boolean | null
  normalized_address?: string | null
  city?: string | null
  state?: string | null
  parcel_id_local?: string | null
  county?: string | null
}

/** The street part of a stored duplicate key, or '' for a parcel-keyed row ("APN|..."). */
const streetOf = (normalized?: string | null): string =>
  !normalized || normalized.startsWith('APN|') ? '' : normalized.split('|')[0] ?? ''

/** Why a stored Tier 1 row came back with no contacts, or null. Nothing invented (CLAUDE.md rule 7). */
export function tier1OutcomeReason(row: Tier1OutcomeRow): string | null {
  if (row.is_successful === true || !row.outcome_code) return null
  const outcome = Object.values(TIER1_OUTCOME).find(c => c === row.outcome_code)
  if (!outcome) return null
  const missing =
    outcome === TIER1_OUTCOME.NO_LOOKUP_KEY
      ? missingLookupKey({
          address: streetOf(row.normalized_address),
          city: row.city,
          state: row.state,
          apn: row.parcel_id_local,
          county: row.county,
        })
      : null
  // The log is JSONB, so it is read through the validating reader, never cast.
  return outcomeSentence(outcome, stepLogFrom(row.trace_steps), missing)
}
```

In `lib/trace/rowSkipReason.ts`, add `import { tier1OutcomeReason, type Tier1OutcomeRow } from '@/lib/trace/tier1Outcome';`, change the row type and the function to:

```ts
export type SkipReasonRow = Tier1OutcomeRow & {
  ai_research_status?: string | null;
  property_trace_status?: string | null;
};

/**
 * Why this row came back with no contacts, or null when there is nothing to say.
 *
 * Tier 2 first, deliberately (see the header). Then a single trace's Tier 1 outcome (spec 7.2):
 * a Tier 1 single row clears both queue columns when it settles, so a queue value can only be
 * stale there, while a bulk tier 2 re-enqueue sets property_trace_status and must win over a stale
 * outcome_code on a reused row.
 */
export function rowSkipReason(row: SkipReasonRow): string | null {
  return (
    propertyTraceSkipReason(row.property_trace_status) ??
    tier1OutcomeReason(row) ??
    skipReasonFor(row.ai_research_status)
  );
}
```

In `lib/trace/traceCompletedWebhook.ts`: in the header, replace "The `trace.completed` webhook for a TIER 2 trace." with "The `trace.completed` webhook for a trace that completes INLINE: every Tier 2 trace, and since Tier 1 Phase 1 every single Tier 1 trace." In `TraceCompletedWebhookInput` add after `ownerType?: string | null;`:

```ts
  /** 1 for a supplied-owner trace, 2 for a Full Property Trace. */
  tier: 1 | 2;
  /** Tier 1 only (spec 7.1). Null on a Full Property Trace. */
  foundBy?: string | null;
  outcomeCode?: string | null;
  skipReason?: string | null;
```

and in the payload replace `tier: TRACE_TIER.PER_RECORD_SUBMITTED,` and `owner_type: input.ownerType ?? null,` with:

```ts
      tier: input.tier,
      owner_type: input.ownerType ?? null,
      // Tier 1 (spec 7.2). Always present, null on a Full Property Trace, so the shape a
      // consumer parses does not change with the tier.
      found_by: input.foundBy ?? null,
      outcome_code: input.outcomeCode ?? null,
      skip_reason: input.skipReason ?? null,
```

Remove the now-unused `import { TRACE_TIER } from './billedRows';` from that file.

In `app/api/trace/single/route.ts` and `app/api/v1/trace/single/route.ts`, inside the existing Tier 2 `dispatchTraceCompleted({ ... })`, add `tier: TRACE_TIER.PER_RECORD_SUBMITTED,` after `ownerType: execution.ownerType,`.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run lib/trace app/api/trace/single app/api/v1/trace/single` then `npx tsc --noEmit`.
Expected: PASS, 0 errors.

- [ ] **Step 5: Mutations**

1. Delete the `steps.some(s => s.outcome === 'failed')` line in `tier1OutcomeFor`: `'any failed step is busy_try_again'` goes red.
2. Append ` Try again later.` to `OWNER_NAME_NOT_MATCHED_REASON`: `'resend advice appears on exactly busy_try_again and no_lookup_key'` goes red.
3. Swap the first two terms of `rowSkipReason`: `'lets a Tier 2 terminal status win over a stale Tier 1 outcome'` goes red. Swap the last two: `'lets the Tier 1 outcome win over a stale ai_research_status'` goes red.
4. Put `tier: TRACE_TIER.PER_RECORD_SUBMITTED` back in the webhook payload: `'stamps tier 1 and the three outcome keys'` goes red.
5. Drop `if (!answered(s)) continue` in `noMatchReason`: the skipped-step expectation goes red.

- [ ] **Step 6: Suite, History, commit**

Run: `npx vitest run`. Expected: 0 failed.

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 7: outcome codes, sentences and the webhook tier.

- New lib/trace/tier1Outcome.ts: the seven outcome codes, found_by, and the sentences, built from
  the step log (no_match names only the keys that answered) and from the record (no_lookup_key
  names what is missing). Copy rules tested on every sentence; resend advice only on
  busy_try_again and no_lookup_key.
- rowSkipReason reads the Tier 1 outcome after the Tier 2 status and before the old queue value,
  so the single CSV download's skip_reason column carries the sentence. No new CSV columns.
- trace.completed takes its tier from the caller and always carries found_by, outcome_code and
  skip_reason. Mutations: all red.
```

```bash
git add lib/trace/tier1Outcome.ts lib/trace/rowSkipReason.ts lib/trace/traceCompletedWebhook.ts app/api/trace/single/route.ts app/api/v1/trace/single/route.ts lib/trace/__tests__/tier1Outcome.test.ts lib/trace/__tests__/traceCompletedWebhook.test.ts lib/trace/__tests__/rowSkipReason.test.ts lib/trace/__tests__/exportCsv.test.ts lib/trace/__tests__/propertyRecordEgress.test.ts History.md tasks/todo.md
git commit -m "$(cat <<'EOF'
feat(trace): Tier 1 outcome codes and sentences; rowSkipReason and trace.completed carry them

Tier 1 Phase 1, Task 7.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The shared Tier 1 settle helper (spec 6.1, 5.2; D8)

**Files:**
- Create: `lib/trace/singleTier1.ts`
- Test: create `lib/trace/__tests__/singleTier1.test.ts`; modify `lib/trace/__tests__/chargeReceipt.test.ts` (`mustFold` list)

**Interfaces:**
- Consumes: `planRoute` (Task 2); `executeRoute`, `stepLogFrom`, `contactVendorFrom`, `requestKeyFor` (Task 5); `traceResultFor`, `hasContactData` (Task 6); `tier1OutcomeFor`, `outcomeSentence`, `missingLookupKey`, `TIER1_OUTCOME` (Task 7); `collectedChargeFor`, `deductWallet`, `foldBillingWrite`, `TRACE_TIER`.
- Produces:
  - `export const TIER1_CHARGE_DESCRIPTION = 'Skip trace - successful match'`
  - `export interface SingleTier1Row extends CacheHitRow { id: string; outcome_code?: string | null; trace_steps?: unknown }`
  - `export interface SingleTier1Input { adminClient: SupabaseClient; userId: string; row: SingleTier1Row; parcel: ParcelInput; pricePlan: PricePlan; chargeAmount: number; deadlineMs: number; deps: RouteDeps }`
  - `export type Tier1Deduction = 'not_attempted' | 'already_collected' | 'charged' | 'insufficient_balance' | 'error'`
  - `export interface SingleTier1Result { execution: ExecutionResult; outcome: Tier1OutcomeCode; foundBy: FoundBy | null; skipReason: string | null; result: TraceResult | null; status: 'success' | 'no_match' | 'error'; charge: number; deduction: Tier1Deduction; persistError: string | null }`
  - `export async function runSingleTier1(input: SingleTier1Input): Promise<SingleTier1Result>`: plans, executes (resuming only a `busy_try_again` row's log), judges, probes the ledger, deducts at most once, folds, and writes one UPDATE with `status, trace_result, phone_count, email_count, is_successful, charge, tier, cost, contact_vendor, outcome_code, found_by, trace_steps, tracerfy_job_id: null, ai_research_status: null, property_trace_status: null`. It never writes `property_record`.

- [ ] **Step 1: Write the failing tests**

Create `lib/trace/__tests__/singleTier1.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runSingleTier1, TIER1_CHARGE_DESCRIPTION, type SingleTier1Input } from '@/lib/trace/singleTier1'
import { requestKeyFor, type ContactResult, type RouteDeps, type StepReport } from '@/lib/routing/executeRoute'
import { planRoute, type ParcelInput } from '@/lib/routing/ownerRoute'
import { BUSY_TRY_AGAIN_REASON, OWNER_NAME_NOT_MATCHED_REASON } from '@/lib/trace/tier1Outcome'

type Op = { table: string; op: 'select' | 'update'; payload?: Record<string, unknown>; filters: unknown[][] }

const H = {
  ops: [] as Op[],
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  ledger: [] as Array<Record<string, unknown>>,
  deductData: true as unknown,
  deductError: null as { message: string } | null,
}

/** Records every select and update; answers wallet_transactions from H.ledger. */
function adminClient(): SupabaseClient {
  return {
    from(table: string) {
      const rec: Op = { table, op: 'select', filters: [] }
      const node: Record<string, unknown> = {}
      node.select = () => { rec.op = 'select'; H.ops.push(rec); return node }
      node.update = (payload: Record<string, unknown>) => { rec.op = 'update'; rec.payload = payload; H.ops.push(rec); return node }
      node.eq = (...args: unknown[]) => { rec.filters.push(['eq', ...args]); return node }
      node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(
          rec.op === 'update'
            ? { data: null, error: null }
            : { data: table === 'wallet_transactions' ? H.ledger : null, error: null }
        ).then(res, rej)
      return node
    },
    rpc(fn: string, args: Record<string, unknown>) {
      H.rpc.push({ fn, args })
      return Promise.resolve({ data: H.deductData, error: H.deductError })
    },
  } as unknown as SupabaseClient
}

const HIT: ContactResult = {
  success: true, hit: true, creditsDeducted: 5,
  contacts: { ownerName: 'Marcus Halloway', phones: [{ number: '5550000101', type: 'mobile' }], emails: [], mailingAddress: null },
}
const MISS: ContactResult = { success: true, hit: false, contacts: null, creditsDeducted: 0 }
const NOT_MATCHED: ContactResult = {
  success: true, hit: true, contacts: null, nameNotMatched: true,
  people: [{ first_name: 'Someoneelse', last_name: 'Different' }], creditsDeducted: 5,
}
const CONTACTLESS: ContactResult = {
  success: true, hit: true,
  contacts: { ownerName: 'Marcus Halloway', phones: [], emails: [], mailingAddress: null },
}
const DOWN: ContactResult = { success: false, hit: false, contacts: null, error: 'Tracerfy did not answer within 25 s' }

/** A street and a city, no parcel id: the person ladder is the Instant lookup alone. */
const PARCEL: ParcelInput = {
  state: 'OH', situsAddress: '100 Placeholder Way', situsCity: 'Placeholderville', situsState: 'OH',
  situsZip: null, parcelIdLocal: null, county: null, ownerName: 'Marcus T Halloway',
}

const deps = (over: Partial<RouteDeps> = {}): RouteDeps => ({
  lookupDossier: vi.fn(),
  traceEntity: vi.fn(async () => MISS),
  tracePerson: vi.fn(async () => MISS),
  ...over,
})

const run = (over: Partial<SingleTier1Input> = {}) =>
  runSingleTier1({
    adminClient: adminClient(),
    userId: 'user-1',
    row: { id: 'row-1', charge: 0, tier: null },
    parcel: PARCEL,
    pricePlan: 'pro',
    chargeAmount: 0.15,
    deadlineMs: Date.now() + 50_000,
    deps: deps(),
    ...over,
  })

const persisted = () => H.ops.find(o => o.op === 'update')?.payload
const deducts = () => H.rpc.filter(c => c.fn === 'deduct_wallet_balance')

beforeEach(() => {
  H.ops = []
  H.rpc = []
  H.ledger = []
  H.deductData = true
  H.deductError = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runSingleTier1: the billing gate (spec 6.1, D8)', () => {
  it('charges once, at the rate it was given, for a name-matched result with a phone', async () => {
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(deducts()).toHaveLength(1)
    expect(deducts()[0].args).toEqual({
      p_user_id: 'user-1', p_amount: 0.15, p_trace_history_id: 'row-1', p_description: TIER1_CHARGE_DESCRIPTION,
    })
    expect(r).toMatchObject({
      outcome: 'found_by_address', foundBy: 'address', status: 'success', charge: 0.15, deduction: 'charged', skipReason: null,
    })
    expect(persisted()).toMatchObject({
      status: 'success', is_successful: true, charge: 0.15, tier: 1, outcome_code: 'found_by_address',
      found_by: 'address', contact_vendor: 'tracerfy', cost: 0.1, tracerfy_job_id: null,
      ai_research_status: null, property_trace_status: null,
    })
  })

  it('charges nothing for a matched owner with no phone and no email', async () => {
    // MUTATION: `const billable = true` (or any gate but hasContactData(result)) and this goes red.
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => CONTACTLESS) }) })
    expect(deducts()).toHaveLength(0)
    expect(r).toMatchObject({ outcome: 'no_match', status: 'no_match', charge: 0 })
  })

  it('charges nothing when the people returned are not the owner (D6), and logs what the vendor billed', async () => {
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => NOT_MATCHED) }) })
    expect(deducts()).toHaveLength(0)
    expect(r.skipReason).toBe(OWNER_NAME_NOT_MATCHED_REASON)
    expect(persisted()).toMatchObject({ outcome_code: 'owner_name_not_matched', charge: 0, cost: 0.1 })
    expect((persisted()!.trace_steps as StepReport[])[0]).toMatchObject({
      outcome: 'name_not_matched', creditsDeducted: 5, people: [{ first_name: 'Someoneelse', last_name: 'Different' }],
    })
  })

  it('a vendor failure, a timeout included, is busy_try_again: free, with its step log kept', async () => {
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => DOWN) }) })
    expect(deducts()).toHaveLength(0)
    expect(r).toMatchObject({ outcome: 'busy_try_again', status: 'error', charge: 0, skipReason: BUSY_TRY_AGAIN_REASON })
    expect(persisted()).toMatchObject({ status: 'error', is_successful: false, outcome_code: 'busy_try_again' })
    expect((persisted()!.trace_steps as StepReport[])[0]).toMatchObject({
      outcome: 'failed', error: 'Tracerfy did not answer within 25 s',
    })
  })

  it('our own refused input is never busy_try_again (spec 5.1)', async () => {
    const refused: ContactResult = {
      success: false, hit: false, contacts: null, error: 'Person trace requires address, city and state', inputError: true,
    }
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => refused) }) })
    expect(r.outcome).not.toBe('busy_try_again')
    expect(deducts()).toHaveLength(0)
  })
})

describe('runSingleTier1: the ledger probe (spec 6.1)', () => {
  it('records, and does not take again, a debit an earlier attempt booked but never wrote to the row', async () => {
    // The crash window: deduct, then die before the persist. The resend must not charge twice.
    // MUTATION: delete the probe (always deduct) and this goes red with a second debit.
    H.ledger = [{ amount: 0.15, type: 'debit', created_at: '2026-09-22T11:59:00.000Z' }]
    const r = await run({ deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(deducts()).toHaveLength(0)
    expect(r).toMatchObject({ charge: 0.15, deduction: 'already_collected' })
    expect(persisted()).toMatchObject({ charge: 0.15, tier: 1 })
  })

  it('still charges a new purchase on a reused row whose earlier debits are already on the row', async () => {
    // MUTATION: probe for ANY debit (`ledger !== null && ledger > 0`) instead of an unrecorded one and this goes red.
    H.ledger = [{ amount: 0.25, type: 'debit', created_at: '2026-08-01T00:00:00.000Z' }]
    const r = await run({ row: { id: 'row-1', charge: 0.25, tier: 2 }, deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(deducts()).toHaveLength(1)
    expect(r.charge).toBe(0.15)
    // Folded onto the receipt; a tier 2 receipt never downgrades.
    // MUTATION: write `{ charge: collectedNow, tier: 1 }` instead of the fold and this goes red.
    expect(persisted()).toMatchObject({ charge: 0.4, tier: 2 })
  })

  it('asks the ledger nothing when nothing is billable', async () => {
    await run()
    expect(H.ops.some(o => o.table === 'wallet_transactions')).toBe(false)
  })
})

describe('runSingleTier1: the busy_try_again resend (spec 5.2)', () => {
  const TRUST: ParcelInput = { ...PARCEL, ownerName: 'Marcus Halloway Revocable Trust' }
  const loggedInstantMiss = (): StepReport[] => [{
    kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss', cost: 0,
    at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    requestKey: requestKeyFor(planRoute(TRUST, 'pro').steps[0]),
  }]

  it('resumes a busy row: the answered Instant step is not bought again', async () => {
    const d = deps()
    await run({
      parcel: TRUST, deps: d,
      row: { id: 'row-1', charge: 0, tier: 1, outcome_code: 'busy_try_again', trace_steps: loggedInstantMiss() },
    })
    expect(d.tracePerson).not.toHaveBeenCalled()
    expect(d.traceEntity).toHaveBeenCalledTimes(1)
    expect((persisted()!.trace_steps as StepReport[])[0]).toMatchObject({ outcome: 'miss', reused: true })
  })

  it('runs a row that is NOT busy fresh, whatever its log says', async () => {
    // MUTATION: pass the log through whatever the outcome_code and this goes red.
    const d = deps()
    await run({
      parcel: TRUST, deps: d,
      row: { id: 'row-1', charge: 0, tier: 1, outcome_code: 'no_match', trace_steps: loggedInstantMiss() },
    })
    expect(d.tracePerson).toHaveBeenCalledTimes(1)
  })
})

describe('runSingleTier1: what it writes', () => {
  it('never writes property_record, so a reused billed tier 2 row keeps the record it paid for', async () => {
    await run({ deps: deps({ tracePerson: vi.fn(async () => HIT) }) })
    expect(persisted()).not.toHaveProperty('property_record')
  })

  it('names every key that answered in the no_match sentence', async () => {
    const r = await run({ parcel: { ...PARCEL, ownerName: 'Marcus Halloway Revocable Trust' } })
    expect(r.skipReason).toBe('We looked this owner up by address and company name and found no match. You were not charged.')
  })
})
```

In `lib/trace/__tests__/chargeReceipt.test.ts`, add `"lib/trace/singleTier1.ts",` to the `mustFold` array in `'folds the settles that reach reused rows'`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run lib/trace/__tests__/singleTier1.test.ts lib/trace/__tests__/chargeReceipt.test.ts`
Expected: FAIL (`@/lib/trace/singleTier1` does not exist; `readFileSync` of it throws in chargeReceipt).

- [ ] **Step 3: Implement `lib/trace/singleTier1.ts`**

```ts
/**
 * A supplied-owner (Tier 1) single trace, run INLINE (spec D1, D26): plan, execute, judge,
 * charge, persist.
 *
 * Shared by app/api/trace/single (Track A price) and app/api/v1/trace/single (Track B price), so
 * the billing gate, the ledger probe and the fold live in ONE place and one set of tests fences
 * both routes. The routes keep what differs: auth, the price, the response casing, the webhook.
 *
 * `execution.steps` is the step log. It is written to trace_steps and read back only by the next
 * resend of a busy_try_again row. It never goes into a response or a webhook.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  contactVendorFrom,
  executeRoute,
  stepLogFrom,
  type ExecutionResult,
  type RouteDeps,
} from '@/lib/routing/executeRoute'
import { planRoute, type ParcelInput, type PricePlan } from '@/lib/routing/ownerRoute'
import { foldBillingWrite, TRACE_TIER, type CacheHitRow } from '@/lib/trace/billedRows'
import { hasContactData, traceResultFor } from '@/lib/trace/fullPropertyTrace'
import {
  missingLookupKey,
  outcomeSentence,
  tier1OutcomeFor,
  TIER1_OUTCOME,
  type FoundBy,
  type Tier1OutcomeCode,
} from '@/lib/trace/tier1Outcome'
import { collectedChargeFor } from '@/lib/wallet/collectedCharge'
import { deductWallet } from '@/lib/wallet/deduct'
import type { TraceResult } from '@/types'

/** The wallet ledger line: the words the retired poll route wrote for a Tier 1 charge. */
export const TIER1_CHARGE_DESCRIPTION = 'Skip trace - successful match'

/** The row this request reused or inserted, as it stood BEFORE this attempt. */
export interface SingleTier1Row extends CacheHitRow {
  id: string
  outcome_code?: string | null
  trace_steps?: unknown
}

export interface SingleTier1Input {
  adminClient: SupabaseClient
  userId: string
  row: SingleTier1Row
  /** The record, with ownerName set. */
  parcel: ParcelInput
  pricePlan: PricePlan
  /** chargePerTrace(profile) on the web, getChargePerTrace(...) on the API. */
  chargeAmount: number
  /** Request start + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS. */
  deadlineMs: number
  deps: RouteDeps
}

export type Tier1Deduction = 'not_attempted' | 'already_collected' | 'charged' | 'insufficient_balance' | 'error'

export interface SingleTier1Result {
  execution: ExecutionResult
  outcome: Tier1OutcomeCode
  foundBy: FoundBy | null
  /** The customer's sentence, or null when contacts were delivered. */
  skipReason: string | null
  result: TraceResult | null
  status: 'success' | 'no_match' | 'error'
  /** What THIS request collected: 0, the rate, or a debit an earlier crashed attempt booked. */
  charge: number
  deduction: Tier1Deduction
  persistError: string | null
}

const round2 = (n: number): number => Math.round(n * 100) / 100

export async function runSingleTier1(input: SingleTier1Input): Promise<SingleTier1Result> {
  const plan = planRoute(input.parcel, input.pricePlan)

  // Only a busy_try_again row RESUMES (spec 5.2). Any other finished row runs fresh, and an answer
  // older than 24 hours is never reused either way: executeRoute judges each entry by its own time,
  // because a reused row keeps its original created_at.
  const priorSteps =
    input.row.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN ? stepLogFrom(input.row.trace_steps) : []

  const execution = await executeRoute(plan, input.deps, { deadlineMs: input.deadlineMs, priorSteps })
  const { outcome, foundBy } = tier1OutcomeFor(execution)
  const result = traceResultFor(execution)

  // THE BILLING GATE (spec 6.1, D8): a name-matched result with at least one phone or email.
  // Everything else is free: no_match, owner_name_not_matched, no_lookup_key, busy_try_again.
  const billable = hasContactData(result)

  let collectedNow = 0
  let deduction: Tier1Deduction = 'not_attempted'
  if (billable) {
    // THE LEDGER PROBE. A debit the row does not show yet means an earlier attempt at THIS record
    // deducted and died before its persist: that money is this record's charge, so it is recorded,
    // never taken again. Asked as "unrecorded", not "any debit", because a reused row legitimately
    // carries debits from earlier, separate purchases that its charge column already shows.
    const ledger = await collectedChargeFor(input.adminClient, input.row.id)
    const recorded = Number(input.row.charge ?? 0) || 0
    const unrecorded = ledger === null ? 0 : round2(ledger - recorded)
    if (unrecorded > 0) {
      collectedNow = unrecorded
      deduction = 'already_collected'
    } else {
      const d = await deductWallet(input.adminClient, {
        p_user_id: input.userId,
        p_amount: input.chargeAmount,
        p_trace_history_id: input.row.id,
        p_description: TIER1_CHARGE_DESCRIPTION,
      })
      collectedNow = d.collected
      deduction = d.outcome
      if (d.outcome === 'error') {
        console.error('Single trace tier 1 - wallet deduct failed, contacts delivered uncharged:', input.row.id, d.message)
      }
    }
  }

  // RECEIPTS ARE MONOTONIC: folded onto what the row already carried, tier never downgraded.
  const billing = foldBillingWrite(input.row, { charge: collectedNow, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE })
  const status: SingleTier1Result['status'] =
    outcome === TIER1_OUTCOME.BUSY_TRY_AGAIN ? 'error' : billable ? 'success' : 'no_match'
  const skipReason = billable
    ? null
    : outcomeSentence(
        outcome,
        execution.steps,
        missingLookupKey({
          address: input.parcel.situsAddress,
          city: input.parcel.situsCity,
          state: input.parcel.state,
          apn: input.parcel.parcelIdLocal,
          county: input.parcel.county,
        }),
      )

  const { error } = await input.adminClient
    .from('trace_history')
    .update({
      status,
      trace_result: result,
      phone_count: result?.phones?.length || 0,
      email_count: result?.emails?.length || 0,
      is_successful: status === 'success',
      charge: billing.charge,
      tier: billing.tier,
      // What the vendors took for this record, answers reused from the log included.
      cost: round2(execution.steps.reduce((sum, s) => sum + s.cost, 0)),
      contact_vendor: contactVendorFrom(execution.steps),
      outcome_code: outcome,
      found_by: foundBy,
      trace_steps: execution.steps,
      tracerfy_job_id: null,
      // A reused row can carry a stale queue value from a bulk job; it must not answer
      // rowSkipReason for this single trace.
      ai_research_status: null,
      property_trace_status: null,
    })
    .eq('id', input.row.id)

  return {
    execution,
    outcome,
    foundBy,
    skipReason,
    result,
    status,
    charge: collectedNow,
    deduction,
    persistError: error ? error.message : null,
  }
}
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run lib/trace` then `npx tsc --noEmit`.
Expected: PASS (chargeReceipt and tierLedger included), 0 errors.

- [ ] **Step 5: Mutations**

1. `const billable = true`: `'charges nothing for a matched owner with no phone and no email'` goes red.
2. Delete the `if (unrecorded > 0) { ... } else` branch so the deduct always runs: `'records, and does not take again, a debit'` goes red.
3. `const unrecorded = ledger !== null && ledger > 0 ? ledger : 0`: `'still charges a new purchase on a reused row'` goes red.
4. `const priorSteps = stepLogFrom(input.row.trace_steps)` (no busy test): `'runs a row that is NOT busy fresh'` goes red.
5. Replace the fold with `const billing = { charge: collectedNow, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE }`: the reused-row test (`charge: 0.4, tier: 2`) and chargeReceipt's `'folds the settles that reach reused rows'` go red.

- [ ] **Step 6: Suite, History, commit**

Run: `npx vitest run`. Expected: 0 failed.

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 8: one shared Tier 1 settle for both single routes.

- New lib/trace/singleTier1.ts: plans and runs the ladder inline, resuming only a busy row's step
  log, judges the outcome, charges once only for a name-matched phone or email, asks the ledger
  first (an unrecorded earlier debit is recorded, never taken again), folds the receipt, and writes
  outcome_code, found_by, trace_steps and contact_vendor. It never writes property_record.
- Pinned as must-fold in chargeReceipt.test.ts. Mutations: five, all red.
```

```bash
git add lib/trace/singleTier1.ts lib/trace/__tests__/singleTier1.test.ts lib/trace/__tests__/chargeReceipt.test.ts History.md tasks/todo.md
git commit -m "$(cat <<'EOF'
feat(trace): shared inline Tier 1 settle with the billing gate, ledger probe and fold

Tier 1 Phase 1, Task 8.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The web single route runs Tier 1 inline (D1, D25, D26; spec 5.2)

**Files:**
- Create: `lib/utils/ownerName.ts`
- Modify: `app/api/trace/single/route.ts`
- Test: create `lib/utils/__tests__/ownerName.test.ts`; modify `app/api/trace/single/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `runSingleTier1`, `SingleTier1Result` (Task 8); `TIER1_OUTCOME` (Task 7); `contactVendorFrom` (Task 5); `VENDOR_TIMEOUT` (Task 4); `dispatchTraceCompleted` with `tier` (Task 7).
- Produces:
  - `export function normalizeOwnerName(name?: string | null): string` and `export function ownerNamesMatch(a?: string | null, b?: string | null): boolean` (`lib/utils/ownerName.ts`).
  - Web Tier 1 response (200): `{ success: true, status: 'success' | 'no_match', trace_id, tier: 1, charge, result, property_record: null, owner_name, owner_type, needs_manual_review, found_by, outcome_code, skip_reason, warnings }`. Busy (503, `Retry-After: 300`): `{ success: false, status: 'error', trace_id, tier: 1, charge: 0, result: null, found_by: null, outcome_code: 'busy_try_again', skip_reason, error: skip_reason }`. Cache hits add `found_by` and `outcome_code` from the row.

- [ ] **Step 1: Write the failing tests**

Create `lib/utils/__tests__/ownerName.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { normalizeOwnerName, ownerNamesMatch } from '@/lib/utils/ownerName'

describe('ownerNamesMatch (D25)', () => {
  it.each([
    ['ACME HOLDINGS LLC', 'Acme Holdings, L.L.C.'],
    ['John T. Smith', 'JOHN SMITH'],
    ['John Smith Jr', 'john smith'],
  ])('%s is the same owner as %s', (a, b) => {
    expect(ownerNamesMatch(a, b)).toBe(true)
  })

  it.each([
    ['John Smith', 'Jane Smith'],
    ['SMITH JOHN', 'JOHN SMITH'],
    ['Acme Holdings LLC', null],
    [null, null],
  ])('%s is not the same owner as %s', (a, b) => {
    expect(ownerNamesMatch(a, b)).toBe(false)
  })

  it('normalises case, punctuation, suffixes and middle initials, never order', () => {
    expect(normalizeOwnerName('  Smith,  John T. Jr ')).toBe('SMITH JOHN')
  })
})
```

In `app/api/trace/single/__tests__/route.test.ts`:

(a) Every existing test that posts `BODY` (the Tier 1 body, owner `ACME HOLDINGS LLC`) and expects `H.cached` to be SERVED must now say whose result it is: add `input_owner_name: "ACME HOLDINGS LLC"` to that `H.cached`. Find them with `grep -n "H.cached = {" app/api/trace/single/__tests__/route.test.ts` and check each test's body; the two in `"POST /api/trace/single — cache hit"` are the known ones.

(b) Every `toHaveBeenCalledWith` on `lookupDossier`, `lookupBusinessTrace` or `lookupPersonTrace` (today at `:764`, `:1074`, `:1089`) gains a second argument `expect.objectContaining({ timeoutMs: expect.any(Number) })`: the route now passes its request budget.

(c) In `"tier 2 — the trigger"`, the test `"does NOT run when the owner of record was supplied"` changes its last assertion to:

```ts
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
```

(destructure `lookupBusinessTrace` from `vendorsCalled()` there).

(d) Replace the whole `describe("POST /api/trace/single — row creation and submission", ...)` block with:

```ts
describe("POST /api/trace/single: row creation, then the inline tier 1 settle", () => {
  it("inserts a processing row and settles it in the same request", async () => {
    const res = await post();
    const body = await res.json();

    const insert = H.ops.find((o) => o.op === "insert");
    expect(insert!.payload).toMatchObject({ user_id: "user-1", city: "AUSTIN", state: "TX", zip: "78701", status: "processing" });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: "no_match", trace_id: "trace-new", tier: 1, charge: 0 });
  });

  it("500s when the row cannot be created", async () => {
    H.insertError = { message: "duplicate key value violates unique constraint", code: "23505" };
    const res = await post();
    expect(res.status).toBe(500);
  });
});
```

(e) Replace the test `"does not fire on the TIER 1 path, where the poll route still owns it"` with:

```ts
  it("FIRES on the tier 1 path, which now completes inline, carrying tier 1 and its outcome", async () => {
    // MUTATION: delete the tier 1 dispatchTraceCompleted call and this goes red.
    H.profile = WEBHOOK_PROFILE;
    await post(BODY);
    expect(webhooks()).toHaveLength(1);
    expect(webhooks()[0].body).toMatchObject({
      event: "trace.completed", status: "no_match", tier: 1, charge: 0, property_record: null,
      found_by: null, outcome_code: "no_match",
      skip_reason: "We looked this owner up by company name and found no match. You were not charged.",
    });
  });
```

(f) Append at the end of the file (after every constant it uses is declared), and add `VENDOR_TIMEOUT` to the existing `import { PRICING } from "@/lib/constants";` and these imports at the top:

```ts
import { requestKeyFor } from "@/lib/routing/executeRoute";
import { planRoute } from "@/lib/routing/ownerRoute";
import { parcelForFullTrace } from "@/lib/trace/fullPropertyTrace";
```

```ts
/* ==================================================================== *
 * TIER 1, INLINE (spec D1, D26). The owner was supplied: planRoute and
 * executeRoute run inside the request. Only the vendors are mocked.
 * ==================================================================== */

/** The UPDATE that writes a tier 1 outcome: it carries outcome_code and never property_record. */
function tier1Persisted(): Record<string, unknown> | undefined {
  const rec = H.ops.find(
    (o) =>
      o.op === "update" &&
      o.payload !== null &&
      typeof o.payload === "object" &&
      "outcome_code" in (o.payload as object) &&
      !("property_record" in (o.payload as object))
  );
  return rec?.payload as Record<string, unknown> | undefined;
}

describe("tier 1 inline: what the caller gets", () => {
  it("returns the finished result with found_by, outcome_code and skip_reason, and no step log", async () => {
    H.entity = CONTACTS_HIT;
    const { submitSingleTrace, lookupBusinessTrace, lookupDossier } = await vendorsCalled();

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(lookupBusinessTrace).toHaveBeenCalledWith(
      { company_name: "ACME HOLDINGS LLC", state: "TX" },
      { timeoutMs: expect.any(Number) }
    );
    expect(body).toMatchObject({
      success: true, status: "success", trace_id: "trace-new", tier: 1,
      charge: PRICING.CHARGE_PER_SUCCESS_WALLET, found_by: "company_name",
      outcome_code: "found_by_company_name", skip_reason: null, property_record: null,
    });
    expect(body.result.phones).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/trace_steps|requestKey/);
  });

  it("persists the outcome, the key, the vendor and the step log, and never property_record", async () => {
    H.entity = CONTACTS_HIT;
    await post();
    expect(tier1Persisted()).toMatchObject({
      status: "success", is_successful: true, charge: PRICING.CHARGE_PER_SUCCESS_WALLET, tier: 1,
      contact_vendor: "fastappend", found_by: "company_name", outcome_code: "found_by_company_name",
      tracerfy_job_id: null, ai_research_status: null, property_trace_status: null,
    });
    expect(Array.isArray(tier1Persisted()!.trace_steps)).toBe(true);
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args).toMatchObject({
      p_amount: PRICING.CHARGE_PER_SUCCESS_WALLET, p_trace_history_id: "trace-new",
      p_description: "Skip trace - successful match",
    });
  });

  it("a miss is free and says which key was tried", async () => {
    const body = await (await post()).json();
    expect(deducts()).toHaveLength(0);
    expect(body).toMatchObject({
      status: "no_match", charge: 0, result: null, outcome_code: "no_match",
      skip_reason: "We looked this owner up by company name and found no match. You were not charged.",
    });
  });

  it("a person owner whose returned people do not match is free and says so", async () => {
    H.person = {
      success: true, hit: true, contacts: null, nameNotMatched: true,
      people: [{ first_name: "Someoneelse", last_name: "Different" }], creditsDeducted: 5,
    };
    const body = await (await post({ ...BODY, owner_name: "Testowner Placeholder" })).json();
    expect(deducts()).toHaveLength(0);
    expect(body.outcome_code).toBe("owner_name_not_matched");
    expect(body.skip_reason).toBe(
      "We found people linked to this property, but none matched the owner name, so no contacts were returned. You were not charged."
    );
  });

  it("a vendor failure is busy_try_again: 503, Retry-After, free, no webhook", async () => {
    // MUTATION: return 200 on the busy branch and this goes red.
    H.profile = WEBHOOK_PROFILE;
    H.entity = { success: false, hit: false, contacts: null, error: "FastAppend service unavailable" };
    const res = await post();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(body).toMatchObject({
      success: false, status: "error", outcome_code: "busy_try_again", charge: 0,
      error: "The system is busy. Try again in 5 minutes. You were not charged.",
    });
    expect(deducts()).toHaveLength(0);
    expect(webhooks()).toHaveLength(0);
    expect(tier1Persisted()).toMatchObject({ status: "error", outcome_code: "busy_try_again" });
  });

  it("passes the request budget to every vendor call", async () => {
    // MUTATION: pass `deadlineMs: startedAt + 10 * 60 * 1000` and this goes red.
    const { lookupBusinessTrace } = await vendorsCalled();
    await post();
    const opts = vi.mocked(lookupBusinessTrace).mock.calls[0][1] as { timeoutMs: number };
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS);
  });

  it("400s an owner name with no letters, before touching the database", async () => {
    const res = await post({ ...BODY, owner_name: "???" });
    expect(res.status).toBe(400);
    expect(H.ops.filter((o) => o.table === "trace_history")).toHaveLength(0);
  });
});

describe("tier 1 inline: money on this call site (L-018)", () => {
  it("records, and does not take again, a debit an earlier attempt booked", async () => {
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", charge: 0, tier: null };
    H.insertedRow = { id: "trace-new", charge: 0, tier: null };
    H.ledgerRefs = [{ amount: 0.25, type: "debit", created_at: "2026-09-22T11:59:00.000Z" }];
    const body = await (await post()).json();
    expect(deducts()).toHaveLength(0);
    expect(body.charge).toBe(0.25);
    expect(tier1Persisted()).toMatchObject({ charge: 0.25, tier: 1 });
  });

  it("folds a new charge onto the reused row's receipt", async () => {
    // MUTATION: pass `row: { id: traceRecord.id }` to runSingleTier1 and this goes red.
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", charge: 0.25, tier: 2, property_record: null };
    H.insertedRow = { id: "trace-new", charge: 0.25, tier: 2, property_record: null };
    H.ledgerRefs = [{ amount: 0.25, type: "debit", created_at: "2026-08-01T00:00:00.000Z" }];
    await post();
    expect(deducts()).toHaveLength(1);
    expect(tier1Persisted()).toMatchObject({ charge: 0.5, tier: 2 });
  });
});

describe("tier 1 inline: the busy_try_again resend (spec 5.2)", () => {
  const TRUST_BODY = { ...BODY, owner_name: "Marcus Halloway Revocable Trust" };
  const instantKey = () =>
    requestKeyFor(planRoute({ ...parcelForFullTrace(TRUST_BODY), ownerName: TRUST_BODY.owner_name }, "wallet").steps[0]);
  const busyRow = () => ({
    id: "trace-new", charge: 0, tier: 1, is_successful: false, property_record: null,
    outcome_code: "busy_try_again",
    trace_steps: [{
      kind: "TRACERFY_INSTANT_NAMED", outcome: "miss", cost: 0,
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), requestKey: instantKey(),
    }],
  });

  it("keeps the busy row: no sweep deletes it", async () => {
    // MUTATION: drop `|| busyResend` from runDelete and the failed sweep deletes it.
    H.survivingRow = busyRow();
    H.insertedRow = busyRow();
    await post(TRUST_BODY);
    expect(deletes()).toHaveLength(0);
  });

  it("does not buy the answered step again", async () => {
    H.survivingRow = busyRow();
    H.insertedRow = busyRow();
    const { lookupPersonTrace, lookupBusinessTrace } = await vendorsCalled();
    await post(TRUST_BODY);
    expect(lookupPersonTrace).not.toHaveBeenCalled();
    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
  });
});

describe("tier 1 inline: the 90-day cache serves only the SAME owner (D25)", () => {
  const CACHED_CONTACTS = { phones: [{ number: "5550000101", type: "mobile" }], emails: [] };

  it("runs a new trace when the cached contacts belong to a different owner", async () => {
    // MUTATION: serve the cached row whatever its owner and this goes red.
    H.cached = { id: "trace-cached", input_owner_name: "JANE DOE", trace_result: CACHED_CONTACTS, is_successful: true, charge: 0.25, tier: 1 };
    const { lookupBusinessTrace } = await vendorsCalled();
    const body = await (await post()).json();
    expect(body.is_cached).toBeUndefined();
    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
  });

  it("serves the same owner written differently, free, with its found_by", async () => {
    H.cached = {
      id: "trace-cached", input_owner_name: "Acme Holdings, L.L.C.", trace_result: CACHED_CONTACTS,
      is_successful: true, found_by: "company_name", outcome_code: "found_by_company_name",
    };
    const body = await (await post()).json();
    expect(body).toMatchObject({ is_cached: true, charge: 0, trace_id: "trace-cached", found_by: "company_name" });
  });
});

describe("tier 2 single: the shared-code changes reach this route (L-018)", () => {
  it("writes contact_vendor and clears any stale tier 1 outcome", async () => {
    // MUTATION: delete the contact_vendor line from the tier 2 persist and this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    await post(TIER2_BODY);
    expect(persisted()).toMatchObject({ contact_vendor: "fastappend", outcome_code: null, found_by: null });
  });

  it("returns the dossier's own contacts labelled not name-verified when the owner lookup misses (D21 b)", async () => {
    H.dossier = {
      ...DOSSIER_INDIVIDUAL_HIT,
      contacts: { ownerName: null, phones: [{ number: "5550000901", type: "mobile" }], emails: [], mailingAddress: null },
    };
    const body = await (await post(TIER2_BODY)).json();
    expect(body.result).toMatchObject({ name_verified: false, phones: [{ number: "5550000901", type: "mobile" }] });
    expect(persisted()!.contact_vendor).toBe("tracerfy");
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run lib/utils/__tests__/ownerName.test.ts app/api/trace/single/__tests__/route.test.ts`
Expected: FAIL (`ownerName.ts` does not exist; the route still submits the batch and returns `processing`).

- [ ] **Step 3: Implement**

Create `lib/utils/ownerName.ts`:

```ts
/**
 * D25: the 90-day cache serves an earlier result only to the SAME owner.
 *
 * Normalised so the same owner written two ways still matches: case, punctuation (periods
 * dropped, so "L.L.C." is "LLC"; other marks become spaces), the suffixes JR SR II III IV, and
 * single letters (middle initials). The ORDER is kept: "SMITH JOHN" and "JOHN SMITH" are different
 * strings on a single trace, as D22 keeps single-trace name order.
 */
const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV']);

export function normalizeOwnerName(name?: string | null): string {
  return (name ?? '')
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !SUFFIXES.has(t))
    .join(' ');
}

/** True only when both names normalise to the same non-empty string. */
export function ownerNamesMatch(a?: string | null, b?: string | null): boolean {
  const x = normalizeOwnerName(a);
  return x !== '' && x === normalizeOwnerName(b);
}
```

In `app/api/trace/single/route.ts`:

Replace the client, dossier and executeRoute imports:

```ts
import {
  submitSingleTrace,
  lookupBusinessTrace,
  lookupPersonTrace,
} from '@/lib/tracerfy/client';
import { lookupDossier } from '@/lib/tracerfy/dossier';
import { executeRoute } from '@/lib/routing/executeRoute';
```

with:

```ts
import { lookupBusinessTrace, lookupPersonTrace } from '@/lib/tracerfy/client';
import { lookupDossier } from '@/lib/tracerfy/dossier';
import { contactVendorFrom, executeRoute } from '@/lib/routing/executeRoute';
import { runSingleTier1 } from '@/lib/trace/singleTier1';
import { TIER1_OUTCOME } from '@/lib/trace/tier1Outcome';
import { ownerNamesMatch } from '@/lib/utils/ownerName';
```

and change `import { STALE_PROCESSING } from '@/lib/constants';` to `import { STALE_PROCESSING, VENDOR_TIMEOUT } from '@/lib/constants';`.

Replace the docblock above `export const maxDuration = 60;` with:

```ts
/**
 * Both tiers now finish INSIDE this request: tier 2 buys the dossier and then contacts, tier 1 runs
 * its ladder (spec D1, D26). Every vendor call is capped at 25 s and no call starts later than 50 s
 * after the request began (VENDOR_TIMEOUT), which leaves 10 s of this 60 for our own writes. The
 * arithmetic is in docs/superpowers/plans/2026-09-21-tier1-phase1-single-traces.md.
 */
```

Directly after `export async function POST(request: Request) {` and `try {`, add as the first statement:

```ts
    const startedAt = Date.now();
```

After the address validation block (`if (!validation.valid) { ... }`), add:

```ts
    // A supplied owner name must be something a vendor can look up.
    if (owner_name?.trim() && !/[A-Za-z]/.test(owner_name)) {
      return NextResponse.json(
        { success: false, error: 'Owner name must contain at least one letter.' },
        { status: 400 }
      );
    }
```

In the ledger probe, change `.select('id, charge, ai_research_charge, property_record, tier')` to `.select('id, charge, ai_research_charge, property_record, tier, outcome_code')`, and after the `ledgerProtected` declaration add:

```ts
    // A busy_try_again row is the one a resend RESUMES (spec 5.2): its step log is what spares the
    // retry from buying the answered steps again, so no sweep below may delete it. It is reused in
    // place by the update branch further down, like a billed row.
    const busyResend = existingRow?.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN;
```

and change the first line inside `runDelete` from `if (ledgerProtected) return;` to `if (ledgerProtected || busyResend) return;`.

In the cache branch, replace

```ts
        if (hasData) {
```

with

```ts
        // D25: a supplied owner is served an earlier result only when it is the SAME owner. A
        // different owner runs a new trace, charged only on a name-matched result with contacts.
        // A Full Property Trace request is served as before.
        const sameOwner =
          fullPropertyTrace || ownerNamesMatch(cachedResult.input_owner_name, owner_name);

        if (hasData && sameOwner) {
```

and in that branch's `NextResponse.json({ ... })` add after `charge: 0,`:

```ts
            found_by: cachedResult.found_by ?? null,
            outcome_code: cachedResult.outcome_code ?? null,
```

In the Tier 2 block, change

```ts
      const execution = await executeRoute(plan, {
        lookupDossier,
        traceEntity: lookupBusinessTrace,
        tracePerson: lookupPersonTrace,
      });
```

to

```ts
      const execution = await executeRoute(
        plan,
        { lookupDossier, traceEntity: lookupBusinessTrace, tracePerson: lookupPersonTrace },
        { deadlineMs: startedAt + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS }
      );
```

and in the Tier 2 persist `.update({ ... })`, after `cost: execution.vendorSpend,` add:

```ts
          // Which contact vendor was asked (spec 6.1); NULL when none was.
          contact_vendor: contactVendorFrom(execution.steps),
          // A tier 2 row carries no tier 1 outcome. Cleared because this row may be REUSED from a
          // tier 1 trace whose outcome would otherwise answer rowSkipReason for it.
          outcome_code: null,
          found_by: null,
          trace_steps: execution.steps,
```

Replace everything from `    // Submit to Tracerfy` down to (not including) `  } catch (error) {` with:

```ts
    /* ---------------------------------------------------------------- *
     * TIER 1, INLINE (spec D1, D26). The owner was supplied: planRoute
     * picks the ladder for this owner and executeRoute runs it inside this
     * request. The deprecated batch submit is gone for new traces; the
     * status poll route only serves rows already in flight.
     * ---------------------------------------------------------------- */
    const ownerName = (owner_name ?? '').trim();
    const tier1 = await runSingleTier1({
      adminClient,
      userId: user.id,
      row: traceRecord,
      parcel: { ...parcelForFullTrace({ address, city, state, zip }), ownerName },
      pricePlan: pricePlanFor(profile),
      chargeAmount: chargePerTrace(profile),
      deadlineMs: startedAt + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS,
      deps: { lookupDossier, traceEntity: lookupBusinessTrace, tracePerson: lookupPersonTrace },
    });

    if (tier1.persistError) {
      console.error('Single trace tier 1 - failed to persist result:', tier1.persistError);
    }

    if (tier1.outcome === TIER1_OUTCOME.BUSY_TRY_AGAIN) {
      // D7: a vendor failure ends the record busy_try_again, free, with no webhook: nothing
      // completed. The row keeps its step log so a resend within 24 hours resumes here.
      return NextResponse.json(
        {
          success: false,
          status: 'error',
          trace_id: traceRecord.id,
          tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
          charge: 0,
          result: null,
          found_by: null,
          outcome_code: tier1.outcome,
          skip_reason: tier1.skipReason,
          error: tier1.skipReason,
        },
        { status: 503, headers: { 'Retry-After': '300' } }
      );
    }

    if (tier1.deduction === 'charged' || tier1.deduction === 'insufficient_balance' || tier1.deduction === 'error') {
      triggerAutoRebillIfNeeded(user.id).catch(() => {});
    }

    const tier1Status = tier1.status === 'success' ? 'success' : 'no_match';

    // trace.completed fires from here now (it used to fire from the poll), for every completed
    // tier 1 trace, a free one included.
    dispatchTraceCompleted({
      webhookUrl: profile.webhook_url,
      traceId: traceRecord.id,
      status: tier1Status,
      address: normalizedAddress,
      city: city.toUpperCase(),
      state: state.toUpperCase(),
      zip: zip ? zip.substring(0, 5) : null,
      result: tier1.result,
      charge: tier1.charge,
      propertyRecord: null,
      ownerType: tier1.execution.ownerType,
      tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
      foundBy: tier1.foundBy,
      outcomeCode: tier1.outcome,
      skipReason: tier1.skipReason,
    });

    // Only the two wallet sentences reach the customer; the routing notes are internal.
    const tier1Warnings: string[] = [];
    if (tier1.deduction === 'insufficient_balance') tier1Warnings.push(WALLET_SHORT_WARNING);
    else if (tier1.deduction === 'error') tier1Warnings.push(WALLET_NOT_COLLECTED_WARNING);

    return NextResponse.json({
      success: true,
      status: tier1Status,
      trace_id: traceRecord.id,
      tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
      charge: tier1.charge,
      result: tier1.result,
      property_record: null,
      owner_name: ownerName,
      owner_type: tier1.execution.ownerType,
      needs_manual_review: tier1.execution.needsManualReview,
      found_by: tier1.foundBy,
      outcome_code: tier1.outcome,
      skip_reason: tier1.skipReason,
      warnings: tier1Warnings,
    });
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run lib/utils app/api/trace/single` then `npx tsc --noEmit`.
Expected: PASS, 0 errors. `grep -n "submitSingleTrace" app/api/trace/single/route.ts` prints nothing.

- [ ] **Step 5: Mutations (this call site, L-018)**

1. `const sameOwner = true`: `'runs a new trace when the cached contacts belong to a different owner'` goes red.
2. `if (ledgerProtected) return;` (drop `|| busyResend`): `'keeps the busy row: no sweep deletes it'` goes red.
3. `row: { id: traceRecord.id }` in the `runSingleTier1` call: `"folds a new charge onto the reused row's receipt"` goes red.
4. `deadlineMs: startedAt + 10 * 60 * 1000`: `'passes the request budget to every vendor call'` goes red.
5. Delete the Tier 2 `contact_vendor` line: `'writes contact_vendor and clears any stale tier 1 outcome'` goes red.
6. Delete the tier 1 `dispatchTraceCompleted({ ... })` call: `'FIRES on the tier 1 path'` goes red.
7. Change the busy branch's `{ status: 503, ... }` to `{ status: 200 }`: `'a vendor failure is busy_try_again: 503'` goes red.

- [ ] **Step 6: Suite, History, commit**

Run: `npx vitest run`. Expected: 0 failed.

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 9: web single trace runs Tier 1 inline.

- app/api/trace/single no longer submits a Tier 1 trace to the batch CSV: it runs the ladder
  inside the request through runSingleTier1 and returns the finished result with found_by,
  outcome_code and skip_reason. A vendor failure answers 503 busy_try_again, free, Retry-After 300.
  trace.completed fires from here with tier 1.
- The 90-day cache serves a supplied owner only the same owner's result (D25, new
  lib/utils/ownerName.ts). No sweep deletes a busy_try_again row, so a resend reuses its log.
- Tier 2 single rows now write contact_vendor and the step log and clear any stale Tier 1 outcome;
  every vendor call gets the 50 s request budget. Mutations: seven, all red.
```

```bash
git add lib/utils/ownerName.ts lib/utils/__tests__/ownerName.test.ts app/api/trace/single/route.ts app/api/trace/single/__tests__/route.test.ts History.md tasks/todo.md
git commit -m "$(cat <<'EOF'
feat(trace-single): web Tier 1 inline with outcome, D25 owner cache, busy resend and request budget

Tier 1 Phase 1, Task 9.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 10: The API single route runs Tier 1 inline, takes a parcel id (D23, D24) and documents it

**Files:**
- Modify: `lib/utils/address-normalizer.ts` (append `normalizeParcelId`, `traceKeyFor`)
- Modify: `lib/utils/deduplication.ts:141-184` (`checkSingleDuplicateByHash`; `checkSingleDuplicate` delegates)
- Modify: `lib/trace/fullPropertyTrace.ts:20-25, :84-103` (`parcelForFullTrace` tolerates no street or city)
- Modify: `app/api/v1/trace/single/route.ts`
- Modify: `app/(dashboard)/settings/api-keys/docs/page.tsx`
- Test: `lib/utils/__tests__/address-normalizer.test.ts`, `lib/utils/__tests__/deduplication.test.ts`, `lib/trace/__tests__/fullPropertyTrace.test.ts`, `app/api/v1/trace/single/__tests__/route.test.ts`; create `app/(dashboard)/settings/api-keys/docs/__tests__/docsContract.test.ts`

**Interfaces:**
- Consumes: everything Task 9 consumes, plus `missingLookupKey`, `noLookupKeyReason` (Task 7) and `ownerNamesMatch` (Task 9).
- Produces:
  - `export function normalizeParcelId(apn?: string | null): string` and `export function traceKeyFor(input: { address?: string | null; city?: string | null; state: string; apn?: string | null; county?: string | null }): string` (`lib/utils/address-normalizer.ts`)
  - `export async function checkSingleDuplicateByHash(userId: string, hash: string): Promise<TraceHistory | null>` (`lib/utils/deduplication.ts`)
  - `TraceAddressInput` becomes `{ address?: string | null; city?: string | null; state: string; zip?: string | null }`
  - API request accepts `apn` (alias `parcelId`) and `county`. A record with no lookup key answers 400 `{ success: false, outcomeCode: 'no_lookup_key', skipReason, error }` before any database write. API Tier 1 response (200): `{ success: true, status, traceId, tier: 1, charge, result, propertyRecord: null, ownerName, ownerType, needsManualReview, foundBy, outcomeCode, skipReason, warnings }`; busy (503, `Retry-After: 300`): `{ success: false, status: 'error', traceId, tier: 1, charge: 0, result: null, foundBy: null, outcomeCode: 'busy_try_again', skipReason, error }`. Cache hits add `foundBy`, `outcomeCode`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/utils/__tests__/address-normalizer.test.ts` (add `traceKeyFor` to its import):

```ts
describe('traceKeyFor (spec 6.3, D9)', () => {
  it('keys a record with a city exactly as before, whatever parcel id rides along', () => {
    expect(traceKeyFor({ address: '123 Main St', city: 'Austin', state: 'TX', apn: '9', county: 'Travis' }))
      .toBe(normalizeAddress('123 Main St', 'Austin', 'TX'));
  });

  it('keys a city-less record on parcel id, county and state: trimmed, upper case, leading # removed', () => {
    // MUTATION: drop the leading-# strip in normalizeParcelId and this goes red.
    expect(traceKeyFor({ state: 'oh', apn: ' #12-345 6 ', county: 'Placeholder' })).toBe('APN|12-345 6|PLACEHOLDER|OH');
  });

  it('keeps dashes and spaces, so two parcel numbers never collapse into one', () => {
    expect(traceKeyFor({ state: 'OH', apn: '12-3456', county: 'X' })).not.toBe(traceKeyFor({ state: 'OH', apn: '123456', county: 'X' }));
  });

  it('does not let the same parcel number in two counties share a key', () => {
    // MUTATION: drop the county from the key and this goes red.
    expect(traceKeyFor({ state: 'OH', apn: '100', county: 'A' })).not.toBe(traceKeyFor({ state: 'OH', apn: '100', county: 'B' }));
  });

  it('falls back to street and state with neither a city nor a whole parcel key', () => {
    expect(traceKeyFor({ address: '1 A St', state: 'OH', apn: '100' })).toBe('1 A ST||OH');
  });
});
```

Append to `lib/utils/__tests__/deduplication.test.ts` (add `checkSingleDuplicateByHash` to the destructured dynamic import):

```ts
describe("checkSingleDuplicateByHash (the API keys a city-less record on its parcel id)", () => {
  it("looks up exactly the hash it is handed, on the admin client, for the caller only", async () => {
    // MUTATION: drop `.eq('user_id', userId)` from checkSingleDuplicateByHash and this goes red.
    H.results = [{ data: null, error: { code: "PGRST116" } }];
    await checkSingleDuplicateByHash("user-1", "hash-apn");
    expect(H.clientsBuilt).toEqual(["admin"]);
    expect(filter(H.ops[0], "eq", "user_id")).toEqual(["eq", "user_id", "user-1"]);
    expect(filter(H.ops[0], "eq", "address_hash")).toEqual(["eq", "address_hash", "hash-apn"]);
  });
});
```

Append to the `parcelForFullTrace` describe in `lib/trace/__tests__/fullPropertyTrace.test.ts`:

```ts
  it("tolerates a record with no street or city (API, spec D23 and D24)", () => {
    expect(parcelForFullTrace({ state: "oh", apn: "12-3", county: "Placeholder" })).toMatchObject({
      state: "OH", situsAddress: "", situsCity: "", parcelIdLocal: "12-3", county: "Placeholder", ownerName: null,
    });
  });
```

In `app/api/v1/trace/single/__tests__/route.test.ts`:

(a) Add `input_owner_name: "ACME HOLDINGS LLC"` to every `H.cached` that a test posting `BODY` expects to be SERVED (`grep -n "H.cached = {"`; the `"cache hit"` describe has one).

(b) Every `toHaveBeenCalledWith` on `lookupDossier`, `lookupBusinessTrace` or `lookupPersonTrace` (today `:517`, `:803`) gains the second argument `expect.objectContaining({ timeoutMs: expect.any(Number) })`.

(c) In `"POST /api/v1/trace/single — gates"`, replace `"400s on an invalid address before touching the database"` with:

```ts
  it("400s a person with a city but no street and no parcel id, as no_lookup_key, before touching the database", async () => {
    // MUTATION: delete the keyPlan check and the record reaches the database.
    const res = await post({ ...BODY, ownerName: "Marcus Halloway", address: "" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ success: false, outcomeCode: "no_lookup_key" });
    expect(body.skipReason).toBe(
      "This record is missing a street address and the parcel ID, so it could not be looked up. You were not charged. Send it again with the street address or the parcel ID."
    );
    expect(H.ops).toHaveLength(0);
  });

  it("400s an invalid state as no_lookup_key", async () => {
    const body = await (await post({ ...BODY, state: "Texas" })).json();
    expect(body.outcomeCode).toBe("no_lookup_key");
    expect(body.skipReason).toContain("a valid state");
    expect(H.ops).toHaveLength(0);
  });

  it("still validates a street and city that were both sent", async () => {
    const res = await post({ ...BODY, address: "1" });
    expect(res.status).toBe(400);
    expect(H.ops).toHaveLength(0);
  });
```

(d) Replace the whole `describe("POST /api/v1/trace/single — row creation and submission", ...)` block with:

```ts
describe("POST /api/v1/trace/single: row creation, then the inline tier 1 settle", () => {
  it("inserts a processing row and settles it in the same request", async () => {
    const res = await post();
    const body = await res.json();
    const insert = H.ops.find((o) => o.op === "insert");
    expect(insert!.payload).toMatchObject({ user_id: "user-1", city: "AUSTIN", state: "TX", status: "processing" });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: "no_match", traceId: "trace-new", tier: 1, charge: 0 });
  });

  it("500s when the row cannot be created", async () => {
    H.insertError = { message: "duplicate key value violates unique constraint", code: "23505" };
    const res = await post();
    expect(res.status).toBe(500);
  });
});
```

(e) In `"POST /api/v1/trace/single — what phase 4 changed"`, replace `"still sends a body WITH an ownerName down the tier 1 async path"` with:

```ts
  it("runs a body WITH an ownerName inline at the Track B tier 1 rate", async () => {
    // WAS: submitted to the Tracerfy batch and returned a traceId to poll. Removed (spec D26).
    H.entity = CONTACTS_HIT;
    const { submitSingleTrace } = await import("@/lib/tracerfy/client");
    const { lookupDossier } = await import("@/lib/tracerfy/dossier");
    const body = await (await post(BODY)).json();
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      success: true, status: "success", traceId: "trace-new", tier: 1, charge: 0.15,
      foundBy: "company_name", outcomeCode: "found_by_company_name", skipReason: null,
    });
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(0.15);
  });
```

(f) Replace `"does not fire on the TIER 1 path, where the poll route still owns it"` with:

```ts
  it("FIRES on the tier 1 path, which now completes inline, carrying tier 1 and its outcome", async () => {
    // MUTATION: delete the tier 1 dispatchTraceCompleted call and this goes red.
    H.profile = WEBHOOK_PROFILE;
    await post(BODY);
    expect(webhooks()).toHaveLength(1);
    expect(webhooks()[0].body).toMatchObject({ tier: 1, status: "no_match", outcome_code: "no_match", found_by: null, property_record: null });
  });
```

(g) Append at the end of the file (add `VENDOR_TIMEOUT` to the file's constants import, or `import { VENDOR_TIMEOUT } from "@/lib/constants";` if it has none, and `import { createAddressHash } from "@/lib/utils/address-normalizer";`):

```ts
/* ==================================================================== *
 * TIER 1 INLINE ON THE API, plus D23 (a parcel id when there is no city)
 * and D24 (a Full Property Trace keyed by parcel id).
 * ==================================================================== */

function tier1Persisted(): Record<string, unknown> | undefined {
  const rec = H.ops.find(
    (o) =>
      o.op === "update" &&
      o.payload !== null &&
      typeof o.payload === "object" &&
      "outcome_code" in (o.payload as object) &&
      !("property_record" in (o.payload as object))
  );
  return rec?.payload as Record<string, unknown> | undefined;
}

describe("v1 tier 1, D23: a record with no city goes by parcel id", () => {
  const APN_PERSON = { state: "OH", apn: "#0123-456", county: "Placeholder", ownerName: "Testowner Placeholder" };

  it("looks an individual up by parcel id, with the names carried for the match only", async () => {
    H.person = CONTACTS_HIT;
    const { lookupPersonTrace } = await v1Vendors();
    const body = await (await post(APN_PERSON)).json();
    expect(lookupPersonTrace).toHaveBeenCalledWith(
      expect.objectContaining({ parcel_id: "#0123-456", county: "Placeholder", state: "OH", first_name: "Testowner", last_name: "Placeholder" }),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(body).toMatchObject({ success: true, tier: 1, foundBy: "parcel_id", outcomeCode: "found_by_parcel_id" });
  });

  it("keys the row on APN, county and state, and stores the parcel id and county (spec 6.3)", async () => {
    // MUTATION: key the row with normalizeAddress(address, city, state) again and this goes red.
    await post(APN_PERSON);
    const insert = H.ops.find((o) => o.op === "insert");
    expect(insert!.payload).toMatchObject({
      normalized_address: "APN|0123-456|PLACEHOLDER|OH",
      address_hash: createAddressHash("APN|0123-456|PLACEHOLDER|OH"),
      city: null,
      parcel_id_local: "#0123-456",
      county: "Placeholder",
    });
  });

  it("accepts parcelId as the same field", async () => {
    H.person = CONTACTS_HIT;
    const body = await (await post({ state: "OH", parcelId: "0123-456", county: "Placeholder", ownerName: "Testowner Placeholder" })).json();
    expect(body.foundBy).toBe("parcel_id");
  });

  it("traces a company with only its name and state (D23)", async () => {
    const { lookupBusinessTrace } = await v1Vendors();
    const res = await post({ state: "OH", ownerName: "ACME HOLDINGS LLC" });
    expect(res.status).toBe(200);
    expect(lookupBusinessTrace).toHaveBeenCalledWith(
      { company_name: "ACME HOLDINGS LLC", state: "OH" },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  it("refuses a person with neither a city nor a parcel id, as no_lookup_key", async () => {
    const res = await post({ state: "OH", ownerName: "Testowner Placeholder" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.skipReason).toBe(
      "This record is missing the city and the parcel ID, so it could not be looked up. You were not charged. Send it again with the city or the parcel ID."
    );
    expect(H.ops).toHaveLength(0);
  });
});

describe("v1 tier 2, D24 and D21 on the API: the dossier by parcel id, the owner at the mailing address", () => {
  it("keys the dossier on the parcel id when there is no city, then searches the owner at the mailing address", async () => {
    H.dossier = DOSSIER_INDIVIDUAL_HIT;
    H.person = CONTACTS_HIT;
    const { lookupDossier, lookupPersonTrace } = await v1Vendors();
    const body = await (await post({ state: "OH", apn: "0123-456", county: "Placeholder" })).json();
    expect(lookupDossier).toHaveBeenCalledWith(
      { mode: "apn", apn: "0123-456", county: "Placeholder", state: "OH" },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    const personReq = vi.mocked(lookupPersonTrace).mock.calls[0][0];
    expect(personReq).toMatchObject({ address: "100 Placeholder Way", city: "Redacted", state: "ZZ", first_name: "Testowner", last_name: "Placeholder" });
    expect(personReq).not.toHaveProperty("parcel_id");
    expect(body.tier).toBe(2);
  });

  it("tries the parcel id first and the address second when both are sent", async () => {
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await v1Vendors();
    await post({ ...TIER2_BODY, apn: "0123-456", county: "Placeholder" });
    expect(vi.mocked(lookupDossier).mock.calls.map((c) => (c[0] as { mode: string }).mode)).toEqual(["apn", "address"]);
  });

  it("writes contact_vendor on the tier 2 persist", async () => {
    // MUTATION: delete the contact_vendor line from the tier 2 persist and this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    await post(TIER2_BODY);
    expect(persisted()).toMatchObject({ contact_vendor: "fastappend", outcome_code: null, found_by: null });
  });
});

describe("v1 tier 1: busy, money, the resend and D25 on this call site (L-018)", () => {
  it("a vendor failure is busy_try_again: 503, Retry-After, free", async () => {
    // MUTATION: return 200 on the busy branch and this goes red.
    H.entity = { success: false, hit: false, contacts: null, error: "FastAppend service unavailable" };
    const res = await post();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(body).toMatchObject({ success: false, outcomeCode: "busy_try_again", charge: 0 });
    expect(deducts()).toHaveLength(0);
  });

  it("folds a new charge onto the reused row's receipt", async () => {
    // MUTATION: pass `row: { id: traceRecord.id }` to runSingleTier1 and this goes red.
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", charge: 0.25, tier: 2, property_record: null };
    H.insertedRow = { id: "trace-new", charge: 0.25, tier: 2, property_record: null };
    H.ledgerRefs = [{ amount: 0.25, type: "debit", created_at: "2026-08-01T00:00:00.000Z" }];
    await post();
    expect(deducts()).toHaveLength(1);
    expect(tier1Persisted()).toMatchObject({ charge: 0.4, tier: 2 });
  });

  it("keeps a busy row: no sweep deletes it", async () => {
    // MUTATION: drop `|| busyResend` from runDelete and this goes red.
    const busy = { id: "trace-new", charge: 0, tier: 1, is_successful: false, property_record: null, outcome_code: "busy_try_again", trace_steps: [] };
    H.survivingRow = busy;
    H.insertedRow = busy;
    await post();
    expect(deletes()).toHaveLength(0);
  });

  it("does not serve a different owner's cached contacts (D25)", async () => {
    // MUTATION: serve the cached row whatever its owner and this goes red.
    H.cached = {
      id: "trace-cached", input_owner_name: "JANE DOE",
      trace_result: { phones: [{ number: "5550000101", type: "mobile" }], emails: [] }, is_successful: true, charge: 0.15, tier: 1,
    };
    const body = await (await post()).json();
    expect(body.cached).toBeUndefined();
  });

  it("passes the request budget to every vendor call", async () => {
    // MUTATION: pass `deadlineMs: startedAt + 10 * 60 * 1000` and this goes red.
    const { lookupBusinessTrace } = await v1Vendors();
    await post();
    const opts = vi.mocked(lookupBusinessTrace).mock.calls[0][1] as { timeoutMs: number };
    expect(opts.timeoutMs).toBeLessThanOrEqual(VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS);
  });
});
```

Create `app/(dashboard)/settings/api-keys/docs/__tests__/docsContract.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DOCS = readFileSync(join(process.cwd(), 'app/(dashboard)/settings/api-keys/docs/page.tsx'), 'utf8')

describe('the API docs describe the synchronous single-trace contract (spec D1, D26)', () => {
  it('no longer tells anyone to poll a trace where the owner was supplied', () => {
    // MUTATION: put the old "Response when you supplied the owner (poll for it)" block back and this goes red.
    expect(DOCS).not.toContain('tracerfyJobId')
    expect(DOCS).not.toMatch(/supplied the owner \(poll/i)
    expect(DOCS).not.toContain('Poll for Results')
    expect(DOCS).not.toContain('then poll if you need to')
  })

  it('documents the new fields, the parcel id input and the busy answer', () => {
    for (const s of ['outcomeCode', 'foundBy', 'skipReason', 'busy_try_again', 'no_lookup_key', '"apn"', '"county"', 'Retry-After', 'name_verified']) {
      expect(DOCS, s).toContain(s)
    }
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run lib/utils lib/trace/__tests__/fullPropertyTrace.test.ts app/api/v1/trace/single "app/(dashboard)/settings/api-keys/docs"`
Expected: FAIL.

- [ ] **Step 3: Implement the library pieces**

Append to `lib/utils/address-normalizer.ts`:

```ts
/**
 * A parcel id as a duplicate key (spec 6.3): trimmed, upper case, leading "#" removed. Dashes and
 * spaces are KEPT, so two different parcel numbers can never collapse into one. The vendor is sent
 * the id as the caller sent it; this form is for the key only.
 */
export function normalizeParcelId(apn?: string | null): string {
  return (apn ?? '').trim().toUpperCase().replace(/^#+\s*/, '');
}

/**
 * The duplicate key for one record (spec 6.3, D9), in precedence order:
 *   1. a city:                        STREET|CITY|STATE, unchanged, so the 90-day history keeps working
 *   2. no city, a parcel id + county: APN|PARCEL|COUNTY|STATE
 *   3. neither:                       STREET||STATE, today's behaviour. Only a company gets this far
 *                                     (a person needs a key), and it carries today's collision risk,
 *                                     which the spec records rather than solves.
 */
export function traceKeyFor(input: {
  address?: string | null;
  city?: string | null;
  state: string;
  apn?: string | null;
  county?: string | null;
}): string {
  const city = (input.city ?? '').trim();
  if (city) return normalizeAddress(input.address ?? '', city, input.state);
  const parcel = normalizeParcelId(input.apn);
  const county = (input.county ?? '').trim().toUpperCase();
  if (parcel && county) return `APN|${parcel}|${county}|${input.state.trim().toUpperCase()}`;
  return normalizeAddress(input.address ?? '', '', input.state);
}
```

In `lib/utils/deduplication.ts`, rename the body of `checkSingleDuplicate` into a new function and make the old one delegate. Replace the `checkSingleDuplicate` function (keep its docblock above the new `checkSingleDuplicateByHash`) with:

```ts
export async function checkSingleDuplicateByHash(
  userId: string,
  hash: string
): Promise<TraceHistory | null> {
  const supabase = createAdminClient();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DEDUPE.WINDOW_DAYS);

  // A row is a cache hit when the customer already owns what it holds (CACHE_HIT_FILTER):
  // contacts delivered, a paid property record, or a billed tier 2 row. Everything else re-traces.
  const { data, error } = await supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    .eq('address_hash', hash)
    .or(CACHE_HIT_FILTER)
    .gte('created_at', cutoffDate.toISOString())
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = no rows returned, which is expected
    throw new Error(`Failed to check duplicate: ${error.message}`);
  }

  return data as TraceHistory | null;
}

/**
 * checkSingleDuplicate for a caller holding an address. The API single route calls
 * checkSingleDuplicateByHash directly, because its key is not always an address (spec 6.3).
 */
export async function checkSingleDuplicate(
  userId: string,
  address: string,
  city: string,
  state: string
): Promise<TraceHistory | null> {
  return checkSingleDuplicateByHash(userId, createAddressHash(normalizeAddress(address, city, state)));
}
```

In `lib/trace/fullPropertyTrace.ts`, change `TraceAddressInput` to:

```ts
/** What a single-trace entry point has: an address, and on the API sometimes only a parcel id. */
export interface TraceAddressInput {
  address?: string | null
  city?: string | null
  state: string
  zip?: string | null
}
```

and in `parcelForFullTrace` change `situsAddress: input.address.trim(),` and `situsCity: input.city.trim(),` to `situsAddress: (input.address ?? '').trim(),` and `situsCity: (input.city ?? '').trim(),`.

- [ ] **Step 4: Implement the route (`app/api/v1/trace/single/route.ts`)**

Replace the imports

```ts
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { checkSingleDuplicate } from '@/lib/utils/deduplication';
```

with

```ts
import { createAddressHash, traceKeyFor, usableZip, validateAddressInput } from '@/lib/utils/address-normalizer';
import { checkSingleDuplicateByHash } from '@/lib/utils/deduplication';
```

replace

```ts
import {
  submitSingleTrace,
  lookupBusinessTrace,
  lookupPersonTrace,
} from '@/lib/tracerfy/client';
import { lookupDossier } from '@/lib/tracerfy/dossier';
import { executeRoute } from '@/lib/routing/executeRoute';
```

with

```ts
import { lookupBusinessTrace, lookupPersonTrace } from '@/lib/tracerfy/client';
import { lookupDossier } from '@/lib/tracerfy/dossier';
import { contactVendorFrom, executeRoute } from '@/lib/routing/executeRoute';
import { runSingleTier1 } from '@/lib/trace/singleTier1';
import { missingLookupKey, noLookupKeyReason, TIER1_OUTCOME } from '@/lib/trace/tier1Outcome';
import { ownerNamesMatch } from '@/lib/utils/ownerName';
```

and change `import { getChargePerTrace } from '@/lib/constants';` to `import { getChargePerTrace, VENDOR_TIMEOUT } from '@/lib/constants';`.

Replace the docblock above `export const maxDuration = 60;` with:

```ts
/**
 * Both tiers now finish INSIDE this request: tier 2 buys the dossier and then contacts, tier 1 runs
 * its ladder (spec D1, D26). Every vendor call is capped at 25 s and no call starts later than 50 s
 * after the request began (VENDOR_TIMEOUT), which leaves 10 s of this 60 for our own writes. The
 * arithmetic is in docs/superpowers/plans/2026-09-21-tier1-phase1-single-traces.md.
 */
```

Add `const startedAt = Date.now();` as the first statement inside `try {`.

Replace

```ts
    const { address, city, state, zip, ownerName } = body;

    // Validate input
    const validation = validateAddressInput(address, city, state, zip);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }
```

with

```ts
    const { address, city, state, zip, ownerName, county } = body;
    // D23: a record with no city can be sent with its parcel id (`apn`, or `parcelId`) and county,
    // so Tracerfy's parcel lookup can serve an individual; a company needs only its name and
    // state. The web app stays address-only (D5).
    const apn: string | undefined =
      typeof body.apn === 'string' ? body.apn : typeof body.parcelId === 'string' ? body.parcelId : undefined;
    const hasCity = typeof city === 'string' && city.trim() !== '';
    const hasStreet = typeof address === 'string' && address.trim() !== '';

    if (typeof state !== 'string' || !/^[A-Za-z]{2}$/.test(state.trim())) {
      const skipReason = noLookupKeyReason('state');
      return NextResponse.json(
        { success: false, outcomeCode: TIER1_OUTCOME.NO_LOOKUP_KEY, skipReason, error: skipReason },
        { status: 400 }
      );
    }

    // A street and a city sent together are validated exactly as before. Either one alone is judged
    // below by whether any lookup key is left, rather than refused here.
    if (hasStreet && hasCity) {
      const validation = validateAddressInput(address, city, state, zip);
      if (!validation.valid) {
        return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
      }
    } else if (typeof zip === 'string' && zip.trim() !== '' && usableZip(zip) === '') {
      return NextResponse.json(
        { success: false, error: 'ZIP code must be 5 or 9 digits when supplied' },
        { status: 400 }
      );
    }

    if (typeof ownerName === 'string' && ownerName.trim() !== '' && !/[A-Za-z]/.test(ownerName)) {
      return NextResponse.json(
        { success: false, error: 'ownerName must contain at least one letter' },
        { status: 400 }
      );
    }
```

Directly after the `const fullPropertyTrace = isFullPropertyTrace({ ... });` statement add:

```ts
    // D23: the record is judged by whether ANY lookup key is left, using the same planRoute that
    // will run it, instead of demanding a street and city of every record. No step means no key:
    // nothing is written and nothing is charged.
    const parcel = parcelForFullTrace({ address, city, state, zip, apn, county });
    const tier1Owner = fullPropertyTrace ? null : String(ownerName).trim();
    const keyPlan = planRoute({ ...parcel, ownerName: tier1Owner }, rawPricePlanFor(profile));
    if (keyPlan.steps.length === 0) {
      const missing = missingLookupKey({ address, city, state, apn, county });
      const skipReason = missing ? noLookupKeyReason(missing) : null;
      return NextResponse.json(
        {
          success: false,
          outcomeCode: TIER1_OUTCOME.NO_LOOKUP_KEY,
          skipReason,
          error: skipReason ?? keyPlan.warnings[0] ?? 'This record has no lookup key.',
        },
        { status: 400 }
      );
    }
```

Replace

```ts
    // Normalize address and create hash
    const normalizedAddress = normalizeAddress(address, city, state);
    const addressHash = createAddressHash(normalizedAddress);
```

with

```ts
    // The duplicate key (spec 6.3): street, city and state when there is a city, as before; parcel
    // id, county and state when there is not.
    const normalizedAddress = traceKeyFor({ address, city, state, apn, county });
    const addressHash = createAddressHash(normalizedAddress);
    // The webhook's `address`: the normalized key when there is a city (unchanged), else the street
    // as sent, else nothing. Never the internal "APN|..." key.
    const webhookAddress = hasCity ? normalizedAddress : hasStreet ? String(address).trim() : null;
```

Change the ledger probe `.select('id, charge, ai_research_charge, property_record, tier')` to `.select('id, charge, ai_research_charge, property_record, tier, outcome_code')`; after the `ledgerProtected` declaration add:

```ts
    // A busy_try_again row is the one a resend RESUMES (spec 5.2): its step log is what spares the
    // retry from buying the answered steps again, so no sweep below may delete it. It is reused in
    // place by the update branch further down, like a billed row.
    const busyResend = existingRow?.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN;
```

and change `if (ledgerProtected) return;` in `runDelete` to `if (ledgerProtected || busyResend) return;`.

Replace `const cachedResult = await checkSingleDuplicate(profile.id, address, city, state);` with `const cachedResult = await checkSingleDuplicateByHash(profile.id, addressHash);`, replace `if (hasData) {` with

```ts
      // D25: a supplied owner is served an earlier result only when it is the SAME owner.
      const sameOwner =
        fullPropertyTrace || ownerNamesMatch(cachedResult.input_owner_name, ownerName);

      if (hasData && sameOwner) {
```

and in that branch's response add after `charge: 0,`:

```ts
          foundBy: cachedResult.found_by ?? null,
          outcomeCode: cachedResult.outcome_code ?? null,
```

In `resubmitData`, change `city: city.toUpperCase(),` to `city: hasCity ? city.toUpperCase() : null,`, change `state: state.toUpperCase(),` to `state: state.trim().toUpperCase(),`, and after `input_owner_name: ownerName || null,` add:

```ts
      // D23: the parcel id and county as sent, beside the key built from them (spec 6.3).
      parcel_id_local: parcel.parcelIdLocal,
      county: parcel.county,
```

In the Tier 2 block: change

```ts
      const plan = planRoute(
        parcelForFullTrace({ address, city, state, zip }),
        rawPricePlanFor(profile)
      );
```

to `const plan = planRoute(parcel, rawPricePlanFor(profile));` (D24: the parcel id key rides along, APN first, address second); change its `executeRoute(plan, { ... })` call to

```ts
      const execution = await executeRoute(
        plan,
        { lookupDossier, traceEntity: lookupBusinessTrace, tracePerson: lookupPersonTrace },
        { deadlineMs: startedAt + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS }
      );
```

add to its persist `.update({ ... })`, after `cost: execution.vendorSpend,`:

```ts
          // Which contact vendor was asked (spec 6.1); NULL when none was.
          contact_vendor: contactVendorFrom(execution.steps),
          // A tier 2 row carries no tier 1 outcome. Cleared because this row may be REUSED from a
          // tier 1 trace whose outcome would otherwise answer rowSkipReason for it.
          outcome_code: null,
          found_by: null,
          trace_steps: execution.steps,
```

and in its `dispatchTraceCompleted` change `address: normalizedAddress,` to `address: webhookAddress,`.

Replace everything from `    // TIER 1, unchanged: submit and return a traceId to poll.` down to (not including) `  } catch (error) {` with:

```ts
    /* ---------------------------------------------------------------- *
     * TIER 1, INLINE (spec D1, D26). The owner was supplied: planRoute
     * picks the ladder, executeRoute runs it inside this request, and the
     * finished result comes back here. The old "processing, then poll"
     * contract is removed for new traces; /api/v1/trace/status still
     * answers for trace ids already issued.
     * ---------------------------------------------------------------- */
    const tier1 = await runSingleTier1({
      adminClient,
      userId: profile.id,
      row: traceRecord,
      parcel: { ...parcel, ownerName: tier1Owner },
      pricePlan: rawPricePlanFor(profile),
      chargeAmount: getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member),
      deadlineMs: startedAt + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS,
      deps: { lookupDossier, traceEntity: lookupBusinessTrace, tracePerson: lookupPersonTrace },
    });

    if (tier1.persistError) {
      console.error('API v1 single trace tier 1 - failed to persist result:', tier1.persistError);
    }

    if (tier1.outcome === TIER1_OUTCOME.BUSY_TRY_AGAIN) {
      // D7: free, no webhook, and the row keeps its step log so a resend within 24 hours resumes.
      return NextResponse.json(
        {
          success: false,
          status: 'error',
          traceId: traceRecord.id,
          tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
          charge: 0,
          result: null,
          foundBy: null,
          outcomeCode: tier1.outcome,
          skipReason: tier1.skipReason,
          error: tier1.skipReason,
        },
        { status: 503, headers: { 'Retry-After': '300' } }
      );
    }

    if (tier1.deduction === 'charged' || tier1.deduction === 'insufficient_balance' || tier1.deduction === 'error') {
      triggerAutoRebillIfNeeded(profile.id).catch(() => {});
    }

    const tier1Status = tier1.status === 'success' ? 'success' : 'no_match';

    // trace.completed fires from here now; an integrator who never polls still hears about it.
    dispatchTraceCompleted({
      webhookUrl: profile.webhook_url,
      traceId: traceRecord.id,
      status: tier1Status,
      address: webhookAddress,
      city: resubmitData.city,
      state: resubmitData.state,
      zip: resubmitData.zip,
      result: tier1.result,
      charge: tier1.charge,
      propertyRecord: null,
      ownerType: tier1.execution.ownerType,
      tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
      foundBy: tier1.foundBy,
      outcomeCode: tier1.outcome,
      skipReason: tier1.skipReason,
    });

    const tier1Warnings: string[] = [];
    if (tier1.deduction === 'insufficient_balance') tier1Warnings.push(WALLET_SHORT_WARNING);
    else if (tier1.deduction === 'error') tier1Warnings.push(WALLET_NOT_COLLECTED_WARNING);

    return NextResponse.json({
      success: true,
      status: tier1Status,
      traceId: traceRecord.id,
      tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
      charge: tier1.charge,
      result: tier1.result,
      propertyRecord: null,
      ownerName: tier1Owner,
      ownerType: tier1.execution.ownerType,
      needsManualReview: tier1.execution.needsManualReview,
      foundBy: tier1.foundBy,
      outcomeCode: tier1.outcome,
      skipReason: tier1.skipReason,
      warnings: tier1Warnings,
    });
```

- [ ] **Step 5: Update the API docs page (`app/(dashboard)/settings/api-keys/docs/page.tsx`)**

The predicate, not just this list (L-016): every sentence or snippet on the page that tells a caller to poll, or wait for, a single trace where the owner was supplied is now false. `grep -n -i "poll" "app/(dashboard)/settings/api-keys/docs/page.tsx"` and fix every hit that is about `/trace/single`; bulk polling (`/trace/bulk/status`, research jobs) stays. The known ones:

1. The `/trace/single` description paragraph becomes:

```tsx
            <p className="text-gray-600 text-sm">Trace a single property. Send the owner of record and you get a skip trace on that owner, finished inside the request. Leave it out and you get a Full Property Trace instead, which buys the county record for the property and then traces whoever it says owns it. A record with no city can be sent with its parcel ID and county instead.</p>
```

2. The `single-request` CodeBlock's code becomes:

```
{
  "address": "123 Main Street",
  "city": "Austin",
  "state": "TX",
  "zip": "78701",                 // optional
  "ownerName": "John Smith",      // optional. Leaving it out runs a Full Property Trace
  "apn": "0123-456-789",          // optional. The county parcel ID ("parcelId" is accepted too)
  "county": "Travis",             // optional. The county that parcel ID belongs to
  "fullPropertyTrace": false      // optional. Set true to get the property record anyway
}
```

3. The blue "Which one runs" box becomes:

```tsx
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
              <p className="text-blue-800 text-sm">
                <strong>Which one runs.</strong> If <code className="bg-blue-100 px-1 rounded">ownerName</code> is missing or blank, a Full Property Trace runs automatically. If you already have the owner but you want the county record too, send <code className="bg-blue-100 px-1 rounded">fullPropertyTrace: true</code>. The spelling <code className="bg-blue-100 px-1 rounded">full_property_trace</code> is accepted as well.
              </p>
              <p className="text-blue-800 text-sm">
                <strong>What a record needs.</strong> Every record needs a two-letter <code className="bg-blue-100 px-1 rounded">state</code>. A person, a trust or a name we cannot read also needs either a street and city, or the parcel ID with its county. A company needs only its name and state. A record with none of these comes back <code className="bg-blue-100 px-1 rounded">400</code> with <code className="bg-blue-100 px-1 rounded">outcomeCode: &quot;no_lookup_key&quot;</code> and a <code className="bg-blue-100 px-1 rounded">skipReason</code> that says what to add, and nothing is charged.
              </p>
              <p className="text-blue-800 text-sm">
                Both kinds of trace run start to finish inside the request and return the finished result, so give your HTTP client a timeout of at least 60 seconds. There is nothing to poll.
              </p>
            </div>
```

4. Replace the heading `Response when you supplied the owner (poll for it):` and its `single-response` CodeBlock with:

```tsx
            <h5 className="font-medium text-sm">Response when you supplied the owner (already finished):</h5>
            <CodeBlock
              code={`{
  "success": true,
  "status": "success",
  "traceId": "uuid",
  "tier": 1,
  "charge": 0.15,
  "result": {
    "owner_name": "John Smith",
    "phones": [{ "number": "5125551234", "type": "mobile" }],
    "emails": ["john.smith@email.com"],
    "mailing_address": "456 Oak Ave, Austin, TX, 78702"
  },
  "propertyRecord": null,
  "ownerName": "John Smith",
  "ownerType": "individual",
  "needsManualReview": false,
  "foundBy": "address",
  "outcomeCode": "found_by_address",
  "skipReason": null,
  "warnings": []
}`}
              section="single-response"
            />

            <p className="text-gray-600 text-sm">
              You are charged only when a person matching the owner name came back with at least one phone or email. <code className="bg-gray-100 px-1 rounded">foundBy</code> says which key found the owner: <code className="bg-gray-100 px-1 rounded">address</code>, <code className="bg-gray-100 px-1 rounded">parcel_id</code> or <code className="bg-gray-100 px-1 rounded">company_name</code>. When nothing came back, <code className="bg-gray-100 px-1 rounded">result</code> is <code className="bg-gray-100 px-1 rounded">null</code>, <code className="bg-gray-100 px-1 rounded">charge</code> is <code className="bg-gray-100 px-1 rounded">0</code> and <code className="bg-gray-100 px-1 rounded">skipReason</code> says why in one sentence. <code className="bg-gray-100 px-1 rounded">outcomeCode</code> is one of <code className="bg-gray-100 px-1 rounded">found_by_address</code>, <code className="bg-gray-100 px-1 rounded">found_by_parcel_id</code>, <code className="bg-gray-100 px-1 rounded">found_by_company_name</code>, <code className="bg-gray-100 px-1 rounded">no_match</code>, <code className="bg-gray-100 px-1 rounded">owner_name_not_matched</code>, <code className="bg-gray-100 px-1 rounded">no_lookup_key</code> or <code className="bg-gray-100 px-1 rounded">busy_try_again</code>.
            </p>

            <h5 className="font-medium text-sm">Response when a lookup service was busy (HTTP 503, header Retry-After: 300):</h5>
            <CodeBlock
              code={`{
  "success": false,
  "status": "error",
  "traceId": "uuid",
  "tier": 1,
  "charge": 0,
  "result": null,
  "foundBy": null,
  "outcomeCode": "busy_try_again",
  "skipReason": "The system is busy. Try again in 5 minutes. You were not charged.",
  "error": "The system is busy. Try again in 5 minutes. You were not charged."
}`}
              section="single-response-busy"
            />
            <p className="text-gray-600 text-sm">
              Send the same record again after five minutes. A resend within 24 hours picks up where the busy one stopped, so a lookup that already answered is not bought twice.
            </p>
```

5. After the paragraph that explains `ownerType` on the Full Property Trace response, add:

```tsx
            <p className="text-gray-600 text-sm">
              On a Full Property Trace, when every owner the county record names was looked up and none came back with contacts, the county record&apos;s own phones and emails are returned instead, with <code className="bg-gray-100 px-1 rounded">result.name_verified</code> set to <code className="bg-gray-100 px-1 rounded">false</code>: they were not matched to the owner&apos;s name. The field is absent on every other result.
            </p>
```

6. The `/trace/status` intro paragraph becomes:

```tsx
            <p className="text-gray-600 text-sm">Read a trace back by its id. Every trace now finishes inside its own request, so you only need this for a trace id you already hold, including one sent before this change. Reading is free.</p>
```

7. Make recipe: in `make-step1` replace the two comment lines at its end with `// Drop ownerName to run a Full Property Trace instead. Either way the\n// response is the finished result.`; delete the whole `Module 2: Poll for Results` div; replace the Tip box's text with: `<strong>Tip:</strong> Module 1 returns the finished result whichever tier ran, so there is no job to poll. Put a Router after it to handle <code className="bg-blue-100 px-1 rounded">success</code>, <code className="bg-blue-100 px-1 rounded">no_match</code> and <code className="bg-blue-100 px-1 rounded">busy_try_again</code> (run that record again after five minutes). Nothing goes to your CRM on its own, so either send the result on to your CRM from here or press Add to CRM on it in PropTracerPRO.`

8. n8n recipe: in `n8n-step1` replace the two comment lines at its end with `// Drop ownerName and a Full Property Trace runs instead. Either way\n// this same response is the finished result.`; delete the whole `Step 2: Branch on the tier, then poll if you need to` div; rename `Step 3: Use the results` to `Step 2: Use the results` and its first code line `// From either branch:` to `// From the response:`; in the Tip box change `You can also skip polling entirely and use webhooks instead.` to `You can also use webhooks instead.`

9. cURL: rename `Poll for results:` to `Read a trace back by id:`.

10. Webhooks: in the `webhook-single` CodeBlock add three lines before `"timestamp"`: `"found_by": null,`, `"outcome_code": null,`, `"skip_reason": null,`. Replace the paragraph that begins "A trace where you supplied the owner sends the same event" with:

```tsx
            <p className="text-gray-600 text-sm">
              A trace where you supplied the owner sends the same event with the same keys, fired as soon as it finishes: <code className="bg-gray-200 px-1 rounded">tier</code> is <code className="bg-gray-200 px-1 rounded">1</code>, <code className="bg-gray-200 px-1 rounded">property_record</code> is <code className="bg-gray-200 px-1 rounded">null</code>, and <code className="bg-gray-200 px-1 rounded">found_by</code>, <code className="bg-gray-200 px-1 rounded">outcome_code</code> and <code className="bg-gray-200 px-1 rounded">skip_reason</code> say what happened. Those three are <code className="bg-gray-200 px-1 rounded">null</code> on a Full Property Trace. A busy answer fires no event, because nothing completed.
            </p>
```

- [ ] **Step 6: Run to see them pass**

Run: `npx vitest run lib app/api "app/(dashboard)"` then `npx tsc --noEmit`.
Expected: PASS, 0 errors. `grep -n "submitSingleTrace\|normalizeAddress(" app/api/v1/trace/single/route.ts` prints nothing.

- [ ] **Step 7: Mutations (this call site, L-018)**

1. Delete the `if (keyPlan.steps.length === 0) { ... }` block: `'400s a person with a city but no street and no parcel id'` and `'refuses a person with neither a city nor a parcel id'` go red.
2. Key the row with `normalizeAddress(address ?? '', city ?? '', state)` again: `'keys the row on APN, county and state'` goes red.
3. In `traceKeyFor`, drop `${county}|` from the APN key: `'does not let the same parcel number in two counties share a key'` goes red.
4. `const sameOwner = true`: `"does not serve a different owner's cached contacts (D25)"` goes red.
5. Drop `|| busyResend` in `runDelete`: `'keeps a busy row: no sweep deletes it'` goes red.
6. `row: { id: traceRecord.id }` in the `runSingleTier1` call: `"folds a new charge onto the reused row's receipt"` goes red.
7. Tier 2 `planRoute(parcelForFullTrace({ address, city, state, zip }), ...)` (drop the parcel id): `'keys the dossier on the parcel id when there is no city'` goes red.
8. Delete the Tier 2 `contact_vendor` line: `'writes contact_vendor on the tier 2 persist'` goes red.
9. `deadlineMs: startedAt + 10 * 60 * 1000`: `'passes the request budget to every vendor call'` goes red.
10. Delete the tier 1 `dispatchTraceCompleted`: the tier 1 webhook test goes red.
11. Put the old "Response when you supplied the owner (poll for it)" heading back in the docs page: `docsContract` goes red.
12. Drop `.eq('user_id', userId)` from `checkSingleDuplicateByHash`: the new deduplication test and the existing caller-scoping tests go red.

- [ ] **Step 8: Suite, History, commit**

Run: `npx vitest run`. Expected: 0 failed.

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 10: API single trace inline, by parcel id when there is no city.

- app/api/v1/trace/single runs Tier 1 inline like the web route (camelCase foundBy, outcomeCode,
  skipReason; 503 busy_try_again). The old processing-then-poll response is gone for new traces.
- D23: the API takes apn (or parcelId) and county. A record is judged by whether planRoute finds a
  key: a person needs a street and city or a parcel id with county, a company only name and state;
  otherwise 400 no_lookup_key with the sentence, before any write. A city-less record is keyed on
  APN, county and state (new traceKeyFor) and stores parcel_id_local and county.
- D24: a Full Property Trace sent with a parcel id tries the parcel id first, and D21's
  mailing-address search now runs on it. The API docs page describes the synchronous contract,
  the parcel id input, the busy answer and name_verified. Mutations: twelve, all red.
```

```bash
git add lib/utils/address-normalizer.ts lib/utils/deduplication.ts lib/trace/fullPropertyTrace.ts app/api/v1/trace/single/route.ts "app/(dashboard)/settings/api-keys/docs/page.tsx" "app/(dashboard)/settings/api-keys/docs/__tests__/docsContract.test.ts" lib/utils/__tests__/address-normalizer.test.ts lib/utils/__tests__/deduplication.test.ts lib/trace/__tests__/fullPropertyTrace.test.ts app/api/v1/trace/single/__tests__/route.test.ts History.md tasks/todo.md
git commit -m "$(cat <<'EOF'
feat(api-single): Tier 1 inline, parcel id input and APN duplicate key (D23, D24), synchronous docs

Tier 1 Phase 1, Task 10.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: What the owner sees: the result card, the single page and History (spec 7.2)

**Files:**
- Create: `lib/trace/historyDisplay.ts`
- Modify: `components/trace/TraceResultCard.tsx`
- Modify: `app/(dashboard)/trace/single/page.tsx`
- Modify: `app/(dashboard)/history/page.tsx`, `app/(dashboard)/dashboard/page.tsx`
- Modify: `lib/trace/__tests__/propertyRecordEgress.test.ts` (the single page's RAW_SITES entry goes: its only line was in the deleted poll)
- Test: `components/trace/__tests__/TraceResultCard.test.tsx`; create `lib/trace/__tests__/historyDisplay.test.ts`

**Interfaces:**
- Consumes: the web response fields `found_by`, `outcome_code`, `skip_reason` (Task 9); `TraceResult.name_verified` (Task 1); `rowSkipReason` (Task 7).
- Produces:
  - `export function foundByLabel(foundBy?: string | null): string | null` (`'Address' | 'Parcel ID' | 'Company name'`), `export function bulkRowExclusion(bulkTracerfyJobIds: string[]): string | null`
  - `TraceResultCard` props gain `foundBy?: string | null` and `skipReason?: string | null`.

- [ ] **Step 1: Write the failing tests**

Create `lib/trace/__tests__/historyDisplay.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bulkRowExclusion, foundByLabel } from '@/lib/trace/historyDisplay'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('bulkRowExclusion: single traces stay visible for a user who has run a bulk job', () => {
  it('keeps a row whose tracerfy_job_id is NULL, which every inline single trace is', () => {
    // SQL: NOT (col IN (...)) is NULL, so false, on a NULL column. Without the is.null arm the old
    // filter hid every inline single trace from anyone with a bulk job (research 10.2, item 11).
    // MUTATION: drop the `tracerfy_job_id.is.null,` arm and this goes red.
    expect(bulkRowExclusion(['j1', 'j2'])).toBe('tracerfy_job_id.is.null,tracerfy_job_id.not.in.(j1,j2)')
  })

  it('adds nothing when the user has no bulk jobs', () => {
    expect(bulkRowExclusion([])).toBeNull()
  })
})

describe('foundByLabel: the key, never the vendor', () => {
  it.each([
    ['address', 'Address'],
    ['parcel_id', 'Parcel ID'],
    ['company_name', 'Company name'],
  ])('%s reads %s', (value, label) => {
    expect(foundByLabel(value)).toBe(label)
  })

  it('says nothing for a row with no key, or a value it does not know', () => {
    expect(foundByLabel(null)).toBeNull()
    expect(foundByLabel('tracerfy')).toBeNull()
  })
})

describe('the pages use them (source scan, like rowSkipReason.test.ts)', () => {
  it.each(['app/(dashboard)/history/page.tsx', 'app/(dashboard)/dashboard/page.tsx'])(
    '%s keeps single traces visible and keeps bulk rows out',
    (path) => {
      const src = read(path)
      expect(src).toContain('bulkRowExclusion(')
      expect(src).toContain(".is('trace_job_id', null)")
      expect(src).not.toMatch(/\.not\(\s*'tracerfy_job_id'/)
    }
  )

  it('History shows a Found by column and the reason on rows that found nothing', () => {
    const src = read('app/(dashboard)/history/page.tsx')
    expect(src).toContain('Found by')
    expect(src).toContain('foundByLabel(')
    expect(src).toContain('rowSkipReason(')
  })

  it('the single-trace page no longer polls, and hands the card the new fields', () => {
    const src = read('app/(dashboard)/trace/single/page.tsx')
    expect(src).not.toContain('/api/trace/status')
    expect(src).toContain('skipReason={')
    expect(src).toContain('foundBy={')
  })
})
```

Append to `components/trace/__tests__/TraceResultCard.test.tsx`:

```tsx
describe('when nothing came back', () => {
  test('shows the real reason, not the three generic guesses', () => {
    // MUTATION: put the "This may be due to" list back and this goes red.
    const markup = renderToStaticMarkup(
      <TraceResultCard
        result={null}
        isCached={false}
        charge={0}
        address="1 A St"
        skipReason="We looked this owner up by address and found no match. You were not charged."
      />
    );
    expect(markup).toContain('We looked this owner up by address and found no match. You were not charged.');
    expect(markup).not.toContain('Recently transferred');
    expect(markup).not.toContain('Address format mismatch');
  });
});

describe('Found by and the charge label', () => {
  const HIT: TraceResult = { ...BASE, owner_name: 'John Smith', phones: [{ number: '5550000101', type: 'mobile' }] };

  test('names the key that found the owner', () => {
    const markup = renderToStaticMarkup(
      <TraceResultCard result={HIT} isCached={false} charge={0.15} address="1 A St" foundBy="parcel_id" />
    );
    expect(markup).toContain('Found by: Parcel ID');
  });

  test('a zero charge that was not cached says Free, not Free (cached)', () => {
    // MUTATION: restore the unconditional 'Free (cached)' and this goes red.
    const markup = renderToStaticMarkup(<TraceResultCard result={HIT} isCached={false} charge={0} address="1 A St" />);
    expect(markup).toContain('>Free<');
    expect(markup).not.toContain('Free (cached)');
  });

  test('a cached zero charge still says Free (cached)', () => {
    const markup = renderToStaticMarkup(<TraceResultCard result={HIT} isCached={true} charge={0} address="1 A St" />);
    expect(markup).toContain('Free (cached)');
  });
});

describe('contacts that are not name-verified (D21 b)', () => {
  test('are labelled', () => {
    // MUTATION: delete the name_verified block and this goes red.
    const markup = renderToStaticMarkup(
      <TraceResultCard
        result={{ ...BASE, name_verified: false, phones: [{ number: '5550000101', type: 'mobile' }] }}
        isCached={false}
        charge={0.25}
        address="1 A St"
      />
    );
    expect(markup).toContain('Not name-verified');
  });

  test('name-matched contacts carry no such label', () => {
    const markup = renderToStaticMarkup(
      <TraceResultCard result={{ ...BASE, phones: [{ number: '5550000101', type: 'mobile' }] }} isCached={false} charge={0.15} address="1 A St" />
    );
    expect(markup).not.toContain('Not name-verified');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run lib/trace/__tests__/historyDisplay.test.ts components/trace/__tests__/TraceResultCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `lib/trace/historyDisplay.ts`:

```ts
/**
 * What the History page and the dashboard show about a single trace, in one place.
 */

const FOUND_BY_LABEL: Record<string, string> = {
  address: 'Address',
  parcel_id: 'Parcel ID',
  company_name: 'Company name',
};

/** The KEY that found the owner, as a column label. Never the vendor. */
export function foundByLabel(foundBy?: string | null): string | null {
  return foundBy ? FOUND_BY_LABEL[foundBy] ?? null : null;
}

/**
 * The PostgREST OR filter that keeps single traces while leaving pre-2026-04-11 bulk rows out.
 *
 * WHY THE is.null ARM. The old `.not('tracerfy_job_id', 'in', (...))` is `NOT (col = ANY(...))`,
 * which is NULL, so false, on a NULL column. Every inline single trace carries tracerfy_job_id NULL,
 * so for any user who had ever run a bulk job the page hid every single trace written since
 * (research 10.2, item 11). Bulk rows written since 2026-04-11 carry trace_job_id and are kept out
 * by `.is('trace_job_id', null)` on the same query.
 */
export function bulkRowExclusion(bulkTracerfyJobIds: string[]): string | null {
  if (bulkTracerfyJobIds.length === 0) return null;
  return `tracerfy_job_id.is.null,tracerfy_job_id.not.in.(${bulkTracerfyJobIds.join(',')})`;
}
```

In `app/(dashboard)/history/page.tsx`: add `import { bulkRowExclusion, foundByLabel } from '@/lib/trace/historyDisplay';` and `import { rowSkipReason } from '@/lib/trace/rowSkipReason';`. In `getSingleTraces` replace

```ts
  let query = supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (bulkTracerfyJobIds.length > 0) {
    // Exclude rows that belong to bulk jobs so the 100-row limit
    // only counts actual single traces
    query = query.not('tracerfy_job_id', 'in', `(${bulkTracerfyJobIds.join(',')})`);
  }
```

with

```ts
  let query = supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    // Bulk rows carry the job they belong to; a single trace carries none.
    .is('trace_job_id', null)
    .order('created_at', { ascending: false })
    .limit(100);

  // Older bulk rows predate trace_job_id and are recognised by their batch id instead. See
  // bulkRowExclusion for why a single trace with no batch id must survive this.
  const exclusion = bulkRowExclusion(bulkTracerfyJobIds);
  if (exclusion) query = query.or(exclusion);
```

In the table header add `<TableHead className="hidden lg:table-cell">Found by</TableHead>` directly after `<TableHead>Status</TableHead>`. In the single-trace row, directly after `<TableCell>{getStatusBadge(trace.status)}</TableCell>` add:

```tsx
                        <TableCell className="hidden lg:table-cell text-sm">
                          {foundByLabel(trace.found_by) ?? <span className="text-gray-400">-</span>}
                        </TableCell>
```

and in the same row replace the Results cell's `<span className="text-gray-400">-</span>` fallback (the `trace.is_successful ? ... : ...` else branch) with:

```tsx
                            rowSkipReason(trace) ? (
                              <span className="text-xs text-gray-500">{rowSkipReason(trace)}</span>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )
```

In the bulk job row, directly after `<TableCell>{getStatusBadge(job.status)}</TableCell>` add `<TableCell className="hidden lg:table-cell"><span className="text-gray-400">-</span></TableCell>`.

In `app/(dashboard)/dashboard/page.tsx`: add `import { bulkRowExclusion } from '@/lib/trace/historyDisplay';` and in `getRecentSingleTraces` replace

```ts
  let query = supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (bulkTracerfyJobIds.length > 0) {
    query = query.not('tracerfy_job_id', 'in', `(${bulkTracerfyJobIds.join(',')})`);
  }
```

with

```ts
  let query = supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    // Bulk rows carry the job they belong to; a single trace carries none.
    .is('trace_job_id', null)
    .order('created_at', { ascending: false })
    .limit(10);

  // See bulkRowExclusion: a single trace with no batch id must survive this.
  const exclusion = bulkRowExclusion(bulkTracerfyJobIds);
  if (exclusion) query = query.or(exclusion);
```

In `components/trace/TraceResultCard.tsx`: add `import { foundByLabel } from '@/lib/trace/historyDisplay';`; extend the props interface with

```ts
  /** The KEY that found the owner (spec 7.1): address, parcel_id or company_name. */
  foundBy?: string | null;
  /** Why nothing came back, in the customer's words (spec 7.1). Shown instead of any guess. */
  skipReason?: string | null;
```

and the destructuring with `foundBy, skipReason`. Replace the whole `if (!result) { return ( ... ); }` block with:

```tsx
  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Results Found</CardTitle>
          <CardDescription>{address}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600">
            {skipReason ?? 'We could not find owner information for this property.'}
          </p>
        </CardContent>
      </Card>
    );
  }
```

After `<CardDescription>{address}</CardDescription>` in the results header add:

```tsx
            {foundByLabel(foundBy) && (
              <p className="text-sm text-gray-500 mt-1">Found by: {foundByLabel(foundBy)}</p>
            )}
```

replace `{charge > 0 ? formatCurrency(charge) : 'Free (cached)'}` with `{charge > 0 ? formatCurrency(charge) : isCached ? 'Free (cached)' : 'Free'}`, and directly before the `{/* Phone Numbers */}` block add:

```tsx
        {result.name_verified === false && (
          <div role="note" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium">Not name-verified</p>
            <p>These contacts came with the county record. They could not be matched to the owner&apos;s name.</p>
          </div>
        )}
```

In `app/(dashboard)/trace/single/page.tsx`: add to the `TraceResponse` interface

```ts
  found_by?: string | null;
  outcome_code?: string | null;
  skip_reason?: string | null;
```

replace everything in `handleSubmit` from `      // Cached result - show immediately` through `      // Unexpected response\n      setResult(data);` with:

```ts
      // Every answer is final in this one response now: a cache hit, a Full Property Trace, and a
      // supplied-owner trace (spec D1, D26). Nothing is polled.
      setResult(data);
```

and pass the two new props to the card:

```tsx
              <TraceResultCard
                result={result.result}
                isCached={result.is_cached ?? false}
                charge={result.charge}
                address={`${address}, ${city}, ${state} ${zip}`}
                traceId={result.trace_id}
                foundBy={result.found_by ?? null}
                skipReason={result.skip_reason ?? null}
              />
```

If `setDebugInfo` or `abortRef` is left with no remaining use, delete it and anything that only rendered it; if eslint still counts the same, leave it.

In `lib/trace/__tests__/propertyRecordEgress.test.ts`, delete the `'app/(dashboard)/trace/single/page.tsx'` entry from `RAW_SITES`: the line it permitted was inside the deleted poll.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run components lib/trace` then `npx tsc --noEmit` then `npx eslint app lib components 2>&1 | tail -3`.
Expected: PASS, 0 errors, at most 47 problems.

- [ ] **Step 5: Mutations**

1. Drop `tracerfy_job_id.is.null,` from `bulkRowExclusion`: `'keeps a row whose tracerfy_job_id is NULL'` goes red.
2. Put `.not('tracerfy_job_id', 'in', ...)` back in the dashboard page: the dashboard row of the source scan goes red. Same for History.
3. Restore `'Free (cached)'` unconditionally: `'a zero charge that was not cached says Free'` goes red.
4. Restore the three-guesses list in the no-result card: `'shows the real reason, not the three generic guesses'` goes red.
5. Delete the `name_verified` block: `'are labelled'` goes red.

- [ ] **Step 6: Suite, History, commit**

Run: `npx vitest run`. Expected: 0 failed.

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 11: Found by, the real reason, and History that shows single traces.

- The single-trace result card shows "Found by" (Address, Parcel ID, Company name) and, when
  nothing came back, the outcome sentence instead of three generic guesses. A zero charge reads
  Free, and Free (cached) only when it was cached. Dossier contacts are labelled Not name-verified.
- The single page stops polling: every answer arrives in one response.
- History gains a Found by column and the reason on rows that found nothing. History and the
  dashboard no longer hide single traces with no Tracerfy batch id for users who have run a bulk
  job (NOT IN on a NULL column); bulk rows are kept out by trace_job_id. Mutations: all red.
```

```bash
git add lib/trace/historyDisplay.ts components/trace/TraceResultCard.tsx "app/(dashboard)/trace/single/page.tsx" "app/(dashboard)/history/page.tsx" "app/(dashboard)/dashboard/page.tsx" lib/trace/__tests__/historyDisplay.test.ts components/trace/__tests__/TraceResultCard.test.tsx lib/trace/__tests__/propertyRecordEgress.test.ts History.md tasks/todo.md
git commit -m "$(cat <<'EOF'
feat(ui): Found by and the real reason on single traces; History shows inline traces again

Tier 1 Phase 1, Task 11.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 12: Suite gates, then the live check (one record per path, behind the owner's dollar amount)

**Files:**
- Create: `tasks/research-scripts/phase1/run-live.ts`
- Create: `tasks/phase1-live-check.md` (counts only)
- Create (gitignored, never committed): `tasks/research-test/phase1/records.json`, `tasks/research-test/phase1/live.jsonl`
- Modify: `tasks/todo.md` (review section), `History.md`

**Interfaces:**
- Consumes: the whole phase, through the real API route on a local server.
- Produces: the phase's evidence: gate results, the mutation table, and one live answer per lookup path.

- [ ] **Step 1: Suite gates**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
npx next build 2>&1 | tail -15
grep -n "submitSingleTrace" app/api/trace/single/route.ts app/api/v1/trace/single/route.ts
grep -n "persons\[0\]" lib/tracerfy/client.ts
```

Expected: vitest 0 failed, and more passing than the Task 1 baseline; `tsc exit 0`; eslint at most 47 problems; the build compiles; the two greps print nothing that is code (a comment naming the removed fallback is fine). Any other result is a defect in an earlier task: fix it there, re-run that task's mutation step, then come back.

- [ ] **Step 2: The mutation table**

Add a review section to `tasks/todo.md` under the Phase 1 item: one row per mutation run in Tasks 2 to 11 (task, the guard broken, the test named, RED or not). Any mutant that survived is a defect to fix before the live check, not a note. A mutant caught only by `tsc` is written as "tsc only" (L-020); an equivalent mutant is written as equivalent with its evidence (L-018).

- [ ] **Step 3: Choose the five records (free: registry reads only, no vendor call)**

One record per lookup path (L-024), each chosen to find a defect, not to pass (L-023):

| Id | Path | What is sent | Why it is a path |
|---|---|---|---|
| L1 | `tier1_address_person` | street, city, state, zip, an individual's name | Instant by address (D2, D13) |
| L2 | `tier1_apn_person` | state, apn, county, an individual's name, NO city | parcel lookup, D23 |
| L3 | `tier1_company` | state and an LLC's name only | FastAppend on name and state, D4 and D23 |
| L4 | `tier1_trust` | street, city, state, apn, county, a trust name WITH a first name | the full trust ladder, D3 |
| L5 | `tier2_apn_no_city` | state, apn, county, NO owner, NO city, a parcel the registry says an individual owns | D24 dossier by parcel id, then D21's mailing-address search |

Rules for picking:
- Candidates come from `/Users/davidmonroe/property-registry/docs/registry-inventory/county-searchable-coverage.csv` (L-023); never a county that is not in it.
- Secondary or tertiary markets only: never a primary metro county, never Indiana, never Florida.
- Never a county or parcel already in `tasks/research-test/` or `tasks/phase0-small-sample.md` (NY Broome, NY Monroe, LA East Baton Rouge, OH Summit, MN Ramsey, MD Wicomico, UT Washington, CA Shasta, and every county in the older research folders: list them with `ls tasks/research-test/` and a grep of the county fields).
- Five different states, and not all one property type.
- Pull each parcel with the Suite Gateway registry tools (`registry_search_parcels`, `registry_parcel_detail`), which are free.

Write them to `tasks/research-test/phase1/records.json` (gitignored) in this shape, one object per record:

```json
[
  { "id": "L1", "path": "tier1_address_person", "body": { "address": "", "city": "", "state": "", "zip": "", "ownerName": "" }, "why": "county, state, property type, and what could break" }
]
```

L5 carries `"owners": <number of owners the registry names>` so the runner can price it.

- [ ] **Step 4: Write the runner (it spends nothing without the approved amount)**

Create `tasks/research-scripts/phase1/run-live.ts`:

```ts
/**
 * Tier 1 Phase 1 live check (plan Task 12). ONE record per lookup path, sent through the real API
 * single route on a LOCAL server that points at production, and nothing else (lessons L-024).
 *
 *   npx tsx tasks/research-scripts/phase1/run-live.ts --approved-dollars <n> --email <owner email>
 *
 * Refuses to run unless the owner's approved amount covers the worst case. Reads the owner's own API
 * key from user_profiles with the service-role key in .env.local, only to call his own API; never
 * prints it or writes it anywhere. Raw request/response pairs go to
 * tasks/research-test/phase1/live.jsonl (gitignored: purchased contact data). The terminal gets no
 * owner name, street, parcel id, phone or email.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

type LivePath = 'tier1_address_person' | 'tier1_apn_person' | 'tier1_company' | 'tier1_trust' | 'tier2_apn_no_city'

interface LiveRecord {
  id: string
  path: LivePath
  body: Record<string, unknown>
  why: string
  /** tier2_apn_no_city only: how many owners the registry names. */
  owners?: number
}

/** Vendor dollars if every step bills. */
const WORST_CASE: Record<LivePath, (r: LiveRecord) => number> = {
  tier1_address_person: () => 0.1, // Instant
  tier1_apn_person: () => 0.1, // parcel lookup
  tier1_company: () => 0.1, // FastAppend
  tier1_trust: () => 0.3, // Instant + parcel + FastAppend
  tier2_apn_no_city: (r) => 0.2 + 0.1 * Math.max(r.owners ?? 3, 1), // dossier + one lookup per owner
}

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'tasks/research-test/phase1')
const RECORDS = join(OUT_DIR, 'records.json')
const BASE = 'http://localhost:3000'

function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, '')
  }
  return out
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const approved = Number(arg('approved-dollars'))
  const email = arg('email')
  if (!Number.isFinite(approved) || approved <= 0 || !email) {
    throw new Error('Usage: --approved-dollars <the amount the owner named> --email <the owner account email>')
  }
  if (!existsSync(RECORDS)) throw new Error(`Write the chosen records to ${RECORDS} first (plan Task 12, Step 3).`)

  const records = JSON.parse(readFileSync(RECORDS, 'utf8')) as LiveRecord[]
  if (new Set(records.map((r) => r.path)).size !== records.length) {
    throw new Error('One record per path (L-024): a path appears twice. Not run.')
  }
  const worst = Math.round(records.reduce((sum, r) => sum + WORST_CASE[r.path](r), 0) * 100) / 100
  if (worst > approved) {
    throw new Error(`Worst case $${worst.toFixed(2)} is over the approved $${approved.toFixed(2)}. Not run.`)
  }

  const env = loadEnvLocal()
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  const { data: profile, error } = await admin.from('user_profiles').select('api_key').eq('email', email).single()
  if (error || !profile?.api_key) throw new Error(`No API key for that account: ${error?.message ?? 'none set'}`)

  mkdirSync(OUT_DIR, { recursive: true })
  console.log(`Worst case $${worst.toFixed(2)} of $${approved.toFixed(2)} approved. ${records.length} records.`)

  for (const r of records) {
    const started = Date.now()
    const res = await fetch(`${BASE}/api/v1/trace/single`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(r.body),
    })
    const ms = Date.now() - started
    const body = (await res.json()) as Record<string, unknown>
    appendFileSync(
      join(OUT_DIR, 'live.jsonl'),
      JSON.stringify({ id: r.id, path: r.path, request: r.body, status: res.status, ms, response: body }) + '\n'
    )
    console.log(
      [
        r.id,
        r.path,
        `HTTP ${res.status}`,
        `outcome ${String(body.outcomeCode ?? 'n/a')}`,
        `foundBy ${String(body.foundBy ?? 'none')}`,
        `tier ${String(body.tier ?? 'n/a')}`,
        `charge ${String(body.charge ?? 0)}`,
        `${ms} ms`,
        `traceId ${String(body.traceId ?? 'n/a')}`,
      ].join(' | ')
    )
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
```

Check it refuses without an amount: `npx tsx tasks/research-scripts/phase1/run-live.ts` must print the usage line and exit 1 without any network call.

- [ ] **Step 5: HARD STOP 2. Ask the owner for a dollar amount.**

Send the owner, in one message: the five records (id, path, state, county, property type, the reason each could break its path; no owner names or parcel ids), the worst-case vendor cost from `WORST_CASE` ($1.10 for five records with L5 at three owners: 0.10 + 0.10 + 0.10 + 0.30 + 0.50), a note that his own wallet is charged the Tier 1 rate on each found contact and the Tier 2 rate on L5 (money that moves inside PropTracerPRO, not vendor spend), and that his webhook, if he has one set, receives one trace.completed per completed record. Ask him to name the amount. Do not run anything until he names it.

- [ ] **Step 6: Run the live check**

```bash
cd /Users/davidmonroe/PropTracerPRO
grep -c "^TRACERFY_API_KEY=\|^FASTAPPEND_API_KEY=\|^NEXT_PUBLIC_SUPABASE_URL=\|^SUPABASE_SERVICE_ROLE_KEY=" .env.local
```

Expected: `4` (names only; never print the values). Start `npm run dev` in the background on this branch and wait until `http://localhost:3000` answers. Then:

```bash
npx tsx tasks/research-scripts/phase1/run-live.ts --approved-dollars <the owner's amount> --email david@davidmonroeccim.com
```

Expected: five lines, one per record, each with an HTTP status, an outcome code, `foundBy` when found, `tier`, `charge`, the latency and a traceId. A 503 `busy_try_again` is a real answer: record it; do not resend it unless the owner asks, because a resend spends again.

- [ ] **Step 7: Read the rows back**

```bash
supabase db query --linked "select id, status, outcome_code, found_by, contact_vendor, charge, tier, cost, jsonb_array_length(trace_steps) as steps from trace_history where id in ('<traceId L1>','<traceId L2>','<traceId L3>','<traceId L4>','<traceId L5>')"
supabase db query --linked "select id, s->>'kind' as kind, s->>'outcome' as outcome, s->>'creditsDeducted' as credits, s->>'at' as at from trace_history, jsonb_array_elements(trace_steps) s where id in ('<traceId L1>','<traceId L2>','<traceId L3>','<traceId L4>','<traceId L5>') order by id"
```

Check for each record: `outcome_code` equals the response's `outcomeCode`; `found_by` agrees; `charge` is the Tier 1 rate only where contacts came back; `contact_vendor` names the vendor that produced them; every asked step has an `at`; L2's first step is `TRACERFY_PARCEL_APN`; L4's steps run Instant, parcel, FastAppend until one delivers; L5's steps are `DOSSIER_APN` then an Instant lookup (at the mailing address), and if it fell back, `result.name_verified` is `false` in live.jsonl. Any disagreement is a defect: stop and report it to the owner as a question.

- [ ] **Step 8: Report, History, commit**

Write `tasks/phase1-live-check.md`: date; approved and spent (sum of `cost` from Step 7); then one section per record with path, state, county, property type, HTTP status, outcome code, found_by, the step kinds and outcomes with credits, the charge, and the latency. Counts only: no owner names, streets, parcel ids, phones or emails.

Tick Task 12 and the Phase 1 line in `tasks/todo.md`, finishing its review section with the gate results and a link to the live report.

```markdown
## <date> (<letter>): Tier 1 Phase 1, Task 12: gates green, live check one record per path.

- vitest <n> passing, 0 failing; tsc 0 errors; eslint <n> problems (baseline 47); next build clean.
  Mutation table in tasks/todo.md: every guard in Tasks 2 to 11 went red when broken.
- Live, approved $<amount>, spent $<spent>: L1 address person <outcome>, L2 parcel id person
  <outcome>, L3 company <outcome>, L4 trust ladder <outcome>, L5 dossier by parcel id with the
  mailing-address search <outcome>. Report: tasks/phase1-live-check.md (counts only; raw in
  tasks/research-test/phase1/, gitignored).
- Branch feat/tier1-phase1-single-traces is ready; merging, pushing and deploying wait for the owner.
```

(Fill every `<...>` in this entry from Steps 1 and 7 before committing; they are results, not placeholders in the plan.)

```bash
git add tasks/research-scripts/phase1/run-live.ts tasks/phase1-live-check.md tasks/todo.md History.md
git status --short tasks/research-test
git commit -m "$(cat <<'EOF'
test(phase1): suite gates and the live check, one record per path

Tier 1 Phase 1, Task 12.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: `git status --short tasks/research-test` prints nothing (the folder is gitignored). Then stop and hand the owner: the live report, the mutation table, and the offer to run one web single trace himself to see "Found by" on the page (the web route needs his session, so it is not run by the executor; its only differences from the API route, session auth, the Track A price and address-only input, are covered by tests). Do not push, merge or deploy.

---

## Carried to later phases (not built here)

Recorded so nobody reads their absence as an oversight:

1. Bulk surfaces onto the Tier 1 queue: MCP `skip_trace_bulk`, API bulk (with D23's parcel id), web upload; per-record judging; the whole-batch rejection removal (Phase 2).
2. The shared Tracerfy rate budget (spec 5.3). D21 adds one lookup per additional owner to the Tier 2 cron (`sweep-property-traces`, 120 rows a minute at concurrency 5): a parcel naming three individual owners who all miss now costs up to five Tracerfy calls instead of two. The cron's sizing is Phase 2's to redo against the 450 a minute budget.
3. Per-arrival step-log writes and stale-claim recovery from the log, which a queue needs and an inline request does not (Phase 2).
4. `found_by` and `outcome_code` in the CSV export, `list_traces`, `bulk_status` and its API twin (with payloadParity), the MCP tool descriptions, and the bulk page summary (Phase 2).
5. The three bulk submit routes' reuse writes should clear `outcome_code`, `found_by` and `trace_steps` on a reused row; until then `rowSkipReason` orders Tier 2 first and ignores the outcome on a successful row (Phase 2).
6. Widening the `ai_research_status` queue index (spec 8) for the Tier 1 queue (Phase 2).
7. A Tier 2 single trace whose contact step fails still answers 502 and does not persist the property record it bought (pre-existing, research Section 3 step 4). D7's busy_try_again is written for Tier 1 records; Tier 2 single keeps today's failure answer in Phase 1.
8. Removing `submitSingleTrace`, the batch path, the city and state matcher and `isLikelyBusiness` after in-flight rows drain (Phase 4).

## Self-review

**Spec coverage (Section 10 Phase 1, the D1-D26 that bind it, and the scope list this plan was asked for):**

| Requirement | Task |
|---|---|
| D1, D26: single Tier 1 inline on both routes, no poll contract for new traces, status routes kept for in-flight rows, web page stops polling, API docs synchronous | 8, 9, 10, 11 |
| Spec 4.1: one classifier; TR and TTEE reach the trust ladder | 2 |
| Spec 4.2, D2, D3, D4, D16: person, company, trust, unknown ladders; no usable key gives no step | 2 |
| D22: single-trace name order unchanged; spec 4.3 match normalisation (case, suffixes, middle initials, stray comma) | 2, 3 |
| D6, spec 4.3: no persons[0]; owner_name_not_matched free, vendor spend logged, route moves on | 3, 5, 8 |
| D23: API takes apn/parcelId and county; validation by lookup key; web address-only | 10 |
| D24, D21 (both arms): dossier by parcel id first; every owner; mailing-address Instant; labelled dossier contacts; shared with the Tier 2 cron, cron covered | 6, 10 |
| D25: cache served only to the same owner | 9, 10 |
| D7, spec 5.1, 5.2: busy_try_again free; step log with kind, outcome, credits, people, timestamp; 24 hour resume by the log's own time; sweeps spare the busy row; own input problems not busy | 3, 5, 8, 9, 10 |
| Per-call timeout on the person, FastAppend and dossier clients; worst-case arithmetic; ladder bounded inside maxDuration 60 | 4, 5 (Latency budget section) |
| Spec 6.1: charge once, hasContactData, Tier 1 rate per track, ledger probe, fold, contact_vendor on Tier 1 and Tier 2 single rows; single routes stay must-fold | 8, 9, 10 |
| Spec 6.3: APN + county + state key for a city-less API record; the parcel index | 1, 10 |
| Spec 7.1, 7.3: codes, sentences, found_by, copy rules by test; responses gain the three fields (API camelCase); rowSkipReason feeds the single CSV skip_reason; Tier 1 trace.completed from the inline path | 7, 9, 10 |
| Spec 8: migration, read back, no new grants; TraceHistory type | 1 |
| UI: Found by, real reason, supplied owner not called the county roll, Free vs Free (cached), not name-verified label, History Found by and reason, NULL-safe History and dashboard filter proven by test | 6, 11 |
| Spec 11: tests first, mutation steps for name match, billing gate, ledger probe, duplicate key and D25, busy exemption and 24 hour window, request shapes, D21 loop and mailing arm, timeout to busy; every call site; no live vendor in tests; sanitized fixtures incl. the parcel lookup | 2 to 11 |
| Final gates and one-record-per-path live check behind the owner's dollar amount | 12 |
| Spec 8's queue-index widening, CSV columns, bulk payloads | Phase 2 (carried, above) |

**Placeholder scan.** The only angle-bracket fills are run-time results the executor writes after measuring them: the History `<date>` and `<letter>` (defined in Global Constraints), the Task 12 History figures, the owner's approved amount, and the five trace ids read from the runner's output. Every code step carries complete code. The two answers that change code (Q1, Q2) each have both versions written out.

**Type consistency.** Checked across tasks: `ContactResult` fields (`nameNotMatched`, `people`, `creditsDeducted`, `inputError`) are defined in Task 3 and read in Task 5; `VendorCallOptions` is defined in Task 4 (`lib/tracerfy/fetchWithTimeout.ts`) and consumed by `RouteDeps` in Task 5; `StepReport` (`at`, `requestKey`, `people`, `noContacts`, `reused`), `ExecuteOptions`, `requestKeyFor`, `stepLogFrom`, `STEP_REUSE_WINDOW_MS` are defined in Task 5 and used in Tasks 6, 7, 8, 9; `ExecutionResult.contactsNameVerified` is defined in Task 6 and set in the Task 7 test literal; `hasSitus` is exported in Task 2 and imported in Task 6; `TIER1_OUTCOME`, `tier1OutcomeFor`, `outcomeSentence`, `missingLookupKey`, `noLookupKeyReason` are defined in Task 7 and used in Tasks 8 and 10; `runSingleTier1`, `SingleTier1Row`, `SingleTier1Result.deduction` values (`not_attempted`, `already_collected`, `charged`, `insufficient_balance`, `error`) are defined in Task 8 and branched on identically in Tasks 9 and 10; `dispatchTraceCompleted`'s required `tier` is added in Task 7 together with its two existing call sites and the egress test's call; `ownerNamesMatch` is defined in Task 9 and used in Task 10; `traceKeyFor` and `checkSingleDuplicateByHash` are defined and used in Task 10; `foundByLabel` and `bulkRowExclusion` are defined and used in Task 11.
