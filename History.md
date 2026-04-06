# PropTracerPRO — Project History

A running log of completed tasks, changes, and decisions. Updated after every task.

---

## 2026-04-06

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
