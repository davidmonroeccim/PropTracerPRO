-- Stale-claim recovery for the bulk research cron.
--
-- The sweep-bulk-research cron claims a row by flipping ai_research_status
-- from 'queued' to 'processing'. If that cron invocation is killed externally
-- (Vercel maxDuration timeout, OOM, deploy restart) before its in-process
-- catch block can revert the claim, the row is stranded in 'processing' and
-- never re-claimed -- subsequent cron runs only look at 'queued' rows. A
-- single stranded row pins the parent bulk job in 'processing' forever, so
-- API consumers (e.g. the Lead-Gen Agent) eventually time out and trigger
-- their failure-recovery path even though the underlying work finished.
--
-- This column lets the cron detect stranded claims (ai_research_status =
-- 'processing' AND claimed_at older than its own maxDuration) and revert
-- them to 'queued' so they can be retried.

ALTER TABLE trace_history
  ADD COLUMN IF NOT EXISTS ai_research_claimed_at TIMESTAMPTZ;

-- Partial index so the stale-claim sweep at the top of every cron run is a
-- cheap index probe rather than a full scan.
CREATE INDEX IF NOT EXISTS idx_trace_history_research_stale_claim
  ON trace_history (ai_research_claimed_at)
  WHERE ai_research_status = 'processing';
