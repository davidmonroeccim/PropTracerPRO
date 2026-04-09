import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getBusinessTraceStatus, downloadBusinessTraceResults } from '@/lib/tracerfy/client';
import type { AIResearchResult, BusinessTraceJob } from '@/types';

/**
 * Vercel Cron: sweeps `business_trace_jobs` rows stuck in 'pending'.
 *
 * These are FastAppend business-trace jobs that were queued during AI research
 * but didn't complete within the 45-second inline poll in resolveEntityChain().
 * FastAppend can take minutes to hours to finish; this cron polls each pending
 * job, downloads results when ready, merges them into trace_history.ai_research,
 * and fires a `business_trace.completed` webhook to the user's configured URL.
 *
 * Runs every 5 minutes. Jobs older than 24 hours that are still pending are
 * marked as 'error' and skipped on subsequent runs.
 */
const STALE_HOURS = 24;
const MAX_JOBS_PER_RUN = 50;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  const now = Date.now();
  const staleCutoff = new Date(now - STALE_HOURS * 60 * 60 * 1000).toISOString();

  let swept = 0;
  let resolved = 0;
  let stillPending = 0;
  let erroredStale = 0;

  try {
    // Mark anything older than 24h as error before working the rest
    await adminClient
      .from('business_trace_jobs')
      .update({
        status: 'error',
        error_message: `Timed out after ${STALE_HOURS}h`,
        completed_at: new Date().toISOString(),
      })
      .eq('status', 'pending')
      .lt('created_at', staleCutoff);

    // Pull the remaining pending jobs
    const { data: pendingJobs } = await adminClient
      .from('business_trace_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(MAX_JOBS_PER_RUN);

    if (!pendingJobs || pendingJobs.length === 0) {
      return NextResponse.json({ success: true, swept: 0, resolved: 0, stillPending: 0 });
    }

    for (const job of pendingJobs as BusinessTraceJob[]) {
      swept++;

      const statusResult = await getBusinessTraceStatus(job.fastappend_queue_id);

      if (!statusResult.success) {
        console.error(`[sweep-business-traces] status error for job ${job.id}: ${statusResult.error}`);
        continue;
      }

      if (statusResult.pending) {
        stillPending++;
        continue;
      }

      // Not pending: attempt to download the results
      let parsed = null;
      if (statusResult.downloadUrl) {
        parsed = await downloadBusinessTraceResults(statusResult.downloadUrl);
      }

      const finalStatus = parsed && (parsed.owner_name || parsed.phones.length > 0 || parsed.emails.length > 0)
        ? 'completed'
        : 'no_match';

      // Update the business_trace_jobs row
      await adminClient
        .from('business_trace_jobs')
        .update({
          status: finalStatus,
          result: parsed,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      // Merge contacts into the linked trace_history row, if one exists
      let mergedResearch: AIResearchResult | null = null;
      if (job.address_hash) {
        const { data: historyRow } = await adminClient
          .from('trace_history')
          .select('id, ai_research')
          .eq('user_id', job.user_id)
          .eq('address_hash', job.address_hash)
          .limit(1)
          .maybeSingle();

        if (historyRow) {
          const existing = (historyRow.ai_research || {}) as AIResearchResult & Record<string, unknown>;

          // Merge contacts discovered by FastAppend into decision_makers + sources.
          // We don't overwrite fields the AI already found — we append.
          const updatedDecisionMakers = Array.isArray(existing.decision_makers)
            ? [...existing.decision_makers]
            : [];

          if (parsed?.owner_name && !updatedDecisionMakers.includes(parsed.owner_name)) {
            updatedDecisionMakers.push(parsed.owner_name);
          }

          mergedResearch = {
            ...existing,
            decision_makers: updatedDecisionMakers,
            business_trace_status: finalStatus === 'completed'
              ? `Recovered async: ${parsed?.owner_name || 'unnamed'} (${parsed?.phones.length || 0} phones, ${parsed?.emails.length || 0} emails)`
              : `Recovered async: no match for "${job.business_name || ''}"`,
          } as AIResearchResult;

          // Stash the full FastAppend contact payload on the research object
          // under a dedicated field so downstream consumers can find phones/emails.
          (mergedResearch as AIResearchResult & { business_trace_contacts?: typeof parsed }).business_trace_contacts = parsed;

          // If AI research didn't find an owner but FastAppend did, promote it
          if (!existing.owner_name && parsed?.owner_name) {
            mergedResearch.owner_name = parsed.owner_name;
            mergedResearch.individual_behind_business = parsed.owner_name;
          }

          await adminClient
            .from('trace_history')
            .update({
              ai_research: mergedResearch,
              ai_research_status: mergedResearch.owner_name ? 'found' : (existing.ai_research_status as string || 'not_found'),
            })
            .eq('id', historyRow.id);
        }
      }

      // Fire webhook
      const { data: profile } = await adminClient
        .from('user_profiles')
        .select('webhook_url')
        .eq('id', job.user_id)
        .single();

      if (profile?.webhook_url) {
        try {
          await fetch(profile.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'business_trace.completed',
              business_trace_job_id: job.id,
              status: finalStatus,
              business_name: job.business_name,
              address: job.normalized_address,
              city: job.city,
              state: job.property_state,
              zip: job.zip,
              contacts: parsed,
              research: mergedResearch,
              timestamp: new Date().toISOString(),
            }),
          });

          await adminClient
            .from('business_trace_jobs')
            .update({ webhook_dispatched: true })
            .eq('id', job.id);
        } catch (err) {
          console.error(`[sweep-business-traces] webhook dispatch error for job ${job.id}:`, err);
        }
      }

      resolved++;
    }

    console.log(`[sweep-business-traces] swept=${swept} resolved=${resolved} stillPending=${stillPending}`);

    return NextResponse.json({
      success: true,
      swept,
      resolved,
      stillPending,
      erroredStale,
    });
  } catch (error) {
    console.error('[sweep-business-traces] error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
