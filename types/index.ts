// PropTracerPRO Type Definitions

// ===================
// User & Profile Types
// ===================

export type SubscriptionTier = 'wallet' | 'starter' | 'pro';

export interface UserProfile {
  id: string;
  email: string;
  company_name: string | null;

  // AcquisitionPRO Membership
  is_acquisition_pro_member: boolean;
  acquisition_pro_member_id: string | null;
  acquisition_pro_verified_at: string | null;

  // Subscription
  subscription_tier: SubscriptionTier;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;

  // API Access
  has_api_access: boolean;
  api_key: string | null;
  api_key_created_at: string | null;

  // Webhooks
  webhook_url: string | null;
  webhook_secret: string | null;

  // HighLevel Integration
  highlevel_api_key: string | null;
  highlevel_location_id: string | null;

  // Wallet
  wallet_balance: number;
  wallet_auto_rebill_enabled: boolean;
  wallet_auto_rebill_amount: number;
  wallet_low_balance_threshold: number;
  wallet_last_rebill_at: string | null;
  wallet_payment_method_id: string | null;

  created_at: string;
  updated_at: string;
}

// ===================
// Trace Types
// ===================

export type TraceStatus = 'pending' | 'processing' | 'success' | 'no_match' | 'error' | 'cached';

export interface PhoneResult {
  number: string;
  type: 'mobile' | 'landline' | 'voip' | 'unknown';
  is_dnc?: boolean;
}

export interface TraceResult {
  owner_name: string | null;
  owner_name_2: string | null;
  phones: PhoneResult[];
  emails: string[];
  mailing_address: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  match_confidence: number; // 0-100
}

export interface TraceHistory {
  id: string;
  user_id: string;
  address_hash: string;
  normalized_address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  input_owner_name: string | null;
  trace_result: TraceResult | null;
  tracerfy_job_id: string | null;
  status: TraceStatus;
  phone_count: number;
  email_count: number;
  is_successful: boolean;
  cost: number;
  charge: number;
  created_at: string;
}

export interface TraceJob {
  id: string;
  user_id: string;
  tracerfy_job_id: string | null;
  file_name: string | null;
  file_url: string | null;
  total_records: number;
  dedupe_removed: number;
  records_submitted: number;
  records_matched: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  results_url: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

// ===================
// Billing Types
// ===================

export interface UsageRecord {
  id: string;
  user_id: string;
  trace_history_id: string | null;
  quantity: number;
  unit_price: number;
  total_amount: number;
  stripe_usage_record_id: string | null;
  billing_period_start: string;
  billing_period_end: string;
  created_at: string;
}

export type WalletTransactionType = 'credit' | 'debit' | 'refund' | 'auto_rebill';

export interface WalletTransaction {
  id: string;
  user_id: string;
  type: WalletTransactionType;
  amount: number;
  balance_before: number;
  balance_after: number;
  description: string | null;
  trace_history_id: string | null;
  stripe_payment_intent_id: string | null;
  created_at: string;
}

// ===================
// API Types
// ===================

export interface ApiLog {
  id: string;
  user_id: string;
  endpoint: string;
  method: string;
  request_body: Record<string, unknown> | null;
  response_status: number;
  response_time_ms: number;
  ip_address: string | null;
  created_at: string;
}

// ===================
// Input Types
// ===================

export interface AddressInput {
  address: string;
  city: string;
  state: string;
  zip: string;
  owner_name?: string;
  owner_name_2?: string;
  mailing_address?: string;
}

export interface SingleTraceRequest {
  address: string;
  city: string;
  state: string;
  zip: string;
  owner_name?: string;
}

export interface BulkTraceRequest {
  records: AddressInput[];
}

// ===================
// Response Types
// ===================

export interface DedupeResult {
  newRecords: AddressInput[];
  duplicates: AddressInput[];
  cachedResults: TraceHistory[];
}

export interface SingleTraceResponse {
  success: boolean;
  is_cached: boolean;
  trace_id: string;
  result: TraceResult | null;
  charge: number;
  error?: string;
}

export interface BulkTraceResponse {
  success: boolean;
  job_id: string;
  total_records: number;
  dedupe_removed: number;
  records_to_process: number;
  estimated_cost: number;
}

// ===================
// Tracerfy API Types
// ===================

export interface TracerfyJobResponse {
  job_id: string;
  status: 'processing' | 'completed' | 'failed';
  total_records?: number;
  matched_records?: number;
  results?: TracerfyResult[];
}

export interface TracerfyResult {
  input_address: string;
  owner_name: string | null;
  phones: Array<{
    number: string;
    type: string;
  }>;
  emails: string[];
  mailing_address: string | null;
}

// ===================
// HighLevel Types
// ===================

export interface HighLevelContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  tags: string[];
  customFields: Array<{
    key: string;
    value: string;
  }>;
}
