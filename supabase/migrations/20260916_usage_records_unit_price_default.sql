-- 2026-09-16 pricing change: usage_records.unit_price default 0.07 -> 0.15
--
-- APPLIED 2026-09-17 to rmmwkjmjchpfebxroyoo. Verified: the default is now 0.15.
--
-- The original warning below was written on the assumption that a stale default could
-- disagree with running code. It cannot here: `usage_records` has ZERO writers anywhere
-- in the codebase, so this column default is unreachable and the change is inert either
-- way. Applied ahead of the deploy on that basis.
-- The old default (0.07) is baked into the LIVE database. Applying this migration
-- while production still runs the old code makes new prod rows disagree with the
-- code that wrote them. Apply it in the same window as the deploy, not before.
--
-- WHAT THIS IS
-- usage_records.unit_price is the Stripe metered-billing line item price. The
-- column default only fires when an INSERT omits unit_price; every current
-- writer passes the value explicitly, so this default is a safety net rather
-- than the billing path. Updating it keeps the net consistent with the new
-- tier 1 pro/grant rate (PRICING.CHARGE_PER_SUCCESS).
--
-- WHAT THIS IS NOT
-- This is NOT the tier 2 per-record price. Tier 2 (PRICING.TIER2_PER_RECORD_SUBMITTED_PRO
-- / _WALLET) bills per record submitted and has no column default here.
-- This is also NOT the Pay-As-You-Go per-success rate (0.25); a single column
-- default cannot express a plan-keyed rate, and the writers already pass the
-- caller's actual rate.
--
-- EXISTING ROWS ARE LEFT ALONE ON PURPOSE. They record what was actually billed
-- at the time and rewriting them would falsify billing history.

ALTER TABLE public.usage_records
  ALTER COLUMN unit_price SET DEFAULT 0.15;

-- No GRANT changes: usage_records already exists and this migration adds no new
-- table, function, or sequence, so the 2026-10-30 Data API grant rule does not apply.
