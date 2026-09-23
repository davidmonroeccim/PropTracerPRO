# Phase 1 live check (Task 12)

Date: 2026-09-22
Status: **NOT RUN.** The owner's HARD STOP: gates, the runner, and the read-only sample selection
are done; the runner's `--plan` (dry-run) mode ran and is reported below. No vendor was called, no
wallet was touched. The owner names a dollar amount before any dispatch runs `--live`.

Counts only below: no owner name, phone, email, street address or parcel id. County, state,
property type and path labels only.

## Sample (read-only, from the registry; secondary/tertiary markets only, none already tested)

| Id | Path | State | County | Property type | Why (see tasks/research-test/phase1/records.json for the full reasoning, gitignored) |
|---|---|---|---|---|---|
| L1 | tier1_address_person | NY | Onondaga (Syracuse metro, secondary/tertiary to NYC) | residential | Full street/city/zip; individual owner; tests the D2/D13 address-keyed Instant lookup and the D22/4.3 name-order and stray-comma edge case |
| L2 | tier1_apn_person | CO | Larimer (Fort Collins, secondary/tertiary to Denver) | residential | Parcel id and county only, no city; individual owner; tests D23's parcel-id-only path with no Instant fallback available |
| L3 | tier1_company | NV | Washoe (Reno, secondary/tertiary to Las Vegas) | multifamily | Name and state only, no address; LLC owner; tests D4's FastAppend entity lane |
| L4 | tier1_trust | OK | Tulsa (secondary/tertiary to Oklahoma City) | commercial | Full street/city/zip plus parcel id and county; trust name with a first name; tests the full trust ladder (D3): Instant, then parcel, then FastAppend fallback |
| L5 | tier2_apn_no_city | AR | Benton (Bentonville/Rogers, secondary/tertiary to Little Rock) | land | Parcel id and county only, no owner, no city; registry shows one individual owner of record; tests D24's dossier-by-parcel-id and D21 arm (c)'s mailing-address search |

None of IN or FL. Five different states. Not all one property type. None of these counties or
parcels appear anywhere under `tasks/research-test/` before this pick (checked against the phase0
small-sample counties and every older research folder).

## Worst case, computed via `planRoute(...).maxVendorCost` (resolution F-P11, never hard-coded)

Ran: `npx tsx tasks/research-scripts/phase1/run-live.ts --plan`

| Id | Path | Steps `planRoute` would ask | Worst case |
|---|---|---|---|
| L1 | tier1_address_person | TRACERFY_INSTANT_NAMED | $0.10 |
| L2 | tier1_apn_person | TRACERFY_PARCEL_APN | $0.10 |
| L3 | tier1_company | FASTAPPEND_ENTITY | $0.10 |
| L4 | tier1_trust | TRACERFY_INSTANT_NAMED + TRACERFY_PARCEL_APN + FASTAPPEND_ENTITY | $0.30 |
| L5 | tier2_apn_no_city | DOSSIER_APN, then 1 owner x worst-case single-owner ladder (Instant + parcel + FastAppend, D3, assuming a mailing address is found per D21 arm c) | $0.50 |

**Total worst case: $1.10.**

L5's per-owner figure assumes the worst plausible classification for the one owner the registry
names on that parcel (a trust, which is the most expensive single-owner ladder), because the
dossier has not run and its actual classification is unknown until it does. The registry itself
names exactly one owner of record for this parcel (no joint-owner marker), which is why the
multiplier is 1.

No vendor was called to produce this table: every figure comes from the production `planRoute()`
function run against the five request bodies, offline, with no network call and no database
access.

## What happens next

The owner names a dollar amount. A later dispatch runs:

```
npx tsx tasks/research-scripts/phase1/run-live.ts --live --max-dollars <the amount> --email <owner email>
```

which will refuse to run if $1.10 (or whatever the worst case computes to at that time, since the
runner recomputes it fresh from `planRoute` rather than reusing this number) exceeds the amount
given. Raw request/response pairs would land in `tasks/research-test/phase1/live.jsonl`
(gitignored); this report would then be extended with the actual HTTP status, outcome code,
found_by, step log and charge per record, still counts only.
