# Fix: Single Trace 500 When Owner Name Changes

## Problem
`UNIQUE(user_id, address_hash)` constraint on `trace_history` means only one trace per address per user can exist. When the AI Agent does a 2-step flow (trace with LLC name, then re-trace same address with resolved person name), the second INSERT hits a unique constraint violation → 500 error.

The v1 single route only cleans up successful-no-data and failed traces before inserting. It does NOT clean up active processing records. The internal route handles stale processing (10+ min), but a trace from seconds ago isn't stale.

## Root Cause
`app/api/v1/trace/single/route.ts` is missing cleanup of existing processing records before inserting a new trace with a different owner name.

## Fix
When the new request has a different `owner_name` than the existing record, delete the old record and allow the new trace. This applies to both the v1 and internal routes.

## Tasks
- [x] Investigate dedup/constraint logic
- [x] Identify root cause: UNIQUE constraint + missing processing record cleanup
- [x] Fix v1 single route: add owner_name-aware cleanup before insert
- [x] Fix internal single route: same change for consistency
- [x] Update History.md
