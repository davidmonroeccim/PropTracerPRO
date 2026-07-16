-- Restrict which user_profiles columns an end user may write.
--
-- THE HOLE THIS CLOSES (verified live on rmmwkjmjchpfebxroyoo, 2026-07-16):
--   1. Policy "Users can update own profile" is USING (auth.uid() = id) with NO WITH CHECK.
--      Postgres then reuses USING as the check, so the updated row only has to still belong
--      to the caller. NOTHING constrains WHICH COLUMNS changed.
--   2. `authenticated` held table-wide UPDATE, including wallet_balance.
--   3. RLS is enabled, so RLS was the only gate -- and it was not gating columns.
--
-- Net effect: any logged-in user could run, straight from the browser console,
--
--     await supabase.from('user_profiles')
--       .update({ wallet_balance: 100000, subscription_tier: 'pro',
--                 is_acquisition_pro_member: true })
--       .eq('id', myUserId)
--
-- ...and it succeeded. No Stripe, no payment, no webhook. wallet_balance IS the source of
-- truth (deduct_wallet_balance reads the column directly; wallet_transactions is audit-only
-- and is never reconciled against it), so the fake money spends exactly like real money and
-- leaves no anomaly any code checks. PropTracerPRO then pays Tracerfy ~$0.009/record for real.
--
-- The Supabase Data API is a PUBLIC endpoint and the anon key ships in the JS bundle by
-- design, so the app's UI is not a boundary: the top-up form and Stripe were never bypassed
-- because they were broken, but because nothing REQUIRED them.
--
-- WHY COLUMN GRANTS (not a WITH CHECK): a WITH CHECK can only inspect the NEW row, so it
-- cannot tell "user set wallet_balance to 100000" from "wallet_balance was already 100000".
-- Column-level privileges are the mechanism that actually says "you may not write this
-- column at all".
--
-- SAFE FOR EVERY SERVER PATH: all server writes to user_profiles use createAdminClient()
-- (service_role), which these REVOKEs do not touch -- Stripe webhook, API-key generation,
-- HighLevel save/disconnect, stripe_customer_id capture, /api/v1 webhook_url, and the three
-- Vercel crons. deduct_wallet_balance / credit_wallet_balance are SECURITY DEFINER and run
-- as the owner, so debits, credits and auto-rebill are unaffected.
--
-- The granted list below is EXACTLY the columns the five browser writes touch:
--   app/(auth)/onboarding/page.tsx:73          company_name, primary_use_case, onboarding_completed
--   app/(dashboard)/settings/profile/page.tsx:54    company_name
--   app/(dashboard)/settings/api-keys/page.tsx:87   webhook_url
--   app/(dashboard)/settings/integrations/page.tsx:171  webhook_url
--   app/(dashboard)/settings/billing/page.tsx:130   wallet_auto_rebill_{enabled,amount}, wallet_low_balance_threshold
--
-- onboarding/page.tsx ALSO wrote is_acquisition_pro_member + acquisition_pro_verified_at.
-- That write is deliberately NOT granted: the browser must never decide its own entitlement.
-- It moves server-side to app/api/verify-member/route.ts, which already verifies honestly
-- against HighLevel's sp3-owner tag and now persists its own verdict via service_role.
--
-- Idempotent: REVOKE/GRANT/ALTER POLICY may be re-run safely.

BEGIN;

-- 1. Drop the blanket UPDATE. anon is revoked too: RLS already blocks it (auth.uid() is
--    NULL for anon, so USING fails), but a privilege that is never legitimately used should
--    not be held.
REVOKE UPDATE ON public.user_profiles FROM authenticated;
REVOKE UPDATE ON public.user_profiles FROM anon;

-- 2. Grant back ONLY the user-editable fields.
--    Deliberately NOT granted, and why:
--      wallet_balance             -- money. The whole point.
--      subscription_tier          -- entitlement + selects the per-trace rate ($0.07/$0.11).
--      is_acquisition_pro_member  -- entitlement + rate. Server-verified only, from now on.
--      acquisition_pro_member_id / acquisition_pro_verified_at -- ditto.
--      api_key / api_key_created_at -- self-issuing an API key bypasses the /api/v1 gate.
--      webhook_secret             -- forging it lets a caller spoof our webhook signatures.
--      highlevel_api_key / highlevel_location_id -- third-party credentials.
--      stripe_customer_id / stripe_subscription_id -- repointing these at another customer
--                                    is an attack on someone else's billing.
--      wallet_payment_method_id / wallet_last_rebill_at -- auto-rebill charges a real card.
--      id / email                 -- identity.
--      created_at / updated_at    -- set by trigger/default, never by a user.
GRANT UPDATE (
  company_name,
  primary_use_case,
  onboarding_completed,
  webhook_url,
  wallet_auto_rebill_enabled,
  wallet_auto_rebill_amount,
  wallet_low_balance_threshold
) ON public.user_profiles TO authenticated;

-- 3. Make the check explicit. This is behavior-identical to the current implicit fallback
--    (USING is reused as the check when WITH CHECK is absent), so it grants nothing new and
--    closes nothing on its own -- the column grants above are the actual fix. It is stated
--    so a future reader cannot mistake the omission for a deliberate choice.
ALTER POLICY "Users can update own profile" ON public.user_profiles
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

COMMIT;
