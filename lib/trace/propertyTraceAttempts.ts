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
 *   no contacts property_trace_no_reach
 *
 * The column is VARCHAR(24); the longest value here is
 * 'property_trace_no_reach' at 23 characters. Keep any new value inside that,
 * and see the width test in __tests__/propertyTraceAttempts.test.ts.
 *
 * THREE TERMINAL VALUES RATHER THAN ONE, AND THE THIRD IS THE ONE WORTH
 * EXPLAINING. A row whose dossier answered is billed and settled whatever the
 * contact half did, so 'property_trace_done' and 'property_trace_no_reach' carry
 * identical money. What they do not carry is the same CLAIM. A genuine contact
 * miss means we asked and the vendor has no record of this owner; a contact
 * OUTAGE means we never completed the asking. Settling both as one value tells a
 * customer who paid full price for a two-call product, and received one call,
 * that we looked and found nobody. That is a result presenting as an answer when
 * it is not one, which is the thing this project is least allowed to do.
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
 * `property_trace_status` for a row whose dossier ANSWERED and was billed, but
 * whose CONTACT vendor could not be reached at all.
 *
 * Terminal, and billed, and NOT the same state as a contact miss. The row is not
 * retried (a retry re-buys the dossier it is already holding), so this value is
 * the only durable record that the second call never happened.
 */
export const PROPERTY_TRACE_NO_REACH_STATUS = 'property_trace_no_reach';

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

/**
 * The sentence a customer reads when the property record was bought but the
 * contact service could not be reached.
 *
 * THIS ONE MUST NOT SAY "you were not charged", WHICH THE OTHER TWO DO. This row
 * WAS charged: the dossier answered and tier 2 bills per record submitted. A
 * sentence that called it free would be a false statement about the customer's
 * own money, in the opposite direction from the usual one.
 *
 * It also must not say we found nothing, because we never finished asking, and
 * it must not invite a resend: the row is now a billed tier 2 row, which every
 * cache path serves back from the database rather than re-running, so a resend
 * would return this same row. It says what happened and what they have.
 *
 * IT STATES THE CHARGE OUTRIGHT, AND THAT SECOND SENTENCE IS NOT DECORATION.
 * Its four siblings all end in "you were not charged". This one cannot, so until
 * phase 5c-3B it said nothing about money at all and left the customer to notice
 * an absence. That only worked while something ELSE on the surface made the
 * money claim. It does not any more: the job summary heading these five share
 * now makes no charge claim of its own, precisely because four of them are free
 * and this one is billed, so each sentence has to carry its own. A reader of
 * this row would otherwise get silence on the one fact that cost them money.
 *
 * No price, for the same reason as the other two: four rates exist and each
 * caller has exactly one of them. So it names the MODEL, per record submitted,
 * which is true of every tier 2 caller, rather than a figure that is true of
 * one. No claim that anyone was told, because nobody was.
 */
export const PROPERTY_TRACE_NO_REACH_REASON =
  'We found the property record for this address and saved it with your results, but we could not reach the service that looks up contacts, so no phone numbers or emails came back for it. You were charged for it, because a full property trace is charged for every record you send rather than only when contacts come back.';

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
 * Every status a row still owing its Full Property Trace can be sitting in:
 * waiting on a rung, or claimed by a worker on one.
 *
 * The set form of isPropertyTracePending() below, for the two callers that have
 * to ask the DATABASE the question rather than a value in hand -- the bulk job
 * completion gates and the shared-pool pre-flight. Derived from the same two
 * arrays the predicate reads, so a rung added to the ladder reaches both
 * automatically and they cannot answer differently about the same row.
 */
export const PROPERTY_TRACE_PENDING_STATUSES: string[] = [
  ...PROPERTY_TRACE_QUEUED_STATUSES,
  ...PROPERTY_TRACE_PROCESSING_STATUSES,
];

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
  return PROPERTY_TRACE_PENDING_STATUSES.includes(s);
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
 * WIRED AS OF PHASE 5c-3B, AND NOT DIRECTLY. Every surface reaches it through
 * rowSkipReason() in lib/trace/rowSkipReason.ts, which asks this function and
 * skipReasonFor() about the same row and knows which answer wins. Call that one
 * rather than this one from a surface: a surface that serves only this misses
 * the tier 1 reasons, and a surface that serves only skipReasonFor() is the bug
 * described below.
 *
 * WHAT THE WIRING IS FOR. Until it existed, a PROPERTY_TRACE_NO_REACH row
 * reached the customer as a bare `status = 'no_match'` on a row they were
 * charged full price for, which is exactly the claim this value was created to
 * stop being made. The status column carries the truth; this function is the
 * only thing that says it out loud. The same dependency is why blankOwnerSkip.ts
 * says a skipped row "is never silent": the pattern only works once the surface
 * serves the reason.
 */
export function propertyTraceSkipReason(status: string | null | undefined): string | null {
  if (status === PROPERTY_TRACE_FAILED_STATUS) return PROPERTY_TRACE_FAILED_REASON;
  if (status === PROPERTY_TRACE_NO_KEY_STATUS) return PROPERTY_TRACE_NO_KEY_REASON;
  if (status === PROPERTY_TRACE_NO_REACH_STATUS) return PROPERTY_TRACE_NO_REACH_REASON;
  return null;
}
