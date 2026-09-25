import { describe, it, expect, vi } from 'vitest';
import {
  isRowStillWorking,
  recordsMatchedFor,
  matchedRowCount,
  totalChargeFor,
  finalizeJobIfDrained,
  finalizeTouchedJobs,
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
  // MUTATION: drop the isTier1QueuePending arm and these two go red. That arm's absence is exactly
  // what makes the v1 and MCP surfaces finalize over live Tier 1 work today. (Moved here from
  // above the settled-row test below, which stays green under this mutation: dropping the arm
  // makes a queued/processing row read as NOT still working, which these two tests catch and the
  // settled-row test, which expects false either way, does not.)
  it('is true for a queued Tier 1 row', () => {
    expect(isRowStillWorking(row({ ai_research_status: 'tier1_queued' }))).toBe(true);
  });

  it('is true for a Tier 1 row on a later rung', () => {
    expect(isRowStillWorking(row({ ai_research_status: 'tier1_processing_3' }))).toBe(true);
  });

  it('is true for a pending tier 2 row', () => {
    expect(isRowStillWorking(row({ property_trace_status: 'queued' }))).toBe(true);
  });

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

/**
 * Minimal PostgREST-shaped stub. `jobUpdateResult` is what the .eq('status','processing') chain
 * returns on a clean update (a lost race returns null with no error). `readError` / `writeError`
 * let a test simulate a Supabase error on the trace_history read or the trace_jobs write.
 *
 * THE FALLBACK BRANCH MATCHES 'trace_jobs' EXPLICITLY, not "anything that is not trace_history": a
 * writer that moved to the wrong table would otherwise still get a working stub and every test
 * would stay green while production wrote nowhere real.
 */
function stubAdmin(
  rows: FinalizableRow[],
  jobUpdateResult: { id: string } | null,
  opts: { readError?: { message: string }; writeError?: { message: string } } = {}
) {
  const updateSpy = vi.fn();
  const selectSpy = vi.fn();
  const eqCalls: Array<[string, unknown]> = [];
  const readEqCalls: Array<[string, unknown]> = [];
  const admin = {
    from: (table: string) => {
      if (table === 'trace_history') {
        return {
          select: (cols: string) => {
            selectSpy(cols);
            return {
              eq: (col: string, val: unknown) => {
                readEqCalls.push([col, val]);
                return {
                  eq: (col2: string, val2: unknown) => {
                    readEqCalls.push([col2, val2]);
                    return opts.readError
                      ? Promise.resolve({ data: null, error: opts.readError })
                      : Promise.resolve({ data: rows, error: null });
                  },
                };
              },
            };
          },
        };
      }
      if (table === 'trace_jobs') {
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
                      select: () => ({
                        maybeSingle: async () =>
                          opts.writeError
                            ? { data: null, error: opts.writeError }
                            : { data: jobUpdateResult, error: null },
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`stubAdmin: unexpected table "${table}"`);
    },
  };
  return { admin: admin as never, updateSpy, eqCalls, readEqCalls, selectSpy };
}

describe('finalizeJobIfDrained: the compare-and-swap', () => {
  it('does not write at all while a Tier 1 row is queued', async () => {
    const { admin, updateSpy } = stubAdmin([row({ ai_research_status: 'tier1_queued' })], { id: 'j1' });
    const out = await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(out).toEqual({ finalized: false, reason: 'still_working', pending: 1 });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // SECURITY BRANCH: tenant scoping. Delete the .eq('user_id', ...) from the module's read and
  // this goes red -- every other test in this file stays green while records_matched would be fed
  // by a cross-tenant row count, because none of them can see WHICH rows were read, only how many.
  it('scopes the read to this user and this job, both, not just the job', async () => {
    const { admin, readEqCalls } = stubAdmin([], { id: 'j1' });
    await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(readEqCalls).toEqual([['user_id', 'u1'], ['trace_job_id', 'j1']]);
  });

  // Guards against a dropped column reading as undefined in production while every other test,
  // which only cares about the VALUES on `rows`, stays green regardless of what was selected.
  it('selects exactly the columns isRowStillWorking / matchedRowCount / totalChargeFor need', async () => {
    const { admin, selectSpy } = stubAdmin([], { id: 'j1' });
    await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(selectSpy).toHaveBeenCalledWith(
      'property_trace_status, ai_research_status, is_successful, charge'
    );
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

  // THE ONE THAT MATTERS FOR THE WEBHOOK. A loser must be distinguishable from a winner. This is
  // the "cleanly lost the race, no error" half of that distinction; the "errored outright" half is
  // the write_failed test below -- both must produce different `reason` values, never the same one.
  it('returns finalized:false when it LOSES the swap', async () => {
    const { admin } = stubAdmin([row({ ai_research_status: 'tier1_done', is_successful: true })], null);
    const out = await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(out).toEqual({ finalized: false, reason: 'already_terminal' });
  });

  // CRITICAL FIX. A failed read is not an empty job: falling through would read pending as 0 and
  // CAS the job terminal with records_matched: 0, a fabricated result under the one-shot token.
  // MUTATION: drop the read's error check so a failed read falls through to the CAS -- this goes
  // red (both the `reason` and the "no write happened" assertion below).
  it('returns read_failed, and performs NO write, when the trace_history read errors', async () => {
    const { admin, updateSpy } = stubAdmin([], null, { readError: { message: 'read timeout' } });
    const out = await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(out).toEqual({ finalized: false, reason: 'read_failed', error: 'read timeout' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // CRITICAL FIX, the write-side half. A failed UPDATE is not "someone else finished the job" --
  // nothing was written and the job is still 'processing'. Collapsing this into already_terminal
  // (see the LOSES-the-swap test above) is exactly the plan-mandated bug the controller ordered
  // fixed: no caller would ever finalize the job again and the webhook would never fire.
  // MUTATION: collapse write_failed back into already_terminal (drop the writeError check) -- red.
  it('returns write_failed, distinct from already_terminal, when the trace_jobs update itself errors', async () => {
    const rows = [row({ ai_research_status: 'tier1_done', is_successful: true })];
    const { admin } = stubAdmin(rows, null, { writeError: { message: 'connection reset' } });
    const out = await finalizeJobIfDrained(admin, { jobId: 'j1', userId: 'u1' });
    expect(out).toEqual({ finalized: false, reason: 'write_failed', error: 'connection reset' });
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

/**
 * A multi-job stub for finalizeTouchedJobs, distinct from stubAdmin above because
 * finalizeTouchedJobs asks about MORE THAN ONE job in a single call: it has to key the
 * trace_history read by (user_id, trace_job_id) so two jobs in the same run see only their OWN
 * rows, and key the trace_jobs write's CAS outcome by job id so one job's race result cannot leak
 * onto another's.
 *
 * `jobs` maps jobId -> { userId, rows, wins }. `wins` defaults to true (the write's CAS succeeds);
 * pass `wins: false` to simulate a caller that loses the race.
 */
function stubAdminForJobs(
  jobs: Map<string, { userId: string; rows: FinalizableRow[]; wins?: boolean }>
) {
  const updateSpy = vi.fn();
  const admin = {
    from: (table: string) => {
      if (table === 'trace_history') {
        return {
          select: () => ({
            eq: (_col1: string, userId: string) => ({
              eq: (_col2: string, jobId: string) => {
                const cfg = jobs.get(jobId);
                return Promise.resolve({
                  data: cfg && cfg.userId === userId ? cfg.rows : [],
                  error: null,
                });
              },
            }),
          }),
        };
      }
      if (table === 'trace_jobs') {
        return {
          update: (payload: unknown) => {
            updateSpy(payload);
            return {
              eq: (_col1: string, jobId: string) => ({
                eq: () => ({
                  select: () => ({
                    maybeSingle: async () => {
                      const cfg = jobs.get(String(jobId));
                      const wins = cfg?.wins !== false;
                      return wins
                        ? { data: { id: jobId }, error: null }
                        : { data: null, error: null };
                    },
                  }),
                }),
              }),
            };
          },
        };
      }
      throw new Error(`stubAdminForJobs: unexpected table "${table}"`);
    },
  };
  return { admin: admin as never, updateSpy };
}

describe('finalizeTouchedJobs: one ask per job, not per row', () => {
  it('asks a job with three rows exactly once', async () => {
    const jobs = new Map([
      [
        'job-1',
        { userId: 'u1', rows: [row({ ai_research_status: 'tier1_done', is_successful: true })] },
      ],
    ]);
    const { admin, updateSpy } = stubAdminForJobs(jobs);
    const rows = [
      { trace_job_id: 'job-1', user_id: 'u1' },
      { trace_job_id: 'job-1', user_id: 'u1' },
      { trace_job_id: 'job-1', user_id: 'u1' },
    ];
    const result = await finalizeTouchedJobs(admin, rows);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ jobId: 'job-1', recordsMatched: 1 }]);
  });

  it('asks two distinct jobs, once each', async () => {
    const jobs = new Map([
      [
        'job-1',
        { userId: 'u1', rows: [row({ ai_research_status: 'tier1_done', is_successful: true })] },
      ],
      [
        'job-2',
        { userId: 'u2', rows: [row({ ai_research_status: 'tier1_done', is_successful: false })] },
      ],
    ]);
    const { admin, updateSpy } = stubAdminForJobs(jobs);
    const rows = [
      { trace_job_id: 'job-1', user_id: 'u1' },
      { trace_job_id: 'job-2', user_id: 'u2' },
    ];
    const result = await finalizeTouchedJobs(admin, rows);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { jobId: 'job-1', recordsMatched: 1 },
        { jobId: 'job-2', recordsMatched: 0 },
      ])
    );
  });

  // MUTATION: drop the `.filter((id): id is string => Boolean(id))` guard and this goes red --
  // the null trace_job_id would be asked about as a literal job id.
  it('skips a row with no parent job, asking nothing', async () => {
    const jobs = new Map<string, { userId: string; rows: FinalizableRow[] }>();
    const { admin, updateSpy } = stubAdminForJobs(jobs);
    const rows = [{ trace_job_id: null, user_id: 'u1' }];
    const result = await finalizeTouchedJobs(admin, rows);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  // MUTATION: return finalizeJobIfDrained's outcome regardless of `finalized`, and this test goes
  // red: a still-working job and a job that lost its CAS would both show up as "finalized".
  it('returns only the jobs that actually finalized, never a still-working or losing one', async () => {
    const jobs = new Map([
      ['job-1', { userId: 'u1', rows: [row({ ai_research_status: 'tier1_queued' })] }], // still working
      [
        'job-2',
        {
          userId: 'u1',
          rows: [row({ ai_research_status: 'tier1_done', is_successful: true })],
          wins: false,
        },
      ], // loses the CAS
      [
        'job-3',
        { userId: 'u1', rows: [row({ ai_research_status: 'tier1_done', is_successful: true })] },
      ], // wins
    ]);
    const { admin } = stubAdminForJobs(jobs);
    const rows = [
      { trace_job_id: 'job-1', user_id: 'u1' },
      { trace_job_id: 'job-2', user_id: 'u1' },
      { trace_job_id: 'job-3', user_id: 'u1' },
    ];
    const result = await finalizeTouchedJobs(admin, rows);
    expect(result).toEqual([{ jobId: 'job-3', recordsMatched: 1 }]);
  });
});
