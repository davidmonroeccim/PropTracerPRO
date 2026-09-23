import { describe, it, expect, vi } from 'vitest'
import {
  executeRoute,
  situsZipFrom,
  contactVendorFrom,
  requestKeyFor,
  stepLogFrom,
  STEP_REUSE_WINDOW_MS,
  type RouteDeps,
  type ContactResult,
  type StepReport,
} from '../executeRoute'
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

/** Resolve the nth contact call's result, then miss. */
const contactSequence = (...results: ContactResult[]) => {
  const fn = vi.fn()
  for (const r of results) fn.mockResolvedValueOnce(r)
  fn.mockResolvedValue(CONTACT_MISS)
  return fn as unknown as RouteDeps['tracePerson']
}

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

  it('sends a trust-only owner to FastAppend on the full trust name (D16)', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_TRUST_ONLY) })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.ownerFound).toBe(true)
    expect(r.ownerType).toBe('trust')
    expect(d.tracePerson).not.toHaveBeenCalled()
    expect(d.traceEntity).toHaveBeenCalledWith({ company_name: 'Placeholder Family Living Trust', state: 'UT' })
    expect(r.needsManualReview).toBe(false)
    expect(r.property).not.toBeNull()
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

describe('contactVendorFrom — which contact lane was actually asked', () => {
  /**
   * WHY THIS EXISTS. Nothing durable records which vendor a row went through. The step
   * reports carry it, executeRoute builds them, and the cron then throws them away at the
   * database boundary. So the one decision David calls first and foremost, entity versus
   * individual, is unauditable after the fact: there is no vendor column, and both vendors
   * cost 0.10 so the cost column cannot tell them apart either.
   *
   * It is also why a tier 2 FastAppend hit is reported to customers as `person_trace`:
   * resolveOwnerContact has to guess from which storage envelope the data landed in, and on
   * tier 2 it guesses wrong every time.
   *
   * ASKED, NOT PRODUCED. A lane that ran and missed still answers the routing question, and
   * a miss leaves no contact name to mislabel anyway. 'skipped' does not count: that step was
   * never put to a vendor.
   */
  it('records fastappend when the entity lane was asked and hit', async () => {
    const d = deps({
      lookupDossier: dossierSequence(HIT_ENTITY_APN),
      traceEntity: vi.fn(async () => CONTACT_HIT),
    })
    const r = await executeRoute(tier2Plan(), d)

    // The positive control: prove the entity lane really ran before asserting on its label.
    expect(r.ownerType).toBe('entity')
    expect(d.traceEntity).toHaveBeenCalledTimes(1)
    expect(contactVendorFrom(r.steps)).toBe('fastappend')
  })

  it('records fastappend even when the entity lane MISSED', async () => {
    // The routing question is answered either way, and this is the case the cost column
    // cannot distinguish.
    const d = deps({ lookupDossier: dossierSequence(HIT_ENTITY_APN) })
    const r = await executeRoute(tier2Plan(), d)

    expect(d.traceEntity).toHaveBeenCalledTimes(1)
    expect(r.contactsFound).toBe(false)
    expect(contactVendorFrom(r.steps)).toBe('fastappend')
  })

  it('records tracerfy when the individual lane was asked', async () => {
    const d = deps({
      lookupDossier: dossierSequence(HIT_INDIVIDUAL),
      tracePerson: vi.fn(async () => CONTACT_HIT),
    })
    const r = await executeRoute(tier2Plan(), d)

    expect(r.ownerType).toBe('individual')
    expect(d.tracePerson).toHaveBeenCalledTimes(1)
    expect(contactVendorFrom(r.steps)).toBe('tracerfy')
  })

  it('records fastappend for a trust-only owner, which D16 sends to FastAppend', async () => {
    const d = deps({ lookupDossier: dossierSequence(HIT_TRUST_ONLY) })
    const r = await executeRoute(tier2Plan(), d)

    expect(d.traceEntity).toHaveBeenCalledTimes(1)
    expect(contactVendorFrom(r.steps)).toBe('fastappend')
  })

  it('records nothing when the dossier itself missed, so no lane was reached', async () => {
    const d = deps()
    const r = await executeRoute(tier2Plan(), d)

    expect(r.ownerFound).toBe(false)
    expect(contactVendorFrom(r.steps)).toBeNull()
  })

  it('ignores a skipped step, which was never put to a vendor', () => {
    expect(contactVendorFrom([
      { kind: 'DOSSIER_APN', outcome: 'hit', cost: 0.2 },
      { kind: 'FASTAPPEND_ENTITY', outcome: 'skipped', cost: 0 },
    ])).toBeNull()
  })

  it('records a lane that was asked and FAILED, because it still ran', () => {
    expect(contactVendorFrom([
      { kind: 'TRACERFY_INSTANT_NAMED', outcome: 'failed', cost: 0, error: 'boom' },
    ])).toBe('tracerfy')
  })
})

describe('executeRoute: the Tier 1 ladder and its step log (spec 4.3, 5.2)', () => {
  const NOW = Date.parse('2026-09-22T12:00:00.000Z')
  const clock = () => NOW
  /** parcel() carries a street, a city and a parcel id: Instant, then the parcel lookup. */
  const personPlan = () => planRoute(parcel({ ownerName: 'Marcus T Halloway' }), 'wallet')

  const NOT_MATCHED: ContactResult = {
    success: true, hit: true, contacts: null, nameNotMatched: true,
    peopleCount: 1, creditsDeducted: 5,
  }
  const CONTACTLESS: ContactResult = {
    success: true, hit: true,
    contacts: { ownerName: 'Marcus Halloway', phones: [], emails: [], mailingAddress: null },
  }

  it('moves on after a person hit whose people are not the owner (D6)', async () => {
    // MUTATION: end the stage on any contact hit (`if (call.hit) hit = call`) and this goes red.
    const d = deps({ tracePerson: contactSequence(NOT_MATCHED, CONTACT_HIT) })
    const r = await executeRoute(personPlan(), d, { now: clock })
    expect(r.steps.map(s => [s.kind, s.outcome])).toEqual([
      ['TRACERFY_INSTANT_NAMED', 'name_not_matched'],
      ['TRACERFY_PARCEL_APN', 'hit'],
    ])
    expect(r.steps[0]).toMatchObject({
      cost: VENDOR_COST.TRACERFY_INSTANT, creditsDeducted: 5,
      peopleCount: 1,
    })
    expect(r.steps[0]).not.toHaveProperty('people')
    expect(r.contactsFound).toBe(true)
    expect(r.vendorSpend).toBe(0.2)
  })

  it('never stores a returned name in the step log (D29)', async () => {
    // MUTATION: copy the vendor result's people (or spread the whole result) into the step and this goes red.
    const withNames = {
      ...NOT_MATCHED, people: [{ first_name: 'Someoneelse', last_name: 'Different' }],
    } as unknown as ContactResult
    const d = deps({ tracePerson: contactSequence(withNames, CONTACT_HIT) })
    const r = await executeRoute(personPlan(), d, { now: clock })
    expect(r.steps[0].peopleCount).toBe(1)
    expect(JSON.stringify(r.steps)).not.toMatch(/Someoneelse|Different/)
  })

  it('moves on after a matched hit that carries no phone and no email (Q1 a)', async () => {
    // MUTATION: end the stage on any contact hit and this goes red.
    const d = deps({ tracePerson: contactSequence(CONTACTLESS, CONTACT_MISS) })
    const r = await executeRoute(personPlan(), d, { now: clock })
    expect(d.tracePerson).toHaveBeenCalledTimes(2)
    expect(r.steps[0]).toMatchObject({ outcome: 'hit', noContacts: true })
    expect(r.contactsFound).toBe(false)
    expect(r.contacts).toBeNull()
  })

  it('stamps every asked step with the time and the exact question it answered', async () => {
    const plan = personPlan()
    const r = await executeRoute(plan, deps(), { now: clock })
    expect(r.steps.map(s => s.at)).toEqual(['2026-09-22T12:00:00.000Z', '2026-09-22T12:00:00.000Z'])
    expect(r.steps.map(s => s.requestKey)).toEqual(plan.steps.map(requestKeyFor))
  })

  it('treats our own refused request as not asked, never as a vendor failure (spec 5.1)', async () => {
    // MUTATION: delete the inputError branch in runStage and success flips to false.
    const refused: ContactResult = {
      success: false, hit: false, contacts: null,
      error: 'Person trace requires address, city and state', inputError: true,
    }
    const d = deps({ tracePerson: contactSequence(refused, CONTACT_HIT) })
    const r = await executeRoute(personPlan(), d, { now: clock })
    expect(r.success).toBe(true)
    expect(r.steps[0]).toMatchObject({ outcome: 'skipped', cost: 0 })
    expect(r.steps[0].note).toMatch(/not sent/)
    expect(r.steps[1].outcome).toBe('hit')
  })

  it('does not start a call it cannot finish inside the request budget', async () => {
    // MUTATION: delete the MIN_CALL_MS check and tracePerson is called twice.
    let t = NOW
    const d = deps({ tracePerson: vi.fn(async () => { t += 46_000; return CONTACT_MISS }) })
    const r = await executeRoute(personPlan(), d, { now: () => t, deadlineMs: NOW + 50_000 })
    expect(d.tracePerson).toHaveBeenCalledTimes(1)
    expect(r.success).toBe(false)
    expect(r.steps[1]).toMatchObject({ kind: 'TRACERFY_PARCEL_APN', outcome: 'failed' })
    expect(r.steps[1].error).toMatch(/ran out of time/)
  })

  it('gives each call only the budget that is left', async () => {
    const d = deps()
    await executeRoute(personPlan(), d, { now: clock, deadlineMs: NOW + 40_000 })
    expect(d.tracePerson).toHaveBeenNthCalledWith(1, expect.anything(), { timeoutMs: 40_000 })
  })

  it('calls the vendors with ONE argument when there is no budget (the crons)', async () => {
    const d = deps()
    await executeRoute(personPlan(), d, { now: clock })
    expect(vi.mocked(d.tracePerson).mock.calls[0]).toHaveLength(1)
  })

  describe('a resend reuses what already answered (spec 5.2)', () => {
    const logged = (
      plan: ReturnType<typeof personPlan>, ageMs: number, outcome: StepReport['outcome'] = 'miss',
    ): StepReport[] => [{
      kind: 'TRACERFY_INSTANT_NAMED', outcome, cost: 0,
      at: new Date(NOW - ageMs).toISOString(), requestKey: requestKeyFor(plan.steps[0]),
    }]

    it('does not buy an answered step again inside 24 hours', async () => {
      // MUTATION: skip the reusableAnswer lookup and the Instant step is bought again.
      const plan = personPlan()
      const d = deps()
      const r = await executeRoute(plan, d, { now: clock, priorSteps: logged(plan, 60 * 60 * 1000) })
      expect(d.tracePerson).toHaveBeenCalledTimes(1)
      expect(d.tracePerson).toHaveBeenCalledWith(expect.objectContaining({ parcel_id: '16183060290000' }))
      expect(r.steps[0]).toMatchObject({ outcome: 'miss', reused: true })
      // The entry keeps its OWN time, so the 24 hours run from the original answer.
      expect(r.steps[0].at).toBe(new Date(NOW - 60 * 60 * 1000).toISOString())
    })

    it('buys it again once the answer is 24 hours old', async () => {
      // MUTATION: drop the age test in reusableAnswer and this goes red.
      const plan = personPlan()
      const d = deps()
      await executeRoute(plan, d, { now: clock, priorSteps: logged(plan, STEP_REUSE_WINDOW_MS) })
      expect(d.tracePerson).toHaveBeenCalledTimes(2)
    })

    it('never reuses an answer to a different question', async () => {
      // MUTATION: match on the step kind alone and this goes red.
      const plan = personPlan()
      const other = planRoute(parcel({ ownerName: 'Gerald Pentland' }), 'wallet')
      const d = deps()
      await executeRoute(plan, d, { now: clock, priorSteps: logged(other, 1000) })
      expect(d.tracePerson).toHaveBeenCalledTimes(2)
    })

    it('never reuses a failed step', async () => {
      const plan = personPlan()
      const d = deps()
      await executeRoute(plan, d, { now: clock, priorSteps: logged(plan, 1000, 'failed') })
      expect(d.tracePerson).toHaveBeenCalledTimes(2)
    })

    it('reuses a billed non-match without spending on it again', async () => {
      const plan = personPlan()
      const prior: StepReport[] = [{
        kind: 'TRACERFY_INSTANT_NAMED', outcome: 'name_not_matched', cost: 0.1,
        at: new Date(NOW - 1000).toISOString(), requestKey: requestKeyFor(plan.steps[0]), peopleCount: 1,
      }]
      const r = await executeRoute(plan, deps(), { now: clock, priorSteps: prior })
      expect(r.steps[0]).toMatchObject({ outcome: 'name_not_matched', reused: true, cost: 0.1 })
      expect(r.vendorSpend).toBe(0)
    })

    it('never reuses a prior dated in the future', async () => {
      // MUTATION: delete "age >= 0" in reusableAnswer and this goes red (the future entry
      // is wrongly reused, so tracePerson is called once instead of twice).
      const plan = personPlan()
      const d = deps()
      // ageMs negative -> at = NOW - (-1000) = NOW + 1000, one second in the future.
      await executeRoute(plan, d, { now: clock, priorSteps: logged(plan, -1000) })
      expect(d.tracePerson).toHaveBeenCalledTimes(2)
    })

    it('never reuses a prior with a malformed at', async () => {
      const plan = personPlan()
      const d = deps()
      const prior: StepReport[] = [{
        kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss', cost: 0,
        at: 'not a date', requestKey: requestKeyFor(plan.steps[0]),
      }]
      await executeRoute(plan, d, { now: clock, priorSteps: prior })
      expect(d.tracePerson).toHaveBeenCalledTimes(2)
    })

    it('never reuses a prior that actually delivered', async () => {
      // MUTATION: narrow "(e.outcome === 'hit' && e.noContacts === true)" to "e.outcome === 'hit'"
      // in isReusableAnswer and this goes red (the delivering hit is wrongly reused, dropping the
      // contacts it bought, so tracePerson is called once instead of twice).
      const plan = personPlan()
      const d = deps()
      const prior: StepReport[] = [{
        kind: 'TRACERFY_INSTANT_NAMED', outcome: 'hit', cost: 0.1,
        at: new Date(NOW - 1000).toISOString(), requestKey: requestKeyFor(plan.steps[0]),
      }]
      await executeRoute(plan, d, { now: clock, priorSteps: prior })
      expect(d.tracePerson).toHaveBeenCalledTimes(2)
    })

    it('drops a name that arrives via priorSteps, not just via the vendor (D29)', async () => {
      // MUTATION: remove the stepLogFrom cleaning of options.priorSteps in executeRoute and this
      // goes red (a caller that casts row.trace_steps instead of calling stepLogFrom itself would
      // otherwise re-persist the raw name it was carrying).
      const plan = personPlan()
      const tainted = [{
        kind: 'TRACERFY_INSTANT_NAMED', outcome: 'name_not_matched', cost: 0.1,
        at: new Date(NOW - 1000).toISOString(), requestKey: requestKeyFor(plan.steps[0]),
        peopleCount: 1, people: [{ first_name: 'Someoneelse', last_name: 'Different' }],
      }] as unknown as StepReport[]
      const d = deps()
      const r = await executeRoute(plan, d, { now: clock, priorSteps: tainted })
      expect(r.steps[0]).toMatchObject({ outcome: 'name_not_matched', reused: true })
      expect(JSON.stringify(r.steps)).not.toMatch(/Someoneelse|Different/)
    })
  })

  describe('stepLogFrom', () => {
    it('reads back exactly what executeRoute wrote', async () => {
      const r = await executeRoute(personPlan(), deps({ tracePerson: contactSequence(NOT_MATCHED) }), { now: clock })
      expect(stepLogFrom(JSON.parse(JSON.stringify(r.steps)))).toEqual(r.steps)
    })

    it('drops anything that is not a step', () => {
      expect(stepLogFrom(null)).toEqual([])
      expect(stepLogFrom([{ kind: 'NOPE', outcome: 'miss' }, 'x', { kind: 'FASTAPPEND_ENTITY', outcome: 'maybe' }])).toEqual([])
    })

    it('drops a raw people key even off an otherwise well-formed entry (D29)', () => {
      // MUTATION: restore a `people` copy line in stepLogFrom and this goes red.
      const raw = {
        kind: 'TRACERFY_INSTANT_NAMED', outcome: 'name_not_matched', cost: 0.1,
        peopleCount: 1, people: [{ first_name: 'Someoneelse', last_name: 'Different' }],
      }
      const [step] = stepLogFrom([raw])
      expect(step).toMatchObject({ peopleCount: 1 })
      expect(step).not.toHaveProperty('people')
      expect(JSON.stringify(step)).not.toMatch(/Someoneelse|Different/)
    })

    it('drops an entry with no numeric cost, rather than inventing zero (CLAUDE.md rule 7)', () => {
      // MUTATION: restore the ": 0" cost default and this goes red.
      const raw = { kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss' }
      expect(stepLogFrom([raw])).toEqual([])
    })
  })
})

describe("executeRoute: D21 (c) every owner and the mailing address; D32, never the dossier's own contacts", () => {
  const TWO_INDIVIDUALS: DossierResult = {
    ...HIT_INDIVIDUAL,
    owners: [
      { first_name: 'Testowner', last_name: 'Placeholder', age: '00' },
      { first_name: 'Secondowner', last_name: 'Placeholder', age: '00' },
    ],
  }

  it('asks about every owner the dossier names, in order, until one has contacts', async () => {
    // MUTATION: loop over ownerNamesFrom(dossier).slice(0, 1) and this goes red.
    // tier2Plan() has a street, a city and a parcel id, so each individual gets Instant then parcel.
    const d = deps({
      lookupDossier: dossierSequence(TWO_INDIVIDUALS),
      tracePerson: contactSequence(CONTACT_MISS, CONTACT_MISS, CONTACT_HIT),
    })
    const r = await executeRoute(tier2Plan(), d)
    expect(d.tracePerson).toHaveBeenCalledTimes(3)
    expect(vi.mocked(d.tracePerson).mock.calls[2][0]).toMatchObject({ first_name: 'Secondowner', last_name: 'Placeholder' })
    expect(r.contacts).toBe(CONTACT_HIT.contacts)
  })

  it('stops asking on a contact FAILURE, rather than continuing to the next owner during an outage', async () => {
    // MUTATION: delete the early `return result` in the owner loop's failure branch and this goes
    // red: the loop keeps calling vendors for the second owner during the outage, and if that
    // owner hits, the result comes back success:false with contacts set anyway.
    // tier2Plan() has a street, a city and a parcel id, so owner one's stage is Instant then
    // parcel; the Instant call fails, which stops that stage before the parcel step is even asked.
    const tracePerson = vi.fn()
      .mockResolvedValueOnce({ success: false, hit: false, contacts: null, error: 'Tracerfy service unavailable' })
      .mockResolvedValue(CONTACT_HIT)
    const d = deps({ lookupDossier: dossierSequence(TWO_INDIVIDUALS), tracePerson })
    const r = await executeRoute(tier2Plan(), d)
    expect(d.tracePerson).toHaveBeenCalledTimes(1)
    expect(r.success).toBe(false)
    expect(r.contacts).toBeNull()
  })

  it('sends an entity co-owner to FastAppend and an individual to Tracerfy (D14)', async () => {
    const MIXED: DossierResult = {
      ...HIT_INDIVIDUAL,
      owners: [
        { first_name: 'Testowner', last_name: 'Placeholder', age: '00' },
        { first_name: '', last_name: 'Acme Holdings Llc', age: '' },
      ],
    }
    const d = deps({ lookupDossier: dossierSequence(MIXED), traceEntity: vi.fn(async () => CONTACT_HIT) })
    const r = await executeRoute(tier2Plan(), d)
    expect(d.tracePerson).toHaveBeenCalledTimes(2)
    expect(d.traceEntity).toHaveBeenCalledWith({ company_name: 'Acme Holdings Llc', state: 'UT' })
    expect(r.contactsFound).toBe(true)
  })

  it('searches an individual at the dossier mailing address when the property has no street or city (D21 c)', async () => {
    // MUTATION: return `base` unconditionally from contactParcelFor and the parcel lookup runs instead.
    const plan = tier2Plan({ situsAddress: null, situsCity: null, situsState: null })
    const d = deps({ lookupDossier: dossierSequence(HIT_INDIVIDUAL), tracePerson: vi.fn(async () => CONTACT_HIT) })
    await executeRoute(plan, d)
    expect(d.tracePerson).toHaveBeenCalledTimes(1)
    expect(d.tracePerson).toHaveBeenCalledWith({
      first_name: 'Testowner', last_name: 'Placeholder',
      address: '100 Placeholder Way', city: 'Redacted', state: 'ZZ', zip: '00000',
      find_owner: false,
    })
  })

  it("never returns the dossier's own contacts, even when every owner misses (D32)", async () => {
    // spec D32 (2026-09-22): the dossier's own contacts block is withdrawn entirely. The dossier
    // identifies the owner and whether it is an individual or an entity; phones and emails come
    // ONLY from the separate Tracerfy (individual) or FastAppend (entity) call. If every owner's
    // lookup misses, the result is a true null: no fallback of any kind, in any phase.
    // MUTATION: reintroduce a hard-coded contacts object carrying this fixture's own phone
    // numbers and email after the loop, and this goes red.
    const d = deps({ lookupDossier: dossierSequence(HIT_INDIVIDUAL) })
    const r = await executeRoute(tier2Plan(), d)
    expect(d.tracePerson).toHaveBeenCalledTimes(2)
    expect(r.contactsFound).toBe(false)
    expect(r.contacts).toBeNull()
    // individual-hit.json's synthetic contacts block (fixtures/README.md), never surfaced.
    const json = JSON.stringify(r)
    expect(json).not.toContain('5555550100')
    expect(json).not.toContain('5555550101')
    expect(json).not.toContain('redacted@example.invalid')
  })

  it('never sends a non-individual owner to the mailing address, even with no situs (D21 c)', async () => {
    // D21 (c) reserves the mailing-address search for an INDIVIDUAL owner. A trust (or an
    // unclassifiable name) still gets the ordinary no-situs ladder: the parcel lookup, never the
    // Instant lookup at the mailing address.
    // MUTATION: drop `classifyOwnerName(owner) === 'individual'` from contactParcelFor and this
    // goes red (the parcel id and county are discarded for the mailing address instead).
    const TRUST_OWNER: DossierResult = {
      ...HIT_INDIVIDUAL, // carries a complete mailing address, so only the owner-type check stops it
      owners: [{ first_name: '', last_name: 'Marcus T Halloway Living Trust', age: '' }],
    }
    const plan = tier2Plan({ situsAddress: null, situsCity: null, situsState: null })
    const d = deps({ lookupDossier: dossierSequence(TRUST_OWNER) })
    const r = await executeRoute(plan, d)
    expect(r.steps.map(s => s.kind)).toContain('TRACERFY_PARCEL_APN')
    expect(d.tracePerson).toHaveBeenCalledWith(expect.objectContaining({
      parcel_id: '16183060290000', county: 'Salt Lake', state: 'UT',
    }))
    expect(d.tracePerson).not.toHaveBeenCalledWith(expect.objectContaining({
      address: '100 Placeholder Way',
    }))
  })

  it('runs the parcel lookup rather than throwing when the dossier has no mailing address (D21 c)', async () => {
    // executeRoute never throws (house pattern). A null mailing address must not reach
    // `mailing!.address` inside contactParcelFor.
    // MUTATION: drop the `mailingComplete` check from contactParcelFor's guard and this throws
    // (TypeError reading .address off null) instead of resolving with the parcel lookup.
    const plan = tier2Plan({ situsAddress: null, situsCity: null, situsState: null })
    const d = deps({
      lookupDossier: dossierSequence({ ...HIT_INDIVIDUAL, mailingAddress: null }),
      tracePerson: vi.fn(async () => CONTACT_HIT),
    })
    await expect(executeRoute(plan, d)).resolves.toMatchObject({ success: true, contactsFound: true })
    expect(d.tracePerson).toHaveBeenCalledWith(expect.objectContaining({
      parcel_id: '16183060290000', county: 'Salt Lake', state: 'UT',
    }))
  })
})

describe('contactVendorFrom: the vendor that produced the contacts wins', () => {
  it('names fastappend when a trust ladder missed at Tracerfy and hit at FastAppend', () => {
    // MUTATION: drop the hit-first loop and this answers tracerfy.
    expect(contactVendorFrom([
      { kind: 'TRACERFY_INSTANT_NAMED', outcome: 'miss', cost: 0 },
      { kind: 'FASTAPPEND_ENTITY', outcome: 'hit', cost: 0.1 },
    ])).toBe('fastappend')
  })
})
