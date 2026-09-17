import Link from 'next/link';
import { isFullPropertyTrace } from '@/lib/trace/fullPropertyTrace';
import { chargePerRecord } from '@/lib/suite/pricing';
import type { EntitlementProfile } from '@/lib/suite/entitlements';

/**
 * Pre-submit disclosure for Full Property Trace (tier 2).
 *
 * WHY THIS EXISTS. A submit with no owner of record bills per RECORD SUBMITTED,
 * and a total miss is billed too (app/api/trace/single/route.ts, step 4). The
 * customer can pay and receive nothing, so they have to be told before they
 * click, not after they are charged.
 *
 * TWO RULES, and neither is negotiable.
 *
 * 1. IT SHOWS EXACTLY WHEN THE ROUTE WOULD BILL TIER 2. The predicate is
 *    isFullPropertyTrace(), the same function the route bills from, rather than
 *    a second "is it blank" test that can drift away from it. A whitespace-only
 *    owner name is blank to the biller, so it is blank here too, and the opt-in
 *    toggle is passed straight through: the route bills tier 2 on EITHER
 *    trigger, so the disclosure has to fire on either trigger. The two cases
 *    open with different sentences because they are different situations. The
 *    customer who opted in already has the owner name and would be confused by
 *    a notice telling them they do not. There is only ever ONE price sentence.
 *
 * 2. THE NUMBER IS THE CALLER'S OWN RATE, or there is no number. The rate is
 *    derived here, from the profile, via chargePerRecord() -- the same helper
 *    the route charges with -- so no caller can hand this component a rate and
 *    get it wrong. Until the profile has loaded (or if it never does) `profile`
 *    is null and the copy carries no figure at all, because quoting $0.25 to a
 *    Pay-As-You-Go customer who will be charged $0.40 is a false statement
 *    about money. An honest sentence with no number beats a confident wrong one.
 */
export function FullTraceDisclosure({
  ownerName,
  profile,
  fullPropertyTrace = false,
}: {
  /** The owner name field's current value, verbatim. */
  ownerName: string;
  /** The caller's own profile, or null while it is still loading. */
  profile: EntitlementProfile | null;
  /** The opt-in toggle, verbatim: the caller has the owner and wants the record anyway. */
  fullPropertyTrace?: boolean;
}) {
  if (!isFullPropertyTrace({ owner_name: ownerName, full_property_trace: fullPropertyTrace })) {
    return null;
  }

  const rate = profile ? chargePerRecord(profile) : null;
  // The opening depends on WHICH trigger fired. A blank owner name is the
  // reason tier 2 runs at all, so it wins when both are true.
  const optedIn = fullPropertyTrace && Boolean(ownerName.trim());

  return (
    <div
      role="note"
      data-testid="full-trace-disclosure"
      className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
    >
      {optedIn ? (
        <>
          You asked for the property record, so this runs as a Full Property Trace. We pull the
          full property record for this address and find contacts for the owner of record.
        </>
      ) : (
        <>
          No owner name, so this runs as a Full Property Trace. We go find the owner of record and
          pull the full property record for this address.
        </>
      )}{' '}
      {rate === null ? (
        <>
          You are charged at your per-record rate whether or not we come back with contacts.{' '}
          <Link href="/settings/billing" className="font-medium underline">
            Check your rate on the billing page.
          </Link>
        </>
      ) : (
        <>
          Your rate is ${rate.toFixed(2)} per record, and you are charged whether or not we come
          back with contacts.
        </>
      )}
    </div>
  );
}
