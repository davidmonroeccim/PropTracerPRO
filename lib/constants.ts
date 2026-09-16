// PropTracerPRO Constants

// ===================
// Pricing
// ===================

export const PRICING = {
  // Monthly subscription fees
  PRO_MONTHLY: 97,

  // ── TIER 1 ─────────────────────────────────────────────────────────────
  // The owner of record is already known. Billed per SUCCESSFUL trace.
  // A no-match is free. Customer-facing label: "per successful trace".
  //
  // OWNER TYPE DOES NOT AFFECT PRICE. An individual routes to Tracerfy and an
  // entity routes to FastAppend, and both bill these same two numbers. The
  // vendor split and the vendor COSTS ($0.10 entity contacts, $0.10 individual
  // contacts) are cost-side only. There is no entity price, no entity
  // surcharge and no entity discount anywhere in the model.
  CHARGE_PER_SUCCESS: 0.15,
  CHARGE_PER_SUCCESS_WALLET: 0.25,

  // ── TIER 2 ─────────────────────────────────────────────────────────────
  // The owner of record is absent, OR the caller wants the enriched property
  // record. Billed per RECORD SUBMITTED, so a no-match IS billed: the county
  // dossier lookup is spent on submission whether or not contacts follow.
  // Customer-facing label: "per record". Never "per search".
  //
  // These are NOT:
  //   - CHARGE_PER_SUCCESS / CHARGE_PER_SUCCESS_WALLET, the tier 1 per-success
  //     rates, which are free on a miss.
  //   - AI_RESEARCH.CHARGE_PER_RECORD (also 0.15), which is the AI research
  //     line item, a different product on a different ledger entry.
  // TIER2_PER_RECORD_SUBMITTED_PRO shares its digits with
  // CHARGE_PER_SUCCESS_WALLET. Same digits, different meaning. Check the name
  // before reusing a number.
  /** Tier 2 per record submitted, Pro and AcquisitionPRO. NOT a per-success rate. */
  TIER2_PER_RECORD_SUBMITTED_PRO: 0.25,
  /** Tier 2 per record submitted, Pay-As-You-Go. NOT a per-success rate. */
  TIER2_PER_RECORD_SUBMITTED_WALLET: 0.40,

  // RETIRED 2026-09-16: CHARGE_PER_FASTAPPEND_SUCCESS. It existed because the
  // old model priced the FastAppend entity path separately from the Tracerfy
  // person path. Under the canonical model owner type selects the VENDOR, not
  // the price, so an entity trace on a known owner bills the plan's tier 1
  // rate above (getChargePerTrace / chargePerTrace) exactly like a person
  // trace. Do not reintroduce a separate entity constant.

  // Our cost from Tracerfy
  COST_PER_RECORD: 0.009,

  // Wallet settings
  WALLET_MIN_BALANCE_THRESHOLD: 5,
  WALLET_DEFAULT_REBILL_AMOUNT: 25,
  WALLET_MIN_REBILL_AMOUNT: 25,
  WALLET_MAX_REBILL_AMOUNT: 500,
  WALLET_AUTO_REFILL_AMOUNTS: [25, 50, 100] as readonly number[],
} as const;

// ===================
// Subscription Tiers
// ===================

export const SUBSCRIPTION_TIERS = {
  wallet: {
    name: 'Pay-As-You-Go',
    monthlyFee: 0,
    /** Tier 1. Billed per successful trace; a no-match is free. */
    perTrace: PRICING.CHARGE_PER_SUCCESS_WALLET,
    /** Tier 2. Billed per record submitted, so a no-match is billed. */
    perRecord: PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET,
    apiAccess: false,
    description: 'No monthly fee. Pay per successful trace when you already have the owner, or per record when we go find them for you.',
  },
  pro: {
    name: 'Pro',
    monthlyFee: PRICING.PRO_MONTHLY,
    /** Tier 1. Billed per successful trace; a no-match is free. */
    perTrace: PRICING.CHARGE_PER_SUCCESS,
    /** Tier 2. Billed per record submitted, so a no-match is billed. */
    perRecord: PRICING.TIER2_PER_RECORD_SUBMITTED_PRO,
    apiAccess: true,
    description: 'Full API access for power users and automation.',
  },
} as const;

// ===================
// Deduplication
// ===================

export const DEDUPE = {
  // How many days to cache results
  WINDOW_DAYS: 90,
} as const;

// ===================
// Stale Processing
// ===================

export const STALE_PROCESSING = {
  // Minutes before a processing record is considered stale (for retries/dedup bypass)
  STALE_MINUTES: 10,
  // Age at which the status endpoints promote a row to status='error' if
  // Tracerfy has been actively unhealthy (rate-limited, 503ing, or returning
  // malformed responses) for this row. Long enough to absorb normal queue
  // depth, short enough that the Lead-Gen Agent's 20-min retry doesn't trip.
  TRACERFY_STALL_MINUTES: 15,
  // Minutes before the cron job marks a processing record as error
  CRON_TIMEOUT_MINUTES: 60,
} as const;

// ===================
// Tracerfy
// ===================

export const TRACERFY = {
  BASE_URL: process.env.TRACERFY_API_URL || 'https://tracerfy.com/v1/api/',
  MAX_PHONES: 8,
  MAX_EMAILS: 5,
} as const;

export const FASTAPPEND = {
  BASE_URL: 'https://app.fastappend.com/v1/api/',
} as const;

// ===================
// HighLevel
// ===================

export const HIGHLEVEL = {
  BASE_URL: 'https://services.leadconnectorhq.com',
  API_VERSION: '2021-07-28',
} as const;

// ===================
// AI Research
// ===================

export const AI_RESEARCH = {
  CHARGE_PER_RECORD: 0.15,
  BRAVE_RATE_LIMIT_PER_SEC: 20,
  BULK_CHUNK_SIZE: 200,
  CLAUDE_BATCH_SIZE: 20,
  CLAUDE_MODEL: 'claude-opus-4-5-20251101',
  MAX_DURATION_SEC: 300,
} as const;

// ===================
// Pricing Helper
// ===================

export function getChargePerTrace(
  subscriptionTier: string,
  isAcquisitionProMember: boolean
): number {
  if (subscriptionTier === 'pro' || isAcquisitionProMember) {
    return PRICING.CHARGE_PER_SUCCESS;
  }
  return PRICING.CHARGE_PER_SUCCESS_WALLET;
}

// ===================
// US States
// ===================

export const US_STATES = [
  { value: 'AL', label: 'Alabama' },
  { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' },
  { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' },
  { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' },
  { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' },
  { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' },
  { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' },
  { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' },
  { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' },
  { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
  { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' },
  { value: 'WY', label: 'Wyoming' },
  { value: 'DC', label: 'District of Columbia' },
] as const;

// ===================
// Use Cases (Onboarding)
// ===================

export const USE_CASES = [
  { value: 'wholesaling', label: 'Wholesaling' },
  { value: 'brokerage', label: 'Brokerage' },
  { value: 'investing', label: 'Real Estate Investing' },
  { value: 'property_management', label: 'Property Management' },
  { value: 'other', label: 'Other' },
] as const;
