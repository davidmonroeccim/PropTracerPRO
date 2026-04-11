# Bulk Trace: AI Research + FastAppend Parity with Single Trace

## Problem

The v1 bulk endpoints (`POST /api/v1/trace/bulk` + `GET /api/v1/trace/bulk/status`) have
none of the AI research / FastAppend business-trace plumbing that the single-trace
endpoints got yesterday (commit `1a4997c`). Every entity-owned property in a bulk
upload silently loses its decision-maker contacts:

- `/v1/trace/bulk` blindly splits whatever `owner_name` is on the record (even an
  LLC like "Extra Space Storage") into first/last name and ships it to Tracerfy's
  person skip trace, guaranteeing a miss.
- No call to `researchProperty()`, no entity detection, no FastAppend business
  trace, no `business_trace_jobs` async recovery, no `ai_research` persisted to
  `trace_history`.
- The `bulk_job.completed` webhook delivers only Tracerfy person-trace output.
  There is no `research`, `contacts`, `business_trace_pending`, or
  `business_trace_job_id` per record.
- This contradicts `docs/AGENT_INTEGRATION.md`, which promises agents the same
  structured FastAppend payload the single-trace flow now delivers.

## Design

Bulk has a hard constraint: an HTTP POST cannot block for `records × 45s` of
inline AI research. So the work moves to a background cron worker, modeled on
the existing `sweep-business-traces` cron.

**Inbound `POST /api/v1/trace/bulk`:**

1. Dedupe, wallet-check (now includes research cost estimate for records needing
   it).
2. Create `trace_jobs` row.
3. Split records:
   - **personRecords** — `owner_name` is set AND `isLikelyBusiness(owner_name)` is
     false. These go straight to Tracerfy as before.
   - **entityRecords** — `owner_name` empty OR looks like a business. These need
     AI research before any Tracerfy call.
4. Insert all `trace_history` rows linked to the new `trace_jobs.id` via a new
   `trace_job_id` column. personRecords get `status='processing'`; entityRecords
   get `status='processing'` + `ai_research_status='queued'`.
5. If any personRecords exist, submit them as a single Tracerfy bulk CSV (old
   fast path, preserved).
6. Return `job_id` immediately. Response declares how many records are queued
   for research.

**New cron `/api/cron/sweep-bulk-research`** (runs every minute):

1. Pulls up to N trace_history rows with `ai_research_status='queued'`.
2. For each row, calls `researchProperty()` with an `asyncRecovery` context so a
   timed-out FastAppend business trace gets queued into `business_trace_jobs`
   (already handled by `resolveEntityChain()`).
3. Persists `ai_research` + `ai_research_status='found'|'not_found'` onto the
   trace_history row; deducts the $0.15 research charge if an owner was found.
4. If research resolved a person name (`individual_behind_business` or
   `owner_name`), submits a single Tracerfy person-skip-trace for that row via
   `submitSingleTrace()` and records the returned `tracerfy_job_id` on the row.
5. If research found no person name, marks the row `status='no_match'`
   immediately.

**Outbound `GET /api/v1/trace/bulk/status`:**

1. Aggregates state across all `trace_history` rows linked to the job via
   `trace_job_id`:
   - Any rows still queued/processing for research → overall `status='processing'`.
   - Any rows whose Tracerfy job hasn't resolved → poll each unique
     `tracerfy_job_id` via `getJobStatus()`, match results back, persist
     trace_result + deduct charges (mirrors current single-trace status logic).
2. When everything is finalized, updates `trace_jobs.status='completed'` and
   fires a single `bulk_job.completed` webhook. The webhook's `results` array
   now includes per-record `research`, `contacts`, `business_trace_pending`,
   and `business_trace_job_id`, matching `docs/AGENT_INTEGRATION.md`.
3. The existing `sweep-business-traces` cron continues to fire per-record
   `business_trace.completed` webhooks as the slow-path FastAppend jobs resolve
   — no change needed, since it already merges into any `trace_history` row
   with a matching `address_hash`.

## Key design choices

- **New `trace_job_id` column on `trace_history`** — needed to aggregate
  per-record state back to the parent bulk job once entity rows have individual
  Tracerfy job IDs (diverging from the shared bulk `tracerfy_job_id`).
- **Per-record single-trace submission for entity rows** — simpler than
  re-packaging resolved rows into a second Tracerfy bulk CSV, and mirrors the
  single-trace API exactly.
- **Cron-driven research, not inline** — Vercel serverless maxDuration (300 s)
  cannot accommodate 10k × 45 s research calls. Cron runs every 1 min, processes
  small batches, matches the proven `sweep-business-traces` pattern.
- **Scope: v1 API only** — the user's ask is specifically about the agent-facing
  API (per `docs/AGENT_INTEGRATION.md`). The dashboard UI bulk flow
  (`app/api/trace/bulk/*`, `/trace/bulk` page) is untouched.

## Tasks

- [x] **1.** Write plan
- [x] **2.** Migration `supabase/migrations/20260411_bulk_trace_research.sql` —
      add `trace_job_id` column + index to `trace_history`
- [x] **3.** Export `isLikelyBusiness` from `lib/ai-research/client.ts`
- [x] **4.** Rewrite `app/api/v1/trace/bulk/route.ts` with entity detection,
      split submit, and research queueing
- [x] **5.** Create `app/api/cron/sweep-bulk-research/route.ts` worker
- [x] **6.** Register the new cron in `vercel.json`
- [x] **7.** Rewrite `app/api/v1/trace/bulk/status/route.ts` to aggregate by
      `trace_job_id` and include per-record research + contacts in the
      response and webhook
- [x] **8.** Update `History.md` and this file's review section

## Review

### What shipped

Bulk trace via the v1 agent API now runs the same AI research + FastAppend
business-trace flow that single trace got yesterday, delivered via a background
cron worker to avoid HTTP timeout constraints.

**Files changed:**
- `supabase/migrations/20260411_bulk_trace_research.sql` (new) — `trace_job_id`
  FK on `trace_history` + two partial indexes (queued-research lookup and
  aggregate-by-bulk-job lookup)
- `lib/ai-research/client.ts` — `isLikelyBusiness` exported
- `app/api/v1/trace/bulk/route.ts` — full rewrite; splits records into person
  vs. entity buckets, inserts `trace_history` rows up front with
  `trace_job_id`, queues entity rows as `ai_research_status='queued'`, submits
  person rows via the existing Tracerfy bulk CSV path
- `app/api/cron/sweep-bulk-research/route.ts` (new) — processes 5 queued rows
  per run, atomic claim, calls `researchProperty()` with asyncRecovery,
  persists research, deducts $0.15 per owner found, submits single Tracerfy
  trace for resolved person names
- `vercel.json` — registers the new cron on `* * * * *`
- `app/api/v1/trace/bulk/status/route.ts` — full rewrite; aggregates by
  `trace_job_id`, polls all unresolved Tracerfy jobs (shared bulk + per-entity
  single submits), fires enriched `bulk_job.completed` webhook with per-record
  `research`, `contacts`, `business_trace_pending`, `business_trace_job_id`
- `History.md` — 2026-04-11 entry

### Flow contract vs. `docs/AGENT_INTEGRATION.md`

Inbound response now includes `recordsDirectTrace` and
`recordsPendingResearch` so the agent knows how many records will be delayed.
Outbound bulk webhook + status response per-record shape:

```
{
  address, city, state, zip, status, input_owner_name,
  result,      // Tracerfy person-trace result
  research,    // full AIResearchResult with business_trace_contacts sidecar
  contacts,    // top-level alias for research.business_trace_contacts
  business_trace_pending,     // true while FastAppend async job unresolved
  business_trace_job_id,      // correlates with business_trace.completed webhook
  charge, ai_research_charge
}
```

Rows whose FastAppend business trace exceeded the 45 s inline poll are tracked
in `business_trace_jobs` and finalized by the existing `sweep-business-traces`
cron, which fires a separate `business_trace.completed` webhook per row.
Agents correlate via `business_trace_job_id` just like the single-trace flow.

### Non-goals / deferred

- UI dashboard bulk (`app/api/trace/bulk/*` + `/trace/bulk` page) is untouched.
  The user asked about the agent-facing v1 API specifically.
- No retry counter on the cron worker. Persistent research failures loop every
  minute; acceptable for now since cron is throttled to 5 rows per run and the
  error path is visible in logs.
- Bulk dedup (`checkDuplicates`) still relies on the stale-processing window
  to allow re-submission of stuck records. Not changed.

### Verification

- `npx tsc --noEmit` — clean
- `npm run lint` on the three modified/new route files — clean (pre-existing
  warning in `lib/ai-research/client.ts:645` about unused `parseError` is not
  from this change and was left alone per the "don't touch code you didn't
  modify" guideline)
