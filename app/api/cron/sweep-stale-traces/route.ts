import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { PRICING, STALE_PROCESSING, getChargePerTrace } from '@/lib/constants';
import type { TraceResult, TracerfyResult } from '@/types';

/**
 * Vercel Cron job: sweeps trace_history and trace_jobs records stuck in 'processing'.
 * Runs every 5 minutes. Checks Tracerfy for results and finalizes or times out records.
 */
export async function GET(request: Request) {
  // Verify cron secret (Vercel sends this header for cron jobs)
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  const cutoff = new Date();
  cutoff.setMinutes(cutoff.getMinutes() - STALE_PROCESSING.CRON_TIMEOUT_MINUTES);

  let singleSwept = 0;
  let singleResolved = 0;
  let singleTimedOut = 0;
  let bulkSwept = 0;

  try {
    // ── 1. Sweep stale single traces ──
    const { data: staleTraces } = await adminClient
      .from('trace_history')
      .select('id, user_id, tracerfy_job_id, normalized_address, city, state, zip')
      .eq('status', 'processing')
      .lt('created_at', cutoff.toISOString())
      .limit(50);

    if (staleTraces && staleTraces.length > 0) {
      for (const trace of staleTraces) {
        singleSwept++;

        // No tracerfy job ID means submission failed silently — mark as error
        if (!trace.tracerfy_job_id) {
          await adminClient
            .from('trace_history')
            .update({ status: 'error' })
            .eq('id', trace.id);
          singleTimedOut++;
          continue;
        }

        // Check Tracerfy for results
        const statusResult = await getJobStatus(trace.tracerfy_job_id);

        // Still pending or error from Tracerfy — mark as error (it's been over an hour)
        if (
          !statusResult.success ||
          statusResult.pending === true ||
          !statusResult.results ||
          statusResult.results.length === 0
        ) {
          await adminClient
            .from('trace_history')
            .update({ status: 'error' })
            .eq('id', trace.id);
          singleTimedOut++;
          continue;
        }

        // Results ready — parse and finalize (same logic as trace/status/route.ts)
        const nonPaddingResults = statusResult.results.filter(
          (r) => r.address !== '0 Padding Row'
        );

        if (nonPaddingResults.length === 0) {
          await adminClient
            .from('trace_history')
            .update({ status: 'error' })
            .eq('id', trace.id);
          singleTimedOut++;
          continue;
        }

        const targetResult =
          nonPaddingResults.find(
            (r) => r.primary_phone || r.mobile_1 || r.email_1
          ) || nonPaddingResults[0];

        const result: TraceResult = parseTracerfyResult(targetResult);
        const isSuccessful =
          (result.phones?.length || 0) > 0 || (result.emails?.length || 0) > 0;

        // Get user profile for tier-aware pricing
        const { data: profile } = await adminClient
          .from('user_profiles')
          .select('subscription_tier, is_acquisition_pro_member, webhook_url, highlevel_api_key, highlevel_location_id')
          .eq('id', trace.user_id)
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
            phone_count: result.phones?.length || 0,
            email_count: result.emails?.length || 0,
            is_successful: isSuccessful,
            cost: PRICING.COST_PER_RECORD,
            charge,
          })
          .eq('id', trace.id);

        // Charge wallet if successful
        if (isSuccessful && charge > 0) {
          await adminClient.rpc('deduct_wallet_balance', {
            p_user_id: trace.user_id,
            p_amount: charge,
            p_trace_history_id: trace.id,
            p_description: 'Skip trace - successful match (cron recovery)',
          });

          // Fire-and-forget: auto-rebill if balance dropped below threshold
          triggerAutoRebillIfNeeded(trace.user_id).catch(() => {});
        }

        // Fire-and-forget: webhook + HighLevel
        if (profile) {
          if (profile.webhook_url) {
            fetch(profile.webhook_url, {
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
            }).catch((err) => console.error('Cron webhook error:', err));
          }

          if (profile.highlevel_api_key && profile.highlevel_location_id && isSuccessful) {
            pushTraceToHighLevel({
              apiKey: profile.highlevel_api_key,
              locationId: profile.highlevel_location_id,
              traceResult: result,
              propertyAddress: trace.normalized_address,
              propertyCity: trace.city || undefined,
              propertyState: trace.state || undefined,
              propertyZip: trace.zip || undefined,
            }).catch((err) => console.error('Cron HighLevel error:', err));
          }
        }

        singleResolved++;
      }
    }

    // ── 2. Sweep stale bulk trace jobs ──
    const { data: staleJobs } = await adminClient
      .from('trace_jobs')
      .select('id, user_id, tracerfy_job_id, records_submitted')
      .eq('status', 'processing')
      .lt('created_at', cutoff.toISOString())
      .limit(10);

    if (staleJobs && staleJobs.length > 0) {
      for (const job of staleJobs) {
        bulkSwept++;

        if (!job.tracerfy_job_id) {
          // No job ID — mark as failed
          await adminClient
            .from('trace_jobs')
            .update({ status: 'failed', error_message: 'No Tracerfy job ID', completed_at: new Date().toISOString() })
            .eq('id', job.id);

          // Mark all associated trace_history rows as error
          await adminClient
            .from('trace_history')
            .update({ status: 'error' })
            .eq('user_id', job.user_id)
            .eq('tracerfy_job_id', job.tracerfy_job_id)
            .eq('status', 'processing');
          continue;
        }

        const statusResult = await getJobStatus(job.tracerfy_job_id);

        // Still pending or error — mark as failed after timeout
        if (
          !statusResult.success ||
          statusResult.pending === true ||
          !statusResult.results ||
          statusResult.results.length === 0
        ) {
          await adminClient
            .from('trace_jobs')
            .update({ status: 'failed', error_message: 'Timed out waiting for Tracerfy', completed_at: new Date().toISOString() })
            .eq('id', job.id);

          await adminClient
            .from('trace_history')
            .update({ status: 'error' })
            .eq('user_id', job.user_id)
            .eq('tracerfy_job_id', job.tracerfy_job_id)
            .eq('status', 'processing');
          continue;
        }

        // Results ready — process them (same logic as bulk/status/route.ts)
        const results = statusResult.results;
        let recordsMatched = 0;

        const { data: profile } = await adminClient
          .from('user_profiles')
          .select('subscription_tier, is_acquisition_pro_member, webhook_url, highlevel_api_key, highlevel_location_id')
          .eq('id', job.user_id)
          .single();

        const chargePerTrace = profile
          ? getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member)
          : PRICING.CHARGE_PER_SUCCESS_WALLET;

        for (const rawResult of results) {
          const parsed = parseTracerfyResult(rawResult);
          const isSuccessful =
            (parsed.phones?.length || 0) > 0 || (parsed.emails?.length || 0) > 0;
          const charge = isSuccessful ? chargePerTrace : 0;

          if (isSuccessful) recordsMatched++;

          const inputCity = (rawResult.city || '').toUpperCase().trim();
          const inputState = (rawResult.state || '').toUpperCase().trim();

          const { data: historyRows } = await adminClient
            .from('trace_history')
            .select('id')
            .eq('user_id', job.user_id)
            .eq('tracerfy_job_id', job.tracerfy_job_id)
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
                p_user_id: job.user_id,
                p_amount: charge,
                p_trace_history_id: historyId,
                p_description: 'Bulk skip trace - successful match (cron recovery)',
              });
            }
          }
        }

        // Mark remaining processing rows as no_match
        await adminClient
          .from('trace_history')
          .update({ status: 'no_match', is_successful: false, cost: PRICING.COST_PER_RECORD, charge: 0 })
          .eq('user_id', job.user_id)
          .eq('tracerfy_job_id', job.tracerfy_job_id)
          .eq('status', 'processing');

        // Mark job as completed
        await adminClient
          .from('trace_jobs')
          .update({ status: 'completed', records_matched: recordsMatched, completed_at: new Date().toISOString() })
          .eq('id', job.id);

        // Fire-and-forget: auto-rebill if balance dropped below threshold
        triggerAutoRebillIfNeeded(job.user_id).catch(() => {});

        // Webhook for bulk completion
        if (profile?.webhook_url) {
          fetch(profile.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'bulk_job.completed',
              job_id: job.id,
              records_submitted: job.records_submitted,
              records_matched: recordsMatched,
              timestamp: new Date().toISOString(),
            }),
          }).catch((err) => console.error('Cron bulk webhook error:', err));
        }
      }
    }

    console.log(`Cron sweep: ${singleSwept} single traces (${singleResolved} resolved, ${singleTimedOut} timed out), ${bulkSwept} bulk jobs`);

    return NextResponse.json({
      success: true,
      single: { swept: singleSwept, resolved: singleResolved, timedOut: singleTimedOut },
      bulk: { swept: bulkSwept },
    });
  } catch (error) {
    console.error('Cron sweep error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
