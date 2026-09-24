import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  VENDOR_RATE_LIMIT,
  pruneVendorRateWindows,
  reservationForSteps,
  reserveVendorCalls,
} from '@/lib/trace/vendorRateBudget'

/** An admin client whose rpc() answers from a script, recording what it was asked. */
function stubAdmin(answers: Array<{ data: boolean | null; error: { message: string } | null }>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  let i = 0
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return answers[i++] ?? { data: null, error: { message: 'no answer scripted' } }
    }),
    from: vi.fn(() => ({
      delete: () => ({ lt: async () => ({ error: null }) }),
    })),
  }
  return { client: client as unknown as SupabaseClient, calls }
}

describe('reserveVendorCalls', () => {
  it('is 450 per 60 seconds for each vendor, 50 under the vendor limit (spec 5.3)', () => {
    expect(VENDOR_RATE_LIMIT.tracerfy).toBe(450)
    expect(VENDOR_RATE_LIMIT.fastappend).toBe(450)
  })

  it('asks the RPC once per vendor, with that vendor s own limit', async () => {
    const { client, calls } = stubAdmin([
      { data: true, error: null },
      { data: true, error: null },
    ])
    expect(await reserveVendorCalls(client, { tracerfy: 1, fastappend: 1 })).toBe(true)
    expect(calls).toEqual([
      { fn: 'claim_vendor_rate', args: { p_vendor: 'tracerfy', p_calls: 1, p_limit: 450 } },
      { fn: 'claim_vendor_rate', args: { p_vendor: 'fastappend', p_calls: 1, p_limit: 450 } },
    ])
  })

  it('asks nothing at all when a record plans no call to that vendor', async () => {
    const { client, calls } = stubAdmin([{ data: true, error: null }])
    expect(await reserveVendorCalls(client, { tracerfy: 1, fastappend: 0 })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].args.p_vendor).toBe('tracerfy')
  })

  it('grants nothing when either vendor refuses', async () => {
    const { client } = stubAdmin([
      { data: true, error: null },
      { data: false, error: null },
    ])
    expect(await reserveVendorCalls(client, { tracerfy: 1, fastappend: 1 })).toBe(false)
  })

  it('REFUSES when the RPC errors, rather than assuming capacity', async () => {
    // An unreadable budget is not a budget of plenty. Assuming one invents the answer to the only
    // question this function exists to ask, and the cost of a false refusal is one minute's wait
    // while the cost of a false grant is tripping a limit that is SHARED across every customer.
    const { client } = stubAdmin([{ data: null, error: { message: 'connection reset' } }])
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await reserveVendorCalls(client, { tracerfy: 1 })).toBe(false)
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('REFUSES when the RPC answers no boolean at all, rather than reading it as a grant', async () => {
    // THE OTHER HALF OF "ANYTHING BUT TRUE IS A REFUSAL", and it needs its own case because the
    // error branch above cannot reach it. A `data: null` with NO error is an RPC that answered
    // something this module cannot read as a yes: a renamed function, a changed return type, a
    // PostgREST shape nobody expected. The contract is `data !== true` refuses, not
    // `data === false` refuses, so a null can never be spent as capacity.
    // MUTATION: `if (data === false) return false` and this goes red.
    const { client } = stubAdmin([{ data: null, error: null }])
    expect(await reserveVendorCalls(client, { tracerfy: 1 })).toBe(false)
  })

  it('grants an empty reservation without touching the database', async () => {
    const { client, calls } = stubAdmin([])
    expect(await reserveVendorCalls(client, {})).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('prunes the bucket table, and nothing else', async () => {
    const { client } = stubAdmin([])
    const from = vi.mocked((client as unknown as { from: ReturnType<typeof vi.fn> }).from)
    await pruneVendorRateWindows(client)
    expect(from).toHaveBeenCalledWith('vendor_rate_windows')
    expect(from).toHaveBeenCalledTimes(1)
  })
})

describe('reservationForSteps', () => {
  it('counts every step against the pool it actually draws, dossier steps included', () => {
    // THE DOSSIER IS A TRACERFY CALL. executeRoute's CONTACT_VENDOR_BY_STEP maps DOSSIER_* to null,
    // because a dossier is not a CONTACT vendor, and reusing that map here would reserve nothing for
    // the two most expensive calls in the product.
    expect(
      reservationForSteps([
        { kind: 'DOSSIER_APN' },
        { kind: 'DOSSIER_ADDRESS' },
        { kind: 'TRACERFY_INSTANT_NAMED' },
        { kind: 'TRACERFY_PARCEL_APN' },
        { kind: 'FASTAPPEND_ENTITY' },
      ])
    ).toEqual({ tracerfy: 4, fastappend: 1 })
  })

  it('asks for nothing when there are no steps, which is a no_lookup_key record', () => {
    expect(reservationForSteps([])).toEqual({ tracerfy: 0, fastappend: 0 })
  })

  it('asks ONE call of ONE vendor for a single step, which is how canSpend uses it', () => {
    // THE HOT PATH ON THE TIER 1 LANE. Its canSpend hook calls this with exactly one step, because
    // that lane reserves per CALL. The TIER 2 cron passes a whole plan's steps instead, once per
    // record, which is the multi-step form above. The list form is kept because it is the same map
    // and it is where the pool assignment is actually asserted.
    expect(reservationForSteps([{ kind: 'FASTAPPEND_ENTITY' }])).toEqual({
      tracerfy: 0,
      fastappend: 1,
    })
    expect(reservationForSteps([{ kind: 'TRACERFY_INSTANT_NAMED' }])).toEqual({
      tracerfy: 1,
      fastappend: 0,
    })
    expect(reservationForSteps([{ kind: 'DOSSIER_ADDRESS' }])).toEqual({
      tracerfy: 1,
      fastappend: 0,
    })
  })
})
