// Shared poll-time bulk-trace settlement.
//
// Extracted (behavior-preserving) from the per-row `resolveOne` closure that
// used to live inline in app/api/v1/trace/bulk/status/route.ts, so the v1 REST
// route and the (later) Suite MCP tool settle a bulk trace job through ONE code
// path and can never diverge on money.
//
// The ONLY parameterized value is the person-trace rate (`personRate`): the v1
// route passes its current getChargePerTrace(...) rate; the MCP passes the
// grant-aware rate. Every other branch and every wallet effect (entity
// Tracerfy-delivered charge at the person rate, entity FastAppend
// refund-$0.15-then-charge-$0.25, no-match $0) is IDENTICAL to the original
// route. The wallet owner (p_user_id) is always the local user_profiles.id,
// supplied as `userId`, never derived from tool/request input.

import type { createAdminClient } from '@/lib/supabase/admin';
import { getJobStatus, parseTracerfyResult, type TracerfyErrorReason } from '@/lib/tracerfy/client';
import { traceCreditFromFastAppend } from '@/lib/ai-research/contacts';
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
};

export type SettleBulkJobArgs = {
  // The Tracerfy job id whose rows are being settled this round.
  tracerfyJobId: string;
  // The trace_history rows backed by that Tracerfy job. Mutated in place exactly
  // as the original closure did, so the caller's completion check stays accurate.
  bucketRows: TraceHistoryRow[];
  // Wallet owner: ALWAYS the local user_profiles.id, never tool/request input.
  userId: string;
  // Per-successful-person-trace charge. Injected so the caller decides
  // grant-awareness (v1 = getChargePerTrace(...); MCP = grant-aware $0.07).
  // Entity/FastAppend amounts stay flat constants and are NOT affected by this.
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

    // FastAppend bundled fallback: if Tracerfy returned nothing for this
    // entity row, check whether FastAppend lent its async business-trace
    // results between cron and now (sweep-business-traces merges contacts
    // into ai_research). When it has, refund the $0.15 research charge
    // the cron already booked and apply the single bundled $0.25 -- the
    // user paid for one credited row, not research-plus-trace separately.
    const fastAppendCredit = tracerfyHasContacts
      ? null
      : traceCreditFromFastAppend(row.ai_research);

    if (tracerfyHasContacts) {
      // Tracerfy delivered contacts -- charge tier-aware trace fee on top
      // of the AI research charge already booked by the cron.
      const charge = personRate;
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
        })
        .eq('id', row.id);

      await admin.rpc('deduct_wallet_balance', {
        p_user_id: userId,
        p_amount: charge,
        p_trace_history_id: row.id,
        p_description: 'Bulk skip trace - entity row (post-research)',
      });

      row.status = 'success';
      row.trace_result = parsed;
      row.phone_count = parsed.phones?.length || 0;
      row.email_count = parsed.emails?.length || 0;
      row.is_successful = true;
      row.charge = charge;
    } else if (fastAppendCredit) {
      // Tracerfy whiffed but FastAppend has contacts now. Refund the
      // $0.15 research charge the cron booked (so the wallet ledger and
      // row both reflect the bundled $0.25 model) and apply the bundled
      // FastAppend success charge.
      const priorResearchCharge = row.ai_research_charge || 0;
      if (priorResearchCharge > 0) {
        await admin.rpc('credit_wallet_balance', {
          p_user_id: userId,
          p_amount: priorResearchCharge,
          p_description:
            'Refund: AI research bundled into FastAppend success ($0.25)',
        });
      }
      await admin.rpc('deduct_wallet_balance', {
        p_user_id: userId,
        p_amount: PRICING.CHARGE_PER_FASTAPPEND_SUCCESS,
        p_trace_history_id: row.id,
        p_description:
          'FastAppend business-trace contacts (bundled research + trace)',
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
          charge: PRICING.CHARGE_PER_FASTAPPEND_SUCCESS,
          ai_research_charge: 0,
        })
        .eq('id', row.id);

      row.status = 'success';
      row.trace_result = fastAppendCredit.trace_result;
      row.phone_count = fastAppendCredit.phone_count;
      row.email_count = fastAppendCredit.email_count;
      row.is_successful = true;
      row.charge = PRICING.CHARGE_PER_FASTAPPEND_SUCCESS;
      row.ai_research_charge = 0;
    } else {
      // No contacts from either provider -- no_match. The $0.15
      // research charge already booked stays put. If FastAppend lands
      // later via sweep-business-traces, that cron will refund the
      // $0.15 and apply the bundled credit.
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
      const charge = isSuccessful ? personRate : 0;

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
        })
        .eq('id', match.id);

      if (isSuccessful && charge > 0) {
        await admin.rpc('deduct_wallet_balance', {
          p_user_id: userId,
          p_amount: charge,
          p_trace_history_id: match.id,
          p_description: 'Bulk skip trace - successful match',
        });
      }

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
