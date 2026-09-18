import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * getAnalytics()'s return type used to declare `credits_remaining`,
 * `credits_used`, `total_jobs`, `total_records` -- field names the vendor
 * never sends. Zero call sites, so it was never exercised, but a guard built
 * on it (`data.credits_remaining < needed`) would evaluate `undefined < 300`
 * as `false` and silently block nothing. The real response, confirmed live
 * 2026-09-18 (balance 10694, queues_pending 0), carries `balance`,
 * `total_queues`, `properties_traced`, `queues_pending`, `queues_completed`.
 *
 * This file proves the type against the shape in two ways: the runtime
 * assertions below, AND `npx tsc --noEmit`, which type-checks this file
 * (tsconfig includes `**\/*.ts` with no test exclusion) -- so a reintroduced
 * fictional field name fails typecheck on `res.data.balance` etc. even
 * before vitest runs.
 *
 * getAnalytics() reads its API key from a MODULE-LEVEL constant captured at
 * import time (unlike lookupBusinessTrace/lookupPersonTrace, which
 * deliberately read env at CALL time -- see the comment above
 * contactFailure in client.ts). Exercising both the present-key and
 * absent-key paths therefore needs a fresh, isolated module import per test
 * rather than mutating process.env after the fact. That capture-at-load
 * behavior is a pre-existing property of getAnalytics, not one of this
 * sub-phase's two defects, so it is worked around here rather than changed.
 */

const ENDPOINT = 'https://tracerfy.com/v1/api/analytics/'

const okResponse = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response

const errorResponse = (status: number) =>
  ({
    ok: false,
    status,
    json: async () => {
      throw new Error('not json')
    },
    text: async () => 'upstream said no',
  }) as unknown as Response

let fetchMock: ReturnType<typeof vi.fn>

/** A fresh import of the client module with TRACERFY_API_KEY set (or deleted) before load. */
const freshClient = async (apiKey: string | undefined) => {
  if (apiKey === undefined) delete process.env.TRACERFY_API_KEY
  else process.env.TRACERFY_API_KEY = apiKey
  delete process.env.TRACERFY_API_URL
  vi.resetModules()
  return import('@/lib/tracerfy/client')
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('getAnalytics', () => {
  it('parses the REAL vendor field names, not the fictional ones the type used to declare', async () => {
    // MUTATION: revert the getAnalytics return type to
    // credits_remaining/credits_used/total_jobs/total_records and this file
    // fails `npx tsc --noEmit` on the typed accesses below (Property
    // 'balance' does not exist on type ...) -- the exact silent-guard bug
    // this test exists to catch, since vitest alone would not have caught it.
    const { getAnalytics } = await freshClient('test-key')
    fetchMock.mockResolvedValue(
      okResponse({
        balance: 10694,
        total_queues: 42,
        properties_traced: 1069,
        queues_pending: 0,
        queues_completed: 42,
      })
    )

    const res = await getAnalytics()

    expect(fetchMock.mock.calls[0][0]).toBe(ENDPOINT)
    expect(res.success).toBe(true)
    const data = res.data!
    expect(data.balance).toBe(10694)
    expect(data.total_queues).toBe(42)
    expect(data.properties_traced).toBe(1069)
    expect(data.queues_pending).toBe(0)
    expect(data.queues_completed).toBe(42)
  })

  it('a transport error is a failure', async () => {
    const { getAnalytics } = await freshClient('test-key')
    fetchMock.mockResolvedValue(errorResponse(500))
    const res = await getAnalytics()
    expect(res.success).toBe(false)
  })

  it('a thrown fetch is a failure, not an exception', async () => {
    const { getAnalytics } = await freshClient('test-key')
    fetchMock.mockRejectedValue(new Error('socket hang up'))
    const res = await getAnalytics()
    expect(res.success).toBe(false)
  })

  it('refuses to call out without an API key', async () => {
    const { getAnalytics } = await freshClient(undefined)
    const res = await getAnalytics()
    expect(res.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
