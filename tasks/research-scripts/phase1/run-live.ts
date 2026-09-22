/**
 * Tier 1 Phase 1 live check (plan Task 12, controller resolutions 2026-09-22). ONE record per
 * lookup path, sent through the real API single route on a LOCAL server that points at
 * production, and nothing else (lessons L-024).
 *
 *   Dry run, no vendor call, no wallet, no database (the HARD STOP mode):
 *     npx tsx tasks/research-scripts/phase1/run-live.ts --plan
 *
 *   Live (never run by the executor; a later dispatch runs this once the owner names a dollar
 *   amount):
 *     npx tsx tasks/research-scripts/phase1/run-live.ts --live --max-dollars <n> --email <owner email>
 *
 * WORST CASE (resolution F-P11): never hard-coded. Every record's worst case is computed by
 * calling the SAME planRoute() the app runs, so a price or step change flows through here
 * automatically instead of going stale next to a table someone forgot to update. A Full Property
 * Trace record (tier2_apn_no_city) additionally prices the dossier step(s) plus, for each owner
 * the registry says the parcel has, one worst-case single-owner ladder (the full trust ladder:
 * Instant + parcel + FastAppend, D3) -- the dossier has not run yet, so the owner's type is
 * unknown, and the trust ladder is the most any one owner's route can cost. D21 arm (c) means a
 * mailing address may be found for that owner even when the property itself has none, so the
 * worst case assumes one is present.
 *
 * --live refuses to run without --max-dollars and refuses when the computed worst case exceeds
 * it. It reads the owner's own API key from user_profiles with the service-role key in
 * .env.local, only to call his own API; never prints it or writes it anywhere. Raw request and
 * response pairs go to tasks/research-test/phase1/live.jsonl (gitignored: purchased contact
 * data). The terminal, in both modes, gets no owner name, street, parcel id, phone or email --
 * only ids, paths, states, counties, step kinds and dollar figures.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import type { ParcelInput } from '../../../lib/routing/ownerRoute'

type LivePath = 'tier1_address_person' | 'tier1_apn_person' | 'tier1_company' | 'tier1_trust' | 'tier2_apn_no_city'

interface LiveRecord {
  id: string
  path: LivePath
  body: Record<string, unknown>
  why: string
  /** tier2_apn_no_city only: how many owners the registry names. */
  owners?: number
}

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'tasks/research-test/phase1')
const RECORDS = join(OUT_DIR, 'records.json')
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

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

interface PricedRecord {
  record: LiveRecord
  total: number
  detail: string
}

/**
 * Compute one record's worst-case vendor dollars by running it through the production
 * planRoute(), never a hard-coded table (F-P11). Cost-side only: the price plan argument
 * planRoute requires does not affect maxVendorCost or costOnHit, so FAILSAFE_PRICE_PLAN (the
 * dearest column) is used uniformly rather than guessing a caller's real plan.
 */
async function worstCaseFor(record: LiveRecord): Promise<PricedRecord> {
  const { planRoute, FAILSAFE_PRICE_PLAN } = await import('../../../lib/routing/ownerRoute')
  const { parcelForFullTrace } = await import('../../../lib/trace/fullPropertyTrace')

  const body = record.body
  const state = str(body.state) ?? ''
  const apn = str(body.apn) ?? str(body.parcelId)
  const county = str(body.county)
  const address = str(body.address)
  const city = str(body.city)
  const zip = str(body.zip)
  const ownerName = str(body.ownerName)

  const parcel = parcelForFullTrace({ address, city, state, zip, apn, county })

  if (record.path === 'tier2_apn_no_city') {
    // 1. The dossier itself: whichever key(s) planRoute emits for an absent owner (D24). Only ONE
    //    dossier key can ever bill -- executeRoute stops at the first hit (ownerRoute.ts: "Stop at
    //    the first hit") -- so a record carrying BOTH an apn and a full situs must worst-case on
    //    the pricier of the two keys, never their sum (fix round 1, item 4: summing double-counted
    //    a record with both keys present; this record's own two keys happen to cost the same
    //    $0.20, so the number does not move here, but the fix matters for a future record that
    //    carries both).
    const dossierPlan = planRoute({ ...parcel, ownerName: null }, FAILSAFE_PRICE_PLAN)
    const dossierCost = dossierPlan.steps.reduce((max, s) => Math.max(max, s.costOnHit), 0)
    const dossierDetail =
      dossierPlan.steps.map((s) => `${s.kind} $${s.costOnHit.toFixed(2)}`).join(' or ') || 'no dossier key'

    // 2. Each owner the registry names gets one worst-case ladder. The dossier has not run, so
    //    the owner's real classification is unknown; the trust ladder (person steps plus the
    //    FastAppend fallback, D3) is the most any single owner's route can cost. A mailing
    //    address is assumed present, because D21 arm (c) searches an individual owner at the
    //    dossier's mailing address even when the property itself carries no street or city.
    //
    //    NO DEFAULT (fix round 1, item 1, CLAUDE.md rule 7): a missing or malformed owners count
    //    is refused by assertOwnersProvided() before any record's worst case is computed at all
    //    (see main()), so this line only ever runs against an already-validated number. No `?? 1`
    //    fallback here: a future caller of worstCaseFor() that skipped that gate must fail loud,
    //    never silently understate the worst case.
    if (typeof record.owners !== 'number' || !Number.isFinite(record.owners) || record.owners <= 0) {
      throw new Error(
        `Record ${record.id} (${record.path}) has a missing or non-numeric owners count. ` +
          'Refusing rather than defaulting to 1, which would understate the worst case.'
      )
    }
    const owners = record.owners
    const perOwnerParcel: ParcelInput = {
      ...parcel,
      ownerName: 'WORST CASE OWNER FAMILY TRUST',
      situsAddress: 'WORST CASE MAILING ADDRESS',
      situsCity: 'WORST CASE CITY',
      situsState: parcel.state,
      situsZip: null,
    }
    const perOwnerPlan = planRoute(perOwnerParcel, FAILSAFE_PRICE_PLAN)
    const perOwnerCost = perOwnerPlan.maxVendorCost
    const total = Math.round((dossierCost + owners * perOwnerCost) * 100) / 100
    return {
      record,
      total,
      detail: `dossier: ${dossierDetail}; ${owners} owner(s) x worst-case single-owner ladder $${perOwnerCost.toFixed(2)} (trust: Instant + parcel + FastAppend)`,
    }
  }

  const plan = planRoute({ ...parcel, ownerName: ownerName ?? null }, FAILSAFE_PRICE_PLAN)
  const detail = plan.steps.map((s) => `${s.kind} $${s.costOnHit.toFixed(2)}`).join(' + ') || 'no lookup key -- no step'
  return { record, total: Math.round(plan.maxVendorCost * 100) / 100, detail }
}

function summaryLine(p: PricedRecord): string {
  const state = str(p.record.body.state) ?? '?'
  const county = str(p.record.body.county)
  const where = county ? `${state}/${county}` : state
  return `  ${p.record.id} ${p.record.path} (${where}): ${p.detail} = $${p.total.toFixed(2)}`
}

/**
 * Fix round 1, item 1 (Important, CLAUDE.md rule 7). Run BEFORE any record's worst case is
 * computed, for every record whose path needs an owner count (tier2_apn_no_city): a missing or
 * non-numeric `owners` throws, naming the record, rather than letting worstCaseFor() silently
 * default it to 1 and understate the worst case this script exists to bound.
 */
function assertOwnersProvided(records: LiveRecord[]): void {
  for (const r of records) {
    if (r.path !== 'tier2_apn_no_city') continue
    if (typeof r.owners !== 'number' || !Number.isFinite(r.owners) || r.owners <= 0) {
      throw new Error(
        `Record ${r.id} (${r.path}) has a missing or non-numeric owners count. ` +
          'Refusing rather than defaulting to 1, which would understate the worst case. Not run.'
      )
    }
  }
}

async function main(): Promise<void> {
  const isPlan = process.argv.includes('--plan')
  const isLive = process.argv.includes('--live')

  if (!isPlan && !isLive) {
    throw new Error(
      'Usage: --plan (dry run: computes and prints the worst case, no vendor call, no wallet, no database) ' +
        'OR --live --max-dollars <the amount the owner named> --email <the owner account email>'
    )
  }

  if (!existsSync(RECORDS)) throw new Error(`Write the chosen records to ${RECORDS} first (plan Task 12, Step 3).`)
  const records = JSON.parse(readFileSync(RECORDS, 'utf8')) as LiveRecord[]
  if (new Set(records.map((r) => r.path)).size !== records.length) {
    throw new Error('One record per path (L-024): a path appears twice. Not run.')
  }
  // Fix round 1, item 1: before anything else runs (before any worst-case math, before any
  // printing), refuse a records file that is missing an owners count anywhere it is needed.
  assertOwnersProvided(records)

  const priced = await Promise.all(records.map((r) => worstCaseFor(r)))
  const worst = Math.round(priced.reduce((a, p) => a + p.total, 0) * 100) / 100

  console.log('Worst case per record, computed from planRoute() (no vendor call):')
  for (const p of priced) console.log(summaryLine(p))
  console.log(`Total worst case: $${worst.toFixed(2)}`)

  // Fix round 1, item 2: a NaN or non-positive worst case must refuse here, on its own terms,
  // before the --live branch's own --max-dollars comparison ever runs -- `NaN > maxDollars` is
  // always false, so that comparison alone would silently let a broken worst case through. This
  // check sits before any environment load, client or fetch (all of which are further below),
  // and it applies to --plan too: a plan run that cannot compute a real number is not a plan.
  if (!Number.isFinite(worst) || worst <= 0) {
    throw new Error(
      `Worst case did not compute to a finite, positive dollar amount ($${worst}). Refusing before any vendor call.`
    )
  }

  // Fix round 1, item 3: --plan and --live are not meant to be given together, but if they are,
  // --plan wins -- print the plan, touch nothing live. This is the safer of the two choices the
  // review offered (refusing both together is no safer, since --plan alone is always safe, so
  // there is no reason to make that combination an error).
  if (isPlan) {
    console.log(
      isLive
        ? 'PLAN MODE: --plan and --live were both given; --plan wins. No vendor call, no wallet spend, no database read or write.'
        : 'PLAN MODE: no vendor call, no wallet spend, no database read or write.'
    )
    return
  }

  // ---- Everything below here only runs with --live and no --plan. Never invoked by the Task 12
  // ---- executor (the owner's HARD STOP): the owner names a dollar amount first, and a LATER
  // ---- dispatch runs this with --live --max-dollars <that amount>.
  const maxDollars = Number(arg('max-dollars'))
  const email = arg('email')
  if (!Number.isFinite(maxDollars) || maxDollars <= 0 || !email) {
    throw new Error('Usage: --live --max-dollars <the amount the owner named> --email <the owner account email>')
  }
  if (worst > maxDollars) {
    throw new Error(`Worst case $${worst.toFixed(2)} is over the approved $${maxDollars.toFixed(2)}. Not run.`)
  }

  const env = loadEnvLocal()
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  const { data: profile, error } = await admin.from('user_profiles').select('api_key').eq('email', email).single()
  if (error || !profile?.api_key) throw new Error(`No API key for that account: ${error?.message ?? 'none set'}`)

  mkdirSync(OUT_DIR, { recursive: true })
  console.log(`Live run starting. Worst case $${worst.toFixed(2)} of $${maxDollars.toFixed(2)} approved. ${records.length} records.`)

  for (const r of records) {
    const started = Date.now()
    const res = await fetch(`${BASE}/api/v1/trace/single`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(r.body),
    })
    const ms = Date.now() - started
    const body = (await res.json()) as Record<string, unknown>
    appendFileSync(
      join(OUT_DIR, 'live.jsonl'),
      JSON.stringify({ id: r.id, path: r.path, request: r.body, status: res.status, ms, response: body }) + '\n'
    )
    console.log(
      [
        r.id,
        r.path,
        `HTTP ${res.status}`,
        `outcome ${String(body.outcomeCode ?? 'n/a')}`,
        `foundBy ${String(body.foundBy ?? 'none')}`,
        `tier ${String(body.tier ?? 'n/a')}`,
        `charge ${String(body.charge ?? 0)}`,
        `${ms} ms`,
        `traceId ${String(body.traceId ?? 'n/a')}`,
      ].join(' | ')
    )
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
