# Retire the ai_research name, record the contact vendor, make the label ours

Plan, 2026-09-20. PropTracerPRO, with one coordinated touch in suite-gateway.

Status: awaiting David's approval. No code written.

## Why

David, 2026-09-20: "THERE IS NO AI RESEARCH ANYMORE... Do the rename and fix the tier 2 label
so it is only visible to us, not the user."

Three separate things are tangled under one name.

1. The AI Search engine is gone. Verified: zero call sites for Brave, Claude or any LLM in
   owner discovery, no `@anthropic-ai` package, and nothing anywhere in `app`, `lib`, `types`,
   `components` or `scripts` reads `BRAVE_SEARCH_API_KEY` or `ANTHROPIC_API_KEY`.
2. The `ai_research*` columns were repurposed in the same commit as FastAppend's storage for
   the tier 1 entity queue. The name is a lie about the engine, which
   `supabase/migrations/20260918_property_trace_queue.sql:22-23` already says out loud.
3. `owner_contact_source` reports `person_trace` for every tier 2 FastAppend hit. That is a
   live wrong answer shipped to customers on five surfaces, and it is what made this session
   report an entity trace as a person trace.

## The measured ground this rests on

Live database, project `rmmwkjmjchpfebxroyoo`, read from `information_schema` and the `pg_*`
catalogs rather than the migration files.

| Column | Type | Populated | Null |
|---|---|---|---|
| `ai_research` | jsonb | 1,301 | 2,537 |
| `ai_research_status` | varchar(20) | 1,298 | 2,540 |
| `ai_research_charge` | numeric(10,4) | 3,838 (743 above zero) | 0 |
| `ai_research_claimed_at` | timestamptz | 0 | 3,838 |

Dependent objects: exactly two partial indexes,
`idx_trace_history_research_queue` and `idx_trace_history_research_stale_claim`, both with
WHERE clauses on `ai_research_status`. No views, no functions, no triggers, no constraints, no
RLS policy and no publication references any of the four. No other table has such a column.

`supabase/schema.sql` is already out of sync with the live database: it omits
`ai_research_claimed_at`. It is not the source of truth for this work.

Test baseline, measured 2026-09-20: 75 files, 1,502 passing, 0 failing. PropTracerPRO's vitest
config has no `test` block at all, so it loads no `.env.local` and every test is hermetic.
That is the opposite of suite-gateway, where a plain `npm test` runs live.

## The three risks that decide the shape of this plan

**Twelve column names live inside strings**, invisible to TypeScript. Four of them are
`.eq` / `.in` / `.or` filters in the entity cron
(`sweep-entity-traces/route.ts:231, 242, 262, 314`). A miss there does not throw. The queue
silently stops draining.

**Fifteen `select('*')` readers** fetch whatever the column is called and then read the old
property name. A miss yields `undefined`, which flows through `|| 0` and `?? null` and presents
as zeros and nulls rather than an exception.

**One cross-repo coupling**, `suite-gateway/lib/tools/crm-push-owners.ts:1615`. It reads
`row.ai_research_charge` off the WIRE, not the database, behind a `typeof` guard, through an
untyped `Record<string, unknown>`. Rename the response key and it degrades silently to 0 with
no test red in either repo.

## What is NOT in scope

Deleting the two `ai_research` branches in `resolveOwnerContact`. They are live reads of
dead-engine data on 167 rows customers paid for, served through v1 and the MCP. Deleting them
blanks the owner contact on those rows. They get renamed, not removed.

Renaming the wire field `ai_research_charge`. The column rename is deliberately decoupled from
the response key, so no coordinated cross-repo deploy is needed. Revisit separately if wanted.

---

## Phase 1: record which vendor actually ran

Additive only. No rename, no removal, nothing customer-visible changes. This is the missing
fact everything else depends on, and it closes the auditability gap on its own.

Today `ExecutionResult` (`lib/routing/executeRoute.ts:130-147`) carries `contacts` and
`contactsFound` and no vendor discriminator. `executeRoute` assigns `result.contacts` at `:405`
and `:481` from either pass without recording which step produced it. The provenance is
destroyed before it reaches the labelling site, which is why the label has to be guessed today.

- [ ] Migration `20260920_trace_history_contact_vendor.sql`: `ADD COLUMN IF NOT EXISTS
      contact_vendor VARCHAR(32) DEFAULT NULL`, with a column comment. No grants needed,
      `ADD COLUMN` inherits the table ACL. Read the ACL back afterwards (L-017).
- [ ] Thread a vendor discriminator out of `executeRoute` from the contact step's `kind`.
      `FASTAPPEND_ENTITY` to `fastappend`, `TRACERFY_INSTANT_NAMED` and `TRACERFY_PARCEL_APN`
      to `tracerfy`.
- [ ] Carry it through `traceResultFor` (`lib/trace/fullPropertyTrace.ts:134-152`).
- [ ] Persist it in the tier 2 settle payload
      (`app/api/cron/sweep-property-traces/route.ts:552-607`) and on the tier 1 entity paths
      (`sweep-entity-traces/route.ts:436, 465`).
- [ ] Tests, each mutation-verified: an entity-classified owner records `fastappend`, an
      individual records `tracerfy`, a row with no contact step records null.

STOP. Report the vendor recorded on the next real row before going further.

## Phase 2: fix the label, and make it ours

- [ ] `resolveOwnerContact` prefers `contact_vendor` when present and falls back to today's
      chain for the 1,301 legacy rows. Add `OwnerContactSource` value `tracerfy`; keep
      `ai_research` for legacy rows until Phase 3 renames it.
- [ ] Remove `owner_contact_source` from all five customer surfaces:
      v1 REST (`app/api/v1/trace/bulk/status/route.ts:438`), the `bulk_job.completed` webhook
      (same builder, reaching `:391`), `ptp_bulk_status` (`lib/suite/mcp-tools.ts:623`),
      `ptp_list_traces` (`lib/suite/mcp-tools.ts:91`), and the docs
      (`app/(dashboard)/settings/api-keys/docs/page.tsx:486, 512`,
      `docs/AGENT_BULK_INTEGRATION.md:217, 243, 282, 305`, and the MCP tool description at
      `app/api/[transport]/route.ts:97`).
- [ ] `listTraces:91` spreads `...resolveOwnerContact(...)`. A spread puts the field straight
      back. Destructure the name only, so the removal cannot be undone by accident.
- [ ] `lib/trace/__tests__/payloadParity.test.ts` asserts both `buildPerRecordResult` twins
      have identical key sets and at least 12 keys each. Remove from BOTH twins or it goes red;
      v1 drops 16 to 15, which still passes.
- [ ] Add a leak guard in the style already at `sweep-entity-traces:244` and
      `mcp-tools.test.ts:621`, asserting `owner_contact_source` never appears in a customer
      payload, so this cannot come back silently.
- [ ] suite-gateway: its `mockPtp` still emits `owner_contact_source`
      (`tests/crm-push-owners.test.ts:433`) with zero assertions on it. Once PTP stops sending
      it, that mock expresses a shape the wire cannot produce, which is that repo's own
      lesson 5. Update it in the same wave.

STOP.

## Phase 3: the rename

- [ ] Migration `20260920_rename_ai_research_to_entity_trace.sql`: four `RENAME COLUMN`
      (`ai_research` to `entity_trace`, `_status`, `_charge`, `_claimed_at` likewise) plus
      `ALTER INDEX` for both partial indexes. Renames are metadata-only and the partial index
      predicates follow the column automatically.
- [ ] Update, in one commit: 6 writer sites in `sweep-entity-traces`, 3 in
      `sweep-business-traces`, `settleBulkJob:264`, the four `buildHistoryRow` families, all
      12 string-embedded names, the 15 `select('*')` property reads, and the types in
      `types/index.ts:99-101, 322-355`, `settleBulkJob.ts:40-42`, `rowSkipReason.ts:60-63`,
      `billedRows.ts:36`, `contacts.ts:42-58`.
- [ ] Move `lib/ai-research/contacts.ts` to `lib/entity-trace/contacts.ts` and update the five
      importers.
- [ ] KEEP the response key `ai_research_charge` exactly as it is on both v1 and MCP, reading
      from the renamed column. That is what keeps suite-gateway:1615 working with no
      coordinated deploy. Comment it at both emit sites so nobody "finishes" the rename there.
- [ ] Fix `supabase/schema.sql`, which is missing `ai_research_claimed_at` today.
- [ ] Test landmines, none of which are find-and-replace:
      the Supabase mock table dispatcher at `app/api/trace/bulk/status/__tests__/route.test.ts:102`
      branches on `cols.includes("ai_research_status")` and will return the WRONG TABLE if
      missed, failing about 23 tests with errors that point nowhere near the cause;
      `sweep-entity-traces/__tests__/route.test.ts:173-175` and `:779-780`;
      `tierLedger.test.ts:125-129`; `chargeReceipt.test.ts:234-235`; and the leak-guard loop
      drivers at `sweep-entity-traces:244`, `:331`, `mcp-tools.test.ts:621`, which stop
      guarding while staying green if a name is missed.

### Deploy order for Phase 3, which is the risky part

There is no deploy order with zero window: code written against the new names breaks before the
migration, and the migration breaks the old code until the deploy lands.

What makes it safe here is that the queue is empty. `ai_research_status` at rest holds only
`found` and `not_found`; every cron ladder value is absent, and `ai_research_claimed_at` has
never been observed populated. So:

- [ ] Verify immediately before: no row in a queued or processing state.
- [ ] Apply the migration, then deploy at once.
- [ ] Verify after: the entity cron and the property cron both complete a pass cleanly.

The crons are idempotent queue drainers that retry, so a one to three minute window where a
pass errors costs a retry, not data.

## Verification for every phase

`npm test` in PropTracerPRO, baseline 1,502 passing across 75 files, must not drop without a
named and counted reason. `npx tsc --noEmit` at 0. For suite-gateway, never a plain `npm test`:
`MPS_READONLY_DB_URL= GATEWAY_SUPABASE_SERVICE_ROLE_KEY= npx vitest run`, and 24 skipped is
part of the baseline. A run reporting 0 skipped hit production.

## Separately, and not part of this plan

`BRAVE_SEARCH_API_KEY` and `ANTHROPIC_API_KEY` are still provisioned in PropTracerPRO's Vercel
project across Development, Preview and Production, 233 days old, and nothing reads either.
Dead code plus a live credential is how something fires by accident. They can be removed at any
time with no code change.
