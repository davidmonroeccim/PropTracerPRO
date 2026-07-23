import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { type TracerfyErrorReason } from '@/lib/tracerfy/client';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { STALE_PROCESSING, getChargePerTrace } from '@/lib/constants';
import { settleBulkJob, type TraceHistoryRow } from '@/lib/trace/settleBulkJob';
import type { TraceJob } from '@/types';

// Polling N entity rows means N sequential Tracerfy getJobStatus() calls; without
// an explicit maxDuration the function dies on the platform default (~10 s) before
// it can mark the bulk job completed, leaving the run stuck in 'processing'.
export const maxDuration = 60;

// Cap parallel Tracerfy getJobStatus() calls so a 200-row bulk doesn't fan out
// 200 simultaneous requests against Tracerfy.
const POLL_CONCURRENCY = 25;

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
    const chargePerTrace = getChargePerTrace(
      profile.subscription_tier,
      profile.is_acquisition_pro_member
    );

    // Pull all trace_history rows for this bulk job.
    const { data: rowsRaw } = await adminClient
      .from('trace_history')
      .select('*')
      .eq('user_id', profile.id)
      .eq('trace_job_id', traceJob.id);

    const rows = (rowsRaw || []) as TraceHistoryRow[];

    // Already-finalized jobs: just emit the stored summary + per-record details.
    if (traceJob.status === 'completed' || traceJob.status === 'failed') {
      return NextResponse.json({
        success: true,
        status: traceJob.status,
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_matched: traceJob.records_matched,
        total_charge: traceJob.records_matched * chargePerTrace,
        error_message: traceJob.error_message,
        results: rows.map(buildPerRecordResult),
      });
    }

    // --- Resolve any still-processing Tracerfy jobs -----------------------

    // Collect unique Tracerfy job IDs that still need polling. A bulk job can
    // contain both the shared bulk tracerfy_job_id (person rows) and one
    // tracerfy_job_id per entity row (post-research single submits).
    const unresolvedByJobId = new Map<string, TraceHistoryRow[]>();
    for (const row of rows) {
      if (row.status !== 'processing') continue;
      if (!row.tracerfy_job_id) continue;
      const bucket = unresolvedByJobId.get(row.tracerfy_job_id) || [];
      bucket.push(row);
      unresolvedByJobId.set(row.tracerfy_job_id, bucket);
    }

    // Run getJobStatus() in parallel batches so a bulk run with N entity rows
    // (each holding its own tracerfy_job_id) doesn't serialize N round trips
    // inside a single HTTP request and bust maxDuration. Per-job work below is
    // unchanged; only the orchestration is parallel.
    const pollEntries = Array.from(unresolvedByJobId.entries());

    // Collect Tracerfy job IDs whose polls came back unhealthy this round.
    // After the batch finishes we use this + the parent job's age to decide
    // whether to stall-promote those rows to 'error' so callers stop polling
    // 'processing' forever when Tracerfy itself is broken.
    const stalledByErrorReason = new Map<string, TracerfyErrorReason>();

    // Per-row settlement now lives in the shared lib/trace/settleBulkJob.ts so
    // this v1 REST route and the Suite MCP tool can never diverge on money. We
    // pass this surface's CURRENT person rate (getChargePerTrace tier-aware);
    // the MCP passes its grant-aware rate. settleBulkJob mutates bucket rows in
    // place (same as the old closure) and returns any unhealthy Tracerfy
    // errorReason so we can still stall-detect below.
    for (let i = 0; i < pollEntries.length; i += POLL_CONCURRENCY) {
      const batch = pollEntries.slice(i, i + POLL_CONCURRENCY);
      const settlements = await Promise.all(
        batch.map(([entryJobId, bucket]) =>
          settleBulkJob(adminClient, {
            tracerfyJobId: entryJobId,
            bucketRows: bucket,
            userId: profile.id,
            personRate: chargePerTrace,
          })
        )
      );
      settlements.forEach((settlement, idx) => {
        if (settlement.stalledErrorReason) {
          stalledByErrorReason.set(batch[idx][0], settlement.stalledErrorReason);
        }
      });
    }

    // --- Stall promotion --------------------------------------------------

    // If Tracerfy has been unhealthy (rate-limited / 503 / malformed) for any
    // of this job's rows AND the parent job is older than the stall threshold,
    // promote those rows to status='error' so the caller gets a definitive
    // answer instead of polling 'processing' indefinitely. The Lead-Gen Agent
    // retries at 20m otherwise, masking real Tracerfy outages as PTP failures.
    const jobAgeMinutes =
      (Date.now() - new Date(traceJob.created_at).getTime()) / 60000;
    const stallThresholdHit =
      jobAgeMinutes >= STALE_PROCESSING.TRACERFY_STALL_MINUTES;
    const stalledRowIds: string[] = [];
    let primaryStallReason: TracerfyErrorReason | null = null;

    if (stallThresholdHit && stalledByErrorReason.size > 0) {
      for (const [tracerfyJobId, reason] of stalledByErrorReason) {
        const bucket = unresolvedByJobId.get(tracerfyJobId) || [];
        for (const row of bucket) {
          if (row.status === 'processing') {
            stalledRowIds.push(row.id);
            row.status = 'error';
          }
        }
        if (!primaryStallReason) primaryStallReason = reason;
      }
      if (stalledRowIds.length > 0) {
        console.error(
          `[v1/trace/bulk/status] stall: job=${traceJob.id} rows=${stalledRowIds.length} reason=${primaryStallReason} age=${jobAgeMinutes.toFixed(1)}m`
        );
        await adminClient
          .from('trace_history')
          .update({ status: 'error' })
          .in('id', stalledRowIds);
      }
    }

    // --- Decide overall bulk job state ------------------------------------

    // A bulk job is not finished while any row is still awaiting research or
    // its Tracerfy result.
    const anyPendingResearch = rows.some(
      (r) => r.ai_research_status === 'queued' || r.ai_research_status === 'processing'
    );
    const anyPendingTrace = rows.some((r) => r.status === 'processing');

    if (anyPendingResearch || anyPendingTrace) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_pending_research: rows.filter(
          (r) => r.ai_research_status === 'queued' || r.ai_research_status === 'processing'
        ).length,
        records_pending_trace: rows.filter((r) => r.status === 'processing').length,
        // Surface stall diagnostics so callers know Tracerfy is the bottleneck
        // even if some rows are still legitimately in flight.
        tracerfy_state: stalledByErrorReason.size > 0
          ? Array.from(stalledByErrorReason.values())[0]
          : 'pending',
        age_minutes: Math.round(jobAgeMinutes),
      });
    }

    // If we stalled rows above and no rows are still in flight, the bulk job
    // failed -- finalize it as such with a real error_message rather than
    // claiming 'completed' on a partial result.
    if (stalledRowIds.length > 0) {
      const errorMessage = `Tracerfy upstream unhealthy: ${primaryStallReason} -- ${stalledRowIds.length} row(s) stalled for ${jobAgeMinutes.toFixed(0)}m`;
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
        records_submitted: traceJob.records_submitted,
        error: errorMessage,
        tracerfy_state: primaryStallReason,
        age_minutes: Math.round(jobAgeMinutes),
        results: rows.map(buildPerRecordResult),
      });
    }

    // --- Finalize --------------------------------------------------------

    const recordsMatched = rows.filter((r) => r.is_successful).length;
    const totalCharge = rows.reduce((sum, r) => sum + (r.charge || 0), 0);

    await adminClient
      .from('trace_jobs')
      .update({
        status: 'completed',
        records_matched: recordsMatched,
        completed_at: new Date().toISOString(),
      })
      .eq('id', traceJob.id);

    if (totalCharge > 0) {
      triggerAutoRebillIfNeeded(profile.id).catch(() => {});
    }

    const perRecordResults = rows.map(buildPerRecordResult);

    // Look up each row's business_trace_jobs row (if any) so the webhook and
    // response can surface business_trace_pending / business_trace_job_id per
    // record, matching docs/AGENT_INTEGRATION.md.
    const addressHashes = rows.map((r) => r.address_hash);
    const pendingBusinessTraceByHash = new Map<string, { id: string; status: string }>();
    if (addressHashes.length > 0) {
      const { data: btJobs } = await adminClient
        .from('business_trace_jobs')
        .select('id, address_hash, status')
        .eq('user_id', profile.id)
        .in('address_hash', addressHashes);
      if (btJobs) {
        for (const bt of btJobs as Array<{ id: string; address_hash: string; status: string }>) {
          // Keep the most recent pending one if multiple exist for the same hash.
          const existing = pendingBusinessTraceByHash.get(bt.address_hash);
          if (!existing || bt.status === 'pending') {
            pendingBusinessTraceByHash.set(bt.address_hash, { id: bt.id, status: bt.status });
          }
        }
      }
    }

    const enrichedResults = perRecordResults.map((result, idx) => {
      const bt = pendingBusinessTraceByHash.get(rows[idx].address_hash);
      return {
        ...result,
        business_trace_pending: bt ? bt.status === 'pending' : false,
        business_trace_job_id: bt ? bt.id : null,
      };
    });

    // Fire webhook + HighLevel push (same fire-and-forget pattern as before).
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
          results: enrichedResults,
          timestamp: new Date().toISOString(),
        }),
      }).catch((err) => console.error('API v1 bulk webhook dispatch error:', err));
    }

    if (profile.highlevel_api_key && profile.highlevel_location_id) {
      for (const row of rows) {
        if (!row.is_successful || !row.trace_result) continue;
        pushTraceToHighLevel({
          apiKey: profile.highlevel_api_key,
          locationId: profile.highlevel_location_id,
          traceResult: row.trace_result,
          propertyAddress: row.normalized_address,
          propertyCity: row.city || undefined,
          propertyState: row.state || undefined,
          propertyZip: row.zip || undefined,
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
      results: enrichedResults,
    });
  } catch (error) {
    console.error('API v1 bulk status error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Build the per-record payload that matches docs/AGENT_INTEGRATION.md:
// research + contacts (FastAppend sidecar) + trace_result, per row.
function buildPerRecordResult(row: TraceHistoryRow) {
  const contacts = row.ai_research?.business_trace_contacts || null;
  return {
    address: row.normalized_address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    status: row.status,
    input_owner_name: row.input_owner_name,
    result: row.trace_result,
    research: row.ai_research,
    contacts,
    charge: row.charge || 0,
    ai_research_charge: row.ai_research_charge || 0,
  };
}
