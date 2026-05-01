# Fix bulk trace v1 status endpoint timing out, leaving jobs stuck in `processing` (2026-05-01)

## Problem

Bulk trace v1 jobs with entity-owned rows (LLC / trust / blank owner_name) get
stuck in `processing` indefinitely after AI research and Tracerfy both finish.
The 30+ minute hang the user observed today on a 14-record run is not FastAppend
or the cron — it's the finalizer.

After Stage 1 (sweep-bulk-research cron) submits per-row Tracerfy jobs and
Stage 2 (Tracerfy + FastAppend) emails the results, the only thing that writes
the result back to PTP is `GET /api/v1/trace/bulk/status?job_id=...`. That
endpoint polls each row's `tracerfy_job_id` and updates the row.

Two compounding bugs in `app/api/v1/trace/bulk/status/route.ts`:

1. **No `maxDuration` declared.** Vercel defaults the function to ~10s. With
   14+ entity rows the endpoint must make N sequential `getJobStatus()` calls
   and gets killed before it reaches the "mark job completed" block at line
   274. Every poll fails the same way; the bulk run can never finalize. (Compare
   `bulk/route.ts:11` which has `maxDuration = 60`, and
   `sweep-bulk-research/route.ts:26` which has `300`.)
2. **Sequential Tracerfy polls.** The `for (const [tracerfyJobId, bucketRows]
   of unresolvedByJobId.entries())` loop at line 111 serializes one Tracerfy
   API call per unique job id. At 14 rows that's already too slow for the
   default timeout; at 200 rows (which a future bulk could produce) it would
   never fit even with maxDuration = 60.

The throughput downstream of PTP — sweep-bulk-research at 5 rows/min and
FastAppend at 5–7 results/min — is correctly reflected in the status response
while pending (`records_pending_research`, `records_pending_trace`). The bug is
strictly that the finalizer can't survive long enough to commit results.

## Plan

- [x] 1. Add `export const maxDuration = 60` to
       `app/api/v1/trace/bulk/status/route.ts`, matching the bulk submit route.
- [x] 2. Replace the sequential Tracerfy poll loop (lines 111-219) with a
       parallel implementation, capped at concurrency 25 to stay friendly to
       Tracerfy's rate limits. Each entry still does the same work (poll,
       parse, update row, deduct wallet, mutate local copy for the completion
       check at lines 251-256) — only the orchestration changes.
- [x] 3. Verify the diff preserves:
       - Local row mutations so `anyPendingResearch` / `anyPendingTrace` checks
         see the latest state.
       - Wallet deductions firing exactly once per successful row.
       - `bulk_job.completed` webhook firing only when every row is finalized.
       - The "mark remaining person rows in shared bulk bucket as no_match"
         branch at lines 224-242.
- [x] 4. `npx tsc --noEmit` and lint clean on the modified file.
- [x] 5. Update `History.md` per CLAUDE rule 9.

## Out of scope

- Push-based finalization via a new cron (long-term improvement; not needed to
  unstick today's job or to handle 200-record runs once the timeout + parallel
  fix is in).
- Changes to `sweep-bulk-research` throughput.
- Anything in the dashboard UI bulk path.

## Review

### What changed

`app/api/v1/trace/bulk/status/route.ts` only:

1. Added `export const maxDuration = 60` so Vercel doesn't kill the function at
   the platform default while it's polling Tracerfy.
2. Added `const POLL_CONCURRENCY = 25` and refactored the per-job poll body
   into an inner `resolveOne(tracerfyJobId, bucketRows)` arrow function.
3. Replaced the sequential `for (const [tracerfyJobId, bucketRows] of
   unresolvedByJobId.entries())` loop with a batched runner:
   `for (let i = 0; i < pollEntries.length; i += POLL_CONCURRENCY) {
     await Promise.all(batch.map(([jobId, bucket]) => resolveOne(...)));
   }`
4. Changed one `if (!target) continue;` inside the single-row branch to
   `return;` since it now lives inside the arrow function rather than the
   outer for loop. The other `continue` (line 200, inside
   `for (const rawResult of statusResult.results)`) is still inside a real
   loop and stays as `continue`.

### Behavioral preservation

- Per-row DB updates and `deduct_wallet_balance` calls fire exactly once per
  successful row, same as before.
- Local row mutation (`row.status = ...`, `match.status = ...`,
  `r.status = 'no_match'`) still runs after the DB update so the completion
  check at `anyPendingResearch` / `anyPendingTrace` sees the latest state in
  this same request.
- The "mark remaining still-processing person rows as no_match" branch still
  runs inside the shared-bulk-job branch.
- `bulk_job.completed` webhook still fires only when both
  `anyPendingResearch` and `anyPendingTrace` are false.

### Verification

- `npx tsc --noEmit` — clean
- `npx eslint app/api/v1/trace/bulk/status/route.ts` — clean

### Out of scope (still)

- Push-based finalization (Tracerfy webhook → row update). With the timeout +
  parallel fix in place the lazy-poll model handles up to ~200 entity rows per
  bulk in a single `getJobStatus` round-trip's worth of latency. Push-based
  remains a longer-term simplification.
- `sweep-bulk-research` throughput (5 rows/min sequential). The user is fine
  with the existing cadence; status responses already report
  `records_pending_research` while it churns.
