# Research scripts, 2026-09-16

Throwaway harnesses that produced the owner-routing findings. Kept because the previous
session's harness lived only in a session-scoped scratchpad and was lost, and regenerating
it cost real time. These encode verified endpoints, request shapes and rates.

Every script loads `/Users/davidmonroe/PropTracerPRO/.env.local` by absolute path and
scrubs the vendor keys it must not use before importing anything. None contains a secret.
All require an explicit `--live` flag to spend.

| Script | What it proved | Spend |
|---|---|---|
| `index-probe.ts` | County parcel records are NOT in Brave's index. A `site:` query against a county portal returns its landing, cart and terms pages and zero parcel records. | $0.025 |
| `classify-owner.ts` | Targeted Brave queries return 0 owners on 13 parcels. Includes the 3-rung query ladder and the state-correct office terms (OH = AUDITOR, UT = RECORDER, CA = ASSESSOR, AL = REVENUE COMMISSIONER). | $0.195 |
| `apn-lookup.ts` | `trace/parcel/lookup/` returns people, never an owner name. 11/13 billed, 0 flagged `property_owner`. | $1.10 |
| `dossier-lookup.ts` | `property-search/lookup/` APN mode returns the owner. 11/12. | $2.20 |
| `fastappend-run.ts` | Entity contacts with `role` and `is_registered_agent`. 5/10. Includes the controlled retries that killed the Delaware and typo hypotheses. | $0.50 |
| `tracerfy-individual.ts` | `find_owner:true` MISSES on an absentee owner; the named lookup HITS. | $0.10 |
| `ohio-test.ts` | Full dossier + FastAppend pipeline, 12 parcels, 4 Ohio counties. 12/12 owners, 8/12 entity hits. | $3.20 |
| `address-mode.ts` | The dossier answers from an ADDRESS with no parcel id. 5/6, and it found a parcel APN mode missed. | $1.00 |
| `run-research.ts` | The `researchProperty` harness. Built, dry-run verified, NEVER RUN live. | $0 |

To re-run any of them you need `tsx` and `dotenv`, which were installed in the scratchpad,
not the repo. `npx tsx <script> --dry-run` where supported; `--live` spends.

Raw outputs live in `tasks/research-test/`, which is gitignored because it holds purchased
skip-trace PII for 63 real individuals.
