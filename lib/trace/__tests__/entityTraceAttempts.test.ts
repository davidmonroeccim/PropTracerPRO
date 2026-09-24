import { describe, expect, it } from 'vitest'
import {
  ENTITY_PROCESSING_STATUSES,
  ENTITY_QUEUED_STATUSES,
  ENTITY_TRACE_ATTEMPTS,
  ENTITY_TRACE_FAILED_REASON,
  ENTITY_TRACE_FAILED_STATUS,
  MAX_ENTITY_TRACE_ATTEMPTS,
  attemptOf,
  entityTraceFailureReason,
  isEntityTraceFailed,
  isEntityTracePending,
  nextAfterFailedAttempt,
  processingStatusFor,
  queuedStatusFor,
} from '@/lib/trace/entityTraceAttempts'

describe('the legacy entity ladder', () => {
  it('keeps the bare queued and processing for attempt 1, so no row needs a backfill', () => {
    // 1,298 rows carry a value on this column (measured 2026-09-20) and the oldest of them were
    // written before the ladder existed. Renaming attempt 1 would strand every one of them.
    expect(MAX_ENTITY_TRACE_ATTEMPTS).toBe(5)
    expect(ENTITY_TRACE_ATTEMPTS).toEqual([1, 2, 3, 4, 5])
    expect(queuedStatusFor(1)).toBe('queued')
    expect(processingStatusFor(1)).toBe('processing')
    expect(ENTITY_QUEUED_STATUSES).toEqual([
      'queued',
      'queued_2',
      'queued_3',
      'queued_4',
      'queued_5',
    ])
    expect(ENTITY_PROCESSING_STATUSES).toEqual([
      'processing',
      'processing_2',
      'processing_3',
      'processing_4',
      'processing_5',
    ])
    expect(ENTITY_TRACE_FAILED_STATUS).toBe('entity_trace_failed')
  })

  it('fits VARCHAR(20), with one character to spare on the longest value', () => {
    const all = [
      ...ENTITY_QUEUED_STATUSES,
      ...ENTITY_PROCESSING_STATUSES,
      ENTITY_TRACE_FAILED_STATUS,
    ]
    for (const value of all) {
      expect(value.length, `${value} is ${value.length} characters`).toBeLessThanOrEqual(20)
    }
    expect(ENTITY_TRACE_FAILED_STATUS.length).toBe(19)
  })

  it('reads the attempt out of the status, and an unknown value as attempt 1', () => {
    expect(attemptOf('queued')).toBe(1)
    expect(attemptOf('processing')).toBe(1)
    expect(attemptOf('queued_4')).toBe(4)
    expect(attemptOf('processing_2')).toBe(2)
    expect(attemptOf('queued_9')).toBe(5)
    expect(attemptOf(ENTITY_TRACE_FAILED_STATUS)).toBe(1)
    expect(attemptOf(null)).toBe(1)
    // A Tier 1 value must NOT read as an entity attempt: the two lanes share this column.
    expect(attemptOf('tier1_queued_3')).toBe(1)
  })

  it('answers PENDING for a rung or a claim and not for the terminal', () => {
    for (const value of [...ENTITY_QUEUED_STATUSES, ...ENTITY_PROCESSING_STATUSES]) {
      expect(isEntityTracePending(value), value).toBe(true)
    }
    expect(isEntityTracePending(ENTITY_TRACE_FAILED_STATUS)).toBe(false)
    expect(isEntityTracePending('found')).toBe(false)
    expect(isEntityTracePending('skipped_no_owner')).toBe(false)
    expect(isEntityTracePending(null)).toBe(false)
    expect(isEntityTracePending('')).toBe(false)
    // And it does NOT claim a Tier 1 queue row, which shares the column.
    expect(isEntityTracePending('tier1_queued')).toBe(false)
    expect(isEntityTracePending('tier1_processing_2')).toBe(false)
  })

  it('walks one rung up per failed attempt and then gives up terminally', () => {
    expect(nextAfterFailedAttempt(1)).toEqual({ status: 'queued_2', exhausted: false })
    expect(nextAfterFailedAttempt(4)).toEqual({ status: 'queued_5', exhausted: false })
    expect(nextAfterFailedAttempt(5)).toEqual({
      status: ENTITY_TRACE_FAILED_STATUS,
      exhausted: true,
    })
    expect(nextAfterFailedAttempt(9)).toEqual({
      status: ENTITY_TRACE_FAILED_STATUS,
      exhausted: true,
    })
  })

  it('serves the exhaustion sentence for the terminal value and nothing else', () => {
    expect(isEntityTraceFailed(ENTITY_TRACE_FAILED_STATUS)).toBe(true)
    expect(isEntityTraceFailed('queued')).toBe(false)
    expect(entityTraceFailureReason(ENTITY_TRACE_FAILED_STATUS)).toBe(ENTITY_TRACE_FAILED_REASON)
    expect(entityTraceFailureReason('queued')).toBeNull()
    expect(entityTraceFailureReason('tier1_failed')).toBeNull()
    expect(entityTraceFailureReason(null)).toBeNull()
  })

  it('states the charge, quotes no price and invites no resend', () => {
    // Spec 7.3, already enforced for the sibling sentences: every sentence states the charge; no
    // price, no dollar sign, no dash, no asterisk, no emoji; and resend advice belongs to exactly
    // two outcomes, neither of which is this one (blankOwnerSkip.ts explains why at length: the
    // dedup hash is address-only, so the resend this sentence used to invite was silently dropped).
    expect(ENTITY_TRACE_FAILED_REASON).toContain('you were not charged')
    expect(ENTITY_TRACE_FAILED_REASON).not.toMatch(/[$*—–]/)
    expect(ENTITY_TRACE_FAILED_REASON).not.toMatch(/send it again|try again/i)
  })
})
