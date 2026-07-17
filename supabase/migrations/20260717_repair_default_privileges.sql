-- 20260717_repair_default_privileges.sql — PropTracerPRO (rmmwkjmjchpfebxroyoo)
-- Phase 2 systemic (recurrence prevention). Companion to the 2026-07-16 wallet/entitlement column locks.
--
-- THE HOLE THIS CLOSES: the legacy `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public`
-- grants ALL table DML (arwdDxtm) to anon + authenticated on every FUTURE public table, so a new
-- table created without RLS is instantly world-writable via the browser anon key (the recurrence
-- engine behind the suite-wide self-write vuln class). This revokes the write verbs from that
-- default, so new tables are locked-by-default and require an explicit GRANT.
--
-- SCOPE: affects only tables created AFTER this runs. EXISTING tables and their grants are UNCHANGED
-- (user_profiles was already column-locked separately). service_role default is untouched. Idempotent.
--
-- RESIDUAL (not closed here): a parallel `supabase_admin`-owned default ACL carries the same grant but
-- needs elevated access to alter; it only affects Supabase-internal tables (app tables are postgres-owned).

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;
