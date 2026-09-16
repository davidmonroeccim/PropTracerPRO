import { describe, it, expect } from 'vitest'
import {
  classifyOwnerName, splitPersonName, assessLoan, planRoute, PRICE, DEFAULT_PRICE_PLAN, VENDOR_COST,
  type ParcelInput,
} from '../ownerRoute'

/**
 * Entity names, dollar figures and parcel facts are real values observed in the
 * 2026-09-16 run of 24 commercial parcels across OH, CA and UT. Individual owner
 * names are synthetic stand-ins that preserve the exact string shape each test
 * exercises: living private individuals do not belong in a committed fixture.
 */

describe('classifyOwnerName', () => {
  it.each([
    'Cutting Edge Hodings Llc', 'Abc Rentals Llc', 'Brunswick 1299 Mp Rk6 Llc',
    'Pin Oak Estates Ltd', 'Storage Trust Properties', 'John Anthony Investments Llc',
    'Kt Investments Llc', 'Country Club Investors', 'Estates Ave Properties Llc',
    'Pinnacle Real Estate, Inc', 'Ovd Springfield Holding Llc', 'Blackhorse Energy Llc',
    'Hill Apartments Of Springfield Llc', 'Bnt Apartments, Llc', 'Parma Mhp Llc',
    'Whiskey Tango Foxtrot Llc', 'Whisman Properties Ltd', 'Marilyn J Cole Brookville Llc',
    'Delphos East Towne Plaza Llc', 'Pohlman Property 9 Llc', 'Evergreen Bldg Llc',
  ])('classifies %s as an entity', (name) => {
    expect(classifyOwnerName(name)).toBe('entity')
  })

  it('classifies a space separated L L C as an entity, not a four token person', () => {
    // Shipped wrong once: the dots-only pattern missed this and the person heuristic
    // claimed it on token count alone.
    expect(classifyOwnerName('Bhf L L C')).toBe('entity')
    expect(classifyOwnerName('Bhf L.L.C.')).toBe('entity')
    expect(classifyOwnerName('Bhf LLC')).toBe('entity')
  })

  it('treats a person named alongside a trust as a routable individual', () => {
    // The trustee is a natural person, so Tracerfy can find them.
    expect(classifyOwnerName('Marcus T Halloway | Halloway Living Trust')).toBe('individual')
  })

  it('classifies a trust with no person as its own lane', () => {
    // No SoS registration and no person, so neither vendor applies.
    expect(classifyOwnerName('Halloway Living Trust')).toBe('trust')
  })

  it.each(['Gerald Pentland', 'Noreen Pentland', 'Marcus T Halloway', 'Jingwen & Shaolan Wu'])(
    'classifies %s as an individual', (name) => {
      expect(classifyOwnerName(name)).toBe('individual')
    })

  it('returns unknown rather than guessing on an empty name', () => {
    expect(classifyOwnerName('')).toBe('unknown')
    expect(classifyOwnerName(null)).toBe('unknown')
    expect(classifyOwnerName(undefined)).toBe('unknown')
  })
})

describe('splitPersonName', () => {
  it.each([
    ['Marcus T Halloway | Halloway Living Trust', 'Marcus', 'Halloway'],
    ['Jingwen & Shaolan Wu', 'Jingwen', 'Wu'],
    ['Marcus T Halloway', 'Marcus', 'Halloway'],
    ['Halloway Marcus T', 'Marcus', 'Halloway'],
    ['Gerald Pentland', 'Gerald', 'Pentland'],
    ['Alan Merrifield Crowe', 'Alan', 'Crowe'],
    ['Vance Elliot A Jr', 'Elliot', 'Vance'],
    ['Diane Latham ET UX', 'Diane', 'Latham'],
  ])('%s splits to %s / %s', (input, first, last) => {
    expect(splitPersonName(input)).toEqual({ first_name: first, last_name: last })
  })

  it('never takes a surname from past the multi owner separator', () => {
    // Regression: produced last_name "Trust". Same failure shape as the documented
    // owner_name.split(' ') bug that yielded "& Shaolan Wu".
    expect(splitPersonName('Marcus T Halloway | Halloway Living Trust').last_name).not.toBe('Trust')
  })

  it('survives a single token and an empty string', () => {
    expect(splitPersonName('Cher')).toEqual({ first_name: 'Cher', last_name: '' })
    expect(splitPersonName('')).toEqual({ first_name: '', last_name: '' })
  })
})

describe('assessLoan', () => {
  it('accepts a loan at or under the sale price as parcel level debt', () => {
    // 2443 Troy Rd: $492,648 against a $780,000 sale.
    const a = assessLoan({ openMortgageBalance: 492648, lastSalePrice: 780000, lastSaleDate: '2019-06-01', buildingSizeSqft: 10090 })
    expect(a.verdict).toBe('parcel_level')
    expect(a.usableAsParcelDebt).toBe(true)
  })

  it('rejects a loan far above the sale price as portfolio debt', () => {
    // 1600 Gressel Dr: $48,000,000 against an $8,500,000 sale.
    const a = assessLoan({ openMortgageBalance: 48000000, lastSalePrice: 8500000, lastSaleDate: '2014-01-01', buildingSizeSqft: 46909 })
    expect(a.verdict).toBe('portfolio')
    expect(a.usableAsParcelDebt).toBe(false)
  })

  it('still catches portfolio debt when the only sale on record is stale', () => {
    // 3620 Lightner Rd: $4,387,000 against a $690,000 sale. A freshness gate that
    // discarded the stale basis scored this "unknown" and lost the signal.
    const a = assessLoan({ openMortgageBalance: 4387000, lastSalePrice: 690000, lastSaleDate: '2005-01-01', buildingSizeSqft: 35942 })
    expect(a.verdict).toBe('portfolio')
    expect(a.basis).toBe('stale_sale')
  })

  it('widens the bands for a stale sale rather than discarding it', () => {
    // 1540 Faux Satin Dr: 0.87x. Ordinary debt, recovered by the widened bands.
    const a = assessLoan({ openMortgageBalance: 4300000, lastSalePrice: 4925000, lastSaleDate: '2009-01-01', buildingSizeSqft: 10560 })
    expect(a.verdict).toBe('parcel_level')
    expect(a.basis).toBe('stale_sale')
  })

  it('falls back to debt per building sqft when there is no sale price', () => {
    // 1299 Industrial Pkwy N: $175,000,000 over 41,588 sqft.
    const a = assessLoan({ openMortgageBalance: 175000000, lastSalePrice: 0, buildingSizeSqft: 41588 })
    expect(a.verdict).toBe('portfolio')
    expect(a.basis).toBe('sqft')
  })

  it('never blesses a loan as parcel level on the sqft basis alone', () => {
    // The magnitude test can rule debt OUT. It can never rule it IN without a value.
    const a = assessLoan({ openMortgageBalance: 1065389, lastSalePrice: 0, buildingSizeSqft: 31221 })
    expect(a.usableAsParcelDebt).toBe(false)
  })

  it('flags the building area, not the loan, when they contradict', () => {
    // 1201 Brindlestone Dr: a 20-39 unit complex reporting 782 sqft. The 0.70x loan
    // is ordinary; the square footage is the bad field.
    const a = assessLoan({ openMortgageBalance: 1580000, lastSalePrice: 2262200, lastSaleDate: '2021-01-01', buildingSizeSqft: 782 })
    expect(a.verdict).toBe('parcel_level')
    expect(a.buildingAreaSuspect).toBe(true)
  })

  it('never uses assessed value as a value basis', () => {
    // estimated_value equalled assessed_value on 23 of 23 parcels in OH, CA and UT,
    // and assessed/sale ranged 0.07 to 0.59 within Ohio alone.
    const withAssessed = assessLoan({ openMortgageBalance: 1000000, lastSalePrice: 0, assessedValue: 184055, buildingSizeSqft: 2236 })
    const withoutAssessed = assessLoan({ openMortgageBalance: 1000000, lastSalePrice: 0, buildingSizeSqft: 2236 })
    expect(withAssessed).toEqual(withoutAssessed)
  })

  it('reports unknown when there is no mortgage at all', () => {
    const a = assessLoan({ openMortgageBalance: 0, lastSalePrice: 675000 })
    expect(a.verdict).toBe('unknown')
    expect(a.basis).toBe('none')
  })

  it('reports unknown when there is neither a sale price nor building area', () => {
    const a = assessLoan({ openMortgageBalance: 500000, lastSalePrice: 0, buildingSizeSqft: 0 })
    expect(a.verdict).toBe('unknown')
  })
})

const parcel = (over: Partial<ParcelInput> = {}): ParcelInput => ({
  parcelIdLocal: '16183060290000', county: 'Salt Lake', state: 'UT',
  situsAddress: '1815 S State St', situsCity: 'Salt Lake City', situsState: 'UT', situsZip: null,
  ownerName: null, ...over,
})

describe('PRICE', () => {
  // The old shape held TIER_1_PER_SUCCESS 0.15 + TIER_2_PER_RECORD 0.40, which mixed the
  // pro tier-1 rate with the pay-as-you-go tier-2 rate and so described no real customer.
  it('carries all four customer-facing numbers, keyed by plan', () => {
    expect(PRICE.pro).toEqual({ tier1PerSuccess: 0.15, tier2PerRecord: 0.25 })
    expect(PRICE.acqPro).toEqual({ tier1PerSuccess: 0.15, tier2PerRecord: 0.25 })
    expect(PRICE.wallet).toEqual({ tier1PerSuccess: 0.25, tier2PerRecord: 0.40 })
  })

  it('prices AcquisitionPRO members at the Pro rate on both tiers', () => {
    expect(PRICE.acqPro).toEqual(PRICE.pro)
  })

  // Owner type is NOT a pricing axis. It selects the vendor (Tracerfy vs FastAppend) and nothing
  // else. A third key here, whatever it is named, is an entity rate and is wrong.
  it('carries exactly two numbers per plan, with no owner-type axis', () => {
    for (const plan of Object.values(PRICE)) {
      expect(Object.keys(plan).sort()).toEqual(['tier1PerSuccess', 'tier2PerRecord'])
    }
  })

  it('never mixes plans: every plan tier 2 costs more than its own tier 1', () => {
    for (const plan of Object.values(PRICE)) {
      expect(plan.tier2PerRecord).toBeGreaterThan(plan.tier1PerSuccess)
    }
  })
})

describe('planRoute', () => {
  it('bills tier 1 per successful trace and tier 2 per record', () => {
    expect(planRoute(parcel({ ownerName: 'Abc Rentals Llc' })).billing)
      .toEqual({ model: 'per_successful_trace', amount: PRICE[DEFAULT_PRICE_PLAN].tier1PerSuccess })
    expect(planRoute(parcel()).billing)
      .toEqual({ model: 'per_record', amount: PRICE[DEFAULT_PRICE_PLAN].tier2PerRecord })
  })

  it('bills an entity and an individual the SAME tier 1 amount, differing only in vendor', () => {
    const entity = planRoute(parcel({ ownerName: 'Abc Rentals Llc' }))
    const person = planRoute(parcel({ ownerName: 'Marcus T Halloway' }))
    expect(entity.ownerType).toBe('entity')
    expect(person.ownerType).toBe('individual')
    // Different vendor...
    expect(entity.steps[0].kind).toBe('FASTAPPEND_ENTITY')
    expect(person.steps[0].kind).toBe('TRACERFY_INSTANT_NAMED')
    // ...same price. There is no entity rate, surcharge or discount in the model.
    expect(entity.billing).toEqual(person.billing)
    expect(entity.billing.amount).toBe(PRICE[DEFAULT_PRICE_PLAN].tier1PerSuccess)
  })

  it('routes a known entity to FastAppend with no address', () => {
    const r = planRoute(parcel({ ownerName: 'Storage Trust Properties', state: 'OH' }))
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].kind).toBe('FASTAPPEND_ENTITY')
    expect(r.steps[0].request).not.toHaveProperty('address')
    expect(r.steps[0].costOnHit).toBe(VENDOR_COST.FASTAPPEND_ENTITY)
  })

  it('warns that the property state is standing in for the registration state', () => {
    const r = planRoute(parcel({ ownerName: 'Storage Trust Properties', state: 'OH' }))
    expect(r.warnings.join(' ')).toMatch(/STATE OF REGISTRATION/)
    expect(r.steps[0].request.state).toBe('OH')
  })

  it('uses a known registration state over the property state', () => {
    const r = planRoute(parcel({ ownerName: 'Storage Trust Properties', state: 'OH', registrationState: 'DE' }))
    expect(r.steps[0].request.state).toBe('DE')
    expect(r.warnings.join(' ')).not.toMatch(/STATE OF REGISTRATION/)
  })

  it('routes a known individual with situs to a named lookup, not find_owner', () => {
    const r = planRoute(parcel({ ownerName: 'Marcus T Halloway | Halloway Living Trust' }))
    expect(r.steps[0].kind).toBe('TRACERFY_INSTANT_NAMED')
    // find_owner true missed on this absentee-owned parcel; the named lookup hit.
    expect(r.steps[0].request.find_owner).toBe(false)
    expect(r.steps[0].request.last_name).toBe('Halloway')
  })

  it('warns never to filter on property_owner once the name is known', () => {
    const r = planRoute(parcel({ ownerName: 'Marcus T Halloway' }))
    expect(r.warnings.join(' ')).toMatch(/property_owner/)
  })

  it('falls back to the APN key for an individual with incomplete situs', () => {
    const r = planRoute(parcel({ ownerName: 'Marcus T Halloway', situsAddress: null, situsCity: null, situsState: null }))
    expect(r.steps[0].kind).toBe('TRACERFY_PARCEL_APN')
  })

  it('emits both dossier keys when both are available, because they fail independently', () => {
    // Salt Lake missed on APN and hit on address. Napa did the reverse.
    const r = planRoute(parcel())
    expect(r.steps.map(s => s.kind)).toEqual(['DOSSIER_APN', 'DOSSIER_ADDRESS'])
    expect(r.needsOwnerDiscovery).toBe(true)
  })

  it('plans an address only prospect with no parcel id', () => {
    const r = planRoute(parcel({ parcelIdLocal: '', county: '' }))
    expect(r.steps.map(s => s.kind)).toEqual(['DOSSIER_ADDRESS'])
    expect(r.steps[0].request).toMatchObject({ address: '1815 S State St', city: 'Salt Lake City', state: 'UT' })
  })

  it('plans an APN only parcel with no situs', () => {
    const r = planRoute(parcel({ situsAddress: null, situsCity: null, situsState: null }))
    expect(r.steps.map(s => s.kind)).toEqual(['DOSSIER_APN'])
  })

  it('emits no steps and says so when neither key is available', () => {
    const r = planRoute(parcel({ parcelIdLocal: '', county: '', situsAddress: null, situsCity: null, situsState: null }))
    expect(r.steps).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/Neither dossier key/)
  })

  it('sends a trust-only owner to manual review rather than guessing a vendor', () => {
    const r = planRoute(parcel({ ownerName: 'Halloway Living Trust' }))
    expect(r.ownerType).toBe('trust')
    expect(r.steps).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/manual review/)
  })

  it('never invents a vendor for an unclassifiable owner', () => {
    const r = planRoute(parcel({ ownerName: '???' }))
    expect(r.steps).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/manual review/)
  })

  it('every step is free on a miss, so a fallback only costs money when it works', () => {
    for (const p of [parcel(), parcel({ ownerName: 'Abc Rentals Llc' }), parcel({ ownerName: 'Marcus T Halloway' })]) {
      for (const s of planRoute(p).steps) expect(s.freeOnMiss).toBe(true)
    }
  })
})
