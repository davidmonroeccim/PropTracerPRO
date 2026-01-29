import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { PRICING, getChargePerTrace } from '@/lib/constants';
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

    // Already completed - return the result
    if (trace.status === 'success' || trace.status === 'no_match' || trace.status === 'error') {
      return NextResponse.json({
        success: true,
        status: trace.status,
        trace_id: trace.id,
        result: trace.trace_result as TraceResult | null,
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
      '| results:', statusResult.results?.length || 0);

    // Tracerfy still processing
    if (!statusResult.success || statusResult.pending === true) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        trace_id: trace.id,
        _debug: {
          tracerfy_job_id: trace.tracerfy_job_id,
          tracerfy_success: statusResult.success,
          tracerfy_pending: statusResult.pending,
          tracerfy_raw: statusResult.rawData,
        },
      });
    }

    // Results ready - parse them
    let result: TraceResult | null = null;

    // Empty results array means Tracerfy hasn't finished processing
    if (!statusResult.results || statusResult.results.length === 0) {
      console.log('Empty results array - still processing');
      return NextResponse.json({
        success: true,
        status: 'processing',
        trace_id: trace.id,
      });
    }

    if (statusResult.results.length > 0) {
      // Filter out padding rows
      const nonPaddingResults = statusResult.results.filter(
        (r) => r.address !== '0 Padding Row'
      );

      console.log('Results:', statusResult.results.length, 'total,',
        nonPaddingResults.length, 'non-padding');

      // If we only got padding rows back, the real record is still processing
      if (nonPaddingResults.length === 0) {
        console.log('Only padding rows returned - still processing');
        return NextResponse.json({
          success: true,
          status: 'processing',
          trace_id: trace.id,
        });
      }

      // Find the best result - prefer ones with contact data
      const targetResult = nonPaddingResults.find(
        (r) => r.primary_phone || r.mobile_1 || r.email_1
      ) || nonPaddingResults[0];

      console.log('Target result:', targetResult?.address,
        '| phone:', targetResult?.primary_phone,
        '| email:', targetResult?.email_1);

      if (targetResult) {
        result = parseTracerfyResult(targetResult);
      }
    }

    // Determine success
    const isSuccessful = result !== null &&
      ((result.phones?.length || 0) > 0 || (result.emails?.length || 0) > 0);

    console.log('Parse result:', '| phones:', result?.phones?.length || 0,
      '| emails:', result?.emails?.length || 0, '| successful:', isSuccessful);

    // Fetch profile for tier-aware pricing
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('subscription_tier, wallet_balance, wallet_low_balance_threshold, wallet_auto_rebill_enabled, is_acquisition_pro_member')
      .eq('id', user.id)
      .single();

    const chargePerTrace = profile
      ? getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member)
      : PRICING.CHARGE_PER_SUCCESS_WALLET;
    const charge = isSuccessful ? chargePerTrace : 0;

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
        charge: charge,
      })
      .eq('id', trace.id);

    // Charge user if successful — all tiers use wallet deduction
    if (isSuccessful && charge > 0) {
      await adminClient.rpc('deduct_wallet_balance', {
        p_user_id: user.id,
        p_amount: charge,
        p_trace_history_id: trace.id,
        p_description: 'Skip trace - successful match',
      });
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
            charge,
            timestamp: new Date().toISOString(),
          }),
        }).catch((err) => console.error('Webhook dispatch error:', err));
      }

      // HighLevel push — only for successful traces with results
      if (integrationProfile.highlevel_api_key && integrationProfile.highlevel_location_id && isSuccessful && result) {
        pushTraceToHighLevel({
          apiKey: integrationProfile.highlevel_api_key,
          locationId: integrationProfile.highlevel_location_id,
          traceResult: result,
          propertyAddress: trace.normalized_address,
          propertyCity: trace.city || undefined,
          propertyState: trace.state || undefined,
          propertyZip: trace.zip || undefined,
        }).catch((err) => console.error('HighLevel push error:', err));
      }
    }

    return NextResponse.json({
      success: true,
      status: isSuccessful ? 'success' : 'no_match',
      trace_id: trace.id,
      result,
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
