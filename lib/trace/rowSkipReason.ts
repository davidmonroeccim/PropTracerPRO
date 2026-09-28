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
 * SIX CALLERS serve a bulk row's reason at HEAD, and the list has grown twice
 * since this dispatch was written:
 *
 *   lib/trace/exportCsv.ts                  the results CSV (a TraceHistory)
 *   app/api/trace/bulk/status/route.ts      the session job summary (its own narrow select)
 *   app/api/v1/trace/bulk/status/route.ts   the v1 REST status payload (a TraceHistoryRow)
 *   lib/suite/mcp-tools.ts bulkStatus       the MCP status payload (a TraceHistoryRow)
 *   app/(dashboard)/history/page.tsx        the history page (a TraceHistory)
 *   lib/suite/mcp-tools.ts listTraces       list_traces (a bespoke `skipRow` object literal)
 *
 * The four this dispatch was built for each called skipReasonFor() alone, so every
 * tier 2 terminal value reached the customer as a bare `no_match` with nothing
 * beside it. On a PROPERTY_TRACE_NO_REACH row that is a BILLED row being told we
 * looked and found nobody, when what actually happened is that we bought the
 * property record and the contact vendor fell over. Leaving each surface to
 * remember two calls is how most of them stay right and one silently does not,
 * and every caller added since is another chance at that.
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
 * A row read down to the two queue columns. Structural, so every caller's own row
 * type satisfies it without a cast. SIX callers (see the header above) carry FOUR
 * distinct shapes between them:
 *
 *   TraceHistoryRow        the v1 status route, and mcp-tools' bulkStatus
 *   TraceHistory           the results CSV, and app/(dashboard)/history/page.tsx
 *   a narrow select        app/api/trace/bulk/status/route.ts's own SkipRow
 *   a bare object literal  mcp-tools' listTraces builds `skipRow` by hand
 *
 * DO NOT TIGHTEN THIS TYPE on the strength of the first two. The hand-built literal
 * and the narrow select are why structural-and-optional is the only shape that
 * works here: neither is a named row type that can be widened to meet a stricter
 * one.
 *
 * Both queue columns optional, because a row written before either migration
 * carries neither and absent has to read as "nothing to explain" rather than throw.
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
 *   isTier1QueueRow(ai_research_status)   a row a BULK upload wrote (web, API or MCP) and the cron
 *                                         settled (Phase 2A). D33 chose to gate the sentence
 *                                         rather than clear the stale columns, and recorded the
 *                                         clearing as "(Phase 2 code)". All three now clear
 *                                         outcome_code, found_by and trace_steps on every reused
 *                                         row except a busy resume, so on THESE rows the
 *                                         outcome_code can only belong to the trace the customer
 *                                         is looking at.
 *
 * AS OF PHASE 2B THAT BRANCH COVERS EVERY BULK SURFACE, AND THE INTERLOCK RELEASED ITSELF.
 * The branch above says WEB BULK because the web upload was the only bulk submit writing a tier1_
 * status when D33 was written. Tasks 4 and 6 put the other two on the same queue. All three bulk
 * submits (app/api/trace/bulk, app/api/v1/trace/bulk, lib/suite/mcp-tools skipTraceBulk) now write
 * `ai_research_status: tier1QueuedStatusFor(1)` on their Tier 1 records, none of them submits a
 * Tracerfy person CSV any more, and all three clear outcome_code, found_by and trace_steps on every
 * reused row except a busy resume. So the second branch opens for their rows BY CONSTRUCTION, and
 * that is exactly why this file needed no edit in Phase 2B: the condition D33 wrote in advance
 * became true underneath it. lib/trace/__tests__/rowSkipReason.test.ts fences the claim from both
 * ends -- the gate accepts the statuses the lifecycle produces, AND the two submits Tasks 4 and 6
 * moved really write one -- because without the second half a revert would silently re-close the
 * gate while the first half stayed green.
 *
 * THE GATE IS STILL THE THING DOING THE WORK, which is what the previous version of this paragraph
 * was protecting even though every factual clause in it had gone false. A row reaches the Tier 1
 * sentence only once it is ON the Tier 1 queue, so a reused row carrying nothing but a stale
 * outcome_code from an earlier single trace still stays silent. That is what stops a stale "You
 * were not charged" answering for a bulk trace that charged, which would be a false statement
 * about a customer's own money, in their favour, on a charge they can see on their wallet.
 *
 * `=== null`, not merely falsy, on trace_job_id: a caller that did not select the column gets
 * `undefined`, and that row gets NO Tier 1 sentence either. Blank, never wrong (CLAUDE.md rule 7).
 */
/**
 * Whether this row's Tier 1 outcome is one we TRUST, and therefore one any surface may report.
 *
 * EXPORTED BECAUSE THREE PAYLOADS NEED THE SAME ANSWER, AND ONE DERIVATION IS THE POINT.
 * `skip_reason` was gated here while `outcome_code` and `found_by` were echoed raw next to it, so
 * a gate-closed row came back as `outcome_code: "no_match"` beside `skip_reason: null`. That is not
 * a smaller version of the sentence, it is the same claim by another route: the approved bulk_status
 * description tells the caller "no_match means we looked this owner up and found no match, and the
 * record was not charged", so the raw code hands over the exact "not charged" claim this gate exists
 * to withhold from a bulk trace that charged.
 *
 * So the three outcome fields speak together or stay silent together, and the predicate they agree
 * on lives HERE, once. Copying `trace_job_id === null || isTier1QueueRow(...)` into each payload
 * would be three places for a money-safety rule to drift apart, which is the same mistake as a
 * second price derivation.
 *
 * Null is the honest answer for a row whose outcome we do not trust (CLAUDE.md rule 7). Nothing a
 * current writer produces is affected: the reuse clear nulls all three columns, and a busy resume is
 * re-queued with a tier1_ status, so its gate is open. The population this silences is rows the v1
 * and MCP bulk submits wrote BEFORE Tasks 4 and 6 added that clear -- trace_job_id set, no tier1_
 * status, a stale outcome_code left by some earlier single trace on the same address_hash. list_traces
 * has no date floor, so those rows stay re-pollable indefinitely.
 */
export function tier1MaySpeak(row: SkipReasonRow): boolean {
  return row.trace_job_id === null || isTier1QueueRow(row.ai_research_status);
}

export function rowSkipReason(row: SkipReasonRow): string | null {
  return (
    propertyTraceSkipReason(row.property_trace_status) ??
    (tier1MaySpeak(row) ? tier1OutcomeReason(row) : null) ??
    skipReasonFor(row.ai_research_status)
  );
}
