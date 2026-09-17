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
