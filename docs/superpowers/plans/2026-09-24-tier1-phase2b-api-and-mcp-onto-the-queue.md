# Tier 1 Phase 2B: API bulk and the gateway MCP onto the queue

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the v1 API bulk route and the gateway MCP `skip_trace_bulk` onto the same Tier 1 queue the web upload uses, judge every record on its own instead of rejecting whole batches, and make a bulk job finish when its queue drains rather than when a browser tab happens to poll it.

**Architecture:** Phase 2A built the queue and proved it on the web surface. 2B changes no routing, no billing and no vendor behaviour: it moves two more submit surfaces onto the existing `planRoute`/`executeRoute`/`runTier1Record` path and deletes the Tracerfy batch CSV from both. One new shared module, `lib/trace/finalizeBulkJob.ts`, becomes the single answer to "is this job still working" and "how many records matched", replacing five divergent copies.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase (Postgres + PostgREST), Vitest, Zod, Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-09-21-tier1-planroute-design.md` (D1-D41; sections 6.1 and 6.3 carry 2026-09-23 amendments that win over anything older). Predecessor plan: `docs/superpowers/plans/2026-09-23-tier1-phase2a-queue-and-web-upload.md`, whose "Carried to Phase 2B and later" items 1 to 5 are the scope of this plan.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **GATES, measured not relayed, before and after every task.** Baseline measured on main at `2982627`: `npx vitest run` = **2040 passed / 87 files / 0 failed**; `npx tsc --noEmit` = **exit 0**; `npx eslint app lib components` = **45 problems (40 errors, 5 warnings)**. Ceiling 46, hard cap 47. **Never run bare `npm run lint`.** `npx next build` must compile.
- **eslint exits non-zero on main.** 45 problems is the pre-existing baseline, not a regression. Judge by the count, never by the exit code.
- **NEVER create fallback, fake, mock or placeholder DATA in product code** (CLAUDE.md rule 7). An empty state stays empty. A missing input fails loudly.
- **No second price derivation.** `lib/suite/pricing.ts` is the only one (L-030). `chargePerTrace(profile)` and `chargePerRecord(profile)`, both grant-aware through `effectiveIsPro`. $0.15 tier 1 / $0.25 tier 2 for pro, AcquisitionPRO and a Suite Gateway grant; $0.25 / $0.40 pay-as-you-go. Do not reintroduce `getChargePerTrace` or `lib/api/pricing.ts`.
- **No customer-facing sentence is written or changed in this phase** without David's prior approval as a listed old-text/new-text pair (L-028). The existing copy tests keep the current wording.
- **No em-dashes, en-dashes, asterisks, emoji or markdown artifacts** in any customer-facing string.
- **Migrations:** none are expected. If one becomes necessary, apply it with `supabase db query --linked --file`, read the ACL back by name, and follow CLAUDE.md's GRANT rules exactly (REVOKE from PUBLIC **and** `anon` **and** `authenticated` by name).
- **Tests never call a live vendor and never reach the live database.** A test that needs `.env.local` is a test that has escaped.
- **Git:** work on branch `feat/tier1-phase2b-api-and-mcp-queue`, cut from `main` at `2982627`. Commit per task. **Nothing is pushed, merged or deployed without David's explicit go.**
- **Commit trailer:** every commit message ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` as its last line.
- **A prescribed mutation is a hypothesis (L-036).** Apply every one. When the result differs from the prediction, the prediction was wrong; record the measurement, not the prediction. Never write that a mutation cannot be applied without trying it.
- **When you mock something, name what you just made invisible and say where it is fenced instead** (L-036). "A later task will cover it" is how a guard goes permanently unfenced, and the last task has no successor.
- **Assert the CONSEQUENCE, not the field** (L-036). A test that asserts `row.ai_research_status === 'tier1_queued'` is weaker than one that asserts the Tier 1 cron then claims that row.

### Line references in this plan were measured on 2026-09-24, not copied

The 2A plan's own citations had drifted. These are current:

| Thing | 2A plan said | Actual |
|---|---|---|
| MCP whole-batch reject | `mcp-tools.ts:373-379` | **`:369-383`** |
| MCP apn/county write | `mcp-tools.ts:429-430` | **`:433-434`** |
| MCP `buildPerRecordResult` | `mcp-tools.ts:622-659` | **`:635-672`** |
| v1 `buildPerRecordResult` | `v1/trace/bulk/status/route.ts:421-464` | **`:423-467`** |
| v1 whole-batch 400 | `v1/trace/bulk/route.ts:77-86` | **`:61-86`** (loop `:65-76`, return `:77-86`) |
| `rowSkipReason` tier-1 gate | `rowSkipReason.ts:43-45` | **`:103-110`** |

---

## What this phase does NOT do

Recorded so nobody reads their absence as an oversight.

1. **It does not touch the Suite Gateway repo.** The gateway's own whole-batch rejection and its city guard live in `/Users/davidmonroe/suite-gateway`, which is another session's working tree. Spec Section 10 assigns "the relaxed city guard" to **Phase 3**, not here. 2B makes PropTracerPRO *accept* what the gateway wants to send. It does not finish that path, and the final task hands off exactly what the gateway side still needs.
2. **It does not change routing, name matching, the ladder, the step log, billing or vendor behaviour.** Those are Phase 1's, unchanged. 2B only changes which rows reach them.
3. **It does not delete `isLikelyBusiness` the function**, only its use for routing on these two surfaces (spec 4.1). Phase 4 deletes the function.
4. **It does not remove the Tracerfy batch path itself**, `submitSingleTrace`, or `settleBulkJob`'s city/state matcher. Spec 3.3: those go in Phase 4, only after in-flight batch rows have drained.
5. **It does not answer L-035** (what a Tier 1 record with a parcel id and no street should do). The APN rung is the designed fallback for a missing city and 2B ships it as-is. The disclosure question stays recorded and open.
6. **It does not resolve the Tier 2 margin question** (cost `$0.20 + $0.10N` against a flat `$0.25`). Recorded 2026-09-24, undecided, and no task here changes a price.
7. **It does not fix `checkDuplicates` being inert on API-key requests.** That helper opens a cookie-scoped client (`v1/trace/bulk/route.ts:290-293` says so), so 90-day dedup does not apply to API callers today. Surfaced in Task 4 as a recorded observation; changing it is a separate decision about what an API caller is charged for.

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `lib/trace/finalizeBulkJob.ts` | **NEW, T1** | The ONE derivation: is a row still working, how many matched, and the guarded terminal write. |
| `lib/trace/__tests__/finalizeBulkJob.test.ts` | NEW, T1 | Unit fence for the above, including the CAS. |
| `app/api/trace/bulk/status/route.ts` | T1 | Stops owning `stillWorking` and `finalize`; calls the module. No behaviour change. |
| `app/api/cron/sweep-entity-traces/route.ts` | T2, T4 | T2: finalize the parent job after the Tier 1 lane drains. T4: nothing, but its claim query is what T4's rows must satisfy. |
| `app/api/cron/sweep-property-traces/route.ts` | T2 | Finalize the parent job after the Tier 2 lane drains. |
| `app/api/cron/sweep-stale-traces/route.ts` | T2 | Its longhand queue guard collapses into the shared predicate. |
| `app/api/v1/trace/bulk/status/route.ts` | T3, T7 | T3: Tier-1-aware pending gate + shared finalize. T7: `found_by`/`outcome_code` on its `buildPerRecordResult` twin. |
| `app/api/v1/trace/bulk/route.ts` | T4 | Per-record judging, the Tier 1 enqueue, `traceKeyFor`, D23 parcel input. The batch CSV goes. |
| `lib/suite/mcp-tools.ts` | T5, T6, T7 | T5: `bulk_status` pending gate + shared finalize. T6: `skip_trace_bulk` onto the queue, `recordSchema` city optional. T7: the other `buildPerRecordResult` twin + `listTraces`. |
| `app/api/[transport]/route.ts` | T7 | MCP tool descriptions (`:91`, `:97`). |
| `tasks/research-scripts/phase2b/run-live.ts` | NEW, T8 | The live check runner, fenced the same way 2A's was. |
| `tasks/phase2b-live-check.md` | NEW, T8 | The live report. Counts only. |

### Ordering, and why it is not negotiable

**For each surface the CONSUMER is fixed before the PRODUCER exists.** T3 makes the v1 status route understand a Tier 1 row before T4 creates one; T5 does the same for MCP before T6. This is deliberate: 2A shipped its enqueue (T3) before its completion gate (T4) and the plan's own review found that a web job would finalize `completed` with `records_matched: 0` on the first poll. Reversing the order here removes that window entirely, and each consumer task is a safe no-op until its producer lands.

T1 and T2 come first because they touch files every later task rewrites. Extracting a shared derivation out of code that T3 to T6 have just edited is strictly harder than extracting it now.

---

## Task 1: One derivation for "is this job done", with a guarded terminal write

**Files:**
- Create: `lib/trace/finalizeBulkJob.ts`
- Create: `lib/trace/__tests__/finalizeBulkJob.test.ts`
- Modify: `app/api/trace/bulk/status/route.ts` (delete `stillWorking` at `:39-50`, delete the `finalize` closure at `:212-246`, call the module instead)

**Interfaces:**
- Consumes: `isPropertyTracePending` from `lib/trace/propertyTraceAttempts`, `isTier1QueuePending` and `isTier1QueueRow` from `lib/trace/tier1Queue`.
- Produces, and T2 to T6 all consume these exact signatures:
  ```ts
  export interface FinalizableRow {
    property_trace_status: string | null;
    ai_research_status: string | null;
    is_successful: boolean | null;
    charge?: number | null;
  }
  export function isRowStillWorking(row: FinalizableRow): boolean;
  export function recordsMatchedFor(rows: FinalizableRow[], tier1Matched: number): number;
  export function totalChargeFor(rows: FinalizableRow[]): number;
  export async function finalizeJobIfDrained(
    admin: SupabaseClient,
    opts: { jobId: string; userId: string; tier1Matched?: number }
  ): Promise<FinalizeOutcome>;
  export type FinalizeOutcome =
    | { finalized: false; reason: 'still_working'; pending: number }
    | { finalized: false; reason: 'already_terminal' }
    | { finalized: true; recordsMatched: number; totalCharge: number };
  ```

**WHY THIS EXISTS.** Five places currently answer "how many records matched" and they do not agree: the web status route uses three disjoint arms, the v1 status route and the MCP tool use a flat `is_successful` count, `sweep-stale-traces` uses a flat count in one branch and a Tracerfy-loop count in another. Two places ask "is this job still working" and the v1 and MCP surfaces ask it with the **legacy** `isEntityTracePending`, which does not contain any `tier1_` value. One number, one predicate, one writer.

**THE CAS IS THE POINT, not a nicety.** Every `trace_jobs.status` write in the repo today is a bare `.eq('id', ...)` after a gate evaluated earlier in the handler: a read-then-write race. Once the crons also finalize (T2), two workers can settle a job's last two rows in the same instant and both see zero pending. The repo already has the primitive, used three times for row claims (`sweep-property-traces/route.ts:375-395`): update, `.eq(<column>, <value just read>)`, `.select('id').maybeSingle()`, and `if (!claimed) return`. Applied to `trace_jobs.status`, a non-null result means **this caller performed the terminal transition** — which is the fire-once token `bulk_job.completed` has never had.

- [ ] **Step 1: Write the failing test for the predicate and the arithmetic**

Create `lib/trace/__tests__/finalizeBulkJob.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  isRowStillWorking,
  recordsMatchedFor,
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
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run lib/trace/__tests__/finalizeBulkJob.test.ts`
Expected: FAIL, `Failed to resolve import "@/lib/trace/finalizeBulkJob"`. Not a type error, not an assertion failure — the module does not exist yet.

- [ ] **Step 3: Write the module**

Create `lib/trace/finalizeBulkJob.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPropertyTracePending } from './propertyTraceAttempts';
import { isTier1QueuePending, isTier1QueueRow } from './tier1Queue';

/**
 * THE ONE ANSWER TO "IS THIS BULK JOB FINISHED", AND THE ONE WRITER THAT ENDS IT.
 *
 * WHAT WAS HERE BEFORE. Five places computed records_matched and they disagreed: the web status
 * route used three disjoint arms, the v1 status route and the MCP bulk_status tool used a flat
 * is_successful count, and sweep-stale-traces used a flat count in one branch and a Tracerfy-loop
 * count in another. Two places asked "still working" and the v1 and MCP surfaces asked it with
 * isEntityTracePending, which contains no tier1_ value at all -- so either of them would have
 * finalized a job over live, billable Tier 1 work the moment Phase 2B enqueued one.
 *
 * WHY THE TERMINAL WRITE IS A COMPARE-AND-SWAP. Every trace_jobs.status write in this repo is a
 * bare .eq('id', ...) after a gate evaluated earlier in the same handler, which is a read-then-write
 * race. Phase 2B adds cron callers, so two workers can settle a job's last two rows in the same
 * instant and both read zero pending. The .eq('status', 'processing') predicate makes the database
 * pick one. Its non-null result is also the only fire-once signal bulk_job.completed has ever had:
 * that webhook is documented as one-shot and has no dispatched flag anywhere.
 *
 * THIS FUNCTION MOVES NO MONEY. Charges are settled per record, by the crons and the status routes,
 * long before a job is finalized. A job's completion is bookkeeping about work already billed.
 */

export interface FinalizableRow {
  property_trace_status: string | null;
  ai_research_status: string | null;
  is_successful: boolean | null;
  charge?: number | null;
}

/**
 * Does this row still owe a cron some work?
 *
 * TWO QUEUES, ONE QUESTION. `property_trace_status` is the tier 2 queue; `ai_research_status`
 * carries the TIER 1 queue (spec 3.2). A row is on at most one of them: every submit path writes
 * null into the other.
 *
 * THE LEGACY ENTITY LADDER IS DELIBERATELY NOT HERE. Its bare `queued`/`processing` values share
 * the ai_research_status column but are a different lane with a different cron. A caller that still
 * has legacy rows in flight asks isEntityTracePending as well; see the v1 status route.
 */
export const isRowStillWorking = (row: FinalizableRow): boolean =>
  isPropertyTracePending(row.property_trace_status) || isTier1QueuePending(row.ai_research_status);

/**
 * THREE DISJOINT ARMS, and the disjointness is what stops a row counting twice.
 *   tier1Matched          the legacy Tracerfy CSV half, counted from the vendor's own results by
 *                         the caller's own loop. Those rows carry NEITHER queue column, which is
 *                         why the caller has to supply the number rather than this function
 *                         deriving it. Pass 0 on a surface with no CSV half.
 *   property_trace_status the tier 2 queue.
 *   ai_research_status    the TIER 1 queue. Keyed on isTier1QueueRow, never on bare truthiness,
 *                         or a legacy `found` row starts counting as a Tier 1 match.
 */
export const recordsMatchedFor = (rows: FinalizableRow[], tier1Matched: number): number =>
  tier1Matched +
  rows.filter((r) => r.property_trace_status && r.is_successful).length +
  rows.filter(
    (r) => !r.property_trace_status && isTier1QueueRow(r.ai_research_status) && r.is_successful
  ).length;

/** Sum of the STORED per-row charges, which is the only figure that includes what a cron booked. */
export const totalChargeFor = (rows: FinalizableRow[]): number =>
  Number(rows.reduce((sum, r) => sum + (r.charge || 0), 0).toFixed(4));

export type FinalizeOutcome =
  | { finalized: false; reason: 'still_working'; pending: number }
  | { finalized: false; reason: 'already_terminal' }
  | { finalized: true; recordsMatched: number; totalCharge: number };

/**
 * Read the job's rows, and if nothing is still working, write the job terminal ONCE.
 *
 * `finalized: true` is returned to exactly one caller, ever, for a given job. Fire
 * bulk_job.completed on that and nothing else.
 */
export async function finalizeJobIfDrained(
  admin: SupabaseClient,
  opts: { jobId: string; userId: string; tier1Matched?: number }
): Promise<FinalizeOutcome> {
  const { data } = await admin
    .from('trace_history')
    .select('property_trace_status, ai_research_status, is_successful, charge')
    .eq('user_id', opts.userId)
    .eq('trace_job_id', opts.jobId);
  const rows = (data || []) as FinalizableRow[];

  const pending = rows.filter(isRowStillWorking).length;
  if (pending > 0) return { finalized: false, reason: 'still_working', pending };

  const recordsMatched = recordsMatchedFor(rows, opts.tier1Matched ?? 0);
  const totalCharge = totalChargeFor(rows);

  // THE COMPARE-AND-SWAP. Only the caller that flips 'processing' to 'completed' gets true back.
  const { data: won } = await admin
    .from('trace_jobs')
    .update({
      status: 'completed',
      records_matched: recordsMatched,
      completed_at: new Date().toISOString(),
    })
    .eq('id', opts.jobId)
    .eq('status', 'processing')
    .select('id')
    .maybeSingle();

  if (!won) return { finalized: false, reason: 'already_terminal' };
  return { finalized: true, recordsMatched, totalCharge };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run lib/trace/__tests__/finalizeBulkJob.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Add the CAS test**

Append to `lib/trace/__tests__/finalizeBulkJob.test.ts`:

```ts
/** Minimal PostgREST-shaped stub. `jobUpdateResult` is what the .eq('status','processing') chain returns. */
function stubAdmin(rows: FinalizableRow[], jobUpdateResult: { id: string } | null) {
  const updateSpy = vi.fn();
  const eqCalls: Array<[string, unknown]> = [];
  const admin = {
    from: (table: string) => {
      if (table === 'trace_history') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          then: undefined,
        } as Record<string, unknown>;
        // Resolve the builder as a promise the route awaits.
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
});
```

- [ ] **Step 6: Run it, then run the mutations named in the comments**

Run: `npx vitest run lib/trace/__tests__/finalizeBulkJob.test.ts`
Expected: PASS, 14 tests.

Then apply each of the four named mutations one at a time, run the file, record RED or GREEN **as measured**, and restore:
1. Delete the `isTier1QueuePending` arm from `isRowStillWorking`.
2. Change the tier 1 arm of `recordsMatchedFor` to bare truthiness on `ai_research_status`.
3. Delete `.eq('status', 'processing')` from the update chain.
4. Change `if (!won)` to `if (false)`.

- [ ] **Step 7: Refactor the web status route to use the module, with NO behaviour change**

In `app/api/trace/bulk/status/route.ts`: delete the local `stillWorking` (`:39-50`) and the `finalize` closure (`:212-246`). Import `isRowStillWorking`, `recordsMatchedFor`, `totalChargeFor` from `@/lib/trace/finalizeBulkJob`. Replace the seven usages (`:254`, `:269`, `:320`, `:578`, `:584`, `:592`) with the imported names.

**Do NOT switch this route to `finalizeJobIfDrained` in this task.** It already holds `rows` in memory from `readJobRows()` and passes a live `tier1Matched` from its own Tracerfy loop; re-reading inside the module would change its query shape and its behaviour. This task makes it share the *arithmetic and the predicate*, not the reader. T2 is where the CAS reaches it.

- [ ] **Step 8: Prove the refactor changed nothing**

Run: `npx vitest run app/api/trace/bulk/status/__tests__/route.test.ts`
Expected: PASS with the **same count as before the edit**. Record the number. A changed count means the refactor was not a refactor.

Then the full suite: `npx vitest run 2>&1 | tail -5` — expected 2040 + 14 new = **2054 passed / 88 files / 0 failed**.
`npx tsc --noEmit; echo "tsc $?"` — expected `tsc 0`.
`npx eslint app lib components 2>&1 | tail -2` — expected 45, and never above 46.

- [ ] **Step 9: Commit**

```bash
git add lib/trace/finalizeBulkJob.ts lib/trace/__tests__/finalizeBulkJob.test.ts app/api/trace/bulk/status/route.ts
git commit -m "$(cat <<'MSG'
refactor(jobs): one derivation for job completion, with a guarded terminal write

Five places computed records_matched and disagreed; two asked "still working"
and the v1 and MCP surfaces asked it with the legacy entity predicate, which
holds no tier1_ value and would finalize a job over live Tier 1 work.

lib/trace/finalizeBulkJob.ts is now the only answer to both, plus the only
writer that ends a job. Its terminal write is a compare-and-swap on
status='processing', copying the row-claim primitive the crons already use, so
exactly one caller is told it performed the transition. That is the fire-once
token bulk_job.completed has never had.

The web status route now shares the arithmetic and the predicate. It keeps its
own reader and its own tier1Matched, so this commit changes no behaviour.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 2: Finalize a job when its queue drains, from both crons

**Files:**
- Modify: `app/api/cron/sweep-entity-traces/route.ts` (insert after the worker `Promise.all` at `:691-693`, before `return out` at `:695`)
- Modify: `app/api/cron/sweep-property-traces/route.ts` (insert after the worker `Promise.all` at `:814-823`, before the `return NextResponse.json` at `:825`)
- Modify: `app/api/cron/sweep-stale-traces/route.ts` (replace the longhand queue guard at `:234-265` with the shared predicate)
- Test: `app/api/cron/sweep-entity-traces/__tests__/route.test.ts`, `app/api/cron/sweep-property-traces/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `finalizeJobIfDrained`, `isRowStillWorking` from Task 1.
- Produces: nothing new. Both crons gain a `jobsFinalized` counter in their response body.

**THE DEFECT THIS CLOSES, measured on 2026-09-24.** A bulk job reaches `completed` in only two reachable ways: a browser tab polling the status route, or `sweep-stale-traces`, which by construction reads only jobs older than 60 minutes (`.lt('created_at', cutoff)`). `app/(dashboard)/history/page.tsx` is a server component with no polling, and Download / Push-to-CRM are gated on `job.status === 'completed'` (`dashboard/page.tsx:325,331`, `history/page.tsx:228,248`). So a customer who closes the tab — **which the upload page explicitly invites them to do** — sees `Processing` with no export for up to an hour after their results are finished and billed. Observed in the Phase 2A live check: last row settled 17:11, job read `completed` at 17:50.

**`CRON_TIMEOUT_MINUTES` STAYS 60 AND IS NOT TOUCHED.** David's recall is correct and `History.md:2577` records it: it is a *"second-line 'give up entirely' deadline"*, sized to absorb normal queue depth. It answers "when do we give up on a job that has not finished". This task answers the different question, "when do we notice a job HAS finished", with a condition that is strictly stronger than the clock: zero rows still working. If any row is pending, this code does nothing.

- [ ] **Step 1: HARD STOP. The webhook change goes to David as a list, before anything is built (L-028).**

Firing `bulk_job.completed` from a cron changes when an integrator's system hears about a job. Present exactly this and wait for a named answer:

> **Today:** `bulk_job.completed` fires from three places — the web status route (`bulk/status/route.ts:613`), the v1 status route (`v1/.../status/route.ts:383`), and `sweep-stale-traces:457` at the 60-minute mark. An integrator whose job drains in 90 seconds hears nothing until they poll or until the hour is up. **The web route's most common finalize path (`:269`, every post-2A web job) fires no webhook at all.**
>
> **Proposed:** the two crons fire it when `finalizeJobIfDrained` returns `finalized: true`, which happens at most once per job because of the compare-and-swap. Same event name, same payload keys as the v1 site, roughly an hour earlier. Nothing else changes.
>
> **The risk, stated plainly:** an integrator who today receives one webhook per job continues to receive exactly one. An integrator who today receives none (web jobs via `:269`) starts receiving one. That second group is the behaviour change.
>
> **Option A** — fire from the crons (recommended; consistent, and the CAS makes it one-shot).
> **Option B** — do not fire; the crons only flip the status, and webhooks stay where they are. The export appears immediately, the notification still waits.

Do not proceed to Step 2 until David names A or B. If B, skip Steps 6 and 7 and say so in the task report.

- [ ] **Step 2: Write the failing test for the Tier 1 cron**

Add to `app/api/cron/sweep-entity-traces/__tests__/route.test.ts`, inside the Tier 1 lane describe block:

```ts
  it('finalizes the parent job once its last queued row settles', async () => {
    // One job, one row, and the row settles in this run. The job must come out completed.
    const { GET, client } = harnessWithTier1Rows([
      { id: 'r1', trace_job_id: 'job-1', user_id: 'u1', ai_research_status: 'tier1_queued' },
    ]);
    await GET(authedRequest());
    const jobUpdate = client.updates.find((u) => u.table === 'trace_jobs');
    expect(jobUpdate?.payload).toMatchObject({ status: 'completed', records_matched: expect.any(Number) });
  });

  // MUTATION: delete the finalizeJobIfDrained call after the Promise.all and this goes red.
  // Without it the job sits at 'processing' until a tab polls or the 60-minute sweep runs.
  it('does NOT finalize while another row of the same job is still queued', async () => {
    const { GET, client } = harnessWithTier1Rows([
      { id: 'r1', trace_job_id: 'job-1', user_id: 'u1', ai_research_status: 'tier1_queued' },
    ], { unclaimedSiblings: [{ trace_job_id: 'job-1', ai_research_status: 'tier1_queued_2' }] });
    await GET(authedRequest());
    expect(client.updates.find((u) => u.table === 'trace_jobs')).toBeUndefined();
  });

  it('guards the terminal write on status=processing', async () => {
    const { GET, client } = harnessWithTier1Rows([
      { id: 'r1', trace_job_id: 'job-1', user_id: 'u1', ai_research_status: 'tier1_queued' },
    ]);
    await GET(authedRequest());
    const jobUpdate = client.updates.find((u) => u.table === 'trace_jobs');
    expect(jobUpdate?.filters).toContainEqual(['status', 'processing']);
  });

  it('asks about each touched job exactly once, not once per row', async () => {
    const { GET, client } = harnessWithTier1Rows([
      { id: 'r1', trace_job_id: 'job-1', user_id: 'u1', ai_research_status: 'tier1_queued' },
      { id: 'r2', trace_job_id: 'job-1', user_id: 'u1', ai_research_status: 'tier1_queued' },
      { id: 'r3', trace_job_id: 'job-2', user_id: 'u1', ai_research_status: 'tier1_queued' },
    ]);
    await GET(authedRequest());
    const jobUpdates = client.updates.filter((u) => u.table === 'trace_jobs');
    expect(jobUpdates).toHaveLength(2);
  });

  it('ignores a row with no parent job', async () => {
    const { GET, client } = harnessWithTier1Rows([
      { id: 'r1', trace_job_id: null, user_id: 'u1', ai_research_status: 'tier1_queued' },
    ]);
    await GET(authedRequest());
    expect(client.updates.find((u) => u.table === 'trace_jobs')).toBeUndefined();
  });
```

**The harness helper does not exist under these names.** Read the file's existing Tier 1 describe block first and reuse whatever stub it already builds (Task 8 of Phase 2A extended that stub to evaluate `.in()`, `.limit()`, `.or()` and `.lt()` the way PostgREST would). Adapt the tests to that harness rather than inventing one; the names above describe the *behaviour to assert*, not an API you may assume exists. Recording which helper you used is part of the task report.

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run app/api/cron/sweep-entity-traces/__tests__/route.test.ts`
Expected: FAIL on the first, third and fourth tests (no `trace_jobs` update is made at all). The second and fifth may pass vacuously — note that, because a vacuous pass is not a fence.

- [ ] **Step 4: Implement in the Tier 1 lane**

In `app/api/cron/sweep-entity-traces/route.ts`, immediately after the worker `Promise.all` (`:691-693`) and before `return out`:

```ts
  /**
   * RELEASE THE PARENT JOBS WHOSE QUEUE JUST DRAINED.
   *
   * The settle above is what MAKES a job finishable; nothing before Phase 2B ever noticed. A job
   * reached 'completed' only when a browser tab polled it or when sweep-stale-traces caught it at
   * the 60-minute cutoff, so a customer who closed the tab saw 'Processing' with no export for up
   * to an hour after the work was done and billed.
   *
   * ONE ASK PER JOB, not per row: a 120-row run of a single job is one question.
   * finalizeJobIfDrained re-reads the job's rows and writes nothing unless every one is settled,
   * so a job with rows this run did not claim is simply left for the next run a minute later.
   */
  const touchedJobs = new Set(
    rows.map((r) => r.trace_job_id).filter((id): id is string => Boolean(id))
  );
  for (const jobId of touchedJobs) {
    const userId = rows.find((r) => r.trace_job_id === jobId)?.user_id;
    if (!userId) continue;
    const outcome = await finalizeJobIfDrained(adminClient, { jobId, userId });
    if (outcome.finalized) out.jobsFinalized++;
  }
```

Add `jobsFinalized: 0` to the `Tier1LaneResult` initialiser (`:308-320`) and import `finalizeJobIfDrained` from `@/lib/trace/finalizeBulkJob`.

**`user_id` must be on `Tier1QueueRow`.** The claim query is `select('*')` (`:443`) so the value is present at runtime; confirm the interface declares it and add it if not. `finalizeJobIfDrained` scopes its read by `user_id` deliberately, mirroring the status route's own `readJobRows`.

- [ ] **Step 5: Run the tests and the mutation**

Run: `npx vitest run app/api/cron/sweep-entity-traces/__tests__/route.test.ts`
Expected: PASS, all five.

Then delete the whole `for (const jobId of touchedJobs)` block, re-run, record which tests go red **as measured**, and restore. Then delete only the `if (outcome.finalized)` guard on the counter, re-run, record, restore.

- [ ] **Step 6: The same in the Tier 2 cron**

In `app/api/cron/sweep-property-traces/route.ts`, after the `Promise.all` at `:814-823` and before the `return NextResponse.json` at `:825`, add the identical block using that file's `rows` and `adminClient`, and add `jobsFinalized` to its response body.

**Note the early return at `:798-808`** when `queuedRows` is empty: a run that settles nothing returns before this point. That is correct and not a gap — a run with no claimed rows has no job to release that a previous run did not already handle.

- [ ] **Step 7: Fire the webhook on the winning caller only (skip if David chose B)**

Only where `outcome.finalized === true`, read the owner's profile and fire the same payload shape the v1 site uses. Copy `sweep-stale-traces:457-469`'s fire-and-forget form exactly (`fetch(...).catch(...)`, no retry, no signing header). **Never fire on `finalized: false`.** The CAS is what makes this one-shot; there is no `webhook_dispatched` column on `trace_jobs` and this task does not add one.

- [ ] **Step 8: Collapse the longhand guard in sweep-stale-traces**

Replace `:234-265`'s two filtered `some(...)` calls with `rows.some(isRowStillWorking)`, keeping the existing comment. This is the third copy of the same question and it must not survive as a fourth derivation.

- [ ] **Step 9: Gates and commit**

Run all four gates. Expected: vitest up by the new tests, 0 failed; tsc 0; eslint at most 46; build clean.

```bash
git add app/api/cron/sweep-entity-traces/route.ts app/api/cron/sweep-property-traces/route.ts app/api/cron/sweep-stale-traces/route.ts app/api/cron/sweep-entity-traces/__tests__/route.test.ts app/api/cron/sweep-property-traces/__tests__/route.test.ts
git commit -m "$(cat <<'MSG'
feat(jobs): finish a bulk job when its queue drains, not when a tab polls it

A job reached 'completed' only from a polling browser tab or from the 60-minute
stale sweep. History is a server component with no poll, and Download and
Push-to-CRM are gated on completed, so a customer who closed the tab, which the
upload page invites, saw Processing with no export for up to an hour after the
work was done and billed. Measured in the 2A live check: last row 17:11, job
completed 17:50.

Both crons now ask finalizeJobIfDrained once per job they touched. Its condition
is zero rows still working, which is strictly stronger than the clock, so it can
never cut a job off early. CRON_TIMEOUT_MINUTES stays 60: that is a give-up
deadline, not a completion mechanism.

sweep-stale-traces' longhand queue guard collapses into the shared predicate so
there is no fourth derivation of the same question.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 3: The v1 status route learns the Tier 1 queue (consumer before producer)

**Files:**
- Modify: `app/api/v1/trace/bulk/status/route.ts` (the pending gate at `:272-298`, the `records_matched` at `:327`, the finalize at `:330-337`)
- Test: `app/api/v1/trace/bulk/status/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `isRowStillWorking`, `recordsMatchedFor`, `totalChargeFor` from Task 1.
- Produces: nothing. This task is a no-op in production until Task 4 creates a Tier 1 row on this surface.

**WHY THIS IS ITS OWN TASK AND WHY IT COMES FIRST.** Phase 2A shipped its enqueue before its completion gate and the plan's own review found the consequence: a web job finalized `completed` with `records_matched: 0` on the first poll, and the status route's top-of-handler early return made that permanent. This route has the identical hole today — its gate at `:278` asks `isEntityTracePending`, which is the **legacy** predicate and contains no `tier1_` value. Its third arm (`r.status === 'processing'`) would catch a `tier1_queued` row *incidentally*, but only until the cron flips `status`, which the Tier 1 cron does before clearing the queue column. Fixing the consumer first means Task 4 cannot open that window at all.

- [ ] **Step 1: Write the failing test**

Add to `app/api/v1/trace/bulk/status/__tests__/route.test.ts`, modelled on the existing `"the tier 2 queue holds the job open too"` describe block at `:265`:

```ts
describe('the Tier 1 queue holds the job open too', () => {
  // MUTATION: revert the gate to isEntityTracePending alone and this goes red. That predicate
  // holds no tier1_ value, so a queued Tier 1 row would read as finished and the job would
  // finalize over live, billable work -- which the top-of-handler early return makes permanent.
  it('reports processing while a Tier 1 row is queued', async () => {
    const { GET, client } = harness({
      job: { id: 'j1', status: 'processing', tracerfy_job_id: null, records_submitted: 2 },
      rows: [
        { ai_research_status: 'tier1_queued', property_trace_status: null, status: 'success', is_successful: true },
        { ai_research_status: 'tier1_done', property_trace_status: null, status: 'success', is_successful: true },
      ],
    });
    const body = await (await GET(apiKeyRequest('j1'))).json();
    expect(body.status).toBe('processing');
    expect(client.updates.find((u) => u.table === 'trace_jobs')).toBeUndefined();
  });

  it('stays processing even after the cron has flipped status off processing', async () => {
    // The incidental third arm (status === 'processing') cannot be what holds this open:
    // the Tier 1 cron writes status before it clears ai_research_status.
    const { GET } = harness({
      job: { id: 'j1', status: 'processing', tracerfy_job_id: null, records_submitted: 1 },
      rows: [{ ai_research_status: 'tier1_queued_3', property_trace_status: null, status: 'no_match', is_successful: false }],
    });
    const body = await (await GET(apiKeyRequest('j1'))).json();
    expect(body.status).toBe('processing');
  });

  it('completes once every Tier 1 row is settled, and counts the successes', async () => {
    const { GET } = harness({
      job: { id: 'j1', status: 'processing', tracerfy_job_id: null, records_submitted: 2 },
      rows: [
        { ai_research_status: 'tier1_done', property_trace_status: null, status: 'success', is_successful: true },
        { ai_research_status: 'tier1_done', property_trace_status: null, status: 'no_match', is_successful: false },
      ],
    });
    const body = await (await GET(apiKeyRequest('j1'))).json();
    expect(body.status).toBe('completed');
    expect(body.records_matched).toBe(1);
  });

  it('does not count a LEGACY entity row as a Tier 1 match', async () => {
    const { GET } = harness({
      job: { id: 'j1', status: 'processing', tracerfy_job_id: null, records_submitted: 1 },
      rows: [{ ai_research_status: 'found', property_trace_status: null, status: 'success', is_successful: true }],
    });
    const body = await (await GET(apiKeyRequest('j1'))).json();
    expect(body.records_matched).toBe(0);
  });
});
```

Reuse whatever harness the existing `:265` block uses; the names above are illustrative of the shape, not an API to assume.

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run app/api/v1/trace/bulk/status/__tests__/route.test.ts`
Expected: FAIL. The first two return `completed` instead of `processing`; the fourth returns 1 instead of 0.

- [ ] **Step 3: Fix the gate, the arithmetic and the finalize**

At `:272-298`, keep the legacy arm and add the Tier 1 one. **Both are needed on this surface**, because until Phase 4 drains the in-flight batch rows a v1 job can hold legacy entity rows *and* Tier 1 rows at once:

```ts
    // THREE POPULATIONS, and until Phase 4 a job can hold all three at once.
    //   isEntityTracePending  the LEGACY entity ladder, bare queued/processing on ai_research_status.
    //   isRowStillWorking     the tier 2 queue AND the Tier 1 queue (spec 3.2), the shared predicate.
    //   status === 'processing'  a row the Tracerfy CSV half still owns.
    // Asking only the first is how this route would finalize over live Tier 1 work, and the
    // early return at the top of this handler would then make that verdict permanent.
    const anyPendingLegacyEntity = rows.some((r) => isEntityTracePending(r.ai_research_status));
    const anyPendingQueue = rows.some(isRowStillWorking);
    const anyPendingTrace = rows.some((r) => r.status === 'processing');
```

Replace `:327`'s flat count with `recordsMatchedFor(rows, 0)` and the `totalCharge` with `totalChargeFor(rows)`. Leave the bare `.eq('id', ...)` update in place for now — **this route holds its rows in memory and must not re-read**; the CAS arrives here only if a later task moves it to `finalizeJobIfDrained`, which is not in scope.

`tier1Matched` is **0** on this surface: it has no in-loop Tracerfy counter of its own, unlike the web route.

- [ ] **Step 4: Run, mutate, record**

Run the file. Expected: PASS.
Mutations, each applied alone and measured: (a) drop `anyPendingQueue` from the disjunction; (b) change `recordsMatchedFor(rows, 0)` back to `rows.filter((r) => r.is_successful).length`. Record RED or GREEN as measured, restore.

- [ ] **Step 5: Gates and commit**

```bash
git add app/api/v1/trace/bulk/status/route.ts app/api/v1/trace/bulk/status/__tests__/route.test.ts
git commit -m "$(cat <<'MSG'
fix(v1): the bulk status route understands the Tier 1 queue

Its pending gate asked isEntityTracePending, the legacy predicate, which holds
no tier1_ value. Its third arm caught a queued Tier 1 row only incidentally, via
status === 'processing', and only until the cron flipped status -- which it does
before clearing the queue column. So the first poll after that would finalize the
job over live, billable work, and the top-of-handler early return would make it
permanent. This is the defect Phase 2A's own review found on the web route.

Fixed before anything enqueues here, so the window never opens. records_matched
moves to the shared three-arm derivation, which also stops a legacy entity row
counting as a Tier 1 match.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 4: The v1 API bulk submit goes on the Tier 1 queue

**Files:**
- Modify: `app/api/v1/trace/bulk/route.ts` (the whole submit path)
- Test: `app/api/v1/trace/bulk/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `tier1QueuedStatusFor` and `TIER1_OUTCOME` from `lib/trace/tier1Queue` / `lib/trace/tier1Outcome`; `traceKeyFor` and `usableZip` from `lib/utils/address-normalizer`; `PROPERTY_TRACE_NO_KEY_STATUS` / `PROPERTY_TRACE_NO_KEY_REASON` from `lib/trace/propertyTraceAttempts`; `TRACE_SOURCE` from `lib/suite/pricing`.
- Produces: rows wearing `tier1_queued`, which the Tier 1 cron claims and Task 3's gate holds open.

**This is the largest task in the phase. It is one task rather than several because its parts cannot land apart**, which the next paragraph explains, and because Phase 2A's Task 3 did exactly this scope for the web route and is the model to copy.

**THE ORDERING CONSTRAINT THAT MAKES THIS INDIVISIBLE (spec 6.3, D36).** `checkDuplicates` hashes with `traceKeyFor`, which prefers street+city and falls through to `APN|<parcel>|<county>|<state>` when either is missing. `buildHistoryRow` stores `address_hash` from plain `normalizeAddress(address, city, state)`. **They agree today only because the whole-batch 400 guarantees every record has a street and a city.** Relax the validation for a parcel-keyed record without switching the row builder to `traceKeyFor`, and the dedup hash and the stored hash diverge: the same record sent through single and through bulk lands on two rows. The spec says so in as many words. So the validation change and the key change are one change.

- [ ] **Step 1: Write the failing tests**

Add to `app/api/v1/trace/bulk/__tests__/route.test.ts`. Note that **no existing test pins the whole-batch 400** — a repo-wide grep for `invalidRecords` / `"failed validation"` finds only the two source sites — so nothing here is being replaced, only added.

```ts
describe('per-record judging replaces the whole-batch 400', () => {
  // MUTATION: restore the `if (invalidRecords.length > 0) return 400` block and this goes red.
  it('runs the good records when one record has no city', async () => {
    const { POST, client } = harness();
    const res = await POST(apiKeyRequest({ records: [
      rec({ owner_name: 'Jane Smith' }),
      rec({ owner_name: 'John Doe', city: '' }),
    ]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recordsToProcess).toBe(2);
    const inserted = client.upserts.flatMap((u) => u.rows);
    expect(inserted).toHaveLength(2);
  });

  // The ZIP is the sharpest case: Excel strips a leading zero on export, so the four-argument
  // validate killed entire New England and Puerto Rico files.
  it('does not reject a batch over a malformed ZIP', async () => {
    const { POST } = harness();
    const res = await POST(apiKeyRequest({ records: [rec({ owner_name: 'Jane Smith', zip: '2139' })] }));
    expect(res.status).toBe(200);
  });

  it('files a record with no street AND no state as no-key, free, without queueing it', async () => {
    const { POST, client } = harness();
    await POST(apiKeyRequest({ records: [rec({ owner_name: 'Jane Smith', address: '', state: '' })] }));
    const row = client.upserts.flatMap((u) => u.rows)[0];
    expect(row.property_trace_status).toBe(PROPERTY_TRACE_NO_KEY_STATUS);
    expect(row.ai_research_status).toBeNull();
    expect(row.status).toBe('no_match');
    expect(row.charge ?? 0).toBe(0);
  });
});

describe('the Tier 1 enqueue', () => {
  // ASSERT THE CONSEQUENCE, NOT THE FIELD (L-036): tier1_queued is the value the cron's
  // .in(TIER1_QUEUED_STATUSES) claim actually matches. A bare 'queued' would be handed to
  // FastAppend on the owner name with no route planned at all.
  it('queues a named record onto the TIER 1 queue, not the legacy entity ladder', async () => {
    const { POST, client } = harness();
    await POST(apiKeyRequest({ records: [rec({ owner_name: 'Acme Holdings LLC' })] }));
    const row = client.upserts.flatMap((u) => u.rows)[0];
    expect(row.ai_research_status).toBe(tier1QueuedStatusFor(1));
    expect(TIER1_QUEUED_STATUSES).toContain(row.ai_research_status);
    expect(row.status).toBe('processing');
    expect(row.tracerfy_job_id).toBeNull();
  });

  it('makes no person/entity distinction at submit any more', async () => {
    const { POST, client } = harness();
    await POST(apiKeyRequest({ records: [
      rec({ owner_name: 'Acme Holdings LLC' }),
      rec({ owner_name: 'Jane Smith' }),
    ]}));
    const rows = client.upserts.flatMap((u) => u.rows);
    expect(rows.every((r) => r.ai_research_status === tier1QueuedStatusFor(1))).toBe(true);
  });

  it('never builds a Tracerfy person CSV', async () => {
    const { POST, submitBulkTrace } = harness();
    await POST(apiKeyRequest({ records: [rec({ owner_name: 'Jane Smith' })] }));
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });

  // MUTATION: change tier1: tier1Records.length back to tier1: 0 and this goes red.
  it('sizes the credit pool against the real Tier 1 count', async () => {
    const { POST, tracerfyCanRun } = harness();
    await POST(apiKeyRequest({ records: [rec({ owner_name: 'Jane Smith' }), rec({})] }));
    expect(tracerfyCanRun).toHaveBeenCalledWith(expect.anything(), { tier1: 1, tier2: 1 });
  });
});

describe('the duplicate key aligns with the single surfaces (spec 6.3, D36)', () => {
  // MUTATION: put normalizeAddress back in buildHistoryRow and this goes red. The dedup hash
  // and the stored hash would then disagree for any parcel-keyed record, and the same address
  // sent through single and bulk would land on two rows.
  it('keys a city-less record on its parcel, exactly as traceKeyFor does', async () => {
    const { POST, client } = harness();
    const record = { address: '', city: '', state: 'TX', owner_name: 'Jane Smith', apn: 'R-123', county: 'Travis' };
    await POST(apiKeyRequest({ records: [record] }));
    const row = client.upserts.flatMap((u) => u.rows)[0];
    expect(row.address_hash).toBe(traceKeyFor(record));
  });

  it('stores the parcel id and county it was given (D23)', async () => {
    const { POST, client } = harness();
    await POST(apiKeyRequest({ records: [rec({ owner_name: 'Jane Smith', apn: 'R-123', county: 'Travis' })] }));
    const row = client.upserts.flatMap((u) => u.rows)[0];
    expect(row.parcel_id_local).toBe('R-123');
    expect(row.county).toBe('Travis');
  });
});

describe('a failed enqueue is not reported as success', () => {
  // MUTATION: swallow the insert error with console.error and return, and this goes red.
  // THIS WRITE IS THE SUBMIT now: swallowing it tells a customer their 500-row job worked
  // when no row was written, and bulk/status would finalize it completed with 0 matched.
  it('fails the job and answers 500 when the row write fails', async () => {
    const { POST, client } = harness({ failUpsert: true });
    const res = await POST(apiKeyRequest({ records: [rec({ owner_name: 'Jane Smith' })] }));
    expect(res.status).toBe(500);
    const jobUpdate = client.updates.find((u) => u.table === 'trace_jobs');
    expect(jobUpdate?.payload).toMatchObject({ status: 'failed' });
  });
});

describe('D33: a reused row does not answer with a stale outcome', () => {
  it('clears outcome_code, found_by and trace_steps on a reused row', async () => {
    const { POST, client } = harness();
    await POST(apiKeyRequest({ records: [rec({ owner_name: 'Jane Smith' })] }));
    const row = client.upserts.flatMap((u) => u.rows)[0];
    expect(row).toMatchObject({ outcome_code: null, found_by: null, trace_steps: null });
  });

  it('does NOT clear them on a busy resume, which needs the step log', async () => {
    const { POST, client } = harness({ cachedResults: [{ address_hash: 'h1', outcome_code: TIER1_OUTCOME.BUSY_TRY_AGAIN }] });
    await POST(apiKeyRequest({ records: [rec({ owner_name: 'Jane Smith' })] }));
    const row = client.upserts.flatMap((u) => u.rows).find((r) => r.address_hash === 'h1');
    expect(row).not.toHaveProperty('trace_steps', null);
  });
});
```

Reuse the file's existing `rec()` helper (`:115-121`) and `recordingClient()` harness rather than inventing new ones.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run app/api/v1/trace/bulk/__tests__/route.test.ts`
Expected: FAIL on most of the new tests. Also expect the **existing** tests listed in Step 6 to still pass at this point; they break in Step 4, which is correct and planned.

- [ ] **Step 3: Rewrite the split and the validation**

Delete the whole-batch 400 (`:61-86`). Replace the three-way split (`:134-147`) with the binary one the web route uses, and add the no-key bucket:

```ts
    // BINARY, AND THE CLASSIFIER MOVED. A record with an owner name is Tier 1 and planRoute
    // decides inside the cron whether it is a person, a company or a trust (spec 4.1). The
    // isLikelyBusiness call that used to make that decision here is gone: it is a substring test
    // that calls "Vincent Crews", "Ralph Holland" and "Lincoln Garland" businesses. The function
    // itself survives until Phase 4.
    const tier1Records: AddressInput[] = [];
    const tier2Records: AddressInput[] = [];
    const noKeyRecords: AddressInput[] = [];
    for (const record of records) {
      if ((record.owner_name || '').trim()) {
        tier1Records.push(record);
        continue;
      }
      // NO ZIP ARGUMENT, AND ITS ABSENCE IS THE POINT. This asks one question: can a vendor be
      // asked about this row at all. Joining the ZIP rule to it filed rows with a perfectly good
      // street, city and state as no-key over a ZIP Excel had stripped a leading zero from, which
      // is every MA, NJ, CT, RI, NH, ME, VT and PR file wholesale. A malformed ZIP is dropped at
      // the row write instead, by usableZip.
      const usable = validateAddressInput(record.address, record.city, record.state);
      if (usable.valid) tier2Records.push(record);
      else noKeyRecords.push(record);
    }
```

**A Tier 1 record is never no-key at submit.** A company traces on name and state alone (D4), and a person with no lookup key settles `no_lookup_key` free inside the cron with a sentence. The no-key bucket is for a blank-owner record whose address cannot be sent anywhere.

- [ ] **Step 4: Rewrite `buildHistoryRow` and the row writes**

In `buildHistoryRow` (`:259-298`): swap `normalizeAddress(...)` for `traceKeyFor({ address, city, state, apn, county })`; swap the raw ZIP truncation for `usableZip(record.zip)`; add `parcel_id_local`, `county`, `source: TRACE_SOURCE.API`, and the D33 clear. Copy the web route's comment at `app/api/trace/bulk/route.ts:378-410` for the D33 half, including its disclosed cost (on a reused row the `found_by` cell is empty between submit and settle).

`TRACE_SOURCE` has no `API` member today — it is `{ MCP: "mcp", WEB: "web" }`. Add `API: "api"`. **It is a label and only a label**: `isTrackASource` is gone and no price keys off it (L-030). Its value is that a live check can tell these rows apart.

Then replace the three row-write blocks: tier 2 keeps `queuedStatusFor(1)`; the entity/person split collapses into one Tier 1 write using `tier1QueuedStatusFor(1)`, `status: 'processing'`, `tracerfy_job_id: null` **written explicitly, not omitted**; and the no-key rows get `PROPERTY_TRACE_NO_KEY_STATUS` with `status: 'no_match'`.

Delete the CSV build (`:346-368`), the `submitBulkTrace` call, and its whole failure path (`:369-441`).

- [ ] **Step 5: Make the insert throw**

Copy the web route's `insertHistoryRows` helper (`app/api/trace/bulk/route.ts:414-436`) and its catch (`:500-536`) verbatim in shape. The three swallowed `console.error` sites (`:323-325`, `:340-342`, `:436-438`) go.

- [ ] **Step 6: Fix the tests this task legitimately breaks**

These existing tests assert behaviour that no longer exists. Rewrite them, do not delete them:
- `:348` `"still sends a person straight to the Tracerfy bulk CSV"` — becomes "queues a person onto the Tier 1 queue".
- `:333` `"still queues a NAMED entity for the business trace, on its own queue"` — becomes the `tier1_queued` assertion.
- the whole `"when the Tracerfy person submit fails"` describe (10 tests, `:409-517`) — **this submit no longer exists.** Replace the block with the enqueue-failure tests from Step 1 rather than leaving a hole where 10 tests were.
- `:386` and `:391` — both assert `tracerfyCanRun` called with `{ tier1: 0, tier2: N }`. Update to the real count, and delete the mock's `"until 2B"` comment at `:100-107`.
- `:585` `"says nothing about queueing when nothing was queued"` — re-derive for the new response.

**Expected failure count before fixing: measure it and write it down.** The plan does not predict it, because Phase 2A predicted 38 and the real answer needed four files it had not named.

- [ ] **Step 7: Run every mutation in Step 1's comments, then the gates**

Apply each named mutation alone, measure RED or GREEN, restore. Then all four gates.

Record as an observation, not a fix: **`checkDuplicates` is inert on this surface** (`:290-293` says so — it opens a cookie-scoped client and an API-key request has no cookie), so 90-day dedup does not apply to API callers, before or after this task.

- [ ] **Step 8: Commit**

```bash
git add app/api/v1/trace/bulk/route.ts app/api/v1/trace/bulk/__tests__/route.test.ts lib/suite/pricing.ts
git commit -m "$(cat <<'MSG'
feat(v1): API bulk enqueues Tier 1 and judges every record on its own

One bad record used to 400 the whole batch, and the validation included the ZIP,
so a leading zero Excel had stripped killed a 500-record file. Records are now
judged one at a time: a record with an owner name goes on the Tier 1 queue, a
blank-owner record with a usable address goes to tier 2, and only a record no
vendor can be asked about is filed no-key, free, with a sentence.

The person/entity split at submit is gone; planRoute classifies inside the cron
(spec 4.1). The Tracerfy person CSV is gone from this surface. The row write is
now THE submit, so it throws instead of console.error-ing, or a customer is told
a 500-row job worked when nothing was written.

The key moves to traceKeyFor in the same change, because it has to: dedup already
hashed that way and the stored hash did not, and they agreed only while the
validation guaranteed a street and a city (spec 6.3, D36).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 5: MCP `bulk_status` learns the Tier 1 queue (consumer before producer)

**Files:**
- Modify: `lib/suite/mcp-tools.ts` (the pending gate at `:749-767`, the finalize at `:777-783`)
- Test: `lib/suite/__tests__/mcp-tools.test.ts`

**Interfaces:** consumes `isRowStillWorking`, `recordsMatchedFor` from Task 1. Produces nothing until Task 6.

**The same hole as Task 3, and one degree worse.** `lib/trace/tier1Queue` is **not imported into `mcp-tools.ts` at all**. Its gate asks `isEntityTracePending`, `isPropertyTracePending` and `status === 'processing'`. Its `records_matched` is a flat `rows.filter(r => r.is_successful)` read *after* settlement, which is arithmetically fine and needs no rewrite — but a Tier 1 row would not hold the job open, so the count would be taken too early.

- [ ] **Step 1: Write the failing test**

Mirror Task 3's four tests inside the existing `bulk_status` describe (`:949`), using that file's harness. Add the same mutation comments.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run lib/suite/__tests__/mcp-tools.test.ts`
Expected: FAIL — the job finalizes while a `tier1_queued` row is present.

- [ ] **Step 3: Add the arm**

Import `isRowStillWorking` and `recordsMatchedFor`. Add `rows.some(isRowStillWorking)` to the pending disjunction alongside the existing legacy arm (both are needed until Phase 4). Replace the flat count with `recordsMatchedFor(rows, 0)`.

- [ ] **Step 4: Run, mutate, gates, commit**

Mutation: remove the `isRowStillWorking` arm; measure; restore.

```bash
git add lib/suite/mcp-tools.ts lib/suite/__tests__/mcp-tools.test.ts
git commit -m "$(cat <<'MSG'
fix(mcp): bulk_status understands the Tier 1 queue

lib/trace/tier1Queue was not imported into this file at all, so a queued Tier 1
row would not have held a job open and bulk_status would have reported it
complete while its rows were still running and still being billed. Fixed before
Task 6 creates such a row, so the window never opens.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 6: `skip_trace_bulk` goes on the Tier 1 queue

**Files:**
- Modify: `lib/suite/mcp-tools.ts` (`recordSchema` `:124-144`, the split `:313-320`, the capacity guard `:322-334`, the whole-batch reject `:369-383`, `buildHistoryRow` `:415-446`, the three row writes `:451-542`)
- Test: `lib/suite/__tests__/mcp-tools.test.ts`

**Interfaces:** consumes the same Tier 1 helpers as Task 4. Produces `tier1_queued` rows from the gateway surface, which Task 5's gate holds open.

**THIS IS THE TASK THAT UNBLOCKS THE SUITE GATEWAY.** `recordSchema` makes **`city` required** — not the validator, the Zod schema itself — and that is what refuses the gateway's APN-bearing parcels before any guard runs. Its sibling comment records the history: `zip` was made optional on 2026-09-04 *"while rejecting whole batches at the door, since skipTraceBulk fails the batch if any one record is invalid."*

- [ ] **Step 1: Write the failing tests**

Mirror Task 4's Step 1 tests into the `skip_trace_bulk` describe (`:549`), plus:

```ts
  it('accepts a record with no city when it carries a parcel key', async () => {
    const out = await skipTraceBulk(admin, sub, {
      confirm: true,
      records: [{ address: '', city: '', state: 'TX', owner_name: 'Jane Smith', apn: 'R-123', county: 'Travis' }],
    });
    expect(out).not.toHaveProperty('error');
  });

  // The APN has been stored on every row since before 2A and read by nothing on the tier 1
  // lane, because MCP rows never wore a tier1_ status. This is the assertion that it is now
  // reachable: the cron's own parcelForTier1Row is what consumes it.
  it('puts the stored parcel key within reach of the Tier 1 cron', async () => {
    const out = await skipTraceBulk(admin, sub, {
      confirm: true,
      records: [{ address: '1 Main St', city: 'Austin', state: 'TX', owner_name: 'Jane Smith', apn: 'R-123', county: 'Travis' }],
    });
    const row = captured.traceHistoryUpserts.flatMap((u) => u.rows)[0];
    expect(row.parcel_id_local).toBe('R-123');
    expect(TIER1_QUEUED_STATUSES).toContain(row.ai_research_status);
  });
```

- [ ] **Step 2: Run and confirm failure**

Expected: the city-less record is rejected by Zod before `skipTraceBulk` runs a line.

- [ ] **Step 3: Make `city` optional and delete the whole-batch reject**

In `recordSchema`, `city` becomes `z.string().optional()`. Document why in place, citing D4 (a company traces on name and state alone) and the APN key. Delete `:369-383` and replace with the same binary split plus no-key bucket as Task 4.

- [ ] **Step 4: The enqueue, the key, the capacity count**

Same as Task 4: `tier1QueuedStatusFor(1)` for every owner-bearing record, `traceKeyFor` in `buildHistoryRow` (which already writes `parcel_id_local`/`county` at `:433-434`, so only the key derivation changes), the D33 clear, and `tracerfyCanRun(admin, { tier1: tier1Records.length, tier2: tier2Records.length })`.

Delete the CSV build (`:526-541`), the `submitBulkTrace` call and the person-submit-failure path (`:496-514`). `tracerfy_job_id` is no longer set on the job (`:533`).

- [ ] **Step 5: Fix the one test that breaks for the right reason**

`:724-733` `"does not ask the pool about a batch with no blank-owner records"` goes red once `tier1` is a real count, because a tier-1-only batch can now be refused. **That is correct.** Rewrite it to assert the new contract and delete the mock's `"This surface always passes tier1: 0 until 2B"` short circuit at `:49-56`, which is what made the old value invisible.

**No test asserts `tracerfyCanRun`'s arguments today** — the only `toHaveBeenCalledWith` calls in the file are against `limitFn`. Add one, so the count is fenced rather than merely changed.

- [ ] **Step 6: Mutations, gates, commit**

```bash
git add lib/suite/mcp-tools.ts lib/suite/__tests__/mcp-tools.test.ts
git commit -m "$(cat <<'MSG'
feat(mcp): skip_trace_bulk enqueues Tier 1 and accepts a city-less record

recordSchema required a city, so a parcel-keyed record was refused by Zod before
any guard ran. That is what has been blocking the Suite Gateway: an APN request
takes parcel_id, county and state and needs no city at all, and hasSitus already
requires a city independently, so nothing could have sent a partial address.

Records are judged one at a time now instead of the whole batch being rejected.
The parcel key this surface has stored on every row since before Phase 2A is
finally within reach of a cron that reads it. tracerfyCanRun gets the real Tier 1
count, and its argument is fenced by a test for the first time.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 7: `found_by` and `outcome_code` reach every payload that reports a record

**Files:**
- Modify: `app/api/v1/trace/bulk/status/route.ts` (`buildPerRecordResult`, `:423-467`)
- Modify: `lib/suite/mcp-tools.ts` (`buildPerRecordResult`, `:635-672`; `listTraces`, `:50-119`, and its SELECT string at `:66`)
- Modify: `app/api/[transport]/route.ts` (tool descriptions at `:91` and `:97`)
- Test: `lib/trace/__tests__/payloadParity.test.ts`, `app/api/v1/trace/bulk/status/__tests__/route.test.ts`, `lib/suite/__tests__/mcp-tools.test.ts`

**Interfaces:** consumes `rowSkipReason` (already imported in both files). Produces two new keys on both per-record payloads and three on `list_traces`.

**BOTH TWINS IN ONE COMMIT, OR THE BUILD GOES RED.** `buildPerRecordResult` exists twice, unexported, once per auth stack (API key at `v1/.../status/route.ts:423`, gateway MCP at `mcp-tools.ts:635`). `lib/trace/__tests__/payloadParity.test.ts` is a **source scan**, not a runtime call: it locates each function, slices from `return {` to `};`, regex-matches top-level keys at four-space indent, and asserts `[...v1Keys].sort()` equals `[...mcpKeys].sort()`. Adding a key to one alone turns that assertion red. Current key set is 15; this task makes it 17.

**THE `list_traces` TRAP, and it would have shipped green.** `listTraces` projects through a literal SELECT string at `:66`, and the test harness stubs projection through that exact string. `rowSkipReason` gates on `row.trace_job_id === null || isTier1QueueRow(row.ai_research_status)`. Add `found_by` and `outcome_code` to the select without also adding **`ai_research_status`, `property_trace_status` and `trace_job_id`**, and the gate receives `undefined` for all three, `tier1MaySpeak` is false for every row, and **every row returns a blank reason with a green suite.**

**THE D33 INTERLOCK RELEASES ITSELF, and this is worth understanding before touching `rowSkipReason`.** Its gate is keyed on the `tier1_` status "precisely so the other two keep today's behaviour until they clear the columns too". Tasks 4 and 6 add exactly that clear. So those rows become `tier1MaySpeak` by construction, and **`rowSkipReason` itself needs no edit in this phase.** Carried item 4 is satisfied by Tasks 4 and 6, not by a change here. Verify that claim with a test rather than trusting this paragraph.

- [ ] **Step 1: HARD STOP. The two MCP tool descriptions are customer-facing copy (L-028).**

Give David the exact old and new text for `app/api/[transport]/route.ts:91` and `:97` and wait for approval. The substance required by spec 7.2:
- `:91` (`skip_trace_bulk`) currently says *"**On a record with no owner name** you may also supply apn ... and county"*. The spec requires `apn`/`county` to apply to **named** records too, which is what Tasks 4 and 6 make true.
- `:97` (`bulk_status`) must gain a description of the outcome codes.

Write both as complete replacement strings, not as diffs, and obey the copy rules (no em-dashes, no asterisks, conversational). **Do not write them before he approves the substance**, and do not proceed past this step without a named answer.

- [ ] **Step 2: Write the failing parity test first**

Raise `payloadParity.test.ts`'s anti-vacuity floor from 12 to 17 and add a literal-presence assertion for each new key in both files, matching the shape of its existing `property_record` and `tier` assertions at `:76-93`.

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run lib/trace/__tests__/payloadParity.test.ts`
Expected: FAIL on the floor and on both literal-presence assertions.

- [ ] **Step 4: Add the two keys to both twins, in the same edit**

```ts
      found_by: row.found_by ?? null,
      outcome_code: row.outcome_code ?? null,
```

Both files already select `*` or already carry the columns; confirm rather than assume, and add them to any explicit select that omits them.

- [ ] **Step 5: `list_traces`, select string first**

Add `outcome_code, found_by, ai_research_status, property_trace_status, trace_job_id` to the SELECT at `:66`, then call `rowSkipReason(row)` and emit `skip_reason`, `found_by`, `outcome_code`. Destructure the three gate columns **out** of the echoed payload the way `parcel_id_local` and `county` already are — they are internal.

Write a test that seeds a Tier 1 row with an `outcome_code` and asserts a non-null `skip_reason` comes back. **Then delete `trace_job_id` from the select string alone and confirm that test goes red**, which is the only thing that proves the trap is closed.

- [ ] **Step 6: The webhook payload**

The v1 `bulk_job.completed` payload carries `results: enrichedResults`, built from `buildPerRecordResult`, so it gains both keys automatically. Assert that rather than assuming it: a test that reads the webhook body and expects `found_by` on a record.

The web route's webhook carries `successfulResults` built from the raw Tracerfy result, **not** from `trace_history`, so it gains nothing here. Record that asymmetry; do not fix it in this phase.

- [ ] **Step 7: Mutations, gates, commit**

Mutations: (a) remove `found_by` from the v1 twin only — expect parity red; (b) remove `trace_job_id` from the `list_traces` select — expect the skip_reason test red; (c) remove `outcome_code` from the MCP twin only. Measure each.

```bash
git add app/api/v1/trace/bulk/status/route.ts lib/suite/mcp-tools.ts app/api/[transport]/route.ts lib/trace/__tests__/payloadParity.test.ts
git commit -m "$(cat <<'MSG'
feat(payloads): found_by and outcome_code on every surface that reports a record

Both buildPerRecordResult twins in one commit, because payloadParity compares
their key sets by source scan and one alone goes red. list_traces gains
skip_reason, found_by and outcome_code, and its SELECT string gains the three
columns rowSkipReason gates on, without which every row would have returned a
blank reason with a green suite.

The v1 bulk_job.completed webhook inherits both keys through buildPerRecordResult.
The web webhook builds from the raw vendor result rather than trace_history and
gains nothing; recorded, not fixed here.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 8: Suite gates, then the live check

**Files:**
- Create: `tasks/research-scripts/phase2b/run-live.ts`
- Create: `tasks/phase2b-live-check.md` (counts only)
- Create, gitignored: `tasks/research-test/phase2b/records.json`, `upload.csv` is NOT needed here
- Modify: `tasks/todo.md`, `History.md`

**WHO RUNS WHAT (L-031, and the split that kept the 2A blast radius at $0.20).** The executor BUILDS the runner, proves its refusals, and stops. It never passes `--live`. It never sets `PTP_LIVE_RUN`. **David names the dollar amount. The CONTROLLER runs the spend.**

**UNLIKE 2A, THIS ONE CAN BE SCRIPTED END TO END.** The web bulk route authenticates by session cookie, which is why David had to upload 2A's file himself. The v1 route authenticates by **API key** and the MCP surface by a **gateway sub**, so the runner can submit, drain and read back without a browser. That removes the human step, not the money gate.

**THE 2A LIVE CHECK'S OWN LESSON APPLIES AND MUST BE DESIGNED AROUND.** A local server pointed at the production database **races the production crons**. In 2A, production drained all four tier 2 rows 50 seconds after submit, on `origin/main` code, so `vendor_rate_windows` showed zero tier 2 contribution and those rows proved nothing about the branch. Only `tier1_*` statuses were invisible to main, which is why the Tier 1 half survived. **After this phase merges, main knows `tier1_*` too**, so that protection is gone. The runner must therefore either run against a branch deploy rather than local-against-production, or the report must state which lane was drained by which code. Decide this explicitly in Step 1 and write the answer into the report.

- [ ] **Step 1: The suite gates**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -6
npx tsc --noEmit; echo "tsc exit $?"
npx eslint app lib components 2>&1 | tail -3
npx next build 2>&1 | tail -15
grep -rn "submitBulkTrace" app/api/v1/trace/bulk/route.ts lib/suite/mcp-tools.ts
grep -rn "isLikelyBusiness" app/api/v1/trace/bulk/route.ts lib/suite/mcp-tools.ts
grep -rn "tier1: 0" app lib | grep -v node_modules
grep -rn "invalidRecords\|invalid_records" app lib | grep -v node_modules
grep -n "normalizeAddress" app/api/v1/trace/bulk/route.ts
grep -rn "isEntityTracePending" app lib | grep -v node_modules
```

Expected: vitest 0 failed and above the 2040 baseline; `tsc exit 0`; eslint at most 46, never above 47; the build compiles. Greps 1 to 5 print **nothing**. Grep 6 (`isEntityTracePending`) still prints the v1 and MCP status sites — **that is correct and must not be "fixed"**: the legacy entity lane is alive until Phase 4 and those surfaces need both arms.

- [ ] **Step 2: The mutation table**

Add a review section to `tasks/todo.md` under the Phase 2B item: one row per mutation run in Tasks 1 to 7, sourced from each task report's **measured** result, never from this plan's prediction. Every mutant that came back GREEN, equivalent or unfenced is written as such with its reason. **Any survivor not already named here is a defect to fix before the live check, not a note.**

- [ ] **Step 3: Choose the records (free: registry reads only)**

Same picking rules as 2A, which are the spec's: candidates from `docs/registry-inventory/county-searchable-coverage.csv`; secondary and tertiary markets only; never Indiana, never Florida, never a primary metro; never a county or parcel used in Phase 0, the Phase 1 live check, the FastAppend probe **or the 2A live check** (`tasks/phase2a-live-check.md` lists all twenty). Registry reads go direct, not through the gateway.

Paths to exercise, and each exists because 2B created it:
| Id | Surface | Path | What it could break |
|---|---|---|---|
| C1 | v1 API | named record, full address | the enqueue replacing the CSV |
| C2 | v1 API | named record, **no city** | the whole-batch 400's removal |
| C3 | v1 API | named record, **no city, with apn+county** | `traceKeyFor` vs the stored hash (D36) |
| C4 | v1 API | blank owner, unusable address | the no-key bucket, free |
| C5 | v1 API | blank owner, good address | tier 2 undisturbed |
| C6 | MCP | named record, **no city, with apn+county** | the gateway's actual blocker |
| C7 | MCP | blank owner | tier 2 via the gateway surface |
| C8 | either | one batch with C2 and C4 together | per-record judging in one call |

- [ ] **Step 4: Write the runner**

`tasks/research-scripts/phase2b/run-live.ts`, built on 2A's, which is the reference implementation. It MUST keep all five refusals: no records file; a duplicate record id; a path with no record; a tier 2 record declaring no owner count; and **refusal 0, `--live` does nothing without `PTP_LIVE_RUN=1` in the environment**, checked before the cap so no cap value an agent can invent gets past it. The cap must be **strictly greater** than the computed worst case. Compute the worst case from `VENDOR_COST` in `lib/routing/ownerRoute`, never from a figure typed into the script.

- [ ] **Step 5: HARD STOP. Ask David for a dollar amount.**

Send, in one message: the record table (id, surface, path, state, county, property type, what each could break — **no owner names, no streets, no parcel ids**); the computed worst case from `--plan`; that his own wallet is charged the Tier 1 rate per found contact and the Tier 2 rate per record submitted, which is money moving inside PTP rather than vendor spend; and the Step 1 decision about which code drains which lane. Ask him to leave headroom, because the runner refuses a cap equal to the worst case.

Run nothing until he names it.

- [ ] **Step 6: The run (CONTROLLER, not the executor)**

- [ ] **Step 7: Read the rows back**

Per record: the outcome code, `found_by`, `contact_vendor`, `charge`, `cost`, step kinds with outcomes, `parcel_id_local`, and **`address_hash`, which is the D36 check** — C3's must equal `traceKeyFor` of its input. Per job: `status` `completed`, `records_matched` correct, `completed_at` set, and **it must not have completed before the cron ran**. Plus `vendor_rate_windows` (reserved must equal the calls the step logs show, never exceed), the wallet before and after, and one ledger debit per charged record.

**And the thing only this phase can prove: the job must reach `completed` without anyone polling it.** Do not open the status route until after the read-back confirms `completed_at`, or the test proves nothing.

Any disagreement is a defect: stop and report it to David as a question (L-021), with the row and the value.

- [ ] **Step 8: Report, History, commit, and the gateway handoff**

Write `tasks/phase2b-live-check.md`: counts only, no owner names, streets, parcel ids, phones or emails. Include a "what this did NOT prove" section as an exhaustive list, closed with that phrase (L-016).

**Then write the gateway handoff**, because this phase ends with PTP ready and the path still incomplete. State exactly what PropTracerPRO now accepts that it did not before, and what remains on the gateway side: its own whole-batch rejection, and its city guard, which spec Section 10 assigns to **Phase 3**. Do not claim the end-to-end path works; no task here tested it.

Tick Task 8 and the Phase 2B line in `tasks/todo.md`.

---

## Self-Review

### 1. Spec coverage

| Requirement | Task | Note |
|---|---|---|
| Carried item 1: API bulk onto the queue, D23 parcel input, per-record judging, remove the whole-batch 400 | **4** | All four in one task, because D36 forbids splitting the key change from the validation change |
| Carried item 2: MCP `skip_trace_bulk` onto the queue, its whole-batch rejection, the apn/county it stores | **6** | Plus `recordSchema`'s required `city`, which the 2A list did not name and is the actual blocker |
| Carried item 3: `found_by`/`outcome_code` in both twins, `list_traces`, the webhook, the tool descriptions | **7** | Both twins in one commit; the `list_traces` SELECT trap called out |
| Carried item 4: D33 clear-on-reuse for the other two submit paths | **4, 6** | Satisfied by the submit routes, not by editing `rowSkipReason`, whose `tier1_` gate then opens by construction |
| Carried item 5: `tracerfyCanRun`'s `tier1: 0` at both call sites | **4, 6** | And fenced by an argument assertion for the first time |
| Spec 6.3 / D36: align the bulk surfaces on the duplicate key | **4, 6** | **Not in the carried list.** Found during research and added |
| Spec 3.2: one queue for every owned record | 4, 6 | Same column, same rungs, `planRoute` classifies |
| Spec 4.1: one classifier; `isLikelyBusiness` not used for routing | 4, 6 | Function survives to Phase 4 |
| Spec 5.1, 5.2: vendor failure, step log, busy resume | — | Unchanged; these rows now reach the same cron the web rows do |
| Spec 6.1: one price derivation | — | Untouched, and Global Constraints forbid a second |
| Spec 6.2: wallet reserve counts queued Tier 1 | — | `inFlightUnbilledCost` is already Tier-1-aware; only the callers' `tier1:` argument was wrong |
| Spec 7.1, 7.2: outcome code, sentence, `found_by` everywhere | 7 | |
| Job completion latency (David's ruling, 2026-09-24) | **1, 2** | Not a spec item; his named first item for 2B |

### 2. Placeholder scan

No "TBD", no "implement later", no "add error handling", no "similar to Task N". Two places deliberately say *"read the existing harness and adapt"* rather than inventing helper names (T2 Step 2, T3 Step 1): that is not a placeholder, it is a refusal to invent an API the executor would then have to reconcile, and Phase 2A's Task 7 review found that inventing one is the more expensive error.

Three places deliberately refuse to predict a number: T4 Step 6's failure count, and every mutation result. That is L-036, which this plan's Global Constraints make binding.

### 3. Type consistency

`isRowStillWorking`, `recordsMatchedFor`, `totalChargeFor`, `finalizeJobIfDrained`, `FinalizableRow`, `FinalizeOutcome` are defined once in Task 1 and used under those exact names in Tasks 2, 3 and 5. `tier1QueuedStatusFor(1)`, `TIER1_QUEUED_STATUSES`, `traceKeyFor`, `usableZip`, `PROPERTY_TRACE_NO_KEY_STATUS` and `TRACE_SOURCE.API` are used identically in Tasks 4 and 6. `TRACE_SOURCE.API` does not exist yet and Task 4 Step 4 creates it.

### 4. The three hard stops, all David's

1. **T2 Step 1** — the `bulk_job.completed` webhook change, as an A/B choice with the risk stated.
2. **T7 Step 1** — the two MCP tool descriptions, as old text and new text.
3. **T8 Step 5** — the dollar amount for the live check.

Plus one decision inside T8 Step 1: which code drains which lane, now that main knows `tier1_*` and the 2A live check's accidental protection is gone.
