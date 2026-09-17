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

/**
 * PostgREST filter matching rows that are a free cache hit for the caller.
 *
 * THREE arms, and the third one is not optional:
 *
 *   is_successful = true          contacts were delivered (tier 1, and tier 2 with contacts)
 *   property_record IS NOT NULL   the 86-field property record was bought (a tier 2 hit)
 *   tier = 2 AND charge > 0       a BILLED tier 2 row, whatever it contains
 *
 * The third arm exists for one row shape that matches neither of the others: a
 * tier 2 MISS. Tier 2 bills per record SUBMITTED, so the county having no
 * parcel at that address is still billed -- `tier = 2`, `charge > 0`,
 * `property_record IS NULL`, `status = 'no_match'`, `is_successful = false`.
 * Without this arm that row is invisible to the cache and the next submit
 * re-buys it, billing the customer a second time for the same absence. David,
 * 2026-09-17: a billed tier 2 row is served from the database whatever it
 * contains.
 *
 * `charge.gt.0` and not `charge.not.is.null`: a row where the wallet deduct
 * returned false collected nothing, so there is no purchase to serve back and
 * re-buying it is correct.
 *
 * `and(...)` is PostgREST's conjunction inside an `or=`; the two columns must
 * be tested together, because `charge > 0` alone would swallow every tier 1
 * row and `tier = 2` alone would swallow an uncharged one.
 */
export const CACHE_HIT_FILTER =
  'is_successful.eq.true,property_record.not.is.null,and(tier.eq.2,charge.gt.0)';

/** The columns CACHE_HIT_FILTER reads. */
export interface CacheHitRow extends BillableTraceRow {
  is_successful?: boolean | null;
  tier?: number | string | null;
}

/* ------------------------------------------------------------------ *
 * RECEIPTS ARE MONOTONIC.
 *
 * `charge` and `tier` are receipts, not scratch fields, and until 2026-09-17
 * two settle paths wrote over them. The sequence, reachable with NO error on
 * ordinary usage:
 *
 *   1. Trace an address with no owner. Tier 2 charges per RECORD SUBMITTED;
 *      the county has no parcel, so the row lands `tier = 2, charge > 0,
 *      property_record = NULL, status = no_match`.
 *   2. Trace the SAME address again WITH an owner name. It goes tier 1, the
 *      billed row survives the guarded deletes and is reused, and the status
 *      route settles it: `charge` overwritten with 0, `tier` with 1.
 *   3. The row now reads UNBILLED to excludeBilledRows while a
 *      wallet_transactions row still references it by FK.
 *   4. The next submit's failed sweep targets it, Postgres raises 23503,
 *      runDelete collects the error, and that address answers
 *      "Failed to clear previous trace" FOREVER.
 *
 * Downgrading `tier` alone does the second half of the damage on its own:
 * isCacheHitRow's third arm is `tier = 2 AND charge > 0`, so a billed tier 2
 * MISS stops being a cache hit and the customer re-buys the same absence.
 *
 * A ROW THAT WAS BILLED MUST NEVER BECOME UNBILLED. Both rules below are
 * one-way.
 * ------------------------------------------------------------------ */

/** What a settle wants to write, and what the row already carries. */
export interface BillingWrite {
  /** The amount THIS settle actually collected. Never the intended amount. */
  charge: number;
  /** The billing model THIS settle applied. */
  tier: number;
}

/**
 * Folds a settle's collection into the receipt already on the row.
 *
 * `charge` ACCUMULATES rather than replacing. The row is one receipt per
 * (user, address) -- UNIQUE(user_id, address_hash) guarantees it -- and it is
 * reused rather than re-inserted, so a second genuine purchase against the same
 * address is a second real debit in `wallet_transactions`. Replacing would drop
 * the earlier one from SUM(trace_history.charge) and under-report what the
 * customer was charged; accumulating keeps that sum in agreement with the
 * ledger. Passing a collection of 0 therefore changes nothing, which is the
 * property that closes the lockout.
 *
 * `tier` never downgrades. A row that was billed per RECORD SUBMITTED keeps
 * saying so, because that is what both the delete guard and the cache filter
 * read. A row that only ever saw tier 1 is untouched by this.
 */
export function foldBillingWrite(
  existing: CacheHitRow | null | undefined,
  write: BillingWrite
): BillingWrite {
  const collectedBefore = toAmount(existing?.charge);
  const tierBefore = Number(existing?.tier);

  return {
    charge: round2(collectedBefore + toAmount(write.charge)),
    tier: Number.isFinite(tierBefore) && tierBefore > write.tier ? tierBefore : write.tier,
  };
}

/**
 * Two amounts in cents added as floats give 0.30000000000000004, and this value
 * is written to a DECIMAL column, summed on the dashboard and shown as money.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The two tables whose rows are FK receipts pointing INTO trace_history. */
const LEDGER_TABLES = ['wallet_transactions', 'usage_records'] as const;

/**
 * The slice of the client `hasLedgerReceipt` needs. Keeps it client-agnostic.
 *
 * `from` is declared as returning `unknown` on purpose. Describing its real
 * shape here makes TypeScript match this interface structurally against
 * SupabaseClient's generic `from`, which resolves the whole schema union and
 * trips TS2589 ("type instantiation is excessively deep"). Returning `unknown`
 * is a trivial check; the shape that matters is asserted at the call below,
 * where it is one query and not a whole client.
 */
interface LedgerLookupClient {
  from(table: string): unknown;
}

/** The three calls this makes on whatever `from` hands back. */
interface LedgerQuery {
  select(columns: string): {
    eq(column: string, value: string): {
      limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
    };
  };
}

/**
 * True when a ledger row REFERENCES this trace_history row, so deleting it
 * would raise 23503.
 *
 * `excludeBilledRows` derives billed-ness from trace_history's own columns,
 * which is exactly what failed above: once those columns were wrong, the guard
 * was wrong with them. This asks the ledger instead. It is the only thing that
 * can free an address whose receipt columns were ALREADY zeroed before the
 * monotonic rule landed, because for those rows the columns say "unbilled" and
 * only the FK still knows better.
 *
 * FAILS CLOSED. An error means we could not prove the row is unreferenced, and
 * an unprovable row must not be deleted: a refused delete is a 500 the customer
 * cannot get past, while a skipped delete just reuses the row in place, which
 * is what a billed row does anyway.
 */
export async function hasLedgerReceipt(
  client: LedgerLookupClient,
  traceHistoryId: string
): Promise<boolean> {
  for (const table of LEDGER_TABLES) {
    const { data, error } = await (client.from(table) as LedgerQuery)
      .select('id')
      .eq('trace_history_id', traceHistoryId)
      .limit(1);

    if (error) return true;
    if (Array.isArray(data) && data.length > 0) return true;
  }
  return false;
}

/**
 * The JS twin of CACHE_HIT_FILTER: true when this row is the customer's to be
 * served from the database, free.
 *
 * The SQL predicate gets the row OUT of the database; a caller still has to
 * decide to serve it rather than re-run the vendors, and that decision cannot
 * be made by re-deriving the rule in a route. Kept beside the filter so the two
 * are read, and changed, together.
 */
export function isCacheHitRow(row: CacheHitRow | null | undefined): boolean {
  if (!row) return false;
  if (row.is_successful === true) return true;
  if (row.property_record !== null && row.property_record !== undefined) return true;
  return (
    Number(row.tier) === TRACE_TIER.PER_RECORD_SUBMITTED && toAmount(row.charge) > 0
  );
}
