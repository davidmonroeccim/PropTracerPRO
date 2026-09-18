/**
 * The bounded retry ladder for entity-owned bulk rows, the rows
 * sweep-entity-traces resolves through a FastAppend business trace.
 *
 * WHY IT EXISTS. lookupBusinessTrace() never throws. A lapsed
 * FASTAPPEND_API_KEY, a blank state and a 503 all come back the same way, as
 * success:false, and the cron answered that by writing the row back to
 * 'queued'. The claim query takes the FIVE OLDEST queued rows every minute, so
 * those same five rows were re-claimed and re-queued every minute for as long
 * as the failure lasted, and no newer row was ever reached. Nothing terminated
 * them: the v1 bulk status route reads 'queued' as pending, so the parent bulk
 * job reported 'processing' forever too.
 *
 * WHAT THIS ADDS. An attempt number that survives between cron runs, so a row
 * that keeps failing stops after a fixed number of tries, says why, and gets
 * out of the way of the rows behind it. Retrying a transient failure is still
 * correct and still happens; only the unbounded part is gone.
 *
 * WHERE THE NUMBER LIVES. In `ai_research_status` itself, which is already the
 * entity state machine and is free text, so this needs no migration and no new
 * column. Attempt 1 keeps the bare 'queued' / 'processing' values, so every row
 * written by an earlier deployment reads as attempt 1 with no backfill.
 *
 *   attempt 1   queued          processing
 *   attempt 2   queued_2        processing_2
 *   ...
 *   exhausted   entity_trace_failed
 *
 * The column is VARCHAR(20); the longest string here is 'entity_trace_failed'
 * at 19 characters. Keep any new value inside that.
 *
 * MONEY. Nothing on this path is billable. A vendor we could not ask is our
 * outage, not the customer's miss (L-007), so an exhausted row is written
 * terminal with no charge, no tier and no ai_research_charge, which is also
 * what keeps it deletable under lib/trace/billedRows.ts.
 */

/**
 * How many times a row is handed to the business-trace vendor before it is
 * given up on. The cron runs every minute (vercel.json), so this is roughly
 * five minutes of consecutive failure: long enough to ride out a restart or a
 * short 503 storm, short enough that a lapsed API key does not hold the queue
 * shut for the rest of the day.
 */
export const MAX_ENTITY_TRACE_ATTEMPTS = 5;

/** `ai_research_status` for a row the vendor could not be reached about. */
export const ENTITY_TRACE_FAILED_STATUS = 'entity_trace_failed';

/**
 * The sentence a customer reads. No price, because the row is free: quoting a
 * figure on a free outcome would be a false statement about money.
 *
 * NO RESEND INVITATION, and it is not an oversight. It ended "Send it again
 * later and we will run it" until 2026-09-18. checkDuplicates() treats any
 * trace_history row inside the 90 day window as a duplicate and the address hash
 * carries no owner, so the resend matched this row and was dropped without
 * running. An exhausted row is written status 'error', not 'processing', so the
 * stale-row escape in that function does not reach it either. The customer
 * followed the instruction and got a duplicate.
 *
 * See lib/trace/blankOwnerSkip.ts for the full reasoning and for why no accurate
 * replacement instruction exists that is true on all three surfaces.
 */
export const ENTITY_TRACE_FAILED_REASON =
  `We could not reach the business records service for this owner after ${MAX_ENTITY_TRACE_ATTEMPTS} tries, so nothing was traced and you were not charged.`;

/** The queued status for a given attempt. Attempt 1 is the bare 'queued'. */
export function queuedStatusFor(attempt: number): string {
  return attempt <= 1 ? 'queued' : `queued_${attempt}`;
}

/** The claimed status for a given attempt. Attempt 1 is the bare 'processing'. */
export function processingStatusFor(attempt: number): string {
  return attempt <= 1 ? 'processing' : `processing_${attempt}`;
}

/** Every attempt number on the ladder, in order. */
export const ENTITY_TRACE_ATTEMPTS: number[] = Array.from(
  { length: MAX_ENTITY_TRACE_ATTEMPTS },
  (_, i) => i + 1
);

/** Every status the claim query may pick a row up from. */
export const ENTITY_QUEUED_STATUSES: string[] =
  ENTITY_TRACE_ATTEMPTS.map(queuedStatusFor);

/** Every status a claimed row may be sitting in. */
export const ENTITY_PROCESSING_STATUSES: string[] =
  ENTITY_TRACE_ATTEMPTS.map(processingStatusFor);

/**
 * Which attempt a status represents. Anything unrecognized reads as attempt 1,
 * which is the safe direction: it costs one extra retry, never an early give-up.
 */
export function attemptOf(status: string | null | undefined): number {
  const parsed = /^(?:queued|processing)_(\d+)$/.exec((status || '').trim());
  if (!parsed) return 1;
  const n = Number(parsed[1]);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_ENTITY_TRACE_ATTEMPTS) : 1;
}

/** True while the row is still waiting on its business trace. */
export function isEntityTracePending(status: string | null | undefined): boolean {
  const s = (status || '').trim();
  if (!s) return false;
  return ENTITY_QUEUED_STATUSES.includes(s) || ENTITY_PROCESSING_STATUSES.includes(s);
}

/** True when the row ran out of attempts. */
export function isEntityTraceFailed(status: string | null | undefined): boolean {
  return status === ENTITY_TRACE_FAILED_STATUS;
}

/**
 * Where a row goes after the attempt it is on has failed.
 *
 * `exhausted` is the whole point: it is what stops the row being claimed again
 * and what lets the parent bulk job settle.
 */
export function nextAfterFailedAttempt(attempt: number): {
  status: string;
  exhausted: boolean;
} {
  if (attempt >= MAX_ENTITY_TRACE_ATTEMPTS) {
    return { status: ENTITY_TRACE_FAILED_STATUS, exhausted: true };
  }
  return { status: queuedStatusFor(attempt + 1), exhausted: false };
}

/**
 * The readable reason for a row that ran out of attempts, or null.
 *
 * Reached through skipReasonFor() in lib/trace/blankOwnerSkip.ts, which is the
 * one accessor every surface uses for "why did this row come back with
 * nothing", so the wording cannot drift between the API payload, the CSV and
 * the job summary.
 */
export function entityTraceFailureReason(status: string | null | undefined): string | null {
  return isEntityTraceFailed(status) ? ENTITY_TRACE_FAILED_REASON : null;
}
