/**
 * The ONE question a surface asks about a row that came back with no contacts:
 * why, in words a customer can read.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN TWO CALLS AT EVERY SURFACE
 * ------------------------------------------------------------------------
 *
 * There are two queues and they have OPPOSITE billing models. `ai_research_status`
 * settles tier 1, where a row is charged per successful trace and a miss is free;
 * `property_trace_status` settles tier 2, where a row is charged per record
 * submitted and a miss is billed. Each queue owns an accessor that already writes
 * the honest sentence for its own terminal values: skipReasonFor() in
 * lib/trace/blankOwnerSkip.ts, propertyTraceSkipReason() in
 * lib/trace/propertyTraceAttempts.ts.
 *
 * Four surfaces serve a bulk row: the results CSV, the session job summary, the
 * v1 REST status payload and the MCP status payload. Every one of them called
 * skipReasonFor() alone, so every tier 2 terminal value reached the customer as
 * a bare `no_match` with nothing beside it. On a PROPERTY_TRACE_NO_REACH row
 * that is a BILLED row being told we looked and found nobody, when what actually
 * happened is that we bought the property record and the contact vendor fell
 * over. Leaving each surface to remember two calls is how three of them stay
 * right and the fourth silently does not.
 *
 * ------------------------------------------------------------------------
 * TIER 2 WINS A COLLISION, AND THAT ORDER IS THE POINT OF THE FUNCTION
 * ------------------------------------------------------------------------
 *
 * A row is written onto ONE queue. The three submit paths all write
 * `ai_research_status: null` explicitly on a tier 2 row, for the reason
 * app/api/trace/bulk/route.ts spells out: a row is REUSED rather than
 * re-inserted (UNIQUE(user_id, address_hash)), and 273 pre-5c rows still carry
 * 'skipped_no_owner' from when a blank-owner row was skipped and free.
 *
 * So a row carrying both is a row whose tier 1 value is STALE. Answering with it
 * would tell a customer "you were not charged" about a row tier 2 billed per
 * record submitted, which is the worst wrong answer available here: a false
 * statement about their own money, in their favour, on a charge they can see on
 * their wallet. The tier 2 column is the one the current engine writes, so it is
 * the one that answers.
 *
 * NOTHING IS INVENTED. Null in, null out. A row nobody skipped and no vendor
 * failed on has nothing to explain, and a surface that gets null shows nothing
 * rather than a plausible sentence (CLAUDE.md rule 7).
 */

import { skipReasonFor } from '@/lib/trace/blankOwnerSkip';
import { propertyTraceSkipReason } from '@/lib/trace/propertyTraceAttempts';

/**
 * A row read down to the two queue columns. Structural, so every caller's own
 * row type satisfies it without a cast: the v1 and MCP surfaces pass a
 * TraceHistoryRow, the CSV passes a TraceHistory, the session summary passes its
 * own narrow select.
 *
 * Both optional, because a row written before either migration carries neither
 * and absent has to read as "nothing to explain" rather than throw.
 */
export type SkipReasonRow = {
  ai_research_status?: string | null;
  property_trace_status?: string | null;
};

/**
 * Why this row came back with no contacts, or null when there is nothing to say.
 *
 * Tier 2 first, deliberately. See the header.
 */
export function rowSkipReason(row: SkipReasonRow): string | null {
  return (
    propertyTraceSkipReason(row.property_trace_status) ??
    skipReasonFor(row.ai_research_status)
  );
}
