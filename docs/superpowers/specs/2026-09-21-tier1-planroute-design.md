# Tier 1 through planRoute: design

Date: 2026-09-21. Status: approved in conversation, section by section, by David. Spans two repos:
PropTracerPRO (this repo) and suite-gateway.

## 1. Why

A Tier 1 record is one that arrives WITH an owner name. Today no Tier 1 path uses `planRoute()`.
Five surfaces each do their own thing:

- The gateway's `skip_trace_bulk` (lib/suite/mcp-tools.ts) sends people to the Tracerfy batch CSV and
  companies to the FastAppend queue. It stores `apn`/`county` on the row (:420-421) but never uses them
  for Tier 1.
- API bulk and web upload send people (web upload: companies too) to the batch CSV.
- Web single and API single send any owner, companies included, to `submitSingleTrace`, a padded
  two-row batch CSV.

Consequences, all verified in code on 2026-09-21:

1. A record with no city cannot be traced. `validateAddressInput` rejects a city under 2 characters
   (lib/utils/address-normalizer.ts:125-127), and on the MCP and API bulk paths one such record
   rejects the WHOLE batch (mcp-tools.ts:359-370, v1 bulk route :65-87). Proven by running
   `skipTraceBulk` on 100 records with one blank city: `invalid_records`, 0 writes, 0 vendor calls.
2. Both vendors can trace without a city. Tracerfy `POST /v1/api/trace/parcel/lookup/` takes
   `parcel_id`, `county`, `state` (docs/vendor/tracerfy-api.md:1324-1360), 5 credits per hit, 0 on a
   miss. FastAppend `POST /v1/api/business-trace/lookup/` takes `company_name` and `state`, 1
   FastAppend credit per hit, 0 on a miss.
3. `planRoute()` already has Tier 1 branches for exactly this (ownerRoute.ts:377-442), but nothing
   runs them for a supplied owner. The only Tier 1 use is pass 2 of a Tier 2 trace
   (executeRoute.ts:503).
4. Batch results are matched back to rows by city and state only, taking the first still-processing
   row (settleBulkJob.ts:335-345). Two records in the same city can have their contacts swapped.

David raised the Tier 1 price from $0.07 to $0.15 per successful trace to pay for the synchronous
lookups this design uses.

## 2. Decisions (David, 2026-09-21)

| # | Decision |
|---|---|
| D1 | Every Tier 1 record goes through `planRoute()` + `executeRoute()`. Bulk surfaces enqueue; a cron works the queue. Single traces run the same code inline. The Tracerfy batch CSV is retired for new work. (Chosen over a batch/instant hybrid, which was cheaper per hit but kept the city/state row matcher and two systems.) |
| D2 | Person order: the name-and-address lookup first when the record has a street and a city; the APN lookup when there is no city, or the address lookup missed. ("Option B".) |
| D3 | Trust and unreadable names: the two person steps on the name with the trust words removed, then FastAppend on the full name if both miss. ("Option C".) |
| D4 | Company: FastAppend on name and state, and the lane stops there. No Tracerfy follow-up (David's ruling in commit d462ab6). |
| D5 | Only the gateway sends an APN and county for now. APN/county input on the API and web app is deferred. |
| D6 | A person result counts only when a returned person matches the owner name. The `persons[0]` fallback is removed. |
| D7 | A vendor failure (5xx, timeout, 429, transport) is not retried automatically. The record ends `busy_try_again` and the user is told to try again in 5 minutes. Every vendor answer is logged on the record so a resend within 24 hours does not re-buy a step that already answered (5.2). |
| D8 | The customer is charged once per record, only for a name-matched result with at least one phone or email, at the Tier 1 rate. Everything else is free to the customer. |
| D9 | Duplicate key: unchanged when the record has a city; APN + county + state when it has no city but has both. |
| D10 | Every record reports an outcome code, a sentence, and (when found) which key found the owner. |
| D11 | The gateway NEVER sends PropTracerPRO an owner name from MPS. The owner comes from the registry only (Section 9). |
| D12 | The multifamily fallback (address and city, no owner, run as a Full Property Trace) stays behind the gateway's `trace_unknown_owners` opt-in. A registry parcel that names no owner gets the same fallback as one that is not found. |
| D13 | (Added 2026-09-21 afternoon.) The Tier 1 person lookup when the record has a city is Tracerfy's INSTANT lookup, `POST /v1/api/trace/lookup/` with `find_owner:false` and the owner's name, 5 credits per hit. Not Advanced (the batch `POST /v1/api/trace/` with `trace_type: 'advanced'`, 2 credits per lead, batch only, still requires a city) and not Normal (today's batch default). David: "1. Instant". The design session never offered Advanced; see lessons L-022. |
| D14 | Tracerfy never supplies an entity's contacts. David: "The original goal of the Dossier is to test for owner is invidual or entity. If individual, tracefy gets the results. If entity, the owner name is sent to fastappend for results, it does NOT stay in tracerfy. Tracerfy is NOT to give results for entities, ONLY id if is an entity." |
| D15 | When the dossier finds an INDIVIDUAL owner, the contacts come from a second Tracerfy lookup on that owner's name, name-matched (D6), not from the dossier's own contacts block (which carries no name, so the owner test cannot run on it). David: "2. Second lookup." |
| D16 | A trust or unreadable name that leaves no first name or initial once the trust words are removed goes to FastAppend as an entity; no person step runs on it. David: "If no first name or initial send to fastappend as an entity." |
| D17 | Multifamily records come from the registry, not MPS. When the registry names no owner, the property gets a dossier search (the Full Property Trace), even if MPS has an owner name, and the user is told it went that way. David: "The multifamily records are coming from the registry NOT MPS. So if MPS has an owner name and the registry does not, it needs a dossier search and the user needs to be notified of that." |
| D18 | Name order is fixed in Phase 1, in both the Tracerfy request and the name match, using the order each county's own data shows (a county that stores "SMITH JOHN T" stores its two-word names LAST FIRST too). Phase 0 measures the order per county. Today `splitPersonName` reads any two-word name as FIRST LAST (lib/routing/ownerRoute.ts:487-490). David: "yes to A3". |
| D19 | (Added 2026-09-21 night.) Phase 0 is a small sample, one record per path, to learn whether each path works. David: "No. That doesn't make any sense. You only need a small sample to know if it works or not. Pick one for address on Tier 1 to both tracerfy and fastappend each, and one for APN on tier 1 for both and one for nothing found on tier 1. Pick three for dossier, one for a commercial, one for multifamily, and one for land or rural. Reserve the 11 questions for the test to see if the changes worked. So this is halfway between b and c." The eleven GATE A questions in the Phase 0 plan move to the test after the Phase 1 changes. (Interpretation, not his words, put to him for confirmation: FastAppend takes no APN, so its "APN" record is an entity-owned parcel with no city; "nothing found" is a parcel id in the county's real format that no parcel in that county carries, sent to the APN lookup; the dossier records are registry parcels with no owner on record, run through production planRoute and executeRoute.) |
| D20 | (Added 2026-09-21 night.) Phase 0 spend approved at $2 for the eight D19 records (worst case $1.40). David: "$2, go ahead and run it" |
| D21 | (Added 2026-09-21 night, after the Phase 0 run.) Amends D15. **Arm (b), the fallback to the dossier's own contacts, is WITHDRAWN by D32; arm (c) stands.** When the dossier finds individual owners, the second lookup tries harder before giving up, and only then falls back to the dossier's own contacts. David: "c then b". The options as put to him: (c) "Try every owner the dossier names, not just the first ... When the property has no street or city, search the owner's name at their mailing address instead of running the nameless APN lookup"; then (b) "Fall back to the dossier's contacts when the second lookup misses, labelled as not name-verified." Evidence: Phase 0 rows 6 and 8 (tasks/phase0-small-sample.md): the second lookup missed on both while the dossier held 10 phones 4 emails and 7 phones 5 emails, every owner named was an individual, Wicomico's second owner was never tried, Shasta's lookup sent no name. |
| D22 | (Added 2026-09-21 night.) Amends D18. Single traces (web and API) keep today's name handling; name order is fixed per county only on gateway records, where the county is known (Phases 2 and 3). David: "1. C" (option put to him: "Leave single traces as they are. Fix order only on gateway records, where the county is known"). |
| D23 | (Added 2026-09-21 night.) Amends D5. On the API, single AND bulk, a record with no city is sent with its parcel ID so Tracerfy's APN lookup can serve an individual; FastAppend needs only the owner name and state. No format test on a sample of states. David: "Whether it's a single or bulk trace the property id should be sent when API is being used if there's no city, so there's a choice by tracerfy for individuals. For fastappend it doesn't matter, because it only needs owner name and state. Testing a single state is irrelevant because every county/state is going to be different." The web app stays address-only (D5 unchanged there). |
| D24 | (Added 2026-09-21 night.) The dossier needs only the parcel ID; the address is the fallback when there is no parcel ID. David: "You do not need a property address to do a dossier search, only an APN/property_id and an address is used in case the APN is not available." With D23, a record with a parcel ID and no city reaches the dossier and its second lookup, so D21 is built whole in Phase 1 (both arms). (Arm b withdrawn by D32.) |
| D25 | (Added 2026-09-21 night.) The 90-day cache reuses an earlier result only when the owner name matches; a different owner runs a new trace, charged only on a name-matched result with contacts. David: "4. a". |
| D26 | (Added 2026-09-21 night.) The API single "processing + tracerfyJobId, then poll" contract (the Normal batch via submitSingleTrace, still live in code at app/api/v1/trace/single/route.ts:548-580) is deprecated and removed for new traces in Phase 1; no compatibility shape is kept. David: "This is the old code and was depricated long ago." |
| D27 | (Added 2026-09-22.) A lookup that matches the owner but returns no phone and no email is a no-contact result: the ladder, and D21's owner loop and dossier-contacts fallback, keep going; nothing stops early (Phase 1 plan Q1 (a)). David: "How many times to I have to tell you the same answer, and was the original primary reason for using dossier, Identify whether it's an individual or an entity, then send the name to the respective vendor for tracing." |
| D28 | (Added 2026-09-22.) The trust-word list stays exactly as spec 4.2 fixes it; THE and ESTATE OF are not added (Phase 1 plan Q2 (b)). David: "2. b" |
| D29 | (Added 2026-09-22.) The step log stores only how many people a billed non-match returned (`peopleCount`), never their names (Phase 1 plan Q3 (b)); amends spec 5.2's "the parsed people". David: "3. b" |
| D30 | (Added 2026-09-22, Phase 1 pre-flight.) A name ending in TRS stays a company, as today: FastAppend on the full name, no person lookups. The Phase 1 plan had moved TRS to the trust path, but TRS is not on the trust-word list (D28), so the person lookups could never match and cost up to $0.20 each time. TR and TTEE still move to the trust path. David: "Keep it a company". |
| D31 | (Added 2026-09-22, Phase 1 pre-flight.) Three copy fixes to the Phase 1 plan, approved as listed to David: (1) the Settings > Integrations webhook preview shows `found_by`, `outcome_code`, `skip_reason`, says every trace sends the same keys (tier 1: `property_record` null; tier 2: the three null), and that the event fires for every finished trace, none when a lookup fails or the system is busy; (2) the API docs: charged only when a phone or email came back, and for a person only when the person matches the owner name; a trust or unreadable name with no first name left is looked up as a company by name and state (D16); the Full Property Trace fallback applies only when the county record shows an individual owner (D14); a 503 row for busy, and the 502 row loses "This is the one to retry"; (3) a matched owner with no contacts plus a non-match elsewhere ends `no_match`, not `owner_name_not_matched` (D27). David approved all three. |
| D32 | (Added 2026-09-22, Phase 1 execution.) Amends D21 (withdraws arm b) and withdraws D31 (2c). The dossier's own contacts block is NEVER used. The dossier identifies the owner and whether it is an individual or an entity; the phones and emails come only from the separate call to Tracerfy (individual) or FastAppend (entity). If those vendors do not find the owner, the result is a true null: no fallback of any kind. David: "First, there will be no phone or email from the county. Second, we don't take the phone and email from the dossier search, it gets a separate call to tracerfy or fastappend. I'm really getting tired of repeating this. If the vendors don't find it, then it's a true null request. If there is no contact from a single or bulk trace from the app, then it does not get added to the export. The behavior from the gateway through the API/MCP is different." Export, clarified the same day: "If they paid the dossier and no contacts are returned, they still get the enriched property details, so the export fields for the contacts stay blank but all other fields that are available are exported. The exception would be the export to CRM from the app, which would be mute without a contact." That is today's behaviour, so nothing changes: the CSV keeps the row with blank contact columns (lib/trace/exportCsv.ts), and Add to CRM refuses a row with no contact (app/api/integrations/highlevel/push/route.ts:114, :178). |
| D33 | (Added 2026-09-22, Phase 1 execution, Task 7 review.) A Tier 1 single-trace outcome sentence is shown only on a row a single trace wrote (`trace_job_id` NULL). A bulk upload that later reuses the row (web, API and MCP all upsert on user_id + address_hash and never clear `outcome_code`) keeps showing exactly what bulk rows show today, so a stale single-trace sentence such as "You were not charged" never answers for a row a bulk Full Property Trace charged. Cost accepted: a single trace that reuses an old bulk row shows a blank reason in its CSV (blank, never wrong). David chose "Single-trace rows only (Recommended)" over also clearing the reason in the three bulk upload paths (Phase 2 code). |
| D34 | (Added 2026-09-22, Task 8.) A reused row's `charge` stays the address's running total (receipts never go down, the 2026-09-17 rule). When a new single trace on that row finds nothing, History and the CSV show that earlier charge beside "You were not charged"; the sentence speaks for the latest trace, and the response and result card show this trace's own charge. David chose "Keep running total (Recommended)" over blanking the reason on such rows. |
| D35 | (Added 2026-09-22, Task 8.) The crash window (a single trace deducts, dies before its persist, and a resend within 24 hours ends free, so the ledger probe inside `if (billable)` never finds the earlier debit) is logged as a known gap, tasks/todo.md task 19, fixed later with task 16's transactional hold; no refund path in Phase 1. David chose "Log it as a known gap (Recommended)". |

## 3. Architecture

### 3.1 Entry points, before and after

| Surface | Today | After |
|---|---|---|
| Gateway `skip_trace_bulk` (MCP) | People: batch CSV. Companies: FastAppend queue. Whole-batch rejection on one bad record. | Every owned record onto the Tier 1 queue. Judged per record. APN/county used. |
| API bulk `/api/v1/trace/bulk` | Same as MCP, no APN input. Whole-batch 400. | Tier 1 queue, address-only (D5). Judged per record. |
| Web upload `/api/trace/bulk` | Every owned row into the batch CSV. Page drops rows with no city before posting (page.tsx:148). | Tier 1 queue, address-only. The page stops dropping city-less rows so the user sees why each one did or did not trace. |
| Web single `/api/trace/single` | `submitSingleTrace` batch CSV, then a status poll. | Inline `executeRoute()`, synchronous response. |
| API single `/api/v1/trace/single` | Same. | Inline `executeRoute()`. |

### 3.2 The Tier 1 queue

- ONE queue for every owned record, whatever the owner type. It extends today's company queue
  (`ai_research_status`, `ai_research_claimed_at`, lib/trace/entityTraceAttempts.ts) rather than adding
  a second one, and `sweep-entity-traces` becomes the Tier 1 cron. The pending rename of
  `ai_research*` (docs/superpowers/plans/2026-09-20-entity-trace-rename-and-vendor-label.md, Phase 3)
  stays a separate piece of work; this design keeps the current column names.
- Status values must fit the column: `ai_research_status` is VARCHAR(20).
- Claim pattern copied from `sweep-property-traces` (the Tier 2 cron, live in production): claim the
  oldest queued rows with a compare-and-swap on the status read, work them at bounded concurrency, write
  a terminal row.
- Throughput today: the company cron takes 5 rows a minute, sequentially (sweep-entity-traces :71).
  After: sized so a 500-record job clears in roughly 2 to 5 minutes. That figure is bounded by the
  Tracerfy limit (Section 5.3); per-lookup latency has never been measured in this repo and Phase 0
  measures it before the batch size is fixed.

### 3.3 Changeover

Rows already submitted to the Tracerfy batch keep settling through `settleBulkJob` until none remain.
Nothing new is sent there. The batch path, `submitSingleTrace` and the city/state matcher are removed in
Phase 4, only after the in-flight rows have drained.

## 4. Routing rules

### 4.1 One classifier

`classifyOwnerName()` (ownerRoute.ts:170-194, word-boundary, returns entity / individual / trust /
unknown) is used everywhere. `isLikelyBusiness()` (lib/trace/ownerClassification.ts:26) stops being used
for routing; it is a substring test that calls "Vincent Crews", "Ralph Holland" and "Lincoln Garland"
businesses. It is deleted in Phase 4.

### 4.2 Steps per owner type

**Person.**
1. `TRACERFY_INSTANT_NAMED` (trace/lookup/, `find_owner:false` + first and last name) when the record
   has a street and a city.
2. `TRACERFY_PARCEL_APN` (trace/parcel/lookup/) when the record has an APN and county AND either there
   was no city or step 1 missed. The owner's first and last name travel with the step so
   PropTracerPRO's parser can match on them; they are not sent to Tracerfy, whose parcel endpoint
   takes only parcel_id, county and state (docs/vendor/tracerfy-api.md:1352-1356).

Today the individual branch is an exclusive `if / else if` (ownerRoute.ts:396-434): address when the situs
is complete, APN only when it is not. It becomes two pushes in the order above. The warning at :426
("the cheaper address-keyed path") is rewritten; both cost $0.10. `maxVendorCost` gets the same
"only one can hit" treatment Tier 2 has at :370-371. Nothing in code or copy may say the parcel id is
more accurate than the address (SESSION-HANDOFF-2026-09-16.md:19-21); the order is justified by
evidence and cost, not accuracy.

**Company.** `FASTAPPEND_ENTITY` on name and state. Needs no street, city or APN. A miss ends the lane.

**Trust.** The person steps above, run on the name with the trust words removed ("John Smith Revocable
Trust" becomes John Smith), then `FASTAPPEND_ENTITY` on the full trust name if both person steps missed.
The trust words are a fixed, tested list (TRUST, REVOCABLE, IRREVOCABLE, LIVING, FAMILY, TRUSTEE, TTEE,
TR, U/A, DTD and a trailing date). A name that leaves no first name or initial ("Smith Family Trust"
leaves only SMITH) skips the person steps and goes straight to `FASTAPPEND_ENTITY` on the full trust
name (D16).

**Unknown** (one word, or five or more words). The same ladder as a trust, with the name as given.

**No usable key.** A person, trust or unknown owner with no city and no APN gets no step and the outcome
`no_lookup_key`. A company never lands here.

### 4.3 Hit, miss and failure

`runStage` (executeRoute.ts:336-373) already stops at the first hit and moves on after a miss. Three
changes:

- **Name matching** (lib/tracerfy/client.ts:577-614). Today the parser takes a person whose last name
  matches and whose first initial matches, else `persons[0]` (:602), and never reads `property_owner`.
  After: no match means a no-contact result with the outcome `owner_name_not_matched`, and the route moves
  to the next step. The vendor still billed us for returning people; that spend is recorded in the step
  log (Section 5.2), not charged to the customer. Names are normalised before comparing (case, suffixes
  JR/SR/II/III, middle initials). The existing tests that pin the `persons[0]` fallback
  (lib/tracerfy/__tests__/contactLookups.test.ts:303-316) are rewritten to pin the refusal.
- **Unrecognized APN.** Whatever Tracerfy returns for an APN it does not know counts as a miss, so the
  next step runs. Today any non-2xx is a failure (client.ts:675-679), which would stop the fallback.
  Phase 0 records the exact response; the classification is written against that evidence, and FastAppend's
  existing 404-is-an-answer handling (client.ts:536-551) is the precedent.
- **Failure** (5xx, timeout, 429, transport) ends the record `busy_try_again` (Section 5.1).

## 5. Queue behaviour

### 5.1 No automatic retry for vendor failures

- A vendor failure ends the record at once as `busy_try_again`, free, with the sentence in Section 7.
  A single trace returns it in the response. A bulk job completes with those records marked and the rest
  settled normally.
- A crash on OUR side (a claim that never finished) is still recovered automatically: after a stale-claim
  cutoff the row is picked up again and continues from its step log. This is recovery of our own
  failure, not a vendor retry.
- Throttling for the per-minute budget (5.3) is not a failure and uses nothing. The record waits in the
  queue for the next minute.

### 5.2 The step log

- Every vendor answer is written to the record as it arrives: step kind, outcome (hit / miss /
  name-not-matched / failed), credits the vendor deducted, the parsed people for a billed non-match,
  and a timestamp. It is internal: never in a customer payload.
- When a `busy_try_again` record is sent again within 24 hours, the queue resumes at the step that
  failed and reuses the logged answers. After 24 hours the record runs fresh so stale answers are never
  reused.
- A resend of a `busy_try_again` record is NOT a duplicate. It reuses the same row (same address hash)
  and goes back on the queue. This exemption is what makes "try again in 5 minutes" true. A resend of any
  other finished record keeps today's duplicate behaviour (open task 17 is unchanged).

### 5.3 Rate budget

Tracerfy allows 500 lookups a minute per account, shared by the instant, APN and dossier endpoints
(docs :661, :1332). Today Tier 1 uses the batch endpoint, a different bucket, and `sweep-property-traces`
is sized on that assumption (:80-81). After this change the Tier 1 and Tier 2 crons draw from ONE shared
per-minute budget of 450 Tracerfy calls (50 under the limit), so neither can starve the other or trip the
limit. FastAppend has its own 500 a minute (client.ts:511-512) and gets its own budget of 450. A 429
that happens anyway is a vendor failure (5.1).

## 6. Billing, wallet and duplicates

### 6.1 Billing

- Charged once per record, only when a name-matched result carries at least one phone or email
  (`hasContactData`, lib/trace/fullPropertyTrace.ts:165-168). `contactsFound` is not the gate; it is true
  for an empty contacts object.
- Rate: the Tier 1 rate for the record's track, unchanged. Track A (session, MCP, crons) uses the
  grant-aware `chargePerTrace` (lib/suite/pricing.ts:41): $0.15 Pro and AcquisitionPRO, $0.25
  Pay-As-You-Go. Track B (API) uses the raw `getChargePerTrace` (lib/constants.ts:166-173).
- The same price whichever key found the owner and however many lookups ran.
- Free: `no_match`, `owner_name_not_matched`, `no_lookup_key`, `busy_try_again`.
- Before charging, the cron asks the ledger whether this row was already charged
  (`collectedChargeFor`, lib/wallet/collectedCharge.ts), exactly as the Tier 2 cron does, so a record
  recovered after a crash is never charged twice. Money written with `foldBillingWrite`
  (lib/trace/billedRows.ts:175), `tier` = PER_SUCCESSFUL_TRACE.
- `contact_vendor` is written on every Tier 1 row from `contactVendorFrom(execution.steps)`
  (executeRoute.ts:194-201). Today Tier 1 person rows leave it NULL.

### 6.2 Wallet reserve

`inFlightUnbilledCost` (lib/trace/bulkPreflight.ts:229-256) counts queued Tier 1 records as well as
`processing` ones, so two batches sent back to back cannot both pass on the same dollars. The gap inside
a single submit (open task 16) is unchanged.

### 6.3 Duplicate key

`normalizeAddress` keys on street, city and state. A blank city gives `STREET||ST`, so "100 Main St" in
two towns collide, and every APN-only record with no street collides on `||ST`.

Key precedence per record:
1. City present: street + city + state. Unchanged, so the 90-day history keeps working.
2. No city, APN and county present: APN + county + state. The APN is stored as sent, only trimmed,
   uppercased and with a leading `#` removed. Dashes and spaces are kept so two different parcel numbers
   cannot collapse into one.
3. Neither: street + state, today's behaviour. A person, trust or unknown owner here is `no_lookup_key`
   anyway; a company is still traced (FastAppend needs only name and state) and carries today's collision
   risk, which is recorded here rather than solved.

## 7. Reporting

### 7.1 Outcome codes

Every Tier 1 record ends with one outcome code, one sentence, and a `found_by` value when found. `found_by`
names the KEY that worked (`address`, `parcel_id`, `company_name`), never the vendor. The vendor stays in
`contact_vendor`, internal, as today (settleBulkJob.ts:64-66).

| Outcome code | Charged | Sentence (draft, must pass 7.3) |
|---|---|---|
| `found_by_address` | Yes | none; contacts are shown |
| `found_by_parcel_id` | Yes | none |
| `found_by_company_name` | Yes | none; companies, and trusts or unknown names that fell through to the company lookup |
| `no_match` | No | "We looked this owner up by {address / parcel ID / address and parcel ID / company name} and found no match. You were not charged." Names only the keys actually tried. |
| `owner_name_not_matched` | No | "We found people linked to this property, but none matched the owner name, so no contacts were returned. You were not charged." |
| `no_lookup_key` | No | "This record is missing {the city and the parcel ID / a valid state / a street address and the parcel ID}, so it could not be looked up. You were not charged. Send it again with {what is missing}." |
| `busy_try_again` | No | "The system is busy. Try again in 5 minutes. You were not charged." |

A sentence says a parcel ID was "not recognized" only if Phase 0 shows Tracerfy tells us so. Otherwise it
says the lookup "found no match".

`trace_history.status` keeps its six-value CHECK constraint (supabase/schema.sql:74). The outcome code
lives in its own column.

### 7.2 Where it shows up

PropTracerPRO:
- `bulk_status` per-record result (`buildPerRecordResult`, mcp-tools.ts:622-659) and its API twin
  (app/api/v1/trace/bulk/status/route.ts:421-464) gain `found_by` and `outcome_code`; `skip_reason`
  carries the sentence. `lib/trace/__tests__/payloadParity.test.ts` keeps the two in step, so both change
  together. The API twin also feeds the `bulk_job.completed` webhook.
- `list_traces` gains `found_by`, `outcome_code` and `skip_reason` (it has no reason today).
- Web single and API single responses gain the same three (API single in camelCase).
- CSV export appends `found_by` and `outcome_code` at the END of the header (the header is append-only,
  lib/trace/exportCsv.ts).
- The Tier 1 `trace.completed` webhook carries them.
- `rowSkipReason` (lib/trace/rowSkipReason.ts) reads the Tier 1 outcome. Today a genuine Tier 1 miss
  returns `skip_reason: null` by design (:43-45); after, every non-success Tier 1 row has a sentence.
- The MCP tool descriptions (app/api/[transport]/route.ts:91, :97) say `apn`/`county` apply to named
  records too, and describe the outcome codes.

Web app:
- History: a "Found by" column (Address, Parcel ID, Company name) and the reason on rows that found
  nothing.
- Single trace: the real reason replaces the generic "No Results Found" guesses
  (components/trace/TraceResultCard.tsx:48-66).
- Bulk page: the summary counts records by outcome, for example "12 busy, try again in 5 minutes;
  3 have no city and no parcel ID" (`BulkSkipSummary`, `summarizeSkips`).

Gateway: Section 9.

### 7.3 Copy rules (already enforced by tests)

From rowSkipReason.test.ts:141-219, propertyTraceAttempts.test.ts:195-238, BulkSkipSummary.test.tsx and
the gateway's crm-push-owners tests:
- Every sentence states the charge.
- No price, no `$`, no em dash, no en dash, no asterisk, no emoji.
- No "notified", "our team", "looking into", "add funds", "top up", "insufficient".
- "Not charged" only where true.
- Resend advice ("send it again", "try again") is allowed on exactly two outcomes: `no_lookup_key`
  (resending with the missing part changes the duplicate key) and `busy_try_again` (exempt from the
  duplicate check, 5.2). The copy test is updated to allow exactly those two.

## 8. Schema changes (PropTracerPRO)

All applied by migration, verified by reading back, per repo practice.
- `trace_history.outcome_code` VARCHAR, nullable (NULL on rows written before this change).
- `trace_history.found_by` VARCHAR, nullable.
- `trace_history.trace_steps` JSONB, nullable: the step log (5.2).
- An index on `(user_id, parcel_id_local, county)` for the APN duplicate key. `parcel_id_local` and
  `county` exist (migration 20260919_trace_history_parcel_key.sql) but are not indexed.
- The existing partial index on `ai_research_status` covers only the bare `'queued'` value
  (migration 20260411:11-13); it is widened to whatever queued values the Tier 1 ladder uses.
- Nothing is granted to `anon` or `authenticated` beyond SELECT (trace_history writes were locked in
  20260918_lock_trace_history_writes.sql and stay locked).

## 9. Gateway changes (suite-gateway)

### 9.1 The owner rule (D11)

The owner name sent to PropTracerPRO comes from the registry, never from MPS. Two places break this today:
- A property that enters from MPS (`search_properties`, `lookup_owner_by_address`, `batch_lookup` ids) sends
  MPS's `owner_name` or `owner_contact` straight to PropTracerPRO (lib/curated.ts:219-220,
  crm-push-owners.ts:1950).
- When a registry parcel names no owner, the merge fills the owner from MPS
  (lib/registry-mps-merge.ts:296-352), and that name can reach the trace.

After: neither MPS field is ever used as the traced owner name. (What the CRM Company record is named is
not changed by this design.)

### 9.2 Multifamily properties

1. Look the property up in the registry: by APN and county first (58.6% of MPS rows carry a parcel number,
   measured 2026-09-07), then by address. More than one candidate counts as not found; neither is chosen,
   matching the existing merge (registry-mps-merge.ts, "never silently picks").
2. Found, with an owner: a normal Tier 1 record using the registry's owner, street, city, APN and county.
3. Not found, or found with no owner (D12): send MPS's street and city with NO owner name. PropTracerPRO
   runs it as a Full Property Trace: the county record names the owner, then contacts are looked up, and
   the name test uses that county owner. This runs only under `trace_unknown_owners` with `confirm`, at
   Tier 2 prices ($0.25 Pro and AcquisitionPRO, $0.40 Pay-As-You-Go, charged per record sent). Without the
   opt-in the owner is skipped with a reason, as today.

Which registry tools perform the two lookups (the address lookup and a parcel-id lookup scoped to county)
is confirmed at the start of Phase 3; if the registry exposes no parcel-id lookup, the address lookup is
the only step.

### 9.3 City guard and mapping

- `hasTraceableAddress` / `ptpCandidateSplit` (crm-push-owners.ts:1091-1126): a named owner with an APN and
  county but no city is sent. An owner with neither key is still held back locally.
- Outcome mapping reads `outcome_code`, never the sentence:
  `busy_try_again` gets a new gateway code whose sentence tells the user to run those property ids again
  in 5 minutes; `owner_name_not_matched` and `no_lookup_key` get their own codes; `no_match` stays
  `trace_found_nothing` with PropTracerPRO's sentence naming the keys tried.
- Sentences that become false are corrected: `REGISTRY_NO_SITUS_CITY_REASON` ("Re-running will not change
  it", :599-604), the "has no city" sentence (:672-675), the stale "PTP accepts city ''" comments
  (:1080, :1099), and the tool descriptions (app/api/[transport]/route.ts:163, :278, and
  lib/tools/crm-push-owners.ts:43).
- `ptpAcceptsParcelKey` (the schema check before sending `apn`/`county`) stays.

## 10. Phases

Before Phase 0: the three unmerged commits on `feat/contact-vendor-provenance` (727bae2, d462ab6, 98424af)
merge first; this design builds on them.

Each phase ends with something David can see, and work stops for his go-ahead before the next.

**Phase 0, paid measurement.** REVISED by D19 (2026-09-21 night): eight records, one per path (Tier 1 by address to Tracerfy and to FastAppend, Tier 1 with no city to the APN lookup and to FastAppend, one Tier 1 lookup that finds nothing, and three dossier records: commercial, multifamily, land or rural). The eleven GATE A questions move to the test after the Phase 1 changes. The bullets below are the superseded larger design. No code changes. Every lookup is logged with its raw response under
`tasks/research-test/` (gitignored). David approves the spend before it starts; estimated at most $15
(misses free; person and company hits $0.10; county records $0.20). (Revised 2026-09-21 evening for
D13-D18; the plan file carries the detail and the three gates: county picks, spend, findings.)
- Counties come from the registry inventory, chosen to find defects, across property types, never re-using
  a tested parcel or county, secondary or tertiary only (see `tasks/phase0-county-shortlist.md`).
- Individually owned parcels, owners from the registry, INCLUDING parcels with no city: each gets the
  Instant lookup (when it has a city) and the APN lookup. Record hit, name match, name order per county
  (D18), what an unrecognized APN returns, and latency.
- About 10 trust-owned parcels: person lookups on the stripped name then FastAppend on the full name; a name
  left with no first name or initial goes to FastAppend only (D16).
- Registry parcels with no owner on record, across property types including multifamily (D17): the dossier,
  then the second lookup on the owner it found (D15), judged by the name test.
- Output: a per-county report in tasks/. Anything it disproves comes out of this design before Phase 1
  (for example the FastAppend half of the trust ladder if it never hits, or the APN step if it never
  returns the named owner).

**Phase 1, single traces (web and API).** Routing (4), name matching, name order per county (D18), the
trust and unknown ladder including D16, one classifier, the step log, outcome codes and sentences, `busy_try_again`, billing on `hasContactData`.
What David sees: a web single trace shows "Found by" and the real reason when nothing was found.

**Phase 2, bulk (gateway MCP, API bulk, web upload).** The Tier 1 queue and cron, the shared rate budget,
per-record judging, the APN duplicate key, the busy exemption, the wallet reserve change, the new payload
fields, CSV columns, webhooks, and the bulk page summary. New submits stop going to the batch CSV.
What David sees: a web upload shows each record's outcome, and a batch with a city-less record still
runs.

**Phase 3, gateway.** The owner rule, the multifamily registry lookup and opt-in fallback (D17: records
come from the registry; no registry owner means a dossier search the user is told about), the relaxed city
guard, outcome mapping, corrected sentences and descriptions. What David sees: a `crm_push_owners` dry
run shows each owner's outcome and which key found them.

**Phase 4, cleanup.** After in-flight batch rows drain: remove the Tracerfy batch path for Tier 1,
`submitSingleTrace`, the city/state matcher, `isLikelyBusiness`, and the stale comments left by d462ab6
(sweep-entity-traces :429-431, v1 bulk route :115-118, the "entity row post-research" branch in
settleBulkJob).

## 11. Testing

- Tests are written before the code.
- Every money or matching guard gets a test that FAILS when the guard is deleted, proven by deleting it
  (lessons L-015): the name match, the billing gate, the ledger probe, the duplicate key, the busy
  exemption, the owner-source rule in the gateway, and the whole-batch-rejection removal.
- Every call site is mutated, not just one (lesson L-018): web and API single, web and API bulk, MCP,
  the cron.
- The request shape of each step is pinned by a test, since a malformed APN key comes back as a free,
  silent miss (lesson L-020).
- Parser changes are checked against the saved raw responses in `tasks/research-test/` (lesson L-008).
- No test calls a live vendor. Gateway tests run without a `.env.local` in the worktree, because that file
  turns skipped live tests into production calls.
- Live checks at the end of each phase use secondary and tertiary markets only.
- Suite gates as in the handoff: vitest, `tsc`, eslint against the 47 baseline (never bare
  `npm run lint`), `next build`.

## 12. Out of scope

- APN and county input on the API and web app (D5, deferred).
- The Florida raw-city fallback in the gateway's registry adapter, which David will handle separately.
- The `ai_research*` rename (existing plan).
- Open tasks 16 (reserve inside one submit) and 17 (re-running a finished row inside 90 days), except the
  busy exemption in 5.2.
- Changing what the CRM Company record is named from.

## 13. Risks

- **The APN person lookup is thinly proven for individuals.** 7 of 12 California parcels returned a
  flagged owner (SESSION-HANDOFF-2026-09-15); the "0 of 13" in ownerRoute.ts:9 was company-owned
  parcels, where it cannot work. Phase 0 decides whether the APN step earns its place.
- **Vendor cost rises for people.** A person hit costs 5 credits ($0.10) instead of the batch's 1 credit
  ($0.02). A record where the APN lookup returns strangers and the address lookup then hits costs $0.20
  against a $0.15 Pro charge.
- **The shared rate budget** is new infrastructure; a bug in it either starves Tier 2 or trips the limit.
- **Latency is unmeasured**, so the 2 to 5 minute figure for 500 records is a ceiling estimate until
  Phase 0.
