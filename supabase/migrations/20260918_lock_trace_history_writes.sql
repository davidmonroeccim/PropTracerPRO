-- SECURITY: take browser write access off public.trace_history.
-- 2026-09-18. David approved this specific change after the finding below.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
-- trace_history granted INSERT, UPDATE and DELETE to `anon` AND `authenticated`,
-- table-wide, with no column-level ACLs. RLS is enabled but NOT forced, and RLS
-- gates WHICH ROWS while grants gate WHICH COLUMNS. The policy
-- "Users can update own traces" is USING (auth.uid() = user_id) with no
-- WITH CHECK, so any signed-in user could rewrite EVERY column on their own
-- rows straight from the browser console, using the anon key that ships in the
-- JS bundle: charge, tier, is_successful, trace_result, property_record.
--
-- Verified with has_table_privilege() and has_column_privilege() AS AN ADMIN,
-- not with information_schema.role_table_grants, which is filtered to grants
-- the QUERYING role can see and has already hidden one instance of this class
-- in this suite for a month.
--
-- ── WHY IT MATTERED MORE ON 2026-09-18 THAN IT DID IN JULY ──────────────────
-- This is the known, deliberately-deferred remainder of the suite-wide grant
-- remediation of 2026-07-16/17, which locked the profile and wallet tables and
-- deferred the broad REVOKE as backward-incompatible and "not flag-critical".
-- That was sound at the time: every writable column here was a FACT ABOUT A
-- ROW, so the exposure was a user corrupting their own records. It was not
-- theft, because the wallet LEDGER is the source of truth for money collected
-- and collectedChargeFor() reads the ledger, not the row.
--
-- Phase 5c-2 expired that reasoning. It added property_trace_status, and a new
-- column inherits the table's grants automatically. That column is not a fact
-- about a row: it is the TRIGGER sweep-property-traces claims work from.
-- Writing 'queued' into it enqueues PAID vendor work. Combined with
-- deductOrZero collapsing an empty wallet to 0 while still DELIVERING the
-- result, a user with no balance could self-enqueue unlimited tier 2 traces
-- against a Tracerfy credit pool SHARED with every other customer.
--
-- ── WHY THIS IS SAFE, VERIFIED RATHER THAN ASSUMED ──────────────────────────
-- Every write to trace_history in this codebase goes through
-- createAdminClient() (service_role): 17 files, all server-side API routes,
-- crons and lib helpers. The only two browser-side files that touch the table,
-- app/(dashboard)/history/page.tsx and app/(dashboard)/dashboard/page.tsx, use
-- the browser client for SELECT only and contain zero writes. So the browser
-- loses nothing it uses.
--
-- SELECT IS DELIBERATELY KEPT for both roles, which is the change David
-- approved. authenticated genuinely needs it (those two pages read the table
-- under RLS). anon keeps it too: anon's auth.uid() is NULL so the SELECT policy
-- matches no rows and it can already read nothing, but narrowing it is beyond
-- the approved change and is noted below instead.
--
-- DELETE was already unreachable for want of a DELETE policy. It is revoked
-- anyway, because a grant that is only neutralised by the absence of a policy
-- is one CREATE POLICY away from being live.
--
-- ── TWO RESIDUALS, DELIBERATELY NOT TOUCHED HERE ────────────────────────────
-- 1. The RLS policies "Users can insert own traces" and "Users can update own
--    traces" are now dead: no role outside service_role holds the verb they
--    gate, and service_role bypasses RLS. They are LEFT IN PLACE because
--    dropping them is beyond the approved change. Note the hazard: if anyone
--    ever re-grants UPDATE to authenticated, those policies silently re-open
--    exactly this hole. Prefer dropping them when someone next works this table.
-- 2. anon retains SELECT (see above).

REVOKE INSERT, UPDATE, DELETE ON public.trace_history FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.trace_history FROM authenticated;

-- service_role owns every write and is untouched on purpose. Re-stated rather
-- than assumed, so a future reader does not have to go looking for it.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trace_history TO service_role;

-- The browser keeps exactly what it uses.
GRANT SELECT ON public.trace_history TO anon;
GRANT SELECT ON public.trace_history TO authenticated;
