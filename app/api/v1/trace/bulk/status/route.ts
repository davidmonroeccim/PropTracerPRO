import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { PRICING, getChargePerTrace } from '@/lib/constants';
import type { TraceJob, TraceResult, TracerfyResult } from '@/types';

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

    // Authenticate via API key
    const authResult = await validateApiKey(request);
    if (isAuthError(authResult)) {
      return authResult.response;
    }
    const { profile } = authResult;

    const adminClient = createAdminClient();

    // Look up the trace job
    const { data: job } = await adminClient
      .from('trace_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', profile.id)
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
      const chargePerTrace = getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member);

      return NextResponse.json({
        success: true,
        status: traceJob.status,
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_matched: traceJob.records_matched,
        total_charge: traceJob.records_matched * chargePerTrace,
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

    // Tracerfy returned results — process each one
    const results = statusResult.results;
    let recordsMatched = 0;
    let totalCharge = 0;

    const chargePerTrace = getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member);

    // Collect successful results for webhook/HighLevel push
    const successfulResults: { parsed: TraceResult; rawResult: TracerfyResult }[] = [];

    for (const rawResult of results) {
      const parsed = parseTracerfyResult(rawResult);
      const isSuccessful =
        (parsed.phones?.length || 0) > 0 || (parsed.emails?.length || 0) > 0;
      const charge = isSuccessful ? chargePerTrace : 0;

      if (isSuccessful) {
        recordsMatched++;
        totalCharge += charge;
        successfulResults.push({ parsed, rawResult });
      }

      // Find the matching trace_history row
      const inputCity = (rawResult.city || '').toUpperCase().trim();
      const inputState = (rawResult.state || '').toUpperCase().trim();

      const { data: historyRows } = await adminClient
        .from('trace_history')
        .select('id')
        .eq('user_id', profile.id)
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

        if (isSuccessful && charge > 0) {
          await adminClient.rpc('deduct_wallet_balance', {
            p_user_id: profile.id,
            p_amount: charge,
            p_trace_history_id: historyId,
            p_description: 'Bulk skip trace - successful match',
          });
        }
      }
    }

    // Mark any remaining processing rows as no_match
    await adminClient
      .from('trace_history')
      .update({
        status: 'no_match',
        is_successful: false,
        cost: PRICING.COST_PER_RECORD,
        charge: 0,
      })
      .eq('user_id', profile.id)
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

    // Fire-and-forget: auto-rebill if balance dropped below threshold
    if (totalCharge > 0) {
      triggerAutoRebillIfNeeded(profile.id).catch(() => {});
    }

    // Fire-and-forget: webhook dispatch + HighLevel push
    if (profile.webhook_url) {
      fetch(profile.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'bulk_job.completed',
          job_id: traceJob.id,
          records_submitted: traceJob.records_submitted,
          records_matched: recordsMatched,
          total_charge: totalCharge,
          results: successfulResults.map(({ parsed, rawResult }) => ({
            address: rawResult.address,
            city: rawResult.city,
            state: rawResult.state,
            result: parsed,
          })),
          timestamp: new Date().toISOString(),
        }),
      }).catch((err) => console.error('API v1 bulk webhook dispatch error:', err));
    }

    if (profile.highlevel_api_key && profile.highlevel_location_id) {
      for (const { parsed, rawResult } of successfulResults) {
        pushTraceToHighLevel({
          apiKey: profile.highlevel_api_key,
          locationId: profile.highlevel_location_id,
          traceResult: parsed,
          propertyAddress: rawResult.address,
          propertyCity: rawResult.city,
          propertyState: rawResult.state,
        }).catch((err) => console.error('API v1 bulk HighLevel push error:', err));
      }
    }

    return NextResponse.json({
      success: true,
      status: 'completed',
      job_id: traceJob.id,
      records_submitted: traceJob.records_submitted,
      records_matched: recordsMatched,
      total_charge: totalCharge,
    });
  } catch (error) {
    console.error('API v1 bulk status error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
