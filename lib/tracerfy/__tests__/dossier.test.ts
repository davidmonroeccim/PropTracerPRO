import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDossierRequest,
  lookupDossier,
  parseDossierResponse,
  type DossierKey,
} from '@/lib/tracerfy/dossier'
import { VENDOR_TIMEOUT } from '@/lib/constants'

import entityApn from './fixtures/entity-hit-apn.json'
import entityAddress from './fixtures/entity-hit-address.json'
import individualHit from './fixtures/individual-hit.json'
import twoOwnerHit from './fixtures/two-owner-hit.json'
import missApn from './fixtures/miss-apn.json'
import missAddress from './fixtures/miss-address.json'

/**
 * Fixtures are SANITIZED derivatives of real vendor responses. See
 * ./fixtures/README.md for exactly what was kept and what was scrubbed.
 * These tests must never read tasks/research-test/ directly: it is gitignored
 * purchased PII, so such a test would pass here and fail everywhere else.
 */

const APN_KEY: DossierKey = { mode: 'apn', apn: '10-000052', county: 'Stark', state: 'OH' }
const ADDRESS_KEY: DossierKey = {
  mode: 'address',
  address: '1815 S State St',
  city: 'Salt Lake City',
  state: 'UT',
}

const ENDPOINT = 'https://tracerfy.com/v1/api/property-search/lookup/'

/** An ok Response carrying `body`, enough of the shape for the client to read. */
const okResponse = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response

const errorResponse = (status: number, text = 'upstream said no') =>
  ({
    ok: false,
    status,
    json: async () => {
      throw new Error('not json')
    },
    text: async () => text,
  }) as unknown as Response

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  process.env.TRACERFY_API_KEY = 'test-key'
  delete process.env.TRACERFY_API_URL
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseDossierResponse — owners', () => {
  it('surfaces an entity name intact from last_name, with first_name empty', () => {
    // The whole entity name arrives in last_name. "Colmaven, Llc" keeps its comma.
    const result = parseDossierResponse(entityAddress.response)

    expect(result.success).toBe(true)
    expect(result.hit).toBe(true)
    expect(result.owners).toHaveLength(1)
    expect(result.owners[0].last_name).toBe('Colmaven, Llc')
    expect(result.owners[0].first_name).toBe('')
    expect(result.creditsDeducted).toBe(10)
  })

  it('does not classify owner type — that is classifyOwnerName()s job, not this clients', () => {
    const result = parseDossierResponse(entityApn.response)
    expect(result.owners[0].last_name).toBe('Cutting Edge Hodings Llc')
    expect(result).not.toHaveProperty('ownerType')
    // The vendor's own corporate_owned flag is unreliable and must survive untouched
    // in the raw record rather than being promoted to a decision here.
    expect(result.property?.corporate_owned).toBe(true)
  })

  it('parses an individual hit with both names populated', () => {
    const result = parseDossierResponse(individualHit.response)

    expect(result.hit).toBe(true)
    expect(result.owners).toHaveLength(1)
    expect(result.owners[0].first_name).toBe('Testowner')
    expect(result.owners[0].last_name).toBe('Placeholder')
    expect(result.owners[0].age).toBe('00')
  })

  it('keeps BOTH owners when a parcel returns two', () => {
    // Guards a parser that reads owners[0] and stops.
    const result = parseDossierResponse(twoOwnerHit.response)

    expect(result.owners).toHaveLength(2)
    expect(result.owners[0].first_name).toBe('Testowner')
    expect(result.owners[1].first_name).toBe('')
    expect(result.owners[1].last_name).toBe('Placeholder Family Living Trust')
  })

  it('returns the mailing address', () => {
    const result = parseDossierResponse(entityAddress.response)
    expect(result.mailingAddress).toEqual(entityAddress.response.mailing_address)
  })
})

describe('parseDossierResponse — a miss', () => {
  it.each([
    ['apn', missApn.response],
    ['address', missAddress.response],
  ])('a %s miss succeeds, reports hit:false and implies no charge', (_mode, body) => {
    const result = parseDossierResponse(body)

    expect(result.success).toBe(true)
    expect(result.hit).toBe(false)
    expect(result.creditsDeducted).toBe(0) // free on a miss
    expect(result.owners).toEqual([])
    expect(result.property).toBeNull()
    expect(result.mailingAddress).toBeNull()
    expect(result.error).toBeUndefined()
  })
})

describe('the fidelity fence', () => {
  // DATA FIDELITY RULE: the property object is returned RAW AND COMPLETE. Downstream
  // decides what to display and what to export. If a future "cleanup" subsets, renames
  // or filters this record, these assertions must go red.
  it.each([
    ['entity, apn mode', entityApn],
    ['entity, address mode', entityAddress],
    ['individual', individualHit],
    ['two owners', twoOwnerHit],
  ])('returns all 86 property keys for a %s hit', (_label, fixture) => {
    const result = parseDossierResponse(fixture.response)

    expect(result.property).not.toBeNull()
    expect(Object.keys(result.property!)).toHaveLength(86)
    expect(result.property).toEqual(fixture.response.property)
  })

  it('preserves the exact key order and the fields we block from display', () => {
    const result = parseDossierResponse(entityApn.response)

    expect(Object.keys(result.property!)).toEqual(Object.keys(entityApn.response.property))
    // The 15 propensity fields and the provably-wrong ones are blocked from DISPLAY,
    // not from storage. Dropping them here would lose data the $0.20 already bought.
    expect(result.property).toHaveProperty('sell_propensity_score')
    expect(result.property).toHaveProperty('sell_propensity_factors')
    expect(result.property).toHaveProperty('solar_renovate_propensity_factors')
    expect(result.property).toHaveProperty('estimated_value')
    expect(result.property).toHaveProperty('beds')
  })

  it('keeps null-valued keys rather than stripping them', () => {
    // A county that does not publish beds returns null. Empty means empty; the key stays.
    const result = parseDossierResponse(entityApn.response)
    expect(result.property).toHaveProperty('beds', null)
    expect(result.property).toHaveProperty('tax_delinquent_year', null)
  })
})

describe('parseDossierResponse: the contacts block (D21 b)', () => {
  it('surfaces the nameless contacts on a hit', () => {
    const result = parseDossierResponse(individualHit.response)
    expect(result.contacts).toEqual({
      ownerName: null,
      phones: [
        { number: '5555550100', type: 'mobile' },
        { number: '5555550101', type: 'landline' },
      ],
      emails: ['redacted@example.invalid'],
      mailingAddress: null,
    })
  })

  it('carries none on a miss', () => {
    expect(parseDossierResponse(missApn.response).contacts ?? null).toBeNull()
  })

  it('returns null for a block with no phone and no email', () => {
    const body = { ...individualHit.response, contacts: { has_contact: false, phones: [], emails: [] } }
    expect(parseDossierResponse(body).contacts).toBeNull()
  })
})

describe('buildDossierRequest', () => {
  it('builds an APN body with a bare county name', () => {
    expect(buildDossierRequest(APN_KEY)).toEqual({
      apn: '10-000052',
      county: 'Stark',
      state: 'OH',
    })
  })

  it('builds an address body, omitting zip_code when absent', () => {
    expect(buildDossierRequest(ADDRESS_KEY)).toEqual({
      address: '1815 S State St',
      city: 'Salt Lake City',
      state: 'UT',
    })
  })

  it('includes zip_code when present', () => {
    expect(
      buildDossierRequest({
        mode: 'address',
        address: '4898 Hills And Dales Rd',
        city: 'Canton',
        state: 'OH',
        zip_code: '44708',
      }),
    ).toEqual({
      address: '4898 Hills And Dales Rd',
      city: 'Canton',
      state: 'OH',
      zip_code: '44708',
    })
  })

  it('emits only the declared modes fields even when the caller smuggles in the other key', () => {
    // Sending both keys is a 400. The body can never carry both.
    const contaminated = {
      mode: 'apn',
      apn: '10-000052',
      county: 'Stark',
      state: 'OH',
      address: '4898 Hills And Dales Rd',
      city: 'Canton',
    } as unknown as DossierKey

    expect(buildDossierRequest(contaminated)).toEqual({
      apn: '10-000052',
      county: 'Stark',
      state: 'OH',
    })
  })
})

describe('lookupDossier — request shaping', () => {
  it('posts the APN body to the lookup endpoint with bearer auth', async () => {
    fetchMock.mockResolvedValue(okResponse(entityApn.response))

    const result = await lookupDossier(APN_KEY)

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(ENDPOINT)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer test-key')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ apn: '10-000052', county: 'Stark', state: 'OH' })
  })

  it('posts the address body', async () => {
    fetchMock.mockResolvedValue(okResponse(entityAddress.response))

    await lookupDossier(ADDRESS_KEY)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      address: '1815 S State St',
      city: 'Salt Lake City',
      state: 'UT',
    })
  })

  it('does ONE lookup per call — it never tries the second key itself', async () => {
    // Sequencing APN then address and stopping at the first hit is the caller's job.
    fetchMock.mockResolvedValue(okResponse(missApn.response))

    const result = await lookupDossier(APN_KEY)

    expect(result.hit).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to send both keys at once, and does not spend to find out', async () => {
    const contaminated = {
      mode: 'apn',
      apn: '10-000052',
      county: 'Stark',
      state: 'OH',
      address: '4898 Hills And Dales Rd',
      city: 'Canton',
      state_: 'OH',
    } as unknown as DossierKey

    const result = await lookupDossier(contaminated)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/both/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an incomplete key rather than posting a body that cannot match', async () => {
    const result = await lookupDossier({
      mode: 'apn',
      apn: '',
      county: 'Stark',
      state: 'OH',
    })

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('lookupDossier — failure paths never throw', () => {
  it('returns an error when the API key is missing', async () => {
    delete process.env.TRACERFY_API_KEY

    const result = await lookupDossier(APN_KEY)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/api key/i)
    expect(result.hit).toBe(false)
    expect(result.owners).toEqual([])
    expect(result.property).toBeNull()
    expect(result.creditsDeducted).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [429, /rate limit/i],
    [503, /unavailable/i],
    [401, /auth/i],
    [403, /auth/i],
    [400, /./],
    [500, /./],
  ])('returns success:false on a %i without throwing', async (status, match) => {
    fetchMock.mockResolvedValue(errorResponse(status))

    const result = await lookupDossier(APN_KEY)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(match)
    expect(result.hit).toBe(false)
    expect(result.creditsDeducted).toBe(0)
  })

  it('returns success:false when fetch itself throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))

    const result = await lookupDossier(APN_KEY)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unavailable/i)
    expect(result.property).toBeNull()
  })

  it('returns success:false when the body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
      text: async () => '<html>502</html>',
    } as unknown as Response)

    const result = await lookupDossier(APN_KEY)

    expect(result.success).toBe(false)
  })

  it('returns success:false on a JSON body that is not a dossier response', async () => {
    fetchMock.mockResolvedValue(okResponse('not an object'))

    const result = await lookupDossier(APN_KEY)

    expect(result.success).toBe(false)
    expect(result.property).toBeNull()
  })

  it('does NOT retry — one call in, one call out', async () => {
    // Retry is emergent elsewhere in this codebase. A retry here silently doubles spend.
    fetchMock.mockResolvedValue(errorResponse(503))

    await lookupDossier(APN_KEY)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('lookupDossier — end to end against a sanitized payload', () => {
  it('returns the full parsed record on a hit', async () => {
    fetchMock.mockResolvedValue(okResponse(twoOwnerHit.response))

    const result = await lookupDossier({
      mode: 'apn',
      apn: '12-022-0101',
      county: 'Davis',
      state: 'UT',
    })

    expect(result.success).toBe(true)
    expect(result.hit).toBe(true)
    expect(result.creditsDeducted).toBe(10)
    expect(result.owners).toHaveLength(2)
    expect(Object.keys(result.property!)).toHaveLength(86)
    expect(result.mailingAddress).not.toBeNull()
    expect(result.error).toBeUndefined()
  })
})

describe('lookupDossier: the per-call ceiling (D7)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ends a hung dossier call as a FAILURE, never a miss', async () => {
    // MUTATION: call fetch directly in lookupDossier and this hangs red.
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    const pending = lookupDossier(APN_KEY)
    await vi.advanceTimersByTimeAsync(VENDOR_TIMEOUT.CALL_MS)
    const result = await pending
    expect(result).toMatchObject({ success: false, hit: false, error: 'Tracerfy dossier did not answer within 25 s' })
  })
})
