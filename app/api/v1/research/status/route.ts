import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';

/**
 * GET /api/v1/research/status?job_id=<business_trace_job_id>
 *
 * Polls one row of `business_trace_jobs`, the async FastAppend recovery queue.
 * It reads that table and nothing else, so it SURVIVED the removal of the AI
 * Search engine on 2026-09-17 even though "research" is in its path.
 *
 * THE PATH STAYS. It is a documented customer polling endpoint, cross-referenced
 * twice in the API docs, and renaming a public path is a breaking change. Do not
 * "tidy" it to match the current feature names.
 *
 * The endpoint that used to hand out these job ids, POST /api/v1/research/single,
 * is gone, and nothing queues a NEW async job any more: the business trace is
 * synchronous now (lib/tracerfy/client.ts lookupBusinessTrace). What is left is
 * the tail of jobs the old engine queued, which app/api/cron/sweep-business-traces
 * is still finalizing, and this is how a customer watches one land.
 *
 * Returns:
 *   status: 'pending' | 'completed' | 'no_match' | 'error'
 *   contacts: { owner_name, phones, emails, address } | null  (FastAppend payload)
 *   research: AIResearchResult | null  (merged trace_history.ai_research if linked)
 */
// validateApiKey's blocking entitlement refresh (lib/suite/access.ts) can add up to 5s
// (AbortSignal.timeout(5000)) plus an un-timeouted UPDATE in front of the two reads below, so
// this needs the same headroom as its v1 siblings (trace/single, trace/bulk, trace/bulk/status),
// all of which set 60 against the ~10s platform default.
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('job_id');

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'Missing job_id query parameter' },
        { status: 400 }
      );
    }

    const authResult = await validateApiKey(request);
    if (isAuthError(authResult)) {
      return authResult.response;
    }
    const { profile } = authResult;

    const adminClient = createAdminClient();

    const { data: job, error } = await adminClient
      .from('business_trace_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', profile.id)
      .maybeSingle();

    if (error || !job) {
      return NextResponse.json(
        { success: false, error: 'Job not found' },
        { status: 404 }
      );
    }

    // If the job is finished, try to surface the merged research from trace_history
    let mergedResearch = null;
    if (job.status !== 'pending' && job.address_hash) {
      const { data: historyRow } = await adminClient
        .from('trace_history')
        .select('ai_research')
        .eq('user_id', profile.id)
        .eq('address_hash', job.address_hash)
        .limit(1)
        .maybeSingle();

      mergedResearch = historyRow?.ai_research || null;
    }

    return NextResponse.json({
      success: true,
      job_id: job.id,
      status: job.status,
      business_name: job.business_name,
      address: job.normalized_address,
      city: job.city,
      state: job.property_state,
      zip: job.zip,
      contacts: job.result,
      research: mergedResearch,
      error_message: job.error_message,
      created_at: job.created_at,
      completed_at: job.completed_at,
    });
  } catch (error) {
    console.error('API v1 research status error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
