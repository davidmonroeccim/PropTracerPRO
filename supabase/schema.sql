-- PropTracerPRO Database Schema
-- Run this in your Supabase SQL Editor

-- ===================
-- User Profiles Table
-- ===================

CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  company_name VARCHAR(255),

  -- AcquisitionPRO Membership
  is_acquisition_pro_member BOOLEAN DEFAULT FALSE,
  acquisition_pro_member_id VARCHAR(50),
  acquisition_pro_verified_at TIMESTAMPTZ,

  -- Subscription
  subscription_tier VARCHAR(20) DEFAULT 'wallet' CHECK (subscription_tier IN ('wallet', 'starter', 'pro')),
  stripe_customer_id VARCHAR(100),
  stripe_subscription_id VARCHAR(100),

  -- API Access (computed: Pro subscribers OR verified AcquisitionPRO members)
  api_key VARCHAR(64) UNIQUE,
  api_key_created_at TIMESTAMPTZ,

  -- Webhooks (for API users)
  webhook_url TEXT,
  webhook_secret VARCHAR(64),

  -- HighLevel Integration
  highlevel_api_key TEXT,
  highlevel_location_id VARCHAR(50),

  -- Wallet System
  wallet_balance DECIMAL(10,2) DEFAULT 0,
  wallet_auto_rebill_enabled BOOLEAN DEFAULT TRUE,
  wallet_auto_rebill_amount DECIMAL(10,2) DEFAULT 25.00,
  wallet_low_balance_threshold DECIMAL(10,2) DEFAULT 10.00,
  wallet_last_rebill_at TIMESTAMPTZ,
  wallet_payment_method_id VARCHAR(100),

  -- Onboarding
  onboarding_completed BOOLEAN DEFAULT FALSE,
  primary_use_case VARCHAR(50),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Function to check if user has API access
CREATE OR REPLACE FUNCTION has_api_access(user_row user_profiles)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN user_row.subscription_tier = 'pro' OR user_row.is_acquisition_pro_member = TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ===================
-- Trace History Table
-- ===================

CREATE TABLE IF NOT EXISTS trace_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  address_hash VARCHAR(64) NOT NULL,
  normalized_address TEXT NOT NULL,
  city VARCHAR(100),
  state VARCHAR(2),
  zip VARCHAR(10),
  input_owner_name TEXT,
  trace_result JSONB,
  tracerfy_job_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'no_match', 'error', 'cached')),
  phone_count INTEGER DEFAULT 0,
  email_count INTEGER DEFAULT 0,
  is_successful BOOLEAN DEFAULT FALSE,
  cost DECIMAL(10,4) DEFAULT 0,
  charge DECIMAL(10,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, address_hash)
);

-- ===================
-- Trace Jobs Table (Bulk)
-- ===================

CREATE TABLE IF NOT EXISTS trace_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  tracerfy_job_id VARCHAR(100),
  file_name VARCHAR(255),
  file_url TEXT,
  total_records INTEGER DEFAULT 0,
  dedupe_removed INTEGER DEFAULT 0,
  records_submitted INTEGER DEFAULT 0,
  records_matched INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  results_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ===================
-- Usage Records Table (Stripe Billing)
-- ===================

CREATE TABLE IF NOT EXISTS usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  trace_history_id UUID REFERENCES trace_history(id),
  quantity INTEGER DEFAULT 1,
  unit_price DECIMAL(10,4) DEFAULT 0.07,
  total_amount DECIMAL(10,4),
  stripe_usage_record_id VARCHAR(100),
  billing_period_start DATE,
  billing_period_end DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===================
-- Wallet Transactions Table
-- ===================

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('credit', 'debit', 'refund', 'auto_rebill')),
  amount DECIMAL(10,2) NOT NULL,
  balance_before DECIMAL(10,2) NOT NULL,
  balance_after DECIMAL(10,2) NOT NULL,
  description TEXT,
  trace_history_id UUID REFERENCES trace_history(id),
  stripe_payment_intent_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===================
-- API Logs Table
-- ===================

CREATE TABLE IF NOT EXISTS api_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  endpoint VARCHAR(100),
  method VARCHAR(10),
  request_body JSONB,
  response_status INTEGER,
  response_time_ms INTEGER,
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===================
-- Indexes
-- ===================

CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
CREATE INDEX IF NOT EXISTS idx_user_profiles_stripe_customer ON user_profiles(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_api_key ON user_profiles(api_key);

CREATE INDEX IF NOT EXISTS idx_trace_history_user_id ON trace_history(user_id);
CREATE INDEX IF NOT EXISTS idx_trace_history_hash ON trace_history(address_hash);
CREATE INDEX IF NOT EXISTS idx_trace_history_created ON trace_history(created_at);
CREATE INDEX IF NOT EXISTS idx_trace_history_status ON trace_history(status);

CREATE INDEX IF NOT EXISTS idx_trace_jobs_user_id ON trace_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_trace_jobs_status ON trace_jobs(status);

CREATE INDEX IF NOT EXISTS idx_usage_records_user_period ON usage_records(user_id, billing_period_start);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created ON wallet_transactions(created_at);

CREATE INDEX IF NOT EXISTS idx_api_logs_user ON api_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at);

-- ===================
-- Row Level Security
-- ===================

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE trace_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE trace_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_logs ENABLE ROW LEVEL SECURITY;

-- User Profiles Policies
CREATE POLICY "Users can view own profile"
  ON user_profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON user_profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Trace History Policies
CREATE POLICY "Users can view own traces"
  ON trace_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own traces"
  ON trace_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own traces"
  ON trace_history FOR UPDATE
  USING (auth.uid() = user_id);

-- Trace Jobs Policies
CREATE POLICY "Users can view own jobs"
  ON trace_jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own jobs"
  ON trace_jobs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own jobs"
  ON trace_jobs FOR UPDATE
  USING (auth.uid() = user_id);

-- Usage Records Policies
CREATE POLICY "Users can view own usage"
  ON usage_records FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own usage"
  ON usage_records FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Wallet Transactions Policies
CREATE POLICY "Users can view own wallet transactions"
  ON wallet_transactions FOR SELECT
  USING (auth.uid() = user_id);

-- API Logs Policies
CREATE POLICY "Users can view own API logs"
  ON api_logs FOR SELECT
  USING (auth.uid() = user_id);

-- ===================
-- Database Functions
-- ===================

-- Deduct from wallet balance
CREATE OR REPLACE FUNCTION deduct_wallet_balance(
  p_user_id UUID,
  p_amount DECIMAL(10,2),
  p_trace_history_id UUID DEFAULT NULL,
  p_description TEXT DEFAULT 'Skip trace charge'
)
RETURNS BOOLEAN AS $$
DECLARE
  v_current_balance DECIMAL(10,2);
BEGIN
  -- Get current balance with row lock
  SELECT wallet_balance INTO v_current_balance
  FROM user_profiles
  WHERE id = p_user_id
  FOR UPDATE;

  -- Check sufficient balance
  IF v_current_balance < p_amount THEN
    RETURN FALSE;
  END IF;

  -- Deduct balance
  UPDATE user_profiles
  SET wallet_balance = wallet_balance - p_amount,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Record transaction
  INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, description, trace_history_id)
  VALUES (p_user_id, 'debit', p_amount, v_current_balance, v_current_balance - p_amount, p_description, p_trace_history_id);

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Credit wallet balance
CREATE OR REPLACE FUNCTION credit_wallet_balance(
  p_user_id UUID,
  p_amount DECIMAL(10,2),
  p_stripe_payment_intent_id VARCHAR(100) DEFAULT NULL,
  p_description TEXT DEFAULT 'Wallet credit'
)
RETURNS BOOLEAN AS $$
DECLARE
  v_current_balance DECIMAL(10,2);
BEGIN
  -- Get current balance with row lock
  SELECT wallet_balance INTO v_current_balance
  FROM user_profiles
  WHERE id = p_user_id
  FOR UPDATE;

  -- Add to balance
  UPDATE user_profiles
  SET wallet_balance = wallet_balance + p_amount,
      updated_at = NOW()
  WHERE id = p_user_id;

  -- Record transaction
  INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, description, stripe_payment_intent_id)
  VALUES (p_user_id, 'credit', p_amount, v_current_balance, v_current_balance + p_amount, p_description, p_stripe_payment_intent_id);

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if wallet needs rebill
CREATE OR REPLACE FUNCTION check_wallet_needs_rebill(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_user user_profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM user_profiles WHERE id = p_user_id;

  -- Check if auto-rebill needed
  IF v_user.wallet_balance < v_user.wallet_low_balance_threshold
     AND v_user.wallet_auto_rebill_enabled
     AND v_user.wallet_payment_method_id IS NOT NULL THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===================
-- Trigger: Auto-create user profile on signup
-- ===================

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists and recreate
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ===================
-- Trigger: Update updated_at timestamp
-- ===================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
