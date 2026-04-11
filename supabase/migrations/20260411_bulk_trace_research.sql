-- Bulk trace AI research + FastAppend parity with single trace
-- Adds a trace_job_id link from trace_history → trace_jobs so the new bulk
-- flow (entity detection → AI research → individual Tracerfy submits) can
-- aggregate per-record state back to the parent bulk job even after each
-- entity row acquires its own tracerfy_job_id during background processing.

ALTER TABLE trace_history
  ADD COLUMN IF NOT EXISTS trace_job_id UUID REFERENCES trace_jobs(id) ON DELETE SET NULL;

-- Cron worker lookup: find queued research rows quickly
CREATE INDEX IF NOT EXISTS idx_trace_history_research_queue
  ON trace_history (ai_research_status, created_at)
  WHERE ai_research_status = 'queued';

-- Status endpoint aggregation: pull all rows belonging to a bulk job
CREATE INDEX IF NOT EXISTS idx_trace_history_trace_job_id
  ON trace_history (trace_job_id)
  WHERE trace_job_id IS NOT NULL;
