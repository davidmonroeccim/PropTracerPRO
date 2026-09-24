# Tier 1 Phase 2A live check, 2026-09-24

Counts only. No owner names, streets, parcel ids, phone numbers or email addresses. The raw request
and response pairs are in `tasks/research-test/phase2a/` (gitignored).

Branch `feat/tier1-phase2a-queue-and-web-upload` at `146741e`, run against a LOCAL server pointed at
the production database. Job `f406e591-0205-4403-876d-160331373a77`, 20 records in one web bulk
upload, submitted by David in his own browser because that route authenticates by session cookie.

## Money, reconciled

| | figure |
|---|---|
| David's authorisation | $10 |
| Cap passed to the runner | `--max-dollars 6` |
| Worst case the runner computed from `VENDOR_COST` | $4.40 |
| **Actual vendor spend** (sum of `cost`) | **$1.70** |
| **Actual customer charge** (sum of `charge`) | **$2.10** |
| Wallet before | $14.33 |
| Wallet after | $12.23 |
| Difference | **$2.10, exact** |

Ledger: 12 debits, one per charged record. 3 x $0.25 "Full Property Trace - per record submitted" at
16:47:48, 9 x $0.15 "Skip trace - successful match" at 17:11:46-48. No row was charged twice and no
row was charged that should not have been.

**The rate column was PRO ($0.15 / $0.25), not pay-as-you-go.** David's profile is
`subscription_tier: 'wallet'` with `gateway_products: ['prop-tracer-pro']`, so `effectiveIsPro` is
true through the gateway grant. **This is the one profile shape that used to carry two different
prices**, and the L-030 collapse priced it once, correctly, end to end. The page quoted $3.40 before
submit and the actual charge came in under it because Tier 1 only bills on a found contact.

## Per record

State, county and property type are from the Task 9 record selection; outcome, charge, cost and
counts are read back from `trace_history`.

| Id | Path | State | County | Type | Outcome | found_by | charge | cost | ph | em |
|---|---|---|---|---|---|---|---|---|---|---|
| B1-1 | tier 1 person by address | WI | Racine | residential | `found_by_address` | address | 0.15 | 0.10 | 5 | 3 |
| B1-2 | tier 1 person by address | WV | Berkeley | commercial | `found_by_address` | address | 0.15 | 0.10 | 3 | 3 |
| B1-3 | tier 1 person by address | AL | Jefferson | multifamily | `found_by_address` | address | 0.15 | 0.10 | 8 | 1 |
| B1-4 | tier 1 person by address | MI | Kent | industrial | `found_by_address` | address | 0.15 | 0.10 | 7 | 3 |
| B2-1 | tier 1 person, NO CITY | NC | Iredell | commercial | `no_lookup_key` | - | 0.00 | 0.00 | 0 | 0 |
| B2-2 | tier 1 person, NO CITY | DE | Kent | multifamily | `no_lookup_key` | - | 0.00 | 0.00 | 0 | 0 |
| B2-3 | tier 1 person, NO CITY | MA | Berkshire | industrial | `no_lookup_key` | - | 0.00 | 0.00 | 0 | 0 |
| B2-4 | tier 1 person, NO CITY | MN | Anoka | residential | `no_lookup_key` | - | 0.00 | 0.00 | 0 | 0 |
| B3-1 | tier 1 company, NO CITY | OH | Muskingum | commercial | `no_match` | - | 0.00 | 0.00 | 0 | 0 |
| B3-2 | tier 1 company, NO CITY | AR | Garland | industrial | `found_by_company_name` | company_name | 0.15 | 0.10 | 8 | 3 |
| B3-3 | tier 1 company, NO CITY | TN | Montgomery | residential | `no_match` | - | 0.00 | 0.00 | 0 | 0 |
| B3-4 | tier 1 company, NO CITY | MA | Franklin | multifamily | `no_match` | - | 0.00 | 0.00 | 0 | 0 |
| B4-1 | tier 1 trust | WI | Brown | residential | `found_by_address` | address | 0.15 | 0.10 | 7 | 3 |
| B4-2 | tier 1 trust | SC | Charleston | residential | `found_by_address` | address | 0.15 | 0.10 | 8 | 3 |
| B4-3 | tier 1 trust | WV | Berkeley | commercial | `found_by_address` | address | 0.15 | 0.10 | 8 | 3 |
| B4-4 | tier 1 trust | WV | Berkeley | multifamily | `found_by_address` | address | 0.15 | 0.10 | 3 | 1 |
| B5-1 | tier 2, blank owner | NC | Forsyth | commercial | `property_trace_done` | - | 0.25 | 0.30 | 8 | 2 |
| B5-2 | tier 2, blank owner | WI | Milwaukee | industrial | `property_trace_done` | - | 0.25 | 0.20 | 0 | 0 |
| B5-3 | tier 2, blank owner | TX | Cameron | multifamily | `property_trace_failed` | - | 0.00 | 0.00 | 0 | 0 |
| B5-4 | tier 2, blank owner | MI | Kent | residential | `property_trace_done` | - | 0.25 | 0.30 | 8 | 3 |

B2-4 and B5-3 were bound to their rows by elimination rather than by address join, because address
normalisation shortens the street (19 characters to 16, and 17 to 9). Both leftovers matched on lane
and on outcome, and no record is unaccounted for.

## The step ladder

| kind | outcome | count |
|---|---|---|
| `TRACERFY_INSTANT_NAMED` | hit | 8 |
| `FASTAPPEND_ENTITY` | **skipped** | 4 |
| `FASTAPPEND_ENTITY` | miss | 3 |
| `FASTAPPEND_ENTITY` | hit | 1 |

16 steps across 16 Tier 1 records. The four B4 trust records each planned BOTH rungs, hit on
Tracerfy, and **skipped** FastAppend: the ladder stops at the first hit (D2). The four B2 records
emitted **no step at all**.

## The shared vendor rate budget

| vendor | buckets | calls reserved | vendor calls the step logs show |
|---|---|---|---|
| tracerfy | 4 | **8** | 8 |
| fastappend | 1 | **4** | 4 |

**Reserved EQUALS spent on both vendors.** The plan's Step 7 requires the Tier 1 lane's share never
to exceed its step log, because a higher figure means something reserved for a call it did not make.
It is exact. A **skipped** rung claimed nothing (FastAppend reserved 4, not 8), which is the per-call
`canSpend` hook working: the claim happens immediately before the call and never for a call the
ladder decided not to make. Buckets span 17:11:44 to 17:11:47, one row per wall-clock second, which
is the sliding-window shape Task 6 built.

## Latency

Pass 1 of the cron drained all 16 queued Tier 1 records in **8,599 ms**; pass 2 found the queue
empty in 1,815 ms. Spec 3.2's target is a 500-record job clearing in roughly 2 to 5 minutes.
Per-record latency was not separately captured and is not claimed here.

## What each path PROVED

- **B1, person by address.** 4 for 4. The queue's happy path bills once, at the Tier 1 rate, with
  `found_by: address` and `contact_vendor: tracerfy`.
- **B2, person with NO CITY. This is the capability the phase exists for and it is the most important
  line in this document.** All four reached the queue, settled `tier1_done` / `no_lookup_key`, emitted
  **zero steps**, called **no vendor**, cost **$0.00**, charged **$0.00**, and wrote **no ledger row**.
  Before this phase the browser discarded these eight rows silently. A record that cannot be looked
  up now says so and costs nothing.
- **B3, company with NO CITY. A city-less row genuinely traces.** B3-2 came back
  `found_by_company_name` on FastAppend, from a name and a state alone, with no city anywhere. The
  other three returned `no_match`, free, which is a legitimate answer and not a defect.
- **B4, the trust ladder.** 4 for 4 on the first rung, with the second rung **skipped** rather than
  bought. Both lanes really are in one record and the ladder really does stop at a hit.
- **B5, tier 2 blank owner.** The other queue was not disturbed: `ai_research_status` stayed NULL on
  all four, so Phase 2A did not put a blank-owner row on the Tier 1 queue, which would have billed it
  twice. **B5-2 is the clean proof of David's per-request ruling:** its dossier named nobody reachable,
  it returned 0 phones and 0 emails, `is_successful` is false, and it was still charged $0.25. Billed
  per record submitted, whatever the result, exactly as disclosed on the page before submit.
- **The price model.** A gateway-grant-only profile priced as PRO on every one of the 12 charged
  records, through one derivation.
- **The CSV.** 105 columns, 20 data rows, columns **104 and 105** are `found_by` and `outcome_code`,
  after the dossier block. No cell anywhere contains `APN|`. The outcome counts in the export match
  the database exactly.
- **The customer sentences**, all three honest and all three matching the money:
  - `no_lookup_key`: "This record is missing the city and the parcel ID, so it could not be looked up. You were not charged. Send it again with the city or the parcel ID."
  - `no_match` company: "We looked this owner up by company name and found no match. You were not charged."
  - `property_trace_failed`: "We could not reach the property records service for this address after 5 tries, so nothing was traced and you were not charged."

## What it did NOT prove, and this list is exhaustive

1. **The Tier 2 lane's rate-budget reservation (Task 6) was NOT exercised.** Production's own Vercel
   cron drained all four B5 rows 50 seconds after submit, because the local server points at the
   production database. Those rows ran on `origin/main` code, which has none of Task 6's 99 lines.
   `vendor_rate_windows` shows zero Tier 2 contribution, which is the evidence. **The B5 rows prove
   the Tier 1 queue did not disturb the Tier 2 queue. They prove nothing about this branch's Tier 2
   changes.**
2. **No parcel/APN path ran.** The web surface sends no parcel id (D5), so `TRACERFY_PARCEL_APN` was
   never reachable. It remains unproven in production, as it was after Phase 1.
3. **Throttling never fired.** `throttled: 0`. The budget was never under pressure at 16 records, so
   the refusal path, the release-to-the-same-rung behaviour and the no-attempt-spent guarantee are
   still only unit-tested.
4. **The stale-claim ladder never ran.** `busy: 0`, `errored: 0`, `staleReverted: 0`. No vendor
   failure, no dead claim, no `busy_try_again` row, no `tier1_failed` row.
5. **The resume-from-step-log path never ran**, because nothing crashed mid-record.
6. **Throughput was not tested at scale.** 16 records, not 500. Spec 3.2's 2-to-5-minute figure
   remains a calculation pinned by a test, not a measurement.
7. **Job completion through THIS branch's status route was not observed.** The job was finalized at
   17:50:13 by production's OLD `sweep-stale-traces` at the 60-minute cutoff, not by the branch's
   gate. `records_matched: 11` is correct, but it was computed by main's code.

## Defect found by this live check, open for David

**Nothing finalizes a bulk job promptly when its queue drains.** A web bulk job is marked `completed`
in only two reachable places: the bulk upload page's own poll loop while that tab is open, and
`sweep-stale-traces`, which by construction only reads jobs older than 60 minutes
(`.lt('created_at', cutoff)`). `app/(dashboard)/history/page.tsx` is a server component with no
polling, so opening History cannot finalize anything, and the Download and CRM buttons are gated on
`job.status === 'completed'` (`dashboard/page.tsx:325,331`; `history/page.tsx:228,248`).

So a customer who closes the tab, **which the upload page explicitly invites them to do**, sees
`Processing` with no export for up to an hour after their results are finished and billed. Observed
here: the last row settled at 17:11 and the job read `completed` at 17:50.

**PRE-EXISTING, not introduced by 2A**: `settleBulkJob` is only ever called from status routes on
`origin/main` too. But 2A makes it bite harder, because now every web row is asynchronous. It is not
on the plan's carried-to-2B list, so nobody owns it. Options put to David: fix inside 2A before the
review, make it the first 2B item, or ship and record. **Awaiting his named answer.**

## Observations recorded, no change proposed

- **The `no_lookup_key` sentence's parcel-ID half is not actionable on this surface.** It reads "Send
  it again with the city or the parcel ID", and the web upload has no parcel id column (D5). The
  sentence is generated from a shared template (`lib/trace/tier1Outcome.ts:104`) that the v1 API also
  uses, where the parcel-ID half IS true. The city half is actionable here, so the advice is partly
  rather than wholly inapplicable. **Record B2-3 was chosen specifically to surface this and it did.**
- **The header badge says "Pay-As-You-Go" while billing the Pro rate.** `getTierBadge()`
  (`components/dashboard/Header.tsx:68`) switches on `subscription_tier` directly, not on
  `effectiveIsPro`. Customer-facing copy, in the customer's favour on price, out of 2A's scope.
- **On the History page the Download and CRM column sits behind a horizontal scrollbar**, which is why
  it reads as absent there and present on the dashboard.
- **`CRON_SECRET` was missing from `.env.local`** and the runner refuses without it. Production has one
  set in Vercel. A local-only value was appended; the original 82 lines are byte-identical.
