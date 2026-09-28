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

- [ ] 1. A per-county name-order map, seeded from the Phase 0 measurement, default LAST FIRST with
      the three measured FIRST LAST counties as the exceptions. Absent county = today's behaviour.
- [ ] 2. `splitPersonName(name, order?)` takes the order; existing signals (explicit `LAST, FIRST`
      comma, shared surname, trailing initial) still win first, and the order decides only a name
      carrying NO signal -- which is exactly `GRAY WAYNE`.
- [ ] 3. `personSteps` resolves the order from `parcel.county` + `parcel.state`.
- [ ] 4. `contactParcelFor` forces natural order: the DOSSIER returns structured first/last, so a
      county rule must never touch it. Highest-risk line, own mutation.
- [ ] 5. Mutation-test every guard; two of five came back GREEN last round (L-036).

## The one boundary to confirm with David before task 1

D22 says "gateway records". Today's coverage test went through the **v1 API** carrying apn +
county, which is the registry-fed shape but not literally the gateway. Does the county rule apply
wherever the county is known (my reading, since "where the county is known" is the mechanism), or
strictly to the MCP/gateway surface?

## Review

(to be filled in)
