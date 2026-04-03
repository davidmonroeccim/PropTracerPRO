# Fix Single Trace Stuck in Processing

## Problem
When Tracerfy finishes processing but returns no useful data (empty results array or only padding rows), the status routes keep returning `processing` instead of finalizing the trace as `no_match`. This causes the UI to spin indefinitely.

## Root Cause
In both `/api/trace/status/route.ts` and `/api/v1/trace/status/route.ts`, when `statusResult.pending === false` but results are empty or only contain padding rows, the code returned `status: 'processing'` instead of falling through to the finalization logic which would mark it as `no_match`.

## Tasks
- [x] Fix `/api/trace/status/route.ts` — finalize as `no_match` when Tracerfy is done but results are empty/padding-only
- [x] Fix `/api/v1/trace/status/route.ts` — same fix for the API route
- [x] Verify the cron sweep handles this case correctly (it already does — marks as error after 60 min)

## Review
**Changes:** Removed early-return `processing` responses for empty/padding-only results in both status routes. Now when Tracerfy has finished (`pending: false`) but returned no useful data, the code falls through to the existing finalization logic which correctly sets `status: 'no_match'`, charges $0, and returns the result to the client.

**Files changed:**
- `app/api/trace/status/route.ts` — removed lines 96-122 (two early returns for empty/padding results)
- `app/api/v1/trace/status/route.ts` — same change

**Impact:** Minimal. Only affects the case where Tracerfy has completed processing but found no contact data. Previously these traces would spin for up to 60 minutes then get marked `error` by the cron sweep. Now they correctly finalize as `no_match` immediately on the next status poll.
