import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
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

    // Already completed - return the result
    if (trace.status === 'success' || trace.status === 'no_match' || trace.status === 'error') {
      return NextResponse.json({
        success: true,
        status: trace.status,
        trace_id: trace.id,
        result: trace.trace_result as TraceResult | null,
        research: trace.ai_research || null,
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
      '| results:', statusResult.results?.length || 0);

    // Tracerfy still processing
    if (!statusResult.success || statusResult.pending === true) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        trace_id: trace.id,
      });
    }

    // Results ready - parse them
    let result: TraceResult | null = null;

    // Empty results array means Tracerfy hasn't finished processing
    if (!statusResult.results || statusResult.results.length === 0) {
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

      // If we only got padding rows back, the real record is still processing
      if (nonPaddingResults.length === 0) {
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

      if (targetResult) {
        result = parseTracerfyResult(targetResult);
      }
    }

    // Determine success
    const isSuccessful = result !== null &&
      ((result.phones?.length || 0) > 0 || (result.emails?.length || 0) > 0);

    const chargePerTrace = getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member);
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

    // Charge user if successful
    if (isSuccessful && charge > 0) {
      await adminClient.rpc('deduct_wallet_balance', {
        p_user_id: profile.id,
        p_amount: charge,
        p_trace_history_id: trace.id,
        p_description: 'Skip trace - successful match',
      });
    }

    // Fire-and-forget: webhook dispatch + HighLevel push
    const { data: integrationProfile } = await adminClient
      .from('user_profiles')
      .select('webhook_url, highlevel_api_key, highlevel_location_id')
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
      research: trace.ai_research || null,
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
