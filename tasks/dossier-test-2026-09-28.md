# THE DOSSIER TEST. 2026-09-28. Run, and the APN dossier key MISSED 2 of 2.

Counts and outcomes only. No owner names, streets or parcel ids. The records are in
`tasks/research-test/phase2b/records.json` as D1 and D2 (gitignored: real county owner data).

**Authorised $5 by David for two records. Cap passed: `--max-dollars 4.50`, strictly above the $4.00
whole-file worst case and below his ceiling. Spent: $0.50 charged, $0.00 vendor cost.**

## The headline

**`DOSSIER_APN` ran live for the first time in this project's history, and it found nothing on either
record.** Every prior phase (0, 1, 2A, 2B) exercised address-keyed paths only. The routing worked
exactly as `tasks/ROUTING-SPEC-AS-DAVID-STATED-IT.md` says it should. Tracerfy has no parcel at
either key.

**Both records were billed $0.25 anyway, and the customer is told nothing about why.** That is the
finding that matters, and it is below under THE BILLED SILENT MISS.

## What was proven, against the six things the test had to show in order

| # | What it had to prove | Result |
|---|---|---|
| 1 | `DOSSIER_APN` is actually sent, keyed apn + county + state, no situs | **PROVEN** |
| 2 | It comes back with an owner name | **NO. Missed on both.** |
| 3 | PTP classifies the discovered owner | not reached |
| 4 | Individual -> Tracerfy for contacts | not reached |
| 5 | Entity -> FastAppend on name + state | not reached |
| 6 | The row settles honestly and the step log records which key answered | **HALF. Settles honestly. There is no step log at all.** |

### How item 1 was proven, three independent ways

1. **Before the spend**, `parcelForFullTrace` + `planRoute` (the identical call
   `app/api/v1/trace/bulk/route.ts:231` makes) emitted `DOSSIER_APN` as the ONLY step on both
   records, with request `{apn, county, state}` and no situs step, because neither record has a city.
2. **`vendor_rate_windows` recorded `tracerfy` `calls_used: 2` at `13:36:45Z`**, the second the job
   settled (`completed_at 13:36:46.623Z`). Two calls, two records, one dossier each.
3. **Nothing else could account for those two calls.** The pre-flight measured every queue empty, and
   `trace_history` holds exactly 2 rows created system-wide since 13:30Z, both on this job. One
   `trace_jobs` row exists since 13:00Z.

### The mutation that proves these records test what shipped on 2026-09-28

`validateAddressInput` (the question the three submits asked BEFORE the fix) returns
`{valid: false, error: "City is required"}` for both records. `canDiscoverOwner` (the question they
ask now) returns `true` for both. Before the fix these two rows were filed no-key, free and never
traced. This test could not have been run at all a day ago.

## The run

| Id | ST | County | Type | tier | property_trace_status | status | charge | vendor cost | steps | key |
|----|----|--------|------|------|----------------------|--------|--------|-------------|-------|-----|
| D1 | NC | Pitt | residential | 2 | `property_trace_done` | `no_match` | 0.25 | 0.00 | none | APN |
| D2 | TX | Randall | residential | 2 | `property_trace_done` | `no_match` | 0.25 | 0.00 | none | APN |

Both counties were fresh: verified against all 66 (state, county) pairs any live vendor call has
touched across every phase. Both records are genuinely city-less IN THE REGISTRY, so this is the
shape a gateway caller would pass, not one manufactured by dropping a city we hold.

- Job `44715ee4-7672-4afe-8e66-c20e766fc572`, v1 API surface, **`completed` in 23.9s UNPOLLED**,
  crons undriven, status route never opened. Rows reached `property_trace_done` within 15s.
- `property_trace_done` on attempt 1, never `queued_2`, which is the code's own way of saying the
  dossier ANSWERED rather than could-not-be-asked. The answer was "no parcel here".
- Money exact and as forecast: wallet $11.73 -> $11.48 -> $11.23, two ledger debits of $0.25 at the
  pro tier-2 rate. The $10.00 auto-rebill threshold was never approached. No card charge.
- D36 holds on both: `createAddressHash(traceKeyFor(input))` matches the stored `address_hash`, on
  the `APN|` key form with a street present and no city.

## THE BILLED SILENT MISS. The most important thing this test found.

A tier 2 record is billed per RECORD SUBMITTED, so a miss is billed. That is correct and settled.
What is not correct is what the customer is then told.

`rowSkipReason(row)` returns **null** for these rows, by three steps:
`propertyTraceSkipReason('property_trace_done')` is null; `tier1MaySpeak` is false because
`trace_job_id` is set and `ai_research_status` is not a tier-1 value; `skipReasonFor(null)` is null.

**So the customer pays $0.25, sees `no_match`, and receives no sentence at all.** They are not told
that we looked the property up by its parcel id, that the data provider has no record of that
parcel, or that tier 2 is billed per record submitted whether or not it finds anything. The three
sentences that DO exist (`_failed`, `_no_key`, `_no_reach`) all describe cases where nothing was
spent. The billed-miss case, which is the one the customer is actually paying for, has no sentence.

This is the shape the whole Tier 1/Tier 2 initiative was built to serve, and on a miss it is silent
while charging. It is NOT in any existing handoff block, so per L-038 it is recorded here once and
raised, not described again.

## THE TIER 2 LANE HAS NO STEP LOG. Measured, not inferred.

`app/api/cron/sweep-property-traces/route.ts` contains the string `trace_steps` **zero times** and
passes **no `onStep`** to `executeRoute` (its deps are `lookupDossier`, `traceEntity`, `tracePerson`
and nothing else). `sweep-entity-traces`, the tier 1 cron, does write it.

So no tier 2 row has ever carried a step log, and item 6's "the step log records which key answered"
cannot be satisfied on this lane by any record. This also explains 2B's C5, a real $0.30 Tracerfy
hit that reported `steps none`: that was not a C5 quirk, it is the whole lane.

Without it there is no per-row audit trail of which dossier key was tried or what it answered. The
only reason this run could prove item 1 is `vendor_rate_windows`, which is a **pruning per-second
window** and had already lost everything older than this job. An hour later the evidence would have
been gone.

## What this does NOT say

- It does **not** say the APN dossier key is broken. It says Tracerfy returned no parcel for these
  two keys. Prior measured evidence is mixed in exactly this way: Salt Lake UT missed on APN and hit
  on address; Napa CA did the reverse.
- It does **not** measure a hit rate. Two records in two counties is a "does it work" sample, not a
  rate study (L-small-sample). The mechanism is proven end to end up to the vendor's own coverage.
- It does **not** clear the gateway. `ptp_skip_trace_bulk` and `ptp_skip_trace_quote` still declare
  `"required": ["address","city","state"]`, so a city-less parcel-keyed record still cannot reach PTP
  through the gateway. That is unchanged and is Phase 3.

## What it means for Phase 3 and D17

D17 is "records come from the registry; no registry owner means a dossier search the user is told
about". This run says the PTP half works and that the search can come back empty while still costing
the customer money. So the gateway's disclosure half is now carrying more weight than when it was
written: the user needs to be told not only that a dossier search is happening, but that it is billed
per record whether or not it finds an owner.

A second, separate Phase 3 risk, measured while selecting records: **NY Jefferson's registry
`parcel_id_local` is a 26-digit SWIS+SBL composite, not the tax map id the county prints.** Phase 3
has the gateway always passing `parcel_id_local` from the registry. Where that column holds a
registry-constructed composite rather than the county's own printed key, the APN dossier is being
handed something no vendor can recognise, and it will miss silently and bill. Measured on NY only;
not generalised to other states.
