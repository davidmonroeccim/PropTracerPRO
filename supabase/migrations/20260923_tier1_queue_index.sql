-- Tier 1 bulk queue (spec 2026-09-21 Section 8, Phase 2A): widen the two partial indexes on
-- ai_research_status so they serve every value the column now holds.
--
-- WHAT WAS WRONG WITH THE OLD PREDICATES, AND IT WAS ALREADY WRONG BEFORE THIS PHASE.
--
--   idx_trace_history_research_queue       WHERE ai_research_status = 'queued'
--   idx_trace_history_research_stale_claim WHERE ai_research_status = 'processing'
--
-- The entity retry ladder (lib/trace/entityTraceAttempts.ts, 2026-09) put four more queued values
-- on this column, 'queued_2' through 'queued_5', and four more claimed values, 'processing_2'
-- through 'processing_5'. The claim query is `.in(ENTITY_QUEUED_STATUSES)` and the stale sweep is
-- one `.eq(processingStatusFor(attempt))` per rung, so nine of those ten statements have been
-- falling back to a sequential scan since the ladder landed. Small table, no visible symptom, and
-- exactly the kind of thing that stops being invisible when the row count grows.
--
-- The Tier 1 queue (lib/trace/tier1Queue.ts) adds ten more: tier1_queued, tier1_queued_2..5,
-- tier1_processing, tier1_processing_2..5, plus the terminals tier1_done and tier1_failed.
-- Rather than list twenty values in two predicates and have to edit them again, both indexes are
-- keyed on IS NOT NULL, which is the shape the tier 2 queue's own index already uses
-- (20260918_property_trace_queue.sql: WHERE property_trace_status IS NOT NULL) and which its
-- header explains: indexing only the rows that have ever been bulk work keeps it small. Measured
-- 2026-09-20: 1,298 of 3,838 rows carry a value here, so it stays about a third of the table.
--
-- THE COLUMN ORDER IS NOT ARBITRARY, and it is the reason the stale-claim index is rebuilt rather
-- than just re-predicated. The queue claim is `.in(statuses).order('created_at').limit(120)`:
-- equality on the leading column, then the sort, which is the order Postgres can satisfy from the
-- index alone. The stale sweep is `.eq(status).or(claimed_at.is.null,claimed_at.lt.cutoff)`, so it
-- wants (status, claimed_at) and the old index led with claimed_at alone.
--
-- LOCKING. Plain CREATE INDEX takes ACCESS EXCLUSIVE for the build. trace_history held 3,838 rows
-- on 2026-09-20, so the build is milliseconds. CREATE INDEX CONCURRENTLY is deliberately NOT used:
-- it cannot run inside a transaction block, and this file is applied as one.
--
-- GRANTS: none, and that is not an oversight. An index is not a grantable object, and this file
-- creates no table and no function. CLAUDE.md's Notes section says ALTER TABLE / ADD COLUMN on a
-- pre-existing table is exempt from the 2026-10-30 rule; an index is further outside it still.
-- Adding a cargo-cult `GRANT ... TO authenticated` here would WIDEN trace_history's privileges,
-- which is the self-write vuln class CLAUDE.md warns about and which
-- 20260918_lock_trace_history_writes.sql exists to have closed. Read the ACL back anyway (L-017).

DROP INDEX IF EXISTS public.idx_trace_history_research_queue;

CREATE INDEX IF NOT EXISTS idx_trace_history_research_queue
  ON public.trace_history (ai_research_status, created_at)
  WHERE ai_research_status IS NOT NULL;

DROP INDEX IF EXISTS public.idx_trace_history_research_stale_claim;

CREATE INDEX IF NOT EXISTS idx_trace_history_research_stale_claim
  ON public.trace_history (ai_research_status, ai_research_claimed_at)
  WHERE ai_research_status IS NOT NULL;

COMMENT ON COLUMN public.trace_history.ai_research_status IS
  'TWO bulk lanes share this column, with disjoint value sets. Legacy entity lane (API bulk and MCP, retired in Phase 4): queued, queued_2..queued_5, processing, processing_2..processing_5, entity_trace_failed, found, not_found, skipped_no_owner. Tier 1 queue (the web upload, Phase 2A): tier1_queued, tier1_queued_2..tier1_queued_5, tier1_processing, tier1_processing_2..tier1_processing_5, tier1_done, tier1_failed. Values and predicates in lib/trace/entityTraceAttempts.ts and lib/trace/tier1Queue.ts. VARCHAR(20): the longest value is entity_trace_failed at 19.';

COMMENT ON COLUMN public.trace_history.ai_research_claimed_at IS
  'When a cron claimed this row, set with the status flip and cleared when the row settles or is released. A claim older than the cron stale cutoff, or one carrying NULL here, is a run killed before it could finish and is reverted one rung further up the ladder. Shared by both lanes above.';
