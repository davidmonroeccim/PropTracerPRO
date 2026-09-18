import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { lookupBusinessTrace, lookupPersonTrace } from '@/lib/tracerfy/client';
import { lookupDossier } from '@/lib/tracerfy/dossier';
import { executeRoute } from '@/lib/routing/executeRoute';
import { FAILSAFE_PRICE_PLAN, planRoute, type PricePlan, type StepKind } from '@/lib/routing/ownerRoute';
import {
  FULL_PROPERTY_TRACE_DESCRIPTION,
  hasContactData,
  parcelForFullTrace,
  traceResultFor,
} from '@/lib/trace/fullPropertyTrace';
import { TRACE_TIER, foldBillingWrite } from '@/lib/trace/billedRows';
import { deductOrZero } from '@/lib/wallet/deduct';
import { collectedChargeFor } from '@/lib/wallet/collectedCharge';
import { isTrackASource, pricePlanFor } from '@/lib/suite/pricing';
import { rawPricePlanFor } from '@/lib/api/pricing';
import {
  MAX_PROPERTY_TRACE_ATTEMPTS,
  PROPERTY_TRACE_ATTEMPTS,
  PROPERTY_TRACE_NO_KEY_STATUS,
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
 * NOTHING ENQUEUES INTO THIS COLUMN YET. The submit routes learn to write
 * 'queued' in phase 5c-3; until then this cron claims nothing every minute and
 * returns processed: 0. That is expected, not a wiring bug.
 */
export const maxDuration = 300;

/**
 * Records claimed per run, and the concurrency they run at. Sized from live
 * measurement on 2026-09-18, not from a guess.
 *
 * BOTH tier 2 calls draw Tracerfy's SHARED 500/minute instant pool (the dossier
 * endpoint's own header says the counter is shared with Instant Trace, Enhanced
 * Trace, Phone Verification and APN Instant Lookup). Tier 1 bulk posts to the
 * BATCH endpoint, a different bucket, so it does not compete. Two calls per
 * record is therefore a hard ceiling of 250 records/minute for this queue alone.
 *
 * 120 records at concurrency 5 is 240 calls/minute, 48% of the pool, which
 * leaves headroom for single traces running at the same time. sweep-entity-
 * traces also runs every minute and draws the same pool, but its
 * MAX_ROWS_PER_RUN is 5, under 2% of it, so it does not change this arithmetic.
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
  normalized_address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** Track A or Track B. See pricePlanForRow below; this is a PRICE decision. */
  source: string | null;
  property_trace_status: string | null;
  /** Receipt columns, read so foldBillingWrite can never downgrade them. */
  charge: number | string | null;
  tier: number | string | null;
  property_record: unknown;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  let processed = 0;
  let billed = 0;
  let propertyRecords = 0;
  let contactsResolved = 0;
  let noContacts = 0;
  let skippedNoKey = 0;
  let errored = 0;
  let staleReverted = 0;
  // Rows that used up every attempt this run and were written terminal. Not a
  // subset of `errored`: a stale claim can exhaust a row without this run ever
  // calling a vendor for it.
  let exhausted = 0;

  /**
   * Which column of the price table this row pays, resolved once per
   * (user, track) per run.
   *
   * THE TRACK IS THE AXIS, NOT THE USER, and the split is deliberate
   * (lib/suite/pricing.ts). Track A -- the signed-in dashboard and the Suite MCP
   * -- is GRANT-AWARE and prices through pricePlanFor(), which counts a gateway
   * product grant. Track B -- the /api/v1/* API-key surface -- is RAW and prices
   * through rawPricePlanFor(), which deliberately does not consult the gateway
   * snapshot. Reusing the Track A helper for everything would move an existing
   * API caller's tier 2 bill from $0.40 to $0.25, in the direction nobody
   * reports.
   *
   * Which track a row belongs to is read off its own `source` tag, which the
   * submit routes write. An untagged row is Track B, which is also the dearer
   * derivation, so the fallback errs in the safe direction. So does the
   * no-profile fallback: FAILSAFE_PRICE_PLAN is the dearest column of all
   * (lib/routing/ownerRoute.ts explains why a cheap default once cost 40% of a
   * pay-as-you-go invoice, silently).
   *
   * OWNER TYPE SELECTS THE VENDOR, NEVER THE PRICE (L-005). There is no entity
   * rate and no individual rate anywhere below.
   *
   * The cache is read and written by several workers at once. The worst a race
   * can do is repeat a read-only profile query; nothing here is order-dependent.
   */
  const pricePlanCache = new Map<string, PricePlan>();
  const pricePlanForRow = async (
    userId: string,
    source: string | null | undefined
  ): Promise<PricePlan> => {
    const isTrackA = isTrackASource(source);
    const key = `${userId}:${isTrackA ? 'A' : 'B'}`;
    const cached = pricePlanCache.get(key);
    if (cached !== undefined) return cached;
    const { data: rateProfile } = await adminClient
      .from('user_profiles')
      .select('subscription_tier, is_acquisition_pro_member, gateway_products')
      .eq('id', userId)
      .single();
    const plan = !rateProfile
      ? FAILSAFE_PRICE_PLAN
      : isTrackA
        ? pricePlanFor(rateProfile)
        : rawPricePlanFor(rateProfile);
    pricePlanCache.set(key, plan);
    return plan;
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
      // normalized_address is a pipe-delimited dedup key of exactly THREE
      // fields, street|city|state, like "160 MINE LAKE CT|RALEIGH|NC". There is
      // no zip in it: normalizeAddress() dropped it deliberately (migration
      // 20260904). The zip lives in its own column. Pull the street portion back
      // out before handing it to a vendor, which expects a raw street address
      // and separate city/state/zip.
      const streetAddress =
        row.normalized_address.split('|')[0] || row.normalized_address;

      // planRoute takes the price plan as a REQUIRED argument so that no caller
      // can quietly bill the wrong column. parcelForFullTrace deliberately
      // passes ownerName: null -- tier 2 is dossier-first by definition, and a
      // plan built with an owner name present returns a tier 1 route with no
      // dossier step at all.
      const pricePlan = await pricePlanForRow(row.user_id, row.source);
      const plan = planRoute(
        parcelForFullTrace({
          address: streetAddress,
          city: row.city || '',
          state: row.state || '',
          zip: row.zip,
        }),
        pricePlan
      );

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
       * in total. One contact-vendor outage across one 500-record job would
       * spend that pool four times over and take every other user's job down
       * with it.
       *
       * This is a DELIBERATE divergence from app/api/trace/single, which returns
       * 502 and charges nothing on a contact-vendor failure. A single trace can
       * be resubmitted by the customer immediately and for free, so leaving it
       * unbilled costs nobody anything. A queued bulk row cannot: the only way
       * to run it again is to re-buy the dossier.
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
      const alreadyCollected = await collectedChargeFor(adminClient, row.id);
      const charge =
        alreadyCollected !== null && alreadyCollected > 0
          ? alreadyCollected
          : // Deduct FIRST, then persist the amount that actually moved. The
            // amount comes off the plan, which is the one place the tier 2
            // per-record rate for this caller's column is resolved.
            await deductOrZero(adminClient, {
              p_user_id: row.user_id,
              p_amount: plan.billing.amount,
              p_trace_history_id: row.id,
              p_description: FULL_PROPERTY_TRACE_DESCRIPTION,
            });

      const result = traceResultFor(execution);
      const isSuccessful = hasContactData(result);

      await adminClient
        .from('trace_history')
        .update({
          property_trace_status: PROPERTY_TRACE_SETTLED_STATUS,
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
          // MONEY FACTS. `charge` is the LEDGER's answer when the ledger had one
          // and is written as-is: folding it would add money already recorded to
          // money already on the row and count one debit twice. `tier` is NOT
          // the ledger's to answer -- the ledger records money, not the billing
          // model -- and a flat literal here would silently downgrade a receipt,
          // so it comes from the fold, which never downgrades.
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

      billed++;
      if (execution.property) propertyRecords++;
      if (isSuccessful) contactsResolved++;
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
      skippedNoKey,
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
