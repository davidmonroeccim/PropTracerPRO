import { describe, expect, it } from 'vitest'
import {
  ENTITY_PROCESSING_STATUSES,
  ENTITY_QUEUED_STATUSES,
  ENTITY_TRACE_FAILED_STATUS,
} from '@/lib/trace/entityTraceAttempts'
import { BLANK_OWNER_SKIP_STATUS } from '@/lib/trace/blankOwnerSkip'
import {
  TIER1_ATTEMPTS,
  TIER1_FAILED_STATUS,
  TIER1_MAX_ATTEMPTS,
  // TIER1_PENDING_STATUSES is deliberately NOT imported here. Nothing in this file uses it, and an
  // unused import is an eslint no-unused-vars warning: the eslint baseline is 45 problems, the
  // ceiling for this phase is 46 and the hard cap is 47, so one wasted warning at Task 2 leaves
  // every later task with no headroom at all. Its callers are fenced where they use it
  // (lib/trace/__tests__/bulkPreflight.test.ts, Tasks 4 and 6).
  TIER1_PROCESSING_STATUSES,
  TIER1_QUEUED_STATUSES,
  TIER1_SETTLED_STATUS,
  isTier1QueuePending,
  isTier1QueueRow,
  tier1AttemptOf,
  tier1NextAfterFailedAttempt,
  tier1ProcessingStatusFor,
  tier1QueuedStatusFor,
} from '@/lib/trace/tier1Queue'

/** Every value this ladder can write, for the width and disjointness tests. */
const ALL_TIER1_VALUES = [
  ...TIER1_QUEUED_STATUSES,
  ...TIER1_PROCESSING_STATUSES,
  TIER1_SETTLED_STATUS,
  TIER1_FAILED_STATUS,
]

describe('the Tier 1 queue ladder', () => {
  it('names the five rungs and their claimed twins', () => {
    expect(TIER1_MAX_ATTEMPTS).toBe(5)
    expect(TIER1_ATTEMPTS).toEqual([1, 2, 3, 4, 5])
    expect(TIER1_QUEUED_STATUSES).toEqual([
      'tier1_queued',
      'tier1_queued_2',
      'tier1_queued_3',
      'tier1_queued_4',
      'tier1_queued_5',
    ])
    expect(TIER1_PROCESSING_STATUSES).toEqual([
      'tier1_processing',
      'tier1_processing_2',
      'tier1_processing_3',
      'tier1_processing_4',
      'tier1_processing_5',
    ])
    expect(TIER1_SETTLED_STATUS).toBe('tier1_done')
    expect(TIER1_FAILED_STATUS).toBe('tier1_failed')
  })

  it('does NOT reuse attempt 1 as a bare queued, unlike the two older ladders', () => {
    // The entity and tier 2 ladders both write a BARE 'queued' for attempt 1, because they
    // predate their own ladders and needed every earlier row to read as attempt 1 with no
    // backfill. This ladder has no history to be compatible with, and it shares its column with
    // the entity ladder, so a bare 'queued' here would be claimed by the WRONG lane.
    expect(tier1QueuedStatusFor(1)).toBe('tier1_queued')
    expect(tier1ProcessingStatusFor(1)).toBe('tier1_processing')
    expect(TIER1_QUEUED_STATUSES).not.toContain('queued')
    expect(TIER1_PROCESSING_STATUSES).not.toContain('processing')
  })

  it('fits VARCHAR(20), with the longest value named', () => {
    // ai_research_status is VARCHAR(20) (migration 20260130_add_ai_research.sql:3). A value one
    // character over does not truncate, it raises 22001 and the row never settles.
    for (const value of ALL_TIER1_VALUES) {
      expect(value.length, `${value} is ${value.length} characters`).toBeLessThanOrEqual(20)
    }
    // ASSERT THE LENGTH, NOT WHICH VALUE WINS THE TIE. tier1_processing_2 through
    // tier1_processing_5 are all 18 characters, and Array.prototype.sort is stable, so this picks
    // tier1_processing_2. Naming a winner asserts an implementation detail of sort, not the
    // guarantee, and the guarantee is that the longest value is 18 and every value is inside 20.
    const longest = [...ALL_TIER1_VALUES].sort((a, b) => b.length - a.length)[0]
    expect(longest.length).toBe(18)
    expect(TIER1_PROCESSING_STATUSES).toContain(longest)
  })

  it('shares its column with the entity lane and overlaps it NOWHERE', () => {
    // ONE CRON, TWO LANES. The Tier 1 lane claims `.in(TIER1_QUEUED_STATUSES)` and the legacy
    // entity lane claims `.in(ENTITY_QUEUED_STATUSES)` on the SAME column. One value in both sets
    // means one row worked by both lanes: two vendor calls, two settles, and under two billing
    // shapes. This is the guard that makes the shared column safe.
    const entity = new Set([
      ...ENTITY_QUEUED_STATUSES,
      ...ENTITY_PROCESSING_STATUSES,
      ENTITY_TRACE_FAILED_STATUS,
      BLANK_OWNER_SKIP_STATUS,
      'found',
      'not_found',
    ])
    for (const value of ALL_TIER1_VALUES) {
      expect(entity.has(value), `${value} is claimed by both lanes`).toBe(false)
    }
  })

  it('reads the attempt out of the status, and an unknown value as attempt 1', () => {
    expect(tier1AttemptOf('tier1_queued')).toBe(1)
    expect(tier1AttemptOf('tier1_processing')).toBe(1)
    expect(tier1AttemptOf('tier1_queued_3')).toBe(3)
    expect(tier1AttemptOf('tier1_processing_5')).toBe(5)
    // Anything unrecognized reads as attempt 1, which is the safe direction: it costs one extra
    // retry, never an early give-up. A value ABOVE the ladder is clamped to the last rung.
    expect(tier1AttemptOf('tier1_queued_9')).toBe(5)
    expect(tier1AttemptOf('queued_3')).toBe(1)
    expect(tier1AttemptOf('tier1_done')).toBe(1)
    expect(tier1AttemptOf(null)).toBe(1)
    expect(tier1AttemptOf(undefined)).toBe(1)
    expect(tier1AttemptOf('  tier1_queued_2  ')).toBe(2)
  })

  it('answers PENDING for a rung or a claim, and never for a terminal', () => {
    // A terminal value that answered true here would hold the parent bulk job at 'processing'
    // forever: app/api/trace/bulk/status/route.ts gates job completion on this predicate.
    for (const value of [...TIER1_QUEUED_STATUSES, ...TIER1_PROCESSING_STATUSES]) {
      expect(isTier1QueuePending(value), value).toBe(true)
    }
    expect(isTier1QueuePending(TIER1_SETTLED_STATUS)).toBe(false)
    expect(isTier1QueuePending(TIER1_FAILED_STATUS)).toBe(false)
    expect(isTier1QueuePending('queued')).toBe(false)
    expect(isTier1QueuePending(BLANK_OWNER_SKIP_STATUS)).toBe(false)
    expect(isTier1QueuePending(null)).toBe(false)
    expect(isTier1QueuePending('')).toBe(false)
  })

  it('answers "this row belongs to the Tier 1 lane" for terminals too', () => {
    // isTier1QueueRow is the wider question, and it is the one lib/trace/rowSkipReason.ts asks:
    // a SETTLED Tier 1 bulk row is exactly the row whose own outcome sentence must be served.
    for (const value of ALL_TIER1_VALUES) {
      expect(isTier1QueueRow(value), value).toBe(true)
    }
    expect(isTier1QueueRow('queued')).toBe(false)
    expect(isTier1QueueRow('processing_2')).toBe(false)
    expect(isTier1QueueRow(ENTITY_TRACE_FAILED_STATUS)).toBe(false)
    expect(isTier1QueueRow(BLANK_OWNER_SKIP_STATUS)).toBe(false)
    expect(isTier1QueueRow('found')).toBe(false)
    expect(isTier1QueueRow(null)).toBe(false)
    expect(isTier1QueueRow(undefined)).toBe(false)
  })

  it('walks one rung up per dead claim and then gives up terminally', () => {
    expect(tier1NextAfterFailedAttempt(1)).toEqual({ status: 'tier1_queued_2', exhausted: false })
    expect(tier1NextAfterFailedAttempt(4)).toEqual({ status: 'tier1_queued_5', exhausted: false })
    expect(tier1NextAfterFailedAttempt(5)).toEqual({ status: 'tier1_failed', exhausted: true })
    // Above the ladder is exhausted, never a rung that does not exist.
    expect(tier1NextAfterFailedAttempt(9)).toEqual({ status: 'tier1_failed', exhausted: true })
  })
})
