-- Full Property Trace, phase 5c-2: trace_history gains its own tier 2 work queue.
-- 2026-09-18. Companion to app/api/cron/sweep-property-traces/route.ts and
-- lib/trace/propertyTraceAttempts.ts.
--
-- NOT APPLIED BY THE AUTHOR. Written and reviewed only; the controller applies
-- it against the linked project and reads the result back. Idempotent
-- (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) but do not re-run
-- casually.
--
-- ORDERING. Two NULLABLE columns and one partial index. No released code reads
-- or writes either column, so this is harmless to old code -- but the NEW cron
-- REQUIRES them: it claims on property_trace_status by name and PostgREST
-- answers 42703 "column does not exist" if it is absent. Apply this in the same
-- deploy window, at or immediately BEFORE the code goes live. A deploy that
-- ships the cron without the columns turns every cron run into a 500 every
-- minute.
--
-- ── WHY THIS QUEUE IS NOT ai_research_status ────────────────────────────────
-- The obvious move is to reuse the column the entity queue already lives in.
-- It was rejected for four reasons, none of them stylistic.
--
-- 1. THE NAME IS A LIE ABOUT THE ENGINE. `ai_research_status` is named for the
--    Brave plus Claude AI Search engine, which was REMOVED on 2026-09-17. The
--    column survives because 1,301 historical rows carry its states and because
--    sweep-entity-traces re-pointed the same state machine at the FastAppend
--    business trace. Adding a third, unrelated engine to a column named after a
--    retired one buys a permanent explanation cost on every future read.
--
-- 2. VARCHAR(20) IS ALREADY NEARLY FULL. Its longest live value is
--    'entity_trace_failed' at 19 characters (lib/trace/entityTraceAttempts.ts
--    says so in as many words). A tier 2 queue needs its own terminal and
--    retry values, and there is no room left to name them legibly. The new
--    column is VARCHAR(24); its longest value is 'property_trace_failed' at 21.
--
-- 3. TWO BILLING MODELS IN ONE STATE MACHINE IS HOW `tier` GETS CONFUSED. The
--    entity queue settles TIER 1 rows: billed per SUCCESSFUL trace, a miss is
--    free. This queue settles TIER 2 rows: billed per RECORD SUBMITTED, so a
--    miss IS billed and a row can legitimately read
--    `is_successful = false, charge > 0`. Those two rules disagree about the
--    single most dangerous question in this codebase, and a shared column
--    invites a reader, or a sweep, to answer it with the wrong one.
--
-- 4. THE ENTITY QUEUE'S OWN INDEX COVERS ONE RUNG OF FIVE, AND THIS FIXES THAT
--    FLAW RATHER THAN INHERITING IT. See the index note below.
--
-- ── WHY THE INDEX PREDICATE IS `IS NOT NULL`, NOT A SINGLE LITERAL RUNG ─────
-- Migration 20260509 indexed the entity queue as
--
--   CREATE INDEX ... ON trace_history (ai_research_claimed_at)
--     WHERE ai_research_status = 'processing'
--
-- and that predicate was correct on the day it was written, when 'processing'
-- was the only claimed state. It stopped being correct when the retry ladder
-- landed: the ladder added queued_2..queued_5 and processing_2..processing_5,
-- so the live claim query (`.in(ENTITY_QUEUED_STATUSES)`) and all five stale
-- sweeps now filter on values the index predicate EXCLUDES. Postgres cannot use
-- a partial index for a query whose rows the predicate does not cover, so every
-- one of those six statements is a sequential scan of trace_history today. It
-- is quiet rather than broken, which is exactly why it survived.
--
-- `WHERE property_trace_status IS NOT NULL` covers EVERY rung of this ladder --
-- queued, queued_2..5, processing, processing_2..5, and the three terminal
-- values -- including any rung added later, because the predicate is about the
-- column having a value at all rather than about which value it has. A new
-- retry rung therefore cannot silently un-index the queue the way it did there.
--
-- It stays a PARTIAL index rather than a plain one because the column is NULL
-- on the overwhelming majority of trace_history: tier 1 rows never enter this
-- queue and every row written before today carries NULL. Indexing only the rows
-- that have ever been tier 2 bulk work keeps it small.
--
-- THE COLUMN ORDER IS (status, created_at) AND IT IS NOT ARBITRARY. The claim
-- query is `.in(QUEUED_STATUSES).order('created_at').limit(120)`: equality on
-- the leading column, then the sort. That is the order Postgres can satisfy
-- from the index alone, oldest-first, without sorting 120 rows out of a scan.
-- Reversed, the equality could not be probed.

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS property_trace_status VARCHAR(24) DEFAULT NULL;

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS property_trace_claimed_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_trace_history_property_trace_queue
  ON public.trace_history (property_trace_status, created_at)
  WHERE property_trace_status IS NOT NULL;

COMMENT ON COLUMN public.trace_history.property_trace_status IS
  'Tier 2 (Full Property Trace) bulk work queue. NULL = this row is not tier 2 bulk work. Rungs and terminal values are defined in lib/trace/propertyTraceAttempts.ts. Deliberately NOT ai_research_status: that column is the TIER 1 entity queue and mixing two billing models in one state machine is how tier gets confused.';

COMMENT ON COLUMN public.trace_history.property_trace_claimed_at IS
  'When sweep-property-traces claimed this row. Set with the status flip, cleared when the row settles. A claim older than the cron stale cutoff, OR one carrying NULL here, is a run that was killed before it could finish and is reverted one rung further up the ladder.';

-- ── NO GRANTs, AND THIS IS NOT AN OVERSIGHT ─────────────────────────────────
-- The 2026-10-30 Supabase rule (CLAUDE.md, Supabase Migration Template) applies
-- to NEW objects in `public`: CREATE TABLE, CREATE FUNCTION called via .rpc(),
-- CREATE SEQUENCE. ALTER TABLE / ADD COLUMN on a PRE-EXISTING table is
-- explicitly exempt -- the CLAUDE.md Notes section says so in as many words --
-- and an index is not a grantable object at all. trace_history already exists
-- and already carries its grants.
--
-- THIS MIGRATION CREATES NO FUNCTION, so there is no ACL to read back. Had it
-- created one, the read-back would be mandatory rather than advisable: on
-- 2026-09-17 a SECURITY DEFINER function that ADDS WALLET BALANCE came back
-- callable by `anon` despite a REVOKE ... FROM PUBLIC, because Supabase's
-- ALTER DEFAULT PRIVILEGES lands explicit grants to named roles at CREATE time
-- and a revoke from PUBLIC does not touch those.
--
-- Adding GRANTs here would not be harmless belt-and-braces. A cargo-cult
-- `GRANT ... ON public.trace_history TO authenticated` WIDENS the table's
-- existing privileges, which is the self-write vuln class CLAUDE.md warns
-- about: the anon key ships in the JS bundle, so a table-wide write grant lets
-- any signed-in user rewrite `charge` on their own rows from the browser
-- console. Do not add grants to this file.
