# THE COMMERCIAL COVERAGE TEST. 2026-09-28. 20 records, 4 arms, 10 counties, 10 states.

**Authorised $20. Cap passed `--max-dollars 19` against a $13.00 worst case. Spent $3.90 charged,
$1.50 vendor cost.** Wallet $111.23 -> $107.33. Job `f2dc14df-20ff-4d4f-9b56-6dd391f5b367`,
**`completed` in 48.0s UNPOLLED**, crons undriven, status route never opened.

The question: when the APN dossier misses, is it the vendor, the county record, or the key the
registry chose? The answer is **mostly none of those. It is PTP's own owner-name parsing.**

## The four arms

| Arm | Shape | Sent |
|---|---|---|
| A | registry holds NO owner name | blank owner + `parcel_id_local` |
| B | registry HOLDS an owner, withheld on the wire as ground truth | blank owner + `parcel_id_local` |
| C | owner SENT, pre-screened to an individual so the entity route cannot eat it | owner + `parcel_id_local` |
| D | the SAME parcel as its pair, carrying the COUNTY's own printed key | blank owner + county key |

Ten counties, none previously touched: MD Washington, UT Cache, MN Clay, NJ Atlantic, WA Yakima,
NC Buncombe, TN Hickman, AR Greene, ND Ward, WV Monongalia. Commercial was selected from each
county's OWN land-use vocabulary, never the curated `property_type` column (L-039).

## Results

| id | arm | ST county | status | ph/em | charge | vendor cost | reads as |
|---|---|---|---|---|---|---|---|
| A1 | no registry owner | MD Washington | no_match | 0/0 | 0.25 | 0.00 | dossier missed |
| **A2** | no registry owner | **UT Cache** | **success** | **7/2** | 0.25 | 0.30 | **hit + contacts** |
| A3 | no registry owner | MN Clay | no_match | 0/0 | 0.25 | 0.00 | dossier missed |
| A4 | no registry owner | NJ Atlantic | no_match | 0/0 | 0.25 | 0.00 | dossier missed |
| A5 | no registry owner | WA Yakima | no_match | 0/0 | 0.25 | 0.00 | dossier missed |
| B1 | owner withheld | NC Buncombe | no_match | 0/0 | 0.25 | 0.20 | **dossier HIT**, no contacts |
| **B2** | owner withheld | **TN Hickman** | **success** | **8/0** | 0.25 | 0.30 | **hit + contacts** |
| B3 | owner withheld | AR Greene | no_match | 0/0 | 0.25 | 0.20 | **dossier HIT**, no contacts |
| B4 | owner withheld | ND Ward | no_match | 0/0 | 0.25 | 0.00 | dossier missed |
| B5 | owner withheld | WV Monongalia | no_match | 0/0 | 0.25 | 0.00 | dossier missed |
| C1 | parcel rung | NC Buncombe | no_match | 0/0 | 0.00 | 0.10 | parcel RESOLVED, name rejected |
| C2 | parcel rung | TN Hickman | no_match | 0/0 | 0.00 | 0.00 | miss |
| **C3** | parcel rung | **AR Greene** | **success** | **5/5** | 0.15 | 0.10 | **hit, `found_by=parcel_id`** |
| C4 | parcel rung | ND Ward | no_match | 0/0 | 0.00 | 0.00 | miss |
| C5 | parcel rung | WV Monongalia | no_match | 0/0 | 0.00 | 0.00 | miss |
| D1 | county key | WA Yakima | no_match | 0/0 | 0.25 | 0.00 | dossier missed |
| **D2** | county key | **MN Clay** | **success** | **4/3** | 0.25 | 0.30 | **hit + contacts** |
| D3 | county key | ND Ward | no_match | 0/0 | 0.25 | 0.00 | dossier missed |
| D4 | county key | WV Monongalia | no_match | 0/0 | 0.25 | 0.00 | dossier missed |
| D5 | county key | TN Hickman | no_match | 0/0 | 0.25 | 0.00 | dossier missed |

`vendor_rate_windows` recorded 20 Tracerfy calls across the run's seconds (4+3+2+1+2+2+1+5), one per
record, so every record reached the vendor.

**On tier 2 the COST COLUMN is the only evidence of what the dossier did**, because
`sweep-property-traces` writes no step log (recorded this morning). It reads: $0.00 the dossier
missed, $0.20 it hit and the contact call found nobody, $0.30 it hit and contacts came back.

## Finding 1: the APN dossier works. This morning's 0 for 2 was sample size.

**5 of 15 tier-2 keys resolved (33%), and 3 returned contacts.** A2 UT Cache is the first complete
Tier 2 chain this application has ever run end to end on a parcel key: `DOSSIER_APN` -> owner name
-> classification -> contact lookup -> 7 phones and 2 emails, for $0.30 of vendor cost.

## Finding 2: TRACERFY_PARCEL_APN fired in production for the first time, and hit.

Unproven since Phase 1 and named as unproven in both 2A and 2B. C3 AR Greene:

```
TRACERFY_PARCEL_APN {"parcel_id":"1551-00199-000","county":"Greene","state":"AR",
                     "first_name":"ROBERT","last_name":"WHITE"}  outcome hit
found_by = parcel_id | outcome_code = found_by_parcel_id | 5 phones, 5 emails | charge $0.15
```

## Finding 3, and it is the answer: PTP mangles the owner name before the vendor ever sees it.

Arm C exists to test the parcel rung. It ended up testing `splitPersonName` and
`classifyOwnerName`, and they failed on **4 of 5 records**. Reproduced locally, no vendor call:

| County owner of record | classifyOwnerName | what PTP sent | correct |
|---|---|---|---|
| `BECK JAMES R;BECK HELEN` | individual | first `BECK`, last `HELEN` | first JAMES, last BECK |
| `VALLEY GENERAL CONTRACTING` | **individual** | first `VALLEY`, last `CONTRACTING` | it is a COMPANY |
| `BOTT, RUSSELL L` | individual | first `RUSSELL`, last **`BOTT,`** | the comma must go |
| `GRAY WAYNE` | individual | first `GRAY`, last `WAYNE` | assessor LAST FIRST |
| `WHITE ROBERT B & MARILYN J` | individual | first `ROBERT`, last `WHITE` | **correct** |

**One of five parsed correctly, and it is the one that hit.** C3 is `WHITE ROBERT B & MARILYN J`.

The cleanest proof is C1 NC Buncombe, which cost real money:

```
TRACERFY_PARCEL_APN {...,"first_name":"BECK","last_name":"HELEN"}
outcome name_not_matched | peopleCount 2 | creditsDeducted 5 | cost $0.10
```

**Tracerfy resolved the parcel and returned two people. PTP threw them away** because it had asked
for a person called "BECK HELEN". The vendor was right, the county record was right, the parcel key
was right, and we lost the lookup on a semicolon. `splitOwners` splits on `|` and `&`; the county
published `;`.

Defects, each reproducible with no spend:
1. `splitOwners` does not treat `;` as an owner separator.
2. `classifyOwnerName` calls `VALLEY GENERAL CONTRACTING` an individual. "contracting" is not in
   `isLikelyBusiness`'s indicator list either, but that function is not the one routing here.
3. `splitPersonName` leaves a trailing comma on the surname for the `LAST, FIRST MIDDLE` form, and
   its own docblock claims to handle assessor ordering.

## Finding 4: registry key vs county key is 1 to 1 to 3, not a one-way defect.

| County | registry `parcel_id_local` | county's own key | winner |
|---|---|---|---|
| MN Clay | `27027-250222000` MISS | `25-022-2000` **HIT, 4ph/3em** | **county key** |
| TN Hickman | `041003    00300` **HIT, 8ph** | `003    00300 00005003` MISS | **registry key** |
| ND Ward | `38101-CO000011600042` miss | `CO000011600042` miss | neither |
| WV Monongalia | `31050019000...` miss | `05  19000...` miss | neither |
| WA Yakima | `077-11130211900` miss | `11130211900` miss | neither |

**MN Clay proves the key form can decide a lookup outright** on an otherwise identical parcel. TN
Hickman proves the registry's choice is sometimes the better one. So `parcel_id_local` is worth
fixing, but the fix is "record BOTH keys and try each", not "the registry's key is wrong".

That also retires a claim I made earlier today. I told David five counties' keys diverge and implied
the registry's form was the defective one. On the evidence it is a coin flip.

**TN Hickman is also the record that nearly died to my own hand.** Its key is `041003    00300`
with four internal spaces. A `clean()` helper I wrote collapsed them to one; caught before the run
against `lessons.md:1503`. Collapsed, B2 would almost certainly have joined the misses, and it is
one of only three tier-2 successes.

## What this does NOT say

- It is not a hit rate. 15 tier-2 keys across 10 counties is a "does it work" sample.
- Arm A vs Arm B did not separate cleanly, which was the original hypothesis. A (no registry owner)
  went 1 of 5; B (registry has an owner) went 1 of 5 for contacts and 3 of 5 for dossier resolution.
  Whether the county publishes owners does not predict whether Tracerfy knows the parcel.
- Nothing here re-tests the gateway. `ptp_skip_trace_bulk` still requires `address`+`city`+`state`.

## What to do next, in value order

1. **Fix the three owner-name defects.** Cheapest, entirely PTP-side, fully reproducible offline,
   and on this sample it is the difference between 1 of 5 and up to 4 of 5 on the parcel rung.
2. **Carry both parcel keys and try each.** Misses are free, so a second key costs nothing unless it
   works, which is the same argument `planRoute` already makes for the two dossier keys.
3. **Give the tier 2 lane a step log.** Every tier-2 conclusion above was inferred from the cost
   column because `sweep-property-traces` writes none.
4. **Give a settled tier 2 miss a sentence.** Still silent, still billing $0.25. 12 of 15 tier-2
   records here charged the customer and said nothing.
