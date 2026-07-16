-- Revoke PUBLIC / anon / authenticated EXECUTE on the SECURITY DEFINER wallet functions.
--
-- THE HOLE THIS CLOSES (verified live on rmmwkjmjchpfebxroyoo, 2026-07-16):
--   credit_wallet_balance() and deduct_wallet_balance() are SECURITY DEFINER, so they run
--   as their owner (postgres), which owns user_profiles and bypasses that table's RLS AND
--   the column grants added in 20260716_restrict_user_profiles_column_grants.sql. Both
--   functions were created with no `REVOKE EXECUTE ... FROM PUBLIC`, so they inherited
--   Postgres's default PUBLIC EXECUTE. proacl for all three was:
--     {=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}
--   The leading `=X` (PUBLIC) plus the explicit anon/authenticated grants meant the public
--   anon key -- which ships in the browser bundle by design -- could call, with NO login:
--     rpc('credit_wallet_balance', {p_user_id: <any id>, p_amount: 100000})    -> mint money
--     rpc('deduct_wallet_balance', {p_user_id: <any id>, p_amount: -100000})   -> mint (negative amount is unguarded)
--     rpc('deduct_wallet_balance', {p_user_id: <victim>,  p_amount: <balance>}) -> drain any user
--   wallet_balance is the source of truth (deduct_wallet_balance reads the column;
--   wallet_transactions is audit-only and never reconciled), so a forged balance spends like
--   real money and PTP pays Tracerfy / FastAppend / LLM vendors for it. This bypassed the
--   column-grant fix entirely: that fix governs direct PostgREST TABLE writes; a SECURITY
--   DEFINER function runs as its owner and is unaffected. We had closed the write path, not
--   the class.
--
-- WHY A REVOKE, NOT A BODY CHECK: removing the capability from the roles that must never
--   hold it is the immediate, surgical close. All 19 in-app callers use createAdminClient()
--   (service_role), which keeps its own explicit EXECUTE grant, so there is NO code change
--   and NO expand-then-contract ordering needed (unlike the table REVOKE in the prior
--   migration, no app path invokes these as anon/authenticated). Hardening the bodies
--   (reject p_amount <= 0; never trust a caller-supplied p_user_id) is a follow-up, not
--   required to close the hole once these roles can no longer invoke the functions.
--
-- check_wallet_needs_rebill() is included for the same reason: same PUBLIC-EXECUTE default,
--   same SECURITY DEFINER, and no browser code calls it.
--
-- Idempotent: REVOKE may be re-run safely. service_role and the owner (postgres) retain
--   EXECUTE, so debits, credits, and the auto-rebill check keep working server-side.

BEGIN;

REVOKE EXECUTE ON FUNCTION
  public.credit_wallet_balance(uuid, numeric, character varying, text)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.deduct_wallet_balance(uuid, numeric, uuid, text)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.check_wallet_needs_rebill(uuid)
  FROM PUBLIC, anon, authenticated;

COMMIT;
