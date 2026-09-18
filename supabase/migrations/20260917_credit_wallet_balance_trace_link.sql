-- Full Property Trace, phase 5b: a refund can finally name the row it refunds.
-- 2026-09-17.
--
-- ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────
-- Two settle sites refund a historical AI-research fee and then ask
-- collectedChargeFor() what the row has already collected, so they do not
-- double-charge it:
--
--   app/api/cron/sweep-business-traces/route.ts   (refund, then probe)
--   lib/trace/settleBulkJob.ts                    (refund, then probe)
--
-- The probe sums `wallet_transactions` WHERE trace_history_id = the row AND
-- type = 'debit'. The refund it just issued is a CREDIT, and credits had no
-- way to name a trace_history row at all -- this function simply did not take
-- the id. So the money handed back stayed on the books as collected: the probe
-- answered with the refunded fee, the deduct was SKIPPED, and the customer
-- received the contacts free while `trace_history.charge` reported an amount
-- that had been returned to their wallet.
--
-- Fixing it at the two call sites was the other option and was rejected. The
-- invariant "a refund is not a collection" would then live in two hand-written
-- subtractions, and the third site to refund would get it wrong -- which is
-- exactly the pattern that produced this defect. Linking the credit makes the
-- ledger self-consistent, so every present and future reader nets correctly
-- without knowing this story.
--
-- ── WHY DROP AND RECREATE RATHER THAN ADD AN OVERLOAD ────────────────────────
-- Adding a 5th parameter creates a NEW signature; the 4-arg version would
-- survive alongside it. Two functions that mint wallet balance, one of which
-- silently cannot link its credit, is a trap with a shelf life. One function.
--
-- SAFE IN BOTH DEPLOY ORDERS, which is why it may be applied ahead of the
-- deploy. `p_trace_history_id` defaults to NULL and Postgres resolves a call
-- that omits it, so the currently-released code -- which passes the same four
-- named arguments it always has -- binds to this function and behaves exactly
-- as before. The Stripe webhook (app/api/stripe/webhook/route.ts:85,150) is a
-- genuine wallet top-up, not a refund against any row, and must keep passing
-- four arguments forever. A NULL here is the honest value for it.
--
-- ── SECURITY. READ BEFORE EDITING. ───────────────────────────────────────────
-- This function ADDS MONEY to a wallet and is SECURITY DEFINER. The live ACL on
-- the function it replaces, read from pg_proc before writing this file, is
-- exactly:
--     postgres=X/postgres | service_role=X/postgres
-- PUBLIC is absent, which is NOT the Postgres default -- a newly created
-- function is granted EXECUTE to PUBLIC automatically. So the REVOKE below is
-- load-bearing, not boilerplate: without it this migration would WIDEN a
-- balance-minting function to every role including `anon`, and the anon key
-- ships in the browser bundle. That is the self-write vuln class in CLAUDE.md,
-- pointed at the wallet.
--
-- Never grant this to `authenticated` or `anon`. Server-side only, forever.

DROP FUNCTION IF EXISTS public.credit_wallet_balance(UUID, DECIMAL(10,2), VARCHAR(100), TEXT);

CREATE FUNCTION public.credit_wallet_balance(
  p_user_id UUID,
  p_amount DECIMAL(10,2),
  p_stripe_payment_intent_id VARCHAR(100) DEFAULT NULL,
  p_description TEXT DEFAULT 'Wallet credit',
  -- NEW. The trace_history row this credit belongs to, when it is a refund of
  -- money collected against that row. NULL for a top-up, which belongs to no row.
  p_trace_history_id UUID DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
  v_current_balance DECIMAL(10,2);
BEGIN
  -- Get current balance with row lock
  SELECT wallet_balance INTO v_current_balance
  FROM user_profiles
  WHERE id = p_user_id
  FOR UPDATE;

  -- Add to balance
  UPDATE user_profiles
  SET wallet_balance = wallet_balance + p_amount,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Record transaction. trace_history_id is the only addition; every other
  -- column is written exactly as before.
  INSERT INTO wallet_transactions (
    user_id, type, amount, balance_before, balance_after,
    description, stripe_payment_intent_id, trace_history_id
  )
  VALUES (
    p_user_id, 'credit', p_amount, v_current_balance, v_current_balance + p_amount,
    p_description, p_stripe_payment_intent_id, p_trace_history_id
  );

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── GRANTS. A NEW SIGNATURE IS A NEW FUNCTION AND CARRIES NONE. ──────────────
-- Per CLAUDE.md: CREATE OR REPLACE on a pre-existing signature inherits grants;
-- a new argument signature does not. This one is new, so every statement below
-- is required.
--
-- ⚠ `REVOKE ... FROM PUBLIC` ALONE IS NOT ENOUGH ON SUPABASE, AND THE FIRST
--   VERSION OF THIS FILE GOT IT WRONG. Applied on 2026-09-17 with only the
--   PUBLIC revoke, this function came back reading:
--
--     postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres
--
--   A balance-minting SECURITY DEFINER function, callable by `anon`, whose key
--   ships in the browser bundle, taking p_user_id and p_amount as arguments.
--   Caught by reading the ACL back rather than trusting the migration, revoked
--   about two minutes later, and audited: 0 transactions in the window and the
--   ledger byte-identical to the pre-migration snapshot (2,919 rows, 30 credits,
--   $688.70 total balance). Nothing was exploited.
--
--   THE REASON, and it is the trap: Supabase ships ALTER DEFAULT PRIVILEGES that
--   grant EXECUTE on new `public` functions to `anon` and `authenticated`. Those
--   arrive as EXPLICIT grants at CREATE time, and `REVOKE FROM PUBLIC` does not
--   touch an explicit grant to a named role. You must revoke each role BY NAME.
--   `20260717_repair_default_privileges.sql` exists because of this same
--   machinery.
--
-- ALWAYS READ THE ACL BACK after a migration that creates a function. The
-- migration succeeding tells you nothing about who can call the result.
REVOKE ALL ON FUNCTION public.credit_wallet_balance(UUID, DECIMAL(10,2), VARCHAR(100), TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.credit_wallet_balance(UUID, DECIMAL(10,2), VARCHAR(100), TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.credit_wallet_balance(UUID, DECIMAL(10,2), VARCHAR(100), TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet_balance(UUID, DECIMAL(10,2), VARCHAR(100), TEXT, UUID) TO service_role;

-- VERIFIED LIVE 2026-09-17 after the revokes. Re-run this to confirm; the
-- expected output is exactly `postgres=X/postgres | service_role=X/postgres`,
-- which matches the 4-arg function this replaced, read from pg_proc beforehand.
--
--   select p.oid::regprocedure::text,
--          coalesce(array_to_string(p.proacl,' | '),'PUBLIC-DEFAULT') as acl
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'credit_wallet_balance';
