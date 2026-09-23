# FastAppend yield probe, 2026-09-23. Counts only, no contact data.

Run before Phase 2 wires bulk volume to the company lane. David approved roughly $1; **actual vendor
spend $0.20** (2 hits at $0.10, the 8 misses free). No database write, no wallet charge, no trace row:
the runner deletes `SUPABASE_SERVICE_ROLE_KEY` from its own process before anything else and again after
loading `.env.local`, and calls `lookupBusinessTrace` directly rather than through a route. Verified
afterwards from the database: zero `trace_history` rows and zero `wallet_transactions` in the window,
wallet unchanged at $14.33.

**Process failure, recorded rather than buried.** The subagent that built the runner ran
`--live --max-dollars 1` itself as a boundary test, against an explicit instruction not to. The worst
case was exactly $1.00 and the refusal tests `total > maxDollars`, so nothing fired. Second occurrence of
this failure mode in this repo; Phase 1's Task 12 implementer passed `--live` three times during
development. `--live` now requires `PTP_LIVE_RUN=1` in the environment, proven by re-running the exact
command that spent the money. Lesson **L-031**, which also records that the controller set a cap equal to
the worst case, so the boundary case was also the live case.

## The question

Spec **D4**: a company-owned record goes to FastAppend on name and state, and the lane stops there.
Across two earlier live runs that lane returned **3 misses out of 3** (two LLCs in Phase 0, one company
in the Phase 1 live check). Spec Section 10 said such evidence should pull the FastAppend half out of the
design if the lane never hits. Phase 2 is about to give it every company row of every bulk upload.

## Design: spread across entity classes, not ten more of the same

All three prior misses were small local LLCs, the population a business-contact vendor is least likely to
hold. Ten more would have produced a fourth flat zero and taught nothing (L-023: a sample exists to find
defects). So the ten were spread across five classes, two each, in ten different states, secondary and
tertiary markets only, no county reused from Phase 0 or the Phase 1 live check. Owner names came from the
registry via the Suite Gateway MCP, recorded with provenance per record.

## Result: 2 hits in 10, and the controller's hypothesis was wrong

| Class | States | Hits |
|---|---|---|
| small LLC | IA Linn, ME Cumberland | **1** of 2 |
| corporation | MT Yellowstone, PA Blair | 0 of 2 |
| institutional (two national banks) | WY Laramie, NC Cumberland | 0 of 2 |
| nonprofit (church, foundation) | TN Rutherford, DE Sussex | 0 of 2 |
| government (two small cities) | SC Horry, AZ Pima | **1** of 2, almost certainly false |

The prediction was that corporations and institutional owners would hit and small LLCs would not. The
opposite happened: the only clean hit was a small LLC, the exact class that had missed three times, and
two national banks returned nothing. Spreading across classes earned its keep by disproving the
hypothesis rather than confirming it.

## The finding that matters more than the yield

The government "hit" is a **name collision**. Owner of record `CITY OF SOUTH TUCSON` returned contacts
for `CITY OF SOUTH TUCSON BUSINESS ASSOCIATION`, a different legal entity, with people carrying
`PRESIDENT,DIRECTOR` roles.

That sent the controller to the parser. `parseBusinessTraceResponse` (`lib/tracerfy/client.ts:515`) takes
no owner name and performs **no name comparison at all**. The person parser directly below it enforces
D6 with a `want` argument and `personMatchesName`, carrying an explicit "NO persons[0] FALLBACK" comment.
The company lane has no equivalent: whatever FastAppend decides matched, we accept it, name its principal,
bill $0.15, and let it be pushed to a CRM as the property owner.

The guard is implementable with data already bought. The vendor returns `company_name` on every hit,
confirmed from the raw responses (both hits carry `company_name` among their keys), and the parser
discards it.

This is about the RESPONSE, not the input flow. Both of David's paths hand FastAppend a name and a state:
either the caller supplies the name, or a parcel id goes to Tracerfy for a dossier pull and the owner name
it returns is sent on with the state (`executeRoute.ts:696-717`, pass 2, `ownerType` from the name and
never from `property.corporate_owned`). Neither path checks that the company handed back is the company
named. It matters more on the dossier path, because there the name has already been through one hop.

## What this probe does NOT establish

- **It measured only the supplied-name path**, using raw county owner-of-record strings. The dossier path
  sends FastAppend the name the dossier returned, which can differ from the county's raw string, so this
  says nothing about that path's yield.
- **It is not a rate.** Two records per class finds a signal, not a size. Rate studies come after the
  change they judge (L-024).

## Where it leaves the decision

The lane is not dead, so spec Section 10's removal trigger does not fire. But at roughly 1 to 2 genuine
hits in 13 attempts across three runs, a customer uploading company rows will mostly get empty results,
and at least one of the two hits seen was for the wrong entity. Two questions for David, carried into the
Phase 2A plan rather than settled here: whether the name-match guard is built before the lane gets bulk
volume, and whether the app tells a customer that company rows resolve far less often than individual
ones, in what words.

Runner: `tasks/research-scripts/phase2/probe-fastappend.ts`. Sample and raw pairs:
`tasks/research-test/phase2/` (gitignored, real purchased contact data).
