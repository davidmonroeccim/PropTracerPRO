-- Async FastAppend business trace recovery
-- Tracks business traces submitted during AI research that didn't complete within
-- the 45-second inline poll. A cron sweeper polls FastAppend, merges results into
-- trace_history.ai_research, and fires a webhook when each job finishes.

CREATE TABLE IF NOT EXISTS business_trace_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  -- FastAppend job tracking
  fastappend_queue_id VARCHAR(100) NOT NULL,
  business_name TEXT,
  state VARCHAR(2),

  -- Address context (for merging into trace_history and webhook payload)
  address_hash VARCHAR(64),
  normalized_address TEXT,
  city VARCHAR(100),
  property_state VARCHAR(2),
  zip VARCHAR(10),

  -- Result tracking
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'no_match', 'error')),
  result JSONB,
  error_message TEXT,
  webhook_dispatched BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Sweeper lookup — partial index keeps it small
CREATE INDEX IF NOT EXISTS idx_business_trace_jobs_pending
  ON business_trace_jobs (created_at)
  WHERE status = 'pending';

-- Merge-into-trace_history lookup
CREATE INDEX IF NOT EXISTS idx_business_trace_jobs_user_address
  ON business_trace_jobs (user_id, address_hash);

-- Agent status endpoint lookup
CREATE INDEX IF NOT EXISTS idx_business_trace_jobs_user
  ON business_trace_jobs (user_id, created_at DESC);

-- RLS: users can read their own jobs (admin client bypasses RLS for writes)
ALTER TABLE business_trace_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_business_trace_jobs"
  ON business_trace_jobs FOR SELECT
  USING (auth.uid() = user_id);
