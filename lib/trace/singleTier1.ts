/**
 * A supplied-owner (Tier 1) single trace, run INLINE (spec D1, D26): plan, execute, judge,
 * charge, persist.
 *
 * Shared by app/api/trace/single (Track A price) and app/api/v1/trace/single (Track B price), so
 * the billing gate, the ledger probe and the fold live in ONE place and one set of tests fences
 * both routes. The routes keep what differs: auth, the price, the response casing, the webhook.
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

/** The row this request reused or inserted, as it stood BEFORE this attempt. */
export interface SingleTier1Row extends CacheHitRow {
  id: string
  outcome_code?: string | null
  trace_steps?: unknown
}

export interface SingleTier1Input {
  adminClient: SupabaseClient
  userId: string
  row: SingleTier1Row
  /** The record, with ownerName set. */
  parcel: ParcelInput
  pricePlan: PricePlan
  /** chargePerTrace(profile) on the web, getChargePerTrace(...) on the API. */
  chargeAmount: number
  /** Request start + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS. */
  deadlineMs: number
  deps: RouteDeps
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

export async function runSingleTier1(input: SingleTier1Input): Promise<SingleTier1Result> {
  const plan = planRoute(input.parcel, input.pricePlan)

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

  const { error } = await input.adminClient
    .from('trace_history')
    .update({
      status,
      trace_result: result,
      phone_count: result?.phones?.length || 0,
      email_count: result?.emails?.length || 0,
      is_successful: status === 'success',
      charge: billing.charge,
      tier: billing.tier,
      // What the vendors took for this record, answers reused from the log included.
      cost: round2(execution.steps.reduce((sum, s) => sum + s.cost, 0)),
      contact_vendor: contactVendorFrom(execution.steps),
      outcome_code: outcome,
      found_by: foundBy,
      trace_steps: execution.steps,
      tracerfy_job_id: null,
      // A reused row can carry a stale queue value from a bulk job; it must not answer
      // rowSkipReason for this single trace.
      ai_research_status: null,
      property_trace_status: null,
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
