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

**Phase 3 — execute the plan.** B5, B6, then the caller that runs `planRoute()`: dossier, re-enter
with the discovered owner, route to the contact vendor. Charge immediately after the dossier
returns, in the same request, because the dossier call is synchronous.
**Visible:** Full Property Trace works end to end on one address via the API.

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
