import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTraceCompleted } from '@/lib/trace/traceCompletedWebhook'

let posts: Array<Record<string, unknown>> = []

beforeEach(() => {
  posts = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: unknown, init: unknown) => {
    posts.push(JSON.parse(String((init as RequestInit).body)))
    return new Response('{}', { status: 200 })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const base = {
  webhookUrl: 'https://customer.example.invalid/hook',
  traceId: 't-1',
  status: 'no_match' as const,
  result: null,
  charge: 0,
  propertyRecord: null,
  ownerType: 'individual',
}

describe('trace.completed carries the tier and the Tier 1 outcome', () => {
  it('stamps tier 1 and the three outcome keys on a supplied-owner trace', () => {
    // MUTATION: hard-code `tier: TRACE_TIER.PER_RECORD_SUBMITTED` back into the payload and this goes red.
    dispatchTraceCompleted({
      ...base, tier: 1, foundBy: null, outcomeCode: 'no_match',
      skipReason: 'We looked this owner up by address and found no match. You were not charged.',
    })
    expect(posts[0]).toMatchObject({
      event: 'trace.completed', tier: 1, found_by: null, outcome_code: 'no_match',
      skip_reason: 'We looked this owner up by address and found no match. You were not charged.',
      property_record: null,
    })
  })

  it('keeps tier 2 on a Full Property Trace, with the outcome keys present and null', () => {
    dispatchTraceCompleted({ ...base, tier: 2 })
    expect(posts[0]).toMatchObject({ tier: 2, found_by: null, outcome_code: null, skip_reason: null })
    expect(Object.keys(posts[0])).toEqual(expect.arrayContaining(['found_by', 'outcome_code', 'skip_reason']))
  })
})
