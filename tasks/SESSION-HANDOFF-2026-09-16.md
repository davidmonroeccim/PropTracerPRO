# SESSION HANDOFF, 2026-09-16

**READ THIS BEFORE TOUCHING OWNER LOOKUP, SKIP TRACE ROUTING, OR PRICING.**
Supersedes `SESSION-HANDOFF-2026-09-15.md` for everything about owner discovery.
That file is still correct on vendor mechanics and its eight defects; this one
overrules its assumption that the AI research step is the path to an owner.

---

## THE ONE THING TO NOT REDO

**The AI research step cannot identify a commercial property owner. This is settled,
measured, and expensive to re-learn.**

- Brave search returned **0 owners across 13 parcels**, twice, with two different query designs.
- It is not a prompt problem or a query problem. **County parcel records are not in any web
  index.** Probed directly: `site:esearch.mobilecopropertytax.com` returns the landing page, the
  cart page and the terms page, and **zero parcel records**. `qpublic.net` and
  `beacon.schneidercorp.com` return only state and county entry pages. Parcel data sits behind
  session state and form POSTs, so no crawler has it.
- The calibration parcel proves it independently: 203 Dauphin St, Mobile AL, whose owner is in a
  free public assessor record we retrieved by hand, returned **nothing** through search.

Do not build another query ladder. Do not add sources. The document is not in the index.

**The working path uses no search step at all.**

---

## WHAT WORKS, WITH MEASURED RATES

Rates reconciled against the Tracerfy and FastAppend **account ledgers**, not documentation.
Hit rates from 24 commercial parcels across OH, CA and UT.

| Step | Endpoint | Cost/hit | Measured |
|---|---|---|---|
| Owner name | `POST tracerfy.com/v1/api/property-search/lookup/` | **$0.20** (10 cr) | **23 of 24** |
| Entity vs individual | regex on the owner name string | **free** | 23 of 23 correct |
| Entity contacts | `POST app.fastappend.com/v1/api/business-trace/lookup/` | **$0.10** (1 cr) | **13 of 22** |
| Individual contacts | `POST tracerfy.com/v1/api/trace/lookup/` `find_owner:false` + name | **$0.10** (5 cr) | 1 of 1 |

**Misses are free on every one of these.** That is why a fallback costs nothing unless it works.

**Commercial means entity: 22 entities, 1 individual, 1 no-owner out of 24 parcels.**

### The dossier has two keys and they fail independently

`property-search/lookup/` takes **either** `apn` + `county` + `state` **or**
`address` + `city` + `state` (+ optional `zip_code`). Mutually exclusive; sending both is a 400.

- Salt Lake `16183060290000` **missed on APN, hit on address**, returning `Colmaven, Llc` — exactly
  what the county recorder shows.
- Napa `003330004000` did the reverse: **hit on APN, missed on address.**

So a prospect with **only street addresses and no parcel ids is a supported case.** `planRoute`
emits both keys when both exist; the caller stops at the first hit.

Address mode also **backfills zip**, which matters because no Utah county publishes one.

---

## WHAT DOES NOT WORK, AND WHY

**`trace/parcel/lookup/` (the 5-credit APN people lookup) is the wrong endpoint for this.**
13 parcels, 11 billed, **0 owner names**. The response shape has no owner field at all. It returns
2 to 5 people, every one flagged `property_owner: false`. It found the business *operator* at the
address, correctly said they are not the owner, and billed $0.10 each time. $1.10 spent, nothing
gained. Note the handoff of 2026-09-15 reports 7 of 12 CA parcels returning a flagged owner from
this endpoint — those were **individually owned**. An entity is not a person and cannot appear in
a consumer-data product.

---

## GOTCHAS THAT WILL BITE. EACH ONE COST REAL MONEY TO FIND.

1. **`corporate_owned` is unreliable.** It returned `false` for `STORAGE TRUST PROPERTIES, L.P.`,
   a Delaware limited partnership (Public Storage). **Classify from the owner name string.**
   `classifyOwnerName()` got it right; the vendor's boolean did not.

2. **`estimated_value === assessed_value` on 23 of 23 parcels, in all three states. There is no
   AVM.** Sale prices in the same records: a parcel with `estimated_value` $203,740 sold for
   $675,000; another at $1,076,990 sold for $7,525,000. Assessed/sale ran **0.07 to 0.59 within
   Ohio alone**, so assessed cannot be scaled to market by any constant.
   **Therefore `estimated_equity`, `equity_percent`, `high_equity` and `free_clear` are unusable.**
   `high_equity: true` occurs exactly when `open_mortgage_balance` is 0 — it means "no mortgage on
   record", not high equity. Never show `estimated_value` as a market value.

3. **`open_mortgage_balance` carries blanket and portfolio debt.** $175,000,000 against a 41,588
   sqft building; $48,000,000 against 46,909 sqft. Use `assessLoan()` in
   `lib/routing/ownerRoute.ts`, which uses **sale price** as the basis and never assessed value.

4. **`property_owner` returned FALSE for a verified owner of record** on an absentee-owned parcel
   — the owner does not live at his own rental. That flag guards fishing without a name. **Once
   you have the owner name, match on the name, not the flag.** Filtering on it discards correct
   answers.

5. **`find_owner: true` misses on absentee owners.** The named lookup (`find_owner: false` plus
   first and last name) hit on the same parcel. Use the named form whenever you have a name.

6. **County owner strings arrive degraded.** Stark County's auditor renders
   `CUTTING EDGE HODINGS LLC` — a typo, missing the L — and Tracerfy's dossier reproduces it
   character for character, which proves the dossier's owner data **is the county assessor roll**.
   Ohio SOS returns **zero** for that spelling. Butler's auditor drops the `, L.P.` suffix
   entirely. Any registry or vendor lookup keyed on the raw county string can fail on spelling.

7. **FastAppend keys on STATE OF REGISTRATION, not the property state.** Confirmed on the vendor's
   own product page: *"At minimum we need business name and state of registration."* The API
   reference never defines the field, which is why nobody caught it. PTP sends the **property**
   state. It worked **13 of 22 times**. NOTE: this was NOT the cause of the misses we tested —
   `STORAGE TRUST PROPERTIES` missed on OH, on DE, and on its full legal name plus DE. FastAppend
   simply does not have it.

8. **FastAppend coverage is per-entity random, not geographic.** An early 0-of-4 in Ohio looked
   structural and was a four-parcel sample. A 12-parcel, 4-county Ohio retest returned **8 of 12**,
   with the smallest county going 3 for 3 and both large counties 2 for 3. Combined Ohio is 8 of 16.

9. **`role` and `is_registered_agent` are documented response fields and PTP reads neither.**
   They return `MEMBER`, `MANAGER`, `GENERAL PARTNER`, `REGISTERED AGENT`, and combinations.
   A registered agent is a service of process, **not necessarily a principal.** This is the cause
   of defect 3 in the previous handoff (204 of 496 hits mapping one person to 2+ entities, one
   person to 42, five contacts literally named "Secretary of State"). Reading the flag is free.

10. **A synchronous FastAppend endpoint exists** (`business-trace/lookup/`, 1 credit, misses free,
    500/min). PTP calls the **bulk** endpoint and polls. That is the cause of defect 4.

11. **Bulk: the dossier has NO bulk endpoint.** Docs: *"one address in, one address out."* No
    array, no CSV. But the rate limit is **500/min**, so 150 parcels is a ~20 second loop.
    FastAppend `business-trace/lookup/` **does** take an array of up to 15. `/execute/` is a
    filter-based list builder (up to 25,000 rows), not a way to submit a list of specific APNs.

12. **Tracerfy bills the dossier as "Single-Address Lookup"** on the dashboard, even in APN mode.
    If you audit spend by line item it will not appear under anything resembling the endpoint name.

---

## PRICING, AS DECIDED

| Tier | When | Model | Price |
|---|---|---|---|
| 1 | Owner already in the registry | per **successful trace** | **$0.15** |
| 2 | Owner absent, OR the caller wants the enriched dossier | per **record** submitted | **$0.40** |

Per 100 tier-2 records: **$40 revenue** against ~$25 cost (96 dossier hits at $0.20, ~54 FastAppend
hits at $0.10, ~4 individuals at $0.10) = **about 37% margin**.

$0.25 was modelled first and came out at **exactly zero margin**, because the $0.20 dossier is
sunk on every hit regardless of whether the contact step later succeeds. Encoded in
`PRICE` in `lib/routing/ownerRoute.ts`.

**Structural note:** under per-record pricing a *better* FastAppend hit rate *reduces* margin,
because revenue is fixed and each hit costs $0.10. Success is a cost.

---

## THE DOSSIER RETURNS 84 FIELDS. WE USE THREE.

Worth capturing per-user (the user bought it, for their own use — this is NOT a shared registry).
Fill rates below treat **0 as absent**, measured over 23 hits.

**Trustworthy** — county-sourced facts and observations:
`lot_size_sqft` 100%, `assessed_value` 100% (label it assessed, never market), `latitude`/
`longitude` 100%, `property_type`/`property_use`/`land_use` 100%, `building_size_sqft` **91%**,
`year_built` 78%, `stories` 70%, `units_count` 43%, normalized `apn` 100%, plus every status flag
at 100%: `absentee_owner`, `owner_occupied`, `vacant`, `tax_delinquent`, `tax_lien`,
`pre_foreclosure`, `foreclosure`, `inherited`, `death`, `judgment`, `hoa`.

**Transaction and debt layer** (bank debt — Maturr covers CMBS/HUD/Ginnie, not this):
`last_sale_price` **52%** (Ohio-only in our sample), `last_sale_date` / `recording_date` /
`document_type` ~91% of those, `open_mortgage_balance` 70%, `estimated_mortgage_payment` 70%,
`lender_name` 74%.

**Do NOT store or display:** `estimated_value` (it is the assessed value), `estimated_equity`,
`equity_percent`, `high_equity`, `free_clear`, `corporate_owned`, and every propensity score
(they are built on the equity math). `price_per_sqft` is just sale ÷ sqft and is **0 whenever
there is no sale price**, so it is not an independent value source.

Always empty on commercial: `subdivision`, `tax_delinquent_year`. Residential-only fields
(`beds`, `baths`, `roof_material`) fill under 10%.

**Registry gaps this fills:** no Ohio county publishes `building_area`, `sqft_building` or
`assessed_value` — the registry refuses the filter outright. The dossier supplies both.

---

## STATE OF THE CODE

### Committed, NOT pushed
- Branch **`feat/owner-routing-tiers`**, commit **`40ea107`**, off `main`.
- `lib/routing/ownerRoute.ts` — `classifyOwnerName()`, `assessLoan()`, `planRoute()`. Pure
  decision logic, no I/O. **Nothing calls it yet.**
- `lib/routing/__tests__/ownerRoute.test.ts` — **63 tests, 5 mutations verified red**,
  `tsc --noEmit` clean, lint unchanged from baseline.
- Push is held deliberately: David needs to notify existing users first.

### Uncommitted, in a separate worktree
- **`/Users/davidmonroe/PTP-owner-extraction-fix`**, branch `fix/no-tenant-as-owner`,
  HEAD still `96178fe`, three modified files, **244 tests passing**, reviewed twice.
- It replaces the absolute "a business operating at an address is NEVER the owner" rule with an
  evidence-gated one. **That absolute rule was wrong** — owner-occupancy is real (the branch's own
  canonical test fixture, 203 Dauphin St Mobile AL, is a property where the restaurant operator
  owns the building, verified at the county). See `tasks/lessons.md` L-001.
- **Decide separately.** It guards the `researchProperty` path, which this session's findings say
  does not belong in the owner-lookup flow at all. It is safe where it sits.

### Also uncommitted
- `/Users/davidmonroe/PTP-advanced-owner-lookup`, branch `feat/tracerfy-advanced-owner-lookup`,
  commits `e9940fe` + `dc7c511`, 211 tests. Untouched this session.

---

## OPEN, IN PRIORITY ORDER

1. **UI and marketing pages** still advertise the old pricing and the search step.
   `components/landing/LandingPage.tsx` advertises $0.07/$0.11 in **nine** places. This is a hard
   merge blocker and it deploys with the app. **Next session's main task.**
2. **Notify existing users** of the pricing change before the push. David's task.
3. **Nothing is wired to a route.** `planRoute()` returns a plan; no caller executes it.
4. **Registration state is unresolved.** Every entity call sends the property state. Resolving it
   needs a Secretary of State step, which is browser-reachable and crawler-hostile — Ohio SOS
   returns 403 to `curl` and both registries sit behind Cloudflare.
5. **Dossier field capture is not built.** 84 fields bought per record, 3 used.
6. **Pre-flight balance check for bulk.** `parcels × 10 credits` against the Tracerfy balance
   before the first call, plus the user's PTP wallet. Without it a bulk run truncates mid-job, and
   previous-handoff defect 2 (a recorded charge on a failed wallet deduct) does damage there.
7. **`PRICING.COST_PER_RECORD` is $0.009** and contradicts the verified $0.02/credit. Written at
   14 sites, read at none. Left alone to keep the diff minimal.
8. **Tracerfy terms of service** on storing dossier fields per-user. Not a technical question.

---

## BALANCES AND SPEND

- Tracerfy: **10,744 credits** at $0.0200/credit (David topped up mid-session).
  This session used 340 credits = $6.80.
- FastAppend: **1,086 business credits** at $0.10/hit. This session used 13 = $1.30.
- Brave + Anthropic on the dead search path: **$0.22**.
- **Total session spend: $8.32.**

---

## WHERE THINGS LIVE

- **Research scripts:** `tasks/research-scripts/` — committed, with a README mapping each script
  to what it proved and what it cost. Preserved deliberately because the previous session's
  harness lived only in a session-scoped scratchpad and was lost.
- **Raw vendor responses:** `tasks/research-test/` — **gitignored**. Holds purchased skip-trace
  PII for 63 real individuals (DOBs, phones, emails). On disk for David's use, never in git.
- **Lessons:** `tasks/lessons.md` — L-001 through L-004. L-004 is about repeated scope drift and
  is worth reading before starting.
- **Review section:** bottom of `tasks/todo.md`.
- **Vendor docs, saved locally:** the Tracerfy markdown export and the FastAppend API docs HTML
  were fetched into the session scratchpad and will be lost. Re-fetch from
  `https://tracerfy.com/skip-tracing-api-documentation/download.md` and
  `https://app.fastappend.com/api-docs/` if needed.

---

## CHECK THE ARITHMETIC AGAINST THE ITEMS BEFORE RELAYING ANY COUNT.

This session produced three reporting errors that were caught only by re-deriving from raw data:
field fill rates computed from **presence instead of usable values** (reported 100% for fields
that were 52% and 43%), a **0-of-4 sample read as a structural conclusion** about Ohio, and a
**"the padding row doubles the bill"** claim that both vendor ledgers disproved. Verify before
asserting, and prefer the live ledger over any document, including this one.
