/**
 * The bounded retry ladder for TIER 2 bulk rows, the rows sweep-property-traces
 * resolves through a Tracerfy property dossier plus one contact lookup.
 *
 * WHY IT IS A SEPARATE COLUMN FROM THE ENTITY QUEUE. The long answer is in
 * supabase/migrations/20260918_property_trace_queue.sql. The short one is that
 * `ai_research_status` is named for a retired engine, is VARCHAR(20) with 19
 * characters already spent, and settles TIER 1 rows. This queue settles TIER 2
 * rows, and the two billing models disagree about the most dangerous question in
 * this codebase: a tier 1 miss is FREE, a tier 2 miss is BILLED. One column
 * holding both invites a reader, or a sweep, to answer it with the wrong one.
 *
 * WHAT THE LADDER IS FOR, AND WHAT IT IS NOT FOR. It bounds ONE failure: the
 * dossier could not be ASKED (a 5xx, a transport error, a lapsed key). Every
 * vendor call on this path returns success:false rather than throwing, so
 * without a bound a lapsed key re-queues the same oldest rows every minute
 * forever and no newer row is ever reached -- the exact starvation
 * lib/trace/entityTraceAttempts.ts was written to end.
 *
 * It is NOT for a contact-vendor failure, and that distinction is the whole of
 * this queue's money rule: once the dossier has ANSWERED, the record is bought
 * and the row is billed and settled. Retrying it would re-buy a $0.20 dossier
 * out of a shared credit pool for a record already in hand. The gate says so
 * where the money moves, in app/api/cron/sweep-property-traces/route.ts.
 *
 * WHERE THE NUMBER LIVES. In `property_trace_status` itself, which is this
 * queue's state machine and is free text, so the ladder needs no second column.
 * Attempt 1 keeps the bare 'queued' / 'processing' values, so a row enqueued by
 * any writer that does not know about the ladder reads as attempt 1 with no
 * backfill.
 *
 *   attempt 1   queued          processing
 *   attempt 2   queued_2        processing_2
 *   ...
 *   settled     property_trace_done
 *   exhausted   property_trace_failed
 *   no key      property_trace_no_key
 *
 * The column is VARCHAR(24); the longest value here is 'property_trace_failed'
 * at 21 characters. Keep any new value inside that, and see the width test in
 * __tests__/propertyTraceAttempts.test.ts.
 *
 * MONEY. Nothing on the FAILURE paths is billable. A vendor we could not ask is
 * our outage, not the customer's miss (L-007), and a row with no usable lookup
 * key was never asked about at all. Both terminal states are therefore written
 * with NO money columns in the payload, which is not the same as writing zero
 * into them: the row may be a REUSED row already carrying a tier 2 receipt, and
 * a receipt is monotonic (lib/trace/billedRows.ts). Exhaustion must not zero a
 * receipt. Do NOT copy the sentence entityTraceAttempts.ts carries about an
 * exhausted row having "no charge, no tier and no ai_research_charge" -- under
 * tier 2 a row can be exhausted AND billed.
 */

/**
 * How many times a row is handed to the dossier vendor before it is given up on.
 * The cron runs every minute (vercel.json), so this is roughly five minutes of
 * consecutive failure: long enough to ride out a restart or a short 503 storm,
 * short enough that a lapsed API key does not hold the queue shut for the rest
 * of the day. Same number as the entity ladder, for the same reasons.
 */
export const MAX_PROPERTY_TRACE_ATTEMPTS = 5;

/** `property_trace_status` for a row whose tier 2 work is finished. */
export const PROPERTY_TRACE_SETTLED_STATUS = 'property_trace_done';

/** `property_trace_status` for a row the dossier vendor could not be reached about. */
export const PROPERTY_TRACE_FAILED_STATUS = 'property_trace_failed';

/**
 * `property_trace_status` for a row that carries no key any vendor can be asked
 * with: no street, or no city, or no state. planRoute() emits no step at all for
 * such a parcel, and a row with nothing to ask is not a row to retry.
 */
export const PROPERTY_TRACE_NO_KEY_STATUS = 'property_trace_no_key';

/**
 * The sentence a customer reads when the dossier vendor could not be reached.
 * No price, because the row is free: quoting a figure on a free outcome would be
 * a false statement about money.
 */
export const PROPERTY_TRACE_FAILED_REASON =
  `We could not reach the property records service for this address after ${MAX_PROPERTY_TRACE_ATTEMPTS} tries, so nothing was traced and you were not charged. Send it again later and we will run it.`;

/**
 * The sentence a customer reads when the row had no usable address. A different
 * thing from the failure above and it must not share its wording: this one is
 * something they can fix by resending the row, and that one is our side failing
 * to reach a vendor.
 */
export const PROPERTY_TRACE_NO_KEY_REASON =
  'This row was missing the street, city or state we need to look a property up, so nothing was traced and you were not charged. Send it again with the full property address and we will run it.';

/** The queued status for a given attempt. Attempt 1 is the bare 'queued'. */
export function queuedStatusFor(attempt: number): string {
  return attempt <= 1 ? 'queued' : `queued_${attempt}`;
}

/** The claimed status for a given attempt. Attempt 1 is the bare 'processing'. */
export function processingStatusFor(attempt: number): string {
  return attempt <= 1 ? 'processing' : `processing_${attempt}`;
}

/** Every attempt number on the ladder, in order. */
export const PROPERTY_TRACE_ATTEMPTS: number[] = Array.from(
  { length: MAX_PROPERTY_TRACE_ATTEMPTS },
  (_, i) => i + 1
);

/** Every status the claim query may pick a row up from. */
export const PROPERTY_TRACE_QUEUED_STATUSES: string[] =
  PROPERTY_TRACE_ATTEMPTS.map(queuedStatusFor);

/** Every status a claimed row may be sitting in. */
export const PROPERTY_TRACE_PROCESSING_STATUSES: string[] =
  PROPERTY_TRACE_ATTEMPTS.map(processingStatusFor);

/**
 * Which attempt a status represents. Anything unrecognized reads as attempt 1,
 * which is the safe direction: it costs one extra retry, never an early give-up.
 */
export function attemptOf(status: string | null | undefined): number {
  const parsed = /^(?:queued|processing)_(\d+)$/.exec((status || '').trim());
  if (!parsed) return 1;
  const n = Number(parsed[1]);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PROPERTY_TRACE_ATTEMPTS) : 1;
}

/**
 * True while the row is still waiting on its Full Property Trace.
 *
 * This is what a bulk job's completion check reads. A terminal value that still
 * answered true here would hold the parent job at 'processing' forever.
 */
export function isPropertyTracePending(status: string | null | undefined): boolean {
  const s = (status || '').trim();
  if (!s) return false;
  return (
    PROPERTY_TRACE_QUEUED_STATUSES.includes(s) ||
    PROPERTY_TRACE_PROCESSING_STATUSES.includes(s)
  );
}

/** True when the row ran out of attempts at the dossier vendor. */
export function isPropertyTraceFailed(status: string | null | undefined): boolean {
  return status === PROPERTY_TRACE_FAILED_STATUS;
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
  if (attempt >= MAX_PROPERTY_TRACE_ATTEMPTS) {
    return { status: PROPERTY_TRACE_FAILED_STATUS, exhausted: true };
  }
  return { status: queuedStatusFor(attempt + 1), exhausted: false };
}

/**
 * The readable reason a tier 2 bulk row came back with nothing without being
 * traced, or null when there is nothing to explain.
 *
 * THE ONE ACCESSOR for this queue, the twin of skipReasonFor() in
 * lib/trace/blankOwnerSkip.ts, so the wording cannot drift between the API
 * payload, the CSV and the job summary.
 *
 * NOT YET WIRED TO ANY SURFACE. Nothing enqueues into this column until the
 * submit routes learn to (phase 5c-3), so no customer can reach either state
 * today. The surfaces that serve a bulk row must call this alongside
 * skipReasonFor() when they do, and that is 5c-3's task 9.
 */
export function propertyTraceSkipReason(status: string | null | undefined): string | null {
  if (status === PROPERTY_TRACE_FAILED_STATUS) return PROPERTY_TRACE_FAILED_REASON;
  if (status === PROPERTY_TRACE_NO_KEY_STATUS) return PROPERTY_TRACE_NO_KEY_REASON;
  return null;
}
