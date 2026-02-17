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

## AI Research Improvement: Better Brave Queries + Two-Pass Entity Resolution

**Date:** January 30, 2026

### Todo
- [x] A. Rewrite `buildSearchQueries()` — expand from 2-3 to 5-6 targeted queries
- [x] B. Add `buildFollowUpQueries()` — second-pass entity resolution + deceased/relatives
- [x] C. Update `researchProperty()` — two-pass flow when entity found without individual
- [x] D. Improve Claude system prompt — better instructions for distinguishing owners vs. managers
- [x] E. Verify TypeScript compiles clean

### Review

**3 files modified:**

1. **`lib/ai-research/client.ts`** — Main changes:
   - `buildSearchQueries()` expanded from 2-3 to 5-6 queries targeting county/gov records, deed/title records, assessor parcels, and tax records instead of generic property owner searches
   - New `buildFollowUpQueries()` function: fires second-pass queries when Pass 1 finds an entity (LLC/trust) without an individual behind it, or discovers an owner name that wasn't known upfront (to run deceased + family queries)
   - `researchProperty()` now runs two passes: initial search + Claude extraction, then follow-up queries if needed, then a second Claude extraction with combined context
   - Claude system prompt rewritten with explicit rules about distinguishing legal owners from property managers/brokers/agents, confidence scoring guidelines based on source quality, and new `confidence_reasoning` field
   - `emptyResult()` and `normalizeResult()` updated for new `confidence_reasoning` field
   - `researchPropertyBatch()` unchanged (stays single-pass for performance)

2. **`types/index.ts`** — Added `confidence_reasoning: string | null` to `AIResearchResult` interface

3. **`components/trace/AIResearchCard.tsx`** — Displays `confidence_reasoning` from Claude when available, falls back to generic confidence text

**No database changes needed.** The `ai_research` column stores JSON, so the new field is automatically included.

---

## Clear Cache Buttons

### Todo
- [x] A. Create `POST /api/cache/clear` endpoint — deletes AI research and/or trace cache from DB for a given address
- [x] B. Add "Clear AI Research Cache" button on AI research result — clears AI research from DB + resets UI
- [x] C. Update existing "Clear" button to also clear trace + AI research cache from DB for current address
- [x] D. Verify TypeScript compiles clean

### Review

**Date:** January 30, 2026

**1 file created, 1 file modified:**

1. **`app/api/cache/clear/route.ts`** (new) — POST endpoint that accepts `{ address, city, state, zip, type }` where type is `ai_research`, `trace`, or `all`. Authenticates user, computes address hash, then:
   - `ai_research`: nulls out `ai_research`, `ai_research_status`, `ai_research_charge` columns on matching trace_history rows
   - `trace` or `all`: deletes trace_history rows entirely for that user+address

2. **`app/(dashboard)/trace/single/page.tsx`** — Two changes:
   - **"Clear" button** (existing): now shows a `window.confirm` warning when results exist ("This will permanently delete the cached results..."), then calls the API to delete all cache for that address before resetting the form. If no results are showing, it just resets the form as before.
   - **"Clear AI Research Cache" button** (new): appears below the AI research card in red styling. Shows a `window.confirm` warning, then calls the API to clear only the AI research cache, resets AI research UI + owner name field. Next AI Search for that address will run fresh.

**If the user never clicks either clear button, the 90-day cache remains unchanged.**

**TypeScript compiles clean. No database changes.**

---

## Recursive Entity Resolution

### Todo
- [x] A. Extract `isLikelyBusiness()` into standalone helper
- [x] B. Replace `buildFollowUpQueries()` with `buildEntityResolutionQueries()` + `buildDeceasedQueries()`
- [x] C. Add `resolveEntityChain()` recursive function (up to 3 iterations)
- [x] D. Update `researchProperty()` to use new recursive flow
- [x] E. Update Claude system prompt for entity chain extraction
- [x] F. Remove old `buildFollowUpQueries()` function
- [x] G. Verify TypeScript compiles clean

### Review

**Date:** January 30, 2026

**1 file modified:** `lib/ai-research/client.ts`

**Changes:**

1. **Extracted `isLikelyBusiness()`** — Standalone helper function with expanded business indicators list (added `associates`, `partners`, `foundation`, `capital`, `realty`, `development`, `construction`, `apartments`). Replaces inline check in `buildSearchQueries()`.

2. **Replaced `buildFollowUpQueries()`** with two focused functions:
   - `buildEntityResolutionQueries(entityName, state)` — 4 SOS/corporate-focused queries (secretary of state, registered agent filings, business entity lookup, officers/principals)
   - `buildDeceasedQueries(personName, city, state)` — 2 queries for obituary/deceased + family/relatives

3. **Added `resolveEntityChain()`** — Recursive loop (up to 3 iterations) that:
   - Checks if current result is a business/trust without a person behind it
   - If `individual_behind_business` itself looks like a business, resolves that entity next
   - Uses a `Set` to prevent infinite loops on circular references
   - Each iteration: searches Brave for SOS records, accumulates context, re-extracts with Claude

4. **Updated `researchProperty()` flow** — Now three phases:
   - Pass 1: Initial property search + Claude extraction (unchanged)
   - Entity Resolution: `resolveEntityChain()` recursive loop (replaces old Pass 2)
   - Deceased/Relatives: Only runs if a person was discovered and no `ownerName` was provided upfront

5. **Updated Claude system prompt** — Added "ENTITY CHAIN RESOLUTION RULES" section instructing Claude to:
   - Extract registered agents, presidents, principals, officers from SOS filings
   - Set `individual_behind_business` to another entity name if the registered agent is a business (not a person)
   - Use ALL context from ALL passes when multiple entity resolution passes are provided

**No type changes. No other files affected. Batch research (`researchPropertyBatch`) unchanged (stays single-pass). TypeScript compiles clean.**

---

## Entity Resolution via Tracerfy Business Skip Trace

### Todo
- [x] A. Add `submitBusinessTrace()` to `lib/tracerfy/client.ts`
- [x] B. Add `parseBusinessTraceResult()` to `lib/tracerfy/client.ts`
- [x] C. Update `resolveEntityChain()` in `lib/ai-research/client.ts`
- [x] D. Update Claude system prompt for business trace data
- [x] E. Verify TypeScript compiles clean

### Review

**Date:** January 30, 2026

**2 files modified:**

1. **`lib/tracerfy/client.ts`** — Two new functions:
   - `submitBusinessTrace({ business_name, state })` — POSTs to `business-trace/` endpoint with CSV containing `business_name` and `state` columns. Same padding row trick, same auth pattern as `submitSingleTrace()`. Column mapping uses `business_name_column` and `state_column`.
   - `parseBusinessTraceResult(result)` — Extracts owner name, phones (primary + mobile 1-5 + landline 1-3), emails (1-5), and mailing address from flat Tracerfy response. Same field parsing logic as `parseTracerfyResult()`.

2. **`lib/ai-research/client.ts`** — Two changes:
   - `resolveEntityChain()` now runs a Tracerfy business trace **before** Brave queries in each iteration. Submits the entity name + state, polls up to 10 times (3s intervals, ~30s max), filters out padding rows, parses results. Business trace context is injected as a structured block (`TRACERFY BUSINESS SKIP TRACE RESULTS`) into the accumulated Claude context, followed by the existing Brave search results as supplementary data.
   - Claude system prompt updated with a new "TRACERFY BUSINESS SKIP TRACE RESULTS" section instructing Claude to treat business trace data as authoritative for contact info and to use the returned owner name as `individual_behind_business`.

**No type changes. No UI changes. No new files. Existing residential skip trace (`submitSingleTrace`) unchanged. TypeScript compiles clean.**

---

## Full Automated AI Research + Trace Pipeline

### Todo
- [x] Task 1: Create `/api/v1/research/single` — standalone AI research with API key auth
- [x] Task 2: Add `aiResearch` opt-in flag to `/api/v1/trace/single`
- [x] Task 3: Create `/api/v1/trace/status` — API-key-auth status polling
- [x] Task 4: Add research data to webhook payloads (both v1 status and session-auth status)
- [x] Task 5: Update API docs page with new endpoints + examples

### Review

**Date:** February 2, 2026

**2 files created, 3 files modified:**

1. **`app/api/v1/research/single/route.ts`** (new) — Standalone AI research endpoint with API key auth. Validates input, checks wallet balance ($0.15), checks 90-day cache, runs `researchProperty()`, charges only if owner found, fires `research.completed` webhook.

2. **`app/api/v1/trace/status/route.ts`** (new) — API-key-auth version of trace status polling. Same Tracerfy polling logic as session-auth version. Includes billing, CRM push (HighLevel), and webhook dispatch. Returns `research` field from `trace_history.ai_research` in both completed responses and webhook payloads.

3. **`app/api/v1/trace/single/route.ts`** (modified) — Added `aiResearch` flag. When `aiResearch: true` and no `ownerName`: runs `researchProperty()` first, uses discovered owner (`individual_behind_business || owner_name`) as the Tracerfy input, stores research on trace record, charges $0.15 research fee. When `ownerName` is already provided, research is skipped. Wallet balance check includes research fee when applicable. Response includes `research` and `researchCharge` fields.

4. **`app/api/trace/status/route.ts`** (modified) — Added `research: trace.ai_research || null` to the `trace.completed` webhook payload. One-line change.

5. **`app/(dashboard)/settings/api-keys/docs/page.tsx`** (modified) — Added: AI Research endpoint (`POST /v1/research/single`), Trace Status endpoint (`GET /v1/trace/status`), `aiResearch` flag documentation on single trace, `research.completed` webhook event, enhanced `trace.completed` webhook with research fields. Updated n8n/Make/cURL examples to show full automated workflow (submit with `aiResearch: true` → poll status → use results).

**TypeScript compiles clean. No database changes needed.**

---

## Fix iframe embedding for AcquisitionPRO (HighLevel)

**Problem:** `proptracerpro.com refused to connect` when loaded in iframe on `app.acquisitionpro.io`.

**Root Cause:** The `frame-ancestors` CSP in `next.config.ts` lists `goacquisitionpro.com` but NOT `acquisitionpro.io` — the actual parent domain shown in the screenshot. Also `X-Frame-Options: ALLOWALL` is not a valid HTTP value.

### Todo
- [x] A. Update `next.config.ts`: Add `https://acquisitionpro.io` and `https://*.acquisitionpro.io` to `frame-ancestors`
- [x] B. Update `next.config.ts`: Remove invalid `X-Frame-Options: ALLOWALL` header (CSP frame-ancestors is the modern replacement)
- [x] C. Update `lib/supabase/middleware.ts`: Set CSP `frame-ancestors` header on all middleware responses (redirects don't get next.config headers)

### Review

**Date:** February 2, 2026

**2 files modified:**

1. **`next.config.ts`** — Added `https://acquisitionpro.io https://*.acquisitionpro.io` to `frame-ancestors` CSP. Removed invalid `X-Frame-Options: ALLOWALL` header entirely.

2. **`lib/supabase/middleware.ts`** — Added CSP header to all 4 response paths: initial `NextResponse.next()`, cookie `setAll` reassignment, login redirect, and dashboard redirect. This ensures the `frame-ancestors` directive is present even on redirect responses that bypass `next.config.ts` headers.

**TypeScript compiles clean. No new files. No database changes.**

---

## Notes
- All changes should be minimal and simple per CLAUDE.md rules
- Never create fallback/fake data - allow application to fail if data is missing
- Verify plan with user before beginning implementation

---

### AI Property Research Feature Implementation

**Date:** January 30, 2026

**6 files created, 6 files modified:**

#### New Files:
1. **`lib/brave/client.ts`** — Brave Search API client
   - `searchBrave(query)` — single query, returns `{ title, url, description }[]`
   - `searchBraveBatch(queries)` — fires multiple queries concurrently respecting 20/sec rate limit
   - Uses `BRAVE_SEARCH_API_KEY` env var

2. **`lib/ai-research/client.ts`** — AI research orchestrator
   - `researchProperty(address, city, state, zip, ownerName?)` — single record research
   - `researchPropertyBatch(records[])` — batch research with batched Claude calls (20 records/prompt)
   - Builds 2-3 Brave search queries per property (owner lookup, entity resolution, deceased check)
   - Sends search results to Claude Opus 4.5 for structured extraction
   - Returns `AIResearchResult` with owner name, type, deceased status, relatives, property type, confidence

3. **`app/api/research/single/route.ts`** — Single property research endpoint
   - POST with address fields, checks wallet balance ($0.15), checks 90-day cache
   - Charges only when owner is found, stores result on trace_history

4. **`app/api/research/bulk/route.ts`** — Bulk research endpoint
   - Accepts up to 200 records per request, `maxDuration: 300` for Vercel Pro
   - Runs batch research, charges per found owner, returns enriched records

5. **`app/api/research/bulk/status/route.ts`** — Bulk research job status endpoint

6. **`components/trace/AIResearchCard.tsx`** — Research results display component
   - Shows owner name/type, business entity, deceased status, relatives/decision makers, property type
   - Confidence bar, charge display, matches TraceResultCard styling

7. **`supabase/migrations/20260130_add_ai_research.sql`** — Database migration
   - Adds `ai_research`, `ai_research_status`, `ai_research_charge` columns to trace_history
   - Creates `research_jobs` table with RLS policies

#### Modified Files:
1. **`types/index.ts`** — Added `AIResearchResult` interface, added ai_research fields to `TraceHistory`
2. **`lib/constants.ts`** — Added `AI_RESEARCH` config block (charge, rate limits, batch sizes, model)
3. **`app/api/trace/single/route.ts`** — Accepts optional `ai_research` in request body, stores on trace_history row
4. **`app/(dashboard)/trace/single/page.tsx`** — Added "AI Search" button next to owner name field, AIResearchCard in results area, auto-populates owner name on success
5. **`app/(dashboard)/trace/bulk/page.tsx`** — Added "AI Research" checkbox toggle when records missing owners, new "researching" phase with progress, two-phase flow (research → trace), cost estimates for both phases
6. **`app/api/trace/bulk/download/route.ts`** — Adds owner_type, deceased, relatives, property_type columns to CSV when AI research data present
7. **`supabase/schema.sql`** — Updated with ai_research columns on trace_history, research_jobs table, indexes, RLS policies

#### New Environment Variables:
- `BRAVE_SEARCH_API_KEY` — Brave Search API key
- `ANTHROPIC_API_KEY` — Claude API key for AI research

**TypeScript compiles clean. No existing tests broken.**

---

### Marketing Landing Page Implementation

**Date:** January 29, 2026

**3 files created, 6 files modified:**

1. **`app/(dashboard)/page.tsx`** — Moved to `app/(dashboard)/dashboard/page.tsx` (no content changes)
2. **`app/page.tsx`** — New server component: checks auth, redirects logged-in users to `/dashboard`, renders `<LandingPage />` for visitors
3. **`components/landing/LandingPage.tsx`** — Full marketing landing page with 9 sections:
   - Sticky Nav (logo, anchor links, Sign In / Get Started, mobile hamburger)
   - Hero (gradient bg, headline, subhead, 2 CTAs)
   - Social Proof Bar (3 stats)
   - Features (3x2 card grid with icons, Pro badges)
   - How It Works (3 numbered steps)
   - Pricing (3 cards: Pay-As-You-Go $0.11, Pro $97/mo $0.07, AcquisitionPRO $0.07)
   - FAQ (6 expandable questions)
   - Final CTA (navy bg, orange button)
   - Footer (same copyright/address/links as dashboard footer)
4. **`app/globals.css`** — Added brand color CSS variables (navy, navy-light, brand-orange, brand-orange-light, steel-blue) + smooth scrolling
5. **`lib/supabase/middleware.ts`** — Added `'/'` to public routes, changed authenticated redirect from `'/'` to `'/dashboard'`
6. **`components/dashboard/Sidebar.tsx`** — Dashboard href `'/'` → `'/dashboard'`, logo href `'/'` → `'/dashboard'`
7. **`components/dashboard/Header.tsx`** — Dashboard href `'/'` → `'/dashboard'`, both mobile logo links `'/'` → `'/dashboard'`
8. **`app/(auth)/login/page.tsx`** — `window.location.href` from `'/'` to `'/dashboard'`
9. **`app/(auth)/onboarding/page.tsx`** — `window.location.href` from `'/'` to `'/dashboard'`

**No new dependencies.** Uses existing `next/image`, `next/link`, `lucide-react`, shadcn `Button`/`Card`/`Badge`.

**TypeScript compiles clean.**

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

---

## Security Audit

**Date:** February 17, 2026

### Plan

- [x] Explore full codebase structure (79 TypeScript files, 23 API routes)
- [x] Audit all API route handlers for vulnerabilities
- [x] Audit all library/utility files for vulnerabilities
- [x] Audit all frontend components for vulnerabilities
- [x] Consolidate and categorize findings by severity
- [ ] Fix approved vulnerabilities

---

### Findings — CRITICAL

#### C1. SSRF via Unvalidated Webhook URLs
**Files:** `app/api/trace/status/route.ts:189-206`, `app/api/trace/bulk/status/route.ts:223-241`, `app/api/v1/trace/status/route.ts:159-176`, `app/api/v1/research/single/route.ts:107-121`, `app/api/v1/trace/bulk/route.ts:77-82`
**Risk:** The `webhook_url` stored on user profiles is fetched and used in `fetch()` calls with zero URL validation. A user can set their webhook URL to internal network addresses (e.g., `http://169.254.169.254/latest/meta-data/` on AWS, `http://localhost:5432`). The server will POST sensitive trace data to those addresses, enabling internal network probing and data exfiltration. The v1 bulk endpoint also allows overwriting the stored webhook URL via the `webhookUrl` request body parameter without any validation.
**Fix:** Validate webhook URLs against an allowlist — require HTTPS, block private/internal IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x, 127.x, ::1), and optionally resolve DNS before fetching to prevent DNS rebinding.

#### C2. Race Condition on Wallet Balance (TOCTOU)
**Files:** `app/api/trace/single/route.ts:50-60`, `app/api/trace/status/route.ts:171-178`, `app/api/trace/bulk/route.ts:80-91`, `app/api/trace/bulk/status/route.ts:186-193`, `app/api/research/single/route.ts:45-50`
**Risk:** Wallet balance is checked at submission time but deducted later when results arrive (in the status polling endpoint). A user can submit many traces concurrently — all pass the balance check, but deductions happen later, allowing significant wallet overdraft. This is a Time-of-Check-to-Time-of-Use (TOCTOU) vulnerability.
**Fix:** Use a single atomic database function that checks AND deducts in one transaction (or use a `SELECT ... FOR UPDATE` lock). The existing `deduct_wallet_balance` RPC may already guard against negative balances at the DB level — needs verification.

#### C3. Debug Data Exposed in Production API Responses
**File:** `app/api/trace/status/route.ts:82-88, 230-239`
**Risk:** The `_debug` field in API responses exposes raw Tracerfy API data (`tracerfy_raw: statusResult.rawData`), internal job IDs, result counts, and raw PII (phone numbers, emails). This leaks vendor implementation details to end users and is also rendered in the frontend UI (`app/(dashboard)/trace/single/page.tsx:162-163, 468-472`).
**Fix:** Remove `_debug` fields from all production responses. If debugging is needed, gate it behind an environment variable (e.g., `NODE_ENV === 'development'`).

#### C4. Internal Error Messages Forwarded to Clients
**Files:** `app/api/trace/single/route.ts:184-188`, `app/api/trace/bulk/route.ts:210-214`, `app/api/research/single/route.ts:122-127`, `app/api/research/bulk/route.ts:140-145`, `app/api/v1/research/single/route.ts:131-136`, `app/api/cache/clear/route.ts:50-53`, `lib/brave/client.ts:41-43`, `lib/ai-research/client.ts:488-491`
**Risk:** Raw `error.message` strings are returned to clients in 500 responses. These can contain database connection strings, SQL errors, file paths, third-party API error details, or other internal information depending on the error source.
**Fix:** Return generic error messages (e.g., "An internal error occurred") in production. Log the detailed error server-side.

---

### Findings — HIGH

#### H1. No Rate Limiting on Any Endpoint
**Files:** All 23 API routes, `lib/api/auth.ts:17` (comment: "No rate limiting")
**Risk:** Enables brute-force attacks on API key authentication, wallet draining via rapid trace submissions, abuse of expensive AI research endpoints, and denial-of-service via concurrent 10,000-record bulk uploads.
**Fix:** Add rate limiting middleware — at minimum on the v1 API key-authenticated endpoints and login. Consider using an in-memory store (for single-server) or Redis (for distributed) with per-user/per-IP limits.

#### H2. API Keys Stored in Plaintext
**Files:** `app/api/user/generate-api-key/route.ts:32-45`, `lib/api/auth.ts:47-52`
**Risk:** API keys are stored and compared as plaintext in the database. A database compromise exposes all keys immediately. The database equality lookup also enables timing side-channel attacks (non-constant-time comparison).
**Fix:** Store a SHA-256 hash of the API key. Show the full key to the user only once at generation time. Look up by a stored prefix (first 8 chars) then compare the full hash with a constant-time function.

#### H3. Open Redirect in Auth Callback
**File:** `app/auth/callback/route.ts:7,30`
**Risk:** The `next` query parameter is used directly in a redirect (`NextResponse.redirect(\`${origin}${next}\`)`) without validation. Crafted values could redirect users to malicious pages after login.
**Fix:** Validate that `next` starts with `/` and does not contain `//` or protocol-relative patterns. Use an allowlist of valid redirect paths.

#### H4. All API Routes Bypass Middleware Authentication
**File:** `lib/supabase/middleware.ts:54`
**Risk:** The middleware explicitly skips auth checks for all `/api/` routes (`!request.nextUrl.pathname.startsWith('/api/')`). Any API route that forgets to implement its own auth check is completely unprotected. This is a dangerous default.
**Fix:** Remove the `/api/` exemption from middleware. Instead, explicitly list public API routes (like the Stripe webhook) that should skip auth. Alternatively, add a shared auth wrapper that all API routes must use.

#### H5. Client Can Set `is_acquisition_pro_member` Directly
**File:** `app/(auth)/onboarding/page.tsx:63-74`
**Risk:** The onboarding page writes `is_acquisition_pro_member: true` and `acquisition_pro_verified_at` directly to the database from the client using the browser Supabase client. The verification status is held in React state, so a user can set it to `'verified'` via browser DevTools and call `handleComplete()` to grant themselves AcquisitionPRO membership — bypassing the actual HighLevel verification.
**Fix:** Move the membership verification write to a server-side API route that performs the HighLevel verification itself and sets the flag. The client should only trigger the verification, not write the result.

#### H6. SameSite=None on Auth Cookies (Weakened CSRF Protection)
**Files:** `lib/supabase/client.ts:8-11`, `lib/supabase/server.ts:19-21`, `lib/supabase/middleware.ts:29-32`
**Risk:** Auth cookies are set with `SameSite=None` (for HighLevel iframe embedding). This means cookies are sent on all cross-site requests, weakening CSRF protection. Combined with no CSRF tokens on any POST endpoint, malicious sites could trigger state changes (traces, billing, credential overwrites) for logged-in users.
**Fix:** Since `SameSite=None` is required for iframe embedding, add explicit CSRF tokens to all state-mutating POST endpoints. Alternatively, verify the `Origin` or `Referer` header on POST requests.

#### H7. HighLevel API Keys Stored Unencrypted
**File:** `app/api/integrations/highlevel/save/route.ts:29-35`
**Risk:** Users' third-party HighLevel API keys are stored in plaintext in the database. A database compromise exposes all users' CRM accounts.
**Fix:** Encrypt third-party credentials at rest using an application-level encryption key (e.g., AES-256-GCM). Decrypt only when needed for API calls.

#### H8. Full User Profile Fetched to Client via `select('*')`
**Files:** `app/(dashboard)/settings/api-keys/page.tsx:38-40`, `app/(dashboard)/settings/integrations/page.tsx:73-76`, `app/(dashboard)/settings/profile/page.tsx:31-35`, `lib/api/auth.ts:48-52`, `app/api/trace/single/route.ts:39`
**Risk:** Multiple locations use `.select('*')` which returns all profile columns (including `api_key`, `highlevel_api_key`, `stripe_customer_id`, `wallet_balance`) to client-side code or API handlers. This increases the attack surface for accidental secret leakage.
**Fix:** Replace `select('*')` with explicit column lists that include only the fields actually needed.

---

### Findings — MEDIUM

#### M1. Incomplete Content Security Policy
**Files:** `next.config.ts:4-14`, `lib/supabase/middleware.ts:4`
**Risk:** CSP only sets `frame-ancestors`. Missing: `default-src`, `script-src`, `style-src`, `connect-src`, `img-src`, `object-src`, `form-action`, `base-uri`. No XSS mitigation beyond React's default escaping.
**Fix:** Add a comprehensive CSP with at minimum `default-src 'self'`, `script-src 'self'`, and `connect-src` scoped to known API domains.

#### M2. Bulk Research Wallet Check Only Validates One Record's Cost
**File:** `app/api/research/bulk/route.ts:61-67`
**Risk:** The code computes `maxCost = records.length * AI_RESEARCH.CHARGE_PER_RECORD` but then only checks `profile.wallet_balance < AI_RESEARCH.CHARGE_PER_RECORD` (single record). A user with $0.15 can submit 200 records ($30 worth). This is a financial loss bug.
**Fix:** Change the balance check to use `maxCost` instead of single-record cost.

#### M3. No Maximum Validation on Wallet Top-Up Amount
**File:** `app/api/stripe/wallet-topup/route.ts:16-23`
**Risk:** Minimum is checked ($25) but no maximum is enforced. No type validation — `amount` could be a string, negative, NaN, or Infinity.
**Fix:** Add maximum check (`PRICING.WALLET_MAX_REBILL_AMOUNT`), validate type is number, validate is positive and finite.

#### M4. Query Parameter Injection in HighLevel Test Endpoint
**File:** `app/api/integrations/highlevel/test/route.ts:28-36`
**Risk:** `highlevel_location_id` is interpolated directly into a URL without encoding. A malicious value could inject additional query parameters.
**Fix:** Use `encodeURIComponent()` on `highlevel_location_id` or use a URL builder.

#### M5. PII Logged to Console in Production
**Files:** `app/api/trace/status/route.ts:128-131`, `app/api/v1/trace/status/route.ts:69-71`
**Risk:** Phone numbers, email addresses, and physical addresses are logged via `console.log`. These often end up in log aggregation services, violating data privacy regulations (GDPR, CCPA).
**Fix:** Remove PII from log statements or use a structured logger with PII redaction.

#### M6. Unvalidated AI Research Source URLs Rendered as Links
**File:** `components/trace/AIResearchCard.tsx:164-183`
**Risk:** URLs from AI-generated research results are rendered as clickable `<a>` tags. If the AI returns a `javascript:` URL, it could be an XSS vector. React 19 may block `javascript:` hrefs, but this depends on version behavior.
**Fix:** Validate URL scheme (allow only `http:` and `https:`) before rendering as a link.

#### M7. Localhost Fallback for Stripe Redirect URLs
**Files:** `app/api/stripe/create-checkout/route.ts:51`, `app/api/stripe/create-portal/route.ts:26`, `app/api/stripe/wallet-topup/route.ts:48`
**Risk:** `process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'` — if the env var is unset in production, Stripe redirects go to localhost.
**Fix:** Throw an error if `NEXT_PUBLIC_APP_URL` is not set instead of falling back to localhost.

#### M8. CSV Injection in Tracerfy Padding Row
**File:** `lib/tracerfy/client.ts:47`
**Risk:** The padding row interpolates `data.city` and `data.state` without using the `esc()` function, unlike all other fields. A malicious city/state value could break CSV structure.
**Fix:** Use the `esc()` function on the padding row values as well.

#### M9. Client-Side Direct Writes to Financial Fields
**File:** `app/(dashboard)/settings/billing/page.tsx:115-123`
**Risk:** Auto-refill settings (`wallet_auto_rebill_enabled`, `wallet_low_balance_threshold`, `wallet_auto_rebill_amount`) are written directly from the client to Supabase without server-side validation. A user could set arbitrary values via DevTools.
**Fix:** Move financial field updates to a server-side API route with proper validation (min/max bounds, type checks).

#### M10. SSRF via Unvalidated Download URL in Business Trace
**File:** `lib/tracerfy/client.ts:193-203`
**Risk:** `downloadBusinessTraceResults(downloadUrl)` fetches a URL from the FastAppend API response without validating its origin. If the API response is compromised or manipulated, the server could be directed to fetch arbitrary internal URLs.
**Fix:** Validate the download URL against expected domains (e.g., `*.fastappend.com`).

#### M11. Business Cost Info Exposed in Client Bundle
**File:** `lib/constants.ts:16`
**Risk:** Internal cost basis (`COST_PER_RECORD: 0.009`) is exported alongside customer pricing. If this file is imported in any client component (likely, since it contains `US_STATES` and other UI constants), internal margins are exposed in the JavaScript bundle.
**Fix:** Separate internal cost constants into a server-only module (e.g., `lib/constants.server.ts`).

---

### Findings — LOW

#### L1. Overly Broad `/auth/` Public Route Prefix
**File:** `lib/supabase/middleware.ts:50`
**Risk:** `request.nextUrl.pathname.startsWith('/auth/')` makes ALL `/auth/*` routes public. If a new protected route is added under `/auth/`, it would be public by default.
**Fix:** Use an explicit allowlist instead of a prefix match.

#### L2. Fire-and-Forget Audit Logging
**File:** `lib/api/auth.ts:76-84`
**Risk:** API request logging uses `.then(() => {})` which silently swallows all errors. Also hardcodes `status_code: 200` before the request is processed. Failed log inserts leave no audit trail.
**Fix:** At minimum, add `.catch(err => console.error('Audit log failed:', err))`. Consider logging the actual response status.

#### L3. API Key Regeneration Without Confirmation/Cooldown
**File:** `app/api/user/generate-api-key/route.ts`
**Risk:** Calling this endpoint unconditionally replaces the existing API key with no confirmation, notification, or cooldown. A CSRF attack could silently break a user's integrations.
**Fix:** Require confirmation (e.g., password re-entry) before regenerating, and/or add a cooldown period.

#### L4. Webhook Error Processing Silently Swallowed
**File:** `app/api/stripe/webhook/route.ts:153-161`
**Risk:** The webhook handler returns 200 even when event processing fails internally (the catch block catches the error but still returns `{ received: true }`). Stripe will not retry failed events.
**Fix:** Return a 500 status on processing failures so Stripe retries the event.

#### L5. Raw Supabase Error Messages Displayed in UI
**Files:** `app/(auth)/login/page.tsx:131`, `app/(auth)/register/page.tsx:128`, `app/(auth)/onboarding/page.tsx:165`, `app/(dashboard)/settings/integrations/page.tsx:294`
**Risk:** Supabase error messages (which may contain database column names, constraint names, or internal error codes) are displayed directly to users.
**Fix:** Map common Supabase errors to user-friendly messages.

---

### Prioritized Remediation Recommendations

**Immediate (do first):**
1. C3 — Remove `_debug` fields from production API responses
2. C4 — Sanitize error messages (return generic, log specific)
3. M2 — Fix bulk research wallet balance check (use `maxCost`)
4. C1 — Add webhook URL validation (HTTPS only, block private IPs)
5. H5 — Move membership verification write to server-side

**Soon:**
6. H2 — Hash API keys before storage
7. H4 — Remove blanket `/api/` exemption from middleware auth
8. H1 — Add rate limiting (at minimum on v1 API and login)
9. C2 — Verify/fix atomic wallet deduction
10. H6 — Add CSRF protection (Origin header check or tokens)
11. H8 — Replace `select('*')` with explicit columns

**Later:**
12. H7 — Encrypt HighLevel API keys at rest
13. M1 — Expand CSP beyond just `frame-ancestors`
14. M3/M9 — Add server-side validation for financial fields
15. M5 — Remove PII from console logs
16. M6 — Validate AI research source URL schemes
17. All remaining MEDIUM and LOW items
