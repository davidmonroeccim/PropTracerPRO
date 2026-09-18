// Shared poll-time bulk-trace settlement.
//
// Extracted (behavior-preserving) from the per-row `resolveOne` closure that
// used to live inline in app/api/v1/trace/bulk/status/route.ts, so the v1 REST
// route and the (later) Suite MCP tool settle a bulk trace job through ONE code
// path and can never diverge on money.
//
// The ONLY parameterized value is the TIER 1 per-successful-trace rate
// (`personRate`): the v1 route passes its current getChargePerTrace(...) rate;
// the MCP passes the grant-aware rate. Owner type selects the VENDOR, never the
// price, so every settled success on this path bills that one rate, whether the
// contacts came from Tracerfy or from FastAppend. The wallet owner (p_user_id)
// is always the local user_profiles.id, supplied as `userId`, never derived
// from tool/request input.

import type { createAdminClient } from '@/lib/supabase/admin';
import { getJobStatus, parseTracerfyResult, type TracerfyErrorReason } from '@/lib/tracerfy/client';
import { traceCreditFromFastAppend } from '@/lib/ai-research/contacts';
import { deductOrZero } from '@/lib/wallet/deduct';
import { collectedChargeFor } from '@/lib/wallet/collectedCharge';
import { TRACE_TIER, foldBillingWrite, excludeBilledRows } from '@/lib/trace/billedRows';
import { PRICING } from '@/lib/constants';
import type { TraceResult, AIResearchResult } from '@/types';

type AdminClient = ReturnType<typeof createAdminClient>;

export type TraceHistoryRow = {
  id: string;
  user_id: string;
  trace_job_id: string | null;
  address_hash: string;
  normalized_address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  input_owner_name: string | null;
  tracerfy_job_id: string | null;
  status: string;
  trace_result: TraceResult | null;
  ai_research: AIResearchResult | null;
  ai_research_status: string | null;
  ai_research_charge: number | null;
  phone_count: number;
  email_count: number;
  is_successful: boolean | null;
  charge: number | null;
  // Added by migration 20260917. OPTIONAL rather than `| null`: every reader of this type loads
  // rows with select('*'), so both columns are always present in production, but a row written
  // before the migration carries no value and the existing test fixtures construct this type by
  // hand. Readers emit them through toPublicPropertyRecord / `?? null`, so absent reads as null.
  //
  // property_record is the vendor's RAW 86-key dossier as stored. It MUST be filtered before it
  // leaves PTP: see lib/trace/publicPropertyRecord.ts.
  property_record?: unknown;
  // 1 = billed per successful trace, 2 = billed per record submitted.
  tier?: number | null;
  // Added by migration 20260918. The TIER 2 queue, driven by
  // app/api/cron/sweep-property-traces. Nothing in this file settles it -- it is
  // declared here because every bulk STATUS surface loads this type with
  // select('*') and has to ask isPropertyTracePending() about it before calling
  // a job finished. A job that finalizes over a queued row reports short on rows
  // the customer is about to be billed for, and a completed job is never polled
  // again. Optional for the same reason as the two above: rows written before
  // the migration carry no value, and absent reads as not pending.
  property_trace_status?: string | null;
  // Added by migration 20260918. Set together with highlevel_contact_id when a
  // push reaches the customer's CRM. Read by the v1 bulk status route to skip a
  // row sweep-property-traces has already pushed: a tier 2 row is settled by the
  // cron and finalized here, so without it the same contact is pushed twice.
  // Optional for the same reason as the columns above: rows written before the
  // migration carry no value, and absent reads as never pushed.
  highlevel_pushed_at?: string | null;
};

export type SettleBulkJobArgs = {
  // The Tracerfy job id whose rows are being settled this round.
  tracerfyJobId: string;
  // The trace_history rows backed by that Tracerfy job. Mutated in place exactly
  // as the original closure did, so the caller's completion check stays accurate.
  bucketRows: TraceHistoryRow[];
  // Wallet owner: ALWAYS the local user_profiles.id, never tool/request input.
  userId: string;
  // Tier 1 per-successful-trace charge for this caller's plan. Injected so the
  // caller decides grant-awareness (v1 = getChargePerTrace(...); MCP =
  // grant-aware chargePerTrace(...)). It prices EVERY success on this path,
  // including the FastAppend entity branch.
  personRate: number;
};

export type SettleResult = {
  // Set to the Tracerfy errorReason when this job's poll came back unhealthy this
  // round (rate_limited / 503 / malformed / ...), null otherwise. The caller
  // records it into its stalledByErrorReason map keyed by tracerfyJobId, exactly
  // as the original closure did inline.
  stalledErrorReason: TracerfyErrorReason | null;
};

export async function settleBulkJob(
  admin: AdminClient,
  args: SettleBulkJobArgs
): Promise<SettleResult> {
  const { tracerfyJobId, bucketRows, userId, personRate } = args;

  const statusResult = await getJobStatus(tracerfyJobId);

  if (!statusResult.success || statusResult.pending === true) {
    // still processing — leave rows as-is. Surface any unhealthy errorReason so
    // the caller can stall-detect (original set stalledByErrorReason here).
    return { stalledErrorReason: statusResult.errorReason ?? null };
  }

  if (!statusResult.results || statusResult.results.length === 0) {
    return { stalledErrorReason: null }; // treat empty results as still processing per existing behavior
  }

  // Finalize the rows backed by this Tracerfy job.
  if (bucketRows.length === 1) {
    // Single-trace submission (entity row post-research). Find the best
    // result and apply it directly to this one row.
    const row = bucketRows[0];
    const nonPadding = statusResult.results.filter(
      (r) => r.address !== '0 Padding Row'
    );
    const target =
      nonPadding.find((r) => r.primary_phone || r.mobile_1 || r.email_1) ||
      nonPadding[0];
    if (!target) return { stalledErrorReason: null };

    const parsed = parseTracerfyResult(target);
    const tracerfyHasContacts =
      (parsed.phones?.length || 0) > 0 || (parsed.emails?.length || 0) > 0;

    // FastAppend fallback: if Tracerfy returned nothing for this entity row,
    // check whether FastAppend lent its async business-trace results between
    // cron and now (sweep-business-traces merges contacts into ai_research).
    // When it has, apply ONE tier 1 per-success charge at the caller's plan
    // rate, and refund any AI research charge the row is still carrying.
    //
    // THAT REFUND SERVICES HISTORICAL ROWS ONLY. The $0.15 research fee was
    // retired with the AI Search engine on 2026-09-17 and sweep-entity-traces
    // now writes ai_research_charge: 0 on every row it touches, so a row
    // created since then has nothing to refund and the refund arm is skipped by
    // its own `> 0` test. It stays because 1,301 rows written before that date
    // do carry a real charge, and they still settle through here.
    const fastAppendCredit = tracerfyHasContacts
      ? null
      : traceCreditFromFastAppend(row.ai_research);

    if (tracerfyHasContacts) {
      // Tracerfy delivered contacts -- charge the tier 1 per-success fee at the
      // caller's plan rate. That is the WHOLE charge for this row: nothing books
      // a research fee any more, so there is no second line item under it.
      // Deduct FIRST so the row records what the wallet actually gave up (0 if
      // it was short), never the intended amount.
      // NEVER CHARGE A ROW THE WALLET HAS ALREADY PAID FOR. sweep-entity-traces
      // can deduct on a FastAppend hit and then throw, which requeues the row;
      // on the retry FastAppend may return nothing, so the row arrives HERE and
      // is charged a second time for the same answer. Two files, one row, two
      // debits, and no unusual failure required. The ledger is the check because
      // it is written in the same transaction as the money.
      //
      // `> 0`, NOT `!== null`. The probe answers the NET of this row's debits
      // and credits, so a row whose debits were all refunded comes back as 0 --
      // money collected and handed straight back -- and 0 is not a collection.
      const alreadyCollected = await collectedChargeFor(admin, row.id);
      const charge =
        alreadyCollected !== null && alreadyCollected > 0
          ? alreadyCollected
          : await deductOrZero(admin, {
              p_user_id: userId,
              p_amount: personRate,
              p_trace_history_id: row.id,
              p_description: 'Bulk skip trace - entity row (post-research)',
            });

      // `charge` is the LEDGER's answer and is written as-is: folding it would
      // add money already recorded to money already on the row. `tier` is NOT
      // the ledger's to answer, and a flat 1 silently downgrades a tier 2
      // receipt, so it comes from the fold, which never downgrades.
      await admin
        .from('trace_history')
        .update({
          status: 'success',
          trace_result: parsed,
          phone_count: parsed.phones?.length || 0,
          email_count: parsed.emails?.length || 0,
          is_successful: true,
          cost: PRICING.COST_PER_RECORD,
          charge,
          tier: foldBillingWrite(row, { charge, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE }).tier,
        })
        .eq('id', row.id);

      row.status = 'success';
      row.trace_result = parsed;
      row.phone_count = parsed.phones?.length || 0;
      row.email_count = parsed.emails?.length || 0;
      row.is_successful = true;
      row.charge = charge;
    } else if (fastAppendCredit) {
      // Tracerfy whiffed but FastAppend has contacts now. Bill ONE tier 1
      // per-success charge at the caller's plan rate. Owner type picks the
      // vendor, never the price, so this is the SAME personRate the Tracerfy
      // branch above uses.
      //
      // The refund below is for HISTORICAL rows. On a row written since
      // 2026-09-17 ai_research_charge is 0 and the arm does not run; on one of
      // the 1,301 older rows it hands back a research fee the retired engine
      // booked, so the customer pays for one credited row rather than research
      // plus trace.
      const priorResearchCharge = row.ai_research_charge || 0;
      if (priorResearchCharge > 0) {
        await admin.rpc('credit_wallet_balance', {
          p_user_id: userId,
          p_amount: priorResearchCharge,
          p_description:
            'Refund: AI research folded into the successful trace charge',
          // THE REFUND NAMES THE ROW IT REFUNDS, and the probe below is the
          // reason. It sums wallet_transactions for this row; an unlinked credit
          // is invisible to it, so the money just handed back would still read
          // as collected, the deduct would be skipped, and the customer would
          // get the contacts free while `charge` reported an amount that had
          // been returned. Migration 20260917 added this parameter for this
          // call. The Stripe webhook's credits are genuine top-ups belonging to
          // no row and must keep passing four arguments.
          p_trace_history_id: row.id,
        });
      }
      // Same guard as the Tracerfy branch, and it has to be here too: the cron
      // books its charge on exactly this FastAppend hit, so this is the arm most
      // likely to be settling a row that has already paid.
      //
      // The refund above is deliberately NOT inside the guard. It is keyed on
      // the row still carrying ai_research_charge > 0, which zeroes itself once
      // it runs, and the cron never refunds. A row the cron charged can still be
      // owed that refund.
      //
      // AND THE REFUND IS SUBTRACTED FROM THIS ANSWER, which is the point of
      // linking it. `> 0`, not `!== null`: a row whose only debit was the
      // research fee this arm just handed back nets to 0, and 0 is not a
      // collection -- skipping the deduct on it gives the contacts away.
      const alreadyCollected = await collectedChargeFor(admin, row.id);
      const charge =
        alreadyCollected !== null && alreadyCollected > 0
          ? alreadyCollected
          : await deductOrZero(admin, {
              p_user_id: userId,
              p_amount: personRate,
              p_trace_history_id: row.id,
              p_description: 'FastAppend business-trace contacts (successful trace)',
            });

      await admin
        .from('trace_history')
        .update({
          status: 'success',
          trace_result: fastAppendCredit.trace_result,
          phone_count: fastAppendCredit.phone_count,
          email_count: fastAppendCredit.email_count,
          is_successful: true,
          cost: PRICING.COST_PER_RECORD,
          // Ledger amount raw, tier from the fold. Same split as the branch
          // above: the ledger knows what moved, it does not know the model.
          charge,
          ai_research_charge: 0,
          tier: foldBillingWrite(row, { charge, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE }).tier,
        })
        .eq('id', row.id);

      row.status = 'success';
      row.trace_result = fastAppendCredit.trace_result;
      row.phone_count = fastAppendCredit.phone_count;
      row.email_count = fastAppendCredit.email_count;
      row.is_successful = true;
      row.charge = charge;
      row.ai_research_charge = 0;
    } else {
      // No contacts from either provider -- no_match, and under tier 1 a miss
      // is FREE. A row written since 2026-09-17 leaves here having been charged
      // nothing at all, because nothing books a research fee any more.
      //
      // One of the 1,301 historical rows can still be sitting on an
      // ai_research_charge the retired engine booked. That amount is left
      // alone here rather than refunded, because it was charged for work that
      // really was done. If FastAppend lands later via sweep-business-traces,
      // that cron hands it back and applies the tier 1 per-success charge
      // instead.
      //
      // FREE MEANS "COLLECT NOTHING FURTHER", NOT "THIS ROW WAS ALWAYS FREE".
      // This row is REUSED, never re-inserted (UNIQUE(user_id, address_hash)),
      // so it can already carry a tier 2 receipt: tier 2 bills per record
      // SUBMITTED, which makes `is_successful = false, charge > 0` a PAID row.
      // A flat `charge: 0, tier: 1` over it erased the receipt while
      // wallet_transactions still referenced it. Folding a collection of 0
      // changes nothing on a row that never paid and preserves one that did.
      const billing = foldBillingWrite(row, {
        charge: 0,
        tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
      });

      await admin
        .from('trace_history')
        .update({
          status: 'no_match',
          trace_result: parsed,
          phone_count: 0,
          email_count: 0,
          is_successful: false,
          cost: PRICING.COST_PER_RECORD,
          charge: billing.charge,
          tier: billing.tier,
        })
        .eq('id', row.id);

      row.status = 'no_match';
      row.trace_result = parsed;
      row.phone_count = 0;
      row.email_count = 0;
      row.is_successful = false;
      row.charge = billing.charge;
    }
  } else {
    // Shared bulk Tracerfy job — match results back to person rows by
    // city/state, mirroring the existing bulk status matcher.
    for (const rawResult of statusResult.results) {
      const inputCity = (rawResult.city || '').toUpperCase().trim();
      const inputState = (rawResult.state || '').toUpperCase().trim();

      // Find the first still-processing row in this bucket that matches.
      const match = bucketRows.find(
        (r) =>
          r.status === 'processing' &&
          (r.city || '').toUpperCase() === inputCity &&
          (r.state || '').toUpperCase() === inputState
      );
      if (!match) continue;

      const parsed = parseTracerfyResult(rawResult);
      const isSuccessful =
        (parsed.phones?.length || 0) > 0 || (parsed.emails?.length || 0) > 0;
      // Deduct FIRST, then persist the amount that actually moved.
      const charge =
        isSuccessful && personRate > 0
          ? await deductOrZero(admin, {
              p_user_id: userId,
              p_amount: personRate,
              p_trace_history_id: match.id,
              p_description: 'Bulk skip trace - successful match',
            })
          : 0;

      // ACCUMULATE, never replace. Two settles against one reused row are two
      // real debits in wallet_transactions, and writing only the second drops
      // the first out of SUM(trace_history.charge) -- the number both status
      // routes and the MCP report as total_charge. On a miss `charge` is 0, and
      // folding 0 leaves an existing receipt exactly where it is.
      const billing = foldBillingWrite(match, {
        charge,
        tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
      });

      await admin
        .from('trace_history')
        .update({
          status: isSuccessful ? 'success' : 'no_match',
          trace_result: parsed,
          phone_count: parsed.phones?.length || 0,
          email_count: parsed.emails?.length || 0,
          is_successful: isSuccessful,
          cost: PRICING.COST_PER_RECORD,
          charge: billing.charge,
          tier: billing.tier,
        })
        .eq('id', match.id);

      // Reflect in local copy so the completion check below is accurate.
      match.status = isSuccessful ? 'success' : 'no_match';
      match.trace_result = parsed;
      match.phone_count = parsed.phones?.length || 0;
      match.email_count = parsed.emails?.length || 0;
      match.is_successful = isSuccessful;
      match.charge = billing.charge;
    }

    // Mark any remaining still-processing person rows in this shared
    // bucket as no_match — Tracerfy returned its final set and these rows
    // got no result.
    //
    // TWO STATEMENTS, AND THE SPLIT IS THE WHOLE POINT. **STATUS IS NOT A
    // RECEIPT.** excludeBilledRows exists to protect `charge` and `tier`.
    // `status` and `is_successful` are DELIVERY facts, and a paid row needs
    // them MORE than an unpaid one, not less.
    //
    // Putting them behind the same guard strands the row: a billed tier 2 row
    // that got no vendor result fails the guard, keeps `status = 'processing'`,
    // and both callers then finalize the job around it -- after which nothing
    // polls it again. An hour later sweep-stale-traces stage 1 claims it
    // (status + created_at) and settles it against
    // `nonPaddingResults.find(r => r.primary_phone || ...)`, which for a SHARED
    // bulk Tracerfy job is whichever OTHER property in the batch came back.
    // Second charge on the same address, a stranger's phone and email written
    // onto the customer's parcel, and both pushed to their CRM.
    const stillProcessing = bucketRows.filter((r) => r.status === 'processing');
    if (stillProcessing.length > 0) {
      const ids = stillProcessing.map((r) => r.id);

      // 1. THE MONEY, guarded. A blanket update cannot carry a per-row folded
      //    amount, so instead it may only ever touch rows that have collected
      //    nothing: excludeBilledRows makes that true in the database rather
      //    than here, so there is no read-then-write race. On those rows a flat
      //    `charge: 0` is a no-op that normalises NULL, and the tier stamp
      //    records the billing model that produced them.
      await excludeBilledRows(
        admin
          .from('trace_history')
          .update({
            charge: 0,
            tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
          })
          .in('id', ids)
      );

      // 2. THE DELIVERY FACTS, for every row. Unguarded on purpose: a row that
      //    was paid for still has to be told it got no result, or it is left
      //    for a cron that will sell it someone else's contacts.
      //
      //    `.eq('status', 'processing')` MATCHES ITS TWO SIBLINGS in
      //    bulk/status and sweep-stale-traces, and it is not decoration here
      //    either. `ids` was read at the top of this function and the statement
      //    runs some vendor round-trips later. Within ONE request a row that
      //    succeeded cannot be in the list -- the per-result loop only matches
      //    rows still 'processing' and updates the local copy -- but nothing
      //    stops a CONCURRENT settle of the same Tracerfy job from succeeding a
      //    row between the read and this write. Without the filter this
      //    statement then stamps `no_match, is_successful: false` over a row
      //    that has real contacts on it, and the guarded money statement above
      //    has already declined to touch it. The filter makes the statement a
      //    no-op on any row that moved on, in the database rather than here.
      await admin
        .from('trace_history')
        .update({
          status: 'no_match',
          is_successful: false,
          cost: PRICING.COST_PER_RECORD,
        })
        .in('id', ids)
        .eq('status', 'processing');

      for (const r of stillProcessing) {
        r.status = 'no_match';
        r.is_successful = false;
        // `charge` is deliberately left alone. The v1 status route and the MCP
        // bulk_status both SUM it off these in-memory rows to report
        // total_charge, and zeroing it here would under-report a receipt the
        // guarded statement above deliberately did not touch.
      }
    }
  }

  return { stalledErrorReason: null };
}
