import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { lookupBusinessTrace } from '@/lib/tracerfy/client';
import { traceCreditFromFastAppend } from '@/lib/ai-research/contacts';
import { deductOrZero } from '@/lib/wallet/deduct';
import { collectedChargeFor } from '@/lib/wallet/collectedCharge';
import { TRACE_TIER, foldBillingWrite } from '@/lib/trace/billedRows';
import { BLANK_OWNER_SKIP_STATUS } from '@/lib/trace/blankOwnerSkip';
import {
  ENTITY_QUEUED_STATUSES,
  ENTITY_TRACE_ATTEMPTS,
  MAX_ENTITY_TRACE_ATTEMPTS,
  attemptOf,
  nextAfterFailedAttempt,
  processingStatusFor,
} from '@/lib/trace/entityTraceAttempts';
import { PRICING } from '@/lib/constants';
import { chargePerTrace, pricePlanFor } from '@/lib/suite/pricing';
import type { StepReport } from '@/lib/routing/executeRoute';
import { lookupPersonTrace } from '@/lib/tracerfy/client';
import { lookupDossier } from '@/lib/tracerfy/dossier';
import {
  FAILSAFE_PRICE_PLAN,
  type ParcelInput,
  type PricePlan,
  type RouteStep,
} from '@/lib/routing/ownerRoute';
import {
  runTier1Record,
  NotATier1PlanError,
  VendorBudgetThrottledError,
} from '@/lib/trace/singleTier1';
import { isParcelKey } from '@/lib/trace/historyDisplay';
import {
  TIER1_ATTEMPTS,
  TIER1_MAX_ATTEMPTS,
  TIER1_QUEUED_STATUSES,
  TIER1_SETTLED_STATUS,
  tier1AttemptOf,
  tier1NextAfterFailedAttempt,
  tier1ProcessingStatusFor,
} from '@/lib/trace/tier1Queue';
import { TIER1_OUTCOME } from '@/lib/trace/tier1Outcome';
import {
  pruneVendorRateWindows,
  reservationForSteps,
  reserveVendorCalls,
} from '@/lib/trace/vendorRateBudget';
import type { AIResearchResult } from '@/types';

/**
 * Vercel Cron, TWO LANES, ONE COLUMN. Runs every minute (vercel.json).
 *
 *   THE TIER 1 LANE (Phase 2A, spec 3.2). Every owned row of a WEB bulk upload, worked through
 *   planRoute() and executeRoute() one record at a time and settled through the SAME
 *   runTier1Record() the two single routes bill with. Rows wear tier1_* statuses.
 *
 *   THE LEGACY ENTITY LANE (unchanged). Rows API bulk and the MCP tool still enqueue with the bare
 *   'queued', resolved through a FastAppend business trace. Phase 2B moves those two surfaces onto
 *   the Tier 1 lane and Phase 4 deletes this one.
 *
 * THE TWO STATUS SETS ARE DISJOINT and lib/trace/__tests__/tier1Queue.test.ts asserts it. That is
 * the whole safety argument for sharing one column: a value in both sets is one row worked twice,
 * by two lanes, under two settle shapes.
 *
 * WHY THE TIER 1 CLAIM PROTOCOL IS A COPY of app/api/cron/sweep-property-traces (spec 3.2 says to
 * copy that one): atomic compare-and-swap against the status just read, `claimed_at` set with the
 * flip, a shared cursor across Promise.all workers rather than fixed slices, and a per-rung stale
 * revert in which a dead claim SPENDS an attempt. Every one of those was paid for by a real failure.
 * This lane mirrors them rather than improving on them.
 *
 * WHAT IT DOES NOT COPY FROM THAT CRON: THE MONEY. Tier 2 bills on whether the dossier ANSWERED,
 * per record submitted, so a miss is billed. Tier 1 bills only a name-matched result carrying a
 * phone or an email, so a miss is FREE. That gate is not re-derived here at all: runTier1Record owns
 * it (spec 6.1, lessons L-030).
 *
 * AND IT DOES NOT COPY THE RETRY EITHER. Under D7 and spec 5.1 a VENDOR failure is never retried:
 * the record ends busy_try_again at once, free, and the customer is told to try again in 5 minutes.
 * The ladder's rungs exist only for a claim that DIED, which spec 5.1 does recover automatically.
 */

/**
 * THE LEGACY ENTITY LANE, below. Resolves the ENTITY-owned rows of a bulk job, the ones parked in
 * `ai_research_status = 'queued'`.
 *
 * RENAMED 2026-09-17 from sweep-bulk-research. It used to call
 * researchProperty(), the Brave plus Claude AI Search engine, which has been
 * removed. It now calls lookupBusinessTrace(), the SYNCHRONOUS FastAppend
 * business-trace lookup, which does the same FastAppend half with no web search
 * and no LLM in the path. Everything else about this cron is unchanged on
 * purpose: the state machine, the stale-claim recovery, the atomic claim, and
 * what it does with the money.
 *
 * WHAT CHANGED IN THE MONEY. The $0.15 AI research fee is gone. It paid for the
 * search-and-extract step that no longer happens, so `ai_research_charge` is
 * written as 0 on every row this cron touches from here on. The column stays,
 * and the two refund sites that read it (app/api/cron/sweep-business-traces and
 * lib/trace/settleBulkJob) keep working for the 1,301 historical rows that
 * carry a real value in it. Pricing is now the plain tier 1 model: a successful
 * trace bills the caller's plan rate, a miss is free.
 *
 * WHAT HAPPENS TO A ROW WITH NO OWNER NAME. Nothing, and it costs nothing. The
 * engine that used to find an owner from an address alone is gone and no
 * replacement is wired on the bulk path yet, so the row is marked with
 * BLANK_OWNER_SKIP_STATUS and the reason is served alongside it. See
 * lib/trace/blankOwnerSkip.ts. The v1 bulk route and the MCP submit no longer
 * queue such rows at all; this branch is the safety net for rows queued by an
 * earlier deployment, and it is what stops them sitting in 'queued' forever.
 *
 * WHAT HAPPENS WHEN THE VENDOR CANNOT BE REACHED. lookupBusinessTrace() never
 * throws; a lapsed API key, a blank state and a 503 all return success:false.
 * Retrying that is right, because most of it is transient, but retrying it
 * FOREVER is not: the claim below takes the five OLDEST queued rows every
 * minute, so five poisoned rows used to be re-claimed and re-queued every
 * minute and no newer row was ever reached. Each row now carries its attempt
 * number in `ai_research_status` and gives up after
 * MAX_ENTITY_TRACE_ATTEMPTS with a readable reason and no charge. See
 * lib/trace/entityTraceAttempts.ts.
 *
 * ON business_trace_jobs. That table and its sweeper are untouched and still
 * finalize every job the old engine queued. This cron adds no new rows to it:
 * lookupBusinessTrace answers on the same request, so there is no pending state
 * to record. A late FastAppend result therefore still reaches a row through
 * sweep-business-traces, which is the async recovery path, unchanged.
 */
export const maxDuration = 300;

/**
 * The legacy entity lane. Unchanged, and deliberately small: Phase 4 deletes this lane.
 *
 * Unchanged from sweep-bulk-research. Each row is now far cheaper (one synchronous FastAppend call,
 * plus at most one Tracerfy submit) so this is a conservative ceiling rather than a tight one.
 * Raising it is safe but is a throughput change, not part of this removal.
 */
const ENTITY_MAX_ROWS_PER_RUN = 5;

/**
 * The Tier 1 lane. Sized from measurement, not from a guess.
 *
 * LATENCY. The Phase 1 live check measured 1.5 to 2.0 s on a miss and 4.1 to 4.4 s on a hit
 * (tasks/phase1-live-check.md), so about 3 s per record. 120 rows at concurrency 8 is 15 rounds,
 * roughly 45 s, inside maxDuration 300 with room for the entity lane's five sequential rows.
 *
 * THROUGHPUT. 120 rows a minute clears a 500-record job in 4.2 minutes, inside spec 3.2's 2-to-5
 * minute target.
 *
 * THE SHARED BUDGET, AND THIS PARAGRAPH IS AN ESTIMATE RATHER THAN A GUARANTEE. The web upload sends
 * no parcel id (D5), so planRoute emits at most ONE Tracerfy step per record here: 120 calls a minute
 * at worst from this lane. sweep-property-traces draws at LEAST 240 (120 rows at concurrency 5, two
 * calls each) and can draw far more, because that figure is a floor: lib/routing/ownerRoute.ts says
 * so about it in capitals, and D21(c) with D40 put no cap on how many owners a dossier record tries,
 * which is 2 + 2N calls for N individual owners. So "360 of 450" describes the ordinary case and
 * nothing more.
 *
 * WHAT ACTUALLY HOLDS THE LIMIT is lib/trace/vendorRateBudget.ts, over a sliding 60 seconds (spec
 * 5.3), drawn per CALL on THIS lane, whose steps are independent so a refusal costs nothing. This
 * comment does not enforce anything and must not be read as if it did. The plan's Task 6 header
 * states what the budget holds on each lane, and what the tier 2 lane's once-per-record reservation
 * costs, since that lane must never be refused after its dossier is bought.
 */
export const TIER1_MAX_ROWS_PER_RUN = 120;
export const TIER1_CONCURRENCY = 8;

/**
 * Each record's own ladder budget. A record that cannot finish inside it ends busy_try_again, free,
 * and its resend resumes from the step log. Without it one hung ladder holds a worker for the
 * 25 s per-call ceiling times every step it has left.
 */
const TIER1_RECORD_BUDGET_MS = 60_000;

/**
 * When this run stops taking NEW records. 240 s of the 300 s maxDuration, so a worker never starts a
 * record the run cannot finish. Rows left unclaimed are not marked anything: they are simply the next
 * run's oldest rows, which costs a minute and spends nothing.
 */
export const TIER1_RUN_BUDGET_MS = 240_000;

// A claim older than this is, by construction, from a cron run that was
// killed externally before it could finish (maxDuration is 300s; a healthy
// run finishes in well under that). Reverting these to 'queued' is the only
// way the row gets retried -- the next claim query only looks at 'queued'.
const STALE_CLAIM_MINUTES = 5;

/**
 * The AIResearchResult we persist for a FastAppend business trace.
 *
 * `ai_research` is still the storage shape for entity contacts: resolveOwnerContact()
 * and traceCreditFromFastAppend() both read `business_trace_contacts` out of it,
 * and sweep-business-traces merges into the same object. What is gone is the
 * SEARCH half, so the fields only the LLM could ever produce are written at
 * their honest "we do not know" values rather than invented:
 * relatives and sources are empty, is_deceased is null, property_type is
 * unknown, and there is no confidence percentage because nothing scored one.
 */
function storedEntityTrace(
  companyName: string,
  contacts: {
    ownerName: string | null;
    phones: Array<{ number: string; type: string }>;
    emails: string[];
    mailingAddress: string | null;
  } | null
): AIResearchResult {
  const person = contacts?.ownerName?.trim() || null;
  return {
    owner_name: person,
    owner_type: person ? 'individual' : 'unknown',
    business_name: companyName,
    individual_behind_business: person,
    is_deceased: null,
    deceased_details: null,
    relatives: [],
    decision_makers: person ? [person] : [],
    property_type: 'unknown',
    confidence: 0,
    confidence_reasoning:
      'No confidence score on this path. The contacts came from a FastAppend business trace keyed on the company name and state.',
    sources: [],
    business_trace_status: person
      ? `Found: ${person} (${contacts?.phones.length || 0} phones, ${contacts?.emails.length || 0} emails)`
      : `No principal returned for "${companyName}"`,
    business_trace_contacts: contacts
      ? {
          owner_name: contacts.ownerName,
          phones: contacts.phones,
          emails: contacts.emails,
          address: contacts.mailingAddress,
        }
      : null,
  };
}

/**
 * The already-collected-charge probe now lives in lib/wallet/collectedCharge.ts.
 *
 * It was local to this file until review found the same double-charge reachable
 * ACROSS files with no unusual failure at all: this cron deducts on a FastAppend
 * hit and then throws, the row is requeued, and on the retry FastAppend returns
 * nothing so the row settles down the Tracerfy path in lib/trace/settleBulkJob.ts
 * and is charged a second time. A guard that lives in only one of the two files
 * cannot see that, which is exactly why it is shared now.
 */

/**
 * The columns the Tier 1 lane reads off a claimed row. The query is `select('*')` and returns more;
 * these are the ones named here, so a rename in the schema fails at compile time rather than at
 * 3 a.m. (the entity lane's four string-literal column filters are exactly the risk the
 * ai_research rename plan calls out).
 */
interface Tier1QueueRow {
  id: string;
  user_id: string;
  /** The bulk job this row is CURRENTLY enqueued for. It bounds the crash probe. */
  trace_job_id: string | null;
  normalized_address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  parcel_id_local: string | null;
  county: string | null;
  input_owner_name: string | null;
  ai_research_status: string | null;
  /** Receipt columns, read so foldBillingWrite inside runTier1Record can never downgrade them. */
  charge: number | string | null;
  tier: number | string | null;
  /** D39: the result the row already holds, so a trace that finds nothing cannot erase it. */
  trace_result: unknown;
  /** The step log, so a re-claimed row does not buy the answers it already paid for (spec 5.2). */
  trace_steps: unknown;
  outcome_code: string | null;
}

/**
 * The parcel planRoute() plans from, rebuilt off a claimed Tier 1 row.
 *
 * A PURE EXTRACTION with one job, for the reason app/api/cron/sweep-property-traces' parcelForRow
 * gives: inline wiring inside a long loop cannot be fenced, and this wiring is the only place the
 * owner name and the address reach the vendor. Deleting a line of it would leave `tsc` clean and the
 * suite green (lessons L-020).
 *
 * normalized_address is a pipe-delimited dedup key of THREE fields, street|city|state, with no zip
 * in it (migration 20260904); the zip lives in its own column. A row keyed on a PARCEL carries
 * `APN|<parcel>|<COUNTY>|<STATE>` instead and has no street at all, so splitting on the pipe would
 * hand the vendor the literal word "APN" as an address. The web upload cannot produce such a key
 * (it sends no parcel id, D5), and the guard is here so 2B cannot start to without anyone noticing.
 * No street is '', never a fabricated one (CLAUDE.md rule 7).
 */
export function parcelForTier1Row(row: Tier1QueueRow): ParcelInput {
  const street = isParcelKey(row.normalized_address)
    ? ''
    : row.normalized_address.split('|')[0] || row.normalized_address;
  const state = (row.state || '').trim().toUpperCase();
  return {
    state,
    situsAddress: street,
    situsCity: (row.city || '').trim(),
    situsState: state,
    situsZip: row.zip?.trim() || null,
    parcelIdLocal: row.parcel_id_local?.trim() || null,
    county: row.county?.trim() || null,
    // THE WHOLE DIFFERENCE FROM TIER 2. parcelForFullTrace passes ownerName: null on purpose,
    // because tier 2 is dossier-first by definition. A Tier 1 row HAS its owner, and planRoute
    // returns a tier 1 ladder for it with no dossier step at all.
    ownerName: row.input_owner_name?.trim() || null,
  };
}

interface Tier1LaneResult {
  processed: number;
  charged: number;
  contactsFound: number;
  noContacts: number;
  busy: number;
  noLookupKey: number;
  skippedNoOwner: number;
  throttled: number;
  errored: number;
  staleReverted: number;
  exhausted: number;
}

/**
 * One pass of the Tier 1 lane. Never throws past its own catch; returns its counters.
 */
async function runTier1Lane(
  adminClient: ReturnType<typeof createAdminClient>,
  runDeadlineMs: number
): Promise<Tier1LaneResult> {
  const out: Tier1LaneResult = {
    processed: 0,
    charged: 0,
    contactsFound: 0,
    noContacts: 0,
    busy: 0,
    noLookupKey: 0,
    skippedNoOwner: 0,
    throttled: 0,
    errored: 0,
    staleReverted: 0,
    exhausted: 0,
  };

  /**
   * Which column of the price table this row pays, and the amount, resolved ONCE per user per run
   * from ONE profile read and ONE derivation (lib/suite/pricing.ts).
   *
   * The no-profile fallback is FAILSAFE_PRICE_PLAN, the dearest column, and the rate that goes with
   * it: an overcharge is visible on a statement and gets refunded within a billing cycle, an
   * undercharge is invisible to both sides and compounds silently (ownerRoute.ts).
   *
   * OWNER TYPE SELECTS THE VENDOR, NEVER THE PRICE (L-005).
   */
  const priceCache = new Map<string, { pricePlan: PricePlan; chargeAmount: number }>();
  const priceFor = async (userId: string) => {
    const cached = priceCache.get(userId);
    if (cached !== undefined) return cached;
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('subscription_tier, is_acquisition_pro_member, gateway_products')
      .eq('id', userId)
      .single();
    const priced = profile
      ? { pricePlan: pricePlanFor(profile), chargeAmount: chargePerTrace(profile) }
      : { pricePlan: FAILSAFE_PRICE_PLAN, chargeAmount: PRICING.CHARGE_PER_SUCCESS_WALLET };
    priceCache.set(userId, priced);
    return priced;
  };

  /**
   * When the bulk job this row now belongs to was created, or null when we cannot tell.
   *
   * It bounds the crash probe to THIS submit. The row is UNIQUE(user_id, address_hash) and is
   * REUSED, so a second submit re-enqueues it for a second, genuine piece of work; a debit booked
   * for the FIRST submit predates this one and cannot answer whether this one has been collected.
   * NULL MEANS UNBOUNDED, WHICH IS THE SAFE DIRECTION: it can only cause a charge to be skipped,
   * while a wrong bound charges a customer twice. Same bound sweep-property-traces takes.
   */
  const jobStartCache = new Map<string, string | null>();
  const jobStartedAt = async (traceJobId: string | null): Promise<string | null> => {
    if (!traceJobId) return null;
    const cached = jobStartCache.get(traceJobId);
    if (cached !== undefined) return cached;
    const { data: job } = await adminClient
      .from('trace_jobs')
      .select('created_at')
      .eq('id', traceJobId)
      .single();
    const startedAt = (job as { created_at?: string } | null)?.created_at ?? null;
    jobStartCache.set(traceJobId, startedAt);
    return startedAt;
  };

  // STALE-CLAIM RECOVERY, one statement per rung, before the claim window. A claim that never came
  // back IS a spent attempt: a row that kills the run every time is exactly as poisonous as one no
  // vendor will answer about, and reverting it to attempt 1 would let it loop forever.
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60 * 1000).toISOString();
  for (const attempt of TIER1_ATTEMPTS) {
    const next = tier1NextAfterFailedAttempt(attempt);
    const { data: reverted } = await adminClient
      .from('trace_history')
      .update(
        next.exhausted
          ? {
              // Terminal, free, and RESENDABLE. Five of our own runs died on this row; that is the
              // system being unable to complete it, which is exactly what busy_try_again says, and
              // busy is one of the two outcomes allowed to invite a resend (spec 7.3). The step log
              // stays, so the resend does not re-buy what this row already answered.
              //
              // NO MONEY COLUMNS IN THIS PAYLOAD, and that is not the same as writing zero into
              // them. The row is REUSED and can already carry a tier 2 receipt; a receipt is
              // monotonic (lib/trace/billedRows.ts), and zeroing one un-protects a paid row from
              // every delete sweep while wallet_transactions still references it by FK.
              ai_research_status: next.status,
              ai_research_claimed_at: null,
              status: 'error',
              is_successful: false,
              outcome_code: TIER1_OUTCOME.BUSY_TRY_AGAIN,
            }
          : { ai_research_status: next.status, ai_research_claimed_at: null }
      )
      .eq('ai_research_status', tier1ProcessingStatusFor(attempt))
      // BOTH ARMS, because SQL `<` never matches NULL. A row sitting in tier1_processing_N with a
      // null claim timestamp is invisible to the claim query (which looks only at the queued rungs)
      // and would be invisible here too, so nothing in the system could touch it and it would hold
      // its parent bulk job at 'processing' forever.
      .or(`ai_research_claimed_at.is.null,ai_research_claimed_at.lt.${staleCutoff}`)
      .select('id');
    const moved = reverted?.length || 0;
    out.staleReverted += moved;
    if (next.exhausted) out.exhausted += moved;
  }
  if (out.staleReverted > 0) {
    console.log(
      `[sweep-entity-traces] tier 1: reverted ${out.staleReverted} stale claim(s) older than ${STALE_CLAIM_MINUTES}m`
    );
  }

  // The claim window. Every rung is claimable; the row's own status says which attempt it is on.
  // Oldest first, which is the order the widened partial index on (ai_research_status, created_at)
  // serves directly (migration 20260923_tier1_queue_index.sql).
  const { data: queuedRows } = await adminClient
    .from('trace_history')
    .select('*')
    .in('ai_research_status', TIER1_QUEUED_STATUSES)
    .order('created_at', { ascending: true })
    .limit(TIER1_MAX_ROWS_PER_RUN);

  const rows = (queuedRows || []) as Tier1QueueRow[];
  if (rows.length === 0) return out;

  const processRow = async (row: Tier1QueueRow): Promise<void> => {
    const attempt = tier1AttemptOf(row.ai_research_status);
    const onFailure = tier1NextAfterFailedAttempt(attempt);

    // ATOMIC CLAIM. Only proceed if we flip the row out of the status we READ IT IN: another worker
    // in this run, or another invocation, may have taken it between the select and here. The compare
    // is against row.ai_research_status rather than a literal, because every rung is claimable and a
    // hardcoded tier1_queued would strand a retried row at tier1_queued_2 forever.
    const { data: claimed } = await adminClient
      .from('trace_history')
      .update({
        ai_research_status: tier1ProcessingStatusFor(attempt),
        ai_research_claimed_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('ai_research_status', row.ai_research_status)
      .select('id')
      .maybeSingle();
    if (!claimed) return;

    try {
      const ownerName = (row.input_owner_name || '').trim();
      if (!ownerName) {
        // planRoute answers a nameless record with a TIER 2 plan, and runTier1Record refuses one
        // (NotATier1PlanError) so a $0.20 dossier cannot be bought here and billed at the tier 1
        // rate. Terminal rather than retried: five more attempts ask the same unanswerable question.
        // Free, because nothing was asked. The web submit routes a blank-owner row to the TIER 2
        // queue, so this cannot happen today; it is here so nothing can start to quietly.
        console.error(
          `[sweep-entity-traces] tier 1 row ${row.id} carries no owner name; settled terminal`
        );
        await adminClient
          .from('trace_history')
          .update({
            ai_research_status: TIER1_SETTLED_STATUS,
            ai_research_claimed_at: null,
            status: 'no_match',
            is_successful: false,
          })
          .eq('id', row.id);
        out.skippedNoOwner++;
        return;
      }

      const { pricePlan, chargeAmount } = await priceFor(row.user_id);

      /**
       * THE SHARED VENDOR BUDGET (spec 5.3), ASKED ONCE PER CALL.
       *
       * Passed down to executeRoute, which asks it immediately before each vendor call it is about to
       * make and never for a step it was not going to call (one skipped behind an earlier hit, one
       * replayed from the step log, one the request deadline already refused).
       *
       * IT IS ONE CALL AT A TIME HERE, AND THAT IS SAFE ON THIS LANE ONLY. A Tier 1 record's steps
       * are independent: nothing has been bought when a later step is refused, and an answer already
       * in hand is replayed from the step log rather than bought again (spec 5.2), so a refusal costs
       * nothing at any rung. The TIER 2 cron cannot use this shape and does not: its pass-2 lookups
       * exist only because the dossier was bought, so a refusal there would mean re-running the
       * record and re-buying that dossier. It reserves once, before the record's first vendor call.
       * Two call shapes over ONE budget module, not two budgets: the money and the window stay in
       * lib/trace/vendorRateBudget.ts, which is what L-030 is about.
       *
       * A REFUSAL COMES BACK AS A THROWN VendorBudgetThrottledError from runTier1Record, handled in
       * the catch below. It is not a result field, because that would change Tier1RecordResult's key
       * set and break Task 7's proof that a single trace is unchanged.
       */
      const canSpend = (step: RouteStep) =>
        reserveVendorCalls(adminClient, reservationForSteps([step]));

      /**
       * THE STEP LOG, WRITTEN AS EACH ANSWER ARRIVES (spec 5.2, carried item 3).
       *
       * A single trace writes it once, after the ladder, because its request is bounded and reaches
       * its own persist. This run can be killed between two vendor calls, and the row is then
       * re-claimed one rung up: without the answers already on the row, the second attempt asks the
       * same questions and BUYS THEM AGAIN. runTier1Record's final persist writes the whole log
       * again, which supersedes every one of these.
       */
      const arrived: StepReport[] = [];
      const onStep = async (step: StepReport): Promise<void> => {
        arrived.push(step);
        const { error } = await adminClient
          .from('trace_history')
          .update({ trace_steps: arrived })
          .eq('id', row.id);
        if (error) {
          // Not fatal: the ladder continues and the final persist will write the whole log. The cost
          // of losing this write is one re-bought step on a run that also dies, so it is logged.
          console.error(
            `[sweep-entity-traces] tier 1 step log write failed for row ${row.id}: ${error.message}`
          );
        }
      };

      const settled = await runTier1Record({
        adminClient,
        userId: row.user_id,
        row: {
          id: row.id,
          charge: row.charge,
          tier: row.tier,
          trace_result: row.trace_result,
          trace_steps: row.trace_steps,
          outcome_code: row.outcome_code,
        },
        parcel: parcelForTier1Row(row),
        pricePlan,
        chargeAmount,
        deadlineMs: Date.now() + TIER1_RECORD_BUDGET_MS,
        deps: { lookupDossier, traceEntity: lookupBusinessTrace, tracePerson: lookupPersonTrace },
        inputOwnerName: row.input_owner_name,
        // Bounded to THIS bulk job, the same bound sweep-property-traces takes and for the same
        // reason: the row is reused, so an earlier submit's debit is not an answer about this one.
        ledgerSince: await jobStartedAt(row.trace_job_id),
        // TERMINAL, which is what releases the parent bulk job. The outcome lives in outcome_code,
        // which runTier1Record writes, so this column needs only one settled value.
        //
        // ------------------------------------------------------------------
        // DISCLOSED COST 2 OF 2 IN THIS PHASE, AND THIS LINE IS WHERE IT LANDS.
        //
        // On the D39 path, a trace that finds nothing on a row that already holds PAID contacts,
        // runTier1Record writes the SHORT payload: it keeps the stored result, the counts, the charge
        // and `is_successful: true`, and it writes NO outcome_code and NO found_by. This line still
        // settles the row `tier1_done`, and it has to, or the row never settles and the parent bulk
        // job hangs at 'processing' forever.
        //
        // WHAT THE CUSTOMER SEES. That row arrives on the results CSV with BOTH of Task 5's new
        // columns EMPTY, `is_successful` still true, and `records_matched` counting it. Its
        // `skip_reason` is empty too, because tier1OutcomeReason returns null for a successful row.
        // So it is exactly the row a customer is most likely to ask about, and it is the one row
        // whose two new columns say nothing.
        //
        // WHY IT IS RIGHT ANYWAY, and it is consistent with D34 and D39: the alternative is writing
        // THIS trace's outcome over a row whose contacts and charge belong to an EARLIER one, which
        // would label paid contacts with a key that did not find them. Blank, never wrong (CLAUDE.md
        // rule 7). Task 3's clear-on-reuse is what emptied `found_by` at submit; this is why it stays
        // empty. If David wants a label there it is a D39 change, and it is his because it changes
        // stored customer data.
        // ------------------------------------------------------------------
        queueWrite: { ai_research_status: TIER1_SETTLED_STATUS, property_trace_status: null },
        // A claimed row always resumes from what it already bought. Answers older than 24 hours are
        // not reused: executeRoute judges each entry by its own timestamp.
        resumeFromStepLog: true,
        onStep,
        canSpend,
      });

      if (settled.persistError) {
        console.error(
          `[sweep-entity-traces] tier 1 row ${row.id} failed to persist: ${settled.persistError}`
        );
      }

      out.processed++;
      if (settled.charge > 0) out.charged++;
      if (settled.outcome === TIER1_OUTCOME.BUSY_TRY_AGAIN) out.busy++;
      else if (settled.outcome === TIER1_OUTCOME.NO_LOOKUP_KEY) out.noLookupKey++;
      else if (settled.status === 'success') out.contactsFound++;
      else out.noContacts++;
    } catch (err) {
      // THROTTLED, AND IT IS NOT AN ERROR AND NOT AN ATTEMPT (spec 5.1, spec 5.3). Checked FIRST and
      // above out.errored++, because a throttle counted as an error is a throttle that looks like a
      // fault in every dashboard and every live check.
      //
      // BACK TO THE RUNG IT WAS CLAIMED FROM, never the next one: `row.ai_research_status`, not
      // `onFailure.status`. A throttle that spent an attempt would burn a customer's row through five
      // rungs on a busy minute and then write it terminal with a busy sentence, which is our rate
      // limit charged to their patience.
      //
      // NOTHING IS SETTLED, NOTHING IS CHARGED, AND NOTHING IS SAID. runTier1Record threw before its
      // judge, its ledger probe and its persist (Task 7), so there is no outcome to write. Any answer
      // the record DID buy is already on the row through onStep above, so the next claim replays it
      // instead of buying it again.
      if (err instanceof VendorBudgetThrottledError) {
        await adminClient
          .from('trace_history')
          .update({
            ai_research_status: row.ai_research_status,
            ai_research_claimed_at: null,
          })
          .eq('id', row.id);
        out.throttled++;
        return;
      }
      out.errored++;
      if (err instanceof NotATier1PlanError) {
        // Not retryable: the same row produces the same plan every time. Terminal and free.
        console.error(
          `[sweep-entity-traces] tier 1 row ${row.id} is not a tier 1 record: ${err.message}`
        );
        await adminClient
          .from('trace_history')
          .update({
            ai_research_status: TIER1_SETTLED_STATUS,
            ai_research_claimed_at: null,
            status: 'no_match',
            is_successful: false,
          })
          .eq('id', row.id);
        return;
      }
      // A THROW IS OUR SIDE, so it walks the ladder: retry a transient one, give up honestly on a
      // row that throws every time rather than let it hold a claim slot run after run. A VENDOR
      // failure never reaches here: executeRoute returns it as a failed step and runTier1Record
      // settles the row busy_try_again, free and terminal (D7, spec 5.1).
      console.error(
        `[sweep-entity-traces] tier 1 row ${row.id} processing error on attempt ${attempt} of ${TIER1_MAX_ATTEMPTS}: ${err}`
      );
      await adminClient
        .from('trace_history')
        .update(
          onFailure.exhausted
            ? {
                ai_research_status: onFailure.status,
                ai_research_claimed_at: null,
                status: 'error',
                is_successful: false,
                outcome_code: TIER1_OUTCOME.BUSY_TRY_AGAIN,
              }
            : { ai_research_status: onFailure.status, ai_research_claimed_at: null }
        )
        .eq('id', row.id);
      if (onFailure.exhausted) out.exhausted++;
    }
  };

  // CONCURRENCY. A shared cursor rather than fixed slices, so one slow record cannot leave a worker
  // idle while another has a backlog. Each worker still takes the atomic claim per row, so a row can
  // never be worked twice, within this run or across two overlapping runs.
  //
  // THE RUN BUDGET. A worker stops TAKING rows once the run is nearly out of time. Rows it did not
  // take are left queued and unmarked, which spends nothing and costs a minute; starting a record
  // the run cannot finish would leave a claim for the stale sweep to spend an attempt on.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let index = cursor++; index < rows.length; index = cursor++) {
      if (Date.now() >= runDeadlineMs) return;
      await processRow(rows[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TIER1_CONCURRENCY, rows.length) }, () => worker())
  );

  return out;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  const runStartedAt = Date.now();
  // Housekeeping for the shared budget, once per run rather than once per claim.
  await pruneVendorRateWindows(adminClient);

  // THE TIER 1 LANE FIRST. It is the customer-visible one and the one with a throughput target
  // (spec 3.2: a 500-record job inside 2 to 5 minutes); the legacy entity lane takes five rows a
  // minute and Phase 4 deletes it.
  const tier1 = await runTier1Lane(adminClient, runStartedAt + TIER1_RUN_BUDGET_MS);

  let processed = 0;
  let noMatch = 0;
  let fastAppendCredited = 0;
  let skippedNoOwner = 0;
  let errored = 0;
  let staleReverted = 0;
  // Rows that used up every attempt this run and were written terminal. Not a
  // subset of `errored`: a stale claim can exhaust a row without this run ever
  // calling the vendor for it.
  let exhausted = 0;

  // Tier 1 per-successful-trace rate, resolved once per (user, track) per run.
  //
  // OWNER TYPE SELECTS THE VENDOR, NEVER THE PRICE (lessons.md L-005). This
  // cron settles the ENTITY rows of a bulk job while the job's own status route
  // settles the PERSON rows, so if the two disagree about the rate, one batch
  // bills two different prices for the same work, split by owner type. That is
  // exactly the rule David restated three times.
  //
  // THE CALLER IS THE AXIS, AND THERE IS ONLY ONE DERIVATION (lib/suite/pricing.ts). This used to
  // branch on the row's `source` tag: an /api/v1/* row priced through a raw helper that ignored
  // the gateway snapshot, so on a v1 bulk job a gateway-grant holder paid $0.25 for person rows
  // (raw, from the v1 status route) and $0.15 for entity rows (grant-aware, from here). Same job,
  // same work, two prices. Both halves now read chargePerTrace(), so they agree (David's decision,
  // 2026-09-23; lessons.md L-030). The `source` tag is a label and switches no price.
  //
  // The no-profile fallback stays the DEARER rate, for the same reason FAILSAFE_PRICE_PLAN points
  // at the dearest column.
  const tier1RateCache = new Map<string, number>();
  const tier1RateFor = async (userId: string): Promise<number> => {
    const cached = tier1RateCache.get(userId);
    if (cached !== undefined) return cached;
    const { data: rateProfile } = await adminClient
      .from('user_profiles')
      .select('subscription_tier, is_acquisition_pro_member, gateway_products')
      .eq('id', userId)
      .single();
    const rate = !rateProfile
      ? PRICING.CHARGE_PER_SUCCESS_WALLET
      : chargePerTrace(rateProfile);
    tier1RateCache.set(userId, rate);
    return rate;
  };

  try {
    // Stale-claim recovery: revert rows whose previous claim never finished
    // (cron killed mid-run by Vercel timeout, OOM, deploy restart, etc.) so
    // they're eligible to be re-claimed below.
    const staleCutoff = new Date(
      Date.now() - STALE_CLAIM_MINUTES * 60 * 1000
    ).toISOString();
    // One statement per rung of the ladder, because the revert has to know
    // which attempt the row was on and 'processing' alone does not say. A claim
    // that never came back IS a spent attempt: a row that kills the run every
    // time is exactly as poisonous as one the vendor keeps refusing, and
    // reverting it to attempt 1 would let it loop forever.
    for (const attempt of ENTITY_TRACE_ATTEMPTS) {
      const next = nextAfterFailedAttempt(attempt);
      const { data: revertedRows } = await adminClient
        .from('trace_history')
        .update(
          next.exhausted
            ? {
                ai_research_status: next.status,
                ai_research_claimed_at: null,
                status: 'error',
                is_successful: false,
              }
            : { ai_research_status: next.status, ai_research_claimed_at: null }
        )
        .eq('ai_research_status', processingStatusFor(attempt))
        // BOTH arms, because SQL `<` never matches NULL. A row sitting in
        // processing_N with a null ai_research_claimed_at is invisible to the
        // claim query below (which only looks at the queued rungs) and was
        // invisible to this sweep too, so nothing in the system could touch it
        // and it held its parent bulk job at 'processing' forever. No writer
        // produces that pair today -- the claim always sets the timestamp with
        // the status -- so this is a latch on a door nobody currently opens,
        // not a live bug. A claim with no timestamp is by definition older than
        // any cutoff, so treating it as stale is the honest reading.
        .or(
          `ai_research_claimed_at.is.null,ai_research_claimed_at.lt.${staleCutoff}`
        )
        .select('id');
      const moved = revertedRows?.length || 0;
      staleReverted += moved;
      if (next.exhausted) exhausted += moved;
    }
    if (staleReverted > 0) {
      console.log(
        `[sweep-entity-traces] reverted ${staleReverted} stale claim(s) older than ${STALE_CLAIM_MINUTES}m`
      );
    }

    // Claim up to N queued rows by flipping them to 'processing' first so
    // concurrent cron invocations don't double-process the same row. Every rung
    // of the retry ladder is claimable; the row's own status says which attempt
    // it is on.
    const { data: queuedRows } = await adminClient
      .from('trace_history')
      .select('*')
      .in('ai_research_status', ENTITY_QUEUED_STATUSES)
      .order('created_at', { ascending: true })
      .limit(ENTITY_MAX_ROWS_PER_RUN);

    if (!queuedRows || queuedRows.length === 0) {
      // `exhausted` is reported even here: the stale sweep above can retire a
      // row on its last rung without this run claiming anything at all.
      return NextResponse.json({ success: true, processed: 0, tier1, exhausted, staleReverted });
    }

    for (const row of queuedRows) {
      // Which try this is. Carried in the status itself, so it survives between
      // cron runs with no extra column. A row written before the ladder existed
      // reads as attempt 1.
      const attempt = attemptOf(row.ai_research_status);

      // What this row gets if this attempt fails, decided once so the vendor
      // branch and the catch below cannot drift apart.
      const onFailure = nextAfterFailedAttempt(attempt);
      const failRow = async (logLine: string) => {
        console.error(logLine);
        await adminClient
          .from('trace_history')
          .update(
            onFailure.exhausted
              ? {
                  // Terminal. No charge, no tier, no ai_research_charge: we
                  // never got an answer out of the vendor, and an outage on our
                  // side is not billable (L-007). The status is what releases
                  // the queue behind it and lets the parent bulk job settle.
                  ai_research_status: onFailure.status,
                  ai_research_claimed_at: null,
                  status: 'error',
                  is_successful: false,
                }
              : { ai_research_status: onFailure.status, ai_research_claimed_at: null }
          )
          .eq('id', row.id);
        if (onFailure.exhausted) exhausted++;
      };

      // Atomic claim: only proceed if we successfully flip the row out of the
      // queued status it arrived in. Another cron instance may have grabbed it
      // already. ai_research_claimed_at is the lifeline for stale-claim
      // recovery above -- always set it together with the status flip.
      const { data: claimed } = await adminClient
        .from('trace_history')
        .update({
          ai_research_status: processingStatusFor(attempt),
          ai_research_claimed_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('ai_research_status', row.ai_research_status)
        .select('id')
        .maybeSingle();

      if (!claimed) continue;

      processed++;

      try {
        // NO ADDRESS IS PULLED OUT OF normalized_address HERE ANY MORE. This lane
        // keys FastAppend on the company name and state and nothing else, so the
        // street portion had no consumer once the Tracerfy person submit was
        // removed. If a future vendor call on this path needs one, note that
        // normalized_address is street|city|state with NO zip in it
        // (lib/utils/address-normalizer.ts, migration 20260904) and the zip lives
        // in its own column; do not try to parse one out of that string.
        const companyName = (row.input_owner_name || '').trim();

        if (!companyName) {
          // No owner of record came in, and nothing on this path can find one
          // now that AI Search is gone. Say so, charge nothing, and leave the
          // row in a terminal state so the parent bulk job can finish. NOT a
          // bare no_match: no vendor was ever asked. No charge, no tier, and no
          // ai_research_charge is written here, which also keeps the row
          // deletable (lib/trace/billedRows.ts treats a charged row as a
          // receipt, and this one is not).
          await adminClient
            .from('trace_history')
            .update({
              ai_research_status: BLANK_OWNER_SKIP_STATUS,
              ai_research_claimed_at: null,
              status: 'no_match',
              is_successful: false,
            })
            .eq('id', row.id);
          skippedNoOwner++;
          continue;
        }

        // FastAppend is keyed on the company name plus its STATE OF
        // REGISTRATION, which is not necessarily the property state. A bulk row
        // carries only the property state, so that is what we send, exactly as
        // the old inline path did. planRoute() calls out the same fallback.
        const lookup = await lookupBusinessTrace({
          company_name: companyName,
          state: (row.state || '').trim(),
        });

        // BILL ON WHETHER WE COULD ASK, NEVER ON WHETHER WE FOUND ANYTHING.
        // success:false means the call itself failed (no key, transport error,
        // malformed body). That is our outage, not the customer's miss, and the
        // two are indistinguishable from the outside because both come back
        // with no contacts. Charge nothing either way. The claim goes back on
        // the queue for another try, one rung further up the ladder, until the
        // attempts run out and the row is written terminal instead of blocking
        // every newer row behind it.
        if (!lookup.success) {
          errored++;
          await failRow(
            `[sweep-entity-traces] business trace failed for row ${row.id} on attempt ${attempt} of ${MAX_ENTITY_TRACE_ATTEMPTS}: ${lookup.error}`
          );
          continue;
        }

        const researchForStorage = storedEntityTrace(
          companyName,
          lookup.hit ? lookup.contacts : null
        );

        const ownerFound = !!researchForStorage.owner_name;

        // FastAppend path: the lookup produced phones/emails, so the row has
        // already delivered everything the user needs. Bill ONE tier 1
        // per-success charge at the user's plan rate and skip the per-row
        // Tracerfy submit entirely -- FastAppend's commercial-DB contacts are
        // what the user paid for.
        const fastAppendCredit = traceCreditFromFastAppend(researchForStorage);
        if (fastAppendCredit) {
          // CHARGE ONCE PER ROW, EVER. A previous attempt may have deducted and
          // then died before it could write this row back, which puts the row
          // straight back on the queue with the money already gone. The ledger
          // is the only durable record of that, so it is asked first. When it
          // answers, the amount it reports is the amount persisted: not zero,
          // which would tell the customer the row was free while their wallet
          // says otherwise, and not today's rate, which would restate a past
          // charge at a price that may since have moved.
          //
          // `> 0`, NOT `!== null`. The probe answers the NET of the row's
          // debits and credits. This file never refunds, but its two twins do
          // -- against rows this cron also settles -- so a row can arrive here
          // having collected a fee and had it handed back. That nets to 0, and
          // 0 is not a collection: treating it as one gives the row away free.
          const alreadyCollected = await collectedChargeFor(adminClient, row.id);
          const charge =
            alreadyCollected !== null && alreadyCollected > 0
              ? alreadyCollected
              : // Deduct FIRST, then persist the amount that actually moved.
                await deductOrZero(adminClient, {
                  p_user_id: row.user_id,
                  p_amount: await tier1RateFor(row.user_id),
                  p_trace_history_id: row.id,
                  p_description: 'FastAppend business-trace contacts (successful trace)',
                });

          await adminClient
            .from('trace_history')
            .update({
              ai_research: researchForStorage,
              ai_research_status: 'found',
              ai_research_charge: 0, // The research fee is retired; nothing to book.
              ai_research_claimed_at: null,
              // FastAppend by construction, not by inference: this branch runs only
              // because lookupBusinessTrace returned the contacts being written on the
              // next line. The tier 2 cron derives the same fact from its step reports;
              // here there is no route to read, so the constant IS the record.
              //
              // NOT written on the fall-through branch below. There FastAppend was asked
              // only to name the owner, and a Tracerfy person submit supplies the contacts
              // afterwards, so calling that row 'fastappend' would name the wrong vendor.
              contact_vendor: 'fastappend',
              status: 'success',
              trace_result: fastAppendCredit.trace_result,
              phone_count: fastAppendCredit.phone_count,
              email_count: fastAppendCredit.email_count,
              is_successful: true,
              cost: PRICING.COST_PER_RECORD,
              // `charge` is the LEDGER's answer and is written as-is: folding
              // it would add money already recorded to money already on the
              // row. `tier` is NOT the ledger's to answer, and a flat 1
              // silently downgrades a tier 2 receipt, so it comes from the
              // fold, which never downgrades.
              charge,
              tier: foldBillingWrite(row, { charge, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE }).tier,
            })
            .eq('id', row.id);
          fastAppendCredited++;
          continue;
        }

        // No usable FastAppend contacts. Persist what the lookup did say and
        // fall through to the Tracerfy person submit. ai_research_charge is 0:
        // identifying an owner is no longer a billable step of its own.
        await adminClient
          .from('trace_history')
          .update({
            ai_research: researchForStorage,
            ai_research_status: ownerFound ? 'found' : 'not_found',
            ai_research_charge: 0,
            ai_research_claimed_at: null,
          })
          .eq('id', row.id);

        {
          // FASTAPPEND ANSWERED AND DELIVERED NO REACHABLE CONTACT. That is the
          // end of the row: a real miss, and under tier 1 a miss is free.
          //
          // NO SECOND VENDOR. David's ruling, 2026-09-21: "DO NOT send a
          // fastappend contact to Tracerfy. This will produce no new results and
          // waste time. Fastappend is a tracerfy company and if the contact info
          // is not found in Fastappend, it will not be found in Tracerfy either.
          // Even if the contact is found in FastAppend, and that contact has no
          // email or phone, it gets treated as null result and the search is
          // free for tier 1."
          //
          // So it does not matter whether FastAppend named a principal. A name
          // with no phone and no email is a null result, not a lead to chase
          // against the same company's other database. This used to fall through
          // to a per-row Tracerfy person submit, which spent a second vendor call
          // on a row the first vendor had already failed to deliver.
          //
          // FREE MEANS "COLLECT NOTHING FURTHER", NOT "THIS ROW WAS ALWAYS
          // FREE". The row is REUSED, never re-inserted
          // (UNIQUE(user_id, address_hash)), so it can already carry a tier 2
          // receipt -- tier 2 bills per record SUBMITTED, which makes
          // `is_successful = false, charge > 0` a row the customer PAID for. A
          // flat `charge: 0, tier: 1` over it erased that receipt while
          // wallet_transactions still referenced the row by FK. Folding a
          // collection of 0 changes nothing on a row that never paid, and
          // preserves one that did.
          const billing = foldBillingWrite(row, {
            charge: 0,
            tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
          });
          await adminClient
            .from('trace_history')
            .update({
              status: 'no_match',
              is_successful: false,
              charge: billing.charge,
              tier: billing.tier,
            })
            .eq('id', row.id);
          noMatch++;
          continue;
        }

      } catch (err) {
        errored++;
        // Same ladder as the vendor failure above. Retry a transient throw,
        // give up honestly on a row that throws every time rather than let it
        // hold the five-oldest claim window shut.
        await failRow(
          `[sweep-entity-traces] row ${row.id} processing error on attempt ${attempt} of ${MAX_ENTITY_TRACE_ATTEMPTS}: ${err}`
        );
      }
    }

    return NextResponse.json({
      success: true,
      processed,
      tier1,
      noMatch,
      fastAppendCredited,
      skippedNoOwner,
      errored,
      exhausted,
      staleReverted,
    });
  } catch (error) {
    console.error('[sweep-entity-traces] fatal error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
