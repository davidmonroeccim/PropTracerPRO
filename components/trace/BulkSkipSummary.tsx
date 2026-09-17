/**
 * The "we did not trace these rows, and here is why" block on a bulk job.
 *
 * WHY THIS EXISTS. David's rule for a bulk row that arrives with no owner name:
 * accept the file, skip the row with a reason, charge nothing, and put the
 * reason in the job summary AND the results CSV. `bulk/download` shipped the
 * CSV half. Until this existed the screen had no half at all: a user who
 * uploaded 100 rows with 40 blank owners watched the job finish and saw those
 * 40 come back as a bare `no_match`, which reads as "we looked and found
 * nobody" when no vendor was ever asked, and had to download a file to learn
 * otherwise.
 *
 * TWO RULES.
 *
 * 1. THE REASON IS PASSED IN, NEVER WRITTEN HERE. It comes from skipReasonFor()
 *    in lib/trace/blankOwnerSkip.ts by way of the bulk routes, which is the one
 *    accessor the API payload, the MCP payload and the CSV all read. A sentence
 *    typed into this file would be a fourth wording that only one person ever
 *    remembers to update. It also means this component covers both reasons a row
 *    goes untraced: a blank owner, which the customer can fix by resending the
 *    row, and an entity trace that ran out of attempts, which is our side
 *    failing to reach a vendor. Both are free; they are not the same thing to
 *    read.
 *
 * 2. NO COUNT, NO BLOCK; and no reason still shows the count. Rendering on a job
 *    where nothing was skipped would be a false statement in the other
 *    direction. A count with no reason is rare (the routes send them together)
 *    but it is still true, so the number is shown and nothing is invented to
 *    stand in for the missing sentence.
 *
 * There is no price here and there must never be one. These rows are free, and
 * the only rates in this product are per-caller.
 */
export function BulkSkipSummary({
  recordsSkipped,
  skipReason,
}: {
  /** How many rows of the job were accepted but never traced. */
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
      <p className="font-medium">We skipped {count} of your records.</p>
      {skipReason && <p className="mt-1">{skipReason}</p>}
    </div>
  );
}
