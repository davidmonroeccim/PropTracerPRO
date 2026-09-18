import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import {
  recordHighLevelOutcomes,
  recordHighLevelPushes,
} from '@/lib/highlevel/credentialHealth';
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
 * be cut off before the work was even scheduled.
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
  /**
   * WHEN THE PUSH RUNS, AND BOTH ANSWERS ARE RIGHT SOMEWHERE. Required rather
   * than defaulted, because the two callers want opposite things and a default
   * would silently give one of them the wrong one.
   *
   * 'deferred'  hand it to after() so it runs once the response has flushed.
   *             Right on a request path: the customer is waiting for their
   *             trace result and must not wait for HighLevel as well.
   * 'inline'    await the push and the record before returning. Right in a
   *             cron, where nobody is waiting, and where deferring opens a real
   *             race: the row is written terminal, the parent bulk job can
   *             finalize on the very next poll, and a v1 finalize that reads
   *             the row before highlevel_pushed_at has landed pushes the same
   *             contact a second time. The skip that prevents that rests on the
   *             recorded push being THERE, so the cron has to finish writing it.
   */
  timing: 'deferred' | 'inline';
}): Promise<void> {
  const { userId, trace, result, isSuccessful } = params;

  if (!isSuccessful || !result) return;

  const credential = await params.resolveCredential();
  const apiKey = credential?.highlevel_api_key;
  const locationId = credential?.highlevel_location_id;
  if (!apiKey || !locationId) return;

  const push = pushTraceToHighLevel({
    apiKey,
    locationId,
    traceResult: result,
    propertyAddress: trace.address || undefined,
    propertyCity: trace.city || undefined,
    propertyState: trace.state || undefined,
    propertyZip: trace.zip || undefined,
  });

  if (params.timing === 'inline') {
    // recordHighLevelOutcomes never throws, and a push that rejects would be a
    // bug in the client rather than a vendor refusal, so it is caught here the
    // same way the deferred path catches it: nothing reached the CRM, so
    // nothing is recorded and the credential is told nothing.
    const outcome = await push.catch((error) => {
      console.error('HighLevel push threw:', error);
      return undefined;
    });
    await recordHighLevelOutcomes(userId, [
      outcome === undefined ? undefined : { traceId: trace.id, outcome },
    ]);
    return;
  }

  await recordHighLevelPushes(userId, [{ traceId: trace.id, push }]);
}
