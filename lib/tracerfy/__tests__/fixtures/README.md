# Dossier fixtures — SANITIZED DERIVATIVES of real vendor responses

Every file here is derived from a real `POST https://tracerfy.com/v1/api/property-search/lookup/`
response captured on 2026-09-16 during the 24-parcel owner-routing study (OH, CA, UT). The
originals live in `tasks/research-test/`, which is **gitignored** because it holds purchased
skip-trace PII for 63 real individuals. Nothing in that directory may be committed, and no test
may read from it: a test that did would pass on one laptop and fail on every other machine and in
CI.

So the structure here is genuine and the private values are not.

## What was KEPT verbatim

- **`response.property` — the whole object, all 86 keys, untouched.** This is public county
  record and it is the thing the fidelity fence test guards. Do not subset it, do not drop the
  propensity scores, do not drop the fields we block from display. The raw dump is the product.
- The response envelope: `hit`, `credits_deducted`, `skip_trace_hit`, `meta`.
- **Entity owner names.** `Cutting Edge Hodings Llc`, `Colmaven, Llc` — business names are public
  record, not PII, and the exact string shape is what `classifyOwnerName()` is tuned against.
- Mailing addresses on records where **every** owner is an entity.
- The `request` wrapper, which is the research harness's own record of what was sent. Handy for
  asserting the two key modes; it is not part of the vendor's response body.

## What was SCRUBBED

| Field | Replaced with | Why |
|---|---|---|
| `owners[].first_name` / `last_name` where `first_name` is non-empty | `Testowner` / `Placeholder` | A non-empty `first_name` is how the vendor signals a natural person. Living private individuals do not belong in a committed fixture. |
| `owners[].age` for those same owners | `"00"` | Age is a personal attribute. The placeholder keeps the field a non-empty string, which is the shape an individual returns. |
| `response.contacts` (entire object) | a synthetic block of identical shape: 2 phones, 1 email, the three booleans | This is the purchased skip-trace payload: phone numbers, carriers, DNC/TCPA flags, emails. All of it goes. |
| `mailing_address` on any record with an individual owner | `100 Placeholder Way, Redacted ZZ 00000` | On those records the mail-to is the person's home. |
| the family trust in `two-owner-hit.json` | `Placeholder Family Living Trust` | The one entity name that was NOT kept. A family trust carries the surname of the individual co-owner whose name was scrubbed two rows above it, so keeping it — or naming it here — would undo that scrub. |

The scrub was applied mechanically, not by eye, and verified by scanning every fixture for each of
the 333 distinct PII strings present in the source corpus. Zero hits.

## The files

| File | Derived from | Shape it exists to cover |
|---|---|---|
| `entity-hit-apn.json` | `dossier/raw-1.json` | Entity hit via APN mode. Stark County OH, an LLC, single owner. |
| `entity-hit-address.json` | `address-mode/raw-9.json` | Entity hit via ADDRESS mode, and the specific parcel APN mode **missed**. `Colmaven, Llc` — the whole entity name arrives in `last_name` with `first_name` empty. |
| `individual-hit.json` | `dossier/raw-10.json`, first owner only | Individual hit: both name fields populated. The source record is the only natural-person owner in the entire 24-parcel corpus. |
| `two-owner-hit.json` | `dossier/raw-10.json`, both owners | Two owners on one parcel, a person and their trust. Guards against a parser that reads `owners[0]` and stops. |
| `miss-apn.json` | `dossier/raw-9.json` | A miss. `hit:false`, `credits_deducted:0`, and **no `property`, `owners`, `contacts` or `skip_trace_hit` keys at all** — the vendor echoes the request keys instead. |
| `miss-address.json` | `address-mode/raw-5.json` | The same miss shape on the address key. |

## Regenerating

The generator is deliberately not committed: it names paths inside the gitignored directory. If
these ever need rebuilding, the rules are the table above, and the acceptance check is that no
string from `tasks/research-test/` `contacts` blocks or individual `owners` entries appears
anywhere in this directory.

---

# Contact-lookup fixtures — added 2026-09-17 (phase 3b)

Five more files, same rules, for the two SYNCHRONOUS contact endpoints Full Property Trace calls
after the dossier: `POST app.fastappend.com/v1/api/business-trace/lookup/` and
`POST tracerfy.com/v1/api/trace/lookup/`. Sources are `tasks/research-test/fastappend/` and
`tasks/research-test/tracerfy-individual/`, captured 2026-09-16, and gitignored for the same reason
as everything above: they hold purchased contact data on real people.

## What was KEPT verbatim

- **The response envelope.** `hit`, `credits_deducted`, `persons_count`, `error`, `meta`, and the
  request keys the vendor echoes back.
- **The exact key set of every nested object**, including the ones our parser ignores
  (`dnc`, `tcpa`, `state_dnc`, `contactable`, `carrier`, `last_seen`, `is_input`, `litigator`,
  `deceased`, `property_owner`, `is_active`, `is_foreign_owned`). A parser that only ever sees the
  keys it reads is not being tested against the payload it will actually receive.
- **`role` and `is_registered_agent` exactly as observed**, including the combined
  `"REGISTERED AGENT,MANAGER"` form, which is the whole reason `business-hit-agent-manager.json`
  exists.
- Entity names, which are public record.

## What was SCRUBBED

Every person's name, age, dob, phone number, carrier, email address and mailing address. Phone
numbers are `555000xxxx`, emails are `@example.invalid` (a reserved TLD that can never resolve),
mailing addresses are the same `100 Placeholder Way, Redacted ZZ 00000` shape used above, and
`request_id` is a counter rather than the real vendor id.

## The files

| File | Derived from | Shape it exists to cover |
|---|---|---|
| `business-hit.json` | `fastappend/raw-12.json` | Entity hit: a rank-1 `MEMBER` plus a pure `REGISTERED AGENT`. The agent must never be returned as the owner contact. |
| `business-hit-agent-manager.json` | `fastappend/raw-8.json` | The ONLY person returned is `"REGISTERED AGENT,MANAGER"` with the flag true. A rule that dropped everyone the flag marks would discard the contact on 1 of the 5 paid hits in the corpus. |
| `business-miss.json` | `fastappend/raw-4.json` | A miss — and it carries `error: "Company not found: ..."`. Reading `error` as a failure would turn every miss into an unbillable outage. |
| `person-hit.json` | `tracerfy-individual/raw-B.json`, second person synthesised | Person hit. Two persons at one address, and the one we asked for is NOT `persons[0]` and NOT the one flagged `property_owner` — that flag returned false for the verified owner of record on an absentee-owned parcel. |
| `person-miss.json` | `tracerfy-individual/raw-A.json` | `find_owner: true` missing on the same parcel the named lookup hit. `hit:false`, `persons: []`, `credits_deducted: 0`. |

`person-hit.json` is the one file carrying a synthesised SECOND record: the source response
returned a single person. The envelope, the key set and the field types are the vendor's; the
multi-person ordering is constructed, deliberately, to pin the name-match rule.

---

# Parcel person-lookup fixtures, added for Tier 1 Phase 1

Two files for `POST tracerfy.com/v1/api/trace/parcel/lookup/`, which had no fixture. They are
CONSTRUCTED, not derived from a saved response: the envelope keys are the ones Phase 0 recorded for
this endpoint (`parcel_id, county, state, hit, persons_count, credits_deducted, persons, meta`,
tasks/phase0-small-sample.md) and the person object is copied key for key from `person-hit.json`.
Every value is a placeholder. Nothing here came from tasks/research-test/.

| File | Shape it exists to cover |
|---|---|
| `apn-person-hit.json` | A parcel hit returning two people. The owner we ask for is NOT `persons[0]`, and here `property_owner` is on the owner, the reverse of `person-hit.json`, so only a parser that trusts neither the order nor the flag passes both. |
| `apn-miss.json` | An unknown parcel id: HTTP 200, `hit:false`, `credits_deducted:0`, `persons: []`, the shape Phase 0 measured (t1_nothing_found). |
