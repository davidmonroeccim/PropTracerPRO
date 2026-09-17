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
import { TRACE_TIER } from '@/lib/trace/billedRows';
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
      const alreadyCollected = await collectedChargeFor(admin, row.id);
      const charge =
        alreadyCollected !== null
          ? alreadyCollected
          : await deductOrZero(admin, {
              p_user_id: userId,
              p_amount: personRate,
              p_trace_history_id: row.id,
              p_description: 'Bulk skip trace - entity row (post-research)',
            });

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
          tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
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
      const alreadyCollected = await collectedChargeFor(admin, row.id);
      const charge =
        alreadyCollected !== null
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
          charge,
          ai_research_charge: 0,
          tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
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
      await admin
        .from('trace_history')
        .update({
          status: 'no_match',
          trace_result: parsed,
          phone_count: 0,
          email_count: 0,
          is_successful: false,
          cost: PRICING.COST_PER_RECORD,
          charge: 0,
          tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
        })
        .eq('id', row.id);

      row.status = 'no_match';
      row.trace_result = parsed;
      row.phone_count = 0;
      row.email_count = 0;
      row.is_successful = false;
      row.charge = 0;
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

      await admin
        .from('trace_history')
        .update({
          status: isSuccessful ? 'success' : 'no_match',
          trace_result: parsed,
          phone_count: parsed.phones?.length || 0,
          email_count: parsed.emails?.length || 0,
          is_successful: isSuccessful,
          cost: PRICING.COST_PER_RECORD,
          charge,
          tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
        })
        .eq('id', match.id);

      // Reflect in local copy so the completion check below is accurate.
      match.status = isSuccessful ? 'success' : 'no_match';
      match.trace_result = parsed;
      match.phone_count = parsed.phones?.length || 0;
      match.email_count = parsed.emails?.length || 0;
      match.is_successful = isSuccessful;
      match.charge = charge;
    }

    // Mark any remaining still-processing person rows in this shared
    // bucket as no_match — Tracerfy returned its final set and these rows
    // got no result.
    const stillProcessing = bucketRows.filter((r) => r.status === 'processing');
    if (stillProcessing.length > 0) {
      await admin
        .from('trace_history')
        .update({
          status: 'no_match',
          is_successful: false,
          cost: PRICING.COST_PER_RECORD,
          charge: 0,
          tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
        })
        .in(
          'id',
          stillProcessing.map((r) => r.id)
        );
      for (const r of stillProcessing) {
        r.status = 'no_match';
        r.is_successful = false;
        r.charge = 0;
      }
    }
  }

  return { stalledErrorReason: null };
}
