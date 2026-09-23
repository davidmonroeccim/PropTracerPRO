/**
 * A supplied-owner (Tier 1) single trace, run INLINE (spec D1, D26): plan, execute, judge,
 * charge, persist.
 *
 * Shared by app/api/trace/single and app/api/v1/trace/single, so the billing gate, the ledger
 * probe and the fold live in ONE place and one set of tests fences both routes. The routes keep
 * what differs: auth, the response casing, the webhook. Both now pass the SAME price, from the one
 * derivation in lib/suite/pricing.ts.
 *
 * `execution.steps` is the step log. It is written to trace_steps and read back only by the next
 * resend of a busy_try_again row. It never goes into a response or a webhook.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  contactVendorFrom,
  executeRoute,
  stepLogFrom,
  STEP_REUSE_WINDOW_MS,
  type ExecutionResult,
  type RouteDeps,
} from '@/lib/routing/executeRoute'
import { planRoute, type ParcelInput, type PricePlan } from '@/lib/routing/ownerRoute'
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
 * runSingleTier1 was handed a record with no owner name. planRoute answers that with a TIER 2
 * plan -- the dossier -- which this settle would buy and then charge at the Tier 1 rate.
 */
export class NotATier1PlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotATier1PlanError'
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

export interface SingleTier1Input {
  adminClient: SupabaseClient
  userId: string
  row: SingleTier1Row
  /** The record, with ownerName set. */
  parcel: ParcelInput
  pricePlan: PricePlan
  /** chargePerTrace(profile) on every surface. One derivation (lib/suite/pricing.ts). */
  chargeAmount: number
  /** Request start + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS. */
  deadlineMs: number
  deps: RouteDeps
  /**
   * The supplied owner name, exactly as the caller sent it, or null. Written into the SAME
   * persist UPDATE as trace_result below (fix round 1, D25 money): a name and the result it
   * describes must change together, in one write, never a separate one that could name a new
   * owner ahead of that owner's own result.
   */
  inputOwnerName: string | null
}

export type Tier1Deduction = 'not_attempted' | 'already_collected' | 'charged' | 'insufficient_balance' | 'error'

export interface SingleTier1Result {
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

const round2 = (n: number): number => Math.round(n * 100) / 100

/** The result already on the row, read the way a JSONB column has to be: never cast blindly. */
const storedResultOf = (value: unknown): TraceResult | null =>
  value !== null && typeof value === 'object' ? (value as TraceResult) : null

export async function runSingleTier1(input: SingleTier1Input): Promise<SingleTier1Result> {
  const plan = planRoute(input.parcel, input.pricePlan)

  // A TIER 1 SETTLE, AND ONLY A TIER 1 SETTLE. planRoute returns a tier 2 plan for a record with
  // no owner name: the $0.20 dossier would be bought here and then billed at the Tier 1 rate, or
  // not billed at all. Both single routes send an ownerless record down their own tier 2 branch,
  // so this cannot fire today. It is here so a future caller cannot make it fire quietly.
  if (plan.tier !== 1) {
    throw new NotATier1PlanError(
      'runSingleTier1 needs a record with an owner name: planRoute returned a Tier 2 plan.',
    )
  }

  // Only a busy_try_again row RESUMES (spec 5.2). Any other finished row runs fresh, and an answer
  // older than 24 hours is never reused either way: executeRoute judges each entry by its own time,
  // because a reused row keeps its original created_at.
  const priorSteps =
    input.row.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN ? stepLogFrom(input.row.trace_steps) : []

  const execution = await executeRoute(plan, input.deps, { deadlineMs: input.deadlineMs, priorSteps })
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
      new Date(Date.now() - STEP_REUSE_WINDOW_MS).toISOString(),
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
  const status: SingleTier1Result['status'] =
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
  // Only the INTERNAL columns are written on that path: the step log, the contact vendor, and the
  // queue columns this settle always nulls. `trace_result`, `input_owner_name`, the two counts,
  // `is_successful`, `charge`, `cost` and `found_by` are left exactly as they are. The customer is
  // still told THIS trace's own outcome, free: the returned SingleTier1Result is unchanged either
  // way. Two columns on that path are written rather than left, and both are written BECAUSE the
  // row keeps its stored result; see `preservedStatus` and `preservedOutcome` below.
  const keepsPaidContacts = !billable && hasContactData(storedResultOf(input.row.trace_result))

  // The queue columns. A reused row can carry a stale value from a bulk job; it must not answer
  // rowSkipReason for this single trace.
  const internalWrite = {
    contact_vendor: contactVendorFrom(execution.steps),
    trace_steps: execution.steps,
    tracerfy_job_id: null,
    ai_research_status: null,
    property_trace_status: null,
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
