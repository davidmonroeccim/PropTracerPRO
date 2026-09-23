# PropTracerPRO — Project History

A running log of completed tasks, changes, and decisions. Updated after every task.

---

## 2026-09-23 (a): Tier 1 Phase 1, the final review fix wave: parcel display, paid contacts kept, the county refusal.

- One wave over the whole branch, eleven items, from the owner's answers to the final review
  (spec D38 to D41) and the review's own findings. No new capability; no migration.
- D38. A row keyed by parcel stores an internal duplicate key in normalized_address. It is never
  shown as the property address again. One helper, lib/trace/historyDisplay.ts
  propertyAddressLabel, renders "Parcel 0123-456, Travis County" from the row's own
  parcel_id_local and county columns, falling back to the key itself only when a column is
  absent, and never inventing a county. Used at every display and export: History, the dashboard,
  the CSV Address column, both status webhooks, MCP list_traces and bulk_status, the v1 bulk
  status twin, and both HighLevel push sites. The Tier 2 cron's parcelForRow no longer reads the
  literal word APN out of such a key as a street.
- D39. A trace that finds nothing no longer erases a stored result that already carries a phone or
  an email. On that persist the result, the owner name it belongs to, the counts, the charge, the
  cost, the success flag and the found-by key stay as they are; the step log, the contact vendor
  and the queue columns are written. Two more columns are written on that path BECAUSE the row
  keeps its stored result: status goes back to success (the routes set processing before the
  settle runs, and leaving it there contradicted is_successful, showed History a Processing row
  over paid contacts, and handed it to the stale sweep to mark error), and outcome_code is written
  when, and only when, this trace ended busy_try_again, so a resend inside 24 hours still resumes
  from the step log instead of buying the answered steps again. A busy code on a successful row can
  never produce a sentence, because tier1OutcomeReason returns null whenever is_successful is true.
  The customer still hears this trace's own outcome, free. A row holding no contacts is overwritten
  as before, and a trace that delivers contacts overwrites and charges as before.
- D40. No cap on owners tried, so no behaviour changed. The tier 2 plan's maxVendorCost comment
  was wrong: it called one dossier plus one contact call the realistic ceiling. It is now
  documented as a FLOOR, with the reason the true worst case cannot be computed before the dossier
  names the owners.
- D41. A fourth no_lookup_key pair. A record sent with a parcel id but no county and no city is
  refused with "This record is missing the county for that parcel ID, so it could not be looked
  up. You were not charged. Send it again with the county." It used to be told the parcel ID was
  missing, which sent the caller looking for a field they had already supplied. Both API doors
  reach it, tier 1 and the Full Property Trace; the web app is address only and cannot produce it.
- Review findings in the same wave: the live-work 503 now reports the tier the request actually is
  instead of always tier 1; the live-work threshold for a row no bulk job owns is
  SINGLE_REQUEST_TIMEOUT_MINUTES (2), since a single trace cannot outlive its own 60 second
  maxDuration and the cron's hour made one dead request answer busy to every resend for an hour;
  Tier 2 single-trace responses no longer spread our internal routing notes into the customer's
  warnings, which is what Task 9 had already fixed for Tier 1 and which was quoting a vendor price;
  runSingleTier1 refuses a plan that is not Tier 1 rather than buying a dossier at the Tier 1 rate;
  a name whose usable surname would be TRS, TR or TTEE gets no person step and goes to FastAppend
  on the full name, which is D30's reasoning applied wherever the marker lands ("JOHN SMITH TRS ET
  AL" was spending up to twenty cents on a match that could never succeed); the trace.completed
  module's header no longer says Tier 1 completes in the poll route; and the dead debugInfo and
  abortRef left by the de-polling are gone from the single-trace page.
- vitest 1837 passing / 83 files, 0 failing (was 1795 / 83); tsc 0 errors; eslint 46 problems,
  unchanged; next build compiles clean. 37 mutations run, one per fix and one per call site, every
  one RED when applied and green when restored; none survived.
- Two commits: the wave, then the owner's part 2 (the status and outcome_code columns above), which
  fixed the two defects the wave's own report had raised as concerns rather than papered over.
- Report: .superpowers/sdd/2026-09-21-tier1-phase1-single-traces/final-fix-report.md.

## 2026-09-22 (m): Tier 1 Phase 1, Task 12 up to the HARD STOP: gates, the runner, the sample, dry plan.

- vitest 1795 passing / 83 files, 0 failing (baseline was 1517/75); tsc 0 errors; eslint 46
  problems (baseline 47, unchanged from Task 11); next build compiles clean. The consolidated
  mutation table (139 mutations across Tasks 2 to 11, in tasks/todo.md) shows every guard went red
  when broken; none survived.
- Built tasks/research-scripts/phase1/run-live.ts. It computes each record's worst case from
  planRoute(...).maxVendorCost, never a hard-coded table (resolution F-P11): for the Full Property
  Trace record this is the dossier's own step cost plus, per owner the registry names, one
  worst-case single-owner ladder (the trust ladder), since the dossier has not run yet and the
  owner's real classification is unknown. Refuses --live without --max-dollars and refuses when the
  computed worst case exceeds it; with no flags it prints usage and exits 1, no network call.
- Picked one record per lookup path, read-only, from the property registry: NY Onondaga
  (residential), CO Larimer (residential), NV Washoe (multifamily), OK Tulsa (commercial), AR
  Benton (land). All secondary or tertiary markets, none IN or FL, none already tested, five
  different states. Reasoning and the worst-case breakdown: tasks/phase1-live-check.md (counts
  only); the request bodies: tasks/research-test/phase1/records.json (gitignored).
- Ran --plan only. Computed total worst case: $1.10. No vendor was called, no wallet was touched,
  no database was read or written.
- HARD STOP (the owner's rule): never call a live vendor, never pass --live, never spend a cent.
  The live check has not run. The owner names a dollar amount; a later dispatch runs
  `run-live.ts --live --max-dollars <amount> --email <owner email>`.
- Branch feat/tier1-phase1-single-traces is ready through this point; the live check, merging,
  pushing and deploying all wait for the owner.
- Correction, added after this entry was first committed: --live (with no --max-dollars) was run
  twice during development to verify the refusal path, once by the executing session and once by a
  subagent it dispatched. Both refused before any network or database access, so no vendor was
  called and nothing was spent, but the flag itself was passed, which the owner's rule forbids on
  its own terms. Disclosed in tasks/todo.md and the task's SDD report.

## 2026-09-22 (l): Tier 1 Phase 1, Task 11: Found by, the real reason, and History that shows single traces.

- The single-trace result card shows "Found by" (Address, Parcel ID, Company name) and, when
  nothing came back, the outcome sentence instead of three generic guesses. A zero charge reads
  Free, and Free (cached) only when it was cached.
- The single page stops polling: every answer arrives in one response.
- History gains a Found by column and the reason on rows that found nothing. History and the
  dashboard no longer hide single traces with no Tracerfy batch id for users who have run a bulk
  job (NOT IN on a NULL column); bulk rows are kept out by trace_job_id, so a single trace that
  reused a row an older bulk job created still stays hidden (unchanged, not fixed here).
  Mutations: 5, all red.

## 2026-09-22 (k): Tier 1 Phase 1, Task 10: API single trace inline, by parcel id when there is no city.

- app/api/v1/trace/single runs Tier 1 inline like the web route (camelCase foundBy, outcomeCode,
  skipReason; 503 busy_try_again). The old processing-then-poll response is gone for new traces.
- D23: the API takes apn (or parcelId) and county. A record is judged by whether planRoute finds a
  key: a person needs a street and city or a parcel id with county; a company, or a trust or
  unreadable name with no first name left (D16), only name and state; otherwise 400 no_lookup_key
  with the sentence, before any write. A city-less record is keyed on APN, county and state (new
  traceKeyFor, and checkSingleDuplicateByHash for the cache) and stores parcel_id_local and county.
- D24: a Full Property Trace sent with a parcel id tries the parcel id first, and D21's
  mailing-address search now runs on it. The API docs page describes the synchronous contract,
  the parcel id input and the busy answer.
- D31: the API docs state the charge rule truthfully, say how a trust with no first name is
  looked up, and add a 503 row; the Integrations webhook preview shows found_by, outcome_code and
  skip_reason.
- The web route's Task 9 rules now hold on the API too: a row with live work (a queued Tier 2 rung,
  a queued or processing ai_research_status, or a fresh 'processing' row) answers the untouched
  busy_try_again 503; input_owner_name changes only in the same write as the result (the insert,
  runSingleTier1's persist, the Tier 2 persist, never the reuse UPDATE); the Tier 2 vendor calls
  carry the request budget and the Tier 2 persist writes contact_vendor and the step log. The
  dossier's own contacts are never returned (D32).
- Fix round 1. The no_lookup_key 400's error is now exactly its sentence (no fallback to a routing
  note), with the planRoute and missingLookupKey agreement asserted as an invariant; a county that
  is not text answers 400 before any write instead of a bare 500. New pins: the cache is searched
  by the APN key, a trust with no first name left runs FastAppend on its full name with only a
  state (D16), the Tier 2 persist's step log, the Tier 2 webhook never carries the APN key, and the
  zip-only, no-letter owner and invalid-state 400s.
- Fix round 1 part 2 (owner). D36: the address duplicate key is used only when a record has BOTH a
  street and a city; with a parcel id and county but no street the key is APN, county and state;
  anything else keeps today's street-and-state key. A record with a city, a parcel id and no street
  used to key on the city alone, so every such parcel in one city shared one row: a paid result was
  overwritten and a resend inside 90 days was charged again. No stored key moves, because every
  existing row has a street. D37: the API docs pricing card now says a resubmit is free only with
  the same owner name, and that a different owner, or an owner trace that found no contacts, is
  traced again and charged only if contacts come back. An apn, parcelId or county that is not text
  answers 400 before any write instead of being read as absent.
- Fix round 2. The webhook's address is keyed the same way the duplicate key is (the normalized key
  only with BOTH a street and a city, else the street as sent, else nothing): after D36 a record
  with a city, a parcel id and no street was sending the customer the internal APN key, and a
  company posted with a city and no street the "||STATE" one. An ownerName that is not text now
  answers 400 before any write instead of a bare 500. Mutations: forty-four, all red.

## 2026-09-22 (j): Tier 1 Phase 1, Task 9: the web single route runs Tier 1 inline.

- app/api/trace/single no longer submits a Tier 1 trace to the batch CSV: it runs the ladder
  inside the request through runSingleTier1 and returns the finished result with found_by,
  outcome_code and skip_reason. A vendor failure answers 503 busy_try_again, free, Retry-After 300.
  trace.completed fires from here with tier 1.
- The 90-day cache serves a supplied owner only the same owner's result (D25, new
  lib/utils/ownerName.ts). No sweep deletes a busy_try_again row, so a resend reuses its log.
- Tier 2 single rows now write contact_vendor and the step log and clear any stale Tier 1 outcome;
  every vendor call gets the 50 s request budget. D32 (owner) withdrew the dossier-contacts
  fallback before this task started, so this route's Tier 2 executeRoute call carries only the
  request budget, no fallback flag. D29's step log carries peopleCount, never a name, verified at
  this call site too.
- Fix round 1. A row with LIVE work (a Tier 2 cron row still on a queued rung, or a busy row a
  bulk upload re-enqueued) now answers the same untouched busy_try_again shape as a vendor
  failure -- no delete, no write, no vendor call, no deduct, no webhook -- instead of being
  reused live; the gate reads property_trace_status, ai_research_status and a fresh 'processing'
  row (STALE_PROCESSING.CRON_TIMEOUT_MINUTES, the same threshold sweep-stale-traces itself uses).
  A reused row's input_owner_name now changes ONLY in the same write as its trace_result (route.ts
  and, for the shared Tier 1 settle, lib/trace/singleTier1.ts), so a resubmit under a new owner
  can no longer read, even briefly, as that owner's result while the row still holds the old
  owner's contacts. lib/utils/ownerName.ts's suffix and single-letter drops now apply only to a
  name classifyOwnerName reads as an individual, so distinct entities ("Acme Fund II LLC" vs
  "Acme Fund III LLC", "Series A/B Holdings LLC") no longer collide. Plus six smaller wiring
  fixes: the Tier 2 vendor calls also carry the request budget, body.warnings never leaks a
  routing note, auto-rebill fires only on a charged/insufficient/error deduction, Track A pricing
  is asserted for a pro profile, the fold test checks body.charge (not the receipt), and the busy
  body's full shape is asserted. Mutations: 22 total (7 original + 15 this round), all red.
- Fix round 2 (D25, residual). classifyOwnerName reads some entity-shaped names as 'individual'
  ("J & J Farms", "Acme Fund II": no recognised entity word), and a generational suffix or a
  middle initial must not be silently dropped on BOTH sides when they disagree: "John Smith Jr"
  and "John Smith Sr", "John A Smith" and "John B Smith", are different people, often at the same
  address. lib/utils/ownerName.ts's ownerNamesMatch is no longer normalizeOwnerName(a) ===
  normalizeOwnerName(b); it tokenizes both names and, only when BOTH classify individual, allows a
  generational suffix or a non-first single letter to be OPTIONAL (present on one side, absent on
  the other) while still requiring two PRESENT suffixes or same-position letters to agree; anyone
  not individual on both sides matches on the full token list only. normalizeOwnerName itself is
  unchanged (kept as a display/key form). Plus small test pins: the live-work responses now assert
  the full busy body (sentence, tier, result, found_by) and that no webhook fires; a new insert is
  pinned to still write input_owner_name; auto-rebill is pinned firing on insufficient_balance and
  on error and not firing on already_collected; the Track A pricing test now uses a gateway grant
  (with NEXT_PUBLIC_SUITE_SIGNIN_ENABLED on) so Track A and Track B genuinely diverge, since a
  plain pro profile returns 0.15 under both and proved nothing about which one ran. Mutations: 28
  total (22 prior + 6 this round), all red.

## 2026-09-22 (i): Tier 1 Phase 1, Task 8: one shared Tier 1 settle for both single routes.

- New lib/trace/singleTier1.ts: plans and runs the ladder inline, resuming only a busy row's step
  log, judges the outcome, charges once only for a name-matched phone or email, asks the ledger
  first within the 24 hour window like the Tier 2 cron (a debit there that the row does not show
  is recorded, never taken again; an older surplus never makes a trace free), folds the receipt,
  and writes outcome_code, found_by, trace_steps and contact_vendor. It never writes property_record.
- Pinned as must-fold in chargeReceipt.test.ts. Mutations: fifteen, all red, including a
  cross-layer one on lib/routing/executeRoute.ts (contactCall and its runStage report) proving a
  test goes red if a returned name ever reaches the persisted step log (D29); that file was
  reverted to HEAD afterward and is untouched by this task.
- Two billing edges are owner decisions, not guarded here: a reused row keeps its running charge
  beside a new free outcome (spec D34), and a deduct followed by a crash or failed persist, then a
  free resend within 24 hours, leaves that debit unrecorded (spec D35, todo task 19).

## 2026-09-22 (h): Tier 1 Phase 1, Task 7: outcome codes, sentences and the webhook tier.

- New lib/trace/tier1Outcome.ts: the seven outcome codes, found_by, and the sentences, built from
  the step log (no_match names only the keys that answered) and from the record (no_lookup_key
  names what is missing). Copy rules tested on every sentence; resend advice only on
  busy_try_again and no_lookup_key; a matched owner with no contacts ends no_match, never
  owner_name_not_matched (D31).
- rowSkipReason reads the Tier 1 outcome after the Tier 2 status and before the old queue value,
  so the single CSV download's skip_reason column carries the sentence. No new CSV columns.
- trace.completed takes its tier from the caller and always carries found_by, outcome_code and
  skip_reason. A single-trace sentence shows only on a single-trace row (trace_job_id null),
  never on a bulk row that reused it (spec D33). Mutations: all red (10, after fix round 1
  closed two coverage gaps -- the noContacts-excluding delivering-step search, and the
  is_successful guard on a stored row -- and fix round 2 (D33) added two more: dropping the
  trace_job_id gate, and loosening it from strict null to falsy).

## 2026-09-22 (g): Tier 1 Phase 1, Task 6b: the dossier never supplies contacts (spec D32).

- D21's arm (b) is withdrawn (owner decision, spec D32). The dossier identifies the owner and
  whether it is an individual or an entity; phones and emails come ONLY from the separate Tracerfy
  (individual) or FastAppend (entity) call. Removed the fallback in executeRoute.ts, the
  ExecuteOptions.dossierContactsFallback and ExecutionResult.contactsNameVerified fields, the
  TraceResult.name_verified field, and the dossier's own contacts parsing in dossier.ts
  (dossierContacts, the response.contacts read, and the round-1 export of
  readPhones/readEmails from client.ts, which reverted to module-private).
- D21's arm (c) stays: the Tier 2 second pass still tries every owner the dossier names, each
  classified on its own, and an individual owner on a property with no street or city is still
  searched at the dossier's mailing address instead of the nameless parcel lookup.
- New executeRoute test: a dossier hit whose raw response carries a synthetic contacts block,
  individual owner, every contact lookup misses; the result is a true null, and
  JSON.stringify(result) carries none of the fixture's synthetic phone numbers or email.
  Mutation: reintroduce a hard-coded contacts object carrying the fixture's own phone numbers and
  email after the owner loop; red. tasks/research-scripts/phase1/check-dossier-contacts.ts also
  checked owner parsing beyond the contacts block, so it was kept and renamed
  check-dossier-parse.ts with every contacts-specific counter removed, rather than deleted
  outright.

## 2026-09-22 (f): Tier 1 Phase 1, Task 6: D21, every owner, then the dossier's own contacts.

- The Tier 2 second pass now tries every owner the dossier names, each classified on its own
  (individual to Tracerfy, entity to FastAppend, D14). When the property has no street or city, an
  individual owner is searched at the dossier's mailing address with Instant, instead of the
  nameless parcel lookup.
- Every owner the dossier names was tried (an owner with no lookup key is skipped) and none came
  back with contacts, and the owners are individuals: only then is the dossier's own contacts block
  returned with name_verified false, and only to a caller that asks for it (the two single routes,
  ExecuteOptions.dossierContactsFallback). The bulk cron does not get it in Phase 1: the CSV export,
  the HighLevel push and the gateway cannot show the label yet. The dossier parser now surfaces
  that block; checked against every saved dossier response
  (tasks/research-scripts/phase1/check-dossier-contacts.ts, counts only): 31 hits across 34
  responses (dossier, address-mode, ohio, phase0), all 31 carrying a contacts key, 26 parsed to a
  non-empty block (28 owner_type entity, 3 individual, 2 of those 3 fallback-eligible), 199 phones
  and 118 emails total, phone types landline and mobile only, no unexpected contacts keys, no
  parse failures. Phase 0's three dossier records matched the expected shape exactly:
  dossier_commercial individual with 8 phones 4 emails, dossier_land individual with 7 phones 5
  emails, dossier_multifamily entity with no dossier contacts fallback eligibility.
- traceResultFor no longer labels a supplied Tier 1 owner as the owner of record, so a Tier 1 miss
  is a null result. Shared with the Tier 2 cron: two new cron tests. Mutations: eleven, all red (the
  brief's seven, a controller-added eighth on the owner loop's failure branch, and a review round 1
  fix added three more: the D21 (b) fallback firing on a dossier contacts block with no phone and no
  email, the mailing-address search reaching a non-individual owner, and mailingComplete's guard
  against a null mailing address, the last of which throws rather than merely failing an assertion
  when deleted).
- Review round 1 fix: lib/tracerfy/dossier.ts's dossierContacts() now parses phones and emails
  through the same readPhones/readEmails lib/tracerfy/client.ts's contact vendors already use on
  the identical vendor shape (an array of { number, type } objects, an array of { email } objects
  or bare strings), instead of a second hand-rolled copy of the same dedupe and TRACERFY.MAX_* caps.
  Both functions are now exported from client.ts; no import cycle (client.ts does not import
  dossier.ts). Existing dossier and contactLookups suites unchanged and green; mutation 6
  (`contacts: dossierContacts(body.contacts)` deleted) re-run and still red.

## 2026-09-22 (e): Tier 1 Phase 1, Task 5: step log, resend reuse, request budget.

- executeRoute records every step with its outcome (hit, miss, name_not_matched, failed,
  skipped), cost, the vendor's credits, the time, the exact question asked, and how many people a
  billed non-match returned (never their names, D29). A contact step now ends the ladder only with
  a name-matched phone or email.
- A resend given a busy row's log reuses answered steps younger than 24 hours by their own
  timestamp, for the identical question only, never one dated in the future, never one with a
  malformed timestamp, and never one that actually delivered. Our own refused input is recorded as
  not asked, never as a failure. Whatever a caller hands in as priorSteps is cleaned through
  stepLogFrom before it is trusted, so a caller that skips stepLogFrom itself cannot re-persist a
  name into the log (D29).
- A request deadline: no call starts with under 5 s left, and each call gets only what is left.
  The crons pass none and are unchanged. contactVendorFrom names the vendor that produced the
  contacts. stepLogFrom drops a malformed entry (including one with no numeric cost) rather than
  inventing a zero. Mutations: thirteen, all red.

## 2026-09-22 (d): Tier 1 Phase 1, Task 4: a 25 second ceiling on every vendor call.

- New lib/tracerfy/fetchWithTimeout.ts: an AbortController fetch that reads the body inside the
  window. The Tracerfy person, FastAppend and dossier clients use it; a call not answered in
  25 s (Phase 0's slowest real answer was 20.4 s) is a vendor failure, never a miss.
- Each client takes an optional tighter timeout from a caller with a request budget.
  VENDOR_TIMEOUT in lib/constants.ts. Mutations: every client, all red.

## 2026-09-22 (c): Tier 1 Phase 1, Task 3: D6 name match, no persons[0] fallback.

- parsePersonTraceResponse returns a person only when the name matches the owner we asked about
  (last name equal, first initial equal, after dropping case, punctuation, JR/SR/II/III/IV and
  middle names; order not swapped, D22). A hit with no match returns no contacts, nameNotMatched,
  how many people came back and the vendor's credits, for the step log (never their names, D29).
- Both contact parsers read credits_deducted. Every refusal of our own input (no name, no city, no
  state) is marked inputError so it can never be reported busy.
- New constructed fixtures for trace/parcel/lookup/ (hit and miss); the parcel request shape is
  pinned to parcel_id, county and state. Mutations: all red.
- Checked against every saved Instant and parcel response in tasks/research-test/ with
  tasks/research-scripts/phase1/check-person-parser.ts (counts only, broken down by source study
  and by which field produced the name to match on): 20 total responses (13 parcel study, 2
  Instant study, 5 phase0), 3 name_matched, 11 name_not_matched, 6 miss, 0 parse_failure, no
  unexpected top-level keys. `want` is the saved request's own first_name/last_name whenever the
  request carried them (every Instant named lookup); only when the request carried none did `want`
  fall back to splitting the study's recorded owner name the way planRoute's person steps do. All 3
  hits tested against a name matched: both Phase 0 Tier 1 hits (t1_address_tracerfy,
  t1_apn_tracerfy) and the Instant study's one hit. The 11 name_not_matched hits are all in the
  parcel study: none of its 13 saved requests carried names (captured before Task 2 added them to
  the parcel step), and for all 11 the study's results.json has a row for that parcel but no
  owner_name value on it, so nothing was available to match against. The other three phase0
  responses were misses (t1_nothing_found, dossier_commercial, dossier_land).

## 2026-09-22 (b): Tier 1 Phase 1, Task 2: one classifier and the Tier 1 ladders.

- classifyOwnerName: a trailing TR or TTEE is a trust, not an entity, so trustee names reach the
  trust ladder; a trailing TRS stays an entity (spec D30). TRUST_MARKER also knows REVOCABLE,
  IRREVOCABLE, U/A and DTD.
- planRoute Tier 1: person gets the Instant lookup then the parcel lookup (D2); company gets
  FastAppend only (D4); trust and unknown get the person steps (trust words stripped) then
  FastAppend on the full name (D3); no first name or initial left goes to FastAppend only (D16).
  The parcel step now carries the owner names for the match. The "cheaper address-keyed path"
  warning is gone.
- A trust-only dossier owner now reaches FastAppend in the Tier 2 second pass (two executeRoute
  tests updated). Mutations: seven, all red.
- Departs from spec 4.2's text on one point, on purpose: maxVendorCost stays the SUM of the steps,
  not the Tier 2 "only one can hit" figure, because under D6 a non-matched person hit is billed by
  the vendor, so every step can cost. Nothing reads the field today.

## 2026-09-22 (a): Tier 1 Phase 1, Task 1: outcome, found-by and step-log columns.

- Migration 20260922_trace_history_tier1_outcome.sql adds trace_history.outcome_code, found_by and
  trace_steps (all nullable) and an index on (user_id, parcel_id_local, county). Applied with
  supabase db query and read back: three columns, the index, and anon and authenticated still
  SELECT only.
- types/index.ts gains TraceResult.name_verified (D21 b) and the new TraceHistory columns.

## 2026-09-21 (h): Tier 1 Phase 0 live run, eight records, one per path (spec D19, D20).

- David approved $2 (D20). Spent $0.90: Tracerfy 40 credits ($0.80), matching the account balance move
  exactly (10,649 to 10,609), plus one FastAppend hit ($0.10). Report: tasks/phase0-small-sample.md (counts
  only); raw requests and responses in tasks/research-test/phase0/ (gitignored).
- Worked: Tier 1 Instant by address (NY Broome, name matched, 4 phones); Tier 1 APN lookup with no city (LA
  East Baton Rouge, parish name accepted, name matched, 9 phones 2 emails); dossier on a UT Washington
  multifamily (APN key) then FastAppend on the entity owner (3 people, 6 phones 3 emails); an absent parcel
  id came back as an ordinary free miss.
- Did not find: FastAppend on two Tier 1 LLCs (NY Monroe, OH Summit) answered 404 "Company not found",
  free, treated by production as a miss. Dossier found individual owners on MD Wicomico (address key; the APN
  key missed) and CA Shasta (APN key), but the second lookup (D15) missed on both, while the dossier's own
  contacts block held 10 phones 4 emails and 7 phones 5 emails.
- Found while picking: registry parcel ids for MN Ramsey carry a "27123-" prefix and NY ids are 26 digits;
  production sends them as stored. The registry busy check must ignore supabase_admin/postgres_exporter.
- Latency: most lookups 0.2 to 2 s; one Instant second lookup took 20.4 s; FastAppend up to 5.2 s.

## 2026-09-21 (g): Tier 1 Phase 0 cut to one record per path (spec D19); small runner written.

- David cut Phase 0 to eight records, one per lookup path; the eleven GATE A questions wait for the test after
  the Phase 1 changes.
- tasks/research-scripts/phase0/run-small.ts makes one production vendor call per record, records every raw
  request and response under tasks/research-test/phase0/, and refuses --live without David's approved amount.
- Nothing spent.

---

## 2026-09-21 (f): TIER 1 SEARCH TYPE RECONCILED. Spec D13-D18; Phase 0 re-planned before any spend.

- **What went wrong.** 2026-09-20 David said "WE ARE NOT USING THE NORMAL TRACE in Tracerfy anymore, We
  are using Advanced or Dossier" and was told PTP never used Normal. False: `submitSingleTrace` and
  `submitBulkTrace` (lib/tracerfy/client.ts:85, :716) post to `trace/` with no `trace_type`, which is Normal.
  The 2026-09-21 design session offered Tier 1 as Normal batch (1 credit) versus Instant (5 credits), never
  Advanced, and the spec recorded Instant without saying so. The Phase 0 session then planned around it and
  wrote nine rulings into a gitignored ledger instead of asking. Lessons L-021, L-022, L-023.
- **Read in full** the Tracerfy docs (live copy identical to docs/vendor/tracerfy-api.md bar one example
  date) and FastAppend's own API docs. Advanced is batch only, 2 credits per lead, and still REQUIRES a city
  (:564); the APN lookup is the only Tracerfy person path with no city. The dossier returns the owner AND
  contacts; PTP discards the contacts (dossier.ts:173).
- **David's decisions, recorded in his words as spec D13-D18:** Instant for a Tier 1 individual with a city;
  Tracerfy never supplies an entity's contacts; a dossier-found individual gets a second, name-matched
  Tracerfy lookup; no first name or initial goes to FastAppend as an entity; multifamily and every no-owner
  record come from the registry, with the user told it went to the dossier; name order fixed per county in
  Phase 1.
- **Measured (read-only registry, counts only):** 52 of 55 shortlisted counties store owner names LAST FIRST;
  UT Washington and Cache carry no owner names; Louisiana holds 2 of 64 parishes (East Baton Rouge,
  Jefferson); NY Onondaga and Broome are about half without a city. County shortlist committed at
  tasks/phase0-county-shortlist.md, built from the registry inventory.
- **Phase 0 plan rewritten** to match (G1 individuals incl. no-city parcels, G2 trusts under D16, G3 no-owner
  records across property types through the dossier, G4 unrecognized-APN probes; raw responses captured;
  GATE A county picks, GATE B spend, GATE C findings). Tasks 1-2 stay done; Task 2 awaits review. $0 spent.

---

## 2026-09-21 (e): Tier 1 Phase 0, Task 2. Name-match prototype and spend guard.

- Implemented three pure functions for Phase 0 measurement: stripTrustWords (removes trust words, dates, and normalization from owner names), personMatchesOwner (judges vendor person against owner, measuring two shapes: LAST FIRST order and surname-only trust stripping), and affordable (spend guard ensuring worst-case cost fits under cap).
- Self-test verifies name matching never falls back to persons[0], covers NATURAL / SWAPPED / SURNAME_ONLY match kinds, and guard logic is inclusive of cap.
- Mutation testing proved the refusal assertion is load-bearing: changing final return from null to 'natural' failed the Mary Jones test case, confirming the guard against false positives.

---

## 2026-09-21 (d): Tier 1 Phase 0, Task 1. The APN step's names are not sent to Tracerfy.

- Spec section 4.2 (person step 2) corrected: the owner's first and last name travel with the step for PropTracerPRO's parser to match on them, and are not sent to Tracerfy, whose parcel endpoint takes only parcel_id, county, and state.
- Tier 1 tracking section added at top of tasks/todo.md with Phase 0 through 4 plan checklist.
- Phase 0 plan file committed: docs/superpowers/plans/2026-09-21-tier1-phase0-measurement.md
- Merging `feat/contact-vendor-provenance` is tracked in the todo section as an open item for David.

---

## 2026-09-21 (c): THE VENDOR LABEL IS READ, NOT GUESSED, AND IT IS OURS. Phase 2.

Branch `feat/contact-vendor-provenance`. **1517 passing / 75 files / 0 failing**, `tsc` 0.
Suite Gateway verified alongside: 1461 passing / 24 skipped, unchanged, on branch
`chore/ptp-drops-owner-contact-source`.

**THE LABEL NOW READS A FACT.** `resolveOwnerContact` prefers `trace_history.contact_vendor`
and only infers when it is absent. Name resolution is UNCHANGED: the chain still decides who
the contact is, and the recorded vendor only decides what we call the source. A recorded
vendor is not a contact, so a row that reached nobody still returns nulls.

The inference could not be fixed by reordering. A tier 2 FastAppend hit puts its contacts in
`trace_result`, where tier 1 already puts them, and never writes `ai_research`, so the
FastAppend rung could not fire and the Tracerfy rung always did. Both vendors land in the same
field; only a recorded lane separates them.

**AND IT IS NO LONGER THE CUSTOMER'S.** `owner_contact_source` is removed from all five
surfaces it reached: the v1 REST bulk status, the `bulk_job.completed` webhook that shares that
builder, `ptp_bulk_status`, `ptp_list_traces`, and the documented ones, which were the in-app
API docs page, `docs/AGENT_BULK_INTEGRATION.md` including its field-meaning table, and the MCP
tool description that told a calling agent the field existed.

**THE FALLBACK IS NOT DEBT.** 3,836 of 3,838 rows predate the column and came from Tracerfy
normal search or AI Search with FastAppend. They keep the label they have always carried rather
than acquiring one derived from nothing.

**TWO MUTATIONS THAT ESCAPED, AND WHAT THEY TAUGHT.**

The first: leaving `contact_vendor` in the `listTraces` spread SURVIVED, because the fixture
did not carry the column, so there was nothing to leak. A negative assertion with no positive
control, in a test written the same day as the lesson about exactly that.

The second: dropping `contact_vendor` from the `listTraces` select also survived. Chasing it
found the real answer, which was that selecting it there was a mistake. That tool emits the
name and not the source, and the NAME does not depend on the vendor. Selecting it added a
column that had to be destructured out of `rest` on pain of leaking, in order to influence a
value the tool never returns. Reverted. The label is read from the column where it is needed,
which is `trace_history` itself.

**FENCED, ALL MUTATION-VERIFIED RED:** spreading `resolveOwnerContact` back into the
`listTraces` payload; re-adding `owner_contact_source` to the v1 twin alone, which
`payloadParity.test.ts` catches.

**HONEST LIMIT.** With the source emitted nowhere, the corrected label has no customer-visible
effect. `buildPerRecordResult` still calls `resolveOwnerContact` and discards the source. What
is live is the recorded column and a function that is now right when anything internal asks it.

---

## 2026-09-21: THE ENTITY LANE STOPS AT FASTAPPEND. The Tracerfy salvage submit is removed.

Branch `feat/contact-vendor-provenance`. **1510 passing / 75 files / 0 failing**, `tsc` 0. One
test replaced by two, so +1 on the 1509 this branch had.

**DAVID'S RULING, 2026-09-21, verbatim because it is the whole reason:** "DO NOT send a
fastappend contact to Tracerfy. This will produce no new results and waste time. Fastappend is a
tracerfy company and if the contact info is not found in Fastappend, it will not be found in
Tracerfy either. Even if the contact is found in FastAppend, and that contact has no email or
phone, it gets treated as null result and the search is free for tier 1."

**WHAT WAS THERE.** When FastAppend returned a named principal but no phone and no email,
`sweep-entity-traces` submitted a per-row Tracerfy person skip-trace on that name. 42 lines,
including its own failure arm and a `tracerfy_job_id` write that handed the row to the status
poller. A second vendor call, on a row the first vendor had already failed to deliver, against a
database owned by the same company.

**WHAT IT IS NOW.** FastAppend answers or it does not. No reachable contact is a null result: the
row settles `no_match`, free, terminal. Whether a principal was named no longer changes anything,
so the `!resolvedPerson` branch became unconditional.

**HOW THIS WAS FOUND, and it was not by reading the code.** I told David the fall-through existed
and described it as "FastAppend is asked only to name the owner and a Tracerfy person submit
supplies the contacts afterwards". He read that and said it was not the workflow. He was right
about the primary path and my sentence was wrong: `if (fastAppendCredit) { ... continue; }`
terminates the row and its own comment says FastAppend's contacts "are what the user paid for".
What I had actually been looking at was the narrower residual branch. Surfacing it got it deleted.

**DEAD CODE REMOVED WITH IT:** the `submitSingleTrace` import, the `resolveOwnerContact` import
and its call (its only consumer was picking a name for the submit), the `resolvedToPerson`
counter and its field on the cron's JSON response, and `streetAddress`, which had no consumer
left once the submit went. This lane now keys FastAppend on the company name and state alone.

**Mutations run, both red.** Re-adding a `submitSingleTrace` call on the no-contact path reds the
test that pins the ruling; dropping the terminal `no_match` write reds three.

---

## 2026-09-21: RECORD WHICH CONTACT VENDOR RAN. Phase 1 of retiring the `ai_research` name.

Branch `feat/contact-vendor-provenance`. **1509 passing / 75 files / 0 failing**, baseline was
1502, so +7. `tsc` 0. An eighth migration, `20260921_trace_history_contact_vendor.sql`, is
APPLIED to production and read back.

**THE DECISION THIS TIER TURNS ON WAS UNAUDITABLE.** An entity owner goes to FastAppend, an
individual to Tracerfy, a trust to neither. Nothing durable recorded which way a row went.
`executeRoute` builds a `StepReport` per step carrying the vendor and the crons dropped it at the
database boundary. There is no vendor column, and `VENDOR_COST.FASTAPPEND_ENTITY` and
`VENDOR_COST.TRACERFY_INSTANT` are both 0.10, so `cost` cannot separate them either.

**WHAT IT COSTS TODAY, measured on a real row.** `owner_contact_source` is computed on read by
`resolveOwnerContact`, whose FastAppend rung looks in `ai_research.business_trace_contacts`.
Tier 2 never writes `ai_research`, so that rung cannot fire and EVERY tier 2 FastAppend hit
reaches customers labelled `person_trace`. Trace `5ec0cf47-6844-4514-9029-53a0b6f34cd0`,
2026-09-20: county owner `Estates Ave Properties Llc`, classified `entity`, routed
`FASTAPPEND_ENTITY`, reported `person_trace`. The label fix is Phase 2; this is the fact it needs.

**THE FACT WAS ALREADY IN MEMORY, only discarded.** So `contactVendorFrom(steps)` reads the
reports `executeRoute` already writes rather than threading a parallel field that could disagree
with them. `CONTACT_VENDOR_BY_STEP` is a full `Record<StepKind, ...>`, so a new step kind is a
compile error until somebody classifies it.

**ASKED, NOT PRODUCED.** A lane that ran and missed still answers the routing question, and a miss
leaves no contact name to mislabel anyway. `skipped` is excluded: that is the record of a question
we chose not to ask. NULL means no contact vendor was asked, the trust and unknown case.

**DEVIATION FROM THE PLAN, deliberate.** The plan said to write the column at both
`sweep-entity-traces` sites, `:436` and `:465`. Only `:436` was written. At `:465` FastAppend is
asked only to NAME the owner and a Tracerfy person submit supplies the contacts afterwards, so
writing `fastappend` there would name the wrong vendor. Tier 1 person rows keep NULL and their
existing `person_trace` label, which is correct for them.

**NO BACKFILL, deliberately.** The 3,838 existing rows have no recoverable vendor: the step
reports were never persisted and cost cannot discriminate. A NULL that honestly means "not
recorded" is the point.

**Mutations run, four red and one escaped as predicted.** Classifying a dossier step as a contact
vendor, mapping the entity lane to the wrong vendor, counting `skipped` as asked, and dropping the
contact-step filter all went red. Last-match-instead-of-first survived and is an equivalent
mutant: `planRoute` emits the entity step or the individual steps and never both, so first and
last are the same answer. One test of my own was deleted rather than shipped, an assertion
`not.toBe('dossier')` that could not fail; the dossier mutation still reds four tests without it.

**FOUND WHILE READING THE ACL BACK, not fixed, not in scope.** `trace_history` is
`anon=rDxtm/postgres`. The `D` is TRUNCATE, alongside REFERENCES and TRIGGER. The 2026-09-18
lockdown removed insert, update and delete and left those. RLS does not gate TRUNCATE. Not
reachable through PostgREST, which has no TRUNCATE verb, so this is a wrong grant rather than a
live hole. Recorded for David.

---

## 2026-09-19: THE DOSSIER'S SECOND LOOKUP KEY. `DOSSIER_APN` fires for the first time since it was written.

`main` = `e48d5c7`, 2 commits. **1502 passing / 75 files / 0 failing**, `tsc` 0, eslint 47, build
compiles. Baseline before was 1489, so +13. A seventh migration,
`20260919_trace_history_parcel_key.sql`, is APPLIED to production and read back.

**THE HEADLINE: a step that has existed for three days had never once executed.** `planRoute` has
emitted `DOSSIER_APN` alongside `DOSSIER_ADDRESS` since `40ea107` on 2026-09-16, stopping at the
first hit. `hasApn()` requires `parcelIdLocal` AND `county`, and `parcelForFullTrace` is the only
builder any tier 2 entry point uses. It set neither. Its own docblock said so: "Nothing in PTP
produces a parcel id today: every entry point is address shaped." **So the address was never the
fallback. It was the only key that had ever fired.**

**WHO ASKED, AND WHY IT MATTERS.** The Suite Gateway holds a county parcel id for every registry
parcel (`CuratedProperty.parcel_number_1`, sourced from the property registry's
`parcel_id_local`) plus the county name, and had no field to send them in. David ruled 2026-09-19:
send both keys, as `planRoute` was built to use.

**THE KEY IS THREE PARTS: `apn`, `county`, `state`.** Not two. `state` was already required on
`recordSchema` and already mapped onto `ParcelInput.state`, so it completes on its own once the
other two arrive. This is written in capitals because the consumer spec described it correctly
once and then called it "two fields" three times running before David caught it. Two mutations now
pin the request shape, because **the vendor answers a malformed key with a MISS, and a miss is
free, so a two-part request would have shipped and found nothing and cost nothing, forever, with
no error anywhere.**

**NOT AN UPGRADE OVER THE ADDRESS KEY, and nothing may say it is.** The two fail independently:
Napa hit on APN and missed on address, Salt Lake did the exact reverse. Sending the parcel id adds
a second independent attempt at the same parcel. Since a dossier miss is free at the vendor, the
second attempt costs nothing unless it works. Neither key is the senior partner.

**WHY A MIGRATION WAS UNAVOIDABLE.** The tier 2 queue separates submit from execution: an MCP
submit writes a `trace_history` row, and `sweep-property-traces` buys the dossier up to a minute
later, rebuilding the parcel from that row alone. It read `normalized_address`, `city`, `state`
and `zip` and nothing else, so a parcel id supplied at submit had nowhere to live.
`normalized_address` was not an option (it is the sha256 dedup key; anything added re-buys every
row forever) and neither was `property_record` (that is the raw 86-key vendor OUTPUT, and the raw
dump is the product). Two nullable columns, `parcel_id_local` and `county`. No grants needed:
`ADD COLUMN` inherits the table ACL and `20260918_lock_trace_history_writes.sql` already left
`anon` and `authenticated` with SELECT only. The ACL was read back and every value accounted for,
including four pre-existing grants traced to Supabase project-wide defaults by comparing against
an untouched table.

**SCOPED TO THE MCP SUBMIT, deliberately.** `v1/trace/bulk` and the dashboard's `trace/bulk` also
enqueue tier 2 rows and are NOT wired. Giving either a parcel id means adding a public API field
or a CSV column, which is a product decision about those surfaces rather than about this seam.
Named here rather than left looking like an oversight, per L-018.

**TWO MUTATIONS SURVIVED THE FIRST PASS AND WERE CLOSED.** Deleting the two lines that pass `apn`
and `county` into `parcelForFullTrace` inside the cron left `tsc` clean and all 1499 tests green.
That is the whole feature silently reverting to address-only with nothing to notice it, and the
cron is the ONLY place the parcel id ever reaches the vendor. Closed by extracting
`parcelForRow(row)` as an exported pure function and testing it directly rather than standing up a
route harness. Both mutations now red in vitest, not merely in `tsc`. See L-020.

**LIVE VERIFICATION: RUN AND PASSED, 2026-09-19, authorised by David. Cost $0.20 (10 credits).**
Script kept at `tasks/research-scripts/verify-apn-key.ts`. It exercises the real wiring, not a
reconstruction: `parcelForRow` on a row shaped as the cron reads one, then `planRoute`, then two
live `lookupDossier` calls.

| | |
|---|---|
| `parcelForRow` produced | `parcelIdLocal "003330004000"`, `county "Napa"`, `state "CA"` |
| `planRoute` emitted | `DOSSIER_APN, DOSSIER_ADDRESS` |
| APN request on the wire | `{"apn":"003330004000","county":"Napa","state":"CA"}` |
| ADDRESS mode | **MISS**, 0 credits, free |
| APN mode | **HIT**, 10 credits, $0.20 |
| owner of record returned | `John Anthony Investments Llc` |
| property keys returned | 86 |

**The APN key resolved a parcel the address key could not**, which is the exact claim and the
reason this parcel was chosen. Napa was measured on 2026-09-16 as hitting on APN and missing on
address; that reproduced exactly, three days later, through the new code path.

**GOTCHA FOUND BY THE RUN, and it has teeth. THE VENDOR RETURNS A DIFFERENTLY FORMATTED APN THAN
THE ONE YOU SEND.** We sent `003330004000` and `property.apn` came back `003-330-004-000`, dashed.
The situs came back reformatted too: we sent `1440 FIRST ST` and got `1440 1st St`. Anything that
compares a returned identifier against the one submitted **must normalise before comparing**, or
it will report a mismatch on every single row. This matters immediately for the Suite Gateway's
proposed check of `property_record.apn` against the registry's `parcel_id_local`: a bare string
comparison there would flag every correct match as wrong.

---

## 2026-09-18

### PTP stops pushing to the CRM on its own. All eight automatic sites removed.

Commits through `2f95896`. **1489 passing from 1493, 75 files, 0 failing**, `tsc` 0, eslint 47,
build compiles. The total DROPPED by 4 and that is deliberate, not a regression: 12 old push tests
and 5 dead-code tests removed, 13 fences added.

**WHY, and it is David's reason, not a preference.** Most PTP users reach their CRM through the
**Suite Gateway**, which holds the GoHighLevel snapshot and knows the object model: an entity owner
becomes a **Company**, a person becomes a **Contact** and only when there is a phone or an email, and
the property hangs on the property custom object. **PTP's own push only ever creates Contacts.** So
an automatic PTP push writes the WRONG OBJECT TYPE into a gateway user's snapshot, and a user with no
gateway has no snapshot for it to populate correctly either.

**THIS WAS ALREADY DECIDED AND I MISSED IT.** The 2026-09-16 handoff says, in the section I read at
the start of this session: *"PTP's own direct HighLevel push is being DROPPED, not built."* When
David said Full Property Trace needs to reach the CRM, I extended that push rather than reconciling
the instruction against the decision already on the page, and added three more automatic sites to a
feature marked for removal. **The lesson is not "read the handoff"; I did read it. It is that a new
instruction has to be checked AGAINST the standing decisions, because an instruction phrased as a
goal ("X needs to reach Y") does not announce which mechanism it means.**

**Removed: eight automatic sites**, each with its import, its call, and the credential read that fed
it. `trace/status`, `v1/trace/status`, `trace/bulk/status`, `v1/trace/bulk/status`,
`sweep-stale-traces`, `sweep-property-traces`, `trace/single`, `v1/trace/single`.

**Deleted as genuinely unreachable, each checked rather than assumed:** `lib/highlevel/pushSettledTrace.ts`
entirely, `recordHighLevelPushes` and `settleAndRecord` and the `after()` scheduling in
`credentialHealth.ts`, `HighLevelPushEntry`, the v1 bulk "skip an already-pushed row" guard, and
`TraceHistoryRow.highlevel_pushed_at`. **The COLUMN and the manual push's write of it stay.**

**A NINTH caller exists and correctly stays.** `app/api/verify-member/route.ts` calls
`verifyAcquisitionProMember`, fired by an onClick in onboarding. A person asked, so it is not an
automatic site. Twelve production files reach HighLevel: 8 automatic (gone) plus push, save, test and
verify-member, all person-initiated.

**SURVIVES, verified byte-identical by diff:** the manual route
(`app/api/integrations/highlevel/push/route.ts`, including the `effectiveIsPro` gate David kept and
the `trace_job_id` fix that lets it see tier 2 rows), the CSV export, and
**`lib/suite/mcp-tools.ts`**. That last one matters most: when the gateway sends a single or bulk
request over MCP, results still flow back with no human step. Confirmed before the work that the MCP
surface has no HighLevel import and that the only MCP references inside the eight route files are
prose comments.

**FIVE COPY CLAIMS HAD GONE FALSE ACROSS FOUR PAGES, and the brief's list named two of them.** The
implementer grepped the property instead. The one that mattered most was on the **landing page
pricing feature list**, "HighLevel CRM auto-push", which is the only false claim that was attached to
money. Also the Pro upsell, an integrations note that had ALREADY been narrowed once earlier the same
day and was still wrong, the Make tip and n8n comment on the API docs page, and an FAQ sentence
promising a hands-off chain. Copy now names the button a user actually sees.

**Two self-caught test defects worth recording.** The implementer's first fence for
`sweep-property-traces` asserted on a field the recorder does not have, so it was vacuously green;
found by reading the recorder's shape rather than by the suite. And three old `trace/status`
credential tests PASSED after the removal because they asserted "no flag was written" and now nothing
writes one. Green by default, guarding nothing, removed rather than kept as decoration.

**Coordinator verification, independent of the report.** All eight sites carry a fence. Re-injecting
an automatic push into `trace/status`, at the exact block it used to occupy, turns **20 red** with the
total held, which is what proves the fences are not vacuous: a `not.toHaveBeenCalled()` is satisfied
for free if the test never drives the route that far. Disabling the manual bulk push turns 11 red. An
earlier attempt at that second mutation dropped the total to 1460 and was discarded as an INVALID RUN
rather than read as a result (L-012).

**A CONSEQUENCE TO KEEP IN VIEW: the credential-health flag now only updates when a person acts.**
Phase B's whole argument was that five push paths had nobody watching. Those paths are gone, so the
flag is written by the manual push and by save validation only. That is not broken, and it is
arguably better since a user is present to see it, but the justification is now much narrower than
what History records one entry above.

---

### Full Property Trace reaches the CRM

Commits `eba223c` (migration), `09371fe`, `1def747`, `eadc678`, `16abb6c`, `5841673`.
**1493 passing from 1456, 75 files, 0 failing**, `tsc` 0, eslint 47, build compiles. A sixth
migration, `20260918_trace_highlevel_push_record.sql`, APPLIED and read back.

**FIRST, A CORRECTION TO WHAT I TOLD DAVID.** I reported the gap as "Full Property Trace results
never reach the CRM", blamed on `sweep-business-traces` and `sweep-property-traces` not reading the
credential columns. That was wrong three ways, and the corrected version is what drove the design:

- **`sweep-business-traces` is TIER 1**, a FastAppend recovery path. Naming it was a misattribution.
- **"Never" was false.** v1 BULK pushed tier 2 already, because it iterates ROWS of the job rather
  than Tracerfy's batch array. The manual button also worked for a tier 2 single.
- **My follow-up guess was also wrong.** I said the single production tier 2 row settled via
  `trace/status` and therefore pushed. `trace/single` settles tier 2 INLINE and `trace/status`
  returns early on a terminal status, so it never saw it.

**The corrected gap was WIDER than the original claim:** automatic push fired for tier 2 on exactly
ONE of five surfaces.

**THE ROOT CAUSE, one sentence: push was attached to JOB settlement, which reads Tracerfy's batch
array, not to ROW settlement.** A settled tier 2 row has `tracerfy_job_id: null`, so every push list
built that way was blind to it. v1 bulk worked because it iterates rows. The fix is therefore one
idea and not five patches: **push where the row settles.** `sweep-property-traces` alone covers
session bulk, v1 bulk AND MCP bulk, since all three enqueue into the same queue column.

**THE GUARD IS THE PART THAT PROTECTS CUSTOMERS AND IT IS `isSuccessful && result`.** The implementer
found a shape my brief did not have: besides `property_trace_no_reach`, a contact-vendor MISS also
settles with a NON-NULL `trace_result` carrying the owner of record and EMPTY phones and emails.
**Under a bare `trace_result != null` both would push a nameless, contactless contact into a
customer's CRM.** Coordinator-verified: dropping the `is_successful` half turns 4 tests red.

**FIVE MUTATIONS SURVIVED ON THE FIRST RUN and were reported, not buried.** All seven push sites were
wired to record the trace id; only two were fenced. Stripping the id from the other five turned
nothing red, meaning those sites could have pushed to a CRM and recorded nothing, green forever.
Fixed with one assertion per site and re-killed. **This is L-016 inside the mutation run** and it is
now L-018: when a change touches N call sites, the mutation count is a function of N, not of the
brief, and a well-tested shared helper does not fence its callers.

**TWO EQUIVALENT MUTANTS, correctly NOT claimed as kills.** One of the implementer's and one of
mine: removing the `!result` half of the guard survives every test, because the shape it guards
(`isSuccessful` true with a null result) cannot be constructed without a type error. Verified by
running `npx tsc --noEmit` on the mutant and reading the TS2322, rather than by asserting it.
Reported as equivalent with evidence instead of being "fixed" by a test that casts its way into an
impossible state.

**THE CRON PUSHES INLINE, NOT DEFERRED, and this is the opposite of Phase B.** Deferring through
`after()` let the cron write the row terminal and return before `highlevel_pushed_at` landed. The
parent job can finalize on the very next poll, and the double-push skip READS that timestamp, so
deferring raced the fact the skip rests on. Request paths still defer, because a customer must not
wait on HighLevel. Both answers are right somewhere, so `timing` is a REQUIRED parameter rather than
a defaulted one.

**Task 5 was already closed by task 1, and the evidence is a grep rather than an argument.**
`sweep-stale-traces` updates `trace_jobs` ONLY in its all-tier-2 branch and touches no
`trace_history` row, so there is nothing there to push; by the time it runs the queue has drained and
every successful row was pushed at settle. **No push was added there**, which would have
double-pushed.

**The push is now recorded at all seven sites** (`highlevel_contact_id`, `highlevel_pushed_at`,
`highlevel_push_action`), so "did this trace reach the CRM" is answerable for the first time since
January, double-push avoidance rests on a fact about the row rather than a filter matching a code
path, and a retry becomes writable. **The columns only record from now on**: 2,742 historical traces
belonging to the six credentialed users stay null, which is correct and must never be rendered as a
claim that they did not reach the CRM.

**Also fixed:** the manual JOB button selected rows by `tracerfy_job_id`, which a tier 2 row does not
have, so a mixed job pushed only its tier 1 half silently and an all-tier-2 job said "No successful
results to push". It now selects by `trace_job_id`. **`effectiveIsPro` was left untouched**: David
considered opening the manual push to pay-as-you-go, who pay $0.40 against Pro's $0.25, and decided
it stays a Pro benefit.

**DECIDED BY DAVID 2026-09-18: PTP PUSHES WHAT IT SETTLES, and the MCP asymmetry stands.**
MCP bulk is now asymmetric. Its tier 2 rows reach
the CRM through the shared cron, while its tier 1 rows still do not, because the MCP finalize path
has no push at all. Note the boundary this touches: the 09-16 handoff records that the Suite Gateway
owns the CRM push for MCP callers via `crm_push_owners`, so PTP pushing MCP-submitted rows directly
is a change of ownership, not just a gap being filled.

**David's ruling and the reasoning to keep:** a user who configured HighLevel credentials IN PTP
asked PTP to push their traces, so PTP pushes what it settles regardless of which surface submitted
it. The gateway's `crm_push_owners` remains available and is user-initiated, so the two do not race;
the worst case is a second push landing as an UPDATE, which since the tags fix no longer overwrites
anything. **The asymmetry is accepted, not overlooked:** MCP tier 1 rows still do not push, because
the MCP finalize path has no push and adding one was the larger expansion David declined.

---

### HighLevel push honesty, Phase B: the credential tells the truth

Commits `d53eaa2`, `f89eb21`, `3b9f3c7`, `fcae3fc`. **1456 passing from 1367, 75 files, 0 failing**,
`tsc` 0, eslint 47 (baseline held), build compiles. 15 mutations from the implementer plus 8 run
independently by the coordinator; all killed, every total held, every restore sha256-verified.

**Migration `20260918_highlevel_credential_health.sql` APPLIED to production and read back.** Three
columns on `user_profiles`: `highlevel_invalid_at`, `_status`, `_reason`.

**THE CHANNEL THAT DID NOT EXIST.** Five of the seven push sites run with nobody watching, so there
was no synchronous place to report a dead key. The outcome is now recorded against the CREDENTIAL,
on a row the integrations page reads, so the user finds out on a page they will visit.

**Only the credential class writes, and the asymmetry is the subtle half.** A record failure (a bad
payload) and a transient failure (a rate limit) say NOTHING about the credential and write nothing;
flagging on either would send a user to reconnect a key that works. And **"not dead" is not
"alive"**: a batch of nothing but rate limits is `no_signal`, not `healthy`, because clearing a red
badge needs evidence the key WORKS, which only a success provides. A batch is ONE decision, so a
fifty-record push does not produce fifty writes.

**Clearing on success is REQUIRED, not a nicety.** HighLevel scopes are editable on an existing
token, so a user can fix a scope problem without ever saving anything in PTP. If only save cleared
the flag, that user stays red forever while their pushes work.

**THE SAVE POLICY IS NARROWER THAN "REFUSE ANY 401", and deliberately so.** The only check available
is a contacts READ and every product call is a WRITE, with `contacts.readonly` and `contacts.write`
as separate scopes. So a failed read does not always prove a failed write:

| reason | | why |
|---|---|---|
| `token` | **REFUSE** | a rejected token is rejected for every verb |
| `location` | **REFUSE** | the wrong location is wrong for every verb |
| `scope` | SAVE, warn | the token may hold `contacts.write` and push perfectly |
| `transient` | SAVE, warn | HighLevel being down is not the user's fault |
| `unknown` | SAVE, warn | we could not read the refusal, so we assert nothing |

Everything saved without confirmation carries a warning naming what we could not confirm. **David's
stated decision was "refuse on 401/403"; this narrows it**, on his own reasoning for choosing that
option, which was that a good credential must not be blocked. Flagged to him rather than done
quietly.

**`setTestResult(null)` is gone.** A save outcome now REPLACES the test outcome with its own honest
result instead of blanking it, so pressing Save can no longer erase a red "Invalid API key" the user
has already been shown.

**The scope copy names both scopes** and says why: Test Connection only reads, so a token with just
`contacts.readonly` passes the test and then fails every push. It also notes scopes are editable on
an existing token, so a misconfigured user does not need to re-paste a credential.

**R1, the false sentence, is fixed and it was in THREE places, not one.** The plan named
`page.tsx:389`. `settings/api-keys/docs/page.tsx` carried the same claim twice more, once in a tip
explicitly about Full Property Trace, which is exactly the tier that does not push. That is the same
page L-016 records as last phase's miss, found the same way: by grepping the property instead of
working the list.

**A MUTATION SURVIVED FIRST and was reported rather than buried.** Deleting the recorder from the
manual push route turned nothing red: that route's test mocked an admin client with no `update`, so
the write went into the void and the try/catch swallowed it. Seven tests added through the real
recorder; re-run kills it.

**COORDINATOR FINDING, fixed in `fcae3fc`: the write could be killed with the response.** The five
automatic sites were left as bare floating promises. On serverless, work still running when the
response flushes can be cut off, and the old code only stood to lose a `console.error` while this
stands to lose the flag itself, which is the whole channel. **The repo already had the answer**:
`lib/suite/access.ts` has used `after()` from `next/server` for the entitlement refresh for months,
fallback included. Copied rather than reinvented.

Worth recording HOW those two tests were proved, because the first run was misleading: both failed
initially on a `ReferenceError` (a fixture name I assumed rather than checked), which is a failure
for the WRONG REASON and proves nothing. Both were then mutation-proved separately. The fallback
test does NOT bite the revert-to-floating-promise mutation, since both implementations run inline
once `after()` throws; it bites a different one, where the catch drops the write. Recorded rather
than counted as a second kill for the first mutation.

**Also done, not in the brief:** disconnect now clears the three health columns. Without it a user
who disconnected and reconnected during a HighLevel outage would see the OLD key's specific
remediation attached to a brand new key, since a save we cannot verify deliberately does not clear
the flag.

**Verified rather than assumed:** all seven push sites are paired with a recorder call, confirmed by
grepping both sets independently. The implementer tested one automatic path and reasoned the other
four were "the identical two-line shape", which is the L-016 assumption; the grep says it holds.

---

### HighLevel push honesty, Phase A: the client says WHY, and the button stops lying

Branch `fix/highlevel-push-honesty`, commits `1dc09ca` (plan), `c5a61dd` (Phase A), `a7962b6`
(tags). **1367 passing from 1306, 70 files, 0 failing**, `npx tsc --noEmit` 0,
`npx eslint app lib components` 47 (baseline), `npm run build` compiles. 7 mutations run
independently by the coordinator on top of the implementer's 6; all killed, every total held,
every restore sha256-verified.

**Blast radius read from production, not from a document: 6 of 53 users** have both
`highlevel_api_key` and `highlevel_location_id` set.

**The handoff named three bugs. All three were confirmed against source, and grepping for the
PROPERTY rather than working the list (L-016) found six more.** Two of the six are worse than
anything on the list:

- **The duplicate-search step had no `else`.** `client.ts` tested `searchRes.ok` and, on a failure,
  left `existingContactId` null and fell through to the CREATE branch. So a credential failure on
  search silently turned "update the existing contact" into "create a second copy", and if the
  credential was only partly broken that duplicate SUCCEEDED. Now a refused search returns the
  classified failure and never reaches create: a failed search means we do not know whether the
  contact exists, and creating on unknown state is inventing a result.
- **Saving erased a failure the user had already been shown.** `saveHighLevel` runs
  `setTestResult(null)`, so pressing Test Connection, getting a red "Invalid API key", and pressing
  Save cleared the banner and turned the badge green in the same tick. Recorded for Phase B.

**THE ORGANISING DISTINCTION, and it is L-007 pointed at pushes: a 401 is a CREDENTIAL failure, not
a trace failure.** `pushTraceToHighLevel` collapsed a dead key, a malformed record and a rate limit
into the identical string `'Failed to create contact'`, and `response.status` never left the
function or reached the log, so a customer reporting "nothing arrives in my CRM" was undiagnosable
from outside. The result is now a discriminated union carrying `kind`
(`credential` / `record` / `transient`) and the status, with the rule written at the gate because
all three are `success:false` and the next reader will want to merge them.

**A SCOPE FINDING THAT CHANGED THE DESIGN MID-FLIGHT.** Verified against HighLevel's live docs:
`contacts.readonly` and `contacts.write` are SEPARATE scopes
(https://marketplace.gohighlevel.com/docs/Authorization/Scopes/), and PTP's setup copy tells users
to grant only "contacts". So a read-only token passes Test Connection (a GET) and fails every push
(a PUT or POST). Worse for the classifier: **a missing scope returns 401, identical to a revoked
token.** Only the response body separates them:

| | status | message |
|---|---|---|
| revoked token | 401 | `Invalid JWT` |
| missing scope | **401** | `The token is not authorized for this scope.` |
| wrong location | 403 | `The token does not have access to this location.` |

Three different remediations behind two statuses. A status-only design tells a user with an
unticked scope to re-paste a token that is perfectly fine. The failure now carries a `reason`
(`token` / `scope` / `location` / `unknown`) derived from the body, matched positive-only and
case-insensitively, with **`unknown` as a first-class value**: the scope wording comes from a
developer-forum report rather than official docs, so if HighLevel rewords it the correct behaviour
is to degrade to a generic message, never to guess (repo rule 7).

**THE BUTTON.** `push/route.ts` returned `{success:false}` inside an HTTP **200** and
`PushToCrmButton` branched on `response.ok`, never reading `data.success`, so a 401 rendered a green
check reading "Contact created". The bulk branch hardcoded `success: true` with `failed` computed
and rendered nowhere, so a 50-record job where every write 401'd showed "0 contacts pushed" under a
green check. Now: credential 502, record 422, transient 503, and 207 Multi-Status for a genuinely
partial job. 502 rather than 401 deliberately, because a 401 on the wire makes the browser think the
PTP session died, so a bad CRM key would read as a surprise logout.

### The tags bug: PTP was deleting customers' HighLevel tags on every update

Commit `a7962b6`. Found while verifying the scopes, and it is not on any prior list.

HighLevel's Update Contact endpoint states verbatim: *"This field will overwrite all current tags
associated with the contact."* (https://marketplace.gohighlevel.com/docs/ghl/contacts/update-contact/)
PTP sent `tags: ['proptracerpro']` on every `PUT`, so **every update push deleted every other tag on
that contact.** In HighLevel tags drive workflows, so this was silently breaking customers'
automation triggers, on a push that reported success.

Tags stay on CREATE, where there is no existing array to overwrite. **Deliberately NOT switched to
the additive `POST /contacts/:contactId/tags`**, which HighLevel's own doc points to for exactly
this: that endpoint's additivity is implied by its name and response shape rather than stated, and
swapping verified destruction for unverified behaviour is not a fix.

The assertion is that the `tags` key is **ABSENT** from the PUT body, not that it is an empty array
and not that it differs from create. An empty array overwrites just the same, so the obvious
"safe" form is still destructive. Both directions mutation-verified.

### Checked and closed, so nobody rediscovers it as a vulnerability

`anon` and `authenticated` hold INSERT on `user_profiles` columns including `subscription_tier`,
`wallet_balance` and `is_acquisition_pro_member`, which looks exactly like the suite self-write
class. **It cannot fire.** Trigger `on_auth_user_created` runs `handle_new_user` in the same
transaction as the `auth.users` insert, so the profile row always pre-exists any JWT and an INSERT
conflicts on the primary key (verified: 53 auth users, 53 profiles). Recorded rather than changed.
**The dependency is the part a deferral usually omits (L-014): it is safe BECAUSE OF THAT TRIGGER.**
If the trigger is ever dropped or moved into application code, the grant goes live and privileged
columns become self-insertable at signup. Written into the header of
`20260918_highlevel_credential_health.sql`.

### A correction to my own plan, caught by the implementer

The plan's classification table listed a wrong location as a `record`-class 404. It is a **403 and
credential-class**. Anyone implementing from the table alone would have told a user with a wrong
location ID that their payload was malformed. Corrected in the code; the table in `tasks/todo.md`
is superseded by the amendment.

---

## 2026-09-18

### Phase 5c final fix: the four seams between the sub-phases

Commit `cca815c`. 1306 passing from 1277, 67 files, 0 failing, `tsc` clean, eslint at its 47,
`npm run build` compiles. 14 mutations proposed and all 14 killed.

Phase 5c was built as four sub-phases and every one passed its own review. The whole-phase review
returned DO NOT SHIP over four defects, and every one of them sits at a JOIN. No per-task review
could see them, because each half was correct in isolation.

- **F1, HIGH. A mangled ZIP silently killed the phase's core capability, under a false reason.** The
  session route's tier split validated blank-owner rows with `validateAddressInput`, which carries a
  5-or-9-digit ZIP rule, and wrote failures as `PROPERTY_TRACE_NO_KEY_STATUS`, whose sentence was
  written for a row that cannot be looked up at all. A row with a valid street, city and state and a
  broken ZIP was told it was missing a component it had, and then locked out for 90 days, because
  `normalizeAddress` excludes the ZIP so a corrected resend hashes identically. Excel strips the
  leading zero from a ZIP column on export, so an MA, NJ, CT, RI, NH, ME, VT or PR file arrives
  mangled on every row while its owner-name rows trace normally. **The split now asks only whether a
  vendor can be ASKED: street, city, state.** The no-key status is reserved for a row genuinely
  missing one of those, which is also the only population its resend advice is true for.
- **And the broken ZIP is dropped rather than carried.** New `usableZip()` in
  `lib/utils/address-normalizer.ts`, sharing one ZIP pattern with the validator. This route does not
  validate per record and as of 5c that column reaches a vendor: a zip contradicting the street, city
  and state it travels with is worse than none, `executeRoute.ts` already says so, and tier 2 bills
  per record SUBMITTED, so a miss caused by our own mangled input is one the customer pays for. It
  also blocks the dossier's zip backfill, which only fires when the caller had none.
- **v1 and MCP do NOT share the shape and were left alone.** Both validate every record up front and
  refuse the whole batch with a structured error naming the ZIP. Nothing is written, nothing is
  locked out, and the caller is told something true and actionable.
- **F2, HIGH. PTP did paid work and collected nothing, repeatably.** `collectedChargeFor` was
  unbounded in time and job, and `trace_history` is UNIQUE(user_id, address_hash), so a resubmit
  re-enqueues the SAME row. The cron re-bought the dossier, the probe found the first submit's debit,
  and the deduct was skipped. **The decision is now scoped to the bulk job the row is currently
  enqueued for; the amount persisted stays the ledger's full net.** Those are two questions and
  answering both with one number is how this got in. `collectedChargesFor` answers both off one read.
  An unreadable job falls back to unbounded, which can only refuse a charge PTP is owed rather than
  take one twice from a customer.
- **The other available bet on F2 was making duplicate detection real on v1 and MCP, and it was NOT
  taken.** It cannot reach the dashboard on day 91, where the row is legitimately resubmitted and a
  fresh charge is genuinely owed, and `lib/utils/deduplication.ts` already records it as a product
  decision belonging elsewhere: `checkDuplicates` counts ANY row in the window as a duplicate,
  including a plain failure, so moving it to the service-role client would start blocking retries of
  failed addresses on a public API. It is named in task 17 rather than half done.
- **F3, MEDIUM. A reused row served the other billing model's sentence, and its tests could not
  fail.** All three submit routes null `ai_research_status` explicitly and none did the mirror-image
  write for `property_trace_status`. The upsert touches only the keys in its payload, so a row that
  was tier 2 kept its terminal value while settling as tier 1, and `rowSkipReason` asks tier 2 first.
  **The three tests guarding it asserted `property_trace_status ?? null` is null, which an ABSENT key
  satisfies** (L-015). Tests fixed first, on presence and value, then the code. The status route's
  `records_matched` double count came from the same missing write and went with it.
- **F4, MEDIUM. The honest partial-failure report never reached the screen.** 5c-3A made a half-failed
  submit report accurately; 5c-3B did not know to render it. `records_failed` was not in the page's
  interface and the message was shown only when no row carried a skip reason, so five explained rows
  silenced it. Because every other figure is re-quoted to the survivors, no arithmetic on the page
  could recover the fact. Its own tile in both phases, and the sentence shown whenever a half failed.
- **F5, LOW. Recorded, not built, as instructed.** Task 17 said "a FREE failed bulk row", which
  excluded the only population that is OUT OF POCKET: a billed `property_trace_no_reach` row paid for
  two calls, received one, and can reach the contacts through neither the cache nor a resend. Task 17
  now covers that shape explicitly. `PROPERTY_TRACE_NO_REACH_REASON` was re-read at the same time and
  invites no retry it cannot honour.
- **One exemption survived scrutiny rather than being deleted.** `ALLOWED_RAW_WRITES` still covers
  `sweep-property-traces`, and its reason was rewritten: the value written is still the ledger's own
  net, so folding it onto the row's column would count one debit twice. Its first draft here folded
  instead, and a test caught it double-counting on the unreadable-job fallback.


### Full Property Trace, phase 5c-3B: the surfaces stop describing a product that no longer exists

Commits `fd73b39`, `2a443ea`, `01a0b32`, `627b78c`. 1277 passing from 1193, 67 files, 0 failing.

Every string in the product was written when tier 1 was the only billing model: charged per
successful trace, a miss is free. Tier 2 charges per record SUBMITTED, so a miss is billed. A
sentence true of one is false of the other, and that single fact produced almost every defect here.

- **The wiring gap was the real work, not the copy.** `propertyTraceSkipReason()` existed, was
  tested, and was connected to nothing, so every tier 2 terminal value reached the customer as a bare
  `no_match`. All four bulk surfaces now serve it through ONE accessor,
  `lib/trace/rowSkipReason.ts`, which asks both queues: the results CSV, the session job summary, the
  v1 REST payload and the MCP payload. Each previously called the tier 1 accessor alone.
- **The billed reason had no charge statement, and finding that was the point of checking.** Of the
  five reasons a row can come back empty, four are free and one is billed: the dossier answered, we
  charged, and the contact vendor then failed. That fifth sentence said nothing about money and
  relied on the reader noticing an absence, which only worked while the summary heading made the
  money claim. **Removing that heading without fixing this would have moved a billed row from a false
  money claim to no money claim, a regression hidden inside a fix.** It now says what was charged and
  why, naming the model rather than a rate.
- **Then the corrected headings over-claimed in the other direction.** "We could not get contacts for
  N of your records" is true as a category and false against its own number: N counts only rows with
  a stated reason, so a 100-record job with 40 matched read as 12 without contacts when 60 were. The
  claim was narrowed rather than the count widened, because widening would leave the reasons
  explaining a fraction of the number above them.
- **Three reasons invited a resend that the 90-day dedup window silently refuses.** The hash is
  address-only, so any existing row blocks it. That is the same defect class as the stale blank-owner
  instruction corrected earlier in this phase: advice that fails when followed. The invitation was
  removed where it is false and KEPT on the no-key reason, where supplying the missing city changes
  the hash and the resend genuinely works. **The gap this leaves is real and is recorded as task 17
  rather than papered over with a sentence:** a customer is now told the truth and has no remedy.
- **The API docs page was still selling the old product** and was not on the plan's list: it told
  callers blank-owner rows are skipped and free, that a skip reason means nothing was charged, and
  showed two response keys 5c-3A had already deleted.
- **v1's status route pages, and the paging is deliberately non-breaking.** Default and max are both
  500, the submit cap, so an existing caller passing no query gets exactly what it gets today, pinned
  by a test. MCP stays at 25/200. The asymmetry is documented on BOTH sides: the MCP limit exists
  because its consumer is a model with a context budget, v1's because of bytes over the wire.
- The cap refuses at parse time on the file's raw row count, deliberately stricter than the routes,
  because we refuse on the number the user is looking at. Its recorded rationale was corrected: the
  route caps BEFORE dedup, so the gap is invalid rows, not duplicates.

**The copy rules are now enforced by tests** rather than by review attention, so no em-dash,
en-dash or asterisk can re-enter a user-facing string silently.

`lessons.md` gains L-016: an enumerated list stops the reader searching, so an incomplete one is
worse than none. The docs page was missed by working the plan's list instead of grepping for the
claims themselves, and the same failure produced an unnumbered enqueue task and a skip-reason
instruction named in one place that survived in three others. All three gaps were mine, and in each
case the missing piece was something known and left in prose.

### Full Property Trace, phase 5c-3A: blank-owner rows are traced, and a job cannot end over live work

Commits `4336f5b`, `f9b15d7`, `c1556dd`, `c257062`, `76833aa`, then `e5a978c` and `2b327e9` from two
fix rounds. 1193 passing from 1075, 65 files, 0 failing.

**The capability change, and the plan never numbered it.** A bulk row arriving with no owner name was
skipped and free. It is now enqueued and runs a Full Property Trace automatically, billed per record
SUBMITTED, which means a miss is billed. 273 of 1,270 historical bulk rows are blank-owner. The task
list had no entry for this; it lived only in a sentence of 5c-2's prose, and every other 5c-3 task is
downstream of it. Added as task 15 before work began.

- **The cap is 500 on all three surfaces**, down from 10,000 on two of them. Measured against all 92
  historical jobs: median 20, p95 223, max 654, and exactly one job exceeds 500.
- **Two pre-flight checks that must never be merged.** The customer's wallet answers "can the
  customer pay" and fails 402. PTP's Tracerfy balance answers "can PTP execute" and refuses SILENTLY,
  by David's explicit decision, because PTP has no alerting channel and he chose no alert over a fake
  one. No message tells the customer to add funds for PTP's shortage; their wallet is not the problem.
- **The wallet check now reserves rather than merely comparing.** It was a bare comparison that wrote
  nothing, so two jobs submitted back to back both passed against the same dollars and the second got
  the vendor work done for free. Settlement fails closed, so no customer was ever harmed and no
  balance went negative, which is exactly why nobody found it: the only party out of pocket was PTP.
  It closes the back-to-back gap but NOT the sub-second window inside one submit, which needs a
  transactional hold and is recorded as task 16 rather than left in a comment.
- **A blank-owner row with an unusable address is written `PROPERTY_TRACE_NO_KEY_STATUS`,** not the
  blank-owner skip. The plan said otherwise and the plan was stale: `BLANK_OWNER_SKIP_REASON` tells
  the customer to resend with the owner of record, which will not make a city-less row run. False
  remediation advice is worse than a vague message, because the customer acts on it and it fails
  again. The cron already wrote the honest status for the identical row; now the submit route does
  too. One row shape, one answer, whichever layer notices.

**NOTHING WAITED ON THE NEW QUEUE, and finding that was the difference between shipping and
outage.** `property_trace_status` had exactly one reader outside its own module. So the moment the
submit routes enqueued, an all-blank job would have hung at `processing` forever and a mixed job
would have been marked complete by the first vendor poll while its tier 2 rows were still queued,
landing a short CSV the customer may treat as final for rows they were charged for. Eleven terminal
`trace_jobs.status` writers across four files now sit behind a pending-tier-2 gate. One of them, the
"Timed out waiting for Tracerfy" verdict, was found by sweeping every writer rather than patching the
ones that had been listed, and the guard is hoisted above its branch precisely so a fifth verdict
cannot be added below it later.

**A failed submit could charge a customer for work it told them did not happen.** When the person CSV
failed, the job was marked `failed` and a 500 returned while the already-enqueued tier 2 rows kept
billing. A 60 plus 40 batch on a vendor 5xx gave the customer an HTTP 500, a job reading failed, a $16
charge, and "all duplicates" if they tried again. Now the job stays open, and all three surfaces say
which half failed and requote only the survivors. Every count and quote field is computed from the
surviving record set, including `trace_jobs.records_submitted`, which is off-payload, is the
match-rate denominator, and is read back by both the status route and the completion webhook. Six
fields in total were still counting the dead half; three were named in review and three were found by
sweeping.

**One sentence carries the whole two-model problem.** The partial-failure message states a charge for
the tier 2 survivors and deliberately makes no charge promise about entity survivors, because
entities are tier 1, billed per successful trace and free on a miss, so "you will be charged for
these" would be false in the other direction. Only tier 2 is billed unconditionally, so only tier 2
gets an unconditional sentence.

Also fixed: `deductOrZero` reported a short wallet and an RPC error identically, so an operator with
no alerting could not tell an expected business outcome from an infrastructure failure. And
`total_charge` on the session status route now sums the stored per-row charges, because a per-poll
number structurally cannot see a charge the cron booked.

`lessons.md` gains L-015: asserting two outputs DIFFER is weaker than asserting what each one SAYS.
The test proving the two deduct log lines were distinguishable SURVIVED its mutation, because the
lines still differed by vendor message text while the meaningful classification had been destroyed.
That is now the fourth member of a family with L-009, L-012 and L-013, all of which produce a green
test that would stay green if the guard were deleted.

### SECURITY, found while applying the 5c-2 migration: trace_history is browser-writable

**Not caused by 5c-2, but widened by it, and it must be closed before 5c ships.** Reading privileges
back after the migration, `public.trace_history` grants `INSERT, UPDATE, DELETE` to `anon` AND
`authenticated`, table-wide. RLS is enabled but RLS gates WHICH ROWS, not WHICH COLUMNS: the
"Users can update own traces" policy is `USING (auth.uid() = user_id)`, so any signed-in user can
rewrite **every column on their own rows** from the browser console with the anon key that ships in
the JS bundle. `charge`, `tier`, `is_successful`, `trace_result`, `property_record`.

**This is NOT a missed audit. It is the known, deliberately-deferred remainder.** The suite-wide
table-grant class was found and partly fixed on 2026-07-16/17; the broad `REVOKE ... ON ALL TABLES`
plus surgical re-grant was explicitly DEFERRED as backward-incompatible and "not flag-critical,
profile and wallet tables already locked". That was reasonable then: the exposure was a user
corrupting their own rows, and the wallet LEDGER, not the row, is the source of truth for money
collected. Recorded as L-014.

**5c-2 is what expired that deferral.** A new column inherits the table's grants, so
`property_trace_status` landed browser-writable like every other column. But it is not a fact about a
row, it is the trigger the cron claims work from, which turns a data-integrity deferral into a
free-vendor-work exploit.
Writing `'queued'` into it enqueues paid vendor work. Combined with `deductOrZero` collapsing an empty
wallet to 0 while still delivering, a user with no balance could self-enqueue unlimited tier 2
traces against PTP's SHARED Tracerfy pool. **Not exploitable today: the cron is committed but not
deployed.** It becomes live on the deploy that ships 5c.

**The fix is verified safe but NOT YET APPLIED, pending David.** Every write to `trace_history` in
the codebase goes through `createAdminClient` (service_role): 17 files, all server-side. The only two
browser-side files that touch the table, `app/(dashboard)/history/page.tsx` and
`app/(dashboard)/dashboard/page.tsx`, contain zero writes. So revoking `INSERT, UPDATE, DELETE` from
`anon` and `authenticated` and leaving `SELECT` breaks nothing. DELETE is already dead anyway, since
no DELETE policy exists.

### Full Property Trace, phase 5c-2: the queue, the worker, and a row that says what really happened

Commits `54f1b41` and `64cd577`. Visible output: almost none, by design. A migration, a cron worker
and the billing gate inside it. The surfaces land in 5c-3.

- **`trace_history` gained its own tier 2 queue**, `property_trace_status VARCHAR(24)` plus
  `property_trace_claimed_at`, deliberately NOT the existing `ai_research_status`. That column is
  named for an engine removed on 2026-09-17, its VARCHAR(20) is nearly full at 19 characters, and
  mixing two billing models in one state machine is how `tier` gets confused: the entity queue bills
  per SUCCESSFUL trace where a miss is free, this one bills per RECORD SUBMITTED where a miss is
  charged.
- **The index fixes a flaw rather than inheriting it.** The entity queue's partial index is
  `WHERE ai_research_status = 'processing'`, which was correct until the retry ladder added
  `queued_2..5` and `processing_2..5`. Postgres cannot use a partial index for rows its predicate
  excludes, so the live claim and all five stale sweeps are sequential scans today. The new predicate
  is `WHERE property_trace_status IS NOT NULL`, which covers every rung including ones added later.
  Applied to production and read back: columns, types, nullability, index definition and predicate
  all verified, and all 3,836 existing rows are NULL in both new columns.
- **The claim protocol mirrors the entity cron exactly** rather than improving on it: atomic
  compare-and-swap, `claimed_at` set with the flip, stale recovery using `.or(claimed_at.is.null,
  claimed_at.lt.cutoff)` because SQL `<` never matches NULL, and a killed claim counting as a SPENT
  attempt so a poison row cannot loop forever. 120 records per run at concurrency 5, which is 48% of
  the shared 500/min vendor pool.
- **A ROW NOW SAYS WHICH THING ACTUALLY HAPPENED.** The first build billed a contact-vendor outage
  and settled it as a plain `no_match`, byte-identical to a genuine contact miss, with the vendor
  error persisted nowhere. The customer paid full price for a two-call product, got one call, and was
  told we asked and found nothing. That satisfies L-007 at the gate and defeats it at the row.
  Billing it is right and not retrying it is right, since a retry re-buys a $0.20 dossier from a pool
  of about 1,069 shared across all customers. Those are independent of the label. A contact failure
  now settles under its own terminal `property_trace_no_reach`, with its own sentence, its own
  `console.error` naming the row and the vendor error, and its own counter kept out of the ordinary
  no-contacts count. One of its tests asserts the new sentence never says "not charged" or "free",
  because unlike its two siblings that row WAS charged.
- **L-009 is closed on this surface, demonstrated rather than asserted.** Both track-pricing tests
  set `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED` themselves, and a third re-runs Track A with the flag
  deleted and watches $0.25 become $0.40. The mutation that collapses Track B onto Track A, which
  produced ZERO red in phase 4 and is the whole reason that lesson exists, now kills a test.

1075 passing from 1008, 64 files, 0 failing. tsc 0. eslint 47. Build compiles. 22 mutations from the
implementer, 6 chosen and re-run independently by me, zero survivors. Spec review PASS, quality HIGH,
one Important finding raised and addressed, re-review clean.

`lessons.md` gains L-013 (a spy you never clear is a fence that cannot fail; found because the log
assertion was being satisfied by an earlier test's output) and L-014 (a GRANT audit is not done until
you check the tables too).

### Full Property Trace, phase 5c-1: a vendor saying "not found" is an answer, not an outage

Two prerequisite defects, both in `lib/tracerfy/client.ts`, both money defects. Bulk tier 2 would
have inherited both, so neither could wait for the engine. Commit `55616b0`.

- **A FastAppend "company not found" was billed as an outage and 502'd the customer.** The vendor
  answers a genuine miss with HTTP 404 carrying a valid envelope, `hit:false, credits_deducted:0`.
  The client checked `if (!response.ok)` and returned `contactFailure` BEFORE parsing the body, so
  `executeRoute` set `pass2.failure` and the route returned 502 with `charge: 0`. A record whose
  dossier had HIT, $0.20 already spent and the 86-field record in hand, was discarded unbilled.
  `executeRoute`'s own comment says "the dossier spend above stands and the record is good"
  immediately before throwing it away. At the handoff's measured rates (22 of 24 commercial parcels
  are entities, FastAppend hits 13 of 22) that is roughly 9 in 22 entity records.
- **L-008 had already recorded this exact lesson and the fix landed one layer too deep.**
  `parseBusinessTraceResponse` handles `hit:false` correctly; the status check above it
  short-circuited before reaching it. The discriminator is now the BODY. A body carrying a boolean
  `hit` is an ANSWER and goes to the parser.
- **A 5xx is the one exception, and it is checked first.** The plan's own sentence contradicted
  itself here, saying "an ANSWER at any status" and then listing 5xx as a transport failure. Bound
  to: the `hit` discriminator covers 2xx and 4xx, any 5xx is a failure regardless of body. A 5xx is
  the vendor reporting that its own server failed, and L-007 says an outage is never billable. The
  ruling can only under-bill, never over-bill. The reasoning is written into a comment at the gate
  because the next reader will see two false-y signals and think they can be merged.
- **The body is now read exactly once.** The old code called `.text()` on one branch and `.json()`
  on the other, and a naive rewrite produces a "body already consumed" error that a permissive mock
  never catches. The test mock enforces single-read.
- **`getAnalytics()`'s type was fiction.** It declared `credits_remaining`, `credits_used`,
  `total_jobs` and `total_records`; the API returns `balance`, `total_queues`, `properties_traced`,
  `queues_pending` and `queues_completed`. Not one declared name exists. With zero call sites nobody
  found out, and the failure mode was the silent kind: a guard reading `data.credits_remaining < 300`
  evaluates `undefined < 300`, which is false, so it would have blocked nothing while looking
  implemented. Fixed against the real response, with the test that would have caught it. No call site
  added; its consumer belongs to 5c-3.

1008 passing from 1000, 62 files, 0 failing. tsc 0. eslint 47. Build compiles. Three mutations run
independently by the controller, all killed: reverting the discriminator to `!response.ok` (1 red),
disabling the 5xx arm (1 red), and weakening the missing-`hit` guard into a billable miss (2 red).
Task review returned zero findings at Critical, Important and Minor.

Worth recording because it nearly cost the work: the implementer ran `git checkout --` on
UNCOMMITTED changes to revert a temporary mutation and destroyed both fixes. It reapplied them and
disclosed it. That is L-012 arriving a second time in a different costume; the lesson's rule is
"commit before a mutation run", and the run that bit it was a mutation run on unsaved work.

### Full Property Trace, phase 5b: a refund is not a collection

A third adversarial review found one new production defect. Two settle sites refund a historical
AI-research fee and then probe `collectedChargeFor` so they do not double-charge the row. The probe
summed only `type = 'debit'`, and the refund is a CREDIT that could not name a row at all -- so the
money handed back still counted as collected, the deduct was SKIPPED, and the customer got the
contacts free while `trace_history.charge` reported an amount that was back in their wallet. Fixed
at the DATABASE (migration `20260917_credit_wallet_balance_trace_link.sql`, applied and ACL-verified
before this pass) rather than patched at the call sites, so no future refund site can get it wrong.

- **`collectedChargeFor` returns a NET.** The `.eq('type','debit')` filter is gone -- that filter,
  not the arithmetic, is what hid the refund. `type` is selected and classified in JS: a debit adds,
  every other type subtracts (the column's CHECK allows four types and three of them ADD balance, so
  an unanticipated one errs toward charging money genuinely owed rather than skipping a charge never
  paid).
- **Null and zero stayed different; the callers moved to `> 0`.** Null means the wallet never touched
  the row, 0 means money moved both ways and settled back to nothing. Collapsing them in the helper
  would lose a fact no caller can recover. But 0 is not a collection, so all FOUR probe sites now
  test `collected !== null && collected > 0` -- including `sweep-entity-traces`, which never refunds
  but settles rows its two twins do.
- **Both refund sites pass `p_trace_history_id`.** The Stripe webhook was deliberately left alone:
  its credits are genuine top-ups belonging to no row.
- **No backfill, on purpose.** Pre-migration credits carry a NULL `trace_history_id` and can never be
  back-linked. The 743 rows carrying `ai_research_charge > 0` are all settled and the fee is retired,
  so this is forward-correctness only. Compensating for unlinked credits would mean guessing which
  credit belongs to which row, and that is a guess about whether to charge a customer.
- **`settleBulkJob`'s delivery statement gained `.eq('status','processing')`,** matching its two
  siblings. A concurrent settle of the same Tracerfy job could otherwise succeed a row between the id
  read and this write, and the statement would stamp `no_match` over real contacts.
- **The fixture that hid the defect was production-shaped.** It set `ai_research_charge: 0.15` against
  an EMPTY ledger -- a fee with no debit behind it, which nothing can produce. All three harnesses now
  write the ledger from the wallet RPCs, and only when the call carries `p_trace_history_id`, so the
  refund's new argument is load-bearing in the tests rather than cosmetic.
- **The charge-receipt fence had a hole and it is closed.** `isFolded` matched any identifier ENDING
  in `billing`/`Billing` and never checked what it was bound to. Proven: rename a local to `billing`,
  delete its exemption, and the old fence passes 8/8 while the file clobbers receipts. Bindings are
  now derived from the file's own assignments, PER COLUMN -- one identifier can hold a folded `tier`
  beside a raw ledger `charge`, and a fence that cannot tell them apart either retires a live
  exemption or demands a bogus one.
- **The fence was extended to `tier`.** Measured first: every `tier` write in a `trace_history` update
  is already folded or guarded, so the extension needs no exemption list. The tier tautology had been
  caught by reviewers at three separate sites precisely because flattening a folded `tier` killed no
  test anywhere.
- **16 mutations run, 16 killed, 0 survivors,** with no anchor failures and no drop in the total test
  count. A 0-red was found DURING verification -- `settleBulkJob`'s Tracerfy probe survived when
  mutated on its own -- and is now covered.
- Documented, not changed: `total_charge` is the LIFETIME receipt for a job's addresses rather than
  that job's cost (one job can report 0.15 then 0.40), and the `source` upsert overwrites, so an MCP
  address resubmitted from the dashboard flips to `web` and leaves `mcp_spend_today`.

Gates: `npx vitest run` **1000 passing / 61 files / 0 failing** (from 982) · `npx tsc --noEmit` **0** ·
`npx eslint app lib components` **47, unchanged** · `npx next build` **compiled**. Nothing committed.

---

## 2026-09-17

### Full Property Trace, phase 5a fix pass: four mutations that produced zero red

An adversarial review ran 14 mutations against the 5a build. **Four came back completely green**,
which is a coverage failure rather than a correctness one -- every number in the original report
re-checked correctly. All nine follow-ups are done and each dead mutation now bites.

- **All 65 dossier columns are prefixed `prop_`.** This removes the four duplicate headers
  (`address`, `city`, `state`, `property_type`), and the duplicates turned out to be **hiding two
  missing assertions**: the test helper resolved a duplicate name last-wins, so the base `state`
  column and the research `property_type` column were unreachable by name. Both survived being
  replaced with `null` with the suite fully green. Prefixed, addressable, now asserted, both red.
- **THE NUMERIC ZERO RULE WAS WRONG.** The plan told us to blank every numeric 0, citing the
  handoff's "fill rates treat 0 as absent". That is a MEASUREMENT convention for computing coverage,
  not a rendering rule, and the `price_per_sqft` precedent was measured on PRICE fields only.
  Generalised it destroyed facts the customer paid for: `years_owned: 0` is bought this year,
  `mls_days_on_market: 0` is listed today, and `beds`/`baths`/`units_count`/`stories` are genuinely
  zero on commercial stock -- this product's entire market. A 0 now renders `0`, except for a named
  `ZERO_MEANS_ABSENT_KEYS` set where 0 is IMPOSSIBLE rather than unlikely: money, size, years and
  coordinates. A parcel is not assessed at $0, a building is not 0 sqft, there is no year 0, and
  lat/long 0,0 is a point in the Gulf of Guinea.
- **`renderCell` was fabricating on non-scalars.** Objects and arrays rendered `[object Object]`,
  and `NaN`/`Infinity` printed bare. `[object Object]` in a paying customer's spreadsheet is
  fabricated data, CLAUDE.md rule 7. Arrays now join on `; `, objects blank, non-finite numbers
  blank. Unreachable today, but this is the single renderer for the product and the drift test does
  not fire on a live vendor addition.
- **CSV formula injection defused.** `"=1+1"` is valid CSV that Excel, Sheets and LibreOffice all
  strip and evaluate, and the dangerous forms are `=HYPERLINK(...)` and the DDE `=cmd|...`, not
  arithmetic. This phase grew the vendor-controlled free-text surface from 16 columns to 103
  (`lender_name`, `subdivision`, `roof_material`, `document_type`, `property_use`). A leading
  `=`, `+`, `-`, `@`, tab or CR now gets an apostrophe inside the quoted cell.
- **Two comments claimed protection a mutation disproved.** Following the 4b precedent they were
  reworded, not propped up with a test invented to justify them. The `toPublicPropertyRecord` call
  in the builder is genuinely redundant and is now labelled defence in depth. The drift test does
  NOT turn red on a live vendor addition -- it fires when a human re-records the committed fixture,
  and until then a new key is silently dropped from the CSV. Said plainly in the test.
- **A fence assertion was a tautology.** `expect(csv).not.toContain('propensity')` could not fail
  under any single change, because values are selected only through `DOSSIER_EXPORT_KEYS`, which
  another assertion already pins. Rebuilt as a unique sentinel written into every blocked key and
  run through the real builder: it bites on the BUILDER widening its selection, which is a different
  mutation from the list changing.
- **The truncation fix had relocated its own failure mode.** A PostgREST error on page 2 of 3 was
  swallowed and returned a 200 with a short, valid-looking CSV -- byte for byte the silent
  truncation this phase exists to remove, wearing an error handler as a disguise. The whole download
  now fails or none of it does. The loop is also bounded now, so an ignored `.range()` is a 500
  rather than a hang.
- **`charge` renders bare again** (`0.40`, not `"0.40"`), the one column where being a number to a
  spreadsheet matters most.
- 933 tests passing (from 909), 58 files, 0 failing. `tsc` exit 0. eslint 47, unchanged.
  `npm run build` exit 0. Ten mutations run this pass, every one observed red. No billing code
  touched, nothing committed.


### Full Property Trace, phase 5a: the export carries everything purchased

**The scope changed before the build.** 5a was specced as "append the 65 dossier columns". Checked
against production first, the export was already short-changing customers on CONTACTS: phones capped
at 3 columns where rows store up to 9 (863 of 1,362 rows over the cap, 1,554 numbers bought and never
exported), emails capped at 3 (142 addresses lost), no phone-type column at all (populated on 1,297
rows), no `mailing_zip`, and -- worst -- **no column for the owner of record**. `trace_result.owner_name_2`
holds the entity the county has on file and had nowhere to go, so a tier 2 customer never saw
"Colmaven, Llc" even on a hit, and saw a blank owner entirely when no principal was found.

- **One shared module, `lib/trace/exportCsv.ts`.** `EXPORT_COLUMNS` (103), `renderCell`,
  `buildExportCsv`. Both download routes build from it, so the bulk file and the single-record file
  cannot drift apart within a release.
- **The fence came first, and it was the point.** `lib/trace/__tests__/propertyRecordEgress.test.ts`
  finds leaks by matching a record written into an object KEY. A builder that reads
  `row.property_record` and writes 65 separate columns writes no such key and is invisible to it --
  this phase built exactly the shape the fence was blind to. Fixed structurally with one canonical
  `DOSSIER_EXPORT_KEYS` list and four new assertions, not with a wider regex. It went green BEFORE
  any new column was emitted, and it caught a real leak during the build (the literal token in a doc
  comment in the new module).
- **The drift test resolves the real tension.** `toPublicPropertyRecord` is a DENYLIST so a new
  vendor key reaches the customer; a CSV column set must be STABLE or it breaks their importer. A
  fixed list plus a test asserting every public fixture key appears in it means a new vendor key
  turns the suite RED and a human adds the column deliberately. Same bargain now guards
  `TRACERFY.MAX_PHONES`.
- **`renderCell` replaces `esc`, which threw on a number.** `(123 || '').replace` is not a function;
  it survived only because every column it ever saw was a string, and most of the 87 new ones are
  numbers and booleans. `false` renders `No` (a known negative is information, not an unknown);
  numeric `0` renders BLANK (the vendor zero-fills an absence, same basis `price_per_sqft` was
  un-blocked on); numbers bare; strings quoted.
- **Append-only. The first 16 columns never moved.** Research went unconditional at its existing
  indices 17-20 and `skip_reason` appended at 21, which is a pure append only because it was measured:
  of 44 bulk jobs carrying rows, 40 have research and ZERO have skip_reason.
- **Fixed a silent row truncation that was waiting to happen.** The bulk route had no `.range()`, so
  PostgREST capped it at 1,000 rows and a bigger job lost the rest with a 200 and a valid-looking
  file. Biggest job to date is 345 rows; `MAX_RECORDS` is 10,000. Now paginated, stopping on an EMPTY
  page rather than a short one, with an `id` tiebreaker so a page boundary cannot drop or repeat a row.
- **New single-record export**, `app/api/trace/single/download/route.ts` plus a button on the single
  trace page. Same 103 columns. Without it the export was bulk-only in practice.
- 909 tests passing (from 864), 58 files, 0 failing. `tsc` clean. eslint 47, unchanged. Eight
  mutations run and each observed red. No billing code touched.
- **Open, needs a naming call:** `address`, `city`, `state` and `property_type` each appear twice in
  the header now (input vs county). Index-keyed importers are fine; name-keyed ones are not. Prefixing
  the 65 is free today and a breaking change after the first release. See the 5a review in
  `tasks/todo.md`.


### Full Property Trace, phase 4b: the dossier reaches the Suite Gateway

**The spec was aimed at the wrong system and got rewritten before anything was built.** 4b was
scoped as auto-creating 65 CONTACT custom fields in each user's GoHighLevel over the API, with a
Private Integration Token scope warning. Reading the gateway killed all three assumptions. See
`tasks/lessons.md` L-010.

- **Most users get this data through the Suite Gateway, not PTP's own push.** Only 6 of 52 PTP
  users have direct HighLevel credentials configured at all, and the gateway CRM path has pushed
  331 properties for 3 users.
- **The gateway keeps property data on a custom object**, `custom_objects.property`, not on the
  Contact. Read live: 50 fields today.
- **Nobody has the permission the auto-create needed.** PTP's own setup page tells users to grant
  only the `contacts` scope, and the API cannot create property-object fields at all
  (`POST /custom-fields/` rejects `custom_objects.property` with "Invalid object key").
- **The gateway reads PTP over MCP, never from PTP's database.** No PTP project ref exists
  anywhere in that repo. The proxy path returns PTP's response verbatim; `crm_push_owners` parses
  it and silently drops every key it does not name.

**So the PTP change is small and it is the whole PTP change.** `listTraces` and
`buildPerRecordResult` in `lib/suite/mcp-tools.ts` now emit `property_record` and `tier`, filtered
through `toPublicPropertyRecord`. A gateway caller receives exactly 65 keys, verified by probing
the real function against the 86-key fixture; the 21 provably-wrong keys never appear.

- **The select was the trap.** Neither column was in `listTraces`'s `.select(...)`, so without
  adding them the change would have been a silent no-op that looked exactly like a customer who
  had never bought a Full Property Trace. The test stubs now emulate PostgREST column projection,
  so dropping a column from the select turns tests red instead of passing.
- **13 mutations applied, and one honestly reported as 0 red.** Destructuring `property_record` out
  of the `...rest` spread turns nothing red, because the explicit filtered key wins the collision
  while the spread stays first. The comment now says it is defence in depth rather than claiming a
  protection the mutation disproves. The variant that is a real leak, reordering the spread to
  last, is caught.
- **Tool descriptions updated** so an MCP caller knows the record exists, and the copy avoids the
  literal `property_record:` pattern because the egress scanner correctly reads that as an
  emission even inside prose.
- **Delivered to David:** `tasks/ghl-property-fields-to-add.txt`, the 54 property-object fields to
  add to the GHL snapshot template, with label, type and exact field key. 86 returned, 21 withheld,
  65 delivered, 11 already present, 54 new. Checked against the live object rather than a cache.
  Money type is excluded throughout, because MONETORY fields cannot be written.
- **Numbers:** 864 tests passing from 849, 56 files, 0 failing. `tsc` 0. eslint 47. Build compiles.
- **Not done, deliberately:** the gateway's own mirror (different repo, after the snapshot ships)
  and PTP's direct HighLevel push, which is dropped rather than built.


### Full Property Trace, phase 4a COMPLETE: AI Search removed, the UI shipped, v1 wired

Consolidated entry. The per-pass entries below carry the detail; this is the summary.

- **AI Search is gone.** The Brave and Claude engine, four research routes, the Brave client and
  the results card, deleted with no deprecation window. Historical data is untouched: 1,301 rows of
  `ai_research`, `ai_research_status` and `ai_research_charge` are still stored, still served, and
  still protected from deletion by `isBilledRow`. Both refund sites still service them.
- **Four things the written deletion list got wrong, all caught before deleting.**
  `app/api/v1/research/status` had to survive (it polls `business_trace_jobs`, not AI research, and
  customers poll it); `isLikelyBusiness()` had to be relocated; `AIResearchResult` could not leave
  `types/`; and deleting `sweep-bulk-research` would have broken BULK for 987 of the 1,301 rows,
  because it was the only path resolving entity-owned bulk rows. Rewritten as `sweep-entity-traces`
  on `lookupBusinessTrace()`, no Brave, no Claude.
- **The UI, which is the visible slice.** `PropertyRecordCard` renders the county record, pure and
  server-renderable. The 6 provably-wrong fields and 15 propensity scores never reach the screen; a
  numeric 0 renders blank because 0 is this vendor's unpopulated default, and a "$0 mortgage
  balance" would assert free-and-clear. Opt-in toggle, the disclosure firing on both billing
  triggers, and the two owner names finally labelled: contact person versus owner of record.
- **v1 runs tier 2 automatically on an absent owner**, on its own RAW Track B price derivation
  (`lib/api/pricing.ts`), never the grant-aware Track A helpers. `trace.completed` now fires for
  tier 2 from both surfaces, including a billed miss, never on a vendor failure.
- **Two reviews caught two money defects a green suite could not.** The v1 cache could never fire
  (anon client under RLS, no session cookie on an API-key request), so every repeat call re-bought
  and re-charged. And a billed row could be written back to unbilled, after which a foreign key
  violation made that address return 500 permanently. Both fixed, both mutation-verified.
- **Receipts are monotonic now.** `foldBillingWrite` accumulates charge and never downgrades tier;
  the ledger is the idempotency marker and it fails closed. Note the dashboard's charge column now
  reports the total collected against an address rather than the most recent collection, which is
  what puts it back in agreement with `wallet_transactions`.
- **L-009 was earned twice in one phase**: a correctly written guard with a correctly named test is
  worthless when the two paths it separates are identical in the test environment. Only the
  mutation runs exposed either one.
- **Numbers:** 848 tests passing from 497, 56 files, 0 failing. `tsc` 0. eslint 47 from 54. Build
  compiles. 56 files changed.
- **Not done, deliberately:** phase 4b (the CRM push with 65 auto-created custom fields and the PIT
  scope warning) and phase 5 (bulk tier 2, the pre-flight balance check, the 65-column export).

### Full Property Trace, phase 4: the 21 blocked dossier fields are withheld from EVERY egress, not just the screen

David's decision: the 6 provably-wrong fields and the 15 propensity scores are blocked from the v1
API, the session API, both poll routes and the `trace.completed` webhook, on the reasoning that
already blocked them from the CSV export. A payload lands in a customer's own system, where a wrong
`estimated_value` looks authoritative and outlives any caveat we could put on a screen.

- **Storage is untouched.** `trace_history.property_record` still holds all 86 keys, verbatim. No
  migration, no backfill, no filter on the way in. The raw dump is the product.
- **New `lib/trace/publicPropertyRecord.ts`**: the one blocked list plus a pure
  `toPublicPropertyRecord()` that returns a COPY. Both submit routes persist the raw record and
  return the filtered one from the same variable, so an in-place delete would have written a
  65-key row to the database; a test fences that and the mutation was verified red.
- **11 egress sites filtered**: 3 on `app/api/v1/trace/single` (both cached branches and the tier 2
  inline response), 3 on `app/api/trace/single`, 2 on each poll route, and the webhook payload.
  The webhook filters at the dispatch itself, so both call sites hand it the raw record and there
  is exactly one place to get it wrong.
- **One list, not two.** `PropertyRecordCard` now runs its input through the same filter before any
  accessor touches it, so a field re-added to the panel renders nothing rather than reappearing on
  screen while the API withholds it. Its test file pins its sentinel map to the shared list.
- **A source scan** over `app/`, `lib/` and `components/` fails on any new unfiltered emission, so a
  fifth egress added later is caught rather than shipping quietly.
- A caller now receives **65 keys**. "Over 60 fields" in the API docs is still exact.
- 761 tests passing (from 699, 40 of them this change and the rest a concurrent agent's), `tsc` 0
  errors, eslint 47 problems, build compiles. 14 mutations applied one at a time, all 14 caught.

### Full Property Trace, phase 4 tasks 11 and 12: tier 2 on the public v1 API, and the completion webhook

**Task 11. `app/api/v1/trace/single` now runs tier 2**, automatic on an absent `ownerName` and on
an explicit opt-in, mirroring the phase 3b charge sequence step for step. Characterization tests
were written against the route FIRST and four of them went red on the change, which is what they
were for.

- **Track B keeps its own price derivation.** New `lib/api/pricing.ts` carries `rawPricePlanFor()`
  and `rawChargePerRecord()`, the RAW twins of `pricePlanFor` / `chargePerRecord`. The Track A
  helpers are grant-aware and reusing them here would have moved an existing API-key caller's bill
  from $0.40 to $0.25. No plan is hardcoded; the caller's real plan is derived and passed.
- The pre-flight gate now reserves the TIER 2 rate. It reserved the tier 1 rate and under-reserved.
- A billed tier 2 row is SERVED from the database, free. v1 had no tier-2 cache branch, so the
  customer re-bought a record they already owned.
- Fixed the latent 500: `zip.substring(0, 5)` was unguarded on a validation-OPTIONAL field, so a
  submit with no zip threw a TypeError before any vendor was called.
- Tier 2 returns the finished record inline; tier 1 is untouched and still returns a `traceId`.

**Task 12. `trace.completed` now fires for tier 2 on BOTH routes.** Tier 2 completes inline and
never reaches a poll route, so a webhook customer silently stopped receiving events. New
`lib/trace/traceCompletedWebhook.ts` sends the poll route's payload plus `property_record`, `tier`
and `owner_type`. Fires for every completed tier 2 INCLUDING a billed miss; never on a vendor
failure, which charges nothing. Fire-and-forget: a webhook failure cannot fail the request or the
charge. The HighLevel CRM push is deliberately NOT wired; it stays phase 4b.

**Files created:** `lib/api/pricing.ts`, `lib/api/__tests__/pricing.test.ts`,
`lib/trace/traceCompletedWebhook.ts`
**Files modified:** `app/api/v1/trace/single/route.ts`, `app/api/trace/single/route.ts`,
`app/api/v1/trace/single/__tests__/route.test.ts`, `app/api/trace/single/__tests__/route.test.ts`

**Numbers:** vitest 663 passing / 47 files / 0 failing (was 593 / 46). `tsc --noEmit` 0 errors.
`eslint app lib components` 49 problems, unchanged. `npm run build` compiles, exit 0.
**Mutations:** 20 applied in isolation, 20 caught. One (swapping in the Track A price helpers)
initially survived with ZERO tests red because the Suite sign-in kill-switch is off in the test
environment, which makes the two tracks agree; the test now sets the flag and the mutation is
caught.

---

### Full Property Trace, phase 3c: the single-trace page discloses the tier 2 charge

**The gate on shipping 3b.** The route bills per record submitted and bills a total miss too, so
a blank owner name could take the customer's money and hand back nothing. Nothing on the page
said so.

- **New `components/trace/FullTraceDisclosure.tsx`.** Inline, always on screen while the owner
  name is blank, no click required. Names the feature, says we go find the owner of record and
  pull the full property record, quotes the rate, and says the charge lands whether or not
  contacts come back.
- **The number is the caller's own rate.** The component derives it itself from the profile via
  `chargePerRecord()`, the same helper the route charges with, so no caller can pass it a rate
  and get it wrong. The page loads the three entitlement columns client-side, the way
  `trace/bulk` already loads its tier 1 rate.
- **No profile, no number.** While the profile is loading (or if it never arrives) the copy says
  "your per-record rate" and links to billing. Quoting $0.25 to a Pay-As-You-Go customer who
  will be charged $0.40 is a false statement about money; an honest sentence with no figure is
  not.
- **It shows exactly when the route bills tier 2.** The predicate is `isFullPropertyTrace()`,
  the route's own, not a second blank test that can drift. Whitespace is blank to both.
- **The owner name field is no longer `required`.** FOUND WHILE BUILDING THIS: `required` was
  still on the input and on the label, so the browser refused a blank submit outright and the
  tier the API charges for could not be reached from this page at all. Dropped the attribute,
  the asterisk, and the "Required for skip trace" helper line. AI Search is untouched.
- **Tests, 19 of them, all four mutations verified.** Hardcoding the rate fails 5, swapping the
  predicate for `ownerName !== ''` fails 1, deleting the disclosure from the page fails 2, and
  putting `required` back fails 1. Static `renderToStaticMarkup` in vitest, no jsdom and no new
  dependency.

### Full Property Trace, phase 3b: the tier 2 billing path goes into the session route

**A new billing path, so tests came first and every money decision was mutation-verified.**
Session route only. `app/api/v1/trace/single/route.ts` was deliberately NOT done — see below.

- **Trigger.** Tier 2 runs when `owner_name` is absent (automatic) or when the caller sends
  `full_property_trace: true` (opt-in, for someone who has the owner and wants the county
  record anyway). Its own flag, not `ai_research`: that feature is being deleted in phase 4 and
  overloading its flag would couple the two.
- **The charge sequence, in order.** Plan the route at the caller's own rate → run it → if a
  vendor FAILED, charge nothing → otherwise deduct once via `deductOrZero` → persist the record,
  the tier, and the amount that actually moved. The gate is `ExecutionResult.success`, never
  `ownerFound`: a billed miss and an unbillable outage both have `ownerFound: false`.
- **A total dossier miss IS billed** ($0.25 / $0.40 per record submitted) and **a vendor failure
  never is.** On a failure nothing billable is persisted either, so the row stays retryable
  rather than becoming a free cache entry that can never acquire its missing contacts.
- **The miss is cached.** `CACHE_HIT_FILTER` gained a third arm, `and(tier.eq.2,charge.gt.0)`,
  plus a JS twin (`isCacheHitRow`) so the route can SERVE the row rather than re-buy it.
- **The caller's real plan is billed.** `pricePlanFor()` / `chargePerRecord()` in
  `lib/suite/pricing.ts`, derived from `effectiveIsPro` exactly as `chargePerTrace` is. The
  pre-flight balance gate now reserves the tier 2 rate; it reserved the tier 1 rate before.
- **The whole request is synchronous.** Two new callers in `lib/tracerfy/client.ts` hit the
  SYNCHRONOUS endpoints (`business-trace/lookup/`, `trace/lookup/` + `trace/parcel/lookup/`)
  instead of the bulk-and-poll path the handoff named as a defect. `maxDuration = 60`.
- **ZIP backfill (added to 3b by David).** `executeRoute` now feeds the dossier's SITUS zip
  (`property.zip_code`) into pass 2's named lookup when the caller supplied none. Never the
  owner's mailing zip, which is a different place entirely on an absentee-owned parcel.
- **Two vendor-reading defects found in real payloads and fenced:** a FastAppend MISS carries an
  `error` string (reading it as a failure makes every miss unbillable), and a person whose role
  is `"REGISTERED AGENT,MANAGER"` is a manager — excluding everyone the flag marks would have
  discarded the contact on 1 of the 5 paid hits in the saved corpus.
- **Numbers:** 478 tests passing (from 380), 39 files, 0 failing. `tsc` 9 pre-existing dotenv
  errors, unchanged. eslint 54 problems, unchanged. **21 mutations applied and all 21 caught.**
- **Not done, on purpose:** the v1 API route (its still-live `aiResearch` path would double-bill
  the same record), bulk, UI, marketing copy, migrations.

### Full Property Trace, phase 3a: plan-aware pricing, address-only parcels, and the executor

**Scope was deliberately half of phase 3.** B5, B6 and `executeRoute()`. No billing, no
persistence, no API route, no UI: 3b depends on a pricing decision still with David.

- **B5 — `planRoute()` prices by PLAN.** It hardcoded the `pro` column, billing a
  pay-as-you-go customer $0.25 instead of $0.40 on tier 2 and $0.15 instead of $0.25 on tier 1,
  a 40% shortfall that produced no error and no complaint. The plan is now a **required**
  parameter: TypeScript refuses to compile a caller that has not thought about it, so the
  mis-wire cannot reach a customer. `DEFAULT_PRICE_PLAN` is **gone**, replaced by
  `FAILSAFE_PRICE_PLAN = 'wallet'`, which covers only what the compiler cannot (a JS caller, a
  NULL plan column) and prices the **dearest** column so a mis-wire overcharges and gets
  reported rather than undercharging invisibly.
- **B6 — `ParcelInput` accepts an address-only parcel.** `parcelIdLocal` and `county` are now
  optional, because nothing in PTP produces either and address mode is proven. The existing
  no-APN path was correct and was left alone. One latent defect it exposed WAS fixed: the tier 1
  `TRACERFY_PARCEL_APN` fallback would have been built with `parcel_id` and `county` undefined.
  It now routes to manual review instead of sending a request that cannot match.
- **`RoutePlan` now echoes `pricePlan` and `parcel`.** The tier 2 two-pass re-enters
  `planRoute()`, and it can only do so faithfully if the plan carries what it was planned from.
- **`lib/routing/executeRoute.ts` — the executor.** Pure of I/O except through injected vendor
  callables, so the whole spend path is testable without a network. Stops at the first hit
  (a second dossier key after a hit is $0.20 wasted per record). Two passes: the discovered owner
  is classified by NAME via `classifyOwnerName`, never by the vendor's `corporate_owned` flag,
  which returns FALSE for a Delaware LP. Reports spend per step from the vendor's own
  `credits_deducted`. Hands the 86-key property record through **by reference**. Never throws.
- **A vendor FAILURE is not a MISS.** A miss is free, final, and billable under the per-record
  model. A failure is free, not final, and not billable: it returns `success: false` with the
  error, and stops the remaining steps rather than compounding an outage against a rate limit
  shared across Tracerfy's endpoints. The caller gates the charge on `success`, never on
  `ownerFound`.
- **Tests: 337 → 380 passing, 36 → 37 files, 0 failing.** 43 added, written before the code.
  Six mutations verified the guards, each reverted after measuring: removing stop-at-first-hit
  kills 3, collapsing failure into miss kills 4, pointing the failsafe back at the cheap column
  kills 3, subsetting the raw record kills 2, assuming the dossier rate instead of reading
  `credits_deducted` kills 1, trusting `corporate_owned` kills 2.

### Full Property Trace, phase 2: the fixes that prevent double-billing

**Visible output: none. That is the phase, not a shortfall.** Phase 2 makes a row shape safe before
anything can create it. Nothing is wired; no user-facing behaviour is added.

- **Tests were written FIRST, against unmodified code.** `lib/utils/deduplication.ts`,
  `app/api/trace/single/route.ts`, `app/api/v1/trace/single/route.ts` and
  `app/api/cache/clear/route.ts` all had ZERO coverage while carrying the billing path. 45
  characterization tests pinning the OLD behaviour went green first: **310 passing, 34 files, 0
  failing** (from 265/30). Only then was anything changed. The 14 that then went red were exactly
  the ones pinning behaviour the fixes replace.
- **The new row shape.** Tier 2 bills per record SUBMITTED, so `is_successful = false` AND
  `charge > 0` becomes legal for the first time: the customer bought an 86-field property record,
  and contacts are a separate call that may return nothing. The whole codebase assumed
  `charge > 0` implies `is_successful`.
- **Migration written, NOT applied.** `20260917_trace_history_property_record_tier.sql` adds
  `property_record JSONB` and `tier SMALLINT`, both nullable. `supabase/schema.sql` updated so a
  fresh provision matches, with the columns declared after `created_at` because that is where
  `ADD COLUMN` puts them. No GRANTs: `ALTER TABLE` on a pre-existing table is exempt, and adding
  them would WIDEN the table's privileges, which is the self-write vuln class. The header says so,
  so nobody adds them cargo-cult.
- **B1: a paid tier 2 row is now visible to the cache.** `checkSingleDuplicate` filtered
  `.eq('is_successful', true)`, so a row whose value IS the property record was invisible and the
  customer was billed AGAIN for data they already own. Now `is_successful = true OR property_record
  IS NOT NULL`. A no-op against every existing row, because `property_record` is NULL on all of
  them. `checkDuplicates` (bulk) needs NOTHING: it never filtered on `is_successful`, so a tier 2
  row is already a free cache hit there.
- **B2: no billed row is ever targeted for deletion, and every delete checks its error.** All ten
  delete sites on `trace_history` ignored their error. `wallet_transactions.trace_history_id` and
  `usage_records.trace_history_id` both reference these rows with NO ON DELETE clause, so a delete
  on a referenced row FAILS with 23503 — and the swallowed failure then walked into
  `UNIQUE(user_id, address_hash)` on the INSERT, surfacing as a 500 that named nothing and leaving
  the address permanently un-retraceable. `lib/trace/billedRows.ts` now holds one definition of
  billed (`charge > 0 OR ai_research_charge > 0 OR property_record IS NOT NULL`), pushed into the
  database as a predicate so there is no read-then-delete race.
- **Delete-then-insert became reuse.** `UNIQUE(user_id, address_hash)` already means one row per
  address per user, and tier 2 enriches one row in two phases, so a row that survives the guarded
  deletes is now UPDATED in place. `charge`, `ai_research_charge`, `property_record` and `tier` are
  never in that payload.
- **B3: the ledger is self-describing.** `tier` is stamped at all 16 sites that write
  `trace_history.charge`, across two status routes, three crons, the bulk status route and the bulk
  settle helper. It exists because `PRICING.CHARGE_PER_SUCCESS_WALLET` and
  `PRICING.TIER2_PER_RECORD_SUBMITTED_PRO` are BOTH 0.25. A source-level invariant test fails the
  moment a new charge site is written without one. No backfill: existing rows stay NULL, which
  honestly means "before tiers existed".
- **19 mutations, every one caught.** Each fix was reverted in isolation and the suite re-run;
  all 19 turned at least one test red (1 to 8 failures each).
- **Verified:** 337 tests passing, 36 files, 0 failing. `tsc` 9 pre-existing dotenv errors,
  unchanged. eslint 54 problems, one FEWER than the 55 baseline (an unused import removed).

---

## 2026-09-17

### Full Property Trace, phase 3: tier 2 bills end to end on a single address

- **3a:** `planRoute` now takes the price plan as a REQUIRED parameter, `DEFAULT_PRICE_PLAN`
  deleted. A safe default still lets a mis-wire bill a customer wrong and be found from a
  statement; a required parameter makes the compiler refuse it. Free to do only because
  `planRoute` had no production callers yet. `FAILSAFE_PRICE_PLAN = 'wallet'` prices the DEAREST
  column, so a mis-wire overcharges (visible, refundable) rather than undercharging (invisible,
  compounding). `ParcelInput` accepts an address-only parcel. `executeRoute()` runs a plan through
  injected vendor callables, stops at the first hit, re-enters `planRoute` with the discovered
  owner, and **distinguishes a vendor FAILURE from a MISS**.
- **3b:** tier 2 wired into the session route, fully synchronous, no polling. **The billing gate is
  `execution.success`, never `ownerFound`** — see lessons L-007. A total dossier miss IS billed; a
  vendor failure never is. `CACHE_HIT_FILTER` gained a third arm so a billed miss is served free
  rather than re-bought.
- **ZIP backfill**, added by David: pass 2 fills `situsZip` from `property.zip_code`, which the
  dossier returns and we were discarding immediately before the lookup that needs it most. Never
  `mailing_address.zip` (the OWNER'S zip; 21 of 24 parcels are absentee). `address_hash` never
  rewritten.
- **Two vendor defects found in saved payloads**, both of which would have shipped silently: a
  FastAppend miss carries an `error` string alongside `hit:false`, so reading it as failure makes
  every billable miss unbillable; and `role` is comma-separated, so filtering on it discards 20% of
  paid hits.
- **A live 500 fixed:** the route called `zip.substring(0,5)` on an optional field, so any
  submission without a zip threw before reaching a vendor.
- **v1 DEFERRED deliberately.** It still runs AI research on `(aiResearch && !ownerName)` and
  deducts $0.15, and an absent owner name is ALSO the tier-2 trigger, so wiring it now would
  double-bill the same record and race two engines. It belongs immediately after the research path
  is deleted.
- 478 tests passing (from 337 at the start of phase 3), 27 mutations across 3a and 3b.

### Both migrations APPLIED to production, verified against a before-snapshot

- `20260917_trace_history_property_record_tier.sql` and
  `20260916_usage_records_unit_price_default.sql` applied to `rmmwkjmjchpfebxroyoo`.
- **Verified independently afterward, not trusted from the migration output:** `trace_history`
  3,836 rows unchanged, `wallet_transactions` 2,919 unchanged, `ai_research` 1,301 unchanged,
  `property_record` present as nullable `jsonb`, `tier` present as `smallint`, **0 rows
  backfilled**, **0 orphaned wallet references**, `usage_records.unit_price` default now 0.15.
- **Applied AHEAD of the deploy deliberately**, which is the safe direction for 20260917: old code
  ignores unknown columns, but the new code REQUIRES them and would 500 on every single-trace
  submit without them. The reverse order is the dangerous one.
- 20260916 is inert either way: `usage_records` has zero writers anywhere in the codebase.

### Full Property Trace, phase 2: nothing deletes a billed row

- **Found a LIVE bug, not just a tier 2 risk.** `wallet_transactions` and `usage_records` both
  reference `trace_history(id)` with no `ON DELETE` clause, so a delete on a billed row fails
  with 23503 rather than cascading, and none of the ten delete sites checked its error. The
  refusal looked like success: the row survived, the following INSERT died on
  `UNIQUE(user_id, address_hash)`, and the customer got a generic 500 that named nothing. The
  address became **permanently un-retraceable**, because `skip_cache` and `/api/cache/clear` fail
  the same way, and `cache/clear` returned `{success:true}` regardless.
- `lib/trace/billedRows.ts` holds one definition of "paid for", pushed into SQL so there is no
  read-then-delete race. Delete-then-insert became **reuse**: the unique constraint already means
  one row per address per user, so a surviving billed row is updated in place.
- The cache now treats `property_record IS NOT NULL` as a hit, so a paid tier 2 record with no
  contacts is never re-billed. `tier` is stamped at all 16 charge-writing sites, with a
  source-level invariant test that fails if a new one is added without it.
- **Tests were written FIRST.** 45 characterization tests pinned current behaviour green (265 to
  310) against unmodified code before anything changed. 19 mutations run, 19 caught; re-verified
  independently that killing the delete guard turns 9 red and killing the cache guard turns 2 red.
- 337 tests passing, `tsc` unchanged, eslint 54.

### Full Property Trace, phase 1: the dossier client

- **`lib/tracerfy/dossier.ts`** plus 34 tests, 6 sanitized fixtures and a dry-run script. Nothing
  wired to a route, UI or billing path. No live API call made. 265 tests passing (from 231), `tsc`
  and eslint unchanged from baseline.
- **The real payloads corrected the plan twice before code was written.** `property` carries NO
  owner field; the owner is in `response.owners[]`. And an entity arrives as
  `{first_name: "", last_name: "Colmaven, Llc", age: ""}`, the whole name in `last_name`. Building
  from the plan rather than the payloads would have shipped a client returning no owner at all.
- **A fidelity fence guards the 86-key record.** Subsetting the property object turns 7 tests red,
  mutation-verified. A "cleanup" that quietly returns fewer fields than the customer paid for
  cannot ship without someone deleting a test deliberately.
- **Fixtures are sanitized derivatives, because `tasks/research-test/` is gitignored** and holds
  purchased data on 63 real people. Full 86-key property object and entity names kept; individual
  names, ages and the whole `contacts` block scrubbed. 373 real-person values word-boundary matched
  against every committable file: zero leaks.
- **Export decisions settled.** All 86 fields are STORED raw; **65 are EXPORTED** (86 minus 6
  provably-wrong minus 15 propensity scores), plus derived loan columns. The 18 never seen in our
  sample ARE exported, as empty columns, because that is coverage not correctness. Export rules:
  append never reorder, stable column set, empty means empty. This also makes "over 60 fields"
  exact rather than asserted.
- **Portfolio-debt gap found by David, and it exposed a hole in the export decision.**
  `open_mortgage_balance` was going to ship BARE, so a customer would export `$175,000,000` against
  a 41,588 sqft building as a plain spreadsheet number. That is the same failure class as
  `estimated_value`, which we had just blocked. Fix: `assessLoan()`'s verdict exports beside the
  balance, with `loan_basis` so the customer knows how much to trust it. Measured first: of 7
  mortgaged parcels only **1** can be judged against a sale price; 5 of 7 return `unknown`.
  `assessLoan()` has zero callers and moves into phase 3.
- **`assessLoan()` handles stale sales but not REFINANCING**, and `recording_date`,
  `document_type` and `years_owned` all sit unread at 82% fill, a higher rate than
  `last_sale_price` itself. A recording date newer than the sale date is an unused refi signal.
- **`price_per_sqft` moved OUT of the blocked set.** Measured: it is `last_sale_price ÷
  building_size_sqft`, not assessed-derived. It had been blocked on a REDUNDANCY argument while
  filed alongside six fields blocked for being WRONG. Now exported with its 0 rendered blank,
  because 0 there means "no sale price on record" and shipping it would be fabricated data.

### Decisions that shape the tier 2 build, plus a marketing debt worth flagging

- **AI Search is being REMOVED, not replaced in place.** I recommended replace-in-place, David
  accepted it on my recommendation, and reconnaissance then showed it does not work:
  `AIResearchResult` is a stored-and-returned contract across two public routes, two webhooks, the
  CSV export, the MCP surface and `AIResearchCard`, with no room for an 86-field property record.
  Removal is cleaner. The recommendation should have come after the recon, not before.
- **Tier 2 ships as a named customer-facing feature.** David proposed "Property Enrichment"; I have
  recommended "Full Property Trace" because PTP's whole vocabulary is *trace*, and "enrichment"
  implies you already have the property when the dominant trigger is not knowing who owns it.
  **Name not yet decided.**
- **MARKETING DEBT, for whenever the marketing pages are next touched: this feature needs a FULL
  DEDICATED SECTION.** It is the entire justification for the tier 2 price and the landing page
  says nothing about it today. The honest claim set is the measured field inventory in the handoff:
  86 fields returned, 46 with a usable value. Do not promise the distress flags.
- **Charge follows the vendor call, not the calendar.** A rerun served from the user's own stored
  record is free; one that spends at Tracerfy is charged. Billing and caching become the same
  condition, so they cannot drift apart. The cache is per-user and must stay that way.
- **Open item 8 closed** by reading Tracerfy's actual terms. Per-user storage is permitted; what
  4.8 forbids is resale "as a standalone data feed, database, directory", which is the
  property-registry propagation David had already ruled out independently.
- **Raised in its place:** Tracerfy forbids FCRA-regulated use including tenant screening, and PTP
  passes none of that through to its own users. No FCRA language or terms route exists anywhere in
  the app. Not a code fix; a question of which surface carries it.

## 2026-09-16

### Pricing repriced across every surface, three billing defects fixed, notification drafted

- **Why:** the app advertised $0.07/$0.11 in 19 customer-visible places while the new model
  charges $0.15/$0.25/$0.40. Hard merge blocker; it deploys with the app.
- **The canonical pricing table now lives in `SESSION-HANDOFF-2026-09-16.md`.** Two axes, tier
  and plan, four numbers. Tier 1 (owner known) $0.15 Pro/AcqPro, $0.25 PAYG. Tier 2 (owner
  unknown or dossier wanted) $0.25 Pro/AcqPro, $0.40 PAYG. **Owner type selects the VENDOR, not
  the price.** It took three restatements from David to land; see lessons L-005.
- **`CHARGE_PER_FASTAPPEND_SUCCESS` (flat $0.25) retired**, not repriced. Under the new model an
  entity trace with a known owner is an ordinary tier 1 trace. Entity settle path in
  `settleBulkJob.ts` and both cron sweeps now bill the plan-aware tier 1 rate. A test asserts the
  constant cannot come back.
- **Three defects found by adversarial review, all fixed and mutation-verified:**
  1. A new MCP string promised "a record that comes back with no match is not charged". False:
     `settleBulkJob.ts` leaves the $0.15 research charge booked on an entity no-match. That string
     is quoted to Claude *before* it spends a user's wallet. Now scoped to what the settle code does.
  2. `worstCaseCost()` reserved a flat $0.25 per entity where the v1 route reserves rate + $0.15.
     The gap went from $0.01 to $0.15 per record at the new rates. Now matches the v1 formula,
     with a test fencing it.
  3. **Four surfaces recomputed historical bulk charges as `records_matched × today's rate`**,
     so every past job would have displayed a number the user was never charged. Now sums the
     stored `trace_history.charge` via new `lib/trace/bulkJobCharges.ts`. A fifth instance at
     `app/api/trace/bulk/status/route.ts` was found during the fix. Jobs with no reachable rows
     render a dash, never a fabricated $0.00.
- **Dossier field inventory measured and documented** by counting keys in the 24 saved raw
  responses: 86 fields returned, 46 with a usable value. "60+ fields" is accurate and conservative.
- **The handoff's "every status flag at 100%" was a presence count and is corrected.** Across 24
  commercial parcels `absentee_owner` is true 88% of the time, `owner_occupied` 4%, and the other
  nine flags (vacant, tax delinquent, tax lien, pre-foreclosure, foreclosure, inherited, death,
  judgment, HOA) are true **zero** times. The distress flags were pulled from all customer copy.
- **Verified:** 221 tests passing (was 217), `tsc` 9 pre-existing dotenv errors unchanged, eslint
  55 problems unchanged from the `main` baseline. Nothing committed, nothing pushed, no migration
  applied, `main` untouched.
- **Deliberately not done:** tier 2 is not wired, so nothing here ships until `planRoute()` has a
  caller. The landing page's free-no-match promise is true against the canonical model and false
  against the legacy code path, and resolves when the wiring lands.

### Owner routing module: vendor selection, tier pricing, portfolio-debt detection

- **Why:** measured whether the AI research step can identify a commercial parcel's owner well
  enough to route it to the right skip-trace vendor. It cannot. Across 13 parcels Brave search
  returned **0 owners**, because county parcel records are not in any web index (probed directly:
  `site:esearch.mobilecopropertytax.com` returns the landing page, cart page and terms page, and
  zero parcel records). `trace/parcel/lookup/` also returned **0 owners** on 13 parcels while
  billing 55 credits, because it returns people and a commercial owner is an entity.
- **What works:** `property-search/lookup/` (the dossier) returned an owner name on **23 of 24**
  parcels at $0.20/hit, entity-vs-individual classifies deterministically from the name string
  for free, and FastAppend resolved contacts with `role` and `is_registered_agent` on
  **13 of 22** entities at $0.10/hit. No search step is used anywhere in that path.
- **Added:** `lib/routing/ownerRoute.ts` — `classifyOwnerName()`, `assessLoan()`, `planRoute()`.
  Pure decision logic, no I/O. 63 tests, 5 mutations verified red.
- **Pricing encoded:** tier 1 $0.15 per successful trace (owner already known), tier 2 $0.40 per
  record (owner absent, or the caller wants the 60+ field dossier).
- **Findings that changed the design:**
  - `corporate_owned` is unreliable — returned `false` for `STORAGE TRUST PROPERTIES, L.P.`,
    a Delaware LP. The name-string test got it right. Classify from the name.
  - `estimated_value === assessed_value` on **23 of 23** parcels in OH, CA and UT. There is no
    AVM. Assessed/sale ran 0.07 to 0.59 within Ohio alone, so assessed cannot be scaled to
    market and `estimated_equity`, `equity_percent`, `high_equity` and `free_clear` are unusable.
  - `open_mortgage_balance` carries blanket debt ($175M against a 41,588 sqft building).
    `assessLoan()` weeds these out using sale price as the basis, never assessed value.
  - `property_owner` returned **false for a verified owner of record** on an absentee-owned
    parcel. It is a guard for fishing without a name, not a filter to apply once you have one.
  - The dossier's APN and address keys **fail independently** — one parcel missed on APN and hit
    on address returning the owner the county recorder confirms, another did the reverse. Misses
    are free, so `planRoute` emits both and the caller stops at the first hit.
- **Verified against both vendor ledgers**, not documentation: Tracerfy 290 credits @ $0.0200,
  FastAppend 13 credits @ $0.10, 25 calls billed on 13 hits. Total research spend $8.32.
- **Not committed:** `tasks/research-test/` is gitignored. It holds purchased skip-trace PII for
  63 real individuals (DOBs, phones, emails). Test fixtures use synthetic individual names that
  preserve the string shapes under test; entity names are real and public.

---

## 2026-09-14

### Manual $20 wallet credit: anthony.matina@gmail.com

- **Why:** David authorized a $20 courtesy credit, knowing PTP pays the Tracerfy / FastAppend
  cost for whatever it's spent on.
- **How:** called the existing `credit_wallet_balance` RPC on production (`rmmwkjmjchpfebxroyoo`)
  for user `9807af67-acde-4ee8-ad6e-8b073607165d`, description `Manual credit: $20.00 (admin)`,
  no Stripe payment intent. No code or schema change. Guarded with a NOT EXISTS so a re-run
  within 24h is a no-op.
- **Verified live:** the credit transaction reads `10.23 -> 30.23` at 16:28:31 UTC and the ledger
  chains without a gap. The user was running a bulk trace at the time; the next debit
  (`30.23 -> 30.08`) landed one second later on top of the credit, which proves the row lock held.

---

## 2026-09-04

### ZIP is optional; the dedup key drops to STREET|CITY|STATE

- **Why:** the property-registry is being wired into the suite gateway for owner enrichment and
  could not clear the door. ZIP was required on every record — and `skipTraceBulk` fails the
  ENTIRE batch if one record is invalid — while never reaching either vendor. The Tracerfy
  person CSV has no zip column (`lib/tracerfy/client.ts:54`) and FastAppend submits
  `business_name,state` only. The registry supplies a situs city for 804 counties and a ZIP for
  766, so requiring it made **241 counties / 16,062,225 parcels** untraceable for a field
  nothing downstream reads.
- **Code:** `normalizeAddress` now returns `STREET|CITY|STATE` and its `zip` parameter was
  REMOVED rather than ignored, so TypeScript forced every one of the 12 call sites across 9
  files to be revisited. `validateAddressInput` takes `zip?` — absent is valid, supplied and
  malformed still errors. `recordSchema.zip` and `AddressInput.zip` are optional.
  `checkSingleDuplicate` lost its now-unused `zip` parameter.
- **Tests:** `address-normalizer.ts` had **no test coverage at all**; it now has 13. Suite
  138 → **151 passing**, `tsc` clean, build clean, eslint unchanged from `main` (55 pre-existing).
  Both fences mutation-proved: restoring the ZIP requirement reds 2 tests, putting ZIP back in
  the key reds 4, reverting is green.
- **Migration `20260904_zip_optional_three_part_dedup.sql`**, applied and independently verified.
  Re-keys 3,617 rows; **deletes nothing**.
- ⚠️ **The first draft was wrong and Postgres caught it.** It deleted the redundant row of each
  colliding group and hit `23503: violates foreign key constraint
  wallet_transactions_trace_history_id_fkey`. **7 of the 15 redundant rows are referenced by the
  billing ledger** — they are receipts. The transaction rolled back with nothing changed. The
  shipped version re-keys only each group's survivor and leaves the 15 non-survivors
  byte-identical, which is safe by construction: a 4-part string cannot hash to a 3-part one, so
  `UNIQUE(user_id, address_hash)` holds automatically.
- **Verified after applying:** 3,632 rows total (unchanged), 3,617 three-part, 15 four-part by
  design, 0 hash mismatches, 0 duplicate keys, 2,591 wallet rows unchanged, **0 orphaned wallet
  references**.
- **It fixed a billing defect, not just a blocker.** The 15 collisions are not distinct
  properties — `3661 AIRPORT BLVD|MOBILE|AL` under both 36608 and 36609, `1850 MAGWOOD DR|
  CHARLESTON|SC` under both 29414 and 29403. The old four-part key was letting the same property
  be traced and charged twice.
- **Docs:** `docs/AGENT_BULK_INTEGRATION.md` said ZIP was required. Corrected.
- **Found, not fixed here:** `suite-gateway/lib/tools/crm-push-owners.ts:493-499` reads five
  field names PTP does not emit (`owner_name`, `email`, `phone`, `cost`, `is_entity` versus the
  real `input_owner_name`, `owner_contact_name`, `owner_contact_source`, `charge`, `phone_count`,
  `email_count`), so enrichment always reports found-nothing with `spent: 0`. Its poll budget is
  also 2.4 seconds against jobs that run 5 to 30 minutes.

---

## 2026-08-17

### Resolved owner contact (person) now has a name in the payload

- **Problem:** Suite Gateway consumers were delivering the company name, its phone and the
  owner's email into a spreadsheet, but never the owner contact person. Reported as "PTP is only
  returning the company name and phone and email, not the owner contact (Person)."
- **Root cause: not a data problem — a naming problem.** PTP was resolving the person all along.
  The per-record payload carried FOUR keys named some variant of "owner name" at three nesting
  levels, meaning two different things: `input_owner_name` and `research.owner_name` are the
  ENTITY, while `trace_result.owner_name` and `contacts.owner_name` are the PERSON. Consumers
  mapping a column called "owner name" matched the company they already had and discarded the
  person. Nothing in the payload was named for the thing an entity skip trace exists to produce.
- **Proof:** in the 2026-08-13 Dallas run, 45 of 77 traces resolved a real human and 0 of them
  reached the delivered CSV, while those same people's *personal emails* did
  (`dhamann2@gmail.com` next to "Magnolia Property Company", `joebeardjr@yahoo.com` next to
  "Westdale"). David independently confirmed it by re-running Houston with "including the owner
  contact, the person" appended to the prompt: same code, 66 of 83 names delivered.
- **Changes:**
  - New `resolveOwnerContact()` in `lib/ai-research/contacts.ts` — one definition of "who is the
    human behind this owner", returning `owner_contact_name` + `owner_contact_source`
    (`fastappend` | `person_trace` | `ai_research`). Never returns a company name.
  - `owner_contact_name` / `owner_contact_source` added at the top level of the per-record payload
    in both the MCP surface (`lib/suite/mcp-tools.ts`) and its REST twin
    (`app/api/v1/trace/bulk/status/route.ts`), which stay line-for-line identical by design.
  - `list_traces` now includes the resolved contact; it previously returned the company name plus
    bare phone/email counts and no contact at all.
  - `sweep-bulk-research`'s inline `resolvedPerson` chain collapsed onto the shared helper
    (behavior-preserving — no `trace_result` exists at that point).
  - Tool descriptions + API docs page now state that the two owner-name fields are different and
    that the company must never be substituted for the contact person.
- **Verification:** TDD throughout (every test watched fail first). Mutation test: deleting the
  `owner_type === 'individual'` guard makes the payload emit "Fountain Parc Apartments LLC" as a
  contact person and turns the test red. Replayed all 77 real Dallas rows through the shipped
  helper: 56 resolve a human, including every name the sheet lost, with no re-trace and no wallet
  spend. 138 tests pass, `tsc --noEmit` clean.
- **Not changed:** `suite-gateway` (it proxies `ptp_*` verbatim and needed no edit).

---

## 2026-08-12

### Fix the emailed sign-in links: password reset was broken for every user
- **Problem:** A member (`ventexproperty@gmail.com`) could not sign in by password, magic link, or the Suite button, and forgot-password did nothing. Reported as one user's lockout; three of the four causes turned out to affect every user.
- **Evidence gathered before changing anything:** His account was healthy on both sides (PTP confirmed Feb 5, bcrypt password set, not banned; gateway account confirmed Aug 11 with a lifetime grant including `prop-tracer-pro`; `user_profiles.email` matching exactly and `gateway_sub` NULL, so linking would be a clean link, not a refusal). Email delivery was working: every `auth.flow_state` row had `auth_code_issued_at` set 20–30s after the send, meaning he clicked each link promptly. Four clicked links (08-10 signup, 08-12 magiclink, 08-12 recovery, 08-12 magiclink) produced **zero** rows in `auth.sessions` — newest session was 08-09. So the PKCE code was reaching the app and never being exchanged. `last_sign_in_at` still 08-09 confirmed his password attempts genuinely failed the credential check (probing the endpoint returned a normal `invalid_credentials`). No deploy since ~07-24, so nothing had regressed in code.
- **Root cause A — `/reset-password` never exchanged the code.** `resetPasswordForEmail` sent `redirectTo: /reset-password`, and `@supabase/ssr`'s `createBrowserClient` hardcodes `flowType: 'pkce'`, so the recovery link landed with `?code=`. But `app/(auth)/reset-password/page.tsx` is a client page that only calls `updateUser({ password })` — nothing ever called `exchangeCodeForSession`, so with no session it failed "Auth session missing!". Forgot-password had never worked for anyone.
- **Root cause B — the middleware then bounced the page.** `/reset-password` sits in `publicRoutes`, and the middleware redirected any authenticated user off public routes to `/dashboard`. Confirmed live in Chrome (`/forgot-password` → `/dashboard`). Since the fix establishes a session *before* the form renders, fixing A without B would just have moved the wall.
- **Root cause C — failures were silent.** `/auth/callback` redirected to `/login?error=auth_callback_error`, but `login/page.tsx` only read `suite_error`. Users were dumped back on a bare login form with no message, which is why this read as "nothing happens" and stayed undiagnosed.
- **Root cause D — Suite consent window too short.** `api/auth/suite/start` gave `suite_state`/`suite_verifier`/`suite_nonce` a 10-minute TTL. The gateway is invite-only and passwordless, so a first-time member must leave for their inbox mid-flow; past 10 minutes the callback fails `invalid_request`. The rest of the OAuth chain checked out (client registered, redirect_uri matching, consent page reachable, `next` preserved through gateway login, grant valid). `email_verified` was a red herring — working accounts carry the same `identity_data.email_verified: false`.
- **Changes:**
  - `app/auth/confirm/route.ts` (new) — server route consuming the one-time `token_hash` via `verifyOtp`, then redirecting to a validated `next`. Needs no browser-held `code_verifier`, so a link requested on a desktop works when opened on a phone. That cross-device case is what PKCE structurally cannot serve.
  - `lib/auth/email-link.ts` (new) — `isEmailOtpType` allowlists `type` before it reaches GoTrue; `safeNext` restricts the post-confirm redirect to same-origin relative paths (a verified session rides on that redirect). Mirrors suite-gateway's `lib/safe-next.ts` deliberately so the two apps cannot drift.
  - `lib/auth/login-errors.ts` (new) — fixed developer-authored copy per error code, plus `loginErrorFromSearch` which reads **both** `suite_error` and `error`. Never echoes the raw param (same phishing hole `lib/suite/login-errors.ts` exists to close).
  - `app/(auth)/forgot-password/page.tsx`, `app/(auth)/login/page.tsx` — point at `/auth/confirm?next=…`; login delegates its banner to `loginErrorFromSearch`.
  - `lib/supabase/middleware.ts` — added `authedAllowedRoutes` so an authenticated user can reach `/reset-password` and any `/auth/*` route. Replaces the old exact-match `!== '/auth/callback'` exemption.
  - `lib/supabase/client.ts`, `server.ts`, `middleware.ts` — `SameSite=None` → `Lax`. None existed only for the AcquisitionPRO/GoHighLevel iframe embed, which was removed weeks ago; a `SameSite=None` cookie is a third-party cookie, exactly the kind browsers now restrict, and the most likely reason the PKCE verifier went missing. Lax still covers the top-level navigation an emailed link performs.
  - `app/api/auth/suite/start/route.ts` — consent window 10 → 30 minutes.
- **Supabase config (Management API, applied to prod):** Recovery and Magic Link templates now use `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=…`; `uri_allow_list` widened to `http://localhost:3001/**,https://proptracerpro.com/**` so `/auth/confirm?next=…` matches with its query string. Deliberately **no** `proptracerpro-*.vercel.app` glob: anyone who registered such a name could receive a `token_hash`. Prior values snapshotted before patching.
- **Verified:** 129 tests pass across 23 files, `tsc --noEmit` clean. Each of the three new guards was deleted in turn to confirm the tests go red (open-redirect guard → 1 failure; middleware reset-password allowance → 2; reading the `error` param → 1). Confirmed empirically against the live project that `POST /auth/v1/verify` with a `pkce_`-prefixed `token_hash` returns a full session, which is why no separate non-PKCE request path was needed. A real recovery email was sent to a throwaway account and inspected in Gmail to confirm `{{ .RedirectTo }}` renders a well-formed link.
- **Left alone:** signup confirmations still use `{{ .ConfirmationURL }}` → `/auth/callback`, which also routes first-time users through `/onboarding`. The CSP `frame-ancestors` allowlist still names the GoHighLevel domains; it is now dead config but harmless, and removing it was out of scope for this fix.

---

## 2026-05-11

### Stall-detect Tracerfy upstream failures so callers stop polling 'processing' forever
- **Problem:** Both bulk and single skip-trace sessions were sitting at `status: 'processing'` for 20–30+ minutes from the caller's perspective. The Lead-Gen Agent was retrying traces at its internal 20-minute timeout, believing PTP failed and generating duplicate `trace_history` rows + duplicate Tracerfy submissions. Last week's fixes (`d780e9d` research-cron stale claims; `5407f2e` v1 bulk status timeout + parallel polling) targeted two unrelated paths; this is a third latent bug that becomes visible under Tracerfy upstream pressure.
- **Root cause:** `lib/tracerfy/client.ts` `getJobStatus()` silently coerced *every* non-success Tracerfy response — 503, 429, unknown response shape — into `{ success: true, pending: true }`. All four status endpoints (v1 single, v1 bulk, dashboard single, dashboard bulk) then treated "Tracerfy is genuinely working" and "Tracerfy is broken / rate-limiting us / returning garbage" as the same state and returned `status: 'processing'` to the caller indefinitely. `sweep-stale-traces` is the only server-side recovery and doesn't kick in until 60 minutes (per `STALE_PROCESSING.CRON_TIMEOUT_MINUTES`) — way past the agent's retry window. Callers had no diagnostic signal at all.
- **Changes:**
  - `lib/constants.ts` — added `TRACERFY_STALL_MINUTES = 15` under `STALE_PROCESSING`. Long enough to absorb normal Tracerfy queue depth, short enough that the Lead-Gen Agent's 20-min retry isn't tripped. Left `CRON_TIMEOUT_MINUTES` at 60 (different purpose — second-line "give up entirely" deadline used by the cron).
  - `lib/tracerfy/client.ts` — exported new `TracerfyErrorReason` union (`'rate_limited' | 'upstream_unavailable' | 'malformed_response' | 'network_error' | 'auth_error'`). `getJobStatus()` now tags returns with `errorReason` on 429 (`rate_limited`), 503 (`upstream_unavailable`), 401/403 (`auth_error`, also flips `success: false`), unknown response shape (`malformed_response`), and caught fetch errors (`network_error`). The `pending: true` contract is preserved — the tag is purely additive diagnostic info so callers can distinguish "still patiently waiting" from "Tracerfy is unhealthy and we're polling through it".
  - `app/api/v1/trace/status/route.ts` — after `getJobStatus()`, compute `ageMinutes` from `trace.created_at`. If `errorReason` set AND age ≥ 15min → update row to `status: 'error'`, return `{ success: false, status: 'error', error, tracerfy_state, age_minutes }`. The existing `'processing'` branch now includes `tracerfy_state` (errorReason or `'pending'`) and `age_minutes` in every response so the agent sees Tracerfy health even while still waiting.
  - `app/api/v1/trace/bulk/status/route.ts` — `resolveOne` records the `errorReason` per `tracerfyJobId` in a `stalledByErrorReason: Map` when polls come back unhealthy. After the parallel batch completes, if the parent `traceJob.created_at` is past the threshold AND any stalled buckets exist, those rows get promoted to `error` via a single `.in('id', stalledRowIds)` update. If no rows remain processing after stall promotion, the parent `trace_jobs` is finalized as `failed` with a descriptive `error_message`. Imported `TracerfyErrorReason` from the client. Pending-state response now also surfaces `tracerfy_state` + `age_minutes`.
  - `app/api/trace/status/route.ts` (dashboard single) — mirror of the v1 single endpoint fix. The `_debug` payload gains `tracerfy_error_reason` for in-browser diagnostics.
  - `app/api/trace/bulk/status/route.ts` (dashboard bulk) — simpler than v1 because the dashboard bulk endpoint polls one shared `tracerfy_job_id`. If `errorReason` set AND job age ≥ 15min → finalize `trace_jobs` as `failed` with `error_message`, bulk-update all still-processing `trace_history` rows for that `tracerfy_job_id` to `error`. Existing pending responses gain `tracerfy_state` + `age_minutes`.
- **No schema migration.** `trace_history.error_message` doesn't exist; per-row error reasoning is surfaced in the API response + Vercel logs (`console.error` with `[v1/trace/status] stall: trace=… reason=… age=…`). `trace_jobs.error_message` already existed and gets the bulk stall reason.
- **Stall threshold is gated on `errorReason` being set** — a genuine `pending: true` from Tracerfy with no `errorReason` keeps the row in `processing` regardless of age. We only promote to `error` when Tracerfy is *actively* unhealthy AND the row is old. This avoids false-erroring legitimate slow Tracerfy jobs.
- **Verified:** `npx tsc --noEmit` clean. `npm run lint` — 35 pre-existing errors, 12 pre-existing warnings, none introduced by this change (the one prefer-const error my first pass introduced was fixed before committing).
- **Why this didn't surface in last week's fixes:** `d780e9d` and `5407f2e` were targeting PTP-side internal failures (cron stale claims, status endpoint timeouts). Neither investigated the `getJobStatus()` return-shape problem because the failure mode at the time was internal, not external. The error-masking pattern has been in the code since the initial Tracerfy integration; it only becomes visible under Tracerfy upstream pressure.

---

## 2026-05-09

### Bundle FastAppend business-trace charges into a single $0.25 per successful row
- **Problem:** After the morning fix that started crediting FastAppend successes, the bulk run on `ea6a10f0` showed 7 of 14 successes credited at $0.07 each — math correct relative to the per-trace fee, but not the user's intended pricing model. The user wants FastAppend successes billed as a single bundled $0.25 (covering AI research + trace combined) per credited row, not as separate $0.15 + $0.07 entries. Additionally, 7 of the 14 successes never got credited at all because they came in via the async FastAppend recovery path (`sweep-business-traces`), which my morning fix didn't touch.
- **Root cause:** Two issues. (1) The trace-credit charge for FastAppend rows used the tier-aware `chargePerTrace` ($0.07/$0.11), and the AI research $0.15 was always booked as a separate ledger entry. There was no concept of a bundled price. (2) The async recovery cron (`sweep-business-traces`) only merged FastAppend contacts into `ai_research` — it never re-evaluated the row's `is_successful` / `charge` / `status` fields, and never bumped the parent `trace_jobs.records_matched`. So when FastAppend lands after the bulk job has already finalised, the row stays as no_match in the user's history with $0.15 of research charge and no successful credit.
- **Changes:**
  - `lib/constants.ts` — new `PRICING.CHARGE_PER_FASTAPPEND_SUCCESS = 0.25` constant. Single flat price (not tier-aware) for any row whose contacts come from FastAppend.
  - `app/api/cron/sweep-bulk-research/route.ts` — restructured the per-row processing. **Before submitting Tracerfy or charging AI research**, the cron now checks whether FastAppend's inline business-trace poll already returned phones/emails (`traceCreditFromFastAppend()`). If yes: persists research with `ai_research_charge: 0`, marks the row `success` with `charge: $0.25`, deducts a single $0.25 from the wallet (`'FastAppend business-trace contacts (bundled research + trace)'`), and **skips Tracerfy submission entirely** — FastAppend already has the commercial-DB owner contacts the user paid for. Only when FastAppend has nothing does the cron fall through to the original flow (charge $0.15 research, submit Tracerfy or mark no_match). Removed the now-dead `chargePerTraceByUser` cache and `getUserChargePerTrace` helper from the morning fix.
  - `app/api/v1/trace/bulk/status/route.ts` — single-row entity finalisation now branches on (a) Tracerfy has contacts → charge $0.07/$0.11 trace fee on top of the $0.15 research already booked (Tracerfy total: $0.22), (b) Tracerfy has nothing but FastAppend contacts arrived async between cron and status → **refund** the $0.15 research (`credit_wallet_balance` with description naming the bundle) then **deduct** the bundled $0.25, set `ai_research_charge: 0` and `charge: $0.25` on the row, (c) neither has contacts → mark no_match, leave the $0.15 research charge in place (will be refunded later if FastAppend lands via async recovery).
  - `app/api/cron/sweep-business-traces/route.ts` — after merging FastAppend results into `ai_research`, re-evaluates billing. When the row is currently `is_successful=false` and FastAppend now provides phones/emails, the cron refunds the prior `ai_research_charge` (if any), deducts $0.25 bundled, updates the row to `status: 'success'` with `charge: $0.25` and `ai_research_charge: 0`, and bumps the parent `trace_jobs.records_matched` so the bulk-job totals stay consistent. Rows already credited as success are left alone (just merge contacts as before).
- **Per-row billing matrix after this change:**
  - FastAppend success (sync, in cron): `charge=$0.25, ai_research_charge=0`. One ledger entry: $0.25.
  - Tracerfy success after AI research (no FastAppend): `charge=$0.07/$0.11, ai_research_charge=$0.15`. Two ledger entries totalling $0.22/$0.26.
  - Tracerfy no_match, FastAppend lands async between cron and status: `charge=$0.25, ai_research_charge=0`. Three ledger entries (debit $0.15, credit $0.15 refund, debit $0.25) net $0.25.
  - Tracerfy no_match, FastAppend lands async after status finalised: same net $0.25 via `sweep-business-traces`. `trace_jobs.records_matched` bumped to keep parent totals correct.
  - Research found owner but no contacts anywhere: `charge=0, ai_research_charge=$0.15`. One ledger entry: $0.15.
  - No owner found: no charge.
- **Verified:** `npx tsc --noEmit` clean. `npx eslint` on changed files: only the pre-existing `'erroredStale' should be const` warning in sweep-business-traces, untouched by this change. Full `npx next build` completes without errors.

### Credit FastAppend business-trace contacts as successful traces in bulk runs
- **Problem:** Bulk job `f3b1e32a-04f5-457f-a922-8461fd68b0c6` (20 Lafayette Parish LLC leads) returned 14 records with real contact name + email/phone — sourced via FastAppend's business-trace path during AI research — but `trace_history` only marked **1** of those as `is_successful=true` with a `$0.07` trace charge. The remaining 13 were stored as `status='no_match', is_successful=false, charge=0`, so the user got the contacts they paid for but wasn't credited or billed for the trace. AI research charges ($0.15/owner found) were applied correctly; the gap was specifically on the per-row trace credit.
- **Root cause:** Three places downstream of FastAppend ignored `ai_research.business_trace_contacts` when deciding whether a row was a successful trace and only looked at the Tracerfy person-skip-trace result. (1) In `app/api/v1/trace/bulk/status/route.ts:140-185`, the single-row entity finalization derived `isSuccessful` purely from the Tracerfy parsed result; if Tracerfy returned no contacts, the row was finalized as no_match even when FastAppend had already produced phones/emails on the same row. (2) In `app/api/cron/sweep-bulk-research/route.ts`, both the no-`resolvedPerson` branch and the Tracerfy-submit-failed branch jumped straight to `status: 'no_match', is_successful: false, charge: 0` without checking whether FastAppend had already delivered contacts. The comment at the submit-failed branch acknowledged the issue ("business_trace_contacts may still carry FastAppend phones/emails which are valid results") but the code didn't credit them. With LLC properties — where Tracerfy commercial coverage often misses the principal but FastAppend doesn't — this pattern hit ~all rows.
- **Changes:**
  - `lib/ai-research/contacts.ts` — new shared helper `traceCreditFromFastAppend(research)` that returns `{ trace_result, phone_count, email_count }` shaped like a Tracerfy `TraceResult` if `business_trace_contacts` has at least one phone or email, or `null` otherwise. Phone-type strings are normalised onto the internal `'mobile' | 'landline' | 'voip' | 'unknown'` union so downstream consumers don't have to defensive-cast. Storing FastAppend contacts in the same `trace_result` shape keeps the history page and per-record API response consistent regardless of which provider the data came from.
  - `app/api/v1/trace/bulk/status/route.ts` — when finalising a single-row entity submission and Tracerfy returned no contacts, fall back to `traceCreditFromFastAppend(row.ai_research)`. If FastAppend has data, `is_successful: true`, `phone_count` / `email_count` reflect the FastAppend payload, `trace_result` stores the FastAppend-shaped record, and `chargePerTrace` is deducted via `deduct_wallet_balance` with description `'Bulk skip trace - FastAppend contacts (entity row)'`. If FastAppend also has nothing, prior behaviour is preserved (`no_match`, no charge).
  - `app/api/cron/sweep-bulk-research/route.ts` — same fallback applied at both the no-`resolvedPerson` branch and the Tracerfy-submit-failed branch. Adds a per-run `chargePerTraceByUser` cache keyed on `user_id` so the user_profiles lookup happens once per cron run instead of per row (cron typically processes 5 rows from the same user). Response body gains a `fastAppendCredited` counter for observability alongside the existing `processed`, `resolvedToPerson`, `noMatch`, `errored`, `staleReverted` fields.
- **Idempotency:** No double-charge risk. The bulk status endpoint only re-polls rows where `status='processing'`; once a row is finalised (either Tracerfy success, FastAppend success, or no_match) it's skipped on subsequent calls. The cron only processes rows with `ai_research_status='queued'`; once it sets `'found'`/`'not_found'`, the row exits the cron's purview. AI research charges ($0.15/owner) and trace charges ($0.07/$0.11) remain separate ledger entries.
- **Out of scope (follow-up):** The async-FastAppend recovery path (`app/api/cron/sweep-business-traces/route.ts`) doesn't yet update `is_successful`, `charge`, or the parent `trace_jobs.records_matched` when FastAppend contacts arrive after the bulk job has already finalised. That edge case requires re-summing per-row charges into the parent job and isn't part of this fix; user's most recent test ran in 6.5 min with sync FastAppend so it didn't hit that path. Will revisit if it surfaces.
- **Verified:** `npx tsc --noEmit` clean. `npx eslint` on `lib/ai-research/contacts.ts`, `app/api/cron/sweep-bulk-research/route.ts`, `app/api/v1/trace/bulk/status/route.ts` clean. Full `npx next build` completes without errors.

### Fix bulk trace jobs stuck in `processing` after row work completes (research-side stale claims)
- **Problem:** A bulk trace job sat in `processing` for 23 minutes even though all underlying Tracerfy + FastAppend work finished within ~6 minutes. The Lead-Gen Agent's external timeout fired and triggered its "system failed" workaround. Same symptom as the 2026-05-01 fix, but with a different root cause — the previous fix addressed the status-endpoint side; this one addresses the research-side.
- **Root cause:** `app/api/cron/sweep-bulk-research/route.ts` claimed rows by flipping `ai_research_status: 'queued' → 'processing'` but had no recovery path for claims that never finished. If a cron invocation was killed externally — Vercel `maxDuration` timeout, OOM, deploy restart — the in-process `try/catch` that reverts a failed claim never ran, leaving the row stranded in `'processing'` forever. The next cron run only looked at `'queued'` rows, so the stranded row was never re-claimed and never finished. The status endpoint at `app/api/v1/trace/bulk/status/route.ts` treats any row with `ai_research_status IN ('queued', 'processing')` as "job not done", so a single stranded row kept the entire bulk wrapper in `'processing'` indefinitely. Risk grew after dd17741 / f4bfaef added the async FastAppend recovery path, which extended per-row research time and pushed cron runs closer to their `maxDuration` cap.
- **Changes:**
  - `supabase/migrations/20260509_add_ai_research_claimed_at.sql` — new migration adding `trace_history.ai_research_claimed_at TIMESTAMPTZ` plus a partial index on `(ai_research_claimed_at) WHERE ai_research_status = 'processing'` for cheap stale-claim lookups.
  - `app/api/cron/sweep-bulk-research/route.ts` — at the top of every cron run, revert any `ai_research_status='processing'` rows whose `ai_research_claimed_at` is older than 5 minutes back to `'queued'` (clearing the timestamp). The claim UPDATE now sets `ai_research_claimed_at: now`. The result-persisting and catch-block-revert UPDATEs both clear `ai_research_claimed_at` so the row's lifecycle ends cleanly. Response payload gains a `staleReverted` counter for observability.
  - `app/(dashboard)/settings/api-keys/docs/page.tsx` — public API docs at `https://proptracerpro.com/settings/api-keys/docs` now reflect what `/trace/bulk/status` actually returns: completed responses include the `results` array with per-record `status`, `result`, `research`, `contacts`, `business_trace_pending`, and `business_trace_job_id`; processing responses include `records_submitted`, `records_pending_research`, `records_pending_trace`. Polling callout adds an SLA note that stuck jobs auto-recover within 5 minutes, and a new amber callout explains how to retrieve delayed FastAppend contacts via `/research/status`.
- **Impact:** Bulk jobs now reliably finalise within minutes of their last row completing. Stranded claims from killed cron runs are picked up automatically on the next minute's cron tick — no manual intervention needed. Existing in-flight bulk jobs benefit immediately once the migration runs and the cron deploys (the next sweep will revert any pre-existing stale claims). Verified with `npx tsc --noEmit` (no errors) and `npx eslint` on changed files (no new errors — the docs page's pre-existing `react-hooks/static-components` warnings are unchanged).

---

## 2026-05-01

### Fix bulk trace v1 status endpoint timing out, leaving jobs stuck in `processing`
- **Problem:** A 14-record bulk run via `POST /api/v1/trace/bulk` sat in `processing` for 30+ minutes even though all 14 Tracerfy result emails arrived within ~5 minutes. Caller's polling against `/api/v1/trace/bulk/status` was failing, blocking inbound API requests in the user's Lead-Gen Agent integration.
- **Root cause:** Two compounding bugs in `app/api/v1/trace/bulk/status/route.ts`. (1) The route declared no `maxDuration`, so Vercel killed it at the platform default (~10 s). (2) The Tracerfy poll loop ran sequentially — for entity-owned bulks, every row owns its own `tracerfy_job_id`, so the endpoint had to make N serialized `getJobStatus()` calls before reaching the "mark job completed" block. Together, the function never survived long enough to commit results; rows stayed `status='processing'` indefinitely no matter how many times the caller polled. AI research, FastAppend, and Tracerfy themselves were finishing fine — only the finalizer was broken.
- **Changes:**
  - `app/api/v1/trace/bulk/status/route.ts` — added `export const maxDuration = 60` (matches the bulk submit route). Replaced the sequential `for (const [tracerfyJobId, bucketRows] of unresolvedByJobId.entries())` loop with a parallel `Promise.all` over batches of `POLL_CONCURRENCY = 25`. Per-row work (poll, parse, update DB row, deduct wallet, mutate local copy for the completion check) is unchanged; only orchestration is parallel. Concurrency is capped to stay friendly to Tracerfy at higher record counts (e.g., a 200-record bulk).
- **Impact:** Today's stuck job will finalize on the next status poll. Future bulk runs with up to ~200 entity rows now finish a single status request in roughly the latency of one Tracerfy poll instead of N. No DB migrations, no contract changes, no new dependencies. Throughput-wise the upstream `sweep-bulk-research` cron (5 rows/min) and FastAppend (5–7 results/min) are unchanged — they already report progress correctly via `records_pending_research` / `records_pending_trace` while the bulk job sits in `processing`.

---

## 2026-04-27

### Fix v1 API failures surfaced by Lead-Gen Agent test
- **Problem:** End-to-end test of the user's Lead Generation AI Agent against the v1 API hit three blocking failures on the same 50-lead run: `POST /api/v1/trace/bulk` returned an opaque HTTP 500, and both `POST /api/v1/research/single` and `POST /api/v1/trace/single?aiResearch=true` timed out for entity-owned (LLC/LP/Trust) properties (48 of 50 records). Net result: 0 CRM-ready leads.
- **Root causes:**
  - **Bulk 500:** `app/api/v1/trace/bulk/route.ts` only validated that `records` was a non-empty array. Per-record fields were unchecked, so any record missing `address` / `city` / `state` / `zip` threw inside `normalizeAddress()` and the whole batch was caught by the generic try/catch and returned as 500. Agent's test data had a mix of leads with and without zip — first one without crashed the request.
  - **Entity research timeout:** `lib/ai-research/client.ts` polled FastAppend up to 15 × 3 s = 45 s per entity, recursing up to 3 levels. With Claude calls layered on top, total runtime could exceed Vercel's default function timeout. Neither sync route declared a `maxDuration`, so they got killed before async recovery could persist a `business_trace_jobs` row.
- **Changes:**
  - `lib/ai-research/client.ts` — added optional `pollBudgetMs` parameter on `researchProperty()` and `resolveEntityChain()`. Default 45 000 ms preserves the cron sweeper's existing behavior; sync routes now pass 15 000 ms so the request returns inside the function timeout. Anything slower falls through to the existing async-recovery path that persists to `business_trace_jobs`.
  - `app/api/v1/trace/bulk/route.ts` — added per-record validation using existing `validateAddressInput()`. Bad records now return a structured 400 with `invalidRecords: [{ index, error }]` instead of an opaque 500. Outer catch now includes the actual error message in the response (matching the `/research/single` pattern). Added `export const maxDuration = 60` for consistency.
  - `app/api/v1/research/single/route.ts` — added `maxDuration = 60` and passes `SYNC_POLL_BUDGET_MS = 15000` to `researchProperty()`.
  - `app/api/v1/trace/single/route.ts` — same treatment.
- **Impact:** A bulk submission with malformed records now returns an actionable 400 telling the caller exactly which records failed and why, instead of a silent 500. Entity research on the sync routes now returns within ~50 s with either inline contacts (if FastAppend resolved within 15 s) or a `business_trace_pending: true` + `business_trace_job_id` for the caller to poll, instead of hanging until the function is killed. No DB migrations, no API contract changes, no new dependencies.

## 2026-04-11

### Bulk trace: AI research + FastAppend parity with single trace
- **Problem:** Yesterday's fast-path FastAppend merge fixed the single-trace API but left `/api/v1/trace/bulk` completely bypassed. Bulk had zero entity detection, no `researchProperty()` call, no `ai_research` persisted on history rows, and no structured contacts in the `bulk_job.completed` webhook. Every entity-owned property in a bulk upload silently lost its decision-maker contacts: an LLC name like "Extra Space Storage" was naïvely split on space and sent to Tracerfy's person skip trace as `first_name="Extra"`, `last_name="Space Storage"`, guaranteeing a miss. This contradicted `docs/AGENT_INTEGRATION.md`, which promises agents the same structured FastAppend output for bulk as for single trace.
- **Design constraint:** Bulk accepts up to 10k records. An HTTP POST cannot block for `N × 45 s` of inline AI research, so the work had to move to a background cron worker, modeled on the existing `sweep-business-traces` pattern.
- **Changes:**
  - Migration `supabase/migrations/20260411_bulk_trace_research.sql` — adds `trace_job_id UUID REFERENCES trace_jobs(id)` to `trace_history`, plus two partial indexes: one for the cron worker to find queued research rows quickly, one for the status endpoint to aggregate per-record state by parent bulk job.
  - `lib/ai-research/client.ts` — `isLikelyBusiness` is now exported so the bulk route can use the same detection heuristics as `resolveEntityChain()`.
  - `app/api/v1/trace/bulk/route.ts` — full rewrite. After dedupe, records are split into `personRecords` (owner_name set AND not business-looking) and `entityRecords` (empty OR business-looking). Wallet balance now covers worst-case research cost in addition to trace cost. All history rows are inserted up front, linked via the new `trace_job_id` column. Person records are still submitted as a single Tracerfy bulk CSV (fast path preserved). Entity records are inserted with `ai_research_status='queued'` and no `tracerfy_job_id` — the cron picks them up. Response now includes `recordsDirectTrace`, `recordsPendingResearch`, and a message indicating how many rows are queued for research.
  - `app/api/cron/sweep-bulk-research/route.ts` — new cron worker. Authenticates via `CRON_SECRET`, pulls up to 5 queued rows per run (throttled because `researchProperty` can take ~45 s per call with inline FastAppend poll), atomically claims each row by flipping `ai_research_status` from `queued` → `processing` to avoid double-processing. For each claimed row: splits the pipe-delimited `normalized_address` back into its street portion, calls `researchProperty()` with an `asyncRecovery` context (so timed-out FastAppend business traces get queued into `business_trace_jobs` for the existing slow-path sweeper), persists the full `AIResearchResult` + charges the $0.15 research fee if an owner was found, picks the best person name to trace (preferring `business_trace_contacts.owner_name`, then `individual_behind_business`, then `owner_name` if the type is individual), and if a person resolved, submits a per-row `submitSingleTrace()` and stores the returned `tracerfy_job_id` on the row. Rows with no resolved person are marked `no_match` immediately so the bulk job can finalize. Transient errors revert the row back to `queued` for the next cron run. `maxDuration = 300`.
  - `vercel.json` — registers `/api/cron/sweep-bulk-research` on `* * * * *` (every minute, because the small batch size means quick churn).
  - `app/api/v1/trace/bulk/status/route.ts` — full rewrite. Now aggregates state across all `trace_history` rows linked to the bulk job via `trace_job_id` instead of reading only the stored summary. Collects unresolved Tracerfy jobs (both the shared bulk job for person rows and the individual per-entity jobs for post-research submits), polls each, persists per-row results, deducts charges, and computes overall completion. While any row is still queued/processing for research OR awaiting a Tracerfy result, returns `status='processing'` with `records_pending_research` and `records_pending_trace` counts. When everything is finalized, marks the job completed, looks up any pending `business_trace_jobs` rows keyed by address hash, and fires a single `bulk_job.completed` webhook whose `results` array now includes per-record `research`, `contacts` (the FastAppend sidecar), `business_trace_pending`, and `business_trace_job_id` — matching `docs/AGENT_INTEGRATION.md`. The existing `sweep-business-traces` cron continues to fire per-record `business_trace.completed` webhooks for rows whose FastAppend job finishes later.
- **Impact:** A bulk upload of 100 properties — say 20 individuals and 80 LLCs — now runs AI research + entity resolution on all 80 entity rows before any Tracerfy person trace, exactly as the single-trace flow does. Agents receive structured decision-maker contacts for business-owned properties in the bulk webhook, plus delayed `business_trace.completed` webhooks for any rows whose FastAppend takes longer than 45 s. Person-named records still hit the original Tracerfy bulk fast path with zero added latency.

## 2026-04-09

### Fix fast-path FastAppend merge (structured contacts were being dropped)
- **Bug:** After the async recovery shipped earlier today, live agent tests revealed a deeper bug: when the inline 45 s FastAppend poll *succeeded* (fast path), the returned `AIResearchResult` still had no structured phones/emails/mailing_address. `resolveEntityChain()` was formatting the FastAppend payload as a text context block for Claude to re-read, but Claude's output schema has no contact fields, so the structured data was silently dropped. Response showed `business_trace_status: "Found: Gwyn McNeal (5 phones, 3 emails)"` but zero contacts in the body — agents were charged $0.15 per call and got nothing usable.
- **Root cause:** The slow-path cron sweeper correctly attaches a `business_trace_contacts` sidecar to `trace_history.ai_research`, but the equivalent fast-path merge was never implemented inside `resolveEntityChain()`.
- **Fix:**
  - `types/index.ts` — `business_trace_contacts` is now a first-class field on `AIResearchResult` (was previously only a cast hack in the cron sweeper).
  - `lib/ai-research/client.ts` — `resolveEntityChain()` now tracks the most recent successful `traceResult` across iterations and, after the Claude re-extraction loop, attaches it to `currentResult.business_trace_contacts`. When Claude didn't identify an owner, the FastAppend owner name is promoted to `owner_name` + `individual_behind_business` (mirroring the cron sweeper). The deceased pass in `researchProperty()` now preserves `business_trace_contacts`, `business_trace_status`, and `pending_business_trace` through its final Claude re-extract (those fields would otherwise be dropped).
  - `app/api/v1/research/single/route.ts` — surfaces `contacts` at the top level of the response and webhook payload, mirroring the shape of `/api/v1/research/status`. The same data is also present at `research.business_trace_contacts`.
  - `docs/AGENT_INTEGRATION.md` and `app/(dashboard)/settings/api-keys/docs/page.tsx` — updated fast-path response examples to show where `phones[]`, `emails[]`, `address` land in the payload, and added a common-mistake note that contact data lives under `business_trace_contacts` (not on the core `research` object).
- **Impact:** Agents calling `/api/v1/research/single` on business/LLC-owned properties now receive structured contact data inline whenever FastAppend responds within 45 s. No more "paid $0.15 and got an empty string" surprise.

### Async FastAppend business trace recovery
- **Problem:** AI research via `/api/v1/research/single` polls FastAppend's business-trace API for only ~45 s in `resolveEntityChain()`. For business/LLC-owned properties, FastAppend usually takes longer — the poll times out, the API returns without contacts, and FastAppend emails the completed CSV to the user's account. Those delayed results never re-entered PTP, so AI agents calling the API (e.g., Cowork finding Mecklenburg County self-storage owners) never saw the phones/emails.
- **Design:** Keep the 45 s inline poll as a fast path (no change for quick cases). When it exhausts, persist the FastAppend `queue_id` to a new `business_trace_jobs` table, surface `business_trace_pending` + `business_trace_job_id` in the API response, and let a cron sweeper poll FastAppend every 5 min, merge contacts into `trace_history.ai_research`, and fire a `business_trace.completed` webhook.
- **Changes:**
  - Migration `supabase/migrations/20260409_business_trace_jobs.sql` — new `business_trace_jobs` table with partial index on `(status='pending', created_at)` and RLS read policy.
  - `types/index.ts` — `pending_business_trace?` field on `AIResearchResult`; new `BusinessTraceJob` interface.
  - `lib/ai-research/client.ts` — `resolveEntityChain()` now accepts an optional `AsyncRecoveryContext`. When the inline poll exhausts with FastAppend still pending, it inserts a `business_trace_jobs` row via admin client and stamps `pending_business_trace` on the returned result. `researchProperty()` forwards the context through discovery-pass and deceased-pass code paths.
  - `app/api/v1/research/single/route.ts` — passes user/address context into `researchProperty`, strips `pending_business_trace` from the persisted research payload, surfaces `business_trace_pending` + `business_trace_job_id` in the response and the `research.completed` webhook.
  - `app/api/research/single/route.ts` — same async-recovery plumbing for the session-auth dashboard endpoint (silent; UI doesn't surface the pending state).
  - `app/api/cron/sweep-business-traces/route.ts` — new cron. Marks rows older than 24 h as errored, polls FastAppend for each pending job, downloads results, updates the job row, merges contacts into `trace_history.ai_research` (appends to `decision_makers`, promotes owner_name if AI didn't find one, adds a `business_trace_contacts` sidecar), and fires `business_trace.completed` webhook.
  - `vercel.json` — registers the new cron on `*/5 * * * *`.
  - `app/api/v1/research/status/route.ts` — new API-key-authenticated status endpoint. Takes `?job_id=<uuid>`, returns `{ status, contacts, research, ... }` where `research` is the merged trace_history snapshot.
  - `app/(dashboard)/settings/api-keys/docs/page.tsx` — documents the new fields, the status endpoint, and the `business_trace.completed` webhook event with a concrete Extra Space Storage example.
  - `docs/AGENT_INTEGRATION.md` — new agent-facing guide covering fast path vs. slow path, polling strategy, webhook alternative, bulk processing, and common mistakes.
- **Billing:** Unchanged. `ai_research_charge` is still deducted on the initial request based on whether the AI found an owner; the delayed merge only enriches contact data.

---

## 2026-04-06

### Fix single trace 500 when re-tracing same address with different owner name
- **Bug:** `trace_history` has `UNIQUE(user_id, address_hash)` but the hash is address-only (no owner_name). When AI Agent resolves a person from an LLC and re-traces the same address with the person's name, the INSERT hits a unique constraint violation → 500
- **Fix:** Before inserting, if `ownerName` is provided, delete any existing trace for that address with a *different* `input_owner_name`. This allows the 2-step research→trace flow to work correctly.
- **Files changed:** `app/api/v1/trace/single/route.ts`, `app/api/trace/single/route.ts`

### Fix API auth returning 401 for server-side errors
- **Bug:** `validateApiKey` in `lib/api/auth.ts` treated all Supabase query errors (connection failures, bad service role key, etc.) as "Invalid API key" (401), masking server-side issues and telling callers their key is wrong when it isn't
- **Fix:** Differentiate PGRST116 (key not found → 401) from other Supabase errors (→ 500 "Internal server error") with server-side `console.error` logging of the actual error code/message. Also wrapped `createAdminClient()` in try/catch for missing env vars.
- **File changed:** `lib/api/auth.ts`

---

## 2026-04-03

### Fix single trace stuck in Processing when Tracerfy returns no data
- **Bug:** When Tracerfy finished processing but returned empty results or only padding rows, both status routes (`/api/trace/status` and `/api/v1/trace/status`) kept returning `processing` instead of finalizing as `no_match`
- **Fix:** Removed early-return `processing` responses for empty/padding-only results; now falls through to existing finalization logic that correctly marks as `no_match`
- **Impact:** Traces that previously spun for up to 60 min (until cron marked them as `error`) now finalize immediately on the next status poll

---

## 2026-04-02

### Update API documentation for bulk import changes
- Updated bulk trace endpoint docs (`/trace/bulk`) with accurate request/response formats including `owner_name`, `mailing_address` optional fields
- Fixed bulk status endpoint path: was `/trace/jobs/:jobId` (non-existent), now `/trace/bulk/status?job_id=uuid`
- Created new v1 bulk status endpoint at `app/api/v1/trace/bulk/status/route.ts` (API key auth wrapper matching internal route logic)
- Added deduplication info (90-day window, batch dedup) and max 10,000 records limit to docs
- Added processing/completed response examples for bulk status polling
- Added bulk trace cURL examples to the integration examples tab
- Fixed v1 bulk route response message to reference correct `/api/v1/trace/bulk/status` path

---

## 2026-03-27

### Fix bulk upload, Stripe wallet top-up, and auto-rebill
- Fixed "Failed to check duplicates: Bad Request" error by batching `.in()` queries into chunks of 100 hashes (was exceeding PostgREST URL length limit with 600+ records)
- Added manual column mapping dropdowns to bulk upload page — users can now override auto-detected column mappings via `<select>` dropdowns
- Surfaced actual Stripe error messages in wallet-topup and create-checkout API routes (was returning generic "Failed to create checkout")
- Added error display to billing page UI so users see meaningful messages when Stripe checkout fails
- Added `setup_future_usage: 'off_session'` to wallet top-up checkout sessions so Stripe saves the payment method for future off-session charges
- Webhook now saves `wallet_payment_method_id` to user profile after successful wallet top-up
- Created `lib/utils/auto-rebill.ts` utility that checks `check_wallet_needs_rebill` and calls `chargePaymentMethod` when wallet balance drops below threshold
- Wired auto-rebill trigger (fire-and-forget) into all trace status endpoints and the cron sweep job

---

## 2026-03-24

### Add forgot password flow to login page
- Added "Forgot password?" link to the password tab on the login page
- Created `/forgot-password` page that sends a Supabase password reset email
- Created `/reset-password` page where users set a new password after clicking the email link
- Added both routes to middleware public routes list

---

## 2026-03-23

### Fix stuck "Processing" traces and add background sweep

**Problem:** Traces submitted Mar 22 stuck in "Processing" for 24+ hours, blocking all future requests.

**Root cause:** System is entirely poll-based with no background recovery. When client stops polling (after ~65s timeout), DB records stay in `processing` forever. Stuck records then block new submissions via unique constraint (single) and dedup logic (bulk).

**Changes:**
- Added `STALE_PROCESSING` constants (10min stale threshold, 60min cron timeout) in `lib/constants.ts`
- Created Vercel Cron job `app/api/cron/sweep-stale-traces/route.ts` — runs every 5 minutes, checks Tracerfy for results on stuck records, finalizes or marks as error
- Fixed `app/api/trace/single/route.ts` — now deletes stale processing records (>10min) before inserting new ones, so stuck records no longer block retries
- Fixed `lib/utils/deduplication.ts` — bulk dedup now excludes stale processing records so they don't prevent reprocessing
- Created `vercel.json` with cron schedule configuration

**Files created:** `app/api/cron/sweep-stale-traces/route.ts`, `vercel.json`
**Files modified:** `lib/constants.ts`, `app/api/trace/single/route.ts`, `lib/utils/deduplication.ts`

---

## 2026-03-09

### Add History.md and update CLAUDE.md workflow rule
- Created `History.md` to track completed tasks across sessions.
- Updated `CLAUDE.md` to add Rule 9: update `History.md` after every task before moving to the next.

---

### Phase 4 review fixes: six defects found in review, fixed

**Fix 1. The dashboard bulk route charged for blank-owner rows.** `app/api/trace/bulk/route.ts`
never got the blank-owner skip the v1 route and the MCP submit got this phase. It put a CSV line
with an empty first and last name into the Tracerfy submit, and `bulk/status` then deducted the
tier 1 rate on whatever came back. It now splits the batch, writes the blank-owner rows terminal
with `BLANK_OWNER_SKIP_STATUS` and no money columns, reserves nothing for them, and never calls a
vendor about them. An upload that is entirely blank-owner closes its job out instead of leaving the
page polling forever.

- Rows now carry `trace_job_id`, as the v1 rows already did. Without it a skipped row, which never
  gets a `tracerfy_job_id`, was invisible to the results CSV.
- `app/api/trace/bulk/download` finds rows by either key and emits the `skip_reason` column, so the
  reason reaches the customer rather than sitting in a database column.
- The bulk page counts blank-owner rows before submit and says they will be skipped and not
  charged. That counter went away with the AI Research toggle and nothing replaced it.

**Fix 2. A poisoned row starved the entity queue forever.** `lookupBusinessTrace()` never throws,
so a lapsed `FASTAPPEND_API_KEY` or an hour of 503s left `sweep-entity-traces` re-queuing the same
five oldest rows every minute, and no newer row was ever reached. New
`lib/trace/entityTraceAttempts.ts` carries the attempt number in `ai_research_status` itself
(`queued`, `queued_2`, ... and the matching `processing_N`), so it survives between runs with no
migration and no new column. After five attempts the row is written terminal as
`entity_trace_failed` with a readable reason and no charge. The stale-claim sweep steps the same
ladder, so a row that kills the run every time is bounded too. Retrying a transient failure is
unchanged.

**Fix 3. A customer could not retrieve the record they paid for.** Neither status route returned
`property_record` or `tier`, so a Pay-As-You-Go customer billed for a Full Property Trace who
closed the tab, or an API caller polling for an async result, had no way to get the 86-field record
back. Both routes now read both keys off the existing `trace_history` row. No vendor call, no
second charge.

**Fix 4. Comments describing money that no longer moves.** `lib/trace/settleBulkJob.ts` said the
tier fee is charged on top of an AI research charge the cron books, and that the booked charge
"stays put". `sweep-entity-traces` writes `ai_research_charge: 0` on every new row, so that was
false for all of them. The refund code is correct and still services the 1,301 historical rows;
the narration now says so. `lib/constants.ts` called the retired `AI_RESEARCH.CHARGE_PER_RECORD`
"a different product on a different ledger entry", contradicting its own RETIRED banner. They
agree now.

**Fix 5. Two copy defects on the single trace page.** The clear-cache confirm promised a permanent
delete and a fresh search, which is false for a billed row: `excludeBilledRows` protects it and the
cache serves it back. It now says what actually happens, which is good news. The Full Property
Trace toggle displayed a tick driven by `!hasOwnerName` while the request body sent
`wantsPropertyRecord`; one derived value now drives the checkbox, the request and the disclosure.

**Fix 6. Two data-honesty defects in `PropertyRecordCard`.** `total_portfolio_value` was labelled
"Portfolio value". It is the sum of the vendor's per-parcel values, and those equal ASSESSED value
on 23 of 23 parcels, so it inherits the defect that got `estimated_value` blocked. It is not
blocked, it is labelled "Portfolio assessed value" with a note saying it is not a market valuation,
the same treatment `assessed_value` gets. And `date()` printed a vendor `0000-00-00` verbatim; it
is blank now.

**Verification.** 699 tests / 49 files / 0 failing (up from 651 / 47). `tsc --noEmit` clean.
eslint 48 problems, down 1 from an unused import removed. `npm run build` compiles. Ten mutations
run and confirmed red, listed in `tasks/todo.md`.

---

## 2026-09-17 — Phase 4 second-review fixes: the bulk surfaces

Five findings from the second review of phase 4, all on the bulk path. Files belonging to other
workstreams (the single-trace routes, `lib/trace/traceCompletedWebhook.ts`,
`lib/utils/deduplication.ts`, `docs/`, the settings pages) were not touched.

**Fix 1. The v1 bulk route reported skipped rows as submitted work.** `records_submitted` on the
job row was every record that survived dedup, blank-owner rows included, and those are never sent
to any vendor. The dashboard route already writes the traceable count with a comment saying
counting skipped rows would overstate the work; the two routes now agree. The number is the
denominator of the match rate, so a 100-row upload with 40 blank owners was showing a match rate
40 percent below the work actually attempted, in the status response, the `bulk_job.completed`
webhook and the history page. Checked first that nothing computes on the column: `settleBulkJob`
never reads it, the v1 status route passes it through with no arithmetic, `sweep-stale-traces`
only copies it into a webhook.

**Fix 2. David's blank-owner rule was half implemented on the dashboard.** The rule is accepted,
skipped with a reason, charged nothing, reason visible in the job summary and the CSV. Only the
CSV had it, so a mixed upload finished with those rows reading as a bare `no_match`. The session
bulk status route now returns `records_skipped` and `skip_reason`, derived through `skipReasonFor()`
so the wording is the same one the v1 payload, the MCP payload and the CSV serve. The page reads
them back and renders `components/trace/BulkSkipSummary.tsx` in both the processing and the
complete phase, and the pre-submit line counts the rows that will actually be traced.

**Fix 3. The entity cron could charge a row twice.** A throw after the deduct and before the row
write left the money moved with nothing on the row, and the catch requeued it for another claim,
another FastAppend call and another deduct. The marker is the `wallet_transactions` debit
`deduct_wallet_balance` already writes carrying `trace_history_id`. No new column: the cron asks
the ledger before deducting and persists the amount that already moved.

**Fix 4. A row could become permanently invisible.** The stale-claim sweep used `.lt()` on
`ai_research_claimed_at`, and SQL `<` never matches NULL, so a row in `processing_N` with a null
claim timestamp was unreachable by both the sweep and the claim query and held its bulk job open
forever. Both arms are matched now. Latent: no current writer produces that pair.

**Fix 5. A comment that invented a database field.** It documented `normalized_address` as
carrying a zip. `normalizeAddress()` returns `STREET|CITY|STATE`, zip-free on purpose since
migration 20260904.

**Verification.** 772 tests / 53 files / 0 failing (up from 737 / 51). `tsc --noEmit` clean.
eslint 47 problems, unchanged. `npm run build` compiles. Fifteen mutations run and confirmed red,
listed in `tasks/todo.md`, including one that survived twice and forced the skip block out of the
page and into its own render-tested component.

## 2026-09-17 — Phase 4 billing fixes: repeat billing, the double webhook, the receipt lockout, the false wallet message

- **The cache could never fire on the public API.** `checkSingleDuplicate` built the cookie-backed
  anon client, and `trace_history` RLS made it blind on every API-key request, so every repeat call
  re-bought the dossier and charged the wallet again. It now uses the service-role client, with the
  unconditional `user_id` filter as the cross-user fence and a mutation test on its deletion.
- **`trace.completed` no longer fires twice for one `trace_id`** on a repeat submit. Three remaining
  paths can emit two events for one row, and each is a genuine second purchase.
- **Receipts are monotonic.** `foldBillingWrite` accumulates `charge` and never downgrades `tier`, so
  a tier 1 settle can no longer zero a tier 2 receipt and lock the address out of every retrace.
- **A row a ledger row points at is never a delete candidate.** `hasLedgerReceipt` asks
  `wallet_transactions` and `usage_records` and fails closed, which also frees rows already damaged.
- **`deductWallet` separates a short wallet from a failed RPC**, so a customer with a full balance is
  no longer told they were short. On an RPC failure they are not billed and keep the record.
- Deduplication is no longer mocked in either single-trace suite, so the cache tests can fail for the
  real reason.

**Verification.** 844 tests / 55 files / 0 failing (up from 772 / 53). `tsc --noEmit` clean. eslint
47 problems, unchanged. `npm run build` compiles. Twenty mutations applied one at a time with a full
suite between each, all twenty red; the table is in `tasks/todo.md`.

## 2026-09-17 — Phase 5b: the four PHASE 5 LIABILITY files. No feature, nothing visible

- **Seven writes that erased receipts now fold or exclude.** `foldBillingWrite` where the row is in
  hand (`settleBulkJob:257,308`, `bulk/status:288`, `sweep-entity:467,495`, `sweep-business:201`);
  the two blanket multi-row updates that read no row at all (`settleBulkJob:333`,
  `bulk/status:302`) stop writing `charge`/`tier` entirely and are narrowed by `excludeBilledRows`.
  Both arms are the pattern `sweep-stale-traces:332` already held, not a second one.
- **`sweep-business-traces` stopped billing the rows it must not touch.** Its upgrade guard was
  `!is_successful`, which is the exact shape of a billed tier 2 row, so it replaced a $0.25 receipt
  with the $0.15 tier 1 rate and downgraded the tier without ever going loud. The guard is now
  `isCacheHitRow`, which is strictly narrower and still admits the 1,301 historical rows the arm
  exists for.
- **`tier1RateFor` takes `source` in both crons.** `sweep-business-traces` priced every row
  grant-aware, so a gateway-grant holder settling a v1 job paid $0.15 for the entity row and $0.25
  for its person siblings. Same job, same work, two prices.
- **`app/api/trace/bulk/route.ts` tags its job and every row `source: 'web'`.** It settles
  grant-aware while writing no tag, and an untagged row reads as the raw Track B derivation. The tag
  values and the Track A predicate now live in `lib/suite/pricing.ts` so writer and readers cannot
  drift.
- **Two of the four `ALLOWED_RAW_WRITES` exemptions are gone**, and the two that remain earn it on a
  new ground: they write an amount READ BACK OUT OF THE LEDGER, where folding would double-count one
  debit. "Tier 1 only" is no longer an acceptable reason for an entry.

**Verification.** 955 tests / 59 files / 0 failing (up from 933 / 58). 21 characterization tests
written FIRST and green against unfixed code; 13 went red on the fix, plus the stale-exemption fence
as the 14th. `tsc --noEmit` clean. eslint 47 problems, unchanged. `npm run build` compiles. Fifteen
mutations applied one at a time with a full suite between each, all fifteen red, zero survivors; the
table is in `tasks/todo.md`. The L-009 flag was probed directly rather than assumed: with the flag
line removed the rate mutation SURVIVES, which is what makes setting it load-bearing.

## 2026-09-17 — Phase 5b corrections: the phase had introduced a double-billing defect

Adversarial review found that phase 5b, as first written, created a critical defect. Corrected before
any commit. Root cause of both major findings: **status is not a receipt.** `excludeBilledRows`
protects `charge` and `tier`; putting `status`, `is_successful` and `trace_result` behind it is how
both defects happened.

- **A billed tier 2 row with no vendor result was stranded in `processing`** by the guarded blanket
  update, inside a job the route then marked `completed` and never polled again. An hour later
  `sweep-stale-traces` stage 1 claimed it (no `trace_job_id` filter) and settled it against whichever
  OTHER record of the SHARED Tracerfy batch carried a phone: a second $0.25 on one address, a
  stranger's phone and email on the customer's parcel, and both pushed to their CRM. Every blanket
  update is now TWO statements — money behind the guard, delivery in front of it — in all THREE
  places, including `sweep-stale-traces` itself, the reference implementation, which had the same
  flaw. Stage 1 also gained `.is('trace_job_id', null)`.
- **`sweep-business-traces` declined to deliver as well as to bill.** Two gates now: `shouldDeliver`
  (status, trace_result, counts, `records_matched`) and the strictly narrower `shouldBill` (refund,
  deduct, charge/tier). Without it the CSV showed blank contacts for a row v1 and the MCP reported
  as having them.
- **Two mutations had survived, both the select list.** Adopted the phase 4b PostgREST
  column-projection stubs; `bulk/status` narrowing to `.select('id')` went 0 → 2 red, and
  `sweep-business-traces` dropping `charge` went 0 → 3 red.
- **`collectedChargeFor` now SUMS every debit** instead of `.limit(1)` returning an arbitrary one,
  and `sweep-business-traces` gained the ledger probe its twins had. Consequence: that file writes
  the ledger total RAW (folding a ledger answer double-counts) and is back on `ALLOWED_RAW_WRITES`
  on the ledger ground, reversing part of the earlier entry.
- **The tier exemption was closed.** Three ledger sites wrote `tier` flat, silently downgrading a
  tier 2 receipt; they now take `tier` from `foldBillingWrite`. Two incoherent test fixtures (a row
  showing $0.25 against a single $0.05 ledger debit) were made consistent.
- `chargeReceipt.test.ts` gained a third safe form (guarded), a canary for it, and a new fence that
  keeps DELIVERY columns out of any `excludeBilledRows` guard — that fence is what found the defect
  in `sweep-stale-traces`.

**Verification.** 982 tests / 61 files / 0 failing (pre-review 955/59, baseline 933/58). `tsc
--noEmit` clean. eslint 47 problems, unchanged. `npm run build` compiles. 26 mutations, all applied
under an exact-anchor check with the total test count watched for a drop, all 26 red — but ONE
survived first at 0 red (a flat tier on settleBulkJob's FastAppend branch, a tautology because every
fixture there had no tier at all); a test now covers it. Table in `tasks/todo.md`.
