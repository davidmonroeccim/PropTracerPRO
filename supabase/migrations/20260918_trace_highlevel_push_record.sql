-- Record that a trace reached the customer's HighLevel CRM. 2026-09-18.
--
-- WHY THIS EXISTS. PTP has pushed contacts to HighLevel since January and has
-- never recorded that it happened. `contactId` comes back from the client and is
-- dropped by all seven callers, so "did this trace reach the CRM" has always been
-- unanswerable after the fact. That was tolerable while push was a side effect.
-- It is not tolerable now that reaching the CRM is the stated requirement: there
-- would be no way to demonstrate the thing works for any given row.
--
-- It also does two jobs beyond reporting:
--   * A tier 2 row can be observed by more than one settle path. Without a
--     recorded push, avoiding a double push rests on a filter matching a code
--     path; with one it rests on a FACT about the row.
--   * A push that failed is currently indistinguishable from one that never ran,
--     so no retry can ever be written.
--
-- GRANTS. Audited AS ADMIN from the table ACL itself, not from
-- information_schema.column_privileges, which expands a table-wide grant into one
-- row per column and therefore CANNOT answer whether a NEW column is covered.
-- That distinction cost a wrong comment on the previous migration; see L-017.
--
--   select unnest(relacl)::text from pg_class where oid='public.trace_history'::regclass;
--     anon=rDxtm/postgres   authenticated=rDxtm/postgres   service_role=arwdDxtm/postgres
--
-- r=SELECT a=INSERT w=UPDATE d=DELETE D=TRUNCATE x=REFERENCES t=TRIGGER m=MAINTAIN.
--
--   * anon and authenticated hold `r` and NOT `a`, `w` or `d`. So these columns
--     are readable by the browser and writable only by the server. That is the
--     required outcome, and it is the state 20260918_lock_trace_history_writes.sql
--     established: before it, any signed-in user could rewrite `charge` from the
--     console.
--   * SELECT is TABLE-WIDE, so these columns are readable the moment they exist.
--     NO EXPLICIT GRANT IS WRITTEN HERE, deliberately. The previous migration
--     added a redundant GRANT SELECT under the mistaken belief that column grants
--     were in force; repeating it would propagate the same misreading.
--   * Noted, not changed: both roles retain `D` (TRUNCATE), left over from
--     Supabase's default grants and untouched by the July remediation, which
--     revoked INSERT/UPDATE/DELETE only. NOT reachable today, because PostgREST
--     exposes no TRUNCATE and `anon`/`authenticated` are NOLOGIN so they cannot
--     take a direct Postgres session. Recorded because TRUNCATE also BYPASSES
--     RLS, so if either premise ever changes this is not protected by the
--     policies the way a DELETE would be.
--
-- No function is created, so the REVOKE-by-name rule in CLAUDE.md does not apply.

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS highlevel_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS highlevel_pushed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS highlevel_push_action TEXT;

COMMENT ON COLUMN public.trace_history.highlevel_contact_id IS
  'The HighLevel contact id this trace was pushed into. NULL means no successful push has been recorded, which is NOT the same as "never attempted": a failed push also leaves this NULL. Written only by the server.';

COMMENT ON COLUMN public.trace_history.highlevel_pushed_at IS
  'When the successful push happened. Set together with highlevel_contact_id; a row with one and not the other is a bug, not a state.';

COMMENT ON COLUMN public.trace_history.highlevel_push_action IS
  'created or updated, as reported by HighLevel. Distinguishes a new contact from an update to one the customer already had, which is the difference between us adding to their CRM and us touching a record they own.';

-- Finding rows that have not reached the CRM. Partial, because the rows that
-- HAVE been pushed are the ones we never need to look up this way, and they will
-- eventually be the overwhelming majority.
CREATE INDEX IF NOT EXISTS trace_history_unpushed_idx
  ON public.trace_history (user_id, created_at DESC)
  WHERE highlevel_pushed_at IS NULL AND is_successful = true;

-- VERIFY AFTER APPLYING. Expected: sel true/true, upd false/false.
--   select r.rolname,
--          has_column_privilege(r.rolname,'public.trace_history','highlevel_contact_id','SELECT') as sel,
--          has_column_privilege(r.rolname,'public.trace_history','highlevel_contact_id','UPDATE') as upd
--     from pg_roles r where r.rolname in ('anon','authenticated');
