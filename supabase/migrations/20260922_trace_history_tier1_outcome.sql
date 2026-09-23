-- Tier 1 single traces through planRoute (spec 2026-09-21, Section 8, Phase 1).
--
-- outcome_code  One of found_by_address, found_by_parcel_id, found_by_company_name, no_match,
--               owner_name_not_matched, no_lookup_key, busy_try_again (spec 7.1). NULL on every
--               row written before this change, and on tier 2 rows, whose reason lives in
--               property_trace_status. status keeps its six-value CHECK (spec 7.1).
-- found_by      The KEY that found the owner: address, parcel_id or company_name. Never the vendor;
--               the vendor stays in contact_vendor.
-- trace_steps   The step log (spec 5.2): one entry per step with kind, outcome, cost, the credits
--               the vendor reported, a timestamp, the question asked, and how many people a billed
--               non-match returned (never their names, D29). INTERNAL: never sent in a customer
--               payload. A busy_try_again resend within 24 hours reuses the answered entries instead
--               of buying them again, judged by each entry's own timestamp because a reused row
--               keeps its created_at.
-- index         (user_id, parcel_id_local, county). The API single route now writes both columns
--               for a record sent by parcel id (spec 6.3, D23).
--
-- NOT HERE: widening the ai_research_status queue index (spec 8). That serves the Phase 2 queue.
--
-- GRANTS: none. ADD COLUMN on a pre-existing table inherits its ACL, and
-- 20260918_lock_trace_history_writes.sql left anon and authenticated with SELECT only.
-- Read the ACL back after applying anyway (L-017).

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS outcome_code VARCHAR(32) DEFAULT NULL;

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS found_by VARCHAR(16) DEFAULT NULL;

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS trace_steps JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_trace_history_user_parcel_county
  ON public.trace_history (user_id, parcel_id_local, county);

COMMENT ON COLUMN public.trace_history.outcome_code IS
  'Tier 1 outcome (spec 7.1). NULL before 2026-09-22 and on tier 2 rows.';
COMMENT ON COLUMN public.trace_history.found_by IS
  'The key that found the owner: address, parcel_id or company_name. Never the vendor.';
COMMENT ON COLUMN public.trace_history.trace_steps IS
  'Step log (spec 5.2). Internal only; never returned to a customer.';
