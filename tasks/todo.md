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

### H. Deliberately NOT done
- [ ] `supabase/schema.sql:134` `unit_price DECIMAL(10,4) DEFAULT 0.07` is baked into the LIVE
      database. Write the migration, do NOT apply it. Applying before push makes prod data
      inconsistent with prod code.
- [ ] History.md, tasks/*, docs/superpowers/specs/, docs/superpowers/plans/ are historical
      records. Do not rewrite prices in them.
- [ ] goacquisitionpro.com and the Stripe dashboard hold copy outside this repo. Separate pass.
