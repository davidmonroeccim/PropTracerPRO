import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { lookupBusinessTrace, lookupPersonTrace } from '@/lib/tracerfy/client';
import { lookupDossier } from '@/lib/tracerfy/dossier';
import { executeRoute, contactVendorFrom } from '@/lib/routing/executeRoute';
import {
  FAILSAFE_PRICE_PLAN,
  planRoute,
  type ParcelInput,
  type PricePlan,
  type StepKind,
} from '@/lib/routing/ownerRoute';
import {
  FULL_PROPERTY_TRACE_DESCRIPTION,
  hasContactData,
  parcelForFullTrace,
  traceResultFor,
} from '@/lib/trace/fullPropertyTrace';
import { TRACE_TIER, foldBillingWrite } from '@/lib/trace/billedRows';
import { isParcelKey } from '@/lib/trace/historyDisplay';
import {
  pruneVendorRateWindows,
  reservationForSteps,
  reserveVendorCalls,
} from '@/lib/trace/vendorRateBudget';
import { deductOrZero } from '@/lib/wallet/deduct';
import { collectedChargesFor } from '@/lib/wallet/collectedCharge';
import { pricePlanFor } from '@/lib/suite/pricing';
import {
  MAX_PROPERTY_TRACE_ATTEMPTS,
  PROPERTY_TRACE_ATTEMPTS,
  PROPERTY_TRACE_NO_KEY_STATUS,
  PROPERTY_TRACE_NO_REACH_STATUS,
  PROPERTY_TRACE_QUEUED_STATUSES,
  PROPERTY_TRACE_SETTLED_STATUS,
  attemptOf,
  nextAfterFailedAttempt,
  processingStatusFor,
} from '@/lib/trace/propertyTraceAttempts';

/**
 * Vercel Cron: runs the TIER 2 (Full Property Trace) rows of a bulk job, the
 * ones parked in `property_trace_status`.
 *
 * WHAT TIER 2 BULK IS. A bulk row that arrives with no owner of record has no
 * tier 1 route: there is nobody to look up. David decided on 2026-09-17 that
 * such a row runs a Full Property Trace AUTOMATICALLY, the same as single and
 * v1 single. That is two vendor calls per record -- a Tracerfy dossier that
 * buys the county property record and names the owner, then one contact lookup
 * for that owner (FastAppend for an entity, Tracerfy's person endpoint for an
 * individual) -- and it is billed per RECORD SUBMITTED, not per success.
 *
 * WHY IT IS A CRON AND NOT THE SUBMIT ROUTE. `maxDuration` on a submit route is
 * 60 s and a full job is minutes of vendor work. Queue plus worker.
 *
 * WHY THE CLAIM PROTOCOL BELOW IS A COPY. sweep-entity-traces is the reference
 * implementation and it is already load-bearing in production: atomic
 * compare-and-swap, `claimed_at` set with the flip, stale recovery that treats a
 * NULL timestamp as stale, and a killed claim that counts as a SPENT attempt so
 * a poison row cannot loop forever. Every one of those was paid for by a real
 * failure. This file mirrors them rather than improving on them.
 *
 * WHAT IT DOES NOT SHARE WITH THAT CRON. The COLUMN and the MONEY. This queue
 * lives in `property_trace_status`, not `ai_research_status`
 * (supabase/migrations/20260918_property_trace_queue.sql says why in full), and
 * it settles a per-RECORD-SUBMITTED billing model where the entity sweep settles
 * a per-SUCCESSFUL-TRACE one. A tier 1 miss is FREE; a tier 2 miss is BILLED.
 * Do not fold the two.
 *
 * ALL THREE BULK SUBMIT SURFACES ENQUEUE INTO THIS COLUMN, which is what makes
 * this one cron the single row-settlement point for tier 2 bulk: the session
 * route (app/api/trace/bulk), the API-key route (app/api/v1/trace/bulk) and the
 * Suite MCP tool (lib/suite/mcp-tools.ts) all write 'queued' onto a blank-owner
 * row and leave it here. A run with nothing to claim returns processed: 0, which
 * is an empty queue rather than a wiring bug.
 */
export const maxDuration = 300;

/**
 * Records claimed per run, and the concurrency they run at. Sized from live
 * measurement on 2026-09-18, not from a guess.
 *
 * BOTH tier 2 calls draw Tracerfy's SHARED 500/minute instant pool (the dossier
 * endpoint's own header says the counter is shared with Instant Trace, Enhanced
 * Trace, Phone Verification and APN Instant Lookup).
 *
 * THE SENTENCE THAT USED TO BE HERE IS NOW FALSE, and it is corrected rather
 * than deleted because it explains the arithmetic below. It said "Tier 1 bulk
 * posts to the BATCH endpoint, a different bucket, so it does not compete."
 * Since Phase 2A the WEB upload's Tier 1 rows are worked per record by
 * sweep-entity-traces through the SAME instant pool (spec 3.2), so they compete
 * directly. API bulk and the MCP tool still post to the batch endpoint, until 2B.
 *
 * SIZING, AND IT IS AN ESTIMATE RATHER THAN A GUARANTEE. 120 records at
 * concurrency 5 is at least 240 calls a minute. The Tier 1 lane is 120 rows at
 * concurrency 8 and at most ONE Tracerfy call per record on the web path (that
 * surface sends no parcel id, so planRoute can emit one person step, not two),
 * which is at most 120 more. That says the two lanes should not normally reach
 * the 450 shared ceiling.
 *
 * DO NOT READ 240 AS A CEILING FOR THIS LANE. It is a FLOOR.
 * lib/routing/ownerRoute.ts says so about its own figure, in capitals, and
 * D21(c) with D40 put no cap on how many owners a dossier record tries: the
 * worst case is 2 + 2N Tracerfy calls for N individual owners, which is 8 for
 * three. At three owners a record this lane alone would want 960 a minute.
 *
 * WHICH IS WHY THE BOUND IS NOT HERE AND IS NOT ARITHMETIC.
 * lib/trace/vendorRateBudget.ts holds it. This cron reserves ONCE PER RECORD,
 * immediately before that record's first vendor call, and then the record runs
 * to completion: a record whose dossier has been bought is never refused
 * part-way and never re-run, so no dossier is ever bought twice. A record the
 * budget cannot cover is released to its own rung before it asks any vendor
 * anything, no attempt spent, and waits for the next minute.
 *
 * SO THE BUDGET BOUNDS RECORD STARTS ON THIS LANE, NOT EVERY CALL INSIDE THEM,
 * and the pass-2 owner lookups are unreserved. The overshoot is CONCURRENCY (5)
 * times a record's worst-case remaining ladder (2N calls for N owners), which is
 * 30 at three owners: 450 + 30 = 480 against the vendor's 500. The 50-call gap
 * absorbs it and also carries the single traces. Do not claim a per-call ceiling
 * for this lane; that one belongs to the Tier 1 lane, which reserves per call.
 * The plan's Task 6 header carries the arithmetic and says where it runs out.
 *
 * At the measured ~1.2-1.7 s per record that is ~36 s per run, far inside
 * maxDuration = 300. Bulk submissions are capped at 500 records (David,
 * 2026-09-18), so a full job is about 5 runs, roughly 5 minutes.
 */
const MAX_ROWS_PER_RUN = 120;
const CONCURRENCY = 5;

/**
 * A claim older than this is, by construction, from a cron run that was killed
 * externally before it could finish (maxDuration is 300 s; a healthy run
 * finishes in well under that). Reverting these is the only way the row gets
 * retried: the claim query below only looks at the queued rungs.
 */
const STALE_CLAIM_MINUTES = 5;

/**
 * The steps that BUY THE PROPERTY RECORD, as opposed to the contact steps that
 * follow. The billing gate is a question about these and only these.
 */
const DOSSIER_STEP_KINDS: ReadonlySet<StepKind> = new Set<StepKind>([
  'DOSSIER_APN',
  'DOSSIER_ADDRESS',
]);

/**
 * The columns this cron reads off a claimed row. The query is `select('*')` and
 * returns more; these are the ones named here, so a rename in the schema fails
 * at compile time rather than at 3 a.m.
 */
interface QueueRow {
  id: string;
  user_id: string;
  /**
   * The bulk job this row is CURRENTLY enqueued for. Re-pointed by every submit
   * route, because the row is reused rather than re-inserted, so it is what
   * separates this piece of paid work from the last one against the same
   * address. The ledger probe below is scoped by it.
   */
  trace_job_id: string | null;
  normalized_address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** The dossier's SECOND lookup key, with county below and state above. NULL for every row
   *  submitted before the Suite Gateway started sending one. See mcp-tools.ts's recordSchema
   *  for where it enters, and fullPropertyTrace.ts's parcelForFullTrace for the three-part key. */
  parcel_id_local: string | null;
  /** Bare county name for the APN key. Tracerfy wants "Stark", never "Stark County". */
  county: string | null;
  /** Where the row was submitted from (lib/suite/pricing.ts TRACE_SOURCE). A label; it no
   *  longer selects a price. */
  source: string | null;
  property_trace_status: string | null;
  /** Receipt columns, read so foldBillingWrite can never downgrade them. */
  charge: number | string | null;
  tier: number | string | null;
  property_record: unknown;
}

/**
 * The parcel planRoute() plans from, rebuilt off a claimed row.
 *
 * A PURE EXTRACTION with one job, so the two lines that carry the dossier's second lookup
 * key (apn and county) can be pinned by a direct test instead of only by standing up the
 * whole cron. Before this extraction, deleting either line from the inline call site here
 * still compiled clean and left the full suite green: nothing anywhere would have caught the
 * feature silently reverting to address-only, which is the exact failure this task exists to
 * prevent. Exported so lib/trace/__tests__/fullPropertyTrace.test.ts and this file's own test
 * can both call it directly.
 *
 * normalized_address is a pipe-delimited dedup key of exactly THREE fields, street|city|state,
 * like "160 MINE LAKE CT|RALEIGH|NC". There is no zip in it: normalizeAddress() dropped it
 * deliberately (migration 20260904). The zip lives in its own column. Pull the street portion
 * back out before handing it to a vendor, which expects a raw street address and separate
 * city/state/zip.
 */
export function parcelForRow(row: QueueRow): ParcelInput {
  // D38: a row keyed on a PARCEL carries `APN|<parcel>|<COUNTY>|<STATE>` here and has no street
  // in it at all, so splitting on the pipe would hand the dossier the literal word "APN" as an
  // address. Such a row cannot reach this queue today (every bulk upload carries a street), and
  // the guard is here so it cannot start to without anyone noticing. No street is '', never a
  // fabricated one: parcelForFullTrace then plans from the apn and county columns alone.
  const streetAddress = isParcelKey(row.normalized_address)
    ? ''
    : row.normalized_address.split('|')[0] || row.normalized_address;
  return parcelForFullTrace({
    address: streetAddress,
    city: row.city || '',
    state: row.state || '',
    zip: row.zip,
    apn: row.parcel_id_local,
    county: row.county,
  });
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  // Housekeeping, once per run rather than once per claim: two rows a minute is 2,880 a day.
  await pruneVendorRateWindows(adminClient);
  let processed = 0;
  let billed = 0;
  let propertyRecords = 0;
  let contactsResolved = 0;
  // The vendor ANSWERED and has no record of this owner. Free, final, and a
  // complete answer the customer paid to receive.
  let noContacts = 0;
  // The vendor could NOT BE ASKED. Billed all the same, because the dossier
  // answered and tier 2 is per record submitted, but a different fact from the
  // line above and deliberately not summed into it: this counter is the outage
  // signal, and PTP has no other one.
  let contactsUnreachable = 0;
  let skippedNoKey = 0;
  // Records the shared vendor budget could not cover THIS MINUTE, released to the
  // rung they were claimed from before they asked any vendor anything (spec 5.3).
  // Not a failure and not an error: nothing was bought and no attempt was spent.
  let throttled = 0;
  let errored = 0;
  let staleReverted = 0;
  // Rows that used up every attempt this run and were written terminal. Not a
  // subset of `errored`: a stale claim can exhaust a row without this run ever
  // calling a vendor for it.
  let exhausted = 0;

  /**
   * Which column of the price table this row pays, resolved once per user per run.
   *
   * THE CALLER IS THE AXIS, AND THERE IS ONLY ONE DERIVATION. This used to branch on the row's
   * `source` tag: a tagged row priced through the grant-aware pricePlanFor() and an untagged one
   * (which is every /api/v1/* row) through a raw twin that ignored the gateway snapshot. That made
   * one submit carry two prices for a gateway-grant holder, which lib/suite/pricing.ts says must
   * never happen. David's named decision, 2026-09-23: "One price: make the API grant-aware." The
   * `source` tag is now a label and switches nothing (lessons.md L-030).
   *
   * The no-profile fallback stays FAILSAFE_PRICE_PLAN, the dearest column of all
   * (lib/routing/ownerRoute.ts explains why a cheap default once cost 40% of a pay-as-you-go
   * invoice, silently).
   *
   * OWNER TYPE SELECTS THE VENDOR, NEVER THE PRICE (L-005). There is no entity
   * rate and no individual rate anywhere below.
   *
   * The cache is read and written by several workers at once. The worst a race
   * can do is repeat a read-only profile query; nothing here is order-dependent.
   */
  const pricePlanCache = new Map<string, PricePlan>();
  const pricePlanForRow = async (userId: string): Promise<PricePlan> => {
    const cached = pricePlanCache.get(userId);
    if (cached !== undefined) return cached;
    const { data: rateProfile } = await adminClient
      .from('user_profiles')
      .select('subscription_tier, is_acquisition_pro_member, gateway_products')
      .eq('id', userId)
      .single();
    const plan = !rateProfile ? FAILSAFE_PRICE_PLAN : pricePlanFor(rateProfile);
    pricePlanCache.set(userId, plan);
    return plan;
  };

  /**
   * When the bulk job this row now belongs to was created, or null when we
   * cannot tell.
   *
   * WHAT IT IS FOR. It bounds the ledger probe below to THIS submit. A
   * trace_history row is UNIQUE(user_id, address_hash) and is reused, so a second
   * submit of the same address re-points `trace_job_id` and re-enqueues the row
   * for a second, genuine piece of vendor work. A debit booked for the FIRST
   * submit predates this job, so it cannot be the answer to whether this one has
   * been collected -- and taking it as the answer is how the dossier gets bought
   * again while nothing is charged for it.
   *
   * NULL MEANS UNBOUNDED, WHICH IS THE SAFE DIRECTION. An unreadable job can only
   * cause a charge to be skipped; a wrong bound charges a customer twice.
   *
   * Cached per job for the same reason the price plan is: one read-only query
   * repeated is the worst a race here can do.
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

  /** One claimed row, start to finish. Never throws past its own catch. */
  const processRow = async (row: QueueRow): Promise<void> => {
    // Which try this is. Carried in the status itself, so it survives between
    // cron runs with no extra column. A row enqueued by a writer that does not
    // know about the ladder reads as attempt 1.
    const attempt = attemptOf(row.property_trace_status);

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
                // Terminal. We never got an answer out of the dossier, and an
                // outage on our side is not billable (L-007), so nothing was
                // charged on any of the five attempts.
                //
                // NO MONEY COLUMNS IN THIS PAYLOAD, AND THAT IS NOT THE SAME AS
                // WRITING ZERO INTO THEM. lib/trace/entityTraceAttempts.ts says
                // "an exhausted row is written terminal with no charge, no tier
                // and no ai_research_charge". Do not carry that sentence over
                // here: under tier 2 a row can be exhausted AND BILLED. This row
                // is REUSED, never re-inserted (UNIQUE(user_id, address_hash)),
                // so it can already carry a tier 2 receipt from an earlier
                // purchase of the same address -- and a tier 2 receipt looks
                // like `is_successful = false, charge > 0`, which is exactly the
                // shape a careless `charge: 0, tier: 1` would erase. Erasing it
                // makes the row read UNBILLED to excludeBilledRows while
                // wallet_transactions still references it by FK, and the next
                // submit's delete then raises 23503 and locks that address out
                // forever. Receipts are monotonic; omitting the columns is what
                // preserves them.
                //
                // The STATUS is what releases the queue behind the row and lets
                // the parent bulk job settle, so it is written even here.
                property_trace_status: onFailure.status,
                property_trace_claimed_at: null,
                status: 'error',
                is_successful: false,
                tracerfy_job_id: null,
              }
            : {
                property_trace_status: onFailure.status,
                property_trace_claimed_at: null,
              }
        )
        .eq('id', row.id);
      if (onFailure.exhausted) exhausted++;
    };

    // ATOMIC CLAIM. Only proceed if we successfully flip the row out of the
    // queued status we READ IT IN: another worker in this run, or another cron
    // invocation, may have taken it between the select and here. The compare is
    // against `row.property_trace_status` rather than a literal, because every
    // rung of the ladder is claimable and a hardcoded 'queued' would leave a
    // retried row stranded at queued_2 forever.
    //
    // property_trace_claimed_at is the lifeline for the stale sweep above --
    // always set it together with the status flip.
    const { data: claimed } = await adminClient
      .from('trace_history')
      .update({
        property_trace_status: processingStatusFor(attempt),
        property_trace_claimed_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('property_trace_status', row.property_trace_status)
      .select('id')
      .maybeSingle();

    if (!claimed) return;

    processed++;

    try {
      // planRoute takes the price plan as a REQUIRED argument so that no caller
      // can quietly bill the wrong column. parcelForRow deliberately passes
      // ownerName: null -- tier 2 is dossier-first by definition, and a plan
      // built with an owner name present returns a tier 1 route with no
      // dossier step at all.
      const pricePlan = await pricePlanForRow(row.user_id);
      const plan = planRoute(parcelForRow(row), pricePlan);

      if (plan.steps.length === 0) {
        // NO VENDOR WAS EVER ASKED, AND NONE EVER CAN BE. planRoute emits no
        // step when the parcel carries neither a complete situs nor a parcel id
        // with county, which on this path means the row is missing its street,
        // city or state. The session bulk route does not validate per record, so
        // such a row really does reach the queue.
        //
        // Terminal rather than retried: five more attempts would ask the same
        // unanswerable question and burn five claim slots that belong to rows
        // that can work. Free, because nothing was spent and nothing was asked.
        // NOT a bare no_match either -- propertyTraceSkipReason() carries the
        // sentence that says we never looked, and phase 5c-3 serves it.
        await adminClient
          .from('trace_history')
          .update({
            property_trace_status: PROPERTY_TRACE_NO_KEY_STATUS,
            property_trace_claimed_at: null,
            status: 'no_match',
            is_successful: false,
            tracerfy_job_id: null,
          })
          .eq('id', row.id);
        skippedNoKey++;
        return;
      }

      /**
       * THE SHARED BUDGET (spec 5.3), ONCE, BEFORE THIS RECORD'S FIRST VENDOR CALL.
       *
       * ONCE, AND NOT PER CALL, BECAUSE A TIER 2 RECORD CANNOT BE REWOUND. Its pass-2 contact
       * lookups exist only because the dossier was bought and named the owners they are for. A
       * refusal after that point could only be handled by releasing the record and running it again
       * next minute, which buys the same dossier twice. So this lane asks once: refused, the record
       * has spent nothing and asks no vendor anything; granted, it finishes. Every owner the dossier
       * names is asked, the customer is billed once, and nothing is re-bought.
       *
       * NO canSpend IS PASSED TO executeRoute HERE, deliberately. The Tier 1 lane passes one because
       * its steps are independent and a refusal there costs nothing. This one would be a refusal
       * mid-ladder, which is the thing that must not happen.
       *
       * WHAT IT RESERVES: the steps the plan carries, which on this lane are the dossier calls.
       * reservationForSteps reads them off the plan rather than restating a constant, so a routing
       * change cannot leave a stale number here. A plan whose FIRST dossier step hits leaves the
       * second unmade, so the claim over-reserves by one, which is the conservative direction.
       *
       * WHAT IT DOES NOT RESERVE, SAID PLAINLY: the pass-2 owner lookups. On this lane the budget
       * bounds how many records BEGIN in a window, not every call inside them, and an in-flight
       * ladder can overshoot the reserved figure. Bounded by CONCURRENCY (5) times a record's
       * worst-case remaining ladder (2N calls for N owners, 30 at three), which the 50-call gap
       * below the vendor's own 500 absorbs. The plan's Task 6 header has the arithmetic.
       */
      if (!(await reserveVendorCalls(adminClient, reservationForSteps(plan.steps)))) {
        // THROTTLED (spec 5.1, spec 5.3), AND IT SPENT NOTHING. No vendor was asked about this
        // record, nothing was judged, nothing was billed, and the customer is told nothing.
        //
        // RELEASED TO THE RUNG IT WAS CLAIMED FROM, WITH NO ATTEMPT SPENT. A throttle is not a
        // failure: giving up an attempt for it would burn a customer's row through five rungs on a
        // busy minute and then write it terminal.
        //
        // A rising `throttled` in the response means the budget is the binding constraint and
        // MAX_ROWS_PER_RUN or CONCURRENCY should come down, not that anything is broken.
        await adminClient
          .from('trace_history')
          .update({
            property_trace_status: row.property_trace_status,
            property_trace_claimed_at: null,
          })
          .eq('id', row.id);
        processed--;
        throttled++;
        return;
      }

      // executeRoute never throws and reports every step separately. It stops at
      // the first dossier hit, re-enters planRoute with the discovered owner to
      // pick the contact vendor, and returns the RAW property record by
      // reference.
      const execution = await executeRoute(plan, {
        lookupDossier,
        traceEntity: lookupBusinessTrace,
        tracePerson: lookupPersonTrace,
      });

      /* -------------------------------------------------------------- *
       * THE BILLING GATE. L-007, and it is the whole rule.
       *
       * BILL ON WHETHER THE DOSSIER ANSWERED, NEVER ON WHETHER IT FOUND
       * ANYTHING. Tier 2 is billed per RECORD SUBMITTED, so a HIT and a MISS are
       * both billable and only a FAILURE is not:
       *
       *   dossier answered, owner found, contacts resolved   BILLED
       *   dossier answered, owner found, contact vendor MISS  BILLED
       *   dossier answered, no parcel at that address (MISS)  BILLED
       *   dossier could not be ASKED (outage, 5xx, transport) NOT BILLED, retry
       *
       * THE NEXT READER WILL SEE TWO FALSE-Y VALUES AND THINK THEY MERGE. They
       * do not. A MISS and a FAILURE both come back with no contacts and no
       * record, and they are opposite facts: a miss is a complete answer the
       * customer paid to receive, a failure is our outage and billing for it
       * charges customers for our downtime. 5c-1 removed exactly this defect one
       * layer down in this same call chain, where a FastAppend 404 carrying
       * `hit:false` -- a genuine "company not found" -- was being treated as a
       * transport failure. That client now hands this layer a clean
       * answer-versus-failure signal and this gate must not re-derive it.
       *
       * WHY THE PREDICATE IS ABOUT THE DOSSIER STEPS AND NOT execution.success.
       * `success: false` is a WHOLE-ROUTE verdict and it is also set when the
       * dossier hit and only the CONTACT call failed. That case has already
       * spent $0.20 and is holding the 86-field record the customer bought, so
       * it is billable and it must not go back on the ladder: a retry would
       * re-buy a dossier we already own, out of a Tracerfy credit pool that is
       * SHARED across every customer's jobs and holds about 1,069 dossier hits
       * in total. Retrying one contact-vendor outage across one 500-record job
       * would put four more dossier hits on every record, about 2,000 against
       * that 1,069, so the retries alone would exhaust the pool and take every
       * other user's job down with it.
       *
       * This is a DELIBERATE divergence from app/api/trace/single, which returns
       * 502 and charges nothing on a contact-vendor failure. A single trace can
       * be resubmitted by the customer immediately and for free, so leaving it
       * unbilled costs nobody anything. A queued bulk row cannot: the only way
       * to run it again is to re-buy the dossier.
       *
       * DECLINING TO RETRY IS NOT PERMISSION TO MISLABEL, AND THE TWO ARE
       * INDEPENDENT. The cost argument above forces the no-retry and nothing
       * else. It says nothing about what the row should then SAY, and settling a
       * contact OUTAGE with the same values as a genuine contact MISS satisfies
       * L-007 at this gate and defeats it one statement later: the customer pays
       * full price for a two-call product, receives one call, and is told we
       * looked and found nobody. contactsUnreached below is what keeps the two
       * apart, on the row and in this cron's own counters.
       * -------------------------------------------------------------- */
      const dossierAnswered = execution.steps.some(
        (step) =>
          DOSSIER_STEP_KINDS.has(step.kind) &&
          (step.outcome === 'hit' || step.outcome === 'miss')
      );

      if (!dossierAnswered) {
        errored++;
        await failRow(
          `[sweep-property-traces] dossier could not be reached for row ${row.id} on attempt ${attempt} of ${MAX_PROPERTY_TRACE_ATTEMPTS}: ${execution.error || 'no dossier step answered'}`
        );
        return;
      }

      // CHARGE ONCE PER ROW, EVER. deductOrZero moves real money the instant it
      // is called and the row is written back afterwards, so anything that dies
      // in between leaves the wallet lighter with nothing on the row to show for
      // it -- and the catch below puts that row straight back on the queue. The
      // ledger is the only durable record of the money, so it is asked first,
      // and when it answers, the amount it reports is the amount persisted: not
      // zero, which would tell the customer the row was free while their wallet
      // says otherwise, and not today's rate, which would restate a past charge
      // at a price that may since have moved.
      //
      // `> 0`, NOT `!== null`. The probe answers the NET of this row's debits
      // and credits. This file never refunds, but two sibling settle paths do,
      // against rows this queue also reaches, so a row can arrive here having
      // collected a fee and had it handed back. That nets to 0, and 0 is not a
      // collection: treating it as one gives the row away free.
      //
      // TWO READINGS OF ONE LEDGER, BECAUSE THE DECISION AND THE AMOUNT ARE
      // DIFFERENT QUESTIONS.
      //
      // `inWindow` decides. Bounded to the bulk job this row is CURRENTLY
      // enqueued for, and that bound is the whole difference between the crash
      // window and a resubmit. Unbounded, it also answered for a debit booked
      // weeks ago under a different job: the row is REUSED, so a second submit
      // re-enqueues it, this cron re-buys the dossier out of the shared pool, and
      // the probe reports the OLD collection so the deduct is skipped. Real
      // vendor money out, $0.00 collected, and repeatable, because nothing in
      // that state ever changes. The crash window this guard was written for --
      // deduct, throw, requeue, re-claim -- happens inside ONE job, so a bound at
      // that job's own start still catches it.
      //
      // `total` is the amount. `trace_history.charge` means what this row has
      // collected in total, and three surfaces SUM it as what the customer paid,
      // so persisting the windowed figure would drop an earlier submit's real
      // debit from a column the ledger still holds.
      const { total: collectedBefore, inWindow: collectedThisJob } =
        await collectedChargesFor(
          adminClient,
          row.id,
          await jobStartedAt(row.trace_job_id)
        );
      const deducted =
        collectedThisJob !== null && collectedThisJob > 0
          ? 0
          : // Deduct FIRST, then persist the amount that actually moved. The
            // amount comes off the plan, which is the one place the tier 2
            // per-record rate for this caller's column is resolved.
            await deductOrZero(adminClient, {
              p_user_id: row.user_id,
              p_amount: plan.billing.amount,
              p_trace_history_id: row.id,
              p_description: FULL_PROPERTY_TRACE_DESCRIPTION,
            });

      // The ledger's net for this row once this pass is accounted for: what it
      // held coming in, plus whatever actually moved just now. One of those two
      // is always zero. Rounded because two 2-decimal floats added give
      // 0.30000000000000004 and this lands in a DECIMAL column shown as money.
      //
      // A row whose ledger could not be READ answers `total: null`, which lands
      // here as the amount that moved this pass -- the same value the site wrote
      // before any probe existed, and the safe one: never a zero over a row that
      // has collected something.
      const charge = Math.round(((collectedBefore ?? 0) + deducted) * 100) / 100;

      const result = traceResultFor(execution);
      const isSuccessful = hasContactData(result);

      // DID WE FINISH ASKING? A CONTACT step with outcome 'failed' is the vendor
      // we could not reach, and it is a different fact from `hit: false`, which
      // is the vendor telling us it has no record of this owner. Both arrive
      // here with no contacts, which is exactly why this is read off the STEP
      // rather than off the absence of contacts.
      //
      // Asked of the contact steps specifically, not of `execution.success`,
      // for the same reason the gate above is: `success` is a whole-route
      // verdict that a dossier step can also set.
      const contactsUnreached = execution.steps.some(
        (step) => !DOSSIER_STEP_KINDS.has(step.kind) && step.outcome === 'failed'
      );

      await adminClient
        .from('trace_history')
        .update({
          // TERMINAL EITHER WAY, AND BILLED EITHER WAY, BUT NOT THE SAME CLAIM.
          // The row is not retried, so this column is the only durable record
          // that the second of the two calls never happened. `status` stays
          // 'no_match' because that column is CHECK-constrained and is what lets
          // the parent bulk job finish; the honest sentence rides on this one,
          // through propertyTraceSkipReason(), exactly as blankOwnerSkip.ts
          // already does for a row nobody looked up.
          property_trace_status: contactsUnreached
            ? PROPERTY_TRACE_NO_REACH_STATUS
            : PROPERTY_TRACE_SETTLED_STATUS,
          property_trace_claimed_at: null,
          // DELIVERY FACTS. A billed row needs these MORE than an unpaid one,
          // not less: `is_successful = false, charge > 0` is the normal,
          // correct shape of a paid tier 2 miss, and a row left saying
          // 'processing' is one a stale sweep will later settle against another
          // property's contacts.
          status: isSuccessful ? 'success' : 'no_match',
          trace_result: result,
          phone_count: result?.phones?.length || 0,
          email_count: result?.emails?.length || 0,
          is_successful: isSuccessful,
          // What the vendors actually took, read from their own credit counters
          // rather than assumed from a price list.
          cost: execution.vendorSpend,
          // WHICH LANE THE OWNER WENT DOWN, recorded rather than inferred later.
          // The entity-versus-individual split is the decision this whole tier turns
          // on, and until now nothing durable said which way it went: there was no
          // vendor column, `steps` was built and then dropped here, and both vendors
          // cost 0.10 so `cost` cannot separate them either. Null when no contact
          // vendor was asked at all, which is a trust or an unclassifiable name.
          contact_vendor: contactVendorFrom(execution.steps),
          // MONEY FACTS. `charge` is the LEDGER's net for this row, written
          // as-is: folding it onto the row's own column would add money already
          // recorded to money already there and count one debit twice. `tier` is
          // NOT the ledger's to answer -- the ledger records money, not the
          // billing model -- and a flat literal here would silently downgrade a
          // receipt, so it comes from the fold, which never downgrades.
          charge,
          tier: foldBillingWrite(row, {
            charge,
            tier: TRACE_TIER.PER_RECORD_SUBMITTED,
          }).tier,
          // Nothing else may settle this row afterwards.
          tracerfy_job_id: null,
          // ONLY WHEN THERE IS ONE. `execution.property` is null on a dossier
          // miss, and this row may be a reused row already holding a record it
          // was charged for. Writing that null would destroy the product AND
          // flip isBilledRow() to false, which un-protects a paid row from every
          // delete sweep. The RAW object, by reference, all 86 keys, when there
          // is one: the raw dump IS the product.
          ...(execution.property ? { property_record: execution.property } : {}),
          // The situs zip the dossier taught us, and ONLY when the row had none.
          // address_hash is sha256 of STREET|CITY|STATE and deliberately
          // excludes the zip (migration 20260904), so this column is free to
          // gain a value and the row keeps matching its own cache key. Never
          // recompute the hash here: a row whose hash moves re-buys itself
          // forever.
          ...(execution.learnedZip ? { zip: execution.learnedZip } : {}),
        })
        .eq('id', row.id);

      // NO CRM PUSH HERE, AND THAT IS THE DESIGN. PTP never calls HighLevel
      // unless a person asked it to, and a cron is the furthest thing from a
      // person asking. A settled Full Property Trace reaches the CRM through
      // the Push to CRM button on the result or on the job, which is
      // app/api/integrations/highlevel/push. Do not reattach a push here.

      billed++;
      if (execution.property) propertyRecords++;
      if (contactsUnreached) {
        // THE OPERATOR HALF, AND IT MATTERS AS MUCH AS THE CUSTOMER HALF. PTP
        // has no alerting channel and David chose no alert over a fake one, so
        // this cron's counters and its log lines are the ONLY place a contact
        // vendor going down can ever surface. Without these, a 500-record job
        // bills full rate through a whole outage and reports `errored: 0` with
        // nothing written anywhere. sweep-entity-traces logs its own contact
        // failure even though that path is free; this one is not free.
        console.error(
          `[sweep-property-traces] contacts unreachable for row ${row.id}, which was billed because the dossier answered: ${execution.error || 'the contact step failed'}`
        );
        contactsUnreachable++;
      } else if (isSuccessful) contactsResolved++;
      else noContacts++;
    } catch (err) {
      errored++;
      // Same ladder as the unreachable-dossier branch above. Retry a transient
      // throw; give up honestly on a row that throws every time rather than let
      // it hold a claim slot open run after run.
      await failRow(
        `[sweep-property-traces] row ${row.id} processing error on attempt ${attempt} of ${MAX_PROPERTY_TRACE_ATTEMPTS}: ${err}`
      );
    }
  };

  try {
    // STALE-CLAIM RECOVERY. Revert rows whose previous claim never finished
    // (cron killed mid-run by a Vercel timeout, OOM or deploy restart) so they
    // are eligible to be re-claimed below.
    const staleCutoff = new Date(
      Date.now() - STALE_CLAIM_MINUTES * 60 * 1000
    ).toISOString();
    // One statement per rung of the ladder, because the revert has to know which
    // attempt the row was on and 'processing' alone does not say. A CLAIM THAT
    // NEVER CAME BACK IS A SPENT ATTEMPT: a row that kills the run every time is
    // exactly as poisonous as one the vendor keeps refusing, and reverting it to
    // attempt 1 would let it loop forever.
    for (const attempt of PROPERTY_TRACE_ATTEMPTS) {
      const next = nextAfterFailedAttempt(attempt);
      const { data: revertedRows } = await adminClient
        .from('trace_history')
        .update(
          next.exhausted
            ? {
                // Terminal, and carrying NO money columns for the same reason
                // failRow's exhausted branch does: this row may already hold a
                // tier 2 receipt and a receipt is monotonic.
                property_trace_status: next.status,
                property_trace_claimed_at: null,
                status: 'error',
                is_successful: false,
              }
            : {
                property_trace_status: next.status,
                property_trace_claimed_at: null,
              }
        )
        .eq('property_trace_status', processingStatusFor(attempt))
        // BOTH ARMS, because SQL `<` never matches NULL. A row sitting in
        // processing_N with a null property_trace_claimed_at is invisible to the
        // claim query below (which only looks at the queued rungs) and would be
        // invisible to this sweep too, so nothing in the system could touch it
        // and it would hold its parent bulk job at 'processing' forever. No
        // writer produces that pair today -- the claim always sets the timestamp
        // with the status -- so this is a latch on a door nobody currently
        // opens, not a live bug. A claim with no timestamp is by definition
        // older than any cutoff, so treating it as stale is the honest reading.
        .or(
          `property_trace_claimed_at.is.null,property_trace_claimed_at.lt.${staleCutoff}`
        )
        .select('id');
      const moved = revertedRows?.length || 0;
      staleReverted += moved;
      if (next.exhausted) exhausted += moved;
    }
    if (staleReverted > 0) {
      console.log(
        `[sweep-property-traces] reverted ${staleReverted} stale claim(s) older than ${STALE_CLAIM_MINUTES}m`
      );
    }

    // The claim window. Every rung of the retry ladder is claimable; the row's
    // own status says which attempt it is on. Oldest first, which is the order
    // the partial index on (property_trace_status, created_at) can serve
    // directly.
    const { data: queuedRows } = await adminClient
      .from('trace_history')
      .select('*')
      .in('property_trace_status', PROPERTY_TRACE_QUEUED_STATUSES)
      .order('created_at', { ascending: true })
      .limit(MAX_ROWS_PER_RUN);

    if (!queuedRows || queuedRows.length === 0) {
      // `exhausted` is reported even here: the stale sweep above can retire a
      // row on its last rung without this run claiming anything at all.
      return NextResponse.json({
        success: true,
        processed: 0,
        throttled,
        exhausted,
        staleReverted,
      });
    }

    // CONCURRENCY. A shared cursor rather than fixed slices, so one slow record
    // cannot leave a worker idle while another has a backlog. Each worker still
    // takes the atomic claim per row, so a row can never be worked twice --
    // within this run or across two overlapping runs.
    const rows = queuedRows as QueueRow[];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (let index = cursor++; index < rows.length; index = cursor++) {
        await processRow(rows[index]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker())
    );

    return NextResponse.json({
      success: true,
      processed,
      billed,
      propertyRecords,
      contactsResolved,
      noContacts,
      contactsUnreachable,
      skippedNoKey,
      throttled,
      errored,
      exhausted,
      staleReverted,
    });
  } catch (error) {
    console.error('[sweep-property-traces] fatal error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
