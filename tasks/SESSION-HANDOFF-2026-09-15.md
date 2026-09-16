> **SUPERSEDED for owner discovery. Read `SESSION-HANDOFF-2026-09-16.md` first.**
> This file is still correct on vendor mechanics and its eight defects. Its assumption that
> the AI research step is the path to a commercial owner was measured on 2026-09-16 and is
> wrong: county parcel records are not in any web index. Do not rebuild that query path.

# SESSION HANDOFF, 2026-09-15 into 09-16

## READ THIS FIRST: what is shipped, what is committed, what is unrun

### SHIPPED, merged to main, deployed, production verified
Suite Gateway `b733669` and woo-app `89369b1`. Both Ready in production, aliases confirmed serving
those exact commits. Task 13 Step 5 of the CRM contact rules plan is COMPLETE: results doc, both
todo Review sections, the SESSION-HANDOFF READ FIRST block, and the memories. Nothing outstanding.

### COMMITTED BUT NOT PUSHED, PropTracerPRO, two independent branches

**1. `feat/tracerfy-advanced-owner-lookup`, worktree `/Users/davidmonroe/PTP-advanced-owner-lookup`**
- `e9940fe` bulk person traces use Tracerfy advanced owner lookup
- `dc7c511` retry a no_match via Tracerfy instant owner lookup, flat $0.15 pricing
- Reviewed twice, all findings fixed. Gates: 211 tests passing, tsc exit 0, eslint unchanged.
- **TWO BLOCKERS BEFORE MERGE:**
  - `components/landing/LandingPage.tsx` still advertises $0.07 and $0.11 in **nine** places. The app
    now bills $0.15. That file is IN THIS REPO and deploys with the app. **David said update the
    landing page after all other fixes. It is not done.** Merging without it ships a live page
    advertising a price the app does not charge.
  - **Unanswered question:** do the AI research charge ($0.15) and the FastAppend success charge
    (now $0.15) STACK? They stack today; the evidence is historical rows billed $0.22 and $0.26,
    which are $0.15 plus the old $0.07 and $0.11. With everything at $0.15 a successful entity trace
    bills $0.30 unless changed. David's stated principle is "$0.15 once, whether it has recovery or
    not", which applied consistently means $0.15 total. **He never answered. Nothing was changed.**

**2. `fix/no-tenant-as-owner`, worktree `/Users/davidmonroe/PTP-owner-extraction-fix`**
- `96178fe` never return a business operating at an address as the property owner
- Gates: 175 tests passing (from 151), tsc exit 0, eslint unchanged. 8 guards mutation-tested red.
- **NOT REVIEWED.** No task review was run on this commit.

### NEVER RUN
The commercial research test (12 parcels, 4 each OH/CA/UT). Blocked by the auto-mode permission
classifier under `[Real-World Transactions]`, three earlier denials under `[Credential Exploration]`.
Parcels are selected and frozen, harness is written, spend guard is proven. David is waiting on its
numbers to price the search step. **Total spend on it so far: $0.00.**

---

## WHAT WAS LEARNED, verified live unless marked otherwise

### Tracerfy and FastAppend are ONE vendor
FastAppend is a Tracerfy LLC company. One relationship, one support contact. Base URL is
`https://tracerfy.com/v1/api/`, NOT `api.tracerfy.com` which does not resolve.

### Billing, read from the live dashboards
- PAYG $0.0200 per credit. Tracerfy all-time 1,820 credits = $36.40.
- FastAppend: 1,915 lists uploaded, 3,830 row count, but only **902 credits used**. It bills on
  HITS, not submissions. 902 x $0.10 = $90.20 all time.
- Count is exactly 2x lists because PTP sends a padding row with every entity trace. Not billed, but
  pointless; remove it.
- Batch normal trace 1 credit. **Batch advanced 2 credits.** Instant lookup 5 credits, 0 on miss.

### The two changes that recover real results
- **`trace_type: 'advanced'`** needs no name and no mailing fields. PTP defaulted to `normal`, which
  requires them, and satisfied them by splitting the owner name on the first space and filling
  `mail_state` with the PROPERTY state. Both wrong.
- **`find_owner: true`** on the instant endpoint. **Six of six properties PTP had recorded as
  `no_match` returned hits with no name supplied.** Clearest case: PTP sent first `Jingwen`, last
  `& Shaolan Wu`; the wife's real surname is Chen, so a first-space split could never have matched.

### The APN lookup exists and needs no address
`POST trace/parcel/lookup/` takes `parcel_id`, `county` (name, no "County"), `state`. Verbatim parcel
id including internal double spaces. Works in every county tested including hyphenated and
zero-padded formats.

### ENTITY-OWNED PARCELS: the most important operational finding
Four entity-owned parcels, four counties, **4 for 4**: the parcel lookup returns 4 to 5 contactable
strangers, **zero flagged `property_owner: true`**, never the entity, and bills a full hit every
time. The individual control returned exactly one person flagged true.
- **`property_owner` is the only thing that separates a real owner from strangers. It works
  perfectly. Nothing else does.**
- Worst trap: owner MASON SULLIVAN PROPERTY INVESTMENTS LLC returned people surnamed Mason and
  Sullivan, both flagged false. Reads exactly like a match. Is not one.
- Therefore: **never send an entity-owned property to the person path.** Route entities to
  FastAppend from the county's owner name.

### Response shapes differ between endpoints
- **Batch** returns FLAT fields (`mobile_1..5`, `email_1..5`). Verified: all 19 fields
  `parseTracerfyResult` reads come back identically; empty slots are `""` not null. No silent-empty risk.
- **Instant and parcel** return NESTED `persons[]` with `property_owner`, and per-phone `type`,
  `dnc`, `tcpa`, `carrier`, `rank`. A separate parser is required.
- Batch carries NO `property_owner`, `dnc` or `tcpa`.

### No-owner counties
- LA, San Diego, Sacramento and Alameda publish **no owner field at all**, not even in raw
  attributes. Genuine absence at source, not a curation gap. Six OTHER California counties do publish
  owner names under county-specific keys. One publishes `OwnerName` = `Protected Per CA Gov Code 7928.205`.
- 7 of 12 CA no-owner parcels returned a flagged owner from the APN alone. Cost per usable owner
  **$0.157**, against $0.15 revenue. Technically works, does not pay at a per-result price.
- Fix for those four counties is a re-source from the county assessor's SECURED ROLL, a different
  file from the GIS parcel layer they were ingested from.

### Research step economics, measured
Residential run: **$0.0574 per property average**, range $0.036 to $0.116. Only 1.74x cheaper than a
$0.10 Tracerfy lookup; worst case cost MORE. 52% Brave at $5/1,000 queries, 48% Claude at Opus
$5/$25 per MTok. **The "fractions of a cent" premise was wrong by two orders of magnitude.**
All 12 queries hit people-search aggregators (clustrmaps, fastpeoplesearch, Spokeo, MyLife), **zero
county, assessor, recorder or deed sources.** Those publish address history, not title.

**After the `96178fe` fix, cost per property will go UP and answer rate DOWN, and both are correct.**
A null owner now runs the FULL path. The figure to price against is **cost per VERIFIED owner**, not
per property.

---

## DEFECTS FOUND AND NOT FIXED

1. **`PRICING.COST_PER_RECORD` is $0.009**, written to `trace_history.cost` at **14** sites, read
   back nowhere, contradicts the real $0.02/credit, and is stamped on FastAppend rows at another
   vendor's rate. Stored cost figures are fiction.
2. **The batch-hit path ignores its own deduct result**, so a failed wallet deduct still records
   `charge: personRate`. Row-versus-ledger divergence. Pre-existing.
3. **Registered-agent clustering, UNVERIFIED but large.** 204 of 496 FastAppend hits (41%) returned a
   person mapped to 2+ distinct entities; one person returned for **42** entities at a Manhattan
   corporate-services address; five hits returned a contact literally named "Secretary of State".
   FastAppend returns `role` and `is_registered_agent`; **PTP reads neither and takes row one.**
   Reading those two flags is free and would also size the problem.
4. **PTP uses the async CSV batch endpoint** when a synchronous single lookup exists, which is what
   necessitated the whole polling, cron, webhook and refund apparatus.
5. **Batch parser discards `mail_zip` and `zip`** (hardcodes `mailing_zip: null`) and hardcodes every
   primary phone as `mobile` while the vendor returns `primary_phone_type`. A landline gets texted.
6. **ZIP is never sent to Tracerfy** in either direction, though the vendor calls it strongly
   recommended for disambiguation.
7. **`business_trace_jobs` rows queued before `96178fe` deploys will still promote tenants into
   `owner_name`** via `sweep-business-traces`. Needs a column marking the traced business as an operator.
8. A concurrent double-poll race on bulk status is pre-existing; the retry now makes it cost $0.10 a
   row as well as a double charge.

---

## THE EPISTEMIC CORRECTION, recorded deliberately

I repeatedly said PTP "promotes tenants as owners". **That was never validated.** Zero title checks
were performed on any property in any run. What IS established is what the code does: the removed
prompt rule and the Discovery Pass both wrote a business-derived person into `owner_name` at a moment
when, by the rule's own trigger, no county, tax or deed record had been found. That is asserting
ownership with no ownership source, and it holds regardless of hit rate. **Whether any specific name
was actually a non-owner is unmeasured.** Research produced 3 names total across all runs; exactly 1
was independently checkable, and that check was an inference from a homeowner's exemption flag, not a
deed.

Three numeric errors propagated this session because a subagent stated a summary figure that
contradicted its own itemised list and I relayed it without adding up the list: "34 tests" that were
34 comment lines, "16 fields" that were 19, and the mailing-state-as-registration-proxy claim.
**Check the arithmetic against the items before relaying a count.**

---

## OPEN QUESTIONS FOR DAVID
1. Do the AI research and FastAppend charges stack, or is it $0.15 once for an entity trace?
2. Landing page: update in the branch before merge. Not done.
3. The commercial research test needs him to run it or approve it interactively. Two commands are in
   the conversation; the harness is at `<scratchpad>/run-research.ts` and the scratchpad is
   session-scoped, so it may need regenerating.
4. Whether to verify the registered-agent clustering by reading `is_registered_agent`, which is free.
