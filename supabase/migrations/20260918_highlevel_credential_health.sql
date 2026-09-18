-- HighLevel credential health, 2026-09-18.
--
-- WHY THIS EXISTS. Five of the six HighLevel push sites run with no user watching
-- (two poll routes, two v1 poll routes, one cron). When the stored credential is
-- dead, those paths have nowhere to report it: today the failure reaches a
-- console.error and stops. These two columns are that missing channel. A 401 or
-- 403 on ANY push path marks the credential dead here, and the integrations page
-- reads it, so the user finds out on a page they will visit rather than not at all.
--
-- THE DISTINCTION THIS ENCODES, and it is the whole point: a 401 is a CREDENTIAL
-- failure, not a trace failure. A 422 means this one payload was bad and the
-- credential is fine. A 429 means nothing is broken. Only the credential class
-- writes here. See tasks/todo.md, "PLAN: The HighLevel push bugs (2026-09-18)".
--
-- GRANTS. Read BEFORE writing this file, not after, per L-014: adding a column to
-- a table whose grants you have not read is a privilege decision, not a schema
-- decision. Audited with has_table_privilege() / has_column_privilege() AS ADMIN,
-- never information_schema.role_table_grants, which is filtered by querying role.
--
-- CORRECTION, MADE AFTER APPLYING AND READING THE ACL BACK. An earlier version of
-- this header said UPDATE, INSERT and SELECT were all "column-listed" on this
-- table, and concluded that a new column would be invisible to the browser unless
-- granted here. THAT WAS WRONG, and the way it was wrong is worth recording.
--
-- I read information_schema.column_privileges, saw one row per column per verb,
-- and read that as column-scoped grants. It is not: that view expands a TABLE
-- level grant into one row per column, so a table-wide grant and 28 individual
-- column grants look identical in it. The authority is the table ACL itself:
--
--   select unnest(relacl)::text from pg_class where oid='public.user_profiles'::regclass;
--     postgres=arwdDxtm/postgres
--     anon=ardDxtm/postgres
--     authenticated=ardDxtm/postgres
--     service_role=arwdDxtm/postgres
--
-- Read those letters. a=INSERT r=SELECT w=UPDATE d=DELETE D=TRUNCATE x=REFERENCES
-- t=TRIGGER m=MAINTAIN. What this actually means:
--
--   * UPDATE (w) is ABSENT for anon and authenticated, and present for
--     service_role. This is the guarantee that matters and it HOLDS: the new
--     columns are not updatable from the browser, so only the server can declare
--     a credential dead or healthy, and a user cannot clear their own red badge.
--     Confirmed by has_column_privilege() AS ADMIN after applying: upd false for
--     both roles, true for service_role.
--   * SELECT (r) and INSERT (a) are TABLE-WIDE, so they already covered these
--     columns the moment they existed. The GRANT SELECT below is therefore a
--     REDUNDANT no-op. It is kept only as documentation of intent; do not read it
--     as the thing that made the columns readable. The worry it was written to
--     answer, that select('*') from the browser would 42501 on an ungranted
--     column, could never have happened.
--   * INSERT being table-wide means the new columns ARE insertable by anon and
--     authenticated, which the earlier header denied. It does not matter, for the
--     same reason the privileged columns below do not matter, but the earlier
--     claim was false and a future reader must not rely on it.
--   * DELETE (d) is granted table-wide to BOTH anon and authenticated. Blocked
--     today only because RLS is enabled and there are ZERO DELETE policies, so
--     every delete is denied by default. Verified: relrowsecurity true, 0 policies
--     with cmd='DELETE'. NOTE THE DEPENDENCY: adding any permissive DELETE policy
--     to this table would immediately let a signed-in user delete their own
--     profile row, taking wallet_balance and subscription_tier with it.
--   * INSERT reaches privileged columns (subscription_tier, wallet_balance,
--     is_acquisition_pro_member). That looks like the suite self-write class and
--     it CANNOT fire: trigger on_auth_user_created runs handle_new_user in the
--     same transaction as the auth.users insert, so the profile row always
--     pre-exists any JWT and an INSERT conflicts on the PK (verified: 53 auth
--     users, 53 profiles). Recorded, not changed, because it is outside this fix.
--     NOTE THE DEPENDENCY, which is the part a deferral usually omits: this is
--     safe BECAUSE OF THAT TRIGGER. If it is ever dropped, made non-transactional,
--     or moved into application code, privileged columns become self-insertable
--     at signup.
--   * The "Users can update own profile" RLS policy is dead, since the UPDATE
--     grant it depends on is absent. Left alone deliberately: re-granting the verb
--     to make it work would silently re-open table-wide writes. Same residual as
--     20260918_lock_trace_history_writes.sql.
--
-- THE GENERAL LESSON, since it nearly shipped as a confident and wrong comment:
-- information_schema.column_privileges cannot distinguish a table-wide grant from
-- a set of column grants, so it cannot answer "will a NEW column be covered".
-- Only the relacl letters can. This is a cousin of the known trap that
-- information_schema.role_table_grants is filtered by querying role.
--
-- No function is created, so the REVOKE-by-name rule in CLAUDE.md does not apply.
-- ALTER TABLE ADD COLUMN on a pre-existing table needs no new INSERT/UPDATE grants.

-- WHY A REASON COLUMN AND NOT JUST THE STATUS. An earlier draft of this migration
-- stored only the HTTP status, on the assumption that 401 meant a revoked token and
-- 403 meant a missing scope. That assumption is WRONG and was corrected against
-- HighLevel's live docs on 2026-09-18:
--
--   revoked / invalid token  401  {"message":"Invalid JWT"}
--   missing scope            401  {"message":"The token is not authorized for this scope."}
--   wrong location           403  {"message":"The token does not have access to this location."}
--
-- Two of the three are the SAME STATUS, so the status cannot carry the remediation
-- and the reason has to be derived from the response body and stored separately.
-- This is not cosmetic: the three fixes are "paste a new token", "tick a scope you
-- did not tick", and "correct your location id". Telling a user to replace a token
-- that is actually fine is the wrong instruction, and it is the one a status-only
-- design would give for a scope problem.
--
-- 'unknown' is a first-class value here, not a failure of the classifier. The scope
-- message string is sourced from a developer-forum report rather than from official
-- docs, so if HighLevel changes the wording the correct behaviour is to record
-- 'unknown' and show a generic credential failure. Never guess a specific
-- remediation we cannot prove (repo rule 7).

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS highlevel_invalid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS highlevel_invalid_status INTEGER,
  ADD COLUMN IF NOT EXISTS highlevel_invalid_reason TEXT;

COMMENT ON COLUMN public.user_profiles.highlevel_invalid_at IS
  'Set when a HighLevel push returned a credential-class failure. NULL means healthy. Cleared when a credential validates on save. Written only by the server; anon and authenticated have no UPDATE grant on this table.';

COMMENT ON COLUMN public.user_profiles.highlevel_invalid_status IS
  'The HTTP status that invalidated the credential. Kept for diagnosis only. It does NOT identify the remediation: a revoked token and a missing scope are both 401. Use highlevel_invalid_reason for anything user-facing.';

COMMENT ON COLUMN public.user_profiles.highlevel_invalid_reason IS
  'Which credential failure it was, derived from the response body: token (rejected, paste a new one), scope (token lacks contacts.write), location (token has no access to this location id), or unknown (unrecognised body, show a generic message). Never infer a specific reason that was not matched.';

-- REDUNDANT, and kept deliberately. SELECT is already table-wide for both roles
-- (relacl 'r'), so these columns were readable the moment they existed and this
-- statement changes nothing. It stays as a statement of intent: read yes, write
-- no. See the CORRECTION block above before citing it as load-bearing.
GRANT SELECT (highlevel_invalid_at, highlevel_invalid_status, highlevel_invalid_reason)
  ON public.user_profiles TO anon, authenticated;

-- DELIBERATELY NOT GRANTED: INSERT or UPDATE on these columns to anon or
-- authenticated. service_role already holds table-wide UPDATE and needs nothing
-- here. If a future migration grants either verb on this table, it re-opens the
-- ability for a user to clear their own credential-dead flag from the browser.

-- VERIFY AFTER APPLYING. A migration reporting success tells you nothing about who
-- can write the result. Expected: select true/true, update false/false.
--   select r.rolname,
--          has_column_privilege(r.rolname,'public.user_profiles','highlevel_invalid_at','SELECT') as sel,
--          has_column_privilege(r.rolname,'public.user_profiles','highlevel_invalid_at','UPDATE') as upd
--     from pg_roles r where r.rolname in ('anon','authenticated');
