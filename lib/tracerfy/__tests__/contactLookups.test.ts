import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  lookupBusinessTrace,
  lookupPersonTrace,
  parseBusinessTraceResponse,
  parsePersonTraceResponse,
  personMatchesName,
} from '@/lib/tracerfy/client'

import businessHit from './fixtures/business-hit.json'
import businessAgentManager from './fixtures/business-hit-agent-manager.json'
import businessMiss from './fixtures/business-miss.json'
import personHit from './fixtures/person-hit.json'
import personMiss from './fixtures/person-miss.json'
import apnHit from './fixtures/apn-person-hit.json'
import apnMiss from './fixtures/apn-miss.json'

/**
 * The two SYNCHRONOUS contact endpoints Full Property Trace spends on.
 *
 * Fixtures are SANITIZED derivatives of real 2026-09-16 vendor responses; see
 * ./fixtures/README.md. These tests must never read tasks/research-test/,
 * which is gitignored purchased PII.
 *
 * The distinction these tests exist to protect: a MISS is an answer (free,
 * final, and under tier 2 still BILLED) and a FAILURE is "we could not ask"
 * (free, and never billed). Both come back with contacts: null, so only
 * `success` separates them, and executeRoute bills on `success`.
 */

const FASTAPPEND_URL = 'https://app.fastappend.com/v1/api/business-trace/lookup/'
const TRACERFY_URL = 'https://tracerfy.com/v1/api/trace/lookup/'
const TRACERFY_PARCEL_URL = 'https://tracerfy.com/v1/api/trace/parcel/lookup/'

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

/**
 * A Response whose body can be read exactly once, via EITHER `.text()` or
 * `.json()`. A second call, on either method, throws -- so an implementation
 * that reads the body more than once (the exact shape of the "body already
 * consumed" runtime error the P1 fix has to avoid) fails loudly instead of
 * silently passing because no test happened to double-read.
 */
const singleReadResponse = (status: number, body: unknown): Response => {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body)
  let consumed = false
  const read = () => {
    if (consumed) throw new Error('body stream already read')
    consumed = true
    return bodyText
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => read(),
    json: async () => JSON.parse(read()),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

const ENTITY = { company_name: 'Abc Rentals Llc', state: 'UT' }
const PERSON = {
  first_name: 'Testowner',
  last_name: 'Placeholder',
  address: '305 W Center St',
  city: 'Clearfield',
  state: 'UT',
  zip: '84015',
  find_owner: false,
}

beforeEach(() => {
  process.env.TRACERFY_API_KEY = 'test-key'
  process.env.FASTAPPEND_API_KEY = 'test-fa-key'
  delete process.env.TRACERFY_API_URL
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The body that was POSTed on the Nth fetch. */
const sentBody = (call = 0): Record<string, unknown> =>
  JSON.parse(String(fetchMock.mock.calls[call][1].body))

describe('parseBusinessTraceResponse', () => {
  it('a miss is an ANSWER, not a failure, even though it carries an error string', () => {
    // { error: "Company not found: X (OH)", hit: false, credits_deducted: 0 }
    // Reading `error` as a failure makes every miss unbillable, and under tier 2
    // a miss IS billed.
    // MUTATION: gate on body.error instead of body.hit and this goes red.
    const res = parseBusinessTraceResponse(businessMiss.response)
    expect(res.success).toBe(true)
    expect(res.hit).toBe(false)
    expect(res.contacts).toBeNull()
    expect(res.error).toBeUndefined()
  })

  it('returns the principal, never the pure registered agent', () => {
    // A registered agent is a service of process. Returning one as the owner
    // contact is how contacts named "Secretary of State" reached customers.
    // MUTATION: take associated_people[0] blindly and this stays green -- the
    // fixture's principal IS first -- which is why the ordering test below
    // exists as well.
    const res = parseBusinessTraceResponse(businessHit.response)
    expect(res.success).toBe(true)
    expect(res.hit).toBe(true)
    expect(res.contacts?.ownerName).toBe('Testowner Placeholder')
    expect(res.contacts?.phones.map((p) => p.number)).toEqual(['5550000101', '5550000102'])
    expect(res.contacts?.emails).toEqual(['principal@example.invalid'])
    expect(res.contacts?.mailingAddress).toBe('100 Placeholder Way, Redacted, ZZ, 00000')
  })

  it('prefers a principal even when the agent outranks them', () => {
    const reordered = {
      ...businessHit.response,
      associated_people: [
        { ...businessHit.response.associated_people[1], rank: 1 },
        { ...businessHit.response.associated_people[0], rank: 2 },
      ],
    }
    // MUTATION: drop the is_registered_agent term from byPrincipalThenRank and
    // this goes red.
    expect(parseBusinessTraceResponse(reordered).contacts?.ownerName).toBe('Testowner Placeholder')
  })

  it('KEEPS a "REGISTERED AGENT,MANAGER" — they are a manager', () => {
    // 1 of the 5 saved hits returns exactly this person and nobody else.
    // Excluding everyone the flag marks throws away 20% of the hits we paid for.
    // MUTATION: filter on is_registered_agent alone and this goes red.
    const res = parseBusinessTraceResponse(businessAgentManager.response)
    expect(res.hit).toBe(true)
    expect(res.contacts?.ownerName).toBe('Testowner Placeholder')
    expect(res.contacts?.emails).toEqual(['manager@example.invalid'])
  })

  it('falls back to the company block with NO name when only an agent is returned', () => {
    const agentOnly = {
      ...businessHit.response,
      associated_people: [businessHit.response.associated_people[1]],
    }
    const res = parseBusinessTraceResponse(agentOnly)
    expect(res.hit).toBe(true)
    // The company's own phones and emails are real and were paid for...
    expect(res.contacts?.phones.map((p) => p.number)).toEqual(['5550000001', '5550000002'])
    // ...but the agent is never named as the owner.
    expect(res.contacts?.ownerName).toBeNull()
  })

  it('a hit with no people and no company contacts returns no contacts, still a hit', () => {
    const bare = { hit: true, credits_deducted: 1, associated_people: [] }
    const res = parseBusinessTraceResponse(bare)
    expect(res).toEqual({ success: true, hit: true, contacts: null, creditsDeducted: 1 })
  })

  it('fails on a body with no hit flag', () => {
    expect(parseBusinessTraceResponse({ credits_deducted: 0 }).success).toBe(false)
    expect(parseBusinessTraceResponse('nonsense').success).toBe(false)
    expect(parseBusinessTraceResponse(null).success).toBe(false)
  })
})

describe('lookupBusinessTrace', () => {
  it('posts company_name and state to the synchronous endpoint', async () => {
    fetchMock.mockResolvedValue(okResponse(businessHit.response))
    const res = await lookupBusinessTrace(ENTITY)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(FASTAPPEND_URL)
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(sentBody()).toEqual({ company_name: 'Abc Rentals Llc', state: 'UT' })
    expect(res.hit).toBe(true)
  })

  it('does not retry', async () => {
    // A retry silently doubles a real charge.
    fetchMock.mockResolvedValue(errorResponse(503))
    await lookupBusinessTrace(ENTITY)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a transport error is a FAILURE, never a miss', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      fetchMock.mockResolvedValue(errorResponse(status))
      const res = await lookupBusinessTrace(ENTITY)
      expect(res.success).toBe(false)
      expect(res.hit).toBe(false)
      expect(res.error).toBeTruthy()
    }
  })

  it('a FastAppend 404 carrying hit:false is a MISS, not a transport failure', async () => {
    // Measured 2026-09-16 (tasks/research-test/fastappend/raw-3.json and
    // raw-11.json, sanitized here as fixtures/business-miss.json): FastAppend
    // answers a genuine miss with HTTP 404 and
    // { error: "Company not found: ...", hit: false, credits_deducted: 0 }.
    // The old code checked `!response.ok` before the body was ever read, so
    // this exact response became a contactFailure and 502'd the customer
    // after the $0.20 dossier spend had already stood. L-008.
    // MUTATION: replace `response.status >= 500` with `!response.ok` (the
    // original defect) and this test goes red -- the miss becomes a failure.
    fetchMock.mockResolvedValue(singleReadResponse(404, businessMiss.response))
    const res = await lookupBusinessTrace(ENTITY)
    expect(res).toEqual({ success: true, hit: false, contacts: null, creditsDeducted: 0 })
  })

  it('a 5xx stays a transport failure even when the body carries hit:false', async () => {
    // The controller's ruling: `hit` is the discriminator for 2xx/4xx ONLY.
    // A 5xx is the vendor's own server failing and is never billable
    // regardless of what the body contains (L-007).
    // MUTATION: delete the `response.status >= 500` short-circuit so every
    // status falls through to the body check, and this test goes red -- a
    // vendor outage that happens to echo hit:false would be billed as a miss.
    fetchMock.mockResolvedValue(singleReadResponse(500, businessMiss.response))
    const res = await lookupBusinessTrace(ENTITY)
    expect(res.success).toBe(false)
    expect(res.hit).toBe(false)
  })

  it('malformed JSON at a 2xx status is a transport failure, never an answer', async () => {
    // status alone cannot be trusted as "it worked"; the body still has to
    // parse. MUTATION: skip the JSON.parse try/catch and let a bad body throw
    // out of the function instead of returning contactFailure, and this goes
    // red (the call rejects instead of resolving to success:false).
    fetchMock.mockResolvedValue(singleReadResponse(200, 'not json at all'))
    const res = await lookupBusinessTrace(ENTITY)
    expect(res.success).toBe(false)
    expect(res.hit).toBe(false)
  })

  it('a 4xx body with no hit field is a transport failure, not an answer', async () => {
    // Same status as the real miss (404) but missing the one field that
    // makes a body trustworthy as an ANSWER.
    // MUTATION: skip the hit-flag check (call parseBusinessTraceResponse's
    // isObj/typeof guard a no-op) and this could resolve as a hit or a miss
    // instead of a failure.
    fetchMock.mockResolvedValue(singleReadResponse(404, { error: 'Company not found: X (OH)', credits_deducted: 0 }))
    const res = await lookupBusinessTrace(ENTITY)
    expect(res.success).toBe(false)
  })

  it('a thrown fetch is a failure, not an exception', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'))
    const res = await lookupBusinessTrace(ENTITY)
    expect(res.success).toBe(false)
  })

  it('refuses to spend without an API key or without a state', async () => {
    delete process.env.FASTAPPEND_API_KEY
    expect((await lookupBusinessTrace(ENTITY)).success).toBe(false)
    process.env.FASTAPPEND_API_KEY = 'test-fa-key'
    expect((await lookupBusinessTrace({ company_name: 'X Llc', state: ' ' })).success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('parsePersonTraceResponse', () => {
  it('a miss is an answer', () => {
    const res = parsePersonTraceResponse(personMiss.response)
    expect(res).toEqual({ success: true, hit: false, contacts: null, creditsDeducted: 0 })
  })

  it('matches on the NAME we asked for, not on persons[0]', () => {
    // MUTATION: return persons[0] and this goes red.
    const res = parsePersonTraceResponse(personHit.response, {
      first_name: 'Testowner',
      last_name: 'Placeholder',
    })
    expect(res.contacts?.ownerName).toBe('Testowner Placeholder')
    expect(res.contacts?.emails).toEqual(['owner1@example.invalid', 'owner2@example.invalid'])
  })

  it('does NOT prefer the person flagged property_owner', () => {
    // property_owner returned FALSE for the verified owner of record on an
    // absentee-owned parcel: the owner does not live in his own rental. In the
    // fixture the flag is on the OTHER person.
    // MUTATION: filter on property_owner and this goes red.
    const res = parsePersonTraceResponse(personHit.response, {
      first_name: 'Testowner',
      last_name: 'Placeholder',
    })
    expect(res.contacts?.ownerName).not.toBe('Someoneelse Different')
  })

  it('returns NO contacts when no person matches the owner name (D6)', () => {
    // A hit is somebody's phone numbers. If nobody returned is the owner, they are not the owner's.
    // MUTATION: put `?? persons[0]` back and this goes red.
    const res = parsePersonTraceResponse(personHit.response, { first_name: 'Nobody', last_name: 'Nothere' })
    expect(res).toMatchObject({ success: true, hit: true, contacts: null, nameNotMatched: true, creditsDeducted: 5 })
    expect(res.peopleCount).toBe(2)
    expect(res).not.toHaveProperty('people')
    // D29: no returned person's name is kept. MUTATION: return people names beside peopleCount and this goes red.
    expect(JSON.stringify(res)).not.toMatch(/Someoneelse|Different|Testowner|Placeholder/)
  })

  it('refuses to pick a person when there is no name to match on (D6 removed persons[0])', () => {
    const res = parsePersonTraceResponse(personHit.response)
    expect(res.contacts).toBeNull()
    expect(res.nameNotMatched).toBe(true)
  })

  it.each([
    ['a stray comma', { first_name: 'Testowner', last_name: 'Placeholder,' }],
    ['a suffix', { first_name: 'Testowner', last_name: 'Placeholder Jr' }],
    ['upper case', { first_name: 'TESTOWNER', last_name: 'PLACEHOLDER' }],
    ['a middle initial', { first_name: 'Testowner Q', last_name: 'Placeholder' }],
    ['a first initial only', { first_name: 'T', last_name: 'Placeholder' }],
  ])('still matches the owner through %s (spec 4.3)', (_why, want) => {
    // MUTATION: drop the punctuation strip or the suffix filter in nameTokens and a row goes red.
    expect(parsePersonTraceResponse(personHit.response, want).contacts?.ownerName).toBe('Testowner Placeholder')
  })

  it('does not swap first and last name (D22 keeps single-trace name order)', () => {
    // MUTATION: accept the reversed pair as a match and this goes red.
    const res = parsePersonTraceResponse(personHit.response, { first_name: 'Placeholder', last_name: 'Testowner' })
    expect(res.contacts).toBeNull()
    expect(res.nameNotMatched).toBe(true)
  })

  it.each([
    ['a matching last name but a different first name', { first_name: 'Mary', last_name: 'Placeholder' }],
    ['a matching first initial but a different last name', { first_name: 'Testowner', last_name: 'Nothere' }],
  ])('does not match on just one half of the name: %s (D6, mutations 7a/7b)', (_why, want) => {
    // MUTATION 7a: replace the last-name comparison with `true &&` and the second row (matching
    // first initial, differing last name) goes red. MUTATION 7b: replace the first-initial
    // comparison with `true` and the first row (matching last name, differing first name) goes
    // red. Every fixture person differs from a bad `want` in BOTH halves at once elsewhere in this
    // file, so those tests alone do not catch either half being deleted -- a same-address relative
    // (same last name) or a same-initial stranger would otherwise be billed and returned as a hit.
    const res = parsePersonTraceResponse(personHit.response, want)
    expect(res.contacts).toBeNull()
    expect(res.nameNotMatched).toBe(true)
  })

  it('personMatchesName needs both halves of both names', () => {
    expect(personMatchesName({ first_name: 'Testowner', last_name: 'Placeholder' }, { last_name: 'Placeholder' })).toBe(false)
    expect(personMatchesName({ first_name: '', last_name: 'Placeholder' }, { first_name: 'T', last_name: 'Placeholder' })).toBe(false)
    // MUTATION 7c (L-015): delete the `!wantLast.length || !gotLast.length` half of the empty-name
    // guard and this goes red -- two empty last names both tokenize to [], and
    // `[][-1] === [][-1]` is `undefined === undefined`, true.
    expect(personMatchesName({ first_name: 'Testowner', last_name: '' }, { first_name: 'T', last_name: '' })).toBe(false)
  })

  it('unwraps an array-wrapped body', () => {
    expect(parsePersonTraceResponse([personMiss.response]).success).toBe(true)
  })

  it('fails on a body with no hit flag', () => {
    expect(parsePersonTraceResponse({ persons: [] }).success).toBe(false)
  })
})

describe('lookupPersonTrace', () => {
  it('sends the named address form with find_owner false', async () => {
    // find_owner:true MISSED on the parcel the named form hit.
    // MUTATION: send find_owner:true and this goes red.
    fetchMock.mockResolvedValue(okResponse(personHit.response))
    await lookupPersonTrace(PERSON)

    expect(fetchMock.mock.calls[0][0]).toBe(TRACERFY_URL)
    expect(sentBody()).toEqual({
      address: '305 W Center St',
      city: 'Clearfield',
      state: 'UT',
      zip: '84015',
      find_owner: false,
      first_name: 'Testowner',
      last_name: 'Placeholder',
    })
  })

  it('omits an absent zip rather than sending it empty', async () => {
    fetchMock.mockResolvedValue(okResponse(personHit.response))
    await lookupPersonTrace({ ...PERSON, zip: '' })
    expect(sentBody()).not.toHaveProperty('zip')
  })

  it('routes an APN-keyed request to the parcel endpoint', async () => {
    fetchMock.mockResolvedValue(okResponse(personMiss.response))
    await lookupPersonTrace({
      first_name: '',
      last_name: '',
      parcel_id: '10000052',
      county: 'Stark',
      state: 'OH',
    })

    expect(fetchMock.mock.calls[0][0]).toBe(TRACERFY_PARCEL_URL)
    expect(sentBody()).toEqual({ parcel_id: '10000052', county: 'Stark', state: 'OH' })
  })

  it('refuses to spend on a nameless address lookup', async () => {
    // find_owner:false with no name cannot match; find_owner:true is the form
    // that missed. Either way, posting it can only waste a call.
    const res = await lookupPersonTrace({ ...PERSON, first_name: '', last_name: '' })
    expect(res.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a transport error is a FAILURE, never a miss', async () => {
    fetchMock.mockResolvedValue(errorResponse(429))
    const res = await lookupPersonTrace(PERSON)
    expect(res.success).toBe(false)
    expect(res.hit).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to spend without an API key', async () => {
    delete process.env.TRACERFY_API_KEY
    expect((await lookupPersonTrace(PERSON)).success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the parcel lookup, trace/parcel/lookup/ (spec 4.2)', () => {
  const APN_PERSON = {
    first_name: 'Testowner', last_name: 'Placeholder',
    parcel_id: '000-000-0000', county: 'Placeholder', state: 'ZZ',
  }

  it('sends Tracerfy only parcel_id, county and state, whatever names ride on the step (L-020)', async () => {
    // A malformed parcel key is a FREE, SILENT miss, so the request shape is pinned.
    // MUTATION: add first_name and last_name to the parcel payload and this goes red.
    fetchMock.mockResolvedValue(okResponse(apnHit.response))
    await lookupPersonTrace(APN_PERSON)
    expect(fetchMock.mock.calls[0][0]).toBe(TRACERFY_PARCEL_URL)
    expect(sentBody()).toEqual({ parcel_id: '000-000-0000', county: 'Placeholder', state: 'ZZ' })
  })

  it('matches the owner by name among the people a parcel returns', async () => {
    fetchMock.mockResolvedValue(okResponse(apnHit.response))
    const res = await lookupPersonTrace(APN_PERSON)
    expect(res.contacts?.ownerName).toBe('Testowner Placeholder')
    expect(res.contacts?.emails).toEqual(['apnowner@example.invalid'])
    expect(res.creditsDeducted).toBe(5)
  })

  it('an unknown parcel id is an ordinary free miss, so the next step runs', async () => {
    fetchMock.mockResolvedValue(okResponse(apnMiss.response))
    expect(await lookupPersonTrace(APN_PERSON)).toEqual({ success: true, hit: false, contacts: null, creditsDeducted: 0 })
  })
})

describe('our own input problems are refusals, never vendor failures (spec 5.1)', () => {
  it.each([
    ['a nameless address lookup', { ...PERSON, first_name: '', last_name: '' }],
    ['an address lookup with no city', { ...PERSON, city: '' }],
    ['a parcel lookup with no state', { first_name: 'Testowner', last_name: 'Placeholder', parcel_id: '1', county: 'X', state: '' }],
  ])('%s is refused before spending and marked inputError', async (_why, req) => {
    // MUTATION: return contactFailure instead of inputRefused at that refusal and this goes red.
    const res = await lookupPersonTrace(req)
    expect(res).toMatchObject({ success: false, inputError: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a business trace with no state is refused the same way', async () => {
    const res = await lookupBusinessTrace({ company_name: 'X Llc', state: ' ' })
    expect(res).toMatchObject({ success: false, inputError: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a missing API key is NOT an input error: the customer did nothing wrong', async () => {
    delete process.env.TRACERFY_API_KEY
    expect((await lookupPersonTrace(PERSON)).inputError).toBeUndefined()
  })

  it('a missing FastAppend API key is NOT an input error either (mutation 7d, L-018 every site)', async () => {
    // MUTATION 7d: switch this refusal to inputRefused and this goes red -- a missing key is our
    // own configuration problem, never something the customer's input caused.
    delete process.env.FASTAPPEND_API_KEY
    expect((await lookupBusinessTrace(ENTITY)).inputError).toBeUndefined()
  })
})
