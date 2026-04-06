# Fix API 401 — Bulk Trace Auth Returning Invalid API Key

## Problem
API key returning 401 "Invalid API key" even though the key is correct. The auth code in `lib/api/auth.ts` swallows all Supabase query errors (connection failures, bad service role key, etc.) and returns a generic "Invalid API key" message, making the real cause invisible.

## Root Cause
At `lib/api/auth.ts:54`, `if (error || !profile)` treats Supabase query errors identically to "key not found." If the service role key is misconfigured, the DB is unreachable, or any query-level error occurs, the user gets "Invalid API key" (401) instead of a meaningful error.

## Tasks
- [x] Investigate auth flow (`lib/api/auth.ts`)
- [x] Identify root cause: Supabase errors swallowed as "Invalid API key"
- [x] Fix: Log Supabase errors server-side, return 500 for query failures vs 401 for actual bad keys
- [x] Update History.md
