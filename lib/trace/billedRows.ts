/**
 * The one definition of "this row has been paid for", and the guard that keeps
 * every DELETE off it.
 *
 * WHY THIS EXISTS
 * `trace_history` rows are not just cache entries, they are receipts:
 * `wallet_transactions.trace_history_id` and `usage_records.trace_history_id`
 * both REFERENCE trace_history(id) with NO ON DELETE clause (supabase/schema.sql),
 * which is ON DELETE NO ACTION. Deleting a referenced row does not cascade and
 * does not null out -- it FAILS with 23503. Migration 20260904's header
 * documents hitting exactly that.
 *
 * Until 2026-09-17 none of the ten delete sites on trace_history checked its
 * error, so a refused delete looked like a successful one. The row survived,
 * the code carried on as though it had not, and the INSERT that followed died
 * on UNIQUE(user_id, address_hash) -- surfacing to the customer as a generic
 * 500 that named nothing and left the address permanently un-retraceable.
 *
 * Tier 2 makes that far worse. It introduces a row shape that never existed:
 * `is_successful = false` AND `charge > 0`. The customer paid for an 86-field
 * property record; contacts are a separate step that may return nothing. The
 * old `delete ... eq('is_successful', false)` sweep targets that shape exactly.
 */

/** Billing model that produced a trace_history row. Mirrors `trace_history.tier`. */
export const TRACE_TIER = {
  /** Tier 1: billed per SUCCESSFUL trace. A no-match is free. */
  PER_SUCCESSFUL_TRACE: 1,
  /** Tier 2: billed per RECORD SUBMITTED. A no-match IS billed. */
  PER_RECORD_SUBMITTED: 2,
} as const;

/** The three markers of a row the customer has paid for. */
export interface BillableTraceRow {
  charge?: number | string | null;
  ai_research_charge?: number | string | null;
  property_record?: unknown;
}

/**
 * True when the customer has paid for anything this row carries.
 *
 * `property_record` counts even at `charge = 0`, because under tier 2 the
 * property record IS the thing that was bought; the contact step that sets
 * `charge` may never have run. Postgres DECIMAL arrives from PostgREST as a
 * string in some client configurations, so both amounts are coerced.
 */
export function isBilledRow(row: BillableTraceRow | null | undefined): boolean {
  if (!row) return false;
  if (row.property_record !== null && row.property_record !== undefined) return true;
  return toAmount(row.charge) > 0 || toAmount(row.ai_research_charge) > 0;
}

function toAmount(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** The slice of the PostgREST builder this guard needs. Keeps it client-agnostic. */
interface FilterableQuery {
  or(filters: string): FilterableQuery;
  is(column: string, value: null): FilterableQuery;
}

/**
 * Narrows a DELETE (or SELECT) so it can never match a billed row.
 *
 * Emits the NOT of `isBilledRow`, pushed into the database rather than
 * evaluated here, so there is no read-then-delete race:
 *
 *   (charge IS NULL OR charge <= 0)
 *   AND (ai_research_charge IS NULL OR ai_research_charge <= 0)
 *   AND property_record IS NULL
 *
 * supabase-js sends each `.or()` as its own `or=` query parameter and PostgREST
 * ANDs the top-level parameters together, so two `.or()` calls are a conjunction
 * of two disjunctions, which is what is wanted. The IS NULL arms matter: a NULL
 * amount is not `<= 0` in SQL, and without them a row with a NULL charge would
 * be excluded from the sweep and never cleaned up.
 */
export function excludeBilledRows<Q extends FilterableQuery>(query: Q): Q {
  return query
    .or('charge.is.null,charge.lte.0')
    .or('ai_research_charge.is.null,ai_research_charge.lte.0')
    .is('property_record', null) as Q;
}

/** PostgREST filter matching rows that are a free cache hit for the caller. */
export const CACHE_HIT_FILTER = 'is_successful.eq.true,property_record.not.is.null';
