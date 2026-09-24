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
import { isTier1QueueRow } from '@/lib/trace/tier1Queue';
import { tier1OutcomeReason, type Tier1OutcomeRow } from '@/lib/trace/tier1Outcome';

/**
 * A row read down to the two queue columns. Structural, so every caller's own
 * row type satisfies it without a cast: the v1 and MCP surfaces pass a
 * TraceHistoryRow, the CSV passes a TraceHistory, the session summary passes its
 * own narrow select.
 *
 * Both optional, because a row written before either migration carries neither
 * and absent has to read as "nothing to explain" rather than throw.
 */
export type SkipReasonRow = Tier1OutcomeRow & {
  ai_research_status?: string | null;
  property_trace_status?: string | null;
  /**
   * The bulk job this row belongs to, or explicitly null on a row a single trace wrote
   * (spec D33). A bulk upload (web, API, MCP) upserts on (user_id, address_hash) rather than
   * inserting, and never clears outcome_code on the row it reuses, so a row a single trace
   * wrote and a later bulk trace overwrote can still carry a stale Tier 1 outcome_code long
   * after everything else on the row says tier 2. `=== null`, not merely falsy: a caller that
   * did not select this column gets `undefined`, and that row gets NO Tier 1 sentence either
   * -- blank, never wrong (CLAUDE.md rule 7).
   */
  trace_job_id?: string | null;
};

/**
 * Why this row came back with no contacts, or null when there is nothing to say.
 *
 * Tier 2 first, deliberately (see the header). Then the Tier 1 outcome, for the two row shapes
 * that are allowed to serve it, and the gate is the whole subtlety of this function:
 *
 *   trace_job_id === null                 a row a SINGLE trace itself wrote (spec D33). Such a row
 *                                         clears both queue columns when it settles, so a queue
 *                                         value on it can only be stale.
 *   isTier1QueueRow(ai_research_status)   a row the WEB BULK upload wrote and the Tier 1 cron
 *                                         settled (Phase 2A). D33 chose to gate the sentence
 *                                         rather than clear the stale columns, and recorded the
 *                                         clearing as "(Phase 2 code)". The web submit now clears
 *                                         outcome_code, found_by and trace_steps on every reused
 *                                         row except a busy resume, so on THESE rows the
 *                                         outcome_code can only belong to the trace the customer
 *                                         is looking at.
 *
 * NOTHING ELSE. An API or MCP bulk row carries no tier1_ status, because those two surfaces still
 * build a Tracerfy person CSV and still do not clear a reused row's outcome (2B). They keep
 * showing exactly what they show today, which is what D33 decided and what stops a stale "You were
 * not charged" answering for a bulk trace that charged.
 *
 * `=== null`, not merely falsy, on trace_job_id: a caller that did not select the column gets
 * `undefined`, and that row gets NO Tier 1 sentence either. Blank, never wrong (CLAUDE.md rule 7).
 */
export function rowSkipReason(row: SkipReasonRow): string | null {
  const tier1MaySpeak = row.trace_job_id === null || isTier1QueueRow(row.ai_research_status);
  return (
    propertyTraceSkipReason(row.property_trace_status) ??
    (tier1MaySpeak ? tier1OutcomeReason(row) : null) ??
    skipReasonFor(row.ai_research_status)
  );
}
