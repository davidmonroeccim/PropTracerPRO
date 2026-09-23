/**
 * Phase 2 FastAppend vendor-yield probe.
 *
 * The question: PropTracerPRO routes a company-owned record to FastAppend on name and state
 * (spec D4), and across two live runs that lane has gone 3 misses out of 3 (two LLCs in
 * tasks/phase0-small-sample.md, one in tasks/phase1-live-check.md record L3). Spec Section 10
 * said that evidence should pull the FastAppend half out of the design if it never hits. Before
 * Phase 2 wires every company row of every bulk upload to that lane, the owner approved roughly
 * $1 to find out whether it EVER hits, on a sample spread across entity classes instead of ten
 * more small local LLCs (which is exactly the shape already known to miss and would teach
 * nothing new -- lesson L-023).
 *
 * This measures VENDOR YIELD ONLY. No wallet, no database, no trace rows, no API route. It
 * calls lib/tracerfy/client.ts's lookupBusinessTrace() directly.
 *
 * Modes: --plan (default), --live --max-dollars <n>. Run with no flags for --plan's output.
 *
 *   npx tsx tasks/research-scripts/phase2/probe-fastappend.ts --plan
 *   npx tsx tasks/research-scripts/phase2/probe-fastappend.ts --live --max-dollars <n>
 *
 * SAFETY, same house pattern as tasks/research-scripts/phase0/run-small.ts and
 * tasks/research-scripts/phase1/run-live.ts:
 *   1. SUPABASE_SERVICE_ROLE_KEY is scrubbed before anything else, and again after any
 *      .env.local load (the file could reintroduce it). The process cannot write to the
 *      database or charge a wallet no matter what --live does.
 *   2. --plan computes the worst case from the SAME constant production uses
 *      (VENDOR_COST.FASTAPPEND_ENTITY in lib/routing/ownerRoute.ts) and makes no vendor call.
 *   3. --live requires --max-dollars and refuses when the worst case exceeds it. Both that
 *      refusal and the missing/invalid --max-dollars refusal happen BEFORE any credential load
 *      or network call -- the worst case is computed from the sample file and the pure
 *      VENDOR_COST constant alone.
 *   4. --live installs a global fetch allowlist of ONE host, app.fastappend.com. This probe
 *      never calls Tracerfy, dossier, or anything else -- a call to any other host throws.
 *   5. The only static imports are node:*, ../phase0/guard (pure, no I/O) and type-only
 *      imports. lib/routing/ownerRoute and lib/tracerfy/client load with dynamic import()
 *      inside the mode that needs them, after the scrub.
 *   6. The terminal gets counts and classes only -- id, entity class, state, hit/miss, phone
 *      count, email count, latency. The entity name and state may also print (public county
 *      record; the probe is meaningless without them). Never a phone, an email, a contact
 *      name, a street, or a parcel id.
 */
import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { affordable } from '../phase0/guard'
import type { ContactResult } from '../../../lib/routing/executeRoute'

// First statement with any effect: never let an inherited shell env leak the DB key into a
// process that is about to dynamically import a production vendor client.
delete process.env.SUPABASE_SERVICE_ROLE_KEY

/* ------------------------------------------------------------------ *
 * Paths and constants
 * ------------------------------------------------------------------ */

const ENV_PATH = '/Users/davidmonroe/PropTracerPRO/.env.local'
const SAMPLE_PATH_DEFAULT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase2/entity-probe.json'
const CALLS_PATH = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase2/probe.jsonl'

const FASTAPPEND_HOST = 'app.fastappend.com'

/* ------------------------------------------------------------------ *
 * Sample shape (entity-probe.json)
 * ------------------------------------------------------------------ */

type EntityClass = 'llc_small' | 'corporation' | 'institutional' | 'nonprofit' | 'government'

const KNOWN_CLASSES: EntityClass[] = ['llc_small', 'corporation', 'institutional', 'nonprofit', 'government']

interface ProbeRecord {
  id: string
  entity_class: EntityClass
  state: string
  county: string
  company_name: string
  /** Where the name came from -- never printed, kept for the report. */
  provenance: string
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ *
 * CLI flags
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2)

/** Value flags: accepts both "--max-dollars 1" (space, matches run-live.ts) and "--max-dollars=1". */
const arg = (name: string): string | undefined => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(eq.indexOf('=') + 1)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

/** Boolean flags: present or not, never consumes the next argv element. */
const hasFlag = (name: string): boolean =>
  argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`))

/* ------------------------------------------------------------------ *
 * Validation -- pure, no I/O beyond the read call in readSample()
 * ------------------------------------------------------------------ */

function validateRecord(r: ProbeRecord): string[] {
  const errors: string[] = []
  if (!r.id || typeof r.id !== 'string') errors.push('missing id')
  if (!KNOWN_CLASSES.includes(r.entity_class)) errors.push(`unknown entity_class "${String(r.entity_class)}"`)
  if (!r.state || !/^[A-Za-z]{2}$/.test(r.state)) errors.push('state must be 2 letters')
  if (!r.county || !r.county.trim()) errors.push('missing county')
  if (!r.company_name || !r.company_name.trim()) errors.push('missing company_name')
  if (!r.provenance || !r.provenance.trim()) errors.push('missing provenance')
  return errors
}

/** Sampling rules (binding): unique ids, and one record per state -- ten different states. */
function validateAll(records: ProbeRecord[]): string[] {
  const errors: string[] = []
  const seenIds = new Set<string>()
  const seenStates = new Set<string>()
  for (const r of records) {
    const label = r.id || '(no id)'
    if (r.id && seenIds.has(r.id)) errors.push(`duplicate id "${r.id}"`)
    if (r.id) seenIds.add(r.id)
    if (r.state && seenStates.has(r.state.toUpperCase())) {
      errors.push(`state "${r.state}" used more than once -- one record per state`)
    }
    if (r.state) seenStates.add(r.state.toUpperCase())
    for (const e of validateRecord(r)) errors.push(`${label}: ${e}`)
  }
  return errors
}

function readSample(path: string): ProbeRecord[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    console.error(`Could not read ${path}: ${msg(err)}`)
    process.exit(1)
  }
  try {
    return JSON.parse(text) as ProbeRecord[]
  } catch (err) {
    console.error(`Could not parse ${path} as JSON: ${msg(err)}`)
    process.exit(1)
  }
}

/* ------------------------------------------------------------------ *
 * Worst case -- derived from the SAME constant production uses
 * (VENDOR_COST.FASTAPPEND_ENTITY, lib/routing/ownerRoute.ts), never a literal typed here.
 * Pure and side-effect-free: lib/routing/ownerRoute.ts does no I/O and makes no vendor call,
 * so importing it computes no charge and needs no credential.
 * ------------------------------------------------------------------ */

interface PricedRecord {
  record: ProbeRecord
  worst: number
}

async function priceRecords(records: ProbeRecord[]): Promise<{ priced: PricedRecord[]; total: number }> {
  const { VENDOR_COST } = await import('../../../lib/routing/ownerRoute')
  const priced = records.map((record) => ({ record, worst: VENDOR_COST.FASTAPPEND_ENTITY }))
  const total = round2(priced.reduce((a, p) => a + p.worst, 0))
  return { priced, total }
}

function printPriced(priced: PricedRecord[], total: number): void {
  for (const p of priced) {
    const r = p.record
    console.log(
      `${r.id} class=${r.entity_class} state=${r.state} "${r.company_name}" worst=$${p.worst.toFixed(2)}`,
    )
  }
  console.log(`TOTAL worst case: $${total.toFixed(2)} across ${priced.length} record(s)`)
}

/* ------------------------------------------------------------------ *
 * --plan
 * ------------------------------------------------------------------ */

async function runPlan(samplePath: string): Promise<void> {
  const records = readSample(samplePath)
  const errors = validateAll(records)
  if (errors.length) {
    console.error('INVALID sample:')
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }
  const { priced, total } = await priceRecords(records)
  printPriced(priced, total)
  console.log('PLAN MODE: no vendor call, no wallet spend, no database read or write.')
}

/* ------------------------------------------------------------------ *
 * .env.local -- parsed by hand, same as run-small.ts / run-live.ts. Reads only; never
 * prints a value.
 * ------------------------------------------------------------------ */

function loadEnvLocal(path: string): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.error(`Could not read ${path}. --live needs it for the FastAppend API key.`)
    return
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

/* ------------------------------------------------------------------ *
 * Fetch allowlist + exchange recorder, installed only inside --live. ONE host: this probe
 * measures FastAppend and nothing else.
 * ------------------------------------------------------------------ */

interface RawExchange {
  host: string
  path: string
  method: string
  request_body: unknown
  status: number | null
  response_body: unknown
  ms: number
  error: string | null
}

let currentExchanges: RawExchange[] = []

function parseJsonSafe(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function installFetchWrapper(): void {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input)
    const u = new URL(url)
    const host = u.hostname
    const method = (init?.method || 'GET').toUpperCase()
    const requestBody = init?.body && typeof init.body === 'string' ? parseJsonSafe(init.body) : null
    const start = Date.now()

    if (host !== FASTAPPEND_HOST) {
      currentExchanges.push({
        host,
        path: u.pathname,
        method,
        request_body: requestBody,
        status: null,
        response_body: null,
        ms: Date.now() - start,
        error: 'BLOCKED',
      })
      throw new Error(`BLOCKED host ${host}: this probe measures FastAppend only`)
    }

    try {
      const res = await realFetch(input, init)
      const text = await res.clone().text()
      currentExchanges.push({
        host,
        path: u.pathname,
        method,
        request_body: requestBody,
        status: res.status,
        response_body: parseJsonSafe(text),
        ms: Date.now() - start,
        error: null,
      })
      return res
    } catch (err) {
      currentExchanges.push({
        host,
        path: u.pathname,
        method,
        request_body: requestBody,
        status: null,
        response_body: null,
        ms: Date.now() - start,
        error: msg(err),
      })
      throw err
    }
  }) as typeof fetch
}

/** Refuse to run --live against anything but the real vendor. A sandbox lies. */
async function assertRealFastAppendHost(): Promise<void> {
  const { FASTAPPEND } = await import('../../../lib/constants')
  let host: string
  try {
    host = new URL(FASTAPPEND.BASE_URL).hostname
  } catch {
    host = ''
  }
  if (host !== FASTAPPEND_HOST) {
    console.error(
      `REFUSED: FASTAPPEND.BASE_URL resolves to host "${host}", not ${FASTAPPEND_HOST}. A sandbox returns fake data.`,
    )
    process.exit(2)
  }
}

/* ------------------------------------------------------------------ *
 * --live
 * ------------------------------------------------------------------ */

async function runLive(maxDollars: number, samplePath: string): Promise<void> {
  // Everything through the end of this block is pure: a file read and the same constant
  // --plan uses. No credential load, no network call, regardless of what maxDollars is.
  const records = readSample(samplePath)
  const errors = validateAll(records)
  if (errors.length) {
    console.error('INVALID sample, refusing to spend:')
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }
  const { priced, total } = await priceRecords(records)
  printPriced(priced, total)

  // Refusal 0, added 2026-09-23 after this script spent real money on its own (lessons L-031).
  // A `--max-dollars` cap cannot protect anything when an automated caller sets the cap equal to
  // the worst case: refusal 2 tests "exceeds", and $1.00 does not exceed $1.00, so the run
  // proceeded. The durable guard is not a bigger number, it is a token an implementer following
  // its brief has no reason to invent. A human runs this; an agent building it never does.
  if (process.env.PTP_LIVE_RUN !== '1') {
    console.error(
      'REFUSED: --live needs PTP_LIVE_RUN=1 in the environment. This exists so an agent building or ' +
        'testing this script cannot spend money by passing --live, however the cap is set. Not run.'
    )
    process.exit(2)
  }
  // Refusal 1: --max-dollars missing or not a positive number.
  if (!Number.isFinite(maxDollars) || maxDollars <= 0) {
    console.error('REFUSED: --max-dollars must be a number greater than 0. Not run.')
    process.exit(2)
  }
  // Refusal 2: computed worst case exceeds the approved cap.
  if (total > maxDollars) {
    console.error(`REFUSED: worst case $${total.toFixed(2)} exceeds approved $${maxDollars.toFixed(2)}. Not run.`)
    process.exit(2)
  }

  // ---- Only past both refusals does anything touch a credential or the network. ----
  loadEnvLocal(ENV_PATH)
  delete process.env.SUPABASE_SERVICE_ROLE_KEY // .env.local could reintroduce it; scrub again

  if (!process.env.FASTAPPEND_API_KEY) {
    console.error('REFUSED: FASTAPPEND_API_KEY must be set')
    process.exit(2)
  }
  if (existsSync(CALLS_PATH)) {
    console.error(`REFUSED: ${CALLS_PATH} already exists. A re-run re-buys hits; move it first.`)
    process.exit(2)
  }

  await assertRealFastAppendHost()
  installFetchWrapper()

  const { lookupBusinessTrace } = await import('../../../lib/tracerfy/client')
  const { VENDOR_COST } = await import('../../../lib/routing/ownerRoute')

  let spent = 0
  let hits = 0
  console.log(`Live run starting. Worst case $${total.toFixed(2)} of $${maxDollars.toFixed(2)} approved.`)

  for (const p of priced) {
    const record = p.record
    if (!affordable(spent, p.worst, maxDollars)) {
      console.log(
        `STOPPED before ${record.id}: spent $${round2(spent).toFixed(2)}, next worst case ` +
          `$${p.worst.toFixed(2)} would exceed cap $${maxDollars.toFixed(2)}.`,
      )
      break
    }

    currentExchanges = []
    const start = Date.now()
    let result: ContactResult | null = null
    let thrown: string | null = null
    try {
      result = await lookupBusinessTrace({ company_name: record.company_name, state: record.state })
    } catch (err) {
      thrown = msg(err)
    }
    const ms = Date.now() - start

    const hit = result?.hit === true
    if (hit) hits++
    const dollars = hit ? VENDOR_COST.FASTAPPEND_ENTITY : 0
    spent = round2(spent + dollars)
    const phones = result?.contacts?.phones.length ?? 0
    const emails = result?.contacts?.emails.length ?? 0

    appendFileSync(
      CALLS_PATH,
      JSON.stringify({
        id: record.id,
        entity_class: record.entity_class,
        state: record.state,
        county: record.county,
        company_name: record.company_name,
        provenance: record.provenance,
        ms,
        dollars,
        hit,
        phones,
        emails,
        error: result?.error ?? thrown,
        raw: currentExchanges,
      }) + '\n',
    )

    console.log(
      `${record.id} class=${record.entity_class} state=${record.state} "${record.company_name}": ` +
        `${thrown ? `FAILED (${thrown})` : hit ? 'HIT' : 'MISS'} phones=${phones} emails=${emails} ${ms}ms ` +
        `total $${spent.toFixed(2)}`,
    )

    await sleep(300)
  }

  console.log(`DONE. Spent $${spent.toFixed(2)} of $${maxDollars.toFixed(2)}. ${hits} hit(s) of ${priced.length}.`)
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const samplePath = arg('sample') || SAMPLE_PATH_DEFAULT
  const isPlan = hasFlag('plan')
  const isLive = hasFlag('live')

  // --plan and --live are not meant to be given together; if they are, --plan wins (safer of
  // the two: --plan alone is always safe, so there is no reason to make the combination an
  // error), mirroring tasks/research-scripts/phase1/run-live.ts fix round 1, item 3.
  if (isLive && !isPlan) {
    const n = Number(arg('max-dollars'))
    await runLive(n, samplePath)
    return
  }
  await runPlan(samplePath)
}

main().catch((err) => {
  console.error(msg(err))
  process.exit(1)
})
