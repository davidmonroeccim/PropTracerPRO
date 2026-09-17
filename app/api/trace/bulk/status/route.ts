import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { deductOrZero } from '@/lib/wallet/deduct';
import { PRICING, STALE_PROCESSING } from '@/lib/constants';
import { chargePerTrace } from '@/lib/suite/pricing';
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

    // Already completed or failed — return stored stats.
    // total_charge SUMS THE STORED PER-ROW CHARGES. It must never be
    // records_matched x a live rate: the rate moves, the history does not, and a
    // repriced constant would restate what the user was actually billed on every
    // past job. The stored charge is the amount the settle path wrote at the time.
    if (traceJob.status === 'completed' || traceJob.status === 'failed') {
      const { data: doneRows } = await adminClient
        .from('trace_history')
        .select('charge')
        .eq('user_id', user.id)
        .eq('trace_job_id', traceJob.id);

      const doneTotal = (doneRows || []).reduce(
        (sum: number, r: { charge: number | null }) => sum + (r.charge || 0),
        0
      );

      return NextResponse.json({
        success: true,
        status: traceJob.status,
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_matched: traceJob.records_matched,
        total_charge: Number(doneTotal.toFixed(4)),
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

    // Stall detection: when Tracerfy is unhealthy (rate-limited / 503 /
    // malformed) and the bulk job is older than the threshold, finalize the
    // job as failed with a real error_message rather than feeding the caller
    // 'processing' forever.
    const jobAgeMinutes =
      (Date.now() - new Date(traceJob.created_at).getTime()) / 60000;

    if (
      statusResult.errorReason &&
      jobAgeMinutes >= STALE_PROCESSING.TRACERFY_STALL_MINUTES
    ) {
      const errorMessage = `Tracerfy upstream unhealthy: ${statusResult.errorReason} for ${jobAgeMinutes.toFixed(0)}m`;
      console.error(
        `[trace/bulk/status] stall: job=${traceJob.id} reason=${statusResult.errorReason} age=${jobAgeMinutes.toFixed(1)}m`
      );
      await adminClient
        .from('trace_jobs')
        .update({
          status: 'failed',
          error_message: errorMessage,
          completed_at: new Date().toISOString(),
        })
        .eq('id', traceJob.id);
      await adminClient
        .from('trace_history')
        .update({ status: 'error' })
        .eq('user_id', user.id)
        .eq('tracerfy_job_id', traceJob.tracerfy_job_id)
        .eq('status', 'processing');
      return NextResponse.json({
        success: false,
        status: 'failed',
        job_id: traceJob.id,
        error_message: errorMessage,
        tracerfy_state: statusResult.errorReason,
        age_minutes: Math.round(jobAgeMinutes),
      });
    }

    // Tracerfy still processing
    if (!statusResult.success || statusResult.pending === true) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
        tracerfy_state: statusResult.errorReason || 'pending',
        age_minutes: Math.round(jobAgeMinutes),
      });
    }

    // Empty results means still processing
    if (!statusResult.results || statusResult.results.length === 0) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
        tracerfy_state: 'pending',
        age_minutes: Math.round(jobAgeMinutes),
      });
    }

    // Tracerfy returned an array (not pending) — this is the complete result set.
    // Note: Tracerfy may return fewer results than submitted (duplicates, bad addresses, etc.)
    console.log(
      'Bulk status: Tracerfy returned',
      statusResult.results.length,
      'results for',
      traceJob.records_submitted,
      'submitted records — processing now'
    );

    // All results ready — process each one
    const results = statusResult.results;
    let recordsMatched = 0;
    // Money ACTUALLY collected across the job. It is reported twice -- as
    // `total_charge` in the bulk_job.completed webhook and in the response body
    // -- so it may only ever accumulate what a deduct really took.
    let totalCharge = 0;
    // Money we TRIED to take. Drives auto-rebill only: a wallet that came up
    // short is precisely the one that needs topping up.
    let attemptedTotal = 0;

    // Get user profile for billing
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('subscription_tier, is_acquisition_pro_member, webhook_url, highlevel_api_key, highlevel_location_id, gateway_products')
      .eq('id', user.id)
      .single();

    const perTraceCharge = profile
      ? chargePerTrace(profile)
      : PRICING.CHARGE_PER_SUCCESS_WALLET;

    // Collect successful results for HighLevel push
    const successfulResults: { parsed: TraceResult; rawResult: TracerfyResult }[] = [];

    for (const rawResult of results) {
      const parsed = parseTracerfyResult(rawResult);
      const isSuccessful =
        (parsed.phones?.length || 0) > 0 || (parsed.emails?.length || 0) > 0;
      const attemptedCharge = isSuccessful ? perTraceCharge : 0;

      if (isSuccessful) {
        recordsMatched++;
        attemptedTotal += attemptedCharge;
        successfulResults.push({ parsed, rawResult });
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
        // Bill for a successful match FIRST -- all tiers use wallet deduction,
        // and a short wallet returns false without moving money. `charge` is
        // what actually moved, so the row and the job total can only ever
        // report collected money.
        const charge =
          attemptedCharge > 0
            ? await deductOrZero(adminClient, {
                p_user_id: user.id,
                p_amount: attemptedCharge,
                p_trace_history_id: historyId,
                p_description: 'Bulk skip trace - successful match',
              })
            : 0;
        totalCharge += charge;

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

    // Fire-and-forget: auto-rebill if balance dropped below threshold.
    // Gated on what we ATTEMPTED, not what we collected: if every deduct failed
    // the wallet is empty, which is exactly when a rebill is needed.
    if (attemptedTotal > 0) {
      triggerAutoRebillIfNeeded(user.id).catch(() => {});
    }

    // Fire-and-forget: webhook dispatch + HighLevel push
    if (profile) {
      // Webhook dispatch — send bulk job summary
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
        }).catch((err) => console.error('Bulk webhook dispatch error:', err));
      }

      // HighLevel push — push each successful result
      if (profile.highlevel_api_key && profile.highlevel_location_id) {
        for (const { parsed, rawResult } of successfulResults) {
          pushTraceToHighLevel({
            apiKey: profile.highlevel_api_key,
            locationId: profile.highlevel_location_id,
            traceResult: parsed,
            propertyAddress: rawResult.address,
            propertyCity: rawResult.city,
            propertyState: rawResult.state,
          }).catch((err) => console.error('Bulk HighLevel push error:', err));
        }
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
    console.error('Bulk status error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
