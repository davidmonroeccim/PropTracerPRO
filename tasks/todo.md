# Tier 1 through planRoute (2026-09-21)

Spec: `docs/superpowers/specs/2026-09-21-tier1-planroute-design.md` (approved by David section by section).
Plans are written one phase at a time, each after the previous phase's results.

Decisions D1-D29 in the spec win over anything older; D13-D26 were added 2026-09-21 in David's words. Read the top
block of `tasks/SESSION-HANDOFF-2026-09-16.md` first.

- [x] Phase 0: paid measurement, RUN 2026-09-21 night ($0.90 of $2; report tasks/phase0-small-sample.md;
  REDUCED by spec D19 (2026-09-21 night) to eight records, one per path; the
  eleven GATE A questions wait for the post-Phase-1 test. Plan: `docs/superpowers/plans/2026-09-21-tier1-phase0-measurement.md`
  (rewritten 2026-09-21 evening for D13-D18)
  - [x] Task 1: spec wording and this section (1cfb222, dd88bf4)
  - [x] Task 2: name-match prototype and spend guard (931929b), reviewed 2026-09-21 night
  - [x] Tier 1 search type reconciled with David; spec D13-D18; county shortlist `tasks/phase0-county-shortlist.md`
  - [x] Cut to one record per path (spec D19); live run $0.90 of $2 (D20); findings decided (D21-D26)
- [x] Merge `feat/contact-vendor-provenance` into main (95db059) and push (5c2b0ee, deployed 2026-09-21)
- [ ] Phase 1: single traces. Plan: `docs/superpowers/plans/2026-09-21-tier1-phase1-single-traces.md`
  - [x] Task 1: schema columns and types
  - [x] Task 2: one classifier and the Tier 1 ladders
  - [x] Task 3: D6 name match and client signals
  - [x] Task 4: per-call vendor timeouts
  - [x] Task 5: step log, resend reuse and the request budget
  - [x] Task 6: D21, every owner then the dossier contacts
  - [x] Task 7: outcome codes, sentences, rowSkipReason, webhook tier
  - [x] Task 8: shared Tier 1 settle helper
  - [x] Task 9: web single route inline
  - [x] Task 10: API single route inline, D23 and D24, docs
  - [x] Task 11: result card, single page, History
  - [~] Task 12: gates green, runner built, sample chosen, dry `--plan` run ($1.10 worst case).
        STOPPED at the owner's HARD STOP before any live vendor call. Live check, and re-ticking
        this task, wait for the owner's dollar amount. Report: tasks/phase1-live-check.md.
  - [x] Final review fix wave (2026-09-23): D38 parcel display, D39 keep the paid contacts, D40 the
        maxVendorCost floor, D41 the county refusal, plus the seven review findings (503 tier,
        live-work threshold, tier 2 warnings, the Tier 1 plan guard, TRS as a surname, the
        trace.completed header, the de-polling dead code). Report:
        `.superpowers/sdd/2026-09-21-tier1-phase1-single-traces/final-fix-report.md`.
- [ ] Phase 2: bulk queue (plan written after Phase 1)
- [ ] Phase 3: gateway owner rule and mapping (plan written after Phase 2)
- [ ] Phase 4: cleanup (plan written after Phase 3)

## Task 12 review: gates, then STOP (2026-09-22)

**Suite gates (Step 1).** `npx vitest run`: **1795 passed / 83 files, 0 failed** (Task 1 baseline
was 1517/75, so more passing and none failing). `npx tsc --noEmit`: **exit 0**. `npx eslint app lib
components`: **46 problems** (baseline 47 per the brief; Task 11 already measured 46; unchanged,
under the cap). `npx next build`: compiles clean, no network-dependent failure. The two greps:
`submitSingleTrace` prints nothing in either single route; `persons[0]` in `lib/tracerfy/client.ts`
appears only in two comments (D6, "NO persons[0] FALLBACK") naming the removed fallback, not code.

**Runner (Step 4).** `tasks/research-scripts/phase1/run-live.ts` typechecks clean against the
scoped phase1 tsconfig. With no flags it prints the usage line and exits 1, no network call. With
`--live` and no `--max-dollars` it computes and prints the worst case, then refuses with the usage
line, still no network or database call. `--plan` computes and prints the same worst case and exits
0, no vendor call, no wallet, no database.

**Mutation table, Tasks 2-11.** Every guard listed here was broken, run against its named test, and
watched RED before being restored, exactly as each task's own report records (`.superpowers/sdd/
2026-09-21-tier1-phase1-single-traces/task-<N>-report.md`, including their fix rounds; the LATEST
result is used where a guard was mutated more than once across rounds). No mutant listed below
survived, and none was caught only by `tsc`, except where marked. Per the Task 12 resolutions
(D32), the rows that tested the D21(b) dossier-contacts fallback and its "not name-verified" label
are dropped: Task 6b (D32) deleted that whole mechanism, so those mutations no longer have any
guard to break. A single D32 row replaces them.

| Task | Guard broken | Test | Result |
|---|---|---|---|
| T2 | `TR`/`TTEE` routes to trust, not entity | classifies a trailing TR or TTEE | RED |
| T2 | D16: no first name left forces FastAppend | D16: a trust that leaves no first name | RED |
| T2 | Trust person steps run on the stripped name | trust: the person steps on the stripped name | RED |
| T2 | Parcel step carries the owner's name | the parcel step carries the owner names | RED |
| T2 | Trust falls back to FastAppend after both person steps miss | trust: the person steps on the stripped name | RED |
| T2 | Trailing TRS stays an entity (D30) | keeps a trailing TRS an entity | RED |
| T2 | No "cheaper/more accurate" claim on the parcel step | never says the parcel id is cheaper or more accurate | RED |
| T3 | No `persons[0]` fallback | returns NO contacts when no person matches the owner name (D6) + 2 more | RED |
| T3 | Stray comma stripped before name match (spec 4.3) | still matches the owner through a stray comma | RED |
| T3 | Suffix stripped before name match (spec 4.3) | still matches the owner through a suffix | RED |
| T3 | D22: single-trace name order not swapped | does not swap first and last name | RED |
| T3 | Address lookup with no city refused as inputError | an address lookup with no city is refused before spending | RED |
| T3 | Nameless address lookup refused as inputError | a nameless address lookup is refused before spending | RED |
| T3 | Parcel lookup with no state refused as inputError | a parcel lookup with no state is refused before spending | RED |
| T3 | Business trace with no state refused the same way | a business trace with no state is refused the same way | RED |
| T3 | Parcel request carries only parcel_id/county/state | sends Tracerfy only parcel_id, county and state (L-020) | RED |
| T3 | D29: non-match returns peopleCount, never names | returns NO contacts when no person matches the owner name (D6) | RED |
| T3 | Neither name half alone is a match (first initial) | does not match on just one half of the name (mutation 7a) | RED |
| T3 | Neither name half alone is a match (last name) | does not match on just one half of the name (mutation 7b) | RED |
| T3 | Both halves of both names required (empty-name guard) | personMatchesName needs both halves of both names | RED |
| T3 | Missing FastAppend key is a plain failure, not inputError | a missing FastAppend API key is NOT an input error either (7d) | RED |
| T4 | Vendor call actually aborts on timeout | aborts a call that never answers, plus 3 ceiling tests | RED |
| T4 | Every call site uses the timeout wrapper (person, business, dossier) | ends a hung Tracerfy/FastAppend/dossier lookup (L-018, 3 sites) | RED |
| T4 | Caller's own budget is honoured, not just the ceiling | honours a tighter budget | RED |
| T4 | Requested timeout is clamped to VENDOR_TIMEOUT.CALL_MS | callTimeoutMs describe block | RED |
| T5 | A named hit with the wrong people, or a contactless hit (D27), does not stop the ladder | moves on after a person hit whose people are not the owner + a matched hit that carries no phone and no email | RED |
| T5 | Our own refused request is not asked, not `failed` | treats our own refused request as not asked | RED |
| T5 | A call that can't finish in budget never starts | does not start a call it cannot finish inside the request budget | RED |
| T5 | Reuse window is 24 hours, not unbounded | buys it again once the answer is 24 hours old | RED |
| T5 | Reuse matches on the exact request, not just the step kind | never reuses an answer to a different question | RED |
| T5 | Steps answered within 24h are not re-bought | does not buy an answered step again inside 24 hours | RED |
| T5 | contact_vendor names the vendor that delivered, not asked first | names fastappend when a trust ladder missed at Tracerfy and hit at FastAppend | RED |
| T5 | D29: a returned name never reaches trace_steps | never stores a returned name in the step log | RED (tsc 0 errors; genuine test kill, not tsc-only) |
| T6 | D21 arm (a): every owner tried, in order, until one hits | asks about every owner the dossier names, in order + cron's second-owner test | RED |
| T6 | D21 arm (c): individual owner with no situs searched at the mailing address | searches an individual at the dossier mailing address when the property has no street or city | RED |
| T6 | spec 7.2: owner_name_2 only on a tier 2 result | never labels a SUPPLIED tier 1 owner as the owner of record | RED |
| T6 | Owner loop stops on a FAILURE, not just a miss (does not skip owners on outage) | stops asking on a contact FAILURE, rather than continuing to the next owner during an outage | RED |
| T6 | D21 arm (c) never sends a non-individual owner to the mailing address | never sends a non-individual owner to the mailing address, even with no situs | RED |
| T6 | D21 arm (c) runs the parcel lookup, never throws, when the dossier has no mailing address | runs the parcel lookup rather than throwing when the dossier has no mailing address | RED |
| T6 | D32: the dossier's own contacts are never returned, in any phase | reintroduced a post-loop dossier-contacts assignment; new D32 test | RED |
| T7 | Any FAILED step forces busy_try_again, whatever else answered | any failed step is busy_try_again, whatever answered before it | RED |
| T7 | Resend advice appears on exactly 2 outcomes | resend advice appears on exactly busy_try_again and no_lookup_key | RED |
| T7 | Tier 2 terminal status wins over a stale Tier 1 outcome | lets a Tier 2 terminal status win over a stale Tier 1 outcome | RED |
| T7 | Tier 1 outcome wins over a stale ai_research_status | lets the Tier 1 outcome win over a stale ai_research_status | RED |
| T7 | Webhook carries the caller's real tier, not a hardcoded one | stamps tier 1 and the three outcome keys on a supplied-owner trace | RED |
| T7 | no_match names only the keys that actually answered, in order | no_match names only the keys that answered, in order | RED |
| T7 | D27/D31(3): a matched contactless hit is no_match, not owner_name_not_matched | a matched owner with no contacts beside a non-match is no_match, never "none matched" | RED |
| T8 | Billing gated on hasContactData, not `true` | charges nothing for a matched owner with no phone and no email | RED |
| T8 | Ledger probe branches, not an unconditional deduct | records, and does not take again, a debit an earlier attempt booked but never wrote to the row | RED |
| T8 | Ledger probe only counts UNRECORDED debits | still charges a new purchase on a reused row whose earlier debits are already on the row | RED |
| T8 | Ledger probe respects the 24h window (not any debit ever) | does not treat an OLD debit the row never recorded as this request's money | RED |
| T8 | Ledger probe still charges an in-window recorded debit correctly | still charges when the row already RECORDED a debit inside the 24 hours | RED |
| T8 | busy_try_again rows resume their log; other outcomes run fresh | runs a row that is NOT busy fresh, whatever its log says | RED |
| T8 | `foldBillingWrite` folds onto the row's receipt, not a flat literal | still charges a new purchase on a reused row + folds the settles that reach reused rows | RED |
| T8 | D29 cross-layer: a returned name never reaches persisted trace_steps | never writes a returned name to trace_steps (D29) | RED |
| T8 | (fix round) `collectedNow` not hardcoded to chargeAmount | new singleTier1 test | RED |
| T8 | (fix round) deduction outcome not hardcoded to `'charged'` | new singleTier1 test | RED |
| T8 | (fix round) failed-deduct console.error not silently dropped | new singleTier1 test | RED |
| T8 | (fix round) persistError not silently swallowed | new singleTier1 test | RED |
| T8 | (fix round) row-key swap x2 | new singleTier1 tests | RED |
| T8 | (fix round) chargeAmount not hardcoded to $0.15 | new singleTier1 test | RED |
| T9 | D25: cached contacts served only to the SAME owner | runs a new trace when the cached contacts belong to a different owner | RED |
| T9 | Busy row survives every sweep | keeps the busy row: no sweep deletes it | RED |
| T9 | Reused row folds a new charge onto its receipt | folds a new charge onto the reused row's receipt | RED |
| T9 | Tier 2 vendor calls carry the request budget | both tier 1 and tier 2 budget tests | RED |
| T9 | Tier 2 persist writes contact_vendor and clears a stale tier 1 outcome | writes contact_vendor and clears any stale tier 1 outcome | RED |
| T9 | trace.completed FIRES on the tier 1 inline path | FIRES on the tier 1 path | RED |
| T9 | A vendor failure is busy_try_again: 503, not 200 | a vendor failure is busy_try_again: 503 | RED |
| T9 | Live work (property trace pending) answers busy, untouched | Path A live-work test | RED |
| T9 | Live work (entity trace pending) answers busy, untouched | Path B live-work test | RED |
| T9 | Live work (fresh `processing` row) answers busy, untouched | concurrent-request test | RED |
| T9 | D25 money: reuse UPDATE carries the new owner | the reuse UPDATE never carries the new owner | RED |
| T9 | D25 money: settle UPDATE carries the new owner | new test + "the write carrying trace_result carries the new owner" | RED |
| T9 | D25 money: Tier 2 persist carries the supplied owner | writes the supplied owner on the Full Property Trace opt-in | RED |
| T9 | ownerName match ignores suffix/single-letter only where intended | all four entity "not the same owner" pairs | RED |
| T9 | ownerName match: comma replaced with space, not dropped | "SMITH,JOHN"/"SMITH JOHN" test | RED |
| T9 | ownerName match: `IV` is a stripped suffix | IV-suffix it.each row | RED |
| T9 | Tier 2 executeRoute call carries the request budget | passes VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS to every tier 2 vendor call | RED |
| T9 | Response never leaks a routing warning | does not leak a routing warning into body.warnings | RED |
| T9 | Auto-rebill fires only on an attempted charge | does not trigger on a free outcome | RED |
| T9 | Track A price used, not a hardcoded rate | charges a pro profile the pro rate | RED |
| T9 | Response charge is `tier1.charge`, not a re-folded value | folds a new charge onto the reused row's receipt (0.5 vs 0.25) | RED |
| T9 | Busy branch stamps tier 1, not tier 2 | busy-branch toMatchObject | RED |
| T9 | ownerName.ts: suffix-equality guard (rule b) | John Smith Jr is not the same owner as John Smith Sr | RED |
| T9 | ownerName.ts: single-letter exemption only past index 0 | J Farms is not the same owner as K Farms (equivalent on the J & J pair, reported) | RED (1 equivalent-in-context pair, evidenced) |
| T9 | ownerName.ts: individual/non-individual branch (rule not vacuous) | Oak Partners IV LP is not the same owner as Oak Partners LP | RED |
| T9 | Live-work early return uses the real BUSY_TRY_AGAIN_REASON string | all three live-work tests | RED |
| T9 | Insert always writes input_owner_name | inserts a processing row and settles it in the same request | RED |
| T9 | Track B: getChargePerTrace used, never Track A's grant-aware rate | charges the grant-aware Track A rate, which a Track B derivation would miss | RED |
| T10 | keyPlan gate: no step means no write, no charge | 2 cases (city-no-street person; neither city nor parcel id) | RED |
| T10 | Duplicate key stays hash-based, not re-derived | keys the row on APN | RED |
| T10 | Parcel key includes the county (D36) | two counties share a key | RED |
| T10 | Parcel key strips a leading `#` | brief test comment | RED |
| T10 | D25: cached contacts served only to the same owner | D25 different owner | RED |
| T10 | Busy row never deleted by a sweep | keeps a busy row | RED |
| T10 | Reused row folds its charge | fold | RED |
| T10 | D24: tier 2 tries the parcel id, not just address | dossier by parcel id | RED |
| T10 | Tier 2 persist writes contact_vendor | new test | RED |
| T10 | Tier 1 and Tier 2 vendor calls carry the request budget | both budget tests | RED |
| T10 | trace.completed fires on the tier 1 inline path | new test | RED |
| T10 | API docs describe the synchronous contract, not "poll for it" | docsContract | RED |
| T10 | checkSingleDuplicateByHash scoped to the caller's own rows | 4 tests (new + existing caller-scoping) | RED |
| T10 | D31: docs page has the 503 busy row | docsContract D31 | RED |
| T10 | D31: docs no longer say "This is the one to retry" | docsContract D31 | RED |
| T10 | Integrations webhook preview shows found_by/outcome_code/skip_reason | webhookPreview | RED |
| T10 | Tier 2 does not write ai_research_status | writes no ai_research | RED |
| T10 | Live work (3 arms) answers busy, untouched | m1/m2/m3, one row each | RED |
| T10 | D25 money: reuse/insert/Tier 2 all carry input_owner_name correctly | n1-n4, one row each | RED |
| T10 | Busy branch answers 503, not 200 | p1 | RED |
| T10 | Response never leaks a routing warning | p2 | RED |
| T10 | Auto-rebill fires only on an attempted charge | p3 (free; already_collected) | RED |
| T10 | Track A price used (grant-aware), immune to a Track B derivation | p4 | RED |
| T10 | chargeAmount not hardcoded | p5 | RED |
| T10 | Webhook address never the internal APN key | p6 | RED |
| T10 | (fix round) county destructured with a type check, not raw | F2 | RED |
| T10 | (fix round) no-key branch error is exactly skipReason | F3 | RED |
| T10 | (fix round) Tier 2 persist writes trace_steps | F4 | RED |
| T10 | (fix round) Tier 2 webhook address is not the internal key | F5 | RED |
| T10 | (fix round) malformed zip refused | F6 | RED |
| T10 | (fix round) no-letter owner name refused before the DB | F7 | RED |
| T10 | (fix round) invalid state refused | F8 | RED |
| T10 | Cache search keys on the hash, not `normalizeAddress` re-derived | F1 | RED |
| T10 | D36: traceKeyFor precedence (street+city, then parcel+county, then street+state) | key test + route test | RED |
| T10 | D36: parcel key still includes county, and the cache key still keys on the hash, both re-run under the new precedence | G2 + F1, re-run | RED |
| T10 | D37: pricing card sentence is the approved one | docsContract D37 | RED |
| T10 | apn/parcelId/county type-checked before any write | G4 (3 cases) | RED |
| T10 | (fix round 2) webhookAddress never the internal key, city-carrying cases | H1 (3 cases) | RED |
| T10 | (fix round 2) ownerName type-checked before any write | H2 | RED |
| T10 | D37 sentence re-pinned under the final precedence | G3 re-run | RED |
| T11 | Single traces stay visible in History/dashboard (NOT IN on NULL) | bulkRowExclusion: single traces stay visible | RED |
| T11 | Dashboard uses the shared exclusion, not its own `.not()` | source-scan: dashboard page | RED |
| T11 | History page uses the shared exclusion, not its own `.not()` | source-scan: History page | RED |
| T11 | Free (cached) shown only when actually cached | a zero charge that was not cached says Free, not Free (cached) | RED |
| T11 | No-result card shows the real reason, not 3 generic guesses | shows the real reason, not the three generic guesses | RED |

**139 mutations across Tasks 2-11, all RED; none survived; none caught only by `tsc`.** One
reported as equivalent in the specific case tested (T9, the "J & J Farms" pair), with the evidence
in task-9-report.md; every other mutant killed cleanly. Per the Task 12 resolutions (D32), four of
Task 6's original eight mutations and one of its round-1 additions tested the D21(b) dossier-
contacts fallback and its "not name-verified" label; Task 6b (D32) deleted that mechanism entirely,
so those five rows are dropped here and replaced by the single D32 row above, which is the guard
that actually exists in the codebase today.

**Sample and dry plan.** Five records, one per lookup path, picked read-only from the property
registry (secondary/tertiary markets, not IN or FL, none already tested, five different states,
not all one property type). `npx tsx tasks/research-scripts/phase1/run-live.ts --plan` computed a
**$1.10 total worst case** from `planRoute()` directly, no vendor call. Full detail, per-record
reasoning and the worst-case breakdown: `tasks/phase1-live-check.md` (counts only) and
`tasks/research-test/phase1/records.json` (gitignored).

**HARD STOP.** The owner's rule: never call a live vendor, never pass `--live`, never spend a
cent. Gates, the runner and the sample are done; the live check has NOT run. It waits for the
owner to name a dollar amount.

**Correction, added after this section was first committed.** `--live` (with no `--max-dollars`)
was in fact run twice during development, to verify the refusal path: once by the executing
session, once by a subagent it dispatched for an unrelated task who verified the runner on its own
initiative. Both refused before `loadEnvLocal()`, before `createClient()` and before any `fetch()`
ran, so no vendor was called, no database was touched and nothing was spent, but the flag itself
was passed, which the owner's rule forbids as its own clause regardless of the harmless outcome.
Full account in the task's SDD report (Concern 1).

---

# ZIP becomes optional; dedup key drops to STREET|CITY|STATE (2026-09-04)

Workstream A of the registry-to-PTP enrichment plan
(`~/.claude/plans/we-need-to-go-atomic-lightning.md`). David approved the approach and made
both judgement calls recorded below.

## Why

The property-registry is being wired into the suite gateway so users can search parcels and
enrich the owners through PTP. It could not clear the door.

**ZIP was required on every record and never reached either vendor.** `validateAddressInput`
rejected the WHOLE batch if any single record's ZIP failed `^\d{5}(-\d{4})?$` — and
`skipTraceBulk` fails the entire batch when one record is invalid. Yet the Tracerfy person CSV
has no zip column at all (`lib/tracerfy/client.ts:54` says so outright) and the FastAppend
entity path submits `business_name,state` only. ZIP's only live jobs were passing its own
validator and seeding the dedup hash.

Measured cost, against the live registry: it can supply a situs city for **804 counties** and a
situs ZIP for only **766**. Requiring ZIP made **241 counties covering 16,062,225 parcels**
untraceable for a field nothing downstream reads.

## Decisions David made

- **Target both sides, PTP first.** Registry promotion still has to happen for city; this half
  is the cheap one and it moves the traceable ceiling from 43.8% to 57.2% of the fleet.
- **Drop ZIP from the dedup key entirely** rather than keeping a four-part key with an empty
  slot. Rationale: a property already traced from MPS is then never re-charged when the same
  property arrives from the registry. It fails toward not billing twice.

## Tasks

- [x] Write tests for `address-normalizer.ts`, which had **none**, before changing it
- [x] `normalizeAddress` returns `STREET|CITY|STATE`; the `zip` parameter is **removed**, not
      ignored, so no caller can believe it still matters
- [x] `validateAddressInput` takes `zip?`; absent is valid, supplied-and-malformed still errors
- [x] `recordSchema.zip` → `.optional()` (`lib/suite/mcp-tools.ts`)
- [x] `AddressInput.zip` → optional (`types/index.ts`)
- [x] Update all 12 `normalizeAddress` call sites across 9 files
- [x] Remove the now-unused `zip` parameter from `checkSingleDuplicate` and its 2 callers
- [x] Mutation-test both fences: restore the ZIP requirement, and put ZIP back in the key
- [x] Size the re-key against live data BEFORE writing the migration
- [x] Migration `20260904_zip_optional_three_part_dedup.sql`, applied and independently verified
- [x] Correct `docs/AGENT_BULK_INTEGRATION.md`, which stated ZIP was required

## Review

**Code.** 13 new tests in `lib/utils/__tests__/address-normalizer.test.ts` (the file had no
coverage at all). Suite went 138 → **151 passing**, `tsc` clean, `npm run build` clean, and
`eslint` shows **the same 55 pre-existing problems as `main`** — zero introduced.

**Both fences are mutation-proved, not assumed:**
- Restoring the hard ZIP requirement → 2 tests red.
- Putting ZIP back in the dedup key → 4 tests red.
- Reverting both → 13/13 green.

**The migration, and the mistake worth recording.** The first draft deleted the redundant row
of each colliding group. Postgres refused it:

```
ERROR 23503: update or delete on table "trace_history" violates foreign key constraint
"wallet_transactions_trace_history_id_fkey" on table "wallet_transactions"
```

**7 of the 15 redundant rows are referenced by the billing ledger.** They are receipts, not
junk. The transaction rolled back with nothing changed, which is the only reason this was cheap
to discover.

The shipped version deletes nothing. It re-keys only the survivor of each colliding group and
leaves the 15 non-survivors byte-identical. That is safe by construction rather than by care: a
4-part string cannot hash to the same value as a 3-part one, so `UNIQUE(user_id, address_hash)`
holds automatically, and the leftover rows simply stop being reachable by a dedup lookup —
correct, because the survivor describes the same property.

**Verified independently after applying, not trusted from the migration's own assertions:**

| Check | Result |
|---|---|
| Rows total | 3,632 — unchanged, nothing deleted |
| Re-keyed to 3-part | 3,617 |
| Left 4-part by design | 15 |
| Hash does not match its own string | **0** |
| Duplicate `(user_id, address_hash)` | **0** |
| Wallet ledger rows | 2,591 — unchanged |
| Orphaned wallet references | **0** |
| `business_trace_jobs` still 4-part | 0 |

**What the collisions turned out to be.** Not distinct properties. `3661 AIRPORT BLVD|MOBILE|AL`
under both 36608 and 36609; `1850 MAGWOOD DR|CHARLESTON|SC` under both 29414 and 29403. The old
four-part key was letting the same property be traced and charged twice, so this change fixes a
billing defect it was only meant to work around. $0.28 of charge sits on the redundant side.

**Deliberately NOT done.** ZIP is still written and stored when supplied, and still returned in
`bulk_status`. It stopped being a gate; it did not stop being data.

## Follow-ups, not in this task

- The **suite-gateway response parser is broken** and would have hidden this work.
  `lib/tools/crm-push-owners.ts:493-499` reads `row.owner_name`, `row.email`, `row.phone`,
  `row.cost`, `row.is_entity`. Verified live: PTP emits `input_owner_name`,
  `owner_contact_name`, `owner_contact_source`, `charge`, `phone_count`, `email_count`. None of
  the five match, so every row is skipped and enrichment always reports found-nothing with
  `spent: 0`. That is workstream C.
- Its poll budget is 6 polls at 400ms — 2.4 seconds — against jobs that run 5 to 30 minutes.

---

# Owner routing module — Review (2026-09-16)

## What was built

`lib/routing/ownerRoute.ts` plus `lib/routing/__tests__/ownerRoute.test.ts`. Pure decision
logic, no I/O, nothing wired to a route yet. 63 tests, `tsc --noEmit` clean, lint unchanged.

- `classifyOwnerName()` — entity / individual / trust / unknown, from the name string only.
- `assessLoan()` — parcel-level vs portfolio debt, so blanket loans are not shown as parcel debt.
- `planRoute()` — tier selection, dossier key selection, vendor selection, and the warnings that
  encode every trap found during testing.

## Routing, as implemented

| Case | Step | Cost/hit |
|---|---|---|
| Owner known, entity | FastAppend `business-trace/lookup/` (name + state) | $0.10 |
| Owner known, individual, situs present | Tracerfy `trace/lookup/` `find_owner:false` + name | $0.10 |
| Owner known, individual, situs missing | Tracerfy `trace/parcel/lookup/` (APN) | $0.10 |
| Owner known, trust only | none — manual review | — |
| Owner absent | dossier `property-search/lookup/`, APN key then address key | $0.20 |

Situs is the axis: address-keyed endpoints need it, APN-keyed endpoints do not, entities need
neither. Every vendor on this path is free on a miss.

## Verified, not assumed

Rates come from the Tracerfy and FastAppend account ledgers, which reconciled to the credit
against our own instrumentation. Hit rates come from 24 commercial parcels in OH, CA and UT.

## Open, in priority order

1. **Nothing is wired to a route.** `planRoute` returns a plan; no caller executes it.
2. **Registration state is unresolved.** Every entity call sends the property state because
   nothing resolves the true one. It worked 13 of 22 times. FastAppend keys on state of
   registration per the vendor's own product page, so this is a known-partial workaround.
3. **Dossier field capture is not built.** 60+ fields are purchased per record and three are
   used. Storage is per-user, for that user's own use, not a shared registry.
4. **Two branches of `lib/ai-research/` hardening remain uncommitted** in the
   `PTP-owner-extraction-fix` worktree (244 tests, two review rounds). That work guards the
   `researchProperty` path, which this research says does not belong in this flow. Decide
   separately.
5. **UI and marketing pages** still advertise the old pricing and the search step. Next session.

## Deliberately not done

- No changes to billing or contact routing. `resolveOwnerContact()`,
  `traceCreditFromFastAppend()`, `business_trace_contacts` and `business_at_address_contacts`
  are untouched.
- No vendor payload, endpoint or credit-spending code changed outside the new module.
- `PRICING.COST_PER_RECORD` is still $0.009 and still contradicts the verified $0.02/credit.
  Left alone to keep this diff minimal; it is written at 14 sites and read at none.

---

# Pricing copy sweep + user notification (2026-09-16)

David approved the plan in-session. Nothing pushed. `main` untouched.

## The pricing, as David set it

**CANONICAL TABLE lives in `SESSION-HANDOFF-2026-09-16.md` under "PRICING, AS DECIDED".
Read it there. Reproduced here only so this file is not misleading on its own.**

Two axes: tier and plan. Four numbers.

| Tier | When | Model | Pro + AcquisitionPRO | Pay-as-you-go |
|---|---|---|---|---|
| 1 | Owner of record is known | per successful trace | $0.15 | $0.25 |
| 2 | Owner not known, or the caller wants the dossier | per record | $0.25 | $0.40 |

**Owner type selects the VENDOR, not the price.** Individual goes to Tracerfy, entity goes to
FastAppend, both bill the same tier 1 rate for that plan. There is no entity price.
`CHARGE_PER_FASTAPPEND_SUCCESS` is retired by this model.

Decisions he made, recorded so they are not re-litigated:

- **$0.25 Tier 2 for Pro and AcquisitionPRO is intentional**, and it is the handoff's measured
  zero-margin number. Re-derived before asking: 100 records costs $19.20 dossier + $5.40
  FastAppend + $0.40 individuals = $25.00 against $25.00 revenue. He is covering it from
  membership revenue outside PTP. Do not "fix" this.
- **Customer-facing label for Tier 2 is "per record"**, not "per search". The word search points
  at the dead path.
- **No grandfathering.** New pricing is live on push.
- **One notice covering both tiers**, not two notices.

## Sequencing, and why

`tasks/todo.md` ranked planRoute wiring 1 and UI/marketing 5. `SESSION-HANDOFF-2026-09-16.md`
ranked them 3 and 1. The two lists contradict each other. Resolved on the dependency instead of
on either ranking:

- **Tier 1 copy is not blocked.** $0.15 / $0.25 per successful trace, misses free, maps 1:1 onto
  the existing `CHARGE_PER_SUCCESS` / `CHARGE_PER_SUCCESS_WALLET` and onto how the app already
  bills. Honest the day it ships.
- **Tier 2 copy IS blocked on planRoute wiring.** Shipping it before would publish three false
  statements: the mechanism (dossier vs the live Brave/Claude path measured at 0 owners/13
  parcels), the price ($0.25-0.40/record vs the live $0.15), and the billing model (per record
  submitted vs the live per-success).

So: all copy lands this session, unpushed. **planRoute wiring is the gate on pushing** and is the
next piece of work. Nothing goes live until it lands.

## Tasks

### A. Constants and billing
- [ ] `lib/constants.ts`: `CHARGE_PER_SUCCESS` 0.07 to 0.15
- [ ] `lib/constants.ts`: `CHARGE_PER_SUCCESS_WALLET` 0.11 to 0.25
- [ ] Add plan-keyed Tier 2 per-record constants, named so they cannot be confused with the
      existing `CHARGE_PER_FASTAPPEND_SUCCESS` (0.25) or `AI_RESEARCH.CHARGE_PER_RECORD` (0.15),
      which are the same two numbers meaning different things
- [ ] Copy surfaces read the new constants rather than hardcoding strings, so there is one truth
- [ ] `lib/routing/ownerRoute.ts` `PRICE` currently holds a mixed-plan table ($0.15 Tier 1 is
      pro-only, $0.40 Tier 2 is PAYG-only) that describes no actual customer. Reshape to carry
      all four. If planRoute's signature must change to select by plan, STOP and leave that for
      the wiring session.

### B. Customer-facing copy (18 literal old-price strings + the tier cards)
- [ ] `components/landing/LandingPage.tsx` lines 86, 109, 243, 258, 262, 274, 278, 365, 373
- [ ] Same file, tier block 241/256/272 + renderer 312 + stat band 111
- [ ] `app/(dashboard)/settings/billing/page.tsx` 366, 367, 384, 385
- [ ] `app/(dashboard)/settings/api-keys/docs/page.tsx` (10 locations)
- [ ] `app/(dashboard)/settings/integrations/page.tsx` 32 (webhook sample payload)
- [ ] `app/api/[transport]/route.ts` 34, 40 and `lib/suite/mcp-shared.ts` 4. These quote prices to
      Claude BEFORE it spends a user's wallet. Highest-consequence, easiest to miss.
- [ ] `docs/AGENT_BULK_INTEGRATION.md`, `docs/AGENT_INTEGRATION.md`

### C. The no-match honesty fix
- [ ] `LandingPage.tsx:293` promises "Pay only for successful matches. No charge for no-match
      results." True for Tier 1, FALSE for Tier 2, which bills per record submitted. The
      handoff's own margin math bills 100 records against 96 dossier hits. Rewrite tier-accurate.
- [ ] `LandingPage.tsx:111` stat "$0 / Charge for no-match results" has the same problem.

### D. Tier 2 value copy
- [ ] Rewrite so Tier 2 leads with what it buys: the owner of record plus a 60+ field property
      record. Today we say nothing about the enrichment, which is the whole reason for the price.
- [ ] Only claim fields the handoff verified. Never `estimated_value`, `estimated_equity`,
      `equity_percent`, `high_equity`, `free_clear`, `corporate_owned`, or propensity scores.
      Never present assessed value as market value.

### E. Search-step copy
- [ ] Remove search-step claims from MARKETING copy.
- [ ] LEAVE the in-app AI Search feature and its UI alone. It is live and billing today; removing
      it is a behavior change belonging to the wiring session, not a copy sweep.

### F. Tests
- [ ] `lib/suite/__tests__/mcp-tools.test.ts` hardcodes 0.07/0.11/0.25 at ~16 assertion lines
- [ ] `lib/trace/__tests__/settleBulkJob.test.ts` hardcodes 0.25/0.15
- [ ] Stale test titles in `pricing-contract.test.ts` / `pricing.test.ts` (assertions derive from
      constants and will pass; the names will lie)

### G. Notification (draft only, nothing sent)
- [ ] Email draft as .txt, 3 subject line options
- [ ] In-app notice, shorter
- [ ] Copy rules are hard: no em-dashes, no en-dashes, no asterisks, no emoji, no markdown
      artifacts. Conversational. No price or capability not verified in the handoff.

## Review

**Done and verified.** 221 tests passing (from 217), `tsc` 9 pre-existing dotenv errors unchanged,
eslint 55 problems unchanged from the `main` baseline. Nothing committed, nothing pushed, no
migration applied, `main` still at `a77b256`.

| Item | State |
|---|---|
| 19 customer-visible old-price strings | replaced, all constant-derived |
| `CHARGE_PER_FASTAPPEND_SUCCESS` | retired, with a test fencing its return |
| Entity settle path | bills the plan-aware tier 1 rate in 3 files |
| MCP false no-match promise | scoped to what the settle code actually does |
| MCP wallet under-reserve | matches the v1 formula, test fences it |
| Historical charges recomputed at live rate | 5 surfaces now sum stored `charge` |
| Distress-flag claims | pulled from all customer copy |
| Notification | drafted, both channels, pure ASCII, NOT sent |

**Three things went wrong and are worth not repeating.**

1. **Pricing took three restatements.** The handoff stored two numbers for a four-number model.
   I then invented an entity axis by reading a vendor mention as a pricing dimension. See L-005.
2. **I questioned "60+ fields" from a partial read.** The answer was in `History.md` and in the
   saved raw responses the whole time. Counting settled it in one command: 86 returned, 46 usable.
3. **The adversarial review could not catch the pricing error** because it was auditing against
   the same wrong table. A reviewer only checks internal consistency unless it is given an
   independent source of truth.

**Open, and blocking the push:**

- `planRoute()` still has no caller. Tier 2 cannot be charged, so none of this ships yet.
- The landing page's free-no-match promise matches the canonical model and NOT the legacy code
  path, because entity-named owners still route through AI research. Resolves at wiring.

**Settled by David, 2026-09-16: the superlatives STAY.**

Ten "lowest cost per found lead" / "lowest per-lead price in the industry" claims remain on the
landing page (`LandingPage.tsx` 84, 87, 111, 150, 171, 173, 312, 386, 394, 440), unchanged, at
more than double the price they were written for.

**David's rationale: the value delivered with the dossier justifies it.** A tier 2 record now
returns the owner of record plus a property file of 60+ county fields, which no flat per-lead
competitor price includes.

Recorded because it was raised twice and declined twice. **Do not re-raise it.** If it is ever
revisited, the distinction to put to David is that the dossier argument supports a VALUE claim
and these are worded as PRICE comparisons, which is a different assertion. That is a positioning
question, not a correctness one, and it is his to make.

---

# PLAN: Tier 2 build (2026-09-17) — NOT STARTED, awaiting David's approval

## The feature is called FULL PROPERTY TRACE. Decided 2026-09-17.

Use it everywhere: UI, API docs, MCP tool descriptions, pricing page, user notification. Nothing
customer-facing says "AI Search" or "AI research" after this ships.

## David's decisions

1. **REMOVE AI Search. Hard-remove, no deprecation window.** His reasoning: it only ever ran when
   there was no owner, so that an owner could be traced. Full Property Trace does that job with
   better results and returns more fields. *(This reverses an earlier "replace in place" plan,
   which was MY recommendation and was wrong. I made it before reading what `AIResearchResult`
   actually was. See History 2026-09-17.)*
2. **Trigger:** automatic when the owner is missing, PLUS an explicit opt-in for users who already
   have the owner but want the property record.
3. **First slice:** single record in the UI, visible and clickable.
4. **Charge follows the vendor call.** Spend at Tracerfy = charged. Served from the user's own
   stored record = free.

## Production reality, measured 2026-09-17 against the live DB

AI Search is **in real use** and is not dead code:

| | |
|---|---|
| `trace_history` rows carrying `ai_research` | **1,301** |
| Owner found | 887 (68%) |
| Not found | 411 |
| Charged | 743, totalling **$111.45** |
| Distinct users | **11** |
| Last used | 2026-09-14 |

Nothing is in flight: `ai_research_status` queued = 0, processing = 0, `research_jobs` unfinished
= 0. **A hard removal strands no work.** The 36 unfinished `trace_jobs` are all terminal `failed`,
not live.

**`api_logs` has 0 rows** despite a writer at `lib/api/auth.ts:108`. So either the public v1 API has
never been called, or request logging silently fails. Either way there is **no usage visibility on
the public API**, which is why the removal decision could not be made on evidence alone.

## WHAT MUST SURVIVE THE REMOVAL. Getting this wrong breaks paying customers.

- **`trace_history.ai_research` (1,301 rows) is CUSTOMER DATA THEY PAID FOR. Do not drop the
  column.** Stop writing to it; never delete it. Same for `ai_research_charge` and
  `ai_research_status` on historical rows.
- **`lib/ai-research/contacts.ts` STAYS.** `resolveOwnerContact()` is the single source of truth for
  "who is the human behind this owner" and is a hard dependency of `lib/suite/mcp-tools.ts:65-69`.
  `traceCreditFromFastAppend()` is load-bearing for the FastAppend credit path in
  `settleBulkJob.ts`. Only the Brave+Claude ENGINE goes.
- **The three refund sites that read `ai_research_charge`** (`sweep-business-traces:170`,
  `settleBulkJob.ts:151,177`) still have historical rows to service. Do not gut them.

## WHAT GETS DELETED

`lib/ai-research/client.ts` (the Brave+Claude engine) · `lib/brave/client.ts` · the five research
routes (`/api/research/single`, `/api/research/bulk`, `/api/research/bulk/status`,
`/api/v1/research/single`, `/api/v1/research/status`) · `app/api/cron/sweep-bulk-research` and its
`vercel.json` entry · `components/trace/AIResearchCard.tsx` · the AI Search UI in
`trace/single/page.tsx` and `trace/bulk/page.tsx` · the `aiResearch` flag path in
`app/api/v1/trace/single/route.ts` · the `research.completed` webhook · the AI-research sections of
the API docs · `ANTHROPIC_API_KEY` and `BRAVE_API_KEY` become unused.

## Architecture

**Billing gets a natural home, which it does not have today.** All current billing lives in the
POLL route because trace results are async. **The dossier is a synchronous JSON POST.** So tier 2
calls the dossier in the SUBMIT route and charges immediately after it returns. The charge fires in
the same request as the spend, which is exactly David's mechanical rule. Tier 1 contact traces stay
async and keep charging in the poll route. No charge moves; a second one is added where it belongs.

**One row per address per user, enriched in two phases.** `UNIQUE(user_id, address_hash)` already
holds. A tier 2 record is the same row gaining a property record first, contacts second. No schema
collision.

## Blocking defects this exposes, all must be fixed IN this build

| # | Defect | Why it is blocking |
|---|---|---|
| B1 | `checkSingleDuplicate` filters `.eq('is_successful', true)` (`deduplication.ts:111`) | A paid tier 2 record with a property file but no contacts is invisible to the cache, so the user is billed AGAIN for data they own. Directly violates David's rule. |
| B2 | `trace/single/route.ts:103-109` DELETES `is_successful:false` rows before re-tracing | Would delete a paid tier 2 record, orphan its `wallet_transactions` FK, and let the next submit bill again. Double-billing. |
| B3 | `charge > 0` implies `is_successful` everywhere | A billed tier 2 miss breaks the invariant. Needs a `tier` column so `$0.25` tier-1-wallet and `$0.25` tier-2-pro are distinguishable. `lib/constants.ts:34-36` already warns those digits collide. |
| B4 | Balance gates reserve the tier 1 rate (`trace/single/route.ts:52`) | Under-reserves for tier 2. |
| B5 | `planRoute()` hardcodes the `pro` price column (`ownerRoute.ts:44-46,57`) | Bills PAYG users 40% under rate. Needs a plan argument; changes the signature and touches its tests. |
| B6 | `ParcelInput` requires `parcelIdLocal` + `county` (`ownerRoute.ts:60-62`) | The entire app is address-shaped and NOTHING produces a parcel id. Address mode is proven (5/6, and it found a parcel APN mode missed), so these must become optional. |

## Phases. STOP AND CHECK IN AFTER EACH ONE.

**Phase 1 — the dossier client.** `lib/tracerfy/dossier.ts` following the house pattern: bearer
auth, never throws, `{success, ...}` return shape, no retries. Both key modes, APN then address,
caller stops at first hit. Tested against the 24 real saved vendor payloads in
`tasks/research-test/`, so the tests use genuine responses rather than invented fixtures.
**Visible:** a dry-run script printing a real parsed record.

**Phase 2 — the fixes that prevent double-billing.** B1, B2, B3 below. Adds `tier` and
`property_record JSONB` to `trace_history`, makes the cache tier-aware, stops the delete path
eating paid rows. Mutation-tested. **Visible: nothing. Flagged bluntly rather than dressed up.**
This is also where the missing tests get written, BEFORE behaviour changes.

**Phase 3 — execute the plan.** Split in two because 3b was blocked on a pricing decision.

*3a (in flight):* B5 (plan-aware `planRoute`, and the default must NOT stay `pro`), B6
(`ParcelInput` accepts an address-only parcel), and `executeRoute()` — runs a plan, stops at the
first hit, re-enters `planRoute` with the discovered owner, distinguishes a vendor FAILURE from a
MISS. No billing, no persistence, no routes.

*3b:* wire it into the single-trace API with per-record billing and persistence.

**Billing rules, settled 2026-09-17, both by David:**
- **Every record submitted is billed, including a total dossier miss.** "Per record" is literal.
  A customer can receive nothing and still be charged. Legitimate, but see the UI requirement.
- **The miss is CACHED.** A re-submit inside 90 days is free. A billed tier-2 miss row is
  `tier = 2`, `charge > 0`, `property_record IS NULL`, `status = 'no_match'`, and
  **`CACHE_HIT_FILTER` needs a third arm for it** or it re-buys. The delete guard already covers
  it, because `isBilledRow` is true on `charge > 0`.
- Deduct fires AFTER the dossier call returns, in the same request, because the dossier is a
  synchronous POST. Never on submission: a record that dies on validation before any vendor call
  must not be billed.

**ZIP BACKFILL, added to 3b by David 2026-09-17.** The dossier returns the situs ZIP; pass 2's
named person lookup currently runs without it. Tracerfy documents the ZIP as strongly recommended
for that lookup, and the handoff notes address mode backfilling it "matters because no Utah county
publishes one". A match-rate improvement on the step that decides whether the customer gets a phone
number at all.

Two traps, both fenced by tests:
- **The response carries TWO zips.** `property.zip_code` is the SITUS zip (100% fill, the one you
  want). `mailing_address.zip` is the OWNER'S MAILING zip, a different state entirely for an
  absentee owner, and 21 of 24 parcels measured absentee. Using it would look like an improvement
  while quietly making matches worse.
- **`address_hash` excludes the ZIP by design** since migration 20260904. Persisting a learned ZIP
  must NOT recompute the hash, or the row stops matching its own cache key and every future lookup
  re-buys.

**Visible:** Full Property Trace works end to end on one address via the API.

**PHASE 4 REQUIREMENT this creates, not optional:** the UI must disclose that a charge applies
whether or not anything is found, BEFORE the submit. The existing AI Search dialog says "You will
be charged $0.15 if an owner is found"; tier 2 needs the inverse sentence.

**Phase 4 — remove AI Search and ship the UI.** The deletion list above, plus the Full Property
Trace panel, the opt-in toggle, and every string that currently says AI Search. Kill
`Free (no owner found)` at `AIResearchCard.tsx:47`, which per-record billing makes false.
**Visible: this is the phase David judges.**

**Phase 5 — bulk.** Pre-flight balance check, and budgeting against the SHARED 500/min pool: Full
Property Trace spends TWO calls per parcel, so 150 parcels is ~300 of the pool, not 150.
Deliberately last, because this is where a truncated run does real damage.

## DATA FIDELITY REQUIREMENT. David, 2026-09-17. Not optional, not a phase-5 nicety.

> *"All the fields available in Tier 2 will be added to the database, and must also be added to the
> export engine, when we get there."*

**Two obligations, and the second one was missing from this plan entirely:**

1. **STORE ALL 86 FIELDS.** Not the 46 usable ones, not the 3 currently read. The whole
   `response.property` object lands in `property_record JSONB` verbatim. This is the same rule as
   the registry's `raw_attributes`: **the raw dump IS the product.** A field that is empty in OH,
   CA and UT may be populated in another county, and a stored raw record costs nothing extra
   because the $0.20 was already spent to fetch it.
2. **EXPORT ALL 86 FIELDS.** `app/api/trace/bulk/download/route.ts` currently emits contact columns
   only. Every dossier field must reach the CSV. A customer who paid for an 86-field record and
   receives a 9-column CSV did not get what they bought.

**Design rules for the export, so it does not break the people already using it:**

- **APPEND the new columns, never reorder or rename the existing ones.** Customers have import
  mappings into their CRMs. Appending is safe for both header-keyed and index-keyed importers;
  reordering silently corrupts the index-keyed ones.
- **Emit a STABLE column set.** Every dossier column appears in every export whether or not it is
  populated for that row, so the CSV shape does not shift between runs. A user building a recurring
  import cannot have columns appear and disappear.
- **Empty means empty.** A field the county did not publish exports as blank. Never a zero, never
  "N/A", never a placeholder. Per CLAUDE.md rule 7 and [[feedback_no_fake_data]].
- **Single-record needs an export too**, or the feature is bulk-only in practice. Not currently
  planned; flag it at phase 4.

### SETTLED 2026-09-17: the blocked fields are blocked from EXPORT too.

David confirmed the 7 provably-wrong fields and the 15 propensity scores stay blocked. "All the
fields available" means all the LEGITIMATE fields; the wrong ones are not available by our own
earlier decision. An export lands in a customer's CRM where a wrong `estimated_value` looks
authoritative and outlives any caveat we could put on a screen.

**The two exclusion categories are NOT the same and must never be merged again:**

| Category | Count | Store? | Export? | Why |
|---|---|---|---|---|
| Provably wrong | 7 | YES, raw | **NO** | `estimated_value` IS the assessed value, there is no AVM; equity/`high_equity`/`free_clear` all derive from it; `corporate_owned` returned FALSE for a Delaware LP; `price_per_sqft` is 0 with no sale. More counties will NOT fix vendor math. |
| Propensity scores | 15 | YES, raw | **NO** | Equity-contaminated, and the renovation models are residential: they score a 41,588 sqft building as a "large home". |
| Never seen in our sample | 18 | YES, raw | **YES, as empty columns** | Coverage, not correctness. Absent in OH/CA/UT says nothing about other counties. NOT blocked. |

**Therefore the export carries 64 columns.** 86 returned, minus 7 wrong, minus 15 scores. Of those
64, **46 held a usable value at least once** in the 24-parcel sample and 18 did not, which is why
the stable-column-set rule matters: all 64 ship every time, blanks included.

**This also finally makes the marketing claim exact.** "Over 60 fields" is 64 fields actually
delivered to the customer, derivable from the measured inventory rather than asserted. Earlier in
this session I challenged that claim as unsupported; it is now supported, with a number behind it.

## PHASE 1 REVIEW — COMPLETE 2026-09-17

`lib/tracerfy/dossier.ts` plus 34 tests, 6 sanitized fixtures, and a dry-run script. Nothing wired
to any route, UI or billing path. No live API call was made.

**Verified independently, not relayed:** 265 tests passing (from 231), `tsc` 9 pre-existing dotenv
errors unchanged, eslint 55 problems unchanged from the `main` baseline.

**Two things the real payloads corrected before a line was written:**

1. **`property` carries NO owner field.** The owner lives in `response.owners[]`. The plan assumed
   otherwise; building from the plan would have shipped a client that silently returned no owner.
2. **An entity arrives as `{ first_name: "", last_name: "Colmaven, Llc", age: "" }`** — the whole
   entity name in `last_name`. Some parcels return TWO owners, which maps onto the `owner_name` /
   `owner_name_2` pair `trace_result` already has.

**The fidelity fence is real and I mutated it myself.** Subsetting the property object to drop
empty-valued keys — the plausible "cleanup" a future dev makes — turns **7 tests red**. Restored
green. A client that quietly returns fewer than 86 keys cannot ship without someone deleting a test
on purpose.

**PII: the fixtures are clean, verified independently.** `tasks/research-test/` is gitignored
because it holds purchased data on 63 real people, so tests could not read from it. Fixtures are
sanitized derivatives: the full 86-key property object and entity names kept, individual names,
ages and the whole `contacts` block scrubbed. I harvested 373 real-person values from the corpus
and word-boundary matched them against every committable file: **zero leaks**. My first scan
reported 40+ hits and was wrong — it substring-matched, so `estimated_mortgage_payment` matched on
"age" and the propensity `_factors` arrays have a literal `name` key. Worth remembering: a PII
scanner that matches loosely produces false alarms that are indistinguishable from real ones.

**Deviations from the house pattern, each deliberate:**
- Env read at call time, not module load. `client.ts` freezes the key at import, which makes the
  missing-key branch untestable.
- A contaminated key (fields from both modes) is REFUSED, not silently stripped. Quietly keying on
  the APN when the caller meant the address would charge $0.20 for the wrong parcel.
- A `"Stark County"` guard rejects before spending rather than posting a body that cannot match.
- `response.contacts` is parsed but not surfaced. It carries PII and the contact step is a separate
  vendor call on a separate ledger line. Phase 3 can add it if needed.

**Known limitation, flagged not hidden:** the individual-owner and two-owner fixtures derive from
the SAME source record, because `dossier/raw-10.json` is the only natural-person owner in all 24
saved payloads. Everything else is entity-owned. So the individual shape is genuine but
uncorroborated; if a future payload shows a different shape, that fixture is the one to revisit.

## PORTFOLIO-DEBT GAP. Raised by David 2026-09-17. NOT currently in this plan. My omission.

**Three separate findings. Only the first is good news.**

### 1. `assessLoan()` already handles both cases David raised, better than the handoff implies

- **Stale sale:** `SALE_BASIS_MAX_AGE_YEARS = 10`. Past that, the bands widen from 1.25/2.5 to
  **2.0/4.0**, so a 15-year-old sale plus a recent refi does NOT get falsely called portfolio.
- **No sale price at all:** falls back to $/sqft of building area. Portfolio above $1,000/sqft,
  suspect above $600/sqft, otherwise `unknown`.
- **Neither:** returns `unknown` rather than guessing.

### 2. But it detects STALENESS, not REFINANCING, and three useful fields go unread

A refi is a different event from appreciation, and `assessLoan` cannot tell them apart. The dossier
carries **`recording_date` (82%)**, **`document_type` (82%)** and **`years_owned` (82%)**, and
`LoanInput` takes **none of them**. A recording date much newer than the sale date is a refi
signal sitting unused at a higher fill rate than `last_sale_price` itself.

### 3. THE SALE-PRICE BASIS IS ALMOST NEVER AVAILABLE. Measured, 24 saved parcels:

| | |
|---|---|
| Parcels carrying an open mortgage balance | **7** |
| Judgeable against a sale price | **1** |
| Forced onto the $/sqft fallback | **6** |

So the method the handoff presents as *the* approach applies to **1 in 7** mortgaged parcels. And
the fallback resolves only the extreme: of those 6, five come back `unknown` and one is caught
($4,208/sqft, the $175,000,000 blanket loan on 41,588 sqft).

**Net: 5 of 7 mortgaged parcels get NO usable loan verdict.** One sits at $586/sqft, fourteen
dollars under the suspect threshold. Another is David's exact scenario: **$2,725,000 against 7,700
sqft, `years_owned` 13, no sale price** — long hold, large loan, unjudgeable.

### THE HOLE THIS OPENS IN THE EXPORT DECISION

`open_mortgage_balance` is in the **64 exported columns**, and it ships **bare, with no verdict
beside it**. A customer exporting these parcels receives `$175,000,000` against a 41,588 sqft
building as a plain number in a spreadsheet column.

**That is the same failure class as `estimated_value`, which we BLOCKED.** A real vendor number
that misleads when presented without its context, landing in a CRM where it looks authoritative and
outlives any caveat on a screen. We blocked one and are shipping the other.

### SETTLED 2026-09-17: export a VERDICT COLUMN beside the balance.

David's call. `open_mortgage_balance` keeps shipping, and `assessLoan()`'s judgement ships next to
it so the number is never read bare. **`assessLoan()` has zero callers today; wiring it is phase 3.**

Minimum derived columns, recommended:

| Column | From | Why |
|---|---|---|
| `loan_verdict` | `assessLoan().verdict` | `parcel_level` / `suspect` / `portfolio` / `unknown` |
| `loan_basis` | `assessLoan().basis` | `sale` / `stale_sale` / `sqft` / `none`. **Tells the customer how much to trust the verdict**, which matters because `sqft` is the basis 6 times out of 7. |

Also available and worth considering: `loan_per_sqft` (`dollarsPerSqft`) and `building_area_suspect`
(`buildingAreaSuspect`), which flags when the square footage contradicts the sale badly enough to
distrust the sqft, e.g. the observed 20-39 unit complex reporting 782 sqft.

`loan_verdict` will read `unknown` on roughly 5 of 7 mortgaged parcels. That is honest and it is
the point: an empty verdict says "we cannot tell", which is the truth, and is what stops a customer
reading $175,000,000 as parcel debt.

### `price_per_sqft` RESOLVED: it is SALE-derived, not assessed. Measured, not assumed.

David asked where it comes from, on the reasonable worry that it was assessed-value-derived. It is
not. Verified against every parcel carrying both inputs:

| `price_per_sqft` | sale ÷ sqft | assessed ÷ sqft |
|---|---|---|
| 64 | **64.43** | 19.45 |
| 370 | **369.98** | 169.76 |
| 349 | **348.88** | 58.14 |

It is `last_sale_price ÷ building_size_sqft`, full stop. **So it belongs in a different category
from the other 6 blocked fields.** Those are blocked because they are WRONG (`estimated_value` IS
the assessed value; equity and `free_clear` inherit that error). `price_per_sqft` is merely
REDUNDANT, being derivable from two columns already exported, and the handoff blocked it on a
redundancy argument, not a correctness one.

**SETTLED 2026-09-17, David: EXPORT it, with its 0 rendered BLANK.** It reads 0 on 9 of 12 parcels
and in every one of those cases the cause is no sale price on record. **0 does not mean "$0 per
foot", it means "unknown", and shipping a 0 into a spreadsheet column is fake data** under
CLAUDE.md rule 7 and the export rule above. Blanked, the field is honest and useful.

**The export is therefore 65 raw columns** plus the derived loan columns, and **6 fields stay
blocked, not 7.** The blocked six are `estimated_value`, `estimated_equity`, `equity_percent`,
`high_equity`, `free_clear`, `corporate_owned` — every one of them blocked for being WRONG.

**Implementation note for phase 2/3:** the 0-to-blank rule is not special-cased to
`price_per_sqft`. Any numeric dossier field whose 0 means "not on record" must export blank. Decide
this per field against the measured inventory, do NOT blanket-convert every 0, because a genuine
0 exists for some fields and erasing it would be its own lie.

**Do not confuse the two per-foot numbers.** `price_per_sqft` is a VALUE metric (sale ÷ area).
`assessLoan().dollarsPerSqft` is a DEBT INTENSITY metric (mortgage ÷ area) and is what produced the
$4,208/sqft that caught the $175,000,000 blanket loan. Neither derives from assessed value.

## Copy debt this creates

- **The user notification needs a new paragraph.** It currently explains a price change. It does
  not say AI Search is going away, that Full Property Trace replaces it, or that the meter moves
  from per-success to per-record. 11 users will notice.
- **The marketing pages need a FULL SECTION on Full Property Trace**, not a bullet. It is the whole
  justification for the tier 2 price. Recorded in the handoff and History.
- **The 68% vs 96% story is worth telling.** AI Search found an owner 68% of the time in
  production; the dossier hit 23 of 24. Those 11 users are getting a better product at a higher
  price, and saying so is more persuasive than announcing an increase.

## Known risks

- **The research path is almost entirely untested.** No tests exist for `research/*` routes,
  `lib/ai-research/client.ts`, `lib/tracerfy/client.ts`, `deduplication.ts`, or any UI. Only
  `settleBulkJob.test.ts` and `mcp-tools.test.ts` will fail loudly on a bad change. Everything else
  fails silently. Phase 2 must add tests before it changes behaviour.
- **Registration state is still unresolved.** Entity calls send the property state, 13 of 22. Not
  blocking, but tier 2 inherits that miss rate.
- **`PRICING.COST_PER_RECORD` is $0.009**, written to `cost` at 14 sites, read at none, and
  contradicts the verified $0.02/credit.

## Open for David, not blocking Phase 1

- **Does a cache HIT on tier 2 bill?** David's rule says no, because nothing is spent at Tracerfy.
  Recorded that way. Flagging only because "per record submitted" could be read the other way.
- **FCRA permissible-use pass-through.** Still unplaced.

### H. Deliberately NOT done
- [ ] `supabase/schema.sql:134` `unit_price DECIMAL(10,4) DEFAULT 0.07` is baked into the LIVE
      database. Write the migration, do NOT apply it. Applying before push makes prod data
      inconsistent with prod code.
- [ ] History.md, tasks/*, docs/superpowers/specs/, docs/superpowers/plans/ are historical
      records. Do not rewrite prices in them.
- [ ] goacquisitionpro.com and the Stripe dashboard hold copy outside this repo. Separate pass.

## PHASE 2 REVIEW — COMPLETE 2026-09-17

**Visible output: none, and that is the phase.** Phase 2 makes the tier 2 row shape safe BEFORE
anything can create it. Nothing is wired. No route gains a feature. Flagging that bluntly rather
than dressing it up, per the phase plan above.

### Order of work: tests first, and the baseline is recorded

`lib/utils/deduplication.ts`, `app/api/trace/single/route.ts`, `app/api/v1/trace/single/route.ts`
and `app/api/cache/clear/route.ts` had ZERO coverage while carrying the billing path. 45
characterization tests pinning the CURRENT behaviour went green against unmodified code first:

| | |
|---|---|
| Green characterization baseline | **310 passing, 34 files, 0 failing** (from 265 / 30) |
| Failures after the fixes landed | 14, every one a characterization test pinning replaced behaviour |
| Final | **337 passing, 36 files, 0 failing** |

### What actually happens today at the failed-delete-then-insert path (B2, asked explicitly)

Measured by characterization test before the fix, not inferred:

1. `trace/single/route.ts:104-109` deletes `WHERE is_successful = false`. If the row is referenced
   by `wallet_transactions` or `usage_records` (both `REFERENCES trace_history(id)` with NO
   ON DELETE clause, i.e. NO ACTION), Postgres raises **23503** and PostgREST returns it as an
   error envelope.
2. The route **discards the error**. The row survives. Execution continues as though it had not.
3. The INSERT at ~:135 then violates `UNIQUE(user_id, address_hash)` and comes back **23505**.
4. `insertError` IS checked, so this is **a hard error, not an upsert and not a silent no-op**:
   HTTP **500** with the generic body `{success: false, error: "Failed to process request"}`.
   The real cause (duplicate key) reaches only the server log.
5. Net effect: **the address becomes permanently un-retraceable.** "Clear cache" does not rescue
   it, because `skip_cache` and `/api/cache/clear` delete the same referenced row and fail the same
   way — and `cache/clear` then returned `{success: true}` regardless.

No double CHARGE occurs on that specific path, because tier 1 bills in the poll route. The damage
is a dead address plus a lie about success.

### Does `checkDuplicates` (bulk) need work? No.

It never narrowed to `is_successful = true`. Any row inside the dedup window (bar a stale
`processing` one) already counts as a duplicate, so a tier 2 row carrying a property record but no
contacts is already a free cache hit there. Its bias runs the OTHER way — a plain failed row also
blocks resubmission — which is pre-existing, costs the customer nothing, and is not this phase's to
change. Documented in the function's docstring so the next reader does not "fix" it.

### Changes

- `supabase/migrations/20260917_trace_history_property_record_tier.sql` — **written, NOT applied.**
  `property_record JSONB` + `tier SMALLINT`, both nullable. Header carries DO NOT APPLY UNTIL PUSH,
  the ordering note (this one is the OPPOSITE of 20260916: old code ignores the columns, new code
  REQUIRES them, so apply at or immediately BEFORE the deploy, never after), and the reason there
  are no GRANTs.
- `supabase/schema.sql` — same two columns, declared after `created_at` so a fresh provision has the
  same column order as a migrated production table.
- `lib/trace/billedRows.ts` — NEW. One definition of billed
  (`charge > 0 OR ai_research_charge > 0 OR property_record IS NOT NULL`), the SQL predicate that
  excludes it, `CACHE_HIT_FILTER`, and `TRACE_TIER`.
- `lib/utils/deduplication.ts` — B1. `checkSingleDuplicate` now matches
  `is_successful = true OR property_record IS NOT NULL`.
- `app/api/trace/single/route.ts`, `app/api/v1/trace/single/route.ts` — B2. Every delete guarded and
  error-checked; delete-then-insert became **reuse**: a row that survives the guarded deletes is
  UPDATED in place, because `UNIQUE(user_id, address_hash)` already means one row per address per
  user and tier 2 enriches one row in two phases.
- `app/api/cache/clear/route.ts` — B2. Guarded, and it no longer reports success on a failed delete.
- B3 — `tier` stamped at all **16** sites that write `trace_history.charge`, across
  `trace/status`, `v1/trace/status`, `trace/bulk/status`, `sweep-stale-traces`,
  `sweep-bulk-research`, `sweep-business-traces` and `settleBulkJob`. No backfill.

### Mutation verification: 19 mutations, 19 caught

Each fix reverted in isolation, full suite re-run, tree restored. Every one turned at least one
test red (1 to 8 failures each). Includes the `tier` stamps, the `property_record` arm of
`isBilledRow`, both halves of `CACHE_HIT_FILTER`, both reuse branches and both delete-error checks.

### Verified numbers

| | Baseline | After |
|---|---|---|
| `npx vitest run` | 265 passing / 30 files | **337 passing / 36 files, 0 failing** |
| `npx tsc --noEmit` | 9 errors, all dotenv in `tasks/research-scripts` | **9, unchanged, zero elsewhere** |
| `npx eslint app lib components` | 55 problems | **54** (one fewer: an unused `PRICING` import removed) |

### Deliberately NOT done, and why

- **Migration not applied.** As instructed.
- **`planRoute` / `ownerRoute.ts` / `dossier.ts` untouched.** Phase 2 wires nothing.
- **No pricing constant, marketing string or "60+ fields" claim changed.**
- **`ai_research*` columns untouched.** 1,301 rows of paid customer data.
- **No backfill of `tier`.** NULL honestly means "before tiers existed".
- **The reuse UPDATE does not clear `trace_result` / `is_successful` / `phone_count`.** Clearing
  them would destroy paid-for contact data if the new trace then failed. The status route overwrites
  them on completion. Cost: a row re-traced after the 90-day cache window shows its previous result
  while `status = 'processing'`. Previously that path 500'd outright, so this is strictly better,
  but it IS a behaviour change worth knowing about.
- **`skip_cache` and `/api/cache/clear` no longer remove a billed row.** Intended: the customer paid
  for it, so it is theirs to be served from. The retry still works because the submit route reuses
  the surviving row instead of colliding with it.

---

# REVIEW: Phase 3a (2026-09-17) — B5, B6 and the executor. In the tree, uncommitted.

Scope was 3a only: the two `ownerRoute` defects plus a route EXECUTOR. **No billing, no
persistence, no API route, no UI**, and no file under `app/` was touched. 3b still waits on the
pricing decision.

## What changed

- [x] **B5 — `planRoute(parcel, pricePlan)`.** Plan is a **required** parameter.
      `DEFAULT_PRICE_PLAN` is deleted; `FAILSAFE_PRICE_PLAN = 'wallet'` replaces it and is used
      only when a value escapes the compiler (a JS caller, a NULL plan column). Required beats a
      safe default because the compiler then blocks the mis-wire before a customer sees it; the
      failsafe points at the **dearest** column so anything that still slips through overcharges
      visibly instead of undercharging silently.
- [x] **B6 — `parcelIdLocal` and `county` are optional.** The existing no-APN path was verified,
      not rewritten. The one branch that genuinely broke was the tier 1 `TRACERFY_PARCEL_APN`
      fallback, which would have sent `parcel_id: undefined`; it now routes to manual review.
- [x] **`RoutePlan` echoes `pricePlan` and `parcel`** so the two-pass re-entry is faithful.
- [x] **`lib/routing/executeRoute.ts`.** `executeRoute(plan, deps)`. Stop at first hit; two-pass
      re-entry classified by NAME; per-step spend read from `credits_deducted`; raw 86-key record
      passed by reference; a vendor failure is never a miss; never throws.
- [x] 43 tests added, written first. Six mutations applied and reverted; all killed.

## Numbers

| | Before | After |
|---|---|---|
| `npx vitest run` | 337 passing, 36 files | **380 passing, 37 files, 0 failing** |
| `npx tsc --noEmit` | 9 errors (all dotenv, research-scripts) | **9, unchanged** |
| `npx eslint app lib components` | 54 problems | **54, unchanged** (`lib/routing` is clean) |

## What 3b inherits, and the one thing it must not get wrong

`ExecutionResult.success` is the billing gate, **not** `ownerFound`. Under the 2026-09-17
per-record decision a dossier MISS is billed and returns `success: true, ownerFound: false,
vendorSpend: 0`. A vendor FAILURE returns `success: false` with `error` set and must not be
billed at all. The two are indistinguishable by `ownerFound` alone, which is exactly the
mistake that would bill customers for an outage.

Still open for 3b: `executeRoute` does not backfill a missing zip from the dossier record before
the contact call, though the address-mode step's own `why` notes the dossier returns one. It is a
possible match-rate improvement for the named Tracerfy lookup, not a defect.

---

# REVIEW: Phase 3b (2026-09-17) — tier 2 wired into the session route. In the tree, uncommitted.

**A NEW BILLING PATH.** Tests first, every money decision mutation-verified, and the two things
that were ambiguous are named at the bottom rather than guessed.

## Numbers

| | Before (3a) | After |
|---|---|---|
| `npx vitest run` | 380 passing, 37 files | **478 passing, 39 files, 0 failing** |
| `npx tsc --noEmit` | 9 errors (all dotenv, research-scripts) | **9, unchanged, zero elsewhere** |
| `npx eslint app lib components` | 54 problems | **54, unchanged** |
| Mutations applied / caught | 6 / 6 | **21 / 21** |

## The trigger, and the flag

`full_property_trace: true` (session body, snake_case, matching the route's other flags) OR an
absent `owner_name`. Both live in one predicate, `isFullPropertyTrace()`, so the two halves cannot
drift apart between the balance gate and the execution.

**It is NOT `ai_research`.** That flag belongs to a feature being deleted in phase 4.

**The opt-in path is dossier-first.** `parcelForFullTrace()` deliberately passes `ownerName: null`
even when the caller supplied one: `planRoute` with an owner name present returns a TIER 1 plan
with no dossier step, so honouring the caller's name would take their money for a property record
and never buy it. The supplied name is still stored as `input_owner_name`.

## The charge sequence, in order, and none of it may move

1. **Pre-flight.** `chargePerRecord(profile)` — the TIER 2 rate. The old gate reserved the tier 1
   rate and under-reserved by $0.10-$0.15.
2. **Cache.** A billed tier 2 row is SERVED from the database, free, whatever it contains.
3. **Row first, vendors second.** The row exists before any vendor is called, so the deduct has a
   `trace_history_id` to reference.
4. **`planRoute(parcel, pricePlanFor(profile))`** — pure, no spend, the caller's real plan.
5. **`executeRoute(plan, { lookupDossier, lookupBusinessTrace, lookupPersonTrace })`** — dossier,
   then contacts for whatever owner it found. Synchronous.
6. **`if (!execution.success)` → charge NOTHING**, mark the row `error`, 502. Nothing billable is
   persisted, so the retry is free AND still able to complete.
7. **`deductOrZero(...)` ONCE**, at `plan.billing.amount`, AFTER the vendors answered.
8. **Persist what was COLLECTED**, not what was intended, alongside `tier = 2`, the raw property
   record, and the real vendor spend in `cost`.

## The four rules, and the test that fails when each is inverted

| Rule | Mutation | Tests red |
|---|---|---|
| The gate is `success`, never `ownerFound` | gate on `ownerFound` | 12 |
| A vendor failure is never billed | drop the failure gate | 3 |
| A total dossier miss IS billed | skip the deduct when `property` is null | 5 |
| Persist only what was collected | persist `attemptedCharge` | 1 |
| Reserve the tier 2 rate up front | reserve `chargePerTrace` | 1 |
| The cache serves a billed tier 2 miss | drop the third arm of `CACHE_HIT_FILTER` | 3 |
| ...and only when money moved | relax it to `tier.eq.2` | 3 |
| The route SERVES that row | delete the `isCacheHitRow` branch | 2 |
| Bill the caller's real plan | hardcode `'pro'` | 10 |
| Store all 86 keys | subset to the populated fields | 1 |
| The opt-in is half the trigger | delete the flag arm | 1 |
| The opt-in still buys the record | pass the caller's owner into the plan | 1 |
| Backfill the SITUS zip | read `mailing_address.zip` | 3 |
| The caller's zip wins | prefer the dossier's | 1 |
| A learned zip never moves `address_hash` | write the hash alongside it | 1 |
| A "REGISTERED AGENT,MANAGER" is a manager | exclude every flagged person | 1 |
| A FastAppend miss is an answer | treat `error` as a failure | 1 |
| Match the person on the NAME | take `persons[0]` | 2 |
| `find_owner: false` plus a name | send `find_owner: true` | 1 |
| A company name is never the contact person | fall back to the owner of record in `owner_name` | 2 |
| The charge follows the vendor call | delete the "no step was planned" guard | 1 |

**21 of 21 caught.** Each applied in isolation, full suite re-run, tree restored.

One further attempt was discarded rather than counted: making `parcelForFullTrace` read an
`ownerName` off its own input changed nothing at runtime, because the route never passes one. It
was replaced by the mutation that matters — the ROUTE passing `owner_name` into the plan — which
is the row above marked "the opt-in still buys the record".

## The synchronous vendor callables

`lib/tracerfy/client.ts` gains `lookupBusinessTrace()` and `lookupPersonTrace()` plus their two
pure parsers. No existing function was rewritten: the batch path the AI research flow still runs on
is untouched. This removes the polling the handoff named as defect 4 — the whole tier 2 request is
now one HTTP request with three vendor round trips inside it.

`lookupPersonTrace` covers BOTH Tracerfy person endpoints, choosing by the key it was handed:
`parcel_id + county` goes to `trace/parcel/lookup/`, anything else to `trace/lookup/` with
`find_owner: false` and the name. The parcel form is unreachable from this route today (nothing in
PTP produces a parcel id) and is implemented anyway because `executeRoute` can plan it.

**Two defects found in the saved payloads, both of which would have cost money:**

1. **A FastAppend MISS carries `error: "Company not found: X (OH)"` alongside `hit: false`.**
   Reading `error` as a failure would have made every legitimate miss unbillable — and under tier 2
   a miss is exactly what we are entitled to bill for.
2. **`role` is a comma-separated LIST.** 1 of the 5 saved hits returns a single person whose role
   is `"REGISTERED AGENT,MANAGER"` with `is_registered_agent: true`. Excluding everyone the flag
   marks — the obvious reading of "a registered agent is not a principal" — would have thrown away
   the contact on 20% of the hits we paid for. Only a person whose ONLY role is registered agent is
   dropped, and when that is all there is, the company block is returned with NO name attached.

`maxDuration = 60` on the session route. It had none, which means the platform default; three
vendor round trips do not reliably fit in it. 60 matches `app/api/v1/trace/single/route.ts`, the
only other route in this codebase that makes inline vendor calls.

## The zip backfill (added to 3b by David, reported separately)

`executeRoute`'s pass 2 now populates `situsZip` from the dossier's `property.zip_code` when the
caller supplied none, and `ExecutionResult.learnedZip` carries it out so the route can persist it.

- **The situs zip, never the mailing zip.** `property.zip_code` is the property's own and is
  present on all 16 saved payloads that carry a property object. `mailing_address.zip` is the
  OWNER'S and is routinely another city or state. Using it would have looked like a match-rate
  improvement while quietly lowering the match rate. Fenced by a test that asserts the two differ.
- **The caller's zip wins.** Never overwritten.
- **`address_hash` is untouched.** It is sha256 of STREET|CITY|STATE and excludes the zip by
  design (migration 20260904), so the column can gain a value without the row losing its own cache
  key. A test asserts the update payload contains neither `address_hash` nor `normalized_address`.

**One real bug had to be fixed to make the backfill reachable:** the zip is OPTIONAL at validation,
but the route did `zip.substring(0, 5)` unconditionally, so a submission without one threw a
TypeError and returned a bare 500 before any vendor was called. It now stores `null`.

## What gets persisted

| Column | Value |
|---|---|
| `property_record` | the vendor's object BY REFERENCE, all 86 keys, unfiltered and unrenamed |
| `tier` | 2 |
| `charge` | what `deductOrZero` actually collected |
| `cost` | `execution.vendorSpend`, read from the vendors' own credit counters |
| `trace_result` | contacts, in the tier 1 shape, where every downstream reader already looks |
| `zip` | only when the dossier taught us one and the caller had none |

`trace_result.owner_name` is the PERSON (null for an entity with no named principal — a company
name is never a contact person, per `resolveOwnerContact`). `trace_result.owner_name_2` is the
OWNER OF RECORD the dossier bought. It has nowhere else to live: the 86-key property object carries
no owner field, and injecting one into a raw dump is not an option. **Flagged for phase 4:** the
results card renders `owner_name_2` as a second "Owner Name" line, which is accurate but not
labelled as the owner of record.

## DEFERRED: `app/api/v1/trace/single/route.ts`. It is NOT a clean parallel.

**The blocker is a double charge, not a style difference.** That route still runs AI research
inline when `aiResearch && !ownerName`, and deducts `AI_RESEARCH.CHARGE_PER_RECORD` ($0.15) when it
finds an owner. An absent `ownerName` is ALSO the tier 2 trigger. Wiring tier 2 in as specified
would make a single request run both engines over the same record and bill **$0.15 + $0.25-$0.40**
for it, while the two paths race to resolve the same owner by different means.

**Three ways out, and the choice is David's:**

1. **`fullPropertyTrace` suppresses `aiResearch`** on that route — tier 2 wins, the older engine is
   skipped and not billed. Closest to "AI Search is being replaced".
2. **Tier 2 is opt-in ONLY on v1** (no automatic trigger on an absent owner) until phase 4 deletes
   the research path. Smallest change, but v1 then prices the same request differently from the
   session route, which is its own trap.
3. **Do v1 in phase 4**, immediately after the AI research path is deleted, when the collision
   cannot exist. **Recommended**, because phase 4 has to touch that route anyway.

**A second, smaller divergence exists regardless:** v1 is Track B and derives its rate from the RAW
`getChargePerTrace(subscription_tier, is_acquisition_pro_member)`, deliberately NOT the grant-aware
`chargePerTrace`. It therefore needs its own plan-derivation function; `pricePlanFor` is Track A
only and must not be reused there.

**There is also no usage visibility on v1 at all** (`api_logs` holds 0 rows), so nobody can say how
many callers a trigger change would surprise.

## Known gaps, flagged not hidden

- **No `trace.completed` webhook and no HighLevel push on a tier 2 completion.** Tier 1 fires both
  from the POLL route; tier 2 never reaches that route because it completes inline. A webhook
  customer would silently stop receiving events for tier 2 traces. Not wired here because it is an
  integration surface nobody asked this phase to touch — **phase 4 must wire it or say why not.**
- **A pass-2 failure discards a dossier record we paid $0.20 for.** The rule is settled (a vendor
  failure is never billed), and the alternative — persisting the record unbilled — makes the row a
  free cache hit that can never acquire contacts, so the customer would be permanently stuck with a
  partial answer. The cost is ours and it only occurs during a contact-vendor outage.
- **Re-tracing an address OVERWRITES `charge` on the reused row.** Inherited from the phase 2 reuse
  design, and true of tier 1 as well (the status route does the same). The dashboard SUMs that
  column, so a re-traced address contributes once, not twice. `wallet_transactions` remains the
  real ledger. Worth a decision, but not a phase 3b regression.
- **The session UI will now bill per record for any trace with no owner name.** That is the
  decided trigger, and phase 4's disclosure requirement ("you are charged whether or not anything
  is found, BEFORE the submit") is what makes it safe to expose. **Do not ship the UI without it.**

---

# PLAN: Phase 4 (2026-09-17) — remove AI Search, ship the UI. APPROVED by David.

## FOUR CORRECTIONS TO THE DELETION LIST ABOVE. It is wrong, and one of them breaks bulk.

Surveyed three ways and checked against the live DB today, not taken from the note.

1. **`app/api/v1/research/status/route.ts` must NOT be deleted.** Despite the path it polls
   `business_trace_jobs`, the FastAppend async recovery that SURVIVES. It is a documented customer
   polling endpoint, cross-referenced twice in the API docs (lines 296, 500). It only incidentally
   reads `ai_research`. Keep the route AND the path: renaming a public path is a breaking change.
2. **`isLikelyBusiness()` lives inside `lib/ai-research/client.ts`** and is imported by two
   survivors, `app/api/v1/trace/bulk/route.ts:7` and `lib/suite/mcp-tools.ts:7`. It relocates.
3. **`AIResearchResult` cannot leave `types/index.ts`.** Five surviving production files import it.
   It is the storage shape for FastAppend business-trace contacts, not just for the search engine.
4. **Deleting `sweep-bulk-research` breaks BULK, not just AI Search.** It is the ONLY path that
   resolves entity-owned bulk rows, and it does it by calling `researchProperty()`.

## LIVE DB, 2026-09-17. Re-derived, because the volume is not where the plan assumed.

| | |
|---|---|
| `ai_research_status` queued / processing | **0 / 0**. Nothing in flight; removal strands no work. |
| AI Search rows from **BULK** | **987 of 1,301** (714 known entity owner, 273 blank owner) |
| AI Search rows from single trace | 314 (300 blank owner, 11 with an owner) |
| Bulk jobs to date, last used | 92, **2026-09-14** |

**76% of AI Search volume was bulk.** The written plan treats this as a single-trace feature.

## THREE USER-FACING MONEY STRINGS GO FALSE ON REMOVAL

`NO_MATCH_TERMS` (`app/api/[transport]/route.ts:45`), `PTP_MCP_CAVEAT`
(`lib/suite/mcp-shared.ts:17`), and the `worstCaseCost` quote (`lib/suite/mcp-tools.ts:112-124`),
which adds $0.15 per entity record to every MCP quote shown before a wallet spend.

## DAVID'S DECISIONS, 2026-09-17

1. **v1 triggers tier 2 AUTOMATICALLY on an absent owner**, same as the session route.
2. **The CRM push carries ALL 65 exportable fields**, auto-created in the user's location.
   **It needs the right Private Integration Token scopes, which existing users will not have**, so
   it needs a warning telling them to update the PIT. Split into phase 4b so it does not delay the
   slice David judges. **The webhook needs no such warning**: extra keys in a JSON POST to the
   customer's own URL need no pre-declaration anywhere. That constraint is the CRM's alone.
3. **Blank-owner bulk rows: accept the file, skip the row with a reason.** Nothing charged, reason
   visible in the job summary and the CSV. Not a silent `no_match`. Gap closes in phase 5.
4. **Export stays in phase 5** with bulk, so the column set is designed once.

## PHASE 4a TASKS. Nothing is deleted until its survivors have somewhere to live.

- [ ] 1. Re-run the queued/processing check immediately before deleting. Anything in flight = STOP.
- [ ] 2. Relocate `isLikelyBusiness()` to `lib/trace/ownerClassification.ts`, straight move, no
      behaviour change. Update the two importers. Note that `classifyOwnerName()` in
      `lib/routing/ownerRoute.ts` is a second classifier; merging them is not this phase.
- [ ] 3. Rewrite `sweep-bulk-research` as `sweep-entity-traces`, calling `lookupBusinessTrace()`
      from `lib/tracerfy/client.ts` (built and mutation-tested in 3b) for rows that HAVE an owner.
      `vercel.json` entry follows. Blank-owner rows skip with a reason.
- [ ] 4. `v1/trace/bulk/route.ts` drops the $0.15 research fee from `estimatedCost` and stops
      queueing blank-owner rows to a cron that no longer resolves them.
- [ ] 5. Delete the engine: `lib/ai-research/client.ts` (minus the relocated function),
      `lib/brave/client.ts`, the FOUR research routes, `components/trace/AIResearchCard.tsx`.
      Historical `ai_research*` columns and both refund sites untouched.
- [ ] 6. `components/trace/PropertyRecordCard.tsx`. Pure/server-renderable like
      `FullTraceDisclosure`. **6 provably-wrong fields and 15 propensity scores NOT displayed.**
      Blank means blank: never a 0, never "N/A".
- [ ] 7. Widen the page result state: `property_record`, `tier`, `owner_type`,
      `needs_manual_review`, `warnings` already arrive and are silently dropped.
- [ ] 8. Opt-in toggle sending `full_property_trace: true`. `FullTraceDisclosure` must fire for the
      opt-in case too, with its own sentence; it only tests the owner name today.
- [ ] 9. Label `owner_name_2` as the owner of record, and `owner_name` as the contact person.
- [ ] 10. Strip AI Search UI from both trace pages, including `Free (no owner found)`.
- [x] 11. v1 tier 2, automatic on absent owner. Needs a RAW twin of `pricePlanFor` (Track B uses
      the raw `getChargePerTrace`, not the grant-aware one). Gate reserves the tier 2 rate.
      Fix the unguarded `zip.substring(0, 5)` 500 at line 158. **DONE — see REVIEW below.**
- [x] 12. Fire `trace.completed` from the tier 2 inline block on BOTH routes, carrying
      `property_record`, `tier`, `owner_type`. Every completed tier 2 including a billed miss;
      never on a vendor failure. **DONE — see REVIEW below.**
- [ ] 13. Copy sweep. Every "AI Search"/"AI research" string, plus the three money strings.
      No em-dashes, no asterisks, no emoji. Only the four canonical prices.

## PHASE 4b: the CRM push, all 65 fields

Verify the HighLevel custom-field endpoints and the exact PIT scope names against the LIVE docs,
not memory. Auto-create missing fields. Detect the scope failure explicitly and never silently
drop fields. The poll route gates the push on `isSuccessful && result`, which is wrong for tier 2:
a billed record with a property record and no contacts is still a paid answer.

## ARITHMETIC CORRECTION for phase 5

This file says the export carries **64** columns. Counted from the sanitized fixture: 86 keys
returned, minus **6** blocked (`price_per_sqft` was moved out), minus 15 propensity, = **65**.
Still "over 60", so no copy change, but the number in this file is one low.

---

# REVIEW: Phase 4 tasks 11 + 12 (2026-09-17) — v1 tier 2 and the completion webhook. Uncommitted.

**A NEW BILLING PATH ON A PUBLIC API.** Characterization tests first, every money decision
mutation-verified, and the two judgment calls named at the bottom rather than buried.

## Numbers

| | Before | After |
|---|---|---|
| `npx vitest run` | 593 passing, 46 files | **663 passing, 47 files, 0 failing** |
| `npx tsc --noEmit` | 0 errors | **0, unchanged** |
| `npx eslint app lib components` | 49 problems | **49, unchanged** |
| `npm run build` | compiles, exit 0 | **compiles, exit 0** |
| Mutations applied / caught | — | **20 / 20** |

## Tests were written FIRST, and four of them went red

Six characterization tests were added to `app/api/v1/trace/single/__tests__/route.test.ts` against
the route as it stood, and passed. Wiring tier 2 in turned four red:

| Characterization test | Was | Is |
|---|---|---|
| a body with no `ownerName` | tier 1 async submit | tier 2, inline |
| the balance gate on that body | raw tier 1 rate ($0.15) | tier 2 rate ($0.25 / $0.40) |
| a billed tier 2 row with no contacts | re-bought | served free from the database |
| a submit with no `zip` | bare 500 (TypeError) | 200, `zip` stored as null |

Each now asserts the new behaviour and records the old one in a comment. A test authored after the
implementation, from the same assumption as the implementation, proves nothing (L-008's corollary).

## Track B keeps its own price derivation: `lib/api/pricing.ts`

`rawPricePlanFor()` and `rawChargePerRecord()` are the RAW twins of `pricePlanFor` /
`chargePerRecord`. They derive from `subscription_tier` and `is_acquisition_pro_member` only, the
same two columns `getChargePerTrace` reads, and are deliberately blind to a gateway grant. An
invariant test asserts `PRICE[rawPricePlanFor(p)].tier1PerSuccess === getChargePerTrace(...)` across
the whole matrix, so the plan derivation and the tier 1 rate cannot drift.

No plan is hardcoded anywhere. An unrecognised or missing tier falls to `wallet`, the DEAREST
column, for FAILSAFE_PRICE_PLAN's reason: an overcharge is visible on a statement and gets reported;
an undercharge is invisible to both sides and compounds.

## The charge sequence on v1, in order, and none of it may move

1. Pre-flight gate reserves `rawChargePerRecord(profile)` — the TIER 2 rate.
2. Cache: a billed tier 2 row is served free, whatever it contains (`isCacheHitRow`).
3. Row first, vendors second, so the deduct has a `trace_history_id`.
4. `planRoute(parcelForFullTrace(...), rawPricePlanFor(profile))` — pure, no spend, the real plan.
5. `executeRoute(...)` with the three synchronous vendor callables.
6. `if (!execution.success)` → charge NOTHING, row `error`, 502, no webhook.
7. `deductOrZero(...)` ONCE. **A total dossier miss IS billed.**
8. Persist what was COLLECTED: `tier`, the raw 86-key `property_record`, real vendor spend in `cost`.
9. `trace.completed`, then return the finished record inline.

## The webhook: `lib/trace/traceCompletedWebhook.ts`

The poll route's payload key for key, plus `property_record`, `tier` and `owner_type`. Fires for
EVERY completed tier 2 including a billed miss (the poll route's rule is "send for all completed
traces", and a billed miss is the case a customer most needs told about). Never on a vendor failure:
that branch returns before reaching the dispatch, which is a structural guarantee rather than a
condition that can be edited. Fire-and-forget with a `.catch()`.

`webhook_url` is read off the profile already in hand on both routes, not re-read. Verified rather
than assumed: v1's `profile` comes from `validateApiKey`'s ADMIN client `select('*')`, and the
session route's comes from an RLS-scoped `select('*')` on the caller's own row — migration
20260716 revoked UPDATE only and there is no column-level SELECT restriction on `user_profiles`
anywhere in `supabase/`.

**The HighLevel CRM push is NOT wired.** Phase 4b, as specified.

## Mutation table. 20 applied in isolation, full suite re-run each time, tree restored.

| # | Mutation | Tests red |
|---|---|---|
| M1 | gate on `ownerFound` instead of `success` (both routes) | 27 |
| M1a | ...v1 only | 12 |
| M2 | drop the vendor-failure gate entirely (both routes) | 8 |
| M2a | ...v1 only | 4 |
| M3 | skip the deduct when the dossier missed (v1) | 8 |
| M4 | reserve the tier 1 rate instead of tier 2 (v1) | 4 |
| M5 | hardcode `'pro'` as the plan (v1) | 2 |
| M5a | use the grant-aware TRACK A helpers on v1 | 2 |
| M5b | Track A for the GATE only | 1 |
| M5c | Track A for the CHARGE only | 1 |
| M6 | drop the v1 tier-2 cache arm, so a paid row re-buys | 2 |
| M7 | fire the webhook on a vendor failure (both routes) | 2 |
| M8 | gate the webhook on `isSuccessful`, so a billed miss is silent (both) | 5 |
| M9 | drop the webhook dispatch entirely (both routes) | 8 |
| M10 | revert the v1 zip guard to the unguarded substring | 4 |
| M11 | drop the automatic arm of the v1 trigger (opt-in only) | 35 |
| M12 | drop the opt-in arm of the v1 trigger (automatic only) | 2 |
| M13 | persist `attemptedCharge` instead of what was collected (v1) | 1 |
| M14 | subset the v1 `property_record` to populated keys | 1 |

**One mutation initially SURVIVED, and it is the one this phase was warned about.** M5a — swapping
`rawPricePlanFor`/`rawChargePerRecord` for the Track A `pricePlanFor`/`chargePerRecord` — turned
**zero** tests red on the first pass. The reason: `hasSuiteAccess()` is gated on
`NEXT_PUBLIC_SUITE_SIGNIN_ENABLED`, which is off in the test environment, so with no grant in play
the two tracks return the same answer and the test passed under both implementations. The test now
sets the flag explicitly, and a second test covers the balance gate on the same profile. M5a, M5b
and M5c all bite now. **The general form: a test for a distinction that only exists when a feature
flag is ON proves nothing while the flag is off. Set the flag in the test.**

## Judgment calls, named rather than buried

1. **The v1 tier 2 response is camelCase** (`traceId`, `propertyRecord`, `ownerName`, `ownerType`,
   `needsManualReview`), matching this route's own `traceId` / `tracerfyJobId`. v1 is NOT uniformly
   camelCase — `app/api/v1/trace/status` returns `trace_id` and `is_cached` — so there was a real
   choice. Per-route consistency won. Nothing in `docs/` or the api-keys docs page published a tier
   2 v1 shape, so no existing contract was broken. **The copy sweep (task 13) owns documenting it.**
2. **v1 honours BOTH `fullPropertyTrace` and `full_property_trace`** as the opt-in. camelCase is
   v1's convention, but a caller who sends the session route's spelling has unambiguously asked for
   a full property trace, and silently giving them a cheaper tier 1 is the wrong answer rather than
   a kindness.

## Gaps, flagged not hidden

- **Nothing verifies this against the live v1 surface.** `api_logs` holds 0 rows, so there is still
  no usage visibility on v1 and no way to say how many callers the automatic trigger will surprise.
  Every assertion here is against mocked vendors.
- **A pay-as-you-go caller cannot actually reach v1 today.** `validateApiKey` 403s anything that is
  not pro or AcquisitionPRO, so the $0.40 column is unreachable in production. It is implemented and
  tested anyway: the route must derive its own price rather than lean on an access gate two files
  away, which is precisely how the 40% shortfall FAILSAFE_PRICE_PLAN documents happened.
- **The zip backfill on v1 is covered only through `executeRoute`.** The session route has a
  dedicated test asserting the SITUS zip and not the mailing zip; v1's tests assert a 5-character
  string lands in the row. The distinction is enforced one layer down and not re-proved here.
- **`research: null` is carried in the tier 2 webhook payload** purely for shape parity with the two
  poll routes, which still send it. If the copy sweep removes `research` from those, remove it here
  in the same pass.
- **Re-tracing an address still OVERWRITES `charge` on the reused row** on v1 as on the session
  route. Inherited from the phase 2 reuse design, unchanged here, still worth a decision.

# REVIEW: Phase 4 review fixes (2026-09-17)

Six defects the phase 4 review found, all fixed. Files another workstream owns
(`app/api/v1/trace/single/route.ts`, `app/api/trace/single/route.ts`, `lib/suite/pricing.ts`,
`docs/`, the API docs page) were not touched.

- [x] **1. MONEY. `app/api/trace/bulk/route.ts` charged for blank-owner rows.** Splits the batch
      the way the v1 route does, reusing `lib/trace/blankOwnerSkip.ts`. Skipped rows are written
      terminal with no charge, no tier, no `ai_research_charge`, never enter the Tracerfy CSV, and
      are excluded from the wallet reserve. A wholly blank-owner upload completes its job rather
      than polling forever. Rows now carry `trace_job_id`; `bulk/download` finds rows by either
      that or `tracerfy_job_id` and emits `skip_reason`. The bulk page counts blank-owner rows
      before submit and says they will be skipped and not charged, with no price figure beyond the
      caller's own profile rate.
- [x] **2. AVAILABILITY. `sweep-entity-traces` looped on a poisoned row forever.** New
      `lib/trace/entityTraceAttempts.ts` puts the attempt number in `ai_research_status`
      (`queued`/`queued_2`/... and `processing_N`), so it needs no migration and no new column, and
      a pre-ladder row reads as attempt 1 with no backfill. Five attempts, then terminal
      `entity_trace_failed` with a reason and nothing charged. The stale-claim sweep steps the same
      ladder. `isEntityTracePending()` replaced the two-literal check in the v1 bulk status route
      and in `lib/suite/mcp-tools.ts`, so a retried row is still pending and a retired one is not.
- [x] **3. Both status routes now return `property_record` and `tier`,** read off the existing
      `trace_history` row. No vendor call and no second charge.
- [x] **4. Narration fixed** in `lib/trace/settleBulkJob.ts` (the refund services the 1,301
      historical rows only) and `lib/constants.ts` (the retired-rate note now agrees with the
      RETIRED banner below it).
- [x] **5. Two copy defects** on `app/(dashboard)/trace/single/page.tsx`: the clear-cache confirm
      now says a paid record is kept and served back free, and one derived
      `willPullPropertyRecord` drives the checkbox, the request body and the disclosure.
- [x] **6. `PropertyRecordCard`:** `total_portfolio_value` relabelled "Portfolio assessed value"
      with a not-a-market-valuation note, not blocked. `date()` returns blank for a vendor
      `0000-00-00`.

## Mutation verification, ten mutations, all red

| Mutation | Result |
|---|---|
| Blank-owner split deleted in the dashboard bulk route | 6 failed / 4 passed |
| Reserve counts skipped rows again | 2 failed / 8 passed |
| Download reverted to filtering on `tracerfy_job_id` alone | 2 failed / 3 passed |
| `nextAfterFailedAttempt` exhausted branch deleted | 2 failed / 20 passed |
| Claim hardcoded back to `.eq('ai_research_status','queued')` | 1 failed / 21 passed |
| Terminal entity row given a charge | 1 failed / 21 passed |
| `property_record` + `tier` dropped from the session status route | 2 failed / 6 passed |
| `property_record` + `tier` dropped from the v1 status route | 2 failed / 5 passed |
| `date()` prints the vendor empty date again | 2 failed / 72 passed |
| Portfolio relabelled as a bare value | 1 failed / 73 passed |

## Baselines

`npx vitest run` 699 passed / 49 files / 0 failing (was 651 / 47 at the start of this pass).
`npx tsc --noEmit` 0 errors. `npx eslint app lib components` 48 problems (was 49; an unused
`PRICING` import went with the rewrite). `npm run build` compiles.

## Open, not fixed here

- **The partial index `WHERE ai_research_status = 'queued'`** (migration 20260411) no longer covers
  the claim query, which is now `.in(...)` over the five queued rungs. Correctness is unaffected;
  a broader index on `(ai_research_status, created_at)` would restore the plan. Not added because
  it is a live schema change and this pass was asked to avoid migrations.
- **`MAX_ENTITY_TRACE_ATTEMPTS = 5`** against a one-minute cron is about five minutes of
  consecutive vendor failure before a row is retired. A longer outage retires rows that would have
  succeeded later. The number is one constant if David wants it longer.
- **The tier 2 toggle flip** still unticks when the user types an owner name, because keeping the
  tick would opt them into the per-record rate they never chose. What was fixed is the divergence
  between what the control showed and what it submitted.

---

# REVIEW: Phase 4 — the 21 blocked fields are withheld from EVERY egress (2026-09-17). Uncommitted.

David's decision, implemented: the 6 provably-wrong fields and the 15 propensity scores are blocked
from the v1 API response, the session API response, both poll routes and the `trace.completed`
webhook, on the project's existing reasoning for blocking them from the CSV export.

## THE BOUNDARY, WHICH IS THE WHOLE JOB

**Storage stays raw.** `trace_history.property_record` holds all 86 keys, verbatim, unfiltered and
unrenamed. No migration, no backfill, nothing filtered on the way in. A field empty in OH, CA and
UT may be populated in another county and the $0.20 was already spent to fetch it.

**Only egress is filtered.** 65 keys leave; 86 keys are stored. The two numbers are asserted
against each other in the same test on both submit routes.

## ONE LIST, AND HOW THE SECOND ONE WAS PREVENTED

`lib/trace/publicPropertyRecord.ts` exports `BLOCKED_PROPERTY_RECORD_KEYS` (21) and a pure
`toPublicPropertyRecord()` that returns a COPY.

`PropertyRecordCard` gated the same fields by enumerating the 65 it renders, which is a second list
in disguise. It now runs its input through `toPublicPropertyRecord()` before a single accessor
touches it, so the two cannot drift: adding an "Estimated value" row to the panel renders nothing,
because the key is not there. Both were done, structure first and tests behind it, because the
structural share alone is invisible to a renderer test (the panel renders no blocked field either
way) and a test alone would not stop the panel from quietly keeping its own copy.

## THE ELEVEN EGRESS SITES

| Surface | Sites |
|---|---|
| `app/api/v1/trace/single/route.ts` | 3: cached-with-contacts, billed tier 2 cache hit, tier 2 inline response |
| `app/api/trace/single/route.ts` | 3: the same three |
| `app/api/trace/status/route.ts` | 2: completed branch, settled-poll branch |
| `app/api/v1/trace/status/route.ts` | 2: the same two |
| `lib/trace/traceCompletedWebhook.ts` | 1: the payload, filtered at the dispatch itself |

The webhook filters inside `dispatchTraceCompleted`, so both call sites hand it the RAW record and
there is exactly one place to get that egress wrong. The two persists and those two call-site
arguments are the only raw sites left, and each is named with a reason and an exact count in the
scan test's allowlist.

**Checked and cleared, not egresses:** the bulk CSV download (no dossier columns yet; phase 5), both
bulk status routes and the MCP twin (`buildPerRecordResult` carries no property record), the
HighLevel push (phase 4b, not wired), and the history and dashboard pages, which `select('*')`
server-side but pass only `trace.id` into a client component, so the record is never serialized to
the browser.

## THE SCAN THAT CATCHES THE FIFTH EGRESS

`lib/trace/__tests__/propertyRecordEgress.test.ts` reads every committed `.ts`/`.tsx` under `app/`,
`lib/` and `components/` and classifies every place a `property_record` / `propertyRecord` key is
written into an object: `null` is fine, `toPublicPropertyRecord(...)` is fine, anything else must be
in an allowlist with a reason and an exact count. A second raw emission in a file that legitimately
has one -- the precise way this leaks -- fails rather than inheriting its neighbour's permission. A
canary test asserts the scan finds sites at all, so a broken regex cannot pass vacuously.

`publicPropertyRecord.test.ts` holds the other end: every blocked key must exist in the vendor
fixture (a typo blocks nothing and looks identical to a key doing its job, and a vendor RENAME shows
up here), and the whole `propensity|renovate` family must be on the list, so a new vendor score is a
decision somebody makes rather than a default.

## NUMBERS

| | Before | After |
|---|---|---|
| `npx vitest run` | 699 passing, 49 files | **761 passing, 52 files, 0 failing** |
| `npx tsc --noEmit` | 0 errors | **0, unchanged** |
| `npx eslint app lib components` | 47 problems | **47, unchanged** |
| `npm run build` | compiles | **compiles** |
| Mutations applied / caught | — | **14 / 14** |
| Keys a caller receives | 86 | **65** |

**40 of the new tests are this change.** The rest are a concurrent agent's, landing during the same
session in `app/api/trace/bulk/`, `app/api/v1/trace/bulk/`, `app/api/cron/` and
`app/(dashboard)/trace/bulk/`, none of which this pass touched. The total moves while they work;
the 40 do not. Measured per file: 13 + 6 new, and +6, +6, +3, +3, +3 added to five existing files.

## MUTATIONS. Each applied alone, full suite re-run, tree restored.

| # | Mutation | Tests red |
|---|---|---|
| M1 | v1 single: cached-with-contacts branch unfiltered | 3 |
| M2 | v1 single: billed tier 2 cache branch unfiltered | 2 |
| M3 | v1 single: tier 2 inline response unfiltered | 4 |
| M4 | session single: cached-with-contacts branch unfiltered | 3 |
| M5 | session single: billed tier 2 cache branch unfiltered | 2 |
| M6 | session single: tier 2 inline response unfiltered | 4 |
| M7 | session status: completed branch unfiltered | 2 |
| M8 | session status: settled-poll branch unfiltered | 2 |
| M9 | v1 status: completed branch unfiltered | 2 |
| M10 | v1 status: settled-poll branch unfiltered | 2 |
| M11 | trace.completed webhook payload unfiltered | 3 |
| M12 | card stops sharing the list and casts the raw record | 1 |
| M13 | filter DELETES FROM ITS ARGUMENT instead of copying | 11 |
| M14 | filter returns the record unfiltered | 18 |

M12 was caught by NOTHING on the first sweep, and that is the finding worth keeping. Deleting the
shared filter from the panel changes no pixel today, because the panel gates by enumeration anyway;
it just silently restores the second list. A source assertion was added for it, and it is the only
test in the suite that goes red on that mutation.

## OPEN

- **The export and the CRM push are not written yet** (phases 5 and 4b). Both must call
  `toPublicPropertyRecord()`. The scan test will catch a raw emission in either, but only if the
  record is written into a key named `property_record` / `propertyRecord`; a CSV column loop or a
  HighLevel custom-field map would name the fields individually and slip past it.
- **`docs/` and the two settings pages were not touched**, as instructed. Their "over 60 fields"
  claim is still exact: a caller now receives 65.

---

# REVIEW: Phase 4 second-review fixes, bulk surfaces (2026-09-17)

Five findings from the second review of phase 4. Scope was the bulk surfaces:
`app/api/v1/trace/bulk/route.ts`, `app/api/trace/bulk/status/route.ts`,
`app/(dashboard)/trace/bulk/page.tsx`, `app/api/cron/sweep-entity-traces/route.ts`,
`lib/trace/entityTraceAttempts.ts`. The single-trace routes, the webhook lib,
`lib/utils/deduplication.ts`, `docs/` and the settings pages belong to other
workstreams and were not touched.

- [x] **1. FALSE STATEMENT. v1 claimed skipped rows as submitted work.**
      `records_submitted` on the `trace_jobs` row was `newRecords.length`, which
      includes blank-owner rows no vendor is ever asked about. It is now the
      traceable count, the same meaning `app/api/trace/bulk/route.ts:125` writes.
      A 100-row upload with 40 blank owners used to report 100 submitted against
      the matches from 60, understating the customer's match rate by 40 percent
      in the status route, the `bulk_job.completed` webhook and the history page.
      Checked before changing it: nothing divides by or otherwise computes on
      this column. `lib/trace/settleBulkJob.ts` never reads it; the v1 status
      route passes it through in five places with no arithmetic;
      `sweep-stale-traces` only copies it into a webhook. It is a reported
      number, so correcting the meaning corrects every reader at once.
- [x] **2. David's blank-owner decision, the missing dashboard half.** The rule
      is accepted, skipped with a reason, charged nothing, reason visible in the
      job summary AND the CSV. Only the CSV had it.
      `app/api/trace/bulk/status/route.ts` now returns `records_skipped` and
      `skip_reason` on both terminal branches, derived through `skipReasonFor()`
      so the wording cannot drift from the v1 payload, the MCP payload or the
      CSV. The page reads them back off the status response and falls back to
      what the submit already said. The block itself is
      `components/trace/BulkSkipSummary.tsx`, rendered in both the processing
      and complete phases. The pre-submit line now counts the rows that will
      actually be traced instead of every mapped row.
- [x] **3. MONEY. The cron could charge a row twice.** Anything throwing between
      the `deductOrZero` and the row write left the money moved with nothing on
      the row, and the catch requeued it for another claim, another FastAppend
      call and another deduct. The guard is the `wallet_transactions` debit
      `deduct_wallet_balance` already writes carrying `trace_history_id`: durable,
      written in the same transaction as the balance change, keyed on exactly
      the right thing, and needing NO new column. When one exists the cron
      persists the amount that already moved rather than deducting again or
      writing a zero. A short wallet leaves no ledger row, so an unpaid first
      attempt is still chargeable.
- [x] **4. A row could become permanently invisible.** The stale sweep used
      `.lt('ai_research_claimed_at', ...)`, and SQL `<` never matches NULL, so a
      row in `processing_N` with a null claim timestamp was reachable by neither
      the sweep nor the claim query and held its bulk job open forever. Now
      `.or('ai_research_claimed_at.is.null,...lt....')`. Latent and inherited:
      no current writer produces that pair.
- [x] **5. A comment that invented a database field.** It documented
      `normalized_address` as `"160 MINE LAKE CT|RALEIGH|NC|27615"`.
      `normalizeAddress()` returns three fields, `STREET|CITY|STATE`, zip-free on
      purpose since migration 20260904. Corrected, with the reason, so the next
      reader does not go looking for a zip that was never there.

## Mutation verification. 15 mutations, all caught, tree restored each time.

| # | Mutation | Tests red |
|---|---|---|
| M1 | v1 counts skipped rows as submitted again | 3 |
| M2 | stored-stats branch stops reporting skips | 1 |
| M3 | finalization stops reporting skips | 4 |
| M4 | skip summary counts every row, not just skipped ones | 3 |
| M5 | complete-phase summary fed a literal 0 | 1 |
| M6 | pre-submit count back to every mapped row | 1 |
| M7 | page stops reading the skip fields off the status response | 1 |
| M8 | ledger probe deleted, cron deducts unconditionally | 3 |
| M9 | probe keyed on user_id instead of trace_history_id | 1 |
| M10 | already-charged row persists 0 instead of what moved | 1 |
| M11 | stale sweep back to a bare `.lt()` | 3 |
| M12 | skip block renders on a job with nothing skipped | 2 |
| M13 | skip block shows the count with no reason | 3 |
| M14 | skip block invents a reason when none came back | 1 |
| M15 | processing-phase summary fed a literal 0 | 1 |

**M5 initially SURVIVED, twice, and the reason is worth keeping.** The page's
complete phase lives behind a `useState` machine that starts at 'upload' and
needs a submit, a fetch and a poll to reach, and this project has no jsdom and
no testing-library, so a static render cannot get there. The first attempt was a
source-level test, which a mutation that leaves the JSX in place and makes it
unreachable walks straight past. The fix was structural rather than another
assertion: the block moved into `components/trace/BulkSkipSummary.tsx`, which
IS render-tested and which owns the decision about whether to show anything, so
the page has no condition left for a source test to be blind to. The second
survival was narrower: the assertion matched a bare field name that also appears
elsewhere in the file, so it now matches whole props.

## Baselines

`npx vitest run` 772 passed / 53 files / 0 failing (was 737 / 51 at the start of
this pass). `npx tsc --noEmit` 0 errors. `npx eslint app lib components` 47
problems, unchanged. `npm run build` compiles.

## Open, not fixed here

- **`lib/suite/mcp-tools.ts:298` has the identical `records_submitted` defect**
  (`newRecords.length`, blank-owner rows included) and already splits them out
  as `skippedRecords`. Not touched: the file was outside this pass's scope. It
  is a one-word fix to `personRecords.length + entityRecords.length`.
- **`settleBulkJob` can still charge a row the cron already charged** in one
  narrow sequence: the cron deducts on a FastAppend hit, throws, requeues, and
  on the retry FastAppend returns nothing so the row goes down the Tracerfy path
  instead. The cron's own guard cannot reach that second charge, which happens
  in a shared file this pass did not own.
- **The submit responses and the status responses spell the reason differently**
  (`skippedReason` on v1, `skipped_reason` on the dashboard submit, `skip_reason`
  on both status routes and the MCP). Each surface's existing key was matched
  rather than a fourth one invented, but it is one name too many.
- **The dashboard `bulk_job.completed` webhook carries no skip fields.** The v1
  webhook carries `skip_reason` per record; this one sends only successful
  results, so a skipped row is invisible to a webhook consumer on that path.

---

# REVIEW: Phase 4 billing fixes (2026-09-17) — the repeat-billing defect and three more. Uncommitted.

Four money defects the review found on the single-trace path. Characterization tests first, all 20
mutations verified red, and the two judgment calls named at the bottom.

## Numbers

| | Before | After |
|---|---|---|
| `npx vitest run` | 772 passing, 53 files | **844 passing, 55 files, 0 failing** |
| `npx tsc --noEmit` | 0 errors | **0, unchanged** |
| `npx eslint app lib components` | 47 problems | **47, unchanged** |
| `npm run build` | compiles | **compiles** |
| Mutations applied / caught | — | **20 / 20** |

## FIX 1. The cache could never fire on the public API, so every repeat call re-bought.

`checkSingleDuplicate` built the COOKIE-BACKED ANON client. `trace_history` carries RLS
`USING (auth.uid() = user_id)`, and an `/api/v1/*` request authenticates by API key with no Supabase
session cookie, so `auth.uid()` was NULL and the select matched zero rows. Both cache branches in
`app/api/v1/trace/single/route.ts` were unreachable code. It now builds the service-role client.

**The cross-user fence.** Moving off the anon client removes RLS as the backstop, so
`.eq('user_id', userId)` is the only thing separating two customers. It is unconditional, and its
deletion is mutation-tested in three files (M2, 5 red).

`checkDuplicates` was deliberately NOT moved. It has the identical blindness on v1 bulk and on the
MCP surface, but the move is not purely a billing fix there: it counts ANY row in the window as a
duplicate, including a plain failure, so it would also start blocking retries of failed addresses on
a public API. That is a product call and the bulk routes are another workstream's. Documented at the
function and pinned by a test so the asymmetry is deliberate rather than forgotten.

## FIX 2. `trace.completed` fired twice for one `trace_id`.

A consequence of Fix 1: the surviving row is REUSED rather than re-inserted, so `traceRecord.id` was
identical on the second submit. Closed by Fix 1 and asserted end to end on both surfaces with the
real lookup running.

Three paths can still emit two events for one `trace_id`, and each is a genuine SECOND PURCHASE
rather than a re-charge for the same work: `skip_cache` (clear cache and re-run, which David decided
correctly charges), a resubmit WITH an owner name against a billed tier 2 row (tier 1 is a different
purchase), and a re-attempt after a run that collected nothing.

## FIX 3. A billed row could be written back to unbilled, then became permanently un-traceable.

Two halves, and the second is what frees the rows already damaged in production.

- **Receipts are monotonic.** `foldBillingWrite` in `lib/trace/billedRows.ts`: `charge` accumulates
  and `tier` never downgrades. Wired into both status settles and both tier 2 persists.
- **A row a ledger row points at is never a delete candidate.** `hasLedgerReceipt` asks
  `wallet_transactions` and `usage_records` directly, and `runDelete` on both submit routes is a
  no-op when it answers yes. It FAILS CLOSED. This is what unlocks an address whose receipt columns
  were already zeroed, because for those rows the columns say unbilled and only the FK knows better.

**What this means for the dashboard's SUM(charge):** it now reports the TOTAL collected against an
address rather than the most recent collection, which is what keeps it in agreement with
`wallet_transactions`. Replacing under-reported every second purchase.

## FIX 4. "The wallet did not cover this record" was said when the RPC itself had failed.

`deductWallet` reports `charged` / `insufficient_balance` / `error`. The customer is told something
true, and an RPC failure is logged as ours.

**The spent-but-not-collected case, named:** the customer is NOT billed and KEEPS the record. We
absorb the vendor cost. Billing them later for a record already delivered is exactly the surprise
charge this phase exists to remove. Those rows are findable as `cost > 0 AND charge = 0`.

## Mutation table. Each applied alone, full suite re-run, tree restored.

| # | Mutation | Red |
|---|---|---|
| M1 | cache lookup back on the cookie-backed anon client | 23 |
| M2 | drop `.eq('user_id')` from the single lookup | 5 |
| M3 | drop `.eq('user_id')` from the bulk lookup | 1 |
| M4 | `foldBillingWrite` replaces instead of folding | 17 |
| M5 | ...charge only | 12 |
| M6 | ...tier only | 5 |
| M7 | drop the ledger guard from the session route's deletes | 5 |
| M8 | ...from v1's | 3 |
| M9 | `hasLedgerReceipt` fails OPEN on a read error | 3 |
| M10 | collapse an RPC error back into insufficient balance | 3 |
| M11 | drop the v1 tier 2 cache arm | 6 |
| M12 | `hasLedgerReceipt` ignores a referencing row | 6 |
| M13 | session settle writes the raw charge again | 3 |
| M14 | v1 settle writes the raw tier again | 1 |
| M15 | session warning back on `charge === 0` | 1 |
| M16 | v1 warning back on `charge === 0` | 1 |
| M17 | session tier 2 persist replaces the receipt | 1 |
| M18 | v1 tier 2 persist replaces the receipt | 1 |
| M19 | drop `usage_records` from the ledger probe | 2 |
| M20 | drop the cent rounding from the fold | 1 |

Four of these survived the first sweep (M8, M16, M17, M18) and one more (M20) survived the second.
Per L-009 each was checked for whether the two sides CAN differ here before being trusted: all five
could, the tests simply did not exist. The v1 harness had no deduct-error knob at all, and no test
ran a tier 2 persist against a row that already carried a charge. M20 needed a THIRD accumulation,
because no pair of the four real rates is inexact in IEEE 754 while `0.15 + 0.15 + 0.15` is
`0.44999999999999996`.

## The test that proved a behaviour that could not occur

`app/api/v1/trace/single/__tests__/route.test.ts` mocked `checkSingleDuplicate` outright, so its
cache assertions were statements about the mock while the real lookup could not see a row. That is
L-009's exact shape for the second time this phase. Deduplication is no longer mocked in either
single-trace suite: the real lookup runs against a service-role client that sees rows and an anon
client wired blind, so pointing it back at the anon client turns 23 tests red.

## Open, not fixed here

- **`app/api/cron/sweep-stale-traces/route.ts:120-131` still overwrites `charge` and `tier`.** It is
  the cron twin of the session status settle and reaches the same reused rows. The permanent lockout
  is closed anyway by the ledger probe, but that cron can still under-report a receipt and break
  `isCacheHitRow`'s tier 2 arm. The fix is three lines: `foldBillingWrite(trace, {...})` and the two
  payload keys. Not applied because the file is outside this pass's ownership.
- **`lib/trace/settleBulkJob.ts` and `app/api/trace/bulk/status/route.ts`** write `charge` on the
  same table and were not reviewed here.
- **The status routes and `sweep-stale-traces` can both claim a row in `processing`** with no atomic
  claim, which is a pre-existing double-settle race that the accumulating fold now reports honestly
  rather than hiding.
- **A tier 1 cache hit that carries contacts swallows a `fullPropertyTrace` opt-in.** The caller asks
  for the property record, the contacts branch returns first, and they get a cache hit with no
  record and no charge. Pre-existing, not touched.

---

# REVIEW: Phase 4a COMPLETE (2026-09-17). Consolidated. Uncommitted, not pushed.

Six implementer passes and two adversarial reviews. The sections above are each pass's own record;
this is the one to read first.

## BASELINES, all four, re-run by me rather than taken from a report

| | Baseline `4fe3929` | Now |
|---|---|---|
| `npx vitest run` | 497 / 41 files | **848 passing / 56 files / 0 failing** |
| `npx tsc --noEmit` | 0 errors | **0 errors** |
| `npx eslint app lib components` | 54 problems | **47** |
| `npm run build` | compiles | **Compiled successfully** |

eslint FELL because the deleted AI Search files took their warnings with them. 56 files changed,
6,810 insertions, 3,381 deletions.

## WHAT THE TWO REVIEWS CAUGHT THAT THE IMPLEMENTERS DID NOT

Both were money. Neither would have been visible in a green suite.

1. **The v1 cache could never fire, so every repeat call re-bought and re-charged.**
   `checkSingleDuplicate` built a cookie-backed anon client; `/api/v1/*` authenticates by API key and
   carries no session cookie, so `auth.uid()` was NULL under RLS and both cache arms were unreachable
   code. Tier 1 largely escaped it (it charges on success from the poll route); tier 2 charges per
   record in the SUBMIT route, so ten calls for one address was ten charges.
2. **A billed row could be written back to unbilled and then became permanently un-traceable.**
   Trace with no owner (tier 2 collects, county has no parcel), trace again WITH an owner (tier 1
   settle writes `charge: 0, tier: 1` flat). The receipt is gone while `wallet_transactions` still
   FK-references the row, so the next submit tries to delete it, Postgres raises 23503, and that
   address returns 500 forever. No error required to reach it.

## THE LESSON THAT REPEATED INSIDE ONE PHASE

**L-009 was earned twice.** A guard that reads correctly, with a correctly-named test, can still be
worthless if the two paths it distinguishes are identical in the test environment. First time: the
Track A / Track B price split collapsed because `hasSuiteAccess()` is behind an env flag that is off
in tests, so the mutation swapping the tracks turned NOTHING red. Second time: the v1 cache test
mocked the very function whose real-world blindness was the bug.

**Only the mutation run exposed either.** Both were invisible to reading.

## RECEIPTS ARE NOW MONOTONIC, AND FENCED

`foldBillingWrite` accumulates `charge` and never downgrades `tier`; `hasLedgerReceipt` and
`collectedChargeFor` ask `wallet_transactions` directly and fail CLOSED.

**A consequence to know about: the dashboard's charge column now reports the TOTAL collected against
an address rather than the most recent collection.** That is what keeps `SUM(trace_history.charge)`
in agreement with `wallet_transactions`, which it was not before.

`lib/trace/__tests__/chargeReceipt.test.ts` is a source-level fence over every
`trace_history.update` that writes `charge`. Each must fold, or resolve from the ledger first, or be
named in `ALLOWED_RAW_WRITES` with a reason. **Four files are exempt today and every one is marked
PHASE 5 LIABILITY**: they are safe only because bulk is tier 1 only, and bulk tier 2 is what puts a
real receipt on those rows. Phase 5 should work that list rather than rediscover it.

## THE DELETION LIST IN THIS FILE WAS WRONG IN FOUR PLACES

Recorded so the next reader trusts the code over the plan: `app/api/v1/research/status/route.ts` had
to SURVIVE (it polls `business_trace_jobs`, not AI research, and is a documented customer endpoint);
`isLikelyBusiness()` had to be relocated, not deleted; `AIResearchResult` could not leave `types/`;
and deleting `sweep-bulk-research` would have broken BULK for 987 of the 1,301 rows, not just AI
Search.

## DECISIONS DAVID MADE DURING THE BUILD

1. v1 triggers tier 2 AUTOMATICALLY on an absent owner, same as the session route.
2. The CRM push carries all 65 exportable fields, auto-created, and needs a Private Integration
   Token scope warning because existing users' tokens will not have it. **Phase 4b, not 4a.**
3. Blank-owner bulk rows are accepted, skipped with a reason, and charged nothing.
4. Export stays in phase 5.
5. **The API withholds the 21 wrong fields too**, not just the screen and the CSV. A caller receives
   65 keys on every surface; the database still stores all 86.

## STILL OPEN, NOT FIXED, NOT HIDDEN

- ~~**A grant holder is billed BY OWNER TYPE on the v1 bulk surface.**~~ **WRONG AS WRITTEN.
  CORRECTED 2026-09-17 by tracing all six surfaces and both crons. This defect cannot fire on v1,
  for two INDEPENDENT reasons.** (1) `sweep-entity-traces` is already source-aware:
  `tier1RateFor(user_id, source)` at :191-198 reads an untagged row as Track B raw, the identical
  expression the v1 status route uses for person rows. The fix is in the tree and the comment at
  :166-172 is a post-mortem of this bullet's own wording. (2) Even without it, `lib/api/auth.ts:94`
  gates every v1 route on raw `subscription_tier === 'pro' || is_acquisition_pro_member`, which is
  EXACTLY the predicate `getChargePerTrace` returns $0.15 on. So for every caller who can reach v1,
  raw and grant-aware both return $0.15. The grant-only profile is the sole shape where they
  diverge and it gets a 403 before any handler runs.
  **David's rule, given 2026-09-17:** *"It doesn't matter if it's a person or entity, it's $0.15 per
  record found, if the owner came from the database and not from the dossier."* Already satisfied
  on v1. Owner PROVENANCE picks the tier (database = tier 1 per record found, dossier = tier 2 per
  record submitted); owner TYPE picks the vendor and never the price.
  **What IS real, and replaces this bullet — both go into phase 5b:**
  - `app/api/cron/sweep-business-traces/route.ts:45` is unconditionally grant-aware and never got
    the `source` argument its twin got. Currently harmless because nothing in the main tree inserts
    into `business_trace_jobs` any more; it drains historical rows only. A live writer re-opens it.
  - `app/api/trace/bulk/route.ts` settles grant-aware (`bulk/status/route.ts:227`) while writing
    **no `source`**, which the entity cron reads as raw. Adding an entity route there without
    tagging `source` creates this same split INVERTED: person $0.15, entity $0.25, one batch.
  - **L-009 WARNING, and it is LIVE not theoretical.** `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED` is
    `false` in `.env.local` but **`true` in production** — verified 2026-09-17 by fetching
    `https://proptracerpro.com/login`, which serves "Sign in with Suite" and
    `/api/auth/suite/start`, and both render only inside `isSuiteSignInEnabled()`. So
    `hasSuiteAccess()` is always false in tests and can be true in production: grant-aware and raw
    are **provably identical in every test and genuinely divergent in prod**. A grant-holding
    wallet-tier user is charged $0.15 by `chargePerTrace` and $0.25 by `getChargePerTrace` today.
    Any test asserting the two differ MUST set that flag inside the test or it pins a tautology,
    and the tautology will look green while production behaves differently.
- `MAX_ENTITY_TRACE_ATTEMPTS = 5` against a one-minute cron retires a row after ~5 minutes of
  consecutive FastAppend failure. One constant if that is too short.
- The partial index from migration 20260411 is `WHERE ai_research_status = 'queued'` and no longer
  covers the five-rung claim query. ~3,800 rows today, so it is plan quality, not correctness.
- A tier 1 cache hit carrying contacts swallows a `full_property_trace` opt-in: the contacts branch
  returns first, so the caller gets no record and no charge. Pre-existing.
- `research_jobs` and `ai_research_claimed_at` are orphaned database objects. Safe to leave.
- Nothing is verified against the live v1 surface. `api_logs` still holds 0 rows, so there is still
  no usage visibility on the public API.

---

# REVIEW: Phase 4b (2026-09-17) — the dossier reaches the gateway. Scope changed before build.

## THE SPEC WAS AIMED AT THE WRONG SYSTEM

4b was written as "auto-create 65 CONTACT custom fields over the HighLevel API, plus a Private
Integration Token scope warning". Every fact gathered for it was correct and the target was wrong.
Reading the gateway settled it. Full reasoning in `tasks/lessons.md` L-010.

| Assumption | Reality, verified |
|---|---|
| Users get this through PTP's own push | **6 of 52** PTP users have HighLevel configured. The gateway CRM path has 3 users and 331 properties. |
| The data belongs on the Contact | The gateway keeps it on `custom_objects.property`, **50 fields**, read live. |
| Auto-create is available | `POST /custom-fields/` rejects `custom_objects.property` ("Invalid object key"). And PTP's own setup page tells users to grant only `contacts`, so **no token carries `locations/customFields.write`**. |
| The gateway consumes a CSV | It uses the **REST API** record by record. There is no CSV writer in that repo; the CSV is David's hand-built INPUT. |

**How the gateway actually reads PTP: over MCP, never the database.** No PTP project ref exists
anywhere in the gateway repo. The proxy path returns PTP's response verbatim. `crm_push_owners`
PARSES it and silently drops every key it does not name.

## WHAT SHIPPED, AND IT IS THE WHOLE PTP CHANGE

`listTraces` and `buildPerRecordResult` in `lib/suite/mcp-tools.ts` emit `property_record` and
`tier`, filtered through `toPublicPropertyRecord`. A gateway caller receives **exactly 65 keys**,
probed through the real function against the 86-key fixture. Tool descriptions updated so a caller
knows the record exists.

**The select was the trap.** Neither column was in `listTraces`'s `.select(...)`. Without adding
them the change is a silent no-op that looks identical to a customer who never bought a Full
Property Trace. The test stubs now emulate PostgREST column projection so a dropped column turns
red.

**13 mutations, one honestly reported as 0 red.** Destructuring `property_record` out of `...rest`
turns nothing red while the spread stays first, so the comment calls it defence in depth rather
than claiming a protection the mutation disproves. The real leak variant is caught.

Numbers: **864 passing / 56 files / 0 failing**, `tsc` 0, eslint 47, build compiles.

## HANDED TO DAVID

`tasks/ghl-property-fields-to-add.txt` — the **54** property-object fields for the GHL snapshot
template, each with label, type and exact field key. 86 returned, 21 withheld, 65 delivered, 11
already present, 54 new. Checked against the LIVE object, not a cache. Money type excluded
throughout because MONETORY fields cannot be written; the yes/no fields are Single line to match
the existing `owner_is_individual` convention; `flood_zone` is a boolean, not a zone code.

## NOT PTP'S JOB. Do not build these here.

- The 54 GHL fields. **David creates them in the snapshot template**, then pushes to users.
- Adding those 54 rows to `PROPERTY_FIELD_MIRROR` and teaching `crm_push_owners` to read
  `property_record`. **suite-gateway repo**, after the snapshot ships. Until then the fields
  reach the proxy path and are dropped by `crm_push_owners`.
- **PTP's direct HighLevel push is DROPPED, not deferred.**

## OPEN

- **Three live bugs in PTP's existing HighLevel push, none fixed:** the manual Push to CRM button
  reports success on a failed push; a 401 is silent on all five automatic paths; saving a
  credential validates nothing and shows a green "Connected" badge for a garbage value.
- **`list_traces` payload size.** Up to 200 rows, each potentially carrying a 65-key record, in one
  MCP text block. Harmless today because bulk tier 2 does not exist, so live rows are tier 1 with a
  null record. **Revisit the default limit when phase 5 lands bulk tier 2.**
- `current_upb` / `original_upb` on the property object now read as NUMERICAL, not MONETORY. The
  pair that could never be written should start landing on the gateway's next push.

---

# PLAN: Phase 5a (2026-09-17) — the export carries everything purchased. APPROVED by David.

## THE SCOPE CHANGED BEFORE THE BUILD, AND DAVID'S QUESTION IS WHY

This was specced as "append the 65 dossier columns". David asked one question before we started:
*"on the export, the contact information is included with the property records?"* Checking it
against the live DB found the export is **already** short-changing customers on contacts, before a
single dossier column is added. So 5a is not "add the property layer", it is **make the export
carry everything the customer paid for**, contact layer and property layer, in one pass. That also
honours the existing rule that the column set gets designed once.

### Measured against production 2026-09-17, not assumed

| Loss | Live number |
|---|---|
| Phones capped at 3 columns; rows store up to 9 | **863 of 1,362** rows exceed 3 phones |
| Phone numbers bought and never exported | **1,554** |
| Emails capped at 3 columns; rows store up to 5 | **142** addresses never exported |
| Phone type (mobile/landline/voip), no column exists | populated on **1,297 of 1,362** rows |
| `mailing_zip`, in the stored shape, no column | 0 today (tier 1 never fills it), tier 2 will |

### THE ONE THAT BITES TIER 2, and it is the worst outcome available in the export

The owner of record lives in **`trace_result.owner_name_2`** and **has no column**. The CSV's
`owner_name` emits the resolved PERSON (`trace_result.owner_name`), falling back to
`input_owner_name`. For a blank-owner bulk row — precisely what tier 2 exists for — both are empty
whenever no principal is found. Handoff numbers: commercial is 22 entities of 24 parcels and
FastAppend hits 13 of 22, so roughly **9 in 23 records would show a blank owner column** after the
customer paid specifically to discover the owner of record. On the hits they still only ever see
the person, never `Colmaven, Llc`.

## THE COLUMN SET: 103, and the first 16 never move

Append-only. Existing indices are preserved, so index-keyed importers survive. The layout is ugly
(phone_4 lands after the research block, not beside phone_3) and that is the correct price.

| Block | Count | Notes |
|---|---|---|
| Existing base | 16 | unchanged, unmoved, unrenamed |
| research | 4 | `hasResearch` conditional REMOVED, always emitted |
| skip_reason | 1 | `hasSkipped` conditional REMOVED, always emitted |
| `owner_of_record` | 1 | `trace_result.owner_name_2` |
| `phone_4`..`phone_8` | 5 | `TRACERFY.MAX_PHONES` = 8 |
| `phone_1_type`..`phone_8_type` | 8 | mobile / landline / voip |
| `email_4`, `email_5` | 2 | `TRACERFY.MAX_EMAILS` = 5 |
| `mailing_zip` | 1 | |
| dossier | 65 | `toPublicPropertyRecord`'s survivors |

**Why unconditional is a pure append and not a reorder.** Measured: of the 44 bulk jobs carrying
rows, **40 have the research columns and ZERO have skip_reason**. `skip_no_research` = 0 and
`both` = 0. So ordering base, research, skip_reason, dossier appends for 100% of existing jobs.
Had a single job carried skip-without-research this ordering would have been a reorder; it was
checked, not assumed.

## THE FENCE COMES FIRST. Nothing else lands before it.

`lib/trace/__tests__/propertyRecordEgress.test.ts` finds egress sites by matching the literal token
`property_record:` in source. **A CSV builder that reads `row.property_record` and emits 65
separate columns produces no such token.** The download route contains zero matches today and is
invisible to the fence. This phase builds exactly the fifth surface the fence exists to catch, in
the one shape it cannot see.

Fix structurally, not with a wider regex:

1. **One canonical ordered list**, `DOSSIER_EXPORT_KEYS`, exported from
   `lib/trace/publicPropertyRecord.ts`. 65 entries, vendor key order.
2. The fence asserts `DOSSIER_EXPORT_KEYS` contains **no** member of `BLOCKED_PROPERTY_RECORD_KEYS`
   and has exactly 65 entries.
3. **The drift test that makes a vendor addition loud.** Assert every public key of the committed
   86-key fixture appears in `DOSSIER_EXPORT_KEYS`. A new vendor key then turns the suite RED and a
   human adds a column deliberately. This is the resolution of the real tension in this phase:
   `toPublicPropertyRecord` is a DENYLIST so a new key reaches the customer, but a STABLE column
   set cannot shift under them. A fixed list plus a red test is how both hold.
4. A CSV-level fence: build a row from the 86-key fixture and assert no blocked key appears in the
   header and the header is exactly the 103.

## TASKS

- [x] 1. `DOSSIER_EXPORT_KEYS` (65, ordered) in `lib/trace/publicPropertyRecord.ts`.
- [x] 2. Extend the egress fence: the four assertions above. **Before any column ships.**
- [x] 3. `lib/trace/exportCsv.ts` — `EXPORT_COLUMNS` (103), `renderCell`, `buildExportCsv(rows)`.
      One module, so bulk and single cannot diverge and the fence has one target.
- [x] 4. `renderCell`. The current `esc` is typed `string` and **throws a TypeError on a number
      argument** (`(123 || '').replace` is not a function); the new columns are mostly numbers and
      booleans. Rules:
      - `null` / `undefined` / `''` → blank
      - `true` → `Yes`, `false` → `No`. A known negative is information; blanking it turns it into
        an unknown. Matches the GHL convention David applied 2026-09-17.
      - **numeric `0` → blank.** Precedent, not invention: the handoff's fill rates "treat 0 as
        absent", and `price_per_sqft` was un-blocked specifically on the basis that its 0 renders
        BLANK because every 0 was "no sale price on record". A 0 in these columns would be
        fabricated data. CLAUDE.md rule 7.
      - numbers render bare, unquoted, no thousands separators
      - strings quoted, inner `"` doubled, as today
- [x] 5. Rewrite `app/api/trace/bulk/download/route.ts` onto the shared module. Drop both
      conditionals. `select('*')` already fetches `property_record`, so no query change.
- [x] 6. **Fix the silent row truncation.** The route has no `.limit()`/`.range()`, so PostgREST
      caps it at 1000 and a bigger job loses rows with NO error. Biggest job today is 345 rows so
      nobody has hit it, but `MAX_RECORDS` is 10,000. Paginate with `.range()`.
- [x] 7. Single-record export: `app/api/trace/single/download/route.ts` + a button on
      `trace/single/page.tsx`. Same 103 columns, one row. Without it the feature is bulk-only in
      practice.
- [x] 8. Tests, then mutations, re-run by me rather than trusted from the report.

## OUT OF SCOPE, NAMED NOT HIDDEN

- **8 rows hold a 9th phone** (earliest 2026-08-13) although `lib/tracerfy/client.ts:415` slices at
  `MAX_PHONES` = 8. Columns follow the constant. Recovering 1,554 numbers while leaving 8 is the
  right trade and sizing columns off live data would break the stable-set rule. The cap
  discrepancy is its own question.
- Until 5c lands, every bulk CSV carries 65 empty dossier columns. That is the stable-set rule
  working, and it is one release of odd-looking output.
- `match_confidence` gets no column. Internal scoring, not a purchased fact.


## REVIEW: Phase 5a shipped 2026-09-17

Build order was the spec's: the fence extension landed and went green BEFORE a single new
column was emitted, which is the only ordering that makes the fence worth having here.

### Files

| File | Change |
|---|---|
| `lib/trace/publicPropertyRecord.ts` | + `DOSSIER_EXPORT_KEYS`, 65 keys in vendor order. Nothing existing touched. |
| `lib/trace/__tests__/propertyRecordEgress.test.ts` | + 4 assertions, the fifth surface the scan cannot see |
| `lib/trace/exportCsv.ts` | NEW. `EXPORT_COLUMNS` (103), `renderCell`, `toExportValues`, `buildExportCsv` |
| `lib/trace/__tests__/exportCsv.test.ts` | NEW, 29 tests |
| `app/api/trace/bulk/download/route.ts` | 171 -> 143 lines. Inline builder gone, both conditionals gone, paginated |
| `app/api/trace/bulk/download/__tests__/route.test.ts` | stub pages now; + 4 pagination tests; the "no skip column" test inverted |
| `app/api/trace/single/download/route.ts` | NEW |
| `app/api/trace/single/download/__tests__/route.test.ts` | NEW, 8 tests |
| `app/(dashboard)/trace/single/page.tsx` | + Download CSV button, same navigation pattern as bulk |

### Verified

`npx vitest run` 909 passing / 58 files / 0 failing (from 864 / 56).
`npx tsc --noEmit` 0 errors. `npx eslint app lib components` 47 problems, unchanged.

Mutations, each run and each observed RED, then restored:

| Mutation | Caught by |
|---|---|
| a blocked key pasted into `DOSSIER_EXPORT_KEYS` | 3 fence tests |
| a vendor key deleted from it | 2 fence tests (the drift test) |
| `renderCell(false)` blanked instead of `No` | 3 |
| numeric `0` emitted as `0` | 2 |
| `PHONE_COLUMN_COUNT` drifted from `TRACERFY.MAX_PHONES` | 5 |
| pagination loop removed (the original silent truncation) | 3 |
| the `id` tiebreaker removed | 1 |
| `.eq('user_id', ...)` removed from the single download | 1 |

The fence also caught a real leak DURING the build: the token `property_record:` in a doc
comment in the new module. Reworded, not exempted.

### THE NAMING DECISION WAS TAKEN: ALL 65 DOSSIER COLUMNS ARE PREFIXED `prop_`

Approved by David. `prop_address`, `prop_city`, `prop_apn`, `prop_flood_zone`, all 65. The four
duplicate headers (`address`, `city`, `state`, `property_type`) are gone and every column name in
the file is now unique.

**The duplicates were hiding missing assertions, which is the real reason this mattered.** The test
helper resolved a duplicate name last-wins, so the base `state` column and the research
`property_type` column were unreachable by name and went unasserted. Both survived being replaced
with `null` in an adversarial mutation run with the suite fully green. Prefixing made them
addressable; the assertions were then written and both mutations now go red.

## FIX PASS: Phase 5a, after an adversarial review (2026-09-17)

An adversarial review ran 14 mutations against the first cut. **Four produced ZERO red.** Every
number in the original report re-checked correctly, so this was a coverage failure, not a
correctness one. All nine follow-ups are done.

### The four dead mutations, and what kills them now

| Mutation that was 0 red | Now red | Killed by |
|---|---|---|
| `row.state` -> `null` | **2** | `the base columns > carries the address the customer submitted` |
| `research?.property_type` -> `null` | **2** | `the file itself > carries the historical research` |
| widen the builder's dossier SELECTION | **1** | the new sentinel test (assertion 1 stays green, proving it catches something different) |
| in-loop error `return` -> `break` | **1** | `fails the whole download when a page errors` |

### What changed

1. **All 65 dossier columns prefixed `prop_`.** `DOSSIER_COLUMN_PREFIX` + `DOSSIER_EXPORT_COLUMNS`
   in `lib/trace/exportCsv.ts`. Header is still 103, now with zero duplicate names.
2. **The two assertions the duplicates were hiding**, plus one asserting the two `state`s and the
   two `property_type`s hold different values, plus a header-uniqueness test so a future collision
   fails instead of silently swallowing an assertion.
3. **THE NUMERIC ZERO RULE WAS WRONG AND IS REPLACED.** Blanking every numeric 0 came from a
   MEASUREMENT convention for fill rates, not a rendering decision, and the `price_per_sqft`
   precedent was measured on PRICE fields only. It destroyed real facts: `years_owned: 0` is bought
   this year, `mls_days_on_market: 0` is listed today, and `beds`/`baths`/`units_count`/`stories` are
   genuinely 0 on commercial stock, which is this product's entire market. Now: **0 renders as `0`**,
   except for `ZERO_MEANS_ABSENT_KEYS` -- money (9), size (2), years (2), coordinates (2) -- where 0
   is IMPOSSIBLE, not merely unlikely. A parcel is not assessed at $0, a building is not 0 sqft,
   there is no year 0, and 0,0 is a point in the Gulf of Guinea. Both sides tested.
4. **`renderCell` no longer fabricates on non-scalars.** It rendered `[object Object]` for objects
   and arrays and printed `NaN`/`Infinity` bare. Now: arrays join on `; ` (the existing `relatives`
   convention), plain objects blank, non-finite numbers blank. Unreachable today, but this is the
   single renderer for the product and the drift test does not fire on a LIVE vendor addition.
5. **CSV formula injection defused.** `=`, `+`, `-`, `@`, tab and CR at the start of a value get a
   leading apostrophe inside the quoted cell. `"=1+1"` is valid CSV that Excel, Sheets and
   LibreOffice all evaluate, and this phase grew the vendor-controlled free-text surface from 16
   columns to 103. Guarded at the front only; a trigger mid-value is inert.
6. **Two comments that claimed protection a mutation disproved, reworded rather than propped up
   with a test written to justify them** (the phase 4b precedent). The `toPublicPropertyRecord` call
   in the builder is now labelled defence in depth, saying plainly that the key list carries the
   weight. The drift test no longer claims a new vendor key "turns the suite RED": it fires when a
   human re-records the fixture, and until then a live vendor addition is silently dropped.
7. **Fence assertion 4's value half was a tautology and is rebuilt.** `not.toContain('propensity')`
   could not fail under any single change. Replaced with a unique sentinel written into every
   blocked key, run through the real builder.
8. **The truncation fix had relocated its own failure mode.** A PostgREST error on page 2 of 3
   returned 200 with a short, valid-looking CSV. The whole download now fails or none of it does.
9. **`charge` renders bare again** (`0.40`, not `"0.40"`) so the column can be summed, and the
   pagination loop is bounded by `MAX_PAGES`, derived from a 10,000-row job, so it cannot run
   unbounded if `.range()` is ever ignored.

### Gates observed after the fix pass

`npx vitest run` **933 passing / 58 files / 0 failing** (from 909).
`npx tsc --noEmit` exit 0. `npx eslint app lib components` **47 problems**, unchanged.
`npm run build` exit 0, compiled successfully, 34/34 static pages.

Ten mutations run in this pass, every one observed RED: the four above plus blanket zero-blanking
(2), ignoring the impossible-zero set (3), objects as `[object Object]` (1), bare `NaN` (1),
dropping the `prop_` prefix (14), and quoting `charge` (2).

### Deliberately not done, per the coordinator

- Peak memory on a 10,000-row export with no streaming.
- The 9th-phone cap discrepancy.
- `MAX_EXPORT_ROWS` is a local constant in the download route rather than an import of the submit
  routes' `MAX_RECORDS`. Importing a submit route would drag its vendor and billing graph into a
  download, and those files were out of bounds this phase.

### Named, not hidden

- Every bulk CSV now carries 65 blank dossier columns until 5c lands. Known, per the plan.
- `charge` deliberately escapes the "0 is blank" rule -- it renders `"0.00"` via a
  pre-formatted string, because a zero charge is the statement "this row was free", not an
  absent value. It is also now quoted where it used to be bare; harmless to every parser.
- Blank cells are now genuinely empty where they used to be `""`. Same meaning, less noise.
- The 9th phone on 8 rows stays unexported. Columns follow `TRACERFY.MAX_PHONES` = 8, and a
  test now goes red if that constant moves, so the 9th column gets added on purpose or not at all.

---

# PLAN: Phase 5b (2026-09-17) — the four PHASE 5 LIABILITY files. APPROVED by David.

**VISIBLE: NOTHING.** Stating that bluntly rather than dressing it up. This phase ships no feature.
Its entire purpose is to make the ground safe for 5c, because bulk tier 2 is what first puts a real
receipt on rows these four files overwrite.

## THE SHARED LOSS MECHANISM

`UNIQUE(user_id, address_hash)` means one row per (user, address), REUSED, never re-inserted.
`wallet_transactions.trace_history_id` references it with ON DELETE NO ACTION. So a flat
`charge: 0, tier: 1` over a paid row does two things at once:

1. The row reads unbilled to `excludeBilledRows`, so the next submit tries to delete it, Postgres
   raises 23503, and **that address returns 500 forever**.
2. `tier` downgraded from 2 kills `isCacheHitRow`'s third arm (`tier = 2 AND charge > 0`), so a
   billed tier-2 miss is **re-bought**.

Every write below pairs its charge with `tier: TRACE_TIER.PER_SUCCESSFUL_TRACE`, so both fire
together.

## THE REFERENCE IMPLEMENTATION IS ALREADY IN THE TREE

`app/api/cron/sweep-stale-traces/route.ts:332-343` already solved the blanket-update version of
this problem: it stopped writing charge/tier on the sweep and wrapped it in `excludeBilledRows`,
with a comment saying bulk tier 2 lands in phase 5 and this was waiting for it. **Read that first
and follow it.** Do not invent a second pattern.

## THE EIGHT WRITES

| File | Line | Write | Why it loses money under bulk tier 2 |
|---|---|---|---|
| `sweep-entity-traces` | 438 | ledger-resolved | SAFE, keep |
| `sweep-entity-traces` | 467 | `charge: 0, tier: 1` | fires on `!resolvedPerson`, never reads `row.charge` |
| `sweep-entity-traces` | 495 | `charge: 0, tier: 1` | fires on Tracerfy submit failure |
| `settleBulkJob` | 165, 224 | ledger-resolved | SAFE, keep |
| `settleBulkJob` | 257 | `charge: 0, tier: 1` | the neither-vendor-hit arm |
| `settleBulkJob` | 308 | raw deduct, REPLACES | under-reports vs the ledger; does not accumulate |
| `settleBulkJob` | 333 | `charge: 0, tier: 1` | **multi-row `.in()`**, zeroes N receipts in one statement |
| `bulk/status/route.ts` | 288 | raw deduct, REPLACES | no ledger probe, no fold |
| `bulk/status/route.ts` | 302 | `charge: 0, tier: 1` | **blanket by job id, no row read at all** |
| `sweep-business-traces` | 201 | `charge = tier1Rate` | see below, the quiet one |

### `sweep-business-traces:201` IS THE DANGEROUS ONE AND IT IS THE QUIETEST

Its guard is `!historyRow.is_successful` (`:167`). A billed tier 2 row's defining shape is EXACTLY
`is_successful = false` AND `charge > 0`. So it fires on precisely the rows it must not touch and
**replaces $0.25 with $0.15**. The row stays non-zero, so it never trips the 23503 lockout. It just
under-reports money that moved and downgrades the tier, so the customer re-buys the record. Nothing
surfaces it. The row's `charge` IS already selected at `:122` and never read.

## TWO MORE, FROM THE 2026-09-17 RATE-SPLIT VERIFICATION

The todo bullet these replace was WRONG; see the corrected entry above and L-011.

- `sweep-business-traces:45` — `tier1RateFor` is unconditionally grant-aware and never got the
  `source` argument its twin got. Harmless only while nothing writes `business_trace_jobs`.
- `app/api/trace/bulk/route.ts` — settles grant-aware (`bulk/status:227`) while writing **no
  `source`**, which the entity cron reads as raw. Adding an entity route there without tagging
  `source` produces a real $0.15/$0.25 split in one batch.

## L-009, AND IT IS LIVE, NOT THEORETICAL

`NEXT_PUBLIC_SUITE_SIGNIN_ENABLED` is `false` in `.env.local` and **`true` in production**
(verified against `proptracerpro.com/login`). Grant-aware and raw are **identical in every test and
divergent in prod**. Any test asserting the two differ MUST set the flag inside the test, or it
pins a tautology that stays green while production behaves differently. This flag has now produced
three worthless tests.

## TASKS

- [x] 1. Read `sweep-stale-traces:332-343` and adopt its pattern. Do not invent another.
- [x] 2. Characterization tests FIRST, pinning CURRENT behaviour green, before any change. The
      phase 2 precedent: tests written after the change inherit its assumptions and agree with it.
- [x] 3. Fix the six unsafe writes. A blanket update either stops writing charge/tier and excludes
      billed rows, or reads the rows and folds. Never a flat zero over an unread row.
- [x] 4. `sweep-business-traces`: the upgrade arm must not fire on a billed tier 2 row, and
      `tier1RateFor` takes `source`.
- [x] 5. `app/api/trace/bulk/route.ts` writes `source` on its rows and its job.
- [x] 6. Remove all four `ALLOWED_RAW_WRITES` exemptions from `chargeReceipt.test.ts`. The test
      asserts an exemption is a live raw writer, so a stale one fails; that is the proof the work
      is done. Any exemption that must survive gets a NEW reason that is not "tier 1 only".
      TWO SURVIVE on a new ground, see the review below.
- [x] 7. Mutation-verify every money decision. Re-run by me, not taken from the report.

## REVIEW: Phase 5b (2026-09-17) — shipped, uncommitted

### The pattern, taken from `sweep-stale-traces` and not reinvented

That file already holds BOTH arms of the one rule, and which arm applies is decided by a single
question: **is the row in hand?**

- **Row read → FOLD.** `:298` calls `foldBillingWrite(historyRow, { charge, tier })` and writes
  `billing.charge` / `billing.tier`. `charge` accumulates, `tier` never downgrades, and folding a
  collection of 0 is a no-op — which is the property that closes the 23503 lockout.
- **Blanket multi-row update, no row read → STOP WRITING THE RECEIPT COLUMNS AND EXCLUDE.** `:332`
  drops `charge`/`tier` from the payload entirely and wraps the statement in `excludeBilledRows()`.
  Its comment says why: a never-charged row already reads unbilled so a 0 buys nothing, and a
  charged row must keep what it collected. It also says it was waiting for phase 5. It was.

### Characterization tests that went RED on the fix (13, plus the intended 14th)

Written first, run GREEN against unfixed code (954 passing), then turned red by the change:

| # | Test | Site |
|---|---|---|
| 1 | settleBulkJob site 257 keeps the tier 2 charge and tier | `settleBulkJob:257` |
| 2 | settleBulkJob site 308 ACCUMULATES the new debit | `settleBulkJob:308` |
| 3 | settleBulkJob site 333 writes no charge/tier, excludes billed | `settleBulkJob:333` |
| 4 | sweep-entity site 467 keeps the charge and the tier | `sweep-entity:467` |
| 5 | sweep-entity site 495 keeps the charge and the tier | `sweep-entity:495` |
| 6 | bulk/status site 288 ACCUMULATES the new debit | `bulk/status:288` |
| 7 | bulk/status site 288 no-match keeps the charge and tier | `bulk/status:288` |
| 8 | bulk/status site 302 writes no charge/tier, excludes billed | `bulk/status:302` |
| 9 | sweep-business billed tier 2 row is not re-billed | `sweep-business:167` |
| 10 | sweep-business charge accumulates rather than replaces | `sweep-business:201` |
| 11 | sweep-business bills a Track B row the RAW rate | `sweep-business:45` |
| 12 | bulk/route tags the job row with its source | `bulk/route` |
| 13 | bulk/route tags every trace_history row | `bulk/route` |
| 14 | chargeReceipt "keeps every exemption justified, and none of them stale" | task 6's proof |

Five characterization tests were written to stay GREEN through the change and did, which is what
says the fix stayed inside its blast radius: both ledger-resolved sites in `settleBulkJob`
(165/224), the ledger-resolved site in `sweep-entity` (438), the historical
`ai_research_charge` refund arm in `sweep-business`, and the already-successful row it leaves alone.

### The two exemptions that survive, on a NEW ground

`app/api/trace/bulk/status/route.ts` and `app/api/cron/sweep-business-traces/route.ts` are GONE from
`ALLOWED_RAW_WRITES` and are now pinned by name in the `mustFold` list instead.

`sweep-entity-traces` (1 site) and `settleBulkJob` (2 sites) keep an exemption, and NOT because
"tier 1 only". Those three writes do not compute an amount — they READ ONE BACK OUT OF THE LEDGER
via `collectedChargeFor()`. Folding a ledger reading onto a row that may already carry it counts
one debit twice, which is the opposite error and just as wrong. The plan marks all three SAFE, keep.
The bar for any future entry is now "explain why folding would be WRONG", not "explain why
clobbering is harmless today".

### Mutation table — 15 mutations, 15 killed, 0 survivors

Every one verified as actually applied (anchor matched exactly once) and checked for load errors.

| Mutation | Red |
|---|---|
| M1 settleBulkJob:257 fold → flat zero | 1 |
| M2 settleBulkJob:308 fold → raw replace | 1 |
| M3a settleBulkJob:333 blanket writes charge/tier again | 1 |
| M3b settleBulkJob:333 `excludeBilledRows` unwrapped | 1 |
| M4 bulk/status:288 fold → raw replace | 4 |
| M5a bulk/status:302 blanket writes charge/tier again | 3 |
| M5b bulk/status:302 `excludeBilledRows` unwrapped | 1 |
| M6 sweep-entity:467 fold → flat zero | 1 |
| M7 sweep-entity:495 fold → flat zero | 1 |
| M8 sweep-business guard `isCacheHitRow` → `!is_successful` | 1 |
| M9 sweep-business:201 fold → raw replace | 3 |
| M10 sweep-business `tier1RateFor` ignores `source` | 1 |
| M11 bulk/route drops `source` from the job insert | 1 |
| M12 bulk/route drops `source` from every history row | 1 |
| M13 `isTrackASource` stops recognising the WEB tag | 1 |

### L-009 probe: the flag really is load-bearing

M10 is the only mutation whose detector compares the two rate derivations, so it is the one L-009
can turn into a tautology. Probed directly rather than assumed:

- M10 applied, flag set (as written): the Track B test goes RED. Mutation killed.
- M10 applied, flag line removed: the Track B test **PASSES**. The mutation SURVIVES.
- Clean code, flag line removed: a *different* test goes red for the flag, not the mutation.

So `process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = 'true'` inside that describe is the only thing
making the assertion mean anything. This is the fourth time this flag has been the difference.

### Gates

`npx vitest run` 955 passing / 59 files / 0 failing (baseline 933/58) · `npx tsc --noEmit` 0 ·
`npx eslint app lib components` 47 (baseline 47, unchanged) · `npm run build` compiled.

---

# REVIEW ADDENDUM: Phase 5b post-review corrections (2026-09-17)

The review above described a phase that **created a critical defect**. It is corrected below and the
numbers in the section above are superseded. Nothing was committed.

## THE ROOT CAUSE OF BOTH MAJOR FINDINGS: STATUS IS NOT A RECEIPT

`excludeBilledRows` exists to protect `charge` and `tier`. I applied it to statements that also
carried `status`, `is_successful`, `trace_result` and the counts. Those are DELIVERY facts, and a
paid row needs them MORE than an unpaid one, not less. Money decisions and delivery decisions must
never share one guard.

## S1 (CRITICAL) — the defect the phase introduced, and how it billed twice

A billed tier 2 row that got no vendor result failed `excludeBilledRows`, so the blanket update
skipped it and it kept `status = 'processing'`. The route then marked the job `completed`, and the
completed early-return means that job is never polled again. Sixty minutes later
`sweep-stale-traces` stage 1 claimed it — its select filters on `status` + `created_at` with **no**
`trace_job_id` restriction — and settled it against
`nonPaddingResults.find(r => r.primary_phone || r.mobile_1 || r.email_1)`, which for a bulk row's
SHARED Tracerfy job is whatever OTHER record in the batch came back. Second $0.25 on one address,
another property's phone and email written onto the customer's parcel, and both pushed to their
GoHighLevel CRM. At HEAD the blanket wrote `status: 'no_match'` unconditionally, so the row never
reached that cron. **This phase opened the path.**

Fixed in THREE places, not two. Each blanket update is now two statements:

1. **The money, guarded** — `charge: 0, tier: 1` inside `excludeBilledRows`, which is safe precisely
   because the guard makes it impossible for the statement to match a row that collected anything.
   This is stronger than folding: it is pushed into the database, so there is no read-then-write race.
2. **The delivery facts, unguarded, for every row** — `status: 'no_match'`, `is_successful: false`.

`lib/trace/settleBulkJob.ts`, `app/api/trace/bulk/status/route.ts`, and — found by the new fence I
wrote for this rule — `app/api/cron/sweep-stale-traces/route.ts:332`, **the reference implementation
I was told to copy**. It carries the identical flaw. Its blast radius is smaller (a stranded row, not
a double charge, once stage 1 is narrowed) but it is the same defect and it is now split too.

Plus the defence in depth: `sweep-stale-traces` stage 1 now carries `.is('trace_job_id', null)`.
Its heading said "single traces" and its filters did not.

## S2 (HIGH) — same root cause: declining to BILL is not declining to DELIVER

My verdict on the charge was right and the status half was wrong. There are now TWO gates:

- `shouldDeliver = fastAppendCredit && !historyRow.is_successful` → status, `trace_result`, the
  counts, `is_successful`, and the `records_matched` bump. The bump moved here because it counts
  matched RECORDS, not collected money.
- `shouldBill = fastAppendCredit && !isCacheHitRow(historyRow)` → the refund, the `deductOrZero`,
  and `charge`/`tier`/`ai_research_charge`. Strictly narrower.

Without this the customer paid $0.25, FastAppend delivered contacts, and the CSV showed six blank
contact columns with `status = no_match` (`exportCsv` reads `trace_result`; nothing reads
`ai_research.business_trace_contacts`), while v1 and the MCP showed the contacts — two of our own
surfaces describing one row differently.

## S3 (HIGH) — two mutations survived, both the select list

Both confirmed surviving, both now killed. The cause was mocks that ignored the column argument.
Adopted the phase 4b `projectRow` PostgREST-projection stubs from
`lib/suite/__tests__/mcp-tools.test.ts` into the `bulk/status` and `sweep-business-traces` harnesses.

- `bulk/status` `.select('id, charge, tier')` → `.select('id')`: **was 0 red, now 2 red.**
- `sweep-business-traces` select drops `charge`: **was 0 red, now 3 red.** That one fully restores
  the phase's headline defect, because `isCacheHitRow`'s third arm needs `charge`.

## S5 (MEDIUM) — the exemption was argued for `charge` and silently extended to `tier`

The three ledger-resolved sites wrote `tier: TRACE_TIER.PER_SUCCESSFUL_TRACE` flat, and
`chargeReceipt.test.ts` only matches `charge`, so nothing caught it. They now keep the ledger amount
raw and take `tier` from `foldBillingWrite`, which never downgrades. The ledger knows what moved; it
does not know the billing model.

The inconsistent fixture is fixed in both places. It had the row showing a $0.25 receipt while the
ledger held a single $0.05 debit — two numbers that cannot both be true, so it froze the behaviour
instead of proving it safe. Both fixtures are now coherent: the row is a billed tier 2 miss and the
ledger holds that debit PLUS a tier 1 contact charge a previous attempt booked before dying, so the
row really has collected $0.50 and the raw write of the ledger TOTAL is provably right while a fold
(0.25 + 0.50 = 0.75) would invent money.

## S6 (MEDIUM) — `collectedChargeFor` now SUMS

It was `.limit(1)` with no ORDER BY and no aggregate, so a row carrying two debits returned an
arbitrary one and three sites wrote it raw, under-reporting the rest. It now totals every debit,
coerces the PostgREST decimal-as-string form, rounds to cents, and treats an unreadable amount as 0
rather than poisoning the total with NaN. New file `lib/wallet/__tests__/collectedCharge.test.ts`.

`sweep-business-traces` gained the `collectedChargeFor` probe its two twins already had.

**A consequence I had to follow, and it reverses part of the review above.** Once a site asks the
ledger, the ledger total is authoritative, so folding its answer onto the row's own column
double-counts the same debit. `sweep-business-traces` therefore switched from folding to
ledger-raw + folded tier, matching its twins — and it goes BACK onto `ALLOWED_RAW_WRITES`, on the
LEDGER ground, not the retired "tier 1 only" one. The earlier claim that its exemption was removed
for good is superseded. I also renamed its local `billing` to `collected`, because a plain object
named `billing` makes `isFolded` read a raw write as folded — a real weakness in the fence, and the
honest classification is what keeps the exemption list meaningful.

## S4 (MEDIUM) — verified, not assumed

Fixing S1 does resolve it, and there is now an assertion that proves it rather than asserting the
mutated array alone: the billed row's id must appear in the `.in()` of the statement that actually
wrote the status. In-memory copy and database now agree, so neither caller finalizes a job around an
unresolved row and `buildPerRecordResult` cannot report `processing` inside a completed job.

## The fence gained a third safe form, and a new rule

`chargeReceipt.test.ts` knew two forms (folded, or exempted). A charge write narrowed by
`excludeBilledRows` is a third, and it is stronger than folding, so the scanner now does a paren-scan
to recognise it. Two new fences came with it: a canary so a broken paren-scan cannot silently call
everything safe, and **"keeps DELIVERY facts out of every excludeBilledRows guard"** — which is what
found the same defect sitting in `sweep-stale-traces`.

Final classification of all 18 charge write sites: 11 FOLDED, 3 GUARDED, 4 RAW (all ledger-resolved,
all exempted with the ledger reason).

## Mutation table — 26 mutations, 26 killed, and ONE SURVIVED FIRST

Every mutation verified as actually applied (anchor matched exactly once) and the total test count
checked for a DROP on every run. No totals dropped.

| Mutation | Red |
|---|---|
| N1 settleBulkJob: delete the unguarded delivery statement | 2 |
| N2 settleBulkJob: put delivery BEHIND the guard (the defect) | 2 |
| N3 bulk/status: delete the unguarded delivery statement | 1 |
| N4 sweep-stale-traces: delete the unguarded delivery statement | 1 |
| N5 sweep-stale-traces: drop `.is('trace_job_id', null)` | 1 |
| N6 sweep-business: gate DELIVERY on the billing check | 2 |
| N7 sweep-business: restore `!is_successful` as the money gate | 3 |
| N8 sweep-business: write money unconditionally | 3 |
| N9 bulk/status: narrow select to `id` | 2 (was **0**) |
| N10 sweep-business: drop `charge` from the select | 3 (was **0**) |
| N11 sweep-stale-traces: drop charge/tier from stage 1 select | 1 |
| N12a settleBulkJob site 165: flat tier | 1 |
| N12b settleBulkJob site 224: flat tier | **0 → 1** |
| N13 sweep-entity site 438: flat tier | 1 |
| N14 collectedChargeFor: one debit instead of the total | 7 |
| N15 sweep-business: remove the ledger probe | 2 |
| N16 sweep-business: fold the ledger answer | 1 |
| N17 settleBulkJob:257 fold → flat zero | 1 |
| N18 settleBulkJob:308 fold → raw replace | 1 |
| N19 bulk/status:288 fold → raw replace | 4 |
| N20 sweep-entity:467 fold → flat zero | 1 |
| N21 sweep-entity:495 fold → flat zero | 1 |
| N22 sweep-business `tier1RateFor` ignores source | 1 |
| N23 bulk/route drops source from the job insert | 1 |
| N24 bulk/route drops source from every history row | 1 |
| N25 `isTrackASource` stops recognising the WEB tag | 1 |

**N12b survived at 0 red and I am reporting it plainly.** Flattening the tier on settleBulkJob's
FastAppend-credit branch killed nothing. The cause is the tautology class the flag rule warns about,
in a different dress: every existing fixture on that branch carries no `tier` at all, `Number(undefined)`
is NaN, the fold treats that as "no prior tier", and so the flat value and the folded value are the
same number. Only a row that really is tier 2 separates them. A test now covers it and the mutation
dies. My first anchor for it also matched TWICE (both ledger sites share a line) and reported
ANCHOR-MISS rather than a false 0 — which is the check earning its keep.

## S8 / S9 — documented, not changed

**`total_charge` changed meaning.** Because `charge` now accumulates, it is the LIFETIME receipt for
the addresses in a job rather than that job's own cost. The same job can report `0.15` on the
finalizing poll and `0.40` later, once an earlier tier 2 purchase on one of its addresses is folded
in. No money moves; the number answers a different question than its name suggests. It affects the
`bulk_job.completed` webhook, both status routes and the MCP `bulk_status`.

**The `source` tag is written by an UPSERT and therefore overwrites.** An address first submitted via
MCP and later resubmitted from the dashboard flips `source` from `mcp` to `web` on the reused row,
and drops out of `mcp_spend_today`, which filters `.eq("source","mcp")`. No money moves; MCP-attributed
spend under-reports for any address a user later re-runs from the web UI.

## Gates, observed personally, after all corrections

`npx vitest run` **982 passing / 61 files / 0 failing** (pre-review 955/59; baseline 933/58) ·
`npx tsc --noEmit` **0** · `npx eslint app lib components` **47** (baseline 47, unchanged) ·
`npm run build` **compiled**.

## Superseded

The "Gates" line of the first review (955) and its claim that `sweep-business-traces`'s exemption was
removed. Both are corrected above.

---

# Phase 5b, third adversarial review: the refund that could not name its row

A third review found **one new production defect** and several 0-red test gaps. The defect's CLASS
was fixed at the database rather than patched at the call sites, which was David's call.

## The defect

Two settle sites refund a historical AI-research fee and then call `collectedChargeFor` so they do
not double-charge the row:

- `app/api/cron/sweep-business-traces/route.ts`
- `lib/trace/settleBulkJob.ts` (FastAppend arm)

The probe summed `wallet_transactions` where `type = 'debit'`. The refund it had just issued is a
CREDIT, and `credit_wallet_balance` did not take a `trace_history_id` at all, so a credit could not
name a row. **The money handed back still counted as collected.** The probe answered non-null,
`deductOrZero` was SKIPPED, and the customer received the contacts free while `trace_history.charge`
reported an amount that was back in their wallet.

`supabase/migrations/20260917_credit_wallet_balance_trace_link.sql` closed the class: one function,
a 5th optional `p_trace_history_id`, applied and ACL-verified live before this pass began. **No
migration was written or applied in this pass.**

## What changed

**`lib/wallet/collectedCharge.ts` returns a NET.** The `.eq('type','debit')` filter is gone -- that
filter, not the arithmetic, is what hid the refund, because a credit the query never returns cannot
be subtracted. `type` is SELECTED and classified in JS: a debit adds, **everything else subtracts**.
Written as an allow-list on `'debit'` rather than a deny-list on `'credit'` because the column's
CHECK is `('credit','debit','refund','auto_rebill')` and three of those four ADD balance, so an
unanticipated type errs toward charging money genuinely owed rather than skipping a charge never
paid -- the safe direction for a guard whose failure mode is billing the same row twice.

**Null and zero stayed DIFFERENT, and the callers moved to `> 0` instead.** This was the one real
design choice. Null means the wallet has never touched the row; 0 means money moved both ways and
settled back to nothing. Collapsing them in the helper would have been the quick fix and it is
wrong twice over: the helper could no longer say which happened, and an audit or reconciliation
could never recover the difference. But **0 is not a collection**, so every one of the four probe
sites now tests `collected !== null && collected > 0`. That is what actually closes the defect --
returning 0 from a fully-refunded row and leaving the callers on `!== null` reproduces the bug
exactly. A negative net (possible when a historical debit predates the migration and so was never
linked) takes the same road.

**The two refund sites pass the row id.** `app/api/stripe/webhook/route.ts:85,150` was NOT touched:
those are genuine wallet top-ups belonging to no row and must keep passing four arguments forever.

**`lib/trace/settleBulkJob.ts` delivery statement gained `.eq('status','processing')`,** matching its
two siblings in `bulk/status` and `sweep-stale-traces`. Within one request a successful row cannot
enter `ids`, but a concurrent settle of the same Tracerfy job can succeed one between the read and
the write -- after which the statement stamps `no_match, is_successful: false` over a row carrying
real contacts, and the guarded money statement has already declined to touch it.

**A third probe site was corrected beyond the brief.** `sweep-entity-traces:415` never refunds, but
its two twins refund rows it also settles, so it needs the same `> 0` test. Leaving it on `!== null`
would have left the defect alive on one of the three doors.

## The limitation, stated deliberately

Credits written before 2026-09-17 carry a NULL `trace_history_id` and can never be back-linked, so
the net cannot see them. **No backfill, and no compensating subtraction for unlinked credits** -- a
compensation would have to guess which unlinked credit belongs to which row, and a guess in that
function is a guess about whether to charge a customer. It is safe to accept because the 743 rows
carrying `ai_research_charge > 0` are all settled (nothing in `processing`, no pending
`business_trace_jobs`), the research fee was retired with the AI Search engine so no new row can
acquire one, and both refund arms are gated on `ai_research_charge > 0`. This is a
forward-correctness fix. The comment in `collectedCharge.ts` says so.

## The fixture that hid the defect

`sweep-business-traces/__tests__` set `ai_research_charge: 0.15` against an **empty ledger** -- a fee
on the row with no debit behind it, which nothing can produce: the column and the
`wallet_transactions` row are written by the same act. With the empty ledger the probe answered null,
the deduct ran, and the defect was invisible. The fixture now carries the linked $0.15 debit, and the
harness's `rpc` stub **appends to the ledger exactly as the wallet functions do, and only when the
call carries `p_trace_history_id`**. That is what makes the refund's new argument load-bearing in
the test rather than cosmetic: drop it and the credit stops reaching the probe, which IS the defect.
The same stub went into `settleBulkJob`'s harness, which exposed a second incoherent fixture
(`ai_research_charge` = $0.15 with no matching debit); it now carries both linked debits.

Every ledger fixture in all three harnesses now carries its `type`. PostgREST never omits a selected
column, so a stub that did was telling the route a lie no database can tell it.

## The fence hole, and why the fix is per-column

`isFolded` was `/(^|,)\s*charge\s*:\s*\w*[Bb]illing\.charge/` -- a test of what the identifier was
CALLED, never of what it was bound to. **Proven, not argued:** rename the local in
`sweep-business-traces` to `billing`, delete its `ALLOWED_RAW_WRITES` entry, and the old fence passes
**8/8 green** while the file clobbers receipts. The same mutation against the new fence is red.

`foldedBindings()` now derives the answer from the file's own assignments, and it tracks them **per
column**, which is not fussiness. `sweep-business-traces` holds
`collected = { charge, tier: foldBillingWrite(...).tier }`, whose two halves have different
provenance: `tier` folds, `charge` is the LEDGER's answer written raw on purpose. A binding set that
is not column-aware must call that identifier wholly folded -- which silently retires a live
exemption as "stale" and drops the file out of the fence entirely, a failure I hit and had to fix
mid-pass -- or wholly raw, which would demand an exemption for a `tier` that genuinely folds.

**Decision: the fence WAS extended to `tier`.** Measured before writing it: every `tier` write in a
`trace_history` update payload is already folded or already guarded, with exactly one reaching the
fold through an object literal. So the extension costs **no exemption list at all**, and `tier`
deserves one less than `charge` does -- the ledger records money, not the billing model, so nothing
can ever write `tier` from it. The cost was near zero and the case is strong: the tier tautology was
found by a reviewer at THREE separate sites because flattening a folded `tier` killed no test
anywhere, every fixture in the suite carrying tier 1 or no tier, where the fold's answer and the
literal are the same number 1.

## Mutation results — 16 run, 16 killed, 0 survivors

| # | Mutation | Result |
|---|---|---|
| M1 | `collectedCharge`: debit-only sum (the pre-migration behaviour) | 13 red |
| M2 | `collectedCharge`: drop `type` from the select | 1 red |
| M3 | `sweep-business-traces`: unlink the refund | 2 red |
| M4 | `settleBulkJob`: unlink the refund | 2 red |
| M5 | `sweep-business-traces`: `!== null` instead of `> 0` | 1 red |
| M6 | `settleBulkJob`: `!== null` at both probes | 4 red |
| M7 | `sweep-entity-traces`: `!== null` instead of `> 0` | 1 red |
| M8 | `settleBulkJob`: drop `.eq('status','processing')` from delivery | 1 red |
| M9 | `sweep-business-traces`: flatten the folded `tier` (MX8) | 2 red |
| M10 | `bulk/status`: drop `.eq('status','processing')` from delivery (MX1) | 1 red |
| M11 | `bulk/status`: delivery BEFORE money (MX3) | 1 red |
| M12 | `sweep-stale-traces`: delivery BEFORE money (MX3) | 1 red |
| M13 | `settleBulkJob`: delivery BEFORE money | 1 red |
| M14 | fence hole: rename local to `billing` + delete its exemption | 1 red |
| M15 | fence: flatten a folded `tier` in `trace/status` | 2 red |
| M16 | M14 again with the OLD shape-based `isFolded` restored | **8/8 GREEN — the hole, proven** |

No anchor failures, and the total stayed at 1000 on every run, so no kill is a file that failed to
load.

## A 0-red found DURING verification, and closed

M6 mutated both `settleBulkJob` probes together and killed 4, which flatters the result. Run
separately, **the Tracerfy branch survived at 0 red** -- that branch never refunds, so no fixture
could reach a net-zero ledger. It is reachable in production: one row is settled by all three paths
and two of them refund against it. `makeAdmin` gained a `priorCredit` option and a test now covers
it. Isolated re-run: Tracerfy branch 1 red, FastAppend branch 3 red.

## S8 / S9 — re-confirmed against live source, documented, NOT changed

**`total_charge` changed meaning.** `charge` accumulates, so it is the LIFETIME receipt for the
addresses in a job rather than that job's own cost. The same job can report `0.15` on the finalizing
poll and `0.40` later, once an earlier tier 2 purchase on one of its addresses folds in. Verified in
source: `lib/suite/mcp-tools.ts:536`, `app/api/trace/bulk/status/route.ts:117` and
`app/api/v1/trace/bulk/status/route.ts` all SUM the stored per-row `trace_history.charge`. It affects
the `bulk_job.completed` webhook, both status routes and the MCP `bulk_status`. No money moves; the
number answers a different question than its name suggests.

**The `source` tag is written by an UPSERT and therefore overwrites.** Both bulk submit paths write
`source` into rows upserted `onConflict: 'user_id,address_hash'` (`app/api/trace/bulk/route.ts:136,167`
writes `TRACE_SOURCE.WEB`; `lib/suite/mcp-tools.ts:360` writes `"mcp"`). An address first submitted
via MCP and later resubmitted from the dashboard flips the reused row's `source` to `web` and drops
out of `mcp_spend_today`, which filters `.eq("source","mcp")` (`lib/suite/mcp-tools.ts:35`). No money
moves; MCP-attributed spend under-reports for any address a user later re-runs from the web UI.

## Gates, observed personally

| Gate | Start of pass | After |
|---|---|---|
| `npx vitest run` | 982 passing / 61 files / 0 failing | **1000 passing / 61 files / 0 failing** |
| `npx tsc --noEmit` | 0 errors | **0 errors** |
| `npx eslint app lib components` | 47 problems | **47, unchanged** |
| `npx next build` | compiles | **compiled successfully** |

eslint briefly went to 48 (a `RECEIPT_COLUMNS` const used only as a type in the fence); the const was
replaced with a plain union type and the count is back to 47. Nothing committed, nothing pushed.

---

# PLAN: Phase 5c (2026-09-18) — bulk tier 2. Three sub-phases, STOP AND CHECK IN AFTER EACH.

David's decision, 2026-09-17: **a blank-owner bulk row runs a Full Property Trace AUTOMATICALLY**,
same as single and v1 single. 273 of 1,270 historical bulk rows (21%) are blank-owner, so this is
the capability gap closing and it is also a real change to what existing bulk users are billed.

## MEASURED LIVE 2026-09-18, $0.00 spent (every probe a deliberate miss, misses are free)

| | |
|---|---|
| Dossier latency | 681 / 724 / 816 ms (min/median/max) |
| FastAppend contact latency | 528 / 617 / 875 ms |
| Tracerfy person latency | 448 ms |
| **A tier 2 record, both calls** | **~1.2 to 1.7 s** |
| PTP's Tracerfy balance | **10,694 credits = 1,069 dossier hits** |
| Tracerfy `queues_pending` | 0 |

## 5c-1. PREREQUISITES. Two live defects. Bulk tier 2 built on today's client is broken.

### P1. A FastAppend "company not found" is billed as an outage and 502s the customer

Measured: FastAppend returns **HTTP 404** with body
`{"error":"Company not found: ...","hit":false,"credits_deducted":0}`. That is a MISS.
`lib/tracerfy/client.ts:536` checks `if (!response.ok)` and returns `contactFailure(...)` **before
the body is parsed**. Chain, confirmed end to end:

`success:false` -> `executeRoute` `pass2.failure` -> `app/api/trace/single/route.ts` **502 with
`charge: 0`**.

So a tier 2 record whose dossier HIT — $0.20 spent, the 86-field record in hand — and whose entity
FastAppend does not carry, returns an **error, no record, and no bill**. `executeRoute`'s own
comment says "the dossier spend above stands and the record is good" immediately before discarding
it. Measured rates make this the dominant case: 22 of 24 commercial parcels are entities and
FastAppend hits 13 of 22, so **~9 in 22 entity records** take this path.

**L-008 recorded this exact lesson and the fix landed one layer too deep.**
`parseBusinessTraceResponse` handles `hit:false` correctly; the HTTP status check above it
short-circuits before reaching it.

**Fix:** the discriminator is the BODY, not the status. A response carrying a valid vendor envelope
(`hit` boolean present) is an ANSWER at any status and goes to the parser. Only a genuine transport
failure — 5xx, network throw, non-JSON, no `hit` field — is `contactFailure`. **Verified: Tracerfy's
person endpoint returns 200 + `hit:false`, so this is FastAppend-only.**

### P2. `getAnalytics()`'s type is fiction, and the pre-flight built on it would never fire

Declares `credits_remaining`, `credits_used`, `total_jobs`, `total_records`. The API returns
`balance`, `total_queues`, `properties_traced`, `queues_pending`, `queues_completed`. **No declared
field name exists.** Zero call sites, so it was never exercised.

The failure mode is the silent kind: `if (data.credits_remaining < needed)` evaluates
`undefined < 300` = `false`, so the guard passes every time and blocks nothing. It would look
implemented and do nothing. Fix the interface against the real response and add the test that
would have caught it.

## 5c-2. THE ENGINE. Visible: almost nothing. Saying so bluntly.

### It cannot run in the submit route
`maxDuration` is 60 s and a 345-record job is minutes of vendor work. Queue plus cron worker.

### The queue gets its OWN column, not `ai_research_status`
Four reasons, none stylistic: that column is `VARCHAR(20)` and its name refers to a retired engine;
its partial index `WHERE ai_research_status = 'queued'` covers **only the literal first rung**, so
the live `.in(ENTITY_QUEUED_STATUSES)` claim and all five stale sweeps are seq scans today; and
mixing two billing models in one state machine is how tier gets confused.

**Migration:** `property_trace_status VARCHAR(24)`, `property_trace_claimed_at TIMESTAMPTZ`, and
a partial index on `(property_trace_status, created_at) WHERE property_trace_status IS NOT NULL`
— which covers **every** rung including retries, fixing the flaw the entity queue has.
Column adds on a pre-existing table need no GRANT. **Read the ACL back anyway if any function is
touched; see CLAUDE.md.**

### Mirror the entity claim EXACTLY. It is correct and it is already load-bearing.
Atomic compare-and-swap (`UPDATE ... WHERE id = ? AND status = <the value we read>` + `.select().maybeSingle()`,
`continue` on null), `claimed_at` set with the flip, stale recovery with
`.or(claimed_at.is.null, claimed_at.lt.cutoff)` because SQL `<` never matches NULL, and a killed
claim counts as a SPENT attempt so a poison row cannot loop forever.

### Throughput, sized from the measurement not a guess
Both tier 2 calls draw the **shared 500/min instant pool**; tier 1 bulk posts to the batch endpoint,
a different bucket, so they do not compete. 2 calls/record = a 250 rec/min hard ceiling.
**Budget 120 records per run at concurrency 5** = 240 calls/min, 48% of the pool, headroom left for
single traces. At ~1.5 s/record that is ~36 s per run, far inside `maxDuration = 300`. Cron is
`* * * * *`. A 345-record job finishes in **~3 minutes**; 10,000 in ~83.
(For scale: the entity cron's `MAX_ROWS_PER_RUN = 5` would take **69 minutes** for 345.)

### BILLING. L-007 is the whole rule and it must be written at the gate.
**Bill on whether the dossier ANSWERED, never on whether it FOUND anything.** A hit and a miss are
both billable — tier 2 is per record SUBMITTED. A vendor FAILURE is not billable and goes back on
the retry ladder. The charge fires in the cron, in the same request as the vendor spend, which is
David's mechanical rule applied where the money actually moves.

**The sentence in `lib/trace/entityTraceAttempts.ts` that 5c breaks**, quoted so nobody reuses it:
*"an exhausted row is written terminal with no charge, no tier and no ai_research_charge, which is
also what keeps it deletable under lib/trace/billedRows.ts."* Under tier 2 a row CAN be exhausted
AND billed (dossier answered, contacts never reachable). Exhaustion must not zero a receipt. Reuse
`foldBillingWrite`; never a flat write. **Phase 5b's rule applies unchanged: STATUS IS NOT A RECEIPT.**

> **CORRECTION, 2026-09-18, after 5c-2 was built and reviewed.** The parenthetical above is not
> reachable the way it reads. "Contacts never reachable" was imagined as a row that climbs the retry
> ladder and exhausts on the contact leg. As built, a contact-vendor failure does NOT go on the
> ladder at all: the dossier already answered, so the row is billed and settled terminal in one pass.
> Only a DOSSIER failure climbs and exhausts, and that case is never billed. The exhausted-AND-billed
> state does still occur, by a different route: a reused row that already carries a receipt from an
> earlier settle. So **the guard is correct and must stay** (`foldBillingWrite`, never a flat write,
> exhaustion never zeroes a receipt) and it is this SENTENCE that was wrong about why. Recorded
> rather than deleted so nobody re-derives the ladder that was never built.

## 5c-3. THE SURFACES. Visible: all of it. This is the phase David judges.

### The two balance checks are DIFFERENT and must never be merged
| Check | Question | On failure |
|---|---|---|
| User's PTP wallet (`wallet_balance`, dollars) | can the CUSTOMER pay? | **402, tell them to add funds** |
| PTP's Tracerfy balance (`balance`, credits) | can PTP EXECUTE? | **Refuse/hold and alert David. NEVER tell the customer to add funds** |

Billing a customer for a job we cannot run is the outcome the second check exists to prevent.
**The Tracerfy balance is SHARED across all users' jobs**, so size the check against credits needed
PLUS whatever is already queued, not the raw balance, or the guard passes for two jobs that cannot
both run.

### Pre-flight estimates, all three submit surfaces
Blank rows stop being free. `app/api/trace/bulk/route.ts:101` and `app/api/v1/trace/bulk/route.ts:129`
must add `blankCount x tier2Rate`. `worstCaseCost` in `lib/suite/mcp-tools.ts:167-176`: the
`continue` at :171 is the single line making blanks free, and its own comment names the
replacement — *"the blank arm becomes chargePerRecord(profile)"*.

### EVERY user-facing string that goes FALSE. Enumerated so none is missed.
`app/(dashboard)/trace/bulk/page.tsx` — the amber banner :651-653 (*"We skip those and you are not
charged for them"*), the count :665, the cost estimate :669 (wrong multiplicand AND wrong model:
tier 2 is per record submitted, not "per successful match"), the `Estimated Max Cost` tile :708-709,
and **`Skipped, not charged` at :713 AND :773**.
`components/trace/BulkSkipSummary.tsx` :51, and its header invariant :31-32 (*"There is no price
here and there must never be one. These rows are free"*) — that component's premise is gone.
`lib/suite/mcp-shared.ts:21-25` **`PTP_MCP_CAVEAT`, appended to EVERY MCP response**, whose own
header calls the no-match sentence a money promise. Tool descriptions at
`app/api/[transport]/route.ts:61,67`. `BLANK_OWNER_SKIP_REASON` survives **only** for rows that fail
address validation (the session route does not validate per record, so a row with no city still
cannot be looked up); it must stop being written for a missing owner.

> **CORRECTION, 2026-09-18, during 5c-3A.** The sentence above is STALE, not wrong-headed: it was
> written before 5c-2 existed, when `BLANK_OWNER_SKIP_REASON` was the only constant available for
> that row. It is now the WRONG constant for it. Its text is *"No owner name came in for this
> address... Send it again with the owner of record and we will run it"*, and for a row missing its
> city that advice is FALSE, because doing what it says will not make the row run. 5c-2 created
> `PROPERTY_TRACE_NO_KEY_REASON`, which says the true thing, and it is already what the cron writes
> for the identical row shape (`sweep-property-traces/route.ts:320`). **Ruling: the session route
> validates blank-owner rows with `validateAddressInput`, keeps failures out of both the estimate and
> the Tracerfy pre-flight, and writes them `PROPERTY_TRACE_NO_KEY_STATUS`.** One row shape, one
> answer, whichever layer notices. `BLANK_OWNER_SKIP_*` then has no live writer on these routes and
> survives only to keep serving the 273 rows already carrying it, so treat it as HISTORICAL.

### The 10-minute poll ceiling breaks
`page.tsx:393` is 120 attempts x 5 s. A cron-driven job over ~1,200 records exceeds it and
*"Processing is taking longer than expected"* becomes the normal outcome, not an error. Raise it,
or change the UX to a resumable "check back" with the job id. **This is a real behaviour change:
bulk submit goes from seconds to minutes of background work.**

### Payload parity and size
`buildPerRecordResult` on v1 REST (`app/api/v1/trace/bulk/status/route.ts:345-369`) **lacks
`property_record` and `tier`** although both surfaces' comments claim they are line-for-line
identical. A tier 2 bulk row's record is invisible there today. The session status route has **no
per-record payload at all**. And `bulkStatus` in `lib/suite/mcp-tools.ts` has **NO limit** — it
returns every row of the job, each carrying a 65-key record, pretty-printed at 2-space indent with
no cap. `list_traces` is default 25 / max 200. Both need revisiting before rows carry records.

### THE BULK CAP IS 500 RECORDS. David, 2026-09-18.

`MAX_RECORDS` drops from **10,000 to 500** on `app/api/trace/bulk/route.ts:11` and
`app/api/v1/trace/bulk/route.ts:14`. MCP already caps at 500 (`lib/suite/mcp-tools.ts:106`), so
this makes **one number true on all three surfaces** instead of two.

**Measured against all 92 historical jobs before choosing:** median 20, average 51, p90 100,
p95 223, p99/max **654**. Only 6 jobs exceed 200, 4 exceed 300, and **exactly 1 exceeds 500**.
So 500 covers 91 of 92.

**The one it blocks is the 654 from 2026-03-27, and it is the only large job that ever worked**
(552 of 654 matched). The other five over 200 returned 2, 1, 1, 5 and 0 matches. Recorded so nobody
re-derives it: the cap catches the single productive large run, and that was accepted knowingly.

**What the cap is and is not.** It is NOT the money guard — the two pre-flight checks are. Its job
is bounding blast radius when a run goes wrong, and stopping one user from eating the SHARED
Tracerfy pool. For scale: a 500-record all-blank tier 2 job is 5,000 credits, **47% of the 10,694
balance in one submit**. That is exactly why the Tracerfy pre-flight must size against credits
needed PLUS what is already queued, not the raw balance.

**Worst-case single-submit exposure for a customer:** 500 x $0.40 = **$200** (all blank owners,
pay-as-you-go tier 2).

The 402/refusal copy must say the cap in records, and the UI should refuse at selection time rather
than after an upload the user waited on.

## DAVID'S DECISIONS, 2026-09-18, taken before execution began

These answer questions the plan left open. They are decisions, not recommendations.

1. **Build on `main`**, same as phases 1 through 5b.

2. **Task 10, long-job UX: CHECK-BACK TO HISTORY.** On poll exhaustion, stop the dead-end spinner
   plus red error and hand the user the job id and a route to the History page, which already lists
   bulk jobs with a status badge and a download once complete (`app/(dashboard)/history/page.tsx`).
   Context that reframed this task, measured after the plan was written: at a 500 cap one job is
   about 5 cron runs, roughly 5 minutes, which FITS inside today's 120 x 5 s ceiling. The ceiling
   only breaks under contention, when two or three jobs share the 120-per-run budget. So this is a
   smaller fire than the plan implies, and the fix is the UX one, not a bigger number.

3. **Task 7, the Tracerfy balance refusal: REFUSE SILENTLY, NO ALERT.** PTP has no alerting channel.
   No Sentry, no email provider, no Slack; `lib/suite/alert.ts` is a single tagged `console.error`
   whose own docstring says to wire it to a real channel before production. David chose no alert over
   a fake one. **Hard constraints: no string may claim anyone was notified, and the refusal must
   never tell the customer to add funds.** It is PTP's balance that is short, not theirs.

4. **NEW TASK 13: fix the advisory wallet check.** Found during pre-flight, not in the original plan.
   The submit-time wallet check is read-only and reserves nothing (`app/api/trace/bulk/route.ts:103`
   and `app/api/v1/trace/bulk/route.ts:132` are bare comparisons; neither route writes
   `wallet_balance`). The real debit is per record at settle time,
   `lib/trace/settleBulkJob.ts:150-176` via `deductOrZero` -> `deduct_wallet_balance`. So two jobs
   submitted back to back both pass against the same dollars. Settlement fails closed
   (`lib/wallet/deduct.ts:33-45`): a short wallet yields `insufficient_balance` and collects 0, so
   no customer is harmed and no balance goes negative, which is why this was never noticed. **PTP
   eats it.** At tier 2 that is up to 500 records of real vendor spend, about $150, collected at $0.
   Size the submit check against in-flight unbilled work, exactly as the plan already requires for
   the shared Tracerfy pool.

### Controller ruling, task 1 (recorded because the plan contradicted itself)

The plan says a body carrying `hit` is an answer "at any status" and one line later lists 5xx among
transport failures. Bound to: **the `hit` discriminator applies to 2xx and 4xx only; any 5xx is a
transport failure regardless of body.** A 5xx is the vendor reporting its own server failed, and
L-007 says an outage is never billable. The ruling can only under-bill, never over-bill. If it is
wrong, a FastAppend outage returning 5xx with a valid miss envelope gets retried instead of billed.

## TASKS
- [x] 1. P1: FastAppend 404 is a miss. Discriminate on the body, not the status. **DONE `55616b0`**
- [x] 2. P2: fix `getAnalytics` against the real response; test it. **DONE `55616b0`**
- [x] 3. `MAX_RECORDS` 10,000 -> 500 on session + v1; UI refuses at selection time. **DONE. Routes `f9b15d7`; UI refuses at parse time on raw rows, `fd73b39`**
- [x] 4. Migration: two queue columns + the all-rungs partial index. **DONE `54f1b41`, APPLIED to production and read back 2026-09-18**
- [x] 5. `sweep-property-traces` cron: CAS claim, stale recovery, ladder, 120/run, concurrency 5. **DONE `54f1b41`**
- [x] 6. Billing in the worker: answer = billable, failure = retry, fold never flat. **DONE `54f1b41` + `64cd577`**
- [x] 7. Both pre-flight checks, with the two different failure owners. **DONE `c1556dd`, `lib/trace/bulkPreflight.ts`**
- [x] 8. All three submit estimates. **DONE `f9b15d7` + `c1556dd`**
- [x] 9. Every string above. **DONE `fd73b39` + `2a443ea`.** Plus the API docs page, which the list omitted. See L-016.
- [x] 10. Poll ceiling / long-job UX. **DONE `fd73b39`.** Check-back to History, per David's decision.
- [x] 11. v1 payload parity + MCP limits. **DONE `fd73b39` + `627b78c`.** v1 default/max 500 (non-breaking), MCP 25/200, asymmetry documented both sides.
- [x] 12. Mutation-verify every money decision. Re-run by me, not taken from the report. **DONE, continuous: 21 mutations chosen and run independently by the controller across all four sub-phases, every one killed, every total held, every restore checksum-verified.**
- [x] 13. The submit wallet check must size against in-flight unbilled work. **DONE `c1556dd`.** Closes the back-to-back gap; the sub-second in-submit window is task 16.
- [ ] 18. **PARKED RESIDUALS from the final review's fix wave. None ship-blocking; recorded so they
      are not rediscovered as bugs.** (a) A 9-digit ZIP with no dash is now DROPPED where the ideal is
      to trim it to 5. Strictly better than before the fix, which rejected the whole row, but not as
      good as it could be. (b) The no-key sentence can render TWICE when a half-failed submit also
      carries no-key rows. (c) A stale comment at `app/api/trace/bulk/route.ts:557`. (d) Two money
      residuals the re-reviewer judged non-blocking because they sit on a correct ledger and a correct
      row receipt: `trace_job_id` attribution drift, and a one-pass race where a mid-flight resubmit
      can swallow one deduct. (e) Still out of scope and still true: `checkDuplicates` is inert on
      v1/MCP, and `validateAddressInput` still 400s a whole API batch on a mangled zip.
- [ ] 17. **PRODUCT GAP, found during 5c-3B. Not a copy problem, and deliberately not papered over.**
      There is now no in-product path to re-run **a bulk row that came back without the contacts it
      was submitted for**, inside the 90-day dedup window. Three of the five no-contacts reasons
      used to end "send it again and we will run it"; that advice fails, because the dedup hash is
      address-only and any existing row blocks the resend. 5c-3B removed the invitation rather than
      leaving a false instruction, and kept it only on the no-key reason, where supplying the missing
      street, city or state changes the hash so the resend genuinely works. **So the customer is now
      told the truth and has no remedy.** The narrowest fix the implementer identified: align
      `checkDuplicates` with the cache-hit test `checkSingleDuplicate` already uses, which is why a
      SINGLE trace re-runs today and a bulk row does not. That is a billing-adjacent decision and
      wants its own scoping, not a fold into a copy dispatch.

      **SCOPE WIDENED 2026-09-18 by the final 5c review (F5). This task said "a FREE failed bulk
      row", and that wording excluded the one population that is OUT OF POCKET.** A
      `property_trace_no_reach` row is billed the full per-record rate: the dossier answered, we
      charged, and the CONTACT vendor could not be reached, so the customer paid for a two-call
      product and received one call. It has no path to the contacts either, and a tighter one than
      the free rows: a single trace of the same address matches `CACHE_HIT_FILTER` on
      `property_record IS NOT NULL` and is served back from the database rather than re-running the
      contact leg (`lib/trace/billedRows.ts`), and a bulk resend is a dedup duplicate. Scoping this
      task on the free rows alone would design a remedy that steps around the only shape where
      money is involved. **Whatever is decided here has to answer for the billed no-reach row
      explicitly, including whether re-running its contact leg is free.**
      Sentence and code checked at the same time: `PROPERTY_TRACE_NO_REACH_REASON` states the charge,
      says what the customer has, and invites no resend, so nothing in the copy promises a retry that
      cannot happen. The gap is real and recorded; the customer is not being misled about it.

      **RELATED, NOT THE SAME TASK.** `checkDuplicates` is also INERT on v1 and MCP, which have no
      session cookie for its anon client (`lib/utils/deduplication.ts:20-30`). That is the same
      helper and the same product decision, it applies to both tiers equally, and the final review's
      F2 named making it real as one of the two available bets. The money half of F2 was fixed
      in the cron instead, so the dedup half stays entirely inside this task rather than being half
      done somewhere else.
- [ ] 21. **FOLLOW-UPS from the Phase 1 final re-review, 2026-09-23. None blocks the merge.**
      (a) The web single route's and the HighLevel push route's test harnesses do not emulate PostgREST column
      projection, so their new select-column dependencies are unfenced: dropping `trace_job_id` from
      app/api/trace/single/route.ts's existing-row select, or `parcel_id_local, county` from
      app/api/integrations/highlevel/push/route.ts's two selects, leaves every test green. The v1 twin was fixed
      with a `projectRow` helper; copy it to both. Trimming that column would silently make every bulk-owned
      processing row reusable after 2 minutes, racing the cron.
      (b) The new Tier 2 warnings comment in both single routes says the routing notes go to the step log and the
      server log; they are simply dropped. Correct the comment.
      (c) lib/trace/tier1Outcome.ts hard-codes `startsWith('APN|')` instead of the exported `isParcelKey`.
      (d) History and the dashboard render ", TX" as the subtitle under a parcel label, because such a row has no
      city. Customer-visible, not false.
      (e) The inline trace.completed sends `address: null` for a parcel-keyed record rather than the new
      "Parcel <id>, <County> County" label; the label exists and could be used.
- [ ] 19. **KNOWN GAP, logged by David's choice 2026-09-22 (spec D35). A crashed single trace can charge once for
      nothing.** A Tier 1 single trace finds contacts, `deductWallet` succeeds, then the process dies before the
      persist, so the customer never sees the result. A resend within 24 hours that now finds nothing never runs
      the ledger probe (it sits inside `if (billable)` in `lib/trace/singleTier1.ts`), so the earlier debit stays
      unrecorded and the row says "You were not charged". Rare (the window is two database calls). Fix later,
      together with task 16's transactional hold. David declined a Phase 1 refund path.
      Two more ways into the same state, found in the Task 8 review: (a) the deduct succeeds and the persist UPDATE
      FAILS (persistError), no crash needed, then a free resend never probes; (b) `already_collected` is not capped
      by the Tier 1 price or tier: a Full Property Trace that deducts $0.40 and dies before its persist, then a Tier 1
      trace on the same row the same day that finds contacts, is treated as already paid and reports charge 0.40.
      The test "asks the ledger nothing when nothing is billable" (lib/trace/__tests__/singleTier1.test.ts) pins
      today's behaviour; a fix that probes on every path must invert it.
- [~] 20. **ANSWERED for the SINGLE routes by spec D39 (2026-09-22 final review); the Tier 2 persist and the bulk
      settles are still open.** A trace row is one per address per user, and every settle on a REUSED row used to
      overwrite `trace_result`, `phone_count`, `email_count`, `is_successful` and `cost`. So a customer who paid for
      contacts on an address, then traced the same address again for a different owner (D25) and found nothing, lost
      the earlier paid contacts from History and the CSV, while `charge` kept the running total (D34).
      **DONE 2026-09-23, Tier 1 single traces (`lib/trace/singleTier1.ts`):** a trace that finds nothing and meets a
      row already carrying a phone or an email writes only the step log, the contact vendor and the queue columns,
      and leaves the result, the owner name it belongs to, the counts, the charge, the cost, the success flag and the
      outcome untouched. The response still reports this trace's own outcome, free.
      **STILL OPEN:** the same overwrite on the TIER 2 single persists (app/api/trace/single/route.ts,
      app/api/v1/trace/single/route.ts) and on the bulk settles, which D39 did not reach.
      Same family (Task 9 review): a Full Property Trace row stores no supplied owner (`input_owner_name` NULL), so a
      later trace of that address WITH an owner never matches it under D25's text, runs a new Tier 1 trace, and
      would replace the paid Full Property Trace contacts. Since D39 the Tier 1 half no longer does; before Phase 1
      that request was served the cached row free.
      **CLOSED 2026-09-23 (part 2), by David's ruling on the wave's own concerns:** the preserved branch also writes
      `status = 'success'` (the reuse UPDATE at the top of both single routes sets `processing` before the settle
      runs, which contradicted `is_successful = true`, showed History a Processing row over paid contacts, and handed
      it to `app/api/cron/sweep-stale-traces` to mark `error`), and writes `outcome_code` when, and only when, this
      trace ended `busy_try_again`, so a resend inside 24 hours still resumes from the step log. `found_by` and every
      other customer-visible column are still left alone, and a busy code on a successful row can never surface as a
      sentence because `tier1OutcomeReason` returns null whenever `is_successful` is true.
- [ ] 16. **DEFERRED, needs a migration: the wallet reserve is a RESERVE, not a LOCK.** 5c-3A's
      submit check now sizes against in-flight unbilled work, which closes the back-to-back
      double-submit gap. It does NOT close the sub-second window between one submit's own read and
      its own writes; that needs a transactional hold taken in the same transaction as the insert.
      Recorded as a task rather than left in a source comment, which was the 5c-3A implementer's own
      point and it is right: a limitation living only in a comment is one nobody ever schedules.
      Caveat is at `lib/trace/bulkPreflight.ts:176-184`. **NOT a 5c blocker.**
- [x] 15. **DONE `f9b15d7`, `c1556dd`, `c257062`. THE ENQUEUE, and the plan never numbered it.** The submit routes must stop SKIPPING
      blank-owner rows and start enqueueing them into `property_trace_status`. Today
      `app/api/trace/bulk/route.ts:92` pushes them to `skippedRecords` and writes
      `ai_research_status: BLANK_OWNER_SKIP_STATUS`. This is the actual capability change 5c exists
      for, 273 of 1,270 historical rows, and every other 5c-3 task is downstream of it. Called out
      because "the submit routes learn to in 5c-3" appears only in prose.
- [x] 14. **SECURITY, found 2026-09-18. CLOSED, applied to production and verified 2026-09-18.** `trace_history` grants
      INSERT/UPDATE/DELETE to `anon` and `authenticated` table-wide, so any signed-in user can rewrite
      every column on their own rows from the browser. 5c-2's `property_trace_status` inherited that
      and is a work trigger, so a browser write enqueues paid vendor work. Fix is verified safe:
      all 17 writing files use `createAdminClient`; the two browser files never write. REVOKE
      INSERT/UPDATE/DELETE from anon + authenticated, keep SELECT. See History.md 2026-09-18 and L-014.
      **DONE:** migration `20260918_lock_trace_history_writes.sql`, applied and read back. anon and
      authenticated are now SELECT-only; service_role untouched; 3 policies, 3,836 rows and RLS all
      unchanged. Two residuals left on purpose and named in the migration header: the now-dead
      INSERT/UPDATE policies (re-granting the verb would silently re-open the hole, so prefer
      dropping them next time this table is worked) and anon's retained SELECT.

---

# REVIEW: Phase 5c FINAL FIX (2026-09-18) — the four seams. Committed, not pushed.

Commit `cca815c`. **1306 passing from 1277, 67 files, 0 failing**, `npx tsc --noEmit` 0,
`npx eslint app lib components` 47, `npm run build` compiles. 14 mutations, all 14 killed.

Full report: `.superpowers/sdd/todo/final-fix-report.md`. Harness:
`.superpowers/sdd/todo/final-fix-mutations.mjs`.

Each sub-phase of 5c passed its own review and the whole-phase review still returned DO NOT SHIP.
Every finding was at a JOIN, which is the part no per-task review can see.

- **F1.** The tier split validated blank-owner rows with `validateAddressInput`, whose ZIP rule was
  never written for a question about lookupability. A valid street, city and state with an
  Excel-mangled ZIP was filed as no-key, told it was missing something it had, and locked out for 90
  days. The split now asks street, city, state only, and a malformed ZIP is dropped at the row write
  via the new `usableZip()` rather than sent on to a dossier it would contradict. v1 and MCP do NOT
  share the shape: they refuse the batch up front with an honest, actionable error and write nothing.
- **F2.** `collectedChargeFor` was unbounded, so on a REUSED row a resubmit's dossier purchase was
  answered with the first submit's debit and collected $0.00, repeatably. **Bet taken: narrow the
  guard.** `collectedChargesFor` now answers the decision within the current bulk job and the
  persisted amount as the ledger's full net, off one read. **Bet NOT taken: make dedup real on v1 and
  MCP.** It cannot reach the dashboard on day 91 where a fresh charge is genuinely owed, and
  `deduplication.ts` already records it as a product decision belonging to the bulk-route owner,
  because it would also start blocking retries of failed addresses on a public API. It is named in
  task 17 instead. **Both halves are genuinely needed; only the money half was in my remit.**
- **F3.** No submit route wrote `property_trace_status: null` on a tier 1 row, so a reused row served
  the other billing model's money sentence. **The three tests guarding it asserted `?? null`, which
  an absent key satisfies** (L-015). Tests fixed first, then the code, then mutation-proved.
- **F4.** `records_failed` and the partial-failure sentence were in the response and on no screen.
  Own tile in both phases plus the sentence whenever a half failed.
- **F5.** Task 17 widened above rather than remedied, per instruction.

## What this leaves open

1. Dedup inert on v1 and MCP, and the `trace_job_id` re-point that moves a finished job's
   `total_charge`. Both in task 17.
2. `validateAddressInput`'s ZIP rule still refuses a mangled ZIP on v1, MCP and both single routes.
   Honest and recoverable there; loosening it is a public API change beyond this brief.
3. Task 16 untouched, still needs a migration.

---

# PLAN: The HighLevel push bugs (2026-09-18). NOT STARTED, awaiting David's decisions.

Baselines re-verified before planning: **1306 passing / 67 files / 0 failing**, `npx tsc --noEmit` 0.
Blast radius read from PRODUCTION, not the handoff: **6 of 53 users** have both
`highlevel_api_key` and `highlevel_location_id` set. The handoff's "6 of 52" holds.

## THE PREDICATE, and it is not the three bullets

The handoff lists three bugs. Per L-011 each was treated as a hypothesis and each was CONFIRMED
against source, quoted below. But the list is a FLOOR (L-016). The property actually being fixed is:

> **Every place a HighLevel push can fail, or a credential can be wrong, where the customer is
> never told.**

Grepping for that property rather than working the list found six more instances, three of which
are in the same call path as the named bugs and two of which are worse than anything on the list.

## ROOT CAUSES. Three, and the three named bugs are symptoms of them.

### A. The client throws away WHY it failed, and never throws

`lib/highlevel/client.ts:218-222` (create) and `:203-207` (update) are the whole of the failure
handling:

```ts
if (!createRes.ok) {
  const errText = await createRes.text();
  console.error('HighLevel create contact error:', errText);
  return { success: false, error: 'Failed to create contact' };
}
```

`response.status` appears NOWHERE in `pushTraceToHighLevel`. A 401 (dead credential), a 422 (bad
payload) and a 429 (rate limit) are indistinguishable to every caller and identical in the log.
And because every fetch sits inside a `try` whose `catch` RETURNS rather than rethrows
(`client.ts:227-230`), the function never rejects, so the `.catch()` on all five automatic call
sites is dead handling that cannot fire on an HTTP failure.

**A.2, the fully silent one, not in the handoff.** The duplicate-search step at `client.ts:166-180`
tests `searchRes.ok` and has **no else**. A 401 there logs nothing at all, leaves
`existingContactId` null, and falls through to the CREATE branch. So a credential failure on search
silently converts "update the existing contact" into "create a duplicate", and if the credential is
only partly broken that duplicate SUCCEEDS. This is a silent data-quality defect, not just a silent
error.

### B. `{success:false}` travels inside an HTTP 200, and nothing reads `success`

`app/api/integrations/highlevel/push/route.ts:73` returns the client's result verbatim:
`return NextResponse.json(result);`. `components/trace/PushToCrmButton.tsx:38-48` branches on
`response.ok`, then on `data.pushed`, then on `data.action`. **It never reads `data.success`.**
A 401 yields `{success:false, error:'Failed to create contact'}` at status 200, so `response.ok` is
true, `pushed` and `action` are both undefined, and the component renders a green check reading
**"Contact created"** for a contact that was not created. Confirmed by reading both files.

**B.2, the bulk half, not in the handoff.** `push/route.ts:128` hardcodes
`{ success: true, pushed, failed, total }`. `failed` is computed at `:124` and rendered nowhere.
A 50-record job where every single write 401s shows a green check reading **"0 contacts pushed"**.

The button is mounted in six places: `dashboard/page.tsx:270,328`, `history/page.tsx:189,247`,
`trace/bulk/page.tsx:1061`, `TraceResultCard.tsx:284`.

### C. "Connected" is a non-null check on two strings

`settings/integrations/page.tsx:96`:
`const isHlConnected = !!(profile?.highlevel_api_key && profile?.highlevel_location_id);`

`app/api/integrations/highlevel/save/route.ts` makes **zero** outbound calls. It presence-checks two
fields and writes them. Typing `x` and `y` and pressing Save yields a permanent green "Connected".

**C.2, worse than the handoff recorded.** `page.tsx:142`, inside `saveHighLevel`, runs
`setTestResult(null)`. So pressing Test Connection, receiving a red "Invalid API key", and pressing
Save anyway CLEARS the red banner and turns the badge green in the same tick. Save does not merely
skip validation, it erases a failure the user has already been shown.

**C.3, the scope mismatch.** `page.tsx:370` tells the user to grant the `contacts` scope. The test
route proves a READ (`test/route.ts:28`, `GET /contacts/?limit=1`). Every real push is a WRITE
(`client.ts:197` PUT, `client.ts:212` POST). A read-only credential passes Test Connection cleanly
and fails 100% of pushes. Confirming the exact GHL scope names against live GHL is a prerequisite
for task 3.

## THE ORGANISING DISTINCTION, and it is L-007 pointed at pushes

**A 401 is not a trace failure. It is a CREDENTIAL failure.** Those two need different handling and
today they are the same code path, which is why there is nowhere to put the error.

| Class | Examples | What is broken | Who must hear about it |
|---|---|---|---|
| **credential** | 401, 403 | the stored key, for EVERY future push | the account owner, once, on the integrations page |
| **record** | 422, 404 location | this one payload | whoever submitted this record |
| **transient** | 429, 5xx, network | nothing | a retry |

This is the same shape as L-007: two outcomes look identical from outside (no contact appeared in
the CRM) and the handling must key on the thing that DIFFERS (is the key dead, or did this record
fail), never on the thing they share (success is false). Writing the classification at the gate is
required, with the comment, because the next reader will see three false-y values and merge them.

**It is also what makes the automatic paths fixable at all.** Five of the six push sites have no
user watching, so there is no synchronous channel to report into. Marking the CREDENTIAL dead is a
single write that reaches the user later, on a page they will visit, and it covers all five at once.

## TASKS

- [x] 1. **DONE `c5a61dd`. The client tells the truth about why it failed.** Return a discriminated failure
      carrying the class above and the HTTP status. Fix the missing else at `client.ts:166-180` so a
      failed search cannot silently become a duplicate create. Log the status, which is currently
      never logged. Tests from scratch; there is no test file for this module.
- [x] 2. **DONE `c5a61dd`. The manual button stops reporting success on a failure.** Route: stop returning
      `{success:false}` at 200, and stop hardcoding `success:true` on the bulk branch. Button: read
      the outcome rather than `response.ok`, and show `failed` on bulk. Covers both B and B.2.
- [x] 3. **DONE `d53eaa2`. "Connected" means the credential worked.** Save validates before it stores. Save stops
      clearing a failed test result (`page.tsx:142`). The badge reads a validated state. Depends on
      decision 2 and on confirming the GHL scope names live (C.3).
- [x] 4. **DONE `d53eaa2` + `fcae3fc`. The five automatic paths mark the credential dead on a credential-class failure.**
      DEPENDS ON DECISION 1. Needs a migration. The five sites are `trace/status/route.ts:285`,
      `trace/bulk/status/route.ts:599`, `v1/trace/status/route.ts:257`,
      `v1/trace/bulk/status/route.ts:395`, `cron/sweep-stale-traces/route.ts:192`.

## TEST POSITION, stated because it changes the work

**There is zero coverage of any of this.** No test file for `lib/highlevel/client.ts`, for any of
the four `/api/integrations/highlevel/*` routes, or for `PushToCrmButton`. The five test files that
mention HighLevel all do the identical thing: `vi.mock` the module away AND set
`highlevel_api_key: null`, so the push branch is never entered and there are no assertions on the
mock at all. Every test here is new, none is a modification. Per L-015 the mutation run is the
only thing that will prove any of them are worth having.

## RECORDED, NOT FIXED. Named so they are not rediscovered as bugs.

- **R1. FIXED (copy only, per David) `d53eaa2`. The two newest crons never push at all, and the page said they do.** The claim was in THREE places, not the one the plan named: `settings/api-keys/docs/page.tsx` carried it twice more, once in a tip explicitly about Full Property Trace. The crons still do not push; that capability decision is untouched and still open.
- **R1-ORIGINAL, kept for the diagnosis.**
  `sweep-business-traces` and `sweep-property-traces` finalize traces and dispatch the user webhook
  but never read the HighLevel columns. `settings/integrations/page.tsx:389` promises "Successful
  traces will automatically create or update contacts in your HighLevel CRM." **So Full Property
  Trace results never reach the CRM by the direct push.** This is a false claim rather than a silent
  failure, and it is DECISION 3.
- **R2. An entity pushes a garbage contact that SUCCEEDS.** `client.ts:155-157` splits `owner_name`
  on whitespace and takes `[0]` as the first name, so `Colmaven, Llc` becomes firstName `Colmaven,`.
  HighLevel accepts it. A successful push of wrong data, invisible to everyone.
- **R3. Nothing is persisted about a push.** No `highlevel_contact_id` column anywhere. `contactId`
  is returned by the client and dropped by all seven callers, so "did this trace reach the CRM" is
  unanswerable after the fact.
- **R4. A failed push still leaves a billed, successful trace.** On all five automatic paths the
  row is set `is_successful: true` and the wallet is charged BEFORE the push fires (e.g.
  `trace/status/route.ts:245-252` precedes `:285`). The user is billed, sees a successful trace, and
  has nothing in the CRM. Correct under the billing model, since the trace did succeed, but it is
  the reason the silent push failure is expensive rather than cosmetic.
- **R5. RESOLVED AND FIXED, `a7962b6`. It was real and it was destructive.** HighLevel's Update
  Contact doc states verbatim: "This field will overwrite all current tags associated with the
  contact." So every update push deleted every other tag on that contact, and in HighLevel tags
  drive workflows, so it broke the customer's automation too. Tags now sent on CREATE only. The
  additive `POST /contacts/:contactId/tags` is deliberately NOT adopted yet: its additivity is
  implied by its name and response shape rather than documented, and swapping verified destruction
  for unverified behaviour is not a fix. Verify against a real account, then switch.
- **R5-OLD, superseded, kept so the original wording is not restored.** `client.ts:191` sends `tags: ['proptracerpro']` in the PUT
  body. Whether GHL v2 MERGES or REPLACES the tag array decides whether pushing over an existing
  contact silently wipes the customer's own tags. This is GHL API semantics, not a repo fact, and
  it is not safe to assume either way.
- **R6. Only the first phone and first email are ever sent** (`client.ts:159-160`). Every other
  contact on the trace is dropped without a word.
- **R7. `createHighLevelContact` (`client.ts:88`) has zero callers.** Dead code, and it reads the
  env-var credentials rather than the user's.
- **R8. The bulk push loops are unbounded and uncapped.** `push/route.ts:110` is sequential with no
  `maxDuration` on the route, so a large job can be cut off mid-loop with the already-counted
  `pushed` value lost.

---

# PLAN: Full Property Trace reaches the CRM (2026-09-18).
# ** LARGELY REVERSED 2026-09-19. READ THIS FIRST. **
#
# Tasks 1 and 2 below were BUILT AND THEN REMOVED. PTP must not push to the CRM on its own: the
# Suite Gateway holds the snapshot and the object model (an entity is a COMPANY, a person is a
# CONTACT only with a phone or email, the property hangs on the property object), and PTP's push
# only ever creates Contacts. All EIGHT automatic push sites are now gone.
#
# WHAT SURVIVED and was worth doing: task 3 (the manual job button now finds tier 2 rows via
# trace_job_id), the push-record columns, the guard analysis, and the billed-miss shapes below.
# The REAL work is in the suite-gateway repo. See the handoff's "PTP DOES NOT PUSH TO THE CRM ON
# ITS OWN" block and lessons L-019.

Baselines: **1456 passing / 75 files / 0 failing**, `tsc` 0, eslint 47, build compiles.
`main` = `c24ffa5`, pushed, deploy READY.

## THE GAP, RESTATED CORRECTLY. My earlier statement of it was wrong three ways.

I told David "Full Property Trace results never reach the CRM by this integration", attributing it
to `sweep-business-traces` and `sweep-property-traces` not reading the credential columns. Corrected
against source:

- **`sweep-business-traces` is TIER 1**, a FastAppend recovery path. Naming it was a misattribution.
- **"Never" is false.** v1 BULK pushes tier 2 today (`app/api/v1/trace/bulk/status/route.ts:398-404`
  reads every ROW of the job, not Tracerfy's batch array). The manual button also works for a tier 2
  SINGLE.
- **My follow-up guess was also wrong.** I said the one production tier 2 row settled via
  `trace/status` and so pushed. It did not: `app/api/trace/single/route.ts:513-536` settles tier 2
  INLINE and `trace/status` returns early on a terminal status (`:68-69`), so it never sees it.

**The real gap is WIDER than the original claim, which is why it still matters.** Automatic push
fires for tier 2 on exactly ONE of five surfaces.

| Surface | Tier 2 settles at | Pushes today |
|---|---|---|
| Single, session | inline, `trace/single/route.ts:513-536` | **NO** |
| Single, v1 | inline, `v1/trace/single/route.ts:438-461` | **NO** |
| Bulk, session | `sweep-property-traces`, finalized by `trace/bulk/status` | **NO** |
| Bulk, v1 | same cron, finalized by `v1/trace/bulk/status` | **YES** |
| Bulk, MCP | same cron, finalized by `mcp-tools.ts:737-743` | **NO**, by design |

## THE ROOT CAUSE, and it is one sentence

**Push is attached to JOB-settlement code that reads Tracerfy's batch array, not to ROW settlement.**
A tier 2 row never has a `tracerfy_job_id` (nulled at `sweep-property-traces:563` and
`trace/single:530`), so every push list built from that array cannot see it. v1 bulk is the one
surface that iterates ROWS instead, which is exactly why it is the one that works.

## WHAT IS NOT THE PROBLEM, verified so nobody re-opens it

- **The shape is fine.** `lib/trace/fullPropertyTrace.ts:103-105` deliberately writes `trace_result`
  in the same shape tier 1 uses, precisely so the export, the results card and the HighLevel push all
  keep working. A push added here sends real contacts, not empty ones.
- **The billed-miss shapes are already excluded correctly.** `no_match` has a null `trace_result`;
  `property_trace_no_reach` has a non-null one with EMPTY phones and emails but `is_successful:false`.
  The existing `isSuccessful && result` guard excludes both. **A guard written as `trace_result != null`
  alone would leak a nameless, contactless row into a customer's CRM**, so keep the `is_successful` half.
- **The 86-field property record half is already built.** `lib/suite/mcp-tools.ts:617-624` emits
  `property_record` and `tier` for the gateway, which writes to `custom_objects.property`. That is a
  different job from a CONTACT reaching HighLevel and it is not this plan.

## TASKS

- [~] 1. **BUILT, THEN REMOVED 2026-09-19.** Push where the row SETTLES. Reversed: PTP does not push automatically at all. One shared helper, called from
      the three row-settlement points: `sweep-property-traces` (which covers session bulk, v1 bulk AND
      MCP bulk, since all three enqueue into the same column), plus the two inline single routes.
      Reuse `recordHighLevelPushes` so every new push also feeds credential health.
- [~] 2. **MOOT, removed with task 1.** Stop v1 bulk double-pushing. Nothing pushes automatically, so there is no double push. Once the cron owns tier 2, `v1/trace/bulk/status:398-404`
      must skip rows the cron already pushed. Filter on the row having gone through the tier 2 queue,
      not on `tier`, because that is the property that actually decides ownership. NOTE: a double push
      is an UPDATE not a duplicate (the client searches first), and post-tags-fix an update is nearly
      idempotent, so this is correctness and waste, not damage.
- [x] 3. **DONE `09371fe`. The manual JOB button silently excluded every tier 2 row.**
      `integrations/highlevel/push/route.ts:160-166` filters `.eq('tracerfy_job_id', job.tracerfy_job_id)`
      and a tier 2 row has none. A mixed job pushes only its tier 1 half with no mention; an all-tier-2
      job reports "No successful results to push". Select the job's rows by `trace_job_id`.
- [x] 4. **CLOSED BY TASK 1, verified by grep, no code added (adding a push there would double-push).** `sweep-stale-traces` can finalize an all-tier-2 job with NO push, permanently.
      `:278-291` writes `status:'completed'` once the property queue drains, and
      `trace/bulk/status:153` then early-returns forever, so no later poll can ever push it.

## OPEN FOR DAVID, both real

- **The Pro gate excludes the customer paying the MOST.** `push/route.ts:84-89` gates the manual push
  on `effectiveIsPro`, so a pay-as-you-go customer, who pays **$0.40** for tier 2 against Pro's $0.25,
  cannot use it at all. Policy, not a bug.
- **Nothing records that a push happened** (R3). Without it "did this trace reach the CRM" stays
  unanswerable, task 2 cannot be verified, and a retry is impossible. A column would fix all three.

## STALE COMMENT FOUND

`sweep-property-traces/route.ts:59-61` still says "NOTHING ENQUEUES INTO THIS COLUMN YET". All three
bulk submit surfaces enqueue (`trace/bulk:385`, `v1/trace/bulk:316`, `mcp-tools.ts:421-424`).
