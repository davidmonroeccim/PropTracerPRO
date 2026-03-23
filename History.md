# PropTracerPRO — Project History

A running log of completed tasks, changes, and decisions. Updated after every task.

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
