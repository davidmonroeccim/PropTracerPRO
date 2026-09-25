import type { SupabaseClient } from '@supabase/supabase-js';
import { isPropertyTracePending } from './propertyTraceAttempts';
import { isTier1QueuePending, isTier1QueueRow } from './tier1Queue';

/**
 * THE ONE ANSWER TO "IS THIS BULK JOB FINISHED", AND THE ONE WRITER THAT ENDS IT.
 *
 * WHAT WAS HERE BEFORE. Five places computed records_matched and they disagreed: the web status
 * route used three disjoint arms, the v1 status route and the MCP bulk_status tool used a flat
 * is_successful count, and sweep-stale-traces used a flat count in one branch and a Tracerfy-loop
 * count in another. Two places asked "still working" and the v1 and MCP surfaces asked it with
 * isEntityTracePending, which contains no tier1_ value at all -- so either of them would have
 * finalized a job over live, billable Tier 1 work the moment Phase 2B enqueued one.
 *
 * WHY THE TERMINAL WRITE IS A COMPARE-AND-SWAP. Every trace_jobs.status write in this repo is a
 * bare .eq('id', ...) after a gate evaluated earlier in the same handler, which is a read-then-write
 * race. Phase 2B adds cron callers, so two workers can settle a job's last two rows in the same
 * instant and both read zero pending. The .eq('status', 'processing') predicate makes the database
 * pick one. Its non-null result is also the only fire-once signal bulk_job.completed has ever had:
 * that webhook is documented as one-shot and has no dispatched flag anywhere.
 *
 * THIS FUNCTION MOVES NO MONEY. Charges are settled per record, by the crons and the status routes,
 * long before a job is finalized. A job's completion is bookkeeping about work already billed.
 *
 * TWO record-count FUNCTIONS LIVE HERE, NOT ONE, AND THAT IS DELIBERATE (controller ruling, see
 * matchedRowCount below for the reasoning). recordsMatchedFor is the web status route's derivation;
 * matchedRowCount is finalizeJobIfDrained's. They disagree on a settled legacy-entity row and on a
 * settled Tracerfy-CSV row -- both real, both live on this deploy -- and that disagreement collapses
 * to one count in Phase 4, when the legacy and CSV lanes are deleted. A reader who finds two counts
 * and no explanation will be tempted to delete one; don't.
 */

export interface FinalizableRow {
  property_trace_status: string | null;
  ai_research_status: string | null;
  is_successful: boolean | null;
  charge?: number | null;
}

/**
 * Does this row still owe a cron some work?
 *
 * TWO QUEUES, ONE QUESTION. `property_trace_status` is the tier 2 queue; `ai_research_status`
 * carries the TIER 1 queue (spec 3.2). A row is on at most one of them: every submit path writes
 * null into the other.
 *
 * THE LEGACY ENTITY LADDER IS DELIBERATELY NOT HERE. Its bare `queued`/`processing` values share
 * the ai_research_status column but are a different lane with a different cron. A caller that still
 * has legacy rows in flight asks isEntityTracePending as well; see the v1 status route.
 */
export const isRowStillWorking = (row: FinalizableRow): boolean =>
  isPropertyTracePending(row.property_trace_status) || isTier1QueuePending(row.ai_research_status);

/**
 * THREE DISJOINT ARMS, and the disjointness is what stops a row counting twice.
 *   tier1Matched          the legacy Tracerfy CSV half, counted from the vendor's own results by
 *                         the caller's own loop. Those rows carry NEITHER queue column, which is
 *                         why the caller has to supply the number rather than this function
 *                         deriving it. Pass 0 on a surface with no CSV half.
 *   property_trace_status the tier 2 queue.
 *   ai_research_status    the TIER 1 queue. Keyed on isTier1QueueRow, never on bare truthiness,
 *                         or a legacy `found` row starts counting as a Tier 1 match.
 *
 * SERVES: the web status route (app/api/trace/bulk/status/route.ts) ONLY. That route still reads
 * its own rows and runs its own Tracerfy loop, so it supplies a live `tier1Matched` this function
 * cannot derive on its own. finalizeJobIfDrained does NOT call this -- see matchedRowCount, its
 * count, immediately below.
 */
export const recordsMatchedFor = (rows: FinalizableRow[], tier1Matched: number): number =>
  tier1Matched +
  rows.filter((r) => r.property_trace_status && r.is_successful).length +
  rows.filter(
    (r) => !r.property_trace_status && isTier1QueueRow(r.ai_research_status) && r.is_successful
  ).length;

/**
 * SERVES: finalizeJobIfDrained, the terminal writer, and ONLY that writer.
 *
 * WHY A FLAT COUNT AND NOT recordsMatchedFor's disjoint arms. recordsMatchedFor's tier-1 arm is
 * keyed on isTier1QueueRow(ai_research_status), and isTier1QueueRow(null) is false. Two kinds of
 * settled, matched row carry BOTH queue columns null and is_successful: true: a legacy entity row
 * settled `found` (ai_research_status = 'found', a value isTier1QueueRow does not recognize), and a
 * Tracerfy-CSV person row (lib/trace/settleBulkJob.ts never writes ai_research_status at all -- it
 * only appears in that file's row interface, at :41). recordsMatchedFor scores each of those rows
 * 0. Those rows are not historical: spec 3.3 keeps both lanes settling until Phase 4, and they
 * exist on jobs in flight across this deploy. Undercounting them would write a permanently wrong
 * records_matched onto trace_jobs and into the bulk_job.completed webhook. So the terminal writer
 * counts what actually settled -- every row with is_successful: true -- rather than what the two
 * queue columns can explain. This collapses to one count in Phase 4 when the legacy and CSV lanes
 * are deleted.
 */
export const matchedRowCount = (rows: FinalizableRow[]): number =>
  rows.filter((r) => r.is_successful).length;

/** Sum of the STORED per-row charges, which is the only figure that includes what a cron booked. */
export const totalChargeFor = (rows: FinalizableRow[]): number =>
  Number(rows.reduce((sum, r) => sum + (r.charge || 0), 0).toFixed(4));

export type FinalizeOutcome =
  | { finalized: false; reason: 'still_working'; pending: number }
  | { finalized: false; reason: 'already_terminal' }
  | { finalized: true; recordsMatched: number; totalCharge: number };

/**
 * Read the job's rows, and if nothing is still working, write the job terminal ONCE.
 *
 * `finalized: true` is returned to exactly one caller, ever, for a given job. Fire
 * bulk_job.completed on that and nothing else.
 */
export async function finalizeJobIfDrained(
  admin: SupabaseClient,
  opts: { jobId: string; userId: string }
): Promise<FinalizeOutcome> {
  const { data } = await admin
    .from('trace_history')
    .select('property_trace_status, ai_research_status, is_successful, charge')
    .eq('user_id', opts.userId)
    .eq('trace_job_id', opts.jobId);
  const rows = (data || []) as FinalizableRow[];

  const pending = rows.filter(isRowStillWorking).length;
  if (pending > 0) return { finalized: false, reason: 'still_working', pending };

  const recordsMatched = matchedRowCount(rows);
  const totalCharge = totalChargeFor(rows);

  // THE COMPARE-AND-SWAP. Only the caller that flips 'processing' to 'completed' gets true back.
  const { data: won } = await admin
    .from('trace_jobs')
    .update({
      status: 'completed',
      records_matched: recordsMatched,
      completed_at: new Date().toISOString(),
    })
    .eq('id', opts.jobId)
    .eq('status', 'processing')
    .select('id')
    .maybeSingle();

  if (!won) return { finalized: false, reason: 'already_terminal' };
  return { finalized: true, recordsMatched, totalCharge };
}
