/**
 * THE ONE TIER 1 SETTLE. Plan, execute, judge, charge, persist, for ONE record.
 *
 * Three callers, one implementation: app/api/trace/single (web, inline), app/api/v1/trace/single
 * (API, inline) and the Tier 1 lane of app/api/cron/sweep-entity-traces (bulk, one claimed row at a
 * time). The billing gate, the ledger probe, the fold and the persist live here and nowhere else.
 *
 * WHY THE CRON DOES NOT HAVE ITS OWN COPY. Two money derivations drift. PTP has already paid for
 * that once: until 2026-09-23 the /api/v1 surface priced through a second, raw derivation that
 * ignored the Suite Gateway snapshot, so the same customer would have been billed the Pro rate on
 * the dashboard and the Pay-As-You-Go rate on the API for the same work. David's ruling: "One
 * price." Both raw helpers were deleted rather than re-pointed, so no new call site could reach for
 * one by accident (lessons L-030). A cron that re-derived the gate, the probe or the fold would be
 * the same defect in a different file, against bulk volume.
 *
 * WHAT DIFFERS BETWEEN A SINGLE TRACE AND A QUEUED RECORD, and it is all in the input:
 *
 *   deadlineMs          the single routes bound the whole ladder to 50 s inside their 60 s
 *                       maxDuration. The cron gives each record its own budget instead.
 *   ledgerSince         the window the crash probe asks about. A single trace asks about the last
 *                       24 hours (the resend window). A queued record asks about ITS OWN BULK JOB,
 *                       because the row is REUSED and a debit from an earlier submit is not an
 *                       answer about this one, which is the bound
 *                       app/api/cron/sweep-property-traces already takes for tier 2.
 *   queueWrite          what the persist writes into the two queue columns. A single trace nulls
 *                       both. A queued record writes its own terminal status, which is what
 *                       releases the parent bulk job.
 *   resumeFromStepLog   a single trace resumes only a busy_try_again row (spec 5.2). A claimed queue
 *                       row always resumes from whatever its log holds, because a dead claim is
 *                       recovered one rung up and the answers it already bought are on the row.
 *   onStep              per-arrival step-log writes, which a queue needs and an inline request does
 *                       not: a killed run would otherwise re-buy every answered step.
 *   canSpend            the shared per-minute vendor budget (spec 5.3), asked once per call. The
 *                       TIER 1 cron lane passes one; a single trace passes NONE, because refusing its call would
 *                       answer a live customer with a busy it did not have to have, and the 50-call
 *                       gap under each vendor's own 500 is what carries that caller, along with the
 *                       tier 2 lane's unreserved pass-2 lookups (Task 6's header sizes both). So a
 *                       throttle is structurally impossible on a single trace, which is why the
 *                       throttle branch below cannot change what one does.
 *
 * `execution.steps` is the step log. It is written to trace_steps and read back only by the next
 * attempt at the same record. It never goes into a response or a webhook.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  contactVendorFrom,
  executeRoute,
  stepLogFrom,
  STEP_REUSE_WINDOW_MS,
  type ExecutionResult,
  type RouteDeps,
  type StepReport,
} from '@/lib/routing/executeRoute'
import { planRoute, type ParcelInput, type PricePlan, type RouteStep } from '@/lib/routing/ownerRoute'
import { foldBillingWrite, TRACE_TIER, type CacheHitRow } from '@/lib/trace/billedRows'
import { hasContactData, traceResultFor } from '@/lib/trace/fullPropertyTrace'
import {
  missingLookupKey,
  outcomeSentence,
  tier1OutcomeFor,
  TIER1_OUTCOME,
  type FoundBy,
  type Tier1OutcomeCode,
} from '@/lib/trace/tier1Outcome'
import { collectedChargesFor } from '@/lib/wallet/collectedCharge'
import { deductWallet } from '@/lib/wallet/deduct'
import type { TraceResult } from '@/types'

/** The wallet ledger line: the words the retired poll route wrote for a Tier 1 charge. */
export const TIER1_CHARGE_DESCRIPTION = 'Skip trace - successful match'

/**
 * runTier1Record was handed a record with no owner name. planRoute answers that with a TIER 2
 * plan -- the dossier -- which this settle would buy and then charge at the Tier 1 rate.
 */
export class NotATier1PlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotATier1PlanError'
  }
}

/**
 * The shared vendor rate budget refused a call this record needed (spec 5.1, 5.3).
 *
 * NOT A FAILURE AND NOT AN OUTCOME. Nothing was settled, nothing was charged, and the customer is
 * told nothing, because nothing happened to their record. The caller puts its row back on the rung it
 * was claimed from, with no attempt spent, and the answers the record had already bought stay in its
 * step log to be replayed rather than bought again.
 *
 * WHY A THROW AND NOT A FIELD ON Tier1RecordResult. Two reasons, and the first is the binding one.
 * A field would change that type's key set, and lib/trace/__tests__/singleTier1.test.ts asserts it in
 * full precisely so this task can prove a single trace is unchanged; the test has to pass unedited
 * against the old code and the new. And on its own terms a throttled record HAS no result: there is
 * no outcome, no skip reason and no deduction to report, so every field of that type would be a lie.
 *
 * UNREACHABLE FROM A SINGLE TRACE. runSingleTier1 passes no canSpend, so executeRoute never sets
 * `throttled` on that path. Only the TIER 1 cron lane can see this: it is the one caller that passes
 * canSpend, because a Tier 1 record's steps are independent and a refusal costs it nothing. The tier 2
 * cron reserves once before a record starts and never gets here.
 */
export class VendorBudgetThrottledError extends Error {
  constructor() {
    super('the shared vendor rate budget could not cover a call this record needed')
    this.name = 'VendorBudgetThrottledError'
  }
}

/** The row this request reused or inserted, as it stood BEFORE this attempt. */
export interface SingleTier1Row extends CacheHitRow {
  id: string
  outcome_code?: string | null
  trace_steps?: unknown
  /**
   * The result the row already holds. D39: a trace that finds nothing must not erase contacts
   * the customer has already paid for. JSONB, so it is `unknown` and read defensively below.
   */
  trace_result?: unknown
}

export interface Tier1RecordInput {
  adminClient: SupabaseClient
  userId: string
  row: SingleTier1Row
  /** The record, with ownerName set. */
  parcel: ParcelInput
  pricePlan: PricePlan
  /** chargePerTrace(profile) on every surface. One derivation (lib/suite/pricing.ts). */
  chargeAmount: number
  /**
   * Epoch ms after which no vendor call may start, or undefined for no bound. The single routes
   * pass request start + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS; the cron passes its own per-record
   * budget. Undefined leaves only the 25 s per-call ceiling in the vendor clients.
   *
   * REQUIRED BUT NULLABLE, NOT OPTIONAL, and the difference is the point (fix round 1). Declared
   * `?: number` a caller could simply FORGET it and still compile, and get an unbounded ladder held
   * only by that per-call ceiling. Written this way every caller has to state its intent, even when
   * the intent is "no bound". SingleTier1Input narrows it back to a real number, so both single
   * routes are still forced to pass one.
   */
  deadlineMs: number | undefined
  deps: RouteDeps
  /**
   * The supplied owner name, exactly as the caller sent it, or null. Written into the SAME
   * persist UPDATE as trace_result below (fix round 1, D25 money): a name and the result it
   * describes must change together, in one write, never a separate one that could name a new
   * owner ahead of that owner's own result.
   */
  inputOwnerName: string | null
  /**
   * ISO time bounding the crash probe, or null for unbounded.
   *
   * A single trace passes 24 hours back, the resend window. A queued record passes its own bulk
   * job's created_at, because the row is REUSED: a debit booked for an earlier submit predates this
   * piece of work and cannot be the answer to whether THIS one has been collected. NULL MEANS
   * UNBOUNDED, WHICH IS THE SAFE DIRECTION: an unreadable bound can only cause a charge to be
   * skipped, while a wrong bound charges a customer twice.
   */
  ledgerSince: string | null
  /**
   * What the persist writes into the two queue columns.
   *
   * A single trace writes null into both: a reused row can carry a stale value from a bulk job and
   * it must not answer rowSkipReason for this trace. A queued record writes its own terminal status
   * into `ai_research_status`, which is what stops it being claimed again and what lets the parent
   * bulk job settle, and null into the other.
   */
  queueWrite: { ai_research_status: string | null; property_trace_status: string | null }
  /**
   * Reuse the answers already on this row instead of buying them again (spec 5.2).
   *
   * A single trace passes this only for a busy_try_again row. The cron passes true for every claimed
   * row: a dead claim is re-claimed one rung up, and the per-arrival writes mean the answers it
   * already paid for are on the row. Either way executeRoute judges each entry by its OWN
   * timestamp, so nothing older than 24 hours is reused.
   */
  resumeFromStepLog: boolean
  /** Per-arrival step-log write. See the file header. */
  onStep?: (step: StepReport) => void | Promise<void>
  /**
   * The shared per-minute vendor budget, asked once per call (spec 5.3, Task 6).
   *
   * Passed straight through to executeRoute. A cron passes one; the two single routes pass NONE, and
   * that is deliberate rather than an omission: a single trace runs inside a customer's request, so
   * refusing its call would mean answering a live customer with a busy it did not have to have. The
   * 50-call gap between the budget's 450 and each vendor's own 500 exists for exactly those callers.
   *
   * Without it `execution.throttled` is always falsy and the throttle branch below is unreachable,
   * which is what keeps a single trace's behaviour identical to before Phase 2A.
   */
  canSpend?: (step: RouteStep) => boolean | Promise<boolean>
}

/** The single-trace input: the shared one without the five fields only a queue needs. */
export type SingleTier1Input = Omit<
  Tier1RecordInput,
  'ledgerSince' | 'queueWrite' | 'resumeFromStepLog' | 'onStep' | 'canSpend' | 'deadlineMs'
> & { deadlineMs: number }

export type Tier1Deduction = 'not_attempted' | 'already_collected' | 'charged' | 'insufficient_balance' | 'error'

export interface Tier1RecordResult {
  execution: ExecutionResult
  outcome: Tier1OutcomeCode
  foundBy: FoundBy | null
  /** The customer's sentence, or null when contacts were delivered. */
  skipReason: string | null
  result: TraceResult | null
  status: 'success' | 'no_match' | 'error'
  /** What THIS request collected: 0, the rate, or a debit an earlier crashed attempt booked. */
  charge: number
  deduction: Tier1Deduction
  persistError: string | null
}

/** The single-trace result: the same object, under the name the two routes already import. */
export type SingleTier1Result = Tier1RecordResult

const round2 = (n: number): number => Math.round(n * 100) / 100

/** The result already on the row, read the way a JSONB column has to be: never cast blindly. */
const storedResultOf = (value: unknown): TraceResult | null =>
  value !== null && typeof value === 'object' ? (value as TraceResult) : null

export async function runTier1Record(input: Tier1RecordInput): Promise<Tier1RecordResult> {
  const plan = planRoute(input.parcel, input.pricePlan)

  // A TIER 1 SETTLE, AND ONLY A TIER 1 SETTLE. planRoute returns a tier 2 plan for a record with
  // no owner name: the $0.20 dossier would be bought here and then billed at the Tier 1 rate, or
  // not billed at all. Both single routes send an ownerless record down their own tier 2 branch,
  // so this cannot fire today. It is here so a future caller cannot make it fire quietly.
  //
  // The message names THIS function, not the wrapper: the cron reaches it without going anywhere
  // near runSingleTier1, and naming a function the caller never called sends the reader to the
  // wrong file.
  if (plan.tier !== 1) {
    throw new NotATier1PlanError(
      'runTier1Record needs a record with an owner name: planRoute returned a Tier 2 plan.',
    )
  }

  // Only a busy_try_again row RESUMES on a single trace (spec 5.2); a claimed queue row always
  // resumes from what it already bought. Any answer older than 24 hours is never reused either way:
  // executeRoute judges each entry by its own time, because a reused row keeps its created_at.
  const priorSteps = input.resumeFromStepLog ? stepLogFrom(input.row.trace_steps) : []

  const execution = await executeRoute(plan, input.deps, {
    deadlineMs: input.deadlineMs,
    priorSteps,
    onStep: input.onStep,
    canSpend: input.canSpend,
  })

  // THROTTLED, AND IT STOPS HERE: BEFORE THE JUDGE, BEFORE THE LEDGER, BEFORE THE PERSIST.
  //
  // A call this record needed could not be covered this minute (spec 5.1, 5.3). Judging it would
  // file a "we looked this owner up and found no match" on a question no vendor was ever asked, and
  // that sentence would then answer for the row in History and in the results CSV. Fabricating the
  // result of a lookup we chose not to make is precisely CLAUDE.md rule 7.
  //
  // Nothing needs unwinding: no money is written above this line, and any answer the record DID buy
  // is already in trace_steps through onStep, so the re-claim replays it instead of re-buying it.
  //
  // UNREACHABLE FROM A SINGLE TRACE: runSingleTier1 passes no canSpend.
  if (execution.throttled) throw new VendorBudgetThrottledError()

  const { outcome, foundBy } = tier1OutcomeFor(execution)
  const result = traceResultFor(execution)

  // THE BILLING GATE (spec 6.1, D8): a name-matched result with at least one phone or email.
  // Everything else is free: no_match, owner_name_not_matched, no_lookup_key, busy_try_again.
  const billable = hasContactData(result)

  let collectedNow = 0
  let deduction: Tier1Deduction = 'not_attempted'
  if (billable) {
    // THE LEDGER PROBE, the Tier 2 cron's pattern (spec 6.1): one ledger read, two answers.
    // `inWindow` DECIDES. A debit inside the last 24 hours (the resend window, spec 5.2) that the
    // row's charge does not yet show is an earlier attempt at THIS record that deducted and died
    // before its persist: it is recorded, never taken again. Bounded, because an OLDER surplus
    // (a receipt zeroed by the 2026-09-17 settle bug, an old single-debit raw write, an earlier
    // failed persist) is not this request's money and must not make this request free. Asked as
    // "unrecorded" too, because a reused row legitimately carries debits from earlier, separate
    // purchases that its charge column already shows.
    const { total, inWindow } = await collectedChargesFor(
      input.adminClient,
      input.row.id,
      input.ledgerSince,
    )
    const recorded = Number(input.row.charge ?? 0) || 0
    const unrecorded =
      inWindow !== null && inWindow > 0 ? round2(Math.min(inWindow, (total ?? 0) - recorded)) : 0
    if (unrecorded > 0) {
      collectedNow = unrecorded
      deduction = 'already_collected'
    } else {
      const d = await deductWallet(input.adminClient, {
        p_user_id: input.userId,
        p_amount: input.chargeAmount,
        p_trace_history_id: input.row.id,
        p_description: TIER1_CHARGE_DESCRIPTION,
      })
      collectedNow = d.collected
      deduction = d.outcome
      if (d.outcome === 'error') {
        console.error('Single trace tier 1 - wallet deduct failed, contacts delivered uncharged:', input.row.id, d.message)
      }
    }
  }

  // RECEIPTS ARE MONOTONIC: folded onto what the row already carried, tier never downgraded.
  const billing = foldBillingWrite(input.row, { charge: collectedNow, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE })
  const status: Tier1RecordResult['status'] =
    outcome === TIER1_OUTCOME.BUSY_TRY_AGAIN ? 'error' : billable ? 'success' : 'no_match'
  const skipReason = billable
    ? null
    : outcomeSentence(
        outcome,
        execution.steps,
        missingLookupKey({
          address: input.parcel.situsAddress,
          city: input.parcel.situsCity,
          state: input.parcel.state,
          apn: input.parcel.parcelIdLocal,
          county: input.parcel.county,
        }),
      )

  // KEEP THE PAID CONTACTS (spec D39). A trace that finds NOTHING never erases a stored result
  // that already carries a phone or an email. That result was bought, and it belongs to the owner
  // the row already names, so `input_owner_name` has to stay with it (D25): writing this trace's
  // owner over it would leave the row naming one owner while holding another's contacts.
  //
  // Only the INTERNAL columns are written on that path: the step log, the contact vendor, and
  // whatever `queueWrite` carries -- null on both from a single trace, the record's own terminal
  // status from the queue, because a queued record that finds nothing still has to release its
  // parent bulk job. `trace_result`, `input_owner_name`, the two counts, `is_successful`, `charge`,
  // `cost` and `found_by` are left exactly as they are. The caller is still told THIS attempt's own
  // outcome, free: the returned Tier1RecordResult is unchanged either way. Two columns on that path
  // are written rather than left, and both are written BECAUSE the row keeps its stored result; see
  // `preservedStatus` and `preservedOutcome` below.
  const keepsPaidContacts = !billable && hasContactData(storedResultOf(input.row.trace_result))

  // The queue columns. A single trace nulls both, because a reused row can carry a stale value from
  // a bulk job and it must not answer rowSkipReason for this trace. A queued record writes its own
  // terminal status here, which is what releases the parent bulk job.
  const internalWrite = {
    contact_vendor: contactVendorFrom(execution.steps),
    trace_steps: execution.steps,
    tracerfy_job_id: null,
    ...input.queueWrite,
  }

  // TWO STATEMENTS, NOT ONE WITH A TERNARY PAYLOAD. lib/trace/__tests__/chargeReceipt.test.ts
  // reads `.from('trace_history').update({` and parses the object literal that follows, so a
  // payload hidden behind a ternary would make the receipt fence blind to this settle.
  const { error } = keepsPaidContacts
    ? await input.adminClient
        .from('trace_history')
        .update({
          ...internalWrite,
          // THE ROW GENUINELY HOLDS A DELIVERED RESULT, SO IT READS AS ONE. Both single routes set
          // status 'processing' on the row before this settle runs. Leaving it there would
          // contradict `is_successful`, which is already true and is not rewritten here: History
          // would show "Processing" over a set of paid contacts, and
          // app/api/cron/sweep-stale-traces (status = 'processing' AND trace_job_id IS NULL) would
          // later write status = 'error' on it. This is the stored result's own status, restored,
          // not this trace's -- this trace reports its own outcome in SingleTier1Result.
          status: 'success',
          // BUSY IS THE ONE OUTCOME THE ROW STILL HAS TO CARRY. A resend inside 24 hours resumes
          // from the step log only when it finds outcome_code 'busy_try_again' (above), so leaving
          // the row's old found_by_* code here would make the retry buy the answered steps again.
          // Safe: `tier1OutcomeReason` returns null whenever `is_successful` is true, so a busy
          // code on a successful row can never surface as a sentence. Every other outcome is left
          // alone, because overwriting found_by_address with no_match would relabel a result that
          // did find contacts.
          ...(outcome === TIER1_OUTCOME.BUSY_TRY_AGAIN ? { outcome_code: outcome } : {}),
        })
        .eq('id', input.row.id)
    : await input.adminClient
        .from('trace_history')
        .update({
          status,
          trace_result: result,
          input_owner_name: input.inputOwnerName,
          phone_count: result?.phones?.length || 0,
          email_count: result?.emails?.length || 0,
          is_successful: status === 'success',
          charge: billing.charge,
          tier: billing.tier,
          // What the vendors took for this record, answers reused from the log included.
          cost: round2(execution.steps.reduce((sum, s) => sum + s.cost, 0)),
          outcome_code: outcome,
          found_by: foundBy,
          ...internalWrite,
        })
        .eq('id', input.row.id)

  return {
    execution,
    outcome,
    foundBy,
    skipReason,
    result,
    status,
    charge: collectedNow,
    deduction,
    persistError: error ? error.message : null,
  }
}

/**
 * A SINGLE Tier 1 trace: runTier1Record with the four queue fields the routes do not have.
 *
 * Kept as its own export so the two single routes read unchanged and so this file has one obvious
 * place where "what a single trace does differently" is written down. Every value below was
 * inlined in this function before Phase 2A, and lib/trace/__tests__/singleTier1.test.ts asserts
 * the full persist payload and the full result to prove that moving them changed nothing.
 */
export async function runSingleTier1(input: SingleTier1Input): Promise<SingleTier1Result> {
  return runTier1Record({
    ...input,
    // The resend window (spec 5.2). Bounded, because an OLDER surplus is not this request's money.
    ledgerSince: new Date(Date.now() - STEP_REUSE_WINDOW_MS).toISOString(),
    // Both queue columns cleared: a reused row must not answer with a bulk job's stale value.
    queueWrite: { ai_research_status: null, property_trace_status: null },
    // Only a busy row resumes on this surface (spec 5.2).
    resumeFromStepLog: input.row.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN,
  })
}
