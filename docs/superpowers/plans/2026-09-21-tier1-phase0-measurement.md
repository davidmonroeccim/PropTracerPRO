# Tier 1 through planRoute, Phase 0 (paid measurement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, on live vendor calls, the facts the Tier 1 design rests on (APN lookup on individually
owned parcels, name matching, name order, unrecognized-APN response, latency, the trust ladder, the
multifamily county-record fallback) so Phases 1 to 4 are planned on evidence.

**Architecture:** Five throwaway research scripts under `tasks/research-scripts/phase0/`, following the
existing research-script pattern (absolute `.env.local`, host allowlist, `--live` gate, hard spend cap,
raw output only under the gitignored `tasks/research-test/`). A Python selector reads the property
registry (owners) and MPS (multifamily addresses only), a TypeScript builder classifies with the
production classifier and fixes the sample, a runner makes the calls, an analyzer writes a PII-free report.
No production code changes.

**Tech Stack:** Python 3 + psycopg2 (read-only DB access), TypeScript run with `npx tsx --env-file=.env.local`,
production modules imported from `lib/` (classifier, name splitter, planRoute/executeRoute, vendor clients).

**Spec:** `docs/superpowers/specs/2026-09-21-tier1-planroute-design.md` (Section 10, Phase 0; Sections 4 and 13
say what the measurement must answer).

## Global Constraints

- Spend cap: at most **$15** for the whole phase. `--plan` prints every call and the worst-case spend with no
  network; `--live` refuses to run without `--max-dollars=<n>` and `n <= 15`.
- **STOP for David's approval of the printed plan and spend before any `--live` run.**
- Vendor prices (verified 2026-09-16 against the ledgers, ownerRoute.ts:6-12): Tracerfy credit $0.02;
  trace/lookup/ and trace/parcel/lookup/ 5 credits ($0.10) per hit; property-search/lookup/ (county record)
  10 credits ($0.20) per hit; FastAppend business-trace/lookup/ $0.10 per hit. Misses are free on all four.
- Databases are read-only: `set default_transaction_read_only = on` / `readonly=True`, `statement_timeout`
  on every session.
- Registry (4GB box): one county at a time; scope every query on `county_fips`; **never range-scan or
  LIKE on `parcel_uid`** (collation returns another county's rows); fetch uids first, then rows by
  `parcel_uid = any(...)`.
- Owner names come **only from the registry**, never from MPS (spec D11). The MPS query must not select any
  `owner_*` column.
- Raw responses and anything carrying a name or address go only to `tasks/research-test/phase0/`
  (gitignored, `.gitignore:45`). The committed report carries counts only.
- Secondary and tertiary counties only; no primary metros.
- Each script installs a fetch host allowlist (`tracerfy.com`, `app.fastappend.com`) and refuses to run if
  `TRACERFY_API_URL` points anywhere but `tracerfy.com` (lib/constants.ts:118 honours that override, and a
  sandbox URL would return fake data).
- Copy in the report: no em dashes, no prices on free outcomes.
- Repo rules (CLAUDE.md): after EVERY completed task add a `History.md` entry (date, task name, bullet points)
  before starting the next; at the end add a review section to `tasks/todo.md`; never create fallback, fake or
  made-up data or results. A lookup that fails is recorded as failed, never filled in.

---

### Task 1: Correct the spec's APN request wording and track the plan

The spec says the APN request "carries the owner's first and last name". Tracerfy's parcel endpoint takes only
`parcel_id`, `county`, `state` (docs/vendor/tracerfy-api.md:1352-1356). The names travel with the step for
PropTracerPRO's parser and are never sent.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-tier1-planroute-design.md` (Section 4.2, person step 2)
- Modify: `tasks/todo.md` (new section at the top)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing code-level.

- [ ] **Step 1: Fix the spec sentence**

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

- [ ] **Step 2: Add the tracking section at the top of `tasks/todo.md`**

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

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-21-tier1-planroute-design.md tasks/todo.md docs/superpowers/plans/2026-09-21-tier1-phase0-measurement.md
git commit -m "docs: Phase 0 plan for Tier 1 routing; APN step names are not sent to Tracerfy"
```

---

### Task 2: Name-match prototype and spend guard

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

- [ ] **Step 1: Write the failing self-test**

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

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx tasks/research-scripts/phase0/selftest.ts`
Expected: FAIL, cannot find module `./match`.

- [ ] **Step 3: Implement `match.ts`**

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

- [ ] **Step 4: Implement `guard.ts`**

```ts
/** The Phase 0 spend guard. A call runs only if its WORST-CASE cost still fits under the cap. */
export function affordable(spentDollars: number, nextWorstCase: number, capDollars: number): boolean {
  return spentDollars + nextWorstCase <= capDollars + 1e-9
}
```

- [ ] **Step 5: Run the self-test to verify it passes**

Run: `npx tsx tasks/research-scripts/phase0/selftest.ts`
Expected: `phase0 selftest OK`

- [ ] **Step 6: Prove the refusal assertion is load-bearing**

Temporarily change the last line of `personMatchesOwner` from `return null` to `return 'natural'`, run the
self-test, confirm it FAILS on the `Mary Jones` assertion, then restore the line and confirm it passes again.

- [ ] **Step 7: Commit**

```bash
git add tasks/research-scripts/phase0/match.ts tasks/research-scripts/phase0/guard.ts tasks/research-scripts/phase0/selftest.ts
git commit -m "research(phase0): name-match prototype and spend guard with self-test"
```

---

### Task 3: Sample selector (registry owners, MPS multifamily addresses)

**Files:**
- Create: `tasks/research-scripts/phase0/select_samples.py`
- Output (gitignored): `tasks/research-test/phase0/candidates.json`, `tasks/research-test/phase0/mf_candidates.json`

**Interfaces:**
- Consumes: registry connection via `env()` in `/Users/davidmonroe/property-registry/worker/scripts/audit_city_key_is_postal.py`
  (reads that repo's `.env.local`: `PROJECT_REF`, `SUPABASE_DB_PASSWORD`); MPS via `MPS_READONLY_DB_URL` in
  `/Users/davidmonroe/suite-gateway/.env.local`.
- Produces, both JSON arrays:
  - `candidates.json`: `{parcel_uid, state, fips, county, owner_name, site_address, situs_city, situs_zip, parcel_id_local}`
  - `mf_candidates.json`: `{mps_id, state, fips, county, address, city, zip}` (no owner field)

- [ ] **Step 1: Write the selector**

```python
#!/usr/bin/env python3
"""Phase 0 sample selector. READ-ONLY against the property registry and MPS.

Owner names come ONLY from the registry (spec D11). MPS supplies street, city and ZIP for the
multifamily fallback sample and nothing else: no owner_* column is ever selected from it.

Run: python3 tasks/research-scripts/phase0/select_samples.py
"""
import json, os, random, re, sys, time
import psycopg2, psycopg2.extras

sys.path.insert(0, '/Users/davidmonroe/property-registry/worker/scripts')
import audit_city_key_is_postal as A  # env() only

OUT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0'
# (state, fips, bare county name as Tracerfy wants it). Two primaries plus one fallback per state,
# all secondary or tertiary markets. build-sample.ts takes the first two per state that qualify.
COUNTIES = [
    ('IN', '18003', 'Allen'), ('IN', '18039', 'Elkhart'), ('IN', '18163', 'Vanderburgh'),
    ('FL', '12127', 'Volusia'), ('FL', '12111', 'St. Lucie'), ('FL', '12009', 'Brevard'),
    ('TN', '47125', 'Montgomery'), ('TN', '47163', 'Sullivan'), ('TN', '47119', 'Maury'),
    ('WV', '54039', 'Kanawha'), ('WV', '54003', 'Berkeley'), ('WV', '54011', 'Cabell'),
    ('WI', '55009', 'Brown'), ('WI', '55073', 'Marathon'), ('WI', '55087', 'Outagamie'),
]
PER_COUNTY = 60      # candidates kept per county, random, before classification
MF_PER_COUNTY = 2    # multifamily properties the registry cannot find, per county
MIN_MF_MATCH_RATE = 0.30  # sanity: below this the address matcher, not the registry, is the problem


def norm_parcel(v):
    return re.sub(r'[^A-Z0-9]', '', (v or '').upper())


def registry():
    e = A.env()
    c = psycopg2.connect(host=f"db.{e['PROJECT_REF']}.supabase.co", port=5432, dbname='postgres',
                         user='postgres', password=e['SUPABASE_DB_PASSWORD'], connect_timeout=60,
                         sslmode='require')
    c.autocommit = True
    cur = c.cursor()
    cur.execute("set statement_timeout = '300s'")
    cur.execute("set default_transaction_read_only = on")
    return c


def mps():
    env = {}
    for line in open('/Users/davidmonroe/suite-gateway/.env.local'):
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    c = psycopg2.connect(env['MPS_READONLY_DB_URL'], connect_timeout=60)
    c.set_session(readonly=True, autocommit=True)
    c.cursor().execute("set statement_timeout = '120s'")
    return c


def main():
    assert norm_parcel('49-03-20-117-001.000-600') == '490320117001000600'
    os.makedirs(OUT, exist_ok=True)
    reg, mdb = registry(), mps()
    cands, mf = [], []
    for st, fips, county in COUNTIES:
        part = f'parcels_{st.lower()}'
        cur = reg.cursor()
        cur.execute(f"""select parcel_uid from public.{part}
                         where county_fips = %s and owner_name is not null and situs_city is not null
                           and parcel_id_local is not null and site_address ~ '^\\s*[0-9]'""", (fips,))
        uids = [r[0] for r in cur.fetchall()]
        pick = random.Random(f'phase0-{fips}').sample(uids, min(PER_COUNTY, len(uids)))
        rows = []
        if pick:
            c2 = reg.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            c2.execute(f"""select parcel_uid, owner_name, site_address, situs_city, situs_zip, parcel_id_local
                             from public.{part} where county_fips = %s and parcel_uid = any(%s)""", (fips, pick))
            rows = [dict(r) for r in c2.fetchall()]
        for r in rows:
            cands.append({**r, 'state': st, 'fips': fips, 'county': county})

        # Multifamily fallback sample: MPS properties the registry cannot find by street or parcel.
        cur.execute(f"""select num_start, street_norm, parcel_id_local from public.{part}
                         where county_fips = %s""", (fips,))
        reg_streets, reg_parcels = set(), set()
        for num, street, pid in cur.fetchall():
            if num is not None and street:
                reg_streets.add((str(num), street))
            if pid:
                reg_parcels.add(norm_parcel(pid))
        mc = mdb.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        mc.execute("""select costar_property_id, property_address, city, zip, parcel_number_1,
                             num_start, street_norm
                        from public.multifamily_search
                       where state = %s and county ilike %s""", (st, f'{county}%'))
        mrows = [dict(r) for r in mc.fetchall()]
        def in_registry(m):
            by_street = (m['num_start'] is not None and m['street_norm']
                         and (str(m['num_start']), m['street_norm']) in reg_streets)
            by_parcel = bool(m['parcel_number_1']) and norm_parcel(m['parcel_number_1']) in reg_parcels
            return by_street or by_parcel
        flags = [in_registry(m) for m in mrows]
        rate = sum(flags) / len(mrows) if mrows else 0.0
        not_found = [m for m, f in zip(mrows, flags) if not f
                     and m['property_address'] and re.match(r'^\s*[0-9]', m['property_address']) and m['city']]
        note = ''
        if mrows and rate < MIN_MF_MATCH_RATE:
            note = f' SANITY FAIL: only {rate:.0%} of MPS rows matched the registry; not sampling MF here'
            not_found = []
        for m in random.Random(f'phase0-mf-{fips}').sample(not_found, min(MF_PER_COUNTY, len(not_found))):
            mf.append({'mps_id': str(m['costar_property_id']), 'state': st, 'fips': fips, 'county': county,
                       'address': m['property_address'], 'city': m['city'], 'zip': m['zip']})
        print(f'{st} {fips} {county}: eligible {len(uids)}, sampled {len(rows)}; '
              f'MPS rows {len(mrows)}, matched {rate:.0%}, MF not-found kept '
              f'{sum(1 for x in mf if x["fips"] == fips)}{note}', flush=True)
        time.sleep(2)
    json.dump(cands, open(f'{OUT}/candidates.json', 'w'), indent=1, default=str)
    json.dump(mf, open(f'{OUT}/mf_candidates.json', 'w'), indent=1, default=str)
    print(f'candidates {len(cands)}, mf {len(mf)}')


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Run it**

Run: `python3 tasks/research-scripts/phase0/select_samples.py`
Expected: one line per county with non-zero `eligible` for most counties, then `candidates N, mf M`.
A county with `eligible 0` is fine (the builder skips it). A `SANITY FAIL` line means MPS and registry
street normalisation disagree in that county; it contributes no MF sample. If fewer than 6 MF candidates
come back overall, report that in the Task 6 summary rather than widening the query.

- [ ] **Step 3: Confirm no MPS owner data was written**

Run: `python3 -c "import json;print(set(k for r in json.load(open('/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0/mf_candidates.json')) for k in r))"`
Expected: exactly `{'mps_id','state','fips','county','address','city','zip'}`.

- [ ] **Step 4: Commit (script only; the data is gitignored)**

```bash
git add tasks/research-scripts/phase0/select_samples.py
git status --short tasks/research-test   # must print nothing
git commit -m "research(phase0): read-only sample selector, registry owners and MPS addresses only"
```

---

### Task 4: Build the fixed sample with the production classifier

**Files:**
- Create: `tasks/research-scripts/phase0/build-sample.ts`
- Output (gitignored): `tasks/research-test/phase0/sample.json`

**Interfaces:**
- Consumes: `classifyOwnerName(raw?: string | null): 'entity' | 'individual' | 'trust' | 'unknown'`
  (lib/routing/ownerRoute.ts:170); `stripTrustWords` (Task 2); the two JSON files from Task 3.
- Produces `sample.json`:
  `{ individuals: Cand[], trusts: Cand[], probes: { state: string; county: string; parcel_id: string }[], mf: Mf[] }`
  where `Cand` and `Mf` are the Task 3 shapes.

- [ ] **Step 1: Write the builder**

```ts
// Run: npx tsx tasks/research-scripts/phase0/build-sample.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { classifyOwnerName } from '../../../lib/routing/ownerRoute'
import { stripTrustWords } from './match'

const DIR = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0'
const INDIV_PER_COUNTY = 4
const COUNTIES_PER_STATE = 2
const MIN_STATES = 4
const TRUST_TOTAL = 10
const MF_TOTAL = 10
const CAP = 15
// Worst case per call: every lookup hits and bills.
const COST = { tracerfy: 0.1, fastappend: 0.1, fullProperty: 0.3 }

export type Cand = {
  parcel_uid: string; state: string; fips: string; county: string; owner_name: string
  site_address: string; situs_city: string; situs_zip: string | null; parcel_id_local: string
}
export type Mf = { mps_id: string; state: string; fips: string; county: string; address: string; city: string; zip: string | null }

const cands: Cand[] = JSON.parse(readFileSync(`${DIR}/candidates.json`, 'utf8'))
const mf: Mf[] = JSON.parse(readFileSync(`${DIR}/mf_candidates.json`, 'utf8'))

const byCounty = new Map<string, Cand[]>()
for (const c of cands) {
  const k = `${c.state}|${c.fips}|${c.county}`
  if (!byCounty.has(k)) byCounty.set(k, [])
  byCounty.get(k)!.push(c)
}

const individuals: Cand[] = []
const perState = new Map<string, number>()
for (const [k, list] of byCounty) {
  const st = k.split('|')[0]
  if ((perState.get(st) ?? 0) >= COUNTIES_PER_STATE) continue
  const ind = list.filter((c) => classifyOwnerName(c.owner_name) === 'individual').slice(0, INDIV_PER_COUNTY)
  if (ind.length < INDIV_PER_COUNTY) { console.log(`skip ${k}: ${ind.length} individuals`); continue }
  individuals.push(...ind)
  perState.set(st, (perState.get(st) ?? 0) + 1)
}
const statesOk = [...perState.values()].filter((n) => n >= COUNTIES_PER_STATE).length
if (statesOk < MIN_STATES) {
  console.error(`only ${statesOk} states have ${COUNTIES_PER_STATE} usable counties; need ${MIN_STATES}`)
  process.exit(1)
}

const pools = [...byCounty.values()].map((l) =>
  l.filter((c) => classifyOwnerName(c.owner_name) === 'trust' && stripTrustWords(c.owner_name)))
const trusts: Cand[] = []
for (let i = 0; trusts.length < TRUST_TOTAL && pools.some((p) => p.length > i); i++)
  for (const p of pools) if (p[i] && trusts.length < TRUST_TOTAL) trusts.push(p[i])

const states = [...new Set(individuals.map((c) => c.state))]
const probes = states.map((st) => ({
  state: st, county: individuals.find((c) => c.state === st)!.county, parcel_id: 'PHASE0NOSUCH0001',
}))
const mfPick = mf.slice(0, MF_TOTAL)

const max =
  individuals.length * 2 * COST.tracerfy +
  trusts.length * (2 * COST.tracerfy + COST.fastappend) +
  probes.length * COST.tracerfy +
  mfPick.length * COST.fullProperty

writeFileSync(`${DIR}/sample.json`, JSON.stringify({ individuals, trusts, probes, mf: mfPick }, null, 1))
console.log({
  counties: [...new Set(individuals.map((c) => `${c.state} ${c.county}`))],
  individuals: individuals.length, trusts: trusts.length, probes: probes.length, mf: mfPick.length,
  max_dollars: Number(max.toFixed(2)),
})
if (max > CAP) { console.error(`worst case $${max.toFixed(2)} is over the $${CAP} cap`); process.exit(1) }
```

- [ ] **Step 2: Run it**

Run: `npx tsx tasks/research-scripts/phase0/build-sample.ts`
Expected: at least 8 counties across at least 4 states, `individuals` = 4 per county, `trusts` up to 10,
`probes` one per state, `mf` up to 10, `max_dollars` at or under 15. Exit code 0.

- [ ] **Step 3: Commit**

```bash
git add tasks/research-scripts/phase0/build-sample.ts
git commit -m "research(phase0): fix the sample with the production classifier"
```

---

### Task 5: The runner, `--plan` only

**Files:**
- Create: `tasks/research-scripts/phase0/run-phase0.ts`
- Output (gitignored, `--live` only): `tasks/research-test/phase0/calls.jsonl`

**Interfaces:**
- Consumes: `sample.json` (Task 4); `affordable` (Task 2); `stripTrustWords` (Task 2);
  `splitPersonName`, `planRoute(parcel, pricePlan)` (lib/routing/ownerRoute.ts:465, :318);
  `parcelForFullTrace({address, city, state, zip})` (lib/trace/fullPropertyTrace.ts:84);
  `executeRoute(plan, deps)` with `RouteDeps = { lookupDossier, traceEntity, tracePerson }`
  (lib/routing/executeRoute.ts:98-102, :415); `lookupDossier` (lib/tracerfy/dossier.ts:228);
  `lookupBusinessTrace`, `lookupPersonTrace` (lib/tracerfy/client.ts:518, :628);
  `TRACERFY.BASE_URL`, `FASTAPPEND.BASE_URL` (lib/constants.ts:118, :124).
- Produces one JSON line per call:
  `{ group: 'individual'|'trust'|'probe'|'mf', id: string, state: string, county: string, step: 'address'|'apn'|'fastappend'|'full_property', owner_name?: string, status: number, ms: number, dollars: number, body: unknown }`

- [ ] **Step 1: Write the runner**

```ts
/**
 * Phase 0 live measurement. THIS SPENDS.
 *   --plan                      print every call and the worst-case spend; no network (default)
 *   --live --max-dollars=<n>    run, n <= 15, stopping before any call whose worst case would pass n
 *   --balance                   print Tracerfy's account analytics (credit balance) and exit; spends nothing
 * Run: npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --plan
 */
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { splitPersonName, planRoute } from '../../../lib/routing/ownerRoute'
import { parcelForFullTrace } from '../../../lib/trace/fullPropertyTrace'
import { executeRoute } from '../../../lib/routing/executeRoute'
import { lookupDossier } from '../../../lib/tracerfy/dossier'
import { lookupBusinessTrace, lookupPersonTrace, getAnalytics } from '../../../lib/tracerfy/client'
import { TRACERFY, FASTAPPEND } from '../../../lib/constants'
import { stripTrustWords } from './match'
import { affordable } from './guard'
import type { Cand, Mf } from './build-sample'

delete process.env.SUPABASE_SERVICE_ROLE_KEY

const DIR = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0'
const OUT = `${DIR}/calls.jsonl`
const LIVE = process.argv.includes('--live')
const CAP_ARG = process.argv.find((a) => a.startsWith('--max-dollars='))
const CAP = CAP_ARG ? Number(CAP_ARG.split('=')[1]) : NaN
const CREDIT = 0.02
const WORST = { address: 0.1, apn: 0.1, probe: 0.1, fastappend: 0.1, full_property: 0.3 } as const

if (new URL(TRACERFY.BASE_URL).hostname !== 'tracerfy.com') {
  console.error(`TRACERFY base URL is ${TRACERFY.BASE_URL}; refusing (sandbox data is fake)`)
  process.exit(2)
}
const ALLOWED = new Set(['tracerfy.com', new URL(FASTAPPEND.BASE_URL).hostname])
const realFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any) => {
  const host = new URL(typeof input === 'string' ? input : input?.url).hostname
  if (!ALLOWED.has(host)) throw new Error(`BLOCKED host: ${host}`)
  return realFetch(input, init)
}) as typeof fetch

type Step = keyof typeof WORST
type Call = { group: string; id: string; state: string; county: string; step: Step; owner_name?: string; run: () => Promise<{ status: number; dollars: number; body: unknown }> }

const street = (s: string) => s.split(',')[0].trim()

async function tracerfy(path: string, payload: Record<string, unknown>) {
  const res = await fetch(`${TRACERFY.BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TRACERFY_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { body = { unparsed: text.slice(0, 800) } }
  const one = Array.isArray(body) ? body[0] : body
  const credits = typeof (one as any)?.credits_deducted === 'number' ? (one as any).credits_deducted
    : (one as any)?.hit === true ? 5 : 0
  return { status: res.status, dollars: credits * CREDIT, body }
}

function addressCall(c: Cand, group: string, ownerForLookup: string): Call {
  const { first_name, last_name } = splitPersonName(ownerForLookup)
  return {
    group, id: c.parcel_uid, state: c.state, county: c.county, step: 'address', owner_name: c.owner_name,
    run: () => tracerfy('trace/lookup/', {
      address: street(c.site_address), city: c.situs_city, state: c.state,
      ...(c.situs_zip ? { zip: c.situs_zip } : {}), find_owner: false, first_name, last_name,
    }),
  }
}
function apnCall(c: Cand, group: string): Call {
  return {
    group, id: c.parcel_uid, state: c.state, county: c.county, step: 'apn', owner_name: c.owner_name,
    run: () => tracerfy('trace/parcel/lookup/', { parcel_id: c.parcel_id_local, county: c.county, state: c.state }),
  }
}

const sample: { individuals: Cand[]; trusts: Cand[]; probes: { state: string; county: string; parcel_id: string }[]; mf: Mf[] } =
  JSON.parse(readFileSync(`${DIR}/sample.json`, 'utf8'))

const calls: Call[] = []
for (const c of sample.individuals) calls.push(addressCall(c, 'individual', c.owner_name), apnCall(c, 'individual'))
for (const c of sample.trusts) {
  calls.push(addressCall(c, 'trust', stripTrustWords(c.owner_name)), apnCall(c, 'trust'))
  calls.push({
    group: 'trust', id: c.parcel_uid, state: c.state, county: c.county, step: 'fastappend', owner_name: c.owner_name,
    run: async () => {
      const r = await lookupBusinessTrace({ company_name: c.owner_name, state: c.state })
      return { status: r.success ? 200 : 0, dollars: r.success && r.hit ? 0.1 : 0, body: r }
    },
  })
}
for (const p of sample.probes) calls.push({
  group: 'probe', id: p.parcel_id, state: p.state, county: p.county, step: 'probe',
  run: () => tracerfy('trace/parcel/lookup/', { parcel_id: p.parcel_id, county: p.county, state: p.state }),
})
for (const m of sample.mf) calls.push({
  group: 'mf', id: m.mps_id, state: m.state, county: m.county, step: 'full_property',
  run: async () => {
    const plan = planRoute(parcelForFullTrace({ address: street(m.address), city: m.city, state: m.state, zip: m.zip ?? '' }), 'pro')
    const ex = await executeRoute(plan, { lookupDossier, traceEntity: lookupBusinessTrace, tracePerson: lookupPersonTrace })
    return { status: ex.success ? 200 : 0, dollars: ex.vendorSpend, body: ex }
  },
})

const worst = calls.reduce((s, c) => s + WORST[c.step], 0)
const byStep = calls.reduce<Record<string, number>>((m, c) => ((m[`${c.group}:${c.step}`] = (m[`${c.group}:${c.step}`] ?? 0) + 1), m), {})
console.log({ calls: calls.length, byStep, worst_case_dollars: Number(worst.toFixed(2)) })

if (process.argv.includes('--balance')) {
  getAnalytics().then((r) => { console.log(JSON.stringify(r)); process.exit(0) })
} else if (!LIVE) { console.log('PLAN ONLY. Nothing was called.'); process.exit(0) }
else runLive()

function runLive() {
if (!(CAP > 0 && CAP <= 15)) { console.error('--live needs --max-dollars=<n>, 0 < n <= 15'); process.exit(2) }
if (!process.env.TRACERFY_API_KEY || !process.env.FASTAPPEND_API_KEY) { console.error('vendor keys missing'); process.exit(2) }

mkdirSync(DIR, { recursive: true })
;(async () => {
  let spent = 0
  for (const c of calls) {
    if (!affordable(spent, WORST[c.step], CAP)) { console.log(`STOP at $${spent.toFixed(2)}: next call could pass the cap`); break }
    const t0 = Date.now()
    let rec: { status: number; dollars: number; body: unknown }
    try { rec = await c.run() } catch (e) { rec = { status: 0, dollars: 0, body: { error: String(e) } } }
    spent += rec.dollars
    const { run, ...meta } = c
    appendFileSync(OUT, JSON.stringify({ ...meta, status: rec.status, ms: Date.now() - t0, dollars: rec.dollars, body: rec.body }) + '\n')
    console.log(`${c.group}:${c.step} ${c.state} ${c.county} status ${rec.status} $${rec.dollars.toFixed(2)} total $${spent.toFixed(2)}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log(`DONE. spent $${spent.toFixed(2)} of $${CAP}`)
})()
}
```

- [ ] **Step 2: Run `--plan`**

Run: `npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --plan`
Expected: a `{ calls, byStep, worst_case_dollars }` line with `worst_case_dollars` at or under 15, then
`PLAN ONLY. Nothing was called.` Confirm no `calls.jsonl` was created.

- [ ] **Step 3: Confirm `--live` refuses without a cap**

Run: `npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --live`
Expected: `--live needs --max-dollars=<n>, 0 < n <= 15`, exit code 2, no `calls.jsonl`.

- [ ] **Step 4: Commit**

```bash
git add tasks/research-scripts/phase0/run-phase0.ts
git commit -m "research(phase0): capped runner, plan mode by default"
```

- [ ] **Step 5: STOP. Get David's approval to spend**

Show David the `--plan` output (call counts by group and step, worst-case dollars) and the list of counties.
Do not continue until he names an amount. Use that amount as `--max-dollars`.

---

### Task 6: Live run (after approval)

**Files:**
- Output (gitignored): `tasks/research-test/phase0/calls.jsonl`

**Interfaces:**
- Consumes: Task 5 runner.
- Produces: `calls.jsonl` for Task 7.

- [ ] **Step 0: Record the Tracerfy balance before**

Run: `npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --balance`
Expected: one JSON line from the analytics endpoint. Record the credit balance.

- [ ] **Step 1: Run live with David's amount**

Run: `npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --live --max-dollars=<amount David approved>`
Expected: one line per call, ending `DONE. spent $X of $<amount>` with X at or under the amount.

- [ ] **Step 2: Confirm the output is complete**

Run: `wc -l tasks/research-test/phase0/calls.jsonl`
Expected: equal to the `calls` count from `--plan`, unless the run printed `STOP`; if it stopped, record how many calls ran.

- [ ] **Step 3: Cross-check spend against the vendor**

Run: `npx tsx --env-file=.env.local tasks/research-scripts/phase0/run-phase0.ts --balance`
Expected: the credit drop since Step 0 matches the Tracerfy share of `spent` (credits x $0.02) within one
lookup. Record both balances in the Task 7 summary.

---

### Task 7: Analyze and report

**Files:**
- Create: `tasks/research-scripts/phase0/analyze.ts`
- Create: `tasks/phase0-tier1-measurement.md` (committed, counts only, no names or addresses)

**Interfaces:**
- Consumes: `sample.json`, `calls.jsonl`, `personMatchesOwner` (Task 2).
- Produces: the report David reviews.

- [ ] **Step 1: Write the analyzer**

```ts
// Run: npx tsx tasks/research-scripts/phase0/analyze.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { personMatchesOwner, stripTrustWords, type MatchKind } from './match'

const DIR = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0'
const REPORT = '/Users/davidmonroe/PropTracerPRO/tasks/phase0-tier1-measurement.md'
type Rec = { group: string; id: string; state: string; county: string; step: string; owner_name?: string; status: number; ms: number; dollars: number; body: any }
const recs: Rec[] = readFileSync(`${DIR}/calls.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

/** One Tracerfy person-lookup answer, classified the way Phase 1 will classify it. */
function classify(r: Rec, owner: string): { cls: string; kind: MatchKind; flagged: boolean } {
  if (r.status !== 200) return { cls: `http_${r.status}`, kind: null, flagged: false }
  const one = Array.isArray(r.body) ? r.body[0] : r.body
  if (!one || typeof one.hit !== 'boolean') return { cls: 'malformed', kind: null, flagged: false }
  if (!one.hit) return { cls: 'miss', kind: null, flagged: false }
  const persons: any[] = Array.isArray(one.persons) ? one.persons : []
  for (const p of persons) {
    const kind = personMatchesOwner(p, owner)
    if (kind) return { cls: `matched_${kind}`, kind, flagged: p?.property_owner === true }
  }
  return { cls: 'billed_unmatched', kind: null, flagged: false }
}
const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0 }
const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})

const lines: string[] = ['# Phase 0: Tier 1 measurement', '', `Run: ${new Date().toISOString().slice(0, 10)}. Counts only; raw responses are in tasks/research-test/phase0/ (gitignored).`, '']

// Individuals, per county.
lines.push('## Individually owned parcels', '', '| County | n | Address lookup | APN lookup | Found, address first then APN (option B) | APN found what the address missed |', '|---|---|---|---|---|---|')
const counties = [...new Set(recs.filter((r) => r.group === 'individual').map((r) => `${r.state}|${r.county}`))]
for (const k of counties) {
  const [st, county] = k.split('|')
  const rs = recs.filter((r) => r.group === 'individual' && r.state === st && r.county === county)
  const ids = [...new Set(rs.map((r) => r.id))]
  const addr = ids.map((id) => { const r = rs.find((x) => x.id === id && x.step === 'address'); return r ? classify(r, r.owner_name!).cls : 'not_run' })
  const apn = ids.map((id) => { const r = rs.find((x) => x.id === id && x.step === 'apn'); return r ? classify(r, r.owner_name!).cls : 'not_run' })
  const found = ids.filter((_, i) => addr[i].startsWith('matched') || apn[i].startsWith('matched')).length
  const apnRescue = ids.filter((_, i) => !addr[i].startsWith('matched') && apn[i].startsWith('matched')).length
  lines.push(`| ${st} ${county} | ${ids.length} | ${JSON.stringify(count(addr))} | ${JSON.stringify(count(apn))} | ${found}/${ids.length} | ${apnRescue} |`)
}

// Name order and property_owner on matched APN people.
const apnMatched = recs.filter((r) => r.group === 'individual' && r.step === 'apn').map((r) => classify(r, r.owner_name!)).filter((c) => c.kind)
lines.push('', `APN matches by name order: ${JSON.stringify(count(apnMatched.map((c) => c.kind!)))}; flagged property_owner: ${apnMatched.filter((c) => c.flagged).length}/${apnMatched.length}.`)
const addrMatched = recs.filter((r) => r.group === 'individual' && r.step === 'address').map((r) => classify(r, r.owner_name!)).filter((c) => c.kind)
lines.push(`Address matches by name order: ${JSON.stringify(count(addrMatched.map((c) => c.kind!)))}.`)

// Unrecognized APN probes: status and body shape, verbatim excerpt.
lines.push('', '## Unrecognized APN (deliberately invalid parcel id)', '', '| State | HTTP status | Body excerpt |', '|---|---|---|')
for (const r of recs.filter((x) => x.group === 'probe')) lines.push(`| ${r.state} | ${r.status} | \`${JSON.stringify(r.body).slice(0, 160).replace(/\|/g, '/')}\` |`)

// Trusts: ladder C.
lines.push('', '## Trusts (ladder C)', '')
const trustIds = [...new Set(recs.filter((r) => r.group === 'trust').map((r) => r.id))]
const tRows = trustIds.map((id) => {
  const get = (s: string) => recs.find((r) => r.group === 'trust' && r.id === id && r.step === s)
  const a = get('address'), p = get('apn'), f = get('fastappend')
  const owner = stripTrustWords(a?.owner_name ?? '')
  const ac = a ? classify(a, owner).cls : 'not_run'
  const pc = p ? classify(p, owner).cls : 'not_run'
  const fc = f ? (f.body?.success ? (f.body?.hit ? ((f.body?.contacts?.phones?.length || f.body?.contacts?.emails?.length) ? 'hit_with_contact' : 'hit_no_contact') : 'miss') : 'failed') : 'not_run'
  return { ac, pc, fc }
})
lines.push(`n = ${trustIds.length}. Person address: ${JSON.stringify(count(tRows.map((t) => t.ac)))}. Person APN: ${JSON.stringify(count(tRows.map((t) => t.pc)))}. FastAppend on the full name: ${JSON.stringify(count(tRows.map((t) => t.fc)))}.`)
const personHalf = tRows.filter((t) => t.ac.startsWith('matched') || t.pc.startsWith('matched')).length
const companyHalfOnly = tRows.filter((t) => !(t.ac.startsWith('matched') || t.pc.startsWith('matched')) && t.fc === 'hit_with_contact').length
lines.push(`Found by the person half: ${personHalf}. Found only by the company half: ${companyHalfOnly}.`)

// Multifamily fallback.
lines.push('', '## Multifamily properties the registry cannot find (county-record path)', '')
const mfRecs = recs.filter((r) => r.group === 'mf')
const mfOwner = mfRecs.filter((r) => r.body?.ownerFound).length
const mfContact = mfRecs.filter((r) => (r.body?.contacts?.phones?.length || 0) + (r.body?.contacts?.emails?.length || 0) > 0).length
lines.push(`n = ${mfRecs.length}. County record named an owner: ${mfOwner}. Contacts found: ${mfContact}. Step outcomes: ${JSON.stringify(count(mfRecs.flatMap((r) => (r.body?.steps ?? []).map((s: any) => `${s.kind}:${s.outcome}`))))}.`)

// Latency and spend.
lines.push('', '## Latency (ms) and spend', '')
for (const s of ['address', 'apn', 'fastappend', 'full_property']) {
  const ms = recs.filter((r) => r.step === s && r.status === 200).map((r) => r.ms)
  if (ms.length) lines.push(`- ${s}: n ${ms.length}, p50 ${pct(ms, 0.5)}, p90 ${pct(ms, 0.9)}`)
}
lines.push(`- Total spent: $${recs.reduce((s, r) => s + r.dollars, 0).toFixed(2)} across ${recs.length} calls.`)

writeFileSync(REPORT, lines.join('\n') + '\n')
console.log(lines.join('\n'))
```

- [ ] **Step 2: Run it**

Run: `npx tsx tasks/research-scripts/phase0/analyze.ts`
Expected: the report prints and `tasks/phase0-tier1-measurement.md` is written.

- [ ] **Step 3: Check the report carries no personal data**

Run: `grep -c -i -E "[0-9]+ [A-Z]+ (ST|AVE|RD|DR|LN|CT|BLVD)" tasks/phase0-tier1-measurement.md`
Expected: `0`. Then read the probe excerpts by eye for any name or address and redact if present.

- [ ] **Step 4: Commit the analyzer and the report**

```bash
git add tasks/research-scripts/phase0/analyze.ts tasks/phase0-tier1-measurement.md
git status --short tasks/research-test   # must print nothing
git commit -m "research(phase0): Tier 1 measurement report"
```

- [ ] **Step 5: STOP. Present the findings to David**

Summarise for David, with the numbers from the report, the questions the spec left to Phase 0:
1. Does the APN lookup find the named owner on individually owned parcels, and does it find owners the
   address lookup missed (the "APN found what the address missed" column)? This decides whether the APN
   step stays in the individual route.
2. What does an unrecognized APN return (HTTP status and body)? This decides how spec 4.3 classifies it.
3. How often does the owner match only in the swapped order? If it happens, Phase 1 must fix
   `splitPersonName` for two-token assessor names or match both orders.
4. Trusts: does the person half find owners, and does the company half ever find one the person half missed?
   A half that never finds anyone comes out of ladder C.
5. Multifamily fallback: how often the county record names an owner and contacts are found.
6. Latency p50/p90, which sizes the Tier 1 cron batch and confirms or corrects the 2 to 5 minute estimate.
7. Total spent against the approved amount.

- [ ] **Step 6: Review section**

Add a `## Phase 0 review` section under the Tier 1 heading in `tasks/todo.md`: what ran, what it cost, where
the report is, and which spec decisions it confirms or overturns. Tick the Phase 0 box. Add the History.md
entry. Commit:

```bash
git add tasks/todo.md History.md
git commit -m "docs: Phase 0 review"
```

Then update the spec with David's decisions on each point, and only after that write the Phase 1 plan.
