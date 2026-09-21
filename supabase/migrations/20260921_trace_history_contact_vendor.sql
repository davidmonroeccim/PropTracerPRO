-- Which contact vendor a trace actually went to, recorded instead of inferred.
--
-- WHY. The entity-versus-individual split is the decision tier 2 turns on: an entity goes to
-- FastAppend, an individual to Tracerfy, and a trust or an unclassifiable name goes to neither
-- and needs a human. Nothing durable recorded which way a row went. executeRoute builds a
-- StepReport per step carrying the vendor, and the crons dropped it at this boundary. There is
-- no vendor column, and VENDOR_COST.FASTAPPEND_ENTITY and VENDOR_COST.TRACERFY_INSTANT are both
-- 0.10, so `cost` cannot separate them either. The routing was unauditable after the fact.
--
-- WHAT IT COSTS TODAY. owner_contact_source is computed on read by resolveOwnerContact, whose
-- FastAppend rung looks in ai_research.business_trace_contacts. Tier 2 never writes ai_research,
-- so that rung cannot fire and EVERY tier 2 FastAppend hit is reported to customers as
-- 'person_trace'. Measured on trace 5ec0cf47-6844-4514-9029-53a0b6f34cd0 (2026-09-20): county
-- owner 'Estates Ave Properties Llc', classified entity, routed FASTAPPEND_ENTITY, reported
-- person_trace. This column is what lets that read the truth instead.
--
-- ASKED, NOT PRODUCED. A lane that ran and missed still answers the routing question, and a
-- miss leaves no contact name to mislabel anyway. NULL means no contact vendor was asked at
-- all, which is the trust and unknown case, not "we forgot to write it".
--
-- BACKFILL: none, deliberately. The 3,838 existing rows have no recoverable vendor: the step
-- reports were never persisted and cost cannot discriminate. Inventing one would be fabricated
-- provenance, and a NULL that honestly means "not recorded" is the point of the column.
--
-- GRANTS: none needed. ADD COLUMN on a pre-existing table inherits the table ACL, and
-- 20260918_lock_trace_history_writes.sql already left anon and authenticated with SELECT only.
-- Read the ACL back after applying anyway (L-017).

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS contact_vendor VARCHAR(32) DEFAULT NULL;

COMMENT ON COLUMN public.trace_history.contact_vendor IS
  'Which contact vendor this trace put the question to: fastappend for an entity owner, tracerfy for an individual. NULL when no contact vendor was asked, which is a trust or an unclassifiable owner, and on every row written before 2026-09-21, where the lane was never recorded.';
