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
