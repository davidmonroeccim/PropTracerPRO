# Tier 1 Phase 2A: The Queue, The Cron and The Web Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web bulk upload stops building a Tracerfy person CSV and puts every owned row on a Tier 1 queue that a cron works through `planRoute()` + `executeRoute()`, one record at a time, billed through the same function a single trace bills through. A row with no city is accepted and traced instead of being dropped in the browser, and every row reports its own outcome and, when found, which key found the owner.

**Architecture:** One new ladder module (`lib/trace/tier1Queue.ts`) adds Tier 1 rungs and terminals to the EXISTING `ai_research_status` / `ai_research_claimed_at` columns, with status values disjoint from the legacy entity ladder's, so one cron file can run two lanes and no row can be claimed by both. `app/api/cron/sweep-entity-traces` becomes that cron: it keeps its legacy entity lane untouched for rows the API and MCP surfaces still enqueue, and gains a Tier 1 lane copied from the live Tier 2 cron's claim protocol (atomic compare-and-swap, shared cursor across `Promise.all` workers, per-rung stale-claim revert). The money is not reimplemented: `lib/trace/singleTier1.ts` exports a new `runTier1Record` that both single routes and the cron call, so plan, execute, judge, charge and persist happen in exactly one place. A new `lib/trace/vendorRateBudget.ts` plus one table and one RPC give the Tier 1 and Tier 2 crons ONE shared per-minute vendor budget. `executeRoute` gains an `onStep` hook so a queue worker can write the step log as each answer arrives, which is what lets a dead claim resume instead of re-buying answered steps.

**Tech Stack:** Next.js 16 route handlers, Supabase (service-role client for every write, one new SECURITY DEFINER RPC), TypeScript strict, vitest 4.1 (node environment; components rendered with `react-dom/server` `renderToStaticMarkup`).

**Spec:** `docs/superpowers/specs/2026-09-21-tier1-planroute-design.md`. Sections 3.2, 3.3, 4.x, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 7.x, 8, 10 (Phase 2), 11 and 13 bind this plan, together with decisions D1-D41. Sections 6.1 and 6.3 carry amendments dated 2026-09-23; read those amendments, not the sentence above them. Code map with file:line facts: `.superpowers/sdd/phase2-research.md`. House style and the carried-item list this phase is built from: `docs/superpowers/plans/2026-09-21-tier1-phase1-single-traces.md`. Read all three before Task 1.

**Branch point:** `main`. The last commit carrying CODE is `2e8719b` ("probe(phase2): FastAppend yield probe, plus the guard it needed after spending on its own"); the commits after it on main are documentation only, the probe report with its History entry and this plan. So branch from `main` rather than from a named commit, and expect `git log --oneline -1 2e8719b` to be reachable from it.

---

## Scope: 2A only, and what 2A is NOT

David split Phase 2 in two. **2A is the queue, the cron, the shared vendor rate budget and the WEB UPLOAD (`app/api/trace/bulk`) only.**

**NOT in this plan, and not to be built by anyone executing it:**

- **API bulk** (`app/api/v1/trace/bulk/route.ts`) keeps building its Tracerfy person CSV and keeps enqueueing entity rows onto the legacy `'queued'` ladder. It is 2B.
- **The gateway MCP `skip_trace_bulk`** (`lib/suite/mcp-tools.ts`) does the same. It is 2B.
- **`buildPerRecordResult`** in `app/api/v1/trace/bulk/status/route.ts` and in `lib/suite/mcp-tools.ts` gains NOTHING here. `lib/trace/__tests__/payloadParity.test.ts` fences those two key sets as identical, and 2A must not break it: do not add `found_by` or `outcome_code` to either one, because adding it to one is what turns that test red.
- **`list_traces`** (`lib/suite/mcp-tools.ts`) gains nothing here.
- **The MCP tool descriptions** (`app/api/[transport]/route.ts`) change nothing here.
- **`isLikelyBusiness`** (`lib/trace/ownerClassification.ts`) is not called, not changed and not deleted here. The web upload has no `isLikelyBusiness` call today and gains none: routing through the queue means `planRoute` classifies every record with `classifyOwnerName`, which is spec 4.1's one classifier. Phase 4 deletes `isLikelyBusiness`.
- **`submitSingleTrace`, the batch path and the city/state row matcher** stay. Spec 3.3: rows already submitted to the Tracerfy batch keep settling through `settleBulkJob` until none remain, and the two contract surfaces keep using that path through the whole of 2A. Phase 4 removes them after the in-flight rows drain.

**The two edits 2A does make outside the web path, both named here so neither reads as scope creep:**

1. `app/api/v1/trace/bulk/route.ts` and `lib/suite/mcp-tools.ts` each gain ONE argument at their pre-flight call (`tier1: 0`), in Task 6, when `tracerfyCanRunTier2(admin, n)` becomes `tracerfyCanRun(admin, { tier1, tier2 })`. Their behaviour does not change: their Tier 1 rows still go to the batch endpoint, a different Tracerfy bucket, so `tier1: 0` is the true value for them until 2B.
2. `app/api/trace/single/route.ts` and `app/api/v1/trace/single/route.ts` each gain one clause in their `liveWork` guard, in Task 4, so a single trace cannot race the Tier 1 cron for a row the cron is about to claim. Without it a single trace of an address whose bulk row is queued would delete or reuse that row mid-flight.

**What David must be able to see at the end of 2A:** a web upload where a city-less row actually runs instead of being dropped before posting, and where every row shows its own outcome and which key found the owner.

## Task order, and why the visible half is not last

The dependency graph allows the customer-visible work early, and this order puts it there deliberately (feedback: David judges progress by visible, usable UI).

| Task | What it is | Visible to David |
|---|---|---|
| 1 | The queue index, widened | No. Schema only, flagged bluntly. |
| 2 | The Tier 1 ladder module, the missing legacy ladder test, the per-arrival step-log hook | No |
| 3 | The web upload enqueues, and the page stops dropping city-less rows | **Yes.** A 520-row file with 30 city-less rows previews and submits 520 records. |
| 4 | The four seams a queued Tier 1 row touches | **Yes.** The job stops closing seconds after submit, the page shows "N of M records processed" while the queue drains, and a single trace of a queued address answers honestly instead of racing it. |
| 5 | The D33 bulk half, `found_by` and `outcome_code` in the CSV, the bulk page summary | **Yes.** Per-outcome counts on the job summary and two new CSV columns. |
| 6 | The shared vendor rate budget, and the Tier-1-only capacity gap | No |
| 7 | The one billing path, extracted | No |
| 8 | The Tier 1 cron | **Yes.** The queue drains and the outcomes appear. |
| 9 | Suite gates, then the live check | Yes, one real record per path. |

**Between Task 3 and Task 8 the queue has no worker.** Rows enqueue and sit. That is safe inside an unmerged branch and it is the reason the Git rule below forbids pushing, merging and deploying at any point in this phase: a deploy taken between Task 3 and Task 8 would queue real customer rows that nothing works.

---

## Hard stops

1. **Before Task 1:** David approves this plan and answers, or explicitly defers, the four open decisions below. A deferral is an answer: it means 2A ships today's behaviour on that point.
2. **Before the live check in Task 9:** David names a dollar amount, and the CONTROLLER runs the spend, not the executor. The runner also refuses to spend unless `PTP_LIVE_RUN=1` is in the environment (lesson L-031). The executor builds it and proves the refusals; it never passes `--live`.

Nothing else stops the executor except a genuine plan defect: a step that cannot work as written, or a finding that changes what is charged, reported or measured. That goes to David as a QUESTION with where it came from (lesson L-021), before Task 1 where possible, never as a silent ruling in a ledger (lesson L-028).

---

## Open decisions for David: SURFACED, NOT SETTLED. Build none of them.

Each carries the exact current behaviour and the exact proposed change, per lesson L-028. **If David does not answer one, 2A ships the "today" column and nothing in this plan changes.**

### Decision A. The FastAppend company name-match guard.

- **Today:** `parseBusinessTraceResponse` (`lib/tracerfy/client.ts:515`) takes ONE argument, the response body, and performs no name comparison at all. The person parser directly below it, `parsePersonTraceResponse` (`lib/tracerfy/client.ts:637`), takes a second `want` argument and enforces D6 through `personMatchesName` (`:422`), with an explicit "NO persons[0] FALLBACK" comment. Whatever company FastAppend decides matched, we accept, we name its principal, we bill the Tier 1 rate, and the contact can be pushed to a CRM as the property owner.
- **Measured, 2026-09-23** (`tasks/phase2-fastappend-probe.md`): owner of record `CITY OF SOUTH TUCSON` returned contacts for `CITY OF SOUTH TUCSON BUSINESS ASSOCIATION`, a different legal entity, with people carrying `PRESIDENT,DIRECTOR` roles. Billable at $0.15 to the customer, $0.10 of vendor spend.
- **Proposed change:** `parseBusinessTraceResponse(body, want?: { company_name?: string })` compares the `company_name` the vendor returns on every hit (confirmed present on both hits in the probe's raw responses) against the name asked for, and a mismatch returns the same shape a person non-match returns: `hit: true`, `contacts: null`, `nameNotMatched: true`, credits recorded in the step log, nothing charged, the ladder moves on. `executeRoute`'s `entityRequest(step)` already carries `company_name`, so the caller has the name in hand.
- **Why it is David's:** it changes what a customer is charged for. 2A gives this lane the company rows of every web upload, which is bulk volume it has never had.

### Decision B. Whether the app tells a customer that company rows resolve far less often.

- **Today:** nothing on the bulk page, in the CSV or in the API says anything about the company lane's yield. A company row that misses shows `no_match` with the sentence "We looked this owner up by company name and found no match. You were not charged."
- **Measured:** 2 hits in 10 across five entity classes and ten states (`tasks/phase2-fastappend-probe.md`), and one of those two is Decision A's name collision. With the 3 prior misses from Phase 0 and the Phase 1 live check, that is roughly 1 to 2 genuine hits in 13. The lane is not dead, so spec Section 10's removal trigger does not fire.
- **Proposed change:** none is written here. If David wants one, he names the words. Any sentence would have to pass the spec 7.3 copy rules (states the charge, no price, no dash, no asterisk, no emoji) and would be a new customer-facing string, which is his to approve and not the implementer's to invent.

### Decision C. Todo task 23, the Tier 2 reporting gap.

- **Today:** a charged Tier 2 record carries `outcome_code` NULL, `found_by` NULL and no sentence, while the free Tier 1 misses beside it each carry one. Measured on L5 of the Phase 1 live check (AR Benton, parcel with no city): charged $0.25, vendor cost $0.00, no contacts, no property record, no reason. Spec D10 says every record reports an outcome code and a sentence.
- **Already ruled:** David, 2026-09-23: "The L5 billing behavior was accurate. It costs $0.25 no matter the result, per request, not per success, when the dossier is used." The $0.25 stands and is not to be revisited.
- **Proposed change:** none in 2A. The reporting half is what stays open, and it is a Tier 2 change, so it is outside this phase's scope as well as outside its decisions. Recorded here because 2A touches the same reporting machinery and this is the moment he can fold it in if he wants it.

### Decision D. Todo task 20's remainder: the Tier 2 persists and the bulk settles still overwrite a reused row's paid result.

- **Today:** D39 closed the Tier 1 SINGLE half only (`lib/trace/singleTier1.ts` keeps the paid contacts). The two Tier 2 single persists (`app/api/trace/single/route.ts`, `app/api/v1/trace/single/route.ts`) and the bulk settles still write `trace_result`, `phone_count`, `email_count` and `is_successful` over a row that already carries paid contacts, so a customer who paid for contacts on an address and later traced it again, finding nothing, loses the earlier contacts from History and the CSV.
- **Proposed change:** none in 2A. The new Tier 1 cron inherits D39 for free, because it bills and persists through the same `runTier1Record` the single routes use (Task 7), so the WEB BULK Tier 1 path is covered from the day it ships. What stays open is the two Tier 2 single persists and `settleBulkJob`. It changes stored customer data, so it is David's.

### Decision E. The `no_lookup_key` sentence names a field the web upload has no column for.

Found while writing this plan, and surfaced rather than fixed, because it is customer-facing copy (L-028).

- **Today:** a Tier 1 record with a street, a state and no city gets `no_lookup_key`, and `noLookupKeyReason('city_and_parcel')` (`lib/trace/tier1Outcome.ts:102`) renders exactly: `This record is missing the city and the parcel ID, so it could not be looked up. You were not charged. Send it again with the city or the parcel ID.` On the API that advice is fully actionable (D23: the API takes a parcel id). On the WEB upload it is half actionable: D5 keeps the web app address-only, so there is no parcel ID column in the template and no way for the customer to supply one.
- **Why it now matters:** before 2A the page dropped city-less rows in the browser, so no web customer ever saw this sentence. Task 3 stops the dropping, so from 2A every city-less web row shows it.
- **It is not false.** It names two ways to fix the record and the web customer can use one of them. The cost is that half the advice points at a field their upload has no column for.
- **Proposed change, if David wants one:** a second pair in `MISSING_WORDS`, used only when the record carries no parcel id AND no county, reading `This record is missing the city, so it could not be looked up. You were not charged. Send it again with the city.` Nothing else about the outcome, the charge or the routing changes.
- **Default if he says nothing:** the sentence above ships unchanged.

---
## Global Constraints

Every task's requirements include this whole section.

**Decisions.** D1-D41 are settled. Implement them; do not reopen them. Where a later decision amends an earlier one, the later wins: D21 over D15, D22 over D18, D23 over D5, D32 over D21(b) and D31(2c), D36 over D9 and spec 6.3, D39 over the bare "settle overwrites the row" behaviour for Tier 1 single traces.

**The canonical price model (lesson L-030, David's words, binding, not to be re-derived).** Two buckets, four numbers:

| | tier 1, per success | tier 2, per record submitted |
|---|---|---|
| pro, AcquisitionPRO, **and a Suite Gateway grant** | **$0.15** | **$0.25** |
| pay-as-you-go | **$0.25** | **$0.40** |

- Tier 1 is FREE on a miss. Tier 2 is billed per record SUBMITTED, and **Tier 2 bills per request whenever the dossier is used, whatever the result** (David, 2026-09-23: "It costs $0.25 no matter the result, per request, not per success, when the dossier is used.").
- **ONE derivation, `lib/suite/pricing.ts`:** `chargePerTrace(profile)`, `chargePerRecord(profile)`, `pricePlanFor(profile)`, all grant-aware through `effectiveIsPro`. `getChargePerTrace` and `lib/api/pricing.ts` **no longer exist**. Never reintroduce a second derivation, and never read a rate from a route, a docs page, a marketing string or memory.
- **Owner type selects the VENDOR, never the price** (lesson L-005). There is no entity rate and no individual rate anywhere in this phase.
- `FAILSAFE_PRICE_PLAN` stays `'wallet'`, the dearest column. `planRoute` keeps a required plan argument. No `'pro'` default on any path, ever.
- `PricePlan` stays CLOSED at `'pro' | 'acqPro' | 'wallet'`. No grant-specific member: `lib/api/auth.ts` skips the entitlement refresh for a caller who is already entitled locally, so a label read off the gateway snapshot would be an unboundedly stale answer.

**Billing gate (spec 6.1, D8).** A Tier 1 record is charged once, only when a name-matched result carries at least one phone or email: `hasContactData(traceResultFor(execution))`. Free: `no_match`, `owner_name_not_matched`, `no_lookup_key`, `busy_try_again`. Before charging, ask the ledger (`collectedChargesFor`) so a record recovered after a crash is never charged twice. Money is written with `foldBillingWrite`, `tier` = `TRACE_TIER.PER_SUCCESSFUL_TRACE`. `contact_vendor` comes from `contactVendorFrom(execution.steps)`.

**ONE billing path.** `runSingleTier1` already does plan, execute, judge, bill and persist for a single row, which is exactly what a queue worker needs per record. **The cron must not reimplement any of it.** Task 7 extracts the shared core and Task 8's cron calls it. Two money derivations drift, and that is the Track A / Track B defect deleted on 2026-09-23 (History 2026-09-23 (e), lesson L-030).

**Throttling is not a failure (spec 5.1).** A record the vendor rate budget cannot cover this minute is released to the SAME rung with its claim cleared, spends nothing, tells the customer nothing, and does not consume an attempt. It waits for the next minute.

**Status values must fit `ai_research_status` VARCHAR(20)** (spec 3.2, migration `20260130_add_ai_research.sql:3`). Every value this phase introduces, with its character count:

| Value | Characters |
|---|---|
| `tier1_queued` | 12 |
| `tier1_queued_2` .. `tier1_queued_5` | 14 |
| `tier1_processing` | 16 |
| `tier1_processing_2` .. `tier1_processing_5` | 18 |
| `tier1_done` | 10 |
| `tier1_failed` | 12 |

The longest is `tier1_processing_5` at 18, two characters inside the column. A width test pins it (Task 2), copied from `lib/trace/__tests__/propertyTraceAttempts.test.ts`, which carries the same test for its own VARCHAR(24) ladder. The existing values on this column are unchanged: `queued`, `queued_2`..`queued_5`, `processing`, `processing_2`..`processing_5`, `entity_trace_failed` (19), `found`, `not_found`, `skipped_no_owner`.

**Cron sizing, pinned by a test (Task 8).** `MAX_ROWS_PER_RUN = 120` and `CONCURRENCY = 8` for the Tier 1 lane. The arithmetic, from the Phase 1 live check (`tasks/phase1-live-check.md`):

- Measured latency: 1.5 to 2.0 s on the three misses, 4.4 s and 4.1 s on the two hits. Call it 3 s per record.
- 120 rows at concurrency 8 is 15 sequential rounds, 15 x 3 s = **45 s per run**, inside `maxDuration = 300` with room for the legacy entity lane's 5 sequential rows.
- 120 rows a minute clears a 500-record job in **4.2 minutes**, inside spec 3.2's 2-to-5-minute target.
- Vendor calls per record on the WEB path specifically: the page sends no parcel id (D5), so `planRoute` can emit at most ONE Tracerfy step per record (`TRACERFY_INSTANT_NAMED`; `TRACERFY_PARCEL_APN` requires an apn and a county, which the web upload never supplies) and at most one FastAppend step. So the Tier 1 lane's worst case is **120 Tracerfy calls and 120 FastAppend calls a minute**, not the 180 the brief estimated from a 1.5-calls-per-record average. Against the Tier 2 cron's 120 rows at concurrency 5 and 2 calls per record, 240 Tracerfy calls a minute, the shared Tracerfy total is **at most 360 of the 450 budget**, 80 percent, with 90 to spare. Measured demand is lower still: of the four Tier 1 records in the Phase 1 live check, three made one Tracerfy call and one made none (the company went to FastAppend), so ~0.75 Tracerfy calls per record.
- **The numbers hold with headroom, and the headroom is why they are these numbers rather than larger ones.** Tier 2 is not starved: its own claim of 240 calls fits inside 450 alongside the Tier 1 lane's worst case.

**Every money or matching guard gets a test that FAILS when the guard is deleted, proven by deleting it** (lesson L-015), and **every call site is mutated, not one representative** (lesson L-018). A mutation caught only by `tsc` is reported as "tsc only" and not counted as a kill (lesson L-020). An equivalent mutant is reported as equivalent with its evidence (lesson L-018).

**No test calls a live vendor, and no test reaches the live database.** Fixtures are sanitized files under `lib/tracerfy/__tests__/fixtures/`; no test reads `tasks/research-test/`. Clear any spy you assert on (lesson L-013). The vitest config has no `test` block, so it loads no `.env.local` and every test is hermetic; keep it that way.

**Customer-facing copy.** No em dashes, no en dashes, no asterisks, no emoji, no markdown. Every sentence states the charge; no price, no dollar sign; "not charged" only where true; resend advice on exactly two outcomes, `no_lookup_key` and `busy_try_again`. **Any copy change is listed for David's approval and never written on the implementer's initiative** (lesson L-028). This plan changes no customer-facing sentence: every sentence a 2A row can show already exists and already passes the copy tests.

**Migrations are applied by the implementer** with `supabase db query --linked --file <file>` from the repo root, and read back (`pg_indexes`, `information_schema.columns`, `pg_class.relacl`, `pg_proc.proacl`). Account for every value you did not predict (lesson L-017). `information_schema.column_privileges` is NOT the authority on grants; the ACL is. Follow the GRANT rules in `CLAUDE.md` exactly: nothing new for `anon` or `authenticated` beyond SELECT, `trace_history` writes stay locked (`20260918_lock_trace_history_writes.sql`), and every new function gets `REVOKE ALL ... FROM PUBLIC`, `FROM anon` and `FROM authenticated` by name plus `GRANT EXECUTE ... TO service_role`, with the ACL read back.

**`payloadParity.test.ts` fences the v1 and MCP `buildPerRecordResult` key sets as identical.** It is relevant to 2B and 2A must not break it: neither function gains a key in this phase.

**No fabricated data (CLAUDE.md rule 7).** A missing sentence is `null`, not a plausible guess. An unreadable ledger is not zero. An empty queue is `processed: 0`, not an error.

**Repo rules (CLAUDE.md).** Every change as small as possible (rule 6). After every task, a `History.md` entry at the top, directly after the header rule, house style `## <date> (<letter>): <title>` then bullets, where `<date>` is the day the task finished and `<letter>` the next unused letter for that date (rule 9). Tick the task in `tasks/todo.md` (rules 2, 4).

**Commands.**
- Tests: `npx vitest run <path>` for a file, `npx vitest run` for the suite. **Baseline: 1902 passing / 84 files, 0 failing.**
- Types: `npx tsc --noEmit` (exit 0).
- Lint: `npx eslint app lib components`. **Baseline 45 problems** (measured 2026-09-23). It must never exceed 46, and the hard cap is 47. **Never bare `npm run lint`** (it scans untracked worktrees).
- Build: `npx next build`, compiles clean.

**Git.** Work on branch `feat/tier1-phase2a-queue-and-web-upload`, cut from `main` at `2e8719b`. One commit per task, message ending with the trailer line `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. **Never push, merge or deploy.** That waits for David, and between Task 3 and Task 8 a deploy would queue real customer rows that nothing works.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `supabase/migrations/20260923_tier1_queue_index.sql` | Create (T1) | Widen both `ai_research_status` partial indexes to every value both ladders use |
| `lib/trace/tier1Queue.ts` | Create (T2) | The Tier 1 rungs, terminals, predicates and the attempt ladder |
| `lib/trace/__tests__/tier1Queue.test.ts` | Create (T2) | Values, width, disjointness, ladder |
| `lib/trace/__tests__/entityTraceAttempts.test.ts` | Create (T2) | The legacy ladder has no test file today |
| `lib/routing/executeRoute.ts` | Modify (T2) | `ExecuteOptions.onStep`, called as each step report is produced |
| `app/api/trace/bulk/route.ts` | Modify (T3) | Enqueue Tier 1 instead of submitting a CSV; clear the stale Tier 1 answer on a reused row; key with `traceKeyFor` |
| `app/(dashboard)/trace/bulk/page.tsx` | Modify (T3, T4) | T3: stop dropping city-less rows. T4: the poll's progress line |
| `app/(dashboard)/trace/bulk/__tests__/page.test.ts` | Modify (T3) | The condition, at the source, in the file whose header says why |
| `lib/utils/deduplication.ts` | Modify (T3) | `traceKeyFor` as the one key; the `busy_try_again` resend exemption |
| `app/api/trace/bulk/status/route.ts` | Modify (T4) | Job completion waits on the Tier 1 queue; count its matches; report its pending rows; widen both selects |
| `app/api/cron/sweep-stale-traces/route.ts` | Modify (T4) | Stage 2 must not fail a job whose Tier 1 queue rows are still draining |
| `app/api/trace/single/route.ts` | Modify (T4) | `liveWork` recognises a Tier 1 queue row |
| `app/api/v1/trace/single/route.ts` | Modify (T4) | The same, at the duplicated guard |
| `lib/trace/bulkPreflight.ts` | Modify (T4, T6) | T4: the wallet reserve counts queued Tier 1 rows. T6: `tracerfyCanRun` sizes the Tier 1 leg |
| `lib/trace/rowSkipReason.ts` | Modify (T5) | A Tier 1 QUEUE row may serve its own outcome sentence (the D33 bulk half) |
| `lib/trace/exportCsv.ts` | Modify (T5) | `found_by` and `outcome_code` appended at the END of the header |
| `lib/trace/__tests__/exportCsv.test.ts` | Modify (T5) | 103 becomes 105; the dossier tail assertion gains an upper bound |
| `lib/trace/__tests__/propertyRecordEgress.test.ts` | Modify (T5) | The same column count |
| `supabase/migrations/20260923_vendor_rate_budget.sql` | Create (T6) | `vendor_rate_windows` table, `claim_vendor_rate` RPC, grants |
| `lib/trace/vendorRateBudget.ts` | Create (T6) | The one shared per-minute budget both crons draw from |
| `app/api/cron/sweep-property-traces/route.ts` | Modify (T6) | Reserve from the shared budget; correct the sizing comment |
| `app/api/v1/trace/bulk/route.ts` | Modify (T6) | One argument: `tier1: 0` |
| `lib/suite/mcp-tools.ts` | Modify (T6) | One argument: `tier1: 0` |
| `lib/trace/singleTier1.ts` | Modify (T7) | Export `runTier1Record`; `runSingleTier1` becomes its single-trace wrapper |
| `app/api/cron/sweep-entity-traces/route.ts` | Modify (T8) | Becomes the Tier 1 cron: a second lane beside the untouched legacy entity lane |
| `tasks/research-scripts/phase2a/run-live.ts` | Create (T9) | One real record per path, behind `PTP_LIVE_RUN=1` and `--max-dollars` |
| `tasks/phase2a-live-check.md` | Create (T9) | Counts only, no contact data |

---
### Task 1: The queue index, widened (spec Section 8)

**Files:**
- Create: `supabase/migrations/20260923_tier1_queue_index.sql`
- Modify: `tasks/todo.md` (the Phase 2 line)
- Modify: `History.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `idx_trace_history_research_queue` on `(ai_research_status, created_at) WHERE ai_research_status IS NOT NULL`, and `idx_trace_history_research_stale_claim` on `(ai_research_status, ai_research_claimed_at) WHERE ai_research_status IS NOT NULL`.

**Why there is no type change in this task, although the brief called it "migration and types".** Every column the Tier 1 queue uses already exists and is already declared: `ai_research_status` and `ai_research_claimed_at` (migrations `20260130` and `20260509`), and `outcome_code`, `found_by`, `trace_steps`, `parcel_id_local`, `county`, `contact_vendor`, `trace_job_id`, `property_trace_status` on `TraceHistory` in `types/index.ts:150-163` (Phase 1, Task 1). `SkipReasonRow` already extends `Tier1OutcomeRow` and already carries `ai_research_status`, so the reporting work in Task 5 needs no new type either. The cron in Task 8 declares its own narrow `QueueRow` interface, exactly as `app/api/cron/sweep-property-traces/route.ts:118-146` does, so a schema rename fails at compile time rather than at 3 a.m. Inventing a type change here to match the task title would be a change that impacts code for no reason (CLAUDE.md rule 6).

- [ ] **Step 1: Branch, and record the baseline**

```bash
cd /Users/davidmonroe/PropTracerPRO
git status --short
git checkout -b feat/tier1-phase2a-queue-and-web-upload main
git log --oneline -4
git merge-base --is-ancestor 2e8719b HEAD; echo "code baseline reachable: $?"
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
```

Expected: `git status --short` shows only `?? tasks/research-scripts/phase0/select_samples.py` (untracked, unrelated, leave it alone); the log shows this plan's commit and the probe report's above `2e8719b`, all three documentation only; `code baseline reachable: 0`; vitest reports **1902 passed / 84 files, 0 failed**; `tsc exit 0`; eslint ends `45 problems`. **If any of those differs, stop and tell David before changing any code.** Write the numbers down: they are this phase's baseline and Task 9 compares against them.

- [ ] **Step 2: Read both index definitions and the table ACL BEFORE touching anything**

```bash
supabase db query --linked "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'trace_history' and indexname in ('idx_trace_history_research_queue','idx_trace_history_research_stale_claim') order by indexname"
supabase db query --linked "select unnest(relacl)::text from pg_class where oid = 'public.trace_history'::regclass"
supabase db query --linked "select coalesce(ai_research_status,'(null)') as status, count(*) from trace_history group by 1 order by 2 desc"
```

Expected, and write all three outputs down:
- Two index rows. `idx_trace_history_research_queue` reads `... USING btree (ai_research_status, created_at) WHERE ((ai_research_status)::text = 'queued'::text)` (migration `20260411_bulk_trace_research.sql:11-13`). `idx_trace_history_research_stale_claim` reads `... USING btree (ai_research_claimed_at) WHERE ((ai_research_status)::text = 'processing'::text)` (migration `20260509_add_ai_research_claimed_at.sql:21-23`).
- The ACL shows `anon` and `authenticated` with `r` (SELECT) only, and `service_role` with `arwdDxtm`. `postgres` may also appear.
- The status histogram tells you how many rows the widened partial index will cover. Measured 2026-09-20 on this project: 1,298 of 3,838 rows carry a non-null `ai_research_status`. A number wildly different from that is a finding: report it, do not proceed.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260923_tier1_queue_index.sql`:

```sql
-- Tier 1 bulk queue (spec 2026-09-21 Section 8, Phase 2A): widen the two partial indexes on
-- ai_research_status so they serve every value the column now holds.
--
-- WHAT WAS WRONG WITH THE OLD PREDICATES, AND IT WAS ALREADY WRONG BEFORE THIS PHASE.
--
--   idx_trace_history_research_queue       WHERE ai_research_status = 'queued'
--   idx_trace_history_research_stale_claim WHERE ai_research_status = 'processing'
--
-- The entity retry ladder (lib/trace/entityTraceAttempts.ts, 2026-09) put four more queued values
-- on this column, 'queued_2' through 'queued_5', and four more claimed values, 'processing_2'
-- through 'processing_5'. The claim query is `.in(ENTITY_QUEUED_STATUSES)` and the stale sweep is
-- one `.eq(processingStatusFor(attempt))` per rung, so nine of those ten statements have been
-- falling back to a sequential scan since the ladder landed. Small table, no visible symptom, and
-- exactly the kind of thing that stops being invisible when the row count grows.
--
-- The Tier 1 queue (lib/trace/tier1Queue.ts) adds ten more: tier1_queued, tier1_queued_2..5,
-- tier1_processing, tier1_processing_2..5, plus the terminals tier1_done and tier1_failed.
-- Rather than list twenty values in two predicates and have to edit them again, both indexes are
-- keyed on IS NOT NULL, which is the shape the tier 2 queue's own index already uses
-- (20260918_property_trace_queue.sql: WHERE property_trace_status IS NOT NULL) and which its
-- header explains: indexing only the rows that have ever been bulk work keeps it small. Measured
-- 2026-09-20: 1,298 of 3,838 rows carry a value here, so it stays about a third of the table.
--
-- THE COLUMN ORDER IS NOT ARBITRARY, and it is the reason the stale-claim index is rebuilt rather
-- than just re-predicated. The queue claim is `.in(statuses).order('created_at').limit(120)`:
-- equality on the leading column, then the sort, which is the order Postgres can satisfy from the
-- index alone. The stale sweep is `.eq(status).or(claimed_at.is.null,claimed_at.lt.cutoff)`, so it
-- wants (status, claimed_at) and the old index led with claimed_at alone.
--
-- LOCKING. Plain CREATE INDEX takes ACCESS EXCLUSIVE for the build. trace_history held 3,838 rows
-- on 2026-09-20, so the build is milliseconds. CREATE INDEX CONCURRENTLY is deliberately NOT used:
-- it cannot run inside a transaction block, and this file is applied as one.
--
-- GRANTS: none, and that is not an oversight. An index is not a grantable object, and this file
-- creates no table and no function. CLAUDE.md's Notes section says ALTER TABLE / ADD COLUMN on a
-- pre-existing table is exempt from the 2026-10-30 rule; an index is further outside it still.
-- Adding a cargo-cult `GRANT ... TO authenticated` here would WIDEN trace_history's privileges,
-- which is the self-write vuln class CLAUDE.md warns about and which
-- 20260918_lock_trace_history_writes.sql exists to have closed. Read the ACL back anyway (L-017).

DROP INDEX IF EXISTS public.idx_trace_history_research_queue;

CREATE INDEX IF NOT EXISTS idx_trace_history_research_queue
  ON public.trace_history (ai_research_status, created_at)
  WHERE ai_research_status IS NOT NULL;

DROP INDEX IF EXISTS public.idx_trace_history_research_stale_claim;

CREATE INDEX IF NOT EXISTS idx_trace_history_research_stale_claim
  ON public.trace_history (ai_research_status, ai_research_claimed_at)
  WHERE ai_research_status IS NOT NULL;

COMMENT ON COLUMN public.trace_history.ai_research_status IS
  'TWO bulk lanes share this column, with disjoint value sets. Legacy entity lane (API bulk and MCP, retired in Phase 4): queued, queued_2..queued_5, processing, processing_2..processing_5, entity_trace_failed, found, not_found, skipped_no_owner. Tier 1 queue (the web upload, Phase 2A): tier1_queued, tier1_queued_2..tier1_queued_5, tier1_processing, tier1_processing_2..tier1_processing_5, tier1_done, tier1_failed. Values and predicates in lib/trace/entityTraceAttempts.ts and lib/trace/tier1Queue.ts. VARCHAR(20): the longest value is entity_trace_failed at 19.';

COMMENT ON COLUMN public.trace_history.ai_research_claimed_at IS
  'When a cron claimed this row, set with the status flip and cleared when the row settles or is released. A claim older than the cron stale cutoff, or one carrying NULL here, is a run killed before it could finish and is reverted one rung further up the ladder. Shared by both lanes above.';
```

- [ ] **Step 4: Apply it**

```bash
cd /Users/davidmonroe/PropTracerPRO
supabase db query --linked --file supabase/migrations/20260923_tier1_queue_index.sql
```

Expected: no error.

- [ ] **Step 5: Read it back**

```bash
supabase db query --linked "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'trace_history' order by indexname"
supabase db query --linked "select unnest(relacl)::text from pg_class where oid = 'public.trace_history'::regclass"
supabase db query --linked "select has_column_privilege('authenticated','public.trace_history','ai_research_status','UPDATE') as auth_update, has_column_privilege('anon','public.trace_history','ai_research_status','INSERT') as anon_insert, has_column_privilege('authenticated','public.trace_history','ai_research_status','SELECT') as auth_select"
supabase db query --linked "select count(*) as rows_still_here from trace_history"
```

Expected: `idx_trace_history_research_queue` now reads `USING btree (ai_research_status, created_at) WHERE (ai_research_status IS NOT NULL)`; `idx_trace_history_research_stale_claim` reads `USING btree (ai_research_status, ai_research_claimed_at) WHERE (ai_research_status IS NOT NULL)`; every other index on the table is unchanged and still present (`idx_trace_history_trace_job_id`, `idx_trace_history_property_trace_queue`, `idx_trace_history_user_parcel_county` among them); the ACL is byte-identical to Step 2; `auth_update false`, `anon_insert false`, `auth_select true`; the row count matches Step 2. **Any other value is a finding: stop and report it to David** (lesson L-017: account for every value you did not predict).

- [ ] **Step 6: todo.md, History.md, commit**

In `tasks/todo.md`, replace the line `- [ ] Phase 2: bulk queue (plan written after Phase 1)` with:

```markdown
- [ ] Phase 2A: the Tier 1 queue, the cron, the shared rate budget and the WEB upload.
      Plan: `docs/superpowers/plans/2026-09-23-tier1-phase2a-queue-and-web-upload.md`.
      API bulk and the gateway MCP `skip_trace_bulk` are 2B and are NOT in it.
  - [x] Task 1: the queue index, widened
  - [ ] Task 2: the Tier 1 ladder, the legacy ladder's missing test, the per-arrival step-log hook
  - [ ] Task 3: the web upload enqueues, and the page stops dropping city-less rows
  - [ ] Task 4: the four seams a queued Tier 1 row touches
  - [ ] Task 5: the D33 bulk half, found_by and outcome_code in the CSV and the bulk summary
  - [ ] Task 6: the shared vendor rate budget, and the Tier-1-only capacity gap
  - [ ] Task 7: the one billing path, extracted
  - [ ] Task 8: the Tier 1 cron
  - [ ] Task 9: suite gates, then the live check
- [ ] Phase 2B: API bulk and the gateway MCP onto the queue (plan written after 2A)
- [ ] Phase 3: gateway owner rule and mapping (plan written after Phase 2)
- [ ] Phase 4: cleanup (plan written after Phase 3)
```

Add at the top of `History.md`, directly after the header rule:

```markdown
## <date> (<letter>): Tier 1 Phase 2A, Task 1: both ai_research_status indexes widened.

- Migration 20260923_tier1_queue_index.sql rebuilds idx_trace_history_research_queue as
  (ai_research_status, created_at) WHERE ai_research_status IS NOT NULL, and
  idx_trace_history_research_stale_claim as (ai_research_status, ai_research_claimed_at) with the
  same predicate. Applied with supabase db query and read back.
- The old predicates were = 'queued' and = 'processing', so nine of the entity ladder's ten claim
  and sweep statements have been sequential-scanning since that ladder landed. The Tier 1 queue
  adds ten more values, so both predicates are now IS NOT NULL, the shape the tier 2 queue's own
  index already uses.
- Two column comments record which values belong to which lane, and that the two sets are
  disjoint. No grants changed: anon and authenticated are still SELECT only.
- Baseline for this phase, measured on the branch point: vitest <n> passing / <files> files,
  tsc 0 errors, eslint 45 problems.
```

```bash
cd /Users/davidmonroe/PropTracerPRO
git add supabase/migrations/20260923_tier1_queue_index.sql tasks/todo.md History.md
git commit -m "$(cat <<'EOF'
feat(schema): widen both ai_research_status indexes for the Tier 1 queue

Tier 1 Phase 2A, Task 1. Applied and read back; no grants changed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Fill the `<date>`, `<letter>` and the three baseline numbers in the History entry from Step 1 before committing. They are measurements, not placeholders in this plan.)

---

### Task 2: The Tier 1 ladder, the legacy ladder's missing test, and the per-arrival step-log hook (spec 3.2, 5.2)

**Files:**
- Create: `lib/trace/tier1Queue.ts`
- Create: `lib/trace/__tests__/tier1Queue.test.ts`
- Create: `lib/trace/__tests__/entityTraceAttempts.test.ts`
- Modify: `lib/routing/executeRoute.ts` (`ExecuteOptions`, `StageContext`, `runStage`, `executeRoute`)
- Modify: `lib/routing/__tests__/executeRoute.test.ts`
- Modify: `History.md`, `tasks/todo.md`

**Interfaces:**
- Consumes: nothing.
- Produces from `lib/trace/tier1Queue.ts`: `TIER1_MAX_ATTEMPTS: 5`, `TIER1_SETTLED_STATUS: 'tier1_done'`, `TIER1_FAILED_STATUS: 'tier1_failed'`, `tier1QueuedStatusFor(attempt: number): string`, `tier1ProcessingStatusFor(attempt: number): string`, `TIER1_ATTEMPTS: number[]`, `TIER1_QUEUED_STATUSES: string[]`, `TIER1_PROCESSING_STATUSES: string[]`, `TIER1_PENDING_STATUSES: string[]`, `tier1AttemptOf(status): number`, `isTier1QueuePending(status): boolean`, `isTier1QueueRow(status): boolean`, `tier1NextAfterFailedAttempt(attempt): { status: string; exhausted: boolean }`.
- Produces from `lib/routing/executeRoute.ts`: `ExecuteOptions.onStep?: (step: StepReport) => void | Promise<void>`.

- [ ] **Step 1: The ladder's test, written first and run to watch it fail**

Create `lib/trace/__tests__/tier1Queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  ENTITY_PROCESSING_STATUSES,
  ENTITY_QUEUED_STATUSES,
  ENTITY_TRACE_FAILED_STATUS,
} from '@/lib/trace/entityTraceAttempts'
import { BLANK_OWNER_SKIP_STATUS } from '@/lib/trace/blankOwnerSkip'
import {
  TIER1_ATTEMPTS,
  TIER1_FAILED_STATUS,
  TIER1_MAX_ATTEMPTS,
  TIER1_PENDING_STATUSES,
  TIER1_PROCESSING_STATUSES,
  TIER1_QUEUED_STATUSES,
  TIER1_SETTLED_STATUS,
  isTier1QueuePending,
  isTier1QueueRow,
  tier1AttemptOf,
  tier1NextAfterFailedAttempt,
  tier1ProcessingStatusFor,
  tier1QueuedStatusFor,
} from '@/lib/trace/tier1Queue'

/** Every value this ladder can write, for the width and disjointness tests. */
const ALL_TIER1_VALUES = [
  ...TIER1_QUEUED_STATUSES,
  ...TIER1_PROCESSING_STATUSES,
  TIER1_SETTLED_STATUS,
  TIER1_FAILED_STATUS,
]

describe('the Tier 1 queue ladder', () => {
  it('names the five rungs and their claimed twins', () => {
    expect(TIER1_MAX_ATTEMPTS).toBe(5)
    expect(TIER1_ATTEMPTS).toEqual([1, 2, 3, 4, 5])
    expect(TIER1_QUEUED_STATUSES).toEqual([
      'tier1_queued',
      'tier1_queued_2',
      'tier1_queued_3',
      'tier1_queued_4',
      'tier1_queued_5',
    ])
    expect(TIER1_PROCESSING_STATUSES).toEqual([
      'tier1_processing',
      'tier1_processing_2',
      'tier1_processing_3',
      'tier1_processing_4',
      'tier1_processing_5',
    ])
    expect(TIER1_SETTLED_STATUS).toBe('tier1_done')
    expect(TIER1_FAILED_STATUS).toBe('tier1_failed')
  })

  it('does NOT reuse attempt 1 as a bare queued, unlike the two older ladders', () => {
    // The entity and tier 2 ladders both write a BARE 'queued' for attempt 1, because they
    // predate their own ladders and needed every earlier row to read as attempt 1 with no
    // backfill. This ladder has no history to be compatible with, and it shares its column with
    // the entity ladder, so a bare 'queued' here would be claimed by the WRONG lane.
    expect(tier1QueuedStatusFor(1)).toBe('tier1_queued')
    expect(tier1ProcessingStatusFor(1)).toBe('tier1_processing')
    expect(TIER1_QUEUED_STATUSES).not.toContain('queued')
    expect(TIER1_PROCESSING_STATUSES).not.toContain('processing')
  })

  it('fits VARCHAR(20), with the longest value named', () => {
    // ai_research_status is VARCHAR(20) (migration 20260130_add_ai_research.sql:3). A value one
    // character over does not truncate, it raises 22001 and the row never settles.
    for (const value of ALL_TIER1_VALUES) {
      expect(value.length, `${value} is ${value.length} characters`).toBeLessThanOrEqual(20)
    }
    const longest = [...ALL_TIER1_VALUES].sort((a, b) => b.length - a.length)[0]
    expect(longest).toBe('tier1_processing_5')
    expect(longest.length).toBe(18)
  })

  it('shares its column with the entity lane and overlaps it NOWHERE', () => {
    // ONE CRON, TWO LANES. The Tier 1 lane claims `.in(TIER1_QUEUED_STATUSES)` and the legacy
    // entity lane claims `.in(ENTITY_QUEUED_STATUSES)` on the SAME column. One value in both sets
    // means one row worked by both lanes: two vendor calls, two settles, and under two billing
    // shapes. This is the guard that makes the shared column safe.
    const entity = new Set([
      ...ENTITY_QUEUED_STATUSES,
      ...ENTITY_PROCESSING_STATUSES,
      ENTITY_TRACE_FAILED_STATUS,
      BLANK_OWNER_SKIP_STATUS,
      'found',
      'not_found',
    ])
    for (const value of ALL_TIER1_VALUES) {
      expect(entity.has(value), `${value} is claimed by both lanes`).toBe(false)
    }
  })

  it('reads the attempt out of the status, and an unknown value as attempt 1', () => {
    expect(tier1AttemptOf('tier1_queued')).toBe(1)
    expect(tier1AttemptOf('tier1_processing')).toBe(1)
    expect(tier1AttemptOf('tier1_queued_3')).toBe(3)
    expect(tier1AttemptOf('tier1_processing_5')).toBe(5)
    // Anything unrecognized reads as attempt 1, which is the safe direction: it costs one extra
    // retry, never an early give-up. A value ABOVE the ladder is clamped to the last rung.
    expect(tier1AttemptOf('tier1_queued_9')).toBe(5)
    expect(tier1AttemptOf('queued_3')).toBe(1)
    expect(tier1AttemptOf('tier1_done')).toBe(1)
    expect(tier1AttemptOf(null)).toBe(1)
    expect(tier1AttemptOf(undefined)).toBe(1)
    expect(tier1AttemptOf('  tier1_queued_2  ')).toBe(2)
  })

  it('answers PENDING for a rung or a claim, and never for a terminal', () => {
    // A terminal value that answered true here would hold the parent bulk job at 'processing'
    // forever: app/api/trace/bulk/status/route.ts gates job completion on this predicate.
    for (const value of [...TIER1_QUEUED_STATUSES, ...TIER1_PROCESSING_STATUSES]) {
      expect(isTier1QueuePending(value), value).toBe(true)
    }
    expect(isTier1QueuePending(TIER1_SETTLED_STATUS)).toBe(false)
    expect(isTier1QueuePending(TIER1_FAILED_STATUS)).toBe(false)
    expect(isTier1QueuePending('queued')).toBe(false)
    expect(isTier1QueuePending(BLANK_OWNER_SKIP_STATUS)).toBe(false)
    expect(isTier1QueuePending(null)).toBe(false)
    expect(isTier1QueuePending('')).toBe(false)
  })

  it('answers "this row belongs to the Tier 1 lane" for terminals too', () => {
    // isTier1QueueRow is the wider question, and it is the one lib/trace/rowSkipReason.ts asks:
    // a SETTLED Tier 1 bulk row is exactly the row whose own outcome sentence must be served.
    for (const value of ALL_TIER1_VALUES) {
      expect(isTier1QueueRow(value), value).toBe(true)
    }
    expect(isTier1QueueRow('queued')).toBe(false)
    expect(isTier1QueueRow('processing_2')).toBe(false)
    expect(isTier1QueueRow(ENTITY_TRACE_FAILED_STATUS)).toBe(false)
    expect(isTier1QueueRow(BLANK_OWNER_SKIP_STATUS)).toBe(false)
    expect(isTier1QueueRow('found')).toBe(false)
    expect(isTier1QueueRow(null)).toBe(false)
    expect(isTier1QueueRow(undefined)).toBe(false)
  })

  it('walks one rung up per dead claim and then gives up terminally', () => {
    expect(tier1NextAfterFailedAttempt(1)).toEqual({ status: 'tier1_queued_2', exhausted: false })
    expect(tier1NextAfterFailedAttempt(4)).toEqual({ status: 'tier1_queued_5', exhausted: false })
    expect(tier1NextAfterFailedAttempt(5)).toEqual({ status: 'tier1_failed', exhausted: true })
    // Above the ladder is exhausted, never a rung that does not exist.
    expect(tier1NextAfterFailedAttempt(9)).toEqual({ status: 'tier1_failed', exhausted: true })
  })
})
```

Run it: `npx vitest run lib/trace/__tests__/tier1Queue.test.ts`
Expected: every test fails, because `lib/trace/tier1Queue.ts` does not exist yet.

- [ ] **Step 2: The ladder**

Create `lib/trace/tier1Queue.ts`:

```ts
/**
 * The TIER 1 bulk queue: the rungs, terminals and predicates for a supplied-owner bulk row that
 * app/api/cron/sweep-entity-traces works through planRoute() and executeRoute().
 *
 * WHY IT IS THIS COLUMN AND NOT A THIRD ONE. Spec 3.2: "It extends today's company queue
 * (ai_research_status, ai_research_claimed_at, lib/trace/entityTraceAttempts.ts) rather than
 * adding a second one, and sweep-entity-traces becomes the Tier 1 cron." So this ladder writes
 * into ai_research_status beside the legacy entity ladder, and the safety of that rests entirely
 * on ONE property: the two value sets are DISJOINT. The Tier 1 lane claims
 * `.in(TIER1_QUEUED_STATUSES)` and the entity lane claims `.in(ENTITY_QUEUED_STATUSES)`; a single
 * value in both sets would be one row worked twice, by two lanes, under two settle shapes.
 * __tests__/tier1Queue.test.ts asserts the disjointness directly.
 *
 * WHY ATTEMPT 1 IS NOT A BARE 'queued'. Both older ladders (entityTraceAttempts.ts,
 * propertyTraceAttempts.ts) keep the bare 'queued' and 'processing' for attempt 1, because each
 * was retrofitted onto a column whose existing rows had to keep reading as attempt 1 with no
 * backfill. This ladder has no history to be compatible with, and it shares its column, so a
 * bare 'queued' here would be claimed by the entity lane and handed to FastAppend with no route
 * at all. Every value carries the tier1_ prefix.
 *
 * WHAT THE LADDER IS FOR, AND IT IS NARROWER THAN THE OTHER TWO. A DEAD CLAIM, and nothing else.
 * Under D7 and spec 5.1 a Tier 1 record is never retried after a VENDOR failure: the record ends
 * busy_try_again at once, free, and the customer is told to try again in 5 minutes. So the vendor
 * branch in the cron does NOT walk this ladder; it writes the row terminal. The rungs exist for
 * the one case spec 5.1 does recover automatically: "A crash on OUR side (a claim that never
 * finished) is still recovered automatically: after a stale-claim cutoff the row is picked up
 * again and continues from its step log." A claim that never came back is a SPENT attempt, so a
 * row that kills the run every time retires instead of holding a claim slot forever, which is the
 * starvation both older ladders were written to end.
 *
 * TWO TERMINALS, NOT FOUR. propertyTraceAttempts.ts needs four because the tier 2 reason lives in
 * its status column. The Tier 1 reason does not: it lives in `outcome_code` and is rendered by
 * tier1OutcomeReason() (lib/trace/tier1Outcome.ts), which did not exist when the entity ladder was
 * built. So:
 *
 *   tier1_done    the cron is finished with this row, whatever the outcome was. The outcome code
 *                 says which, including busy_try_again on a vendor failure.
 *   tier1_failed  five claims in a row died before finishing. Free. The cron writes outcome_code
 *                 busy_try_again with it, because that is the true and already-approved sentence
 *                 for "our system could not complete this, you were not charged, try again in 5
 *                 minutes", and it is one of exactly two outcomes allowed to invite a resend
 *                 (spec 7.3).
 *
 * MONEY. Nothing on the failure paths is billable: a vendor we could not ask is our outage, not
 * the customer's miss (L-007). But do NOT copy entityTraceAttempts.ts's sentence about an
 * exhausted row being written "with no charge, no tier and no ai_research_charge": a trace_history
 * row is REUSED rather than re-inserted (UNIQUE(user_id, address_hash)), so it can already carry a
 * tier 2 receipt, and a receipt is monotonic (lib/trace/billedRows.ts). The cron writes no money
 * columns on these paths, which is not the same as writing zero into them.
 *
 * The column is VARCHAR(20). The longest value here is 'tier1_processing_5' at 18 characters.
 * Keep any new value inside that, and see the width test.
 */

/**
 * How many times a row is CLAIMED before the cron gives up on it. Only a dead claim spends one
 * (see the header), and the cron runs every minute, so this is roughly five minutes of runs that
 * keep dying on the same row. Same number as both older ladders, for the same reasons.
 */
export const TIER1_MAX_ATTEMPTS = 5

/** `ai_research_status` for a row whose Tier 1 queue work is finished, whatever the outcome. */
export const TIER1_SETTLED_STATUS = 'tier1_done'

/** `ai_research_status` for a row whose claims kept dying. Free, terminal, resendable. */
export const TIER1_FAILED_STATUS = 'tier1_failed'

/** The queued status for a given attempt. Attempt 1 is `tier1_queued`, NEVER a bare `queued`. */
export function tier1QueuedStatusFor(attempt: number): string {
  return attempt <= 1 ? 'tier1_queued' : `tier1_queued_${attempt}`
}

/** The claimed status for a given attempt. Attempt 1 is `tier1_processing`. */
export function tier1ProcessingStatusFor(attempt: number): string {
  return attempt <= 1 ? 'tier1_processing' : `tier1_processing_${attempt}`
}

/** Every attempt number on the ladder, in order. */
export const TIER1_ATTEMPTS: number[] = Array.from(
  { length: TIER1_MAX_ATTEMPTS },
  (_, i) => i + 1
)

/** Every status the Tier 1 claim query may pick a row up from. */
export const TIER1_QUEUED_STATUSES: string[] = TIER1_ATTEMPTS.map(tier1QueuedStatusFor)

/** Every status a claimed Tier 1 row may be sitting in. */
export const TIER1_PROCESSING_STATUSES: string[] = TIER1_ATTEMPTS.map(tier1ProcessingStatusFor)

/**
 * Every status a row still owing its Tier 1 trace can be sitting in: waiting on a rung, or
 * claimed by a worker on one.
 *
 * The set form of isTier1QueuePending(), for the callers that have to ask the DATABASE rather
 * than a value in hand: the bulk job completion gate and the wallet reserve. Derived from the same
 * two arrays the predicate reads, so a rung added to the ladder reaches both automatically and
 * they cannot answer differently about the same row.
 */
export const TIER1_PENDING_STATUSES: string[] = [
  ...TIER1_QUEUED_STATUSES,
  ...TIER1_PROCESSING_STATUSES,
]

/**
 * Which attempt a status represents. Anything unrecognized reads as attempt 1, which is the safe
 * direction: it costs one extra claim, never an early give-up. Above the ladder clamps to the last
 * rung rather than inventing one.
 */
export function tier1AttemptOf(status: string | null | undefined): number {
  const parsed = /^tier1_(?:queued|processing)_(\d+)$/.exec((status || '').trim())
  if (!parsed) return 1
  const n = Number(parsed[1])
  return Number.isFinite(n) && n >= 1 ? Math.min(n, TIER1_MAX_ATTEMPTS) : 1
}

/**
 * True while the row is still waiting on, or being worked for, its Tier 1 trace.
 *
 * This is what the bulk job's completion check reads, and what the two single routes' live-work
 * guard reads. A terminal value that answered true here would hold the parent job at 'processing'
 * forever; a pending value that answered false would let a single trace race the cron for the row.
 */
export function isTier1QueuePending(status: string | null | undefined): boolean {
  const s = (status || '').trim()
  if (!s) return false
  return TIER1_PENDING_STATUSES.includes(s)
}

/**
 * True when this row belongs to the Tier 1 lane AT ALL, terminals included.
 *
 * The wider question, and the one lib/trace/rowSkipReason.ts asks (the D33 bulk half): a SETTLED
 * Tier 1 bulk row is precisely the row whose own outcome sentence has to be served, and it is
 * settled, so isTier1QueuePending() is false for it. It is also how the status route counts Tier 1
 * bulk matches without double-counting the legacy CSV half.
 */
export function isTier1QueueRow(status: string | null | undefined): boolean {
  const s = (status || '').trim()
  if (!s) return false
  return (
    TIER1_PENDING_STATUSES.includes(s) ||
    s === TIER1_SETTLED_STATUS ||
    s === TIER1_FAILED_STATUS
  )
}

/**
 * Where a row goes after the CLAIM it was on died without finishing.
 *
 * `exhausted` is the whole point: it is what stops the row being claimed again and what lets the
 * parent bulk job settle.
 */
export function tier1NextAfterFailedAttempt(attempt: number): {
  status: string
  exhausted: boolean
} {
  if (attempt >= TIER1_MAX_ATTEMPTS) {
    return { status: TIER1_FAILED_STATUS, exhausted: true }
  }
  return { status: tier1QueuedStatusFor(attempt + 1), exhausted: false }
}
```

Run it: `npx vitest run lib/trace/__tests__/tier1Queue.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 3: MUTATION. Break the disjointness and watch the test catch it**

Temporarily change `tier1QueuedStatusFor` to `return attempt <= 1 ? 'queued' : \`tier1_queued_${attempt}\``, then run `npx vitest run lib/trace/__tests__/tier1Queue.test.ts`.

Expected: RED on both `does NOT reuse attempt 1 as a bare queued` and `shares its column with the entity lane and overlaps it NOWHERE`. Restore the line and watch it go green. This is the mutation that matters most in this task: it is the one that would have put one row on two lanes.

- [ ] **Step 4: The legacy ladder's missing test**

`lib/trace/entityTraceAttempts.ts` has NO test file today (`.superpowers/sdd/phase2-research.md` Section 7); its behaviour is only exercised indirectly through the cron's route test. Task 8 edits that cron, so the ladder it shares gets its own fence first.

Create `lib/trace/__tests__/entityTraceAttempts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  ENTITY_PROCESSING_STATUSES,
  ENTITY_QUEUED_STATUSES,
  ENTITY_TRACE_ATTEMPTS,
  ENTITY_TRACE_FAILED_REASON,
  ENTITY_TRACE_FAILED_STATUS,
  MAX_ENTITY_TRACE_ATTEMPTS,
  attemptOf,
  entityTraceFailureReason,
  isEntityTraceFailed,
  isEntityTracePending,
  nextAfterFailedAttempt,
  processingStatusFor,
  queuedStatusFor,
} from '@/lib/trace/entityTraceAttempts'

describe('the legacy entity ladder', () => {
  it('keeps the bare queued and processing for attempt 1, so no row needs a backfill', () => {
    // 1,298 rows carry a value on this column (measured 2026-09-20) and the oldest of them were
    // written before the ladder existed. Renaming attempt 1 would strand every one of them.
    expect(MAX_ENTITY_TRACE_ATTEMPTS).toBe(5)
    expect(ENTITY_TRACE_ATTEMPTS).toEqual([1, 2, 3, 4, 5])
    expect(queuedStatusFor(1)).toBe('queued')
    expect(processingStatusFor(1)).toBe('processing')
    expect(ENTITY_QUEUED_STATUSES).toEqual([
      'queued',
      'queued_2',
      'queued_3',
      'queued_4',
      'queued_5',
    ])
    expect(ENTITY_PROCESSING_STATUSES).toEqual([
      'processing',
      'processing_2',
      'processing_3',
      'processing_4',
      'processing_5',
    ])
    expect(ENTITY_TRACE_FAILED_STATUS).toBe('entity_trace_failed')
  })

  it('fits VARCHAR(20), with one character to spare on the longest value', () => {
    const all = [
      ...ENTITY_QUEUED_STATUSES,
      ...ENTITY_PROCESSING_STATUSES,
      ENTITY_TRACE_FAILED_STATUS,
    ]
    for (const value of all) {
      expect(value.length, `${value} is ${value.length} characters`).toBeLessThanOrEqual(20)
    }
    expect(ENTITY_TRACE_FAILED_STATUS.length).toBe(19)
  })

  it('reads the attempt out of the status, and an unknown value as attempt 1', () => {
    expect(attemptOf('queued')).toBe(1)
    expect(attemptOf('processing')).toBe(1)
    expect(attemptOf('queued_4')).toBe(4)
    expect(attemptOf('processing_2')).toBe(2)
    expect(attemptOf('queued_9')).toBe(5)
    expect(attemptOf(ENTITY_TRACE_FAILED_STATUS)).toBe(1)
    expect(attemptOf(null)).toBe(1)
    // A Tier 1 value must NOT read as an entity attempt: the two lanes share this column.
    expect(attemptOf('tier1_queued_3')).toBe(1)
  })

  it('answers PENDING for a rung or a claim and not for the terminal', () => {
    for (const value of [...ENTITY_QUEUED_STATUSES, ...ENTITY_PROCESSING_STATUSES]) {
      expect(isEntityTracePending(value), value).toBe(true)
    }
    expect(isEntityTracePending(ENTITY_TRACE_FAILED_STATUS)).toBe(false)
    expect(isEntityTracePending('found')).toBe(false)
    expect(isEntityTracePending('skipped_no_owner')).toBe(false)
    expect(isEntityTracePending(null)).toBe(false)
    expect(isEntityTracePending('')).toBe(false)
    // And it does NOT claim a Tier 1 queue row, which shares the column.
    expect(isEntityTracePending('tier1_queued')).toBe(false)
    expect(isEntityTracePending('tier1_processing_2')).toBe(false)
  })

  it('walks one rung up per failed attempt and then gives up terminally', () => {
    expect(nextAfterFailedAttempt(1)).toEqual({ status: 'queued_2', exhausted: false })
    expect(nextAfterFailedAttempt(4)).toEqual({ status: 'queued_5', exhausted: false })
    expect(nextAfterFailedAttempt(5)).toEqual({
      status: ENTITY_TRACE_FAILED_STATUS,
      exhausted: true,
    })
    expect(nextAfterFailedAttempt(9)).toEqual({
      status: ENTITY_TRACE_FAILED_STATUS,
      exhausted: true,
    })
  })

  it('serves the exhaustion sentence for the terminal value and nothing else', () => {
    expect(isEntityTraceFailed(ENTITY_TRACE_FAILED_STATUS)).toBe(true)
    expect(isEntityTraceFailed('queued')).toBe(false)
    expect(entityTraceFailureReason(ENTITY_TRACE_FAILED_STATUS)).toBe(ENTITY_TRACE_FAILED_REASON)
    expect(entityTraceFailureReason('queued')).toBeNull()
    expect(entityTraceFailureReason('tier1_failed')).toBeNull()
    expect(entityTraceFailureReason(null)).toBeNull()
  })

  it('states the charge, quotes no price and invites no resend', () => {
    // Spec 7.3, already enforced for the sibling sentences: every sentence states the charge; no
    // price, no dollar sign, no dash, no asterisk, no emoji; and resend advice belongs to exactly
    // two outcomes, neither of which is this one (blankOwnerSkip.ts explains why at length: the
    // dedup hash is address-only, so the resend this sentence used to invite was silently dropped).
    expect(ENTITY_TRACE_FAILED_REASON).toContain('you were not charged')
    expect(ENTITY_TRACE_FAILED_REASON).not.toMatch(/[$*\u2014\u2013]/)
    expect(ENTITY_TRACE_FAILED_REASON).not.toMatch(/send it again|try again/i)
  })
})
```

Run it: `npx vitest run lib/trace/__tests__/entityTraceAttempts.test.ts`
Expected: all 7 tests pass on the code as it stands. If one fails, the ladder is not what this plan read: stop and report it.

- [ ] **Step 5: MUTATION on the legacy ladder**

Temporarily change `nextAfterFailedAttempt` to `return { status: queuedStatusFor(attempt + 1), exhausted: false }` with the exhaustion branch deleted, run `npx vitest run lib/trace/__tests__/entityTraceAttempts.test.ts`.

Expected: RED on `walks one rung up per failed attempt and then gives up terminally`. Restore it and watch it go green. Before this test file existed, deleting that branch left the whole suite green while every poisoned row looped forever.

- [ ] **Step 6: The per-arrival step-log hook, test first**

Add to `lib/routing/__tests__/executeRoute.test.ts` (a new `describe` block; keep every existing test untouched):

```ts
describe('onStep, the per-arrival step-log hook (spec 5.2)', () => {
  it('hands the caller every report as it is produced, in order', async () => {
    // A QUEUE NEEDS THIS AND AN INLINE REQUEST DOES NOT. A single trace writes trace_steps once,
    // after the ladder finishes, because its request is guaranteed to finish. A cron worker can be
    // killed between two vendor calls, and the row is then re-claimed one rung up: without the log
    // already on the row, the resumed attempt buys the answered steps again.
    const seen: Array<{ kind: string; outcome: string }> = []
    const plan = planRoute(
      {
        state: 'TX',
        situsAddress: '1 Main St',
        situsCity: 'Smithville',
        situsState: 'TX',
        ownerName: 'Smith Family Trust',
      },
      'pro'
    )
    const execution = await executeRoute(
      plan,
      {
        lookupDossier: async () => {
          throw new Error('no dossier on a tier 1 plan')
        },
        traceEntity: async () => ({ success: true, hit: false }),
        tracePerson: async () => ({ success: true, hit: false }),
      },
      { onStep: (step) => void seen.push({ kind: step.kind, outcome: step.outcome }) }
    )

    expect(seen).toEqual(execution.steps.map((s) => ({ kind: s.kind, outcome: s.outcome })))
    expect(seen.length).toBeGreaterThan(1)
  })

  it('awaits an async hook, so a worker can finish its write before the next vendor call', async () => {
    const order: string[] = []
    const plan = planRoute(
      {
        state: 'TX',
        situsAddress: '1 Main St',
        situsCity: 'Smithville',
        situsState: 'TX',
        ownerName: 'Smith Family Trust',
      },
      'pro'
    )
    await executeRoute(
      plan,
      {
        lookupDossier: async () => {
          throw new Error('no dossier on a tier 1 plan')
        },
        traceEntity: async () => {
          order.push('vendor')
          return { success: true, hit: false }
        },
        tracePerson: async () => {
          order.push('vendor')
          return { success: true, hit: false }
        },
      },
      {
        onStep: async () => {
          await Promise.resolve()
          order.push('write')
        },
      }
    )

    // Every write lands before the next vendor call, never after the ladder has moved on.
    expect(order[0]).toBe('vendor')
    expect(order[1]).toBe('write')
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBe('vendor')
      expect(order[i + 1]).toBe('write')
    }
  })

  it('never lets a failing hook break the ladder, and logs it instead', async () => {
    // executeRoute's house contract is NEVER THROWS (its own header). A step-log write is a
    // database call and database calls fail, so a hook that throws must not take the vendor work
    // with it. It is logged, because the console is the only operator channel PTP has.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const plan = planRoute(
      { state: 'TX', situsAddress: '1 Main St', situsCity: 'Smithville', situsState: 'TX', ownerName: 'Jane Smith' },
      'pro'
    )
    const execution = await executeRoute(
      plan,
      {
        lookupDossier: async () => {
          throw new Error('no dossier on a tier 1 plan')
        },
        traceEntity: async () => ({ success: true, hit: false }),
        tracePerson: async () => ({ success: true, hit: false }),
      },
      {
        onStep: () => {
          throw new Error('step write failed')
        },
      }
    )

    expect(execution.steps.length).toBeGreaterThan(0)
    expect(execution.error).toBeUndefined()
    expect(logged).toHaveBeenCalledWith(
      '[executeRoute] onStep failed, the ladder continued:',
      expect.any(Error)
    )
    logged.mockRestore()
  })

  it('runs the whole ladder unchanged when no hook is passed', async () => {
    const plan = planRoute(
      { state: 'TX', situsAddress: '1 Main St', situsCity: 'Smithville', situsState: 'TX', ownerName: 'Jane Smith' },
      'pro'
    )
    const execution = await executeRoute(plan, {
      lookupDossier: async () => {
        throw new Error('no dossier on a tier 1 plan')
      },
      traceEntity: async () => ({ success: true, hit: false }),
      tracePerson: async () => ({ success: true, hit: false }),
    })
    expect(execution.steps.map((s) => s.outcome)).toEqual(['miss'])
  })
})
```

Check the file's existing imports include `vi` from `vitest` and `planRoute` from `@/lib/routing/ownerRoute`; add whichever is missing to the existing import statements rather than writing a second one.

Run it: `npx vitest run lib/routing/__tests__/executeRoute.test.ts`
Expected: the four new tests fail (`onStep` is not a known option), every existing test in the file still passes.

- [ ] **Step 7: The hook**

In `lib/routing/executeRoute.ts`, inside `ExecuteOptions`, after the `priorSteps` field, add:

```ts
  /**
   * Called with each step report AS IT IS PRODUCED, before the next vendor call starts.
   *
   * WHAT IT IS FOR, AND WHY ONLY A QUEUE USES IT (spec 5.2). A single trace writes trace_steps
   * ONCE, after the ladder finishes: its request is bounded by SINGLE_ROUTE_BUDGET_MS and is
   * guaranteed to reach its own persist. A cron worker is not: the run can be killed between two
   * vendor calls, and the row is then re-claimed one rung up the ladder. Without the answers
   * already on the row, that second attempt asks the same questions again and BUYS THEM AGAIN.
   *
   * Awaited, so the worker's write lands before the next call is made rather than racing it.
   * A hook that throws is logged and swallowed: this module never throws (see the header), and a
   * failed bookkeeping write must not take the vendor work with it.
   */
  onStep?: (step: StepReport) => void | Promise<void>
```

In the same file, inside `interface StageContext`, after `now: () => number`, add:

```ts
  onStep?: (step: StepReport) => void | Promise<void>
```

In `runStage`, replace the line `  const reports: StepReport[] = []` and its four `reports.push(...)` call sites with one recorder. The new head of the function reads:

```ts
async function runStage(steps: RouteStep[], deps: RouteDeps, ctx: StageContext): Promise<StageResult> {
  const reports: StepReport[] = []
  let spend = 0
  let hit: VendorCall | null = null
  let failure: string | null = null

  /**
   * Record one report, and hand it to the caller's hook before the next step runs.
   *
   * ONE FUNNEL, SIX CALL SITES. This stage pushes a report from six places (skipped after a hit
   * or a failure, a reused answer, a call the budget could not start, our own refused request, a
   * vendor failure, and an answer). A hook wired into five of them is a step log missing whichever
   * one the next reader forgets, which for a queue means a resumed row re-buying that step.
   */
  const record = async (report: StepReport): Promise<void> => {
    reports.push(report)
    if (!ctx.onStep) return
    try {
      await ctx.onStep(report)
    } catch (err) {
      // NEVER THROWS is this module's contract. The console is the only operator channel PTP has.
      console.error('[executeRoute] onStep failed, the ladder continued:', err)
    }
  }
```

Then change each of the six pushes in `runStage` to `await record({...})`:

1. The skipped branch at the top of the loop: `reports.push({ kind: step.kind, outcome: 'skipped', cost: 0, note: hit ? ... : ... })` becomes `await record({ kind: step.kind, outcome: 'skipped', cost: 0, note: hit ? 'an earlier step hit; this one would have been a wasted charge' : 'an earlier step failed; not attempted' })`.
2. The reuse branch: `reports.push({ ...prior, reused: true })` becomes `await record({ ...prior, reused: true })`.
3. The budget branch: `reports.push({ kind: step.kind, outcome: 'failed', cost: 0, error: failure, at: new Date(ctx.now()).toISOString(), requestKey })` becomes `await record({ ... })` with the identical object.
4. The `call.inputError` branch: `reports.push({ kind: step.kind, outcome: 'skipped', cost: 0, note: \`not sent: ${call.error ?? 'refused'}\`, at, requestKey })` becomes `await record({ ... })` with the identical object.
5. The `!call.success` branch: `reports.push({ kind: step.kind, outcome: 'failed', cost: 0, error: failure, at, requestKey })` becomes `await record({ ... })` with the identical object.
6. The answered branch: the multi-line `reports.push({ kind: step.kind, outcome: call.nameNotMatched ? 'name_not_matched' : call.hit ? 'hit' : 'miss', ... })` becomes `await record({ ... })` with the identical object.

In `executeRoute`, inside the `const ctx: StageContext = { ... }` literal, after `now: options.now ?? Date.now,` add:

```ts
    onStep: options.onStep,
```

Run it: `npx vitest run lib/routing/__tests__/executeRoute.test.ts lib/routing/__tests__/ownerRoute.test.ts lib/trace/__tests__/singleTier1.test.ts`
Expected: everything passes, including the four new tests and every pre-existing one.

- [ ] **Step 8: MUTATION. Unwire one call site and watch the funnel test catch it**

`onStep` is exactly the L-018 shape: six call sites, one hook. Mutate each of the six in turn by replacing `await record({...})` with `reports.push({...})`, and after each one run:

```bash
npx vitest run lib/routing/__tests__/executeRoute.test.ts
```

Expected: RED on `hands the caller every report as it is produced, in order` for each of the six, because that test compares the hook's own sequence against `execution.steps`. Restore each before mutating the next. If a site survives, the test does not reach it: write a case that does (a trust ladder reaches the hit-skip and answer sites; a `deadlineMs` in the past reaches the budget site; a `tracePerson` returning `{ success: false, inputError: true, error: 'x' }` reaches the refusal site; `{ success: false, error: 'boom' }` reaches the failure site; a `priorSteps` entry matching `requestKeyFor(step)` with a fresh `at` reaches the reuse site). Record any site whose mutation is caught only by `tsc` as "tsc only" (L-020).

- [ ] **Step 9: Gates, History, commit**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
```

Expected: 0 failed and more passing than the Task 1 baseline of 1902 (this task adds 19 tests across three files); `tsc exit 0`; eslint at most 46.

Tick Task 2 in `tasks/todo.md` and add at the top of `History.md`:

```markdown
## <date> (<letter>): Tier 1 Phase 2A, Task 2: the Tier 1 ladder and the per-arrival step log.

- lib/trace/tier1Queue.ts adds the Tier 1 rungs to the EXISTING ai_research_status column, with
  every value prefixed tier1_ so the set is disjoint from the legacy entity ladder's. One cron
  will run both lanes and the disjointness is what makes that safe; a test asserts it directly,
  and the mutation that reverts attempt 1 to a bare 'queued' goes red.
- Two terminals rather than four: tier1_done and tier1_failed. The Tier 1 reason lives in
  outcome_code, not in the status column, which is the difference from the tier 2 ladder.
- The ladder's rungs are for a DEAD CLAIM only. D7 and spec 5.1 say a vendor failure is never
  retried: the record ends busy_try_again at once, free.
- lib/trace/__tests__/entityTraceAttempts.test.ts is new: that ladder had no test file at all.
- executeRoute gains ExecuteOptions.onStep, awaited, called from all six report sites through one
  recorder. Each of the six was mutated separately (L-018) and each went red. A hook that throws
  is logged and swallowed, because this module never throws.
```

```bash
git add lib/trace/tier1Queue.ts lib/trace/__tests__/tier1Queue.test.ts lib/trace/__tests__/entityTraceAttempts.test.ts lib/routing/executeRoute.ts lib/routing/__tests__/executeRoute.test.ts tasks/todo.md History.md
git commit -m "$(cat <<'EOF'
feat(queue): the Tier 1 ladder, disjoint from the entity lane, and a per-arrival step log

Tier 1 Phase 2A, Task 2.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 3: The web upload enqueues, and the page stops dropping city-less rows (spec 3.1, 3.2, 5.2, 6.3, D33, D36)

**This is the first task David can see.** After it, a 520-row county export carrying 30 rows with no city previews 520 records and submits 520 records, and every owned row lands on the Tier 1 queue instead of in a Tracerfy person CSV.

**Files:**
- Modify: `lib/utils/deduplication.ts` (`removeBatchDuplicates`, `checkDuplicates`)
- Modify: `lib/utils/__tests__/deduplication.test.ts`
- Modify: `app/api/trace/bulk/route.ts`
- Modify: `app/api/trace/bulk/__tests__/route.test.ts`
- Modify: `app/(dashboard)/trace/bulk/page.tsx` (`mapRows`, the `MAX_RECORDS` docblock)
- Modify: `app/(dashboard)/trace/bulk/__tests__/page.test.ts`
- Modify: `History.md`, `tasks/todo.md`

**Interfaces:**
- Consumes: `tier1QueuedStatusFor` (Task 2), `traceKeyFor` (`lib/utils/address-normalizer.ts:170`), `TIER1_OUTCOME` (`lib/trace/tier1Outcome.ts:14`).
- Produces: `trace_history` rows carrying `ai_research_status = 'tier1_queued'`, `status = 'processing'`, `tracerfy_job_id` absent, `property_trace_status` null, and `outcome_code` / `found_by` / `trace_steps` cleared unless the row is a busy resume. `POST /api/trace/bulk` no longer calls `submitBulkTrace`.

**WARNING to whoever executes this task: after it, the queue has no worker until Task 8.** Rows enqueue and sit at `tier1_queued`. Do not deploy, merge or push this branch between here and Task 8.

- [ ] **Step 1: The duplicate key and the busy exemption, tests first**

Add to `lib/utils/__tests__/deduplication.test.ts` (a new `describe` block; leave every existing test alone):

```ts
describe('the bulk duplicate key (spec 6.3, D36)', () => {
  it('is traceKeyFor, so one record cannot land on two rows through two doors', () => {
    // WHY THIS MATTERS EVEN THOUGH THE TWO AGREE ON EVERY WEB RECORD TODAY. The single routes key
    // with traceKeyFor (app/api/v1/trace/single/route.ts) and the bulk routes keyed with plain
    // normalizeAddress. On the web upload the two answers are identical for every record the page
    // can send, because the page requires a street and a state and the web app has no parcel id
    // column (D5). They diverge the moment a surface carries a parcel id, which is exactly what
    // 2B wires up, and a divergence there is the same record stored twice: paid once, charged
    // again inside the 90 days. One derivation now, proven, rather than two that happen to agree.
    const withStreetAndCity = { address: '100 Main St', city: 'Dallas', state: 'TX' }
    expect(traceKeyFor(withStreetAndCity)).toBe(normalizeAddress('100 Main St', 'Dallas', 'TX'))

    const streetNoCity = { address: '100 Main St', city: '', state: 'TX' }
    expect(traceKeyFor(streetNoCity)).toBe(normalizeAddress('100 Main St', '', 'TX'))

    // The 2B shape, keyed on the parcel rather than on `|CITY|STATE` (D36).
    expect(traceKeyFor({ city: 'Austin', state: 'TX', apn: '0123-456', county: 'Travis' })).toBe(
      'APN|0123-456|TRAVIS|TX'
    )
  })

  it('removeBatchDuplicates keys on traceKeyFor', async () => {
    const { removeBatchDuplicates } = await import('@/lib/utils/deduplication')
    const a = { address: '100 Main St', city: '', state: 'TX', apn: '0123-456', county: 'Travis' }
    const b = { address: '200 Oak Ave', city: '', state: 'TX', apn: '0123-456', county: 'Travis' }
    // Same parcel, two different street strings: under D36 that is ONE record, and under plain
    // normalizeAddress it was two.
    const { unique, internalDuplicates } = removeBatchDuplicates([a, b])
    expect(unique).toHaveLength(1)
    expect(internalDuplicates).toBe(1)
  })
})

describe('the busy_try_again resend exemption (spec 5.2)', () => {
  it('does NOT count a busy row as a duplicate', async () => {
    // Spec 5.2: "A resend of a busy_try_again record is NOT a duplicate. It reuses the same row
    // (same address hash) and goes back on the queue. This exemption is what makes 'try again in 5
    // minutes' true." Without it the sentence is advice that fails when followed: the row is
    // written status 'error', so the stale-processing escape below does not reach it either, and
    // the resend lands in Duplicates Removed with no explanation.
    const record = { address: '100 Main St', city: 'Dallas', state: 'TX' }
    const hash = createAddressHash(traceKeyFor(record))
    stubRows([
      {
        address_hash: hash,
        status: 'error',
        outcome_code: 'busy_try_again',
        created_at: new Date().toISOString(),
      },
    ])
    const result = await checkDuplicates('user-1', [record])
    expect(result.newRecords).toHaveLength(1)
    expect(result.duplicates).toHaveLength(0)
  })

  it('still counts every OTHER finished row as a duplicate, busy being the one exemption', async () => {
    // Open task 17 is unchanged by this: a row that came back without contacts still blocks a
    // resend for 90 days. Only busy is exempt, because only busy is the outcome whose own sentence
    // tells the customer to send it again.
    const record = { address: '100 Main St', city: 'Dallas', state: 'TX' }
    const hash = createAddressHash(traceKeyFor(record))
    for (const outcome of ['no_match', 'owner_name_not_matched', 'no_lookup_key', null]) {
      stubRows([
        {
          address_hash: hash,
          status: 'no_match',
          outcome_code: outcome,
          created_at: new Date().toISOString(),
        },
      ])
      const result = await checkDuplicates('user-1', [record])
      expect(result.newRecords, `outcome ${outcome}`).toHaveLength(0)
      expect(result.duplicates, `outcome ${outcome}`).toHaveLength(1)
    }
  })
})
```

Read the existing file first and reuse its own harness rather than inventing one: it already stubs `@/lib/supabase/server` and `@/lib/supabase/admin`. Name the local helper that seeds rows whatever that file already calls it (`stubRows` above is a placeholder for the name you find; if the file has no such helper, add one that sets the array the existing `createClient` stub returns from `.select().eq().in().gte()`). Import `traceKeyFor`, `normalizeAddress` and `createAddressHash` from `@/lib/utils/address-normalizer` at the top of the file if they are not already imported.

Run it: `npx vitest run lib/utils/__tests__/deduplication.test.ts`
Expected: the four new tests fail; every existing test in the file passes.

- [ ] **Step 2: The duplicate key and the busy exemption**

In `lib/utils/deduplication.ts`, change the import line

```ts
import { normalizeAddress, createAddressHash } from './address-normalizer';
```

to

```ts
import { normalizeAddress, createAddressHash, traceKeyFor } from './address-normalizer';
import { TIER1_OUTCOME } from '@/lib/trace/tier1Outcome';
```

In `checkDuplicates`, replace the `recordsWithHashes` block

```ts
  const recordsWithHashes = records.map((record) => ({
    ...record,
    normalizedAddress: normalizeAddress(record.address, record.city, record.state),
    hash: createAddressHash(
      normalizeAddress(record.address, record.city, record.state)
    ),
  }));
```

with

```ts
  // ONE KEY DERIVATION (spec 6.3, D36). traceKeyFor is what the single routes key on, so a record
  // sent through single and bulk lands on ONE row rather than two. It agrees with plain
  // normalizeAddress on every record that carries a street and a city, which is every web upload
  // record; it differs for a record keyed on a parcel, which is the shape 2B sends.
  const recordsWithHashes = records.map((record) => ({
    ...record,
    normalizedAddress: traceKeyFor(record),
    hash: createAddressHash(traceKeyFor(record)),
  }));
```

In the same function, replace the `validTraces` filter

```ts
  const validTraces = (existingTraces || []).filter((t: TraceHistory) => {
    if (t.status === 'processing' && new Date(t.created_at) < staleCutoff) {
      return false; // Stale processing — don't count as duplicate
    }
    return true;
  });
```

with

```ts
  const validTraces = (existingTraces || []).filter((t: TraceHistory) => {
    if (t.status === 'processing' && new Date(t.created_at) < staleCutoff) {
      return false; // Stale processing: do not count as a duplicate.
    }
    // THE BUSY EXEMPTION (spec 5.2), and it is what makes one of our own sentences true.
    //
    // busy_try_again tells the customer "The system is busy. Try again in 5 minutes. You were not
    // charged." That row is written status 'error', so the stale-processing escape above never
    // reaches it, and the address hash carries no outcome, so the resend matched this very row and
    // was dropped into Duplicates Removed with nothing said. The customer did what we told them and
    // got nothing. Resend advice is allowed on exactly two outcomes (spec 7.3) and this is one of
    // them precisely because the resend genuinely runs.
    //
    // It reuses the SAME row, so the step log is still there and executeRoute replays the answers
    // this record already bought rather than buying them again. Answers older than 24 hours are not
    // reused, judged by each entry's own timestamp inside executeRoute, because a reused row keeps
    // its original created_at.
    //
    // Only busy. Open task 17 (a finished row blocks a resend for 90 days) is unchanged.
    if (t.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN) return false;
    return true;
  });
```

In `removeBatchDuplicates`, replace

```ts
    const hash = createAddressHash(
      normalizeAddress(record.address, record.city, record.state)
    );
```

with

```ts
    // The same key derivation checkDuplicates uses, for the same reason (spec 6.3, D36).
    const hash = createAddressHash(traceKeyFor(record));
```

`normalizeAddress` is still imported and still used by `checkSingleDuplicate`, so the import stays.

Run it: `npx vitest run lib/utils/__tests__/deduplication.test.ts app/api/v1/trace/bulk/__tests__/route.test.ts lib/suite/__tests__/mcp-tools.test.ts`
Expected: everything passes. The two 2B surfaces are unaffected because every record they accept has a street and a city (both reject a record failing `validateAddressInput` before dedup runs), and for that shape `traceKeyFor` returns exactly what `normalizeAddress` returned.

- [ ] **Step 3: MUTATION on the busy exemption and on the key**

Two mutations, each run against its named test:

1. Delete the `if (t.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN) return false;` line, run `npx vitest run lib/utils/__tests__/deduplication.test.ts`. Expected: RED on `does NOT count a busy row as a duplicate`. Restore.
2. Change the exemption to `if (t.outcome_code) return false;`, run the same file. Expected: RED on `still counts every OTHER finished row as a duplicate, busy being the one exemption`. This is the L-015 shape: the first mutation proves the guard fires, and only the second proves it fires for the RIGHT value. Restore.
3. Revert `removeBatchDuplicates` to `normalizeAddress(record.address, record.city, record.state)`, run the same file. Expected: RED on `removeBatchDuplicates keys on traceKeyFor`. Restore.

- [ ] **Step 4: The route's tests, first**

Read `app/api/trace/bulk/__tests__/route.test.ts` in full before editing it. The following changes are exhaustive; make all of them.

**Delete** the helper at lines 174-178 and every use of it:

```ts
/** The CSV body handed to Tracerfy, split into data lines. */
const submittedCsvLines = () => {
  const call = vi.mocked(submitBulkTrace).mock.calls[0];
  return call ? String(call[0]).split("\n").slice(1) : [];
};
```

**Delete** the whole `describe("when the Tracerfy person submit fails", ...)` block (its 9 tests: `does NOT mark the job failed while tier 2 rows are queued`, `does not hand back a 500 for a job that is still running and will be billed`, `quotes only the rows that are actually going to run`, `tells the customer which half failed and that it was free`, `writes the tier 1 rows terminal so every accepted record has one`, `corrects the job's records_submitted, which is the match-rate denominator`, `gets BOTH charge statements right in the same breath`, `STILL fails the job when nothing survives the failure`, and the block's `beforeEach` that sets `H.submit`). There is no Tracerfy person submit on this route any more, so there is no half to fail: an enqueue is a database write inside the same handler, and its failure path is the existing `insertHistoryRows` console.error plus the route's own catch. Deleting tests for a deleted mechanism is correct; leaving them passing against a mock nothing calls is the L-009 shape.

**Delete** `H.submit` from the `H` fixture object and from `beforeEach`.

**Rewrite** `describe("a traced row") > it("still goes to Tracerfy and is still linked to the bulk job")` as:

```ts
  it("goes on the TIER 1 QUEUE, not to Tracerfy, and stays linked to the bulk job", async () => {
    await post([rec("Jane Smith")]);
    // THE CHANGEOVER (spec 3.3). Nothing new is sent to the batch endpoint from this surface.
    // Rows already in flight there keep settling through settleBulkJob until none remain; Phase 4
    // deletes the path once they have drained.
    expect(submitBulkTrace).not.toHaveBeenCalled();
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].ai_research_status).toBe("tier1_queued");
    expect(rows[0].status).toBe("processing");
    expect(rows[0].trace_job_id).toBe("job-1");
    // No tracerfy_job_id: it is the column every tier 1 CSV settle path finds its rows by, and a
    // queued row settled there would be billed by the wrong engine.
    expect(rows[0].tracerfy_job_id).toBeUndefined();
  });
```

**Rewrite** `describe("the entity-queue column on every row this route writes") > it("is written null rather than left alone")`. It is now true of two buckets and false of the third:

```ts
  it("is written explicitly on every row: the Tier 1 rung, or null", async () => {
    // WRITTEN ON EVERY ROW BECAUSE THE UPSERT ONLY TOUCHES THE KEYS IN THIS PAYLOAD. A row is
    // REUSED rather than re-inserted (UNIQUE(user_id, address_hash)), so omitting the key leaves
    // whatever the row already carried. 273 pre-5c rows carry 'skipped_no_owner' and would be
    // enqueued and billed while summarizeSkips read that stale value and said "you were not
    // charged" on a row that was.
    await post([rec("Jane Smith"), rec(undefined, 2), noKeyRec(3)]);
    const rows = historyRows();
    const byAddress = new Map(rows.map((r) => [r.normalized_address, r]));
    // Tier 1: the rung the Tier 1 lane of the cron claims.
    expect(byAddress.get("1 MAIN ST|DALLAS|TX")!.ai_research_status).toBe("tier1_queued");
    // Tier 2 and no-key: null, because neither belongs to this column's lanes at all.
    expect(byAddress.get("2 MAIN ST|DALLAS|TX")!.ai_research_status).toBeNull();
    expect(byAddress.get("3 MAIN ST||TX")!.ai_research_status).toBeNull();
  });
```

**Rewrite** `describe("a job whose only rows are queued") > it("asks no person vendor, because there is no person to ask about")` to keep its assertion and widen its reason:

```ts
  it("asks no vendor at submit time at all, on either tier", async () => {
    await post([rec(undefined), rec("Jane Smith", 2)]);
    // Both tiers are queued now. A submit writes rows and returns; every vendor call belongs to a
    // cron, which is what keeps this handler inside its 60 second maxDuration on 500 records.
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });
```

**Add** a new describe block:

```ts
/* ------------------------------------------------------------------ *
 * PHASE 2A: THE TIER 1 ENQUEUE.
 * ------------------------------------------------------------------ */

describe("a row with an owner name", () => {
  it("is ENQUEUED on the Tier 1 rung the cron claims", async () => {
    await post([rec("Jane Smith")]);
    const rows = historyRows();
    expect(rows[0].ai_research_status).toBe("tier1_queued");
    // The rung has to be attempt 1 of the TIER 1 ladder specifically. A bare 'queued' is the
    // legacy entity ladder's attempt 1 and would be claimed by the wrong lane of the same cron.
    expect(rows[0].ai_research_status).not.toBe("queued");
  });

  it("is accepted and queued when it has NO CITY, which is the whole point of this phase", async () => {
    // Spec 3.1: "The page stops dropping city-less rows so the user sees why each one did or did
    // not trace." A company owner with no city traces on name and state alone (D4); a person owner
    // with no city and no parcel id ends no_lookup_key, free, with a sentence. Either way the
    // customer is told, and before this phase the row never left the browser.
    await post([
      { owner_name: "Smith Holdings LLC", address: "1 Main St", city: "", state: "TX", zip: "" },
    ]);
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].ai_research_status).toBe("tier1_queued");
    expect(rows[0].city).toBe("");
    expect(rows[0].normalized_address).toBe("1 MAIN ST||TX");
  });

  it("carries property_trace_status null, so no stale tier 2 value can answer for it", async () => {
    await post([rec("Jane Smith")]);
    expect(historyRows()[0].property_trace_status).toBeNull();
  });

  it("clears the stale Tier 1 answer a reused row was carrying (D33, carried item 5)", async () => {
    // D33 chose "single-trace rows only" for the SENTENCE and recorded the other half as Phase 2
    // code: "the bulk submit paths must clear outcome_code, found_by and trace_steps on a reused
    // row". Without it a row a single trace left saying "You were not charged" answers for the new
    // bulk trace, and Task 5 is about to let a bulk row show its own sentence.
    await post([rec("Jane Smith")]);
    const row = historyRows()[0];
    expect(row.outcome_code).toBeNull();
    expect(row.found_by).toBeNull();
    expect(row.trace_steps).toBeNull();
  });

  it("does NOT clear the step log of a busy row it is resuming (spec 5.2)", async () => {
    // The one exemption, and it is money. A busy row's step log is what stops the resend buying
    // the answers this record already paid for. checkDuplicates lets the row through (it is not a
    // duplicate); this keeps the log for executeRoute to replay.
    vi.mocked(checkDuplicates).mockResolvedValueOnce({
      newRecords: [rec("Jane Smith")],
      duplicates: [],
      cachedResults: [
        {
          address_hash: createAddressHash("1 MAIN ST|DALLAS|TX"),
          outcome_code: "busy_try_again",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof checkDuplicates>>);
    await post([rec("Jane Smith")]);
    const row = historyRows()[0];
    expect(row.outcome_code).toBeUndefined();
    expect(row.found_by).toBeUndefined();
    expect(row.trace_steps).toBeUndefined();
    expect(row.ai_research_status).toBe("tier1_queued");
  });

  it("is counted as submitted work and quoted at the tier 1 rate", async () => {
    const res = await post([rec("Jane Smith"), rec("John Smith", 2)]);
    const body = await res.json();
    expect(body.records_submitted).toBe(2);
    expect(body.estimated_cost).toBeCloseTo(2 * TIER1, 4);
  });
});
```

`checkDuplicates` and `createAddressHash` need importing in that file: `const { checkDuplicates } = await import("@/lib/utils/deduplication");` beside the existing dynamic imports, and `createAddressHash` from `@/lib/utils/address-normalizer` at the top.

Run it: `npx vitest run app/api/trace/bulk/__tests__/route.test.ts`
Expected: the new block fails (the route still builds a CSV) and the rewritten tests fail; nothing else in the file is red for another reason.

- [ ] **Step 5: The route**

In `app/api/trace/bulk/route.ts`:

**(a) Imports.** Replace

```ts
import {
  normalizeAddress,
  createAddressHash,
  usableZip,
  validateAddressInput,
} from '@/lib/utils/address-normalizer';
import { removeBatchDuplicates, checkDuplicates } from '@/lib/utils/deduplication';
import { submitBulkTrace } from '@/lib/tracerfy/client';
```

with

```ts
import {
  createAddressHash,
  traceKeyFor,
  usableZip,
  validateAddressInput,
} from '@/lib/utils/address-normalizer';
import { removeBatchDuplicates, checkDuplicates } from '@/lib/utils/deduplication';
import { TIER1_OUTCOME } from '@/lib/trace/tier1Outcome';
import { tier1QueuedStatusFor } from '@/lib/trace/tier1Queue';
```

**(b) The three-bucket comment.** In the block that begins `// SPLIT THE BATCH IN THREE`, replace the three-line table

```ts
    //   tier 1      owner of record present. Tracerfy person CSV, billed per
    //               SUCCESSFUL trace, free on a miss.
```

with

```ts
    //   tier 1      owner of record present. ENQUEUED into ai_research_status for
    //               app/api/cron/sweep-entity-traces, which runs planRoute() and
    //               executeRoute() per record. Billed per SUCCESSFUL trace, free on a miss.
    //               The Tracerfy person CSV is gone from this surface (spec D1, 3.3): rows
    //               already in flight there keep settling through settleBulkJob, and nothing
    //               new is sent. A row with no CITY reaches this bucket now, because the page
    //               stopped dropping it: a company traces on name and state alone (D4), and a
    //               person with no city and no parcel id ends no_lookup_key, free, with a
    //               sentence that says so.
```

**(c) The busy set and `buildHistoryRow`.** Immediately above `const buildHistoryRow = (record: AddressInput) => {`, add:

```ts
    /**
     * Rows this submit is RESUMING rather than starting: the ones whose stored outcome is
     * busy_try_again (spec 5.2).
     *
     * checkDuplicates lets a busy row through as a new record rather than a duplicate, because
     * its own sentence told the customer to send it again. Its step log is the money: it is what
     * stops executeRoute re-buying the lookups this record already paid for. So the clear below
     * skips these rows, and ONLY these rows.
     *
     * Read off cachedResults, which is every row checkDuplicates found inside the 90-day window
     * for the hashes submitted, not just the ones it treated as duplicates.
     */
    const busyResumeHashes = new Set(
      dedupeResult.cachedResults
        .filter((r) => r.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN)
        .map((r) => r.address_hash)
    );
```

Inside `buildHistoryRow`, replace

```ts
      const normalizedAddress = normalizeAddress(
        record.address || '',
        record.city || '',
        record.state || ''
      );
      return {
        user_id: user.id,
        trace_job_id: job.id,
        address_hash: createAddressHash(normalizedAddress),
```

with

```ts
      // ONE KEY DERIVATION (spec 6.3, D36), the same one the single routes and
      // lib/utils/deduplication.ts use, so a record sent through single and bulk lands on ONE row.
      // On this surface it returns exactly what normalizeAddress returned: the page requires a
      // street and a state, and the web app has no parcel id column (D5).
      const normalizedAddress = traceKeyFor({
        address: record.address || '',
        city: record.city || '',
        state: record.state || '',
        apn: record.apn,
        county: record.county,
      });
      const addressHash = createAddressHash(normalizedAddress);
      return {
        user_id: user.id,
        trace_job_id: job.id,
        address_hash: addressHash,
```

and at the END of the same returned object, after the `source: TRACE_SOURCE.WEB,` line, add:

```ts
        // THE D33 BULK HALF (carried item 5). A row is REUSED, and a bulk upload never used to
        // clear the Tier 1 answer on it, so a sentence written for an earlier trace could answer
        // for this one: "You were not charged" over a row this job is about to charge. D33 chose
        // to gate the sentence on trace_job_id instead and recorded this half as Phase 2 code.
        // lib/trace/rowSkipReason.ts stops gating a Tier 1 QUEUE row in Task 5, and this is what
        // makes that safe.
        //
        // NOT on a busy resume: that row's step log is what spares the resend from buying its
        // answered lookups again, and the resume is keyed on finding outcome_code busy_try_again.
        //
        // COST, ACCEPTED, AND IT IS D33'S OWN TRADE: a row that already holds PAID contacts from
        // an earlier single trace loses its `found_by` label here while keeping the contacts, the
        // charge and the counts (D39 protects those inside the settle). The History column reads
        // blank until this trace writes its own. Blank, never wrong (CLAUDE.md rule 7).
        ...(busyResumeHashes.has(addressHash)
          ? {}
          : { outcome_code: null, found_by: null, trace_steps: null }),
```

**(d) Enqueue the Tier 1 rows.** Directly after the `if (tier2Records.length > 0) { ... }` block, add:

```ts
    // TIER 1 ROWS, ONTO THE TIER 1 QUEUE (spec 3.2, D1). Attempt 1 of the Tier 1 ladder, which is
    // the rung app/api/cron/sweep-entity-traces claims in its Tier 1 lane. `tier1_queued`, never a
    // bare 'queued': that value is the LEGACY entity ladder's attempt 1 on the same column, and a
    // row wearing it is handed to FastAppend on its owner name with no route planned at all.
    //
    // `status: 'processing'` because the row genuinely is in flight, and because that is what the
    // wallet reserve prices (lib/trace/bulkPreflight.ts). No tracerfy_job_id: it is the column
    // every CSV settle path finds its rows by, and a queued row settled there would be billed by
    // the wrong engine at the wrong moment.
    if (tier1Records.length > 0) {
      await insertHistoryRows(
        tier1Records.map((r) => ({
          ...buildHistoryRow(r),
          ai_research_status: tier1QueuedStatusFor(1),
          status: 'processing' as const,
        }))
      );
    }
```

**(e) Delete the CSV and the submit.** Delete everything from the comment `// Build the Tracerfy person CSV from the TIER 1 records only.` through the end of the `if (!submitResult.success || !submitResult.jobId) { ... }` block, plus the `// Update job with Tracerfy job ID` update and the final `insertHistoryRows(tier1Records.map(...))` call that followed it. That is the `esc` helper, `csvLines`, the loop that splits `owner_name` on a space, `csvContent`, `submitBulkTrace`, the whole half-failure branch, the `trace_jobs.tracerfy_job_id` update and the old Tier 1 insert.

**(f) The two early returns and the final return.** Keep the `if (tier1Records.length === 0 && tier2Records.length === 0)` block exactly as it is (a job with only no-key rows is finished at submit and is closed here). Replace the `if (tier1Records.length === 0) { ... }` block and everything after it, up to the `} catch (error) {`, with one return:

```ts
    // EVERY ACCEPTED ROW IS NOW QUEUED, on one of the two columns, so this handler is done the
    // moment the rows are written. The job stays 'processing' and app/api/trace/bulk/status
    // finishes it when both queues have drained; closing it here would stop the page polling
    // before results the customer is billed for ever arrive.
    return NextResponse.json({
      success: true,
      job_id: job.id,
      total_records: records.length,
      dedupe_removed: totalDeduped,
      records_submitted: tier1Records.length + tier2Records.length,
      // BOTH TIERS ARE QUEUED NOW. This field used to mean the tier 2 half alone. Nothing renders
      // it (app/(dashboard)/trace/bulk/page.tsx reads records_submitted, records_skipped and
      // records_failed); it stays because the route tests assert it and it is the honest count of
      // rows a cron still owes work on.
      records_queued: tier1Records.length + tier2Records.length,
      // Always 0 on this surface now. It counted rows accepted and then never sent because the
      // Tracerfy person submit failed, and there is no such submit any more. Kept at 0 rather than
      // removed so the page's "Records We Could Not Send" tile keeps reading a number it
      // understands instead of undefined.
      records_failed: 0,
      ...noKeyFields,
      cached_count: dedupeResult.cachedResults.length,
      estimated_cost: estimatedCost,
      message:
        noKeyRecords.length > 0
          ? `${noKeyRecords.length} records could not be looked up. ${PROPERTY_TRACE_NO_KEY_REASON}`
          : undefined,
    });
```

Run it: `npx vitest run app/api/trace/bulk/__tests__/route.test.ts`
Expected: every test in the file passes, including the new block.

- [ ] **Step 6: MUTATIONS on the route**

Four, each with its named test:

1. Change `ai_research_status: tier1QueuedStatusFor(1)` to `ai_research_status: 'queued'`. Run `npx vitest run app/api/trace/bulk/__tests__/route.test.ts`. Expected: RED on `is ENQUEUED on the Tier 1 rung the cron claims`. This is the one-row-two-lanes mutation at the call site rather than in the ladder. Restore.
2. Delete the `...(busyResumeHashes.has(addressHash) ? {} : { outcome_code: null, found_by: null, trace_steps: null })` spread. Expected: RED on `clears the stale Tier 1 answer a reused row was carrying`. Restore.
3. Change that spread to the unconditional `{ outcome_code: null, found_by: null, trace_steps: null }`. Expected: RED on `does NOT clear the step log of a busy row it is resuming`. This is the money half: without it every busy resend re-buys its answered lookups. Restore.
4. Change `traceKeyFor({...})` back to `normalizeAddress(record.address || '', record.city || '', record.state || '')`. Expected: GREEN, and that is the honest result, because the two agree on every record this surface can send. **Record it as an EQUIVALENT MUTANT with that evidence** (lesson L-018: an equivalent mutant is reported as equivalent, never counted as a kill and never "fixed" by manufacturing a test that casts its way into an impossible state). The divergence is fenced where it is real, in `lib/utils/__tests__/deduplication.test.ts`, by `removeBatchDuplicates keys on traceKeyFor` and the parcel case of `is traceKeyFor, so one record cannot land on two rows through two doors`.

- [ ] **Step 7: The page stops dropping city-less rows, test first**

`app/(dashboard)/trace/bulk/__tests__/page.test.ts` asserts at the SOURCE and its header says exactly why: everything interesting on this page lives in the `processing` and `complete` phases of a `useState` machine that starts at `upload`, there is no jsdom and no testing-library in this project, and a static render cannot reach them. It calls itself a WIRING guard and says plainly that it cannot see a CONDITION change.

**So this step follows that file's own pattern rather than fighting it, and says what that costs.** The condition is asserted as text, in the file whose header explains why text is what it has. The BEHAVIOUR that matters, the route accepting and queueing a city-less row, is fenced for real by Step 4's `is accepted and queued when it has NO CITY, which is the whole point of this phase`, which drives the real handler. Do not add an export of `mapRows` for a node test: importing this module executes `@/lib/supabase/client`, `papaparse` and `xlsx` at module scope, and buying one text assertion with that risk is the wrong trade.

Add to `app/(dashboard)/trace/bulk/__tests__/page.test.ts`:

```ts
describe('which rows leave the browser at all', () => {
  it('no longer drops a row for having no city', () => {
    // Spec 3.1. Until Phase 2A this row was dropped here, before anything was posted: a 520-row
    // county export with 30 city-less rows submitted 490 records and said nothing about the other
    // 30. A company owner with no city traces on name and state alone (D4), and a person owner with
    // no city ends no_lookup_key, free, with a sentence. Dropping it is the one outcome that tells
    // the customer nothing at all.
    //
    // A TEXT ASSERTION, and the file header says why this file only has those. The behaviour is
    // fenced in app/api/trace/bulk/__tests__/route.test.ts, which drives the real handler.
    expect(SOURCE).toContain('if (!address || !state) continue;');
    expect(SOURCE).not.toContain('if (!address || !city || !state) continue;');
  });

  it('still drops a row with no street and a row with no state', () => {
    // Neither vendor can be asked about a record with no state. And a record with no street keys on
    // `||STATE` (spec 6.3 rule 3), so thirty street-less rows in one state would collapse onto ONE
    // trace_history row: the customer gets one result back out of thirty while records_submitted
    // says thirty. Spec 6.3 records that collision rather than solving it, so the page keeps it out
    // of reach.
    expect(SOURCE).toContain('!address');
    expect(SOURCE).toContain('!state');
  });
});
```

and correct the stale explanation inside the existing `it('does not tell a customer their job is over the limit when it may not be')`: the line `// number: mapRows drops any row missing an address, city or state before the` becomes `// number: mapRows drops any row missing an address or a state before the`, and the next line's `520-row export with 30 unusable rows` keeps its arithmetic but its example changes from a city to a missing street, because a city-less row is no longer dropped. Its two `PROSE` assertions are unchanged.

Run it and watch the first test fail.

- [ ] **Step 8: The page**

In `app/(dashboard)/trace/bulk/page.tsx`, inside `mapRows`, replace

```ts
    if (!address || !city || !state) continue;
```

with

```ts
    // A CITY IS NO LONGER REQUIRED (spec 3.1, Phase 2A). This line used to drop the row here, in
    // the browser, before anything was posted, which is the one outcome that tells the customer
    // nothing: a company owner with no city traces on name and state alone (D4), and a person
    // owner with no city and no parcel id comes back no_lookup_key, free, with a sentence naming
    // what is missing. The submit route splits on the owner name and does not validate per record,
    // so the row reaches the right bucket on its own.
    //
    // A STREET AND A STATE ARE STILL REQUIRED, and they are not the same case. No state means no
    // vendor can be asked at all. No street means the row keys on `||STATE` (spec 6.3 rule 3), so
    // every street-less row in one state collapses onto ONE trace_history row: the customer would
    // get one result back out of thirty while records_submitted said thirty. Spec 6.3 records that
    // collision rather than solving it, so this keeps it out of reach.
    if (!address || !state) continue;
```

In the `MAX_RECORDS` docblock, replace the paragraph

```
 * The real gap is INVALID rows. mapRows() below drops any row missing an
 * address, city or state before the page posts anything, so a 520-row county
 * export carrying 30 rows with no city is a legitimate 490-record job that this
 * refuses. mapRows only ever drops rows, never adds them, so the parsed count is
 * always at least the submitted count and this can never under-refuse.
```

with

```
 * The real gap is INVALID rows, and Phase 2A made it NARROWER rather than closing it. mapRows()
 * below drops any row missing an address or a state before the page posts anything. It used to
 * drop rows with no CITY too, which is where the 30-rows-of-a-520-row-file example came from; a
 * city-less row is now accepted and traced or explained (spec 3.1). What is left is a row with no
 * street or no state, which is rarer. mapRows only ever drops rows, never adds them, so the parsed
 * count is always at least the submitted count and this can never under-refuse.
```

Run it: `npx vitest run "app/(dashboard)/trace/bulk/__tests__/page.test.ts"`
Expected: both new tests pass, and every existing test in that file still passes (including the cap tests, which read `MAX_RECORDS` out of the source of all three submit routes).

**MUTATION:** restore `if (!address || !city || !state) continue;` and watch `no longer drops a row for having no city` go RED. Restore.

- [ ] **Step 9: Gates, History, commit**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
npx next build 2>&1 | tail -12
grep -n "submitBulkTrace" app/api/trace/bulk/route.ts
```

Expected: 0 failed (the net count moves: this task adds tests and deletes the 9 obsolete submit-failure tests, so the total may be near the baseline; what matters is 0 failed and every other file's count unchanged); `tsc exit 0`; eslint at most 46; the build compiles; the grep prints nothing.

Tick Task 3 in `tasks/todo.md` and add at the top of `History.md`:

```markdown
## <date> (<letter>): Tier 1 Phase 2A, Task 3: the web upload enqueues, and a city-less row runs.

- app/api/trace/bulk/route.ts no longer builds a Tracerfy person CSV. Every owned row is written
  ai_research_status 'tier1_queued', status 'processing', no tracerfy_job_id, for the Tier 1 lane
  of the cron. The half-failure branch is gone with the submit that could fail.
- The bulk page stops dropping rows with no city (spec 3.1). A street and a state are still
  required: a street-less row keys on ||STATE and thirty of them in one state would collapse onto
  one row.
- lib/utils/deduplication.ts keys on traceKeyFor, the derivation the single routes use (D36), and
  exempts a busy_try_again row from the duplicate check (spec 5.2) so the sentence that tells the
  customer to send it again is true. Its step log is kept on a resume, which is what stops the
  resend buying answers this record already paid for.
- The bulk submit clears outcome_code, found_by and trace_steps on every reused row except a busy
  resume, which is D33's recorded Phase 2 half.
- NOTE FOR ANYONE READING THIS MID-PHASE: the queue has no worker until Task 8. This branch is not
  to be deployed until then.
```

```bash
git add app/api/trace/bulk/route.ts app/api/trace/bulk/__tests__/route.test.ts lib/utils/deduplication.ts lib/utils/__tests__/deduplication.test.ts "app/(dashboard)/trace/bulk/page.tsx" "app/(dashboard)/trace/bulk/__tests__/page.test.ts" tasks/todo.md History.md
git status --short
git commit -m "$(cat <<'EOF'
feat(bulk): the web upload enqueues Tier 1 and a city-less row is no longer dropped

Tier 1 Phase 2A, Task 3. No Tracerfy person CSV from this surface; traceKeyFor as the one
duplicate key; the busy_try_again resend exemption; D33's clear-on-reuse.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

`git status --short` before the commit should show only the files in the `git add` list plus the pre-existing untracked `tasks/research-scripts/phase0/select_samples.py`. Anything else is a file this task changed without meaning to: look at it before committing.

---
### Task 4: The four seams a queued Tier 1 row touches (spec 6.2, D33; research Sections 3 and 6)

A Tier 1 bulk row is a new shape on the `ai_research_status` column, and four pieces of live code ask questions about rows that they now answer wrongly. Each is a defect Task 3 introduced, so each is closed here, before the cron makes the rows real.

| Seam | What it answers wrongly now | Consequence |
|---|---|---|
| `app/api/trace/bulk/status` job completion | A web job's rows are all queued and its `tracerfy_job_id` is NULL, so the `!traceJob.tracerfy_job_id` branch finalizes it on the first poll | The job is marked completed seconds after submit, its early-return makes that permanent, and the customer's CSV is short by every row they are about to be billed for |
| the same route's `records_matched` | `finalize` counts only rows carrying a `property_trace_status` | Every Tier 1 bulk match reads as 0 matched |
| `app/api/cron/sweep-stale-traces` stage 2 | It guards only on the tier 2 queue, and a web job now has `tier2Rows.length === 0` | After 60 minutes it writes the job `failed` with `error_message: 'No Tracerfy job ID'` while the Tier 1 rows are still draining |
| `liveWork` in both single routes, and `inFlightUnbilledCost` | Neither knows the Tier 1 rungs | A single trace deletes or reuses a row the cron is about to claim; and a queued row stops reserving wallet after 60 minutes although the cron will still bill it |

**Files:**
- Modify: `app/api/trace/bulk/status/route.ts`
- Modify: `app/api/trace/bulk/status/__tests__/route.test.ts`
- Modify: `app/api/cron/sweep-stale-traces/route.ts`
- Modify: `app/api/cron/sweep-stale-traces/__tests__/route.test.ts`
- Modify: `app/api/trace/single/route.ts`, `app/api/v1/trace/single/route.ts`
- Modify: `app/api/trace/single/__tests__/route.test.ts`, `app/api/v1/trace/single/__tests__/route.test.ts`
- Modify: `lib/trace/bulkPreflight.ts`, `lib/trace/__tests__/bulkPreflight.test.ts`
- Modify: `app/(dashboard)/trace/bulk/page.tsx` (the progress line)
- Modify: `History.md`, `tasks/todo.md`

**Interfaces:**
- Consumes: `isTier1QueuePending`, `isTier1QueueRow`, `TIER1_PENDING_STATUSES` (Task 2).
- Produces: `GET /api/trace/bulk/status` returns `records_pending` and `records_submitted` on every processing response; `inFlightUnbilledCost` reserves the Tier 1 rate for a queued Tier 1 row with no age bound.

- [ ] **Step 1: The status route, tests first**

Add to `app/api/trace/bulk/status/__tests__/route.test.ts` (reuse the file's own `projectRow` stub and row seeding helpers; read it first):

```ts
describe('a job whose Tier 1 rows are on the queue', () => {
  it('stays PROCESSING while a Tier 1 row is still queued', async () => {
    // A web job has no tracerfy_job_id at all now, so it lands in the branch that used to mean
    // "the submit had nothing to send". Finalizing it there marks the job completed within seconds
    // of submit, and the early return at the top of this handler makes that permanent: the job is
    // never polled again and the customer's CSV is short by every row they are about to be billed
    // for.
    seedJob({ id: 'job-1', status: 'processing', tracerfy_job_id: null });
    seedRows([
      { trace_job_id: 'job-1', ai_research_status: 'tier1_queued', status: 'processing', charge: 0 },
    ]);
    const body = await get('job-1');
    expect(body.status).toBe('processing');
    expect(body.records_pending).toBe(1);
  });

  it('stays PROCESSING while a Tier 1 row is CLAIMED, not only while it waits', async () => {
    seedJob({ id: 'job-1', status: 'processing', tracerfy_job_id: null });
    seedRows([
      {
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_processing_3',
        status: 'processing',
        charge: 0,
      },
    ]);
    expect((await get('job-1')).status).toBe('processing');
  });

  it('completes once every Tier 1 row is terminal, and COUNTS its matches', async () => {
    seedJob({ id: 'job-1', status: 'processing', tracerfy_job_id: null });
    seedRows([
      {
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        status: 'success',
        is_successful: true,
        charge: 0.15,
      },
      {
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        status: 'no_match',
        is_successful: false,
        outcome_code: 'no_match',
        charge: 0,
      },
    ]);
    const body = await get('job-1');
    expect(body.status).toBe('completed');
    // The count used to require property_trace_status, so every Tier 1 bulk match read as 0.
    expect(body.records_matched).toBe(1);
    expect(body.total_charge).toBeCloseTo(0.15, 4);
  });

  it('counts a tier 2 match and a Tier 1 match once each, never twice', async () => {
    // The three arms of the count are disjoint by construction: the submit writes null into
    // whichever queue column the row is not on, and the legacy CSV half carries neither column.
    seedJob({ id: 'job-1', status: 'processing', tracerfy_job_id: null });
    seedRows([
      {
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        property_trace_status: null,
        status: 'success',
        is_successful: true,
        charge: 0.15,
      },
      {
        trace_job_id: 'job-1',
        ai_research_status: null,
        property_trace_status: 'property_trace_done',
        status: 'success',
        is_successful: true,
        charge: 0.25,
      },
    ]);
    expect((await get('job-1')).records_matched).toBe(2);
  });

  it('reports how many records are still pending, so the page can show progress', async () => {
    seedJob({ id: 'job-1', status: 'processing', tracerfy_job_id: null, records_submitted: 3 });
    seedRows([
      { trace_job_id: 'job-1', ai_research_status: 'tier1_queued', status: 'processing', charge: 0 },
      { trace_job_id: 'job-1', ai_research_status: 'tier1_processing', status: 'processing', charge: 0 },
      {
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        status: 'success',
        is_successful: true,
        charge: 0.15,
      },
    ]);
    const body = await get('job-1');
    expect(body.status).toBe('processing');
    expect(body.records_pending).toBe(2);
    expect(body.records_submitted).toBe(3);
  });
});
```

Run it and watch the first, second, third and fifth fail (the fourth may pass by accident on the tier 2 arm alone; it still has to be there, because it is the double-counting fence).

- [ ] **Step 2: The status route**

In `app/api/trace/bulk/status/route.ts`:

**(a)** Add to the imports:

```ts
import { isTier1QueuePending, isTier1QueueRow } from '@/lib/trace/tier1Queue';
```

**(b)** Under the `JobRow` type, add one predicate both the gate and the counters read:

```ts
/**
 * Does this row still owe a cron some work?
 *
 * TWO QUEUES, ONE QUESTION. `property_trace_status` is the tier 2 queue and `ai_research_status`
 * now also carries the TIER 1 queue for rows the web upload wrote (spec 3.2). A row is on exactly
 * one of them: every submit path writes null into the other, for the reason
 * app/api/trace/bulk/route.ts spells out at length. Asking about one column and not the other is
 * how a job gets finalized over live, billable work, and the early return at the top of this
 * handler then makes that permanent.
 */
const stillWorking = (row: JobRow): boolean =>
  isPropertyTracePending(row.property_trace_status) || isTier1QueuePending(row.ai_research_status);
```

**(c)** Widen BOTH selects. The already-completed branch:

```ts
      const { data: doneRows } = await adminClient
        .from('trace_history')
        .select(
          'charge, is_successful, trace_job_id, ai_research_status, property_trace_status, outcome_code, trace_steps, normalized_address, city, state, parcel_id_local, county'
        )
        .eq('user_id', user.id)
        .eq('trace_job_id', traceJob.id);
```

and `readJobRows`:

```ts
    const readJobRows = async (): Promise<JobRow[]> => {
      const { data } = await adminClient
        .from('trace_history')
        .select(
          'charge, is_successful, trace_job_id, ai_research_status, property_trace_status, outcome_code, trace_steps, normalized_address, city, state, parcel_id_local, county'
        )
        .eq('user_id', user.id)
        .eq('trace_job_id', traceJob.id);
      return (data || []) as JobRow[];
    };
```

Both lists are what `rowSkipReason` reads, so `summarizeSkips` can serve a Tier 1 bulk row's own sentence once Task 5 unblocks it. A column missing from either select is a reason the customer never sees no matter how right `summarizeSkips` is, which is the defect the comment above the first select already records for `property_trace_status`.

Change the `rows` cast under the first select to match:

```ts
      const rows = (doneRows || []) as JobRow[];
```

**(d)** `finalize` gains the Tier 1 arm:

```ts
    const finalize = async (rows: JobRow[], tier1Matched: number) => {
      // THREE DISJOINT ARMS, and the disjointness is what stops a row counting twice.
      //   tier1Matched          the legacy Tracerfy CSV half, counted from the vendor's own
      //                         results by the loop below. Those rows carry NEITHER queue column.
      //   property_trace_status the tier 2 queue.
      //   ai_research_status    the TIER 1 queue (spec 3.2). Without this arm every Tier 1 bulk
      //                         match read as 0 matched, on the job summary and in the webhook.
      const recordsMatched =
        tier1Matched +
        rows.filter((r) => r.property_trace_status && r.is_successful).length +
        rows.filter((r) => isTier1QueueRow(r.ai_research_status) && r.is_successful).length;
```

The rest of `finalize` is unchanged.

**(e)** The `!traceJob.tracerfy_job_id` branch. Replace

```ts
    if (!traceJob.tracerfy_job_id) {
      const rows = await readJobRows();
      if (rows.some((r) => isPropertyTracePending(r.property_trace_status))) {
        return NextResponse.json({
          success: true,
          status: 'processing',
          job_id: traceJob.id,
          records_pending_property_trace: rows.filter((r) =>
            isPropertyTracePending(r.property_trace_status)
          ).length,
        });
      }
```

with

```ts
    // A JOB WITH NO TRACERFY JOB ID IS THE NORMAL SHAPE OF A WEB JOB NOW. Before Phase 2A it meant
    // either an empty submit or an all-tier-2 job; since the web upload enqueues its Tier 1 rows
    // too (spec 3.2), no web job ever gets a tracerfy_job_id again. The gate below is what stops
    // this handler finalizing such a job seconds after submit.
    if (!traceJob.tracerfy_job_id) {
      const rows = await readJobRows();
      const pending = rows.filter(stillWorking).length;
      if (pending > 0) {
        return NextResponse.json({
          success: true,
          status: 'processing',
          job_id: traceJob.id,
          records_submitted: traceJob.records_submitted,
          // Both queues, one number, so the page can show progress on a mixed job.
          records_pending: pending,
          // Kept for any consumer already reading it.
          records_pending_property_trace: rows.filter((r) =>
            isPropertyTracePending(r.property_trace_status)
          ).length,
        });
      }
```

**(f)** The stall branch. Replace

```ts
      const stallRows = await readJobRows();
      const stillQueued = stallRows.filter((r) =>
        isPropertyTracePending(r.property_trace_status)
      ).length;
```

with

```ts
      const stallRows = await readJobRows();
      // Both queues. A stalled Tracerfy batch says nothing about either cron, which run on their
      // own clocks against their own vendors. The Tier 1 arm is defensive today: no web job can
      // carry a tracerfy_job_id and Tier 1 queue rows at the same time, because the surface that
      // enqueues Tier 1 no longer submits a CSV. It is here so 2B cannot make it reachable
      // without anyone noticing.
      const stillQueued = stallRows.filter(stillWorking).length;
```

and in the `records_pending_property_trace: stillQueued` response below it, rename the field to `records_pending: stillQueued` and keep a second `records_pending_property_trace: stallRows.filter((r) => isPropertyTracePending(r.property_trace_status)).length`.

**(g)** The mixed-job completion gate. Replace

```ts
    const jobRows = await readJobRows();
    if (jobRows.some((r) => isPropertyTracePending(r.property_trace_status))) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_pending_property_trace: jobRows.filter((r) =>
          isPropertyTracePending(r.property_trace_status)
        ).length,
        age_minutes: Math.round(jobAgeMinutes),
      });
    }
```

with

```ts
    const jobRows = await readJobRows();
    if (jobRows.some(stillWorking)) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_pending: jobRows.filter(stillWorking).length,
        records_pending_property_trace: jobRows.filter((r) =>
          isPropertyTracePending(r.property_trace_status)
        ).length,
        age_minutes: Math.round(jobAgeMinutes),
      });
    }
```

Run it: `npx vitest run app/api/trace/bulk/status/__tests__/route.test.ts`
Expected: all five new tests pass; every existing test in the file still passes.

- [ ] **Step 3: MUTATIONS on the status route**

1. Change `stillWorking` to `isPropertyTracePending(row.property_trace_status)` alone. Run the file. Expected: RED on `stays PROCESSING while a Tier 1 row is still queued`, `stays PROCESSING while a Tier 1 row is CLAIMED` and `reports how many records are still pending`. Restore.
2. Delete the `isTier1QueueRow(...)` arm from `finalize`. Expected: RED on `completes once every Tier 1 row is terminal, and COUNTS its matches` and `counts a tier 2 match and a Tier 1 match once each`. Restore.
3. Change the `isTier1QueueRow` arm to `isTier1QueuePending`. Expected: RED on the same two tests, because a settled row is not pending. This is the mutation that proves the WIDER predicate is the right one there. Restore.
4. Drop `outcome_code` from `readJobRows`'s select list. Expected: GREEN today, and that is correct and expected, because Task 5 is what starts reading it. Record it as a gap this task cannot fence and Task 5 must: its own test for the summary sentence is the fence, and Task 5's mutation list repeats this mutation.

- [ ] **Step 4: The page's progress line**

In `app/(dashboard)/trace/bulk/page.tsx`, inside the poll loop, replace

```ts
        if (statusData.status === 'processing') {
          if (statusData.results_so_far && statusData.records_submitted) {
            setPollProgress(`${statusData.results_so_far} of ${statusData.records_submitted} records processed`);
          }
          continue;
        }
```

with

```ts
        if (statusData.status === 'processing') {
          // `results_so_far` was only ever sent by the Tracerfy batch poll, which this surface no
          // longer uses, so the line never appeared for a queued job. `records_pending` comes from
          // both queues, so a 500-record upload now shows movement every 5 seconds instead of a
          // silent spinner for four minutes.
          if (
            typeof statusData.records_pending === 'number' &&
            typeof statusData.records_submitted === 'number'
          ) {
            const done = Math.max(statusData.records_submitted - statusData.records_pending, 0);
            setPollProgress(`${done} of ${statusData.records_submitted} records processed`);
          } else if (statusData.results_so_far && statusData.records_submitted) {
            setPollProgress(`${statusData.results_so_far} of ${statusData.records_submitted} records processed`);
          }
          continue;
        }
```

- [ ] **Step 5: sweep-stale-traces stage 2, test first**

Add to `app/api/cron/sweep-stale-traces/__tests__/route.test.ts`:

```ts
describe('a stale bulk job whose Tier 1 queue rows are still draining', () => {
  it('is left entirely alone, not failed', async () => {
    // Stage 2 guarded on the tier 2 queue alone. A web job now has NO tier 2 rows and no
    // tracerfy_job_id, so at the 60 minute cutoff it fell straight into the
    // 'No Tracerfy job ID' branch and was written FAILED while its Tier 1 rows were still being
    // worked and billed. The status route's early return then makes that verdict permanent.
    seedJob({ id: 'job-1', status: 'processing', tracerfy_job_id: null, created_at: hoursAgo(3) });
    seedRows([
      { trace_job_id: 'job-1', ai_research_status: 'tier1_queued', status: 'processing' },
    ]);
    await runCron();
    expect(jobUpdates('job-1')).toEqual([]);
  });

  it('COMPLETES such a job once the queue has drained, rather than failing it', async () => {
    seedJob({ id: 'job-1', status: 'processing', tracerfy_job_id: null, created_at: hoursAgo(3) });
    seedRows([
      {
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        status: 'success',
        is_successful: true,
      },
      {
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        status: 'no_match',
        is_successful: false,
      },
    ]);
    await runCron();
    const update = jobUpdates('job-1').at(-1);
    expect(update).toMatchObject({ status: 'completed', records_matched: 1 });
    expect(update).not.toMatchObject({ error_message: 'No Tracerfy job ID' });
  });
});
```

Use the file's own seeding and assertion helpers; the names above stand in for whatever it already calls them.

- [ ] **Step 6: sweep-stale-traces stage 2**

In `app/api/cron/sweep-stale-traces/route.ts`, add to the imports:

```ts
import { isTier1QueuePending, isTier1QueueRow } from '@/lib/trace/tier1Queue';
```

Replace

```ts
        const { data: jobRows } = await adminClient
          .from('trace_history')
          .select('property_trace_status, is_successful')
          .eq('user_id', job.user_id)
          .eq('trace_job_id', job.id);
        const rows = (jobRows || []) as Array<{
          property_trace_status: string | null;
          is_successful: boolean | null;
        }>;
        const tier2Rows = rows.filter((r) => r.property_trace_status);

        if (tier2Rows.some((r) => isPropertyTracePending(r.property_trace_status))) {
```

with

```ts
        // BOTH QUEUES, and the second one is new. Since Phase 2A the web upload enqueues its TIER 1
        // rows into ai_research_status, so a web job reaches this cutoff with no tier 2 rows at all
        // and no tracerfy_job_id: it fell into the 'No Tracerfy job ID' branch below and was
        // written FAILED while its rows were still being worked and billed, and the status route's
        // early return made that verdict permanent.
        const { data: jobRows } = await adminClient
          .from('trace_history')
          .select('property_trace_status, ai_research_status, is_successful')
          .eq('user_id', job.user_id)
          .eq('trace_job_id', job.id);
        const rows = (jobRows || []) as Array<{
          property_trace_status: string | null;
          ai_research_status: string | null;
          is_successful: boolean | null;
        }>;
        const tier2Rows = rows.filter((r) => r.property_trace_status);
        const tier1QueueRows = rows.filter((r) => isTier1QueueRow(r.ai_research_status));

        if (
          tier2Rows.some((r) => isPropertyTracePending(r.property_trace_status)) ||
          tier1QueueRows.some((r) => isTier1QueuePending(r.ai_research_status))
        ) {
```

and in the branch below, replace `if (tier2Rows.length > 0) {` with

```ts
          if (tier2Rows.length > 0 || tier1QueueRows.length > 0) {
```

The comment above that branch already explains why such a job is COMPLETED rather than failed; extend its first sentence to `A JOB WITH NO TRACERFY JOB ID USED TO MEAN ONE THING AND NOW MEANS THREE.` and add the third: `And since Phase 2A it is the normal shape of EVERY web job, whose Tier 1 rows are queued on ai_research_status.`

Run it: `npx vitest run app/api/cron/sweep-stale-traces/__tests__/route.test.ts`
Expected: the two new tests pass, every existing test passes.

**MUTATION:** delete the `|| tier1QueueRows.some(...)` clause. Expected: RED on `is left entirely alone, not failed`. Then delete the `|| tier1QueueRows.length > 0` clause. Expected: RED on `COMPLETES such a job once the queue has drained`. Restore both.

- [ ] **Step 7: The two single routes' live-work guard**

In BOTH `app/api/trace/single/route.ts` and `app/api/v1/trace/single/route.ts`, add to the imports beside the existing `isEntityTracePending` import:

```ts
import { isTier1QueuePending } from '@/lib/trace/tier1Queue';
```

and in both files replace

```ts
    const liveWork = Boolean(
      existingRow &&
        (isPropertyTracePending(existingRow.property_trace_status) ||
          isEntityTracePending(existingRow.ai_research_status) ||
          processingIsLive)
    );
```

with

```ts
    const liveWork = Boolean(
      existingRow &&
        (isPropertyTracePending(existingRow.property_trace_status) ||
          isEntityTracePending(existingRow.ai_research_status) ||
          // THE TIER 1 QUEUE, added in Phase 2A. isEntityTracePending answers for the LEGACY
          // values on this column only; a row the web upload queued wears tier1_queued and was
          // invisible here. This route would then have deleted it, or reused it and nulled the
          // queue column out from under the cron mid-claim: the customer's bulk row silently
          // never runs, and runSingleTier1 counts any debit the cron had already booked as THIS
          // request's charge.
          isTier1QueuePending(existingRow.ai_research_status) ||
          processingIsLive)
    );
```

Both files already select `ai_research_status` in the `existingRow` query, so no select changes.

Add to BOTH route test files:

```ts
  it('refuses to touch a row the Tier 1 bulk queue is working', async () => {
    // A single trace of an address whose bulk row is queued must answer busy and write NOTHING:
    // no delete, no reuse, no vendor call, no deduct, no webhook. Anything else races the cron.
    seedExistingRow({
      id: 'row-1',
      ai_research_status: 'tier1_queued',
      status: 'processing',
      created_at: new Date().toISOString(),
    });
    const res = await post({ address: '1 Main St', city: 'Dallas', state: 'TX', owner_name: 'Jane Smith' });
    expect(res.status).toBe(503);
    expect(deletes()).toEqual([]);
    expect(updates()).toEqual([]);
    expect(tracePersonMock).not.toHaveBeenCalled();
    expect(deductWalletMock).not.toHaveBeenCalled();
  });
```

using each file's own helper names. **MUTATION, in BOTH files (L-018: every call site, not one representative):** delete the `isTier1QueuePending(...)` clause and watch each file's new test go RED. Restore.

- [ ] **Step 8: The wallet reserve (spec 6.2), test first**

Add to `lib/trace/__tests__/bulkPreflight.test.ts`:

```ts
describe('inFlightUnbilledCost and the Tier 1 queue (spec 6.2)', () => {
  it('reserves the tier 1 rate for a QUEUED Tier 1 bulk row', async () => {
    // Spec 6.2: "inFlightUnbilledCost counts queued Tier 1 records as well as processing ones, so
    // two batches sent back to back cannot both pass on the same dollars."
    stubRows([
      { status: 'processing', property_trace_status: null, ai_research_status: 'tier1_queued' },
    ]);
    expect(await inFlightUnbilledCost(admin, 'user-1', { tier1: 0.15, tier2: 0.25 })).toBeCloseTo(
      0.15,
      4
    );
  });

  it('keeps reserving for a Tier 1 queue row OLDER than the stale-processing bound', async () => {
    // THE ASYMMETRY IS THE POINT, and it is the tier 2 argument arriving on the tier 1 column. The
    // age bound exists for an ORPHANED single-trace row that nothing will ever resolve. A queued
    // bulk row is not orphaned: the ladder and the stale-claim sweep guarantee it reaches a
    // terminal, so it WILL be billed, and under-reserving certain money is the wrong direction to
    // fail in. Without this arm the row stops reserving after CRON_TIMEOUT_MINUTES and the
    // customer's next submit passes against dollars this one is going to spend.
    stubRows([
      {
        status: 'processing',
        property_trace_status: null,
        ai_research_status: 'tier1_processing_2',
        created_at: hoursAgo(5),
      },
    ]);
    expect(await inFlightUnbilledCost(admin, 'user-1', { tier1: 0.15, tier2: 0.25 })).toBeCloseTo(
      0.15,
      4
    );
  });

  it('prices a Tier 1 queue row ONCE, at the tier 1 rate, never at both rates', async () => {
    // A queued row is ALSO status 'processing', so two ifs instead of an else-if chain would
    // reserve the two rates added together for a row that can only ever cost one of them and 402
    // a wallet that can afford the batch.
    stubRows([
      { status: 'processing', property_trace_status: null, ai_research_status: 'tier1_queued' },
    ]);
    expect(await inFlightUnbilledCost(admin, 'user-1', { tier1: 0.15, tier2: 0.25 })).toBeCloseTo(
      0.15,
      4
    );
  });

  it('reserves the TIER 2 rate when a row is somehow on both columns', async () => {
    // Tier 2 outranks, exactly as rowSkipReason orders the two queues, because tier 2 is certain
    // money: the cron will bill it whatever it finds.
    stubRows([
      {
        status: 'processing',
        property_trace_status: 'queued',
        ai_research_status: 'tier1_queued',
      },
    ]);
    expect(await inFlightUnbilledCost(admin, 'user-1', { tier1: 0.15, tier2: 0.25 })).toBeCloseTo(
      0.25,
      4
    );
  });

  it('reserves nothing for a SETTLED Tier 1 queue row', async () => {
    stubRows([
      { status: 'success', property_trace_status: null, ai_research_status: 'tier1_done' },
    ]);
    expect(await inFlightUnbilledCost(admin, 'user-1', { tier1: 0.15, tier2: 0.25 })).toBe(0);
  });
});
```

- [ ] **Step 9: The wallet reserve**

In `lib/trace/bulkPreflight.ts`, add to the imports:

```ts
import { TIER1_PENDING_STATUSES, isTier1QueuePending } from '@/lib/trace/tier1Queue';
```

Extend the row interface:

```ts
/** Rows this module reads, named so a schema rename fails at compile time. */
interface UnsettledRow {
  status: string | null;
  property_trace_status: string | null;
  ai_research_status: string | null;
}
```

In `inFlightUnbilledCost`, extend the docblock's population table by one line, directly under the `a processing tier 1 row` entry:

```
 *   a queued tier 1 row    the Tier 1 cron WILL work it and MAY bill it, per successful trace.
 *                          Reserved in full and NOT age-bounded, unlike the bare processing row
 *                          above: that bound exists for an ORPHANED single-trace row nothing can
 *                          resolve, and a queued bulk row is not orphaned. Its ladder and the
 *                          cron's stale-claim sweep guarantee it reaches a terminal, so it is the
 *                          same kind of certainty a pending tier 2 row has, and under-reserving
 *                          certain money is the wrong direction to fail in.
```

Replace the query and the loop:

```ts
  const { data, error } = await admin
    .from('trace_history')
    .select('status, property_trace_status, ai_research_status')
    .eq('user_id', userId)
    .or(
      `and(status.eq.processing,created_at.gte.${tier1Cutoff}),property_trace_status.in.(${PROPERTY_TRACE_PENDING_STATUSES.join(',')}),ai_research_status.in.(${TIER1_PENDING_STATUSES.join(',')})`
    );

  if (error) {
    // NOT ZERO. Zero is the claim that this user owes nothing, and making that
    // claim because a query failed is precisely the fabricated result the
    // reserve exists to stop anyone acting on. The route's catch owns this.
    throw new Error(`could not size in-flight work: ${error.message}`);
  }

  let total = 0;
  for (const row of (data || []) as UnsettledRow[]) {
    // ELSE-IF, NOT THREE IFS. A queued row of EITHER tier is also `status: 'processing'`, so
    // counting more than one column would reserve two rates added together for a row that can
    // only ever cost one of them, and 402 a wallet that can afford the batch.
    //
    // TIER 2 FIRST, for the reason lib/trace/rowSkipReason.ts orders the two queues the same way:
    // it is certain money, billed per record submitted whatever the result.
    if (isPropertyTracePending(row.property_trace_status)) total += rates.tier2;
    else if (isTier1QueuePending(row.ai_research_status)) total += rates.tier1;
    else if (row.status === 'processing') total += rates.tier1;
  }
  return total;
```

Run it: `npx vitest run lib/trace/__tests__/bulkPreflight.test.ts app/api/trace/bulk/__tests__/route.test.ts`
Expected: everything passes.

**MUTATIONS:** (1) delete the `isTier1QueuePending` arm; expected RED on `keeps reserving for a Tier 1 queue row OLDER than the stale-processing bound` (the bare-processing arm still catches the young case, which is exactly why the old test would not have found this). (2) Change the chain's three `else if`s to three plain `if`s; expected RED on `prices a Tier 1 queue row ONCE, at the tier 1 rate, never at both rates`. (3) Move the Tier 1 arm above the tier 2 arm; expected RED on `reserves the TIER 2 rate when a row is somehow on both columns`. Restore each.

- [ ] **Step 10: Gates, History, commit**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
```

Expected: 0 failed, more passing than after Task 3; `tsc exit 0`; eslint at most 46.

Tick Task 4 in `tasks/todo.md` and add at the top of `History.md`:

```markdown
## <date> (<letter>): Tier 1 Phase 2A, Task 4: the four seams a queued Tier 1 row touches.

- app/api/trace/bulk/status: job completion and the match count now ask BOTH queue columns. A web
  job has no tracerfy_job_id at all since Task 3, so the branch that used to mean "nothing was
  submitted" was finalizing live jobs seconds after submit, and every Tier 1 bulk match read as 0.
  Both selects widened to the columns rowSkipReason reads.
- The processing responses carry records_pending, and the bulk page turns it into a progress line,
  so a 500-record upload shows movement instead of a silent spinner.
- sweep-stale-traces stage 2 no longer writes a web job failed with "No Tracerfy job ID" while its
  Tier 1 rows are draining; it defers while they are pending and COMPLETES the job when they are
  not.
- Both single routes' live-work guard recognises a Tier 1 queue row, so a single trace cannot
  delete or reuse a row the cron is about to claim. Mutated in both files, not one.
- inFlightUnbilledCost reserves the tier 1 rate for a queued Tier 1 row, with NO age bound: the
  ladder guarantees the row reaches a terminal, so the money is certain (spec 6.2).
```

```bash
git add app/api/trace/bulk/status/route.ts app/api/trace/bulk/status/__tests__/route.test.ts app/api/cron/sweep-stale-traces/route.ts app/api/cron/sweep-stale-traces/__tests__/route.test.ts app/api/trace/single/route.ts app/api/trace/single/__tests__/route.test.ts app/api/v1/trace/single/route.ts app/api/v1/trace/single/__tests__/route.test.ts lib/trace/bulkPreflight.ts lib/trace/__tests__/bulkPreflight.test.ts "app/(dashboard)/trace/bulk/page.tsx" tasks/todo.md History.md
git commit -m "$(cat <<'EOF'
fix(bulk): close the four seams a queued Tier 1 row opened

Tier 1 Phase 2A, Task 4. Job completion, the match count, the stale sweep, the single routes'
live-work guard and the wallet reserve all ask about the Tier 1 queue.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 5: The D33 bulk half, and what David sees: found_by, outcome_code and per-outcome counts (spec 7.1, 7.2, D33, D38)

**Second visible task.** After it, the job summary counts records BY OUTCOME ("...You were not charged. That happened to 3 of them.") and the results CSV carries two new columns at the end of its header.

**Files:**
- Modify: `lib/trace/rowSkipReason.ts`
- Modify: `lib/trace/__tests__/rowSkipReason.test.ts`
- Modify: `lib/trace/exportCsv.ts`
- Modify: `lib/trace/__tests__/exportCsv.test.ts`
- Modify: `lib/trace/__tests__/propertyRecordEgress.test.ts`
- Modify: `app/api/trace/bulk/status/__tests__/route.test.ts` (the summary)
- Modify: `History.md`, `tasks/todo.md`

**Interfaces:**
- Consumes: `isTier1QueueRow` (Task 2), the widened selects (Task 4), `tier1OutcomeReason` (`lib/trace/tier1Outcome.ts:168`), `propertyAddressLabel` (`lib/trace/historyDisplay.ts:55`).
- Produces: `EXPORT_COLUMNS` is 105 columns, ending `found_by`, `outcome_code`; `rowSkipReason` serves a Tier 1 QUEUE row's own sentence.

- [ ] **Step 1: The D33 bulk half, test first**

Add to `lib/trace/__tests__/rowSkipReason.test.ts`:

```ts
describe('a TIER 1 QUEUE row serves its own outcome sentence (the D33 bulk half)', () => {
  it('answers for a settled Tier 1 bulk row, although it carries a trace_job_id', () => {
    // D33 gated the Tier 1 term on `trace_job_id === null` and recorded the other half as Phase 2
    // code: the bulk submit paths must clear outcome_code, found_by and trace_steps on a reused
    // row, and then a bulk row may surface its own. Task 3 did the clearing on the WEB path, so
    // the gate opens for exactly the rows that path writes, which are the rows wearing a tier1_
    // status. No other surface writes one.
    expect(
      rowSkipReason({
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        property_trace_status: null,
        outcome_code: 'no_match',
        is_successful: false,
        normalized_address: '100 MAIN ST|DALLAS|TX',
        city: 'DALLAS',
        state: 'TX',
        trace_steps: [
          { kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss', cost: 0, at: '2026-09-23T00:00:00Z' },
        ],
      })
    ).toBe('We looked this owner up by address and found no match. You were not charged.')
  })

  it('answers for a row whose claims kept dying, at the exhausted terminal', () => {
    expect(
      rowSkipReason({
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_failed',
        property_trace_status: null,
        outcome_code: 'busy_try_again',
        is_successful: false,
        normalized_address: '100 MAIN ST|DALLAS|TX',
        city: 'DALLAS',
        state: 'TX',
        trace_steps: [],
      })
    ).toBe('The system is busy. Try again in 5 minutes. You were not charged.')
  })

  it('leaves an API or MCP bulk row showing EXACTLY what it shows today', () => {
    // The 2B surfaces do NOT clear a reused row's outcome_code (that is 2B's work), so a stale
    // single-trace sentence could otherwise answer for a bulk trace that charged. Those rows carry
    // no tier1_ status, so the gate stays shut for them. This is the scope line of the whole change.
    expect(
      rowSkipReason({
        trace_job_id: 'job-1',
        ai_research_status: null,
        property_trace_status: null,
        outcome_code: 'no_match',
        is_successful: false,
        normalized_address: '100 MAIN ST|DALLAS|TX',
        city: 'DALLAS',
        state: 'TX',
        trace_steps: [
          { kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss', cost: 0, at: '2026-09-23T00:00:00Z' },
        ],
      })
    ).toBeNull()
    // And the legacy entity lane keeps its own wording rather than a Tier 1 sentence.
    expect(
      rowSkipReason({
        trace_job_id: 'job-1',
        ai_research_status: 'entity_trace_failed',
        property_trace_status: null,
        outcome_code: 'no_match',
        is_successful: false,
      })
    ).toBe(ENTITY_TRACE_FAILED_REASON)
  })

  it('still lets a tier 2 terminal status win over a Tier 1 queue value', () => {
    // A row is written onto ONE queue; both values present means the tier 1 one is stale. Answering
    // with it would tell a customer "you were not charged" about a row tier 2 billed per record.
    expect(
      rowSkipReason({
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        property_trace_status: 'property_trace_no_reach',
        outcome_code: 'no_match',
        is_successful: false,
      })
    ).toBe(PROPERTY_TRACE_NO_REACH_REASON)
  })

  it('says nothing about a Tier 1 bulk row that DELIVERED contacts', () => {
    // tier1OutcomeReason returns null whenever is_successful is true, so a found_by_* code can
    // never surface as a "reason". Nothing is invented for a row with nothing to explain.
    expect(
      rowSkipReason({
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        property_trace_status: null,
        outcome_code: 'found_by_address',
        is_successful: true,
      })
    ).toBeNull()
  })
})
```

Import `ENTITY_TRACE_FAILED_REASON` and `PROPERTY_TRACE_NO_REACH_REASON` into that file if they are not there already.

- [ ] **Step 2: The D33 bulk half**

In `lib/trace/rowSkipReason.ts`, add to the imports:

```ts
import { isTier1QueueRow } from '@/lib/trace/tier1Queue';
```

Replace the function and the paragraph of its docblock that describes the gate:

```ts
/**
 * Why this row came back with no contacts, or null when there is nothing to say.
 *
 * Tier 2 first, deliberately (see the header). Then the Tier 1 outcome, for the two row shapes
 * that are allowed to serve it, and the gate is the whole subtlety of this function:
 *
 *   trace_job_id === null                 a row a SINGLE trace itself wrote (spec D33). Such a row
 *                                         clears both queue columns when it settles, so a queue
 *                                         value on it can only be stale.
 *   isTier1QueueRow(ai_research_status)   a row the WEB BULK upload wrote and the Tier 1 cron
 *                                         settled (Phase 2A). D33 chose to gate the sentence
 *                                         rather than clear the stale columns, and recorded the
 *                                         clearing as "(Phase 2 code)". The web submit now clears
 *                                         outcome_code, found_by and trace_steps on every reused
 *                                         row except a busy resume, so on THESE rows the
 *                                         outcome_code can only belong to the trace the customer
 *                                         is looking at.
 *
 * NOTHING ELSE. An API or MCP bulk row carries no tier1_ status, because those two surfaces still
 * build a Tracerfy person CSV and still do not clear a reused row's outcome (2B). They keep
 * showing exactly what they show today, which is what D33 decided and what stops a stale "You were
 * not charged" answering for a bulk trace that charged.
 *
 * `=== null`, not merely falsy, on trace_job_id: a caller that did not select the column gets
 * `undefined`, and that row gets NO Tier 1 sentence either. Blank, never wrong (CLAUDE.md rule 7).
 */
export function rowSkipReason(row: SkipReasonRow): string | null {
  const tier1MaySpeak = row.trace_job_id === null || isTier1QueueRow(row.ai_research_status);
  return (
    propertyTraceSkipReason(row.property_trace_status) ??
    (tier1MaySpeak ? tier1OutcomeReason(row) : null) ??
    skipReasonFor(row.ai_research_status)
  );
}
```

Run it: `npx vitest run lib/trace/__tests__/rowSkipReason.test.ts`
Expected: the five new tests pass, the file's existing 22 tests still pass.

**MUTATIONS:** (1) drop the `|| isTier1QueueRow(...)` clause; expected RED on the first two new tests. (2) Change it to `|| true`; expected RED on `leaves an API or MCP bulk row showing EXACTLY what it shows today`, which is the scope fence. (3) Move the Tier 1 term above `propertyTraceSkipReason`; expected RED on `still lets a tier 2 terminal status win over a Tier 1 queue value`. Restore each.

- [ ] **Step 3: The two CSV columns, test first**

In `lib/trace/__tests__/exportCsv.test.ts` make these exact edits:

1. Line 48, the `cells` docblock: `The 103 rendered cells of one row` becomes `The 105 rendered cells of one row`.
2. Line 212, the comment `the 103 columns now carry vendor-controlled free text` becomes `the 105 columns now carry vendor-controlled free text`.
3. Line 257, the test title `is 103 columns and the first 16 are exactly what they always were` becomes `is 105 columns and the first 16 are exactly what they always were`, and line 258 `expect(EXPORT_COLUMNS).toHaveLength(103)` becomes `toHaveLength(105)`.
4. Line 292, `expect(EXPORT_COLUMNS.slice(38)).toEqual(DOSSIER_EXPORT_COLUMNS)` becomes `expect(EXPORT_COLUMNS.slice(38, 103)).toEqual(DOSSIER_EXPORT_COLUMNS)`. **This is the one edit that is not a number: the dossier block stopped being the tail of the header, so the assertion needs its upper bound or it would demand that the two new columns be dossier columns.**
5. Line 485, `expect(lines[1].split(',')).toHaveLength(103)` becomes `toHaveLength(105)`.
6. Line 655, `expect(parsed.data[1]).toHaveLength(103)` becomes `toHaveLength(105)`.

In `lib/trace/__tests__/propertyRecordEgress.test.ts`, line 240: `expect(header).toHaveLength(103)` becomes `toHaveLength(105)`. Line 239's `expect(header).toEqual([...EXPORT_COLUMNS])` is unchanged and still does the real work.

Then add to `lib/trace/__tests__/exportCsv.test.ts`, inside the existing `describe('the column set', ...)`:

```ts
  it('appends found_by and outcome_code at the very END of the header', () => {
    // THE HEADER IS APPEND-ONLY (this module's own header: "never reorder, never rename"). An
    // importer keyed on column position has to survive this, and the dossier block occupies 39-103,
    // so the only safe place for a new column is after it. Spec 7.2 says so in as many words: "CSV
    // export appends found_by and outcome_code at the END of the header".
    expect(EXPORT_COLUMNS[103]).toBe('found_by');
    expect(EXPORT_COLUMNS[104]).toBe('outcome_code');
    expect(EXPORT_COLUMNS.indexOf('skip_reason')).toBe(20);
    expect(EXPORT_COLUMNS.indexOf('owner_of_record')).toBe(21);
  });
```

and inside the `describe('the base columns', ...)` block:

```ts
  it('exports the KEY that found the owner, never the vendor', () => {
    // spec 7.1: found_by names the key (address, parcel_id, company_name). The vendor stays in
    // contact_vendor, which is internal and has no column here.
    expect(cells(row({ found_by: 'parcel_id', outcome_code: 'found_by_parcel_id' })).found_by).toBe(
      'parcel_id'
    );
    expect(cells(row({ found_by: 'parcel_id' })).outcome_code).toBe('');
    expect(EXPORT_COLUMNS).not.toContain('contact_vendor');
  });

  it('exports the outcome code of a row that found nothing, beside its sentence', () => {
    const c = cells(
      row({
        outcome_code: 'no_match',
        is_successful: false,
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        trace_steps: [
          { kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss', cost: 0, at: '2026-09-23T00:00:00Z' },
        ],
      })
    );
    expect(c.outcome_code).toBe('no_match');
    expect(c.skip_reason).toBe(
      'We looked this owner up by address and found no match. You were not charged.'
    );
    expect(c.found_by).toBe('');
  });

  it('renders both new columns blank on every row written before they existed', () => {
    const c = cells(row());
    expect(c.found_by).toBe('');
    expect(c.outcome_code).toBe('');
  });
```

Run it: `npx vitest run lib/trace/__tests__/exportCsv.test.ts lib/trace/__tests__/propertyRecordEgress.test.ts`
Expected: the column-count assertions fail (the code still has 103) and the three new value tests fail.

- [ ] **Step 4: The two CSV columns**

In `lib/trace/exportCsv.ts`, in `EXPORT_COLUMNS`, replace the final two lines

```ts
  // 39-103. The county dossier, in vendor order, every name prefixed.
  ...DOSSIER_EXPORT_COLUMNS,
];
```

with

```ts
  // 39-103. The county dossier, in vendor order, every name prefixed.
  ...DOSSIER_EXPORT_COLUMNS,
  // 104-105. WHICH KEY FOUND THE OWNER, AND WHAT THE OUTCOME WAS (spec 7.1, 7.2, D10).
  //
  // AT THE VERY END, AFTER THE DOSSIER BLOCK, because this header is append-only and an importer
  // keyed on column position has to survive the change. Putting them beside `skip_reason`, where
  // they belong logically, would shift 84 columns right.
  //
  // `found_by` is the KEY (address, parcel_id, company_name), never the vendor: the vendor lives in
  // contact_vendor, which is internal and deliberately has no column here. `outcome_code` is the
  // machine-readable twin of `skip_reason` at column 21, which carries the sentence.
  //
  // Blank on every row written before 2026-09-22 and on every tier 2 row, because both columns are
  // NULL there. Blank, never a plausible guess (CLAUDE.md rule 7).
  'found_by',
  'outcome_code',
];
```

In `toExportValues`, after the `...DOSSIER_EXPORT_KEYS.map((key) => dossier[key] ?? null),` line and before the closing `];`, add:

```ts
    row.found_by ?? null,
    row.outcome_code ?? null,
```

Run it: `npx vitest run lib/trace/__tests__/exportCsv.test.ts lib/trace/__tests__/propertyRecordEgress.test.ts app/api/trace/bulk/download/__tests__/route.test.ts`
Expected: everything passes. The download routes select `*`, so both columns arrive without a query change (`app/api/trace/bulk/download/route.ts:67` and `:104`).

**MUTATIONS:** (1) swap the order of the two appended columns; expected RED on `appends found_by and outcome_code at the very END of the header` and on `exports the KEY that found the owner`. (2) Delete `row.outcome_code ?? null` from `toExportValues`; expected RED on `exports the outcome code of a row that found nothing` and on the two length assertions in `the file itself` and `the whole file parses`. (3) Insert the two columns before `...DOSSIER_EXPORT_COLUMNS` instead of after; expected RED on `prefixes all 65 dossier columns and keeps vendor order` (the `slice(38, 103)` assertion) and on the append test. Restore each.

- [ ] **Step 5: D38, checked rather than assumed**

`propertyAddressLabel` is already wired into every read path that matters (`lib/trace/exportCsv.ts:347`, `app/api/trace/bulk/status` via the page, `app/api/v1/trace/bulk/status/route.ts:436`, `lib/suite/mcp-tools.ts:104` and `:643`), so D38 needs no new wiring. Add one test to `lib/trace/__tests__/exportCsv.test.ts` that pins the reason the web path cannot produce a parcel key at all, so nobody "fixes" it later:

```ts
  it('never exports the internal parcel key as an address (D38)', () => {
    // A web upload cannot produce an APN| row: the page has no parcel id column (D5) and
    // traceKeyFor only reaches its parcel branch with an apn AND a county. This pins the rendering
    // for the 2B surfaces that CAN, and for any row already stored that way by a single trace.
    expect(
      cells(row({ normalized_address: 'APN|0123-456|TRAVIS|TX', parcel_id_local: '0123-456', county: 'Travis' }))
        .address
    ).toBe('Parcel 0123-456, Travis County');
    expect(
      cells(row({ normalized_address: 'APN|0123-456|TRAVIS|TX' })).address
    ).not.toContain('APN|');
  });
```

- [ ] **Step 6: The bulk page summary, which needs no new component**

`summarizeSkips` (`app/api/trace/bulk/status/route.ts:63`) already groups rows by their `rowSkipReason` sentence and, when a job carries several, renders each one followed by `That happened to N of them.` With Step 2's gate open and Task 4's widened selects, a Tier 1 bulk job's per-outcome counts appear through that existing machinery and `BulkSkipSummary` renders them unchanged. **That is spec 7.2's example** ("the summary counts records by outcome, for example 12 busy, try again in 5 minutes; 3 have no city and no parcel ID") arriving without a new component or a new string, which is why this step adds a test rather than code.

Add to `app/api/trace/bulk/status/__tests__/route.test.ts`:

```ts
describe('the job summary counts Tier 1 bulk rows by outcome', () => {
  it('names each outcome and how many rows it covers', async () => {
    seedJob({ id: 'job-1', status: 'processing', tracerfy_job_id: null, records_submitted: 6 });
    seedRows([
      // Two rows that found nothing by address.
      ...[1, 2].map((n) => ({
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        property_trace_status: null,
        status: 'no_match',
        is_successful: false,
        outcome_code: 'no_match',
        normalized_address: `${n} MAIN ST|DALLAS|TX`,
        city: 'DALLAS',
        state: 'TX',
        charge: 0,
        trace_steps: [
          { kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss', cost: 0, at: '2026-09-23T00:00:00Z' },
        ],
      })),
      // Three rows with no city and no parcel id.
      ...[3, 4, 5].map((n) => ({
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        property_trace_status: null,
        status: 'no_match',
        is_successful: false,
        outcome_code: 'no_lookup_key',
        normalized_address: `${n} MAIN ST||TX`,
        city: '',
        state: 'TX',
        charge: 0,
        trace_steps: [],
      })),
      // One row that delivered, which has nothing to explain and must not be counted.
      {
        trace_job_id: 'job-1',
        ai_research_status: 'tier1_done',
        property_trace_status: null,
        status: 'success',
        is_successful: true,
        outcome_code: 'found_by_address',
        found_by: 'address',
        normalized_address: '6 MAIN ST|DALLAS|TX',
        city: 'DALLAS',
        state: 'TX',
        charge: 0.15,
      },
    ]);

    const body = await get('job-1');
    expect(body.status).toBe('completed');
    expect(body.records_matched).toBe(1);
    // Only rows with a stated reason are counted, which is the rule BulkSkipSummary's own header
    // insists on: the heading scopes itself to the rows we can EXPLAIN.
    expect(body.records_skipped).toBe(5);
    expect(body.skip_reason).toContain(
      'We looked this owner up by address and found no match. You were not charged. That happened to 2 of them.'
    );
    expect(body.skip_reason).toContain(
      'This record is missing the city and the parcel ID, so it could not be looked up. You were not charged. Send it again with the city or the parcel ID. That happened to 3 of them.'
    );
  });
});
```

**MUTATION:** drop `outcome_code` from `readJobRows`'s select list (the gap Task 4's Step 3 recorded as unfenceable there). Expected: RED on this test, because `tier1OutcomeReason` returns null without it. Restore. Then drop `trace_steps`. Expected: RED, because `noMatchReason` names the keys from the step log and returns null when none answered. Restore.

- [ ] **Step 7: Gates, History, commit**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
npx next build 2>&1 | tail -12
```

Expected: 0 failed; `tsc exit 0`; eslint at most 46; the build compiles.

Tick Task 5 in `tasks/todo.md` and add at the top of `History.md`:

```markdown
## <date> (<letter>): Tier 1 Phase 2A, Task 5: a bulk row says why, and the CSV says which key.

- rowSkipReason lets a TIER 1 QUEUE row serve its own outcome sentence. That is D33's recorded
  other half: the web submit now clears a reused row's outcome_code, found_by and trace_steps
  (Task 3), so on those rows the code can only belong to the trace the customer is looking at. API
  and MCP bulk rows carry no tier1_ status and keep showing exactly what they show today.
- The results CSV gains found_by and outcome_code as columns 104 and 105, at the very end of an
  append-only header, after the 65 dossier columns. The dossier-tail assertion gained an upper
  bound; every 103 in the two test files became 105.
- The bulk page's per-outcome counts needed no new component and no new string: summarizeSkips
  already groups by sentence and appends "That happened to N of them", and it reaches the Tier 1
  outcomes now that the gate is open and both selects carry the columns it reads.
```

```bash
git add lib/trace/rowSkipReason.ts lib/trace/__tests__/rowSkipReason.test.ts lib/trace/exportCsv.ts lib/trace/__tests__/exportCsv.test.ts lib/trace/__tests__/propertyRecordEgress.test.ts app/api/trace/bulk/status/__tests__/route.test.ts tasks/todo.md History.md
git commit -m "$(cat <<'EOF'
feat(reporting): a Tier 1 bulk row says why, and the CSV carries found_by and outcome_code

Tier 1 Phase 2A, Task 5. The D33 bulk half, scoped to the web path by the tier1_ status.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The shared vendor rate budget, and the Tier-1-only capacity gap (spec 5.3, Section 13)

Spec 5.3: ONE per-minute budget of 450 Tracerfy calls and 450 FastAppend calls, shared by the Tier 1 and Tier 2 crons, so neither starves the other or trips the vendor's 500. **There is no rate limiter anywhere in runtime code today** (`.superpowers/sdd/phase2-research.md` Section 6: the only hits for a budget-shaped constant are one-off research scripts). Spec Section 13 names this as the phase's own risk: "The shared rate budget is new infrastructure; a bug in it either starves Tier 2 or trips the limit."

**Files:**
- Create: `supabase/migrations/20260923_vendor_rate_budget.sql`
- Create: `lib/trace/vendorRateBudget.ts`
- Create: `lib/trace/__tests__/vendorRateBudget.test.ts`
- Modify: `lib/trace/bulkPreflight.ts`, `lib/trace/__tests__/bulkPreflight.test.ts`
- Modify: `app/api/cron/sweep-property-traces/route.ts`, `app/api/cron/sweep-property-traces/__tests__/route.test.ts`
- Modify: `app/api/trace/bulk/route.ts`, `app/api/trace/bulk/__tests__/route.test.ts`
- Modify: `app/api/v1/trace/bulk/route.ts`, `lib/suite/mcp-tools.ts` (ONE argument each)
- Modify: `History.md`, `tasks/todo.md`

**Interfaces:**
- Produces from `lib/trace/vendorRateBudget.ts`: `VENDOR_RATE_LIMIT: { tracerfy: 450; fastappend: 450 }`, `VendorCallReservation = { tracerfy?: number; fastappend?: number }`, `reserveVendorCalls(admin, want): Promise<boolean>`, `pruneVendorRateWindows(admin): Promise<void>`.
- Produces from `lib/trace/bulkPreflight.ts`: `tracerfyCanRun(admin, { tier1, tier2 }): Promise<boolean>` replacing `tracerfyCanRunTier2(admin, n)`; `TRACERFY_TIER1_CREDITS = 5`.

- [ ] **Step 1: Read the table and function ACLs you are about to create, so there is a before**

```bash
supabase db query --linked "select to_regclass('public.vendor_rate_windows') as table_exists, count(*) as fn_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='claim_vendor_rate'"
```

Expected: `table_exists` NULL and `fn_count` 0. If either says otherwise, stop: something else already owns those names.

- [ ] **Step 2: The migration**

Create `supabase/migrations/20260923_vendor_rate_budget.sql`:

```sql
-- ONE shared per-minute vendor call budget for the two crons (spec 5.3).
--
-- WHY IT CANNOT BE A COUNTER IN MEMORY. The Tier 1 lane and the Tier 2 cron are SEPARATE Vercel
-- function invocations on separate instances, both scheduled every minute (vercel.json). A
-- process-local counter would give each of them its own 450 and the vendor its 900, which is the
-- opposite of the guarantee spec 5.3 asks for. Shared state across invocations is the database.
--
-- WHY A RESERVATION AND NOT A POST-HOC COUNT. Tracerfy's limit is 500 lookups a minute across the
-- instant, APN and dossier endpoints (docs :661, :1332), and FastAppend has its own 500
-- (lib/tracerfy/client.ts:566). Counting calls AFTER making them cannot refuse the call that trips
-- the limit. So a worker asks for the calls its planned ladder could make BEFORE it starts, and
-- does not start the record at all if the answer is no.
--
-- WHY 450 AND NOT 500. Spec 5.3: 50 under the limit. That gap absorbs the two places a reservation
-- can under-count: a tier 2 record whose dossier names several owners (D40 puts no cap on how many
-- it tries), and single traces, which run inside a customer request and reserve nothing.
--
-- THROTTLING IS NOT A FAILURE (spec 5.1). A refused reservation releases the row to the rung it was
-- claimed from, spends nothing, tells the customer nothing and does not consume an attempt. It
-- waits for the next minute. Nothing here is on the billing path.
--
-- THE WINDOW IS date_trunc('minute', now()), so every caller in the same wall-clock minute lands on
-- the same row and the row lock serialises them. A window is not swept by a cron: the RPC's callers
-- prune windows older than an hour once per run (pruneVendorRateWindows), which is cheaper than a
-- delete on every one of up to 450 calls a minute.

CREATE TABLE IF NOT EXISTS public.vendor_rate_windows (
  vendor text NOT NULL,
  window_start timestamptz NOT NULL,
  calls_used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (vendor, window_start)
);

-- Data API grants: LEAST PRIVILEGE, and this table has NO browser surface at all.
--
-- CLAUDE.md's template defaults a new table to `GRANT SELECT ... TO authenticated`. This one gets
-- nothing: no page, no route and no client reads it, and the anon key ships in the JS bundle. The
-- brief's ceiling for this phase is "nothing new for anon or authenticated beyond SELECT"; granting
-- neither of them anything stays inside that ceiling rather than spending it.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_rate_windows TO service_role;

-- Required RLS. service_role bypasses it; with no policies and no grants, nobody else can read or
-- write a row through the Data API even if a future grant were added by accident.
ALTER TABLE public.vendor_rate_windows ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.vendor_rate_windows IS
  'Per-minute vendor call budget shared by app/api/cron/sweep-entity-traces (the Tier 1 lane) and app/api/cron/sweep-property-traces (tier 2). One row per vendor per wall-clock minute. Written only through claim_vendor_rate(); see lib/trace/vendorRateBudget.ts and spec 5.3.';

-- Reserve p_calls against this minute's budget for one vendor. TRUE when they are granted.
--
-- ATOMIC BY THE ROW LOCK. ON CONFLICT DO UPDATE takes a row-level lock on the conflicting row, so
-- two workers in the same minute serialise on it and the sum can never overshoot p_limit. The
-- WHERE on the DO UPDATE is what refuses: when it is false no row is updated, RETURNING yields
-- nothing, and v_used stays NULL.
CREATE OR REPLACE FUNCTION public.claim_vendor_rate(
  p_vendor text,
  p_calls integer,
  p_limit integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window timestamptz := date_trunc('minute', now());
  v_used integer;
BEGIN
  -- Nothing asked for is always granted, and costs no round trip inside the transaction.
  IF p_calls IS NULL OR p_calls <= 0 THEN
    RETURN true;
  END IF;
  -- A single ask bigger than the whole budget can never be granted, and must not be inserted as a
  -- fresh window either: the INSERT arm has no WHERE to refuse it.
  IF p_limit IS NULL OR p_limit <= 0 OR p_calls > p_limit THEN
    RETURN false;
  END IF;

  INSERT INTO public.vendor_rate_windows AS w (vendor, window_start, calls_used)
  VALUES (p_vendor, v_window, p_calls)
  ON CONFLICT (vendor, window_start) DO UPDATE
    SET calls_used = w.calls_used + p_calls
    WHERE w.calls_used + p_calls <= p_limit
  RETURNING w.calls_used INTO v_used;

  RETURN v_used IS NOT NULL;
END;
$$;

-- GRANTS, ALL FOUR STATEMENTS, BY NAME.
--
-- REVOKE ... FROM PUBLIC DOES NOT SECURE A NEW FUNCTION ON SUPABASE (CLAUDE.md, learned on
-- 2026-09-17 when a SECURITY DEFINER function that ADDS WALLET BALANCE came back callable by anon
-- despite exactly that revoke). Supabase ships ALTER DEFAULT PRIVILEGES that land EXPLICIT grants
-- to anon and authenticated at CREATE time, and a revoke from PUBLIC does not touch an explicit
-- grant to a named role. Only the crons call this, so only service_role gets it back.
REVOKE ALL ON FUNCTION public.claim_vendor_rate(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_vendor_rate(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_vendor_rate(text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_vendor_rate(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.claim_vendor_rate(text, integer, integer) IS
  'Reserve p_calls of this minute''s budget for p_vendor, all or nothing. TRUE when granted. Called only by the two crons through lib/trace/vendorRateBudget.ts (spec 5.3).';
```

- [ ] **Step 3: Apply it and read BOTH ACLs back**

```bash
cd /Users/davidmonroe/PropTracerPRO
supabase db query --linked --file supabase/migrations/20260923_vendor_rate_budget.sql
supabase db query --linked "select column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name='vendor_rate_windows' order by ordinal_position"
supabase db query --linked "select unnest(relacl)::text from pg_class where oid = 'public.vendor_rate_windows'::regclass"
supabase db query --linked "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.vendor_rate_windows'::regclass"
supabase db query --linked "select p.oid::regprocedure::text as fn, coalesce(array_to_string(p.proacl,' | '),'PUBLIC-DEFAULT') as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='claim_vendor_rate'"
```

Expected: three columns (`vendor` text NO, `window_start` timestamp with time zone NO, `calls_used` integer NO); the table ACL shows `service_role=arwd/...` and **no `anon` and no `authenticated` entry at all**; `relrowsecurity` true; the function ACL shows `service_role=X/...` and **nothing for anon or authenticated**. If the function ACL says `PUBLIC-DEFAULT`, or names anon or authenticated, STOP: that is the 2026-09-17 wallet-RPC shape and the function is callable from the browser. Fix it, re-read, and report what you saw (lesson L-017).

Then prove the arithmetic from the database itself:

```bash
supabase db query --linked "select public.claim_vendor_rate('probe', 400, 450) as first_400, public.claim_vendor_rate('probe', 40, 450) as next_40, public.claim_vendor_rate('probe', 20, 450) as over_by_10, public.claim_vendor_rate('probe', 10, 450) as exactly_450"
supabase db query --linked "select vendor, calls_used from vendor_rate_windows where vendor='probe'"
supabase db query --linked "delete from vendor_rate_windows where vendor='probe'"
```

Expected: `first_400 t`, `next_40 t`, `over_by_10 f`, `exactly_450 t`; then one row reading `probe | 450`; then the probe row is deleted. The refused call must leave `calls_used` at 440, not 460, which is what the third and fourth answers together prove.

- [ ] **Step 4: The module, test first**

Create `lib/trace/__tests__/vendorRateBudget.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  VENDOR_RATE_LIMIT,
  pruneVendorRateWindows,
  reserveVendorCalls,
} from '@/lib/trace/vendorRateBudget'

/** An admin client whose rpc() answers from a script, recording what it was asked. */
function stubAdmin(answers: Array<{ data: boolean | null; error: { message: string } | null }>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  let i = 0
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return answers[i++] ?? { data: null, error: { message: 'no answer scripted' } }
    }),
    from: vi.fn(() => ({
      delete: () => ({ lt: async () => ({ error: null }) }),
    })),
  }
  return { client: client as unknown as SupabaseClient, calls }
}

describe('reserveVendorCalls', () => {
  it('is 450 a minute for each vendor, 50 under the vendor limit (spec 5.3)', () => {
    expect(VENDOR_RATE_LIMIT.tracerfy).toBe(450)
    expect(VENDOR_RATE_LIMIT.fastappend).toBe(450)
  })

  it('asks the RPC once per vendor, with that vendor s own limit', async () => {
    const { client, calls } = stubAdmin([
      { data: true, error: null },
      { data: true, error: null },
    ])
    expect(await reserveVendorCalls(client, { tracerfy: 1, fastappend: 1 })).toBe(true)
    expect(calls).toEqual([
      { fn: 'claim_vendor_rate', args: { p_vendor: 'tracerfy', p_calls: 1, p_limit: 450 } },
      { fn: 'claim_vendor_rate', args: { p_vendor: 'fastappend', p_calls: 1, p_limit: 450 } },
    ])
  })

  it('asks nothing at all when a record plans no call to that vendor', async () => {
    const { client, calls } = stubAdmin([{ data: true, error: null }])
    expect(await reserveVendorCalls(client, { tracerfy: 1, fastappend: 0 })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].args.p_vendor).toBe('tracerfy')
  })

  it('grants nothing when either vendor refuses', async () => {
    const { client } = stubAdmin([
      { data: true, error: null },
      { data: false, error: null },
    ])
    expect(await reserveVendorCalls(client, { tracerfy: 1, fastappend: 1 })).toBe(false)
  })

  it('REFUSES when the RPC errors, rather than assuming capacity', async () => {
    // An unreadable budget is not a budget of plenty. Assuming one invents the answer to the only
    // question this function exists to ask, and the cost of a false refusal is one minute's wait
    // while the cost of a false grant is tripping a limit that is SHARED across every customer.
    const { client } = stubAdmin([{ data: null, error: { message: 'connection reset' } }])
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await reserveVendorCalls(client, { tracerfy: 1 })).toBe(false)
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('grants an empty reservation without touching the database', async () => {
    const { client, calls } = stubAdmin([])
    expect(await reserveVendorCalls(client, {})).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('prunes windows older than an hour, and nothing newer', async () => {
    const { client } = stubAdmin([])
    const from = vi.mocked((client as unknown as { from: ReturnType<typeof vi.fn> }).from)
    await pruneVendorRateWindows(client)
    expect(from).toHaveBeenCalledWith('vendor_rate_windows')
  })
})
```

- [ ] **Step 5: The module**

Create `lib/trace/vendorRateBudget.ts`:

```ts
/**
 * ONE shared per-minute vendor call budget, drawn by BOTH crons (spec 5.3).
 *
 * THE GUARANTEE. Tracerfy allows 500 lookups a minute per account, shared across its instant, APN
 * and dossier endpoints (docs :661, :1332). FastAppend has its own 500 (lib/tracerfy/client.ts:566).
 * The Tier 1 lane of app/api/cron/sweep-entity-traces and app/api/cron/sweep-property-traces are
 * separate function invocations on the same one-minute schedule, so a counter in either process
 * would give each of them a private 450 and the vendor 900. The budget therefore lives in the
 * database, in `vendor_rate_windows`, one row per vendor per wall-clock minute, and every claim
 * goes through the claim_vendor_rate RPC, whose ON CONFLICT DO UPDATE takes the row lock that makes
 * two workers in one minute serialise instead of both reading 440 and both adding 20.
 *
 * 450, NOT 500, because spec 5.3 says 50 under the limit. That gap is what absorbs the callers that
 * cannot reserve accurately: a tier 2 record whose dossier names several owners (D40 caps nothing),
 * and single traces, which run inside a customer's request and reserve nothing at all.
 *
 * A RESERVATION IS THE RECORD'S WORST CASE, not its actual spend. A record that reserves two calls
 * and hits on the first leaves one reserved call unused for that minute. That is the safe
 * direction and it is deliberate: the budget can only ever throttle EARLIER than strictly
 * necessary, never grant more calls than the vendor allows. It is the same reasoning
 * lib/trace/bulkPreflight.ts gives for reserving a tier 1 row in full.
 *
 * THROTTLING IS NOT A FAILURE (spec 5.1). A refused reservation means the record is not started:
 * its row goes back to the rung it was claimed from with its claim cleared, it spends nothing, no
 * attempt is consumed, and the customer is told nothing because nothing happened to their record.
 * It waits for the next minute. NOTHING in this module is on the billing path.
 *
 * NOT A LOCK, AND NOT A REFUND EITHER. There is no hand-back call. A worker that reserves for two
 * vendors and is refused by the second forfeits the first vendor's reservation for that minute: at
 * most a couple of calls, in the conservative direction, and a hand-back could over-credit a
 * minute another worker has already drawn from.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Calls a minute, per vendor. 50 under each vendor's own 500 (spec 5.3).
 *
 * ONE PLACE. A second copy of either number is a second budget, and two budgets over one vendor
 * account is the defect this module exists to prevent.
 */
export const VENDOR_RATE_LIMIT = {
  tracerfy: 450,
  fastappend: 450,
} as const

export type VendorName = keyof typeof VENDOR_RATE_LIMIT

/** How many calls one record could make to each vendor. Absent or 0 asks for nothing. */
export interface VendorCallReservation {
  tracerfy?: number
  fastappend?: number
}

/** How long a window row is kept before pruning. Long enough to debug, short enough to stay small. */
const WINDOW_RETENTION_MS = 60 * 60 * 1000

/**
 * Reserve this record's calls against this minute's budget. TRUE when every vendor granted.
 *
 * All or nothing across vendors, because a record that gets its Tracerfy call and not its
 * FastAppend one would run half a ladder and answer the customer with a miss it never made.
 */
export async function reserveVendorCalls(
  adminClient: SupabaseClient,
  want: VendorCallReservation
): Promise<boolean> {
  // Fixed order, so two workers asking for the same two vendors queue on the same row first and
  // cannot deadlock against each other.
  const vendors: VendorName[] = ['tracerfy', 'fastappend']
  for (const vendor of vendors) {
    const calls = want[vendor] ?? 0
    if (calls <= 0) continue
    const { data, error } = await adminClient.rpc('claim_vendor_rate', {
      p_vendor: vendor,
      p_calls: calls,
      p_limit: VENDOR_RATE_LIMIT[vendor],
    })
    if (error) {
      // AN UNREADABLE BUDGET IS NOT A BUDGET OF PLENTY. Refusing costs one minute of waiting;
      // assuming costs a rate limit that is shared across every customer's jobs. The console is
      // the only operator channel PTP has (lib/suite/alert.ts is one tagged console.error and its
      // own docstring says to wire it to a real channel first).
      console.error(
        `[vendor-rate-budget] refusing ${calls} ${vendor} call(s): could not read the budget (${error.message})`
      )
      return false
    }
    if (data !== true) return false
  }
  return true
}

/**
 * Delete window rows older than an hour.
 *
 * Called ONCE per cron run rather than from reserveVendorCalls, which runs up to 450 times a
 * minute. Two rows a minute is about 2,880 a day, so this is housekeeping, not a hot path.
 */
export async function pruneVendorRateWindows(adminClient: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - WINDOW_RETENTION_MS).toISOString()
  const { error } = await adminClient.from('vendor_rate_windows').delete().lt('window_start', cutoff)
  if (error) {
    // Never fatal: a window that outlives its hour costs a row, not a wrong answer.
    console.error(`[vendor-rate-budget] could not prune old windows: ${error.message}`)
  }
}
```

Run it: `npx vitest run lib/trace/__tests__/vendorRateBudget.test.ts`
Expected: all 7 tests pass.

**MUTATIONS:** (1) change `if (data !== true) return false` to `if (data === false) return false`; expected RED on `REFUSES when the RPC errors` only if the stub returns `data: null` with no error, so add that case if it is missing, then restore. (2) Delete the `if (error) ... return false` block; expected RED on `REFUSES when the RPC errors, rather than assuming capacity`. (3) Change `VENDOR_RATE_LIMIT.tracerfy` to 500; expected RED on `is 450 a minute for each vendor`. (4) Change the loop to `return true` inside the loop after the first grant; expected RED on `grants nothing when either vendor refuses`. Restore each.

- [ ] **Step 6: The Tier 2 cron draws from the budget**

In `app/api/cron/sweep-property-traces/route.ts`:

**(a)** Add to the imports:

```ts
import { pruneVendorRateWindows, reserveVendorCalls } from '@/lib/trace/vendorRateBudget';
```

**(b)** Correct the sizing comment above `MAX_ROWS_PER_RUN`. Replace

```
 * BOTH tier 2 calls draw Tracerfy's SHARED 500/minute instant pool (the dossier
 * endpoint's own header says the counter is shared with Instant Trace, Enhanced
 * Trace, Phone Verification and APN Instant Lookup). Tier 1 bulk posts to the
 * BATCH endpoint, a different bucket, so it does not compete. Two calls per
 * record is therefore a hard ceiling of 250 records/minute for this queue alone.
 *
 * 120 records at concurrency 5 is 240 calls/minute, 48% of the pool, which
 * leaves headroom for single traces running at the same time. sweep-entity-
 * traces also runs every minute and draws the same pool, but its
 * MAX_ROWS_PER_RUN is 5, under 2% of it, so it does not change this arithmetic.
```

with

```
 * BOTH tier 2 calls draw Tracerfy's SHARED 500/minute instant pool (the dossier
 * endpoint's own header says the counter is shared with Instant Trace, Enhanced
 * Trace, Phone Verification and APN Instant Lookup).
 *
 * THE SENTENCE THAT USED TO BE HERE IS NOW FALSE, and it is corrected rather
 * than deleted because it explains the arithmetic below. It said "Tier 1 bulk
 * posts to the BATCH endpoint, a different bucket, so it does not compete."
 * Since Phase 2A the WEB upload's Tier 1 rows are worked per record by
 * sweep-entity-traces through the SAME instant pool (spec 3.2), so they compete
 * directly. API bulk and the MCP tool still post to the batch endpoint, until 2B.
 *
 * 120 records at concurrency 5 is 240 calls/minute. The Tier 1 lane is 120 rows
 * at concurrency 8 and at most ONE Tracerfy call per record on the web path
 * (that surface sends no parcel id, so planRoute can emit one person step, not
 * two), which is at most 120 more. 360 of the 450 shared budget, 80%, with 90
 * left for single traces, which reserve nothing.
 *
 * The budget is what enforces that rather than this comment:
 * lib/trace/vendorRateBudget.ts, spec 5.3. A record the budget cannot cover is
 * released to its own rung, unspent, and waits for the next minute.
```

**(c)** Reserve before the vendor work. Immediately after `processed++;` and before the `try {`, add:

```ts
    // THE SHARED BUDGET (spec 5.3). Reserved BEFORE any vendor call, because counting calls after
    // making them cannot refuse the one that trips the limit.
    //
    // WHAT IS RESERVED. The dossier steps this plan actually carries, plus one contact leg: the
    // typical record. A record whose dossier names several owners can exceed it (D40 caps nothing),
    // and the 50-call gap between this budget and the vendor's own 500 is what absorbs that.
    //
    // THROTTLING IS NOT A FAILURE (spec 5.1). The row goes back to the rung it was claimed FROM,
    // its claim cleared, with NO attempt spent: nothing was asked of a vendor, so there is nothing
    // to give up on. It is the next run's oldest row.
    const reserved = await reserveVendorCalls(adminClient, {
      tracerfy: 2,
      fastappend: 1,
    });
    if (!reserved) {
      await adminClient
        .from('trace_history')
        .update({
          property_trace_status: row.property_trace_status,
          property_trace_claimed_at: null,
        })
        .eq('id', row.id);
      processed--;
      throttled++;
      return;
    }
```

Declare `let throttled = 0;` beside the other counters at the top of `GET`, and add `throttled` to BOTH `NextResponse.json` result objects (the empty-queue one and the full one).

**(d)** Prune once per run. Immediately after `const adminClient = createAdminClient();`, add:

```ts
  // Housekeeping, once per run rather than once per claim: two rows a minute is 2,880 a day.
  await pruneVendorRateWindows(adminClient);
```

Add to `app/api/cron/sweep-property-traces/__tests__/route.test.ts`:

```ts
describe('the shared vendor rate budget (spec 5.3)', () => {
  it('releases a record it cannot reserve back to its OWN rung, unspent', async () => {
    reserveVendorCallsMock.mockResolvedValue(false);
    seedRows([{ id: 'row-1', property_trace_status: 'queued_3', user_id: 'user-1' }]);
    const body = await runCron();
    expect(body.throttled).toBe(1);
    expect(body.processed).toBe(0);
    expect(lookupDossierMock).not.toHaveBeenCalled();
    expect(deductOrZeroMock).not.toHaveBeenCalled();
    // The SAME rung, not the next one: a throttle spends no attempt, because no vendor was asked.
    expect(rowUpdates('row-1').at(-1)).toMatchObject({
      property_trace_status: 'queued_3',
      property_trace_claimed_at: null,
    });
  });

  it('reserves BEFORE the dossier call, never after it', async () => {
    const order: string[] = [];
    reserveVendorCallsMock.mockImplementation(async () => {
      order.push('reserve');
      return true;
    });
    lookupDossierMock.mockImplementation(async () => {
      order.push('dossier');
      return { success: true, hit: false, creditsDeducted: 0, owners: [] };
    });
    seedRows([{ id: 'row-1', property_trace_status: 'queued', user_id: 'user-1' }]);
    await runCron();
    expect(order[0]).toBe('reserve');
  });
});
```

Mock `@/lib/trace/vendorRateBudget` in that file the way it already mocks `@/lib/tracerfy/dossier`, with `reserveVendorCalls` defaulting to `async () => true` so every existing test keeps passing unchanged, and `pruneVendorRateWindows` as `async () => {}`.

**MUTATIONS:** (1) move the reservation below the `executeRoute` call; expected RED on `reserves BEFORE the dossier call, never after it`. (2) Change the release to `property_trace_status: nextAfterFailedAttempt(attempt).status`; expected RED on `releases a record it cannot reserve back to its OWN rung, unspent`. That mutation is the one that would quietly burn a customer's row through five rungs on a busy minute and then write it terminal. Restore both.

- [ ] **Step 7: The Tier-1-only capacity gap (`lib/trace/bulkPreflight.ts:122`)**

`tracerfyCanRunTier2(admin, newRecords)` returns `true` unconditionally when `newRecords <= 0`, so **a 500-record all-Tier-1 batch never reads the Tracerfy balance at all** (the function's own docstring says so). That was harmless while Tier 1 posted to the batch endpoint. It is live the moment the web upload's Tier 1 rows hit Tracerfy per record.

Tests first, in `lib/trace/__tests__/bulkPreflight.test.ts`:

```ts
describe('tracerfyCanRun and a TIER 1 batch', () => {
  it('reads the balance for a tier-1-only batch, which it used to skip entirely', async () => {
    stubAnalytics({ success: true, data: { balance: 100 } });
    stubQueuedCounts({ tier1: 0, tier2: 0 });
    expect(await tracerfyCanRun(admin, { tier1: 500, tier2: 0 })).toBe(false);
    expect(getAnalyticsMock).toHaveBeenCalled();
  });

  it('sizes a tier 1 record at the person lookup it spends', async () => {
    stubAnalytics({ success: true, data: { balance: 50 } });
    stubQueuedCounts({ tier1: 0, tier2: 0 });
    // 10 records x 5 credits = 50, exactly the balance.
    expect(await tracerfyCanRun(admin, { tier1: 10, tier2: 0 })).toBe(true);
    expect(await tracerfyCanRun(admin, { tier1: 11, tier2: 0 })).toBe(false);
  });

  it('adds the two tiers rather than sizing on whichever is larger', async () => {
    stubAnalytics({ success: true, data: { balance: 50 } });
    stubQueuedCounts({ tier1: 0, tier2: 0 });
    // 4 tier 1 (20) + 3 tier 2 (30) = 50.
    expect(await tracerfyCanRun(admin, { tier1: 4, tier2: 3 })).toBe(true);
    expect(await tracerfyCanRun(admin, { tier1: 4, tier2: 4 })).toBe(false);
  });

  it('counts the rows ALREADY queued on both queues, not just the new ones', async () => {
    stubAnalytics({ success: true, data: { balance: 50 } });
    stubQueuedCounts({ tier1: 5, tier2: 2 });
    // queued: 5 x 5 + 2 x 10 = 45. One more tier 1 record is 50; two is 55.
    expect(await tracerfyCanRun(admin, { tier1: 1, tier2: 0 })).toBe(true);
    expect(await tracerfyCanRun(admin, { tier1: 2, tier2: 0 })).toBe(false);
  });

  it('asks nothing when the batch is empty on both tiers', async () => {
    expect(await tracerfyCanRun(admin, { tier1: 0, tier2: 0 })).toBe(true);
    expect(getAnalyticsMock).not.toHaveBeenCalled();
  });

  it('refuses rather than assuming plenty when the balance cannot be read', async () => {
    stubAnalytics({ success: false, error: 'timeout' });
    expect(await tracerfyCanRun(admin, { tier1: 1, tier2: 0 })).toBe(false);
  });
});
```

Then in `lib/trace/bulkPreflight.ts`, add the Tier 1 credit constant beside `TRACERFY_DOSSIER_CREDITS`:

```ts
/**
 * What one TIER 1 record costs the shared Tracerfy pool, in credits.
 *
 * FIVE, which is one person lookup: the instant named lookup and the APN lookup each cost 5 credits
 * on a hit and nothing on a miss (spec 4.2, and the Phase 1 live check measured $0.10 per hit).
 *
 * IT IS NEITHER A FLOOR NOR A CEILING, and saying which it is would be wrong in one direction or
 * the other, so here is the shape instead. An ENTITY record costs this pool NOTHING: its lane is
 * FastAppend, a different vendor with a separate pool. A trust can cost 10, because it may run the
 * instant lookup and then the APN lookup before falling through to FastAppend. A person record on
 * the web upload costs at most 5, because that surface sends no parcel id so only one person step
 * can be planned. At submit time the owner TYPE is known but classifying it here would be a second
 * classifier (spec 4.1 has exactly one, classifyOwnerName, and it lives in planRoute), so this
 * check sizes every tier 1 record at one person lookup.
 *
 * What makes that safe is the same thing that makes TRACERFY_DOSSIER_CREDITS safe: running short
 * mid-job is not a billing event. A vendor we could not ask is our outage, not the customer's miss
 * (L-007), so the record settles free. The per-minute budget in lib/trace/vendorRateBudget.ts is a
 * different guard answering a different question: this one is about the ACCOUNT BALANCE over a
 * whole job, that one is about calls per minute.
 */
export const TRACERFY_TIER1_CREDITS = 5;
```

Replace the whole of `tracerfyCanRunTier2` with:

```ts
/**
 * Can PTP's shared Tracerfy pool cover this batch, on both tiers?
 *
 * RENAMED FROM tracerfyCanRunTier2, AND THE NAME WAS THE BUG. It took a tier 2 record count and
 * short-circuited on `newRecords <= 0`, so a 500-record all-tier-1 batch never read the balance at
 * all. Its own docstring recorded that as deliberate and scoped out, which was true while tier 1
 * posted to the BATCH endpoint, a different bucket. Since Phase 2A the web upload's tier 1 rows are
 * worked per record against this very pool, so the gap is live and both legs are sized here.
 *
 * SIZED AGAINST WHAT IS ALREADY QUEUED, NOT THE RAW BALANCE. The pool is shared across every
 * customer's jobs, so a check that looks only at the balance passes for two jobs that cannot both
 * run: each sees the same credits and neither sees the other. Every rung of both retry ladders
 * counts, claimed rows included, because a row mid-retry still owes the pool its lookup.
 *
 * Returns false rather than throwing on a capacity answer, and throws on OUR failure. See the file
 * header for why those are different.
 */
export async function tracerfyCanRun(
  admin: SupabaseClient,
  records: { tier1: number; tier2: number }
): Promise<boolean> {
  // A batch with nothing in it draws no credits, so there is no question to ask and no reason to
  // spend a vendor round trip asking it.
  if (records.tier1 <= 0 && records.tier2 <= 0) return true;

  const analytics = await getAnalytics();
  const balance = analytics.data?.balance;
  if (!analytics.success || typeof balance !== 'number') {
    // AN UNREADABLE BALANCE IS NOT A BALANCE OF PLENTY. Assuming one here would invent the answer
    // to the only question this check exists to ask, which is the one thing this project is least
    // allowed to do. Refusing costs a customer a retry; assuming costs them a job we take payment
    // for and cannot run.
    console.error(
      `[bulk-preflight] refusing ${records.tier1} tier 1 and ${records.tier2} tier 2 record(s): could not read the Tracerfy balance (${analytics.error || 'no balance in the analytics response'})`
    );
    return false;
  }

  const { count: queuedTier2, error: tier2Error } = await admin
    .from('trace_history')
    .select('id', { count: 'exact', head: true })
    .in('property_trace_status', PROPERTY_TRACE_PENDING_STATUSES);
  if (tier2Error) {
    throw new Error(`could not size the Tracerfy queue: ${tier2Error.message}`);
  }

  const { count: queuedTier1, error: tier1Error } = await admin
    .from('trace_history')
    .select('id', { count: 'exact', head: true })
    .in('ai_research_status', TIER1_PENDING_STATUSES);
  if (tier1Error) {
    throw new Error(`could not size the Tier 1 queue: ${tier1Error.message}`);
  }

  const needed =
    (records.tier2 + (queuedTier2 ?? 0)) * TRACERFY_DOSSIER_CREDITS +
    (records.tier1 + (queuedTier1 ?? 0)) * TRACERFY_TIER1_CREDITS;

  if (needed > balance) {
    // THE ONLY SURFACE THIS EVER REACHES AN OPERATOR THROUGH. There is no alerting channel to raise
    // instead, so a pool running dry is invisible without this line.
    console.error(
      `[bulk-preflight] refusing ${records.tier1} tier 1 and ${records.tier2} tier 2 record(s): needs ${needed} Tracerfy credit(s) against a balance of ${balance}, with ${queuedTier1 ?? 0} tier 1 and ${queuedTier2 ?? 0} tier 2 record(s) already queued`
    );
    return false;
  }

  return true;
}
```

`TIER1_PENDING_STATUSES` is already imported by Task 4's change to this file.

Update the file header's two-row table: the second row's question becomes `can PTP EXECUTE, on either tier?`.

**The three call sites.** In `app/api/trace/bulk/route.ts`:

```ts
    if (!(await tracerfyCanRun(adminClient, { tier1: tier1Records.length, tier2: tier2Records.length }))) {
```

In `app/api/v1/trace/bulk/route.ts` and in `lib/suite/mcp-tools.ts`, at their existing pre-flight calls:

```ts
    // tier1: 0, and it is the TRUE value here rather than a placeholder. This surface still posts
    // its tier 1 records to the Tracerfy BATCH endpoint, a different credit bucket from the
    // per-record instant lookups this check sizes. Phase 2B moves them onto the queue and this
    // becomes the tier 1 record count.
    if (!(await tracerfyCanRun(admin, { tier1: 0, tier2: tier2Records.length }))) {
```

using each file's own admin-client variable name and its own tier 2 array name.

Update the `tracerfyCanRunTier2` mock in `app/api/trace/bulk/__tests__/route.test.ts` to the new name and shape:

```ts
    tracerfyCanRun: vi.fn(async (_admin: unknown, n: { tier1: number; tier2: number }) =>
      n.tier1 <= 0 && n.tier2 <= 0 ? true : H.canRunTier2,
    ),
```

and rewrite that file's `it("does not block a tier 1 only batch")` as:

```ts
  it("DOES ask about a tier 1 only batch now, because those records draw the pool per record", async () => {
    H.canRunTier2 = false;
    const res = await post([rec("Jane Smith")]);
    expect(res.status).toBe(503);
    expect(historyRows()).toHaveLength(0);
    expect(vi.mocked(tracerfyCanRun).mock.calls[0][1]).toEqual({ tier1: 1, tier2: 0 });
  });
```

Also update the `it("is asked about the tier 2 records only")` test to assert the pair `{ tier1: <n>, tier2: <m> }` rather than a bare number, and rename it `it("is asked about both tiers, counted separately")`.

Run: `npx vitest run lib/trace/__tests__/bulkPreflight.test.ts app/api/trace/bulk/__tests__/route.test.ts app/api/v1/trace/bulk/__tests__/route.test.ts lib/suite/__tests__/mcp-tools.test.ts app/api/cron/sweep-property-traces/__tests__/route.test.ts`
Expected: everything passes.

**MUTATIONS (every call site, L-018):** (1) in the web route, pass `{ tier1: 0, tier2: tier2Records.length }`; expected RED on `DOES ask about a tier 1 only batch now`. (2) In `tracerfyCanRun`, drop the `queuedTier1` term from `needed`; expected RED on `counts the rows ALREADY queued on both queues`. (3) Drop the `records.tier1 * TRACERFY_TIER1_CREDITS` term; expected RED on `sizes a tier 1 record at the person lookup it spends` and `adds the two tiers`. (4) Change the empty-batch short circuit to `if (records.tier2 <= 0) return true`; expected RED on `reads the balance for a tier-1-only batch`. Restore each.

- [ ] **Step 8: Gates, History, commit**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
grep -rn "tracerfyCanRunTier2" app lib | grep -v node_modules
```

Expected: 0 failed; `tsc exit 0`; eslint at most 46; the grep prints nothing.

Tick Task 6 and add at the top of `History.md`:

```markdown
## <date> (<letter>): Tier 1 Phase 2A, Task 6: one shared per-minute vendor budget.

- Migration 20260923_vendor_rate_budget.sql adds vendor_rate_windows (one row per vendor per
  wall-clock minute) and the claim_vendor_rate RPC, which reserves calls atomically through an
  ON CONFLICT DO UPDATE row lock. Applied and both ACLs read back: nothing for anon or
  authenticated on either the table or the function, service_role only, RLS on.
- lib/trace/vendorRateBudget.ts holds the 450 per vendor (50 under each vendor's own 500, spec
  5.3) in ONE place. A record reserves its worst case before its first vendor call. An unreadable
  budget REFUSES rather than assuming plenty.
- sweep-property-traces reserves before the dossier call and releases a throttled record to the
  rung it was claimed FROM, with no attempt spent: throttling is not a failure (spec 5.1). Its
  sizing comment said tier 1 posts to a different bucket and does not compete, which Phase 2A made
  false; corrected with the new arithmetic (240 + at most 120 of 450).
- bulkPreflight's tracerfyCanRunTier2 becomes tracerfyCanRun({ tier1, tier2 }), closing the gap
  where a 500-record all-tier-1 batch never read the Tracerfy balance at all. The v1 route and the
  MCP tool pass tier1: 0, which is true for them until 2B moves them onto the queue.
```

```bash
git add supabase/migrations/20260923_vendor_rate_budget.sql lib/trace/vendorRateBudget.ts lib/trace/__tests__/vendorRateBudget.test.ts lib/trace/bulkPreflight.ts lib/trace/__tests__/bulkPreflight.test.ts app/api/cron/sweep-property-traces/route.ts app/api/cron/sweep-property-traces/__tests__/route.test.ts app/api/trace/bulk/route.ts app/api/trace/bulk/__tests__/route.test.ts app/api/v1/trace/bulk/route.ts lib/suite/mcp-tools.ts tasks/todo.md History.md
git commit -m "$(cat <<'EOF'
feat(rate): one shared per-minute vendor budget for both crons

Tier 1 Phase 2A, Task 6. 450 Tracerfy and 450 FastAppend calls a minute, reserved atomically in
the database; and tracerfyCanRun now sizes the tier 1 leg it used to skip.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 7: The one billing path, extracted (spec 6.1, D8, D34, D39; lesson L-030)

`runSingleTier1` (`lib/trace/singleTier1.ts:106`) already does plan, execute, judge, charge and persist for a single row, which is exactly what a queue worker needs per record. The cron must not reimplement any of it: two money derivations drift, and that is the Track A / Track B defect deleted on 2026-09-23 (History 2026-09-23 (e), lesson L-030). **This is a refactor of freshly shipped, freshly reviewed money code, so it gets its own task, its own mutation coverage, and a test that proves a single trace's behaviour is byte-identical before and after.**

**Files:**
- Modify: `lib/trace/singleTier1.ts`
- Modify: `lib/trace/__tests__/singleTier1.test.ts`
- Modify: `History.md`, `tasks/todo.md`

**Interfaces:**
- Produces: `runTier1Record(input: Tier1RecordInput): Promise<Tier1RecordResult>`, exported. `Tier1RecordInput` = every field of today's `SingleTier1Input` plus `ledgerSince: string | null`, `queueWrite: { ai_research_status: string | null; property_trace_status: string | null }`, `resumeFromStepLog: boolean`, `onStep?: (step: StepReport) => void | Promise<void>`, and `deadlineMs` becomes optional. `Tier1RecordResult` is today's `SingleTier1Result` unchanged.
- `runSingleTier1(input: SingleTier1Input)` keeps its exact signature and its exact behaviour, and becomes a wrapper.
- Consumes: nothing new.

**Why the file keeps its name.** `lib/trace/__tests__/chargeReceipt.test.ts:412-439` pins a `mustFold` list BY PATH, and `lib/trace/singleTier1.ts` is on it with `expect(sites.length, 'no charge write found in ...').toBeGreaterThan(0)`. Moving the persist into a new module turns that fence red and, worse, would leave it pointed at a file that no longer writes money. Renaming the file means editing the fence list, which is a change to a load-bearing guard made for cosmetic reasons. The file stays `singleTier1.ts`, its docblock says plainly that it now serves the cron too, and the rename goes on Phase 4's cleanup list beside the `ai_research*` rename it belongs with.

- [ ] **Step 1: The byte-identical characterization test, written and passing BEFORE the refactor**

Add to `lib/trace/__tests__/singleTier1.test.ts`. Read the file first and reuse its existing admin-client stub and its `deps` builders; the assertions below are what matter.

```ts
describe('BEFORE AND AFTER THE TASK 7 REFACTOR: the persist payload and the result, in full', () => {
  /**
   * WHY THE WHOLE OBJECT AND NOT THE FIELDS THIS TEST CARES ABOUT. This is money code that shipped
   * eight days ago and was reviewed twice. The refactor that follows moves its body behind a new
   * signature, and the only way to show a single trace still does exactly what it did is to assert
   * every key and every value of both writes and of the returned result, run it against the code as
   * it stands today, and then run the same unchanged test against the refactor. A test that asserts
   * the five interesting keys cannot tell you that the sixth stopped being written.
   */
  it('writes exactly these keys on the ordinary persist', async () => {
    const { admin, updates } = stubAdmin({ row: { id: 'row-1', charge: 0, trace_result: null } })
    const result = await runSingleTier1({
      adminClient: admin,
      userId: 'user-1',
      row: { id: 'row-1', charge: 0, trace_result: null },
      parcel: {
        state: 'TX',
        situsAddress: '1 Main St',
        situsCity: 'Smithville',
        situsState: 'TX',
        situsZip: null,
        parcelIdLocal: null,
        county: null,
        ownerName: 'Jane Smith',
      },
      pricePlan: 'pro',
      chargeAmount: 0.15,
      deadlineMs: Date.now() + 50_000,
      deps: hitDeps(),
      inputOwnerName: 'Jane Smith',
    })

    expect(Object.keys(updates[0].payload).sort()).toEqual(
      [
        'ai_research_status',
        'charge',
        'contact_vendor',
        'cost',
        'email_count',
        'found_by',
        'input_owner_name',
        'is_successful',
        'outcome_code',
        'phone_count',
        'property_trace_status',
        'status',
        'tier',
        'trace_result',
        'trace_steps',
        'tracerfy_job_id',
      ].sort()
    )
    expect(updates[0].payload).toMatchObject({
      status: 'success',
      is_successful: true,
      charge: 0.15,
      tier: 1,
      outcome_code: 'found_by_address',
      found_by: 'address',
      input_owner_name: 'Jane Smith',
      contact_vendor: 'tracerfy',
      tracerfy_job_id: null,
      ai_research_status: null,
      property_trace_status: null,
    })
    expect(Object.keys(result).sort()).toEqual(
      [
        'charge',
        'deduction',
        'execution',
        'foundBy',
        'outcome',
        'persistError',
        'result',
        'skipReason',
        'status',
      ].sort()
    )
    expect(result).toMatchObject({
      outcome: 'found_by_address',
      foundBy: 'address',
      skipReason: null,
      status: 'success',
      charge: 0.15,
      deduction: 'charged',
      persistError: null,
    })
  })

  it('writes exactly these keys on the D39 keep-the-paid-contacts persist', async () => {
    const stored = { phones: [{ number: '5125550001', type: 'mobile' }], emails: [] }
    const { admin, updates } = stubAdmin({ row: { id: 'row-1', charge: 0.15, trace_result: stored } })
    await runSingleTier1({
      adminClient: admin,
      userId: 'user-1',
      row: { id: 'row-1', charge: 0.15, trace_result: stored },
      parcel: {
        state: 'TX',
        situsAddress: '1 Main St',
        situsCity: 'Smithville',
        situsState: 'TX',
        situsZip: null,
        parcelIdLocal: null,
        county: null,
        ownerName: 'John Other',
      },
      pricePlan: 'pro',
      chargeAmount: 0.15,
      deadlineMs: Date.now() + 50_000,
      deps: missDeps(),
      inputOwnerName: 'John Other',
    })

    // D39: the paid result, the owner name it belongs to, the counts, the charge, the cost, the
    // success flag and found_by are ALL left alone. Only the internal columns and the restored
    // status are written.
    expect(Object.keys(updates[0].payload).sort()).toEqual(
      [
        'ai_research_status',
        'contact_vendor',
        'property_trace_status',
        'status',
        'trace_steps',
        'tracerfy_job_id',
      ].sort()
    )
    expect(updates[0].payload).toMatchObject({ status: 'success' })
    expect(updates[0].payload).not.toHaveProperty('trace_result')
    expect(updates[0].payload).not.toHaveProperty('charge')
    expect(updates[0].payload).not.toHaveProperty('found_by')
  })

  it('carries the busy outcome onto a preserved row and no other outcome', async () => {
    const stored = { phones: [{ number: '5125550001', type: 'mobile' }], emails: [] }
    const { admin, updates } = stubAdmin({ row: { id: 'row-1', charge: 0.15, trace_result: stored } })
    await runSingleTier1({
      adminClient: admin,
      userId: 'user-1',
      row: { id: 'row-1', charge: 0.15, trace_result: stored },
      parcel: {
        state: 'TX',
        situsAddress: '1 Main St',
        situsCity: 'Smithville',
        situsState: 'TX',
        situsZip: null,
        parcelIdLocal: null,
        county: null,
        ownerName: 'John Other',
      },
      pricePlan: 'pro',
      chargeAmount: 0.15,
      deadlineMs: Date.now() + 50_000,
      deps: failingDeps(),
      inputOwnerName: 'John Other',
    })
    expect(updates[0].payload).toMatchObject({ outcome_code: 'busy_try_again' })
  })
})
```

Run it: `npx vitest run lib/trace/__tests__/singleTier1.test.ts`
Expected: **every one of the three passes against the code as it is today, with no production change.** If one fails, this plan has misread the current persist: stop and report exactly which key differs (lesson L-021). Do not proceed to Step 2 until all three are green.

- [ ] **Step 2: The extraction**

In `lib/trace/singleTier1.ts`:

**(a)** Replace the file docblock with:

```ts
/**
 * THE ONE TIER 1 SETTLE. Plan, execute, judge, charge, persist, for ONE record.
 *
 * Three callers, one implementation: app/api/trace/single (web, inline), app/api/v1/trace/single
 * (API, inline) and the Tier 1 lane of app/api/cron/sweep-entity-traces (bulk, one claimed row at a
 * time). The billing gate, the ledger probe, the fold and the persist live here and nowhere else.
 *
 * WHY THE CRON DOES NOT HAVE ITS OWN COPY. Two money derivations drift. PTP has already paid for
 * that once: until 2026-09-23 the /api/v1 surface priced through a second, raw derivation that
 * ignored the Suite Gateway snapshot, so the same customer would have been billed the Pro rate on
 * the dashboard and the Pay-As-You-Go rate on the API for the same work. David's ruling: "One
 * price." Both raw helpers were deleted rather than re-pointed, so no new call site could reach for
 * one by accident (lessons L-030). A cron that re-derived the gate, the probe or the fold would be
 * the same defect in a different file, against bulk volume.
 *
 * WHAT DIFFERS BETWEEN A SINGLE TRACE AND A QUEUED RECORD, and it is all in the input:
 *
 *   deadlineMs          the single routes bound the whole ladder to 50 s inside their 60 s
 *                       maxDuration. The cron gives each record its own budget instead.
 *   ledgerSince         the window the crash probe asks about. A single trace asks about the last
 *                       24 hours (the resend window). A queued record asks about ITS OWN BULK JOB,
 *                       because the row is REUSED and a debit from an earlier submit is not an
 *                       answer about this one, which is the bound
 *                       app/api/cron/sweep-property-traces already takes for tier 2.
 *   queueWrite          what the persist writes into the two queue columns. A single trace nulls
 *                       both. A queued record writes its own terminal status, which is what
 *                       releases the parent bulk job.
 *   resumeFromStepLog   a single trace resumes only a busy_try_again row (spec 5.2). A claimed queue
 *                       row always resumes from whatever its log holds, because a dead claim is
 *                       recovered one rung up and the answers it already bought are on the row.
 *   onStep              per-arrival step-log writes, which a queue needs and an inline request does
 *                       not: a killed run would otherwise re-buy every answered step.
 *
 * `execution.steps` is the step log. It is written to trace_steps and read back only by the next
 * attempt at the same record. It never goes into a response or a webhook.
 */
```

**(b)** Rename `SingleTier1Input` to `Tier1RecordInput`, add the four new fields, and make `deadlineMs` optional:

```ts
export interface Tier1RecordInput {
  adminClient: SupabaseClient
  userId: string
  row: SingleTier1Row
  /** The record, with ownerName set. */
  parcel: ParcelInput
  pricePlan: PricePlan
  /** chargePerTrace(profile) on every surface. One derivation (lib/suite/pricing.ts). */
  chargeAmount: number
  /**
   * Epoch ms after which no vendor call may start, or undefined for no bound. The single routes
   * pass request start + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS; the cron passes its own per-record
   * budget. Undefined leaves only the 25 s per-call ceiling in the vendor clients.
   */
  deadlineMs?: number
  deps: RouteDeps
  /**
   * The supplied owner name, exactly as the caller sent it, or null. Written into the SAME
   * persist UPDATE as trace_result below (fix round 1, D25 money): a name and the result it
   * describes must change together, in one write, never a separate one that could name a new
   * owner ahead of that owner's own result.
   */
  inputOwnerName: string | null
  /**
   * ISO time bounding the crash probe, or null for unbounded.
   *
   * A single trace passes 24 hours back, the resend window. A queued record passes its own bulk
   * job's created_at, because the row is REUSED: a debit booked for an earlier submit predates this
   * piece of work and cannot be the answer to whether THIS one has been collected. NULL MEANS
   * UNBOUNDED, WHICH IS THE SAFE DIRECTION: an unreadable bound can only cause a charge to be
   * skipped, while a wrong bound charges a customer twice.
   */
  ledgerSince: string | null
  /**
   * What the persist writes into the two queue columns.
   *
   * A single trace writes null into both: a reused row can carry a stale value from a bulk job and
   * it must not answer rowSkipReason for this trace. A queued record writes its own terminal status
   * into `ai_research_status`, which is what stops it being claimed again and what lets the parent
   * bulk job settle, and null into the other.
   */
  queueWrite: { ai_research_status: string | null; property_trace_status: string | null }
  /**
   * Reuse the answers already on this row instead of buying them again (spec 5.2).
   *
   * A single trace passes this only for a busy_try_again row. The cron passes true for every claimed
   * row: a dead claim is re-claimed one rung up, and the per-arrival writes mean the answers it
   * already paid for are on the row. Either way executeRoute judges each entry by its OWN
   * timestamp, so nothing older than 24 hours is reused.
   */
  resumeFromStepLog: boolean
  /** Per-arrival step-log write. See the file header. */
  onStep?: (step: StepReport) => void | Promise<void>
}

/** The single-trace input: the shared one without the four fields only a queue needs. */
export type SingleTier1Input = Omit<
  Tier1RecordInput,
  'ledgerSince' | 'queueWrite' | 'resumeFromStepLog' | 'onStep' | 'deadlineMs'
> & { deadlineMs: number }
```

Rename `SingleTier1Result` to `Tier1RecordResult` and add `export type SingleTier1Result = Tier1RecordResult` beneath it, so no caller's import breaks.

**(c)** Rename the function and change five lines of its body. `export async function runSingleTier1(input: SingleTier1Input)` becomes `export async function runTier1Record(input: Tier1RecordInput): Promise<Tier1RecordResult>`, and inside it:

```ts
  // Only a busy_try_again row RESUMES on a single trace (spec 5.2); a claimed queue row always
  // resumes from what it already bought. Any answer older than 24 hours is never reused either way:
  // executeRoute judges each entry by its own time, because a reused row keeps its created_at.
  const priorSteps = input.resumeFromStepLog ? stepLogFrom(input.row.trace_steps) : []

  const execution = await executeRoute(plan, input.deps, {
    deadlineMs: input.deadlineMs,
    priorSteps,
    onStep: input.onStep,
  })
```

the ledger probe's window becomes the input:

```ts
    const { total, inWindow } = await collectedChargesFor(
      input.adminClient,
      input.row.id,
      input.ledgerSince,
    )
```

and `internalWrite` takes the queue columns from the input:

```ts
  // The queue columns. A single trace nulls both, because a reused row can carry a stale value from
  // a bulk job and it must not answer rowSkipReason for this trace. A queued record writes its own
  // terminal status here, which is what releases the parent bulk job.
  const internalWrite = {
    contact_vendor: contactVendorFrom(execution.steps),
    trace_steps: execution.steps,
    tracerfy_job_id: null,
    ...input.queueWrite,
  }
```

Everything else in the function, including both UPDATE statements and every comment on them, is untouched. The two statements stay two statements for the reason the existing comment gives: `lib/trace/__tests__/chargeReceipt.test.ts` parses the object literal that follows `.from('trace_history').update({`, so a payload hidden behind a ternary would make the receipt fence blind to this settle.

**(d)** Add the wrapper at the end of the file:

```ts
/**
 * A SINGLE Tier 1 trace: runTier1Record with the four queue fields the routes do not have.
 *
 * Kept as its own export so the two single routes read unchanged and so this file has one obvious
 * place where "what a single trace does differently" is written down. Every value below was
 * inlined in this function before Phase 2A, and lib/trace/__tests__/singleTier1.test.ts asserts
 * the full persist payload and the full result to prove that moving them changed nothing.
 */
export async function runSingleTier1(input: SingleTier1Input): Promise<SingleTier1Result> {
  return runTier1Record({
    ...input,
    // The resend window (spec 5.2). Bounded, because an OLDER surplus is not this request's money.
    ledgerSince: new Date(Date.now() - STEP_REUSE_WINDOW_MS).toISOString(),
    // Both queue columns cleared: a reused row must not answer with a bulk job's stale value.
    queueWrite: { ai_research_status: null, property_trace_status: null },
    // Only a busy row resumes on this surface (spec 5.2).
    resumeFromStepLog: input.row.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN,
  })
}
```

Add `type StepReport` to the existing `@/lib/routing/executeRoute` import.

Run it: `npx vitest run lib/trace/__tests__/singleTier1.test.ts lib/trace/__tests__/chargeReceipt.test.ts app/api/trace/single/__tests__/route.test.ts app/api/v1/trace/single/__tests__/route.test.ts`
Expected: **every test passes, with the three characterization tests unchanged from Step 1.** That is the byte-identical proof. `chargeReceipt.test.ts` must be green without editing it, which proves the charge write is still in this file and still folded.

- [ ] **Step 3: MUTATIONS on the extracted money path**

Every one of these existed before the refactor and must still be caught after it. Run each against `npx vitest run lib/trace/__tests__/singleTier1.test.ts` unless another file is named.

1. Change the billing gate `const billable = hasContactData(result)` to `const billable = execution.contactsFound`. Expected: RED on the existing test that a matched owner with no phone and no email is free (spec 6.1: `contactsFound` is true for an empty contacts object, which is why it is not the gate).
2. Delete the ledger probe branch (`if (unrecorded > 0) { ... }`) so every billable record deducts. Expected: RED on the existing already-collected test.
3. Change `input.ledgerSince` to `null`. Expected: GREEN on the single-trace tests, because an unbounded probe is a SUPERSET; record it as a mutant the single-trace suite cannot kill, and note that Task 8's cron test kills it (`charges a row whose earlier debit belongs to a previous bulk job`). Then run `npx vitest run lib/trace/__tests__/singleTier1.test.ts -t 'older'` and check whether the file has a bounded-window test; if it does and it stays green, report that too (lesson L-020: say which mutations only `tsc` or only another suite can catch).
4. Change `...input.queueWrite` to `ai_research_status: null, property_trace_status: null`. Expected: GREEN on the single-trace suite (that IS what a single trace passes), and RED in Task 8's cron test (`writes the Tier 1 terminal status so the parent job can settle`). Record it here as the mutation Task 8 owns, and re-run it there.
5. Change `resumeFromStepLog: input.row.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN` in the wrapper to `true`. Expected: RED on the existing test that a non-busy row does not reuse its log.
6. Delete `onStep: input.onStep` from the `executeRoute` options. Expected: GREEN here (the single routes pass none) and RED in Task 8's cron test (`writes the step log as each answer arrives`). Record and re-run there.

Mutations 3, 4 and 6 are the honest shape of this task: the extraction adds three behaviours no single-trace test can see, and the plan says so here rather than leaving them unfenced. Task 8 fences all three.

- [ ] **Step 4: Gates, History, commit**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
grep -n "export async function runTier1Record\|export async function runSingleTier1\|charge: billing.charge" lib/trace/singleTier1.ts
```

Expected: 0 failed; `tsc exit 0`; eslint at most 46; the grep shows both functions and the folded charge write still in this file.

Tick Task 7 and add at the top of `History.md`:

```markdown
## <date> (<letter>): Tier 1 Phase 2A, Task 7: one Tier 1 settle for the routes and the cron.

- lib/trace/singleTier1.ts exports runTier1Record. runSingleTier1 is now a wrapper that supplies
  the four things only a queue needs: the ledger probe's window, the queue columns the persist
  writes, whether to resume from the step log, and the per-arrival step hook.
- The billing gate, the crash probe, the fold and both persist shapes are UNCHANGED and are not
  duplicated anywhere. Two money derivations drift, and PTP has already paid for that once
  (lessons L-030).
- Proved byte-identical for a single trace by three characterization tests asserting the FULL
  persist payload key set and the FULL result key set, written and passing against the old code
  first, then run unchanged against the new. chargeReceipt.test.ts needed no edit, which is what
  proves the charge write is still folded and still in this file.
- The file keeps its name: chargeReceipt.test.ts pins it by path. The rename goes on Phase 4's list.
```

```bash
git add lib/trace/singleTier1.ts lib/trace/__tests__/singleTier1.test.ts tasks/todo.md History.md
git commit -m "$(cat <<'EOF'
refactor(money): one Tier 1 settle, shared by both single routes and the cron

Tier 1 Phase 2A, Task 7. runTier1Record is the extracted core; runSingleTier1 is its single-trace
wrapper, proved byte-identical by full-payload characterization tests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The Tier 1 cron (spec 3.2, 5.1, 5.2, 5.3, 6.1)

`sweep-entity-traces` becomes the Tier 1 cron. It keeps its legacy entity lane, untouched, for the rows API bulk and the MCP tool still enqueue, and gains a Tier 1 lane whose claim protocol is copied from `app/api/cron/sweep-property-traces` (spec 3.2: "Claim pattern copied from `sweep-property-traces`").

**Files:**
- Modify: `app/api/cron/sweep-entity-traces/route.ts`
- Modify: `app/api/cron/sweep-entity-traces/__tests__/route.test.ts`
- Modify: `lib/trace/vendorRateBudget.ts` (`reservationForSteps`, with its first caller in the same sitting)
- Modify: `lib/trace/__tests__/vendorRateBudget.test.ts`
- Modify: `History.md`, `tasks/todo.md`

**Interfaces:**
- Consumes: `runTier1Record` (Task 7), the Tier 1 ladder (Task 2), `reserveVendorCalls` (Task 6), `planRoute`, `chargePerTrace`, `pricePlanFor`, `FAILSAFE_PRICE_PLAN`.
- Produces: `parcelForTier1Row(row: Tier1QueueRow): ParcelInput`, exported from the route file; `reservationForSteps(steps): VendorCallReservation`, exported from `lib/trace/vendorRateBudget.ts`; the cron's response gains a `tier1` object.

**Sizing, and it is pinned by a test below.** `TIER1_MAX_ROWS_PER_RUN = 120`, `TIER1_CONCURRENCY = 8`. The arithmetic is in Global Constraints and the test asserts the two numbers together with the 450 budget, so a change to either is a deliberate one.

- [ ] **Step 1: `reservationForSteps`, test first**

Add to `lib/trace/__tests__/vendorRateBudget.test.ts`:

```ts
describe('reservationForSteps', () => {
  it('counts every step against the pool it actually draws, dossier steps included', () => {
    // THE DOSSIER IS A TRACERFY CALL. executeRoute's CONTACT_VENDOR_BY_STEP maps DOSSIER_* to null,
    // because a dossier is not a CONTACT vendor, and reusing that map here would reserve nothing for
    // the two most expensive calls in the product.
    expect(
      reservationForSteps([
        { kind: 'DOSSIER_APN' },
        { kind: 'DOSSIER_ADDRESS' },
        { kind: 'TRACERFY_INSTANT_NAMED' },
        { kind: 'TRACERFY_PARCEL_APN' },
        { kind: 'FASTAPPEND_ENTITY' },
      ])
    ).toEqual({ tracerfy: 4, fastappend: 1 })
  })

  it('asks for nothing when there are no steps, which is a no_lookup_key record', () => {
    expect(reservationForSteps([])).toEqual({ tracerfy: 0, fastappend: 0 })
  })

  it('asks one vendor only for a single-lane record', () => {
    expect(reservationForSteps([{ kind: 'FASTAPPEND_ENTITY' }])).toEqual({
      tracerfy: 0,
      fastappend: 1,
    })
    expect(reservationForSteps([{ kind: 'TRACERFY_INSTANT_NAMED' }])).toEqual({
      tracerfy: 1,
      fastappend: 0,
    })
  })
})
```

Add to `lib/trace/vendorRateBudget.ts`:

```ts
/**
 * Which per-minute pool each step draws from.
 *
 * EXHAUSTIVE BY TYPE, deliberately, the same way executeRoute's CONTACT_VENDOR_BY_STEP is: a new
 * StepKind is a compile error here until somebody says which vendor's limit it spends, rather than
 * silently reserving nothing and tripping that limit in production.
 *
 * NOT THE SAME MAP AS executeRoute's, and the difference is the dossier. That map answers "which
 * CONTACT vendor was asked" and maps DOSSIER_APN and DOSSIER_ADDRESS to null, correctly, because a
 * dossier finds the owner rather than their contacts. This map answers "whose rate limit does this
 * call spend", and a dossier spends Tracerfy's: the endpoint's own header says the counter is shared
 * with Instant Trace, Enhanced Trace, Phone Verification and APN Instant Lookup.
 */
const POOL_BY_STEP: Record<StepKind, VendorName> = {
  DOSSIER_APN: 'tracerfy',
  DOSSIER_ADDRESS: 'tracerfy',
  TRACERFY_INSTANT_NAMED: 'tracerfy',
  TRACERFY_PARCEL_APN: 'tracerfy',
  FASTAPPEND_ENTITY: 'fastappend',
}

/** What a planned ladder could spend, per vendor: its WORST case, which is what a reserve is for. */
export function reservationForSteps(steps: ReadonlyArray<{ kind: StepKind }>): VendorCallReservation {
  const out: Required<VendorCallReservation> = { tracerfy: 0, fastappend: 0 }
  for (const step of steps) out[POOL_BY_STEP[step.kind]] += 1
  return out
}
```

with `import type { StepKind } from '@/lib/routing/ownerRoute'` added at the top.

Run: `npx vitest run lib/trace/__tests__/vendorRateBudget.test.ts`
Expected: all three new tests pass.

**MUTATION:** change `DOSSIER_APN: 'tracerfy'` to `'fastappend'`. Expected: RED on `counts every step against the pool it actually draws`. Restore.

- [ ] **Step 2: The cron's tests, first**

Add to `app/api/cron/sweep-entity-traces/__tests__/route.test.ts`. Read it first: it already stubs the admin client, `lookupBusinessTrace` and `submitSingleTrace`, and it already asserts `submitSingleTrace` is never called (lines 222, 431, 633). Keep every existing test. Add mocks for `@/lib/trace/vendorRateBudget` (`reserveVendorCalls` defaulting to `async () => true`, `pruneVendorRateWindows` as `async () => {}`, and `reservationForSteps` REAL via `importOriginal`) and for the three vendor callables `lookupPersonTrace` and `lookupDossier` the Tier 1 lane injects.

```ts
describe('the TIER 1 lane', () => {
  it('claims only tier1_ rows, and never a legacy entity row', async () => {
    // ONE CRON, TWO LANES, ONE COLUMN. A lane that claimed the other's rows would run a FastAppend
    // business trace against a record planRoute was never asked about, or plan a route for a row
    // whose contacts the entity lane is already buying.
    seedRows([
      { id: 'row-t1', ai_research_status: 'tier1_queued', input_owner_name: 'Jane Smith', user_id: 'u1' },
      { id: 'row-legacy', ai_research_status: 'queued', input_owner_name: 'Acme LLC', user_id: 'u1' },
    ]);
    const body = await runCron();
    expect(body.tier1.processed).toBe(1);
    expect(body.processed).toBe(1);
    expect(rowUpdates('row-t1').some((u) => u.ai_research_status === 'tier1_processing')).toBe(true);
    expect(rowUpdates('row-legacy').some((u) => String(u.ai_research_status).startsWith('tier1'))).toBe(
      false
    );
  });

  it('takes the claim with a compare-and-swap on the status it read', async () => {
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued_3', input_owner_name: 'Jane Smith', user_id: 'u1' }]);
    await runCron();
    const claim = rowUpdates('row-1')[0];
    expect(claim).toMatchObject({ ai_research_status: 'tier1_processing_3' });
    expect(claim.ai_research_claimed_at).toBeTruthy();
    // The compare is against the value READ, not a literal 'tier1_queued': every rung is claimable
    // and a hardcoded attempt 1 would strand a retried row forever.
    expect(claimFilters('row-1')[0]).toMatchObject({ ai_research_status: 'tier1_queued_3' });
  });

  it('does nothing at all to a row another worker claimed first', async () => {
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued', input_owner_name: 'Jane Smith', user_id: 'u1' }]);
    failTheClaim('row-1');
    const body = await runCron();
    expect(body.tier1.processed).toBe(0);
    expect(tracePersonMock).not.toHaveBeenCalled();
    expect(deductWalletMock).not.toHaveBeenCalled();
  });

  it('bills through runTier1Record and nowhere else', async () => {
    // The whole point of Task 7. A cron with its own gate, probe or fold is the Track A/Track B
    // defect in a new file, against bulk volume (lessons L-030).
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued', input_owner_name: 'Jane Smith', user_id: 'u1' }]);
    await runCron();
    expect(runTier1RecordMock).toHaveBeenCalledTimes(1);
    const arg = runTier1RecordMock.mock.calls[0][0];
    expect(arg.chargeAmount).toBe(0.15);
    expect(arg.pricePlan).toBe('pro');
    expect(arg.queueWrite).toEqual({ ai_research_status: 'tier1_done', property_trace_status: null });
    expect(arg.resumeFromStepLog).toBe(true);
    expect(typeof arg.onStep).toBe('function');
  });

  it('prices a grant holder at the PRO rate, through the one derivation', async () => {
    // lib/suite/pricing.ts, grant-aware through effectiveIsPro. $0.15 per tier 1 success for pro,
    // AcquisitionPRO and a Suite Gateway grant; $0.25 pay-as-you-go (lessons L-030).
    seedProfile('u1', {
      subscription_tier: 'wallet',
      is_acquisition_pro_member: false,
      gateway_products: ['prop-tracer-pro'],
    });
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued', input_owner_name: 'Jane Smith', user_id: 'u1' }]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].chargeAmount).toBe(0.15);
  });

  it('prices a pay-as-you-go caller with no grant at the wallet rate', async () => {
    seedProfile('u1', {
      subscription_tier: 'wallet',
      is_acquisition_pro_member: false,
      gateway_products: [],
    });
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued', input_owner_name: 'Jane Smith', user_id: 'u1' }]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].chargeAmount).toBe(0.25);
    expect(runTier1RecordMock.mock.calls[0][0].pricePlan).toBe('wallet');
  });

  it('prices a row whose profile cannot be read at the DEAREST column', async () => {
    // FAILSAFE_PRICE_PLAN is 'wallet' and must never point at the cheap column: an overcharge is
    // visible on a statement and gets refunded, an undercharge is invisible to both sides.
    seedProfile('u1', null);
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued', input_owner_name: 'Jane Smith', user_id: 'u1' }]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].pricePlan).toBe('wallet');
    expect(runTier1RecordMock.mock.calls[0][0].chargeAmount).toBe(0.25);
  });

  it('bounds the crash probe to THIS row s bulk job', async () => {
    // The row is REUSED, so an unbounded probe answers with a debit from an earlier submit, skips
    // the deduct, and gives this job's work away free, repeatably. Same bound the tier 2 cron takes.
    seedJob('job-9', { created_at: '2026-09-23T10:00:00.000Z' });
    seedRows([
      {
        id: 'row-1',
        ai_research_status: 'tier1_queued',
        input_owner_name: 'Jane Smith',
        user_id: 'u1',
        trace_job_id: 'job-9',
      },
    ]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].ledgerSince).toBe('2026-09-23T10:00:00.000Z');
  });

  it('passes an UNBOUNDED probe when the job cannot be read, which is the safe direction', async () => {
    seedRows([
      {
        id: 'row-1',
        ai_research_status: 'tier1_queued',
        input_owner_name: 'Jane Smith',
        user_id: 'u1',
        trace_job_id: null,
      },
    ]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].ledgerSince).toBeNull();
  });

  it('writes the Tier 1 terminal status so the parent job can settle', async () => {
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued', input_owner_name: 'Jane Smith', user_id: 'u1' }]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].queueWrite.ai_research_status).toBe('tier1_done');
  });

  it('writes the step log as each answer arrives', async () => {
    // What a queue needs and an inline request does not: a killed run leaves the answers on the row,
    // so the re-claim one rung up does not buy them again.
    runTier1RecordMock.mockImplementationOnce(async (input) => {
      await input.onStep({ kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss', cost: 0 });
      await input.onStep({ kind: 'FASTAPPEND_ENTITY', outcome: 'hit', cost: 0.1 });
      return okResult();
    });
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued', input_owner_name: 'Smith Family Trust', user_id: 'u1' }]);
    await runCron();
    const logWrites = rowUpdates('row-1').filter((u) => 'trace_steps' in u);
    expect(logWrites).toHaveLength(2);
    expect((logWrites[0].trace_steps as unknown[]).length).toBe(1);
    expect((logWrites[1].trace_steps as unknown[]).length).toBe(2);
  });

  it('releases a record the rate budget refused back to its OWN rung, unspent', async () => {
    // Throttling is NOT a failure (spec 5.1): the record waits for the next minute and spends
    // nothing. No attempt is consumed, because no vendor was asked.
    reserveVendorCallsMock.mockResolvedValue(false);
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued_2', input_owner_name: 'Jane Smith', user_id: 'u1' }]);
    const body = await runCron();
    expect(body.tier1.throttled).toBe(1);
    expect(body.tier1.processed).toBe(0);
    expect(runTier1RecordMock).not.toHaveBeenCalled();
    expect(rowUpdates('row-1').at(-1)).toMatchObject({
      ai_research_status: 'tier1_queued_2',
      ai_research_claimed_at: null,
    });
  });

  it('reserves what the PLAN could spend, per vendor', async () => {
    // A trust with a street and a city plans the instant lookup then FastAppend, so it draws one
    // call from each pool.
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued', input_owner_name: 'Smith Family Trust', user_id: 'u1' }]);
    await runCron();
    expect(reserveVendorCallsMock).toHaveBeenCalledWith(expect.anything(), {
      tracerfy: 1,
      fastappend: 1,
    });
  });

  it('reverts a stale claim ONE RUNG UP, never back to attempt 1', async () => {
    // A claim that never came back is a SPENT attempt. Reverting to attempt 1 lets a row that kills
    // the run every time loop forever and hold a claim slot that belongs to rows that can work.
    seedRows([
      {
        id: 'row-1',
        ai_research_status: 'tier1_processing_2',
        ai_research_claimed_at: minutesAgo(9),
        input_owner_name: 'Jane Smith',
        user_id: 'u1',
      },
    ]);
    const body = await runCron();
    expect(body.tier1.staleReverted).toBe(1);
    expect(rowUpdates('row-1')[0]).toMatchObject({
      ai_research_status: 'tier1_queued_3',
      ai_research_claimed_at: null,
    });
  });

  it('treats a claim with NO timestamp as stale, because SQL < never matches NULL', async () => {
    seedRows([
      {
        id: 'row-1',
        ai_research_status: 'tier1_processing',
        ai_research_claimed_at: null,
        input_owner_name: 'Jane Smith',
        user_id: 'u1',
      },
    ]);
    expect((await runCron()).tier1.staleReverted).toBe(1);
  });

  it('retires a row on its last rung terminally, free, and tells the customer it can be resent', async () => {
    seedRows([
      {
        id: 'row-1',
        ai_research_status: 'tier1_processing_5',
        ai_research_claimed_at: minutesAgo(9),
        input_owner_name: 'Jane Smith',
        user_id: 'u1',
      },
    ]);
    const body = await runCron();
    expect(body.tier1.exhausted).toBe(1);
    const update = rowUpdates('row-1')[0];
    expect(update).toMatchObject({
      ai_research_status: 'tier1_failed',
      ai_research_claimed_at: null,
      status: 'error',
      is_successful: false,
      outcome_code: 'busy_try_again',
    });
    // NO MONEY COLUMNS. The row is REUSED and can already carry a tier 2 receipt; a receipt is
    // monotonic (lib/trace/billedRows.ts), and `charge: 0, tier: 1` over it un-protects a paid row
    // from every delete sweep while wallet_transactions still references it by FK.
    expect(update).not.toHaveProperty('charge');
    expect(update).not.toHaveProperty('tier');
    expect(update).not.toHaveProperty('ai_research_charge');
  });

  it('writes a row with no owner name terminal rather than retrying it', async () => {
    // planRoute answers a nameless record with a TIER 2 plan, which runTier1Record refuses
    // (NotATier1PlanError) precisely so a $0.20 dossier cannot be bought here and billed at the
    // tier 1 rate. Five retries would ask the same unanswerable question five times.
    seedRows([{ id: 'row-1', ai_research_status: 'tier1_queued', input_owner_name: '', user_id: 'u1' }]);
    const body = await runCron();
    expect(body.tier1.skippedNoOwner).toBe(1);
    expect(runTier1RecordMock).not.toHaveBeenCalled();
    expect(rowUpdates('row-1').at(-1)).toMatchObject({
      ai_research_status: 'tier1_done',
      status: 'no_match',
      is_successful: false,
    });
  });

  it('works rows oldest first, at the sizing this phase pinned', async () => {
    seedRows(
      Array.from({ length: 130 }, (_, i) => ({
        id: `row-${i}`,
        ai_research_status: 'tier1_queued',
        input_owner_name: 'Jane Smith',
        user_id: 'u1',
      }))
    );
    const body = await runCron();
    // 120 rows a minute clears a 500-record job in 4.2 minutes, inside spec 3.2's 2-to-5 minutes.
    expect(body.tier1.processed).toBe(120);
    expect(claimWindow().limit).toBe(120);
    expect(claimWindow().order).toBe('created_at');
  });

  it('keeps the legacy entity lane exactly as it was', async () => {
    // 2B moves API bulk and the MCP tool onto the queue; until then their rows are settled here by
    // the lane that has always settled them, through lookupBusinessTrace, at the same rate.
    seedRows([{ id: 'row-1', ai_research_status: 'queued', input_owner_name: 'Acme LLC', user_id: 'u1' }]);
    lookupBusinessTraceMock.mockResolvedValue({ success: true, hit: false });
    const body = await runCron();
    expect(lookupBusinessTraceMock).toHaveBeenCalledTimes(1);
    expect(body.noMatch).toBe(1);
    expect(body.tier1.processed).toBe(0);
    expect(runTier1RecordMock).not.toHaveBeenCalled();
  });
});

describe('the Tier 1 lane s sizing, pinned', () => {
  it('is 120 rows at concurrency 8, which fits the 450 shared budget beside tier 2', () => {
    // 120 rows at concurrency 8 is 15 rounds; at the 3 s per record the Phase 1 live check measured
    // (1.5-2.0 s on a miss, 4.1-4.4 s on a hit) that is ~45 s per run, inside maxDuration 300 with
    // room for the entity lane. Vendor calls: the web upload sends no parcel id (D5), so at most ONE
    // Tracerfy step per record, at most 120 a minute, against sweep-property-traces' 240 and a
    // shared budget of 450. 360 of 450, with 90 left for single traces, which reserve nothing.
    expect(TIER1_MAX_ROWS_PER_RUN).toBe(120);
    expect(TIER1_CONCURRENCY).toBe(8);
    expect(TIER1_MAX_ROWS_PER_RUN * 1 + 240).toBeLessThanOrEqual(VENDOR_RATE_LIMIT.tracerfy);
  });
});
```

Export `TIER1_MAX_ROWS_PER_RUN` and `TIER1_CONCURRENCY` from the route file so that last test can read them rather than repeating the numbers.

- [ ] **Step 3: The cron**

In `app/api/cron/sweep-entity-traces/route.ts`:

**(a)** Add to the imports:

```ts
import type { StepReport } from '@/lib/routing/executeRoute';
import { lookupPersonTrace } from '@/lib/tracerfy/client';
import { lookupDossier } from '@/lib/tracerfy/dossier';
import {
  FAILSAFE_PRICE_PLAN,
  planRoute,
  type ParcelInput,
  type PricePlan,
} from '@/lib/routing/ownerRoute';
import { runTier1Record, NotATier1PlanError } from '@/lib/trace/singleTier1';
import { isParcelKey } from '@/lib/trace/historyDisplay';
import { pricePlanFor } from '@/lib/suite/pricing';
import {
  TIER1_ATTEMPTS,
  TIER1_MAX_ATTEMPTS,
  TIER1_QUEUED_STATUSES,
  TIER1_SETTLED_STATUS,
  tier1AttemptOf,
  tier1NextAfterFailedAttempt,
  tier1ProcessingStatusFor,
} from '@/lib/trace/tier1Queue';
import { TIER1_OUTCOME } from '@/lib/trace/tier1Outcome';
import {
  pruneVendorRateWindows,
  reservationForSteps,
  reserveVendorCalls,
} from '@/lib/trace/vendorRateBudget';
```

`executeRoute` itself is NOT imported: the lane calls `runTier1Record`, which calls it. Only its `StepReport` type is needed here, for the per-arrival accumulator. `TIER1_FAILED_STATUS` is not imported either, because `tier1NextAfterFailedAttempt` is what returns it; an unused import is an eslint error and the baseline of 45 problems must not rise.

**(b)** Extend the file docblock with a new first section:

```ts
/**
 * Vercel Cron, TWO LANES, ONE COLUMN. Runs every minute (vercel.json).
 *
 *   THE TIER 1 LANE (Phase 2A, spec 3.2). Every owned row of a WEB bulk upload, worked through
 *   planRoute() and executeRoute() one record at a time and settled through the SAME
 *   runTier1Record() the two single routes bill with. Rows wear tier1_* statuses.
 *
 *   THE LEGACY ENTITY LANE (unchanged). Rows API bulk and the MCP tool still enqueue with the bare
 *   'queued', resolved through a FastAppend business trace. Phase 2B moves those two surfaces onto
 *   the Tier 1 lane and Phase 4 deletes this one.
 *
 * THE TWO STATUS SETS ARE DISJOINT and lib/trace/__tests__/tier1Queue.test.ts asserts it. That is
 * the whole safety argument for sharing one column: a value in both sets is one row worked twice,
 * by two lanes, under two settle shapes.
 *
 * WHY THE TIER 1 CLAIM PROTOCOL IS A COPY of app/api/cron/sweep-property-traces (spec 3.2 says to
 * copy that one): atomic compare-and-swap against the status just read, `claimed_at` set with the
 * flip, a shared cursor across Promise.all workers rather than fixed slices, and a per-rung stale
 * revert in which a dead claim SPENDS an attempt. Every one of those was paid for by a real failure.
 * This lane mirrors them rather than improving on them.
 *
 * WHAT IT DOES NOT COPY FROM THAT CRON: THE MONEY. Tier 2 bills on whether the dossier ANSWERED,
 * per record submitted, so a miss is billed. Tier 1 bills only a name-matched result carrying a
 * phone or an email, so a miss is FREE. That gate is not re-derived here at all: runTier1Record owns
 * it (spec 6.1, lessons L-030).
 *
 * AND IT DOES NOT COPY THE RETRY EITHER. Under D7 and spec 5.1 a VENDOR failure is never retried:
 * the record ends busy_try_again at once, free, and the customer is told to try again in 5 minutes.
 * The ladder's rungs exist only for a claim that DIED, which spec 5.1 does recover automatically.
 */
```

**(c)** Rename the entity lane's constant and add the Tier 1 lane's, with the arithmetic:

```ts
/** The legacy entity lane. Unchanged, and deliberately small: Phase 4 deletes this lane. */
const ENTITY_MAX_ROWS_PER_RUN = 5;

/**
 * The Tier 1 lane. Sized from measurement, not from a guess.
 *
 * LATENCY. The Phase 1 live check measured 1.5 to 2.0 s on a miss and 4.1 to 4.4 s on a hit
 * (tasks/phase1-live-check.md), so about 3 s per record. 120 rows at concurrency 8 is 15 rounds,
 * roughly 45 s, inside maxDuration 300 with room for the entity lane's five sequential rows.
 *
 * THROUGHPUT. 120 rows a minute clears a 500-record job in 4.2 minutes, inside spec 3.2's 2-to-5
 * minute target.
 *
 * THE SHARED BUDGET. The web upload sends no parcel id (D5), so planRoute emits at most ONE Tracerfy
 * step per record here: 120 calls a minute at worst. sweep-property-traces draws 240 (120 rows at
 * concurrency 5, two calls each). 360 of the 450 shared Tracerfy budget, leaving 90 for single
 * traces, which reserve nothing. Tier 2 is not starved and the vendor's 500 is not approached.
 * lib/trace/vendorRateBudget.ts enforces it; this comment only explains it.
 */
export const TIER1_MAX_ROWS_PER_RUN = 120;
export const TIER1_CONCURRENCY = 8;

/**
 * Each record's own ladder budget. A record that cannot finish inside it ends busy_try_again, free,
 * and its resend resumes from the step log. Without it one hung ladder holds a worker for the
 * 25 s per-call ceiling times every step it has left.
 */
const TIER1_RECORD_BUDGET_MS = 60_000;

/**
 * When this run stops taking NEW records. 240 s of the 300 s maxDuration, so a worker never starts a
 * record the run cannot finish. Rows left unclaimed are not marked anything: they are simply the next
 * run's oldest rows, which costs a minute and spends nothing.
 */
const TIER1_RUN_BUDGET_MS = 240_000;
```

Every existing reference to `MAX_ROWS_PER_RUN` in this file becomes `ENTITY_MAX_ROWS_PER_RUN`.

**(d)** The row shape and the parcel builder, above `export async function GET`:

```ts
/**
 * The columns the Tier 1 lane reads off a claimed row. The query is `select('*')` and returns more;
 * these are the ones named here, so a rename in the schema fails at compile time rather than at
 * 3 a.m. (the entity lane's four string-literal column filters are exactly the risk the
 * ai_research rename plan calls out).
 */
interface Tier1QueueRow {
  id: string;
  user_id: string;
  /** The bulk job this row is CURRENTLY enqueued for. It bounds the crash probe. */
  trace_job_id: string | null;
  normalized_address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  parcel_id_local: string | null;
  county: string | null;
  input_owner_name: string | null;
  ai_research_status: string | null;
  /** Receipt columns, read so foldBillingWrite inside runTier1Record can never downgrade them. */
  charge: number | string | null;
  tier: number | string | null;
  /** D39: the result the row already holds, so a trace that finds nothing cannot erase it. */
  trace_result: unknown;
  /** The step log, so a re-claimed row does not buy the answers it already paid for (spec 5.2). */
  trace_steps: unknown;
  outcome_code: string | null;
}

/**
 * The parcel planRoute() plans from, rebuilt off a claimed Tier 1 row.
 *
 * A PURE EXTRACTION with one job, for the reason app/api/cron/sweep-property-traces' parcelForRow
 * gives: inline wiring inside a long loop cannot be fenced, and this wiring is the only place the
 * owner name and the address reach the vendor. Deleting a line of it would leave `tsc` clean and the
 * suite green (lessons L-020).
 *
 * normalized_address is a pipe-delimited dedup key of THREE fields, street|city|state, with no zip
 * in it (migration 20260904); the zip lives in its own column. A row keyed on a PARCEL carries
 * `APN|<parcel>|<COUNTY>|<STATE>` instead and has no street at all, so splitting on the pipe would
 * hand the vendor the literal word "APN" as an address. The web upload cannot produce such a key
 * (it sends no parcel id, D5), and the guard is here so 2B cannot start to without anyone noticing.
 * No street is '', never a fabricated one (CLAUDE.md rule 7).
 */
export function parcelForTier1Row(row: Tier1QueueRow): ParcelInput {
  const street = isParcelKey(row.normalized_address)
    ? ''
    : row.normalized_address.split('|')[0] || row.normalized_address;
  const state = (row.state || '').trim().toUpperCase();
  return {
    state,
    situsAddress: street,
    situsCity: (row.city || '').trim(),
    situsState: state,
    situsZip: row.zip?.trim() || null,
    parcelIdLocal: row.parcel_id_local?.trim() || null,
    county: row.county?.trim() || null,
    // THE WHOLE DIFFERENCE FROM TIER 2. parcelForFullTrace passes ownerName: null on purpose,
    // because tier 2 is dossier-first by definition. A Tier 1 row HAS its owner, and planRoute
    // returns a tier 1 ladder for it with no dossier step at all.
    ownerName: row.input_owner_name?.trim() || null,
  };
}
```

**(e)** The lane itself, as one function above `GET` so the file stays readable:

```ts
interface Tier1LaneResult {
  processed: number;
  charged: number;
  contactsFound: number;
  noContacts: number;
  busy: number;
  noLookupKey: number;
  skippedNoOwner: number;
  throttled: number;
  errored: number;
  staleReverted: number;
  exhausted: number;
}

/**
 * One pass of the Tier 1 lane. Never throws past its own catch; returns its counters.
 */
async function runTier1Lane(
  adminClient: ReturnType<typeof createAdminClient>,
  runDeadlineMs: number
): Promise<Tier1LaneResult> {
  const out: Tier1LaneResult = {
    processed: 0,
    charged: 0,
    contactsFound: 0,
    noContacts: 0,
    busy: 0,
    noLookupKey: 0,
    skippedNoOwner: 0,
    throttled: 0,
    errored: 0,
    staleReverted: 0,
    exhausted: 0,
  };

  /**
   * Which column of the price table this row pays, and the amount, resolved ONCE per user per run
   * from ONE profile read and ONE derivation (lib/suite/pricing.ts).
   *
   * The no-profile fallback is FAILSAFE_PRICE_PLAN, the dearest column, and the rate that goes with
   * it: an overcharge is visible on a statement and gets refunded within a billing cycle, an
   * undercharge is invisible to both sides and compounds silently (ownerRoute.ts).
   *
   * OWNER TYPE SELECTS THE VENDOR, NEVER THE PRICE (L-005).
   */
  const priceCache = new Map<string, { pricePlan: PricePlan; chargeAmount: number }>();
  const priceFor = async (userId: string) => {
    const cached = priceCache.get(userId);
    if (cached !== undefined) return cached;
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('subscription_tier, is_acquisition_pro_member, gateway_products')
      .eq('id', userId)
      .single();
    const priced = profile
      ? { pricePlan: pricePlanFor(profile), chargeAmount: chargePerTrace(profile) }
      : { pricePlan: FAILSAFE_PRICE_PLAN, chargeAmount: PRICING.CHARGE_PER_SUCCESS_WALLET };
    priceCache.set(userId, priced);
    return priced;
  };

  /**
   * When the bulk job this row now belongs to was created, or null when we cannot tell.
   *
   * It bounds the crash probe to THIS submit. The row is UNIQUE(user_id, address_hash) and is
   * REUSED, so a second submit re-enqueues it for a second, genuine piece of work; a debit booked
   * for the FIRST submit predates this one and cannot answer whether this one has been collected.
   * NULL MEANS UNBOUNDED, WHICH IS THE SAFE DIRECTION: it can only cause a charge to be skipped,
   * while a wrong bound charges a customer twice. Same bound sweep-property-traces takes.
   */
  const jobStartCache = new Map<string, string | null>();
  const jobStartedAt = async (traceJobId: string | null): Promise<string | null> => {
    if (!traceJobId) return null;
    const cached = jobStartCache.get(traceJobId);
    if (cached !== undefined) return cached;
    const { data: job } = await adminClient
      .from('trace_jobs')
      .select('created_at')
      .eq('id', traceJobId)
      .single();
    const startedAt = (job as { created_at?: string } | null)?.created_at ?? null;
    jobStartCache.set(traceJobId, startedAt);
    return startedAt;
  };

  // STALE-CLAIM RECOVERY, one statement per rung, before the claim window. A claim that never came
  // back IS a spent attempt: a row that kills the run every time is exactly as poisonous as one no
  // vendor will answer about, and reverting it to attempt 1 would let it loop forever.
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60 * 1000).toISOString();
  for (const attempt of TIER1_ATTEMPTS) {
    const next = tier1NextAfterFailedAttempt(attempt);
    const { data: reverted } = await adminClient
      .from('trace_history')
      .update(
        next.exhausted
          ? {
              // Terminal, free, and RESENDABLE. Five of our own runs died on this row; that is the
              // system being unable to complete it, which is exactly what busy_try_again says, and
              // busy is one of the two outcomes allowed to invite a resend (spec 7.3). The step log
              // stays, so the resend does not re-buy what this row already answered.
              //
              // NO MONEY COLUMNS IN THIS PAYLOAD, and that is not the same as writing zero into
              // them. The row is REUSED and can already carry a tier 2 receipt; a receipt is
              // monotonic (lib/trace/billedRows.ts), and zeroing one un-protects a paid row from
              // every delete sweep while wallet_transactions still references it by FK.
              ai_research_status: next.status,
              ai_research_claimed_at: null,
              status: 'error',
              is_successful: false,
              outcome_code: TIER1_OUTCOME.BUSY_TRY_AGAIN,
            }
          : { ai_research_status: next.status, ai_research_claimed_at: null }
      )
      .eq('ai_research_status', tier1ProcessingStatusFor(attempt))
      // BOTH ARMS, because SQL `<` never matches NULL. A row sitting in tier1_processing_N with a
      // null claim timestamp is invisible to the claim query (which looks only at the queued rungs)
      // and would be invisible here too, so nothing in the system could touch it and it would hold
      // its parent bulk job at 'processing' forever.
      .or(`ai_research_claimed_at.is.null,ai_research_claimed_at.lt.${staleCutoff}`)
      .select('id');
    const moved = reverted?.length || 0;
    out.staleReverted += moved;
    if (next.exhausted) out.exhausted += moved;
  }
  if (out.staleReverted > 0) {
    console.log(
      `[sweep-entity-traces] tier 1: reverted ${out.staleReverted} stale claim(s) older than ${STALE_CLAIM_MINUTES}m`
    );
  }

  // The claim window. Every rung is claimable; the row's own status says which attempt it is on.
  // Oldest first, which is the order the widened partial index on (ai_research_status, created_at)
  // serves directly (migration 20260923_tier1_queue_index.sql).
  const { data: queuedRows } = await adminClient
    .from('trace_history')
    .select('*')
    .in('ai_research_status', TIER1_QUEUED_STATUSES)
    .order('created_at', { ascending: true })
    .limit(TIER1_MAX_ROWS_PER_RUN);

  const rows = (queuedRows || []) as Tier1QueueRow[];
  if (rows.length === 0) return out;

  const processRow = async (row: Tier1QueueRow): Promise<void> => {
    const attempt = tier1AttemptOf(row.ai_research_status);
    const onFailure = tier1NextAfterFailedAttempt(attempt);

    // ATOMIC CLAIM. Only proceed if we flip the row out of the status we READ IT IN: another worker
    // in this run, or another invocation, may have taken it between the select and here. The compare
    // is against row.ai_research_status rather than a literal, because every rung is claimable and a
    // hardcoded tier1_queued would strand a retried row at tier1_queued_2 forever.
    const { data: claimed } = await adminClient
      .from('trace_history')
      .update({
        ai_research_status: tier1ProcessingStatusFor(attempt),
        ai_research_claimed_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('ai_research_status', row.ai_research_status)
      .select('id')
      .maybeSingle();
    if (!claimed) return;

    try {
      const ownerName = (row.input_owner_name || '').trim();
      if (!ownerName) {
        // planRoute answers a nameless record with a TIER 2 plan, and runTier1Record refuses one
        // (NotATier1PlanError) so a $0.20 dossier cannot be bought here and billed at the tier 1
        // rate. Terminal rather than retried: five more attempts ask the same unanswerable question.
        // Free, because nothing was asked. The web submit routes a blank-owner row to the TIER 2
        // queue, so this cannot happen today; it is here so nothing can start to quietly.
        console.error(`[sweep-entity-traces] tier 1 row ${row.id} carries no owner name; settled terminal`);
        await adminClient
          .from('trace_history')
          .update({
            ai_research_status: TIER1_SETTLED_STATUS,
            ai_research_claimed_at: null,
            status: 'no_match',
            is_successful: false,
          })
          .eq('id', row.id);
        out.skippedNoOwner++;
        return;
      }

      const { pricePlan, chargeAmount } = await priceFor(row.user_id);
      const plan = planRoute(parcelForTier1Row(row), pricePlan);

      // THE SHARED PER-MINUTE BUDGET (spec 5.3), reserved BEFORE any vendor call, for the calls this
      // PLAN could make. Throttling is not a failure (spec 5.1): the row goes back to the rung it
      // was claimed FROM, no attempt spent, nothing said to the customer, nothing charged. It is the
      // next run's oldest row.
      if (!(await reserveVendorCalls(adminClient, reservationForSteps(plan.steps)))) {
        await adminClient
          .from('trace_history')
          .update({
            ai_research_status: row.ai_research_status,
            ai_research_claimed_at: null,
          })
          .eq('id', row.id);
        out.throttled++;
        return;
      }

      /**
       * THE STEP LOG, WRITTEN AS EACH ANSWER ARRIVES (spec 5.2, carried item 3).
       *
       * A single trace writes it once, after the ladder, because its request is bounded and reaches
       * its own persist. This run can be killed between two vendor calls, and the row is then
       * re-claimed one rung up: without the answers already on the row, the second attempt asks the
       * same questions and BUYS THEM AGAIN. runTier1Record's final persist writes the whole log
       * again, which supersedes every one of these.
       */
      const arrived: StepReport[] = [];
      const onStep = async (step: StepReport): Promise<void> => {
        arrived.push(step);
        const { error } = await adminClient
          .from('trace_history')
          .update({ trace_steps: arrived })
          .eq('id', row.id);
        if (error) {
          // Not fatal: the ladder continues and the final persist will write the whole log. The cost
          // of losing this write is one re-bought step on a run that also dies, so it is logged.
          console.error(
            `[sweep-entity-traces] tier 1 step log write failed for row ${row.id}: ${error.message}`
          );
        }
      };

      const settled = await runTier1Record({
        adminClient,
        userId: row.user_id,
        row: {
          id: row.id,
          charge: row.charge,
          tier: row.tier,
          trace_result: row.trace_result,
          trace_steps: row.trace_steps,
          outcome_code: row.outcome_code,
        },
        parcel: parcelForTier1Row(row),
        pricePlan,
        chargeAmount,
        deadlineMs: Date.now() + TIER1_RECORD_BUDGET_MS,
        deps: { lookupDossier, traceEntity: lookupBusinessTrace, tracePerson: lookupPersonTrace },
        inputOwnerName: row.input_owner_name,
        // Bounded to THIS bulk job, the same bound sweep-property-traces takes and for the same
        // reason: the row is reused, so an earlier submit's debit is not an answer about this one.
        ledgerSince: await jobStartedAt(row.trace_job_id),
        // TERMINAL, which is what releases the parent bulk job. The outcome lives in outcome_code,
        // which runTier1Record writes, so this column needs only one settled value.
        queueWrite: { ai_research_status: TIER1_SETTLED_STATUS, property_trace_status: null },
        // A claimed row always resumes from what it already bought. Answers older than 24 hours are
        // not reused: executeRoute judges each entry by its own timestamp.
        resumeFromStepLog: true,
        onStep,
      });

      if (settled.persistError) {
        console.error(
          `[sweep-entity-traces] tier 1 row ${row.id} failed to persist: ${settled.persistError}`
        );
      }

      out.processed++;
      if (settled.charge > 0) out.charged++;
      if (settled.outcome === TIER1_OUTCOME.BUSY_TRY_AGAIN) out.busy++;
      else if (settled.outcome === TIER1_OUTCOME.NO_LOOKUP_KEY) out.noLookupKey++;
      else if (settled.status === 'success') out.contactsFound++;
      else out.noContacts++;
    } catch (err) {
      out.errored++;
      if (err instanceof NotATier1PlanError) {
        // Not retryable: the same row produces the same plan every time. Terminal and free.
        console.error(`[sweep-entity-traces] tier 1 row ${row.id} is not a tier 1 record: ${err.message}`);
        await adminClient
          .from('trace_history')
          .update({
            ai_research_status: TIER1_SETTLED_STATUS,
            ai_research_claimed_at: null,
            status: 'no_match',
            is_successful: false,
          })
          .eq('id', row.id);
        return;
      }
      // A THROW IS OUR SIDE, so it walks the ladder: retry a transient one, give up honestly on a
      // row that throws every time rather than let it hold a claim slot run after run. A VENDOR
      // failure never reaches here: executeRoute returns it as a failed step and runTier1Record
      // settles the row busy_try_again, free and terminal (D7, spec 5.1).
      console.error(
        `[sweep-entity-traces] tier 1 row ${row.id} processing error on attempt ${attempt} of ${TIER1_MAX_ATTEMPTS}: ${err}`
      );
      await adminClient
        .from('trace_history')
        .update(
          onFailure.exhausted
            ? {
                ai_research_status: onFailure.status,
                ai_research_claimed_at: null,
                status: 'error',
                is_successful: false,
                outcome_code: TIER1_OUTCOME.BUSY_TRY_AGAIN,
              }
            : { ai_research_status: onFailure.status, ai_research_claimed_at: null }
        )
        .eq('id', row.id);
      if (onFailure.exhausted) out.exhausted++;
    }
  };

  // CONCURRENCY. A shared cursor rather than fixed slices, so one slow record cannot leave a worker
  // idle while another has a backlog. Each worker still takes the atomic claim per row, so a row can
  // never be worked twice, within this run or across two overlapping runs.
  //
  // THE RUN BUDGET. A worker stops TAKING rows once the run is nearly out of time. Rows it did not
  // take are left queued and unmarked, which spends nothing and costs a minute; starting a record
  // the run cannot finish would leave a claim for the stale sweep to spend an attempt on.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let index = cursor++; index < rows.length; index = cursor++) {
      if (Date.now() >= runDeadlineMs) return;
      await processRow(rows[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TIER1_CONCURRENCY, rows.length) }, () => worker())
  );

  return out;
}
```

**(f)** Wire it into `GET`. Immediately after `const adminClient = createAdminClient();` add:

```ts
  const runStartedAt = Date.now();
  // Housekeeping for the shared budget, once per run rather than once per claim.
  await pruneVendorRateWindows(adminClient);

  // THE TIER 1 LANE FIRST. It is the customer-visible one and the one with a throughput target
  // (spec 3.2: a 500-record job inside 2 to 5 minutes); the legacy entity lane takes five rows a
  // minute and Phase 4 deletes it.
  const tier1 = await runTier1Lane(adminClient, runStartedAt + TIER1_RUN_BUDGET_MS);
```

and add `tier1` to BOTH `NextResponse.json` success bodies (the empty-queue early return and the full one), beside `processed`.

Run it: `npx vitest run app/api/cron/sweep-entity-traces/__tests__/route.test.ts`
Expected: every new test passes and every existing test in the file still passes, including the three that assert `submitSingleTrace` is never called.

- [ ] **Step 4: MUTATIONS on the cron**

Run each against `npx vitest run app/api/cron/sweep-entity-traces/__tests__/route.test.ts` and restore between them.

1. Claim with `.eq('ai_research_status', 'tier1_queued')` instead of `row.ai_research_status`. Expected: RED on `takes the claim with a compare-and-swap on the status it read`.
2. Delete `if (!claimed) return;`. Expected: RED on `does nothing at all to a row another worker claimed first`.
3. Claim `.in('ai_research_status', ENTITY_QUEUED_STATUSES)` in the Tier 1 window. Expected: RED on `claims only tier1_ rows, and never a legacy entity row` and on `keeps the legacy entity lane exactly as it was`.
4. Change the throttle release to `onFailure.status`. Expected: RED on `releases a record the rate budget refused back to its OWN rung, unspent`.
5. Move the reservation after the `runTier1Record` call. Expected: RED on `releases a record the rate budget refused` (the record would already have run).
6. Change the stale revert to `tier1QueuedStatusFor(1)`. Expected: RED on `reverts a stale claim ONE RUNG UP, never back to attempt 1`.
7. Delete the `.or(ai_research_claimed_at.is.null, ...)` NULL arm. Expected: RED on `treats a claim with NO timestamp as stale`.
8. Add `charge: 0, tier: 1` to the exhausted payload. Expected: RED on `retires a row on its last rung terminally, free` (its three `not.toHaveProperty` assertions).
9. Change `queueWrite.ai_research_status` to `null`. Expected: RED on `writes the Tier 1 terminal status so the parent job can settle`. **This is mutation 4 from Task 7, re-run where it can be killed.**
10. Delete `onStep` from the `runTier1Record` call. Expected: RED on `writes the step log as each answer arrives`. **This is mutation 6 from Task 7.**
11. Change `ledgerSince` to `new Date(Date.now() - 86_400_000).toISOString()`. Expected: RED on `bounds the crash probe to THIS row s bulk job`. **This is mutation 3 from Task 7.**
12. Change the no-profile fallback to `{ pricePlan: 'pro', chargeAmount: PRICING.CHARGE_PER_SUCCESS }`. Expected: RED on `prices a row whose profile cannot be read at the DEAREST column`.
13. Change `chargePerTrace(profile)` to `PRICING.CHARGE_PER_SUCCESS`. Expected: RED on `prices a pay-as-you-go caller with no grant at the wallet rate`.
14. Change `TIER1_MAX_ROWS_PER_RUN` to 240. Expected: RED on `works rows oldest first, at the sizing this phase pinned` and on `is 120 rows at concurrency 8, which fits the 450 shared budget beside tier 2`.
15. Delete `if (Date.now() >= runDeadlineMs) return;`. Expected: no test can see it (a test would have to make 120 records take four minutes). Report it as UNFENCED with that reason, and record the alternative considered and rejected: injecting a clock into the lane, which would mean exporting `runTier1Lane` and its whole dependency surface for one assertion.

- [ ] **Step 5: Gates, History, commit**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
npx next build 2>&1 | tail -12
grep -n "\"path\": \"/api/cron/sweep-entity-traces\"" -A 1 vercel.json
```

Expected: 0 failed; `tsc exit 0`; eslint at most 46; the build compiles; `vercel.json` still schedules this cron `* * * * *` (it already does; no change is needed and none is made).

Tick Task 8 and add at the top of `History.md`:

```markdown
## <date> (<letter>): Tier 1 Phase 2A, Task 8: sweep-entity-traces becomes the Tier 1 cron.

- A second lane, beside the legacy entity lane, claiming only tier1_ statuses: atomic
  compare-and-swap on the status just read, claimed_at set with the flip, a shared cursor across 8
  Promise.all workers, and a per-rung stale revert in which a dead claim SPENDS an attempt. Copied
  from sweep-property-traces, which spec 3.2 names as the pattern to copy.
- It bills through runTier1Record and nothing else: no gate, no probe and no fold is re-derived
  (lessons L-030). One profile read per user per run, one derivation from lib/suite/pricing.ts, and
  the dearest column when the profile cannot be read.
- 120 rows a minute at concurrency 8: ~45 s a run, a 500-record job in 4.2 minutes, at most 120
  Tracerfy calls a minute against 240 from the tier 2 cron and a shared budget of 450. The numbers
  are pinned by a test so a change to either is deliberate.
- The step log is written as each answer arrives, so a killed run does not re-buy what the row
  already paid for. A throttled record goes back to its OWN rung with no attempt spent.
- A VENDOR failure is not retried (D7, spec 5.1): runTier1Record settles the row busy_try_again,
  free and terminal. The ladder is for a dead CLAIM only, and its last rung writes the row
  tier1_failed with the same busy sentence, free, with no money columns in the payload.
```

```bash
git add app/api/cron/sweep-entity-traces/route.ts app/api/cron/sweep-entity-traces/__tests__/route.test.ts lib/trace/vendorRateBudget.ts lib/trace/__tests__/vendorRateBudget.test.ts tasks/todo.md History.md
git commit -m "$(cat <<'EOF'
feat(cron): sweep-entity-traces gains the Tier 1 lane and drains the queue

Tier 1 Phase 2A, Task 8. 120 rows a minute at concurrency 8, reserved against the shared budget,
settled through the one Tier 1 billing path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 9: Suite gates, then the live check (one record per path, behind David's dollar amount)

**Files:**
- Create: `tasks/research-scripts/phase2a/run-live.ts`
- Create: `tasks/phase2a-live-check.md` (counts only)
- Create (gitignored, never committed): `tasks/research-test/phase2a/records.json`, `tasks/research-test/phase2a/upload.csv`, `tasks/research-test/phase2a/live.jsonl`
- Modify: `tasks/todo.md` (review section), `History.md`

**Interfaces:**
- Consumes: the whole phase, through the real web bulk route and the real cron on a local server pointed at production.
- Produces: the phase's evidence: gate results, the mutation table, and one live answer per lookup path.

**WHO RUNS WHAT, and it is not negotiable (lesson L-031, and the Phase 1 split that kept the blast radius at $0.20).**
- The EXECUTOR builds the runner, proves its refusals, and stops. It never passes `--live`. It never sets `PTP_LIVE_RUN`.
- DAVID names the dollar amount, and DAVID does the upload: the web bulk route authenticates by session cookie, so there is no way for a script to submit it as him, and there must not be one.
- The CONTROLLER runs the cron trigger with the approved amount after he has uploaded.

- [ ] **Step 1: Suite gates**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
npx next build 2>&1 | tail -15
grep -n "submitBulkTrace" app/api/trace/bulk/route.ts
grep -rn "tracerfyCanRunTier2" app lib | grep -v node_modules
grep -rn "getChargePerTrace\|lib/api/pricing" app lib | grep -v node_modules
grep -n "isLikelyBusiness" app/api/trace/bulk/route.ts
```

Expected: vitest 0 failed and more passing than the Task 1 baseline of 1902 / 84 files; `tsc exit 0`; eslint at most 46 problems and never above the 47 cap; the build compiles; and all four greps print nothing. The third is the L-030 fence (no second price derivation); the fourth proves the web upload still has no `isLikelyBusiness` call, which spec 4.1 requires and Phase 4 makes permanent by deleting the function.

- [ ] **Step 2: The mutation table**

Add a review section to `tasks/todo.md` under the Phase 2A item: one row per mutation run in Tasks 2 to 8 (task, the guard broken, the test named, RED or not). Every mutant this plan predicted GREEN or UNFENCED is written as such with its reason (L-018, L-020): the `traceKeyFor` equivalence in Task 3, the three Task 7 mutants Task 8 owns, and Task 8's run-budget line. Any OTHER survivor is a defect to fix before the live check, not a note.

- [ ] **Step 3: Choose the five records (free: registry reads only, no vendor call)**

One record per lookup path (L-024), each chosen to find a defect rather than to pass (L-023). All five go in ONE upload, because the thing under test is a bulk upload.

| Id | Path | What the CSV row carries | Why it is a path |
|---|---|---|---|
| B1 | tier 1 person, by address | street, city, state, zip, an individual's name | The queue's happy path: Instant by address (D2, D13), billed once |
| B2 | tier 1 person, NO CITY | street, state, an individual's name, city blank | The capability this phase exists for. Was dropped in the browser; now runs and ends `no_lookup_key`, free, with a sentence |
| B3 | tier 1 company, NO CITY | street, state, an LLC's name, city blank | A city-less row that genuinely TRACES: FastAppend needs only a name and a state (D4) |
| B4 | tier 1 trust | street, city, state, a trust name WITH a first name | Both lanes in one record: the instant lookup then FastAppend, and two vendor pools in one reservation |
| B5 | tier 2, blank owner | street, city, state, no owner name | The other queue, unchanged, proving 2A did not disturb it: the job must wait for BOTH |

Rules for picking:
- Candidates come from `/Users/davidmonroe/property-registry/docs/registry-inventory/county-searchable-coverage.csv` (L-023); never a county that is not in it.
- Secondary or tertiary markets only. Never a primary metro county, never Indiana, never Florida.
- Never a county or parcel already used: Phase 0 (`tasks/phase0-small-sample.md`: NY Broome, NY Monroe, LA East Baton Rouge, OH Summit, MN Ramsey, MD Wicomico, UT Washington, CA Shasta), the Phase 1 live check (`tasks/phase1-live-check.md`: NY Onondaga, CO Larimer, NV Washoe, OK Tulsa, AR Benton) or the FastAppend probe (`tasks/phase2-fastappend-probe.md`: IA Linn, ME Cumberland, MT Yellowstone, PA Blair, WY Laramie, NC Cumberland, TN Rutherford, DE Sussex, SC Horry, AZ Pima). List the rest with `ls tasks/research-test/` and a grep of the county fields.
- Five different states, and not all one property type.
- Single traces and the web upload keep today's name handling (D22), so a two-word name is read FIRST LAST. For B1, B2 and B4 pick counties whose registry stores owner names in natural order (`tasks/phase0-county-shortlist.md` records the order per county), or expect `owner_name_not_matched`, which is then the correct answer and not a defect.
- Pull each parcel with the Suite Gateway registry tools (`registry_search_parcels`, `registry_parcel_detail`), which are free.

Write them to `tasks/research-test/phase2a/records.json` (gitignored) in this shape, one object per record, and have the runner render `upload.csv` from it so the file David uploads is the file this plan described:

```json
[
  {
    "id": "B1",
    "path": "tier1_address_person",
    "row": { "address": "", "city": "", "state": "", "zip": "", "owner_name": "" },
    "why": "county, state, property type, and what could break"
  }
]
```

- [ ] **Step 4: Write the runner (it spends nothing without BOTH tokens)**

Create `tasks/research-scripts/phase2a/run-live.ts`:

```ts
/**
 * Tier 1 Phase 2A live check (plan Task 9). ONE record per path, in ONE web bulk upload, drained by
 * the real cron on a LOCAL server pointed at production.
 *
 *   npx tsx tasks/research-scripts/phase2a/run-live.ts --plan
 *   npx tsx tasks/research-scripts/phase2a/run-live.ts --csv
 *   PTP_LIVE_RUN=1 npx tsx tasks/research-scripts/phase2a/run-live.ts --live --max-dollars <n>
 *
 * WHAT IT DOES AND DOES NOT DO. It does NOT submit the upload: app/api/trace/bulk authenticates by
 * session cookie, so David uploads the CSV this script renders, in his own browser, on the local
 * server. --live then triggers the cron that drains the queue, which is where the vendor money is
 * spent, and reads the rows back.
 *
 * THE TWO REFUSALS, AND WHY THERE ARE TWO (lessons L-031). A spend cap does not stop an agent: on
 * 2026-09-23 a subagent ran the FastAppend probe `--live --max-dollars 1` as a "boundary test"
 * against an explicit instruction, the worst case was exactly $1.00, the refusal tested
 * `total > maxDollars`, and ten real vendor calls went out. So:
 *   1. --live does nothing at all unless PTP_LIVE_RUN=1 is in the environment. That is a token an
 *      implementer following its brief has no reason to invent and a human sets deliberately.
 *   2. The cap must be STRICTLY GREATER than the computed worst case. A cap equal to the worst case
 *      is refused, because that is the shape that failed: the boundary case must not also be the
 *      live case.
 * Raw request and response pairs go to tasks/research-test/phase2a/live.jsonl (gitignored: real
 * purchased contact data). The terminal gets no owner name, street, parcel id, phone or email.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type LivePath =
  | 'tier1_address_person'
  | 'tier1_no_city_person'
  | 'tier1_no_city_company'
  | 'tier1_trust'
  | 'tier2_blank_owner'

interface LiveRecord {
  id: string
  path: LivePath
  row: { address: string; city: string; state: string; zip?: string; owner_name?: string }
  why: string
}

/** Vendor dollars if every step of that path bills. */
const WORST_CASE: Record<LivePath, number> = {
  // One Instant lookup at 5 credits.
  tier1_address_person: 0.1,
  // No city and no parcel id on the web (D5): planRoute emits NO step, so nothing can be spent.
  tier1_no_city_person: 0,
  // FastAppend on name and state, 1 credit.
  tier1_no_city_company: 0.1,
  // Instant, then FastAppend if it misses.
  tier1_trust: 0.2,
  // The dossier, then one contact lookup for each owner it names. Two owners assumed.
  tier2_blank_owner: 0.2 + 2 * 0.1,
}

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'tasks/research-test/phase2a')
const RECORDS = join(OUT_DIR, 'records.json')
const CSV = join(OUT_DIR, 'upload.csv')
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

function loadRecords(): LiveRecord[] {
  if (!existsSync(RECORDS)) {
    throw new Error(`Write the chosen records to ${RECORDS} first (plan Task 9, Step 3).`)
  }
  const records = JSON.parse(readFileSync(RECORDS, 'utf8')) as LiveRecord[]
  if (new Set(records.map((r) => r.path)).size !== records.length) {
    throw new Error('One record per path (L-024): a path appears twice. Not run.')
  }
  for (const r of records) {
    if (!(r.path in WORST_CASE)) throw new Error(`${r.id}: unknown path ${r.path}. Not run.`)
  }
  return records
}

const worstCase = (records: LiveRecord[]): number =>
  Math.round(records.reduce((sum, r) => sum + WORST_CASE[r.path], 0) * 100) / 100

/** The file David uploads, in the page's own template order. */
function writeCsv(records: LiveRecord[]): void {
  mkdirSync(OUT_DIR, { recursive: true })
  const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`
  const lines = ['address,city,state,zip,owner_name']
  for (const r of records) {
    lines.push(
      [r.row.address, r.row.city, r.row.state, r.row.zip ?? '', r.row.owner_name ?? '']
        .map(esc)
        .join(',')
    )
  }
  writeFileSync(CSV, lines.join('\n') + '\n')
  console.log(`Wrote ${records.length} rows to ${CSV}. Nothing was spent.`)
}

async function drain(env: Record<string, string>, records: LiveRecord[]): Promise<void> {
  const secret = env.CRON_SECRET
  if (!secret) throw new Error('No CRON_SECRET in .env.local. Not run.')
  mkdirSync(OUT_DIR, { recursive: true })
  for (let pass = 1; pass <= 10; pass++) {
    const started = Date.now()
    const res = await fetch(`${BASE}/api/cron/sweep-entity-traces`, {
      headers: { Authorization: `Bearer ${secret}` },
    })
    const body = (await res.json()) as Record<string, unknown>
    const ms = Date.now() - started
    appendFileSync(
      join(OUT_DIR, 'live.jsonl'),
      JSON.stringify({ pass, cron: 'sweep-entity-traces', status: res.status, ms, body }) + '\n'
    )
    const tier1 = (body.tier1 ?? {}) as Record<string, number>
    console.log(
      [
        `pass ${pass}`,
        `HTTP ${res.status}`,
        `tier1 processed ${tier1.processed ?? 0}`,
        `charged ${tier1.charged ?? 0}`,
        `contacts ${tier1.contactsFound ?? 0}`,
        `no contacts ${tier1.noContacts ?? 0}`,
        `no key ${tier1.noLookupKey ?? 0}`,
        `busy ${tier1.busy ?? 0}`,
        `throttled ${tier1.throttled ?? 0}`,
        `errored ${tier1.errored ?? 0}`,
        `${ms} ms`,
      ].join(' | ')
    )
    if ((tier1.processed ?? 0) === 0 && (tier1.throttled ?? 0) === 0) {
      console.log('Queue is empty. Also trigger the tier 2 cron for the B5 row if it is still queued.')
      return
    }
  }
  console.log(`Ten passes and the queue is still draining. ${records.length} records were expected.`)
}

async function main(): Promise<void> {
  const records = loadRecords()
  const total = worstCase(records)

  if (process.argv.includes('--csv')) {
    writeCsv(records)
    return
  }

  if (!process.argv.includes('--live')) {
    console.log(`Worst case $${total.toFixed(2)} across ${records.length} records:`)
    for (const r of records) console.log(`  ${r.id} ${r.path}: $${WORST_CASE[r.path].toFixed(2)}`)
    console.log('Nothing was run. Pass --csv to write the upload file, or --live to drain the queue.')
    return
  }

  // REFUSAL 0. A token, not a number (lessons L-031).
  if (process.env.PTP_LIVE_RUN !== '1') {
    console.error(
      'REFUSED: --live needs PTP_LIVE_RUN=1 in the environment. This exists so an agent building or ' +
        'testing this script cannot spend money by passing --live, however the cap is set. Not run.'
    )
    process.exit(2)
  }
  // REFUSAL 1. No cap, no run.
  const maxDollars = Number(arg('max-dollars'))
  if (!Number.isFinite(maxDollars) || maxDollars <= 0) {
    console.error('REFUSED: --max-dollars must be a number greater than 0. Not run.')
    process.exit(2)
  }
  // REFUSAL 2. STRICTLY GREATER, not "exceeds". A cap equal to the worst case is the shape that
  // spent real money on 2026-09-23, because $1.00 does not exceed $1.00.
  if (total >= maxDollars) {
    console.error(
      `REFUSED: worst case $${total.toFixed(2)} is not strictly under the approved $${maxDollars.toFixed(2)}. ` +
        'Leave headroom so the boundary case is not also the live case. Not run.'
    )
    process.exit(2)
  }

  const env = loadEnvLocal()
  console.log(`Worst case $${total.toFixed(2)}, under $${maxDollars.toFixed(2)} approved. Draining.`)
  await drain(env, records)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
```

Type-check it and prove all three refusals, spending nothing:

```bash
cd /Users/davidmonroe/PropTracerPRO
T=$(mktemp -d) && cat > $T/tsconfig.json <<'EOF'
{
  "extends": "/Users/davidmonroe/PropTracerPRO/tsconfig.json",
  "compilerOptions": {
    "noEmit": true, "incremental": false, "plugins": [],
    "typeRoots": ["/Users/davidmonroe/PropTracerPRO/node_modules/@types"]
  },
  "include": ["/Users/davidmonroe/PropTracerPRO/tasks/research-scripts/phase2a/*.ts"],
  "exclude": []
}
EOF
npx tsc --noEmit -p $T/tsconfig.json; echo "tsc exit $?"; rm -rf $T
npx tsx tasks/research-scripts/phase2a/run-live.ts; echo "exit $?"
npx tsx tasks/research-scripts/phase2a/run-live.ts --live; echo "exit $?"
npx tsx tasks/research-scripts/phase2a/run-live.ts --live --max-dollars 0.5; echo "exit $?"
```

Expected: `tsc exit 0`; the first prints the per-record worst case and exits 0 with no network call; the second refuses with the `PTP_LIVE_RUN` message and `exit 2`; the third refuses the SAME way and `exit 2`, because the token is still absent and refusal 0 runs first. **The executor stops here. It does not set `PTP_LIVE_RUN` to test refusals 1 and 2; the controller does that, and only with a cap below the worst case so the refusal is the outcome.**

- [ ] **Step 5: HARD STOP 2. Ask David for a dollar amount, and for the upload.**

Send him, in one message:
- The five records: id, path, state, county, property type, and the one thing each could break. No owner names, no streets, no parcel ids.
- The computed worst case from `--plan` (about $0.80 with B5 at two owners: 0.10 + 0.00 + 0.10 + 0.20 + 0.40).
- That his OWN wallet is charged the Tier 1 rate on each found contact and the Tier 2 rate on B5, which is money moving inside PropTracerPRO rather than vendor spend.
- That the web upload needs his session, so he uploads `tasks/research-test/phase2a/upload.csv` himself on the local server, and the controller drains the queue afterwards.
- That his webhook, if he has one set, receives one `bulk_job.completed`.
- Ask him to name the amount, and to leave headroom above the worst case, because the runner refuses a cap equal to it.

Do not run anything until he names it.

- [ ] **Step 6: The run (CONTROLLER, not the executor)**

```bash
cd /Users/davidmonroe/PropTracerPRO
grep -c "^TRACERFY_API_KEY=\|^FASTAPPEND_API_KEY=\|^NEXT_PUBLIC_SUPABASE_URL=\|^SUPABASE_SERVICE_ROLE_KEY=\|^CRON_SECRET=" .env.local
npx tsx tasks/research-scripts/phase2a/run-live.ts --csv
```

Expected: `5` (names only; never print the values), and the CSV written.

Start `npm run dev` in the background on this branch with `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED=true` to match production, and wait until `http://localhost:3000` answers. Ask David to sign in there, open `/trace/bulk`, upload the CSV and submit. The page should show **5 records ready to submit**, not 3: B2 and B3 have no city, and before this phase they were dropped in the browser. Note what the page says at submit (records submitted, most this can cost, and whether the "Records We Can Explain" tile appears yet).

Then, with his amount:

```bash
PTP_LIVE_RUN=1 npx tsx tasks/research-scripts/phase2a/run-live.ts --live --max-dollars <the owner's amount>
curl -s -H "Authorization: Bearer $(grep '^CRON_SECRET=' .env.local | cut -d= -f2-)" http://localhost:3000/api/cron/sweep-property-traces | head -c 400
```

Expected: one line per pass, the first reporting `tier1 processed 4` (B1 through B4) and the queue empty on the next pass; then the tier 2 cron settles B5. A `busy` count is a real answer: record it, and do NOT resend, because a resend spends again.

- [ ] **Step 7: Read the rows back**

```bash
supabase db query --linked "select id, status, outcome_code, found_by, contact_vendor, ai_research_status, property_trace_status, charge, tier, cost, jsonb_array_length(trace_steps) as steps, phone_count, email_count from trace_history where trace_job_id = '<the job id>' order by normalized_address"
supabase db query --linked "select s->>'kind' as kind, s->>'outcome' as outcome, s->>'creditsDeducted' as credits, s->>'at' as at from trace_history, jsonb_array_elements(trace_steps) s where trace_job_id = '<the job id>' order by 4"
supabase db query --linked "select status, records_submitted, records_matched, completed_at from trace_jobs where id = '<the job id>'"
supabase db query --linked "select vendor, window_start, calls_used from vendor_rate_windows order by window_start desc limit 6"
supabase db query --linked "select type, amount, description, created_at from wallet_transactions where trace_history_id in (select id from trace_history where trace_job_id = '<the job id>') order by created_at"
```

Check, record by record:
- B1: `ai_research_status` `tier1_done`, `outcome_code` `found_by_address` with contacts, `found_by` `address`, `contact_vendor` `tracerfy`, `charge` the Tier 1 rate ONCE, one ledger debit.
- B2: `tier1_done`, `outcome_code` `no_lookup_key`, `charge` 0, `cost` 0, **zero steps**, and NO ledger row. A city-less person record must spend nothing at all.
- B3: `tier1_done`, `outcome_code` either `found_by_company_name` with `contact_vendor` `fastappend` or `no_match`, `charge` 0 unless contacts came back. **This is the row that proves a city-less record can trace.**
- B4: `tier1_done`, its step log showing the instant lookup and then FastAppend (or FastAppend `skipped` after a hit), `contact_vendor` naming whichever DELIVERED.
- B5: `property_trace_status` `property_trace_done` or `property_trace_no_reach`, `charge` the Tier 2 rate, and `ai_research_status` NULL: 2A must not have put a blank-owner row on the Tier 1 queue.
- The job: `completed`, `records_submitted` 5, `records_matched` matching the rows that delivered, `completed_at` set. **It must NOT have completed before the cron ran.**
- `vendor_rate_windows`: a `tracerfy` row and, if B3 or B4 reached FastAppend, a `fastappend` row, each with `calls_used` at or below the calls actually made plus the reservations that went unused.
- Every debit is one row per charged record, at the rate the price model says for this account, and the wallet moved by exactly their sum.

Then open the job's results CSV from the History page and check the last two columns are `found_by` and `outcome_code`, that B2's `skip_reason` reads the no-lookup-key sentence, and that no Address cell contains `APN|`.

Any disagreement is a defect: stop and report it to David as a question (L-021), with the row and the value.

- [ ] **Step 8: Report, History, commit**

Write `tasks/phase2a-live-check.md`: date; the approved amount and the actual vendor spend (sum of `cost`) and the customer charge (sum of `charge`, reconciled against the wallet before and after); one table row per record with path, state, county, property type, outcome code, found_by, phone and email counts, step kinds with outcomes and credits, the charge and the latency; then a section on what each path PROVED and a section on what it did NOT prove. Counts only: no owner names, streets, parcel ids, phones or emails.

Tick Task 9 and the Phase 2A line in `tasks/todo.md`, finishing its review section with the gate results, the mutation table and a link to the live report.

```markdown
## <date> (<letter>): Tier 1 Phase 2A, Task 9: gates green, live check one record per path.

- vitest <n> passing, 0 failing; tsc 0 errors; eslint <n> problems (baseline 45, cap 47); next build
  clean. Mutation table in tasks/todo.md: every guard in Tasks 2 to 8 went red when broken, and the
  four predicted-green or unfenced mutants are written as such with their reasons.
- Live, approved $<amount>, vendor spend $<spent>, customer charge $<charge> reconciled against the
  wallet: B1 address person <outcome>, B2 city-less person <outcome>, B3 city-less company
  <outcome>, B4 trust ladder <outcome>, B5 tier 2 blank owner <outcome>. Report:
  tasks/phase2a-live-check.md (counts only; raw in tasks/research-test/phase2a/, gitignored).
- David uploaded the file himself: the web bulk route authenticates by session cookie, so no script
  can submit it as him. The runner rendered the CSV, refused to spend without PTP_LIVE_RUN=1 and a
  cap strictly above the worst case, and drained the queue afterwards.
- Branch feat/tier1-phase2a-queue-and-web-upload is ready. Merging, pushing and deploying wait for
  David. Phase 2B (API bulk and the gateway MCP) is next and is not in this branch.
```

```bash
cd /Users/davidmonroe/PropTracerPRO
git add tasks/research-scripts/phase2a/run-live.ts tasks/phase2a-live-check.md tasks/todo.md History.md
git status --short tasks/research-test
git commit -m "$(cat <<'EOF'
test(phase2a): suite gates and the live check, one record per path

Tier 1 Phase 2A, Task 9.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: `git status --short tasks/research-test` prints nothing (the folder is gitignored). Then stop and hand David: the live report, the mutation table, the four open decisions if he has not answered them, and the list below of what 2B inherits. **Do not push, merge or deploy.**

---

## Carried to Phase 2B and later (not built here)

Recorded so nobody reads their absence as an oversight.

1. **API bulk onto the queue** (`app/api/v1/trace/bulk/route.ts`), including D23's parcel id input, per-record judging, and removing the whole-batch 400 on one bad record (`:77-86`). 2B.
2. **The gateway MCP `skip_trace_bulk` onto the queue** (`lib/suite/mcp-tools.ts`), including its own whole-batch rejection (`:373-379`) and the `apn`/`county` it already stores but has never used for Tier 1 (`:429-430`). 2B.
3. **`found_by` and `outcome_code` in `buildPerRecordResult`** (both twins, in the same change, or `lib/trace/__tests__/payloadParity.test.ts` goes red), in `list_traces`, in the `bulk_job.completed` webhook and in the MCP tool descriptions (`app/api/[transport]/route.ts:91`, `:97`). 2B.
4. **The D33 clear-on-reuse for the other two submit paths.** 2A scoped it to the web route, and `rowSkipReason`'s gate is keyed on the `tier1_` status precisely so the other two keep today's behaviour until they clear the columns too. 2B.
5. **`tracerfyCanRun`'s `tier1: 0` at the two 2B call sites** becomes the real Tier 1 record count when those surfaces stop posting to the batch endpoint. 2B.
6. **The `isLikelyBusiness` split on those two surfaces** disappears when they route through `planRoute`. The function itself is deleted in Phase 4 (spec 4.1, Section 10).
7. **`submitSingleTrace`, the Tracerfy batch path, `settleBulkJob`'s city/state row matcher** (`lib/trace/settleBulkJob.ts:341-352`, the contact-swap defect) and the stale comments d462ab6 left. Phase 4, after the in-flight batch rows drain (spec 3.3).
8. **Renaming `lib/trace/singleTier1.ts`** to something that does not say "single", now that the cron calls it. Phase 4, with the `ai_research*` column rename (`docs/superpowers/plans/2026-09-20-entity-trace-rename-and-vendor-label.md`), because `lib/trace/__tests__/chargeReceipt.test.ts` pins the path and moving it is an edit to a load-bearing fence.
9. **Deleting the legacy entity lane** from `app/api/cron/sweep-entity-traces`, and with it `ENTITY_MAX_ROWS_PER_RUN`, `storedEntityTrace`, `traceCreditFromFastAppend` on that path and the `business_trace_jobs` recovery sweep. Phase 4, once 2B has moved the two surfaces that still enqueue onto it.
10. **The Tier 1 lane's run-budget line is unfenced** (Task 8, mutation 15): no test can see it without making 120 records take four minutes. Recorded rather than papered over with a test that casts its way into an impossible state.
11. **Open task 16** (the wallet reserve is a reserve, not a lock: the sub-second window inside one submit needs a hold taken in the same transaction as the insert) and **open task 19** (a crashed single trace can charge once for nothing; the ledger probe sits inside `if (billable)`) are unchanged by this phase. 2A's per-arrival step log narrows task 19's window for BULK rows but does not close it.
12. **Open task 17** (no in-product path to re-run a bulk row that came back without the contacts it was submitted for, inside the 90-day window) is unchanged. 2A adds the busy exemption, which is the one resend spec 5.2 requires, and nothing else.
13. **Todo task 20's remainder and todo task 23** are Decisions C and D above: surfaced for David, not built.

---
## Self-review

### Spec coverage: Section 10's Phase 2 list, the sections that bind it, and the decisions

| Requirement | Task | Note |
|---|---|---|
| Spec 3.2: ONE queue for every owned record, extending `ai_research_status` / `ai_research_claimed_at` and `entityTraceAttempts.ts` rather than adding a second queue | 2 | Same column, disjoint value sets, asserted directly |
| Spec 3.2: status values fit VARCHAR(20) | 2 (Global Constraints counts every one) | Longest is `tier1_processing_5` at 18 |
| Spec 3.2: claim pattern copied from `sweep-property-traces` (compare-and-swap, bounded concurrency, terminal row) | 8 | Plus the shared cursor and the per-rung stale revert |
| Spec 3.2: `sweep-entity-traces` becomes the Tier 1 cron | 8 | Two lanes in one file; the legacy lane untouched until 2B |
| Spec 3.2: sized so a 500-record job clears in 2 to 5 minutes | 8 | 120 rows a minute at concurrency 8 is 4.2 minutes, pinned by a test |
| Spec 3.3: the batch path keeps settling in-flight rows; nothing new is sent | 3 | Only the web surface stops sending; `submitSingleTrace` and `settleBulkJob` untouched |
| Spec 4.1: one classifier; no `isLikelyBusiness` added | 3 | The web upload never had one and gains none; `planRoute` classifies |
| Spec 4.2, 4.3: the ladders, the name match, hit/miss/failure | 8 (through `planRoute` and `executeRoute`, unchanged from Phase 1) | Nothing about routing is re-implemented in this phase |
| Spec 5.1: a vendor failure ends the record `busy_try_again` at once, free, and is NOT retried | 8 | The ladder's rungs are for a dead claim only, and the file says so |
| Spec 5.1: a crash on our side is recovered automatically and continues from the step log | 2, 8 | `onStep` writes it; `resumeFromStepLog: true` reads it |
| Spec 5.1: throttling is not a failure and uses nothing | 6 (tier 2), 8 (tier 1) | Released to the SAME rung, no attempt spent, mutation-tested in both crons |
| Spec 5.2: per-arrival step log | 2 (the hook), 8 (the writer) | Carried item 3 |
| Spec 5.2: the 24-hour resume window | 7 | `resumeFromStepLog` + `executeRoute`'s per-entry `at` judgement, unchanged |
| Spec 5.2: a resend of a busy row is NOT a duplicate | 3 | `checkDuplicates`, mutation-tested both ways |
| Spec 5.3: ONE shared budget, 450 Tracerfy and 450 FastAppend, neither cron starving the other | 6, 8 | Database-backed, atomic, with the arithmetic in Global Constraints and in the cron |
| Spec 6.1: charged once, on `hasContactData`, at the one rate derivation, with the ledger probe and the fold; `contact_vendor` written | 7, 8 | Not re-derived anywhere: the cron calls `runTier1Record` |
| Spec 6.2: the wallet reserve counts queued Tier 1 records | 4 | Un-age-bounded, else-if ordered, three mutations |
| Spec 6.3 + D36: the bulk surfaces align on `traceKeyFor` | 3 | A no-op on every record this surface can send, and the plan says so rather than claiming a fix |
| Spec 7.1, 7.2: every record reports an outcome code, a sentence and `found_by`; `rowSkipReason` reads the Tier 1 outcome for a bulk row | 5 | Scoped to the web path by the `tier1_` status, which is D33's other half |
| Spec 7.2: CSV appends `found_by` and `outcome_code` at the END | 5 | Columns 104 and 105, after the dossier block |
| Spec 7.2: the bulk page summary counts records by outcome | 5 | Through the existing `summarizeSkips`; no new component, no new string |
| Spec 7.2: `buildPerRecordResult` (both twins), `list_traces`, the MCP descriptions, the Tier 1 webhook fields | **2B** | Named in Scope and in the carried list. `payloadParity.test.ts` is why they move together |
| Spec 7.3: copy rules | 5, and Global Constraints | No sentence is written or changed in this phase; the existing copy tests keep it |
| Spec 8: widen the partial index on `ai_research_status` | 1 | Both indexes, and the older one was already wrong for the entity ladder's own rungs |
| Spec 8: nothing granted to `anon` or `authenticated` beyond SELECT | 1, 6 | The new table and function grant them NOTHING, and both ACLs are read back |
| Spec 11: tests first; every money or matching guard mutation-tested; every call site; no live vendor; request shapes pinned | 2 to 9 | Each task carries its own mutation step; Task 9 collects the table |
| Spec 13: the rate budget is the phase's named risk | 6 | Its own task, its own module, its own tests, and an unreadable budget REFUSES |
| Spec 10, Phase 2: "New submits stop going to the batch CSV" | 3 | The WEB submit. The other two are 2B by David's split |
| Carried item 1: bulk surfaces onto the queue, per-record judging, whole-batch rejection removed | 3, 8 (web); **2B** (API bulk, MCP) | The whole-batch rejection lives only on those two surfaces; the web route never had one |
| Carried item 2: the shared rate budget, and the Tier 2 cron re-sized against it | 6 | Including the correction of that cron's now-false sizing comment |
| Carried item 3: per-arrival step-log writes and stale-claim recovery from the log | 2, 8 | |
| Carried item 4: `found_by` and `outcome_code` in the CSV export and the bulk page summary | 5 (web slice); **2B** (`list_traces`, `bulk_status`, its API twin, the MCP descriptions) | |
| Carried item 5: the bulk submit paths clear `outcome_code`, `found_by`, `trace_steps` on a reused row | 3 (web only), 5 (the gate that depends on it) | |
| Carried item 6: widening the queue index | 1 | |
| Carried item 9 | **WITHDRAWN by spec D32. NOT BUILT, and nothing in this plan builds it.** | The dossier's own contacts are never used, on any surface. No `dossierContactsFallback`, no `contactsNameVerified`, no `TraceResult.name_verified`, no "not name-verified" label anywhere in this phase |
| Carried item 10, reshaped by D36 | 3 | The street-less `\|\|STATE` collision is recorded, not solved, exactly as spec 6.3 rule 3 records it |

**Gaps this review found in the plan's first draft, and fixed inline:**

1. **The bulk job would have completed seconds after submit.** Task 3 makes every web job carry no `tracerfy_job_id`, which lands it in the status route's `!traceJob.tracerfy_job_id` branch, and that branch finalized on the first poll. The early return at the top of the handler makes a completed job permanent, so the customer's CSV would have been short by every row they were about to be billed for. Closed by Task 4, with the gate, the match count and five tests.
2. **`sweep-stale-traces` would have written those jobs FAILED.** Its stage 2 guards only on the tier 2 queue, and a web job now has no tier 2 rows, so at the 60-minute cutoff it fell into the "No Tracerfy job ID" branch. Closed by Task 4.
3. **A single trace could have raced the cron.** `liveWork` calls `isEntityTracePending`, which answers only for the legacy values on that column, so a `tier1_queued` row was invisible and the route would have deleted or reused it mid-claim. Closed by Task 4, in both route files, mutated in both (L-018).
4. **Every Tier 1 bulk match would have read as 0.** `finalize` counted only rows with a `property_trace_status`. Closed by Task 4.
5. **A queued Tier 1 row would have stopped reserving wallet after 60 minutes** although the cron would still bill it, because the only arm that could see it is age-bounded for a different reason. Closed by Task 4, spec 6.2.
6. **A busy resend would have re-bought its answered lookups.** `checkDuplicates` has no busy exemption, so spec 5.2's "try again in 5 minutes" was advice that fails when followed on this surface; and the naive version of D33's clear-on-reuse would have wiped the step log that makes the resume free. Closed by Task 3, with the exemption AND the conditional clear, each mutated.
7. **A resumed queue row would NOT have resumed.** `runSingleTier1` only reads the step log when `outcome_code === 'busy_try_again'`, and a row recovered from a dead claim has no outcome code at all, so the re-claim would have re-bought every answered step and the per-arrival writes would have been pointless. Closed by Task 7's `resumeFromStepLog`.
8. **`chargeReceipt.test.ts` would have gone red on the obvious refactor.** It pins `lib/trace/singleTier1.ts` BY PATH and asserts a charge write exists in it. Task 7 keeps the persist in that file and records the rename as Phase 4 work.
9. **The CSV's dossier-tail assertion would have gone red.** `EXPORT_COLUMNS.slice(38)` equalled `DOSSIER_EXPORT_COLUMNS` only while the dossier block was the tail. Task 5 names the exact edit, `slice(38, 103)`, and every `103` that becomes `105`.
10. **`reservationForSteps` could not reuse `executeRoute`'s vendor map.** `CONTACT_VENDOR_BY_STEP` maps `DOSSIER_*` to null, correctly, because a dossier is not a contact vendor; reusing it would have reserved nothing for the two most expensive calls in the product. Task 8 defines a separate, exhaustive pool map and says why.
11. **The live check cannot be driven by a script.** The web bulk route authenticates by session cookie. Task 9 splits it: the runner renders the CSV and drains the queue, David uploads, the controller runs the spend.
12. **A fifth open decision.** The `no_lookup_key` sentence tells a web customer to send the record again with "the city or the parcel ID", and the web app has no parcel ID column (D5). Before this phase no web customer could see that sentence, because the page dropped the row. Surfaced as Decision E, not fixed (L-028).

### Placeholder scan

There is no "TBD", no "add error handling", no "similar to Task N" and no cross-reference standing in for code. Every code step carries complete code, and where two tasks need the same thing the code is repeated.

The only angle-bracket fills are RESULTS the executor measures before writing them down, each defined where it is used: the `<date>` and `<letter>` of each History entry (defined in Global Constraints, CLAUDE.md rule 9), the baseline counts in Task 1's History entry, the vitest and eslint counts in Task 9's, David's approved amount, the bulk `<the job id>` from the submit response, and the outcome per record in the Task 9 report. A step that cannot be written without a measurement says which command produces it.

**Three places name a local test-harness identifier this plan could not read from outside the file, and each says so at the point of use rather than pretending:**

1. `lib/utils/__tests__/deduplication.test.ts` (Task 3, Step 1): the helper that seeds the rows the stubbed client returns. The step says to read the file first and use its own name, and describes what to add if the file has no such helper.
2. `lib/trace/__tests__/bulkPreflight.test.ts` (Task 4, Step 8 and Task 6, Step 7): `stubAnalytics`, `stubQueuedCounts`, `stubRows`, `admin`, `getAnalyticsMock`.
3. `app/api/trace/bulk/status/__tests__/route.test.ts`, `app/api/cron/sweep-stale-traces/__tests__/route.test.ts`, `app/api/cron/sweep-property-traces/__tests__/route.test.ts`, `app/api/cron/sweep-entity-traces/__tests__/route.test.ts` and the two single-route test files: `seedJob`, `seedRows`, `seedProfile`, `get`, `runCron`, `rowUpdates`, `jobUpdates`, `claimFilters`, `claimWindow`, `failTheClaim`, `minutesAgo`, `hoursAgo`, and the vendor mocks.

Writing invented names into those assertions would be worse than naming the constraint: they would be wrong, and an executor would have to reconcile them anyway. Every one of those files already has such helpers (each defines its own `projectRow` PostgREST-projection stub, per research Section 7), and the assertions themselves, which are the part that matters, are complete.

Two further judgement calls are stated rather than hidden: Task 3's `traceKeyFor` mutation is predicted GREEN and recorded as an equivalent mutant with its evidence, and Task 8's run-budget line is predicted UNFENCED with the reason and the rejected alternative. Both are L-018 and L-020 requirements, not gaps.

### Type consistency across tasks

- `TIER1_MAX_ATTEMPTS`, `TIER1_SETTLED_STATUS`, `TIER1_FAILED_STATUS`, `TIER1_ATTEMPTS`, `TIER1_QUEUED_STATUSES`, `TIER1_PROCESSING_STATUSES`, `TIER1_PENDING_STATUSES`, `tier1QueuedStatusFor`, `tier1ProcessingStatusFor`, `tier1AttemptOf`, `isTier1QueuePending`, `isTier1QueueRow`, `tier1NextAfterFailedAttempt` are all defined in Task 2 (`lib/trace/tier1Queue.ts`) and consumed as: `tier1QueuedStatusFor` in Task 3; `isTier1QueuePending` and `isTier1QueueRow` in Task 4 (four files) and Task 5; `TIER1_PENDING_STATUSES` in Task 4 and Task 6; the rest in Task 8. Every consumer imports from that one module; nothing re-declares a status string.
- `ExecuteOptions.onStep?: (step: StepReport) => void | Promise<void>` is defined in Task 2, threaded through `StageContext` in the same task, passed by `runTier1Record` in Task 7 and supplied by the cron in Task 8. Its parameter type is `StepReport`, already exported from `lib/routing/executeRoute`, and the cron's local accumulator is typed `StepReport[]`.
- `Tier1RecordInput` is defined in Task 7 with `ledgerSince: string | null`, `queueWrite: { ai_research_status: string | null; property_trace_status: string | null }`, `resumeFromStepLog: boolean`, `onStep?`, and `deadlineMs?: number`. `SingleTier1Input` is derived from it by `Omit` in the same task, so a field added to one cannot drift from the other. Task 8 passes every required field, including `deadlineMs` as a number. `Tier1RecordResult` keeps every field of today's `SingleTier1Result` and the old name stays as an alias, so the two single routes' imports are untouched.
- `SingleTier1Row` is unchanged in Task 7, and Task 8 constructs one from its `Tier1QueueRow` with `id`, `charge`, `tier`, `trace_result`, `trace_steps` and `outcome_code`. `charge` and `tier` are `number | string | null` on both sides, which is what `foldBillingWrite`'s `CacheHitRow` already accepts.
- `VENDOR_RATE_LIMIT`, `VendorName`, `VendorCallReservation`, `reserveVendorCalls` and `pruneVendorRateWindows` are defined in Task 6; `reservationForSteps` is added to the same module in Task 8, where its first caller is (L-020: name the first caller in the same sitting). Its parameter is `ReadonlyArray<{ kind: StepKind }>`, which `RoutePlan.steps` (`RouteStep[]`) satisfies structurally, and `POOL_BY_STEP` is an exhaustive `Record<StepKind, VendorName>` so a new step kind is a compile error.
- `tracerfyCanRun(admin, { tier1: number; tier2: number })` replaces `tracerfyCanRunTier2(admin, number)` in Task 6, and all three call sites plus the web route test's mock change in the same task. Task 9's gate greps for the old name to prove none is left.
- `UnsettledRow` in `lib/trace/bulkPreflight.ts` gains `ai_research_status: string | null` in Task 4, and Task 6's `tracerfyCanRun` reads no row shape at all (it uses `count`), so the two changes to that file do not touch each other.
- `SkipReasonRow` already extends `Tier1OutcomeRow` and already carries `ai_research_status` and `trace_job_id`, so Task 5's gate needs no type change; Task 4's widened selects are what make the fields present at runtime, and Task 4's `JobRow` is `SkipRow & { charge; is_successful; property_trace_status? }`, which both widened selects satisfy.
- `Tier1QueueRow` and `parcelForTier1Row` are defined and used in Task 8 only. `parcelForTier1Row` returns `ParcelInput`, which `planRoute(parcel, pricePlan)` takes, and sets `ownerName` where `parcelForFullTrace` sets null, which is the whole tier 1 versus tier 2 difference.
- `TIER1_OUTCOME` (`lib/trace/tier1Outcome.ts`) is read in Tasks 3, 7 and 8 and is never re-declared; `TIER1_OUTCOME.BUSY_TRY_AGAIN` is the one outcome string this phase writes outside `runTier1Record`, in the cron's two exhaustion payloads, and it is imported rather than typed as a literal.
- `EXPORT_COLUMNS` grows by two entries in Task 5 and `toExportValues` grows by two values in the same step, in the same order, which is the invariant `toExportCells` depends on (it zips the two by index).
