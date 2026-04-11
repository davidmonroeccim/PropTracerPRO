import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { researchProperty } from '@/lib/ai-research/client';
import { submitSingleTrace } from '@/lib/tracerfy/client';
import { AI_RESEARCH } from '@/lib/constants';
import type { AIResearchResult } from '@/types';

/**
 * Vercel Cron: processes trace_history rows stuck in ai_research_status='queued'.
 *
 * These are bulk-upload rows where the inbound owner_name was empty or looked
 * like a business entity, so AI research must run before any Tracerfy submit.
 * For each queued row we:
 *   1. Run researchProperty() with asyncRecovery context (so a timed-out
 *      FastAppend business trace gets queued into business_trace_jobs and the
 *      existing sweep-business-traces cron can finalize it later).
 *   2. Persist the full AIResearchResult onto trace_history.ai_research.
 *   3. Deduct the $0.15 research charge if an owner was found.
 *   4. If research resolved a person name, submit a single Tracerfy person-
 *      skip-trace for this row and store its tracerfy_job_id on the row.
 *   5. If research found nothing, mark the row as no_match immediately.
 *
 * Runs every minute. Processes a small batch per run because researchProperty
 * can take up to ~45 s per call with the inline FastAppend poll.
 */
export const maxDuration = 300;

const MAX_ROWS_PER_RUN = 5;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  let processed = 0;
  let resolvedToPerson = 0;
  let noMatch = 0;
  let errored = 0;

  try {
    // Claim up to N queued rows by flipping them to 'processing' first so
    // concurrent cron invocations don't double-process the same row.
    const { data: queuedRows } = await adminClient
      .from('trace_history')
      .select('*')
      .eq('ai_research_status', 'queued')
      .order('created_at', { ascending: true })
      .limit(MAX_ROWS_PER_RUN);

    if (!queuedRows || queuedRows.length === 0) {
      return NextResponse.json({ success: true, processed: 0 });
    }

    for (const row of queuedRows) {
      // Atomic claim: only proceed if we successfully flip the row out of
      // 'queued'. Another cron instance may have grabbed it already.
      const { data: claimed } = await adminClient
        .from('trace_history')
        .update({ ai_research_status: 'processing' })
        .eq('id', row.id)
        .eq('ai_research_status', 'queued')
        .select('id')
        .maybeSingle();

      if (!claimed) continue;

      processed++;

      try {
        // normalized_address is a pipe-delimited dedup key like
        //   "160 MINE LAKE CT|RALEIGH|NC|27615"
        // Pull the street portion back out before handing it to researchProperty,
        // which expects a raw street address and separate city/state/zip.
        const streetAddress = row.normalized_address.split('|')[0] || row.normalized_address;
        const research: AIResearchResult = await researchProperty(
          streetAddress,
          row.city || '',
          row.state || '',
          row.zip || '',
          row.input_owner_name || undefined,
          {
            userId: row.user_id,
            addressHash: row.address_hash,
            normalizedAddress: row.normalized_address,
            city: row.city || '',
            state: row.state || '',
            zip: row.zip || '',
          }
        );

        // Strip pending_business_trace before persisting — it's bookkeeping
        // for the async recovery path and is resolved via business_trace_jobs.
        const {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          pending_business_trace: _pendingBusinessTrace,
          ...researchForStorage
        } = research as AIResearchResult & { pending_business_trace?: unknown };

        // Determine the best person name to use for the follow-up person-
        // skip-trace. Prefer business_trace_contacts.owner_name (FastAppend
        // was authoritative), then individual_behind_business, then owner_name
        // if it doesn't itself look like a business.
        let resolvedPerson: string | null = null;
        const btContacts = researchForStorage.business_trace_contacts;
        if (btContacts?.owner_name) {
          resolvedPerson = btContacts.owner_name;
        } else if (researchForStorage.individual_behind_business) {
          resolvedPerson = researchForStorage.individual_behind_business;
        } else if (researchForStorage.owner_name && researchForStorage.owner_type === 'individual') {
          resolvedPerson = researchForStorage.owner_name;
        }

        const ownerFound = !!researchForStorage.owner_name;
        const researchCharge = ownerFound ? AI_RESEARCH.CHARGE_PER_RECORD : 0;

        // Persist research result + status, regardless of whether we found
        // a person to trace.
        await adminClient
          .from('trace_history')
          .update({
            ai_research: researchForStorage,
            ai_research_status: ownerFound ? 'found' : 'not_found',
            ai_research_charge: researchCharge,
          })
          .eq('id', row.id);

        if (researchCharge > 0) {
          await adminClient.rpc('deduct_wallet_balance', {
            p_user_id: row.user_id,
            p_amount: researchCharge,
            p_trace_history_id: row.id,
            p_description: 'AI property research (bulk API)',
          });
        }

        if (!resolvedPerson) {
          // No person to skip-trace. Mark the row as no_match so the status
          // endpoint can finalize the bulk job.
          await adminClient
            .from('trace_history')
            .update({
              status: 'no_match',
              is_successful: false,
              charge: 0,
            })
            .eq('id', row.id);
          noMatch++;
          continue;
        }

        // Submit a per-row Tracerfy person-skip-trace for the resolved name.
        const submitResult = await submitSingleTrace({
          address: streetAddress,
          city: row.city || '',
          state: row.state || '',
          zip: row.zip || '',
          owner_name: resolvedPerson,
        });

        if (!submitResult.success || !submitResult.jobId) {
          console.error(
            `[sweep-bulk-research] Tracerfy submit failed for row ${row.id}: ${submitResult.error}`
          );
          // Don't mark the row as error outright — business_trace_contacts
          // may still carry FastAppend phones/emails which are valid results.
          // Treat as no_match so the bulk job can finalize.
          await adminClient
            .from('trace_history')
            .update({
              status: 'no_match',
              is_successful: false,
              charge: 0,
            })
            .eq('id', row.id);
          noMatch++;
          continue;
        }

        // Row now has its own Tracerfy job; status endpoint will poll it.
        await adminClient
          .from('trace_history')
          .update({
            tracerfy_job_id: submitResult.jobId,
          })
          .eq('id', row.id);
        resolvedToPerson++;
      } catch (err) {
        errored++;
        console.error(`[sweep-bulk-research] row ${row.id} processing error:`, err);
        // Revert claim so the next cron run can retry this row. A persistent
        // failure will keep looping but is capped by the parent bulk job's
        // lifetime and can be manually cleared.
        await adminClient
          .from('trace_history')
          .update({ ai_research_status: 'queued' })
          .eq('id', row.id);
      }
    }

    return NextResponse.json({
      success: true,
      processed,
      resolvedToPerson,
      noMatch,
      errored,
    });
  } catch (error) {
    console.error('[sweep-bulk-research] fatal error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
