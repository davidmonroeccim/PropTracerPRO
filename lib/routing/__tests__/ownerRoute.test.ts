import { describe, it, expect } from 'vitest'
import {
  classifyOwnerName, splitPersonName, assessLoan, planRoute, stripTrustWords,
  PRICE, FAILSAFE_PRICE_PLAN, VENDOR_COST,
  type ParcelInput, type PricePlan, type RoutePlan,
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

/**
 * planRoute now REQUIRES a plan. The routing tests below are about which vendor runs, not
 * about price, so they name one plan here once. The pricing tests pass the plan explicitly.
 */
const routeFor = (p: ParcelInput): RoutePlan => planRoute(p, 'wallet')

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

describe('planRoute pricing by plan (B5)', () => {
  const PLANS: PricePlan[] = ['pro', 'acqPro', 'wallet']

  it.each(PLANS)('prices both tiers from the %s column, not a hardcoded one', (plan) => {
    expect(planRoute(parcel({ ownerName: 'Abc Rentals Llc' }), plan).billing)
      .toEqual({ model: 'per_successful_trace', amount: PRICE[plan].tier1PerSuccess })
    expect(planRoute(parcel(), plan).billing)
      .toEqual({ model: 'per_record', amount: PRICE[plan].tier2PerRecord })
  })

  it('bills pay-as-you-go at the wallet rate, not the pro rate', () => {
    // THE DEFECT. The old planRoute reported $0.25 here, 40% under rate, on every
    // pay-as-you-go tier 2 record, and $0.15 instead of $0.25 on tier 1.
    expect(planRoute(parcel(), 'wallet').billing.amount).toBe(0.40)
    expect(planRoute(parcel({ ownerName: 'Abc Rentals Llc' }), 'wallet').billing.amount).toBe(0.25)
  })

  it('never prices one plan at another plans rate', () => {
    for (const plan of PLANS) {
      const tier2 = planRoute(parcel(), plan).billing.amount
      const tier1 = planRoute(parcel({ ownerName: 'Abc Rentals Llc' }), plan).billing.amount
      expect(tier2).toBe(PRICE[plan].tier2PerRecord)
      expect(tier1).toBe(PRICE[plan].tier1PerSuccess)
    }
  })

  // THE TRAP TEST. planRoute has no default plan: the parameter is required, so a caller
  // that forgets one does not compile. A value that only goes wrong at runtime (a JS caller,
  // or a plan column that came back NULL) falls through to the MOST EXPENSIVE column, so a
  // mis-wire overcharges and gets reported rather than undercharging silently and invisibly.
  // If anyone ever restores a cheap default, these go red.
  it('fails safe to the dearest column when no plan reaches it at runtime', () => {
    const noPlan = planRoute as unknown as (p: ParcelInput) => RoutePlan
    expect(noPlan(parcel()).billing.amount).toBe(PRICE.wallet.tier2PerRecord)
    expect(noPlan(parcel()).billing.amount).not.toBe(PRICE.pro.tier2PerRecord)
    expect(noPlan(parcel({ ownerName: 'Abc Rentals Llc' })).billing.amount)
      .toBe(PRICE.wallet.tier1PerSuccess)
  })

  it('fails safe to the dearest column on an unrecognised plan name', () => {
    const dearestTier2 = Math.max(...Object.values(PRICE).map(p => p.tier2PerRecord))
    const dearestTier1 = Math.max(...Object.values(PRICE).map(p => p.tier1PerSuccess))
    const bogus = 'enterprise' as PricePlan
    expect(planRoute(parcel(), bogus).billing.amount).toBe(dearestTier2)
    expect(planRoute(parcel({ ownerName: 'Abc Rentals Llc' }), bogus).billing.amount).toBe(dearestTier1)
  })

  it('names the dearest plan as the failsafe, never the cheapest', () => {
    for (const plan of PLANS) {
      expect(PRICE[FAILSAFE_PRICE_PLAN].tier1PerSuccess).toBeGreaterThanOrEqual(PRICE[plan].tier1PerSuccess)
      expect(PRICE[FAILSAFE_PRICE_PLAN].tier2PerRecord).toBeGreaterThanOrEqual(PRICE[plan].tier2PerRecord)
    }
  })

  it('echoes the plan and the parcel it planned from, so a re-entry can be faithful', () => {
    // The tier 2 two-pass re-enters planRoute with the discovered owner. It can only do
    // that at the same rate, for the same parcel, if the plan carries both.
    const p = parcel()
    const r = planRoute(p, 'acqPro')
    expect(r.pricePlan).toBe('acqPro')
    expect(r.parcel).toEqual(p)
  })
})

describe('planRoute with an address-only parcel (B6)', () => {
  /** What every entry point in PTP actually produces: no parcel id, no county. */
  const addressOnly = (over: Partial<ParcelInput> = {}): ParcelInput => ({
    state: 'UT',
    situsAddress: '1815 S State St', situsCity: 'Salt Lake City', situsState: 'UT', situsZip: null,
    ownerName: null, ...over,
  })

  it('accepts a parcel with no parcelIdLocal and no county at all', () => {
    // Not '' placeholders: the keys are ABSENT, which is the shape the app produces.
    const r = planRoute(addressOnly(), 'wallet')
    expect(r.tier).toBe(2)
    expect(r.needsOwnerDiscovery).toBe(true)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].kind).toBe('DOSSIER_ADDRESS')
  })

  it('sends only the address key, never a half-built APN key', () => {
    const r = planRoute(addressOnly({ situsZip: '84115' }), 'wallet')
    expect(r.steps[0].request).toEqual({
      address: '1815 S State St', city: 'Salt Lake City', state: 'UT', zip_code: '84115',
    })
    expect(r.steps[0].request).not.toHaveProperty('apn')
    expect(r.steps[0].request).not.toHaveProperty('county')
  })

  it('still prices, warns and costs correctly with one step', () => {
    const r = planRoute(addressOnly(), 'wallet')
    expect(r.billing).toEqual({ model: 'per_record', amount: PRICE.wallet.tier2PerRecord })
    expect(r.steps[0].costOnHit).toBe(VENDOR_COST.DOSSIER)
    expect(r.steps[0].freeOnMiss).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/Re-enter planRoute/)
    expect(r.warnings.join(' ')).not.toMatch(/Neither dossier key/)
  })

  it('warns about the missing zip rather than silently sending none', () => {
    expect(planRoute(addressOnly(), 'wallet').warnings.join(' ')).toMatch(/No zip sent/)
  })

  it('reaches the no-key warning when an address-only parcel has no situs either', () => {
    const r = planRoute(addressOnly({ situsAddress: null, situsCity: null, situsState: null }), 'wallet')
    expect(r.steps).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/Neither dossier key/)
  })

  it('never emits an APN-keyed contact step for an address-only individual with no situs', () => {
    // Making the APN optional exposes this: the tier 1 APN fallback would otherwise be
    // built with parcel_id undefined and county undefined, a request that cannot match.
    const r = planRoute(
      addressOnly({ ownerName: 'Marcus T Halloway', situsAddress: null, situsCity: null, situsState: null }),
      'wallet',
    )
    expect(r.steps).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/manual review/)
  })
})

describe('planRoute', () => {
  it('bills tier 1 per successful trace and tier 2 per record', () => {
    expect(routeFor(parcel({ ownerName: 'Abc Rentals Llc' })).billing)
      .toEqual({ model: 'per_successful_trace', amount: PRICE.wallet.tier1PerSuccess })
    expect(routeFor(parcel()).billing)
      .toEqual({ model: 'per_record', amount: PRICE.wallet.tier2PerRecord })
  })

  it('bills an entity and an individual the SAME tier 1 amount, differing only in vendor', () => {
    const entity = routeFor(parcel({ ownerName: 'Abc Rentals Llc' }))
    const person = routeFor(parcel({ ownerName: 'Marcus T Halloway' }))
    expect(entity.ownerType).toBe('entity')
    expect(person.ownerType).toBe('individual')
    // Different vendor...
    expect(entity.steps[0].kind).toBe('FASTAPPEND_ENTITY')
    expect(person.steps[0].kind).toBe('TRACERFY_INSTANT_NAMED')
    // ...same price. There is no entity rate, surcharge or discount in the model.
    expect(entity.billing).toEqual(person.billing)
    expect(entity.billing.amount).toBe(PRICE.wallet.tier1PerSuccess)
  })

  it('routes a known entity to FastAppend with no address', () => {
    const r = routeFor(parcel({ ownerName: 'Storage Trust Properties', state: 'OH' }))
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].kind).toBe('FASTAPPEND_ENTITY')
    expect(r.steps[0].request).not.toHaveProperty('address')
    expect(r.steps[0].costOnHit).toBe(VENDOR_COST.FASTAPPEND_ENTITY)
  })

  it('warns that the property state is standing in for the registration state', () => {
    const r = routeFor(parcel({ ownerName: 'Storage Trust Properties', state: 'OH' }))
    expect(r.warnings.join(' ')).toMatch(/STATE OF REGISTRATION/)
    expect(r.steps[0].request.state).toBe('OH')
  })

  it('uses a known registration state over the property state', () => {
    const r = routeFor(parcel({ ownerName: 'Storage Trust Properties', state: 'OH', registrationState: 'DE' }))
    expect(r.steps[0].request.state).toBe('DE')
    expect(r.warnings.join(' ')).not.toMatch(/STATE OF REGISTRATION/)
  })

  it('routes a known individual with situs to a named lookup, not find_owner', () => {
    const r = routeFor(parcel({ ownerName: 'Marcus T Halloway | Halloway Living Trust' }))
    expect(r.steps[0].kind).toBe('TRACERFY_INSTANT_NAMED')
    // find_owner true missed on this absentee-owned parcel; the named lookup hit.
    expect(r.steps[0].request.find_owner).toBe(false)
    expect(r.steps[0].request.last_name).toBe('Halloway')
  })

  it('warns never to filter on property_owner once the name is known', () => {
    const r = routeFor(parcel({ ownerName: 'Marcus T Halloway' }))
    expect(r.warnings.join(' ')).toMatch(/property_owner/)
  })

  it('falls back to the APN key for an individual with incomplete situs', () => {
    const r = routeFor(parcel({ ownerName: 'Marcus T Halloway', situsAddress: null, situsCity: null, situsState: null }))
    expect(r.steps[0].kind).toBe('TRACERFY_PARCEL_APN')
  })

  it('emits both dossier keys when both are available, because they fail independently', () => {
    // Salt Lake missed on APN and hit on address. Napa did the reverse.
    const r = routeFor(parcel())
    expect(r.steps.map(s => s.kind)).toEqual(['DOSSIER_APN', 'DOSSIER_ADDRESS'])
    expect(r.needsOwnerDiscovery).toBe(true)
  })

  it('plans an address only prospect with no parcel id', () => {
    const r = routeFor(parcel({ parcelIdLocal: '', county: '' }))
    expect(r.steps.map(s => s.kind)).toEqual(['DOSSIER_ADDRESS'])
    expect(r.steps[0].request).toMatchObject({ address: '1815 S State St', city: 'Salt Lake City', state: 'UT' })
  })

  it('plans an APN only parcel with no situs', () => {
    const r = routeFor(parcel({ situsAddress: null, situsCity: null, situsState: null }))
    expect(r.steps.map(s => s.kind)).toEqual(['DOSSIER_APN'])
  })

  it('emits no steps and says so when neither key is available', () => {
    const r = routeFor(parcel({ parcelIdLocal: '', county: '', situsAddress: null, situsCity: null, situsState: null }))
    expect(r.steps).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/Neither dossier key/)
  })

  it('sends a trust-only owner with no first name to FastAppend on the full name (D16)', () => {
    const r = routeFor(parcel({ ownerName: 'Halloway Living Trust' }))
    expect(r.ownerType).toBe('trust')
    expect(r.steps.map(s => s.kind)).toEqual(['FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toMatchObject({ company_name: 'Halloway Living Trust' })
  })

  it('never invents a vendor for an unclassifiable owner', () => {
    const r = routeFor(parcel({ ownerName: '???' }))
    expect(r.steps).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/manual review/)
  })

  it('every step is free on a miss, so a fallback only costs money when it works', () => {
    for (const p of [parcel(), parcel({ ownerName: 'Abc Rentals Llc' }), parcel({ ownerName: 'Marcus T Halloway' })]) {
      for (const s of routeFor(p).steps) expect(s.freeOnMiss).toBe(true)
    }
  })
})

describe('Tier 1 ladders (spec 4.2; D2, D3, D4, D16)', () => {
  const t1 = (ownerName: string, over: Partial<ParcelInput> = {}) =>
    planRoute(parcel({ ownerName, ...over }), 'wallet')
  const kinds = (r: RoutePlan) => r.steps.map(s => s.kind)

  it('classifies a trailing TR or TTEE as a trust, so the name reaches the trust ladder (spec 4.1)', () => {
    // MUTATION: put TR|TTEE back into ENTITY_TRAILING and this goes red.
    expect(classifyOwnerName('SMITH JOHN TR')).toBe('trust')
    expect(classifyOwnerName('SMITH JOHN TTEE')).toBe('trust')
    expect(classifyOwnerName('Mary Jones Revocable Trust U/A')).toBe('trust')
    expect(classifyOwnerName('Storage Trust Properties')).toBe('entity')
  })

  it('keeps a trailing TRS an entity: FastAppend on the full name only (spec D30)', () => {
    // MUTATION: take TRS out of ENTITY_TRAILING and this goes red.
    expect(classifyOwnerName('SMITH JOHN TRS')).toBe('entity')
    const r = t1('SMITH JOHN TRS')
    expect(kinds(r)).toEqual(['FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toEqual({ company_name: 'SMITH JOHN TRS', state: 'UT' })
  })

  it('person: the Instant lookup at the street and city first, then the parcel lookup', () => {
    expect(kinds(t1('Marcus T Halloway'))).toEqual(['TRACERFY_INSTANT_NAMED', 'TRACERFY_PARCEL_APN'])
  })

  it('person with no city: the parcel lookup only', () => {
    expect(kinds(t1('Marcus T Halloway', { situsCity: null }))).toEqual(['TRACERFY_PARCEL_APN'])
  })

  it('the parcel step carries the owner names for the match (L-020)', () => {
    // MUTATION: drop `...who` from the parcel step request and this goes red.
    expect(t1('Marcus T Halloway').steps[1].request).toEqual({
      parcel_id: '16183060290000', county: 'Salt Lake', state: 'UT',
      first_name: 'Marcus', last_name: 'Halloway',
    })
  })

  it('company: FastAppend on name and state only, and the lane stops there (D4)', () => {
    const r = t1('Abc Rentals Llc')
    expect(kinds(r)).toEqual(['FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toEqual({ company_name: 'Abc Rentals Llc', state: 'UT' })
  })

  it('trust: the person steps on the stripped name, then FastAppend on the full name (D3)', () => {
    // MUTATION: run the person steps on the unstripped name and last_name becomes "Trust".
    // MUTATION: drop the trailing FastAppend push and the third kind disappears.
    const r = t1('Marcus Halloway Revocable Trust')
    expect(r.ownerType).toBe('trust')
    expect(kinds(r)).toEqual(['TRACERFY_INSTANT_NAMED', 'TRACERFY_PARCEL_APN', 'FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toMatchObject({ first_name: 'Marcus', last_name: 'Halloway' })
    expect(r.steps[2].request).toEqual({ company_name: 'Marcus Halloway Revocable Trust', state: 'UT' })
  })

  it('D16: a trust that leaves no first name or initial goes to FastAppend only', () => {
    // MUTATION: drop the personNameFor gate and a person step runs on "Smith".
    const r = t1('Smith Family Trust')
    expect(kinds(r)).toEqual(['FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toEqual({ company_name: 'Smith Family Trust', state: 'UT' })
  })

  it('unknown, one word: FastAppend only (D16)', () => {
    const r = t1('Halloway')
    expect(r.ownerType).toBe('unknown')
    expect(kinds(r)).toEqual(['FASTAPPEND_ENTITY'])
  })

  it('unknown, five words: the person steps on the name as given, then FastAppend', () => {
    const r = t1('Alpha Bravo Charlie Delta Echo')
    expect(r.ownerType).toBe('unknown')
    expect(kinds(r)).toEqual(['TRACERFY_INSTANT_NAMED', 'TRACERFY_PARCEL_APN', 'FASTAPPEND_ENTITY'])
    expect(r.steps[0].request).toMatchObject({ first_name: 'Alpha', last_name: 'Echo' })
  })

  it('a trust with a first name and no lookup key gets no step at all (spec 4.2)', () => {
    const r = t1('Marcus Halloway Revocable Trust', {
      situsAddress: null, situsCity: null, situsState: null, parcelIdLocal: null, county: null,
    })
    expect(r.steps).toEqual([])
    expect(r.warnings.join(' ')).toMatch(/No lookup key/)
  })

  it('keeps today name order for single traces (D22): SMITH JOHN is sent as first SMITH', () => {
    expect(t1('SMITH JOHN').steps[0].request).toMatchObject({ first_name: 'SMITH', last_name: 'JOHN' })
  })

  it('never says the parcel id is cheaper or more accurate (spec 4.2)', () => {
    // No situs is the case the removed "cheaper address-keyed path" warning fired on.
    // MUTATION: put that warning back on the parcel step and this goes red.
    const noSitus = { situsAddress: null, situsCity: null, situsState: null }
    expect(JSON.stringify(t1('Marcus T Halloway', noSitus))).not.toMatch(/cheaper|more accurate/i)
    expect(JSON.stringify(t1('Marcus T Halloway'))).not.toMatch(/cheaper|more accurate/i)
  })

  it('reads an individual-looking name that leaves no first name ("SMITH JR") as unreadable: FastAppend only (D16)', () => {
    // D16 covers "a trust or unreadable name". A name with no first name left cannot be asked of a
    // person lookup, so it takes the same FastAppend-only lane. Stated and pinned, not implied.
    const r = t1('SMITH JR')
    expect(r.ownerType).toBe('individual')
    expect(kinds(r)).toEqual(['FASTAPPEND_ENTITY'])
  })
})

describe('stripTrustWords (the fixed list, spec 4.2)', () => {
  it.each([
    ['John Smith Revocable Trust', 'John Smith'],
    ['SMITH JOHN TR', 'SMITH JOHN'],
    ['JOHN SMITH TTEE', 'JOHN SMITH'],
    ['Mary Jones Irrevocable Living Trust U/A 5/1/99', 'Mary Jones'],
    ['JOHN SMITH FAMILY TRUST DTD 01/02/2003', 'JOHN SMITH'],
    ['Smith Family Trust', 'Smith'],
    ['Trustman John', 'Trustman John'],
    ['The Smith Family Trust', 'The Smith'],
    ['Estate of John Smith', 'Estate of John Smith'],
  ])('%s strips to %s', (input, out) => {
    expect(stripTrustWords(input)).toBe(out)
  })
})
