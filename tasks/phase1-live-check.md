# Phase 1 live check, 2026-09-23. RUN. Counts only, no contact data.

Plan Task 12. Owner's approved spend $2. Runner's computed worst case $1.10.
**Vendor spend: $0.20. Customer charge to the owner's own wallet: $0.55** (14.88 -> 14.33, reconciled exactly).

One record per lookup path, five secondary and tertiary counties, none reused from Phase 0. Sent through
the real `POST /api/v1/trace/single` on a local server pointed at production, on branch
`fix/api-gate-gateway-grants` (not on main: main still prices a gateway grant as pay-as-you-go, so the
check would have measured the bug the branch fixes). Raw request and response pairs are in
`tasks/research-test/phase1/live.jsonl` (gitignored, real purchased contact data). Nothing below names a
person, phone, email, street or parcel.

An earlier attempt on 2026-09-23 was refused five times with HTTP 403 by the v1 entitlement gate and spent
$0.00; that defect, its fix, and its deploy are History 2026-09-23 (b) and (c). Those five blocked
attempts are archived at `tasks/research-test/phase1/live-403-blocked.jsonl`.

## Results

| # | Path | County | Steps run | Outcome | found_by | Phones | Emails | Vendor | Charged |
|---|---|---|---|---|---|---|---|---|---|
| L1 | tier 1, person by address | NY Onondaga | `TRACERFY_INSTANT_NAMED:hit` | `found_by_address` | address | 6 | 3 | $0.10 | **$0.15** |
| L2 | tier 1, person by APN | CO Larimer | `TRACERFY_PARCEL_APN:miss` | `no_match` | none | 0 | 0 | $0.00 | $0.00 |
| L3 | tier 1, company | NV Washoe | `FASTAPPEND_ENTITY:miss` | `no_match` | none | 0 | 0 | $0.00 | $0.00 |
| L4 | tier 1, trust | OK Tulsa | `INSTANT:hit -> PARCEL_APN:skipped -> FASTAPPEND:skipped` | `found_by_address` | address | 6 | 3 | $0.10 | **$0.15** |
| L5 | tier 2, parcel, no city | AR Benton | `DOSSIER_APN:miss` | **none stored** | none | 0 | 0 | $0.00 | **$0.25** |

Latency: 4.4 s and 4.1 s on the two hits, 1.5 to 2.0 s on the three misses. All five HTTP 200.

## What each path PROVED

- **L1, the D13 Instant lookup with a supplied owner name: works end to end.** One step, one hit, a
  name-matched individual with contacts, `found_by` reported, `match_confidence` 80, charged once.
- **L2 and L3: a miss is genuinely free, on both vendors.** $0.00 vendor and $0.00 customer on each, with
  `no_match` and a `skipReason` sentence in the response. Spec 4.3 and D8 behave as written.
- **L4: the trust ladder is planned whole and stops at the first hit.** All three rungs appear in the step
  log, rungs 2 and 3 recorded `skipped` after rung 1 hit. A trust name that still has a usable first name
  gets the person steps, so it is not being mistaken for D16's entity-only path.
- **D36's parcel duplicate key fires in production.** L2 and L5 (parcel + county, no street) stored an
  `APN|`-keyed row; L1 and L4 (street present) stored street-keyed rows; L3 (name and state only) stored
  the documented state-only `||STATE` shape. Each of the five is a single-trace row (`trace_job_id` NULL),
  so D33's sentence rule applies to them.
- **The pricing collapse is live and correct.** The owner's account is tier `wallet` with a
  `prop-tracer-pro` gateway grant, which is the one shape the collapse moves. It was charged the PRO rates
  throughout: $0.15 per tier 1 success and $0.25 for the tier 2 record. Before the collapse the same five
  records would have cost $0.25, $0.25 and $0.40, i.e. **$0.90 instead of $0.55.**
- **No contact swapping.** L1 and L4 both returned 6 phones and 3 emails, which looked like the old batch
  path's row-mixing defect (spec 1, item 4). Hash-compared: different phones, different emails, different
  owners. Coincidence, not a swap.

## What each path did NOT prove, and one thing it left worse

- **The APN person lookup is still thinly proven.** L2 was the only test of it and it missed. That is
  exactly spec Section 13's named risk ("7 of 12 California parcels returned a flagged owner ... Phase 0
  decides whether the APN step earns its place"). One record cannot condemn it and did not vindicate it.
  The step ran, sent the right shape and cost nothing, so the plumbing is proven; the yield is not.
- **The FastAppend entity lane has now missed 3 for 3 across two live runs.** Phase 0 had two LLCs come
  back "Company not found"; L3 is the third. Spec Section 10 anticipated exactly this ("Anything it
  disproves comes out of this design before Phase 1, for example the FastAppend half of the trust ladder
  if it never hits"). Three misses is not proof of nothing working, but it is the only evidence there is,
  and it all points one way.
- **The trust ladder's fallback rungs are unexercised.** L4 hit on rung 1, so `TRACERFY_PARCEL_APN` and
  `FASTAPPEND_ENTITY` on a stripped trust name have still never run live.
- **L5: a Tier 2 record was charged $0.25, cost us $0.00, returned nothing, and was given no reason.**
  The stored row has `outcome_code` NULL, `found_by` NULL and `contact_vendor` NULL, and the API response
  carries no `outcomeCode`, no `foundBy` and no `skipReason` at all. It says only `status: "no_match"`.
  The two Tier 1 misses each carried a `skipReason` sentence; the paying Tier 2 miss carried none.
  This was a known, recorded deferral, not a surprise (Phase 1 plan carried item 7, "Tier 2 single keeps
  today's failure answer in Phase 1", and a Task 10 deferred minor recorded that the tier 2 branch omits
  `foundBy`/`outcomeCode`). The live check turns it from a note into a measured fact with money on it:
  spec **D10** says every record reports an outcome code and a sentence, and this record reports neither.
  Also worth the owner's eye: the stated justification for billing Tier 2 per record submitted is that
  "the county dossier lookup is spent on submission whether or not contacts follow" (lib/constants.ts).
  On L5 it was not spent. The vendor charged $0.00 for the miss and the customer was charged $0.25.
  That is the documented model working as designed, but the reason given for it does not hold on a miss.
  **Flagged for the owner; no code changed on the strength of it.**

## Housekeeping

The owner's account had no API key, so one was minted with the same generator the app's own Settings
button uses, and revoked immediately after the run; before and after, `api_key` and `api_key_created_at`
both read NULL. The local server was started with `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED=true` to match
production, verified by `/api/auth/suite/start` answering 307 locally exactly as it does live, rather
than by editing `.env.local`.
