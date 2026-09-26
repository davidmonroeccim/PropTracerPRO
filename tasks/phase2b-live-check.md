# Tier 1 Phase 2B live check

**STATUS: NOT RUN. This is the skeleton the run fills in.** The build half is done: the gates, the
greps, the mutation table, the nine records and the runner with its five refusals proven. The spend
waits on David's dollar amount, and the CONTROLLER runs it, not the executor who built the runner.

Counts only. No owner names, streets, parcel ids, phone numbers or email addresses. Raw request and
response pairs go to `tasks/research-test/phase2b/live.jsonl` (gitignored: real purchased contact data).

Branch `feat/tier1-phase2b-api-and-mcp-queue` at `5abce8e`.

## The lane, decided before the run

**A branch deploy against the production database, with production's two per-minute crons paused for
the window. Branch code drains BOTH lanes.**

`origin/main` is at `2982627`, the Phase 2A merge, so main already knows `tier1_*`, and `vercel.json`
runs `sweep-entity-traces` and `sweep-property-traces` on `* * * * *`. 2A's accidental protection is
already gone. A local server pointed at production would lose both lanes to production's crons inside
60 seconds, and main carries none of Task 1 and Task 2's `finalizeTouchedJobs` wiring, so a job drained
by main would settle its rows and never write `completed_at`. Pausing production's two crons is a
precondition of the run, not a nicety.

- Production crons paused at: _NOT RUN_
- Branch deploy url (`PTP_BASE_URL`): _NOT RUN_
- Production crons resumed at: _NOT RUN_

## Money, to be reconciled

| | figure |
|---|---|
| David's authorisation | _NOT RUN_ |
| Cap passed to the runner | _NOT RUN_ |
| Worst case the runner computed from `VENDOR_COST` | **$2.80** (measured by `--plan`, 9 records) |
| Actual vendor spend (sum of `cost`) | _NOT RUN_ |
| Actual customer charge (sum of `charge`) | _NOT RUN_ |
| Wallet before | _NOT RUN_ |
| Wallet after | _NOT RUN_ |
| Difference | _NOT RUN_ |
| Ledger debits, one per charged record | _NOT RUN_ |

The worst case is derived from `VENDOR_COST` in `lib/routing/ownerRoute` (`DOSSIER 0.20`,
`FASTAPPEND_ENTITY 0.10`, `TRACERFY_INSTANT 0.10`, `TRACERFY_PARCEL 0.10`), never from a figure typed
into the script. Per Tier 1 record the ceiling is
`(hasSitus ? TRACERFY_INSTANT : 0) + (hasApn ? TRACERFY_PARCEL : 0) + FASTAPPEND_ENTITY`; per Tier 2
record it is `DOSSIER + owners * (that same ladder)`, where `owners` is a declared BUDGET because
D21(c) with D40 put no cap on how many owners a dossier names.

## Per record

State, county and property type come from the Step 3 record selection; everything else is read back
from `trace_history` by `--readback`, which never opens the status route.

| Id | Surface | Batch | Path | State | County | Type | Outcome | found_by | charge | cost | ph | em |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | v1 | v1-a | named, full address | NY | Chautauqua | commercial | _NOT RUN_ | | | | | |
| C2 | v1 | v1-a | named, NO city | NM | San Juan | residential | _NOT RUN_ | | | | | |
| C3 | v1 | v1-a | named, no city, apn+county | MS | Warren | land | _NOT RUN_ | | | | | |
| C4 | v1 | v1-a | blank owner, unusable address | CO | Garfield | unclassified | _NOT RUN_ | | | | | |
| C5 | v1 | v1-a | blank owner, good address | WI | Calumet | residential | _NOT RUN_ | | | | | |
| C6 | MCP | mcp-a | named, no city, apn+county | CO | Mesa | multifamily | _NOT RUN_ | | | | | |
| C7 | MCP | mcp-a | blank owner | WV | Cabell | residential | _NOT RUN_ | | | | | |
| C8a | v1 | v1-b | named, NO city | VT | Rutland | commercial | _NOT RUN_ | | | | | |
| C8b | v1 | v1-b | blank owner, unusable address | TX | Bell | residential | _NOT RUN_ | | | | | |

C8 is two FRESH records, not a re-send of C2 and C4: re-sending either would collide with its own
stored `address_hash` and be dropped as a duplicate, so the pairing would prove nothing.

## Per job

| Batch | Surface | `status` | `records_matched` | `completed_at` | Cron pass that drained it |
|---|---|---|---|---|---|
| v1-a | v1 | _NOT RUN_ | | | |
| mcp-a | MCP | _NOT RUN_ | | | |
| v1-b | v1 | _NOT RUN_ | | | |

**The thing only this phase can prove: the job must reach `completed` without anyone polling it.** The
status route must not be opened until after the read-back confirms `completed_at`, and `completed_at`
must not precede the cron run.

## D36: the stored key equals `traceKeyFor` of the input

Per record, `address_hash` against `traceKeyFor` of what was submitted. C3's and C6's are the ones that
matter: a city-less parcel-keyed record must store `APN|<parcel>|<COUNTY>|<ST>`, not `||<ST>`.

| Id | `traceKeyFor(input)` shape | stored `address_hash` shape | agree |
|---|---|---|---|
| _NOT RUN_ | | | |

## Amendment 9: the four LIVE column widths

The test added in Task 6 pins `TRACE_HISTORY_WIDTH` to the CHECKED-IN DDL (`supabase/schema.sql` for
`city` and `state`, `supabase/migrations/20260919_trace_history_parcel_key.sql` for `parcel_id_local`
and `county`), not to the live database. If production has drifted, that test still passes, and no unit
test can close it because tests never reach the live database. This is the only opportunity in the phase
to confirm the constant matches reality rather than a file. It is a free read.

| Column | `TRACE_HISTORY_WIDTH` | `character_maximum_length` in production | agree |
|---|---|---|---|
| `state` | 2 | _NOT RUN_ | |
| `city` | 100 | _NOT RUN_ | |
| `parcel_id_local` | 64 | _NOT RUN_ | |
| `county` | 64 | _NOT RUN_ | |

A constant WIDER than the column means the overflow this phase fixed is back. A constant NARROWER than
the column means records are being emptied for no reason. Either is a defect to stop and report, not a
note.

## Amendment 10: the legacy exposure count

Rows written by the v1 and MCP bulk submits BEFORE Tasks 4 and 6 added the reuse clear could return
`outcome_code: "no_match"` with `skip_reason: null`, and the owner-approved `bulk_status` description
reads that code as "the record was not charged". Ruling 32 now gates all three together, so the defect
is closed, but the affected population was never sized. `list_traces` has no date floor, so those rows
are re-pollable indefinitely. Free read:

    count trace_history rows where trace_job_id is not null
      and outcome_code is not null
      and (ai_research_status is null or ai_research_status not like 'tier1_%')

**Measured: _NOT RUN_.** If zero, the exposure was theoretical and the gating is belt-and-braces. If
not zero, that is the number of rows that could have told a customer "not charged" about a trace that
charged.

## `vendor_rate_windows`

Reserved must EQUAL the calls the step logs show, and must never exceed them.

| Lane | Reserved | Calls in the step logs | agree |
|---|---|---|---|
| _NOT RUN_ | | | |

## What this did NOT prove

_To be completed after the run, and it must be EXHAUSTIVE: an enumerated list stops the reader
searching, so an incomplete one is worse than none. Before writing it, ask what else is true of the
same kind rather than working from the list already here._

Already known to belong in it, from the build half:

1. **Nothing here tested the Suite Gateway end to end.** No task in Phase 2B touched the gateway repo
   and no call in this check went through the gateway. The gateway's own whole-batch rejection and its
   city guard are spec Section 10, Phase 3.
2. **The MCP submit was called IN PROCESS, not over the MCP transport.** `--live` calls
   `skipTraceBulk(admin, gatewaySub, ...)` directly, because `app/api/[transport]/route.ts` wraps the
   tools in `withMcpAuth` + `verifyToken` and that needs a gateway Supabase JWT no script can mint
   without a browser login. So `withMcpAuth`, `verifyToken`, the entitlement cache and the tool
   registration are all unexercised.
3. **A passing suite proves nothing about production column widths.** `lib/supabase/admin.ts:16` builds
   the client with no `Database` generic, so `tsc` checks neither column names nor widths, and the test
   doubles carry none. Only the Amendment 9 read above can speak to this.
4. **A record sent WITHOUT an `address` key is still refused** by `recordSchema`'s `address: z.string()`,
   as a thrown ZodError rather than a per-record verdict. `address: ''` is accepted. No record here
   exercises the omitted-`address` shape, and the runner refuses one on purpose so it cannot reach a
   paid run.
5. **A parcel-keyed record with a BLANK owner is still filed no-key and free**, because the usability
   question is `validateAddressInput(address, city, state)`, which has no parcel term. The tier 2 cron
   can in principle plan from the apn and county columns alone
   (`app/api/cron/sweep-property-traces/route.ts:202-218`), so the lane exists and nothing feeds it.
   Closing that is L-035 / D23 territory, which spec Section 10 keeps out of Phase 2B.
6. **The MCP submit success payload carries no `duplicates_removed`**, so with `no_lookup_key` present a
   caller reading `accepted: 2` on a three-record batch can tell "unlookupable" from "duplicate" only
   when `no_lookup_key > 0`. Pre-existing, not a Task 6 defect, and untouched here.
7. _add the rest after the run: what the outcome distribution did and did not cover, which tier 2 owner
   counts the dossiers actually named against the budget, whether any record hit the busy-resume path,
   and anything the paused-cron window means for concurrency claims._

## The gateway handoff

_To be written after the run. It must state exactly what PropTracerPRO now accepts that it did not
before, and what remains on the gateway side. Do not claim the end-to-end path works; no task in this
phase tested it._

What PTP now accepts, measured in Tasks 4 and 6:

- **An OMITTED `city` key is accepted**, and so is `city: ''`. The omitted key was the actual Zod
  blocker and it is the gateway's APN shape.
- **An OMITTED `address` key is still refused**, as a thrown ZodError rather than a per-record verdict.
  `address: ''` is accepted. Not fixed in this phase.
- **A parcel-keyed record must carry an `owner_name` to be traced at all.** Send one, or the record
  comes back free and untraced with a resendable reason. This is not a regression: before this phase the
  whole batch was refused for that same record.

What remains on the gateway side:

1. Its own whole-batch rejection.
2. Its city guard (spec Section 10, **Phase 3**).
3. **The gateway always passes `parcel_id_local` and `county` from the registry rather than leaving it
   to a model to decide** (David's ruling, 2026-09-25: *"The property is coming from the registry,
   either way, we should be choosing for them, not letting them choose something they know absolutely
   nothing about."*). This is the DESIGN, not a PropTracerPRO limitation. PTP has no registry access and
   is not supposed to have any: no `REGISTRY` env vars, one Supabase client which is its own, no
   registry query anywhere in `lib` or `app`, and `mcp-tools.ts:433` reads `record.apn` from whatever
   the caller sent. The two caller populations are separate: a trace originating in the PTP app never
   called the suite or the registry and needs no parcel id, because the address is its key; a suite or
   registry caller reaches PTP through Claude, and the registry has already produced `parcel_id_local`
   and `county` before PTP is called, so passing them is that path's job and not a model's judgement
   call. Task 7 makes the tool descriptions instruct rather than offer, which is PTP's whole share of it.
