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

### CANONICAL TABLE. David settled this on 2026-09-16 after three restatements.

**TWO axes: tier and plan. FOUR numbers. If your table has more or fewer cells than four, it is
wrong.**

| Tier | When | Model | Pro + AcquisitionPRO | Pay-as-you-go |
|---|---|---|---|---|
| 1 | Owner of record is **known** | per **successful trace** | **$0.15** | **$0.25** |
| 2 | Owner **not** known, OR the caller wants the enriched dossier | per **record** | **$0.25** | **$0.40** |

**Owner type does NOT affect price. It selects the vendor.** An individual routes to Tracerfy, an
entity routes to FastAppend, and both bill the same tier 1 rate for that plan. There is no
entity price, no entity surcharge and no entity discount anywhere in the model.

**Tier 2 does not split by owner type either.** Once the owner is unknown, or the caller wants the
dossier, the price is the same for an individual and an entity.

**The trap that cost three restatements:** the vendor split (Tracerfy vs FastAppend) and the
vendor COSTS ($0.10 entity contacts, $0.10 individual contacts, $0.20 dossier) are real and are
documented above in WHAT WORKS. They are cost-side only. Do not let them leak into the price
table. `CHARGE_PER_FASTAPPEND_SUCCESS` existed because the old model priced the FastAppend path
separately; under this model that is retired and an entity trace bills the plan's tier 1 rate.

**Tier 2 blended cost is about $0.25 per record**, which is why the Pro tier-2 rate of $0.25 runs
at cost. **That is intentional**; David covers it from membership revenue outside PTP. Do not
raise it and do not flag it again.

**Costs, for margin checks:** FastAppend entity contacts $0.10/hit. Tracerfy individual contacts
$0.10/hit. Dossier $0.20/hit. Tier 2 blended cost is about $0.25 per parcel analyzed, which is why
the Pro tier-2 rate of $0.25 runs at cost. **That is intentional**; David covers it from membership
revenue outside PTP. Do not raise it and do not flag it again.

### The superseded version, kept only so nobody restores it

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

## THE DOSSIER RETURNS 86 FIELDS. WE USE THREE.

### MEASURED FIELD INVENTORY. Re-derived 2026-09-16 by counting keys in the 24 unique saved raw responses.

This is the empirical answer to "is 60+ fields a defensible claim". **It is.**

| | Count |
|---|---|
| Keys returned on `response.property` | **86** |
| Forbidden to display (AVM, equity, `corporate_owned`, `price_per_sqft`) | 7 |
| Propensity and renovation scores (built on the equity math) | 15 |
| Never once populated across all 24 | 18 |
| **Fields with at least one usable value** | **46** |

Plus `owners`, `mailing_address`, `contacts` and `meta` as sibling objects on the same response.

**So "60+ fields" is accurate for what is RETURNED and is conservative against 86.** It is NOT
accurate as a claim about what is reliably populated. David's framing is the correct one: the
fields are there, and which ones are useful depends on the market, the county and the state.
Copy should state the count and then band by reliability. Never promise a field flat.

**Usable-rate bands, measured, not assumed:**

- **100%** (16): `address`, `city`, `state`, `zip_code`, `county`, `latitude`, `longitude`, `apn`,
  `property_type`, `property_use`, `land_use`, `lot_size_sqft`, `assessed_value`,
  `absentee_owner`, `area_median_income`, `investor_buyer`
- **75-99%** (5): `building_size_sqft` 91, `last_sale_date` 82, `years_owned` 82,
  `document_type` 82, `recording_date` 82
- **50-74%** (6): `year_built`, `open_mortgage_balance`, `lender_name`,
  `estimated_mortgage_payment`, `flood_zone`, `stories`
- **25-49%** (6): `units_count`, `prior_sale_date`, `total_properties_owned`,
  `total_portfolio_value`, `last_sale_price`, `cash_buyer`
- **1-24%** (10): MLS fields, `beds`, `has_ac`, `has_garage`, `roof_construction`,
  `prior_sale_price`, `quit_claim`

**Fields nobody had documented that matter for CRE:** `years_owned` (82%, hold-period signal),
`total_properties_owned` and `total_portfolio_value` (36%, portfolio-scale signal),
`flood_zone` (64%), `area_median_income` (100%), `investor_buyer` (100%).

**Note on the band numbers:** these are computed over the 24 unique records and differ slightly
from the per-field rates below, which were measured over a 23-hit subset. Where they disagree,
prefer these, because they are reproducible from the saved files.

---

### DECIDED 2026-09-16: STORE PER-USER IN PTP. NEVER PROPAGATE TO THE PROPERTY-REGISTRY.

David: *"PTP has a supabase database, so I see the new fields being added and saved for the user.
What I don't want it to do is update the property-registry from the results."*

So the original line below is correct and stands. **The boundary is not storage, it is direction:**

- **ALLOWED:** dossier fields persisted in PTP's own Supabase (`rmmwkjmjchpfebxroyoo`), scoped to
  the user who paid for them. They bought it, it is theirs, it shows up in their account.
- **FORBIDDEN:** any write from PTP results into the shared **property-registry**. Not a backfill,
  not an enrichment job, not "while we're here". Purchased per-user data must not become a shared
  asset.

**Why, so nobody helpfully reverses it later.** Two reasons and both matter. It is the paying
user's data, not PTP's inventory to resell. And the registry's whole value is that it is
county-sourced with provenance; injecting vendor dossier fields would break that claim silently,
and a registry row whose origin is "a customer's Tracerfy purchase" cannot be told apart from a
county-sourced one after the fact.

**Verified 2026-09-16: no such path exists today.** PTP constructs exactly one Supabase client
(`lib/supabase/admin.ts`), pointed at its own project. The only `property-registry` mentions in the
codebase are prose comments in `lib/utils/address-normalizer.ts:75` and `lib/suite/mcp-tools.ts:85`
explaining why ZIP became optional. The `SUITE_GATEWAY_*` env vars are for reading entitlements,
not for writing parcels. **If this ever gets built it will be built in the gateway or in a
registry-side job, not here, so the guard has to live there too.**

### OPEN ITEM 8 IS CLOSED. Read 2026-09-17 from the actual terms, not inferred.

Source: `https://tracerfy.com/privacy-policy`, sections 4.7 and 4.8. **Storing results per-user is
permitted. Do not raise it again.**

- **4.7, ownership:** *"You retain all ownership rights to data you upload to Tracerfy. We claim no
  ownership or intellectual property rights over your uploaded data."*
- **4.8, the actual restriction:** *"Service results may not be resold or redistributed as a
  standalone data feed, database, directory, or sublicensed product."* Permitted uses are
  *"lawful skip-tracing, contact-enrichment, direct mail, real estate, debt collection,
  business-to-business enrichment, and related internal business workflows only."*

PTP storing a user's purchased record for that user's own workflow is contact-enrichment and an
internal business workflow. Explicitly allowed. **What 4.8 prohibits is exactly what David ruled
out on his own: turning results into a standalone database.** That is the property-registry
propagation banned above. The instinct and the contract agree.

### THE REAL EXPOSURE, and it is not storage: FCRA PERMISSIBLE USE IS NOT PASSED THROUGH.

**4.8 also states:** *"Service results may not be used for employment, tenant screening, credit,
insurance, eligibility, adverse-action, harassment, stalking, or any FCRA-regulated purpose."*

Tracerfy binds PTP to that. **PTP does not bind its own users to it.** Verified 2026-09-17: no FCRA
language, no permissible-use notice, and no acceptable-use or terms route anywhere in `app/`,
`components/`, `lib/` or `docs/`. Zero matches.

PTP resells access to this data to real-estate customers, and **tenant screening is a thing a
landlord will plausibly try**, so the prohibited use sits directly adjacent to the customer base.
The obligation does not stop at PTP; it has to reach the end user running the search.

**Not a blocker for tier 2 and not a technical fix.** It is a terms-and-surface question: whether
the restriction appears at signup, in the API docs, in the MCP caveat, or on a terms page that does
not currently exist.

### DECIDED 2026-09-17: THE CHARGE FOLLOWS THE VENDOR CALL, NOT THE CALENDAR.

David: *"If a rerun pulls from Tracerfy and not the database, they get charged."*

**The rule is mechanical, which is why it cannot drift:** if serving the request spends money at
Tracerfy, the user is charged. If it is served from the user's own stored record, it is free.
There is no separate cache policy to keep in sync with billing, because the two are the same
condition.

Consequences, all of which fall out rather than needing decisions:

- **The 90-day promise at `LandingPage.tsx:378` HOLDS for tier 2**, provided the record was stored.
  No copy change needed.
- **The cache is PER-USER, and that is required, not incidental.** `trace_history` is already keyed
  `UNIQUE(user_id, address_hash)`, so this needs no schema change. Two different users tracing the
  same parcel BOTH pay, because serving user B from user A's purchase would be redistributing one
  customer's data to another. That is the same boundary that bans registry propagation, and it is
  the thing 4.8 prohibits. **Do not "optimise" this into a shared cache. It is the product rule.**
- **"Clear cache and re-run" correctly charges**, because it forces a fresh vendor call by
  definition. The existing button at `trace/single/page.tsx` already warns about a charge.
- A record whose dossier was never captured is a cache MISS and re-buys, which is correct.

### DECIDED 2026-09-17: AI SEARCH IS REMOVED. Tier 2 ships as a NAMED FEATURE.

David: *"We no longer need AISearch, so remove it. Add in Property Enrichment, unless you can think
of a better name."*

This **reverses** the earlier "replace in place" decision, which was my recommendation and was
wrong. I recommended it before reading what `AIResearchResult` actually was: a stored-and-returned
contract across two public routes, two webhook payloads, the CSV export, the MCP surface and the
results card, with no room for an 86-field property record. David accepted the recommendation on
my say-so. Removal is the cleaner answer and it is now the plan.

**FOR THE MARKETING PAGES, WHENEVER THEY ARE NEXT TOUCHED:** this feature needs a **full dedicated
section**, not a bullet. It is the entire justification for the tier 2 price and the landing page
currently says nothing about it. See the tier 2 value copy already written into
`LandingPage.tsx:370` as a starting point, and the measured field inventory above for what may
honestly be claimed. Do not promise the distress flags; nine of eleven are true zero times.

### THE NAME IS "FULL PROPERTY TRACE". Decided by David 2026-09-17. Use it everywhere.

Nothing customer-facing says "AI Search" or "AI research" after this ships: UI, API docs, MCP tool
descriptions, pricing page, user notification.

**Removal is a HARD REMOVE, no deprecation window.** David's reasoning, worth keeping because it
is the one-line pitch for the feature: *"It was only used if there was no owner, so an owner could
be traced. Tier 2 fixes that with better results and returns more fields."*

Measured against the live DB 2026-09-17 before deciding: AI Search carried **1,301** rows across
**11 users**, found an owner **68%** of the time, charged 743 times for **$111.45**, last used
2026-09-14. **Nothing was in flight**, so the removal strands no work. `api_logs` holds 0 rows
despite a writer at `lib/api/auth.ts:108`, so there is no usage visibility on the public v1 API at
all. Full Property Trace hits 23 of 24 by comparison, so those 11 users get a materially better
product at a higher price. **Say that in the notification rather than announcing an increase.**

The reasoning behind the name, recorded so it is not re-argued:

- PTP's entire vocabulary is *trace*. The product is PropTracer, the verb is trace, the unit is a
  trace. "Enrichment" introduces a second noun users must learn and map onto the first.
- "Property Enrichment" implies you already HAVE the property and are improving it. That fits the
  opt-in case and misses the primary one, which is *I do not know who owns this*. Per the pricing
  table the dominant trigger is an ABSENT owner, so the name should not presume you have anything.
- "Full" contrasts cleanly with the basic trace and maps to the tier 1 / tier 2 split without
  exposing the word "tier" to customers.

Either name is workable. **The decision is David's; this is a recommendation only.** Whatever is
chosen must be used consistently in the UI, the API docs, the MCP tool descriptions, the pricing
page and the user notification, all of which currently say "AI Search" or "AI research".

### RATE LIMIT CORRECTION, same source, read 2026-09-17.

The handoff's **500/min for the dossier is CORRECT**, but incomplete in a way that matters for
tier 2 bulk design. Verbatim from `https://www.tracerfy.com/skip-tracing-api-documentation/`:

> *"Instant Trace, Enhanced Trace, Phone Verification, APN Instant Lookup & Property Lookup — 500
> lookups per minute (shared counter)"*

**It is a SHARED counter.** `property-search/lookup/` (the dossier) and the instant person trace
draw from the same 500/min pool. A tier 2 bulk run does a dossier call AND then a contact call per
parcel, so a 150-parcel run consumes roughly 300 of that shared budget, not 150. Size the loop
against the shared pool.

Also note the batch endpoints are far tighter and are a different limit entirely:
*"Batch Trace & APN Batch Trace — 10 submissions per 5 minutes"*. A generic abuse-policy line on
the same page ("Maximum rate limit is 10 POST trace requests per 5-minute window") refers to those
batch submissions, NOT to the instant endpoints. Do not read it as a 2/min global cap.

---

Worth capturing per-user (the user bought it, for their own use — this is NOT a shared registry).
Fill rates below treat **0 as absent**, measured over 23 hits.

**Trustworthy** — county-sourced facts and observations:
`lot_size_sqft` 100%, `assessed_value` 100% (label it assessed, never market), `latitude`/
`longitude` 100%, `property_type`/`property_use`/`land_use` 100%, `building_size_sqft` **91%**,
`year_built` 78%, `stories` 70%, `units_count` 43%, normalized `apn` 100%.

> **CORRECTION, 2026-09-16, re-derived from the 24 saved raw responses in `tasks/research-test/`.**
> An earlier version of this line said "every status flag at 100%". **That was a PRESENCE count and
> it is misleading.** The flag keys are present on 24 of 24 records. What they actually contain:
>
> | Flag | Present | Actually TRUE | |
> |---|---|---|---|
> | `absentee_owner` | 24/24 | **21 (88%)** | genuinely useful, the one worth surfacing |
> | `owner_occupied` | 24/24 | 1 (4%) | |
> | `vacant`, `tax_delinquent`, `tax_lien`, `pre_foreclosure`, `foreclosure`, `inherited`, `death`, `judgment`, `hoa` | 24/24 | **0 (0%)** | never fired once |
>
> Nine of the eleven flags have **never been true on a commercial parcel in this sample.** Whether
> that is because commercial property genuinely is not distressed, or because the vendor does not
> populate distress flags for commercial, is UNKNOWN and 24 records cannot settle it.
>
> **Do not advertise the distress flags as a reason to buy.** `absentee_owner` is the only one
> with evidence behind it. This is the exact presence-versus-usable error this document's own
> closing warning names, committed inside this document.

**Transaction and debt layer** (bank debt — Maturr covers CMBS/HUD/Ginnie, not this):
`last_sale_price` **52%** (Ohio-only in our sample), `last_sale_date` / `recording_date` /
`document_type` ~91% of those, `open_mortgage_balance` 70%, `estimated_mortgage_payment` 70%,
`lender_name` 74%.

### CAPTURE EVERYTHING. GATE DISPLAY, NOT STORAGE. Revised 2026-09-16 on David's challenge.

An earlier version of this section said "do NOT store or display" for three groups at once. David
pushed back: a field that is empty in 24 parcels across OH, CA and UT may be populated in other
counties, and blocking storage on a 24-parcel sample is the L-001 mistake. He is right. **Nothing
is blocked from STORAGE.** The rules below govern DISPLAY only, and each one names its reason,
because the reasons are not the same and they do not age the same way.

**Group A, 7 fields. Do not DISPLAY. Reason: provably wrong, not missing.**
`estimated_value` (100% populated, but it equals `assessed_value` on 23 of 23; there is no AVM),
and everything derived from it: `estimated_equity` (46%), `equity_percent` (46%), `high_equity`
(33%), `free_clear` (33%). Plus `corporate_owned` (92% populated but returned FALSE for
`STORAGE TRUST PROPERTIES, L.P.`) and `price_per_sqft` (sale ÷ sqft, 0 with no sale).
**More counties will not fix these.** The defect is in the vendor's math, not in county coverage.
Store them; if the vendor ever ships a real AVM the history is there.

**Group B, 15 propensity fields. The blanket ban was TOO BROAD. Two separate problems:**

1. *Equity contamination, varies by model.* The `_factors` arrays name every input with points.
   `refi_propensity` is almost entirely equity math: `thin_equity` -15 (fires 14/24),
   `high_equity` +15, `free_clear` +6, `ltv_sweet_spot`. That one is genuinely unusable.
   `sell_propensity` is MIXED: only `low_equity_distress` +10 and `free_clear` +4 are tainted,
   while `absentee_owner` +8 (21/24), `investor_buyer` +5 (21/24), `portfolio_size` up to +5,
   `years_owned` up to +12, `quit_claim_deed` +4, `mls_cancelled` +15 and `aging_property` are
   real, independently checkable signals.
2. *They are RESIDENTIAL models run on commercial buildings.* Verbatim from the factors:
   `"41,588 sqft — large home, higher HVAC cost and complexity"` on the building the handoff
   elsewhere records as carrying $175,000,000 of blanket debt. Also `"79,684 sqft — large home"`,
   `"Home built in 1904 (122 years old)"`, and `home_value` scoring off `estimated_value`.
   The roof, HVAC and solar models are homeowner models. They are not wrong about equity so much
   as inapplicable to the asset class.

   **`sell_propensity` also consumes `corporate_owned` (+3, fires 22/24), a field this document
   already flags as unreliable.** And `low_equity_distress` fires on 14 of 24 at +10 points, off
   an equity number computed from assessed value, where assessed/sale ran 0.07 to 0.59 in Ohio
   alone. So the sell score is being inflated on more than half the sample by a signal that is
   wrong by construction.

   **Do not display the scores. DO mine the `_factors` arrays**, which surface `years_owned`,
   `portfolio_size`, `flood_zone`, `absentee_owner` and `quit_claim` as raw signals. Surface those
   from the underlying fields directly, where they are checkable.

**Group C, 18 fields never populated in this sample. NOT BLOCKED. Coverage, not correctness.**
`tax_delinquent`, `tax_delinquent_year`, `tax_lien`, `foreclosure`, `pre_foreclosure`, `inherited`,
`death`, `judgment`, `vacant`, `hoa`, `adjustable_rate`, `subdivision`, `mls_active`,
`mls_pending`, `mls_sold`, `baths`, `has_pool`, `has_deck`.

These are absent in 24 parcels across three states. **That is a statement about OH, CA and UT, not
about the field.** Several are exactly the distress signals a CRE prospector wants, and county
recorders differ enormously in what they publish. Capture all of them, display them when present,
and do not ADVERTISE them until a wider sample shows a rate. The only honest current statement is
"not observed in the 24 parcels measured."

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
