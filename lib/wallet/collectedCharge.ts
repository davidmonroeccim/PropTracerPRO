import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The amount ALREADY collected against a trace_history row, or null if nothing
 * has been.
 *
 * WHY THIS EXISTS. deductOrZero moves real money the instant it is called, and
 * the row is only written back afterwards. Anything that throws in between
 * leaves the wallet lighter with nothing on the row to show for it, and the next
 * pass over that row charges again. supabase-js returns errors rather than
 * throwing, so it takes an unusual failure to get there, but nothing made the
 * second charge impossible.
 *
 * THE SEQUENCE THAT REACHES IT WITHOUT ANY UNUSUAL FAILURE, found in review:
 * sweep-entity-traces deducts on a FastAppend hit and then throws, so the row is
 * requeued. On the retry FastAppend returns nothing, the row goes down the
 * Tracerfy path instead, and settleBulkJob charges it a second time. Two
 * different files, one row, two debits. That is why this guard cannot live in
 * either one of them alone.
 *
 * WHY THE LEDGER AND NOT A COLUMN. `deduct_wallet_balance` already writes a
 * wallet_transactions debit carrying the trace_history_id it charged
 * (supabase/schema.sql). That row is durable, it is written in the SAME
 * transaction as the balance change, and it is keyed on exactly the thing we
 * need to be idempotent about. A new `charged_at` column would be a second
 * record of the same fact, and a second record can disagree with the money.
 *
 * WHY ANY DEBIT COUNTS, not just one written by the caller. A debit against this
 * row means the customer has already paid for this row, whichever path booked
 * it. Charging again because the description does not match would be billing
 * twice for one answer.
 *
 * A SHORT WALLET LEAVES NOTHING BEHIND. deduct_wallet_balance returns FALSE
 * before it inserts anything, so a row whose first attempt could not be paid for
 * has no ledger entry and is still chargeable, which is correct: no money moved.
 *
 * NOT a replacement for the deduct's own atomicity. This is a guard against
 * charging the same row twice across separate passes, not a lock.
 */
export async function collectedChargeFor(
  adminClient: SupabaseClient,
  traceHistoryId: string
): Promise<number | null> {
  const { data } = await adminClient
    .from('wallet_transactions')
    .select('amount')
    .eq('trace_history_id', traceHistoryId)
    .eq('type', 'debit')
    .limit(1)

  const prior = (data as Array<{ amount: number | string | null }> | null)?.[0]
  if (!prior) return null
  return Number(prior.amount) || 0
}
