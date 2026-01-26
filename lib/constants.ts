// PropTracerPRO Constants

// ===================
// Pricing
// ===================

export const PRICING = {
  // Monthly subscription fees
  STARTER_MONTHLY: 47,
  PRO_MONTHLY: 97,

  // Per-trace charges
  CHARGE_PER_SUCCESS: 0.07,

  // Our cost from Tracerfy
  COST_PER_RECORD: 0.009,

  // Wallet settings
  WALLET_MIN_BALANCE_THRESHOLD: 10,
  WALLET_DEFAULT_REBILL_AMOUNT: 25,
  WALLET_MIN_REBILL_AMOUNT: 25,
  WALLET_MAX_REBILL_AMOUNT: 500,
} as const;

// ===================
// Subscription Tiers
// ===================

export const SUBSCRIPTION_TIERS = {
  wallet: {
    name: 'Pay-As-You-Go',
    monthlyFee: 0,
    perTrace: PRICING.CHARGE_PER_SUCCESS,
    apiAccess: false,
    description: 'Perfect for occasional users. No monthly fee, pay only for successful traces.',
  },
  starter: {
    name: 'Starter',
    monthlyFee: PRICING.STARTER_MONTHLY,
    perTrace: PRICING.CHARGE_PER_SUCCESS,
    apiAccess: false,
    description: 'For regular users. Monthly subscription with usage-based billing.',
  },
  pro: {
    name: 'Pro',
    monthlyFee: PRICING.PRO_MONTHLY,
    perTrace: PRICING.CHARGE_PER_SUCCESS,
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
// API Rate Limits
// ===================

export const API_LIMITS = {
  REQUESTS_PER_MINUTE: 100,
  RECORDS_PER_DAY: 10000,
} as const;

// ===================
// Tracerfy
// ===================

export const TRACERFY = {
  BASE_URL: process.env.TRACERFY_API_URL || 'https://api.tracerfy.com',
  MAX_PHONES: 8,
  MAX_EMAILS: 5,
} as const;

// ===================
// HighLevel
// ===================

export const HIGHLEVEL = {
  BASE_URL: 'https://services.leadconnectorhq.com',
  API_VERSION: '2021-07-28',
} as const;

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
