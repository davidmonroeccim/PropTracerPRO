/**
 * Route executor: take a RoutePlan and actually run it.
 *
 * planRoute() decides. This module spends. It is pure of I/O except through the vendor
 * callables in RouteDeps, so the whole of Full Property Trace's spend logic is testable
 * without a network and without a cent of real credit.
 *
 * Four rules, each of which has a measured reason behind it:
 *
 * 1. STOP AT THE FIRST HIT. A dossier hit ends its stage; a contact step ends it only with a
 *    name-matched phone or email (D6, spec 4.3), so a non-matched or contactless answer lets
 *    the next step run. planRoute emits DOSSIER_APN then DOSSIER_ADDRESS when both keys
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
  hasSitus,
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
import { VENDOR_TIMEOUT } from '@/lib/constants'
import type { VendorCallOptions } from '@/lib/tracerfy/fetchWithTimeout'

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
  /**
   * D6: the vendor returned people and none matched the owner's name. The vendor billed the hit,
   * nothing is returned, and the route moves on to its next step. Tracerfy person lookups only.
   */
  nameNotMatched?: boolean
  /** How many people the vendor returned on that billed non-match. Never their names (spec D29). */
  peopleCount?: number
  /** `credits_deducted` exactly as the vendor reported it, when it did. */
  creditsDeducted?: number
  /**
   * The client refused OUR request before spending: no name, no city, no state. Never a vendor
   * failure, so never busy_try_again (spec 5.1). `success` is false alongside it.
   */
  inputError?: boolean
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
  lookupDossier: (key: DossierKey, opts?: VendorCallOptions) => Promise<DossierResult>
  traceEntity: (req: EntityTraceRequest, opts?: VendorCallOptions) => Promise<ContactResult>
  tracePerson: (req: PersonTraceRequest, opts?: VendorCallOptions) => Promise<ContactResult>
}

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

export type StepOutcome =
  /** The vendor matched and charged. */
  | 'hit'
  /** The vendor answered, with no record. Free and final. */
  | 'miss'
  /** D6: the vendor returned people and charged, and none was the owner. Nothing is delivered. */
  | 'name_not_matched'
  /** We could not ask. Free, not final, and not billable. */
  | 'failed'
  /** Never put to a vendor: an earlier step hit or failed, or our own request was refused. */
  | 'skipped'

export interface StepReport {
  kind: StepKind
  outcome: StepOutcome
  /** Dollars actually spent on this step. Zero on a miss, a failure and a skip. */
  cost: number
  /** Credits the vendor said it deducted, read from its own answer. */
  creditsDeducted?: number
  error?: string
  /** Why a step was skipped. */
  note?: string
  /** When the vendor answered, or the call failed. Absent on a skip. */
  at?: string
  /** requestKeyFor(step): the exact question this answer belongs to. */
  requestKey?: string
  /** How many people a billed non-match returned (D6). Never their names (spec D29). Internal: the step log only. */
  peopleCount?: number
  /** A contact hit that carried no phone and no email. */
  noContacts?: boolean
  /** Copied from a busy_try_again row's step log instead of asked again (spec 5.2). */
  reused?: boolean
}

/** What a caller may tell executeRoute beyond the plan. */
export interface ExecuteOptions {
  /** Epoch ms after which no vendor call may start. The single routes pass one; the crons do not. */
  deadlineMs?: number
  /** A busy_try_again row's step log. Answered entries younger than 24 hours are reused. */
  priorSteps?: StepReport[] | null
  /** The clock, injectable for tests. */
  now?: () => number
  /**
   * Called with each step report AS IT IS PRODUCED, before the next vendor call starts.
   *
   * WHAT IT IS FOR, AND WHY ONLY A QUEUE USES IT (spec 5.2). A single trace writes trace_steps
   * ONCE, after the ladder finishes: its request is bounded by SINGLE_ROUTE_BUDGET_MS and is
   * guaranteed to reach its own persist. A cron worker is not: the run can be killed between two
   * vendor calls, and the row is then re-claimed one rung up the ladder. Without the answers
   * already on the row, that second attempt asks the same questions again and BUYS THEM AGAIN.
   *
   * Awaited, so the worker's write lands before the next call is made rather than racing it.
   * A hook that throws is logged and swallowed: this module never throws (see the header), and a
   * failed bookkeeping write must not take the vendor work with it.
   */
  onStep?: (step: StepReport) => void | Promise<void>
  /**
   * Asked immediately BEFORE each vendor call this ladder is about to make. False refuses the call.
   *
   * WHAT IT IS FOR (spec 5.3). It is where the shared per-minute vendor budget is drawn, ONE CALL
   * AT A TIME, at the moment the call is about to happen. A budget reserved per RECORD is a guess at
   * that record's worst case, and lib/routing/ownerRoute.ts says of its own tier 2 figure "A FLOOR,
   * NOT A CEILING": under D21(c) and D40 a tier 2 record tries every owner the dossier names with no
   * cap, so the guess can be exceeded and the budget bounds nothing. Asked here it cannot be.
   *
   * IT IS NOT ASKED ABOUT A CALL THAT WAS NEVER GOING TO HAPPEN: not for a step skipped behind an
   * earlier hit or failure, not for an answer replayed from the step log, and not for a call the
   * request deadline already refused. Reserving for those would spend budget on calls nobody makes
   * and throttle records that could have run.
   *
   * A REFUSAL IS NOT A FAILURE (spec 5.1). Nothing was asked of a vendor, so `success` stays true
   * and `error` stays unset; the step is recorded `skipped` with a note, THE LADDER STOPS, and
   * `throttled` is set on the result so the caller can put its row back on the rung it came from
   * with no attempt spent and nothing said to the customer.
   *
   * Awaited, because the budget lives in the database.
   */
  canSpend?: (step: RouteStep) => boolean | Promise<boolean>
}

/** A logged answer older than this is never reused; the record runs fresh instead (spec 5.2). */
export const STEP_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The question a step asked, as a string: its kind plus its request, which already carries the
 * owner's name and every key sent. A resend reuses a logged answer only for the IDENTICAL question,
 * so a different owner, address or parcel id always asks again.
 */
export function requestKeyFor(step: RouteStep): string {
  return `${step.kind}:${JSON.stringify(step.request)}`
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
  /**
   * `canSpend` refused a call this ladder was about to make (spec 5.3).
   *
   * OPTIONAL, so that the two test files which build an ExecutionResult literal
   * (lib/trace/__tests__/fullPropertyTrace.test.ts:30, lib/trace/__tests__/tier1Outcome.test.ts:24)
   * keep typechecking. Absent means false, and it can only ever be true for a caller that passed
   * `canSpend`, which is the TIER 1 cron lane and nothing else. The tier 2 cron reserves once before
   * a record's first vendor call and passes no canSpend, so a tier 2 record cannot be refused
   * part-way through a ladder whose dossier it has already bought.
   *
   * EVERY STEP BEFORE THE REFUSED ONE REALLY HAPPENED and is in `steps` with its own cost and
   * timestamp. Nothing about this record is settled: the caller releases it, and the answers already
   * bought are replayed from the step log next time (spec 5.2) rather than bought again.
   */
  throttled?: boolean
}

/** The contact vendors. The dossier is not one of them: it finds the OWNER, and which
 *  vendor is then asked for that owner's contacts is the entity-versus-individual decision. */
export type ContactVendor = 'fastappend' | 'tracerfy'

/** Which vendor each step puts the question to, or null when the step asks no contact vendor.
 *
 *  EXHAUSTIVE BY TYPE, deliberately. A new StepKind is a compile error here until somebody
 *  says which lane it belongs to, rather than silently defaulting to "not a contact step" and
 *  leaving its rows unattributed. */
const CONTACT_VENDOR_BY_STEP: Record<StepKind, ContactVendor | null> = {
  DOSSIER_APN: null,
  DOSSIER_ADDRESS: null,
  FASTAPPEND_ENTITY: 'fastappend',
  TRACERFY_INSTANT_NAMED: 'tracerfy',
  TRACERFY_PARCEL_APN: 'tracerfy',
}

/**
 * Which contact vendor this run actually put the question to, or null when none was asked.
 *
 * WHY IT EXISTS. Nothing durable records the lane. These reports carry it, and the crons throw
 * them away at the database boundary, so the entity-versus-individual decision cannot be
 * audited after the fact: there is no vendor column and both vendors cost 0.10, so even the
 * cost column cannot separate them. It is also why a tier 2 FastAppend hit reaches customers
 * labelled `person_trace`: resolveOwnerContact has to infer the vendor from which storage
 * envelope the contacts landed in, and on tier 2 that inference is wrong every time.
 *
 * ASKED, NOT PRODUCED. A lane that ran and missed still answers the routing question, and a
 * miss leaves no contact name to mislabel anyway. A 'skipped' step is excluded because it was
 * never put to a vendor: it is the record of a question we decided not to ask.
 *
 * A trust or unreadable name can ask BOTH vendors (spec 4.2, D3). The vendor whose answer
 * produced the contacts wins; when none did, the first vendor asked answers the routing question.
 */
export function contactVendorFrom(steps: StepReport[]): ContactVendor | null {
  for (const step of steps) {
    if (step.outcome !== 'hit' || step.noContacts) continue
    const vendor = CONTACT_VENDOR_BY_STEP[step.kind]
    if (vendor) return vendor
  }
  for (const step of steps) {
    if (step.outcome === 'skipped') continue
    const vendor = CONTACT_VENDOR_BY_STEP[step.kind]
    if (vendor) return vendor
  }
  return null
}

const STEP_OUTCOMES: ReadonlySet<string> = new Set(['hit', 'miss', 'name_not_matched', 'failed', 'skipped'])

/**
 * A step log read back from trace_history.trace_steps (JSONB, so anything). Keeps only entries
 * that are well-formed steps; a resend decides what NOT to buy from this, so a malformed entry is
 * dropped rather than trusted.
 */
export function stepLogFrom(raw: unknown): StepReport[] {
  if (!Array.isArray(raw)) return []
  const out: StepReport[] = []
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue
    const r = e as Record<string, unknown>
    if (typeof r.kind !== 'string' || !Object.prototype.hasOwnProperty.call(CONTACT_VENDOR_BY_STEP, r.kind)) continue
    if (typeof r.outcome !== 'string' || !STEP_OUTCOMES.has(r.outcome)) continue
    if (typeof r.cost !== 'number') continue
    out.push({
      kind: r.kind as StepKind,
      outcome: r.outcome as StepOutcome,
      cost: r.cost,
      ...(typeof r.creditsDeducted === 'number' ? { creditsDeducted: r.creditsDeducted } : {}),
      ...(typeof r.error === 'string' ? { error: r.error } : {}),
      ...(typeof r.note === 'string' ? { note: r.note } : {}),
      ...(typeof r.at === 'string' ? { at: r.at } : {}),
      ...(typeof r.requestKey === 'string' ? { requestKey: r.requestKey } : {}),
      ...(typeof r.peopleCount === 'number' ? { peopleCount: r.peopleCount } : {}),
      ...(r.noContacts === true ? { noContacts: true } : {}),
      ...(r.reused === true ? { reused: true } : {}),
    })
  }
  return out
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
  nameNotMatched?: boolean
  peopleCount?: number
  inputError?: boolean
}

/** A contact vendor's answer, normalised. A hit costs costOnHit whether or not a name matched. */
function contactCall(step: RouteStep, res: ContactResult, fallbackError: string): VendorCall {
  if (!res.success) {
    return {
      success: false, hit: false, cost: 0, error: res.error ?? fallbackError,
      ...(res.inputError ? { inputError: true } : {}),
    }
  }
  return {
    success: true,
    hit: res.hit,
    // The vendor bills a hit whether or not a returned person was the owner (D6).
    cost: res.hit ? step.costOnHit : 0,
    contacts: res.contacts,
    ...(res.creditsDeducted === undefined ? {} : { creditsDeducted: res.creditsDeducted }),
    ...(res.nameNotMatched
      ? { nameNotMatched: true, ...(res.peopleCount === undefined ? {} : { peopleCount: res.peopleCount }) }
      : {}),
  }
}

async function callVendor(step: RouteStep, deps: RouteDeps, opts?: VendorCallOptions): Promise<VendorCall> {
  // Only a caller with a request budget passes opts. The crons pass none, and their vendor calls
  // keep the one-argument shape their tests pin.
  try {
    switch (step.kind) {
      case 'DOSSIER_APN':
      case 'DOSSIER_ADDRESS': {
        const key = dossierKeyFor(step)
        if (!key) return { success: false, hit: false, cost: 0, error: `Cannot key ${step.kind}` }

        const res = opts ? await deps.lookupDossier(key, opts) : await deps.lookupDossier(key)
        if (!res.success) {
          return { success: false, hit: false, cost: 0, error: res.error ?? `${step.kind} failed` }
        }
        // Charge what the vendor says it deducted, not what we assume a hit costs.
        const cost = res.hit
          ? round2((res.creditsDeducted / DOSSIER_CREDITS_PER_HIT) * step.costOnHit)
          : 0
        return { success: true, hit: res.hit, cost, creditsDeducted: res.creditsDeducted, dossier: res }
      }

      case 'FASTAPPEND_ENTITY': {
        const req = entityRequest(step)
        const res = opts ? await deps.traceEntity(req, opts) : await deps.traceEntity(req)
        return contactCall(step, res, 'Entity trace failed')
      }

      case 'TRACERFY_INSTANT_NAMED':
      case 'TRACERFY_PARCEL_APN': {
        const req = personRequest(step)
        const res = opts ? await deps.tracePerson(req, opts) : await deps.tracePerson(req)
        return contactCall(step, res, 'Person trace failed')
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
  /** canSpend refused a call. The stage stopped there; nothing after it was attempted. */
  throttled: boolean
}

interface StageContext {
  deadlineMs?: number
  prior: StepReport[]
  now: () => number
  onStep?: (step: StepReport) => void | Promise<void>
  canSpend?: (step: RouteStep) => boolean | Promise<boolean>
}

const isContactStep = (kind: StepKind): boolean => CONTACT_VENDOR_BY_STEP[kind] !== null

const hasPhoneOrEmail = (c: OwnerContacts | null | undefined): boolean =>
  Boolean(c && (c.phones.length > 0 || c.emails.length > 0))

/** An answer that can stand in for asking again: the vendor answered and nothing was delivered. */
const isReusableAnswer = (e: StepReport): boolean =>
  e.outcome === 'miss' || e.outcome === 'name_not_matched' || (e.outcome === 'hit' && e.noContacts === true)

/** The logged answer to exactly this question, if it is younger than 24 hours by its OWN time. */
function reusableAnswer(ctx: StageContext, requestKey: string): StepReport | null {
  for (const e of ctx.prior) {
    // `!e.at` is belt-and-braces: Date.parse(undefined) is already NaN, which Number.isFinite(age)
    // below rejects on its own. Kept for clarity at the call site, not because it changes behavior.
    if (e.requestKey !== requestKey || !e.at || !isReusableAnswer(e)) continue
    const age = ctx.now() - Date.parse(e.at)
    if (Number.isFinite(age) && age >= 0 && age < STEP_REUSE_WINDOW_MS) return e
  }
  return null
}

/**
 * Run one stage's steps in order, stopping at the first step that DELIVERS: a dossier hit, or a
 * contact hit with a name-matched phone or email.
 *
 * A failure also stops the stage. We cannot tell a transient outage from a key-specific
 * rejection here, and continuing through an incident both compounds load on a rate limit
 * that is SHARED across Tracerfy's endpoints and produces a half-run record the caller
 * cannot safely bill.
 */
async function runStage(steps: RouteStep[], deps: RouteDeps, ctx: StageContext): Promise<StageResult> {
  const reports: StepReport[] = []
  let spend = 0
  let hit: VendorCall | null = null
  let failure: string | null = null
  let throttled = false

  /**
   * Record one report, and hand it to the caller's hook before the next step runs.
   *
   * ONE FUNNEL, SEVEN CALL SITES. This stage pushes a report from seven places (skipped after a
   * hit or a failure, a reused answer, a call the request deadline refused, a call the per-minute
   * vendor budget refused, our own refused request, a vendor failure, and an answer). A hook wired
   * into six of them is a step log missing whichever one the next reader forgets, which for a
   * queue means a resumed row re-buying that step.
   */
  const record = async (report: StepReport): Promise<void> => {
    reports.push(report)
    if (!ctx.onStep) return
    try {
      await ctx.onStep(report)
    } catch (err) {
      // NEVER THROWS is this module's contract. The console is the only operator channel PTP has.
      console.error('[executeRoute] onStep failed, the ladder continued:', err)
    }
  }

  for (const step of steps) {
    if (hit || failure) {
      await record({
        kind: step.kind,
        outcome: 'skipped',
        cost: 0,
        note: hit ? 'an earlier step hit; this one would have been a wasted charge'
                  : 'an earlier step failed; not attempted',
      })
      continue
    }

    const requestKey = requestKeyFor(step)

    // RESUME (spec 5.2). An answer this record already bought, inside 24 hours, is not bought again.
    // It keeps its own time and cost, and adds nothing to this run's spend.
    const prior = reusableAnswer(ctx, requestKey)
    if (prior) {
      await record({ ...prior, reused: true })
      continue
    }

    // THE REQUEST BUDGET. A call that cannot finish before the deadline is not started: the record
    // ends busy_try_again and the resend picks up at this step.
    const left = ctx.deadlineMs === undefined ? undefined : ctx.deadlineMs - ctx.now()
    if (left !== undefined && left < VENDOR_TIMEOUT.MIN_CALL_MS) {
      failure = 'The request ran out of time before this lookup could start.'
      await record({
        kind: step.kind, outcome: 'failed', cost: 0, error: failure,
        at: new Date(ctx.now()).toISOString(), requestKey,
      })
      continue
    }

    // THE SHARED PER-MINUTE VENDOR BUDGET (spec 5.3), asked for THIS call, one call at a time, at
    // the last moment before it is made. A record cannot exceed a reservation it takes here, which
    // is the difference between a budget that bounds the vendor's rate limit and one that describes
    // a hoped-for average.
    //
    // OPTIONAL, AND ONLY THE TIER 1 CRON LANE PASSES IT. A caller whose ladder cannot be rewound
    // must reserve before the record starts instead, because a refusal here stops a ladder that may
    // already have been paid for: see the tier 2 cron, which passes no canSpend for that reason.
    //
    // A REFUSAL IS NOT A FAILURE (spec 5.1): `failure` is deliberately NOT set, so the record does
    // not end busy_try_again and the customer is told nothing, because nothing happened to their
    // record. BREAK, not continue: the budget said this minute has no room for this record, not "ask
    // the other vendor instead", and a `skipped` report for every remaining step would claim they
    // were considered when they were not reached.
    if (ctx.canSpend && !(await ctx.canSpend(step))) {
      throttled = true
      await record({
        kind: step.kind,
        outcome: 'skipped',
        cost: 0,
        note: 'the per-minute vendor budget could not cover this call; not attempted',
        requestKey,
      })
      break
    }

    const call = await callVendor(step, deps, left === undefined ? undefined : { timeoutMs: left })
    const at = new Date(ctx.now()).toISOString()

    if (call.inputError) {
      // OUR request, refused before spending (no name, no city, no state). Not a vendor failure, so
      // never busy_try_again (spec 5.1): recorded as not asked, and the next step runs.
      await record({
        kind: step.kind, outcome: 'skipped', cost: 0,
        note: `not sent: ${call.error ?? 'refused'}`, at, requestKey,
      })
      continue
    }

    if (!call.success) {
      failure = call.error ?? `${step.kind} failed`
      await record({ kind: step.kind, outcome: 'failed', cost: 0, error: failure, at, requestKey })
      continue
    }

    spend = round2(spend + call.cost)
    const delivered = !isContactStep(step.kind) || hasPhoneOrEmail(call.contacts)
    await record({
      kind: step.kind,
      outcome: call.nameNotMatched ? 'name_not_matched' : call.hit ? 'hit' : 'miss',
      cost: call.cost,
      at,
      requestKey,
      ...(call.creditsDeducted === undefined ? {} : { creditsDeducted: call.creditsDeducted }),
      ...(call.nameNotMatched && call.peopleCount !== undefined ? { peopleCount: call.peopleCount } : {}),
      ...(call.hit && !call.nameNotMatched && !delivered ? { noContacts: true } : {}),
    })
    // A dossier hit ends its stage. A contact step ends it only with a name-matched phone or email:
    // a non-matched person (D6) or a matched one with neither is a no-contact result, and the next
    // step runs (spec 4.3).
    if (call.hit && delivered) hit = call
  }

  return { reports, spend, hit, failure, throttled }
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

/** Each owner the dossier names, as the one string classifyOwnerName() and splitPersonName() parse.
 *  An entity arrives with its whole name in last_name and first_name empty. */
function ownerNamesFrom(dossier: DossierResult): string[] {
  const names: string[] = []
  for (const o of dossier.owners) {
    const name = [o.first_name, o.last_name].map(s => s.trim()).filter(Boolean).join(' ')
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** All owners joined with " | ", the shape ExecutionResult.ownerName reports. */
const ownerNameFrom = (dossier: DossierResult): string => ownerNamesFrom(dossier).join(' | ')

/**
 * The parcel one dossier owner's contacts are looked up on.
 *
 * D21 (c): when the property has no street or city, an INDIVIDUAL owner is searched by name at the
 * dossier's MAILING address with the Instant lookup, instead of the parcel lookup. Every other owner
 * keeps the property's own keys.
 */
function contactParcelFor(
  parcel: ParcelInput,
  owner: string,
  situsZip: string | null,
  mailing: DossierMailingAddress | null,
): ParcelInput {
  const base: ParcelInput = { ...parcel, ownerName: owner, situsZip }
  const mailingComplete =
    mailing !== null && Boolean(mailing.address.trim() && mailing.city.trim() && mailing.state.trim())
  if (!hasSitus(parcel) && mailingComplete && classifyOwnerName(owner) === 'individual') {
    return {
      ...base,
      situsAddress: mailing!.address.trim(),
      situsCity: mailing!.city.trim(),
      situsState: mailing!.state.trim(),
      situsZip: mailing!.zip.trim() || null,
      parcelIdLocal: null,
      county: null,
    }
  }
  return base
}

export async function executeRoute(
  plan: RoutePlan,
  deps: RouteDeps,
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const ctx: StageContext = {
    deadlineMs: options.deadlineMs,
    // Never trust what a caller hands in here: a caller that casts row.trace_steps instead of
    // going through stepLogFrom could otherwise re-persist a raw `people` key it was carrying,
    // and D29 requires that no name ever reaches the log, no matter how a caller got here.
    prior: stepLogFrom(options.priorSteps),
    now: options.now ?? Date.now,
    onStep: options.onStep,
    canSpend: options.canSpend,
  }
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
  const pass1 = await runStage(plan.steps, deps, ctx)
  result.steps = pass1.reports
  result.vendorSpend = pass1.spend

  // THROTTLED BEFORE THE LADDER COULD FINISH (spec 5.3). Nothing is judged here: on a tier 1 plan
  // pass 1 IS the contact call, so a throttle means the question was never put, and returning
  // `contactsFound: false` without this flag would let a caller file "we looked and found nothing"
  // on a lookup that never happened (CLAUDE.md rule 7). The tier 2 re-plan below is not entered
  // either: there is no owner to discover when the dossier was never asked.
  if (pass1.throttled) {
    result.throttled = true
    return result
  }

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
  const dossier = pass1.hit?.dossier
  if (!dossier) {
    // Every key missed. Asked and answered: there is no record to route.
    result.needsManualReview = plan.steps.length === 0
    return result
  }

  // RAW, by reference. Not copied, not subsetted, not renamed.
  result.property = dossier.property
  result.mailingAddress = dossier.mailingAddress

  const discovered = ownerNameFrom(dossier)
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

  // ---- Pass 2 (D21 c, D32). Every owner the dossier names, each classified on its own. If every
  // owner's lookup misses, the result is a TRUE NULL: the dossier's own contacts block (D21 b) is
  // withdrawn (spec D32, 2026-09-22) and is never used, in any phase, by any caller. ----
  //
  // ZIP BACKFILL. The $0.20 we just spent bought the property's own zip, and the contact step is
  // the one that decides whether the customer gets a phone number at all: Tracerfy calls the zip
  // strongly recommended for the named lookup. THE CALLER'S OWN ZIP WINS: they may know something
  // the county file does not.
  const callerZip = plan.parcel.situsZip?.trim() || ''
  const learnedZip = callerZip ? null : situsZipFrom(result.property)
  result.learnedZip = learnedZip

  let asked = false
  for (const owner of ownerNamesFrom(dossier)) {
    const contactPlan = planRoute(
      contactParcelFor(plan.parcel, owner, callerZip || learnedZip, result.mailingAddress),
      plan.pricePlan,
    )
    for (const w of contactPlan.warnings) if (!warnings.includes(w)) warnings.push(w)
    if (contactPlan.steps.length === 0) continue
    asked = true

    const stage = await runStage(contactPlan.steps, deps, ctx)
    result.steps = [...result.steps, ...stage.reports]
    result.vendorSpend = round2(result.vendorSpend + stage.spend)

    // The dossier above was bought and its record stands. This owner's contact lookup was refused
    // by the budget, and so is every owner after it, so the caller releases the record rather than
    // settling it as "no contacts found" for owners nobody asked about.
    if (stage.throttled) {
      result.throttled = true
      return result
    }

    if (stage.failure) {
      // The dossier spend above stands and the record is good. Only the contact call is unknown.
      result.success = false
      result.error = stage.failure
      return result
    }
    if (stage.hit?.contacts) {
      result.contacts = stage.hit.contacts
      result.contactsFound = true
      return result
    }
  }

  // No owner had a usable name or key: a person has to take it.
  if (!asked) result.needsManualReview = true
  return result
}
