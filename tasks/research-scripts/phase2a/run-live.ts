/**
 * Tier 1 Phase 2A live check (plan Task 9). TWENTY records, FOUR per path across the five paths, in
 * ONE web bulk upload, drained by the real cron on a LOCAL server pointed at production.
 *
 *   npx tsx tasks/research-scripts/phase2a/run-live.ts --plan
 *   npx tsx tasks/research-scripts/phase2a/run-live.ts --csv
 *   PTP_LIVE_RUN=1 npx tsx tasks/research-scripts/phase2a/run-live.ts --live --max-dollars <n>
 *
 * SAMPLE SIZE, AND WHY IT IS NOT THE PLAN'S. Task 9 as written picked ONE record per path (L-024).
 * David overrode that on 2026-09-24: FOUR per path, twenty records, because one record per path
 * answers "does it work" and not "does it work twice", and he authorised the spend for it. Every
 * other picking rule is the plan's, unchanged: the exclusion lists, secondary and tertiary markets
 * only, five different states, not all one property type, and natural-order owner-name counties for
 * the person and trust paths.
 *
 * WHAT IT DOES AND DOES NOT DO. It does NOT submit the upload: app/api/trace/bulk authenticates by
 * session cookie, so David uploads the CSV this script renders, in his own browser, on the local
 * server. --live then triggers the cron that drains the queue, which is where the vendor money is
 * spent, and reads the rows back.
 *
 * THE WORST CASE IS COMPUTED HERE, FROM THE PRODUCT'S OWN COST TABLE, not copied from the plan.
 * `VENDOR_COST` is imported from lib/routing/ownerRoute, the same table planRoute prices its steps
 * with, so this script cannot drift from what the crons actually spend. That module has no imports
 * of its own, so reading it opens nothing and loads no credential.
 *
 * The ceiling is derived from THE ROW, never from the path label this file was handed, because the
 * label is a claim about how planRoute will classify an owner name and the row is a fact:
 *
 *   Tier 1 record:  (row has a city ? TRACERFY_INSTANT : 0) + FASTAPPEND_ENTITY
 *   Tier 2 record:  DOSSIER + owners * TRACERFY_INSTANT
 *
 *   The web upload sends no parcel id (D5), so planRoute can emit at most ONE Tracerfy step and at
 *   most ONE FastAppend step per Tier 1 record: TRACERFY_PARCEL_APN needs an apn and a county this
 *   surface never supplies. And a Tracerfy step is IMPOSSIBLE without a city, because `hasSitus`
 *   requires street AND city AND state, so a city-less row cannot reach that vendor at any price.
 *   Both of those are structural facts about the surface, not predictions about a name.
 *
 *   A city-less PERSON row is expected to spend $0.00, since planRoute emits no step at all for it,
 *   and that is measured rather than assumed. It is still budgeted at the FastAppend figure, because
 *   "this record spends nothing" is the thing the live check exists to verify, and a cap that
 *   assumes the code under test is correct is not a cap.
 *
 *   `owners` is declared per Tier 2 record, and a Tier 2 record that declares none is REFUSED. The
 *   dossier decides how many contact lookups follow it and D21(c) with D40 put NO cap on that, so
 *   there is no structural ceiling on this lane at all: the declared figure is a BUDGET, and
 *   assuming one silently would fabricate the single input the spend cap is checked against
 *   (CLAUDE.md rule 7). A record whose dossier names more owners than it declared can exceed its own
 *   budget, because the Tier 2 lane reserves once and then lets the record finish by design.
 *
 * THE REFUSALS, AND WHY THERE ARE SO MANY (lesson L-031). A spend cap does not stop an agent: on
 * 2026-09-23 a subagent ran the FastAppend probe `--live --max-dollars 1` as a "boundary test"
 * against an explicit instruction, the worst case was exactly $1.00, the refusal tested
 * `total > maxDollars`, and ten real vendor calls went out. So:
 *   1. --live does nothing at all unless PTP_LIVE_RUN=1 is in the environment. That is a token an
 *      implementer following its brief has no reason to invent and a human sets deliberately.
 *   2. The cap must be STRICTLY GREATER than the computed worst case. A cap equal to the worst case
 *      is refused, because that is the shape that failed: the boundary case must not also be the
 *      live case.
 * Every refusal fires before a credential is read, before a database is opened and before a vendor
 * is called: loadEnvLocal() is reached only after all of them pass.
 *
 * Raw request and response pairs go to tasks/research-test/phase2a/live.jsonl (gitignored: real
 * purchased contact data). The terminal gets no owner name, street, parcel id, phone or email.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VENDOR_COST } from '../../../lib/routing/ownerRoute'

type LivePath =
  | 'tier1_address_person'
  | 'tier1_no_city_person'
  | 'tier1_no_city_company'
  | 'tier1_trust'
  | 'tier2_blank_owner'

interface LiveRecord {
  id: string
  path: LivePath
  row: { address: string; city: string; state: string; zip?: string; owner_name?: string }
  /** Tier 2 only: how many owners the dossier is budgeted to name. Required on that path. */
  owners?: number
  why: string
}

const ALL_PATHS: readonly LivePath[] = [
  'tier1_address_person',
  'tier1_no_city_person',
  'tier1_no_city_company',
  'tier1_trust',
  'tier2_blank_owner',
]

/** Vendor dollars if every step this ROW can reach on THIS surface bills. */
function worstCaseFor(record: LiveRecord): number {
  if (record.path === 'tier2_blank_owner') {
    // The dossier, then one contact lookup for each owner it is budgeted to name.
    return VENDOR_COST.DOSSIER + (record.owners as number) * VENDOR_COST.TRACERFY_INSTANT
  }
  // Tier 1: at most one Tracerfy step, and only if the row carries a city (hasSitus), plus at most
  // one FastAppend step. No parcel id on this surface (D5), so no third vendor call is reachable.
  const tracerfy = record.row.city?.trim() ? VENDOR_COST.TRACERFY_INSTANT : 0
  return tracerfy + VENDOR_COST.FASTAPPEND_ENTITY
}

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'tasks/research-test/phase2a')
const RECORDS = join(OUT_DIR, 'records.json')
const CSV = join(OUT_DIR, 'upload.csv')
const BASE = 'http://localhost:3000'

function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, '')
  }
  return out
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function loadRecords(): LiveRecord[] {
  if (!existsSync(RECORDS)) {
    throw new Error(`Write the chosen records to ${RECORDS} first (plan Task 9, Step 3).`)
  }
  const records = JSON.parse(readFileSync(RECORDS, 'utf8')) as LiveRecord[]
  if (records.length === 0) throw new Error('No records. Not run.')

  // Ids identify a row in the report and in live.jsonl, so a duplicate makes the evidence unreadable.
  const ids = new Set(records.map((r) => r.id))
  if (ids.size !== records.length) throw new Error('Duplicate record id. Not run.')

  for (const r of records) {
    if (!ALL_PATHS.includes(r.path)) throw new Error(`${r.id}: unknown path ${r.path}. Not run.`)
  }
  // L-024's requirement survives the four-per-path override: every path must still be exercised.
  const seen = new Set(records.map((r) => r.path))
  const missing = ALL_PATHS.filter((p) => !seen.has(p))
  if (missing.length > 0) {
    throw new Error(`No record on path(s) ${missing.join(', ')}. Every path is exercised. Not run.`)
  }

  // REFUSAL: a tier 2 record with no owner count. The dossier decides how many contact lookups
  // follow it, so without a declared count the worst case is unknown, and an assumed count would be
  // a fabricated input to the one number the spend cap is checked against.
  for (const r of records) {
    if (r.path !== 'tier2_blank_owner') continue
    if (!Number.isInteger(r.owners) || (r.owners as number) < 0) {
      throw new Error(
        `REFUSED: ${r.id} is on tier2_blank_owner and declares no owner count. The dossier decides ` +
          'how many contact lookups follow it, so the worst case cannot be computed and must not be ' +
          'guessed. Add "owners": <n> to that record. Not run.'
      )
    }
  }
  return records
}

const worstCase = (records: LiveRecord[]): number =>
  Math.round(records.reduce((sum, r) => sum + worstCaseFor(r), 0) * 100) / 100

/** The file David uploads, in the page's own template order. */
function writeCsv(records: LiveRecord[]): void {
  mkdirSync(OUT_DIR, { recursive: true })
  const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`
  const lines = ['address,city,state,zip,owner_name']
  for (const r of records) {
    lines.push(
      [r.row.address, r.row.city, r.row.state, r.row.zip ?? '', r.row.owner_name ?? '']
        .map(esc)
        .join(',')
    )
  }
  writeFileSync(CSV, lines.join('\n') + '\n')
  console.log(`Wrote ${records.length} rows to ${CSV}. Nothing was spent.`)
}

function printPlan(records: LiveRecord[], total: number): void {
  console.log(`Worst case $${total.toFixed(2)} across ${records.length} records.`)
  console.log(
    `  Tier 1 per record: TRACERFY_INSTANT $${VENDOR_COST.TRACERFY_INSTANT.toFixed(2)} only if the row ` +
      `carries a city (hasSitus), plus FASTAPPEND_ENTITY $${VENDOR_COST.FASTAPPEND_ENTITY.toFixed(2)}. ` +
      'No parcel id on this surface (D5), so no third vendor call is reachable.'
  )
  console.log(
    `  Tier 2 per record: DOSSIER $${VENDOR_COST.DOSSIER.toFixed(2)} plus ` +
      `$${VENDOR_COST.TRACERFY_INSTANT.toFixed(2)} for each owner it is BUDGETED to name. ` +
      'That lane has no structural ceiling (D21(c), D40), so the figure is a budget, not a bound.'
  )
  for (const p of ALL_PATHS) {
    const onPath = records.filter((r) => r.path === p)
    const sub = Math.round(onPath.reduce((s, r) => s + worstCaseFor(r), 0) * 100) / 100
    console.log(`  ${p}: ${onPath.length} records, $${sub.toFixed(2)}`)
    for (const r of onPath) {
      const owners = r.path === 'tier2_blank_owner' ? ` (${r.owners} owners budgeted)` : ''
      console.log(`      ${r.id}: $${worstCaseFor(r).toFixed(2)}${owners}`)
    }
  }
  console.log('Nothing was run. Pass --csv to write the upload file, or --live to drain the queue.')
}

async function drain(env: Record<string, string>, records: LiveRecord[]): Promise<void> {
  const secret = env.CRON_SECRET
  if (!secret) throw new Error('No CRON_SECRET in .env.local. Not run.')
  mkdirSync(OUT_DIR, { recursive: true })
  for (let pass = 1; pass <= 10; pass++) {
    const started = Date.now()
    const res = await fetch(`${BASE}/api/cron/sweep-entity-traces`, {
      headers: { Authorization: `Bearer ${secret}` },
    })
    const body = (await res.json()) as Record<string, unknown>
    const ms = Date.now() - started
    appendFileSync(
      join(OUT_DIR, 'live.jsonl'),
      JSON.stringify({ pass, cron: 'sweep-entity-traces', status: res.status, ms, body }) + '\n'
    )
    const tier1 = (body.tier1 ?? {}) as Record<string, number>
    console.log(
      [
        `pass ${pass}`,
        `HTTP ${res.status}`,
        `tier1 processed ${tier1.processed ?? 0}`,
        `charged ${tier1.charged ?? 0}`,
        `contacts ${tier1.contactsFound ?? 0}`,
        `no contacts ${tier1.noContacts ?? 0}`,
        `no key ${tier1.noLookupKey ?? 0}`,
        `busy ${tier1.busy ?? 0}`,
        `throttled ${tier1.throttled ?? 0}`,
        `errored ${tier1.errored ?? 0}`,
        `${ms} ms`,
      ].join(' | ')
    )
    if ((tier1.processed ?? 0) === 0 && (tier1.throttled ?? 0) === 0) {
      console.log('Queue is empty. Also trigger the tier 2 cron for the B5 rows if they are still queued.')
      return
    }
  }
  console.log(`Ten passes and the queue is still draining. ${records.length} records were expected.`)
}

async function main(): Promise<void> {
  const records = loadRecords()
  const total = worstCase(records)

  if (process.argv.includes('--csv')) {
    writeCsv(records)
    return
  }

  if (!process.argv.includes('--live')) {
    printPlan(records, total)
    return
  }

  // REFUSAL 0. A token, not a number (lesson L-031).
  if (process.env.PTP_LIVE_RUN !== '1') {
    console.error(
      'REFUSED: --live needs PTP_LIVE_RUN=1 in the environment. This exists so an agent building or ' +
        'testing this script cannot spend money by passing --live, however the cap is set. Not run.'
    )
    process.exit(2)
  }
  // REFUSAL 1. No cap, no run.
  const maxDollars = Number(arg('max-dollars'))
  if (!Number.isFinite(maxDollars) || maxDollars <= 0) {
    console.error('REFUSED: --max-dollars must be a number greater than 0. Not run.')
    process.exit(2)
  }
  // REFUSAL 2. STRICTLY GREATER, not "exceeds". A cap equal to the worst case is the shape that
  // spent real money on 2026-09-23, because $1.00 does not exceed $1.00.
  if (total >= maxDollars) {
    console.error(
      `REFUSED: worst case $${total.toFixed(2)} is not strictly under the approved $${maxDollars.toFixed(2)}. ` +
        'Leave headroom so the boundary case is not also the live case. Not run.'
    )
    process.exit(2)
  }

  const env = loadEnvLocal()
  console.log(`Worst case $${total.toFixed(2)}, under $${maxDollars.toFixed(2)} approved. Draining.`)
  await drain(env, records)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
