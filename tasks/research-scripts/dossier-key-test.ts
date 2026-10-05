/**
 * Dossier key test, 2026-10-05: property-registry Phase 2 Step 1 (UT + NH).
 *
 * QUESTION. UT and NH parcels name no owner, so a trace buys the county record (the dossier).
 * The dossier has two keys (lib/routing/ownerRoute.ts:439-440): APN + county + state, and
 * address + city + state (+ zip). These parcels carry no city today, so only the APN is tried.
 * Does the address key, with the city a registry write WOULD store, find the right parcel,
 * especially where the APN misses? Does a ZIP change it? Does the APN's printed form?
 *
 * Every arm runs on its own (production stops at the first hit), so each key is measured. It
 * runs the SHIPPED client, so the request body and the parse are production's. Owner names go
 * ONLY into the raw files under --out (gitignored, PII) and are never printed.
 *
 *   npx tsx tasks/research-scripts/dossier-key-test.ts --self-test
 *   npx tsx tasks/research-scripts/dossier-key-test.ts --dry-run --sample S --out D
 *   npx tsx tasks/research-scripts/dossier-key-test.ts --sandbox --sample S --out D
 *   npx tsx tasks/research-scripts/dossier-key-test.ts --live --max-dollars N --sample S --out D
 *
 * 10 credits ($0.20) a hit, 0 on a miss. The cap is checked BEFORE every call at a hit's price,
 * so no call can cross it. The control runs first; if it does not reproduce its 2026-09-16 record
 * (APN miss, recorded address hit), nothing else runs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import type { DossierKey, DossierResult } from '../../lib/tracerfy/dossier'

const ENV_PATH = '/Users/davidmonroe/PropTracerPRO/.env.local'
const HIT_CREDITS = 10
const CREDIT_USD = 0.02
const ALLOWED = new Set(['tracerfy.com', 'mock.tracerfy.com'])

export type Parcel = {
  id: string; role: 'control' | 'agree' | 'disagree'; state: string; county: string
  apn: string; apn_printed: string | null; address: string; city: string | null; zip: string | null
  recorded?: { address: string; city: string }
}
export type ArmName = 'apn' | 'apn_printed' | 'address_recorded' | 'address_city' | 'address_city_zip'
export type Arm = { name: ArmName; key: DossierKey; onlyIfApnMissed: boolean }
export type Verdict = 'ERROR' | 'MISS' | 'RIGHT_APN' | 'SAME_ADDRESS_APN_DIFFERS' | 'WRONG_PARCEL'
type Row = { id: string; role: string; state: string; county: string; arm: ArmName; verdict: Verdict | 'DRY_RUN'
  credits: number; returned_apn: unknown; returned_zip: unknown; error: string | null; request?: unknown }

export function planArms(p: Parcel): Arm[] {
  const arms: Arm[] = [{ name: 'apn', key: { mode: 'apn', apn: p.apn, county: p.county, state: p.state }, onlyIfApnMissed: false }]
  if (p.apn_printed) {
    arms.push({ name: 'apn_printed', key: { mode: 'apn', apn: p.apn_printed, county: p.county, state: p.state }, onlyIfApnMissed: true })
  }
  if (p.recorded) {
    arms.push({ name: 'address_recorded', key: { mode: 'address', address: p.recorded.address, city: p.recorded.city, state: p.state }, onlyIfApnMissed: false })
  }
  const sameAsRecorded = p.recorded && p.recorded.address === p.address && p.recorded.city === p.city
  if (p.city && !sameAsRecorded) {
    arms.push({ name: 'address_city', key: { mode: 'address', address: p.address, city: p.city, state: p.state }, onlyIfApnMissed: false })
  }
  if (p.city && p.zip) {
    arms.push({ name: 'address_city_zip', key: { mode: 'address', address: p.address, city: p.city, state: p.state, zip_code: p.zip }, onlyIfApnMissed: false })
  }
  return arms
}

const norm = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const DIRECTIONS = new Set(['N', 'S', 'E', 'W', 'NORTH', 'SOUTH', 'EAST', 'WEST'])

/** "1815 S STATE ST" -> "1815 STATE": the number and the first word that is not a direction. */
export function streetHead(v: unknown): string | null {
  const m = /^\s*(\d+)\s+(.+)$/.exec(String(v ?? '').toUpperCase())
  if (!m) return null
  const word = m[2].split(/\s+/).find((w) => !DIRECTIONS.has(w))
  return word ? `${m[1]} ${word.replace(/[^A-Z0-9]/g, '')}` : null
}

/** RIGHT only on the APN. A same-street answer with another APN is reported for a human to read,
 *  never counted as right: Utah grid numbers repeat across towns. */
export function classify(p: Parcel, r: Pick<DossierResult, 'success' | 'hit' | 'property'>): Verdict {
  if (!r.success) return 'ERROR'
  if (!r.hit) return 'MISS'
  const got = norm(r.property?.apn)
  if (got && (got === norm(p.apn) || (p.apn_printed !== null && got === norm(p.apn_printed)))) return 'RIGHT_APN'
  const head = streetHead(p.address)
  if (head && head === streetHead(r.property?.address)) return 'SAME_ADDRESS_APN_DIFFERS'
  return 'WRONG_PARCEL'
}

export const capAllows = (spentCredits: number, capCredits: number) => spentCredits + HIT_CREDITS <= capCredits
export const outDirError = (dir: string) => (existsSync(dir) ? `REFUSING: ${dir} exists; a result set is never overwritten` : null)

const FOUND = new Set<string>(['RIGHT_APN'])
export function summarize(rows: Row[]) {
  const byArm: Record<string, Record<string, number>> = {}
  for (const r of rows) { const a = (byArm[r.arm] ??= {}); a[r.verdict] = (a[r.verdict] ?? 0) + 1 }
  const ids = [...new Set(rows.map((r) => r.id))]
  const found = (id: string, arms: ArmName[]) => rows.some((r) => r.id === id && arms.includes(r.arm) && FOUND.has(r.verdict))
  return {
    parcels: ids.length,
    by_arm: byArm,
    apn_found: ids.filter((id) => found(id, ['apn'])).length,
    rescued_by_printed_apn: ids.filter((id) => !found(id, ['apn']) && found(id, ['apn_printed'])).length,
    rescued_by_address: ids.filter((id) => !found(id, ['apn', 'apn_printed']) && found(id, ['address_city', 'address_city_zip'])).length,
    zip_changed_result: ids.filter((id) => {
      const v = (a: ArmName) => rows.find((r) => r.id === id && r.arm === a)?.verdict
      return v('address_city_zip') !== undefined && v('address_city_zip') !== v('address_city')
    }).length,
    same_address_apn_differs: rows.filter((r) => r.verdict === 'SAME_ADDRESS_APN_DIFFERS').length,
    wrong_parcel: rows.filter((r) => r.verdict === 'WRONG_PARCEL').length,
    credits: rows.reduce((s, r) => s + r.credits, 0),
  }
}

function selfTest(): number {
  const fails: string[] = []
  const eq = (label: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  }
  const ctl: Parcel = { id: 'c', role: 'control', state: 'UT', county: 'Salt Lake', apn: '16183060290000', apn_printed: '16-18-306-029',
    address: '1815 S STATE ST', city: 'South Salt Lake', zip: null, recorded: { address: '1815 S State St', city: 'Salt Lake City' } }
  const ut: Parcel = { id: 'u', role: 'disagree', state: 'UT', county: 'Davis', apn: '120220101', apn_printed: null,
    address: '305 W CENTER ST', city: 'Clearfield', zip: '84015' }
  eq('control arms', planArms(ctl).map((a) => a.name), ['apn', 'apn_printed', 'address_recorded', 'address_city'])
  eq('a parcel with no printed APN gets no printed arm', planArms(ut).map((a) => a.name), ['apn', 'address_city', 'address_city_zip'])
  eq('no zip, no zip arm', planArms({ ...ut, zip: null }).map((a) => a.name), ['apn', 'address_city'])
  eq('no city, no address arm', planArms({ ...ut, city: null }).map((a) => a.name), ['apn'])
  eq('a failure is ERROR', classify(ut, { success: false, hit: false, property: null }), 'ERROR')
  eq('a miss is MISS', classify(ut, { success: true, hit: false, property: null }), 'MISS')
  eq('the same APN is RIGHT_APN', classify(ut, { success: true, hit: true, property: { apn: '12-022-0101', address: '305 W Center St' } }), 'RIGHT_APN')
  eq('the printed APN form is RIGHT_APN', classify(ctl, { success: true, hit: true, property: { apn: '16-18-306-029', address: '1815 S State St' } }), 'RIGHT_APN')
  eq('same street, other APN is not called right', classify(ut, { success: true, hit: true, property: { apn: '999', address: '305 Center Street' } }), 'SAME_ADDRESS_APN_DIFFERS')
  eq('a hit on another parcel is WRONG_PARCEL', classify(ut, { success: true, hit: true, property: { apn: '999', address: '12 Elm St' } }), 'WRONG_PARCEL')
  eq('the cap refuses the call that could cross it', [capAllows(40, 50), capAllows(41, 50)], [true, false])
  eq('an existing out dir is refused', outDirError('/tmp') !== null, true)
  const rows: Row[] = [
    { id: 'u', role: 'disagree', state: 'UT', county: 'Davis', arm: 'apn', verdict: 'MISS', credits: 0, returned_apn: null, returned_zip: null, error: null },
    { id: 'u', role: 'disagree', state: 'UT', county: 'Davis', arm: 'address_city', verdict: 'RIGHT_APN', credits: 10, returned_apn: '1', returned_zip: null, error: null },
  ]
  eq('an address hit after an APN miss is a rescue', summarize(rows).rescued_by_address, 1)
  if (fails.length) { console.error(`FAIL -- ${fails.join('\n  ')}`); return 1 }
  console.log('OK -- 13 cases'); return 0
}

function loadEnvLocal(path: string) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
  if (argv.includes('--self-test')) process.exit(selfTest())
  const modes = ['--dry-run', '--sandbox', '--live'].filter((m) => argv.includes(m))
  if (modes.length !== 1) { console.error('pass exactly one of --self-test, --dry-run, --sandbox, --live'); process.exit(2) }
  const mode = modes[0]
  const samplePath = flag('sample'), out = flag('out')
  if (!samplePath || !out) { console.error('--sample and --out are required'); process.exit(2) }
  const outErr = outDirError(out)
  if (outErr) { console.error(outErr); process.exit(2) }
  let capCredits = Number.POSITIVE_INFINITY
  if (mode === '--live') {
    const dollars = Number(flag('max-dollars'))
    if (!(dollars > 0)) { console.error('REFUSING: --live needs --max-dollars N'); process.exit(2) }
    capCredits = Math.floor(dollars / CREDIT_USD + 1e-9)
    loadEnvLocal(ENV_PATH)
  } else if (mode === '--sandbox') {
    process.env.TRACERFY_API_KEY = 'sandbox'
    process.env.TRACERFY_API_URL = 'https://mock.tracerfy.com/v1/api/'
  }
  delete process.env.FASTAPPEND_API_KEY
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(typeof input === 'string' ? input : (input as Request).url ?? String(input)).hostname
    if (!ALLOWED.has(host)) throw new Error(`BLOCKED ${host}`)
    return realFetch(input, init)
  }) as typeof fetch
  const { lookupDossier, buildDossierRequest } = await import('../../lib/tracerfy/dossier')

  const parcels: Parcel[] = JSON.parse(readFileSync(samplePath, 'utf8'))
  parcels.sort((a, b) => Number(b.role === 'control') - Number(a.role === 'control'))
  mkdirSync(out, { recursive: false })
  const rows: Row[] = []
  const finish = (code: number) => {
    writeFileSync(`${out}/results.json`, JSON.stringify({ mode, summary: summarize(rows.filter((r) => r.verdict !== 'DRY_RUN')), rows }, null, 2))
    const credits = rows.reduce((s, r) => s + r.credits, 0)
    console.log(`credits ${credits} = $${(credits * CREDIT_USD).toFixed(2)}; wrote ${out}/results.json`)
    process.exit(code)
  }
  let errorsInRow = 0
  for (const p of parcels) {
    let apnMissed = false
    for (const arm of planArms(p)) {
      if (arm.onlyIfApnMissed && !apnMissed) continue
      const request = buildDossierRequest(arm.key)
      if (mode === '--dry-run') {
        rows.push({ id: p.id, role: p.role, state: p.state, county: p.county, arm: arm.name, verdict: 'DRY_RUN', credits: 0,
          returned_apn: null, returned_zip: null, error: null, request })
        console.log(`${p.role.padEnd(8)} ${p.state} ${p.county.padEnd(12)} ${arm.name.padEnd(17)} ${JSON.stringify(request)}`)
        if (arm.name === 'apn') apnMissed = true
        continue
      }
      if (!capAllows(rows.reduce((s, r) => s + r.credits, 0), capCredits)) {
        console.error('CAP: the next call could cross --max-dollars; stopping'); finish(4)
      }
      const r = await lookupDossier(arm.key)
      const verdict = classify(p, r)
      if (arm.name === 'apn') apnMissed = verdict === 'MISS'
      errorsInRow = verdict === 'ERROR' ? errorsInRow + 1 : 0
      writeFileSync(`${out}/raw-${p.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}-${arm.name}.json`, JSON.stringify({ request, response: r }, null, 2))
      rows.push({ id: p.id, role: p.role, state: p.state, county: p.county, arm: arm.name, verdict, credits: r.creditsDeducted,
        returned_apn: r.property?.apn ?? null, returned_zip: r.property?.zip_code ?? null, error: r.error ?? null })
      console.log(`${p.role.padEnd(8)} ${p.state} ${p.county.padEnd(12)} ${arm.name.padEnd(17)} ${verdict}${r.error ? ` ${r.error}` : ''}`)
      if (errorsInRow >= 2) { console.error('two errors in a row; stopping'); finish(5) }
      await new Promise((res) => setTimeout(res, 400))
    }
    if (p.role === 'control' && mode === '--live') {
      const v = (n: ArmName) => rows.find((x) => x.id === p.id && x.arm === n)?.verdict
      if (v('apn') !== 'MISS' || !['RIGHT_APN', 'SAME_ADDRESS_APN_DIFFERS'].includes(String(v('address_recorded')))) {
        console.error('STOP: the control did not reproduce its 2026-09-16 record (APN miss, address hit). Nothing else runs.')
        finish(3)
      }
    }
  }
  finish(0)
}

main()
