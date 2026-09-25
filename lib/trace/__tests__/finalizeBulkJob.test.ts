import { describe, it, expect, vi } from 'vitest';
import {
  isRowStillWorking,
  recordsMatchedFor,
  matchedRowCount,
  totalChargeFor,
  finalizeJobIfDrained,
  type FinalizableRow,
} from '@/lib/trace/finalizeBulkJob';

const row = (o: Partial<FinalizableRow>): FinalizableRow => ({
  property_trace_status: null,
  ai_research_status: null,
  is_successful: null,
  charge: null,
  ...o,
});

describe('isRowStillWorking: BOTH queues, one question', () => {
  it('is true for a queued Tier 1 row', () => {
    expect(isRowStillWorking(row({ ai_research_status: 'tier1_queued' }))).toBe(true);
  });

  it('is true for a Tier 1 row on a later rung', () => {
    expect(isRowStillWorking(row({ ai_research_status: 'tier1_processing_3' }))).toBe(true);
  });

  it('is true for a pending tier 2 row', () => {
    expect(isRowStillWorking(row({ property_trace_status: 'queued' }))).toBe(true);
  });

  // MUTATION: drop the isTier1QueuePending arm and this goes red. That arm's absence is
  // exactly what makes the v1 and MCP surfaces finalize over live Tier 1 work today.
  it('is FALSE for a settled Tier 1 row', () => {
    expect(isRowStillWorking(row({ ai_research_status: 'tier1_done' }))).toBe(false);
  });

  it('is FALSE for a legacy entity row, which this predicate does not own', () => {
    // The legacy ladder's bare 'queued' is a DIFFERENT lane on the same column. It is held
    // open by isEntityTracePending at the call sites that still have a legacy half, never here.
    expect(isRowStillWorking(row({ ai_research_status: 'queued' }))).toBe(false);
  });

  it('is FALSE for a row on neither queue', () => {
    expect(isRowStillWorking(row({}))).toBe(false);
  });
});

describe('recordsMatchedFor: three disjoint arms', () => {
  it('counts a tier 2 success and a Tier 1 success once each, plus the legacy count', () => {
    const rows = [
      row({ property_trace_status: 'property_trace_done', is_successful: true }),
      row({ ai_research_status: 'tier1_done', is_successful: true }),
      row({ ai_research_status: 'tier1_done', is_successful: false }),
    ];
    expect(recordsMatchedFor(rows, 4)).toBe(6);
  });

  // MUTATION: change the tier 1 arm from isTier1QueueRow(...) to a bare truthiness check on
  // ai_research_status and this goes red: the legacy row would start counting.
  it('does NOT count a legacy entity row as a Tier 1 match', () => {
    const rows = [row({ ai_research_status: 'found', is_successful: true })];
    expect(recordsMatchedFor(rows, 0)).toBe(0);
  });

  it('cannot double count a row that somehow carries both columns', () => {
    const rows = [
      row({
        property_trace_status: 'property_trace_done',
        ai_research_status: 'tier1_done',
        is_successful: true,
      }),
    ];
    // Arms are evaluated in order and a row is counted at most once.
    expect(recordsMatchedFor(rows, 0)).toBe(1);
  });
});

describe('totalChargeFor', () => {
  it('sums stored per-row charges and rounds to four places', () => {
    expect(totalChargeFor([row({ charge: 0.15 }), row({ charge: 0.25 }), row({ charge: null })])).toBe(0.4);
  });
});

describe('matchedRowCount: the flat count finalizeJobIfDrained uses (Ruling A)', () => {
  it('counts every is_successful row once, regardless of which queue column it carries', () => {
    const rows = [
      row({ property_trace_status: 'property_trace_done', is_successful: true }),
      row({ ai_research_status: 'tier1_done', is_successful: true }),
      row({ ai_research_status: 'tier1_done', is_successful: false }),
    ];
    expect(matchedRowCount(rows)).toBe(2);
  });

  it('does not count a null or false is_successful row', () => {
    const rows = [row({ is_successful: null }), row({ is_successful: false })];
    expect(matchedRowCount(rows)).toBe(0);
  });

  // THE DISTINGUISHING CASE. A settled legacy-entity row and a settled Tracerfy-CSV row each
  // carry is_successful: true on a match, but NEITHER carries a value isTier1QueueRow recognizes
  // (isTier1QueueRow(null) is false, and 'found' is not on the Tier 1 ladder). recordsMatchedFor
  // scores both 0; matchedRowCount, which does not gate on either queue column, scores both 1.
  it('counts a legacy-entity success and a Tracerfy-CSV success that recordsMatchedFor scores 0', () => {
    const legacyEntitySuccess = row({ ai_research_status: 'found', is_successful: true });
    const tracerfyCsvSuccess = row({ is_successful: true }); // both queue columns null

    expect(matchedRowCount([legacyEntitySuccess])).toBe(1);
    expect(matchedRowCount([tracerfyCsvSuccess])).toBe(1);

    expect(recordsMatchedFor([legacyEntitySuccess], 0)).toBe(0);
    expect(recordsMatchedFor([tracerfyCsvSuccess], 0)).toBe(0);
  });
});

/** Minimal PostgREST-shaped stub. `jobUpdateResult` is what the .eq('status','processing') chain returns. */
function stubAdmin(rows: FinalizableRow[], jobUpdateResult: { id: string } | null) {
  const updateSpy = vi.fn();
  const eqCalls: Array<[string, unknown]> = [];
  const admin = {
    from: (table: string) => {
      if (table === 'trace_history') {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({ data: rows }),
            }),
          }),
        };
      }
      return {
        update: (payload: unknown) => {
          updateSpy(payload);
          return {
            eq: (col: string, val: unknown) => {
              eqCalls.push([col, val]);
              return {
                eq: (col2: string, val2: unknown) => {
                  eqCalls.push([col2, val2]);
                  return {
                    select: () => ({ maybeSingle: async () => ({ data: jobUpdateResult }) }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { admin: admin as never, updateSpy, eqCalls };
}

describe('finalizeJobIfDrained: the compare-and-swap', () => {
  it('does not write at all while a Tier 1 row is queued', async () => {
    const { admin, updateSpy } = stubAdmin([row({ ai_research_status: 'tier1_queued' })], { id: 'j1' });
    const out = await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(out).toEqual({ finalized: false, reason: 'still_working', pending: 1 });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // MUTATION: delete the .eq('status','processing') link and this goes red. Without it a second
  // concurrent caller also gets finalized:true and bulk_job.completed fires twice.
  it('guards the write on status=processing', async () => {
    const { admin, eqCalls } = stubAdmin([row({ ai_research_status: 'tier1_done', is_successful: true })], { id: 'j1' });
    await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(eqCalls).toEqual([['id', 'j1'], ['status', 'processing']]);
  });

  it('returns finalized:true with the counts when it WINS the swap', async () => {
    const { admin } = stubAdmin(
      [row({ ai_research_status: 'tier1_done', is_successful: true, charge: 0.15 })],
      { id: 'j1' }
    );
    const out = await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(out).toEqual({ finalized: true, recordsMatched: 1, totalCharge: 0.15 });
  });

  // THE ONE THAT MATTERS FOR THE WEBHOOK. A loser must be distinguishable from a winner.
  it('returns finalized:false when it LOSES the swap', async () => {
    const { admin } = stubAdmin([row({ ai_research_status: 'tier1_done', is_successful: true })], null);
    const out = await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(out).toEqual({ finalized: false, reason: 'already_terminal' });
  });

  // RULING A, FENCED. finalizeJobIfDrained must use matchedRowCount, not recordsMatchedFor, or a
  // settled legacy-entity row / Tracerfy-CSV row (both queue columns null) counts 0 in the
  // webhook and on trace_jobs.records_matched forever.
  it('counts a settled legacy-entity row and a Tracerfy-CSV row, which recordsMatchedFor(rows, 0) would score 0', async () => {
    const rows = [
      row({ ai_research_status: 'found', is_successful: true }), // legacy entity, settled
      row({ is_successful: true }), // Tracerfy CSV: both queue columns null
    ];
    const { admin } = stubAdmin(rows, { id: 'j1' });
    const out = await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(out).toEqual({ finalized: true, recordsMatched: 2, totalCharge: 0 });
  });
});
