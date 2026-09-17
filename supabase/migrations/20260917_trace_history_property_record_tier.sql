-- Full Property Trace, phase 2: trace_history gains property_record + tier.
-- 2026-09-17. Companion to the code changes in lib/utils/deduplication.ts,
-- lib/trace/billedRows.ts, app/api/trace/single/route.ts,
-- app/api/v1/trace/single/route.ts and app/api/cache/clear/route.ts.
--
-- APPLIED 2026-09-17 to rmmwkjmjchpfebxroyoo, ahead of the deploy, which is the safe
-- direction for this one. Verified independently afterward against a before-snapshot:
-- trace_history 3,836 rows unchanged, wallet_transactions 2,919 unchanged, ai_research
-- 1,301 unchanged, both columns present and nullable, 0 rows backfilled, 0 orphaned
-- wallet references. Idempotent (ADD COLUMN IF NOT EXISTS) but do not re-run casually.
--
-- ORDERING, AND IT IS THE OPPOSITE OF 20260916. That migration must not land
-- BEFORE its deploy, because it changes a value the running code disagrees
-- with. This one adds two NULLABLE columns that no released code reads or
-- writes, so it is harmless to old code -- but the NEW code REQUIRES them:
-- checkSingleDuplicate() and every guarded delete reference property_record by
-- name, and PostgREST answers 42703 "column does not exist" if they are absent.
-- So: apply this in the same deploy window, at or immediately BEFORE the code
-- goes live. Never after. A deploy that ships the code without the columns
-- turns every single-trace submit into a 500.
--
-- ── property_record JSONB ────────────────────────────────────────────────────
-- The RAW `response.property` object from the Tracerfy dossier, verbatim: all
-- 86 keys, not the 46 that held a value in our 24-parcel sample and not the 3
-- the code currently reads. Same rule as the property-registry's
-- raw_attributes: the raw dump IS the product. A key that is empty in OH, CA
-- and UT may be populated in another county, and storing it costs nothing
-- because the $0.20 was already spent to fetch it.
--
-- It is also a BILLING FACT, not just data. Under tier 2 the customer is
-- billed per record SUBMITTED, so a row can carry `is_successful = false` AND
-- `charge > 0`: they bought an 86-field property record, and contacts are a
-- separate step that may return nothing. A non-null property_record is
-- therefore one of the three markers of a row the customer has paid for
-- (charge > 0, ai_research_charge > 0, property_record IS NOT NULL), and the
-- code treats all three identically: such a row is never deleted, and it is
-- always a free cache hit.
--
-- ── tier SMALLINT ────────────────────────────────────────────────────────────
-- Which billing model produced the row. 1 = per successful trace, free on a
-- miss. 2 = per record submitted, billed on a miss.
--
-- It exists because `charge` alone cannot tell them apart:
-- PRICING.CHARGE_PER_SUCCESS_WALLET and PRICING.TIER2_PER_RECORD_SUBMITTED_PRO
-- are BOTH 0.25 (lib/constants.ts:34-36 already warns the digits collide). A
-- $0.25 row is either a Pay-As-You-Go tier 1 success or a Pro tier 2 record,
-- and without this column no amount of SQL can say which -- which makes every
-- refund, dispute and revenue split a guess.
--
-- NO BACKFILL, DELIBERATELY. Existing rows stay NULL and NULL honestly means
-- "written before tiers existed". Every one of them is in fact tier 1, but
-- stamping that retroactively would assert a fact the row does not carry, and
-- the value is nil: the rows predate the ambiguity the column exists to
-- resolve. Cf. 20260916, which left existing usage_records alone for the same
-- reason -- they record what was actually billed.
--
-- SMALLINT, not an enum or a CHECK: tier 3 is not hypothetical (bulk is phase
-- 5) and a CHECK constraint would have to be migrated to add one. Legibility
-- lives in the code constant (TRACE_TIER in lib/constants.ts), not the type.
--
-- ── BACKWARD COMPATIBLE ──────────────────────────────────────────────────────
-- Both columns are nullable with no default beyond NULL, so this is a metadata-
-- only change in Postgres 11+ -- no table rewrite, no lock held while 3,632
-- rows are copied. Existing readers use `select('*')` and ignore unknown keys;
-- existing writers name their columns explicitly and never touch these two.

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS property_record JSONB DEFAULT NULL;

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS tier SMALLINT DEFAULT NULL;

COMMENT ON COLUMN public.trace_history.property_record IS
  'Raw Tracerfy dossier response.property object, all 86 keys verbatim. Non-null marks a row the customer has paid for: never delete it, always serve it from cache free.';

COMMENT ON COLUMN public.trace_history.tier IS
  'Billing model that produced this row: 1 = per successful trace (free on a miss), 2 = per record submitted (billed on a miss). NULL = written before tiers existed. Never inferred from charge -- 0.25 is ambiguous between the two.';

-- ── NO GRANTs, AND THIS IS NOT AN OVERSIGHT ─────────────────────────────────
-- The 2026-10-30 Supabase rule (CLAUDE.md, Supabase Migration Template) applies
-- to NEW objects in `public`: CREATE TABLE, CREATE FUNCTION called via .rpc(),
-- CREATE SEQUENCE. ALTER TABLE / ADD COLUMN on a PRE-EXISTING table is
-- explicitly exempt -- the CLAUDE.md Notes section says so in as many words.
-- trace_history already exists and already carries its grants; column-level
-- privileges are only involved when a grant was itself column-scoped, and
-- trace_history's are not.
--
-- Adding GRANTs here would not be a harmless belt-and-braces. A cargo-cult
-- `GRANT ... ON public.trace_history TO authenticated` would WIDEN the
-- table's existing privileges, which is the self-write vuln class CLAUDE.md
-- warns about: the anon key ships in the JS bundle, so a table-wide write
-- grant lets any signed-in user rewrite `charge` on their own rows from the
-- browser console. Do not add grants to this file.
