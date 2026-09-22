import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rowSkipReason } from '@/lib/trace/rowSkipReason';
import { BUSY_TRY_AGAIN_REASON, OWNER_NAME_NOT_MATCHED_REASON } from '@/lib/trace/tier1Outcome';
import {
  BLANK_OWNER_SKIP_REASON,
  BLANK_OWNER_SKIP_STATUS,
} from '@/lib/trace/blankOwnerSkip';
import {
  ENTITY_TRACE_FAILED_REASON,
  ENTITY_TRACE_FAILED_STATUS,
} from '@/lib/trace/entityTraceAttempts';
import {
  PROPERTY_TRACE_FAILED_REASON,
  PROPERTY_TRACE_FAILED_STATUS,
  PROPERTY_TRACE_NO_KEY_REASON,
  PROPERTY_TRACE_NO_KEY_STATUS,
  PROPERTY_TRACE_NO_REACH_REASON,
  PROPERTY_TRACE_NO_REACH_STATUS,
  PROPERTY_TRACE_SETTLED_STATUS,
} from '@/lib/trace/propertyTraceAttempts';

/**
 * THE WIRING PHASE 5c-2 ESCALATED AND 5c-3B LANDED.
 *
 * propertyTraceSkipReason() mapped three tier 2 terminal statuses to honest
 * sentences and was connected to NOTHING. Every surface that serves a bulk row
 * called skipReasonFor(), the tier 1 accessor, on its own. So a tier 2 row that
 * failed reached the customer as a bare `no_match`, and one of the three is a
 * row that was CHARGED: the dossier answered, we billed it per record submitted,
 * and then the contact vendor fell over. That row told the customer we looked
 * and found nothing, which is the exact claim the status was created to stop.
 *
 * These tests hold two separate things. The first block is the accessor: which
 * sentence comes back for which row, and who wins a collision. The second is the
 * WIRING, asserted at the source of all four surfaces, because an accessor that
 * is right and unreferenced is the bug this dispatch existed to fix.
 */

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/**
 * A file with its full-line comments removed.
 *
 * The "must not call" assertion below needs this. These files EXPLAIN the change
 * in prose, and one of them names skipReasonFor() to say why it is no longer
 * enough on its own. Scanning the raw text makes that explanation fail the test,
 * which leaves two bad options: delete the explanation, or weaken the assertion
 * until it stops catching the real call. Dropping comment lines keeps the
 * assertion sharp and lets the file keep saying why.
 *
 * Full-line comments only, which is what this codebase writes. A trailing
 * comment is left in place rather than stripped by a regex that cannot tell a
 * comment from a `//` inside a string literal.
 */
const codeOnly = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');

describe('the reason a row came back with no contacts', () => {
  it('has nothing to say about a row that simply ran', () => {
    // CLAUDE.md rule 7: absence stays absence. A sentence here would contradict
    // the row's own status, trace_result and property_record.
    expect(rowSkipReason({})).toBeNull();
    expect(rowSkipReason({ ai_research_status: null, property_trace_status: null })).toBeNull();
    expect(
      rowSkipReason({ property_trace_status: PROPERTY_TRACE_SETTLED_STATUS })
    ).toBeNull();
    expect(rowSkipReason({ property_trace_status: 'queued' })).toBeNull();
  });

  it('still answers for both TIER 1 reasons, which were never broken', () => {
    // The point of the change was to ADD the tier 2 half, not to trade one half
    // for the other. MUTATION: drop the skipReasonFor arm and this goes red.
    expect(rowSkipReason({ ai_research_status: BLANK_OWNER_SKIP_STATUS })).toBe(
      BLANK_OWNER_SKIP_REASON
    );
    expect(rowSkipReason({ ai_research_status: ENTITY_TRACE_FAILED_STATUS })).toBe(
      ENTITY_TRACE_FAILED_REASON
    );
  });

  it('answers for all three TIER 2 reasons, which reached nobody before', () => {
    // MUTATION: drop the propertyTraceSkipReason arm and all three go red.
    expect(rowSkipReason({ property_trace_status: PROPERTY_TRACE_FAILED_STATUS })).toBe(
      PROPERTY_TRACE_FAILED_REASON
    );
    expect(rowSkipReason({ property_trace_status: PROPERTY_TRACE_NO_KEY_STATUS })).toBe(
      PROPERTY_TRACE_NO_KEY_REASON
    );
    expect(rowSkipReason({ property_trace_status: PROPERTY_TRACE_NO_REACH_STATUS })).toBe(
      PROPERTY_TRACE_NO_REACH_REASON
    );
  });

  it('lets TIER 2 win a row carrying both, because the tier 1 value is the stale one', () => {
    // THE COLLISION THAT COSTS MONEY TO GET WRONG. A row is REUSED rather than
    // re-inserted (UNIQUE(user_id, address_hash)) and 273 pre-5c rows still
    // carry 'skipped_no_owner' from when a blank-owner row was skipped and free.
    // The submit routes null that column on a tier 2 row for exactly this
    // reason, so a row holding both is a row whose tier 1 half is stale.
    //
    // Answering with the tier 1 sentence would tell a customer "you were not
    // charged" about a row tier 2 billed per record submitted. That is a false
    // statement about their own money, in their favour, on a charge they can see
    // on their wallet.
    // MUTATION: swap the ?? order in rowSkipReason and this goes red.
    const bothSet = {
      ai_research_status: BLANK_OWNER_SKIP_STATUS,
      property_trace_status: PROPERTY_TRACE_NO_REACH_STATUS,
    };
    expect(rowSkipReason(bothSet)).toBe(PROPERTY_TRACE_NO_REACH_REASON);
    expect(rowSkipReason(bothSet)).not.toContain('not charged');
  });

  it('falls through to tier 1 when the tier 2 column is set but not terminal', () => {
    // A row still on the queue has nothing to explain YET, so it must not
    // swallow a tier 1 reason that genuinely applies.
    expect(
      rowSkipReason({
        ai_research_status: ENTITY_TRACE_FAILED_STATUS,
        property_trace_status: 'queued_2',
      })
    ).toBe(ENTITY_TRACE_FAILED_REASON);
  });
});

describe('every reason carries its own charge statement', () => {
  /** All five sentences a customer can be shown, through the one accessor. */
  const EVERY_REASON = [
    rowSkipReason({ ai_research_status: BLANK_OWNER_SKIP_STATUS })!,
    rowSkipReason({ ai_research_status: ENTITY_TRACE_FAILED_STATUS })!,
    rowSkipReason({ property_trace_status: PROPERTY_TRACE_FAILED_STATUS })!,
    rowSkipReason({ property_trace_status: PROPERTY_TRACE_NO_KEY_STATUS })!,
    rowSkipReason({ property_trace_status: PROPERTY_TRACE_NO_REACH_STATUS })!,
  ];

  it('says what happened to the money on all five, not on four of them', () => {
    // THE DEFECT THIS TEST EXISTS FOR. Four of the five ended in "you were not
    // charged". The fifth, the BILLED one, said nothing about money at all and
    // relied on the reader noticing an absence. That worked only while the
    // summary heading above it made the money claim, and 5c-3B removed that
    // heading precisely because it could not be true for both kinds of row.
    // MUTATION: strip the charge sentence off PROPERTY_TRACE_NO_REACH_REASON and
    // this goes red.
    for (const reason of EVERY_REASON) {
      expect(reason, reason).toMatch(/charged/);
    }
  });

  it('quotes no price on any of them, because each caller has exactly one rate', () => {
    for (const reason of EVERY_REASON) {
      expect(reason, reason).not.toMatch(/\$|\d+\s*cent/);
    }
  });

  it('claims nobody was notified, because PTP has no alerting channel', () => {
    for (const reason of EVERY_REASON) {
      expect(reason, reason).not.toMatch(/notified|alerted|our team|looking into/i);
    }
  });

  it('never tells anyone to add funds, because their wallet is not the problem', () => {
    for (const reason of EVERY_REASON) {
      expect(reason, reason).not.toMatch(/add funds|top up|insufficient/i);
    }
  });

  it('carries no em-dash, en-dash, asterisk or emoji', () => {
    for (const reason of EVERY_REASON) {
      expect(reason, reason).not.toMatch(/[—–*]/);
      expect(reason, reason).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });

  /* ---------------------------------------------------------------- *
   * NO SENTENCE MAY GIVE ADVICE THAT FAILS WHEN FOLLOWED.
   *
   * checkDuplicates() in lib/utils/deduplication.ts treats ANY
   * trace_history row inside the DEDUPE.WINDOW_DAYS window as a
   * duplicate, excluding only STALE 'processing' rows, and the address
   * hash is normalizeAddress(address, city, state) with no owner in it.
   * An exhausted row is written status 'error', so the stale escape
   * does not reach it either.
   *
   * So "send this address again" is refused for every reason EXCEPT the
   * one that asks for a missing address part, because supplying that
   * part changes the hash and produces a genuinely new record.
   * ---------------------------------------------------------------- */

  it('never asks the customer to resend the SAME address, which dedup refuses', () => {
    // Three sentences ended with a resend invitation and all three were false
    // inside the window. One of them, the tier 2 dossier failure, became
    // customer-visible for the first time in the commit that wired this
    // accessor. MUTATION: put any of those invitations back and this goes red.
    const sameAddressResend = [
      rowSkipReason({ ai_research_status: BLANK_OWNER_SKIP_STATUS })!,
      rowSkipReason({ ai_research_status: ENTITY_TRACE_FAILED_STATUS })!,
      rowSkipReason({ property_trace_status: PROPERTY_TRACE_FAILED_STATUS })!,
      rowSkipReason({ property_trace_status: PROPERTY_TRACE_NO_REACH_STATUS })!,
    ];
    for (const reason of sameAddressResend) {
      expect(reason, reason).not.toMatch(/send it again|send them again|try again|upload it again/i);
    }
  });

  it('KEEPS the one resend instruction that is true, and does not tidy it away', () => {
    // The no-key row is the exception and the exception is the whole test: the
    // missing street, city or state is PART of the dedup hash, so doing what
    // this sentence asks produces a new record that runs. Deleting it for
    // consistency with its four siblings would remove the only actionable
    // remedy in the set.
    // MUTATION: strip the resend line from PROPERTY_TRACE_NO_KEY_REASON and this
    // goes red.
    const noKey = rowSkipReason({ property_trace_status: PROPERTY_TRACE_NO_KEY_STATUS })!;
    expect(noKey).toMatch(/send it again/i);
    expect(noKey).toContain('full property address');
  });
});

/**
 * THE WIRING ITSELF.
 *
 * Asserted at the source rather than by calling each surface, because what went
 * wrong was not a surface behaving incorrectly: it was four surfaces each
 * calling the tier 1 accessor alone and therefore behaving CONSISTENTLY and
 * wrongly. The failure has a shape a source scan catches exactly, and the
 * per-surface behaviour is already covered by those surfaces' own tests.
 */
describe('all four surfaces that serve a bulk row serve both queues', () => {
  const SURFACES: [string, string][] = [
    ['the results CSV', 'lib/trace/exportCsv.ts'],
    ['the session job summary', 'app/api/trace/bulk/status/route.ts'],
    ['the v1 REST status payload', 'app/api/v1/trace/bulk/status/route.ts'],
    ['the MCP status payload', 'lib/suite/mcp-tools.ts'],
  ];

  for (const [name, path] of SURFACES) {
    it(`${name} reads the reason through rowSkipReason`, () => {
      // MUTATION: put skipReasonFor(row.ai_research_status) back at any one of
      // these four and that one goes red, which is the regression that shipped.
      const code = codeOnly(read(path));
      expect(code).toContain('rowSkipReason');
      expect(code).not.toContain('skipReasonFor(');
    });
  }

  it('the session summary SELECTS the tier 2 column on every branch that reads it', () => {
    // A right accessor behind a select that never fetched the column is the same
    // blank cell with a longer stack trace. The already-completed branch is the
    // one every poll after the first hits and the one a reload lands on, and it
    // selected only `charge, ai_research_status`.
    const source = read('app/api/trace/bulk/status/route.ts');
    const selects = source.match(/\.select\('[^']*ai_research_status[^']*'\)/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const select of selects) {
      expect(select, select).toContain('property_trace_status');
    }
  });
});

describe('the Tier 1 outcome through the one accessor (spec 7.2)', () => {
  it('serves the Tier 1 sentence on a single-trace row', () => {
    expect(rowSkipReason({ outcome_code: 'owner_name_not_matched', is_successful: false })).toBe(OWNER_NAME_NOT_MATCHED_REASON);
  });

  it('lets a Tier 2 terminal status win over a stale Tier 1 outcome', () => {
    // A single-trace row can be re-enqueued by a bulk tier 2 submit (the row is REUSED); its stale
    // "not charged" sentence must never answer for a row tier 2 billed.
    // MUTATION: put tier1OutcomeReason first in rowSkipReason and this goes red.
    // The Tier 1 half must be able to answer on its own, or the swap below cannot show.
    expect(rowSkipReason({ outcome_code: 'owner_name_not_matched', is_successful: false })).toBe(OWNER_NAME_NOT_MATCHED_REASON);
    expect(
      rowSkipReason({ outcome_code: 'owner_name_not_matched', is_successful: false, property_trace_status: PROPERTY_TRACE_NO_REACH_STATUS })
    ).toBe(PROPERTY_TRACE_NO_REACH_REASON);
  });

  it('lets the Tier 1 outcome win over a stale ai_research_status', () => {
    // MUTATION: put skipReasonFor before tier1OutcomeReason and this goes red.
    expect(
      rowSkipReason({ outcome_code: 'busy_try_again', is_successful: false, ai_research_status: BLANK_OWNER_SKIP_STATUS })
    ).toBe(BUSY_TRY_AGAIN_REASON);
  });
});
