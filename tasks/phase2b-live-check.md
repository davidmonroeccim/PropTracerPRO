# Tier 1 Phase 2B live check, 2026-09-27

Counts only. No owner names, streets, parcel ids, phone numbers or email addresses. The raw request and
response pairs are in `tasks/research-test/phase2b/` (gitignored).

**8 of 9 chosen records ran, across 7 of the 8 paths.** The ninth (C6) could not be sent at all, for a
reason that is itself a finding: see "C6, and why no route could carry it".

**Actual customer charge $0.50. Actual vendor cost $0.30.** Against a computed worst case of $2.80, a
$4.00 cap and a $5.00 authorisation.

---

## The lane, decided before the run

**Merged to `main` as a single `--no-ff` commit `495a012`, pushed, and deployed to production by Vercel's
git integration. Production's own crons then drained both lanes. NO cron was paused.**

This is not what the Task 8 brief proposed (a branch deploy with the two queue crons paused), and the
change is David's, made 2026-09-27. His reasoning was that he had told his users to hold off until the
update was complete. The premise needed one correction before it could be acted on: the race is not with
his users, it is with **Vercel's scheduler**, which runs `sweep-entity-traces` and `sweep-property-traces`
every 60 seconds against the production database on whatever code production carries. Telling people to
hold off does not stop it. So there were exactly two ways to make production's crons run the right code:
pause them, or make production *be* the branch. He chose the second.

**The blast radius was measured before the merge, not assumed.** Every queue was empty: zero rows in any
`tier1_queued*` status, zero queued property traces, and zero `trace_jobs` at `processing` (58 completed,
36 failed). So the deploy could touch nothing but this check's own records.

Verified after the deploy, rather than inferred from a green Vercel screen: deployment
`dpl_5KaE7N2dLLsBMtHqaMe5JjyCy8au`, `githubCommitSha` **495a012**, `state: READY`, `target: production`,
aliased to `proptracerpro.com` with `aliasError: null`.

**Which code drained which lane: branch code drained both**, because production is the branch. There is no
main-versus-branch mismatch left in this run, which is the one thing 2A could not arrange (its Tier 1 half
survived only because production could not see `tier1_*` statuses, and its four tier 2 rows were drained by
`origin/main` and proved nothing about 2A's tier 2 changes).

**Nobody drove the crons and nobody opened a status route.** The runner was given `--no-drain`. `.env.local`
holds a local-only `CRON_SECRET` appended during 2A, which returns HTTP 401 against production (measured),
and reading production's real secret is refused by the credential classifier. That turned out to be an
improvement rather than an obstacle: production's scheduler drained on its own timetable, so the job
completion claim below rests on nothing this session touched.

## Money, reconciled

| | figure |
|---|---|
| David's authorisation | $5.00 |
| Cap passed to the runner | `--max-dollars 4` |
| Worst case the runner computed from `VENDOR_COST` | $2.80 |
| **Actual customer charge** (sum of `charge`) | **$0.50** |
| **Actual vendor cost** (sum of `cost`) | **$0.30** |
| Wallet before | $12.23 |
| Wallet after | $11.73 |
| Difference | **$0.50, exact** |

Ledger: **2 debits, one per charged record**, both reading `Full Property Trace - per record submitted` at
**$0.25**. No row was charged twice and no row was charged that should not have been.

**Both charges are the PRO rate ($0.25), not pay-as-you-go ($0.40).** David's profile is
`subscription_tier: 'wallet'` with a gateway grant, so `effectiveIsPro` is true — the same single profile
shape 2A priced, priced once again here, through both the v1 API and the Suite Gateway.

**No Tier 1 charge appears anywhere, and that is correct**: every Tier 1 record returned `no_match` or
`no_lookup_key`, and Tier 1 bills only on a found contact.

### The auto-rebill trigger, checked before the run because Task 2 put it back on this path

Auto-rebill is **armed** on the profile: enabled, Stripe customer set, payment method set, amount $25.00,
and the threshold is `user_profiles.wallet_low_balance_threshold` = **$10.00** — read from
`check_wallet_needs_rebill`'s body, which does **not** read the `WALLET_MIN_BALANCE_THRESHOLD` env var.
Wallet was $12.23, so **$2.23 of headroom against a maximum possible customer charge of $1.75**. It did not
fire, and the wallet closed at $11.73. Had it fired it would have charged David's **card** $25.00, which is
outside the $5.00 he authorised; that is why it was measured and disclosed before the run rather than
discovered after it.

## Per record

State, county and property type are from the record selection. Everything else is read back from
`trace_history`. "key" is which form `traceKeyFor` derived, which is the D36 question.

| Id | Surface | Path | State | County | Type | tier 1 | tier 2 | outcome | vendor | charge | cost | matched | steps | key |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | v1 | named, full address | NY | Chautauqua | commercial | `tier1_done` | - | `no_match` | fastappend | 0.00 | 0.00 | no | 1 | address |
| C2 | v1 | named, **no city** | NM | San Juan | residential | `tier1_done` | - | `no_lookup_key` | - | 0.00 | 0.00 | no | 0 | address |
| C3 | v1 | named, no city, **+apn/county** | MS | Warren | land | `tier1_done` | - | `no_match` | fastappend | 0.00 | 0.00 | no | 1 | **APN** |
| C4 | v1 | blank owner, unusable address | CO | Garfield | unclassified | - | `property_trace_no_key` | - | - | 0.00 | 0.00 | no | 0 | address |
| C5 | v1 | blank owner, good address | WI | Calumet | residential | - | `property_trace_done` | - | tracerfy | **0.25** | **0.30** | **yes** | 0 | address |
| C7 | **MCP** | blank owner, via the real gateway | WV | Cabell | residential | - | `property_trace_done` | - | - | **0.25** | 0.00 | no | 0 | address |
| C8a | v1 | named, no city (mixed batch) | VT | Rutland | commercial | `tier1_done` | - | `no_lookup_key` | - | 0.00 | 0.00 | no | 0 | address |
| C8b | v1 | blank owner, unusable (mixed batch) | TX | Bell | residential | - | `property_trace_no_key` | - | - | 0.00 | 0.00 | no | 0 | address |
| C6 | MCP | named, no city, +apn/county | CO | Mesa | multifamily | **NOT SENT** | | | | | | | | APN |

`source` is `api` on the seven v1 rows and **`mcp`** on C7.

## Per job

| Batch | Surface | `records_submitted` | `records_matched` | Created | Completed | **Seconds** |
|---|---|---|---|---|---|---|
| v1-a (C1-C5) | v1 | 4 | 1 | 18:59:53.93 | 19:00:49.22 | **55.3** |
| v1-b (C8a, C8b) | v1 | 1 | 0 | 19:13:08.54 | 19:13:19.13 | **10.6** |
| mcp-a (C7) | MCP | 1 | 0 | 19:22:16.34 | 19:22:45.84 | **29.5** |

**All three reached `status: completed` with `completed_at` set, and not one of them was polled.** No status
route and no `bulkStatus` was opened at any point before the read-back, and the crons were not driven. This
is the single thing only this phase could prove, and it is proven three times on three independent jobs.

`records_submitted: 4` on v1-a and `1` on v1-b are correct: the no-key records (C4, C8b) are reported
separately as `recordsSkipped: 1` on each submit response, which is David's decision (d) working.

`records_matched: 1` on v1-a is the single `is_successful` row, C5. It agrees with the flat count David
ruled for in option C.

**For contrast, 2A's equivalent job took 39 minutes** (its rows settled 17:11, the job read `completed` at
17:50, finalized by the 60-minute `sweep-stale-traces` cutoff rather than by anything that knew the queue
had drained). That is the defect Tasks 1 and 2 existed to close, and 55.3 / 10.6 / 29.5 seconds is the
measurement of the close.

## Per-record judging, which is what Task 4 and Task 6 are for

**Batch v1-b is the proof, and it is one API call.** C8a (named, no city) and C8b (blank owner, unusable
address) were sent together. C8a settled `tier1_done` / `no_lookup_key`, free. C8b settled
`property_trace_no_key`, free. Neither killed the other and the batch was not rejected.

**Before Task 4 that call returned a whole-batch 400 naming one record's index.** Batch v1-a carries the
same result at larger scale: three different problems among five records, each judged on its own merits, one
of them billed and four free.

## D36: the stored hash equals `createAddressHash(traceKeyFor(input))`

**8 of 8 records MATCH**, including C3, whose key takes the **`APN|`** form (street present, city absent,
parcel and county both present) rather than the address form. Both key shapes are therefore verified against
production, which is the invariant Task 4 was kept indivisible to protect: `checkDuplicates` hashes with
`traceKeyFor` while the row builders store `normalizeAddress`, and they agree only if the key derivation and
the stored value cannot diverge.

**The check itself was wrong on its first run and it is worth recording.** As built it compared
`traceKeyFor(input)` — the plaintext normalised key — against `address_hash`, which stores
`createAddressHash(key)`, a sha256 hex digest. It can never match, and it reported **"HAS NO stored row" for
all 8 records on a system where D36 actually holds**. Had that been believed it would have read as the dedup
hash and the stored hash having diverged in production, which is the most serious thing this check looks for.
Fixed in commit `12b1b09`, which also makes the failure branch print the derived key shape so a future
failure says which form it built.

**Nothing in the repo could have caught it**: `tsconfig.json` excludes `tasks/research-scripts`, so
`tsc --noEmit` never typechecks the runner, and both sides of the comparison are `string`.

## Amendment 9: the four LIVE column widths

Read from production with a direct SQL session against `information_schema.columns`.

| Column | Live `character_maximum_length` | `TRACE_HISTORY_WIDTH` | Verdict |
|---|---|---|---|
| `state` | **2** | 2 | match |
| `city` | **100** | 100 | match |
| `parcel_id_local` | **64** | 64 | match |
| `county` | **64** | 64 | match |

**All four match exactly. Production has not drifted from the migrations.** A constant wider than the column
would mean this phase's `"Texas"` overflow is back; narrower would mean records are being emptied for
nothing. Neither.

**The runner cannot perform this read and the report must not imply it did.** `--readback` queries
`information_schema.columns` through PostgREST, which does not serve it (`Could not find the table
'public.information_schema.columns' in the schema cache`), and its select carries no `table_name` filter
either, so it would return every column of every table if it ever resolved. The runner prints that and tells
the operator to use a direct session, which is how these four numbers were obtained.

## Amendment 10: the legacy exposure count

    count trace_history rows where trace_job_id is not null
      and outcome_code is not null
      and (ai_research_status is null or ai_research_status not like 'tier1_%')

**ZERO.** Run two ways, because `_` is a LIKE wildcard: both `'tier1_%'` and the escaped `'tier1\_%'`
return 0. Measured against **1,291** rows carrying a `trace_job_id`, out of **3,866** total. Re-checked
after the run: still 0.

**So the exposure Ruling 32 closed was theoretical and the gating is belt-and-braces.** No row could have
told a customer "the record was not charged" about a trace that charged. The gate is still correct to exist —
it is what makes the claim safe for rows written from here on — but no historical row needed it.

## `vendor_rate_windows`: reserved versus spent

| Vendor | Calls reserved | Calls the evidence shows | Agreement |
|---|---|---|---|
| fastappend | 2 | 2 (`FASTAPPEND_ENTITY` / miss, C1 and C3) | **exact** |
| tracerfy | 2 | 2 (C5 at 19:00, C7 at 19:22) | **exact** |

**Reserved equals spent on both vendors; neither exceeded its step log.** A figure higher than the log would
mean something was reserved for a call that was never made.

**This is the first time the Tier 2 lane's rate budget has ever been exercised.** 2A's report lists it as
explicitly NOT proven, because production's own crons drained all four of its tier 2 rows on `origin/main`
code 50 seconds after submit and `vendor_rate_windows` showed zero tier 2 contribution. The table was
**empty** before this run, so every row in it is this check's.

**A methodological warning for whoever reads this table next: the windows are per-second buckets that
prune.** A single snapshot at the end understates the run. The figures above are cumulative across two
captures (3 calls at 19:07, 1 more at 19:25); reading only the final state would have shown `tracerfy=1`.

### The one number that disagreed with expectation, and what it turned out to be

C7 settled `property_trace_done` with **`cost: 0.0000` and `contact_vendor: null`**, while a tracerfy call
was reserved and used at 19:22:44 — one second before that job finalized, so the call is certainly C7's.
A tier 2 record that buys no dossier was not what the $2.80 worst case assumed.

It is consistent with every other row here rather than a defect: **a miss records $0.00 cost** on all three
observations in this run (both FastAppend misses and this Tracerfy one), where C5's successful trace recorded
$0.30. C7 was still charged $0.25 because tier 2 bills per record submitted whatever comes back, which is
what the tool description and the docs page both disclose before submit.

**What this check cannot establish is that an unsuccessful tier 2 is generally free.** 2A's B5-2 was also an
unsuccessful tier 2 and it recorded `cost: 0.20`. So the dossier's billability varies with how the lookup
fails, and one observation each way is not a rule. Recorded as an observation, not a finding.

## C6, and why no route could carry it

C6 is the named, **city-less**, `apn`+`county` record — the exact shape Task 6 exists to unblock, and the
only path not exercised (`mcp_named_no_city_apn`). All three routes to it were measured and all three are
closed:

1. **In process, as the runner was built.** `skipTraceBulk` reaches `checkDuplicates`, and
   `lib/utils/deduplication.ts:36` calls `createClient()` from `@/lib/supabase/server`, which calls
   `cookies()` and therefore requires a Next request scope. Outside a request it throws ``cookies` was
   called outside a request scope`. The module imports cleanly and the failure is at call time, after the
   confirm gate — proven by a `confirm: false` probe that returned `confirm_required` and spent nothing.
   **This is a defect in the runner's design, not in the product**: the real MCP route runs inside a request,
   where `cookies()` resolves. It was never caught because the executor correctly never passed `--live`.
2. **Through the Suite Gateway.** The gateway's own `ptp_skip_trace_bulk` schema declares
   `"required": ["address", "city", "state"]`, so a city-less record cannot reach PropTracerPRO through it at
   all. **The remaining blocker is gateway-side, exactly where spec Section 10 puts it (Phase 3).**
3. **A direct HTTP call to PTP's MCP endpoint.** `app/api/[transport]/route.ts` wraps the tools in
   `withMcpAuth` + `verifyToken`, which needs a gateway Supabase JWT that no script can mint without a
   browser login.

So the MCP surface's **Tier 1** lane, and the `APN|` key shape on the MCP surface, have no production
evidence. The `APN|` key shape **is** proven on the v1 surface by C3.

## What the MCP lane DID prove, through the real gateway

C7 was submitted with `confirm: true` through the Suite Gateway's own `ptp_skip_trace_bulk`, on David's
explicit instruction. That is the real end-to-end path and it exercises what the Task 8 report called
impossible to reach from a script: **`withMcpAuth`, `verifyToken`, the entitlement cache and the tool
registration all work on the deployed 2B commit.**

- `ptp_wallet_balance` returned **$11.98**, matching the database exactly at that moment, so the gateway is
  reading the real profile through the real auth chain.
- The free quote returned `submitted: 1, after_dedup: 1, duplicates_removed: 0, persons: 0, entities: 0,`
  **`full_property_trace: 1`**, `worst_case_cost: 0.25`, `over_cap: false`. The blank-owner record is
  classified correctly and `persons + entities + full_property_trace == after_dedup`.
- The submit returned `accepted: 1`, `full_property_trace: 1`, **`no_lookup_key: 0`**, `records_failed: 0`,
  `committed_worst_case: 0.25`. **`no_lookup_key` is present with 0 on a success path**, which is David's
  decision (g) and Task 6's fix round 1 requirement working: present rather than absent.
- **Quote $0.25 >= submit $0.25**, the inequality Ruling 28 required.
- The row landed with `source: mcp`, was enqueued, was drained by production's own cron, and its job
  finalized unpolled in 29.5 seconds.

## What this did NOT prove, and this list is exhaustive

1. **C6 never ran**, so the MCP surface's Tier 1 enqueue and the `APN|` key shape on that surface are
   unproven in production. Three blocked routes, above.
2. **No Tracerfy Tier 1 step ran at all.** Both named records that reached a vendor (C1, C3) classified as
   **entities** and routed to FastAppend, so `TRACERFY_INSTANT_NAMED` and `TRACERFY_PARCEL_APN` were never
   called. **C3 carried `apn` and `county` and still never reached the parcel rung**, because the entity
   route does not use it. The parcel rung remains unproven in production, as it was after Phase 1 and 2A.
3. **No Tier 1 record matched.** `found_by` is null on all 8 rows, so the `found_by_*` codes, the $0.15
   Tier 1 charge, and the approved "contacts came back and the record was charged" sentence were not
   exercised here. 2A proved them; this run did not re-prove them.
4. **The `bulk_job.completed` webhook never fired.** The profile has **no webhook URL**, so
   `notifyBulkJobCompleted` bailed at its no-webhook guard on all three jobs. Task 2's externally visible
   change, and David's Option A decision, rest on unit tests alone.
5. **`finalizeFailed` was never non-zero**, so Ruling 17's surfacing of `read_failed` / `write_failed` is
   unit-tested only.
6. **Auto-rebill never fired**, so Ruling 16's restored trigger — the money fix Task 2 reversed my own
   amendment to make — was not observed in production.
7. **Throttling never fired.** 8 records never pressured the budget, so the refusal path, the
   release-to-the-same-rung behaviour and the no-attempt-spent guarantee are still unit-tested only.
8. **The stale-claim, busy-resume and vendor-failure ladders never ran.** Nothing crashed, nothing was
   throttled, no `tier1_failed` row and no `busy_try_again` row.
9. **No status route was opened, deliberately**, so Task 3's v1 gate, Task 5's MCP `bulk_status` gate and
   Task 7's payload changes on both twins are unproven in production. Opening one before the read-back would
   have destroyed the only claim this phase can make; that trade was taken knowingly.
10. **`list_traces` was not called**, so Task 7's SELECT trap fix and the gated
    `outcome_code` / `found_by` pair are unproven in production.
11. **The column-width clamp was never exercised with a real over-long value.** All nine records carried
    2-character states and short cities, so `storableValue` returned its input unchanged every time. The
    overflow branch — the `"Texas"` defect — is unit-tested only.
12. **No duplicate was exercised.** `duplicates_removed: 0` and every record was fresh, so the dedup
    collapse and `checkDuplicates`' cache-hit branch did not run.
13. **Throughput at scale was not tested.** 8 records, not 500. Spec 3.2's 2-to-5-minute figure for a
    500-record job remains a calculation pinned by a test.
14. **A passing suite proves nothing about production column widths**, and cannot:
    `lib/supabase/admin.ts:16` builds the client with **no `Database` generic**, so `tsc` checks neither
    column names nor widths, and the test doubles carry none. Amendment 9's live read is the only fence, and
    the runner could not perform it.
15. **The gates never typechecked the runner.** `tsconfig.json` excludes `tasks/research-scripts`. That is
    exactly how the D36 check shipped comparing a key to a digest, and any remaining defect in the runner is
    equally invisible to `tsc`, `eslint` and `vitest`.
16. **The end-to-end gateway path for a parcel-keyed record does not work, and this phase did not make it
    work.** PropTracerPRO now accepts that record; the gateway still refuses it.
17. **An unsuccessful tier 2 being free is not established.** C7 recorded $0.00 where 2A's B5-2 recorded
    $0.20 on the same outcome.
18. **Nothing here tested the Suite Gateway repo**, which was never touched by this phase.

And that list is exhaustive.

## The gateway handoff

Phase 2B ends with **PropTracerPRO ready and the path still incomplete.** Nothing in this phase tested the
gateway end to end for the shape that matters, and the gateway repo was never touched.

### What PropTracerPRO now accepts that it did not before

**Key must be present, value may be empty.** This distinction is the whole of it and paraphrasing it as "PTP
now accepts parcel-keyed records" will mislead whoever builds against it:

- An **omitted `city` key** is now accepted. That was the actual Zod blocker (`recordSchema.city` was
  required, so a parcel-keyed record was refused before any guard ran) and it is the gateway's APN shape.
- `city: ''` is accepted.
- An **omitted `address` key is still refused**, as a thrown ZodError rather than a per-record verdict.
  `address: ''` is accepted. Not fixed in this phase.

**A parcel-keyed record must carry an `owner_name` or it is filed free and never traced.** The usability
question is `validateAddressInput(address, city, state)`, which has **no parcel term**, so a blank-owner
record keyed only on `apn` + `county` + `state` fails the street check and lands no-key, free, untraced. The
tier 2 cron can in principle plan from the parcel columns alone
(`app/api/cron/sweep-property-traces/route.ts:202-218`, whose own comment says such a row "cannot reach this
queue today"), so the lane exists and nothing feeds it. This is **not a regression** — the whole batch was
refused for that record before — and it is consistent with the v1 route. But it is squarely the shape this
phase exists to unblock, so: **send an `owner_name` with a parcel-keyed record, or it comes back free and
untraced with a resendable reason.** Closing the gap is L-035 / D23 territory, which spec Section 10 and the
2B plan both keep out of this phase.

### What remains on the gateway side

1. **Its own city guard. This is now measured, not inferred.** The gateway's `ptp_skip_trace_bulk` and
   `ptp_skip_trace_quote` schemas both declare `"required": ["address", "city", "state"]`. **So the gateway
   is the remaining blocker for the parcel-keyed shape**, and C6 could not be sent through it. Spec Section
   10 assigns this to **Phase 3**.
2. **Its own whole-batch rejection**, which PTP has now removed on both of its surfaces.
3. **The gateway always passes `parcel_id_local` and `county` from the registry rather than leaving it to a
   model to decide.** David, 2026-09-25: *"The property is coming from the registry, either way, we should be
   choosing for them, not letting them choose something they know absolutely nothing about."*

   Record this as the **design, not as a PropTracerPRO limitation**, which is what he corrected. The registry
   is reachable only through the API or the Suite Gateway, and PTP has no registry access and is not supposed
   to have any (measured: no `REGISTRY` env vars, one Supabase client which is its own, no registry query
   anywhere in `lib` or `app`; `mcp-tools.ts` reads `record.apn` from whatever the caller sent). Two separate
   caller populations: a trace originating in the **PTP app** never called the suite or the registry and needs
   no parcel id, the address is its key; a **suite or registry caller reaches PTP through Claude** and the
   registry has already produced `parcel_id_local` and `county` before PTP is called, so it holds them by
   construction. Task 7 makes the tool descriptions instruct rather than offer, which is PTP's whole share of
   this.

### One thing for the gateway team to check that this session could not

The `ptp_skip_trace_bulk` description this session was served still carries the **old** apn/county copy
("optional ... not a more accurate one; either key can find an owner the other misses") that David rejected
on 2026-09-25 and Task 7 replaced. **This session's tool list was fetched before the deploy, so the stale
text is most likely a client-side cache rather than a gateway defect** — but it is worth confirming that a
gateway caller now reads the approved copy, because if the gateway caches PTP's `tools/list` for any length
of time, the wording David approved is not what a calling model sees.

### What must not be claimed

**The end-to-end gateway path works.** It does not, for the parcel-keyed shape, and nothing in this phase
tested the gateway repo. What is proven is narrower and worth stating exactly: the gateway's auth chain,
entitlement cache and tool registration reach the deployed 2B code, and a record the gateway's own schema
accepts traverses gateway -> PTP -> queue -> cron -> finalized job correctly, for real money, in 29.5
seconds.
