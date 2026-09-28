# Owner name order per county (D18 / D22), 2026-09-28

**SUPERSEDES the provenance plan I wrote earlier today, which was wrong.** It proposed a migration,
a per-record wire field on three surfaces and a cross-repo gateway dependency. All of that is
deleted. See L-040.

## The decisions this implements, which already existed

- **D17** (`specs/2026-09-21-tier1-planroute-design.md:57`) -- records come from the REGISTRY, never
  MPS. David: *"The multifamily records are coming from the registry NOT MPS."*
- **D18** (:58) -- name order is fixed using the order each county's own data shows. Names the
  defect: *"Today splitPersonName reads any two-word name as FIRST LAST
  (lib/routing/ownerRoute.ts:487-490)."*
- **D22** (:62) -- amends D18. *"Single traces (web and API) keep today's name handling; name order
  is fixed per county only on gateway records, where the county is known."* David: "1. C".
- **Measured 2026-09-21**: 52 of 55 counties store LAST FIRST. Only MN Ramsey, WI Milwaukee, WI Dane
  read FIRST LAST. Per-county table: `tasks/phase0-county-shortlist.md`.

## Tasks

- [x] 1. A per-county name-order map, seeded from the Phase 0 measurement, default LAST FIRST with
      the three measured FIRST LAST counties as the exceptions. Absent county = today's behaviour.
- [x] 2. `splitPersonName(name, order?)` takes the order; existing signals (explicit `LAST, FIRST`
      comma, shared surname, trailing initial) still win first, and the order decides only a name
      carrying NO signal -- which is exactly `GRAY WAYNE`.
- [x] 3. `personSteps` resolves the order from `parcel.county` + `parcel.state`.
- [x] 4. `contactParcelFor` forces natural order: the DOSSIER returns structured first/last, so a
      county rule must never touch it. Highest-risk line, own mutation.
- [x] 5. Mutation-test every guard; two of five came back GREEN last round (L-036).

## The boundary, answered

David, 2026-09-28: **"Wherever the county is known."** Implemented that way: `planRoute` resolves
the order from `parcel.state` + `parcel.county` on every surface, so any record carrying a county
gets it and a record without one is untouched.

## Review

`lib/routing/countyNameOrder.ts` holds **59 measured counties**: 55 from the Phase 0 A3 measurement
(2026-09-21) plus 4 measured against the registry today. 56 assessor, 3 natural (MN Ramsey, WI
Milwaukee, WI Dane). Every entry carries its provenance string.

**Measured today, not generalised** (individual-looking names, entity words excluded):

| county | LAST FIRST | FIRST LAST | verdict |
|---|---|---|---|
| NC Buncombe | 14,721 | 205 | assessor |
| TN Hickman | 3,918 | 117 | assessor (this is `GRAY WAYNE`'s county) |
| AR Greene | 2,234 | 68 | assessor |
| WV Monongalia | 9,488 | 109 | assessor |
| ND Ward | 259 | 221 | assessor, on **29,621 explicit `LAST, FIRST` comma forms**; the 3-token sample alone is genuinely ambiguous and would not have been enough |

The five Arm A counties return 0/0 because they hold no owner names at all, which is why they were
Arm A. Nothing to measure and nothing to fix there.

**An absent county means NOT MEASURED and keeps today's behaviour.** 59 of 1,854 is the honest
coverage number and it is pinned in a test. Defaulting the other 1,795 from a 59-county sample is
exactly the generalisation the no-generalized-data-claims rule forbids; extending the map is a
measurement job, not a code change.

**Gates, measured:** vitest **2248 passed / 89 files / 0 failed** (2240 before), tsc **exit 0**,
eslint **45 problems, back to the floor**, `next build` **exit 0**. eslint briefly hit 46 on an
unused import I added; used it to pin the coverage count rather than deleting it.

**MUTATION TESTING CAUGHT THE MOST IMPORTANT ONE AGAIN.** M8, deleting `ownerNameOrder: 'natural'`
from `contactParcelFor`, left the suite GREEN. My test had asserted the override MECHANISM inside
`ownerRoute`, not that `executeRoute` sets it -- L-036's "fence a behaviour in the file that owns
the code, not in the file that happens to call it", which I had just re-read and still got wrong.
Fixed by driving a real dossier through `executeRoute` in TN Hickman with `mailingAddress: null`,
so `contactParcelFor` takes the `return base` path with the county still set. M8 now goes RED.

Final mutation run: M6 county-order branch 2 failed, M7 planRoute stops consulting the county 1
failed, M8 the natural guard 1 failed, M9 flip MN Ramsey to assessor 1 failed.
