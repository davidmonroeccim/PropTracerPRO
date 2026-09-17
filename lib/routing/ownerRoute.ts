/**
 * Owner routing: decide which vendor resolves a parcel's owner contacts, and at what tier.
 *
 * Pure decision logic. No I/O, no vendor calls. Returns a plan the caller executes.
 *
 * Measured on 24 commercial parcels across OH, CA and UT (2026-09-16). Rates confirmed
 * against the Tracerfy and FastAppend account ledgers, not documentation:
 *   dossier   property-search/lookup/   10 credits  $0.20/hit   23/24 returned an owner
 *   parcel    trace/parcel/lookup/       5 credits  $0.10/hit   0/13 returned an owner (people only)
 *   instant   trace/lookup/              5 credits  $0.10/hit
 *   entity    business-trace/lookup/     1 credit   $0.10/hit   13/22 entities matched
 * Misses are free on all four.
 */

export type OwnerType = 'entity' | 'individual' | 'trust' | 'unknown'
export type BillingTier = 1 | 2

export const VENDOR_COST = {
  DOSSIER: 0.20,
  FASTAPPEND_ENTITY: 0.10,
  TRACERFY_INSTANT: 0.10,
  TRACERFY_PARCEL: 0.10,
} as const

/**
 * What the CUSTOMER pays. TWO axes, tier and plan. FOUR numbers, no more and no fewer.
 *
 *   pro      $97/mo                      tier 1 $0.15   tier 2 $0.25
 *   acqPro   AcquisitionPRO, no monthly  tier 1 $0.15   tier 2 $0.25
 *   wallet   Pay-As-You-Go               tier 1 $0.25   tier 2 $0.40
 *
 * TIER 1: the owner of record is already known. Billed per SUCCESSFUL trace, misses free.
 * TIER 2: the owner is absent, OR the caller wants the enriched dossier. Billed per RECORD
 *   SUBMITTED, so misses ARE billed. Covers a $0.20 dossier plus a $0.10 contact call and
 *   returns the 60+ field property record, which is the reason this tier is worth buying.
 *   Customer-facing label is "per record", never "per search".
 *
 * OWNER TYPE IS NOT A PRICING AXIS. An individual routes to Tracerfy and an entity routes to
 * FastAppend, and both bill the same tier 1 rate for that plan. Tier 2 does not split by owner
 * type either. The vendor split and the vendor COSTS in VENDOR_COST above are real and are
 * cost-side only; do not let them leak into this table. Anyone adding an entity rate here is
 * restoring a model David has now corrected three times.
 *
 * planRoute() selects by plan. The plan is a REQUIRED parameter — see FAILSAFE_PRICE_PLAN.
 */
export type PricePlan = 'pro' | 'acqPro' | 'wallet'

export const PRICE: Record<PricePlan, { tier1PerSuccess: number; tier2PerRecord: number }> = {
  pro: { tier1PerSuccess: 0.15, tier2PerRecord: 0.25 },
  acqPro: { tier1PerSuccess: 0.15, tier2PerRecord: 0.25 },
  wallet: { tier1PerSuccess: 0.25, tier2PerRecord: 0.40 },
} as const

/**
 * DESIGN DECISION, 2026-09-17: planRoute takes a REQUIRED plan, and the only fallback is the
 * DEAREST column. There is deliberately no default plan.
 *
 * The bug this replaces was a default of 'pro'. It cost a pay-as-you-go customer's invoice
 * $0.15 instead of $0.25 on tier 1 and $0.25 instead of $0.40 on tier 2 — a 40% shortfall
 * that produced no error, no log line and no complaint, because nobody reports being
 * undercharged. It was found by reading the code, which is the only way it could be found.
 *
 * REQUIRED beats a safer default because TypeScript then refuses to compile a caller that
 * has not thought about the plan, so the mis-wire never reaches a customer at all. The
 * signature change is the point: it forces every call site to be read once.
 *
 * FAILSAFE_PRICE_PLAN covers only what the compiler cannot: a JS caller, or a plan column
 * that came back NULL from the database and was cast. In that case we price the most
 * expensive column of every plan, so a mis-wire OVERCHARGES. An overcharge is visible on a
 * customer's statement and gets reported and refunded within a billing cycle; an undercharge
 * is invisible to both sides and compounds silently. Never point this at the cheap column.
 */
export const FAILSAFE_PRICE_PLAN: PricePlan = 'wallet'

const priceFor = (plan: PricePlan) => PRICE[plan] ?? PRICE[FAILSAFE_PRICE_PLAN]

export interface ParcelInput {
  /**
   * OPTIONAL. Nothing in PTP produces a parcel id today: every entry point is address
   * shaped. Address mode is proven — Salt Lake 16183060290000 missed on APN and hit on
   * address, returning the owner the county recorder confirms — so requiring an APN here
   * would have locked the whole app out of tier 2.
   */
  parcelIdLocal?: string | null
  /** Bare county name, and OPTIONAL for the same reason. Tracerfy wants "Stark", never "Stark County". */
  county?: string | null
  /** 2-letter property state. */
  state: string
  situsAddress?: string | null
  situsCity?: string | null
  situsState?: string | null
  situsZip?: string | null
  /** Curated owner of record. Null/absent puts the parcel in tier 2. */
  ownerName?: string | null
  /** State of registration, if already resolved. FastAppend keys on this, NOT the property state. */
  registrationState?: string | null
}

export type StepKind =
  | 'DOSSIER_APN'
  | 'DOSSIER_ADDRESS'
  | 'FASTAPPEND_ENTITY'
  | 'TRACERFY_INSTANT_NAMED'
  | 'TRACERFY_PARCEL_APN'

export interface RouteStep {
  kind: StepKind
  endpoint: string
  request: Record<string, unknown>
  costOnHit: number
  /** Free on a miss. True for every vendor on this path. */
  freeOnMiss: true
  why: string
}

export interface RoutePlan {
  tier: BillingTier
  billing: { model: 'per_record' | 'per_successful_trace'; amount: number }
  /**
   * The plan and the parcel this route was planned from, echoed back.
   *
   * The tier 2 two-pass RE-ENTERS planRoute with the discovered owner name (see the warning
   * emitted below). It can only do that for the same parcel and at the same rate if the plan
   * carries both, and an executor that has to be handed them separately can be handed the
   * wrong ones.
   */
  pricePlan: PricePlan
  parcel: ParcelInput
  ownerName: string | null
  ownerType: OwnerType
  /** True when the owner must be purchased before routing can be decided. */
  needsOwnerDiscovery: boolean
  steps: RouteStep[]
  maxVendorCost: number
  warnings: string[]
}

/* ------------------------------------------------------------------ *
 * Owner classification
 *
 * Classify from the NAME STRING, never from the vendor's corporate_owned
 * flag. That flag returned false for STORAGE TRUST PROPERTIES, L.P., a
 * Delaware limited partnership. The string test got it right.
 * ------------------------------------------------------------------ */

/**
 * Tokens that may appear anywhere in the name.
 * Note the space-tolerant LLC/LLP/PLLC forms: county rolls and the dossier both emit
 * "Bhf L L C", which a dots-only pattern misses and the person heuristic then
 * misclassifies as a four-token individual.
 */
const ENTITY_ANYWHERE =
  /\b(L\s*\.?\s*L\s*\.?\s*C|L\s*\.?\s*L\s*\.?\s*P|P\s*\.?\s*L\s*\.?\s*L\s*\.?\s*C|INC(ORPORATED)?|CORP(ORATION)?|LTD|LIMITED|L\s*\.?\s*P|PARTNERSHIP|ASSOCIATES?|ASSOCIATION|HOLDINGS?|PROPERT(Y|IES)|INVESTMENTS?|INVESTORS?|ENTERPRISES?|VENTURES?|REALTY|REAL ESTATE|MANAGEMENT|MGMT|DEVELOPMENT|RENTALS?|APARTMENTS?|ESTATES|STORAGE|GROUP|BANK|CHURCH|MINISTRIES|FOUNDATION|AUTHORITY|DISTRICT|CITY OF|COUNTY OF|STATE OF|BOARD OF|UNIVERSITY|COLLEGE|HOSPITAL)\b/i

/** Ambiguous tokens that only count as entity markers at the END of the name. */
const ENTITY_TRAILING = /\b(CO|PA|PC|TR|TTEE|TRS|ET AL CO)\.?$/i

const TRUST_MARKER = /\b(TRUST|TTEE|TRUSTEE|TRS|LIVING TRUST|FAMILY TRUST|ESTATE OF)\b/i

/** Forms that indicate a natural person, including joint ownership. */
const INDIVIDUAL_MARKER = /\b(ET AL|ET UX|ET VIR|JR|SR|III|IV|MRS?|DR)\b|&| AND /i

/**
 * Split multi-owner strings. The dossier returns owners[] which we join with " | ",
 * e.g. "Marcus T Halloway | Halloway Living Trust".
 */
const splitOwners = (name: string): string[] =>
  name.split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean)

export function classifyOwnerName(raw?: string | null): OwnerType {
  if (!raw || !raw.trim()) return 'unknown'
  const parts = splitOwners(raw)

  // A person named alongside a trust is still a routable individual: the trustee is
  // a natural person and Tracerfy can find them. Trust-only has no SoS registration
  // and no person, so it needs its own lane.
  const anyEntity = parts.some(p => ENTITY_ANYWHERE.test(p) || ENTITY_TRAILING.test(p))
  const anyTrust = parts.some(p => TRUST_MARKER.test(p))
  const anyPerson = parts.some(p => looksLikePerson(p))

  if (anyPerson && (anyTrust || !anyEntity)) return 'individual'
  if (anyEntity) return 'entity'
  if (anyTrust) return 'trust'
  return looksLikePerson(raw) ? 'individual' : 'unknown'
}

function looksLikePerson(s: string): boolean {
  if (ENTITY_ANYWHERE.test(s) || ENTITY_TRAILING.test(s)) return false
  if (TRUST_MARKER.test(s)) return false
  if (INDIVIDUAL_MARKER.test(s)) return true
  const tokens = s.trim().split(/\s+/).filter(Boolean)
  // "Marcus T Halloway", "Gerald Pentland", "Vance Elliot A" — two to four tokens, no entity words.
  return tokens.length >= 2 && tokens.length <= 4
}

/* ------------------------------------------------------------------ *
 * Loan basis and portfolio-debt detection
 *
 * open_mortgage_balance routinely carries BLANKET debt secured by many
 * parcels: $175,000,000 against a 41,588 sqft building, $48,000,000
 * against 46,909 sqft. Those must not be presented as parcel-level debt.
 *
 * The only trustworthy value basis is last_sale_price, present on 52% of
 * records and, in our sample, Ohio only. estimated_value is NOT a value:
 * it equalled assessed_value on 23 of 23 parcels in all three states, and
 * assessed/sale ran from 0.07 to 0.59 within Ohio alone, so assessed
 * cannot be scaled to market by any constant.
 * ------------------------------------------------------------------ */

export type LoanVerdict = 'parcel_level' | 'suspect' | 'portfolio' | 'unknown'

export interface LoanInput {
  openMortgageBalance?: number | null
  lastSalePrice?: number | null
  lastSaleDate?: string | null
  buildingSizeSqft?: number | null
  /** Accepted but never used as a value basis. See note above. */
  assessedValue?: number | null
}

export interface LoanAssessment {
  verdict: LoanVerdict
  basis: 'sale' | 'stale_sale' | 'sqft' | 'none'
  ratio: number | null
  dollarsPerSqft: number | null
  usableAsParcelDebt: boolean
  /** True when building_size_sqft contradicts the sale price badly enough to distrust it. */
  buildingAreaSuspect: boolean
  reason: string
}

/** Beyond this a sale price is a weaker basis, so the thresholds widen. It is not discarded. */
const SALE_BASIS_MAX_AGE_YEARS = 10
/** Loan-to-sale at or below this reads as ordinary parcel-level debt. */
const RATIO_PARCEL_LEVEL = 1.25
/** Above this, the loan is almost certainly secured by more than this parcel. */
const RATIO_PORTFOLIO = 2.5
/** Same bands, widened, when the only sale on record is old and the asset has likely appreciated. */
const RATIO_PARCEL_LEVEL_STALE = 2.0
const RATIO_PORTFOLIO_STALE = 4.0
/** Fallback when there is no sale price at all: absurd debt per building sqft. */
const PSF_PORTFOLIO = 1000
const PSF_SUSPECT = 600
/** A loan this far above sale price per sqft means the sqft is wrong, not the loan. */
const PSF_IMPLAUSIBLE = 1000

export function assessLoan(input: LoanInput): LoanAssessment {
  const mortgage = num(input.openMortgageBalance)
  if (!mortgage) {
    return { verdict: 'unknown', basis: 'none', ratio: null, dollarsPerSqft: null,
      usableAsParcelDebt: false, buildingAreaSuspect: false,
      reason: 'no open mortgage balance reported' }
  }

  const sale = num(input.lastSalePrice)
  if (sale) {
    const fresh = saleIsFresh(input.lastSaleDate)
    const ratio = mortgage / sale
    const parcelMax = fresh ? RATIO_PARCEL_LEVEL : RATIO_PARCEL_LEVEL_STALE
    const portfolioMin = fresh ? RATIO_PORTFOLIO : RATIO_PORTFOLIO_STALE
    const verdict: LoanVerdict =
      ratio <= parcelMax ? 'parcel_level'
      : ratio <= portfolioMin ? 'suspect'
      : 'portfolio'
    const dollarsPerSqft = psf(mortgage, input.buildingSizeSqft)
    // When the loan looks ordinary against the sale price but absurd per square foot,
    // the square footage is the bad field. Observed: a 20-39 unit apartment complex
    // reporting 782 sqft. Flag the area, do not downgrade the loan.
    const areaSuspect =
      verdict === 'parcel_level' && dollarsPerSqft !== null && dollarsPerSqft > PSF_IMPLAUSIBLE
    return { verdict, basis: fresh ? 'sale' : 'stale_sale', ratio, dollarsPerSqft,
      usableAsParcelDebt: verdict === 'parcel_level',
      buildingAreaSuspect: areaSuspect,
      reason: `mortgage is ${ratio.toFixed(2)}x the ${input.lastSaleDate ?? 'recorded'} sale price` +
        (fresh ? '' : ' (sale is stale, thresholds widened)') }
  }

  // No usable sale price. Assessed value cannot substitute, so fall back to a
  // magnitude test that only catches the extremes.
  const dollarsPerSqft = psf(mortgage, input.buildingSizeSqft)
  if (dollarsPerSqft === null) {
    return { verdict: 'unknown', basis: 'none', ratio: null, dollarsPerSqft: null,
      usableAsParcelDebt: false, buildingAreaSuspect: false,
      reason: 'no sale price and no building area; cannot judge' }
  }
  const verdict: LoanVerdict =
    dollarsPerSqft > PSF_PORTFOLIO ? 'portfolio'
    : dollarsPerSqft > PSF_SUSPECT ? 'suspect'
    : 'unknown' // plausible, but unproven without a value basis
  return { verdict, basis: 'sqft', ratio: null, dollarsPerSqft,
    usableAsParcelDebt: false, buildingAreaSuspect: false,
    reason: `no sale price; $${Math.round(dollarsPerSqft)}/sqft of building area` }
}

const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0)
const psf = (loan: number, sqft?: number | null): number | null => {
  const s = num(sqft)
  return s ? loan / s : null
}
function saleIsFresh(date?: string | null): boolean {
  if (!date) return true // price present, date missing: accept rather than discard
  const t = Date.parse(date)
  if (isNaN(t)) return true
  return (Date.now() - t) / 31_557_600_000 <= SALE_BASIS_MAX_AGE_YEARS
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

const hasSitus = (p: ParcelInput): boolean =>
  Boolean(p.situsAddress?.trim() && p.situsCity?.trim() && p.situsState?.trim())

/** Both halves or neither: the APN-keyed endpoints reject an apn without its county. */
const hasApn = (p: ParcelInput): boolean =>
  Boolean(p.parcelIdLocal?.trim() && p.county?.trim())

export function planRoute(parcel: ParcelInput, pricePlan: PricePlan): RoutePlan {
  const warnings: string[] = []
  const ownerKnown = Boolean(parcel.ownerName?.trim())
  const tier: BillingTier = ownerKnown ? 1 : 2
  const steps: RouteStep[] = []

  if (!ownerKnown) {
    // Tier 2. The owner must be bought before the vendor can be chosen.
    //
    // The dossier has two mutually exclusive keys and they FAIL INDEPENDENTLY.
    // Measured: Salt Lake 16183060290000 missed on APN and hit on address, returning
    // the owner the county recorder confirms. Napa 003330004000 did the reverse.
    // Misses are free, so attempting the second key costs nothing unless it succeeds.
    // Emit both when both keys exist; the caller stops at the first hit.
    const apnStep: RouteStep = {
      kind: 'DOSSIER_APN',
      endpoint: 'POST https://tracerfy.com/v1/api/property-search/lookup/',
      request: { apn: parcel.parcelIdLocal, county: parcel.county, state: parcel.state },
      costOnHit: VENDOR_COST.DOSSIER,
      freeOnMiss: true,
      why: 'owner absent from the registry; APN-keyed so no situs required',
    }
    const addressStep: RouteStep = {
      kind: 'DOSSIER_ADDRESS',
      endpoint: 'POST https://tracerfy.com/v1/api/property-search/lookup/',
      request: {
        address: parcel.situsAddress, city: parcel.situsCity, state: parcel.situsState,
        ...(parcel.situsZip ? { zip_code: parcel.situsZip } : {}),
      },
      costOnHit: VENDOR_COST.DOSSIER,
      freeOnMiss: true,
      why: 'address-keyed dossier; independent coverage from the APN key, and it backfills zip',
    }

    if (hasApn(parcel)) steps.push(apnStep)
    if (hasSitus(parcel)) steps.push(addressStep)

    if (!steps.length) {
      warnings.push('No parcel id with county, and no complete situs. Neither dossier key is available.')
    } else {
      warnings.push('Stop at the first hit. Both steps bill only on success, so the fallback is free unless it works.')
      warnings.push('Re-enter planRoute with the discovered owner name to select the contact vendor.')
      warnings.push('The $0.20 dossier charge is sunk on a hit even if the contact step later misses.')
      if (!parcel.situsZip?.trim() && hasSitus(parcel)) {
        warnings.push('No zip sent. Address mode returned the correct owner without one in testing, but a common street name in a large city can mismatch.')
      }
    }

    return {
      tier, billing: { model: 'per_record', amount: priceFor(pricePlan).tier2PerRecord },
      pricePlan, parcel,
      ownerName: null, ownerType: 'unknown', needsOwnerDiscovery: true, steps,
      // Only one dossier key can hit, so the realistic ceiling is one dossier plus one contact call.
      maxVendorCost: VENDOR_COST.DOSSIER + VENDOR_COST.FASTAPPEND_ENTITY,
      warnings,
    }
  }

  const ownerName = parcel.ownerName!.trim()
  const ownerType = classifyOwnerName(ownerName)

  if (ownerType === 'entity') {
    const state = parcel.registrationState?.trim() || parcel.state
    if (!parcel.registrationState?.trim()) {
      warnings.push(
        'Sending the property state. FastAppend keys on STATE OF REGISTRATION; an out-of-state ' +
        'entity may miss. Measured: 13/22 entities matched using the property state.',
      )
    }
    steps.push({
      kind: 'FASTAPPEND_ENTITY',
      endpoint: 'POST https://app.fastappend.com/v1/api/business-trace/lookup/',
      request: { company_name: ownerName, state },
      costOnHit: VENDOR_COST.FASTAPPEND_ENTITY,
      freeOnMiss: true,
      why: 'entity owner; no address needed, keyed on name plus state',
    })
    warnings.push('Read role and is_registered_agent on the response. A registered agent is a service of process, not necessarily a principal.')
  } else if (ownerType === 'individual') {
    if (hasSitus(parcel)) {
      steps.push({
        kind: 'TRACERFY_INSTANT_NAMED',
        endpoint: 'POST https://tracerfy.com/v1/api/trace/lookup/',
        request: {
          address: parcel.situsAddress, city: parcel.situsCity, state: parcel.situsState,
          ...(parcel.situsZip ? { zip: parcel.situsZip } : {}),
          find_owner: false, ...splitPersonName(ownerName),
        },
        costOnHit: VENDOR_COST.TRACERFY_INSTANT,
        freeOnMiss: true,
        why: 'individual owner with situs; named lookup, not find_owner',
      })
      warnings.push(
        'Do NOT filter on property_owner. It returned false for the verified owner of record ' +
        'on an absentee-owned parcel. Match on the name instead.',
      )
      if (!parcel.situsZip?.trim()) {
        warnings.push('No zip. Tracerfy calls it strongly recommended; without it a similar address in the same city can match.')
      }
    } else if (hasApn(parcel)) {
      steps.push({
        kind: 'TRACERFY_PARCEL_APN',
        endpoint: 'POST https://tracerfy.com/v1/api/trace/parcel/lookup/',
        request: { parcel_id: parcel.parcelIdLocal, county: parcel.county, state: parcel.state },
        costOnHit: VENDOR_COST.TRACERFY_PARCEL,
        freeOnMiss: true,
        why: 'individual owner, situs incomplete; APN-keyed fallback',
      })
      warnings.push('Situs incomplete, so the cheaper address-keyed path is unavailable.')
    } else {
      // Exposed by making the APN optional: this branch used to build a request with
      // parcel_id and county undefined, which cannot match a parcel and should never be sent.
      warnings.push(
        'Individual owner, but neither a complete situs nor a parcel id with county. ' +
        'No lookup key exists for this owner. Route to manual review.',
      )
    }
  } else if (ownerType === 'trust') {
    warnings.push(
      'Trust-only owner. No Secretary of State registration to match and no natural person named, ' +
      'so neither vendor lane applies. Route to manual review.',
    )
  } else {
    warnings.push(`Owner name "${ownerName}" did not classify. Route to manual review rather than guessing a vendor.`)
  }

  return {
    tier,
    billing: { model: 'per_successful_trace', amount: priceFor(pricePlan).tier1PerSuccess },
    pricePlan, parcel,
    ownerName, ownerType, needsOwnerDiscovery: false, steps,
    maxVendorCost: steps.reduce((a, s) => a + s.costOnHit, 0),
    warnings,
  }
}

/**
 * Extract one natural person's first and last name from a county or dossier owner string.
 *
 * Handles three shapes seen in live data:
 *   "Marcus T Halloway | Halloway Living Trust"  multi-owner, only the person is wanted
 *   "Jingwen & Shaolan Wu"                     joint owners sharing one surname
 *   "Halloway Marcus T"                         assessor ordering, LAST FIRST MIDDLE
 *
 * Naive whitespace splitting produces last_name "Trust" for the first and
 * "& Shaolan Wu" for the second. Both have shipped in this codebase before.
 */
export function splitPersonName(name: string): { first_name: string; last_name: string } {
  // 1. Of the pipe-separated owners, keep the first that reads as a person.
  const person = splitOwners(name).find(looksLikePerson) ?? splitOwners(name)[0] ?? name

  // 2. Drop generational and legal suffixes; they are never the surname.
  const cleaned = person.replace(/\b(ET AL|ET UX|ET VIR|JR|SR|II|III|IV|MRS?|DR)\b\.?/gi, ' ')
  const tokens = cleaned.split(/\s+/).filter(t => t && t !== '&')
  if (!tokens.length) return { first_name: '', last_name: '' }
  if (tokens.length === 1) return { first_name: tokens[0], last_name: '' }

  // 3. A trailing single-letter token is a middle initial, which means the string is
  //    in assessor order (LAST FIRST MI) rather than natural order.
  const trailingInitial = /^[A-Za-z]\.?$/.test(tokens[tokens.length - 1])
  if (trailingInitial && tokens.length >= 3) {
    return { first_name: tokens[1], last_name: tokens[0] }
  }

  // 4. Natural order. With joint owners the shared surname is the final token, and the
  //    first given name precedes the ampersand, so take the ends rather than a split.
  return { first_name: tokens[0], last_name: tokens[tokens.length - 1] }
}
