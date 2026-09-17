/**
 * The one definition of "this bulk row arrived with no owner name, so we did
 * not trace it and did not charge for it".
 *
 * WHY IT EXISTS. Until 2026-09-17 a bulk row with a blank owner_name was queued
 * for the AI Search engine, which went and found an owner from the open web.
 * That engine is gone. Nothing on the bulk path can resolve an owner from an
 * address alone yet, so the row has no route.
 *
 * The rule David set: accept the file, skip the row, say why, charge nothing.
 * The thing it is NOT allowed to be is a bare `no_match`, which reads to a
 * customer as "we looked and found nobody" when we never looked at all.
 *
 * HOW IT IS RECORDED. `trace_history.ai_research_status` is set to
 * BLANK_OWNER_SKIP_STATUS. That column is already the bulk state machine and it
 * is free text, so this needs no migration and no new CHECK value on
 * `trace_history.status` (which is constrained to six values and is read by the
 * dashboard). The row's `status` still settles to 'no_match' so the bulk job can
 * finish, but every surface that serves the row also serves skipReasonFor(),
 * so the no_match is never silent.
 *
 * Nothing here is charged: charge, ai_research_charge and tier all stay at
 * their unbilled values, which is also what keeps the row deletable by
 * lib/trace/billedRows.ts (a skipped row is not a receipt).
 */

import { entityTraceFailureReason } from '@/lib/trace/entityTraceAttempts';

/** `ai_research_status` for a row we declined to trace because it had no owner name. */
export const BLANK_OWNER_SKIP_STATUS = 'skipped_no_owner';

/**
 * The sentence a customer reads. Plain language, no price: the row is free, and
 * quoting any figure on a free outcome would be a false statement about money.
 */
export const BLANK_OWNER_SKIP_REASON =
  'No owner name came in for this address, so there was nothing to trace and you were not charged. Send it again with the owner of record and we will run it.';

/** True when this row was skipped for a blank owner rather than traced. */
export function isBlankOwnerSkip(aiResearchStatus: string | null | undefined): boolean {
  return aiResearchStatus === BLANK_OWNER_SKIP_STATUS;
}

/**
 * The readable reason for a row, or null when there is nothing to explain.
 *
 * THE ONE ACCESSOR for "why did this row come back with nothing without being
 * traced". Every surface that reports such a row goes through this, so the
 * wording cannot drift between the API payload, the CSV and the job summary.
 *
 * There are two ways to land here and they are not the same thing to a
 * customer. A blank owner is something they can fix by resending the row with
 * the owner of record. An exhausted entity trace is OUR side failing to reach
 * the vendor, and the row is free either way.
 */
export function skipReasonFor(aiResearchStatus: string | null | undefined): string | null {
  if (isBlankOwnerSkip(aiResearchStatus)) return BLANK_OWNER_SKIP_REASON;
  return entityTraceFailureReason(aiResearchStatus);
}
