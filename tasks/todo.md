# Fix: PTP silently masks Tracerfy failures as "pending" (2026-05-11)

## Problem

Both bulk and single skip-trace sessions sit at `status: 'processing'` (which the dashboard surfaces as "pending") for 20–30+ minutes. The Lead-Gen Agent then retries the trace at its internal 20-minute timeout, believing PTP failed.

Last week's fixes (`d780e9d` research-cron stale claims; `5407f2e` v1 bulk status `maxDuration` + parallel polling) addressed two unrelated paths. They didn't touch the path that's biting now.

## Root cause

`lib/tracerfy/client.ts` `getJobStatus()` silently coerces *every* non-success Tracerfy response — 503, 429, unknown response shape — into `{ success: true, pending: true }`. All four status endpoints then react identically to "Tracerfy is genuinely working" and "Tracerfy is broken", returning `status: 'processing'` to the caller indefinitely. Under upstream Tracerfy pressure (which is what's happening right now), the agent has no diagnostic signal and gives up.

`sweep-stale-traces` only kicks in at 60 minutes — too late.

## Plan

- [x] Add `STALE_PROCESSING.TRACERFY_STALL_MINUTES = 15` constant.
- [x] `lib/tracerfy/client.ts`: surface a `TracerfyErrorReason` tag on `getJobStatus()` returns — `rate_limited` / `upstream_unavailable` / `malformed_response` / `network_error` / `auth_error`. Pending state is preserved (`pending: true`) but tagged so callers can stall-detect.
- [x] `app/api/v1/trace/status/route.ts` (Lead-Gen Agent hits this): stall-detect at 15min when `errorReason` is set → promote row to `status: 'error'` with reason in response. Surface `tracerfy_state` and `age_minutes` on every processing response.
- [x] `app/api/v1/trace/bulk/status/route.ts`: track stalled Tracerfy job ids inside `resolveOne`. After the parallel batch, if job is past stall threshold AND any bucket got an `errorReason`, promote those rows to `error` and finalize the parent `trace_jobs` row as `failed` with `error_message`.
- [x] `app/api/trace/status/route.ts` (dashboard single): same stall-detect.
- [x] `app/api/trace/bulk/status/route.ts` (dashboard bulk): stall-detect on the shared `tracerfy_job_id`; on stall, mark all still-processing rows for that job as `error` and finalize the parent as `failed`.
- [x] `npx tsc --noEmit` clean.
- [x] `npm run lint` — no new errors introduced (one prefer-const error from my changes fixed; remaining 35 errors are pre-existing).
- [x] Update `History.md`.

## Out of scope

- Schema migration. No `trace_history.error_message` column; per-row error reasoning is surfaced in the API response + console logs only. `trace_jobs.error_message` already exists and gets the bulk stall reason.
- Tracerfy webhook / push completion. Real long-term fix but depends on Tracerfy's API.
- Bulk research cron retry diagnostics. Different code path (`sweep-bulk-research`), already has its own stale-claim recovery.
- Dashboard bulk status `maxDuration`. Latent issue mirror of `5407f2e` but not the cause of this symptom.

## Review

### What changed

Six files:

1. `lib/constants.ts` — added `TRACERFY_STALL_MINUTES = 15` under `STALE_PROCESSING`.
2. `lib/tracerfy/client.ts` — exported `TracerfyErrorReason` type. `getJobStatus()` now returns `errorReason` on 429 (`rate_limited`), 503 (`upstream_unavailable`), 401/403 (`auth_error`), unknown response shape (`malformed_response`), and caught fetch errors (`network_error`). 401/403 also flips `success: false` since these aren't transient. The `pending: true` contract is preserved for callers that want to keep polling — the tag is purely additive diagnostic info.
3. `app/api/v1/trace/status/route.ts` — after `getJobStatus`, compute `ageMinutes` from `trace.created_at`. If `errorReason` set AND age ≥ 15min → update row to `status: 'error'`, return `{ success: false, status: 'error', tracerfy_state, age_minutes }`. Otherwise the existing `'processing'` branch now includes `tracerfy_state` (the error reason or `'pending'`) and `age_minutes` in the response.
4. `app/api/v1/trace/bulk/status/route.ts` — `resolveOne` now records the `errorReason` per `tracerfyJobId` in a `stalledByErrorReason: Map` when polls come back unhealthy. After the parallel batch, if the parent `traceJob.created_at` is past the threshold AND any stalled buckets exist, those rows get promoted to `error` in a single `.in('id', stalledRowIds)` update. If no rows remain processing after that, the parent `trace_jobs` is finalized as `failed` with a real `error_message`. The pending-state response shape also gets `tracerfy_state` + `age_minutes` for diagnostic visibility.
5. `app/api/trace/status/route.ts` — same stall-detect pattern as the v1 single endpoint.
6. `app/api/trace/bulk/status/route.ts` — dashboard bulk polls one shared `tracerfy_job_id`, so stall logic is simpler: if `errorReason` set AND job age ≥ 15min → finalize `trace_jobs` as `failed` with `error_message`, mark all its still-processing `trace_history` rows as `error`. Otherwise existing pending branches now include `tracerfy_state` + `age_minutes`.

### Behavioral preservation

- Genuine `pending: true` from Tracerfy (no `errorReason`) keeps the row in `processing` regardless of age — only Tracerfy-side unhealthiness triggers stall promotion.
- The 60-min `CRON_TIMEOUT_MINUTES` for `sweep-stale-traces` is untouched and serves as the second-line recovery.
- Wallet deduction logic is untouched. Stall-promoted rows have no charge applied (they were never `is_successful`).
- The webhook + HighLevel push paths fire on the existing terminal states; a `failed` bulk job doesn't trigger the `bulk_job.completed` webhook (existing guard).

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` — 35 pre-existing errors, 12 pre-existing warnings, none introduced by this change.
- Code-path trace:
  - Row created 10min ago, Tracerfy returns 503 → response: `status: 'processing', tracerfy_state: 'upstream_unavailable', age_minutes: 10`. Row stays processing.
  - Same row at 16min, Tracerfy still 503 → row promoted to `error` in DB, response: `status: 'error', tracerfy_state: 'upstream_unavailable', age_minutes: 16`. Agent sees a definitive failure signal.
  - Row at 16min, Tracerfy genuinely says `{ pending: true }` (no `errorReason`) → response: `status: 'processing', tracerfy_state: 'pending', age_minutes: 16`. Row stays processing. No false-erroring slow Tracerfy jobs.
  - Bulk job at 20min with 3 rows polling a 503-ing Tracerfy → 3 rows promoted to `error`, parent `trace_jobs` finalized as `failed` with `error_message: "Tracerfy upstream unhealthy: upstream_unavailable -- 3 row(s) stalled for 20m"`.

### Out of scope (still)

- Tracerfy webhook integration for push-based completion.
- Adjusting Lead-Gen Agent's 20-min retry threshold (server-side fix makes that retry meaningful instead of useless).
- Schema migration for per-row error_message.
