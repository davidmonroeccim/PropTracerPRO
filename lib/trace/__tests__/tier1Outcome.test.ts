import { describe, expect, it } from 'vitest'
import type { ExecutionResult, StepReport } from '@/lib/routing/executeRoute'
import {
  BUSY_TRY_AGAIN_REASON,
  missingLookupKey,
  noLookupKeyReason,
  noMatchReason,
  OWNER_NAME_NOT_MATCHED_REASON,
  outcomeSentence,
  tier1OutcomeFor,
  tier1OutcomeReason,
} from '@/lib/trace/tier1Outcome'

const step = (kind: StepReport['kind'], outcome: StepReport['outcome'], extra: Partial<StepReport> = {}): StepReport =>
  ({ kind, outcome, cost: 0, ...extra })

const exec = (steps: StepReport[], contactsFound = false): ExecutionResult => ({
  success: !steps.some(s => s.outcome === 'failed'),
  ownerFound: true, learnedZip: null, ownerName: 'Marcus Halloway', ownerType: 'individual',
  property: null, mailingAddress: null, contactsFound,
  contacts: contactsFound
    ? { ownerName: 'Marcus Halloway', phones: [{ number: '5550000101', type: 'mobile' }], emails: [], mailingAddress: null }
    : null,
  tier: 1, vendorSpend: 0, steps, needsManualReview: false, warnings: [],
})

describe('tier1OutcomeFor (spec 7.1)', () => {
  it.each([
    ['TRACERFY_INSTANT_NAMED', 'found_by_address', 'address'],
    ['TRACERFY_PARCEL_APN', 'found_by_parcel_id', 'parcel_id'],
    ['FASTAPPEND_ENTITY', 'found_by_company_name', 'company_name'],
  ] as const)('a %s hit with contacts is %s', (kind, outcome, foundBy) => {
    expect(tier1OutcomeFor(exec([step(kind, 'hit')], true))).toEqual({ outcome, foundBy })
  })

  it('names the key that FOUND the owner, not a step before it', () => {
    expect(tier1OutcomeFor(exec([step('TRACERFY_INSTANT_NAMED', 'miss'), step('TRACERFY_PARCEL_APN', 'hit')], true)).foundBy)
      .toBe('parcel_id')
  })

  it('a contactless hit does not count as delivering: the next hit does (D27)', () => {
    // The ladder produces exactly this shape when the address lookup matched the owner but
    // carried no phone or email, and the parcel lookup then delivered.
    // MUTATION: drop `&& !s.noContacts` from the delivering-step search and this reads found_by_address.
    expect(tier1OutcomeFor(exec([
      step('TRACERFY_INSTANT_NAMED', 'hit', { noContacts: true }),
      step('TRACERFY_PARCEL_APN', 'hit'),
    ], true))).toEqual({ outcome: 'found_by_parcel_id', foundBy: 'parcel_id' })
  })

  it('any failed step is busy_try_again, whatever answered before it', () => {
    // MUTATION: delete the failed-step test and this reads no_match.
    expect(tier1OutcomeFor(exec([step('TRACERFY_INSTANT_NAMED', 'miss'), step('FASTAPPEND_ENTITY', 'failed')])).outcome)
      .toBe('busy_try_again')
  })

  it('a billed non-match with nothing delivered is owner_name_not_matched', () => {
    expect(tier1OutcomeFor(exec([step('TRACERFY_INSTANT_NAMED', 'name_not_matched'), step('FASTAPPEND_ENTITY', 'miss')])).outcome)
      .toBe('owner_name_not_matched')
  })

  it('a matched owner with no contacts beside a non-match is no_match, never "none matched" (D27, D31)', () => {
    // MUTATION: delete the matched-contactless line and this reads owner_name_not_matched.
    expect(tier1OutcomeFor(exec([
      step('TRACERFY_INSTANT_NAMED', 'name_not_matched'),
      step('TRACERFY_PARCEL_APN', 'hit', { noContacts: true }),
    ])).outcome).toBe('no_match')
  })

  it('answered misses, and a contactless hit (Q1 a), are no_match', () => {
    expect(tier1OutcomeFor(exec([step('FASTAPPEND_ENTITY', 'miss')])).outcome).toBe('no_match')
    expect(tier1OutcomeFor(exec([step('TRACERFY_INSTANT_NAMED', 'hit', { noContacts: true })])).outcome).toBe('no_match')
  })

  it('nothing asked, or only our own refused input, is no_lookup_key', () => {
    expect(tier1OutcomeFor(exec([])).outcome).toBe('no_lookup_key')
    expect(tier1OutcomeFor(exec([step('TRACERFY_INSTANT_NAMED', 'skipped', { note: 'not sent: x' })])).outcome).toBe('no_lookup_key')
  })
})

describe('the sentences (spec 7.1)', () => {
  it('no_match names only the keys that answered, in order', () => {
    expect(noMatchReason([step('TRACERFY_INSTANT_NAMED', 'miss')]))
      .toBe('We looked this owner up by address and found no match. You were not charged.')
    expect(noMatchReason([step('TRACERFY_INSTANT_NAMED', 'miss'), step('TRACERFY_PARCEL_APN', 'miss')]))
      .toBe('We looked this owner up by address and parcel ID and found no match. You were not charged.')
    expect(noMatchReason([step('FASTAPPEND_ENTITY', 'miss')]))
      .toBe('We looked this owner up by company name and found no match. You were not charged.')
    expect(noMatchReason([
      step('TRACERFY_INSTANT_NAMED', 'miss'), step('TRACERFY_PARCEL_APN', 'name_not_matched'), step('FASTAPPEND_ENTITY', 'miss'),
    ])).toBe('We looked this owner up by address, parcel ID and company name and found no match. You were not charged.')
    // A skipped or failed step was never an answer.
    expect(noMatchReason([step('TRACERFY_INSTANT_NAMED', 'miss'), step('FASTAPPEND_ENTITY', 'skipped')]))
      .toBe('We looked this owner up by address and found no match. You were not charged.')
    expect(noMatchReason([])).toBeNull()
  })

  it('no_lookup_key names what is missing and what to send', () => {
    expect(noLookupKeyReason('city_and_parcel')).toBe(
      'This record is missing the city and the parcel ID, so it could not be looked up. You were not charged. Send it again with the city or the parcel ID.'
    )
    expect(noLookupKeyReason('state')).toBe(
      'This record is missing a valid state, so it could not be looked up. You were not charged. Send it again with a valid two-letter state.'
    )
    expect(noLookupKeyReason('street_and_parcel')).toBe(
      'This record is missing a street address and the parcel ID, so it could not be looked up. You were not charged. Send it again with the street address or the parcel ID.'
    )
    // D41: the fourth pair. A caller who DID send a parcel id must not be told it is missing.
    // MUTATION: delete the county_for_parcel entry from MISSING_WORDS and this goes red.
    expect(noLookupKeyReason('county_for_parcel')).toBe(
      'This record is missing the county for that parcel ID, so it could not be looked up. You were not charged. Send it again with the county.'
    )
  })

  it('missingLookupKey reads the record, state first', () => {
    expect(missingLookupKey({ state: 'Texas', city: 'Austin', address: '1 A St' })).toBe('state')
    expect(missingLookupKey({ state: 'TX' })).toBe('city_and_parcel')
    expect(missingLookupKey({ state: 'TX', city: 'Austin' })).toBe('street_and_parcel')
    expect(missingLookupKey({ state: 'TX', apn: '12-3', county: 'Travis' })).toBeNull()
    // D41: a parcel id with no county and no city is missing the COUNTY, not the parcel ID.
    // MUTATION: delete the county_for_parcel arm and this goes red with 'city_and_parcel'.
    expect(missingLookupKey({ state: 'TX', apn: '12-3' })).toBe('county_for_parcel')
    // A city still present is judged as before: the address key is what is short.
    expect(missingLookupKey({ state: 'TX', apn: '12-3', city: 'Austin' })).toBe('street_and_parcel')
    // No parcel id at all keeps the original sentence.
    expect(missingLookupKey({ state: 'TX', county: 'Travis' })).toBe('city_and_parcel')
    expect(missingLookupKey({ state: 'TX', city: 'Austin', address: '1 A St' })).toBeNull()
  })

  it('found_by outcomes carry no sentence: the contacts are shown', () => {
    expect(outcomeSentence('found_by_address', [], null)).toBeNull()
  })

  it('never says a parcel ID was "not recognized": Tracerfy never tells us so', () => {
    for (const s of [BUSY_TRY_AGAIN_REASON, OWNER_NAME_NOT_MATCHED_REASON, noMatchReason([step('TRACERFY_PARCEL_APN', 'miss')])!]) {
      expect(s).not.toMatch(/recogni/i)
    }
  })
})

describe('copy rules (spec 7.3) on every new sentence', () => {
  const ALL = [
    BUSY_TRY_AGAIN_REASON,
    OWNER_NAME_NOT_MATCHED_REASON,
    noMatchReason([step('TRACERFY_INSTANT_NAMED', 'miss'), step('TRACERFY_PARCEL_APN', 'miss'), step('FASTAPPEND_ENTITY', 'miss')])!,
    noLookupKeyReason('city_and_parcel'),
    noLookupKeyReason('state'),
    noLookupKeyReason('street_and_parcel'),
    noLookupKeyReason('county_for_parcel'),
  ]

  it('every one states the charge', () => {
    for (const s of ALL) expect(s, s).toMatch(/charged/)
  })

  it('none quotes a price, claims anyone was notified, or asks for funds', () => {
    for (const s of ALL) {
      expect(s, s).not.toMatch(/\$|\d+\s*cent/)
      expect(s, s).not.toMatch(/notified|alerted|our team|looking into/i)
      expect(s, s).not.toMatch(/add funds|top up|insufficient/i)
    }
  })

  it('none carries an em dash, en dash, asterisk or emoji', () => {
    for (const s of ALL) {
      expect(s, s).not.toMatch(/[—–*]/)
      expect(s, s).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    }
  })

  it('resend advice appears on exactly busy_try_again and no_lookup_key', () => {
    // MUTATION: append " Try again later." to OWNER_NAME_NOT_MATCHED_REASON and this goes red.
    expect(BUSY_TRY_AGAIN_REASON).toMatch(/try again/i)
    for (const m of ['city_and_parcel', 'state', 'street_and_parcel'] as const) {
      expect(noLookupKeyReason(m)).toMatch(/send it again/i)
    }
    for (const s of [OWNER_NAME_NOT_MATCHED_REASON, noMatchReason([step('TRACERFY_INSTANT_NAMED', 'miss')])!]) {
      expect(s, s).not.toMatch(/send it again|send them again|try again|upload it again/i)
    }
  })
})

describe('tier1OutcomeReason: the sentence read back off a stored row', () => {
  it('reads each outcome', () => {
    expect(tier1OutcomeReason({ outcome_code: 'no_match', trace_steps: [step('FASTAPPEND_ENTITY', 'miss')], is_successful: false }))
      .toBe('We looked this owner up by company name and found no match. You were not charged.')
    expect(tier1OutcomeReason({ outcome_code: 'busy_try_again', is_successful: false })).toBe(BUSY_TRY_AGAIN_REASON)
    expect(tier1OutcomeReason({ outcome_code: 'owner_name_not_matched', is_successful: false })).toBe(OWNER_NAME_NOT_MATCHED_REASON)
    expect(tier1OutcomeReason({ outcome_code: 'no_lookup_key', state: 'OH', city: null, parcel_id_local: null, is_successful: false }))
      .toBe(noLookupKeyReason('city_and_parcel'))
  })

  it('says nothing about a row that delivered contacts, or a row with no outcome', () => {
    // busy_try_again is sentence-producing unconditionally (it needs no trace_steps), so this
    // is_successful:true case is the one that actually exercises the guard: the old
    // `outcome_code: 'no_match', trace_steps: []` case stayed null even without the guard,
    // because noMatchReason([]) is null on its own.
    // MUTATION: delete the `row.is_successful === true` guard and this reads a sentence instead of null.
    expect(tier1OutcomeReason({ outcome_code: 'busy_try_again', is_successful: true })).toBeNull()
    expect(tier1OutcomeReason({ outcome_code: null })).toBeNull()
  })
})
