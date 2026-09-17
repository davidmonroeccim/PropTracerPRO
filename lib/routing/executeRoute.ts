/**
 * Route executor: take a RoutePlan and actually run it.
 *
 * planRoute() decides. This module spends. It is pure of I/O except through the vendor
 * callables in RouteDeps, so the whole of Full Property Trace's spend logic is testable
 * without a network and without a cent of real credit.
 *
 * Four rules, each of which has a measured reason behind it:
 *
 * 1. STOP AT THE FIRST HIT. planRoute emits DOSSIER_APN then DOSSIER_ADDRESS when both keys
 *    exist, because they fail independently — Salt Lake missed on APN and hit on address,
 *    Napa did the reverse. Running the second after the first hits is a wasted $0.20 on
 *    every record that works.
 *
 * 2. TWO PASSES. Tier 2 buys the owner, then RE-ENTERS planRoute with that name to pick the
 *    contact vendor. The name is classified with classifyOwnerName(), never with the vendor's
 *    own corporate_owned flag, which returned FALSE for a Delaware limited partnership.
 *
 * 3. A FAILURE IS NOT A MISS. A miss is "we asked and the county has no record": free, final,
 *    and a complete answer — and under the per-record model the caller still bills for it
 *    (decided 2026-09-17). A failure is "we could not ask": free, NOT final, and nothing about
 *    that record may be billed. Collapsing the two bills customers for our outages, which is
 *    why `success` is the flag the caller gates the charge on, never `ownerFound`.
 *
 * 4. THE RAW RECORD IS THE PRODUCT. property is handed through by reference, all 86 keys,
 *    unfiltered and unrenamed. See the fidelity rule in lib/tracerfy/dossier.ts.
 *
 * House pattern, same as lib/tracerfy/: NEVER THROWS. Every path returns a result object,
 * including a vendor that throws at us.
 *
 * Deliberately NOT here: billing, persistence, retries. The caller owns all three, and it
 * owns them with a precise per-step spend report rather than a guess.
 */
import {
  classifyOwnerName,
  planRoute,
  type BillingTier,
  type OwnerType,
  type ParcelInput,
  type RoutePlan,
  type RouteStep,
  type StepKind,
} from './ownerRoute'
import type {
  DossierKey,
  DossierMailingAddress,
  DossierProperty,
  DossierResult,
} from '@/lib/tracerfy/dossier'

/* ------------------------------------------------------------------ *
 * Injected vendors
 *
 * The dossier is the real lookupDossier signature from lib/tracerfy/dossier.ts. The two
 * contact vendors are narrow interfaces declared here and injected, so this module does not
 * reach into lib/tracerfy/client.ts (whose contact path is batch/CSV/poll shaped) and does
 * not have to change when that path is replaced.
 * ------------------------------------------------------------------ */

/** What a contact vendor returns once its own transport has been dealt with. */
export interface OwnerContacts {
  /** The natural person behind the owner. For an entity this is the principal, NOT the owner of record. */
  ownerName: string | null
  phones: Array<{ number: string; type: string }>
  emails: string[]
  mailingAddress: string | null
}

export interface ContactResult {
  /** False ONLY when we could not ask. A no-match is success:true, hit:false. */
  success: boolean
  /** True when the vendor matched. A hit costs the step's costOnHit; a miss is free. */
  hit: boolean
  contacts: OwnerContacts | null
  error?: string
}

/** FastAppend business-trace. Keyed on name plus STATE OF REGISTRATION, no address. */
export interface EntityTraceRequest {
  company_name: string
  state: string
}

/** Tracerfy person lookup, either the address-keyed named form or the APN-keyed fallback. */
export interface PersonTraceRequest {
  first_name: string
  last_name: string
  address?: string
  city?: string
  state?: string
  zip?: string
  parcel_id?: string
  county?: string
  /** Always false on this path: the named lookup hit where find_owner missed. */
  find_owner?: boolean
}

export interface RouteDeps {
  lookupDossier: (key: DossierKey) => Promise<DossierResult>
  traceEntity: (req: EntityTraceRequest) => Promise<ContactResult>
  tracePerson: (req: PersonTraceRequest) => Promise<ContactResult>
}

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

export type StepOutcome =
  /** The vendor matched and charged. */
  | 'hit'
  /** The vendor answered, with no record. Free and final. */
  | 'miss'
  /** We could not ask. Free, not final, and not billable. */
  | 'failed'
  /** Never attempted: an earlier step hit, or an earlier step failed. */
  | 'skipped'

export interface StepReport {
  kind: StepKind
  outcome: StepOutcome
  /** Dollars actually spent on this step. Zero on a miss, a failure and a skip. */
  cost: number
  /** Only the dossier reports credits. Read rather than inferred from `hit`. */
  creditsDeducted?: number
  error?: string
  /** Why a step was skipped. */
  note?: string
}

export interface ExecutionResult {
  /** False when any step FAILED. Partial results below are still populated and still real. */
  success: boolean
  ownerFound: boolean
  /**
   * The SITUS zip the dossier taught us, set ONLY when the caller had none.
   * Null when the caller supplied one (theirs wins) or the dossier had none.
   * The caller may persist it; it is the property's own zip, not the owner's.
   */
  learnedZip: string | null
  /** Owner of record. Multiple owners are joined with " | ", the shape classifyOwnerName parses. */
  ownerName: string | null
  ownerType: OwnerType
  /** RAW. All 86 keys, by reference, exactly as the vendor sent them. Null unless a dossier hit. */
  property: DossierProperty | null
  mailingAddress: DossierMailingAddress | null
  contactsFound: boolean
  contacts: OwnerContacts | null
  tier: BillingTier
  /** Total dollars spent at vendors, to the cent. The caller bills its own price, not this. */
  vendorSpend: number
  steps: StepReport[]
  /** True when no vendor lane applies and a human has to take it: a trust, or no usable key. */
  needsManualReview: boolean
  warnings: string[]
  /** Set only on a FAILURE. Never set for a miss. */
  error?: string
}

/**
 * The dossier bills in credits. Ten of them are the $0.20 in VENDOR_COST.DOSSIER, so the
 * step's own costOnHit and the vendor's own credits_deducted between them give the real
 * charge without this module asserting a price of its own.
 */
const DOSSIER_CREDITS_PER_HIT = 10

/** Money, to the cent. 0.20 + 0.10 is 0.30000000000000004 in binary floating point. */
const round2 = (n: number): number => Math.round(n * 100) / 100

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Copy through only the keys the step actually carries, as strings. */
const copyStrings = (src: Record<string, unknown>, keys: string[]): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const k of keys) {
    const v = src[k]
    if (typeof v === 'string' && v.trim()) out[k] = v
  }
  return out
}

/** Rebuild the dossier's typed, mutually-exclusive key from the step that planned it. */
function dossierKeyFor(step: RouteStep): DossierKey | null {
  const r = step.request
  if (step.kind === 'DOSSIER_APN') {
    return { mode: 'apn', apn: str(r.apn), county: str(r.county), state: str(r.state) }
  }
  if (step.kind === 'DOSSIER_ADDRESS') {
    const zip = str(r.zip_code).trim()
    return {
      mode: 'address',
      address: str(r.address),
      city: str(r.city),
      state: str(r.state),
      ...(zip ? { zip_code: zip } : {}),
    }
  }
  return null
}

const entityRequest = (step: RouteStep): EntityTraceRequest => ({
  company_name: str(step.request.company_name),
  state: str(step.request.state),
})

const personRequest = (step: RouteStep): PersonTraceRequest => ({
  first_name: str(step.request.first_name),
  last_name: str(step.request.last_name),
  ...copyStrings(step.request, ['address', 'city', 'state', 'zip', 'parcel_id', 'county']),
  find_owner: step.request.find_owner === true,
})

/** One vendor call, normalised. cost is what was really spent, which is 0 unless it hit. */
interface VendorCall {
  success: boolean
  hit: boolean
  cost: number
  creditsDeducted?: number
  dossier?: DossierResult
  contacts?: OwnerContacts | null
  error?: string
}

async function callVendor(step: RouteStep, deps: RouteDeps): Promise<VendorCall> {
  try {
    switch (step.kind) {
      case 'DOSSIER_APN':
      case 'DOSSIER_ADDRESS': {
        const key = dossierKeyFor(step)
        if (!key) return { success: false, hit: false, cost: 0, error: `Cannot key ${step.kind}` }

        const res = await deps.lookupDossier(key)
        if (!res.success) {
          return { success: false, hit: false, cost: 0, error: res.error ?? `${step.kind} failed` }
        }
        // Charge what the vendor says it deducted, not what we assume a hit costs.
        const cost = res.hit
          ? round2((res.creditsDeducted / DOSSIER_CREDITS_PER_HIT) * step.costOnHit)
          : 0
        return {
          success: true,
          hit: res.hit,
          cost,
          creditsDeducted: res.creditsDeducted,
          dossier: res,
        }
      }

      case 'FASTAPPEND_ENTITY': {
        const res = await deps.traceEntity(entityRequest(step))
        if (!res.success) {
          return { success: false, hit: false, cost: 0, error: res.error ?? 'Entity trace failed' }
        }
        return { success: true, hit: res.hit, cost: res.hit ? step.costOnHit : 0, contacts: res.contacts }
      }

      case 'TRACERFY_INSTANT_NAMED':
      case 'TRACERFY_PARCEL_APN': {
        const res = await deps.tracePerson(personRequest(step))
        if (!res.success) {
          return { success: false, hit: false, cost: 0, error: res.error ?? 'Person trace failed' }
        }
        return { success: true, hit: res.hit, cost: res.hit ? step.costOnHit : 0, contacts: res.contacts }
      }
    }
  } catch (error) {
    // A vendor that throws could not be asked. That is a failure, never a miss.
    return {
      success: false,
      hit: false,
      cost: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

interface StageResult {
  reports: StepReport[]
  spend: number
  /** The call that hit, if one did. */
  hit: VendorCall | null
  failure: string | null
}

/**
 * Run one stage's steps in order, stopping at the first hit.
 *
 * A failure also stops the stage. We cannot tell a transient outage from a key-specific
 * rejection here, and continuing through an incident both compounds load on a rate limit
 * that is SHARED across Tracerfy's endpoints and produces a half-run record the caller
 * cannot safely bill. Nothing was charged, so the caller retries for free.
 */
async function runStage(steps: RouteStep[], deps: RouteDeps): Promise<StageResult> {
  const reports: StepReport[] = []
  let spend = 0
  let hit: VendorCall | null = null
  let failure: string | null = null

  for (const step of steps) {
    if (hit || failure) {
      reports.push({
        kind: step.kind,
        outcome: 'skipped',
        cost: 0,
        note: hit ? 'an earlier step hit; this one would have been a wasted charge'
                  : 'an earlier step failed; not attempted',
      })
      continue
    }

    const call = await callVendor(step, deps)

    if (!call.success) {
      failure = call.error ?? `${step.kind} failed`
      reports.push({ kind: step.kind, outcome: 'failed', cost: 0, error: failure })
      continue
    }

    spend = round2(spend + call.cost)
    reports.push({
      kind: step.kind,
      outcome: call.hit ? 'hit' : 'miss',
      cost: call.cost,
      ...(call.creditsDeducted === undefined ? {} : { creditsDeducted: call.creditsDeducted }),
    })
    if (call.hit) hit = call
  }

  return { reports, spend, hit, failure }
}

/**
 * The SITUS zip, read off the dossier's property record.
 *
 * TWO ZIPS COME BACK AND THEY ARE NOT THE SAME THING. Do not "simplify" this
 * by reaching for the other one; the field names are close enough that someone
 * will try.
 *
 *   property.zip_code       the PROPERTY's own zip. Present on 16 of the 16
 *                           saved payloads that carry a property object.
 *   mailing_address.zip     the OWNER'S MAILING zip. 21 of the 24 parcels in
 *                           the study are absentee-owned, so this is routinely
 *                           a different city and frequently a different state.
 *
 * The contact step is keyed on the PROPERTY address. Feeding it the owner's
 * mailing zip would contradict the street, city and state it is sent with, and
 * it would do so invisibly: the call still succeeds, it just matches less
 * often. That is worse than sending no zip at all, which is the state this
 * function exists to improve on.
 *
 * ZIP+4 is trimmed to the 5 the vendor's own examples use.
 */
export function situsZipFrom(property: DossierProperty | null | undefined): string | null {
  const raw = property?.zip_code
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const match = String(raw).trim().match(/^\d{5}/)
  return match ? match[0] : null
}

/**
 * Join the dossier's owners into the one string classifyOwnerName() and splitPersonName()
 * both parse. An entity arrives with its whole name in last_name and first_name empty, so
 * this must not assume two parts.
 */
function ownerNameFrom(dossier: DossierResult): string {
  return dossier.owners
    .map(o => [o.first_name, o.last_name].map(s => s.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' | ')
}

export async function executeRoute(plan: RoutePlan, deps: RouteDeps): Promise<ExecutionResult> {
  const warnings = [...plan.warnings]
  const result: ExecutionResult = {
    success: true,
    ownerFound: Boolean(plan.ownerName),
    learnedZip: null,
    ownerName: plan.ownerName,
    ownerType: plan.ownerType,
    property: null,
    mailingAddress: null,
    contactsFound: false,
    contacts: null,
    tier: plan.tier,
    vendorSpend: 0,
    steps: [],
    needsManualReview: false,
    warnings,
    // no error: nothing has failed yet
  }

  // ---- Pass 1. Tier 2 discovers the owner here; tier 1 runs its contact step here. ----
  const pass1 = await runStage(plan.steps, deps)
  result.steps = pass1.reports
  result.vendorSpend = pass1.spend

  if (pass1.failure) {
    result.success = false
    result.error = pass1.failure
    return result
  }

  if (!plan.needsOwnerDiscovery) {
    // Tier 1: the owner was already known, so pass 1 WAS the contact call.
    if (pass1.hit?.contacts) {
      result.contacts = pass1.hit.contacts
      result.contactsFound = true
    }
    // No steps at all means planRoute found no vendor lane for this owner (a trust, or an
    // unclassifiable name). It said so in its warnings; surface it as a flag too.
    result.needsManualReview = plan.steps.length === 0
    return result
  }

  // ---- Tier 2. What the $0.20 bought. ----
  if (pass1.hit?.dossier) {
    // RAW, by reference. Not copied, not subsetted, not renamed.
    result.property = pass1.hit.dossier.property
    result.mailingAddress = pass1.hit.dossier.mailingAddress

    const discovered = ownerNameFrom(pass1.hit.dossier)
    if (!discovered) {
      // We paid for a property record that names no owner. Real, and not routable.
      result.needsManualReview = true
      warnings.push('The dossier hit but returned no owner name, so no contact vendor can be chosen.')
      return result
    }

    result.ownerName = discovered
    result.ownerFound = true
    // From the NAME. Never from property.corporate_owned, which lies.
    result.ownerType = classifyOwnerName(discovered)
  } else {
    // Every key missed. Asked and answered: there is no record to route.
    result.needsManualReview = plan.steps.length === 0
    return result
  }

  // ---- Pass 2. Re-enter planRoute with the discovered owner to pick the contact vendor. ----
  //
  // ZIP BACKFILL. The $0.20 we just spent bought the property's own zip, and
  // the contact step is the one that decides whether the customer gets a phone
  // number at all: Tracerfy calls the zip strongly recommended for the named
  // lookup, and without one a similar address in the same city can match
  // instead. It matters most exactly where it is hardest to supply -- no Utah
  // county in the study publishes a zip.
  //
  // THE CALLER'S OWN ZIP WINS. They may know something the county file does
  // not, and silently overwriting submitted data with vendor data is how a
  // "helpful" backfill becomes a bug report nobody can reproduce.
  const callerZip = plan.parcel.situsZip?.trim() || ''
  const learnedZip = callerZip ? null : situsZipFrom(result.property)
  result.learnedZip = learnedZip

  const contactParcel: ParcelInput = {
    ...plan.parcel,
    ownerName: result.ownerName,
    situsZip: callerZip || learnedZip,
  }
  const contactPlan = planRoute(contactParcel, plan.pricePlan)
  for (const w of contactPlan.warnings) if (!warnings.includes(w)) warnings.push(w)

  if (contactPlan.steps.length === 0) {
    // A trust with no natural person, or a name that would not classify. planRoute refuses to
    // guess a vendor and so does this. The property record is still bought, still delivered.
    result.needsManualReview = true
    return result
  }

  const pass2 = await runStage(contactPlan.steps, deps)
  result.steps = [...result.steps, ...pass2.reports]
  result.vendorSpend = round2(result.vendorSpend + pass2.spend)

  if (pass2.failure) {
    // The dossier spend above stands and the record is good. Only the contact call is unknown.
    result.success = false
    result.error = pass2.failure
    return result
  }

  if (pass2.hit?.contacts) {
    result.contacts = pass2.hit.contacts
    result.contactsFound = true
  }

  return result
}
