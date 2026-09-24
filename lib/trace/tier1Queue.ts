/**
 * The TIER 1 bulk queue: the rungs, terminals and predicates for a supplied-owner bulk row that
 * app/api/cron/sweep-entity-traces works through planRoute() and executeRoute().
 *
 * WHY IT IS THIS COLUMN AND NOT A THIRD ONE. Spec 3.2: "It extends today's company queue
 * (ai_research_status, ai_research_claimed_at, lib/trace/entityTraceAttempts.ts) rather than
 * adding a second one, and sweep-entity-traces becomes the Tier 1 cron." So this ladder writes
 * into ai_research_status beside the legacy entity ladder, and the safety of that rests entirely
 * on ONE property: the two value sets are DISJOINT. The Tier 1 lane claims
 * `.in(TIER1_QUEUED_STATUSES)` and the entity lane claims `.in(ENTITY_QUEUED_STATUSES)`; a single
 * value in both sets would be one row worked twice, by two lanes, under two settle shapes.
 * __tests__/tier1Queue.test.ts asserts the disjointness directly.
 *
 * WHY ATTEMPT 1 IS NOT A BARE 'queued'. Both older ladders (entityTraceAttempts.ts,
 * propertyTraceAttempts.ts) keep the bare 'queued' and 'processing' for attempt 1, because each
 * was retrofitted onto a column whose existing rows had to keep reading as attempt 1 with no
 * backfill. This ladder has no history to be compatible with, and it shares its column, so a
 * bare 'queued' here would be claimed by the entity lane and handed to FastAppend with no route
 * at all. Every value carries the tier1_ prefix.
 *
 * WHAT THE LADDER IS FOR, AND IT IS NARROWER THAN THE OTHER TWO. A DEAD CLAIM, and nothing else.
 * Under D7 and spec 5.1 a Tier 1 record is never retried after a VENDOR failure: the record ends
 * busy_try_again at once, free, and the customer is told to try again in 5 minutes. So the vendor
 * branch in the cron does NOT walk this ladder; it writes the row terminal. The rungs exist for
 * the one case spec 5.1 does recover automatically: "A crash on OUR side (a claim that never
 * finished) is still recovered automatically: after a stale-claim cutoff the row is picked up
 * again and continues from its step log." A claim that never came back is a SPENT attempt, so a
 * row that kills the run every time retires instead of holding a claim slot forever, which is the
 * starvation both older ladders were written to end.
 *
 * TWO TERMINALS, NOT FOUR. propertyTraceAttempts.ts needs four because the tier 2 reason lives in
 * its status column. The Tier 1 reason does not: it lives in `outcome_code` and is rendered by
 * tier1OutcomeReason() (lib/trace/tier1Outcome.ts), which did not exist when the entity ladder was
 * built. So:
 *
 *   tier1_done    the cron is finished with this row, whatever the outcome was. The outcome code
 *                 says which, including busy_try_again on a vendor failure.
 *   tier1_failed  five claims in a row died before finishing. Free. The cron writes outcome_code
 *                 busy_try_again with it, because that is the true and already-approved sentence
 *                 for "our system could not complete this, you were not charged, try again in 5
 *                 minutes", and it is one of exactly two outcomes allowed to invite a resend
 *                 (spec 7.3).
 *
 * MONEY. Nothing on the failure paths is billable: a vendor we could not ask is our outage, not
 * the customer's miss (L-007). But do NOT copy entityTraceAttempts.ts's sentence about an
 * exhausted row being written "with no charge, no tier and no ai_research_charge", because a
 * trace_history row is REUSED rather than re-inserted (UNIQUE(user_id, address_hash)), so it can
 * already carry a tier 2 receipt, and a receipt is monotonic (lib/trace/billedRows.ts). The cron
 * writes no money columns on these paths, which is not the same as writing zero into them.
 *
 * The column is VARCHAR(20). The longest value here is 'tier1_processing_5' at 18 characters.
 * Keep any new value inside that, and see the width test.
 */

/**
 * How many times a row is CLAIMED before the cron gives up on it. Only a dead claim spends one
 * (see the header), and the cron runs every minute, so this is roughly five minutes of runs that
 * keep dying on the same row. Same number as both older ladders, for the same reasons.
 */
export const TIER1_MAX_ATTEMPTS = 5

/** `ai_research_status` for a row whose Tier 1 queue work is finished, whatever the outcome. */
export const TIER1_SETTLED_STATUS = 'tier1_done'

/** `ai_research_status` for a row whose claims kept dying. Free, terminal, resendable. */
export const TIER1_FAILED_STATUS = 'tier1_failed'

/** The queued status for a given attempt. Attempt 1 is `tier1_queued`, NEVER a bare `queued`. */
export function tier1QueuedStatusFor(attempt: number): string {
  return attempt <= 1 ? 'tier1_queued' : `tier1_queued_${attempt}`
}

/** The claimed status for a given attempt. Attempt 1 is `tier1_processing`. */
export function tier1ProcessingStatusFor(attempt: number): string {
  return attempt <= 1 ? 'tier1_processing' : `tier1_processing_${attempt}`
}

/** Every attempt number on the ladder, in order. */
export const TIER1_ATTEMPTS: number[] = Array.from(
  { length: TIER1_MAX_ATTEMPTS },
  (_, i) => i + 1
)

/** Every status the Tier 1 claim query may pick a row up from. */
export const TIER1_QUEUED_STATUSES: string[] = TIER1_ATTEMPTS.map(tier1QueuedStatusFor)

/** Every status a claimed Tier 1 row may be sitting in. */
export const TIER1_PROCESSING_STATUSES: string[] = TIER1_ATTEMPTS.map(tier1ProcessingStatusFor)

/**
 * Every status a row still owing its Tier 1 trace can be sitting in: waiting on a rung, or
 * claimed by a worker on one.
 *
 * The set form of isTier1QueuePending(), for the callers that have to ask the DATABASE rather
 * than a value in hand: the bulk job completion gate and the wallet reserve. Derived from the same
 * two arrays the predicate reads, so a rung added to the ladder reaches both automatically and
 * they cannot answer differently about the same row.
 */
export const TIER1_PENDING_STATUSES: string[] = [
  ...TIER1_QUEUED_STATUSES,
  ...TIER1_PROCESSING_STATUSES,
]

/**
 * Which attempt a status represents. Anything unrecognized reads as attempt 1, which is the safe
 * direction: it costs one extra claim, never an early give-up. Above the ladder clamps to the last
 * rung rather than inventing one.
 */
export function tier1AttemptOf(status: string | null | undefined): number {
  const parsed = /^tier1_(?:queued|processing)_(\d+)$/.exec((status || '').trim())
  if (!parsed) return 1
  const n = Number(parsed[1])
  return Number.isFinite(n) && n >= 1 ? Math.min(n, TIER1_MAX_ATTEMPTS) : 1
}

/**
 * True while the row is still waiting on, or being worked for, its Tier 1 trace.
 *
 * This is what the bulk job's completion check reads, and what the two single routes' live-work
 * guard reads. A terminal value that answered true here would hold the parent job at 'processing'
 * forever; a pending value that answered false would let a single trace race the cron for the row.
 */
export function isTier1QueuePending(status: string | null | undefined): boolean {
  const s = (status || '').trim()
  if (!s) return false
  return TIER1_PENDING_STATUSES.includes(s)
}

/**
 * True when this row belongs to the Tier 1 lane AT ALL, terminals included.
 *
 * The wider question, and the one lib/trace/rowSkipReason.ts asks (the D33 bulk half): a SETTLED
 * Tier 1 bulk row is precisely the row whose own outcome sentence has to be served, and it is
 * settled, so isTier1QueuePending() is false for it. It is also how the status route counts Tier 1
 * bulk matches without double-counting the legacy CSV half.
 */
export function isTier1QueueRow(status: string | null | undefined): boolean {
  const s = (status || '').trim()
  if (!s) return false
  return (
    TIER1_PENDING_STATUSES.includes(s) ||
    s === TIER1_SETTLED_STATUS ||
    s === TIER1_FAILED_STATUS
  )
}

/**
 * Where a row goes after the CLAIM it was on died without finishing.
 *
 * `exhausted` is the whole point: it is what stops the row being claimed again and what lets the
 * parent bulk job settle.
 */
export function tier1NextAfterFailedAttempt(attempt: number): {
  status: string
  exhausted: boolean
} {
  if (attempt >= TIER1_MAX_ATTEMPTS) {
    return { status: TIER1_FAILED_STATUS, exhausted: true }
  }
  return { status: tier1QueuedStatusFor(attempt + 1), exhausted: false }
}
