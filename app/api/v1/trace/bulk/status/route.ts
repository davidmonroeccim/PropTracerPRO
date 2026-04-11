import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { PRICING, getChargePerTrace } from '@/lib/constants';
import type { TraceJob, TraceResult, AIResearchResult } from '@/types';

type TraceHistoryRow = {
  id: string;
  user_id: string;
  trace_job_id: string | null;
  address_hash: string;
  normalized_address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  input_owner_name: string | null;
  tracerfy_job_id: string | null;
  status: string;
  trace_result: TraceResult | null;
  ai_research: AIResearchResult | null;
  ai_research_status: string | null;
  ai_research_charge: number | null;
  phone_count: number;
  email_count: number;
  is_successful: boolean | null;
  charge: number | null;
};

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

    for (const [tracerfyJobId, bucketRows] of unresolvedByJobId.entries()) {
      const statusResult = await getJobStatus(tracerfyJobId);

      if (!statusResult.success || statusResult.pending === true) {
        continue; // still processing — leave rows as-is
      }

      if (!statusResult.results || statusResult.results.length === 0) {
        continue; // treat empty results as still processing per existing behavior
      }

      // Finalize the rows backed by this Tracerfy job.
      if (bucketRows.length === 1) {
        // Single-trace submission (entity row post-research). Find the best
        // result and apply it directly to this one row.
        const row = bucketRows[0];
        const nonPadding = statusResult.results.filter(
          (r) => r.address !== '0 Padding Row'
        );
        const target =
          nonPadding.find((r) => r.primary_phone || r.mobile_1 || r.email_1) ||
          nonPadding[0];
        if (!target) continue;

        const parsed = parseTracerfyResult(target);
        const isSuccessful =
          (parsed.phones?.length || 0) > 0 || (parsed.emails?.length || 0) > 0;
        const charge = isSuccessful ? chargePerTrace : 0;

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
          .eq('id', row.id);

        if (isSuccessful && charge > 0) {
          await adminClient.rpc('deduct_wallet_balance', {
            p_user_id: profile.id,
            p_amount: charge,
            p_trace_history_id: row.id,
            p_description: 'Bulk skip trace - entity row (post-research)',
          });
        }

        // Reflect in local copy so buildPerRecordResult below sees the latest.
        row.status = isSuccessful ? 'success' : 'no_match';
        row.trace_result = parsed;
        row.phone_count = parsed.phones?.length || 0;
        row.email_count = parsed.emails?.length || 0;
        row.is_successful = isSuccessful;
        row.charge = charge;
      } else {
        // Shared bulk Tracerfy job — match results back to person rows by
        // city/state, mirroring the existing bulk status matcher.
        for (const rawResult of statusResult.results) {
          const inputCity = (rawResult.city || '').toUpperCase().trim();
          const inputState = (rawResult.state || '').toUpperCase().trim();

          // Find the first still-processing row in this bucket that matches.
          const match = bucketRows.find(
            (r) =>
              r.status === 'processing' &&
              (r.city || '').toUpperCase() === inputCity &&
              (r.state || '').toUpperCase() === inputState
          );
          if (!match) continue;

          const parsed = parseTracerfyResult(rawResult);
          const isSuccessful =
            (parsed.phones?.length || 0) > 0 || (parsed.emails?.length || 0) > 0;
          const charge = isSuccessful ? chargePerTrace : 0;

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
            .eq('id', match.id);

          if (isSuccessful && charge > 0) {
            await adminClient.rpc('deduct_wallet_balance', {
              p_user_id: profile.id,
              p_amount: charge,
              p_trace_history_id: match.id,
              p_description: 'Bulk skip trace - successful match',
            });
          }

          // Reflect in local copy so the completion check below is accurate.
          match.status = isSuccessful ? 'success' : 'no_match';
          match.trace_result = parsed;
          match.phone_count = parsed.phones?.length || 0;
          match.email_count = parsed.emails?.length || 0;
          match.is_successful = isSuccessful;
          match.charge = charge;
        }

        // Mark any remaining still-processing person rows in this shared
        // bucket as no_match — Tracerfy returned its final set and these rows
        // got no result.
        const stillProcessing = bucketRows.filter((r) => r.status === 'processing');
        if (stillProcessing.length > 0) {
          await adminClient
            .from('trace_history')
            .update({
              status: 'no_match',
              is_successful: false,
              cost: PRICING.COST_PER_RECORD,
              charge: 0,
            })
            .in(
              'id',
              stillProcessing.map((r) => r.id)
            );
          for (const r of stillProcessing) {
            r.status = 'no_match';
            r.is_successful = false;
            r.charge = 0;
          }
        }
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
