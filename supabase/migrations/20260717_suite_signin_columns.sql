-- 20260717_suite_signin_columns.sql — PropTracerPRO Suite sign-in (Track A)
-- ADDITIVE ONLY. No RLS policy created/altered/dropped. No FK changes.
-- Rollback is the NEXT_PUBLIC_SUITE_SIGNIN_ENABLED flag, not a down-migration.
--
-- GRANTS: user_profiles was column-locked on 2026-07-16 (REVOKE UPDATE/INSERT/DELETE FROM
-- authenticated,anon; GRANT UPDATE(<wallet/profile cols>)). Table-level SELECT to authenticated was
-- NOT revoked, so the new columns are readable by the browser session client. The gateway_* columns
-- are deliberately NOT added to the authenticated UPDATE grant: only service_role writes them (the
-- snapshot path in the Suite callback + the TTL refresh). Verify with the has_column_privilege check
-- in the plan's Task 2 before/after this runs.
--
-- APPLY: held until pre-canary/pre-merge (via `supabase db query --linked --file`), together with the
-- gateway prerequisites. Additive + dormant (nothing reads these columns until the flag flips).

alter table public.user_profiles
  add column if not exists gateway_sub text,
  add column if not exists gateway_products text[] not null default '{}',
  add column if not exists gateway_products_checked_at timestamptz;

-- One gateway identity maps to at most one PTP account: makes the "refuse on conflict" linking rule
-- enforceable at the database level.
create unique index if not exists user_profiles_gateway_sub_key
  on public.user_profiles (gateway_sub)
  where gateway_sub is not null;

-- The email lookup fails closed on a multi-row result; a case-variant duplicate would lock that
-- address out of Suite sign-in. GoTrue lowercases auth.users.email and the handle_new_user trigger
-- copies it verbatim, so this enforces an invariant that already holds.
create unique index if not exists user_profiles_email_lower_key
  on public.user_profiles (lower(email))
  where email is not null;

comment on column public.user_profiles.gateway_sub is
  'Suite Gateway auth.users.id. Authoritative for identity after first link.';
