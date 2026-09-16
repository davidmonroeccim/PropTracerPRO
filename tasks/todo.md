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
