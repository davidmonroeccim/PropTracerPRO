import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { recordHighLevelPushes } from '@/lib/highlevel/credentialHealth';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { deductOrZero } from '@/lib/wallet/deduct';
import { TRACE_TIER, foldBillingWrite, excludeBilledRows } from '@/lib/trace/billedRows';
import { PRICING, STALE_PROCESSING } from '@/lib/constants';
import { chargePerTrace } from '@/lib/suite/pricing';
import { isPropertyTracePending } from '@/lib/trace/propertyTraceAttempts';
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
      // charge and tier are selected so the settle below can FOLD rather than
      // overwrite. They are receipts: this cron reaches reused rows, and a row
      // that was billed tier 2 must not be rewritten as an unbilled tier 1.
      .select('id, user_id, tracerfy_job_id, normalized_address, city, state, zip, charge, tier')
      .eq('status', 'processing')
      // SINGLE TRACES ONLY, AND THIS IS THE LINE THAT MAKES THAT TRUE. Without
      // it the heading above was a comment rather than a filter: a stale BULK
      // row matched status + created_at just as well, and this loop finalizes a
      // row against `nonPaddingResults.find(r => r.primary_phone || ...)`. For a
      // single trace that is the answer. For a bulk row the Tracerfy job is
      // SHARED across the whole batch, so it is whichever OTHER property came
      // back carrying a phone -- billing the customer a second time and writing
      // a stranger's contacts onto their parcel, which then go to their CRM.
      //
      // A bulk row is settled by its own job's status route and by
      // lib/trace/settleBulkJob. It is never this sweep's to claim.
      .is('trace_job_id', null)
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
          .select('subscription_tier, is_acquisition_pro_member, webhook_url, highlevel_api_key, highlevel_location_id, gateway_products')
          .eq('id', trace.user_id)
          .single();

        const perTraceCharge = profile
          ? chargePerTrace(profile)
          : PRICING.CHARGE_PER_SUCCESS_WALLET;
        // Charge the wallet FIRST so the row records what actually moved: a
        // short wallet returns false without deducting, and trace_history.charge
        // is summed back to the customer as money they paid.
        const attemptedCharge = isSuccessful ? perTraceCharge : 0;
        const charge =
          attemptedCharge > 0
            ? await deductOrZero(adminClient, {
                p_user_id: trace.user_id,
                p_amount: attemptedCharge,
                p_trace_history_id: trace.id,
                p_description: 'Skip trace - successful match (cron recovery)',
              })
            : 0;

        // Update trace record.
        //
        // FOLD, NEVER OVERWRITE. This cron is the twin of the status-route
        // settle and reaches the same reused rows. Writing `charge` and `tier`
        // flat would take a row already billed $0.25 at tier 2 and rewrite it as
        // charge 0, tier 1: the receipt disappears while the wallet_transactions
        // row still points at it, isCacheHitRow's tier 2 arm stops matching, and
        // the customer re-buys a record they already own.
        const billing = foldBillingWrite(trace, {
          charge,
          tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
        });

        await adminClient
          .from('trace_history')
          .update({
            status: isSuccessful ? 'success' : 'no_match',
            trace_result: result,
            phone_count: result.phones?.length || 0,
            email_count: result.emails?.length || 0,
            is_successful: isSuccessful,
            cost: PRICING.COST_PER_RECORD,
            charge: billing.charge,
            tier: billing.tier,
          })
          .eq('id', trace.id);

        if (attemptedCharge > 0) {
          // Fire-and-forget: auto-rebill if balance dropped below threshold.
          // Still fires when the deduct failed -- that is exactly the wallet
          // that needs topping up.
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

          // This is the path with the LEAST chance of anyone noticing a dead
          // credential: no user is on a page at all. The outcome is recorded
          // against the credential so the integrations page can show it. It
          // never throws, so the sweep continues either way.
          if (profile.highlevel_api_key && profile.highlevel_location_id && isSuccessful) {
            recordHighLevelPushes(trace.user_id, [
              pushTraceToHighLevel({
                apiKey: profile.highlevel_api_key,
                locationId: profile.highlevel_location_id,
                traceResult: result,
                propertyAddress: trace.normalized_address,
                propertyCity: trace.city || undefined,
                propertyState: trace.state || undefined,
                propertyZip: trace.zip || undefined,
              }),
            ]);
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

        // THE TIER 2 QUEUE OUTRANKS EVERY TERMINAL VERDICT IN THIS LOOP, SO IT
        // IS ASKED ONCE, HERE, BEFORE ANY BRANCH.
        //
        // This loop writes a terminal `trace_jobs.status` in four places: the
        // 'No Tracerfy job ID' failure, the 'Timed out waiting for Tracerfy'
        // failure, the completion at the end, and the completion just below.
        // Every one of them is a verdict on the WHOLE job, and none of them can
        // see the dossier queue: sweep-property-traces claims on
        // `property_trace_status` alone and never reads the parent job, so its
        // rows keep running and keep billing whatever this cron decides.
        //
        // A mixed job under queue contention reaches this 60-minute cutoff with
        // tier 2 rows still pending as a matter of course. Finalizing it there
        // writes a terminal status the status route's top-of-handler
        // short-circuit then makes permanent, so the customer's summary and
        // downloadable CSV are short by exactly the rows they are about to be
        // charged for, on a file they have every reason to treat as final.
        //
        // Hoisting the question above the branch is also what stops the next
        // person adding a fifth verdict below it and missing the guard.
        const { data: jobRows } = await adminClient
          .from('trace_history')
          .select('property_trace_status, is_successful')
          .eq('user_id', job.user_id)
          .eq('trace_job_id', job.id);
        const rows = (jobRows || []) as Array<{
          property_trace_status: string | null;
          is_successful: boolean | null;
        }>;
        const tier2Rows = rows.filter((r) => r.property_trace_status);

        if (tier2Rows.some((r) => isPropertyTracePending(r.property_trace_status))) {
          // Still real work in flight, whatever the Tracerfy half is doing. Not
          // stale, so leave the job entirely alone.
          //
          // This DEFERS the tier 1 settle rather than dropping it: the job stays
          // 'processing', so the next run of this cron five minutes later picks
          // it up again, and the status route settles it too if anyone polls.
          // Once the queue drains, the branches below run exactly as they always
          // did. Nothing is stranded, it just waits.
          continue;
        }

        if (!job.tracerfy_job_id) {
          // A JOB WITH NO TRACERFY JOB ID USED TO MEAN ONE THING AND NOW MEANS
          // TWO. Until phase 5c it could only be a submit that failed silently,
          // so failing it after the timeout was the honest answer. Now it is
          // also the normal shape of a job whose rows are ALL tier 2: there is
          // no person CSV, sweep-property-traces owns every row, and the job
          // legitimately outlives this cutoff whenever the queue is under
          // contention.
          if (tier2Rows.length > 0) {
            // The queue has drained and the status route was never polled to
            // notice. Finish it the way that route would: COMPLETED, not failed.
            // The rows already carry their own results and their own receipts.
            await adminClient
              .from('trace_jobs')
              .update({
                status: 'completed',
                records_matched: rows.filter((r) => r.is_successful).length,
                completed_at: new Date().toISOString(),
              })
              .eq('id', job.id);
            continue;
          }

          // No tier 2 rows at all: the original case, unchanged. The submit
          // never reached a vendor and the job has nothing behind it.
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
          .select('subscription_tier, is_acquisition_pro_member, webhook_url, highlevel_api_key, highlevel_location_id, gateway_products')
          .eq('id', job.user_id)
          .single();

        const perTraceCharge = profile
          ? chargePerTrace(profile)
          : PRICING.CHARGE_PER_SUCCESS_WALLET;

        for (const rawResult of results) {
          const parsed = parseTracerfyResult(rawResult);
          const isSuccessful =
            (parsed.phones?.length || 0) > 0 || (parsed.emails?.length || 0) > 0;

          if (isSuccessful) recordsMatched++;

          const inputCity = (rawResult.city || '').toUpperCase().trim();
          const inputState = (rawResult.state || '').toUpperCase().trim();

          const { data: historyRows } = await adminClient
            // charge and tier come back so the settle below folds instead of
            // overwriting. Same reason as the single-trace half above.
            .from('trace_history')
            .select('id, charge, tier')
            .eq('user_id', job.user_id)
            .eq('tracerfy_job_id', job.tracerfy_job_id)
            .eq('status', 'processing')
            .ilike('city', inputCity)
            .ilike('state', inputState)
            .limit(1);

          const historyRow = historyRows?.[0];
          const historyId = historyRow?.id;
          if (historyId) {
            // Deduct FIRST, then persist the amount that actually moved.
            const charge =
              isSuccessful && perTraceCharge > 0
                ? await deductOrZero(adminClient, {
                    p_user_id: job.user_id,
                    p_amount: perTraceCharge,
                    p_trace_history_id: historyId,
                    p_description: 'Bulk skip trace - successful match (cron recovery)',
                  })
                : 0;

            // Fold, never overwrite. Same receipt rule as the single-trace half.
            const billing = foldBillingWrite(historyRow, {
              charge,
              tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
            });

            await adminClient
              .from('trace_history')
              .update({
                status: isSuccessful ? 'success' : 'no_match',
                trace_result: parsed,
                phone_count: parsed.phones?.length || 0,
                email_count: parsed.emails?.length || 0,
                is_successful: isSuccessful,
                cost: PRICING.COST_PER_RECORD,
                charge: billing.charge,
                tier: billing.tier,
              })
              .eq('id', historyId);
          }
        }

        // Mark remaining processing rows as no_match.
        //
        // TWO STATEMENTS, AND THE SPLIT IS THE WHOLE POINT. **STATUS IS NOT A
        // RECEIPT.** excludeBilledRows exists to protect `charge` and `tier`.
        // `status` and `is_successful` are DELIVERY facts, and a paid row needs
        // them MORE than an unpaid one, not less.
        //
        // This blanket used to write `charge: 0, tier: 1` flat, which erased a
        // receipt wholesale while the wallet_transactions row still pointed at
        // it. Guarding it fixed that and introduced the opposite bug: a billed
        // tier 2 row failed the guard, was skipped entirely, and kept
        // `status = 'processing'` inside a job marked completed on the very next
        // statement. Nothing re-sweeps it -- stage 2 only claims jobs still
        // 'processing', and stage 1 is restricted to rows with no parent job --
        // so it is stranded and every surface reports it as still running.

        // 1. THE MONEY, guarded. A blanket update reads no row, so it cannot
        //    fold; instead the guard makes it impossible for the statement to
        //    match a row that collected anything, which is stronger. On the rows
        //    it can reach, `charge: 0` normalises NULL and the tier stamp
        //    records the billing model. Runs FIRST, while they are 'processing'.
        await excludeBilledRows(
          adminClient
            .from('trace_history')
            .update({
              charge: 0,
              tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
            })
            .eq('user_id', job.user_id)
            .eq('tracerfy_job_id', job.tracerfy_job_id)
            .eq('status', 'processing')
        );

        // 2. THE DELIVERY FACTS, for every row. Unguarded on purpose.
        await adminClient
          .from('trace_history')
          .update({
            status: 'no_match',
            is_successful: false,
            cost: PRICING.COST_PER_RECORD,
          })
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
