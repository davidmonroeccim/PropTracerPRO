import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { type TracerfyErrorReason } from '@/lib/tracerfy/client';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { recordHighLevelPushes, type HighLevelPushEntry } from '@/lib/highlevel/credentialHealth';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { STALE_PROCESSING, getChargePerTrace } from '@/lib/constants';
import { settleBulkJob, type TraceHistoryRow } from '@/lib/trace/settleBulkJob';
import { resolveOwnerContact } from '@/lib/ai-research/contacts';
import { rowSkipReason } from '@/lib/trace/rowSkipReason';
import { toPublicPropertyRecord } from '@/lib/trace/publicPropertyRecord';
import { isEntityTracePending } from '@/lib/trace/entityTraceAttempts';
import { isPropertyTracePending } from '@/lib/trace/propertyTraceAttempts';
import type { TraceJob } from '@/types';

// Polling N entity rows means N sequential Tracerfy getJobStatus() calls; without
// an explicit maxDuration the function dies on the platform default (~10 s) before
// it can mark the bulk job completed, leaving the run stuck in 'processing'.
export const maxDuration = 60;

// Cap parallel Tracerfy getJobStatus() calls so a 200-row bulk doesn't fan out
// 200 simultaneous requests against Tracerfy.
const POLL_CONCURRENCY = 25;

/**
 * THE SIZE FENCE. ADDITIVE, AND DELIBERATELY NOT THE MCP'S NUMBERS.
 *
 * WHY IT EXISTS. Restoring payload parity in 5c-3B put a 65-key
 * `property_record` on every row of this response, on all three emitting exits.
 * Rows that were thin on a surface sized for thin rows became fat, and that is
 * this phase's own doing rather than a pre-existing debt.
 *
 * WHY THE DEFAULT IS THE SUBMIT CAP AND NOT A PAGE SIZE. A bulk job is capped at
 * 500 records on all three submit surfaces, so this response is ALREADY bounded
 * at 500 rows by construction; the unbounded case was removed by the cap, not by
 * a page size. Defaulting to a small page would bound it a second time at the
 * cost of breaking every existing API-key consumer, which is a far larger harm
 * than a large response. So paging here is ADDITIVE: a caller that reads
 * `results` and passes no query sees exactly what it saw before, and a caller
 * that wants pages can ask for them.
 *
 * THE ASYMMETRY WITH lib/suite/mcp-tools.ts (25 default, 200 max) IS ON PURPOSE.
 * Do not "fix" it by making the numbers match. The MCP limit exists because its
 * consumer is a model with a context budget, where a 500-row payload crowds out
 * the conversation. This limit exists because of bytes over the wire to a
 * program that asked for them. Different reasons, genuinely different numbers.
 * Two surfaces differing for a stated reason is fine; two surfaces differing for
 * no reason is what this phase spent its time removing.
 *
 * THE ONE CASE WHERE AN EXISTING CALLER SEES A CHANGE. The 500 cap is new, so a
 * job submitted before it can hold more rows: the brief measured exactly one in
 * the whole history, at 654 records. Polling that job now returns 500 rows
 * rather than 654. It is visible (`results_total` says 654) and recoverable
 * (`offset=500` returns the rest), which is why a bound is still the right
 * answer, but it is a change and it is recorded rather than discovered.
 *
 * `results_total`, `results_returned` and `results_offset` are ALWAYS present,
 * not only when truncation happens: a silently short array a consumer cannot
 * detect is the failure this codebase treats as worse than a large response.
 *
 * The `bulk_job.completed` WEBHOOK is deliberately NOT paged. It is a one-shot
 * delivery into the customer's own system with nothing to page with, so
 * truncating it would lose rows permanently.
 */
const RESULTS_DEFAULT_LIMIT = 500;
const RESULTS_MAX_LIMIT = 500;

/** One page of per-record results, plus the counts that make truncation visible. */
function pageResults<T>(all: T[], url: URL) {
  const rawLimit = Number(url.searchParams.get('limit'));
  const rawOffset = Number(url.searchParams.get('offset'));
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : RESULTS_DEFAULT_LIMIT, 1),
    RESULTS_MAX_LIMIT
  );
  // A negative offset would slice from the END of the array and silently return
  // the WRONG rows rather than failing, which is the shape of bug nobody reports.
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
  return {
    results_total: all.length,
    results_returned: Math.min(Math.max(all.length - offset, 0), limit),
    results_offset: offset,
    results: all.slice(offset, offset + limit),
  };
}

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const { searchParams } = requestUrl;
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
    // total_charge SUMS THE STORED PER-ROW CHARGES. It must never be
    // records_matched x a live rate: the rate moves, the history does not, and a
    // repriced constant would restate what the user was actually billed on every
    // past job. The stored charge is the amount the settle path wrote at the time.
    if (traceJob.status === 'completed' || traceJob.status === 'failed') {
      return NextResponse.json({
        success: true,
        status: traceJob.status,
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_matched: traceJob.records_matched,
        total_charge: Number(
          rows.reduce((sum, r) => sum + (r.charge || 0), 0).toFixed(4)
        ),
        error_message: traceJob.error_message,
        ...pageResults(rows.map(buildPerRecordResult), requestUrl),
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

    // A bulk job is not finished while any row is still awaiting its business
    // trace or its Tracerfy result. `ai_research_status` is still the entity
    // state machine (sweep-entity-traces drives it); only the engine behind it
    // changed. Pendingness is asked of lib/trace/entityTraceAttempts.ts rather
    // than compared against two literals, because a retried row carries its
    // attempt number in that column. A row skipped for having no owner name,
    // and a row whose attempts ran out, are NOT pending: both carry a terminal
    // status, which is what stops them holding a job open forever.
    //
    // AND WHILE ANY ROW STILL OWES ITS FULL PROPERTY TRACE. Same shape as the
    // entity gate above and deliberately not a different one: that gate is
    // already load-bearing and correct, and two near-identical checks that
    // differ slightly is how one of them rots. Asked of
    // lib/trace/propertyTraceAttempts.ts rather than compared against literals,
    // because a retried row carries its attempt number in the column.
    //
    // A tier 2 row is written `status: 'processing'` at submit, so the arm below
    // catches it too. That overlap is not a reason to drop this one: the cron
    // writes the row's delivery status the moment the dossier answers, while the
    // queue column is what says whether the ROW is finished, and the two part
    // company on exactly the row that matters. Without this the job finalizes
    // over rows the customer is about to be billed for, and a completed job is
    // never polled again.
    const anyPendingResearch = rows.some((r) => isEntityTracePending(r.ai_research_status));
    const anyPendingProperty = rows.some((r) =>
      isPropertyTracePending(r.property_trace_status)
    );
    const anyPendingTrace = rows.some((r) => r.status === 'processing');

    if (anyPendingResearch || anyPendingProperty || anyPendingTrace) {
      return NextResponse.json({
        success: true,
        status: 'processing',
        job_id: traceJob.id,
        records_submitted: traceJob.records_submitted,
        records_pending_research: rows.filter((r) =>
          isEntityTracePending(r.ai_research_status)
        ).length,
        records_pending_property_trace: rows.filter((r) =>
          isPropertyTracePending(r.property_trace_status)
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
        ...pageResults(rows.map(buildPerRecordResult), requestUrl),
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

    // The whole batch is ONE credential decision rather than one write per
    // record. Nobody is watching this push, so the credential flag is the only
    // channel it has. See lib/highlevel/credentialHealth.ts.
    if (profile.highlevel_api_key && profile.highlevel_location_id) {
      const pushes: HighLevelPushEntry[] = [];
      for (const row of rows) {
        if (!row.is_successful || !row.trace_result) continue;
        // ALREADY THERE. sweep-property-traces pushes a tier 2 row the moment it
        // settles, and this list walks every ROW of the job, so without this the
        // same contact is pushed a second time on the poll that finalizes it.
        //
        // The skip is the RECORDED PUSH, not a filter on `tier` or on the queue
        // column. Those two guess at which code path owned the row; the
        // timestamp is what actually happened to it, and that is the whole
        // reason the column exists. A tier 1 row nothing has pushed still has a
        // null here and still goes.
        if (row.highlevel_pushed_at) continue;
        pushes.push({
          traceId: row.id,
          push: pushTraceToHighLevel({
            apiKey: profile.highlevel_api_key,
            locationId: profile.highlevel_location_id,
            traceResult: row.trace_result,
            propertyAddress: row.normalized_address,
            propertyCity: row.city || undefined,
            propertyState: row.state || undefined,
            propertyZip: row.zip || undefined,
          }),
        });
      }
      recordHighLevelPushes(profile.id, pushes);
    }

    return NextResponse.json({
      success: true,
      status: 'completed',
      job_id: traceJob.id,
      records_submitted: traceJob.records_submitted,
      records_matched: recordsMatched,
      total_charge: totalCharge,
      ...pageResults(enrichedResults, requestUrl),
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
// `research` still carries whatever is stored on the row. For a row written
// before 2026-09-17 that is AI Search output the customer paid for, and it is
// served unchanged; for a row written since it is the FastAppend business-trace
// record. Either way it is read here and never written.
function buildPerRecordResult(row: TraceHistoryRow) {
  const contacts = row.ai_research?.business_trace_contacts || null;
  // owner_contact_name is the resolved HUMAN behind input_owner_name (the entity asked about).
  // Kept identical to the MCP twin in lib/suite/mcp-tools.ts -- the two surfaces are
  // line-for-line the same payload by design and must not diverge. They HAD diverged:
  // property_record and tier were on the MCP twin only, and both comments went on
  // claiming parity, which is why lib/trace/__tests__/payloadParity.test.ts now
  // compares the two key sets instead of trusting either comment.
  const { owner_contact_name, owner_contact_source } = resolveOwnerContact(row);
  return {
    address: row.normalized_address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    status: row.status,
    input_owner_name: row.input_owner_name,
    owner_contact_name,
    owner_contact_source,
    result: row.trace_result,
    research: row.ai_research,
    contacts,
    // THE PUBLIC PROPERTY RECORD: 65 of the 86 keys stored on the row. Filtered
    // here because this payload is one an agent maps into a customer's own CRM,
    // where a wrong estimated_value looks authoritative and outlives any caveat.
    // Null on a tier 1 row, because an absence is reported as an absence.
    //
    // IT WAS MISSING ENTIRELY UNTIL 5c-3B, while this function's own comment
    // claimed it was line for line identical to the MCP twin. A tier 2 bulk row
    // is charged per record submitted specifically to buy this record, and the
    // one surface an API-key caller polls did not return it.
    property_record: toPublicPropertyRecord(row.property_record),
    // Which billing tier bought this row: 1 = per successful trace, 2 = per
    // record submitted. Null on a row written before migration 20260917. Never
    // 0 and never a guess, because an unknown tier is an absence.
    tier: row.tier ?? null,
    // Why a row came back with no contacts. Asked of BOTH queues: serving only
    // the tier 1 accessor left every tier 2 terminal value speaking as a bare
    // no_match, including the billed row whose contact vendor never answered.
    skip_reason: rowSkipReason(row),
    charge: row.charge || 0,
    ai_research_charge: row.ai_research_charge || 0,
  };
}
