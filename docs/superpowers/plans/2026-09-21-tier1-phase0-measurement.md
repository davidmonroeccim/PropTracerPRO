# Tier 1 through planRoute, Phase 0 (paid measurement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status, 2026-09-21 afternoon rewrite.** Tasks 1 and 2 are DONE and kept below as the record (Task 1 =
1cfb222 + dd88bf4; Task 2 = 931929b, review still pending). Tasks 3 to 7 were rewritten after David's
decisions D13 to D18 (spec Section 2) and his sampling rules. Nothing has been spent.

**Goal:** Measure, on live vendor calls, the facts the Tier 1 design rests on, so Phases 1 to 4 are
planned on evidence: whether the APN lookup finds individual owners (including parcels with no city, the
case this design exists for), what an unrecognized APN returns, name order per county, the trust ladder
under D16, the no-owner path through the dossier and a second lookup (D15, D17), and latency.

**Architecture:** Throwaway research scripts under `tasks/research-scripts/phase0/`, following the existing
research-script pattern (vendor host allowlist, `--live` gate, spend cap, raw output only under the
gitignored `tasks/research-test/`). A read-only Python selector draws candidate pools from the property
registry (never MPS, D17), a TypeScript builder classifies them with the production classifier and fixes
the sample, a runner makes the calls through the production vendor clients and records every raw request
and response, and an analyzer writes a PII-free report. No production code changes.

**Tech Stack:** Python 3 + psycopg2 (read-only registry access), TypeScript run with
`npx tsx --env-file=.env.local`, production modules imported from `lib/` (classifier, name splitter,
planRoute/executeRoute, dossier and contact clients).

**Spec:** `docs/superpowers/specs/2026-09-21-tier1-planroute-design.md` (Section 2 decisions D1 to D18,
Section 10 Phase 0, revised 2026-09-21 for D13 to D18; Sections 4 and 13 say what the measurement must
answer). Section 10 still says "estimated at most $15"; the 8-per-county option at GATE A is above that,
and the amount David names at GATE B governs.

## What changed from the first version of this plan

- Search types follow D13 to D16: a person with a city gets Tracerfy INSTANT (`trace/lookup/`,
  `find_owner:false` plus the name); every individual also gets the APN lookup (`trace/parcel/lookup/`);
  an entity goes to FastAppend only; a trust that strips to no first name or initial goes straight to
  FastAppend (D16).
- The individual sample no longer requires a city. It must include parcels with NO situs city where the
  county has them; the first version never tested the case this design exists for.
- The multifamily-from-MPS group is gone. Group G3 is registry parcels with no owner on record, across
  property types (D17), run through production planRoute + executeRoute, and its second lookup is judged
  by the name test from the raw response (D6, D15), because the production parser still falls back to
  `persons[0]` (lib/tracerfy/client.ts:602).
- Every county comes from the registry inventory, spread across property types, never re-using a county or
  parcel already tested, never IN or FL. David names the counties at GATE A.
- The runner records every vendor request and response on the call's line (`raw`), as spec Section 10
  requires.
- The hard-coded $15 ceiling is gone: the runner refuses `--live` above the amount David approves at
  GATE B.
- Every choice the brief left open is a numbered GATE A question for David, with no default: the no-city
  share, the street format, the G3 trust ladder, property types beyond the six, trusts without an APN,
  "ESTATE OF" names, the name-order add-on's cap, and whether the run stops after three failures in a row. The scripts implement every option and read David's
  answers from `gate-a.json`.

## Global Constraints

- **Spend: never above the amount David approves at GATE B.** `--plan` (the default) makes no network
  call. `--live` refuses to run without `--max-dollars=<n>`, without `gate-b.json`, or with `n` above
  `gate-b.json`'s `approved_dollars`, and stops before any call or record whose worst case could pass `n`.
- Vendor prices (verified 2026-09-16 against the ledgers, lib/routing/ownerRoute.ts:6-12): Tracerfy credit
  $0.02; `trace/lookup/` and `trace/parcel/lookup/` 5 credits ($0.10) per hit; `property-search/lookup/`
  (the dossier) 10 credits ($0.20) per hit; FastAppend `POST https://app.fastappend.com/v1/api/business-trace/lookup/`
  `{company_name, state}` 1 credit ($0.10) per hit. Misses are free on all four.
- The calls, per group (every listed call always runs, so both halves can be compared):

  | Group | Record | Calls | Worst case |
  |---|---|---|---|
  | G1 | Individual owner (classifyOwnerName), with a city | Instant with the name as splitPersonName splits it today; APN; plus, on at most as many records as David's add-on cap (GATE A question 4) where the county stores LAST FIRST and the name is two words, a second Instant with the order corrected | $0.20 (+$0.10) |
  | G1 | Individual owner, no city | APN | $0.10 |
  | G2 | Trust whose stripped name keeps a first name or initial | Instant (if it has a city and a street) and APN (if it has an APN; question 9) on the stripped name, then FastAppend on the full trust name | $0.30 |
  | G2 | Trust that strips to no first name or initial (D16; a suffix such as JR or ET AL is not a first name) | FastAppend on the full trust name only | $0.10 |
  | G3 | No owner on record (D17) | Production planRoute + executeRoute via parcelForFullTrace, pricePlan `pro`: dossier by APN first, then address, stop at the first hit; then the second lookup on the owner found (individual: Tracerfy; entity: FastAppend). Only if question 7 is (b): the D3/D16 ladder on a trust or unreadable owner | $0.30 ($0.50 with the ladder) |
  | G4 | Deliberately invalid APN, one per G1 state | APN | $0.10 |

  G3 runs today's production routing unchanged: its individual branch is an exclusive Instant-or-APN
  (ownerRoute.ts:396-434), and a trust or unclassifiable owner gets no second lookup (ownerRoute.ts:435-442,
  executeRoute.ts:506-511). Phase 0 measures that; it does not change it.
- Worst case with the GATE A proposal: 32 x $0.20 + 10 x $0.30 + 12 x $0.30 + 5 x $0.10 = **$13.50** at 4
  per county, about **$23.50** at 8, before GATE A questions 4, 5 and 7 (their effect is tabled at GATE A:
  up to $18.30 and $33.10 with every optional call on). The builder computes the worst case from the actual
  sample. Expected spend is lower: misses are free and no-city records get one call.
- Tracerfy counties are sent BARE ("Monroe", never "Monroe County"; "East Baton Rouge", never "... Parish").
- Databases: the property registry only, read-only (`set default_transaction_read_only = on`,
  `statement_timeout`), one county at a time, every query scoped on `county_fips`, **never a range scan or
  LIKE on `parcel_uid`** (collation returns another county's rows): fetch uids first, then rows by
  `parcel_uid = any(...)`. Check `pg_stat_activity` first and STOP if another non-idle session exists
  (the registry is a 4GB box). The check reads a count only; another session's SQL is never read or
  printed, since it can carry owner names or addresses. **MPS is not used at all** (D17).
- Counties: only from `/Users/davidmonroe/property-registry/docs/registry-inventory/county-searchable-coverage.csv`;
  secondary and tertiary only; never IN or FL; never a county already tested (AL Mobile; CA Contra Costa,
  Napa, Placer, Sacramento; OH Allen, Butler, Clark, Cuyahoga, Medina, Montgomery, Richland, Stark; UT
  Carbon, Davis, Iron, Salt Lake); never a parcel already in `tasks/research-test/`. Chosen to FIND
  DEFECTS, spread across property types (residential, commercial, industrial, multifamily, land,
  mixed_use, round-robin).
- Raw responses and anything carrying a name or address go only to `tasks/research-test/phase0/`
  (gitignored, `.gitignore:45`). Every call's line carries `raw`: host, path, request body, HTTP status and
  response body of every exchange it made. Headers are never recorded (they carry the API keys). The
  committed report carries counts only.
- The runner installs a fetch host allowlist (`tracerfy.com`, `app.fastappend.com`), refuses to run if
  `TRACERFY_API_URL` points anywhere but `tracerfy.com` (a sandbox returns fake data), and deletes
  `process.env.SUPABASE_SERVICE_ROLE_KEY` before any production module loads: every module that reaches
  `lib/` is imported dynamically after the scrub.
- No production code changes. Everything new lives in `tasks/research-scripts/phase0/`.
- Copy in the report and in History.md: no em dashes, no prices on free outcomes.
- Repo rules (CLAUDE.md): after EVERY task, a `History.md` entry at the top of the file (after the header
  rule, house style `## 2026-09-2X (letter): title` then bullets, no em dashes) in that task's own commit;
  at the end a review section in `tasks/todo.md`; never create fallback, fake or made-up data or results. A
  lookup that fails is recorded as failed, never filled in. Every commit ends with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- L-021: a defect found in this plan while executing it is a question for David, not a ruling. A choice
  that would change what is measured or spent is his.

## STOP gates, in this order. Each is a hard stop.

- **GATE A** (Task 3, before the selector runs): David answers eleven numbered questions (counties, records
  per county, the name-order add-on and its cap, the no-city share, the street format, the G3 trust ladder,
  property types, trusts without an APN, "ESTATE OF" names, and whether the live run stops after three
  failures in a row), each shown with its options, what each option measures, its worst-case cost effect,
  and no default. He also sees the FYI notes. **No selector run, no registry sampling and no spend until
  David has answered every GATE A question by name.** The selector, builder and runner each refuse to run unless `gate-a.json` holds an
  explicit answer to every question.
- **GATE B** (end of Task 5, `--plan` only): David sees calls by group and step, the worst case and the
  counties, and names the dollar amount. No `--live` before that.
- **GATE C** (end of Task 7): David gets the seven questions with the numbers. No Phase 1 plan until he has
  decided each.

---

### Task 1: Correct the spec's APN request wording and track the plan (DONE: 1cfb222 + dd88bf4)

The spec says the APN request "carries the owner's first and last name". Tracerfy's parcel endpoint takes only
`parcel_id`, `county`, `state` (docs/vendor/tracerfy-api.md:1352-1356). The names travel with the step for
PropTracerPRO's parser and are never sent.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-tier1-planroute-design.md` (Section 4.2, person step 2)
- Modify: `tasks/todo.md` (new section at the top)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing code-level.

- [x] **Step 1: Fix the spec sentence**

Replace:

```
   was no city or step 1 missed. The request carries the owner's first and last name as well, so the
   parser can match on them.
```

with:

```
   was no city or step 1 missed. The owner's first and last name travel with the step so
   PropTracerPRO's parser can match on them; they are not sent to Tracerfy, whose parcel endpoint
   takes only parcel_id, county and state (docs/vendor/tracerfy-api.md:1352-1356).
```

- [x] **Step 2: Add the tracking section at the top of `tasks/todo.md`**

Insert above the current first line:

```markdown
# Tier 1 through planRoute (2026-09-21)

Spec: `docs/superpowers/specs/2026-09-21-tier1-planroute-design.md` (approved by David section by section).
Plans are written one phase at a time, each after the previous phase's results.

- [ ] Phase 0: paid measurement. Plan: `docs/superpowers/plans/2026-09-21-tier1-phase0-measurement.md`
- [ ] Merge `feat/contact-vendor-provenance` (727bae2, d462ab6, 98424af) before Phase 1
- [ ] Phase 1: single traces (plan written after Phase 0)
- [ ] Phase 2: bulk queue (plan written after Phase 1)
- [ ] Phase 3: gateway owner rule and mapping (plan written after Phase 2)
- [ ] Phase 4: cleanup (plan written after Phase 3)

---

```

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-21-tier1-planroute-design.md tasks/todo.md docs/superpowers/plans/2026-09-21-tier1-phase0-measurement.md
git commit -m "docs: Phase 0 plan for Tier 1 routing; APN step names are not sent to Tracerfy"
```

---

### Task 2: Name-match prototype and spend guard (DONE: 931929b; review pending)

The only logic in Phase 0 worth unit tests: how a vendor person is judged to be the owner, how trust words
are stripped, and the spend guard. Pure functions, no I/O.

**Files:**
- Create: `tasks/research-scripts/phase0/match.ts`
- Create: `tasks/research-scripts/phase0/guard.ts`
- Test: `tasks/research-scripts/phase0/selftest.ts`

**Interfaces:**
- Consumes: `splitPersonName(name: string): { first_name: string; last_name: string }` from
  `lib/routing/ownerRoute.ts:465`.
- Produces:
  - `stripTrustWords(name: string): string` (uppercased, trust words and dates removed)
  - `type MatchKind = 'natural' | 'swapped' | 'surname_only' | null`
  - `personMatchesOwner(person: { first_name?: unknown; last_name?: unknown }, ownerName: string): MatchKind`
  - `affordable(spentDollars: number, nextWorstCase: number, capDollars: number): boolean`

- [x] **Step 1: Write the failing self-test**

`tasks/research-scripts/phase0/selftest.ts`:

```ts
// Run: npx tsx tasks/research-scripts/phase0/selftest.ts
import assert from 'node:assert/strict'
import { personMatchesOwner, stripTrustWords } from './match'
import { affordable } from './guard'

// Name order. splitPersonName reads "LAST FIRST MI" correctly only with a trailing initial.
assert.equal(personMatchesOwner({ first_name: 'John', last_name: 'Smith' }, 'John Smith'), 'natural')
assert.equal(personMatchesOwner({ first_name: 'Marcus', last_name: 'Halloway' }, 'Halloway Marcus T'), 'natural')
assert.equal(personMatchesOwner({ first_name: 'John', last_name: 'Smith' }, 'Smith John'), 'swapped')
assert.equal(personMatchesOwner({ first_name: 'Jingwen', last_name: 'Wu' }, 'Jingwen & Shaolan Wu'), 'natural')
assert.equal(personMatchesOwner({ first_name: 'John', last_name: 'Smith' }, 'John Smith Jr'), 'natural')
// Refusals: the persons[0] fallback is exactly what this prototype must NOT do.
assert.equal(personMatchesOwner({ first_name: 'Mary', last_name: 'Jones' }, 'John Smith'), null)
assert.equal(personMatchesOwner({ first_name: 'Mary', last_name: 'Smith' }, 'John Smith'), null)
assert.equal(personMatchesOwner({ first_name: 'John', last_name: '' }, 'John Smith'), null)
// Trusts.
assert.equal(stripTrustWords('John Smith Revocable Trust U/A Dated Jan 5 2001'), 'JOHN SMITH')
assert.equal(stripTrustWords('The Halloway Living Trust'), 'HALLOWAY')
assert.equal(stripTrustWords('Smith Family Trust'), 'SMITH')
assert.equal(stripTrustWords('Martin Family Trust'), 'MARTIN')
assert.equal(stripTrustWords('Robert May Revocable Trust'), 'ROBERT MAY')
assert.equal(stripTrustWords('Decker Living Trust Dtd May 5 2001'), 'DECKER')
assert.equal(personMatchesOwner({ first_name: 'Ann', last_name: 'Smith' }, stripTrustWords('Smith Family Trust')), 'surname_only')
// Spend guard: the cap is inclusive and never exceeded.
assert.equal(affordable(14.8, 0.2, 15), true)
assert.equal(affordable(14.9, 0.2, 15), false)
assert.equal(affordable(0, 0.3, 0.2), false)
console.log('phase0 selftest OK')
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx tsx tasks/research-scripts/phase0/selftest.ts`
Expected: FAIL, cannot find module `./match`.

- [x] **Step 3: Implement `match.ts`**

```ts
/**
 * Phase 0 prototype of the Tier 1 name match (spec 4.3). Throwaway: Phase 1 ports the rule into
 * lib/tracerfy/client.ts with its own tests. Pure, no I/O.
 */
import { splitPersonName } from '../../../lib/routing/ownerRoute'

const TRUST_WORDS = new Set([
  'TRUST', 'TRUSTS', 'REVOCABLE', 'IRREVOCABLE', 'LIVING', 'FAMILY', 'TRUSTEE', 'TRUSTEES',
  'TTEE', 'TTEES', 'TR', 'TRS', 'UA', 'UAD', 'DTD', 'DATED', 'THE', 'OF', 'AGREEMENT',
])
// A month only when a date number follows it. A bare prefix match would eat surnames:
// MARTIN, MAYFIELD, DECKER, and a whole-word match would eat the surname MAY.
const MONTHS = /\b(JAN(UARY)?|FEB(RUARY)?|MAR(CH)?|APR(IL)?|MAY|JUNE?|JULY?|AUG(UST)?|SEPT?(EMBER)?|OCT(OBER)?|NOV(EMBER)?|DEC(EMBER)?)\.?\s+(?=\d)/g

/** "John Smith Revocable Trust" -> "JOHN SMITH"; "Smith Family Trust" -> "SMITH". */
export function stripTrustWords(name: string): string {
  return name
    .toUpperCase()
    .replace(/U\s*\/\s*A/g, ' ')
    .replace(MONTHS, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^A-Z&\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !TRUST_WORDS.has(t))
    .join(' ')
    .trim()
}

const norm = (v: unknown): string =>
  (typeof v === 'string' ? v : '').toUpperCase().replace(/[^A-Z]/g, '')

export type MatchKind = 'natural' | 'swapped' | 'surname_only' | null

/**
 * Is this vendor person the owner? Same rule the production parser uses today (last name exact,
 * first initial) plus two things Phase 0 must measure: the SWAPPED order (assessor "LAST FIRST"
 * with no middle initial, which splitPersonName reads backwards) and SURNAME ONLY (a trust that
 * strips to one token). Never falls back to persons[0].
 */
export function personMatchesOwner(
  person: { first_name?: unknown; last_name?: unknown },
  ownerName: string,
): MatchKind {
  const pFirst = norm(person.first_name)
  const pLast = norm(person.last_name)
  if (!pLast) return null
  const { first_name, last_name } = splitPersonName(ownerName)
  const oFirst = norm(first_name)
  const oLast = norm(last_name)
  if (!oLast) return oFirst && pLast === oFirst ? 'surname_only' : null
  if (pLast === oLast && (!oFirst || pFirst.startsWith(oFirst.charAt(0)))) return 'natural'
  if (pLast === oFirst && pFirst.startsWith(oLast.charAt(0))) return 'swapped'
  return null
}
```

- [x] **Step 4: Implement `guard.ts`**

```ts
/** The Phase 0 spend guard. A call runs only if its WORST-CASE cost still fits under the cap. */
export function affordable(spentDollars: number, nextWorstCase: number, capDollars: number): boolean {
  return spentDollars + nextWorstCase <= capDollars + 1e-9
}
```

- [x] **Step 5: Run the self-test to verify it passes**

Run: `npx tsx tasks/research-scripts/phase0/selftest.ts`
Expected: `phase0 selftest OK`

- [x] **Step 6: Prove the refusal assertion is load-bearing**

Temporarily change the last line of `personMatchesOwner` from `return null` to `return 'natural'`, run the
self-test, confirm it FAILS on the `Mary Jones` assertion, then restore the line and confirm it passes again.

- [x] **Step 7: Commit**

```bash
git add tasks/research-scripts/phase0/match.ts tasks/research-scripts/phase0/guard.ts tasks/research-scripts/phase0/selftest.ts
git commit -m "research(phase0): name-match prototype and spend guard with self-test"
```

---

### Task 3: Read-only sample selector (GATE A first)

**Files:**
- Create: `tasks/research-scripts/phase0/select_samples.py`
- Create by hand at GATE A (gitignored): `tasks/research-test/phase0/gate-a.json`
- Output (gitignored): `tasks/research-test/phase0/county-counts.json`, `tasks/research-test/phase0/candidates.json`

**Interfaces:**
- Consumes: `env()` in `/Users/davidmonroe/property-registry/worker/scripts/audit_city_key_is_postal.py:830`
  (reads that repo's `.env.local`: `PROJECT_REF`, `SUPABASE_DB_PASSWORD`); the registry inventory CSV
  (columns `state`, `county_fips`, `county_name`, `parcels`); registry partitions `public.parcels_<st>`
  (columns `parcel_uid`, `county_fips`, `owner_name`, `site_address`, `situs_city`, `situs_zip`,
  `parcel_id_local`, `property_type`); David's `gate-a.json` (every GATE A answer; it refuses a file with any
  missing).
- Produces:
  - `county-counts.json`: `[{ group, state, fips, county, inventory_parcels, totals, by_type }]`, counts only.
  - `candidates.json`: `{ g1: Cand[], g2: Cand[], g3: Cand[] }` where each row is
    `{ parcel_uid, owner_name, site_address, situs_city, situs_zip, parcel_id_local, property_type, state, fips, county }`
    (the `Cand` type in Task 4). `g1`: owner, APN and numeric address present, not trust-marked. `g2`:
    trust-marked (mirrors `TRUST_MARKER`, ownerRoute.ts:158), with an APN and a numeric address unless
    question 9 is (b). `g3`: no owner, and an APN or a numeric address with a city. Pools cover the six types,
    or every type if question 8 is (b).

- [ ] **Step 1: Write the selector**

`tasks/research-scripts/phase0/select_samples.py`:

```python
#!/usr/bin/env python3
"""Phase 0 sample selector. READ-ONLY against the property registry. MPS is not used (spec D17).

Refuses to run until tasks/research-test/phase0/gate-a.json holds an explicit answer from David to EVERY
GATE A question (there are no defaults), and refuses any county that is not in the registry inventory, is
in IN or FL, or was already tested.

Then, before touching a county, it counts other non-idle sessions in pg_stat_activity and STOPS if
there is any (the registry is a 4GB box: one workstream at a time). It prints the count only, never
another session's SQL. Per county, one at a time:
  1. ONE scan of the county returning flags only, no names or addresses: the FULL count of city,
     ZIP, owner, APN and numeric-address fill per property type (the shortlist's figures were a
     storage-order sample and are not reliable);
  2. seeded random pools per property type (the six, or every type if GATE A question 8 is (b)), and
     for G1 per city / no-city; G2 trusts need an APN and a numeric address unless question 9 is (b);
  3. the pooled rows fetched by parcel_uid = any(...), scoped on county_fips. Never a range scan
     or LIKE on parcel_uid (collation returns another county's rows).
Writes county-counts.json (counts only) and candidates.json (names and addresses, gitignored).

Run: python3 tasks/research-scripts/phase0/select_samples.py
"""
import csv, json, os, random, re, sys, time
import psycopg2, psycopg2.extras

sys.path.insert(0, '/Users/davidmonroe/property-registry/worker/scripts')
import audit_city_key_is_postal as A  # env() only

OUT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0'
INVENTORY = '/Users/davidmonroe/property-registry/docs/registry-inventory/county-searchable-coverage.csv'
TYPES = ['residential', 'commercial', 'industrial', 'multifamily', 'land', 'mixed_use']
STREET_FORMATS = ('first_comma', 'whole', 'strip_city')
EXCLUDED_STATES = {'IN', 'FL'}
# Every county with a parcel in tasks/research-test/ (L-023: a parcel that already passed is spent evidence).
TESTED = {('AL', 'MOBILE'), ('CA', 'CONTRA COSTA'), ('CA', 'NAPA'), ('CA', 'PLACER'), ('CA', 'SACRAMENTO'),
          ('OH', 'ALLEN'), ('OH', 'BUTLER'), ('OH', 'CLARK'), ('OH', 'CUYAHOGA'), ('OH', 'MEDINA'),
          ('OH', 'MONTGOMERY'), ('OH', 'RICHLAND'), ('OH', 'STARK'),
          ('UT', 'CARBON'), ('UT', 'DAVIS'), ('UT', 'IRON'), ('UT', 'SALT LAKE')}
POOL = 20        # random candidates per stratum: G1 (property type, city or not), G3 (property type)
TRUST_POOL = 10  # G1 counties: random trust-marked candidates per property type (feeds G2)
NUMERIC_RE = r'^\s*[0-9]'
# Mirrors TRUST_MARKER in lib/routing/ownerRoute.ts:158 (LIVING TRUST and FAMILY TRUST contain TRUST).
# A pre-filter only: build-sample.ts decides with the production classifyOwnerName.
TRUST_RE = r'\m(TRUST|TTEE|TRUSTEE|TRS|ESTATE OF)\M'

FLAGS_SQL = """
select parcel_uid,
       coalesce(property_type, '(null)'),
       nullif(btrim(situs_city), '') is not null,
       nullif(btrim(situs_zip), '') is not null,
       nullif(btrim(owner_name), '') is not null,
       nullif(btrim(parcel_id_local), '') is not null,
       coalesce(site_address ~ %s, false),
       coalesce(owner_name ~* %s, false)
  from public.{part}
 where county_fips = %s
"""
ROWS_SQL = """
select parcel_uid, owner_name, site_address, situs_city, situs_zip, parcel_id_local,
       coalesce(property_type, '(null)') as property_type
  from public.{part}
 where county_fips = %s and parcel_uid = any(%s)
"""
# A COUNT only: other sessions' SQL can carry owner names or addresses, so it is never read or printed.
BUSY_SQL = """
select count(*)
  from pg_stat_activity
 where state <> 'idle' and pid <> pg_backend_pid() and datname = 'postgres'
"""


def die(code, msg):
    print(msg, flush=True)
    sys.exit(code)


def load_gate():
    path = f'{OUT}/gate-a.json'
    if not os.path.exists(path):
        die(2, f'REFUSING: {path} does not exist. GATE A: David names the counties first; there is no default.')
    g = json.load(open(path))
    if g.get('records_per_county') not in (4, 8):
        die(2, 'REFUSING: gate-a.json records_per_county must be 4 or 8')
    if not g.get('g1_counties') or not g.get('g3_counties'):
        die(2, 'REFUSING: gate-a.json needs g1_counties and g3_counties (questions 1 and 2)')
    if any(c.get('name_order') not in ('LAST FIRST', 'FIRST LAST', 'unclear') for c in g['g1_counties']):
        die(2, 'REFUSING: every G1 county needs name_order from tasks/phase0-county-shortlist.md')
    cap = g.get('name_order_addon_cap')
    if cap != 'all' and not (type(cap) is int and cap >= 0):
        die(2, 'REFUSING: gate-a.json name_order_addon_cap must be 0, a whole number, or "all" (question 4)')
    n = g.get('g1_no_city_per_county')
    # The brief requires no-city parcels wherever a county has them, so 0 is not an answer.
    if type(n) is not int or not 1 <= n <= g['records_per_county']:
        die(2, 'REFUSING: gate-a.json g1_no_city_per_county must be a whole number from 1 to records_per_county (question 5)')
    if g.get('street_format') not in STREET_FORMATS:
        die(2, 'REFUSING: gate-a.json street_format must be first_comma, whole or strip_city (question 6)')
    for k, q in (('g3_trust_ladder', 7), ('extra_property_types', 8), ('g2_trusts_without_apn', 9), ('stop_after_three_failures', 11)):
        if type(g.get(k)) is not bool:
            die(2, f'REFUSING: gate-a.json {k} must be true or false (question {q})')
    if g.get('g2_estate_of') not in ('include', 'exclude'):
        die(2, 'REFUSING: gate-a.json g2_estate_of must be include or exclude (question 10)')
    if not all(str(g.get(k) or '').strip() for k in ('answered_by', 'answered_at', 'david_words')):
        die(2, 'REFUSING: gate-a.json needs answered_by, answered_at and david_words')
    return g


def inventory():
    with open(INVENTORY, newline='') as f:
        return {(r['state'], r['county_fips']): r for r in csv.DictReader(f)}


def bare(name):
    return re.sub(r'\s+(County|Parish|Borough|Municipality)$', '', name.strip(), flags=re.I)


def check_county(c, inv):
    st, fips, county = c['state'], c['fips'], c['county']
    row = inv.get((st, fips))
    if row is None:
        die(2, f'REFUSING: {st} {fips} is not in the registry inventory ({INVENTORY})')
    if bare(row['county_name']).upper() != county.strip().upper():
        die(2, f'REFUSING: {st} {fips} is "{row["county_name"]}" in the inventory; gate-a.json must name it '
               f'"{bare(row["county_name"])}" (bare, as Tracerfy wants it), not "{county}"')
    if st in EXCLUDED_STATES:
        die(2, f'REFUSING: {st} is excluded from Phase 0 (David, 2026-09-21)')
    if (st, county.strip().upper()) in TESTED:
        die(2, f'REFUSING: {st} {county} was already tested (tasks/research-test/)')
    return int(row['parcels'])


def registry():
    e = A.env()
    c = psycopg2.connect(host=f"db.{e['PROJECT_REF']}.supabase.co", port=5432, dbname='postgres',
                         user='postgres', password=e['SUPABASE_DB_PASSWORD'], connect_timeout=60,
                         sslmode='require')
    c.set_session(readonly=True, autocommit=True)
    cur = c.cursor()
    cur.execute("set default_transaction_read_only = on")
    cur.execute("set statement_timeout = '300s'")
    return c


def stop_if_busy(cur, where):
    cur.execute(BUSY_SQL)
    busy = cur.fetchone()[0]
    if busy:
        die(3, f'STOP ({where}): {busy} other non-idle session(s) on the registry. Ask David; do not wait them out.')


def pct(n, d):
    return f'{100.0 * n / d:.1f}%' if d else 'n/a'


def main():
    gate = load_gate()
    inv = inventory()
    jobs = [('G1', c) for c in gate['g1_counties']] + [('G3', c) for c in gate['g3_counties']]
    expected = {(g, c['fips']): check_county(c, inv) for g, c in jobs}
    os.makedirs(OUT, exist_ok=True)
    conn = registry()
    cur = conn.cursor()
    counts_out, cands = [], {'g1': [], 'g2': [], 'g3': []}
    for grp, c in jobs:
        st, fips, county = c['state'], c['fips'], c['county']
        part = f'parcels_{st.lower()}'
        stop_if_busy(cur, f'before {st} {county}')

        # 1. One scan, flags only: the full count and the strata.
        cur.execute(FLAGS_SQL.format(part=part), (NUMERIC_RE, TRUST_RE, fips))
        flags = cur.fetchall()
        if not flags:
            die(4, f'STOP: {st} {fips} {county} returned 0 parcels; the inventory says {expected[(grp, fips)]}. Ask David.')
        by_type, strata, trust_strata = {}, {}, {}
        for uid, ptype, has_city, has_zip, has_owner, has_apn, numeric, trust in flags:
            t = by_type.setdefault(ptype, dict(parcels=0, no_city=0, no_zip=0, no_owner=0, with_apn=0, numeric_address=0,
                                              g1_eligible_city=0, g1_eligible_no_city=0, trust_marked=0,
                                              trust_marked_eligible=0, g3_eligible=0))
            t['parcels'] += 1
            t['no_city'] += not has_city
            t['no_zip'] += not has_zip
            t['no_owner'] += not has_owner
            t['with_apn'] += has_apn
            t['numeric_address'] += numeric
            g1_ok = has_owner and has_apn and numeric
            g2_ok = has_owner and trust and (g1_ok or gate['g2_trusts_without_apn'])
            g3_ok = (not has_owner) and (has_apn or (numeric and has_city))
            if g1_ok:
                t['g1_eligible_city' if has_city else 'g1_eligible_no_city'] += 1
                t['trust_marked_eligible'] += trust
            t['trust_marked'] += has_owner and trust
            t['g3_eligible'] += g3_ok
            if ptype not in TYPES and not gate['extra_property_types']:
                continue
            if grp == 'G1' and g2_ok:
                trust_strata.setdefault(ptype, []).append(uid)
            elif grp == 'G1' and g1_ok:
                strata.setdefault((ptype, has_city), []).append(uid)
            if grp == 'G3' and g3_ok:
                # By type only: city and no-city parcels in their natural proportion.
                strata.setdefault((ptype, 'any'), []).append(uid)
        total = {k: sum(t[k] for t in by_type.values()) for k in next(iter(by_type.values()))}
        counts_out.append(dict(group=grp, state=st, fips=fips, county=county,
                               inventory_parcels=expected[(grp, fips)], totals=total, by_type=by_type))

        # 2. Seeded random pools. The seed names the stratum, so a re-run picks the same parcels.
        g1_pick, g2_pick = [], []
        for key in sorted(strata):
            uids = strata[key]
            g1_pick += random.Random(f'phase0-{grp}-{fips}-{key[0]}-{key[1]}').sample(uids, min(POOL, len(uids)))
        for ptype in sorted(trust_strata):
            uids = trust_strata[ptype]
            g2_pick += random.Random(f'phase0-G2-{fips}-{ptype}').sample(uids, min(TRUST_POOL, len(uids)))

        # 3. Rows for the pooled uids only.
        rows = []
        if g1_pick or g2_pick:
            rc = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            rc.execute(ROWS_SQL.format(part=part), (fips, g1_pick + g2_pick))
            rows = [dict(r) for r in rc.fetchall()]
        in_g2 = set(g2_pick)
        for r in rows:
            r.update(state=st, fips=fips, county=county)
            if grp == 'G3':
                cands['g3'].append(r)
            else:
                cands['g2' if r['parcel_uid'] in in_g2 else 'g1'].append(r)

        n = total['parcels']
        print(f"{grp} {st} {fips} {county}: parcels {n:,} (inventory {expected[(grp, fips)]:,}); "
              f"no city {total['no_city']:,} ({pct(total['no_city'], n)}); no ZIP {pct(total['no_zip'], n)}; "
              f"no owner {total['no_owner']:,} ({pct(total['no_owner'], n)}); APN {pct(total['with_apn'], n)}; "
              f"numeric address {pct(total['numeric_address'], n)}", flush=True)
        print(f"   eligible G1 with city {total['g1_eligible_city']:,}, G1 no city {total['g1_eligible_no_city']:,}, "
              f"trust-marked {total['trust_marked']:,} ({total['trust_marked_eligible']:,} with APN and address), "
              f"G3 (no owner) {total['g3_eligible']:,}; "
              f"pooled {len(rows)}", flush=True)
        print('   by type: ' + ' | '.join(f"{p} {t['parcels']:,} (no city {pct(t['no_city'], t['parcels'])}, "
                                          f"no owner {pct(t['no_owner'], t['parcels'])})"
                                          for p, t in sorted(by_type.items())), flush=True)
        time.sleep(2)

    json.dump(counts_out, open(f'{OUT}/county-counts.json', 'w'), indent=1)
    json.dump(cands, open(f'{OUT}/candidates.json', 'w'), indent=1, default=str)
    print(f"candidates: g1 {len(cands['g1'])}, g2 {len(cands['g2'])}, g3 {len(cands['g3'])}")


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Check it parses, without running it**

Run: `python3 -c "import ast; ast.parse(open('tasks/research-scripts/phase0/select_samples.py').read()); print('parses')"`
Expected: `parses`. Nothing connects to the registry in this step.

- [ ] **Step 3: GATE A. STOP. David answers every question below, by name**

**Nothing happens until David has answered every GATE A question below by name: the selector does not run,
the registry is not sampled, and nothing is spent.** No question has a default, and nobody answers one for
him. The scripts enforce it: the selector, the builder and the runner each refuse to run unless
`gate-a.json` carries an explicit answer to every question.

**Questions for David**

1. **G1 counties** (individual owners; the same counties feed the G2 trusts and the G4 probes).
   - Options: the proposal below, or any other counties from the registry inventory that are not IN or FL,
     not already tested, and secondary or tertiary.
   - Proposal, from `tasks/phase0-county-shortlist.md`, with FIPS and names checked in the inventory and the
     name order from the shortlist: NY Monroe (36055, LAST FIRST), NY Broome (36007, LAST FIRST), LA East Baton
     Rouge Parish (22033, LAST FIRST), LA Jefferson Parish (22051, LAST FIRST, mostly the comma form "SMITH,
     JOHN"), OH Summit (39153, LAST FIRST), OH Muskingum (39119, LAST FIRST), WI Milwaukee (55079, FIRST LAST),
     MN Ramsey (27123, FIRST LAST).
   - What it measures: Instant against APN, and name order, in each county picked.
   - Worst-case cost effect: each G1 county adds records-per-county x $0.20 ($0.10 for a record with no city),
     plus one $0.10 probe for each new state.
   - No default.
2. **G3 counties** (no owner on record, D17).
   - Options: the proposal, or any other inventory counties under the same rules.
   - Proposal: UT Washington (49053), TX Hidalgo (48215), AL Jefferson (01073).
   - What it measures: the dossier path and the second lookup, by property type.
   - Worst-case cost effect: each G3 county adds records-per-county x $0.30 ($0.50 if question 7 is (b)).
   - No default.
3. **Records per county, for G1 and G3.**
   - (a) 4. What it measures: 32 G1 and 12 G3 records with the proposal. Worst case $13.50, before
     questions 4, 5 and 7.
   - (b) 8. What it measures: twice the evidence per county. Worst case about $23.50, before questions 4, 5
     and 7. That is above the spec's Section 10 estimate of $15.
   - No default.
4. **The name-order add-on.** One extra Instant call, with the two words swapped, for a G1 record that has a
   city, is in a county that stores LAST FIRST, and has a name of exactly two words. $0.10 per call at worst.
   David was told "+$0.80 for 8 records".
   - (0) No add-on. What it measures: name order only from what Instant and APN return for the name as it is
     sent today. Cost $0.
   - (a) Capped at 8 records, $0.80. This is what David was told. What it measures: the corrected order on up
     to 8 records, spread one per LAST FIRST county per round. Cost: up to +$0.80.
   - (b) Every qualifying record. What it measures: the corrected order on every such record. Cost: up to
     +$2.40 at 4 per county, so the worst case becomes $15.90, over the spec's $15. At 8 per county, up to
     +$4.80.
   - Recorded as `name_order_addon_cap`: `0`, `8` or `"all"`. The builder never marks more records than the
     cap, and the runner refuses a sample that does.
   - No default.
5. **How many of each G1 county's records must be parcels with NO city** (APN only), where the county has
   them. The brief requires such parcels but names no share; this question was raised by the re-plan.
   - Options: a whole number from **1** to the records per county. 0 is not offered: the brief makes
     no-city parcels a MUST, because this redesign exists for records with no city, and the first version of
     this plan never tested one. A county with fewer no-city individuals than asked gives what it has, and
     the rest are filled with records that have a city.
   - What it measures: a higher share gives more evidence on the APN-only path this design exists for, and
     less on Instant against APN on the same record.
   - Worst-case cost effect: a no-city record costs at most $0.10 instead of $0.20, and it cannot take the
     add-on. Half (2 of 4) lowers the proposal's worst case by $1.60; half at 8 per county lowers it by $3.20.
   - No default.
6. **The street sent to Instant and to the dossier.**
   - (a) `first_comma`: `site_address` up to its first comma, as the first version of this plan did. What it
     measures: the lookups on a street whose city may still be attached when the county stores none after a
     comma.
   - (b) `whole`: `site_address` exactly as stored, which is what the gateway sends today
     (suite-gateway lib/registry-parcel-adapter.ts:703). What it measures: production's real input, including
     any city, state or ZIP inside the street. The registry's own audit script handles NY addresses shaped
     like "55 Electric Ave Rochester NY 14613".
   - (c) `strip_city`: first comma, then a trailing situs city removed when nothing but the state and a ZIP
     follows it. What it measures: the lookups on a clean street.
   - Worst-case cost effect: none, since the calls are the same, but the answer can move hits between Instant
     and APN. The builder reports, per county, how many streets still contain the city.
   - No default.
7. **G3 owners that the dossier returns as a trust or an unreadable name.** Production gives them no second
   lookup and sends them to manual review (ownerRoute.ts:435-442, executeRoute.ts:506-511).
   - (a) Production only. What it measures: today's behaviour. These owners get no contacts and are counted
     as manual review. Cost: G3 stays at $0.30 a record.
   - (b) Also run the D3/D16 ladder on them. That means Instant (if there is a city) and APN on the stripped
     name, then FastAppend on the full name; or FastAppend only when no first name or initial is left; and an
     unreadable name is used as given (spec 4.2). What it measures: whether Phase 1's ladder finds contacts
     for trusts the dossier finds. Cost: G3 goes to $0.50 a record ($0.20 dossier plus three $0.10 calls),
     which is up to +$2.40 at 4 per county and +$4.80 at 8.
   - No default.
8. **Property types beyond the six.**
   - (a) Only the six: residential, commercial, industrial, multifamily, land, mixed_use. What it measures:
     those types only. Agricultural, exempt, utility, special_purpose, blank or any other type is counted in
     the full counts but never sampled.
   - (b) Every type the county has, with the six first in the rotation and the rest after them. What it
     measures: defects on the other types too, with fewer records on the six.
   - Worst-case cost effect: none, because the records per county are fixed.
   - No default.
9. **Trusts without an APN (G2).**
   - (a) Only trusts whose parcel has an APN and a numeric address, the same rule as G1. What it measures:
     the full person half (Instant and APN) on every trust.
   - (b) Any trust-owned parcel, with or without an APN, in its natural proportion. What it measures: trusts
     the APN step cannot reach too. Those get Instant if they have a city and a street, then FastAppend.
   - Worst-case cost effect: still at most $0.30 a trust; a trust without an APN costs at most $0.20.
   - No default.
10. **"ESTATE OF" names in G2.** classifyOwnerName calls them trusts, but the Task 2 `stripTrustWords` leaves
    "ESTATE" in, so "ESTATE OF JOHN SMITH" goes to Instant with first name "ESTATE" and the name test cannot
    match. match.ts is not changed in Phase 0.
    - (a) Include them. What it measures: how estates fare under today's rules, this defect included. Cost:
      within the $0.30 per trust, but up to $0.20 per estate goes on person calls that cannot name-match.
    - (b) Exclude them from G2. What it measures: trusts only, with no data on estates. Cost: no change to the
      per-trust ceiling.
    - No default.
11. **Three vendor or transport failures in a row during the live run** (429, 401, 402, 403, a 5xx, or no
    answer at all).
    - (a) Stop the run and record the stop point: the runner prints the `calls.jsonl` line where it stopped,
      and the operator records it for David. What it measures: everything up to the outage, and nothing
      after it. The runner refuses to re-run while `calls.jsonl` exists (a re-run would re-buy every call),
      so the records after the stop point stay unmeasured unless David decides otherwise.
    - (b) Continue through the failures. What it measures: every record is attempted, and a record whose
      lookup failed is recorded as failed, never filled in. During a long outage that can be many failed
      records.
    - Worst-case cost effect: none. Failures are free, and the cap still stops the run before any record
      that could pass the approved amount; (a) can only spend less.
    - Recorded as `stop_after_three_failures`: `true` for (a), `false` for (b).
    - No default.

**Worst case with the proposal, by answer** (the builder prices the real sample; GATE B still governs the
spend):

| | 4 per county | 8 per county |
|---|---|---|
| Questions 1 to 3 only | $13.50 | $23.50 |
| Question 4 (a), cap 8 | +$0.80 | +$0.80 |
| Question 4 (b), every qualifying record | up to +$2.40 | up to +$4.80 |
| Question 7 (b), the ladder | up to +$2.40 | up to +$4.80 |
| 4 (b) and 7 (b) together | $18.30 | $33.10 |
| Question 5 at half | -$1.60, and halves the 4 (b) ceiling | -$3.20, and halves the 4 (b) ceiling |

**For David's information, not questions**
- G3's second lookup for an individual runs production as it is: an exclusive Instant-or-APN
  (ownerRoute.ts:396-434), not D2's "Instant, then APN on a miss". The plan measures production as it is.
- A blank `owner_name` counts as no owner, as it does in planRoute (ownerRoute.ts:320). The brief said NULL.
- The shortlist's no-owner figures for the proposed G3 counties (100%, 48%, 30%) come from a storage-order
  sample. The inventory reports owner fill of 0% (UT Washington), 99.35% (TX Hidalgo) and 99.34% (AL
  Jefferson). Step 5's full count settles it, and a county that cannot fill its quota is a STOP.

- [ ] **Step 4: Record David's answers**

Write `tasks/research-test/phase0/gate-a.json` from his answers, and only from his answers: one field per
question, each written from what he said. Copy every county entry from the inventory row (state, 5-digit FIPS,
bare name) and, for G1, take `name_order` from the shortlist. By design, the template below does not parse
until every `<...>` is replaced, and the scripts refuse a file with any field missing:

```json
{
  "g1_counties": [
    { "state": "<ST>", "fips": "<5-digit FIPS>", "county": "<bare name>", "name_order": "<LAST FIRST | FIRST LAST | unclear>" }
  ],
  "g3_counties": [
    { "state": "<ST>", "fips": "<5-digit FIPS>", "county": "<bare name>" }
  ],
  "records_per_county": <question 3: 4 or 8>,
  "name_order_addon_cap": <question 4: 0, 8 or "all">,
  "g1_no_city_per_county": <question 5: whole number, 1 to records_per_county>,
  "street_format": "<question 6: first_comma | whole | strip_city>",
  "g3_trust_ladder": <question 7: false for (a), true for (b)>,
  "extra_property_types": <question 8: false for (a), true for (b)>,
  "g2_trusts_without_apn": <question 9: false for (a), true for (b)>,
  "g2_estate_of": "<question 10: include | exclude>",
  "stop_after_three_failures": <question 11: true for (a), false for (b)>,
  "answered_by": "David",
  "answered_at": "<YYYY-MM-DD>",
  "david_words": "<his answers, verbatim>"
}
```

- [ ] **Step 5: Run the selector (read-only)**

Run: `python3 tasks/research-scripts/phase0/select_samples.py`
Expected: per county, one line of full counts (parcels, no city, no ZIP, no owner, APN, numeric address),
one line of eligible and pooled counts, one line by property type; then
`candidates: g1 N, g2 M, g3 K`; exit 0. No name or address is printed.
Other exits, each a STOP for David, never a choice made here:
- exit 2: a refusal (gate-a.json missing an answer, a county not in the inventory, not bare, IN or FL, or
  already tested). Fix it with David; never fill in an answer he did not give.
- exit 3: another non-idle session on the registry. Do not wait it out; ask David.
- exit 4: a county returned no parcels although the inventory lists it.

- [ ] **Step 6: Confirm the outputs**

Run: `python3 -c "import json; c=json.load(open('/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0/candidates.json')); print({k: len(v) for k, v in c.items()}); print(set(k for v in c.values() for r in v for k in r))"`
Expected: non-zero counts for `g1` and `g3` (a zero `g2` goes to David), and exactly the keys
`parcel_uid, owner_name, site_address, situs_city, situs_zip, parcel_id_local, property_type, state, fips, county`.
Then `git status --short tasks/research-test` must print nothing.

- [ ] **Step 7: History entry and commit**

Add at the top of `History.md`, after the header rule (house style, no em dashes):

```markdown
## 2026-09-2X (letter): Tier 1 Phase 0, Task 3. GATE A answered; registry selector run, read-only.

- David's GATE A answers, verbatim: "<david_words>". G1: <counties>. G3: <counties>. <N> records per
  county, <N> of them without a city; add-on cap <0 / 8 / all>; street <format>; G3 ladder <a / b>; types
  <six / all>; trusts without an APN <a / b>; ESTATE OF <include / exclude>; after three failures <stop /
  continue>.
- Full counts before sampling (county-counts.json): one line per county with parcels, no-city share,
  no-owner share and APN share.
- Pools drawn: g1 <N>, g2 <N>, g3 <N>. Names and addresses stay in tasks/research-test/phase0/.
```

Tick `GATE A` under Phase 0 in `tasks/todo.md`.

```bash
git add tasks/research-scripts/phase0/select_samples.py History.md tasks/todo.md
git status --short tasks/research-test   # must print nothing
git commit -m "research(phase0): read-only registry selector for the GATE A counties" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Shared helpers and the sample builder

**Files:**
- Create: `tasks/research-scripts/phase0/shared.ts`
- Test: `tasks/research-scripts/phase0/shared-selftest.ts`
- Create: `tasks/research-scripts/phase0/build-sample.ts`
- Output (gitignored): `tasks/research-test/phase0/sample.json`

**Interfaces:**
- Consumes: `classifyOwnerName(raw?: string | null): OwnerType` (lib/routing/ownerRoute.ts:170);
  `stripTrustWords(name: string): string` (Task 2, match.ts); `gate-a.json` and `candidates.json` (Task 3).
- Produces (`shared.ts`):
  - types `Group`, `Step` (`'instant' | 'instant_swapped' | 'apn' | 'fastappend' | 'full_property' | 'probe'`
    plus `'ladder_instant' | 'ladder_apn' | 'ladder_fastappend'` for question 7 (b)), `NameOrder`,
    `StreetFormat`, `GateCounty`, `GateA` (one field per GATE A question), `GateB`, `Cand`, `SampleRecord`,
    `Sample`, `Exchange`, `CallRecord`;
  - constants `DIR`, `TYPES`, `WORST`, `LADDER_EXTRA`, `CREDIT_DOLLARS`, `FASTAPPEND_HIT_DOLLARS`;
  - `round2(n: number): number`, `readJson<T>(path: string): T`, `readGateA(): GateA`,
    `street(site: string | null): string`,
    `streetFor(site: string | null, city: string | null, state: string, format: StreetFormat): string`,
    `rotation(extra: boolean, present: string[]): string[]`, `nameTokens(name: string): string[]`,
    `correctedOrder(name: string): { first_name: string; last_name: string } | null`,
    `keepsFirstName(stripped: string): boolean`, `plannedSteps(r: SampleRecord): Step[]`,
    `worstCase(r: SampleRecord): number`,
    `spendFrom(raw: Exchange[]): { dollars: number; credits: number; inferred: boolean }`.
- Produces `sample.json`: `Sample` = `{ built_at, records: SampleRecord[], worst_case_dollars }`, G1 then G2,
  G3, G4.

- [ ] **Step 1: Write the failing self-test**

`tasks/research-scripts/phase0/shared-selftest.ts`:

```ts
// Run: npx tsx tasks/research-scripts/phase0/shared-selftest.ts
import assert from 'node:assert/strict'
import { stripTrustWords } from './match'
import { correctedOrder, keepsFirstName, plannedSteps, rotation, spendFrom, street, streetFor, worstCase, type Exchange, type SampleRecord } from './shared'

// Name-order add-on: exactly two words, returned the other way round.
assert.deepEqual(correctedOrder('SMITH JOHN'), { first_name: 'JOHN', last_name: 'SMITH' })
assert.deepEqual(correctedOrder('SMITH, JOHN'), { first_name: 'JOHN', last_name: 'SMITH' })
assert.deepEqual(correctedOrder('SMITH JOHN JR'), { first_name: 'JOHN', last_name: 'SMITH' })
assert.equal(correctedOrder('SMITH JOHN T'), null) // splitPersonName already reads LAST FIRST MI
assert.equal(correctedOrder('JOHN & MARY SMITH'), null)
assert.equal(correctedOrder('SMITH JOHN | SMITH MARY'), null)
// D16: a first name or initial must survive the trust words.
assert.equal(keepsFirstName('JOHN SMITH'), true)
assert.equal(keepsFirstName('J SMITH'), true)
assert.equal(keepsFirstName('SMITH'), false)
assert.equal(keepsFirstName('SMITH &'), false)
assert.equal(keepsFirstName(''), false)
// A suffix is not a first name (splitPersonName drops it), so these trusts go to FastAppend only.
assert.equal(keepsFirstName(stripTrustWords('Smith Jr Family Trust')), false)
assert.equal(keepsFirstName(stripTrustWords('Smith Et Al Trust')), false)
assert.equal(keepsFirstName(stripTrustWords('John Smith Jr Revocable Trust')), true)
assert.equal(street('55 ELM ST, AKRON OH'), '55 ELM ST')
// Question 6: the three street formats.
assert.equal(streetFor('55 ELM AVE ROCHESTER NY 14613', 'ROCHESTER', 'NY', 'whole'), '55 ELM AVE ROCHESTER NY 14613')
assert.equal(streetFor('55 ELM AVE, ROCHESTER', 'ROCHESTER', 'NY', 'first_comma'), '55 ELM AVE')
assert.equal(streetFor('55 ELM AVE ROCHESTER NY 14613', 'Rochester', 'NY', 'strip_city'), '55 ELM AVE')
assert.equal(streetFor('55 ELM AVE ROCHESTER', 'ROCHESTER', 'NY', 'strip_city'), '55 ELM AVE')
assert.equal(streetFor('10 ROCHESTER ST', 'ROCHESTER', 'NY', 'strip_city'), '10 ROCHESTER ST') // a street named for the city stays
assert.equal(streetFor('10 ROCHESTER ST ROCHESTER', 'ROCHESTER', 'NY', 'strip_city'), '10 ROCHESTER ST')
assert.equal(streetFor('55 ELM AVE', null, 'NY', 'strip_city'), '55 ELM AVE')
// Question 8: the rotation.
assert.deepEqual(rotation(false, ['exempt', 'residential']), ['residential', 'commercial', 'industrial', 'multifamily', 'land', 'mixed_use'])
assert.deepEqual(rotation(true, ['exempt', 'residential', '(null)', 'exempt']).slice(6), ['(null)', 'exempt'])

// Which calls a record gets, and its worst case.
const base: SampleRecord = {
  parcel_uid: 'X', state: 'NY', fips: '36055', county: 'Monroe', property_type: 'residential',
  owner_name: 'SMITH JOHN', site_address: '1 A ST', situs_city: 'ROCHESTER', situs_zip: null,
  parcel_id_local: '1', group: 'G1', has_city: true, addon: true, stripped: null, person_half: false, ladder: false,
}
assert.deepEqual(plannedSteps(base), ['instant', 'apn', 'instant_swapped'])
assert.equal(worstCase(base), 0.3)
assert.deepEqual(plannedSteps({ ...base, has_city: false, addon: false }), ['apn'])
assert.deepEqual(plannedSteps({ ...base, group: 'G2', addon: false, person_half: true }), ['instant', 'apn', 'fastappend'])
assert.equal(worstCase({ ...base, group: 'G2', addon: false, person_half: true }), 0.3)
assert.deepEqual(plannedSteps({ ...base, group: 'G2', addon: false, person_half: false }), ['fastappend'])
// Question 9 (b): a trust with no APN gets no APN step.
assert.deepEqual(plannedSteps({ ...base, group: 'G2', addon: false, person_half: true, parcel_id_local: null }), ['instant', 'fastappend'])
assert.equal(worstCase({ ...base, group: 'G3', addon: false }), 0.3)
// Question 7 (b): the ladder raises a G3 record's ceiling to $0.50.
assert.equal(worstCase({ ...base, group: 'G3', addon: false, ladder: true }), 0.5)
assert.equal(worstCase({ ...base, group: 'G4', addon: false }), 0.1)

// Spend from the vendors' own answers; a hit with no credits field is over-counted, never free.
const ex = (host: string, path: string, body: unknown): Exchange =>
  ({ host, path, method: 'POST', request_body: null, status: 200, response_body: body, ms: 1, error: null })
assert.deepEqual(spendFrom([ex('tracerfy.com', '/v1/api/trace/lookup/', { hit: true, credits_deducted: 5 })]), { dollars: 0.1, credits: 5, inferred: false })
assert.deepEqual(spendFrom([ex('tracerfy.com', '/v1/api/trace/lookup/', { hit: false, credits_deducted: 0 })]), { dollars: 0, credits: 0, inferred: false })
assert.deepEqual(spendFrom([ex('tracerfy.com', '/v1/api/property-search/lookup/', { hit: true })]), { dollars: 0.2, credits: 10, inferred: true })
assert.deepEqual(spendFrom([ex('app.fastappend.com', '/v1/api/business-trace/lookup/', { hit: true })]), { dollars: 0.1, credits: 0, inferred: false })
assert.deepEqual(
  spendFrom([
    ex('tracerfy.com', '/v1/api/property-search/lookup/', { hit: true, credits_deducted: 10 }),
    ex('tracerfy.com', '/v1/api/trace/lookup/', [{ hit: true, credits_deducted: 5 }]),
  ]),
  { dollars: 0.3, credits: 15, inferred: false },
)
console.log('phase0 shared selftest OK')
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx tasks/research-scripts/phase0/shared-selftest.ts`
Expected: FAIL, cannot find module `./shared`.

- [ ] **Step 3: Implement `shared.ts`**

```ts
/**
 * Phase 0 shared shapes and pure helpers. Imported by build-sample.ts, run-phase0.ts and
 * analyze.ts so the three agree on ONE definition of a sample record, of which calls a record
 * gets, and of what each call can cost at worst. No I/O beyond reading the gate files.
 */
import { readFileSync } from 'node:fs'

export const DIR = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0'

/** Round-robin order for every group (David: every sample spans property types). */
export const TYPES = ['residential', 'commercial', 'industrial', 'multifamily', 'land', 'mixed_use'] as const

export type Group = 'G1' | 'G2' | 'G3' | 'G4'
/** ladder_* run only on a G3 record whose dossier owner is a trust or unreadable, and only if GATE A question 7 is (b). */
export type Step =
  | 'instant' | 'instant_swapped' | 'apn' | 'fastappend' | 'full_property' | 'probe'
  | 'ladder_instant' | 'ladder_apn' | 'ladder_fastappend'
export type NameOrder = 'LAST FIRST' | 'FIRST LAST' | 'unclear'
/** GATE A question 6: what street goes to Instant and the dossier. */
export type StreetFormat = 'first_comma' | 'whole' | 'strip_city'

/**
 * Worst case per call: every lookup hits and bills (ownerRoute.ts:6-12, ledger-verified 2026-09-16).
 * Tracerfy credit $0.02: trace/lookup/ and trace/parcel/lookup/ 5 credits ($0.10) per hit,
 * property-search/lookup/ 10 credits ($0.20) per hit. FastAppend business-trace/lookup/ 1 credit
 * ($0.10) per hit. full_property = one dossier hit (only one of its two keys can hit, executeRoute
 * stops at the first) plus one contact lookup. Misses are free on all four.
 */
export const WORST: Record<Step, number> = {
  instant: 0.1, instant_swapped: 0.1, apn: 0.1, fastappend: 0.1, full_property: 0.3, probe: 0.1,
  ladder_instant: 0.1, ladder_apn: 0.1, ladder_fastappend: 0.1,
}
/**
 * GATE A question 7 (b). A trust or unreadable owner found by the dossier gets NO production contact
 * call, so its worst case is the $0.20 dossier plus the ladder's three $0.10 calls: $0.50, which is
 * $0.20 above full_property's $0.30.
 */
export const LADDER_EXTRA = 0.2
export const CREDIT_DOLLARS = 0.02
export const FASTAPPEND_HIT_DOLLARS = 0.1

/** Money, to the cent. */
export const round2 = (n: number): number => Math.round(n * 100) / 100

export type GateCounty = { state: string; fips: string; county: string; name_order?: NameOrder }

/**
 * David's GATE A answers, one field per question. Written by hand from his reply; NOTHING here has a
 * default, and readGateA() refuses a file that leaves any answer out.
 */
export type GateA = {
  g1_counties: GateCounty[] // question 1
  g3_counties: GateCounty[] // question 2
  records_per_county: number // question 3: 4 or 8
  name_order_addon_cap: number | 'all' // question 4: 0 (none), 8 (what David was told), or 'all'
  g1_no_city_per_county: number // question 5: 1 to records_per_county
  street_format: StreetFormat // question 6
  g3_trust_ladder: boolean // question 7
  extra_property_types: boolean // question 8
  g2_trusts_without_apn: boolean // question 9
  g2_estate_of: 'include' | 'exclude' // question 10
  stop_after_three_failures: boolean // question 11: true = stop and record the stop point, false = continue
  answered_by: string
  answered_at: string
  david_words: string
}

/** David's GATE B answer: the most the live run may spend. */
export type GateB = { approved_dollars: number; answered_by: string; answered_at: string; david_words: string }

/** One registry row as select_samples.py writes it. */
export type Cand = {
  parcel_uid: string
  state: string
  fips: string
  county: string
  property_type: string
  owner_name: string | null
  site_address: string | null
  situs_city: string | null
  situs_zip: string | null
  parcel_id_local: string | null
}

export type SampleRecord = Cand & {
  group: Group
  has_city: boolean
  /** G1 only: the county stores two-word names LAST FIRST, so this record also gets the corrected-order call. */
  addon: boolean
  /** G2 only: the owner name with the trust words removed (stripTrustWords). */
  stripped: string | null
  /** G2 only: the stripped name keeps a first name or initial, so the person steps run. False = D16, FastAppend only. */
  person_half: boolean
  /** G3 only: GATE A question 7 is (b), so a trust or unreadable dossier owner also gets the D3/D16 ladder. */
  ladder: boolean
}

export type Sample = { built_at: string; records: SampleRecord[]; worst_case_dollars: number }

/** One HTTP exchange as the runner's fetch wrapper saw it. Headers are never recorded: they carry the API keys. */
export type Exchange = {
  host: string
  path: string
  method: string
  request_body: unknown
  status: number | null
  response_body: unknown
  ms: number
  error: string | null
}

/** One line of calls.jsonl: one planned call, its production result, and every raw exchange it made. */
export type CallRecord = {
  group: Group
  id: string
  state: string
  fips: string
  county: string
  property_type: string
  has_city: boolean
  step: Step
  /** Registry owner of record. Null for G3 (none on record) and G4. */
  owner_name: string | null
  /** The name returned people are judged against: G1 the owner, G2 the stripped name. G3 uses result.ownerName. */
  match_name: string | null
  /** The first and last name put in the request (Instant) or carried with it (APN, never sent to Tracerfy). */
  sent_name: { first_name: string; last_name: string } | null
  ms: number
  dollars: number
  credits: number
  credits_inferred: boolean
  /** Set only if the step threw. The production clients never throw, so this should stay null. */
  thrown: string | null
  /** What the production client returned: ContactResult for person and company steps, ExecutionResult for full_property. */
  result: unknown
  raw: Exchange[]
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Read and check gate-a.json. Throws on anything missing: there is no default for any answer. */
export function readGateA(): GateA {
  const g = readJson<GateA>(`${DIR}/gate-a.json`)
  const bad = (m: string): never => {
    throw new Error(`gate-a.json: ${m}`)
  }
  if (g.records_per_county !== 4 && g.records_per_county !== 8) bad('records_per_county must be 4 or 8 (question 3)')
  const cap = g.name_order_addon_cap
  if (cap !== 'all' && !(Number.isInteger(cap) && cap >= 0)) bad('name_order_addon_cap must be 0, a whole number, or "all" (question 4)')
  // The brief requires no-city parcels wherever a county has them, so 0 is not an answer.
  if (!Number.isInteger(g.g1_no_city_per_county) || g.g1_no_city_per_county < 1 || g.g1_no_city_per_county > g.records_per_county) {
    bad('g1_no_city_per_county must be a whole number from 1 to records_per_county (question 5)')
  }
  if (!['first_comma', 'whole', 'strip_city'].includes(g.street_format)) bad('street_format must be first_comma, whole or strip_city (question 6)')
  const questions = { g3_trust_ladder: 7, extra_property_types: 8, g2_trusts_without_apn: 9, stop_after_three_failures: 11 } as const
  for (const k of Object.keys(questions) as (keyof typeof questions)[]) {
    if (typeof g[k] !== 'boolean') bad(`${k} must be true or false (question ${questions[k]})`)
  }
  if (g.g2_estate_of !== 'include' && g.g2_estate_of !== 'exclude') bad('g2_estate_of must be include or exclude (question 10)')
  if (!g.g1_counties?.length || !g.g3_counties?.length) bad('g1_counties and g3_counties are both required')
  for (const c of [...g.g1_counties, ...g.g3_counties]) {
    if (!/^[A-Z]{2}$/.test(c.state) || !/^\d{5}$/.test(c.fips) || !c.county?.trim()) bad(`bad county entry ${JSON.stringify(c)}`)
    if (/\b(county|parish|borough|municipality)\b/i.test(c.county)) bad(`county must be bare (Tracerfy wants "Stark", never "Stark County"): ${c.county}`)
  }
  for (const c of g.g1_counties) {
    if (c.name_order !== 'LAST FIRST' && c.name_order !== 'FIRST LAST' && c.name_order !== 'unclear') {
      bad(`name_order (from tasks/phase0-county-shortlist.md) missing for ${c.state} ${c.county}`)
    }
  }
  if (!g.answered_by?.trim() || !g.answered_at?.trim() || !g.david_words?.trim()) bad('answered_by, answered_at and david_words are required')
  return g
}

/** The street part of a registry site_address: everything before the first comma. */
export const street = (site: string | null): string => (site ?? '').split(',')[0].trim()

/**
 * GATE A question 6. first_comma: everything before the first comma. whole: site_address as stored, which
 * is what the gateway sends (suite-gateway lib/registry-parcel-adapter.ts:703). strip_city: first comma,
 * then a trailing situs city removed when nothing but the record's own state and a ZIP follows it, so
 * "55 ELM AVE ROCHESTER NY 14613" loses "ROCHESTER NY 14613" but "10 ROCHESTER ST" keeps its street name.
 */
export function streetFor(site: string | null, city: string | null, state: string, format: StreetFormat): string {
  const whole = (site ?? '').trim()
  if (format === 'whole') return whole
  const first = street(site)
  const c = (city ?? '').trim().toUpperCase()
  if (format === 'first_comma' || !c) return first
  const u = first.toUpperCase()
  const tail = new RegExp(`^(\\s+${state.toUpperCase()})?(\\s+\\d{5}(-\\d{4})?)?\\s*$`)
  let at = -1
  for (let i = u.indexOf(` ${c}`); i !== -1; i = u.indexOf(` ${c}`, i + 1)) {
    if (tail.test(u.slice(i + 1 + c.length))) at = i
  }
  return at > 0 ? first.slice(0, at).trim() : first
}

/** The same suffixes splitPersonName drops (lib/routing/ownerRoute.ts:470). */
const SUFFIX = /\b(ET AL|ET UX|ET VIR|JR|SR|II|III|IV|MRS?|DR)\b\.?/gi

/** A name's words the way splitPersonName counts them: suffixes and a bare '&' removed. */
export function nameTokens(name: string): string[] {
  return name.replace(SUFFIX, ' ').split(/\s+/).filter((t) => t && t !== '&')
}

/**
 * The name-order add-on (spec D18, measured here). splitPersonName reads ANY two-word name as
 * FIRST LAST (ownerRoute.ts:484), so a county that stores "SMITH JOHN" is sent backwards. This
 * returns the two words the other way round, commas dropped. Null when the name is not exactly
 * two words (three words with a trailing initial are already read LAST FIRST MI) or carries a pipe.
 */
export function correctedOrder(name: string): { first_name: string; last_name: string } | null {
  if (name.includes('|')) return null
  const t = nameTokens(name).map((s) => s.replace(/[^A-Za-z'-]/g, '')).filter(Boolean)
  return t.length === 2 ? { first_name: t[1], last_name: t[0] } : null
}

/**
 * D16: once the trust words are gone, is a first name or initial left? Two or more words, counted the way
 * splitPersonName counts them (suffixes and '&' dropped), so "SMITH JR" is one word and goes to FastAppend.
 */
export const keepsFirstName = (stripped: string): boolean =>
  nameTokens(stripped).filter((t) => /[A-Z]/i.test(t)).length >= 2

/** Every call a sample record gets, in the order the runner makes them. */
export function plannedSteps(r: SampleRecord): Step[] {
  const steps: Step[] = []
  if (r.group === 'G1') {
    if (r.has_city) steps.push('instant')
    steps.push('apn')
    if (r.addon) steps.push('instant_swapped')
  } else if (r.group === 'G2') {
    // Question 9 (b) admits trusts without an APN or a street; each person step runs only if its key exists.
    if (r.person_half) {
      if (r.has_city && r.site_address?.trim()) steps.push('instant')
      if (r.parcel_id_local?.trim()) steps.push('apn')
    }
    steps.push('fastappend')
  } else if (r.group === 'G3') {
    steps.push('full_property')
  } else {
    steps.push('probe')
  }
  return steps
}

export const worstCase = (r: SampleRecord): number =>
  round2(plannedSteps(r).reduce((s, st) => s + WORST[st], 0) + (r.group === 'G3' && r.ladder ? LADDER_EXTRA : 0))

/** The round-robin rotation: the six named types, then (question 8 (b) only) every other type present, alphabetically. */
export function rotation(extra: boolean, present: string[]): string[] {
  const six: string[] = [...TYPES]
  return extra ? [...six, ...[...new Set(present)].filter((t) => !six.includes(t)).sort()] : six
}

/**
 * What a call's exchanges cost, from the vendors' own answers. Tracerfy reports credits_deducted.
 * A Tracerfy HIT without that field is counted at the documented per-hit credits and flagged
 * inferred, so the spend guard over-counts rather than under-counts. FastAppend: $0.10 per hit.
 */
export function spendFrom(raw: Exchange[]): { dollars: number; credits: number; inferred: boolean } {
  let credits = 0
  let fastappend = 0
  let inferred = false
  for (const ex of raw) {
    const b = Array.isArray(ex.response_body) ? ex.response_body[0] : ex.response_body
    const body = b && typeof b === 'object' ? (b as Record<string, unknown>) : {}
    if (ex.host === 'tracerfy.com') {
      if (typeof body.credits_deducted === 'number') credits += body.credits_deducted
      else if (body.hit === true) {
        credits += ex.path.includes('property-search') ? 10 : 5
        inferred = true
      }
    } else if (ex.host === 'app.fastappend.com' && body.hit === true) {
      fastappend += FASTAPPEND_HIT_DOLLARS
    }
  }
  return { dollars: round2(credits * CREDIT_DOLLARS + fastappend), credits, inferred }
}
```

- [ ] **Step 4: Run the self-test to verify it passes**

Run: `npx tsx tasks/research-scripts/phase0/shared-selftest.ts`
Expected: `phase0 shared selftest OK`

- [ ] **Step 5: Prove the spend assertion is load-bearing**

Temporarily change `credits += ex.path.includes('property-search') ? 10 : 5` in `spendFrom` to
`credits += 0`, run the self-test, confirm it FAILS on the `property-search` assertion (a billed hit
counted as free would let the cap be passed), then restore the line and confirm it passes again.

- [ ] **Step 6: Write the builder**

`tasks/research-scripts/phase0/build-sample.ts`:

```ts
// Run: npx tsx tasks/research-scripts/phase0/build-sample.ts
/**
 * Fix the Phase 0 sample from the selector's pools with the PRODUCTION classifier, and price it.
 * Reads gate-a.json and candidates.json, writes sample.json. Prints counts only, never a name or
 * an address. A county that cannot fill its quota is a STOP for David, never a substitution.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyOwnerName } from '../../../lib/routing/ownerRoute'
import { stripTrustWords } from './match'
import {
  DIR, correctedOrder, keepsFirstName, readGateA, readJson, rotation, round2, street, streetFor, worstCase,
  type Cand, type Sample, type SampleRecord,
} from './shared'

const TRUST_TOTAL = 10 // G2, "~10, same counties, spread types" (David's brief)
const PROBE_PARCEL_ID = 'PHASE0NOSUCH0001' // G4: deliberately not a parcel anywhere
const TESTED_DIR = '/Users/davidmonroe/PropTracerPRO/tasks/research-test'

const gate = readGateA()
const pools = readJson<{ g1: Cand[]; g2: Cand[]; g3: Cand[] }>(`${DIR}/candidates.json`)

// L-023: never re-use a parcel already tested. Everything under tasks/research-test/ except this run.
function corpus(dir: string): string {
  let text = ''
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (p === DIR) continue
    text += statSync(p).isDirectory() ? corpus(p) : readFileSync(p, 'utf8')
  }
  return text
}
const squash = (s: string | null): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const TESTED = squash(corpus(TESTED_DIR))
let excludedAsTested = 0
const fresh = (list: Cand[]): Cand[] =>
  list.filter((c) => {
    const pid = squash(c.parcel_id_local)
    const st = squash(street(c.site_address))
    const seen = pid.length >= 6 ? TESTED.includes(pid) : st.length >= 8 && TESTED.includes(st)
    if (seen) excludedAsTested++
    return !seen
  })
const g1Pool = fresh(pools.g1)
const g2Pool = fresh(pools.g2)
const g3Pool = fresh(pools.g3)

const used = new Set<string>()
const hasCity = (c: Cand): boolean => Boolean(c.situs_city?.trim())
// Question 8: the six types only, or every type the pools hold (the six first).
const TYPE_ORDER = rotation(gate.extra_property_types, [...pools.g1, ...pools.g2, ...pools.g3].map((c) => c.property_type))

/**
 * Take up to n from list, one property type at a time. The cursor is shared across a group's
 * counties, so four records per county still walk all the types rather than the first four.
 */
function roundRobin(list: Cand[], n: number, cursor: { i: number }): Cand[] {
  const byType = new Map<string, Cand[]>(TYPE_ORDER.map((t) => [t, list.filter((c) => c.property_type === t && !used.has(c.parcel_uid))]))
  const out: Cand[] = []
  let idle = 0
  while (out.length < n && idle < TYPE_ORDER.length) {
    const next = byType.get(TYPE_ORDER[cursor.i % TYPE_ORDER.length])!.shift()
    cursor.i++
    if (next) {
      out.push(next)
      used.add(next.parcel_uid)
      idle = 0
    } else {
      idle++
    }
  }
  return out
}

const records: SampleRecord[] = []
const shortfalls: string[] = []
const plain = { addon: false, stripped: null, person_half: false, ladder: false }

// G1: individual owners. The no-city share first (APN only), then city records, then top up.
const g1Cursor = { i: 0 }
for (const county of gate.g1_counties) {
  const mine = g1Pool.filter((c) => c.fips === county.fips && classifyOwnerName(c.owner_name) === 'individual')
  const noCity = roundRobin(mine.filter((c) => !hasCity(c)), gate.g1_no_city_per_county, g1Cursor)
  const withCity = roundRobin(mine.filter(hasCity), gate.records_per_county - noCity.length, g1Cursor)
  const topUp = roundRobin(mine.filter((c) => !hasCity(c)), gate.records_per_county - noCity.length - withCity.length, g1Cursor)
  const picked = [...noCity, ...withCity, ...topUp]
  if (picked.length < gate.records_per_county) {
    shortfalls.push(`G1 ${county.state} ${county.county}: ${picked.length} of ${gate.records_per_county} individual owners`)
  }
  if (noCity.length < gate.g1_no_city_per_county) {
    console.log(`note: G1 ${county.state} ${county.county} has ${noCity.length} no-city individuals of ${gate.g1_no_city_per_county} asked`)
  }
  for (const c of picked) records.push({ ...c, ...plain, group: 'G1', has_city: hasCity(c) })
}

// Question 4: the name-order add-on, never on more records than David's cap. Qualifying = the county
// stores LAST FIRST, the record has a city, the name is exactly two words. Taken one per county per
// round so a cap of 8 spreads across the LAST FIRST counties.
const qualifying = gate.g1_counties.map((county) =>
  records.filter((r) => r.group === 'G1' && r.fips === county.fips && county.name_order === 'LAST FIRST' &&
    r.has_city && correctedOrder(r.owner_name ?? '') !== null))
const addonCap = gate.name_order_addon_cap === 'all' ? Infinity : gate.name_order_addon_cap
let addons = 0
for (let round = 0; addons < addonCap && qualifying.some((q) => q.length > round); round++) {
  for (const q of qualifying) {
    if (addons < addonCap && q[round]) {
      q[round].addon = true
      addons++
    }
  }
}
const qualifyingTotal = qualifying.reduce((n, q) => n + q.length, 0)

// G2: trusts in the same counties, one per county per round, types rotating.
const trustCursor = { i: 0 }
// Question 10: "ESTATE OF" names classify as trusts; David decides whether they are sampled.
const estate = (c: Cand): boolean => /\bESTATE OF\b/i.test(c.owner_name ?? '')
const trustLists = gate.g1_counties.map((county) =>
  g2Pool.filter((c) => c.fips === county.fips && classifyOwnerName(c.owner_name) === 'trust' &&
    (gate.g2_estate_of === 'include' || !estate(c))))
const trusts: Cand[] = []
for (let took = true; took && trusts.length < TRUST_TOTAL; ) {
  took = false
  for (const list of trustLists) {
    if (trusts.length >= TRUST_TOTAL) break
    const got = roundRobin(list, 1, trustCursor)
    if (got.length) {
      trusts.push(...got)
      took = true
    }
  }
}
for (const c of trusts) {
  const stripped = stripTrustWords(c.owner_name ?? '')
  records.push({ ...c, ...plain, group: 'G2', has_city: hasCity(c), stripped, person_half: keepsFirstName(stripped) })
}
if (trusts.length < TRUST_TOTAL) console.log(`note: G2 found ${trusts.length} trusts of ${TRUST_TOTAL}`)

// G3: no owner on record (D17), across property types.
const g3Cursor = { i: 0 }
for (const county of gate.g3_counties) {
  const mine = g3Pool.filter((c) => c.fips === county.fips)
  if (mine.some((c) => c.owner_name?.trim())) throw new Error(`G3 pool for ${county.fips} holds a named owner; the selector is wrong`)
  const picked = roundRobin(mine, gate.records_per_county, g3Cursor)
  if (picked.length < gate.records_per_county) {
    shortfalls.push(`G3 ${county.state} ${county.county}: ${picked.length} of ${gate.records_per_county} no-owner parcels`)
  }
  for (const c of picked) records.push({ ...c, ...plain, group: 'G3', has_city: hasCity(c), ladder: gate.g3_trust_ladder })
}

// G4: one unrecognized-APN probe per G1 state, in that state's first G1 county.
const probed = new Set<string>()
for (const county of gate.g1_counties) {
  if (probed.has(county.state)) continue
  probed.add(county.state)
  records.push({
    parcel_uid: `probe-${county.state}`, state: county.state, fips: county.fips, county: county.county,
    property_type: '(probe)', owner_name: null, site_address: null, situs_city: null, situs_zip: null,
    parcel_id_local: PROBE_PARCEL_ID, ...plain, group: 'G4', has_city: false,
  })
}

if (shortfalls.length) {
  console.error(`STOP. Bring these to David; no county is substituted:\n  ${shortfalls.join('\n  ')}`)
  process.exit(1)
}

const worst = round2(records.reduce((s, r) => s + worstCase(r), 0))
const sample: Sample = { built_at: new Date().toISOString(), records, worst_case_dollars: worst }
writeFileSync(`${DIR}/sample.json`, JSON.stringify(sample, null, 1))

const tally = (f: (r: SampleRecord) => string | null): Record<string, number> =>
  records.reduce<Record<string, number>>((m, r) => {
    const k = f(r)
    if (k !== null) m[k] = (m[k] ?? 0) + 1
    return m
  }, {})
console.log(JSON.stringify({
  records: tally((r) => r.group),
  by_county: tally((r) => `${r.group} ${r.state} ${r.county}`),
  by_type: tally((r) => `${r.group} ${r.property_type}`),
  city: tally((r) => (r.group === 'G4' ? null : `${r.group} ${r.has_city ? 'city' : 'no city'}`)),
  g1_name_order_addon: { marked: records.filter((r) => r.addon).length, qualifying: qualifyingTotal, cap: gate.name_order_addon_cap },
  g2_person_half: records.filter((r) => r.group === 'G2' && r.person_half).length,
  g2_fastappend_only_d16: records.filter((r) => r.group === 'G2' && !r.person_half).length,
  g2_without_apn: records.filter((r) => r.group === 'G2' && !r.parcel_id_local?.trim()).length,
  g2_estate_of: records.filter((r) => r.group === 'G2' && estate(r)).length,
  g3_ladder_enabled: gate.g3_trust_ladder,
  street_format: gate.street_format,
  street_still_contains_city: tally((r) =>
    r.has_city && squash(streetFor(r.site_address, r.situs_city, r.state, gate.street_format)).includes(squash(r.situs_city))
      ? `${r.group} ${r.state} ${r.county}` : null),
  excluded_as_already_tested: excludedAsTested,
  worst_case_dollars: worst,
}, null, 1))
```

- [ ] **Step 7: Run it**

Run: `npx tsx tasks/research-scripts/phase0/build-sample.ts`
Expected: a JSON summary with `records` (G1 = G1 counties x records per county, G2 up to 10, G3 = G3
counties x records per county, G4 one per G1 state), `by_county`, `by_type` spread across the types
question 8 allows, `city` (G1 no-city records present wherever a county has them), `g1_name_order_addon`
(`marked` never above `cap`), `g2_person_half`, `g2_fastappend_only_d16`, `g2_without_apn`, `g2_estate_of`,
`g3_ladder_enabled`, `street_format`, `street_still_contains_city`, `excluded_as_already_tested`,
`worst_case_dollars`.
Exit 0. Any `note:` line and any non-empty `street_still_contains_city` go to David at GATE B.
Exit 1 with `STOP. Bring these to David` means a county could not fill its quota: STOP; no county is
substituted and no quota is lowered without him.

- [ ] **Step 8: History entry and commit**

```markdown
## 2026-09-2X (letter): Tier 1 Phase 0, Task 4. Sample fixed with the production classifier.

- shared.ts holds one definition of a sample record, the calls each record gets and their worst case;
  its self-test pins the name-order add-on, D16 and the spend count, and fails if a billed hit is
  counted as free.
- Sample: G1 <N> (<N> without a city), G2 <N> (<N> straight to FastAppend under D16), G3 <N>, G4 <N>;
  add-on records <N>; worst case $<X>.
```

```bash
git add tasks/research-scripts/phase0/shared.ts tasks/research-scripts/phase0/shared-selftest.ts tasks/research-scripts/phase0/build-sample.ts History.md
git status --short tasks/research-test   # must print nothing
git commit -m "research(phase0): shared sample shapes and the builder, production classifier" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The runner, `--plan` only (GATE B)

**Files:**
- Create: `tasks/research-scripts/phase0/run-phase0.ts`
- Output (gitignored, `--live` only): `tasks/research-test/phase0/calls.jsonl`; (`--balance` only)
  `tasks/research-test/phase0/balance.jsonl`

**Interfaces (each verified against the code on 2026-09-21):**
- Consumes:
  - `splitPersonName(name: string): { first_name: string; last_name: string }` (lib/routing/ownerRoute.ts:465);
    `planRoute(parcel: ParcelInput, pricePlan: PricePlan): RoutePlan` (:318).
  - `parcelForFullTrace(input: TraceAddressInput & { apn?: string | null; county?: string | null }): ParcelInput`
    (lib/trace/fullPropertyTrace.ts:84; `TraceAddressInput = { address: string; city: string; state: string; zip?: string | null }`, :20).
  - `executeRoute(plan: RoutePlan, deps: RouteDeps): Promise<ExecutionResult>` (lib/routing/executeRoute.ts:415),
    `RouteDeps = { lookupDossier, traceEntity, tracePerson }` (:98-102), `ExecutionResult` (:130),
    `StepReport` (:118).
  - `lookupDossier(key: DossierKey): Promise<DossierResult>` (lib/tracerfy/dossier.ts:228).
  - `lookupBusinessTrace(req: EntityTraceRequest): Promise<ContactResult>` (lib/tracerfy/client.ts:518);
    `lookupPersonTrace(req: PersonTraceRequest): Promise<ContactResult>` (:628; parcel endpoint when
    `parcel_id` and `county` are both set, :633-641, otherwise `trace/lookup/` with `find_owner:false`,
    :642-661); `getAnalytics()` (:858, `data.balance` is the credit balance).
  - `TRACERFY.BASE_URL` (lib/constants.ts:118, honours `TRACERFY_API_URL`), `FASTAPPEND.BASE_URL` (:124).
  - `affordable` and `stripTrustWords` (Task 2), everything in `shared.ts` (Task 4), `sample.json` (Task 4),
    and `gate-a.json` through `readGateA()`: the add-on cap (question 4, checked against the sample), the
    street format (question 6), the G3 ladder (question 7) and the stop after three failures (question 11).
  - Everything from `lib/`, and `match.ts`, is loaded with a dynamic `import()` inside `main()`, after
    `delete process.env.SUPABASE_SERVICE_ROLE_KEY` has run (the house pattern of
    `tasks/research-scripts/dossier-client-check.ts`). The `ExecutionResult` import is type-only.
- Produces one `CallRecord` line per call in `calls.jsonl` (type in `shared.ts`), each with `result` (what
  the production client returned) and `raw` (every exchange). `balance.jsonl`: `{ at, success, balance, error }`.

- [ ] **Step 1: Write the runner**

`tasks/research-scripts/phase0/run-phase0.ts`:

```ts
/**
 * Phase 0 live measurement. THIS SPENDS.
 *   --plan                     (default) list every call by group and step, the counties and the worst case; no network
 *   --live --max-dollars=<n>   run; n must be above 0 and at or under gate-b.json approved_dollars (David, GATE B)
 *   --balance                  append Tracerfy's account balance to balance.jsonl and exit; spends nothing
 * Every vendor request and response a call makes is written on that call's line as `raw`.
 * Reads David's GATE A answers for the add-on cap (question 4), the street format (question 6), the G3
 * ladder (question 7) and the stop after three failures (question 11).
 * Run: npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --plan
 */

// The env scrub runs before any production module loads. The only static imports are node:fs and Phase 0's
// own guard.ts and shared.ts, which reach nothing in lib/. Every module that does (match.ts included, which
// imports ownerRoute) is loaded with a dynamic import inside main(), after this line has run. Same house
// pattern as tasks/research-scripts/dossier-client-check.ts.
delete process.env.SUPABASE_SERVICE_ROLE_KEY

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
// Type-only: erased at runtime, so they load nothing before the scrub.
import type { ExecutionResult } from '../../../lib/routing/executeRoute'
import { affordable } from './guard'
import {
  DIR, WORST, correctedOrder, keepsFirstName, plannedSteps, readGateA, readJson, round2, spendFrom, streetFor, worstCase,
  type CallRecord, type Exchange, type GateA, type GateB, type Sample, type SampleRecord, type Step,
} from './shared'

const OUT = `${DIR}/calls.jsonl`
const args = process.argv.slice(2)
const LIVE = args.includes('--live')
const BALANCE = args.includes('--balance')
const capArg = args.find((a) => a.startsWith('--max-dollars='))
const CAP = capArg ? Number(capArg.split('=')[1]) : NaN

function refuse(msg: string): never {
  console.error(msg)
  process.exit(2)
}

/** The production modules, loaded after the env scrub. */
async function loadLib() {
  const { planRoute, splitPersonName } = await import('../../../lib/routing/ownerRoute')
  const { parcelForFullTrace } = await import('../../../lib/trace/fullPropertyTrace')
  const { executeRoute } = await import('../../../lib/routing/executeRoute')
  const { lookupDossier } = await import('../../../lib/tracerfy/dossier')
  const { getAnalytics, lookupBusinessTrace, lookupPersonTrace } = await import('../../../lib/tracerfy/client')
  const { FASTAPPEND, TRACERFY } = await import('../../../lib/constants')
  const { stripTrustWords } = await import('./match')
  return {
    planRoute, splitPersonName, parcelForFullTrace, executeRoute, lookupDossier,
    getAnalytics, lookupBusinessTrace, lookupPersonTrace, FASTAPPEND, TRACERFY, stripTrustWords,
  }
}
type Lib = Awaited<ReturnType<typeof loadLib>>

// ---- Vendor hosts only, and the raw recorder. ----
let current: Exchange[] | null = null
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return { unparsed: text }
  }
}

/** Installed before any call. lookupDossier and lookupPersonTrace read TRACERFY_API_URL at call time
 *  (dossier.ts:232, client.ts:632), and a sandbox URL returns fake data, so the override itself is checked. */
function guardNetwork(lib: Lib): void {
  const tracerfyBase = process.env.TRACERFY_API_URL || lib.TRACERFY.BASE_URL
  if (new URL(tracerfyBase).hostname !== 'tracerfy.com') refuse(`Tracerfy base URL is ${tracerfyBase}; refusing (sandbox data is fake)`)
  const allowed = new Set(['tracerfy.com', new URL(lib.FASTAPPEND.BASE_URL).hostname])
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (!allowed.has(url.hostname)) throw new Error(`BLOCKED host: ${url.hostname}`)
    const ex: Exchange = {
      host: url.hostname, path: url.pathname, method: init?.method ?? 'GET',
      request_body: typeof init?.body === 'string' ? parse(init.body) : null,
      status: null, response_body: null, ms: 0, error: null,
    }
    current?.push(ex)
    const t0 = Date.now()
    try {
      const res = await realFetch(input, init)
      ex.status = res.status
      // A clone, so the production client still reads the body it expects.
      ex.response_body = parse(await res.clone().text())
      return res
    } catch (e) {
      ex.error = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      ex.ms = Date.now() - t0
    }
  }) as typeof fetch
}

type Planned = {
  match_name: string | null
  sent_name: { first_name: string; last_name: string } | null
  run: () => Promise<unknown>
}

/**
 * Set only for a G3 record under question 7 (b) whose dossier owner is a trust or unreadable name: the
 * D3/D16 ladder runs on it. `person` is the stripped trust name, or an unreadable name as given (spec 4.2).
 */
type Ladder = { owner: string; person: string; zip: string | null }

/** One step of one record, through the production client that Phase 1 will call. */
function planned(lib: Lib, r: SampleRecord, step: Step, gate: GateA, ladder: Ladder | null): Planned {
  const personName = (r.group === 'G2' ? r.stripped : r.owner_name) ?? ''
  const zip = r.situs_zip?.trim() || ladder?.zip || ''
  const address = {
    address: streetFor(r.site_address, r.situs_city, r.state, gate.street_format), city: r.situs_city ?? '', state: r.state,
    ...(zip ? { zip } : {}),
  }
  switch (step) {
    case 'instant': {
      // The name exactly as splitPersonName splits it today (D18 is measured, not yet fixed).
      const sent = lib.splitPersonName(personName)
      return { match_name: personName, sent_name: sent, run: () => lib.lookupPersonTrace({ ...sent, ...address, find_owner: false }) }
    }
    case 'instant_swapped': {
      const sent = correctedOrder(r.owner_name ?? '')
      if (!sent) throw new Error(`instant_swapped planned for a name that is not two words (${r.parcel_uid})`)
      return { match_name: r.owner_name, sent_name: sent, run: () => lib.lookupPersonTrace({ ...sent, ...address, find_owner: false }) }
    }
    case 'apn': {
      // The names travel with the step for the parser; the parcel endpoint is sent only parcel_id, county, state.
      const carried = lib.splitPersonName(personName)
      return {
        match_name: personName, sent_name: carried,
        run: () => lib.lookupPersonTrace({ ...carried, parcel_id: r.parcel_id_local ?? '', county: r.county, state: r.state }),
      }
    }
    case 'fastappend':
      // The FULL trust name (D3, D16).
      return { match_name: null, sent_name: null, run: () => lib.lookupBusinessTrace({ company_name: r.owner_name ?? '', state: r.state }) }
    case 'full_property':
      // PRODUCTION routing, unchanged: dossier (APN key first, then address), then the second lookup on
      // the owner it found. pricePlan 'pro' only prices the plan; it spends nothing by itself.
      return {
        match_name: null, sent_name: null,
        run: () => {
          const parcel = lib.parcelForFullTrace({
            address: streetFor(r.site_address, r.situs_city, r.state, gate.street_format), city: r.situs_city ?? '',
            state: r.state, zip: r.situs_zip, apn: r.parcel_id_local, county: r.county,
          })
          return lib.executeRoute(lib.planRoute(parcel, 'pro'), {
            lookupDossier: lib.lookupDossier, traceEntity: lib.lookupBusinessTrace, tracePerson: lib.lookupPersonTrace,
          })
        },
      }
    case 'probe':
      return {
        match_name: null, sent_name: null,
        run: () => lib.lookupPersonTrace({ first_name: '', last_name: '', parcel_id: r.parcel_id_local ?? '', county: r.county, state: r.state }),
      }
    case 'ladder_instant':
    case 'ladder_apn': {
      if (!ladder) throw new Error(`${step} without a ladder owner (${r.parcel_uid})`)
      const sent = lib.splitPersonName(ladder.person)
      return step === 'ladder_instant'
        ? { match_name: ladder.person, sent_name: sent, run: () => lib.lookupPersonTrace({ ...sent, ...address, find_owner: false }) }
        : { match_name: ladder.person, sent_name: sent, run: () => lib.lookupPersonTrace({ ...sent, parcel_id: r.parcel_id_local ?? '', county: r.county, state: r.state }) }
    }
    case 'ladder_fastappend': {
      if (!ladder) throw new Error(`${step} without a ladder owner (${r.parcel_uid})`)
      const owner = ladder.owner
      return { match_name: null, sent_name: null, run: () => lib.lookupBusinessTrace({ company_name: owner, state: r.state }) }
    }
  }
}

/** Question 7 (b): the ladder steps a finished G3 record now gets, or none. */
function ladderAfter(lib: Lib, r: SampleRecord, result: unknown): { ladder: Ladder; steps: Step[] } | null {
  const ex = result as ExecutionResult | null
  if (!r.ladder || !ex || !ex.success || !ex.ownerFound || !ex.ownerName) return null
  if (ex.ownerType !== 'trust' && ex.ownerType !== 'unknown') return null
  const person = ex.ownerType === 'trust' ? lib.stripTrustWords(ex.ownerName) : ex.ownerName.trim()
  const steps: Step[] = []
  if (keepsFirstName(person)) {
    if (r.has_city && r.site_address?.trim()) steps.push('ladder_instant')
    if (r.parcel_id_local?.trim()) steps.push('ladder_apn')
  }
  steps.push('ladder_fastappend')
  return { ladder: { owner: ex.ownerName, person, zip: ex.learnedZip }, steps }
}

const tally = (xs: string[]): Record<string, number> =>
  xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  if (BALANCE) {
    const lib = await loadLib()
    guardNetwork(lib)
    mkdirSync(DIR, { recursive: true })
    const r = await lib.getAnalytics()
    const line = { at: new Date().toISOString(), success: r.success, balance: r.data?.balance ?? null, error: r.error ?? null }
    appendFileSync(`${DIR}/balance.jsonl`, JSON.stringify(line) + '\n')
    console.log(JSON.stringify(line))
    return
  }

  const gate = readGateA()
  const sample = readJson<Sample>(`${DIR}/sample.json`)
  const units = sample.records.map((r) => ({ r, steps: plannedSteps(r) }))
  const worst = round2(sample.records.reduce((s, r) => s + worstCase(r), 0))
  const addons = sample.records.filter((r) => r.addon).length
  console.log(JSON.stringify({
    calls: units.reduce((n, u) => n + u.steps.length, 0),
    by_group_step: tally(units.flatMap((u) => u.steps.map((s) => `${u.r.group} ${s}`))),
    worst_by_group: Object.fromEntries(['G1', 'G2', 'G3', 'G4'].map((g) =>
      [g, round2(sample.records.filter((r) => r.group === g).reduce((s, r) => s + worstCase(r), 0))])),
    g3_ladder: gate.g3_trust_ladder ? 'on: up to 3 more calls per G3 record whose owner is a trust or unreadable, counted in the worst case' : 'off',
    name_order_addon: { records: addons, cap: gate.name_order_addon_cap },
    street_format: gate.street_format,
    stop_after_three_failures: gate.stop_after_three_failures,
    counties: tally(units.map((u) => `${u.r.group} ${u.r.state} ${u.r.county}`)),
    worst_case_dollars: worst,
  }, null, 1))
  if (Math.abs(worst - sample.worst_case_dollars) > 0.005) refuse(`worst case $${worst} differs from build-sample.ts ($${sample.worst_case_dollars}); refusing`)
  if (gate.name_order_addon_cap !== 'all' && addons > gate.name_order_addon_cap) {
    refuse(`sample marks ${addons} add-on records, above David's cap of ${gate.name_order_addon_cap}; refusing`)
  }
  if (sample.records.some((r) => r.group === 'G3' && r.ladder !== gate.g3_trust_ladder)) refuse('sample.json and gate-a.json disagree on the G3 ladder; rebuild the sample')
  if (!LIVE) {
    console.log('PLAN ONLY. Nothing was called.')
    return
  }

  // ---- Live. Every refusal below happens before any production module loads and before any network call.
  // The cap comes first so that --max-dollars=0 is refused whether or not gate-b.json exists.
  if (!(CAP > 0)) refuse('--live needs --max-dollars=<n> with n above 0')
  if (!existsSync(`${DIR}/gate-b.json`)) refuse('GATE B is not recorded (gate-b.json). David names the amount first.')
  const gateB = readJson<GateB>(`${DIR}/gate-b.json`)
  const approved = gateB.approved_dollars
  if (!(typeof approved === 'number' && approved > 0) || !gateB.answered_by?.trim() || !gateB.david_words?.trim()) {
    refuse('gate-b.json needs approved_dollars above 0, answered_by and david_words')
  }
  if (!(CAP <= approved + 1e-9)) refuse(`--live needs --max-dollars=<n>, 0 < n <= ${approved} (the amount David approved)`)
  if (!process.env.TRACERFY_API_KEY || !process.env.FASTAPPEND_API_KEY) refuse('vendor keys missing (run with --env-file=.env.local)')
  if (existsSync(OUT)) refuse(`${OUT} exists from an earlier run. Re-running re-buys every call; STOP and ask David.`)

  const lib = await loadLib()
  guardNetwork(lib)

  let spent = 0
  let written = 0
  let failStreak = 0
  let stopped: string | null = null
  run: for (const u of units) {
    const w = worstCase(u.r)
    if (!affordable(spent, w, CAP)) {
      stopped = `before ${u.r.group} ${u.r.state} ${u.r.county}: its worst case $${w.toFixed(2)} could pass $${CAP}`
      break
    }
    const queue: Step[] = [...u.steps]
    let ladder: Ladder | null = null
    for (let step = queue.shift(); step; step = queue.shift()) {
      if (!affordable(spent, WORST[step], CAP)) {
        stopped = `inside ${u.r.group} ${u.r.state} ${u.r.county}: the next call could pass $${CAP}`
        break run
      }
      const p = planned(lib, u.r, step, gate, ladder)
      current = []
      const t0 = Date.now()
      let result: unknown = null
      let thrown: string | null = null
      try {
        result = await p.run()
      } catch (e) {
        thrown = e instanceof Error ? e.message : String(e)
      }
      const raw: Exchange[] = current ?? []
      current = null
      const cost = spendFrom(raw)
      spent = round2(spent + cost.dollars)
      const rec: CallRecord = {
        group: u.r.group, id: u.r.parcel_uid, state: u.r.state, fips: u.r.fips, county: u.r.county,
        property_type: u.r.property_type, has_city: u.r.has_city, step,
        owner_name: u.r.owner_name, match_name: p.match_name, sent_name: p.sent_name,
        ms: Date.now() - t0, dollars: cost.dollars, credits: cost.credits, credits_inferred: cost.inferred,
        thrown, result, raw,
      }
      appendFileSync(OUT, JSON.stringify(rec) + '\n')
      written++
      if (step === 'full_property') {
        const next = ladderAfter(lib, u.r, result)
        if (next) {
          ladder = next.ladder
          queue.push(...next.steps)
        }
      }
      // No names or addresses on the terminal.
      const statuses = raw.map((x) => x.status ?? 'ERR').join(',') || 'not sent'
      console.log(`${u.r.group} ${step} ${u.r.state} ${u.r.county} ${u.r.property_type}: status ${statuses}, $${cost.dollars.toFixed(2)}, total $${spent.toFixed(2)}`)
      const failed = thrown !== null || raw.some((x) => x.status === null || x.status === 429 || x.status === 401 || x.status === 402 || x.status === 403 || x.status >= 500)
      failStreak = failed ? failStreak + 1 : 0
      // GATE A question 11: (a) stop here and record the stop point, (b) carry on, every failure recorded as failed.
      if (gate.stop_after_three_failures && failStreak >= 3) {
        stopped = `after three calls in a row failed at the vendor or in transport; the stop point is line ${written} of calls.jsonl (${u.r.group} ${step} ${u.r.state} ${u.r.county})`
        break run
      }
      await sleep(300)
    }
  }
  console.log(stopped ? `STOPPED ${stopped}. Spent $${spent.toFixed(2)} of $${CAP}. Ask David.` : `DONE. Spent $${spent.toFixed(2)} of $${CAP}.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

- [ ] **Step 2: Type-check the phase0 scripts**

The repo tsconfig excludes `tasks/research-scripts`, and `tsx` does not type-check, so check them against a
throwaway config that extends the repo's (`typeRoots` is absolute because the config lives outside the repo;
without it `node:` imports do not resolve):

```bash
T=$(mktemp -d) && cat > $T/tsconfig.json <<'EOF'
{
  "extends": "/Users/davidmonroe/PropTracerPRO/tsconfig.json",
  "compilerOptions": {
    "noEmit": true, "incremental": false, "plugins": [],
    "typeRoots": ["/Users/davidmonroe/PropTracerPRO/node_modules/@types"]
  },
  "include": ["/Users/davidmonroe/PropTracerPRO/tasks/research-scripts/phase0/*.ts"],
  "exclude": []
}
EOF
npx tsc --noEmit -p $T/tsconfig.json; echo "tsc exit $?"; rm -rf $T
```

Expected: no errors, `tsc exit 0`.

- [ ] **Step 3: Run `--plan`**

Run: `npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --plan`
Expected: a JSON block with `calls`, `by_group_step`, `worst_by_group`, `g3_ladder`, `name_order_addon`
(records not above the cap), `street_format`, `stop_after_three_failures`, `counties` and
`worst_case_dollars` equal to the builder's,
then `PLAN ONLY. Nothing was called.` Under question 7 (b), `calls` counts only the planned calls; the ladder
calls are decided live but are already inside `worst_case_dollars`. Confirm `tasks/research-test/phase0/calls.jsonl`
does not exist.

- [ ] **Step 4: Confirm `--live` refuses before GATE B**

This check cannot spend in any state. The runner tests `--max-dollars` above 0 before it reads `gate-b.json`,
so `--max-dollars=0` is refused whether or not that file exists. And the command STOPS before the runner
starts if a `gate-b.json` is already there, because one must not exist before GATE B:

```bash
test ! -e tasks/research-test/phase0/gate-b.json || { echo "STOP: gate-b.json exists before GATE B; ask David"; exit 1; }
npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --live --max-dollars=0; echo "exit $?"
```

Expected: the plan block, then `--live needs --max-dollars=<n> with n above 0`, `exit 2`, and no
`calls.jsonl`. A `STOP: gate-b.json exists` line is a STOP for David.

- [ ] **Step 5: History entry and commit**

```markdown
## 2026-09-2X (letter): Tier 1 Phase 0, Task 5. Runner built, plan mode only; awaiting GATE B.

- Calls go through the production clients (lookupPersonTrace, lookupBusinessTrace, and for no-owner
  records planRoute + executeRoute), and every vendor request and response is written on the call's line.
- --plan: <calls> calls, worst case $<X> (G1 $<X>, G2 $<X>, G3 $<X>, G4 $<X>). --live refuses without
  David's GATE B amount. Nothing spent.
```

Tick `Selector, builder, runner (--plan only)` under Phase 0 in `tasks/todo.md`.

```bash
git add tasks/research-scripts/phase0/run-phase0.ts History.md tasks/todo.md
git commit -m "research(phase0): runner with raw capture, plan mode by default" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: GATE B. STOP. David names the amount**

Show David, from Step 3 and Tasks 3 and 4: calls by group and step, the worst case by group and in total,
the counties, the full county counts, his GATE A answers as the scripts read them, and every builder `note:`
or `street_still_contains_city` entry.
Tell him one fact about the runner: it works through the sample in order (G1, then G2, G3, G4) and stops
before any record whose worst case could pass the amount, so an amount below the worst case cuts the last
groups first. Do not continue until he names a dollar amount. No `--live` before that.

---

### Task 6: Live run (after GATE B)

**Files:**
- Create by hand (gitignored): `tasks/research-test/phase0/gate-b.json`
- Output (gitignored): `tasks/research-test/phase0/calls.jsonl`, `tasks/research-test/phase0/balance.jsonl`

**Interfaces:**
- Consumes: the Task 5 runner, `sample.json`.
- Produces: `calls.jsonl` and `balance.jsonl` for Task 7.

- [ ] **Step 1: Record David's amount**

Write `tasks/research-test/phase0/gate-b.json` (does not parse until every `<...>` is replaced):

```json
{ "approved_dollars": <the amount David named>, "answered_by": "David", "answered_at": "<YYYY-MM-DD>", "david_words": "<his answer, verbatim>" }
```

- [ ] **Step 2: Confirm the runner refuses anything above it**

A refusal check, before any network call.
Run: `npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --live --max-dollars=<approved plus 1>`
Expected: `--live needs --max-dollars=<n>, 0 < n <= <approved> (the amount David approved)`, exit code 2, no
`calls.jsonl`.

- [ ] **Step 3: Record the Tracerfy credit balance before**

Run: `npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --balance`
Expected: one JSON line with `success: true` and a numeric `balance`, also appended to `balance.jsonl`.

- [ ] **Step 4: Run live with David's amount**

Run: `npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --live --max-dollars=<the amount David approved>`
Expected: one line per call (group, step, state, county, property type, status, dollars, running total;
never a name), ending `DONE. Spent $X of $<amount>.` with X at or under the amount. A line starting
`STOPPED` (cap reached, or three failures in a row) is a STOP: record where it stopped and ask David; do not
re-run (the runner refuses while `calls.jsonl` exists, because a re-run re-buys every call).

- [ ] **Step 5: Confirm the output is complete**

Run: `wc -l tasks/research-test/phase0/calls.jsonl`
Expected: equal to `calls` from `--plan`, unless the run printed `STOPPED`; if it stopped, record how many
calls ran.

- [ ] **Step 6: Record the balance after and cross-check**

Run: `npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --balance`
Then: `node -e "const r=require('fs').readFileSync('/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0/calls.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);console.log({calls:r.length,credits:r.reduce((s,x)=>s+x.credits,0),dollars:Math.round(r.reduce((s,x)=>s+x.dollars,0)*100)/100,inferred:r.filter(x=>x.credits_inferred).length})"`
Expected: the drop in `balance` between the two `balance.jsonl` lines equals `credits` (both are Tracerfy
credits). A difference is reported to David as measured, never adjusted.

- [ ] **Step 7: History entry and commit**

```markdown
## 2026-09-2X (letter): Tier 1 Phase 0, Task 6. Live run.

- David's GATE B answer, verbatim: "<david_words>". Approved $<X>.
- <N> calls, spent $<X> (Tracerfy <N> credits, FastAppend $<X>); Tracerfy balance moved <N> credits.
  <DONE, or where it stopped and why>.
```

Tick `GATE B` under Phase 0 in `tasks/todo.md`.

```bash
git add History.md tasks/todo.md
git status --short tasks/research-test   # must print nothing
git commit -m "docs: Phase 0 live run recorded" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Analyze, report, GATE C

**Files:**
- Create: `tasks/research-scripts/phase0/analyze.ts`
- Create: `tasks/phase0-tier1-measurement.md` (committed, counts only, no names or addresses)
- Modify: `tasks/todo.md` (review section), `History.md`

**Interfaces:**
- Consumes: `gate-a.json`, `gate-b.json`, `sample.json`, `calls.jsonl`, `balance.jsonl`, `county-counts.json`;
  `personMatchesOwner`, `MatchKind` (Task 2); `contactVendorFrom(steps: StepReport[]): ContactVendor | null`,
  `ContactResult`, `ExecutionResult` (lib/routing/executeRoute.ts:194, :69, :130); `shared.ts`.
- Produces: the report David reviews at GATE C.

- [ ] **Step 1: Write the analyzer**

`tasks/research-scripts/phase0/analyze.ts`:

```ts
// Run: npx tsx tasks/research-scripts/phase0/analyze.ts
/**
 * Phase 0 report. Reads the gitignored run output, writes tasks/phase0-tier1-measurement.md with
 * COUNTS ONLY. Every person lookup is judged from the RAW vendor response with personMatchesOwner,
 * never through the production parser's persons[0] fallback (client.ts:602). Refuses to write the
 * report if any sampled name, street or parcel id, or any name or address a vendor returned,
 * appears in it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { contactVendorFrom, type ContactResult, type ExecutionResult } from '../../../lib/routing/executeRoute'
import { personMatchesOwner, type MatchKind } from './match'
import {
  DIR, correctedOrder, plannedSteps, readGateA, readJson, rotation, round2, street,
  type CallRecord, type Exchange, type GateB, type Sample, type SampleRecord, type Step,
} from './shared'

const REPORT = '/Users/davidmonroe/PropTracerPRO/tasks/phase0-tier1-measurement.md'
const gate = readGateA()
const gateB = readJson<GateB>(`${DIR}/gate-b.json`)
const sample = readJson<Sample>(`${DIR}/sample.json`)
const recs: CallRecord[] = readFileSync(`${DIR}/calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CallRecord)
type Counts = { group: string; state: string; county: string; totals: Record<string, number> }
const countyCounts: Counts[] = existsSync(`${DIR}/county-counts.json`) ? readJson<Counts[]>(`${DIR}/county-counts.json`) : []

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const bodyOf = (ex: Exchange | undefined): Obj | null => {
  const b = Array.isArray(ex?.response_body) ? (ex!.response_body as unknown[])[0] : ex?.response_body
  return isObj(b) ? b : null
}
const personsOf = (b: Obj | null): Obj[] => (b && Array.isArray(b.persons) ? b.persons.filter(isObj) : [])
const contactCount = (p: Obj): number => (Array.isArray(p.phones) ? p.phones.length : 0) + (Array.isArray(p.emails) ? p.emails.length : 0)
const endpoint = (ex: Exchange): string =>
  ex.host === 'app.fastappend.com' ? 'fastappend'
  : ex.path.endsWith('property-search/lookup/') ? 'dossier'
  : ex.path.endsWith('trace/parcel/lookup/') ? 'apn'
  : ex.path.endsWith('trace/lookup/') ? 'instant'
  : ex.path

/** One Tracerfy person answer, judged the way Phase 1 will judge it: a returned person must match the owner. */
type Judged = { cls: string; kind: MatchKind; flagged: boolean; contacts: number }
function judgePerson(ex: Exchange | undefined, owner: string): Judged {
  const none = (cls: string): Judged => ({ cls, kind: null, flagged: false, contacts: 0 })
  if (!ex) return none('not_sent')
  if (ex.status === null) return none('transport_error')
  if (ex.status !== 200) return none(`http_${ex.status}`)
  const b = bodyOf(ex)
  if (!b || typeof b.hit !== 'boolean') return none('malformed')
  if (!b.hit) return none('miss')
  for (const p of personsOf(b)) {
    const kind = personMatchesOwner(p, owner)
    if (kind) return { cls: `matched_${kind}`, kind, flagged: p.property_owner === true, contacts: contactCount(p) }
  }
  return none('billed_unmatched')
}
const NOT_RUN: Judged = { cls: 'not_run', kind: null, flagged: false, contacts: 0 }
const callOf = (id: string, step: Step): CallRecord | undefined => recs.find((r) => r.id === id && r.step === step)
const judgeStep = (id: string, step: Step, owner: string): Judged => {
  const c = callOf(id, step)
  return c ? judgePerson(c.raw.find((x) => x.host === 'tracerfy.com'), owner) : NOT_RUN
}
const found = (j: Judged): boolean => j.kind !== null
const withContact = (j: Judged): boolean => j.kind !== null && j.contacts > 0

const tally = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})
const fmt = (m: Record<string, number>): string => Object.entries(m).sort().map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
const pct = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0
}
const of = (g: SampleRecord['group']) => sample.records.filter((r) => r.group === g)
const cell = (s: string) => s.replace(/\|/g, '/')
const TYPE_ORDER = rotation(gate.extra_property_types, sample.records.map((r) => r.property_type)).filter((t) =>
  sample.records.some((r) => r.property_type === t))

const lines: string[] = [
  '# Phase 0: Tier 1 measurement',
  '',
  `Run ${new Date().toISOString().slice(0, 10)}. Counts only; every raw request and response is in tasks/research-test/phase0/ (gitignored).`,
  `GATE A (${gate.answered_at}): ${gate.records_per_county} records per county, ${gate.g1_no_city_per_county} of them without a city where the county has them; name-order add-on cap ${gate.name_order_addon_cap}; street format ${gate.street_format}; G3 trust ladder ${gate.g3_trust_ladder ? 'on' : 'off'}; types ${gate.extra_property_types ? 'all' : 'the six'}; trusts without an APN ${gate.g2_trusts_without_apn ? 'allowed' : 'excluded'}; ESTATE OF names ${gate.g2_estate_of}d; after three failures in a row the run ${gate.stop_after_three_failures ? 'stops' : 'continues'}.`,
  `Sample: G1 ${of('G1').length} individual owners, G2 ${of('G2').length} trusts, G3 ${of('G3').length} no-owner parcels, G4 ${of('G4').length} probes. Calls recorded: ${recs.length}.`,
  '',
]

// ---- County fill, full counts (the shortlist figures were a storage-order sample). ----
if (countyCounts.length) {
  lines.push('## County fill (full counts before sampling)', '', '| Group | County | Parcels | No city | No owner | With APN |', '|---|---|---|---|---|---|')
  for (const c of countyCounts) {
    const t = c.totals
    const p = (k: string) => `${((100 * (t[k] ?? 0)) / (t.parcels || 1)).toFixed(1)}%`
    lines.push(`| ${c.group} | ${c.state} ${c.county} | ${t.parcels} | ${p('no_city')} | ${p('no_owner')} | ${p('with_apn')} |`)
  }
  lines.push('')
}

// ---- Q1. Individual owners: Instant vs APN, per county and per property type. ----
type G1Row = { r: SampleRecord; instant: Judged; apn: Judged; swapped: Judged }
const g1: G1Row[] = of('G1').map((r) => ({
  r,
  instant: r.has_city ? judgeStep(r.parcel_uid, 'instant', r.owner_name ?? '') : NOT_RUN,
  apn: judgeStep(r.parcel_uid, 'apn', r.owner_name ?? ''),
  swapped: r.addon ? judgeStep(r.parcel_uid, 'instant_swapped', r.owner_name ?? '') : NOT_RUN,
}))
lines.push(
  '## Q1. Individual owners (G1): does the APN lookup find the named owner?', '',
  'Every record got the APN lookup; records with a city also got the Instant lookup. "Found" = a returned person matched the owner name (natural or swapped order).', '',
  '| County | n | city / no city | Instant | APN | Found by any lookup | APN found, Instant missed | Found, no-city records | Found with a phone or email |',
  '|---|---|---|---|---|---|---|---|---|',
)
for (const c of gate.g1_counties) {
  const rows = g1.filter((x) => x.r.fips === c.fips)
  const city = rows.filter((x) => x.r.has_city)
  const noCity = rows.filter((x) => !x.r.has_city)
  const foundAny = (x: G1Row) => found(x.instant) || found(x.apn) || found(x.swapped)
  lines.push(`| ${c.state} ${c.county} | ${rows.length} | ${city.length} / ${noCity.length} | ${fmt(tally(city.map((x) => x.instant.cls)))} | ${fmt(tally(rows.map((x) => x.apn.cls)))} | ${rows.filter(foundAny).length} | ${city.filter((x) => !found(x.instant) && found(x.apn)).length} | ${noCity.filter((x) => found(x.apn)).length} of ${noCity.length} | ${rows.filter((x) => withContact(x.instant) || withContact(x.apn) || withContact(x.swapped)).length} |`)
}
lines.push('', '| Property type | n | Found by any lookup | APN found | Instant found |', '|---|---|---|---|---|')
for (const t of TYPE_ORDER) {
  const rows = g1.filter((x) => x.r.property_type === t)
  if (rows.length) lines.push(`| ${t} | ${rows.length} | ${rows.filter((x) => found(x.instant) || found(x.apn) || found(x.swapped)).length} | ${rows.filter((x) => found(x.apn)).length} | ${rows.filter((x) => found(x.instant)).length} |`)
}
const matched = g1.flatMap((x) => [x.instant, x.apn, x.swapped]).filter(found)
lines.push('', `Matched people flagged property_owner by Tracerfy: ${matched.filter((j) => j.flagged).length} of ${matched.length}.`, '')

// ---- Q2. What an unrecognized APN returns. ----
lines.push('## Q2. Unrecognized APN (G4, a parcel id that exists nowhere)', '', '| State | HTTP status | hit | persons_count | credits_deducted | Top-level keys | Message |', '|---|---|---|---|---|---|---|')
for (const r of recs.filter((x) => x.group === 'G4')) {
  const ex = r.raw[0]
  const b = bodyOf(ex)
  // Never print a body that found people: it would carry names.
  const msg = b && b.hit !== true ? [b.error, b.detail, b.message].find((v): v is string => typeof v === 'string') : undefined
  lines.push(`| ${r.state} | ${ex?.status ?? 'not sent'} | ${String(b?.hit ?? '-')} | ${String(b?.persons_count ?? '-')} | ${String(b?.credits_deducted ?? '-')} | ${b ? Object.keys(b).sort().join(' ') : '(no JSON body)'} | ${msg ? cell(msg.slice(0, 120)) : ''} |`)
}
lines.push('')

// ---- Q3. Name order, per county. ----
lines.push(
  '## Q3. Name order (D18)', '',
  '"Two-word" = exactly two words once suffixes are dropped, the shape splitPersonName reads as FIRST LAST. "Swapped" = the person matched only with the registry name read the other way round.', '',
  `Add-on cap set at GATE A: ${gate.name_order_addon_cap}.`, '',
  '| County | Stored order (shortlist) | n | Two-word names | Instant matches | APN matches | Add-on calls | Add-on found the owner | Add-on found, default Instant missed |',
  '|---|---|---|---|---|---|---|---|---|',
)
for (const c of gate.g1_counties) {
  const rows = g1.filter((x) => x.r.fips === c.fips)
  const two = rows.filter((x) => correctedOrder(x.r.owner_name ?? '') !== null).length
  const kinds = (js: Judged[]) => fmt(tally(js.filter(found).map((j) => j.kind!)))
  const add = rows.filter((x) => x.r.addon)
  lines.push(`| ${c.state} ${c.county} | ${c.name_order} | ${rows.length} | ${two} | ${kinds(rows.map((x) => x.instant))} | ${kinds(rows.map((x) => x.apn))} | ${add.length} | ${add.filter((x) => found(x.swapped)).length} | ${add.filter((x) => found(x.swapped) && !found(x.instant)).length} |`)
}
lines.push('')

// ---- Q4. Trusts. ----
function judgeFastAppend(c: CallRecord | undefined): string {
  if (!c) return 'not_run'
  const res = c.result as ContactResult | null
  if (!res || !res.success) return 'failed'
  if (!res.hit) return 'miss'
  return (res.contacts?.phones.length ?? 0) + (res.contacts?.emails.length ?? 0) > 0 ? 'hit_with_contact' : 'hit_no_contact'
}
const g2 = of('G2').map((r) => {
  const owner = r.stripped ?? ''
  const steps = plannedSteps(r)
  const instant = steps.includes('instant') ? judgeStep(r.parcel_uid, 'instant', owner) : NOT_RUN
  const apn = steps.includes('apn') ? judgeStep(r.parcel_uid, 'apn', owner) : NOT_RUN
  return { r, steps, instant, apn, fa: judgeFastAppend(callOf(r.parcel_uid, 'fastappend')) }
})
const half = g2.filter((x) => x.r.person_half)
const d16 = g2.filter((x) => !x.r.person_half)
const personFound = (x: (typeof g2)[number]) => found(x.instant) || found(x.apn)
lines.push(
  '## Q4. Trusts (G2)', '',
  `n = ${g2.length}. Kept a first name or initial (person half ran, then FastAppend): ${half.length}. Went straight to FastAppend under D16: ${d16.length}.`,
  `- Trusts without an APN: ${g2.filter((x) => !x.r.parcel_id_local?.trim()).length}. "ESTATE OF" names: ${g2.filter((x) => /\bESTATE OF\b/i.test(x.r.owner_name ?? '')).length}.`,
  `- Person half, Instant: ${fmt(tally(half.filter((x) => x.steps.includes('instant')).map((x) => x.instant.cls)))}.`,
  `- Person half, APN: ${fmt(tally(half.filter((x) => x.steps.includes('apn')).map((x) => x.apn.cls)))}.`,
  `- FastAppend on the full name, person-half trusts: ${fmt(tally(half.map((x) => x.fa)))}.`,
  `- FastAppend, D16 trusts: ${fmt(tally(d16.map((x) => x.fa)))}.`,
  `- Found by the person half: ${half.filter(personFound).length} of ${half.length}. Found only by FastAppend (person half missed, FastAppend returned a contact): ${half.filter((x) => !personFound(x) && x.fa === 'hit_with_contact').length}.`,
  '',
)

// ---- Q5. No owner on record (G3), by property type. ----
const g3 = of('G3').map((r) => {
  const c = callOf(r.parcel_uid, 'full_property')
  const ex = (c?.result ?? null) as ExecutionResult | null
  if (!c || !ex || !Array.isArray(ex.steps)) return { r, ran: Boolean(c), ex: null, key: 'none', vendor: 'none', prod: 0, named: NOT_RUN }
  const hitStep = ex.steps.find((s) => (s.kind === 'DOSSIER_APN' || s.kind === 'DOSSIER_ADDRESS') && s.outcome === 'hit')
  const vendor = contactVendorFrom(ex.steps) ?? 'none'
  const pass2 = c.raw.find((x) => x.host === 'tracerfy.com' && /trace\/(parcel\/)?lookup\/$/.test(x.path))
  return {
    r, ran: true, ex,
    key: hitStep ? (hitStep.kind === 'DOSSIER_APN' ? 'APN key' : 'address key') : 'none',
    vendor,
    prod: (ex.contacts?.phones.length ?? 0) + (ex.contacts?.emails.length ?? 0),
    // D6/D15: the second Tracerfy lookup counts only if a returned person matches the dossier's owner.
    named: vendor === 'tracerfy' ? judgePerson(pass2, ex.ownerName ?? '') : NOT_RUN,
  }
})
lines.push(
  '## Q5. No owner on record (G3), through production planRoute + executeRoute', '',
  'The Tracerfy columns cover ONLY the records whose second lookup went to Tracerfy (an individual owner), so both contact counts are over the same records. "Production parser" = what today\'s parser returned (it falls back to persons[0], client.ts:602). "Name-matched" = the raw Tracerfy answer judged against the owner the dossier found (D6, D15). FastAppend entity results (D14) are on their own line below.', '',
  '| Property type | n | Dossier hit (key) | Owner found | Owner type | Second lookup | Tracerfy second lookups | Tracerfy: production parser returned a contact | Tracerfy: name-matched with a phone or email | Tracerfy: billed, no name match | Manual review | Failed |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
)
for (const t of [...TYPE_ORDER, 'all']) {
  const rows = g3.filter((x) => t === 'all' || x.r.property_type === t)
  if (!rows.length) continue
  const done = rows.filter((x) => x.ex)
  const tr = done.filter((x) => x.vendor === 'tracerfy')
  lines.push(`| ${t} | ${rows.length} | ${fmt(tally(done.filter((x) => x.key !== 'none').map((x) => x.key)))} | ${done.filter((x) => x.ex!.ownerFound).length} | ${fmt(tally(done.filter((x) => x.ex!.ownerFound).map((x) => x.ex!.ownerType)))} | ${fmt(tally(done.map((x) => x.vendor)))} | ${tr.length} | ${tr.filter((x) => x.prod > 0).length} | ${tr.filter((x) => withContact(x.named)).length} | ${tr.filter((x) => x.named.cls === 'billed_unmatched').length} | ${done.filter((x) => x.ex!.needsManualReview).length} | ${done.filter((x) => !x.ex!.success).length + rows.filter((x) => !x.ran || !x.ex).length} |`)
}
// D14: an entity owner's second lookup is FastAppend only; no name test applies to a principal.
const fa = g3.filter((x) => x.ex && x.vendor === 'fastappend')
const faStep = (x: (typeof g3)[number]) => x.ex!.steps.find((st) => st.kind === 'FASTAPPEND_ENTITY')?.outcome ?? 'none'
lines.push('', `FastAppend second lookups (entity owners, D14): ${fa.length}. Outcome: ${fmt(tally(fa.map(faStep)))}. With a phone or email: ${fa.filter((x) => x.prod > 0).length}.`, '')
// Question 7 (b) only: the D3/D16 ladder on dossier owners that are a trust or an unreadable name.
const g3Ladder = of('G3').filter((r) => callOf(r.parcel_uid, 'ladder_fastappend')).map((r) => {
  const person = callOf(r.parcel_uid, 'ladder_apn')?.match_name ?? callOf(r.parcel_uid, 'ladder_instant')?.match_name ?? null
  const instant = person ? judgeStep(r.parcel_uid, 'ladder_instant', person) : NOT_RUN
  const apn = person ? judgeStep(r.parcel_uid, 'ladder_apn', person) : NOT_RUN
  return { personHalf: Boolean(person), instant, apn, fa: judgeFastAppend(callOf(r.parcel_uid, 'ladder_fastappend')) }
})
const trustish = g3.filter((x) => x.ex?.ownerFound && (x.ex.ownerType === 'trust' || x.ex.ownerType === 'unknown')).length
if (gate.g3_trust_ladder) {
  lines.push(
    `Ladder on dossier owners that are a trust or unreadable (question 7 (b)): ${trustish} such owners, ladder ran on ${g3Ladder.length}. ` +
    `Person half: ${g3Ladder.filter((x) => x.personHalf).length} (Instant ${fmt(tally(g3Ladder.filter((x) => x.personHalf).map((x) => x.instant.cls)))}; ` +
    `APN ${fmt(tally(g3Ladder.filter((x) => x.personHalf).map((x) => x.apn.cls)))}). FastAppend: ${fmt(tally(g3Ladder.map((x) => x.fa)))}. ` +
    `Found only by FastAppend: ${g3Ladder.filter((x) => !found(x.instant) && !found(x.apn) && x.fa === 'hit_with_contact').length}.`, '')
} else {
  lines.push(`Dossier owners that are a trust or unreadable (question 7 (a), production only, no second lookup): ${trustish}.`, '')
}

// ---- Q6. Latency. ----
lines.push('## Q6. Latency per lookup (ms, answered calls only)', '')
const exs = recs.flatMap((r) => r.raw).filter((x) => x.status !== null)
for (const ep of ['instant', 'apn', 'dossier', 'fastappend']) {
  // Every exchange on that endpoint, whichever group or step made it.
  const ms = exs.filter((x) => endpoint(x) === ep).map((x) => x.ms)
  if (ms.length) lines.push(`- ${ep}: n ${ms.length}, p50 ${pct(ms, 0.5)}, p90 ${pct(ms, 0.9)}`)
}
const fp = recs.filter((r) => r.step === 'full_property').map((r) => r.ms)
if (fp.length) lines.push(`- whole no-owner record (dossier plus second lookup): n ${fp.length}, p50 ${pct(fp, 0.5)}, p90 ${pct(fp, 0.9)}`)
lines.push('')

// ---- Q7. Spend. ----
const total = round2(recs.reduce((s, r) => s + r.dollars, 0))
const credits = recs.reduce((s, r) => s + r.credits, 0)
const bal = existsSync(`${DIR}/balance.jsonl`)
  ? readFileSync(`${DIR}/balance.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { at: string; success: boolean; balance: number | null })
  : []
const okBal = bal.filter((b) => b.success && typeof b.balance === 'number')
lines.push(
  '## Q7. Spend', '',
  `- Approved at GATE B: $${gateB.approved_dollars.toFixed(2)}. Spent: $${total.toFixed(2)} across ${recs.length} calls.`,
  `- Tracerfy: ${credits} credits ($${round2(credits * 0.02).toFixed(2)}); ${recs.filter((r) => r.credits_inferred).length} calls billed a hit with no credits_deducted field (counted at the documented rate). FastAppend: $${round2(total - credits * 0.02).toFixed(2)}.`,
  okBal.length >= 2
    ? `- Tracerfy credit balance (analytics/) before ${okBal[0].balance}, after ${okBal[okBal.length - 1].balance}: ${round2(okBal[0].balance! - okBal[okBal.length - 1].balance!)} credits used, against ${credits} counted from the raw responses.`
    : '- Tracerfy credit balance: not recorded before and after the run.',
  '',
)

// ---- PII check: nothing sampled or bought may appear in a committed file. ----
const text = lines.join('\n') + '\n'
const needles = new Set<string>()
// Two words or more: a lone surname could collide with a county or a column word and block a clean report.
const add = (s: unknown) => {
  const t = typeof s === 'string' ? s.trim().toUpperCase().replace(/\s+/g, ' ') : ''
  if (t.length >= 6 && t.includes(' ') && /[A-Z]/.test(t)) needles.add(t)
}
for (const r of sample.records) {
  if (r.group === 'G4') continue
  add(r.owner_name)
  add(r.stripped)
  add(street(r.site_address))
  add(r.site_address)
  const pid = (r.parcel_id_local ?? '').trim().toUpperCase()
  if (pid.replace(/[^A-Z0-9]/g, '').length >= 8) needles.add(pid)
}
function walk(v: unknown): void {
  if (Array.isArray(v)) v.forEach(walk)
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && /name|street|address/i.test(k)) add(x)
      else walk(x)
    }
    if (typeof v.first_name === 'string' && typeof v.last_name === 'string') add(`${v.first_name} ${v.last_name}`)
  }
}
for (const r of recs) {
  add(r.match_name)
  if (r.sent_name) add(`${r.sent_name.first_name} ${r.sent_name.last_name}`)
  for (const x of r.raw) walk(x.response_body)
}
const upper = text.toUpperCase()
const leaks = [...needles].filter((n) => upper.includes(n)).length
if (leaks) {
  console.error(`PII CHECK FAILED: ${leaks} sampled or vendor-returned strings appear in the report. Not written.`)
  process.exit(1)
}
writeFileSync(REPORT, text)
console.log(text)
```

- [ ] **Step 2: Type-check**

Run the Task 5 Step 2 block again. Expected: `tsc exit 0`.

- [ ] **Step 3: Run it**

Run: `npx tsx tasks/research-scripts/phase0/analyze.ts`
Expected: the report prints and `tasks/phase0-tier1-measurement.md` is written. `PII CHECK FAILED` means a
sampled or vendor-returned name, street or parcel id reached the report: fix the section that printed it;
never weaken the check.

- [ ] **Step 4: Check the report carries no personal data**

Run: `grep -c -i -E "[0-9]+ [A-Z]+ (ST|AVE|RD|DR|LN|CT|BLVD|WAY|HWY)" tasks/phase0-tier1-measurement.md`
Expected: `0`. Then read the Q2 message column by eye.

- [ ] **Step 5: History entry and commit**

```markdown
## 2026-09-2X (letter): Tier 1 Phase 0, Task 7. Measurement report written.

- tasks/phase0-tier1-measurement.md, counts only: APN vs Instant per county, the unrecognized-APN answer,
  name order per county, the trust ladder, the no-owner path by property type, latency, spend.
- Person answers judged from the raw responses with the name test, never the persons[0] fallback.
```

Tick `Live run, analysis, report` under Phase 0 in `tasks/todo.md`.

```bash
git add tasks/research-scripts/phase0/analyze.ts tasks/phase0-tier1-measurement.md History.md tasks/todo.md
git status --short tasks/research-test   # must print nothing
git commit -m "research(phase0): Tier 1 measurement report" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: GATE C. STOP. Present the findings to David**

Bring David these questions, each with its numbers from the report. No Phase 1 plan until he has decided
each one.
1. Does the APN lookup find the named owner on individually owned parcels, and does it find owners Instant
   missed, including on parcels with no city (Q1)? This decides whether the APN step stays in the
   individual route and in what order (D2).
2. What does an unrecognized APN return (Q2)? This decides how spec 4.3 classifies it and whether a sentence
   may say "not recognized" (7.1).
3. Name order, per county: how many two-word names, how many matched only in the swapped order, and the
   add-on result if it ran (Q3). This sizes the D18 fix.
4. Trusts: the person half against the FastAppend half, how many went straight to FastAppend under D16, and
   (per his GATE A answers) the trusts without an APN and the "ESTATE OF" names (Q4). A half that never
   finds anyone comes out of the ladder.
5. No owner on record, by property type: dossier hit, owner found, owner type, which vendor the second
   lookup went to, and, on the same Tracerfy-only records, name-matched contacts against the production
   parser's contacts; FastAppend entity results on their own line (Q5). Include how many
   owners came back as a trust or an unclassifiable name, which production sends to manual review today,
   and, if GATE A question 7 was (b), what the ladder found for them.
6. Latency p50 and p90 per step (Q6), which sizes the Tier 1 cron batch and confirms or corrects the 2 to 5
   minute estimate (spec 3.2).
7. Spend against the approved amount, and the Tracerfy balance change (Q7).

- [ ] **Step 7: Review section**

After David's answers: add a `## Phase 0 review` section under the Tier 1 heading in `tasks/todo.md` (what
ran, what it cost, where the report is, David's decision on each GATE C question in his words, and which
spec decisions it confirms or overturns), tick `GATE C` and the Phase 0 box, add the History.md entry, and
commit:

```bash
git add tasks/todo.md History.md
git commit -m "docs: Phase 0 review and David's GATE C decisions" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Then update the spec with David's decisions on each point, and only after that write the Phase 1 plan.
