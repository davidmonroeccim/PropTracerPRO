# PropTracerPRO - Implementation Plan

## Project Overview
Build PropTracerPRO, a white-label skip tracing web application for commercial real estate professionals. Integrates with Tracerfy API, includes Stripe billing (wallet + subscription), Supabase auth/database, and HighLevel CRM integration.

---

## Phase 1: MVP Implementation

### 1. Project Foundation
- [x] Initialize Next.js 15.5.7+ with App Router, TypeScript, Tailwind CSS
- [x] Install and configure shadcn/ui component library
- [x] Set up ESLint, Prettier, and TypeScript configuration
- [x] Create `.env.local` and `.env.example` with all required variables
- [x] Create base folder structure per specification
- [x] Configure `next.config.ts` for Supabase and external APIs

### 2. Supabase Setup
- [x] Create `lib/supabase/client.ts` - browser client
- [x] Create `lib/supabase/server.ts` - server-side client
- [x] Create `lib/supabase/admin.ts` - service role client
- [x] Create `lib/supabase/middleware.ts` - session handling
- [x] Set up database schema in `supabase/schema.sql`:
  - [x] `user_profiles` table (extends auth.users)
  - [x] `trace_history` table (deduplication + results)
  - [x] `trace_jobs` table (bulk jobs)
  - [x] `usage_records` table (Stripe billing)
  - [x] `wallet_transactions` table (pay-as-you-go)
  - [x] `api_logs` table (Pro tier API usage)
- [x] Create database functions:
  - [x] `deduct_wallet_balance` function
  - [x] `credit_wallet_balance` function
  - [x] `check_wallet_needs_rebill` function
  - [x] `handle_new_user` trigger
- [x] Set up Row Level Security (RLS) policies
- [x] Create indexes for performance

### 3. Authentication System
- [x] Create `middleware.ts` for protected routes
- [x] Create `app/(auth)/layout.tsx` - auth pages layout
- [x] Create `app/(auth)/login/page.tsx` - email/password + magic link
- [x] Create `app/(auth)/register/page.tsx` - registration form
- [x] Create `app/auth/callback/route.ts` - auth callback handler

### 4. Onboarding Flow
- [x] Create `app/(auth)/onboarding/page.tsx`
  - [x] Company name input
  - [x] AcquisitionPRO member status (yes/no)
  - [x] Member ID verification (HighLevel API lookup)
  - [x] Primary use case selection
- [x] Create HighLevel API integration for member verification
  - [x] `lib/highlevel/client.ts`
  - [x] Member lookup function

### 5. Dashboard Layout & Navigation
- [x] Create `app/(dashboard)/layout.tsx` - main dashboard layout
- [x] Create `components/dashboard/Sidebar.tsx` - sidebar navigation
- [x] Create `components/dashboard/Header.tsx` - header with user menu and wallet balance
- [x] Create `app/(dashboard)/page.tsx` - dashboard home with stats
- [x] Create usage stats components (traces today, this month, wallet balance)

### 6. Stripe Integration
- [x] Create `lib/stripe/client.ts` - Stripe SDK setup
- [x] Create `app/api/stripe/create-checkout/route.ts`
- [x] Create `app/api/stripe/webhook/route.ts`
  - [x] Handle `customer.subscription.created`
  - [x] Handle `customer.subscription.updated`
  - [x] Handle `customer.subscription.deleted`
  - [x] Handle `invoice.paid`
  - [x] Handle `invoice.payment_failed`
  - [x] Handle `checkout.session.completed` (wallet top-up)
  - [x] Handle `payment_intent.succeeded` (auto-rebill)
- [x] Create `app/api/stripe/create-portal/route.ts` (manage subscription)
- [x] Create `app/api/stripe/wallet-topup/route.ts` (for wallet)

### 7. Billing & Settings Pages
- [x] Create `app/(dashboard)/settings/page.tsx` - settings overview
- [x] Create `app/(dashboard)/settings/profile/page.tsx` - profile management
- [x] Create `app/(dashboard)/settings/billing/page.tsx`:
  - [x] Current plan display
  - [x] Wallet balance + top-up button
  - [x] Upgrade/downgrade buttons
  - [x] Available plans display

### 8. Core Utilities
- [x] Create `lib/utils/address-normalizer.ts`
  - [x] `normalizeAddress()` function
  - [x] `createAddressHash()` function
  - [x] `validateAddressInput()` function
- [x] Create `lib/utils/deduplication.ts`
  - [x] `checkDuplicates()` function
  - [x] `checkSingleDuplicate()` function
  - [x] `removeBatchDuplicates()` function
  - [x] 90-day window logic
- [x] Create `lib/constants.ts` - pricing, limits, US states, etc.
- [x] Create `types/index.ts` - TypeScript interfaces

### 9. Tracerfy API Integration
- [x] Create `lib/tracerfy/client.ts`
  - [x] `submitSingleTrace()` - POST /trace/
  - [x] `submitBulkTrace()` - POST /trace/
  - [x] `getJobStatus()` - GET /queue/:id
  - [x] `listJobs()` - GET /queues/
  - [x] `getAnalytics()` - GET /analytics/
  - [x] `parseTracerfyResult()` - parse results
- [x] Create types for Tracerfy responses

### 10. Single Property Trace
- [x] Create `app/(dashboard)/trace/single/page.tsx`
  - [x] Form: address, city, state, zip, owner name (optional)
  - [x] Pre-submit deduplication check
  - [x] Display cached result if duplicate
  - [x] Submit to Tracerfy if new
  - [x] Display results inline
  - [x] Copy-to-clipboard for phone/email
- [x] Create `app/api/trace/single/route.ts`
  - [x] Validate input
  - [x] Check deduplication
  - [x] Call Tracerfy API
  - [x] Store result in trace_history
  - [x] Charge user (wallet or metered)
  - [x] Return results

### 11. Bulk CSV Upload
- [x] Create `app/(dashboard)/trace/bulk/page.tsx`
  - [x] Drag-and-drop CSV upload
  - [x] CSV parsing and validation (PapaParse + SheetJS)
  - [x] Auto-detect column mapping (CoStar, Reonomy, county records)
  - [x] Preview with dedupe results
  - [x] Submit for processing
  - [x] Progress indicator with polling
  - [x] Download results as CSV
- [x] Create `app/api/trace/bulk/route.ts` (submit endpoint)
- [x] Create `app/api/trace/bulk/status/route.ts` (poll endpoint)
- [x] Create `app/api/trace/bulk/download/route.ts` (download endpoint)
- [x] Install `xlsx` npm package for Excel support

### 12. Trace History
- [x] Create `app/(dashboard)/history/page.tsx`
  - [x] Paginated list of past traces
  - [x] Status badges
  - [x] Results summary (phones, emails)
  - [x] Charge display

### 13. API Access (Pro Tier + AcquisitionPRO Members)
- [x] Create `app/(dashboard)/settings/api-keys/page.tsx`
  - [x] Generate API key button
  - [x] Display/copy API key
  - [x] Regenerate key option
  - [x] Webhook URL configuration
  - [x] API documentation
- [x] Create `app/api/user/generate-api-key/route.ts`
- [x] Create `app/api/v1/trace/single/route.ts`
- [x] Create `app/api/v1/trace/bulk/route.ts`
- [x] Create API authentication middleware (`lib/api/auth.ts`)
- [x] ~~Implement rate limiting~~ — removed per user decision (no rate limits)

### 14. Results Display Components
- [x] Create `components/trace/TraceResultCard.tsx`
  - [x] Owner name(s)
  - [x] Phone numbers (up to 8) with type tags
  - [x] Emails (up to 5)
  - [x] Mailing address
  - [x] Match confidence indicator
  - [x] DNC status indicator
  - [x] Copy-to-clipboard functionality

### 15. Testing & Validation
- [ ] Test user registration and login
- [ ] Test subscription creation (Starter, Pro)
- [ ] Test single trace with new address
- [ ] Test single trace with duplicate (cached result)
- [ ] Test bulk upload with deduplication preview
- [ ] Test wallet deduction
- [ ] Test auto-rebill trigger
- [ ] Test AcquisitionPRO member verification
- [ ] Test API key generation and API access

---

## Phase 2: Post-MVP (Future)

### Integrations
- [x] HighLevel CRM - push traced contacts to CRM
- [x] Universal webhook support (Zapier, Make, n8n, Kartra, ClickFunnels, RealNex, etc.)
- [x] Integrations settings page

### Admin Dashboard
- [ ] User management (view, suspend, impersonate)
- [ ] Usage analytics (traces/day, revenue, costs)
- [ ] PropTracerPRO credit balance monitoring
- [ ] System health monitoring
- [ ] Manual credit adjustments

### Notifications
- [ ] Low balance email notifications ($10, $5 remaining)
- [ ] Job completion email notifications
- [ ] Payment failed notifications

### Analytics
- [ ] Usage analytics and reporting
- [ ] Revenue dashboard
- [ ] Cost tracking

---

## Environment Variables Required

```env
# App
NEXT_PUBLIC_APP_URL=

# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Stripe
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER=
STRIPE_PRICE_PRO=
STRIPE_PRICE_USAGE=

# Tracerfy
TRACERFY_API_KEY=
TRACERFY_API_URL=https://api.tracerfy.com
TRACERFY_WEBHOOK_SECRET=

# HighLevel
HIGHLEVEL_API_KEY=
HIGHLEVEL_LOCATION_ID=
HIGHLEVEL_MEMBER_CUSTOM_FIELD=

# App Config
TRACE_COST_PER_RECORD=0.009
TRACE_CHARGE_PER_SUCCESS=0.07
DEDUPE_WINDOW_DAYS=90
WALLET_MIN_BALANCE_THRESHOLD=10.00
WALLET_DEFAULT_REBILL_AMOUNT=25.00
WALLET_MIN_REBILL_AMOUNT=25.00
```

---

## Review Section

### Implementation Summary (Session 1)

**Date:** December 23, 2024

**What was built:**

1. **Project Foundation**
   - Next.js 16.1.1 with App Router, TypeScript, Tailwind CSS 4
   - shadcn/ui component library with 14 core components
   - Complete folder structure per specification

2. **Database Layer**
   - Complete SQL schema in `supabase/schema.sql`
   - All 6 tables with proper relationships
   - Database functions for wallet operations
   - Row Level Security policies
   - Indexes for performance

3. **Authentication**
   - Login page with email/password and magic link
   - Registration with email verification
   - Onboarding flow with AcquisitionPRO verification
   - Middleware for protected routes

4. **Dashboard**
   - Responsive sidebar navigation
   - Header with wallet balance and user menu
   - Dashboard home with usage stats
   - Settings pages (profile, billing, API keys)

5. **Skip Tracing**
   - Single property trace with full form
   - Deduplication logic (90-day cache)
   - TraceResultCard component with copy-to-clipboard
   - Tracerfy API client

6. **Billing**
   - Stripe client with lazy initialization
   - Checkout sessions for subscriptions
   - Wallet top-up functionality
   - Webhook handlers for all major events
   - Billing portal integration

7. **API Access**
   - API key generation for Pro/AcquisitionPRO members
   - Webhook URL configuration
   - Basic API documentation in UI

**Files Created:** ~50 files including:
- 15+ React pages and components
- 10+ API routes
- 5 utility libraries
- Database schema
- Type definitions
- Environment configuration

**What's remaining for MVP:**
- Bulk CSV upload feature
- Public API endpoints (`/api/v1/*`)
- Rate limiting middleware
- End-to-end testing

**Technical Notes:**
- TypeScript compiles successfully
- Build requires environment variables (Supabase, Stripe) to be set
- Uses Next.js 16 with middleware (deprecated warning - can migrate to proxy pattern later)

---

### Bulk CSV Upload Implementation Review

**Date:** January 27, 2026

**Package added:** `xlsx` (SheetJS) for Excel file support

**4 files created:**

1. **`app/api/trace/bulk/route.ts`** — POST submit endpoint
   - Authenticates user, parses AddressInput records, checks wallet balance
   - Runs `removeBatchDuplicates()` then `checkDuplicates()` for 90-day history
   - Creates `trace_jobs` row, builds Tracerfy CSV (no zip column), submits via `submitBulkTrace()`
   - Inserts pending `trace_history` rows for each record with `tracerfy_job_id`
   - Returns job summary with dedup stats and estimated cost

2. **`app/api/trace/bulk/status/route.ts`** — GET poll endpoint
   - Looks up `trace_jobs` by job_id + user_id
   - If already completed/failed, returns stored stats
   - Otherwise polls Tracerfy via `getJobStatus()`, processes results when ready
   - For each result: `parseTracerfyResult()`, updates `trace_history`, bills per match
   - Marks remaining unmatched rows as `no_match`, updates job as completed

3. **`app/api/trace/bulk/download/route.ts`** — GET download endpoint
   - Verifies job ownership and completed status
   - Queries `trace_history` by `tracerfy_job_id`
   - Builds CSV with address, owner, status, phones, emails, mailing info, charge
   - Returns as `text/csv` attachment

4. **`app/(dashboard)/trace/bulk/page.tsx`** — Frontend page
   - 3 phases: upload → processing → complete
   - Template download button for blank CSV
   - Drag-and-drop + file picker for .csv, .xlsx, .xls
   - Auto-detect column mapping from CoStar, Reonomy, Bexar County, etc.
   - Shows detected mapping, preview table (first 5 rows), record count
   - Validates required columns (address, city, state)
   - Splits owner_name from first/last if needed
   - Polls status endpoint every 5s, max 120 attempts (10 min)
   - Download Results CSV button on completion

**No existing files modified.** All backend infrastructure reused as-is.

---

### Remove Starter Plan & Gate Pro-Only Features

**Date:** January 29, 2026

**7 files modified:**

1. **`types/index.ts`** — Removed `'starter'` from `SubscriptionTier` union type
2. **`lib/constants.ts`** — Removed `STARTER_MONTHLY: 47` from `PRICING`, removed `starter` entry from `SUBSCRIPTION_TIERS`
3. **`app/(dashboard)/settings/billing/page.tsx`** — Removed Starter plan card, changed grid from 3-col to 2-col, simplified `handleSubscribe` to only support Pro, removed "Everything in Starter" from Pro features, Pay-As-You-Go card now highlights for all non-Pro users (including legacy starter users)
4. **`app/api/stripe/webhook/route.ts`** — Removed `STRIPE_PRICE_STARTER` branch; unrecognized prices default to `'wallet'`
5. **`components/dashboard/Header.tsx`** — Removed `case 'starter'` from tier badge switch; starter users now fall through to default Pay-As-You-Go badge
6. **`app/(dashboard)/settings/integrations/page.tsx`** — Added Pro-only gate: non-Pro/non-AcquisitionPRO users see an upgrade card instead of integrations content
7. **`app/api/integrations/highlevel/push/route.ts`** — Added Pro-only check: returns 403 with upgrade message for non-Pro/non-AcquisitionPRO users

**No database changes.** Existing starter users in the DB will be treated as wallet-tier (Pay-As-You-Go).

**TypeScript compiles clean.** Zero references to `'starter'` remain in the codebase.

---

---

### Tiered Per-Trace Pricing ($0.11 Wallet, $0.07 Pro/AcquisitionPRO)

**Date:** January 29, 2026

**11 files modified:**

1. **`lib/constants.ts`** — Added `CHARGE_PER_SUCCESS_WALLET: 0.11`, updated `SUBSCRIPTION_TIERS.wallet.perTrace` to use it, added `getChargePerTrace(subscriptionTier, isAcquisitionProMember)` helper function
2. **`app/api/trace/status/route.ts`** — Moved profile fetch before charge calc, added `is_acquisition_pro_member` to select, replaced flat `CHARGE_PER_SUCCESS` with `getChargePerTrace()` for charge and usage_records
3. **`app/api/trace/bulk/status/route.ts`** — Added `is_acquisition_pro_member` to profile select, added `chargePerTrace` via helper, updated all 3 charge references (already-completed return, per-result loop, usage_records insert)
4. **`app/api/trace/single/route.ts`** — Wallet balance check now uses `CHARGE_PER_SUCCESS_WALLET` ($0.11)
5. **`app/api/trace/bulk/route.ts`** — Estimated cost uses `CHARGE_PER_SUCCESS_WALLET` ($0.11)
6. **`app/api/v1/trace/single/route.ts`** — Wallet balance check uses `CHARGE_PER_SUCCESS_WALLET`
7. **`app/api/v1/trace/bulk/route.ts`** — Estimated cost uses `CHARGE_PER_SUCCESS_WALLET`
8. **`app/(dashboard)/page.tsx`** — Fetches user profile, computes `perTrace` via helper, uses it for bulk job charge display
9. **`app/(dashboard)/history/page.tsx`** — Same pattern: fetches profile, uses `getChargePerTrace()` for bulk charge display
10. **`app/(dashboard)/settings/billing/page.tsx`** — Pay-As-You-Go card text changed from `$0.07` to `$0.11`, Pro card stays `$0.07`
11. **`app/(dashboard)/trace/bulk/page.tsx`** — Added profile fetch on mount, replaced hardcoded `0.07` with tier-aware `perTraceRate` state

**Key design decisions:**
- Wallet balance checks always use the higher $0.11 rate (worst-case for wallet users, which is the only tier that hits these checks)
- Actual billing uses `getChargePerTrace()` which returns $0.07 for Pro/AcquisitionPRO, $0.11 for everyone else
- Fallback when profile can't be loaded defaults to $0.11 (wallet rate) to avoid undercharging

**TypeScript compiles clean.** No new files created. No database changes.

---

## Notes
- All changes should be minimal and simple per CLAUDE.md rules
- Never create fallback/fake data - allow application to fail if data is missing
- Verify plan with user before beginning implementation

---

### Integrations Page — CRM + Automation Platform Connections

**Date:** January 27, 2026

**4 files created, 3 files modified:**

1. **`app/(dashboard)/settings/integrations/page.tsx`** — New settings page
   - HighLevel CRM card: API key + Location ID inputs, show/hide toggle, Test Connection / Save / Disconnect buttons, connection status badge
   - Webhook & Automation card: webhook URL input + save, collapsible payload preview, API key display with copy, link to API docs

2. **`app/api/integrations/highlevel/save/route.ts`** — POST endpoint
   - Auth check, validates API key + location ID from body, saves to user_profiles via adminClient

3. **`app/api/integrations/highlevel/test/route.ts`** — POST endpoint
   - Auth check, reads credentials from body, tests GET to HighLevel contacts endpoint, returns connected/error

4. **`app/api/integrations/highlevel/disconnect/route.ts`** — POST endpoint
   - Auth check, nulls out highlevel_api_key and highlevel_location_id on user_profiles

5. **`lib/highlevel/client.ts`** — Modified
   - Added `pushTraceToHighLevel()` function: accepts user's API key + location ID, searches for existing contact by phone/email, creates or updates, tags with `proptracerpro`

6. **`app/api/trace/status/route.ts`** — Modified
   - After billing, fetches user's integration profile (webhook_url, highlevel fields)
   - Webhook dispatch: POSTs `trace.completed` event to webhook URL (fire-and-forget)
   - HighLevel push: calls `pushTraceToHighLevel()` for successful traces (fire-and-forget)

7. **`app/api/trace/bulk/status/route.ts`** — Modified
   - Expanded profile fetch to include integration fields
   - Collects successful results during processing loop
   - After job completion: webhook dispatch with `bulk_job.completed` summary, HighLevel push for each successful result

**No database changes.** All columns (`highlevel_api_key`, `highlevel_location_id`, `webhook_url`) already existed in `user_profiles`.

---

### History Page Redesign — Unified Trace + Bulk View

**Date:** January 27, 2026

**1 file modified:** `app/(dashboard)/history/page.tsx`

**Changes:**
1. Added imports — `TraceJob` type, `PRICING` constant, `Download` icon from lucide-react
2. Added `getTraceJobs()` — queries `trace_jobs` table, same pattern as `getTraceHistory()`
3. Parallel fetch with `Promise.all` for both datasets
4. Bulk row filtering — removes `trace_history` rows whose `tracerfy_job_id` matches a job
5. Unified sorted list — discriminated union `HistoryEntry` merges singles and bulk jobs, sorted by date desc
6. Updated table columns: Date, Description, Status, Results, Charge, Action
7. Single trace rows adapted to new layout (empty Action cell)
8. Bulk job rows: purple "Bulk" badge, file name, total/submitted counts, match results, computed charge, "Download CSV" link
9. Added `completed`, `pending`, `failed` status badges for job statuses
10. Updated header text to "Your recent traces and bulk uploads."

**No new files, no new API routes, no database changes.**

---

### Public API Endpoints, GHL Instructions, Rate Limit Removal

**Date:** January 29, 2026

**3 files created, 4 files modified:**

1. **`lib/api/auth.ts`** — New API key authentication helper
   - `validateApiKey(request)` — extracts Bearer token, looks up `user_profiles` by `api_key`, verifies Pro tier or AcquisitionPRO membership, logs to `api_logs`
   - `isAuthError()` — type guard for error handling
   - No rate limiting

2. **`app/api/v1/trace/single/route.ts`** — Public single trace endpoint
   - POST with JSON `{ address, city, state, zip, ownerName? }`
   - Uses `validateApiKey()` then reuses same dedup + Tracerfy + billing logic as internal `/api/trace/single`
   - Returns processing status with trace ID for polling

3. **`app/api/v1/trace/bulk/route.ts`** — Public bulk trace endpoint
   - POST with JSON `{ records: [...], webhookUrl? }`
   - Uses `validateApiKey()` then reuses same dedup + Tracerfy + billing logic as internal `/api/trace/bulk`
   - Returns job ID for status polling via existing `/api/trace/bulk/status`

4. **`app/(dashboard)/settings/integrations/page.tsx`** — Modified
   - Added collapsible "Where do I find my API Key & Location ID?" help section inside HighLevel CRM card
   - Covers GHL v1 (Business Profile → API Key), GHL v2 (Settings → Company → API Keys with contacts scope), and Location ID (Business Profile or URL)

5. **`app/(dashboard)/settings/api-keys/page.tsx`** — Modified
   - Removed "Rate limit: 100 requests/minute, 10,000 records/day" from upgrade card features list
   - Removed "Rate Limits" section from API quick reference

6. **`app/(dashboard)/settings/api-keys/docs/page.tsx`** — Modified
   - Removed entire Rate Limits card (100 req/min, 10k records/day)
   - Removed 429 Too Many Requests from error codes table

7. **`lib/constants.ts`** — Modified
   - Removed `API_LIMITS` constant (`REQUESTS_PER_MINUTE`, `RECORDS_PER_DAY`)

**No database changes.** All tables (`user_profiles`, `trace_history`, `trace_jobs`, `api_logs`) already existed.
