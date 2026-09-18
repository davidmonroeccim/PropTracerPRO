import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import { recordHighLevelPushes } from '@/lib/highlevel/credentialHealth';
import type { TraceResult } from '@/types';

/**
 * PUSH WHERE THE ROW SETTLES, NOT WHERE THE JOB FINALIZES.
 *
 * Every automatic HighLevel push used to hang off JOB-settlement code that
 * walks Tracerfy's batch array. A Full Property Trace (tier 2) row never has a
 * `tracerfy_job_id` -- it is nulled the moment the row settles -- so every push
 * list built that way was blind to it, and tier 2 results reached the CRM on
 * exactly one of five surfaces.
 *
 * This is the shape those surfaces share: a single row, just written terminal,
 * with contacts on it. It is called from the three ROW-settlement points:
 *
 *   app/api/cron/sweep-property-traces  bulk, and it covers all THREE bulk
 *                                       submit surfaces (session, v1 and MCP),
 *                                       because all three enqueue into the same
 *                                       property_trace_status column.
 *   app/api/trace/single                tier 2 settles INLINE here
 *   app/api/v1/trace/single             and here
 *
 * The push feeds lib/highlevel/credentialHealth like every other site, so a 401
 * on one of these paths flags the credential and the record of the push lands
 * on the row. Nobody is watching any of them, so that flag is the only channel
 * they have.
 */

/** The two profile columns a push needs. Named so a caller can pass a whole profile row. */
export interface HighLevelCredentialColumns {
  highlevel_api_key?: string | null;
  highlevel_location_id?: string | null;
}

/** The settled row, in the terms every caller already has it in. */
export interface SettledTraceRow {
  id: string;
  /** normalized_address on the bulk path, the normalized address on the singles. */
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

/**
 * Push one settled trace to the customer's CRM, and record that it got there.
 *
 * THE GUARD IS `isSuccessful && result` AND BOTH HALVES CARRY WEIGHT. The next
 * reader will see a non-null `trace_result` and think the null check is the
 * whole test. It is not: the two BILLED MISS shapes both carry a non-null
 * result and neither may ever reach a customer's CRM.
 *
 *   property_trace_no_reach  the contact vendor could not be ASKED. The row
 *                            holds owner_name_2 from the dossier with EMPTY
 *                            phones and emails, and `is_successful: false`.
 *   a contact-vendor MISS    the vendor answered and has no record of this
 *                            owner. Same shape, same emptiness.
 *
 * Under a bare `trace_result != null` both push a nameless, contactless contact
 * into the customer's CRM, which is junk in the one place a customer cannot
 * tolerate junk. `no_match` is excluded by either half, since its trace_result
 * is null, so it is NOT the case that decides this.
 *
 * AWAITED BY ITS CALLERS, and that is deliberate. The credential has to be
 * resolved before anything can be handed to `after()`, so a floating call could
 * be cut off before the work was even scheduled. Once scheduled, the push
 * itself outlives the response.
 */
export async function pushSettledTrace(params: {
  userId: string;
  /**
   * Resolves the credential, and is only called when a push is actually going
   * to happen. A resolver rather than a value so the guard below lives in ONE
   * place: the cron would otherwise have to repeat it to avoid a profile read
   * on every settled row, and a duplicated guard is a guard that drifts.
   */
  resolveCredential: () => Promise<HighLevelCredentialColumns | null | undefined>;
  trace: SettledTraceRow;
  result: TraceResult | null;
  isSuccessful: boolean;
}): Promise<void> {
  const { userId, trace, result, isSuccessful } = params;

  if (!isSuccessful || !result) return;

  const credential = await params.resolveCredential();
  const apiKey = credential?.highlevel_api_key;
  const locationId = credential?.highlevel_location_id;
  if (!apiKey || !locationId) return;

  await recordHighLevelPushes(userId, [
    {
      traceId: trace.id,
      push: pushTraceToHighLevel({
        apiKey,
        locationId,
        traceResult: result,
        propertyAddress: trace.address || undefined,
        propertyCity: trace.city || undefined,
        propertyState: trace.state || undefined,
        propertyZip: trace.zip || undefined,
      }),
    },
  ]);
}
