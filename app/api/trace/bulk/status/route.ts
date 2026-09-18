import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { deductOrZero } from '@/lib/wallet/deduct';
import { PRICING, STALE_PROCESSING } from '@/lib/constants';
import { chargePerTrace } from '@/lib/suite/pricing';
import { TRACE_TIER, foldBillingWrite, excludeBilledRows } from '@/lib/trace/billedRows';
import { rowSkipReason, type SkipReasonRow } from '@/lib/trace/rowSkipReason';
import { isPropertyTracePending } from '@/lib/trace/propertyTraceAttempts';
import type { TraceJob, TraceResult, TracerfyResult } from '@/types';

/**
 * A trace_history row, read down to the columns this summary needs.
 *
 * BOTH QUEUE COLUMNS, not just the tier 1 one. A row's reason can live in
 * either, and every select feeding this has to name both or the reason is lost
 * on the way to the screen rather than in the function.
 */
type SkipRow = SkipReasonRow;

/**
 * A row of this job, read down to what the completion gate and the job summary
 * need. Structurally a SkipRow, so summarizeSkips takes it unchanged.
 *
 * `property_trace_status` is the TIER 2 queue. It is the only column that says
 * whether a row still owes work: a queued row's `status` is 'processing' at
 * submit but the cron writes a delivery status the moment the dossier answers,
 * and the row is not finished then.
 */
type JobRow = SkipRow & {
  charge: number | null;
  is_successful: boolean | null;
  property_trace_status?: string | null;
};

/**
 * How many rows of this job came back with no contacts for a reason worth
 * saying, and what that reason is.
 *
 * David's rule: never hand a customer a bare `no_match` on a row nobody looked
 * up. `bulk/download` does the CSV half. This is the job summary half, and
 * without it the dashboard shows those rows as a bare `no_match`, which reads
 * to a customer as "we looked and found nobody".
 *
 * THE REASON NOW COMES FROM rowSkipReason(), WHICH ASKS BOTH QUEUES. It used to
 * ask only skipReasonFor(), the tier 1 accessor, so every tier 2 terminal value
 * counted as nothing and explained nothing. The same accessor serves the v1
 * status route, the MCP tool and the CSV, so the wording cannot drift between
 * the four.
 *
 * `records_skipped` IS NO LONGER AN ALL-FREE COUNT, and that is why nothing
 * around it may promise the rows were free. Four of the five reasons are free
 * rows. The fifth is PROPERTY_TRACE_NO_REACH: the property record was bought,
 * the row was billed per record submitted, and only the contact half failed.
 * Each reason sentence carries its own charge statement for exactly this reason,
 * so the summary states a count and lets the sentences speak about money.
 *
 * Only rows with a reason are counted. A row a vendor was actually asked about
 * returns null and is never in this number, however empty it came back.
 */
function summarizeSkips(rows: SkipRow[]): {
  records_skipped: number;
  skip_reason: string | null;
} {
  // Five different things land here and they are not the same thing to read: a
  // blank owner, an entity trace that ran out of attempts, a dossier vendor we
  // could not reach, a row with no usable address, and a billed row whose
  // contact vendor never answered. A job carrying several says all of them.
  const byReason = new Map<string, number>();
  let count = 0;
  for (const row of rows) {
    const reason = rowSkipReason(row);
    if (!reason) continue;
    count++;
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }

  const groups = [...byReason.entries()];
  if (groups.length === 0) return { records_skipped: count, skip_reason: null };

  // ONE REASON NEEDS NO COUNT: it accounts for every row in `records_skipped`,
  // and repeating that number beside a heading already carrying it reads as a
  // second, different figure.
  if (groups.length === 1) return { records_skipped: count, skip_reason: groups[0][0] };

  // SEVERAL REASONS DO, AND THIS IS THE TWO-MODEL PROBLEM ARRIVING AT THE
  // AGGREGATE. The sentences were joined with a space and nothing else, so a
  // mixed job rendered "...you were not charged." immediately followed by "You
  // were charged for it, because..." over one undifferentiated total. Both
  // sentences are true of their own rows and the customer had no way to tell how
  // many rows each one covered, which on a job holding 13 free rows and 1 billed
  // one is the difference they most need. The heading gave up its money claim
  // deliberately; this is what stops that leaving a gap.
  return {
    records_skipped: count,
    skip_reason: groups
      .map(([reason, n]) => `${reason} That happened to ${n} of them.`)
      .join(' '),
  };
}

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
      // BOTH QUEUE COLUMNS. This branch is the one every poll after the first
      // hits and the one a page reload lands on, so a column missing from this
      // select is a reason the customer never sees no matter how right
      // summarizeSkips is. `property_trace_status` was absent, which silently
      // blanked the explanation on every finished tier 2 row.
      const { data: doneRows } = await adminClient
        .from('trace_history')
        .select('charge, ai_research_status, property_trace_status')
        .eq('user_id', user.id)
        .eq('trace_job_id', traceJob.id);

      const rows = (doneRows || []) as Array<{ charge: number | null } & SkipRow>;

      const doneTotal = rows.reduce((sum, r) => sum + (r.charge || 0), 0);

      return NextResponse.json({
        success: true,
        status: traceJob.status,
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_matched: traceJob.records_matched,
        total_charge: Number(doneTotal.toFixed(4)),
        // This is the branch every poll after the first one hits, and the one a
        // user who reloads the page lands on, so it has to carry the skip
        // summary too.
        ...summarizeSkips(rows),
        error_message: traceJob.error_message,
      });
    }

    /**
     * Every row of this job, read once, for the completion gate below.
     *
     * It is the SAME query the skip summary used to run on its own at the end of
     * the handler, widened rather than duplicated: one read that answers whether
     * the job is finished, what it collected and how many rows matched.
     */
    const readJobRows = async (): Promise<JobRow[]> => {
      const { data } = await adminClient
        .from('trace_history')
        .select('charge, is_successful, ai_research_status, property_trace_status')
        .eq('user_id', user.id)
        .eq('trace_job_id', traceJob.id);
      return (data || []) as JobRow[];
    };

    /**
     * Write the job terminal and report it.
     *
     * total_charge SUMS THE STORED PER-ROW CHARGES rather than what this poll
     * happened to collect, which is the only number that can include the tier 2
     * charges sweep-property-traces booked. It is also what the already-completed
     * branch at the top of this handler reports, so both branches now answer the
     * same question with the same arithmetic.
     */
    const finalize = async (rows: JobRow[], tier1Matched: number) => {
      const recordsMatched =
        tier1Matched + rows.filter((r) => r.property_trace_status && r.is_successful).length;
      await adminClient
        .from('trace_jobs')
        .update({
          status: 'completed',
          records_matched: recordsMatched,
          completed_at: new Date().toISOString(),
        })
        .eq('id', traceJob.id);
      return {
        recordsMatched,
        totalCharge: Number(
          rows.reduce((sum, r) => sum + (r.charge || 0), 0).toFixed(4)
        ),
      };
    };

    // A JOB WITH NO TRACERFY JOB ID IS NOT NECESSARILY AN EMPTY ONE ANY MORE.
    // Until phase 5c it meant the submit had nothing to send, and the submit
    // route closed such a job itself. Now it also means EVERY row of the job is
    // tier 2: there is no person CSV to poll, the cron owns all of it, and this
    // is the only place that can notice when it is done. Returning a bare
    // 'processing' here, as this branch used to, would park that job at
    // processing forever.
    if (!traceJob.tracerfy_job_id) {
      const rows = await readJobRows();
      if (rows.some((r) => isPropertyTracePending(r.property_trace_status))) {
        return NextResponse.json({
          success: true,
          status: 'processing',
          job_id: traceJob.id,
          records_pending_property_trace: rows.filter((r) =>
            isPropertyTracePending(r.property_trace_status)
          ).length,
        });
      }
      const { recordsMatched, totalCharge } = await finalize(rows, 0);
      return NextResponse.json({
        success: true,
        status: 'completed',
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_matched: recordsMatched,
        total_charge: totalCharge,
        ...summarizeSkips(rows),
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
      // The TIER 1 rows really are stuck, so they are errored either way. The
      // filter is on tracerfy_job_id, which a tier 2 row does not carry, so this
      // cannot reach the queue.
      await adminClient
        .from('trace_history')
        .update({ status: 'error' })
        .eq('user_id', user.id)
        .eq('tracerfy_job_id', traceJob.tracerfy_job_id)
        .eq('status', 'processing');

      // BUT THE JOB IS NOT THE TIER 1 HALF. A stalled Tracerfy bulk says nothing
      // about the dossier queue, which is a different vendor endpoint on a
      // different clock, and those rows keep running and keep billing. Declaring
      // the job failed over them hands the customer a terminal verdict on work
      // that is still being charged for, and the top of this handler then
      // short-circuits the job so it is never polled again.
      const stallRows = await readJobRows();
      const stillQueued = stallRows.filter((r) =>
        isPropertyTracePending(r.property_trace_status)
      ).length;

      if (stillQueued === 0) {
        await adminClient
          .from('trace_jobs')
          .update({
            status: 'failed',
            error_message: errorMessage,
            completed_at: new Date().toISOString(),
          })
          .eq('id', traceJob.id);
        return NextResponse.json({
          success: false,
          status: 'failed',
          job_id: traceJob.id,
          error_message: errorMessage,
          tracerfy_state: statusResult.errorReason,
          age_minutes: Math.round(jobAgeMinutes),
        });
      }

      // The tier 1 half is dead and the tier 2 half is alive. The job stays open
      // and the caller is told both facts rather than one of them.
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
        records_pending_property_trace: stillQueued,
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
    // Money THIS POLL collected, and only that. It is no longer what gets
    // reported: finalize() below replaces it with the sum of the stored per-row
    // charges before either the response body or the bulk_job.completed webhook
    // reads it.
    //
    // WHY IT HAD TO STOP BEING THE REPORTED NUMBER. A poll-local accumulator
    // structurally cannot see a charge sweep-property-traces booked, because
    // that money never passes through this handler. An all-tier-2 job would have
    // completed reporting 0 against a wallet the customer had watched drop, and
    // a mixed job would have reported its tier 1 half only. The
    // already-completed branch at the top of this handler was ALREADY summing
    // stored charges, so the same handler answered one question two ways
    // depending on which poll you hit.
    //
    // CONSUMER-VISIBLE CHANGE, 2026-09-18: `total_charge` on the
    // bulk_job.completed webhook now means the job's stored charges rather than
    // one poll's collections. For a tier 1 only job those are the same number.
    // They differ on a job carrying tier 2 rows, and on a REUSED address whose
    // row already held a receipt from an earlier job, which the sum attributes
    // to this one. Both match what the already-completed branch has always
    // reported, which is why this is the consistent answer rather than a second
    // one.
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

      // `charge` and `tier` are selected because they are the RECEIPT this
      // settle has to fold into, not overwrite. The row is reused rather than
      // re-inserted (UNIQUE(user_id, address_hash)), so it may already carry a
      // tier 2 charge booked against a wallet_transactions row that still
      // references it.
      const { data: historyRows } = await adminClient
        .from('trace_history')
        .select('id, charge, tier')
        .eq('user_id', user.id)
        .eq('tracerfy_job_id', traceJob.tracerfy_job_id)
        .eq('status', 'processing')
        .ilike('city', inputCity)
        .ilike('state', inputState)
        .limit(1);

      const historyRow = historyRows?.[0];
      const historyId = historyRow?.id;

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

        // ACCUMULATE, never replace. `totalCharge` above is what THIS poll
        // collected and is reported as such; the row's `charge` column is the
        // receipt for the address across every settle that ever touched it. On
        // a miss `charge` is 0, and folding 0 leaves an existing receipt exactly
        // where it is rather than declaring a paid row free.
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

    // Mark any remaining processing rows as no_match (no result returned by Tracerfy)
    //
    // TWO STATEMENTS, AND THE SPLIT IS THE WHOLE POINT. **STATUS IS NOT A
    // RECEIPT.** excludeBilledRows exists to protect `charge` and `tier`.
    // `status` and `is_successful` are DELIVERY facts, and a paid row needs them
    // MORE than an unpaid one, not less.
    //
    // Putting them behind the same guard strands the row: a billed tier 2 row
    // Tracerfy returned nothing for fails the guard, keeps
    // `status = 'processing'`, and the very next statement marks this job
    // `completed` -- whose early-return at the top of this handler means the job
    // is never polled again. An hour later sweep-stale-traces stage 1 claims
    // that row (status + created_at) and settles it against
    // `nonPaddingResults.find(r => r.primary_phone || ...)`, which for a SHARED
    // bulk Tracerfy job is whichever OTHER property in the batch came back.
    // Second charge on the same address, a stranger's phone and email written
    // onto the customer's parcel, and both pushed to their GoHighLevel CRM.

    // 1. THE MONEY, guarded. A blanket update reads no row, so it cannot fold;
    //    instead it may only ever touch rows that have collected nothing, and
    //    excludeBilledRows makes that true in the database rather than here, so
    //    there is no read-then-write race. On those rows a flat `charge: 0` is a
    //    no-op that normalises NULL, and the tier stamp records the billing
    //    model. This runs FIRST, while the rows are still 'processing'.
    await excludeBilledRows(
      adminClient
        .from('trace_history')
        .update({
          charge: 0,
          tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
        })
        .eq('user_id', user.id)
        .eq('tracerfy_job_id', traceJob.tracerfy_job_id)
        .eq('status', 'processing')
    );

    // 2. THE DELIVERY FACTS, for every row. Unguarded on purpose: a row that was
    //    paid for still has to be told it got no result, or it is left for a
    //    cron that will sell it someone else's contacts.
    await adminClient
      .from('trace_history')
      .update({
        status: 'no_match',
        is_successful: false,
        cost: PRICING.COST_PER_RECORD,
      })
      .eq('user_id', user.id)
      .eq('tracerfy_job_id', traceJob.tracerfy_job_id)
      .eq('status', 'processing');

    // THE JOB IS NOT FINISHED JUST BECAUSE TRACERFY IS. The rows above are the
    // tier 1 half; a MIXED job also carries tier 2 rows the cron is still
    // working, and they are invisible to the loop above because a queued row
    // never gets a tracerfy_job_id. Marking the job completed here would strand
    // them: the branch at the top of this handler short-circuits a completed
    // job, so it is never polled again and the customer keeps a result that is
    // short by exactly the rows they are about to be billed for, on a CSV they
    // may reasonably treat as final.
    //
    // The tier 1 rows are still settled above on every poll, which is
    // deliberate and not optional: a row left at 'processing' is one
    // sweep-stale-traces would later settle against another property's
    // contacts. Only the JOB-level completion waits.
    const jobRows = await readJobRows();
    if (jobRows.some((r) => isPropertyTracePending(r.property_trace_status))) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_pending_property_trace: jobRows.filter((r) =>
          isPropertyTracePending(r.property_trace_status)
        ).length,
        age_minutes: Math.round(jobAgeMinutes),
      });
    }

    const finalized = await finalize(jobRows, recordsMatched);
    recordsMatched = finalized.recordsMatched;
    totalCharge = finalized.totalCharge;

    const skips = summarizeSkips(jobRows);

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
      ...skips,
    });
  } catch (error) {
    console.error('Bulk status error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
