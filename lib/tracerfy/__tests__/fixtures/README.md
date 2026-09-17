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
