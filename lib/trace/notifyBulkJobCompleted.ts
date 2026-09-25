import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * FIRE bulk_job.completed FOR A JOB finalizeTouchedJobs JUST FINALIZED, AND NOWHERE ELSE.
 *
 * WHY THIS MODULE EXISTS (controller ruling). Before Task 2, `bulk_job.completed` was fired from
 * three inline copies (the web status route, the v1 status route, sweep-stale-traces) with no
 * shared dispatcher. Task 2 adds two more callers -- the two crons Phase 2B now finalizes jobs
 * from -- and copying sweep-stale-traces' fetch call into both would make it a fourth and a fifth
 * inline copy of the exact thing lib/trace/finalizeBulkJob.ts exists to stop happening to
 * records_matched. So there is one small module instead, and both crons call it once per job
 * finalizeTouchedJobs returned as a winner.
 *
 * KEPT OUT OF finalizeBulkJob.ts ON PURPOSE. That module is PostgREST-only and its tests stub only
 * PostgREST; a `fetch` inside it would change its character and make it harder to fence (it is also
 * why THIS module's own tests stub `fetch` directly rather than reusing that file's stub).
 *
 * THE CALLER NEVER PASSES `finalized`. There is no such parameter, on purpose: this function reads
 * the job by id and fires unconditionally once it has a webhook URL. The one-shot guarantee comes
 * entirely from finalizeTouchedJobs only ever returning WINNERS (finalized: true) -- a caller that
 * lost the compare-and-swap is never in the array this is looped over, so it is structurally
 * impossible to notify a job twice or notify one nobody actually finalized.
 *
 * SAME PAYLOAD SHAPE SWEEP-STALE-TRACES HAS FIRED SINCE BEFORE THIS PHASE: fetch(...).catch(...),
 * no retry, no signing header, event 'bulk_job.completed' with job_id / records_submitted /
 * records_matched / timestamp. Not inventing new copy (global constraint): these are the same keys,
 * same event name, an integrator already receives from the other two copies.
 *
 * NEVER TREAT A FAILED READ AS AN EMPTY JOB (the same amendment finalizeJobIfDrained carries). A
 * Supabase error reading trace_jobs or user_profiles is not "there is no webhook to fire" -- it is
 * "we do not know" -- so both are logged and this function returns without firing, rather than
 * treating a missing read as license to skip silently or to fire at an undefined URL.
 */
export async function notifyBulkJobCompleted(
  admin: SupabaseClient,
  jobId: string,
  recordsMatched: number
): Promise<void> {
  const { data: job, error: jobError } = await admin
    .from('trace_jobs')
    .select('user_id, records_submitted')
    .eq('id', jobId)
    .single();

  if (jobError) {
    console.error(
      `[notifyBulkJobCompleted] failed to read trace_jobs ${jobId}: ${jobError.message}`
    );
    return;
  }
  if (!job) {
    console.error(`[notifyBulkJobCompleted] trace_jobs row not found for ${jobId}`);
    return;
  }

  const { data: profile, error: profileError } = await admin
    .from('user_profiles')
    .select('webhook_url')
    .eq('id', job.user_id)
    .single();

  if (profileError) {
    console.error(
      `[notifyBulkJobCompleted] failed to read user_profiles for ${job.user_id}: ${profileError.message}`
    );
    return;
  }
  if (!profile?.webhook_url) return;

  fetch(profile.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'bulk_job.completed',
      job_id: jobId,
      records_submitted: job.records_submitted,
      records_matched: recordsMatched,
      timestamp: new Date().toISOString(),
    }),
  }).catch((err) => console.error('Cron bulk webhook error:', err));
}
