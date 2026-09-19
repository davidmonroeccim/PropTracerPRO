-- The dossier's second lookup key, carried from submit to execution.
--
-- WHY A MIGRATION AND NOT A PARAMETER. The tier 2 queue separates the two: an MCP submit
-- writes a trace_history row, and sweep-property-traces buys the dossier up to a minute
-- later, rebuilding the parcel from that row alone. Today it reads normalized_address,
-- city, state and zip, so a parcel id supplied at submit time has nowhere to live.
--
-- WHY NOT normalized_address. That column is the dedup key (sha256 over STREET|CITY|STATE,
-- migration 20260904). Anything added to it re-buys every existing row forever.
--
-- WHY NOT property_record. That is the OUTPUT, the raw 86-key vendor dump, and the raw
-- dump is the product. Writing an input into it would corrupt that claim silently.
--
-- GRANTS: none needed. ADD COLUMN on a pre-existing table inherits the table's ACL, and
-- 20260918_lock_trace_history_writes.sql left anon and authenticated with SELECT only.
-- Read the ACL back after applying anyway and account for anything unexpected (L-017).

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS parcel_id_local VARCHAR(64) DEFAULT NULL;

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS county VARCHAR(64) DEFAULT NULL;

COMMENT ON COLUMN public.trace_history.parcel_id_local IS
  'County parcel id supplied by the caller, used with county and state as the dossier''s APN key. NULL for every caller that sends only an address.';
COMMENT ON COLUMN public.trace_history.county IS
  'Bare county name for the dossier APN key. Tracerfy wants "Stark", never "Stark County".';
