/**
 * ONE shared vendor call budget over a SLIDING 60-second window, drawn by BOTH crons (spec 5.3).
 *
 * THE GUARANTEE, AND WHAT IT COSTS, ARE WRITTEN OUT IN FULL in the plan's Task 6 header, because spec
 * Section 13 names this module as the phase's own risk. In short: a per-vendor ceiling of 450 inside
 * any 60-second span on the Tier 1 lane, which reserves every call; a bound on how many records BEGIN
 * on the Tier 2 lane, which reserves once per record; and no row starves forever.
 *
 * WHY IT IS IN THE DATABASE. Tracerfy allows 500 lookups a minute per account, shared across its
 * instant, APN and dossier endpoints (docs :661, :1332). FastAppend has its own 500
 * (lib/tracerfy/client.ts:566). The Tier 1 lane of app/api/cron/sweep-entity-traces and
 * app/api/cron/sweep-property-traces are separate function invocations on the same one-minute
 * schedule, so a counter in either process would give each of them a private 450 and the vendor 900.
 *
 * A RECORD IS THROTTLED AT ITS START OR NOT AT ALL. No caller may draw from this budget in a way
 * that can refuse a record part-way through a ladder it has already paid for, because releasing such
 * a record means re-running it and re-buying its dossier.
 *   TIER 1 claims ONE CALL AT A TIME, from executeRoute's canSpend hook, which is exact there: that
 *   ladder's steps are independent, a refusal lands before the call it refused, and an answer already
 *   in hand is replayed from the per-arrival step log rather than bought again (spec 5.2).
 *   TIER 2 claims ONCE PER RECORD, for reservationForSteps(plan.steps), immediately before the
 *   record's first vendor call, and then that record runs to completion.
 * WHAT THE TIER 2 SHAPE COSTS: its pass-2 owner lookups are not reserved, so the budget bounds record
 * STARTS there rather than every call, and an in-flight ladder can overshoot. D21(c) and D40 cap
 * nothing and lib/routing/ownerRoute.ts calls its own tier 2 figure "A FLOOR, NOT A CEILING", so the
 * bound is that cron's CONCURRENCY (5) times a record's worst-case remaining ladder (2N calls for N
 * owners: 30 at three owners, against a 50-call gap below the vendor's own 500). There is no
 * hard-coded per-record reservation constant anywhere in this phase; tier 2's figure comes from the
 * plan it is about to run. Never claim the per-call ceiling for the tier 2 lane.
 *
 * THE WINDOW SLIDES. `vendor_rate_windows` holds one bucket per vendor per wall-clock SECOND and a
 * claim sums the trailing 60. A fixed calendar minute would permit 450 calls at :59 and 450 at the
 * next :00: 900 in one 60-second span against a limit of 500. Serialised per vendor by
 * pg_advisory_xact_lock inside claim_vendor_rate, which covers the count and the write together; the
 * row-lock-on-conflict trick a fixed window could use cannot serialise a sum across other rows.
 *
 * 450, NOT 500, because spec 5.3 says 50 under the limit. That gap carries what cannot be reserved:
 * a SINGLE trace, which runs inside a customer's request and claims nothing, and the tier 2 overshoot
 * above.
 *
 * THROTTLING IS NOT A FAILURE, AND IT SPENDS NOTHING (spec 5.1). A refused record has bought nothing,
 * because it was refused before it began (tier 2) or before the call it was asked about (tier 1). Its
 * row goes back to the rung it was claimed from with its claim cleared, no attempt is consumed, and
 * the customer is told nothing because nothing was asked about their record. NOTHING in this module is
 * on the billing path, and no record is ever released after a dossier has been bought for it.
 *
 * NO HAND-BACK. A tier 1 claim is taken for a call that is about to happen, so it is spent within
 * milliseconds. A tier 2 claim covers the dossier steps the plan carries, and a plan whose first step
 * HITS leaves the second one unmade: that claim is spent in the conservative direction, as is a claim
 * granted for a call the vendor client then refuses before sending (an inputError). At most one or two
 * calls each, always over-reserving rather than under-reserving.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StepKind } from '@/lib/routing/ownerRoute'

/**
 * Calls per 60 seconds, per vendor. 50 under each vendor's own 500 (spec 5.3).
 *
 * ONE PLACE. A second copy of either number is a second budget, and two budgets over one vendor
 * account is the defect this module exists to prevent.
 */
export const VENDOR_RATE_LIMIT = {
  tracerfy: 450,
  fastappend: 450,
} as const

export type VendorName = keyof typeof VENDOR_RATE_LIMIT

/** How many calls to ask for, per vendor. Absent or 0 asks for nothing. */
export interface VendorCallReservation {
  tracerfy?: number
  fastappend?: number
}

/**
 * How long a bucket row is kept before pruning.
 *
 * FIFTEEN MINUTES, and the number changed with the window. Buckets are one SECOND wide now, so a
 * saturated vendor writes up to 60 rows a minute rather than one, and an hour of them is 3,600 per
 * vendor for no benefit: the claim only ever reads the last 60 seconds. Fifteen minutes keeps the
 * table around 900 rows per vendor and still leaves a live check (Task 9, Step 7) able to read back
 * the windows a run drew from minutes after it finished.
 */
const WINDOW_RETENTION_MS = 15 * 60 * 1000

/**
 * Which per-minute pool each step draws from.
 *
 * EXHAUSTIVE BY TYPE, deliberately, the same way executeRoute's CONTACT_VENDOR_BY_STEP is: a new
 * StepKind is a compile error here until somebody says which vendor's limit it spends, rather than
 * silently reserving nothing and tripping that limit in production.
 *
 * NOT THE SAME MAP AS executeRoute's, and the difference is the dossier. That map answers "which
 * CONTACT vendor was asked" and maps DOSSIER_APN and DOSSIER_ADDRESS to null, correctly, because a
 * dossier finds the owner rather than their contacts. This map answers "whose rate limit does this
 * call spend", and a dossier spends Tracerfy's: the endpoint's own header says the counter is shared
 * with Instant Trace, Enhanced Trace, Phone Verification and APN Instant Lookup.
 */
const POOL_BY_STEP: Record<StepKind, VendorName> = {
  DOSSIER_APN: 'tracerfy',
  DOSSIER_ADDRESS: 'tracerfy',
  TRACERFY_INSTANT_NAMED: 'tracerfy',
  TRACERFY_PARCEL_APN: 'tracerfy',
  FASTAPPEND_ENTITY: 'fastappend',
}

/**
 * What these steps would spend, per vendor.
 *
 * Called with ONE step by the Tier 1 lane's canSpend hook, which is the hot path, and with a whole
 * plan's steps once per record by the tier 2 cron. The list form is what the tests assert the pool
 * assignment on, because a list is how you read it.
 */
export function reservationForSteps(
  steps: ReadonlyArray<{ kind: StepKind }>
): VendorCallReservation {
  const out: Required<VendorCallReservation> = { tracerfy: 0, fastappend: 0 }
  for (const step of steps) out[POOL_BY_STEP[step.kind]] += 1
  return out
}

/**
 * Reserve these calls against the trailing 60 seconds. TRUE when every vendor granted.
 *
 * All or nothing across vendors. The Tier 1 lane asks for one call of one vendor, because
 * `reservationForSteps([step])` is what it passes; the tier 2 cron asks once per record for
 * `reservationForSteps(plan.steps)`. The multi-vendor form is what makes both a special case of one
 * rule rather than two rules.
 */
export async function reserveVendorCalls(
  adminClient: SupabaseClient,
  want: VendorCallReservation
): Promise<boolean> {
  // FIXED ORDER, so two workers asking for the same two vendors take the two advisory locks in the
  // same sequence and cannot deadlock against each other. It is belt-and-braces with per-call
  // claiming, because a single step draws ONE vendor and so takes one lock, but the multi-vendor form
  // is still reachable and a lock order that depends on object key order is not an order.
  const vendors: VendorName[] = ['tracerfy', 'fastappend']
  for (const vendor of vendors) {
    const calls = want[vendor] ?? 0
    if (calls <= 0) continue
    const { data, error } = await adminClient.rpc('claim_vendor_rate', {
      p_vendor: vendor,
      p_calls: calls,
      p_limit: VENDOR_RATE_LIMIT[vendor],
    })
    if (error) {
      // AN UNREADABLE BUDGET IS NOT A BUDGET OF PLENTY. Refusing costs one minute of waiting;
      // assuming costs a rate limit that is shared across every customer's jobs. The console is
      // the only operator channel PTP has (lib/suite/alert.ts is one tagged console.error and its
      // own docstring says to wire it to a real channel first).
      console.error(
        `[vendor-rate-budget] refusing ${calls} ${vendor} call(s): could not read the budget (${error.message})`
      )
      return false
    }
    // ANYTHING BUT TRUE IS A REFUSAL, and `!== true` rather than `=== false` is the whole of it. A
    // null, an undefined or a shape nobody expected is a budget that did not answer, and spending
    // it as capacity is the fabricated result this module exists to prevent.
    if (data !== true) return false
  }
  return true
}

/**
 * Delete bucket rows older than WINDOW_RETENTION_MS.
 *
 * Called ONCE per cron run rather than from reserveVendorCalls, which runs up to 450 times a minute.
 * A saturated vendor writes up to 60 rows a minute, so this is what keeps the table at hundreds of
 * rows rather than tens of thousands. It is housekeeping and not a hot path.
 *
 * IT IS NOT WHAT BOUNDS THE RATE. The claim's own `window_start > now() - 60 seconds` is. If pruning
 * stopped entirely the budget would still be correct, just reading a bigger table, which is why this
 * function logs and swallows rather than failing a run.
 */
export async function pruneVendorRateWindows(adminClient: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - WINDOW_RETENTION_MS).toISOString()
  const { error } = await adminClient.from('vendor_rate_windows').delete().lt('window_start', cutoff)
  if (error) {
    // Never fatal: a window that outlives its hour costs a row, not a wrong answer.
    console.error(`[vendor-rate-budget] could not prune old windows: ${error.message}`)
  }
}
