import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { PRICING } from '@/lib/constants';
import type { TraceJob } from '@/types';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('job_id');

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'Missing job_id' },
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

    // Look up the trace job
    const { data: job } = await adminClient
      .from('trace_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .single();

    if (!job) {
      return NextResponse.json(
        { success: false, error: 'Job not found' },
        { status: 404 }
      );
    }

    const traceJob = job as TraceJob;

    // Already completed or failed — return stored stats
    if (traceJob.status === 'completed' || traceJob.status === 'failed') {
      return NextResponse.json({
        success: true,
        status: traceJob.status,
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_matched: traceJob.records_matched,
        total_charge: traceJob.records_matched * PRICING.CHARGE_PER_SUCCESS,
        error_message: traceJob.error_message,
      });
    }

    // Still processing — check Tracerfy
    if (!traceJob.tracerfy_job_id) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
      });
    }

    const statusResult = await getJobStatus(traceJob.tracerfy_job_id);

    // Tracerfy still processing
    if (!statusResult.success || statusResult.pending === true) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
      });
    }

    // Empty results means still processing
    if (!statusResult.results || statusResult.results.length === 0) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
      });
    }

    // Results ready — process each one
    const results = statusResult.results;
    let recordsMatched = 0;
    let totalCharge = 0;

    // Get user profile for billing
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('subscription_tier')
      .eq('id', user.id)
      .single();

    for (const rawResult of results) {
      const parsed = parseTracerfyResult(rawResult);
      const isSuccessful =
        (parsed.phones?.length || 0) > 0 || (parsed.emails?.length || 0) > 0;
      const charge = isSuccessful ? PRICING.CHARGE_PER_SUCCESS : 0;

      if (isSuccessful) {
        recordsMatched++;
        totalCharge += charge;
      }

      // Find the matching trace_history row by tracerfy_job_id + address match
      // Update it with results
      const inputAddress = (rawResult.address || '').toUpperCase().trim();
      const inputCity = (rawResult.city || '').toUpperCase().trim();
      const inputState = (rawResult.state || '').toUpperCase().trim();

      const { data: historyRows } = await adminClient
        .from('trace_history')
        .select('id')
        .eq('user_id', user.id)
        .eq('tracerfy_job_id', traceJob.tracerfy_job_id)
        .eq('status', 'processing')
        .ilike('city', inputCity)
        .ilike('state', inputState)
        .limit(1);

      const historyId = historyRows?.[0]?.id;

      if (historyId) {
        await adminClient
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
          .eq('id', historyId);

        // Bill for successful match
        if (isSuccessful && charge > 0) {
          if (profile?.subscription_tier === 'wallet') {
            await adminClient.rpc('deduct_wallet_balance', {
              p_user_id: user.id,
              p_amount: charge,
              p_trace_history_id: historyId,
              p_description: 'Bulk skip trace - successful match',
            });
          } else {
            await adminClient.from('usage_records').insert({
              user_id: user.id,
              trace_history_id: historyId,
              quantity: 1,
              unit_price: PRICING.CHARGE_PER_SUCCESS,
              total_amount: charge,
              billing_period_start: new Date().toISOString().substring(0, 10),
              billing_period_end: new Date().toISOString().substring(0, 10),
            });
          }
        }
      }
    }

    // Mark any remaining processing rows as no_match (no result returned by Tracerfy)
    await adminClient
      .from('trace_history')
      .update({
        status: 'no_match',
        is_successful: false,
        cost: PRICING.COST_PER_RECORD,
        charge: 0,
      })
      .eq('user_id', user.id)
      .eq('tracerfy_job_id', traceJob.tracerfy_job_id)
      .eq('status', 'processing');

    // Update job as completed
    await adminClient
      .from('trace_jobs')
      .update({
        status: 'completed',
        records_matched: recordsMatched,
        completed_at: new Date().toISOString(),
      })
      .eq('id', traceJob.id);

    return NextResponse.json({
      success: true,
      status: 'completed',
      job_id: traceJob.id,
      records_submitted: traceJob.records_submitted,
      records_matched: recordsMatched,
      total_charge: totalCharge,
    });
  } catch (error) {
    console.error('Bulk status error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
