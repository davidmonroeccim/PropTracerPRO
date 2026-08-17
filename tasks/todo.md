# Resolved owner contact (person) never reaches the consumer — diagnosis + fix plan (2026-08-17)

Report (David): "When the gateway calls PTP to get the owner contact name, phone, and/or email,
PTP is only returning the company name and phone and email, not the owner contact (Person). So the
Owner Contact Name field never gets updated in the spreadsheet."

## What the evidence shows

**PTP is finding the person. The person's name just has no self-describing field in the payload.**

Evidence sheet: `Maturr/app/docs/Claude Exports/Dallas_MSA_MF_Loans_DSCR_below_1.25_maturing_thru_2028.csv`
(the run where PTP actually executed — 77 MCP trace rows, 2026-08-12..14).

| Check | Result |
|---|---|
| MCP trace rows in the run window | 77 |
| Rows where `trace_result.owner_name` holds a real person | **45** |
| Rows where `business_trace_contacts.owner_name` holds a person | 29 |
| Rows where `individual_behind_business` holds a person | 49 |
| Entity-input rows whose person name merely echoes the company | **0** (85 checked) |
| Those 45 person names present anywhere in the delivered CSV | **0 of 18 sampled — all ABSENT** |

The person's *email* landed in the sheet while their *name* did not, which is what makes this
conclusive — the data was in the response and the consumer dropped only the name:

| Sheet `Owner Name` | Sheet email that landed | PTP `trace_result.owner_name` |
|---|---|---|
| Magnolia Property Company | `dhamann2@gmail.com` | **Daniel Hamann** |
| Kisna Investment Group LLC | `drshetal@aol.com` | **Shetal Patel** |
| iForte Properties, LLC | alt `hidoski@comcast.net` | **Gazim Idoski** |
| Westdale Real Estate Investment | `joebeardjr@yahoo.com`, alt `jbeard@westdale.com` | **Joe Beard** |
| Sphinx Development Corporation | (none) | **Paul Osaji** |

## Root cause

`buildPerRecordResult` — duplicated in `lib/suite/mcp-tools.ts:348` (MCP) and
`app/api/v1/trace/bulk/status/route.ts:328` (REST) — emits **four keys named some variant of
"owner name", at three nesting levels, carrying two different meanings**:

```jsonc
{
  "input_owner_name": "Magnolia Property Company",   // the ENTITY we asked about
  "result":   { "owner_name": "Daniel Hamann" },     // the PERSON we resolved  <-- the payload
  "research": { "owner_name": "Magnolia Property Company",
                "individual_behind_business": "Daniel Hamann" },
  "contacts": { "owner_name": "Daniel Hamann" }      // the PERSON (FastAppend)
}
```

A consumer mapping a column called "Owner Name" finds `input_owner_name` / `research.owner_name`
— the company, matching what it already had — then harvests `result.phones` and `result.emails`.
`result.owner_name` reads as a *restatement of the owner it already knows*, not as "the human
behind the entity", so it is discarded. Nothing in the payload is named for the thing the entity
skip trace exists to produce.

Not the cause (ruled out with evidence):
- Not the gateway. `suite-gateway` proxies `ptp_*` verbatim (`lib/aggregator/registry.ts`); it adds
  and strips nothing.
- Not the FastAppend parse. `downloadBusinessTraceResults` correctly builds `owner_name` from the
  CSV's `First Name` + `Last Name` (`lib/tracerfy/client.ts:237`).
- Not entitlements. `prop-tracer-pro` is granted on David's gateway account.
- Not a storage bug. Every one of the 178 MCP rows carrying a phone or email also carries a
  `trace_result.owner_name`; zero echo the company.

## Plan

- [ ] 1. Extract the person-resolution precedence into one shared helper,
      `resolveOwnerContact(row)` in `lib/ai-research/contacts.ts`, returning
      `{ owner_contact_name, owner_contact_source }`. Precedence is the chain that already exists
      inline at `app/api/cron/sweep-bulk-research/route.ts:138-146`:
      `business_trace_contacts.owner_name` (`fastappend`) → `trace_result.owner_name`
      (`person_trace`) → `individual_behind_business` (`ai_research`) →
      `owner_name` when `owner_type === 'individual'` (`ai_research`). Null when none — never a
      company name, never a fabricated value.
- [ ] 2. Failing test first: assert the MCP per-record payload for an entity input
      (`Magnolia Property Company` → `Daniel Hamann`) exposes a top-level `owner_contact_name`.
      Confirm it fails before touching the source.
- [ ] 3. Add `owner_contact_name` + `owner_contact_source` to the top level of
      `buildPerRecordResult` in `lib/suite/mcp-tools.ts`.
- [ ] 4. Mirror it in the REST twin `app/api/v1/trace/bulk/status/route.ts` so the two surfaces
      cannot diverge (they are line-for-line identical today, by design).
- [ ] 5. Point the shared helper at `sweep-bulk-research`'s inline `resolvedPerson` so the
      precedence has exactly one definition, matching the `isEntityRecord` single-source-of-truth
      convention already used for the person/entity split.
- [ ] 6. Surface it in `list_traces` too — it currently selects neither `trace_result` nor
      `ai_research`, so it returns `input_owner_name` (the company) plus bare phone/email *counts*
      and no contact at all.
- [ ] 7. Update the tool descriptions so an agent knows the field exists and what it means, and
      the API docs page (`app/(dashboard)/settings/api-keys/docs/page.tsx:234`).
- [ ] 8. Verify: re-read a settled Dallas job through the MCP surface and confirm Daniel Hamann,
      Shetal Patel, Gazim Idoski, Joe Beard and Paul Osaji all appear in `owner_contact_name`.
      No re-trace, no new spend — these rows are already settled in `trace_history`.

## Confirming natural experiment (David, 2026-08-17)

David re-ran the same pipeline for Houston with one prompt change: he appended "including the
owner contact, the person." Same PTP code, same payload, different consumer instruction:

| Run | Prompt asked for the person | Person names delivered |
|---|---|---|
| Dallas | no | **0** (the sheet had no such column at all) |
| Houston | yes | **66 of 83** (`Owner Contact Person`) |

This is the diagnosis confirmed from the outside. The data was always in the response; it only
surfaced when a human explicitly told the agent to go looking for it. Each run also invented its
own column name (`Owner Contact Person`, `Owner Contact Name`, none), which is the same defect
showing up as naming drift. Field name approved: `owner_contact_name`.

## Review

**Fixed.** The resolved human now has exactly one self-describing name in the payload, so it no
longer takes a prompt hint to extract.

Changes (all in PropTracerPRO; `suite-gateway` needed no change, it proxies `ptp_*` verbatim):

1. `lib/ai-research/contacts.ts` — new `resolveOwnerContact(row)` returning
   `{ owner_contact_name, owner_contact_source }`, the single source of truth for "who is the
   human behind this owner", same convention as `isEntityRecord`. Source is one of
   `fastappend` | `person_trace` | `ai_research` so the consumer can see provenance. A company
   name is never returned; an entity with no resolved human returns null.
2. `lib/suite/mcp-tools.ts` — `buildPerRecordResult` emits `owner_contact_name` +
   `owner_contact_source` at the TOP level, beside `input_owner_name` (the entity).
3. `app/api/v1/trace/bulk/status/route.ts` — identical change to the REST twin so the two
   surfaces cannot diverge.
4. `lib/suite/mcp-tools.ts` (`listTraces`) — previously returned the company name plus bare
   phone/email COUNTS and no contact at all. Now selects `trace_result` + `ai_research` solely to
   derive `owner_contact_name` (neither is echoed back).
5. `app/api/cron/sweep-bulk-research/route.ts` — the inline `resolvedPerson` precedence chain now
   calls the shared helper. Behavior-preserving: that row has not been traced yet, so
   `trace_result: null` reproduces the old chain exactly.
6. `app/api/[transport]/route.ts` — `skip_trace_bulk`, `bulk_status` and `list_traces`
   descriptions now state that the trace resolves a named human, that `owner_contact_name` and
   `input_owner_name` are different fields, and that the company must never be substituted.
7. `app/(dashboard)/settings/api-keys/docs/page.tsx` — documented both new fields.

Verification:

- `resolveOwnerContact` unit tests (7) written FIRST and watched fail (`is not a function`).
- MCP payload test and `list_traces` test each watched fail (`undefined`) before implementing.
- **Mutation test:** deleting the `owner_type === 'individual'` guard makes the payload return
  `Fountain Parc Apartments LLC` as a contact person and turns the guard test red. Restored, green.
- **Against real production data:** all 77 real MCP rows from the 2026-08-13 Dallas run replayed
  through the shipped helper. 56 of 77 resolve a human, 50 of those from entity inputs, including
  every name the delivered sheet lost: Daniel Hamann, Paul Osaji, Shetal Patel, Gazim Idoski,
  Joe Beard. Invariants hold: no resolved contact is a company name, and for an entity input the
  contact always differs from the input. No re-trace and no wallet spend (rows already settled).
- Full suite: 138 passed / 24 files. `tsc --noEmit` clean.

Not done, deliberately, and separate from this bug: the Atlanta sheet has 9 rows where the MPS
source column `owner_contact` is genuinely NULL, so `batch_lookup` correctly returned nothing and
no skip trace was ever run against them. That is an MPS coverage gap, not a payload defect.
