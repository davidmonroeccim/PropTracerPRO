/**
 * The "these rows came back with no contacts, and here is why" block on a bulk
 * job.
 *
 * WHY THIS EXISTS. A row that comes back empty must never reach the customer as
 * a bare `no_match`, which reads as "we looked and found nobody" when that is
 * not what happened. `bulk/download` puts the reason in the results CSV. This is
 * the on-screen half, so nobody has to download a file to find out why a third
 * of their upload has no phone numbers on it.
 *
 * ------------------------------------------------------------------------
 * ITS PREMISE CHANGED IN PHASE 5c, AND THE HEADING CHANGED WITH IT
 * ------------------------------------------------------------------------
 *
 * This component was written for ONE situation: a bulk row with no owner name
 * was skipped, free, and the customer could fix it by resending the row. It said
 * "We skipped N of your records", and its header said outright that there is no
 * price here and there must never be one, because these rows are free.
 *
 * Both statements are now wrong for one of the five reasons it carries.
 * `property_trace_no_reach` is a row we did NOT skip: we bought the county
 * property record, billed it per record submitted, and then could not reach the
 * contact vendor. Telling that customer we skipped their record is false, and
 * telling them it was free is a false statement about their own money.
 *
 * SO THE HEADING MAKES NO MONEY CLAIM AT ALL, and each reason sentence carries
 * its own. That is the same shape phase 5c-3A used for a partial submit failure,
 * which states a charge for the tier 2 survivors and deliberately states nothing
 * about the entity survivors, because a blanket claim would be false in the
 * other direction. With two billing models in one product, a summary line that
 * covers rows from both can only state the count; money belongs in the sentence
 * that knows which model the row is on.
 *
 * The heading that survives says the one thing true of all five: we could not
 * get contacts for these rows.
 *
 * ------------------------------------------------------------------------
 * TWO RULES, BOTH UNCHANGED
 * ------------------------------------------------------------------------
 *
 * 1. THE REASON IS PASSED IN, NEVER WRITTEN HERE. It comes from rowSkipReason()
 *    in lib/trace/rowSkipReason.ts by way of the bulk routes, which is the one
 *    accessor the API payload, the MCP payload and the CSV all read. A sentence
 *    typed into this file would be a fifth wording that only one person ever
 *    remembers to update. It is also what lets this component carry all five
 *    reasons without knowing anything about tiers: a blank owner, an entity
 *    trace that ran out of attempts, a dossier vendor we could not reach, a row
 *    with no usable address, and the billed row above. Four are free and one is
 *    not, and the sentences say so individually.
 *
 * 2. NO COUNT, NO BLOCK; and no reason still shows the count. Rendering on a job
 *    where every row was traced would be a false statement in the other
 *    direction. A count with no reason is rare (the routes send them together)
 *    but it is still true, so the number is shown and nothing is invented to
 *    stand in for the missing sentence.
 */
export function BulkSkipSummary({
  recordsSkipped,
  skipReason,
}: {
  /** How many rows of the job came back with no contacts for a stated reason. */
  recordsSkipped: number | null | undefined;
  /** Why, in the routes' own words. Null when the route did not say. */
  skipReason: string | null | undefined;
}) {
  const count = recordsSkipped || 0;
  if (count < 1) return null;

  return (
    <div
      data-testid="skipped-summary"
      className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="font-medium">We could not get contacts for {count} of your records.</p>
      {skipReason && <p className="mt-1">{skipReason}</p>}
    </div>
  );
}
