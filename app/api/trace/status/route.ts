import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { recordHighLevelPushes } from '@/lib/highlevel/credentialHealth';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { deductWallet } from '@/lib/wallet/deduct';
import { foldBillingWrite, TRACE_TIER } from '@/lib/trace/billedRows';
import { toPublicPropertyRecord } from '@/lib/trace/publicPropertyRecord';
import { PRICING, STALE_PROCESSING } from '@/lib/constants';
import { chargePerTrace } from '@/lib/suite/pricing';
import type { TraceResult } from '@/types';

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

    // Check authentication
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const adminClient = createAdminClient();

    // Look up the trace record
    const { data: trace } = await adminClient
      .from('trace_history')
      .select('*')
      .eq('id', traceId)
      .eq('user_id', user.id)
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
    // bills per record submitted, so a Pay-As-You-Go customer who closed the tab
    // has already paid for the county record; without these two keys there was
    // no way left to get it back, and the trace page reads both off this
    // response and was always handed null. Nothing here calls a vendor.
    //
    // The row holds all 86 keys and this response carries 65. Re-reading a
    // stored record is an egress: the 21 blocked fields are withheld here
    // exactly as they are on the submit that bought it, or a customer could
    // collect the wrong `estimated_value` on the second request instead of the
    // first. See lib/trace/publicPropertyRecord.ts.
    if (trace.status === 'success' || trace.status === 'no_match' || trace.status === 'error') {
      return NextResponse.json({
        success: true,
        status: trace.status,
        trace_id: trace.id,
        result: trace.trace_result as TraceResult | null,
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

    console.log('Trace status check:', trace.id, '| job:', trace.tracerfy_job_id,
      '| success:', statusResult.success, '| pending:', statusResult.pending,
      '| results:', statusResult.results?.length || 0,
      '| errorReason:', statusResult.errorReason || 'none');

    // Stall detection: if Tracerfy has been unhealthy past the threshold,
    // promote to status='error' so the UI stops spinning. Gated on
    // errorReason -- a genuine `pending: true` from Tracerfy keeps polling.
    const ageMinutes =
      (Date.now() - new Date(trace.created_at).getTime()) / 60000;

    if (
      statusResult.errorReason &&
      ageMinutes >= STALE_PROCESSING.TRACERFY_STALL_MINUTES
    ) {
      console.error(
        `[trace/status] stall: trace=${trace.id} reason=${statusResult.errorReason} age=${ageMinutes.toFixed(1)}m`
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
        tracerfy_state: statusResult.errorReason || 'pending',
        age_minutes: Math.round(ageMinutes),
        _debug: {
          tracerfy_job_id: trace.tracerfy_job_id,
          tracerfy_success: statusResult.success,
          tracerfy_pending: statusResult.pending,
          tracerfy_error_reason: statusResult.errorReason,
          tracerfy_raw: statusResult.rawData,
        },
      });
    }

    // Results ready - parse them
    let result: TraceResult | null = null;

    if (statusResult.results && statusResult.results.length > 0) {
      // Filter out padding rows
      const nonPaddingResults = statusResult.results.filter(
        (r) => r.address !== '0 Padding Row'
      );

      console.log('Results:', statusResult.results.length, 'total,',
        nonPaddingResults.length, 'non-padding');

      // Find the best result - prefer ones with contact data
      const targetResult = nonPaddingResults.find(
        (r) => r.primary_phone || r.mobile_1 || r.email_1
      ) || nonPaddingResults[0];

      if (targetResult) {
        console.log('Target result:', targetResult?.address,
          '| phone:', targetResult?.primary_phone,
          '| email:', targetResult?.email_1);
        result = parseTracerfyResult(targetResult);
      }
    } else {
      console.log('Empty results array from Tracerfy - finalizing as no_match');
    }

    // Determine success
    const isSuccessful = result !== null &&
      ((result.phones?.length || 0) > 0 || (result.emails?.length || 0) > 0);

    console.log('Parse result:', '| phones:', result?.phones?.length || 0,
      '| emails:', result?.emails?.length || 0, '| successful:', isSuccessful);

    // Fetch profile for tier-aware pricing
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('subscription_tier, wallet_balance, wallet_low_balance_threshold, wallet_auto_rebill_enabled, is_acquisition_pro_member, gateway_products')
      .eq('id', user.id)
      .single();

    const perTraceCharge = profile
      ? chargePerTrace(profile)
      : PRICING.CHARGE_PER_SUCCESS_WALLET;
    // Charge the wallet FIRST so `charge` is the amount that actually moved: a
    // short wallet returns false without deducting. This matters more here than
    // anywhere else, because `charge` leaves this route through THREE doors --
    // the trace_history row below, the trace.completed webhook payload, and the
    // JSON response body. Reporting the INTENDED amount tells the customer and
    // their webhook consumer they paid money that was never collected.
    const attemptedCharge = isSuccessful ? perTraceCharge : 0;
    const deduction =
      attemptedCharge > 0
        ? await deductWallet(adminClient, {
            p_user_id: user.id,
            p_amount: attemptedCharge,
            p_trace_history_id: trace.id,
            p_description: 'Skip trace - successful match',
          })
        : ({ collected: 0, outcome: 'charged' } as const);
    const charge = deduction.collected;

    if (deduction.outcome === 'error') {
      // OUR failure, not the customer's balance. They keep the contacts and are
      // not billed. Logged so the uncollected charge is findable rather than
      // silent; nothing here may tell them their wallet was short, because it
      // may well not have been.
      console.error(
        '[trace/status] wallet deduct failed, result delivered uncharged:',
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
      triggerAutoRebillIfNeeded(user.id).catch(() => {});
    }

    // Fire-and-forget: webhook dispatch + HighLevel push
    const { data: integrationProfile } = await adminClient
      .from('user_profiles')
      .select('webhook_url, highlevel_api_key, highlevel_location_id')
      .eq('id', user.id)
      .single();

    if (integrationProfile) {
      // Webhook dispatch — send for all completed traces
      if (integrationProfile.webhook_url) {
        fetch(integrationProfile.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'trace.completed',
            trace_id: trace.id,
            status: isSuccessful ? 'success' : 'no_match',
            address: trace.normalized_address,
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

      // HighLevel push — only for successful traces with results.
      //
      // THE OUTCOME IS RECORDED, NOT DISCARDED. Nobody is watching this push,
      // so a dead credential used to reach a console.error and stop. The
      // recorder is the channel: a credential-class refusal flags the key on
      // the profile and the integrations page shows it. It never throws, so
      // this route still returns the customer's trace result either way.
      if (integrationProfile.highlevel_api_key && integrationProfile.highlevel_location_id && isSuccessful && result) {
        recordHighLevelPushes(user.id, [
          pushTraceToHighLevel({
            apiKey: integrationProfile.highlevel_api_key,
            locationId: integrationProfile.highlevel_location_id,
            traceResult: result,
            propertyAddress: trace.normalized_address,
            propertyCity: trace.city || undefined,
            propertyState: trace.state || undefined,
            propertyZip: trace.zip || undefined,
          }),
        ]);
      }
    }

    return NextResponse.json({
      success: true,
      status: isSuccessful ? 'success' : 'no_match',
      trace_id: trace.id,
      result,
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
      _debug: {
        tracerfy_job_id: trace.tracerfy_job_id,
        results_count: statusResult.results?.length || 0,
        is_successful: isSuccessful,
        raw_first_result: statusResult.results?.[0] ? {
          address: statusResult.results[0].address,
          primary_phone: statusResult.results[0].primary_phone,
          email_1: statusResult.results[0].email_1,
        } : null,
      },
    });
  } catch (error) {
    console.error('Trace status error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
