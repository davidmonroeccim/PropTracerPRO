# The dossier's second lookup key: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MCP caller supply a county parcel id so the dossier's already-written, never-executed `DOSSIER_APN` step fires for the first time.

**Architecture:** `planRoute` has always emitted two dossier steps, APN-keyed and address-keyed, stopping at the first hit. `hasApn()` has never once returned true because nothing populates `ParcelInput.parcelIdLocal`. This plan carries a parcel id and county from the MCP submit, through a new pair of `trace_history` columns (the tier 2 queue separates submit from execution, so the values must persist), into `parcelForFullTrace`, which finally populates the two fields the gate checks.

**Tech Stack:** TypeScript, Next.js, Zod, Supabase Postgres, Vitest, Tracerfy dossier API.

**Consumer spec:** `/Users/davidmonroe/suite-gateway/docs/superpowers/specs/2026-09-19-crm-push-dossier-tier-design.md` section 7b. The Suite Gateway is the only caller that will supply these fields. It holds a county parcel id as `CuratedProperty.parcel_number_1`, sourced from the property registry's `parcel_id_local`.

## Global Constraints

- **The APN key is a THREE-part key: `apn`, `county`, `state`.** Not two. `state` is already required on `recordSchema`, already persisted, and already mapped onto `ParcelInput.state` by `parcelForFullTrace`. A request missing any of the three is malformed. This is written here because the consumer spec described it as two fields three times before David caught it.
- **This is NOT an upgrade over the address key.** The two fail independently: Napa hit on APN and missed on address, Salt Lake did the reverse. This adds a second independent attempt, it does not replace the first. Never write copy or a comment claiming the parcel id is more accurate.
- **A dossier miss is free at the vendor**, which is the entire reason emitting both steps is safe. Do not add logic that "saves" a call by skipping one.
- **Migration rules:** follow the Supabase Migration Template in `CLAUDE.md`. `ADD COLUMN` on a pre-existing table does NOT need new grants. `trace_history` was locked down on 2026-09-18 (`20260918_lock_trace_history_writes.sql`) leaving `anon` and `authenticated` with SELECT only; a new column inherits that. **Read the ACL back after applying and account for anything you did not predict** (L-017).
- **Never create fallback, fake or placeholder data** (CLAUDE.md rule 7). An absent parcel id is absent; it is never an empty string.
- **Test baseline: 1489 passing / 75 files / 0 failing, `tsc` 0, eslint 47, build compiles.** Confirm before you start and after you finish. The total must not drop without a named, counted reason.
- **Scope: the MCP submit only.** `app/api/v1/trace/bulk/route.ts` and `app/api/trace/bulk/route.ts` also enqueue tier 2 rows and are deliberately NOT wired. Giving either a parcel id means a public API field or a CSV column, which is a product decision about those surfaces. This is a choice, not an oversight: see L-018 on wiring some call sites and not others.
- **Update `History.md`** after the task completes (CLAUDE.md rule 9).

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260919_trace_history_parcel_key.sql` (create) | Two nullable text columns carrying the APN key across the queue. |
| `lib/suite/mcp-tools.ts` (modify) | `recordSchema` accepts `apn` and `county`; `buildHistoryRow` persists them. |
| `lib/trace/fullPropertyTrace.ts` (modify) | `parcelForFullTrace` accepts and forwards them. |
| `app/api/cron/sweep-property-traces/route.ts` (modify) | Row type and `select` carry them; the parcel is built with them. |
| `lib/trace/__tests__/fullPropertyTrace.test.ts` (modify) | The gate: `hasApn` true, both steps emitted, order correct. |
| `lib/suite/__tests__/mcp-tools.test.ts` (modify) | Schema accepts the fields; the row persists them; absent stays absent. |

---

## Task 1: Carry the parcel id from the MCP submit to the dossier call

One task, not five. Every piece below is the same deliverable and a reviewer could not sensibly approve one half: a migration with nothing writing to it, or a schema field that never reaches the vendor, are each worse than not starting.

**Files:** all six above.

**Interfaces:**
- Consumes: nothing.
- Produces: `recordSchema` accepts optional `apn` and `county`; `parcelForFullTrace(input)` reads `input.apn` and `input.county`.

- [ ] **Step 1: Confirm the baseline before touching anything**

```bash
cd /Users/davidmonroe/PropTracerPRO
npx vitest run 2>&1 | tail -5
npx tsc --noEmit && echo "tsc clean"
```

Expected: 1489 passing, 75 files, 0 failing, tsc clean. If it differs, STOP and report: the plan's numbers are stale and everything downstream compares against them.

- [ ] **Step 2: Write the failing test for the gate**

The point of this whole task is that `hasApn()` becomes reachable. Test that first, because it is the thing that has never been true. Add to `lib/trace/__tests__/fullPropertyTrace.test.ts`:

```ts
describe('parcelForFullTrace with a parcel id', () => {
  it('populates parcelIdLocal and county so hasApn can finally be true', () => {
    const parcel = parcelForFullTrace({
      address: '203 Dauphin St', city: 'Mobile', state: 'al', zip: '36602',
      apn: 'R022901', county: 'Mobile',
    })
    expect(parcel.parcelIdLocal).toBe('R022901')
    expect(parcel.county).toBe('Mobile')
    // The THIRD part of the APN key. Already carried, asserted here so a refactor that
    // drops it is caught: an apn and a county without a state is a malformed request.
    expect(parcel.state).toBe('AL')
  })

  it('leaves both null when no parcel id is supplied, which is every caller today', () => {
    const parcel = parcelForFullTrace({ address: '203 Dauphin St', city: 'Mobile', state: 'AL' })
    expect(parcel.parcelIdLocal ?? null).toBeNull()
    expect(parcel.county ?? null).toBeNull()
  })

  it('treats a blank parcel id as absent, never as a value', () => {
    // CLAUDE.md rule 7: no placeholder data. An empty string would make hasApn() true and
    // send a request with an empty apn, which the vendor charges nothing for and answers
    // with nothing, so it would be an invisible waste rather than an error.
    const parcel = parcelForFullTrace({
      address: '203 Dauphin St', city: 'Mobile', state: 'AL', apn: '   ', county: '',
    })
    expect(parcel.parcelIdLocal ?? null).toBeNull()
    expect(parcel.county ?? null).toBeNull()
  })

  it('emits BOTH dossier steps, APN first, when both keys exist', () => {
    const plan = planRoute(parcelForFullTrace({
      address: '203 Dauphin St', city: 'Mobile', state: 'AL', apn: 'R022901', county: 'Mobile',
    }), 'pro')
    expect(plan.steps.map((s) => s.kind)).toEqual(['DOSSIER_APN', 'DOSSIER_ADDRESS'])
  })

  it('sends apn, county AND state on the APN step', () => {
    // The three-part key. A request with two of the three is malformed and the vendor
    // answers it with a miss, which is free and therefore silent.
    const plan = planRoute(parcelForFullTrace({
      address: '203 Dauphin St', city: 'Mobile', state: 'AL', apn: 'R022901', county: 'Mobile',
    }), 'pro')
    const apnStep = plan.steps.find((s) => s.kind === 'DOSSIER_APN')!
    expect(apnStep.request).toEqual({ apn: 'R022901', county: 'Mobile', state: 'AL' })
  })

  it('still emits the address step alone when only a situs exists', () => {
    // The regression fence for every caller that exists today. Address mode is the proven
    // key and must not become conditional on a parcel id arriving.
    const plan = planRoute(
      parcelForFullTrace({ address: '203 Dauphin St', city: 'Mobile', state: 'AL' }), 'pro',
    )
    expect(plan.steps.map((s) => s.kind)).toEqual(['DOSSIER_ADDRESS'])
  })
})
```

- [ ] **Step 3: Run and confirm it fails**

```bash
npx vitest run lib/trace/__tests__/fullPropertyTrace.test.ts
```

Expected: FAIL. `parcelForFullTrace` takes no `apn` and sets `parcelIdLocal` nowhere.

- [ ] **Step 4: Widen `parcelForFullTrace`**

In `lib/trace/fullPropertyTrace.ts`, extend the input type with two optional fields and forward them. Replace the `ownerName: null` return block's object with:

```ts
export function parcelForFullTrace(
  input: TraceAddressInput & { apn?: string | null; county?: string | null },
): ParcelInput {
  const state = input.state.trim().toUpperCase()
  return {
    state,
    situsAddress: input.address.trim(),
    situsCity: input.city.trim(),
    situsState: state,
    situsZip: input.zip?.trim() || null,
    // THE SECOND DOSSIER KEY, and the first caller that has ever supplied it. hasApn()
    // needs BOTH of these plus `state` above: apn, county and state is a three-part key
    // and a request missing any part is malformed. Blank trims to null rather than to ''
    // because an empty apn would make hasApn() true and spend an attempt on a request the
    // vendor answers with a free, silent miss (CLAUDE.md rule 7).
    parcelIdLocal: input.apn?.trim() || null,
    county: input.county?.trim() || null,
    ownerName: null,
  }
}
```

The docblock above this function currently says "No `parcelIdLocal` and no `county`: nothing in PTP produces a parcel id". Rewrite it: a caller now can, the Suite Gateway supplies it from the property registry, and address mode remains the proven key that fires whenever a situs exists.

- [ ] **Step 5: Run and confirm the gate tests pass**

```bash
npx vitest run lib/trace/__tests__/fullPropertyTrace.test.ts
```

- [ ] **Step 6: Write the migration**

Create `supabase/migrations/20260919_trace_history_parcel_key.sql`:

```sql
-- The dossier's second lookup key, carried from submit to execution.
--
-- WHY A MIGRATION AND NOT A PARAMETER. The tier 2 queue separates the two: an MCP submit
-- writes a trace_history row, and sweep-property-traces buys the dossier up to a minute
-- later, rebuilding the parcel from that row alone. Today it reads normalized_address,
-- city, state and zip, so a parcel id supplied at submit time has nowhere to live.
--
-- WHY NOT normalized_address. That column is the dedup key (sha256 over STREET|CITY|STATE,
-- migration 20260904). Anything added to it re-buys every existing row forever.
--
-- WHY NOT property_record. That is the OUTPUT, the raw 86-key vendor dump, and the raw
-- dump is the product. Writing an input into it would corrupt that claim silently.
--
-- GRANTS: none needed. ADD COLUMN on a pre-existing table inherits the table's ACL, and
-- 20260918_lock_trace_history_writes.sql left anon and authenticated with SELECT only.
-- Read the ACL back after applying anyway and account for anything unexpected (L-017).

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS parcel_id_local VARCHAR(64) DEFAULT NULL;

ALTER TABLE public.trace_history
  ADD COLUMN IF NOT EXISTS county VARCHAR(64) DEFAULT NULL;

COMMENT ON COLUMN public.trace_history.parcel_id_local IS
  'County parcel id supplied by the caller, used with county and state as the dossier''s APN key. NULL for every caller that sends only an address.';
COMMENT ON COLUMN public.trace_history.county IS
  'Bare county name for the dossier APN key. Tracerfy wants "Stark", never "Stark County".';
```

- [ ] **Step 7: Apply the migration and read the ACL back**

Apply it, then confirm the columns exist AND that the grants are what you expect. Do not skip the read-back: a migration reporting success tells you nothing about who can write the result.

```sql
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='trace_history'
   and column_name in ('parcel_id_local','county');

select unnest(relacl)::text from pg_class where oid='public.trace_history'::regclass;
```

Expected: both columns present and nullable; the ACL shows `anon` and `authenticated` with read-only rights and `service_role` with writes. **Account for any value you did not predict, even a benign one** (L-017: the unexplained TRUE is the finding).

- [ ] **Step 8: Write the failing tests for the MCP surface**

Add to `lib/suite/__tests__/mcp-tools.test.ts`:

```ts
describe('skip_trace_bulk carries the dossier parcel key', () => {
  it('accepts apn and county on a record', () => {
    const parsed = recordSchema.safeParse({
      address: '203 Dauphin St', city: 'Mobile', state: 'AL',
      apn: 'R022901', county: 'Mobile',
    })
    expect(parsed.success).toBe(true)
  })

  it('still accepts a record with neither, which is every caller today', () => {
    expect(recordSchema.safeParse({
      address: '203 Dauphin St', city: 'Mobile', state: 'AL',
    }).success).toBe(true)
  })

  it('persists both onto the trace_history row', async () => {
    // The whole point of the migration. If these are not written at submit, the cron
    // cannot use them a minute later and the APN step stays dead with no error anywhere.
    const rows = await capturedHistoryRowsFor([{
      address: '203 Dauphin St', city: 'Mobile', state: 'AL',
      apn: 'R022901', county: 'Mobile',
    }])
    expect(rows[0].parcel_id_local).toBe('R022901')
    expect(rows[0].county).toBe('Mobile')
  })

  it('writes null, never an empty string, when they are absent', async () => {
    const rows = await capturedHistoryRowsFor([{
      address: '203 Dauphin St', city: 'Mobile', state: 'AL',
    }])
    expect(rows[0].parcel_id_local).toBeNull()
    expect(rows[0].county).toBeNull()
  })
})
```

Build `capturedHistoryRowsFor` from the file's existing Supabase stub; do not invent a second harness.

- [ ] **Step 9: Wire the MCP surface**

In `lib/suite/mcp-tools.ts`:

Add to `recordSchema`, after `zip`:

```ts
  /** The dossier's SECOND lookup key, with county and state. Optional: every caller before
   *  the Suite Gateway sent an address only, and address mode stays the proven key. The two
   *  keys fail INDEPENDENTLY (Napa hit on APN and missed on address; Salt Lake did the
   *  reverse), so supplying this adds a second attempt rather than replacing the first, and
   *  a dossier miss is free at the vendor so the extra attempt costs nothing unless it works. */
  apn: z.string().optional(),
  /** Bare county name for the APN key. Tracerfy wants "Stark", never "Stark County". */
  county: z.string().optional(),
```

In `buildHistoryRow`, add to the returned object:

```ts
      parcel_id_local: record.apn?.trim() || null,
      county: record.county?.trim() || null,
```

Also extend the `skip_trace_bulk` tool description in `app/api/[transport]/route.ts` to mention that a county parcel id and county name may be supplied and are used as a second, independent lookup key. No em-dashes, no en-dashes, no asterisks, no emoji.

- [ ] **Step 10: Wire the cron**

In `app/api/cron/sweep-property-traces/route.ts`, add `parcel_id_local: string | null;` and `county: string | null;` to the row interface, add both to the `select` string, and pass them into `parcelForFullTrace`:

```ts
        parcelForFullTrace({
          address: streetAddress,
          city: row.city || '',
          state: row.state || '',
          zip: row.zip,
          apn: row.parcel_id_local,
          county: row.county,
        }),
```

**The select is a fence.** Drop a column from that string and the cron emits null for every row, which is indistinguishable from a caller who never sent a parcel id. The same trap is already documented at `mcp-tools.ts:57-61` for `property_record` and `tier`.

- [ ] **Step 11: Run the full suite**

```bash
npx vitest run 2>&1 | tail -5
npx tsc --noEmit && echo "tsc clean"
npx eslint app lib components 2>&1 | tail -3
npm run build
```

Expected: the total has risen from 1489 by the number of tests you added, 0 failing, tsc clean, eslint still 47, build compiles.

- [ ] **Step 12: Mutation-verify, every one must go RED**

Run each, confirm RED, restore, and record the result. A survivor means the behaviour is unfenced. The list is a floor and not a ceiling: if you can think of another way this silently does nothing, mutate that too and report it.

1. Drop `parcel_id_local` from the cron's `select` string.
2. Drop `county` from the cron's `select` string.
3. Stop passing `apn` into `parcelForFullTrace` in the cron.
4. Stop passing `county` into `parcelForFullTrace` in the cron.
5. Make `parcelForFullTrace` write `''` instead of `null` for a blank apn.
6. Remove `county` from the `DOSSIER_APN` request object in `ownerRoute.ts`, leaving apn and state.
7. Remove `state` from the `DOSSIER_APN` request object, leaving apn and county.
8. Drop `parcel_id_local` from `buildHistoryRow`.
9. Swap the push order in `planRoute` so the address step precedes the APN step.

Mutations 6 and 7 are the three-part key. If either survives, the request shape is not pinned and a malformed key would ship silently, because the vendor answers a malformed request with a free miss.

- [ ] **Step 13: Commit and record**

```bash
git add supabase/migrations/20260919_trace_history_parcel_key.sql lib/suite/mcp-tools.ts \
        lib/trace/fullPropertyTrace.ts app/api/cron/sweep-property-traces/route.ts \
        app/api/\[transport\]/route.ts lib/trace/__tests__/fullPropertyTrace.test.ts \
        lib/suite/__tests__/mcp-tools.test.ts
git commit -m "feat(trace): accept a county parcel id as the dossier's second lookup key"
```

Then update `History.md` with the date, the task name, and what changed, per CLAUDE.md rule 9. Note explicitly that `DOSSIER_APN` has fired for the first time since it was written on 2026-09-16.

- [ ] **Step 14: STOP. Live verification is David's call.**

Proving the APN key works end to end means spending real money at Tracerfy, because a dossier hit costs 0.20. Do not do it without asking. Present which parcel you propose, the exact spend, and what you will read back to prove the APN step fired rather than the address step. Then wait.

---

## Self-Review

**Coverage.** Consumer spec 7b item 1 to Steps 6 and 7. Item 2 to Step 9. Item 3 to Step 9. Item 4 to Step 10. Item 5 to Step 4. The three-part key constraint to Steps 2, 4 and mutations 6 and 7. The scope limit to Global Constraints. The independence claim to Global Constraints and the `recordSchema` comment.

**Placeholder scan.** No TBD, no TODO. Every step carries real code or a real command. Step 8's `capturedHistoryRowsFor` is deliberately left to follow the file's existing Supabase stub rather than reproducing that scaffolding here and inviting a divergent second copy.

**Type consistency.** `apn` and `county` are the wire names on `recordSchema` throughout. `parcel_id_local` and `county` are the column names throughout. `parcelIdLocal` and `county` are the `ParcelInput` field names throughout. The three naming layers are deliberate and each is used consistently in its own layer.
