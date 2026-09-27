import type { createAdminClient } from '@/lib/supabase/admin';

/**
 * How many trace_history rows go into one upsert.
 *
 * The same 500 all three bulk submit surfaces already used under three different local names
 * (`BATCH_SIZE` twice, `BULK_BATCH_SIZE` once). It is also the record cap, so a batch that reaches
 * the cap is one statement.
 */
export const HISTORY_BATCH_SIZE = 500;

/** The service-role client the bulk submits already build; passed in rather than built here. */
type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Writes trace_history rows for a bulk submit, in batches, and THROWS on the first failure.
 *
 * IT THROWS BECAUSE THIS WRITE IS THE SUBMIT. Every bulk surface used to console.error the upsert
 * error and carry on, which was survivable only while the tier 1 half had a real failure path of
 * its own: the Tracerfy person CSV submit could fail, and each route corrected records_submitted,
 * wrote the accepted rows terminal and told the customer which half failed and that it was free.
 * Phase 2A and 2B delete that submit on every surface, so there is nothing left between the caller
 * and this upsert. A swallowed error means: the handler answers success with records_submitted
 * counting rows that were never written; the status route finds zero pending rows on its first poll
 * and finalizes the job `completed` with records_matched 0; and its own early return makes that
 * verdict permanent. The customer sent 500 rows, was told it worked, and downloads an empty CSV.
 *
 * The message names the batch size rather than the rows, because the rows carry addresses.
 *
 * WHY IT IS SHARED AND THE WEB ROUTE'S COPY IS NOT DELETED. app/api/trace/bulk/route.ts keeps its
 * own local closure: it was written in Phase 2A and other tasks in this phase are editing around
 * it. This module exists so the v1 route and the Suite MCP submit do not become a second and third
 * copy of a function whose whole point is one behaviour on failure.
 */
export async function insertHistoryRows(
  adminClient: AdminClient,
  rows: Record<string, unknown>[]
): Promise<void> {
  for (let i = 0; i < rows.length; i += HISTORY_BATCH_SIZE) {
    const { error: insertError } = await adminClient
      .from('trace_history')
      .upsert(rows.slice(i, i + HISTORY_BATCH_SIZE), { onConflict: 'user_id,address_hash' });
    if (insertError) {
      throw new Error(
        `could not write ${rows.length} trace_history row(s): ${insertError.message}`
      );
    }
  }
}
