// Real, already-billed charge per bulk job, summed from the per-row
// trace_history.charge values the settle path wrote at settle time.
//
// NEVER compute a historical charge as records_matched x a live rate. The rate
// moves, the history does not, so the moment a pricing constant changes every
// past bulk job would display a number the user was never charged. The amount
// actually billed is already stored per row (supabase/schema.sql, trace_history
// .charge), so read it.

import type { SupabaseClient } from '@supabase/supabase-js';

type ChargeRow = {
  trace_job_id: string | null;
  tracerfy_job_id: string | null;
  charge: number | null;
};

export type BulkJobRef = { id: string; tracerfy_job_id: string | null };

/**
 * Sum the stored per-row charges for each of `jobs`, keyed by trace_jobs.id.
 *
 * Rows link to their job by `trace_job_id` (added by the 2026-04-11 migration).
 * Rows written before that migration carry NULL there and are reachable only
 * through the shared `tracerfy_job_id`, so both keys are read.
 *
 * A job with no reachable rows is ABSENT from the map rather than present at 0.
 * The caller must render nothing for it, not a fabricated total.
 */
export async function getBulkJobCharges(
  supabase: SupabaseClient,
  userId: string,
  jobs: BulkJobRef[]
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  if (jobs.length === 0) return totals;

  const jobIds = jobs.map((j) => j.id);
  const tracerfyToJob = new Map<string, string>();
  for (const j of jobs) {
    if (j.tracerfy_job_id) tracerfyToJob.set(j.tracerfy_job_id, j.id);
  }

  const add = (jobId: string, charge: number | null) =>
    totals.set(jobId, (totals.get(jobId) ?? 0) + (charge || 0));

  const { data: linkedRaw } = await supabase
    .from('trace_history')
    .select('trace_job_id, tracerfy_job_id, charge')
    .eq('user_id', userId)
    .in('trace_job_id', jobIds);

  for (const row of (linkedRaw || []) as ChargeRow[]) {
    if (row.trace_job_id) add(row.trace_job_id, row.charge);
  }

  // Legacy rows, written before trace_job_id existed: reach them through the
  // bulk job's shared Tracerfy job id.
  const tracerfyIds = [...tracerfyToJob.keys()];
  if (tracerfyIds.length > 0) {
    const { data: legacyRaw } = await supabase
      .from('trace_history')
      .select('trace_job_id, tracerfy_job_id, charge')
      .eq('user_id', userId)
      .is('trace_job_id', null)
      .in('tracerfy_job_id', tracerfyIds);

    for (const row of (legacyRaw || []) as ChargeRow[]) {
      const jobId = row.tracerfy_job_id
        ? tracerfyToJob.get(row.tracerfy_job_id)
        : undefined;
      if (jobId) add(jobId, row.charge);
    }
  }

  return totals;
}
