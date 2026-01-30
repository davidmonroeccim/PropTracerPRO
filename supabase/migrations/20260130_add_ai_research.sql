-- Add AI Research columns to trace_history
ALTER TABLE trace_history ADD COLUMN IF NOT EXISTS ai_research JSONB DEFAULT NULL;
ALTER TABLE trace_history ADD COLUMN IF NOT EXISTS ai_research_status VARCHAR(20) DEFAULT NULL;
ALTER TABLE trace_history ADD COLUMN IF NOT EXISTS ai_research_charge DECIMAL(10,4) DEFAULT 0;

-- Create research_jobs table for bulk research tracking
CREATE TABLE IF NOT EXISTS research_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  total_records INTEGER DEFAULT 0,
  records_completed INTEGER DEFAULT 0,
  records_found INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_research_jobs_user_id ON research_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_research_jobs_status ON research_jobs(status);

-- RLS
ALTER TABLE research_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own research jobs"
  ON research_jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own research jobs"
  ON research_jobs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own research jobs"
  ON research_jobs FOR UPDATE
  USING (auth.uid() = user_id);
