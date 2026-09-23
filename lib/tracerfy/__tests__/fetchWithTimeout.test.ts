import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callTimeoutMs, fetchTextWithTimeout, VendorTimeoutError } from '@/lib/tracerfy/fetchWithTimeout'
import { VENDOR_TIMEOUT } from '@/lib/constants'

/** A fetch that never answers, and rejects only when its signal aborts, as the real one does. */
const hangingFetch = () =>
  vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        )
      })
  )

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('fetchTextWithTimeout', () => {
  it('aborts a call that never answers and says it timed out', async () => {
    // MUTATION: delete the setTimeout that aborts, and this test hangs until vitest fails it.
    vi.stubGlobal('fetch', hangingFetch())
    const pending = fetchTextWithTimeout('https://vendor.example.invalid/x', { method: 'POST' }, 1_000)
    const settled = expect(pending).rejects.toBeInstanceOf(VendorTimeoutError)
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
  })

  it('reads the body inside the timed window and returns status and text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 404, ok: false, text: async () => '{"hit":false}' }) as unknown as Response)
    )
    await expect(fetchTextWithTimeout('https://vendor.example.invalid/x', {}, 1_000)).resolves.toEqual({
      status: 404,
      ok: false,
      text: '{"hit":false}',
    })
  })

  it('passes a real transport error through unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(fetchTextWithTimeout('https://vendor.example.invalid/x', {}, 1_000)).rejects.toThrow('fetch failed')
  })
})

describe('callTimeoutMs', () => {
  it('never exceeds the per-call ceiling and honours a tighter request budget', () => {
    // MUTATION: return `requested` unclamped and the 60_000 row goes red.
    expect(callTimeoutMs()).toBe(VENDOR_TIMEOUT.CALL_MS)
    expect(callTimeoutMs(60_000)).toBe(VENDOR_TIMEOUT.CALL_MS)
    expect(callTimeoutMs(7_000)).toBe(7_000)
    expect(callTimeoutMs(0)).toBe(VENDOR_TIMEOUT.CALL_MS)
  })
})
