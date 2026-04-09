# Async FastAppend Business Trace Recovery

## Problem
When `/api/v1/research/single` encounters a business-owned property (LLC, Trust, storage company), `resolveEntityChain()` in `lib/ai-research/client.ts:316` calls FastAppend's business-trace API and polls for ~45s (15 × 3s). FastAppend routinely takes longer than that, so the poll times out, the API returns with just `business_trace_status: "No results for..."`, and FastAppend later emails the completed CSV to the user — those results never re-enter PTP. The agent that called the API has no way to retrieve them.

## Design (keeps inline polling as fast-path, adds async recovery)

**Hot path (unchanged):** If FastAppend responds within 45 s, `resolveEntityChain()` picks up the contacts inline, feeds them to Claude, and the research returns fully-populated. No change for agents.

**Slow path (new):** If the 45 s poll exhausts without results, `resolveEntityChain()` saves the FastAppend `queue_id` to a new `business_trace_jobs` table via admin client, and the research still returns immediately. The v1 route surfaces `business_trace_pending: true` + `business_trace_job_id` in the response. A cron sweeper picks up pending jobs every 5 min, polls FastAppend, merges contacts into `trace_history.ai_research`, and fires a `business_trace.completed` webhook. Agents can also poll `/api/v1/research/status?job_id=...`.

## Tasks

- [x] **1.** Write plan
- [x] **2.** Migration `supabase/migrations/20260409_business_trace_jobs.sql`
- [x] **3.** `types/index.ts` — `pending_business_trace?` + `BusinessTraceJob`
- [x] **4.** `lib/ai-research/client.ts` — async recovery path in `resolveEntityChain()`
- [x] **5.** `app/api/v1/research/single/route.ts` — surface pending job id
- [x] **6.** `app/api/research/single/route.ts` — session route parity
- [x] **7.** `app/api/cron/sweep-business-traces/route.ts` — new cron sweeper
- [x] **8.** `vercel.json` — cron registered
- [x] **9.** `app/api/v1/research/status/route.ts` — new status endpoint
- [x] **10.** API docs page updated
- [x] **11.** `docs/AGENT_INTEGRATION.md` created
- [x] **12.** `History.md` + review section

## Review

### What shipped

**Fast path (unchanged):** FastAppend business traces that complete within 45 s still populate contacts inline during AI research. Zero behavior change for quick cases.

**Slow path (new):** When the 45 s poll exhausts with FastAppend still pending:

1. `resolveEntityChain()` inserts a row into `business_trace_jobs` via admin client (requires the new `AsyncRecoveryContext` param from the calling route) and stamps `pending_business_trace` on the returned `AIResearchResult`.
2. `/api/v1/research/single` reads `pending_business_trace`, looks up the inserted row by `fastappend_queue_id`, and returns `business_trace_pending: true` + `business_trace_job_id` in the response body (and in the `research.completed` webhook).
3. Every 5 minutes, `/api/cron/sweep-business-traces` picks up pending jobs, polls FastAppend, downloads results, updates the job row, merges contacts into `trace_history.ai_research` (appends to `decision_makers`, promotes `owner_name` if the AI didn't find one, adds a `business_trace_contacts` sidecar payload), and fires a `business_trace.completed` webhook.
4. Agents can also poll `GET /api/v1/research/status?job_id=<uuid>` to retrieve the merged result on demand.
5. Pending jobs older than 24 hours are automatically marked as errored.

### Files changed

- `supabase/migrations/20260409_business_trace_jobs.sql` (new)
- `types/index.ts`
- `lib/ai-research/client.ts`
- `app/api/v1/research/single/route.ts`
- `app/api/research/single/route.ts`
- `app/api/cron/sweep-business-traces/route.ts` (new)
- `app/api/v1/research/status/route.ts` (new)
- `vercel.json`
- `app/(dashboard)/settings/api-keys/docs/page.tsx`
- `docs/AGENT_INTEGRATION.md` (new)
- `History.md`

### Not changed

- Billing stays on the initial request (`ai_research_charge` deducted when the AI finds an owner). Delayed merges only enrich contact data.
- The session-authed `/api/research/single` endpoint still records pending jobs silently — the dashboard UI doesn't yet render a "pending business trace" indicator. Future enhancement.
- `researchPropertyBatch()` (used by `/api/research/bulk`) does **not** trigger async recovery. It doesn't call `resolveEntityChain()` — it's a Claude-only batch path. If bulk-with-entity-resolution is ever added, it would need to accept the same `AsyncRecoveryContext`.

### To deploy

1. Run the new migration: `supabase/migrations/20260409_business_trace_jobs.sql`.
2. Deploy to Vercel — the new cron `/api/cron/sweep-business-traces` will auto-register from `vercel.json`.
3. Confirm `CRON_SECRET` env var is set (same one used by `sweep-stale-traces`).
4. Confirm `FASTAPPEND_API_KEY` env var is set.

### Agent usage summary (for the Cowork agent's instructions)

1. Call `POST /api/v1/research/single` with property address.
2. If response has `business_trace_pending: true`, capture `business_trace_job_id`.
3. Either listen for the `business_trace.completed` webhook at your configured webhook URL, **or** poll `GET /api/v1/research/status?job_id=<id>` every 30–60 seconds.
4. When `status` becomes `completed`, use the `contacts` field (owner_name, phones, emails, address) and/or the merged `research` object.
5. Full instructions in `docs/AGENT_INTEGRATION.md`.

## Notes
- Only the v1 API-key endpoint returns `business_trace_pending` in the response (agents use that endpoint). The session-authed `/api/research/single` just records the pending job silently — the dashboard UI does not need the pending-state plumbing.
- Inline polling is preserved → fast cases stay fast.
- `business_trace.completed` is a new webhook event (distinct from `research.completed`) so agents can filter.
- Billing unaffected — `ai_research_charge` is deducted on the initial request; delayed merge only enriches contact data.
