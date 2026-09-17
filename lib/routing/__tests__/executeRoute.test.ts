import { describe, it, expect, vi } from 'vitest'
import { executeRoute, situsZipFrom, type RouteDeps, type ContactResult } from '../executeRoute'
import { planRoute, VENDOR_COST, type ParcelInput } from '../ownerRoute'
import { parseDossierResponse, type DossierResult } from '@/lib/tracerfy/dossier'

import entityApn from '@/lib/tracerfy/__tests__/fixtures/entity-hit-apn.json'
import entityAddress from '@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json'
import individualHit from '@/lib/tracerfy/__tests__/fixtures/individual-hit.json'
import twoOwnerHit from '@/lib/tracerfy/__tests__/fixtures/two-owner-hit.json'
import missApn from '@/lib/tracerfy/__tests__/fixtures/miss-apn.json'

/**
 * The dossier doubles are REAL sanitized vendor payloads run through the REAL parser, so a
 * change to either parser or fixture surfaces here rather than being papered over by an
 * invented object. See lib/tracerfy/__tests__/fixtures/README.md.
 *
 * The contact doubles are hand-built because the contact vendors are injected interfaces,
 * not a parsed payload. Their values are obvious placeholders, never plausible-looking PII.
 */
const HIT_ENTITY_APN = parseDossierResponse(entityApn.response)
const HIT_ENTITY_ADDRESS = parseDossierResponse(entityAddress.response)
const HIT_INDIVIDUAL = parseDossierResponse(individualHit.response)
const HIT_TWO_OWNER = parseDossierResponse(twoOwnerHit.response)
const DOSSIER_MISS = parseDossierResponse(missApn.response)

/** A vendor OUTAGE. success:false, and never to be read as "the county has no record". */
const DOSSIER_FAILURE: DossierResult = {
  success: false, hit: false, owners: [], property: null, mailingAddress: null,
  creditsDeducted: 0, error: 'Tracerfy service unavailable',
}

/** Trust-only ownership: the real two-owner payload with the natural person removed. */
const HIT_TRUST_ONLY: DossierResult = {
  ...HIT_TWO_OWNER,
  owners: HIT_TWO_OWNER.owners.filter(o => !o.first_name),
}

/**
 * A Delaware LP whose own corporate_owned flag says FALSE. Measured in the handoff. The
 * name string is the only trustworthy signal, and this record proves it.
 */
const HIT_LYING_FLAG: DossierResult = {
  ...HIT_ENTITY_APN,
  owners: [{ first_name: '', last_name: 'Storage Trust Properties, L.P.', age: '' }],
  property: { ...(HIT_ENTITY_APN.property as Record<string, unknown>), corporate_owned: false },
}

const CONTACT_HIT: ContactResult = {
  success: true,
  hit: true,
  contacts: {
    ownerName: 'Testowner Placeholder',
    phones: [{ number: '5555550100', type: 'mobile' }],
    emails: ['redacted@example.invalid'],
    mailingAddress: '100 Placeholder Way, Redacted, ZZ',
  },
}

const CONTACT_MISS: ContactResult = { success: true, hit: false, contacts: null }

const CONTACT_FAILURE: ContactResult = {
  success: false, hit: false, contacts: null, error: 'FastAppend service unavailable',
}

const deps = (over: Partial<RouteDeps> = {}): RouteDeps => ({
  lookupDossier: vi.fn(async () => DOSSIER_MISS),
  traceEntity: vi.fn(async () => CONTACT_MISS),
  tracePerson: vi.fn(async () => CONTACT_MISS),
  ...over,
})

const parcel = (over: Partial<ParcelInput> = {}): ParcelInput => ({
  parcelIdLocal: '16183060290000', county: 'Salt Lake', state: 'UT',
  situsAddress: '1815 S State St', situsCity: 'Salt Lake City', situsState: 'UT', situsZip: null,
  ownerName: null, ...over,
})

const tier2Plan = (over: Partial<ParcelInput> = {}) => planRoute(parcel(over), 'wallet')

/** Resolve the nth call's result, so a two-key run can hit on the second. */
const dossierSequence = (...results: DossierResult[]) => {
  const fn = vi.fn()
  for (const r of results) fn.mockResolvedValueOnce(r)
  fn.mockResolvedValue(DOSSIER_MISS)
  return fn as unknown as RouteDeps['lookupDossier']
}

describe('executeRoute — stop at the first hit', () => {
  it('never runs the address key after the APN key hits', async () => {
    // Both keys are planned because they fail independently. Running the second after
    // the first hits is a wasted $0.20 on every record.
    const plan = tier2Plan()
    expect(plan.steps.map(s => s.kind)).toEqual(['DOSSIER_APN', 'DOSSIER_ADDRESS'])

    const d = deps({ lookupDossier: dossierSequence(HIT_ENTITY_APN, HIT_ENTITY_ADDRESS) })
    const r = await executeRoute(plan, d)

    expect(d.lookupDossier).toHaveBeenCalledTimes(1)
    expect(r.steps.map(s => [s.kind, s.outcome])).toEqual([
      ['DOSSIER_APN', 'hit'],
      ['DOSSIER_ADDRESS', 'skipped'],
      // ...and the second pass ran, on the owner the first key discovered.
      ['FASTAPPEND_ENTITY', 'miss'],
    ])
    expect(r.steps[1].note).toMatch(/wasted charge/)
    expect(r.vendorSpend).toBe(VENDOR_COST.DOSSIER)
  })

  it('pays for one dossier, not two, when both keys would have hit', async () => {
    // The money statement of the rule above: a second key run after a hit is $0.20 wasted
    // on every record where the first key works, which was 23 of 24 in the sample.
    const d = deps({ lookupDossier: dossierSequence(HIT_ENTITY_APN, HIT_ENTITY_ADDRESS) })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.vendorSpend).toBe(VENDOR_COST.DOSSIER)
    expect(r.steps.filter(s => s.outcome === 'hit')).toHaveLength(1)
    expect(r.steps.filter(s => s.kind.startsWith('DOSSIER') && s.cost > 0)).toHaveLength(1)
    expect(r.steps.reduce((a, s) => a + (s.creditsDeducted ?? 0), 0)).toBe(10)
  })

  it('falls through to the address key when the APN key misses, and hits', async () => {
    // Salt Lake 16183060290000 missed on APN and hit on address, returning the owner
    // the county recorder confirms.
    const d = deps({ lookupDossier: dossierSequence(DOSSIER_MISS, HIT_ENTITY_ADDRESS) })
    const r = await executeRoute(tier2Plan(), d)

    expect(d.lookupDossier).toHaveBeenCalledTimes(2)
    expect(r.steps.map(s => [s.kind, s.outcome])).toEqual([
      ['DOSSIER_APN', 'miss'],
      ['DOSSIER_ADDRESS', 'hit'],
      ['FASTAPPEND_ENTITY', 'miss'],
    ])
    expect(r.ownerFound).toBe(true)
    expect(r.ownerName).toBe('Colmaven, Llc')
    // The miss was free, so the record cost one dossier, not two.
    expect(r.vendorSpend).toBe(VENDOR_COST.DOSSIER)
  })

  it('keys each dossier call by the mode its step declares', async () => {
    const d = deps({ lookupDossier: dossierSequence(DOSSIER_MISS, HIT_ENTITY_ADDRESS) })
    await executeRoute(tier2Plan({ situsZip: '84115' }), d)

    expect(d.lookupDossier).toHaveBeenNthCalledWith(1, {
      mode: 'apn', apn: '16183060290000', county: 'Salt Lake', state: 'UT',
    })
    expect(d.lookupDossier).toHaveBeenNthCalledWith(2, {
      mode: 'address', address: '1815 S State St', city: 'Salt Lake City', state: 'UT', zip_code: '84115',
    })
  })

  it('reports both keys missing as a free, finished, ownerless run', async () => {
    const d = deps()
    const r = await executeRoute(tier2Plan(), d)

    expect(d.lookupDossier).toHaveBeenCalledTimes(2)
    expect(r.success).toBe(true)
    expect(r.ownerFound).toBe(false)
    expect(r.property).toBeNull()
    expect(r.vendorSpend).toBe(0)
    expect(r.steps.every(s => s.outcome === 'miss')).toBe(true)
    // Nothing to route to, so no contact vendor was asked.
    expect(d.traceEntity).not.toHaveBeenCalled()
    expect(d.tracePerson).not.toHaveBeenCalled()
  })

  it('runs the single planned step for an address-only parcel', async () => {
    const plan = planRoute(
      { state: 'UT', situsAddress: '1815 S State St', situsCity: 'Salt Lake City', situsState: 'UT' },
      'wallet',
    )
    const d = deps({ lookupDossier: dossierSequence(HIT_ENTITY_ADDRESS) })
    const r = await executeRoute(plan, d)

    expect(d.lookupDossier).toHaveBeenCalledTimes(1)
    expect(r.steps.map(s => s.kind)).toEqual(['DOSSIER_ADDRESS', 'FASTAPPEND_ENTITY'])
    expect(r.ownerFound).toBe(true)
  })
})

describe('executeRoute — the two-pass', () => {
  it('routes a discovered entity to FastAppend', async () => {
    const d = deps({
      lookupDossier: dossierSequence(HIT_ENTITY_APN),
      traceEntity: vi.fn(async () => CONTACT_HIT),
    })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.ownerType).toBe('entity')
    expect(d.traceEntity).toHaveBeenCalledTimes(1)
    expect(d.tracePerson).not.toHaveBeenCalled()
    expect(d.traceEntity).toHaveBeenCalledWith({
      company_name: 'Cutting Edge Hodings Llc', state: 'UT',
    })
    expect(r.contactsFound).toBe(true)
    expect(r.contacts?.phones).toHaveLength(1)
    // Money is totalled to the cent: 0.20 + 0.10 is 0.30000000000000004 in binary floats.
    expect(r.vendorSpend).toBeCloseTo(VENDOR_COST.DOSSIER + VENDOR_COST.FASTAPPEND_ENTITY, 2)
    expect(r.vendorSpend).toBe(0.30)
  })

  it('routes a discovered individual to Tracerfy, named, never find_owner', async () => {
    const d = deps({
      lookupDossier: dossierSequence(HIT_INDIVIDUAL),
      tracePerson: vi.fn(async () => CONTACT_HIT),
    })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.ownerType).toBe('individual')
    expect(d.tracePerson).toHaveBeenCalledTimes(1)
    expect(d.traceEntity).not.toHaveBeenCalled()
    expect(d.tracePerson).toHaveBeenCalledWith(expect.objectContaining({
      first_name: 'Testowner', last_name: 'Placeholder', find_owner: false,
      address: '1815 S State St', city: 'Salt Lake City', state: 'UT',
    }))
    expect(r.vendorSpend).toBeCloseTo(VENDOR_COST.DOSSIER + VENDOR_COST.TRACERFY_INSTANT, 2)
  })

  it('classifies from the NAME, never the vendors corporate_owned flag', async () => {
    // corporate_owned is FALSE on this record and the owner is a Delaware LP.
    expect((HIT_LYING_FLAG.property as Record<string, unknown>).corporate_owned).toBe(false)
    const d = deps({
      lookupDossier: dossierSequence(HIT_LYING_FLAG),
      traceEntity: vi.fn(async () => CONTACT_HIT),
    })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.ownerType).toBe('entity')
    expect(d.traceEntity).toHaveBeenCalledTimes(1)
    expect(d.tracePerson).not.toHaveBeenCalled()
  })

  it('treats a person named alongside their trust as a routable individual', async () => {
    const d = deps({
      lookupDossier: dossierSequence(HIT_TWO_OWNER),
      tracePerson: vi.fn(async () => CONTACT_HIT),
    })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.ownerName).toBe('Testowner Placeholder | Placeholder Family Living Trust')
    expect(r.ownerType).toBe('individual')
    expect(d.tracePerson).toHaveBeenCalledWith(expect.objectContaining({
      first_name: 'Testowner', last_name: 'Placeholder',
    }))
  })

  it('sends a trust-only owner to manual review and asks no contact vendor', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_TRUST_ONLY) })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.ownerFound).toBe(true)
    expect(r.ownerName).toBe('Placeholder Family Living Trust')
    expect(r.ownerType).toBe('trust')
    expect(r.needsManualReview).toBe(true)
    expect(d.traceEntity).not.toHaveBeenCalled()
    expect(d.tracePerson).not.toHaveBeenCalled()
    // The $0.20 is still sunk: the property record was bought and delivered.
    expect(r.vendorSpend).toBe(VENDOR_COST.DOSSIER)
    expect(r.property).not.toBeNull()
    expect(r.warnings.join(' ')).toMatch(/manual review/)
  })

  it('flags a hit that carries no owner at all for manual review', async () => {
    const d = deps({ lookupDossier: dossierSequence({ ...HIT_ENTITY_APN, owners: [] }) })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.ownerFound).toBe(false)
    expect(r.ownerType).toBe('unknown')
    expect(r.needsManualReview).toBe(true)
    expect(r.property).not.toBeNull()
    expect(r.vendorSpend).toBe(VENDOR_COST.DOSSIER)
  })

  it('carries the second passs vendor warnings out to the caller', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_ENTITY_APN) })
    const r = await executeRoute(tier2Plan(), d)
    expect(r.warnings.join(' ')).toMatch(/is_registered_agent/)
  })

  it('does not re-run discovery for a tier 1 plan whose owner is already known', async () => {
    const d = deps({ traceEntity: vi.fn(async () => CONTACT_HIT) })
    const r = await executeRoute(planRoute(parcel({ ownerName: 'Abc Rentals Llc' }), 'wallet'), d)

    expect(d.lookupDossier).not.toHaveBeenCalled()
    expect(r.tier).toBe(1)
    expect(r.ownerName).toBe('Abc Rentals Llc')
    expect(r.contactsFound).toBe(true)
    expect(r.vendorSpend).toBe(VENDOR_COST.FASTAPPEND_ENTITY)
  })
})

describe('executeRoute — a failure is not a miss', () => {
  it('surfaces a dossier outage as an error, not as "no record"', async () => {
    const d = deps({ lookupDossier: dossierSequence(DOSSIER_FAILURE) })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.success).toBe(false)
    expect(r.error).toMatch(/unavailable/)
    expect(r.steps[0].outcome).toBe('failed')
    // A miss is free and FINAL. A failure is free and NOT final: nothing may be billed.
    expect(r.vendorSpend).toBe(0)
    expect(r.ownerFound).toBe(false)
    expect(r.needsManualReview).toBe(false)
  })

  it('stops the remaining steps after a failure rather than compounding an outage', async () => {
    const d = deps({ lookupDossier: dossierSequence(DOSSIER_FAILURE, HIT_ENTITY_ADDRESS) })
    const r = await executeRoute(tier2Plan(), d)

    expect(d.lookupDossier).toHaveBeenCalledTimes(1)
    expect(r.steps.map(s => s.outcome)).toEqual(['failed', 'skipped'])
    expect(d.traceEntity).not.toHaveBeenCalled()
  })

  it('never reports a failed step as a miss anywhere in the result', async () => {
    const d = deps({ lookupDossier: dossierSequence(DOSSIER_FAILURE) })
    const r = await executeRoute(tier2Plan(), d)
    expect(r.steps.some(s => s.outcome === 'miss')).toBe(false)
  })

  it('keeps the paid property record when the CONTACT vendor fails', async () => {
    // $0.20 was genuinely spent and the record is genuinely good. The contact outage
    // must not discard it, and must not be billed as a completed contact trace.
    const d = deps({
      lookupDossier: dossierSequence(HIT_ENTITY_APN),
      traceEntity: vi.fn(async () => CONTACT_FAILURE),
    })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.success).toBe(false)
    expect(r.error).toMatch(/FastAppend service unavailable/)
    expect(r.ownerFound).toBe(true)
    expect(r.property).not.toBeNull()
    expect(r.contactsFound).toBe(false)
    expect(r.vendorSpend).toBe(VENDOR_COST.DOSSIER)
  })

  it('reports a genuine contact MISS as a completed, cheaper run', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_ENTITY_APN) })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.contactsFound).toBe(false)
    expect(r.steps.map(s => s.outcome)).toEqual(['hit', 'skipped', 'miss'])
    expect(r.vendorSpend).toBe(VENDOR_COST.DOSSIER)
  })

  it('treats a vendor that THROWS as a failure, and never throws itself', async () => {
    const d = deps({
      lookupDossier: vi.fn(async () => {
        throw new Error('socket hang up')
      }) as unknown as RouteDeps['lookupDossier'],
    })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.success).toBe(false)
    expect(r.error).toMatch(/socket hang up/)
    expect(r.steps[0].outcome).toBe('failed')
    expect(r.vendorSpend).toBe(0)
  })

  it('returns a result rather than throwing on a plan with no steps at all', async () => {
    const plan = planRoute({ state: 'UT' }, 'wallet')
    expect(plan.steps).toHaveLength(0)
    const r = await executeRoute(plan, deps())

    expect(r.success).toBe(true)
    expect(r.vendorSpend).toBe(0)
    expect(r.needsManualReview).toBe(true)
    expect(r.steps).toEqual([])
  })
})

describe('executeRoute — spend', () => {
  it('reads what the dossier says it deducted rather than assuming the rate', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_ENTITY_APN) })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.steps[0].creditsDeducted).toBe(10)
    expect(r.steps[0].cost).toBe(VENDOR_COST.DOSSIER)
  })

  it('bills nothing for a hit the vendor says it did not charge for', async () => {
    // Dossier reporting hit:true with credits_deducted 0 (a cached or comped record)
    // must not be invoiced at $0.20 on our assumption.
    const d = deps({ lookupDossier: dossierSequence({ ...HIT_ENTITY_APN, creditsDeducted: 0 }) })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.steps[0].outcome).toBe('hit')
    expect(r.steps[0].cost).toBe(0)
    expect(r.vendorSpend).toBe(0)
  })

  it('never exceeds the plans own ceiling', async () => {
    const plan = tier2Plan()
    const d = deps({
      lookupDossier: dossierSequence(HIT_ENTITY_APN),
      traceEntity: vi.fn(async () => CONTACT_HIT),
    })
    const r = await executeRoute(plan, d)
    expect(r.vendorSpend).toBeLessThanOrEqual(plan.maxVendorCost)
  })

  it('totals exactly the sum of the steps that were charged', async () => {
    const d = deps({
      lookupDossier: dossierSequence(DOSSIER_MISS, HIT_ENTITY_ADDRESS),
      traceEntity: vi.fn(async () => CONTACT_HIT),
    })
    const r = await executeRoute(tier2Plan(), d)
    expect(r.vendorSpend).toBeCloseTo(r.steps.reduce((a, s) => a + s.cost, 0), 2)
    expect(r.vendorSpend).toBe(0.30)
  })
})

describe('executeRoute — the fidelity fence', () => {
  it('hands the raw 86-key property record through untouched', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_ENTITY_APN) })
    const r = await executeRoute(tier2Plan(), d)

    expect(Object.keys(r.property!)).toHaveLength(86)
    expect(r.property).toEqual(entityApn.response.property)
    expect(Object.keys(r.property!)).toEqual(Object.keys(entityApn.response.property))
    // Same object, not a copy: no subsetting, renaming or normalising happened on the way.
    expect(r.property).toBe(HIT_ENTITY_APN.property)
  })

  it('keeps the blocked-from-display fields, which are not blocked from storage', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_ENTITY_APN) })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.property).toHaveProperty('sell_propensity_score')
    expect(r.property).toHaveProperty('estimated_value')
    expect(r.property).toHaveProperty('corporate_owned')
  })

  it('carries the mailing address the dossier returned', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_INDIVIDUAL) })
    const r = await executeRoute(tier2Plan(), d)
    expect(r.mailingAddress).toEqual(HIT_INDIVIDUAL.mailingAddress)
  })
})

/* ==================================================================== *
 * ZIP BACKFILL — the dossier teaches the contact step the situs zip
 *
 * The $0.20 dossier returns the property's own zip. The contact step is the
 * one that decides whether the customer gets a phone number at all, and
 * Tracerfy calls the zip strongly recommended for the named lookup. Feeding
 * it back is free.
 * ==================================================================== */

describe('executeRoute — zip backfill', () => {
  /** The zip the contact vendor was actually sent. */
  const sentZip = (fn: unknown): unknown =>
    (fn as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0][0].zip

  it('feeds the SITUS zip from the dossier into the contact lookup', async () => {
    // The caller had none: nothing in PTP requires a zip and no Utah county in
    // the study publishes one.
    const tracePerson = vi.fn(async () => CONTACT_HIT)
    const d = deps({ lookupDossier: dossierSequence(HIT_INDIVIDUAL), tracePerson })

    const res = await executeRoute(tier2Plan({ situsZip: null }), d)

    const situsZip = String(
      (individualHit.response.property as Record<string, unknown>).zip_code
    )
    expect(situsZip).toMatch(/^\d{5}$/)
    expect(sentZip(tracePerson)).toBe(situsZip)
    expect(res.learnedZip).toBe(situsZip)
  })

  it('NEVER uses the owner mailing zip', async () => {
    // property.zip_code is the PROPERTY's. mailing_address.zip is the OWNER'S,
    // and 21 of the 24 parcels studied are absentee-owned -- routinely a
    // different city, often a different state. Sending it would contradict the
    // street and city it travels with and quietly lower the match rate.
    // MUTATION: read mailingAddress.zip instead and this goes red.
    const tracePerson = vi.fn(async () => CONTACT_HIT)
    const mailingZip = individualHit.response.mailing_address.zip
    const situsZip = String(
      (individualHit.response.property as Record<string, unknown>).zip_code
    )
    expect(mailingZip).not.toBe(situsZip)

    await executeRoute(
      tier2Plan({ situsZip: null }),
      deps({ lookupDossier: dossierSequence(HIT_INDIVIDUAL), tracePerson })
    )

    expect(sentZip(tracePerson)).not.toBe(mailingZip)
    expect(sentZip(tracePerson)).toBe(situsZip)
  })

  it("does not overwrite the CALLER'S zip", async () => {
    // They may know something the county file does not, and silently replacing
    // submitted data with vendor data is unreproducible from a bug report.
    // MUTATION: always prefer the dossier zip and this goes red.
    const tracePerson = vi.fn(async () => CONTACT_HIT)

    const res = await executeRoute(
      tier2Plan({ situsZip: '99999' }),
      deps({ lookupDossier: dossierSequence(HIT_INDIVIDUAL), tracePerson })
    )

    expect(sentZip(tracePerson)).toBe('99999')
    // Nothing was learned, so the caller has nothing to persist.
    expect(res.learnedZip).toBeNull()
  })

  it('learns nothing from a dossier miss', async () => {
    const res = await executeRoute(tier2Plan({ situsZip: null }), deps())
    expect(res.learnedZip).toBeNull()
  })

  it('leaves the entity path alone: FastAppend is keyed on name and state', async () => {
    const traceEntity = vi.fn(async () => CONTACT_HIT)

    await executeRoute(
      tier2Plan({ situsZip: null }),
      deps({ lookupDossier: dossierSequence(HIT_ENTITY_ADDRESS), traceEntity })
    )

    expect(traceEntity).toHaveBeenCalledWith({
      company_name: 'Colmaven, Llc',
      state: 'UT',
    })
  })
})

describe('situsZipFrom', () => {
  it('reads zip_code off the property record', () => {
    expect(situsZipFrom({ zip_code: '84115' })).toBe('84115')
  })

  it('trims ZIP+4 to the 5 the vendor examples use', () => {
    expect(situsZipFrom({ zip_code: '84115-1234' })).toBe('84115')
  })

  it('accepts a numeric zip without losing a leading zero', () => {
    expect(situsZipFrom({ zip_code: 84115 })).toBe('84115')
  })

  it('returns null rather than a partial or absent zip', () => {
    expect(situsZipFrom({ zip_code: '' })).toBeNull()
    expect(situsZipFrom({ zip_code: 'N/A' })).toBeNull()
    expect(situsZipFrom({})).toBeNull()
    expect(situsZipFrom(null)).toBeNull()
    expect(situsZipFrom(undefined)).toBeNull()
  })
})
