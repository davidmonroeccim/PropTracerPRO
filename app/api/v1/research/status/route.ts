import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';

/**
 * GET /api/v1/research/status?job_id=<business_trace_job_id>
 *
 * Polls the status of an async FastAppend business-trace job that was queued
 * during /api/v1/research/single. Use this endpoint when the initial research
 * response returned `business_trace_pending: true` and you want to retrieve
 * the delayed contact results without waiting for the webhook.
 *
 * Returns:
 *   status: 'pending' | 'completed' | 'no_match' | 'error'
 *   contacts: { owner_name, phones, emails, address } | null  (FastAppend payload)
 *   research: AIResearchResult | null  (merged trace_history.ai_research if linked)
 */
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
