import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The amount ALREADY collected against a trace_history row, NET of anything
 * handed back, or null if the wallet has never touched the row at all.
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
 * WHY IT IS A NET, AND WHY A REFUND USED TO BE INVISIBLE HERE. Two settle sites
 * refund a historical AI-research fee and then call this to avoid
 * double-charging the row (sweep-business-traces, settleBulkJob). A refund is a
 * CREDIT, and before migration 20260917 `credit_wallet_balance` did not take a
 * trace_history_id at all -- a credit could not name the row it belonged to, so
 * this probe, which summed debits alone, reported money that had been HANDED
 * BACK as still collected. The probe answered non-null, deductOrZero was
 * skipped, and the customer got the contacts free while `trace_history.charge`
 * reported an amount that was no longer in our pocket. The credit links now, and
 * the only honest reading of a ledger holding both is the difference.
 *
 * ZERO AND NULL ARE DIFFERENT FACTS, AND CALLERS GATE ON `> 0`. Null means the
 * wallet has never touched this row; 0 means money moved in both directions and
 * settled back to nothing (a row whose only debit was refunded). Both mean "no
 * money is currently collected here, charging is correct", so every caller tests
 * `collected !== null && collected > 0` rather than `!== null`. The distinction
 * is kept HERE because collapsing it would leave this helper unable to say which
 * happened, and because a caller that ever needs to tell them apart -- an audit,
 * a receipt, a reconciliation -- cannot recover the difference once it is lost.
 *
 * LIMITATION, DELIBERATE, NOT A BUG TO FIX LATER. Credits written before
 * 2026-09-17 carry a NULL trace_history_id and can never be back-linked, so the
 * net cannot see them. That is knowingly accepted rather than worked around: the
 * 743 rows carrying `ai_research_charge > 0` are all settled (nothing in
 * 'processing', no pending business_trace_jobs), the research fee was retired
 * with the AI Search engine so no new row can acquire one, and the refund arms
 * that produce these credits are gated on `ai_research_charge > 0`. This is a
 * forward-correctness fix. Do NOT add compensating subtraction for unlinked
 * credits: it would have to guess which unlinked credit belongs to which row,
 * and a guess in this function is a guess about whether to charge a customer.
 *
 * NOT a replacement for the deduct's own atomicity. This is a guard against
 * charging the same row twice across separate passes, not a lock.
 */
export async function collectedChargeFor(
  adminClient: SupabaseClient,
  traceHistoryId: string
): Promise<number | null> {
  // NO `type` FILTER, AND THAT IS THE FIX. This query used to end
  // `.eq('type', 'debit')`, which is precisely what made a refund invisible: a
  // credit that never comes back cannot be subtracted. `type` is SELECTED
  // instead, and the classification happens below where both signs are in view.
  const { data } = await adminClient
    .from('wallet_transactions')
    .select('amount, type')
    .eq('trace_history_id', traceHistoryId)

  const ledger = data as Array<{ amount: number | string | null; type?: string | null }> | null
  if (!ledger || ledger.length === 0) return null

  // EVERY DEBIT, NOT ONE OF THEM. Three settle sites write this answer into
  // `trace_history.charge` RAW rather than folding, on the grounds that the
  // value already IS the money -- which is the entire justification for their
  // ALLOWED_RAW_WRITES exemption, and it only holds if the answer is a TOTAL.
  //
  // This was `.limit(1)` with no ORDER BY and no aggregate, so on a row
  // carrying two debits Postgres returned whichever one it liked and the site
  // wrote that single amount over the row. A row that had really collected
  // $0.50 was recorded as $0.25, under-reporting what the customer paid on
  // every surface that SUMs the column. Two debits on one row is not exotic:
  // UNIQUE(user_id, address_hash) means the row is REUSED, so a tier 2 record
  // purchase and a later tier 1 contact charge against the same address both
  // point at it.
  //
  // A DEBIT ADDS, EVERYTHING ELSE SUBTRACTS. `wallet_transactions.type` is
  // CHECKed to ('credit', 'debit', 'refund', 'auto_rebill') and three of those
  // four ADD balance, so "not a debit" means "money returned to the customer".
  // Written as an allow-list on 'debit' rather than a deny-list on 'credit' so
  // a type nobody anticipated errs toward charging money that is genuinely owed
  // rather than skipping a charge the customer never paid -- the safe direction
  // for a guard whose failure mode is billing the same row twice.
  //
  // An unreadable amount counts as 0 rather than poisoning the total with NaN,
  // and the sum is rounded to cents because two floats added give
  // 0.30000000000000004 and this lands in a DECIMAL column shown as money.
  const net = ledger.reduce((sum, row) => {
    const n = typeof row.amount === 'number' ? row.amount : Number(row.amount)
    const magnitude = Number.isFinite(n) ? n : 0
    return sum + (row.type === 'debit' ? magnitude : -magnitude)
  }, 0)

  return Math.round(net * 100) / 100
}
