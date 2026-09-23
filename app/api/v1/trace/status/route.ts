import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { deductWallet } from '@/lib/wallet/deduct';
import { foldBillingWrite, TRACE_TIER } from '@/lib/trace/billedRows';
import { propertyAddressLabel } from '@/lib/trace/historyDisplay';
import { toPublicPropertyRecord } from '@/lib/trace/publicPropertyRecord';
import { PRICING, STALE_PROCESSING, getChargePerTrace } from '@/lib/constants';
import type { TraceResult } from '@/types';

// validateApiKey's blocking entitlement refresh (lib/suite/access.ts) can add up to 5s
// (AbortSignal.timeout(5000)) plus an un-timeouted UPDATE in front of the Tracerfy poll and
// wallet settle below, so this needs the same headroom as its siblings (trace/single,
// trace/bulk, trace/bulk/status), all of which set 60 against the ~10s platform default.
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const traceId = searchParams.get('trace_id');

    if (!traceId) {
      return NextResponse.json(
        { success: false, error: 'Missing trace_id' },
        { status: 400 }
      );
    }

    // Authenticate via API key
    const authResult = await validateApiKey(request);
    if (isAuthError(authResult)) {
      return authResult.response;
    }
    const { profile } = authResult;

    const adminClient = createAdminClient();

    // Look up the trace record
    const { data: trace } = await adminClient
      .from('trace_history')
      .select('*')
      .eq('id', traceId)
      .eq('user_id', profile.id)
      .single();

    if (!trace) {
      return NextResponse.json(
        { success: false, error: 'Trace not found' },
        { status: 404 }
      );
    }

    // Already completed - return the result.
    //
    // property_record and tier are READ, never re-bought. A Full Property Trace
    // bills per record submitted, so an integrator polling this endpoint has
    // already paid for the county record; without these two keys there was no
    // way left to get it back, and a poll was the documented way to collect an
    // async result. Nothing here calls a vendor.
    //
    // The row holds all 86 keys and this response carries 65. Re-reading a
    // stored record is an egress: the 21 blocked fields are withheld here
    // exactly as they are on the submit that bought it, or an integrator could
    // collect the wrong `estimated_value` on the poll instead of the submit.
    // See lib/trace/publicPropertyRecord.ts.
    if (trace.status === 'success' || trace.status === 'no_match' || trace.status === 'error') {
      return NextResponse.json({
        success: true,
        status: trace.status,
        trace_id: trace.id,
        result: trace.trace_result as TraceResult | null,
        research: trace.ai_research || null,
        property_record: toPublicPropertyRecord(trace.property_record),
        tier: trace.tier ?? null,
        charge: trace.charge || 0,
        is_cached: false,
      });
    }

    // Still processing - check Tracerfy for results
    if (!trace.tracerfy_job_id) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        trace_id: trace.id,
      });
    }

    const statusResult = await getJobStatus(trace.tracerfy_job_id);

    console.log('API v1 trace status check:', trace.id, '| job:', trace.tracerfy_job_id,
      '| success:', statusResult.success, '| pending:', statusResult.pending,
      '| results:', statusResult.results?.length || 0,
      '| errorReason:', statusResult.errorReason || 'none');

    // Stall detection: if Tracerfy has been unhealthy for this row past the
    // threshold, promote to status='error' so callers get a definitive answer
    // instead of polling 'processing' forever. Gated on errorReason being set
    // -- a genuine `pending: true` from Tracerfy (no errorReason) keeps the
    // row in 'processing' regardless of age.
    const ageMinutes =
      (Date.now() - new Date(trace.created_at).getTime()) / 60000;

    if (
      statusResult.errorReason &&
      ageMinutes >= STALE_PROCESSING.TRACERFY_STALL_MINUTES
    ) {
      console.error(
        `[v1/trace/status] stall: trace=${trace.id} reason=${statusResult.errorReason} age=${ageMinutes.toFixed(1)}m`
      );
      await adminClient
        .from('trace_history')
        .update({ status: 'error' })
        .eq('id', trace.id);
      return NextResponse.json({
        success: false,
        status: 'error',
        trace_id: trace.id,
        error: `Tracerfy upstream unhealthy: ${statusResult.errorReason} for ${ageMinutes.toFixed(0)}m`,
        tracerfy_state: statusResult.errorReason,
        age_minutes: Math.round(ageMinutes),
      });
    }

    // Tracerfy still processing
    if (!statusResult.success || statusResult.pending === true) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        trace_id: trace.id,
        // Surface diagnostics so callers aren't flying blind. errorReason is
        // set if Tracerfy is unhealthy but the row isn't old enough yet to
        // promote to 'error'.
        tracerfy_state: statusResult.errorReason || 'pending',
        age_minutes: Math.round(ageMinutes),
      });
    }

    // Results ready - parse them
    let result: TraceResult | null = null;

    if (statusResult.results && statusResult.results.length > 0) {
      // Filter out padding rows
      const nonPaddingResults = statusResult.results.filter(
        (r) => r.address !== '0 Padding Row'
      );

      // Find the best result - prefer ones with contact data
      const targetResult = nonPaddingResults.find(
        (r) => r.primary_phone || r.mobile_1 || r.email_1
      ) || nonPaddingResults[0];

      if (targetResult) {
        result = parseTracerfyResult(targetResult);
      }
    }

    // Determine success
    const isSuccessful = result !== null &&
      ((result.phones?.length || 0) > 0 || (result.emails?.length || 0) > 0);

    const chargePerTrace = getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member);
    // Charge the wallet FIRST so `charge` is the amount that actually moved: a
    // short wallet returns false without deducting. `charge` is written to the
    // trace_history row, POSTed in the trace.completed webhook, and returned in
    // the response body -- and this is the API surface integrators reconcile
    // their own books against, so a phantom amount propagates outward.
    const attemptedCharge = isSuccessful ? chargePerTrace : 0;
    const deduction =
      attemptedCharge > 0
        ? await deductWallet(adminClient, {
            p_user_id: profile.id,
            p_amount: attemptedCharge,
            p_trace_history_id: trace.id,
            p_description: 'Skip trace - successful match',
          })
        : ({ collected: 0, outcome: 'charged' } as const);
    const charge = deduction.collected;

    if (deduction.outcome === 'error') {
      // OUR failure, not the integrator's balance. They keep the contacts and
      // are not billed. Logged so the uncollected charge is findable rather
      // than silent.
      console.error(
        '[v1/trace/status] wallet deduct failed, result delivered uncharged:',
        trace.id,
        deduction.message
      );
    }

    // RECEIPTS ARE MONOTONIC, and this is the write that used to destroy one.
    //
    // A tier 2 row reused by a later tier 1 trace arrives here carrying
    // `tier = 2` and a real `charge`. Writing this settle's numbers over them
    // zeroed a paid receipt and downgraded the tier, which made the row read
    // UNBILLED to excludeBilledRows while wallet_transactions still referenced
    // it by FK, and the next submit then 500'd on 23503 forever. It also broke
    // isCacheHitRow's `tier = 2 AND charge > 0` arm, so a billed tier 2 miss
    // silently started re-buying. See lib/trace/billedRows.ts.
    const billing = foldBillingWrite(trace, {
      charge,
      tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
    });

    // Update trace record
    await adminClient
      .from('trace_history')
      .update({
        status: isSuccessful ? 'success' : 'no_match',
        trace_result: result,
        phone_count: result?.phones?.length || 0,
        email_count: result?.emails?.length || 0,
        is_successful: isSuccessful,
        cost: PRICING.COST_PER_RECORD,
        charge: billing.charge,
        // Stamp the billing model alongside the amount. `charge` alone is
        // ambiguous: PRICING.CHARGE_PER_SUCCESS_WALLET and
        // PRICING.TIER2_PER_RECORD_SUBMITTED_PRO are both 0.25.
        tier: billing.tier,
      })
      .eq('id', trace.id);

    if (attemptedCharge > 0) {
      // Fire-and-forget: auto-rebill if balance dropped below threshold.
      // Still fires when the deduct failed -- that is exactly the wallet that
      // needs topping up.
      triggerAutoRebillIfNeeded(profile.id).catch(() => {});
    }

    // Fire-and-forget: webhook dispatch.
    //
    // NO CRM PUSH HERE, AND THAT IS THE DESIGN. PTP never calls HighLevel
    // unless a person asked it to. See app/api/integrations/highlevel/push,
    // which is the one place a push starts, and only from the Push to CRM
    // button. The credential columns are deliberately not read on this path.
    const { data: integrationProfile } = await adminClient
      .from('user_profiles')
      .select('webhook_url')
      .eq('id', profile.id)
      .single();

    if (integrationProfile) {
      // Webhook dispatch with research data included
      if (integrationProfile.webhook_url) {
        fetch(integrationProfile.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'trace.completed',
            trace_id: trace.id,
            status: isSuccessful ? 'success' : 'no_match',
            // D38: a row keyed on a parcel carries an INTERNAL key here. The customer's own
            // system gets "Parcel 0123-456, Travis County", never `APN|0123-456|TRAVIS|TX`.
            address: propertyAddressLabel(trace),
            city: trace.city,
            state: trace.state,
            zip: trace.zip,
            result,
            research: trace.ai_research || null,
            charge,
            timestamp: new Date().toISOString(),
          }),
        }).catch((err) => console.error('Webhook dispatch error:', err));
      }

    }

    return NextResponse.json({
      success: true,
      status: isSuccessful ? 'success' : 'no_match',
      trace_id: trace.id,
      result,
      research: trace.ai_research || null,
      // Whatever the row already carries, filtered to the 65 publishable keys.
      // This branch settles a tier 1 poll, so the record is normally null and
      // the tier is the 1 just stamped above; both are reported rather than
      // assumed, so a row that arrived here with a property record on it is not
      // silently dropped a second time.
      property_record: toPublicPropertyRecord(trace.property_record),
      // The tier that was WRITTEN, which is not always the one this settle
      // applied: a row already billed per record submitted keeps saying so.
      tier: billing.tier,
      charge,
      is_cached: false,
    });
  } catch (error) {
    console.error('API v1 trace status error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
