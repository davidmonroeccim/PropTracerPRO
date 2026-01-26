import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { PRICING } from '@/lib/constants';
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
      });
    }

    // Results ready - parse them
    let result: TraceResult | null = null;

    if (statusResult.results && statusResult.results.length > 0) {
      // Find the real result (exclude padding row), prefer results with contact data
      const targetResult = statusResult.results.find(
        (r) => r.address !== '0 Padding Row' &&
          (r.primary_phone || r.mobile_1 || r.email_1)
      ) || statusResult.results.find(
        (r) => r.address !== '0 Padding Row'
      );

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

    const charge = isSuccessful ? PRICING.CHARGE_PER_SUCCESS : 0;

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
      const { data: profile } = await adminClient
        .from('user_profiles')
        .select('subscription_tier, wallet_balance, wallet_low_balance_threshold, wallet_auto_rebill_enabled')
        .eq('id', user.id)
        .single();

      if (profile?.subscription_tier === 'wallet') {
        await adminClient.rpc('deduct_wallet_balance', {
          p_user_id: user.id,
          p_amount: charge,
          p_trace_history_id: trace.id,
          p_description: 'Skip trace - successful match',
        });
      } else {
        await adminClient.from('usage_records').insert({
          user_id: user.id,
          trace_history_id: trace.id,
          quantity: 1,
          unit_price: PRICING.CHARGE_PER_SUCCESS,
          total_amount: charge,
          billing_period_start: new Date().toISOString().substring(0, 10),
          billing_period_end: new Date().toISOString().substring(0, 10),
        });
      }
    }

    return NextResponse.json({
      success: true,
      status: isSuccessful ? 'success' : 'no_match',
      trace_id: trace.id,
      result,
      charge,
      is_cached: false,
    });
  } catch (error) {
    console.error('Trace status error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
