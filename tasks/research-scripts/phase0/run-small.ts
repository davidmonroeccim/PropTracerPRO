/**
 * Phase 0 small runner (spec D19).
 *
 * David cut Phase 0 to eight real records, one per lookup path, to learn whether each path WORKS
 * before Phase 1 builds on it. This script makes those eight calls through the PRODUCTION vendor
 * clients, records every raw request and response, and writes a counts-only report. No production
 * code changes. It spends real money only in `--live`, and only up to the amount David names.
 *
 * Brief: .superpowers/sdd/2026-09-21-tier1-phase0-measurement/small-runner-brief.md
 *
 * SAFETY, same house pattern as tasks/research-scripts/dossier-client-check.ts:
 *   1. SUPABASE_SERVICE_ROLE_KEY is scrubbed before anything else, and again after any .env.local
 *      load (the file could reintroduce it).
 *   2. The only static imports are node:*, ./guard and type-only imports. Every lib/ module and
 *      ./match (it imports lib/routing/ownerRoute) load with dynamic import() inside the mode that
 *      needs them, after the scrub.
 *   3. --live and --balance install a global fetch allowlist (tracerfy.com, app.fastappend.com
 *      only) and refuse to run against anything but the real tracerfy.com host.
 *   4. Never print an owner name, street or parcel id to the terminal, in any mode.
 *
 * Modes: --plan (default), --live --max-dollars=<n>, --balance, --report, --selftest.
 * Run `npx tsx tasks/research-scripts/phase0/run-small.ts` with no flags for --plan's usage.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { affordable } from './guard'
import type { ContactResult, ExecutionResult } from '../../../lib/routing/executeRoute'

// First statement with any effect: never let an inherited shell env leak the DB key into a
// process that is about to dynamically import production vendor clients.
delete process.env.SUPABASE_SERVICE_ROLE_KEY

/* ------------------------------------------------------------------ *
 * Paths and constants
 * ------------------------------------------------------------------ */

const ENV_PATH = '/Users/davidmonroe/PropTracerPRO/.env.local'
const SAMPLE_PATH_DEFAULT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0/small-sample.json'
const GATE_B_PATH = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0/small-gate-b.json'
const CALLS_PATH = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0/small-calls.jsonl'
const BALANCE_PATH = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/phase0/small-balance.jsonl'
const REPORT_PATH = '/Users/davidmonroe/PropTracerPRO/tasks/phase0-small-sample.md'

const TRACERFY_HOST = 'tracerfy.com'
const FASTAPPEND_HOST = 'app.fastappend.com'

/* ------------------------------------------------------------------ *
 * Input shape (small-sample.json), verbatim from the brief
 * ------------------------------------------------------------------ */

type Path = 'tracerfy_address' | 'tracerfy_apn' | 'fastappend' | 'apn_probe' | 'dossier'

interface SmallRecord {
  slot: string
  path: Path
  state: string
  county: string
  fips: string
  property_type: string
  owner_name: string | null
  site_address: string | null
  situs_city: string | null
  situs_zip: string | null
  parcel_id_local: string | null
}

const KNOWN_PATHS: Path[] = ['tracerfy_address', 'tracerfy_apn', 'fastappend', 'apn_probe', 'dossier']

/** Endpoint(s) each path may hit, for --plan's printout. Never a network call. */
const ENDPOINTS: Record<Path, string> = {
  tracerfy_address: 'tracerfy trace/lookup/',
  tracerfy_apn: 'tracerfy trace/parcel/lookup/',
  fastappend: 'fastappend business-trace/lookup/',
  apn_probe: 'tracerfy trace/parcel/lookup/',
  dossier:
    'tracerfy property-search/lookup/ (apn and/or address), then trace/lookup/ or ' +
    'trace/parcel/lookup/ or business-trace/lookup/ depending on the discovered owner',
}

/** Worst case per record from the brief: misses are free on all four vendor endpoints. */
const WORST_CASE: Record<Path, number> = {
  tracerfy_address: 0.1,
  tracerfy_apn: 0.1,
  fastappend: 0.1,
  apn_probe: 0.1,
  dossier: 0.3,
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/* ------------------------------------------------------------------ *
 * CLI flags
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : ''
}
const has = (name: string): boolean => flag(name) !== undefined

/* ------------------------------------------------------------------ *
 * Validation, shared by --plan and --live
 * ------------------------------------------------------------------ */

/** "Stark County" / "Iberia Parish" / "Juneau Borough" — Tracerfy wants the bare name. */
function countyLooksBad(county: string): boolean {
  return /\b(county|parish|borough)\s*$/i.test(county.trim())
}

function validateRecord(r: SmallRecord): string[] {
  const errors: string[] = []
  if (!r.slot || typeof r.slot !== 'string') errors.push('missing slot')
  if (!KNOWN_PATHS.includes(r.path)) errors.push(`unknown path "${String(r.path)}"`)
  if (!r.state || !/^[A-Za-z]{2}$/.test(r.state)) errors.push('state must be 2 letters')
  if (!r.county || !r.county.trim()) errors.push('missing county')
  else if (countyLooksBad(r.county)) errors.push(`county must be bare, not "${r.county}"`)
  if (!r.fips || !r.fips.trim()) errors.push('missing fips')
  if (!r.property_type || !r.property_type.trim()) errors.push('missing property_type')

  const hasOwner = Boolean(r.owner_name?.trim())
  const hasStreetCity = Boolean(r.site_address?.trim() && r.situs_city?.trim())
  const hasApn = Boolean(r.parcel_id_local?.trim() && r.county?.trim())

  switch (r.path) {
    case 'tracerfy_address':
      if (!hasOwner) errors.push('tracerfy_address requires owner_name')
      if (!hasStreetCity) errors.push('tracerfy_address requires site_address and situs_city')
      break
    case 'tracerfy_apn':
      if (!hasOwner) errors.push('tracerfy_apn requires owner_name')
      if (!hasApn) errors.push('tracerfy_apn requires parcel_id_local and county')
      break
    case 'fastappend':
      if (!hasOwner) errors.push('fastappend requires owner_name')
      break
    case 'apn_probe':
      if (!hasApn) errors.push('apn_probe requires parcel_id_local and county')
      break
    case 'dossier':
      if (!hasApn && !hasStreetCity) {
        errors.push('dossier requires parcel_id_local+county or site_address+situs_city')
      }
      break
    default:
      // unknown path already flagged above
      break
  }
  return errors
}

function validateAll(records: SmallRecord[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const r of records) {
    const label = r.slot || '(no slot)'
    if (r.slot && seen.has(r.slot)) errors.push(`duplicate slot "${r.slot}"`)
    if (r.slot) seen.add(r.slot)
    for (const e of validateRecord(r)) errors.push(`${label}: ${e}`)
  }
  return errors
}

function readSample(path: string): SmallRecord[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    console.error(`Could not read ${path}: ${msg(err)}`)
    process.exit(1)
  }
  try {
    return JSON.parse(text) as SmallRecord[]
  } catch (err) {
    console.error(`Could not parse ${path} as JSON: ${msg(err)}`)
    process.exit(1)
  }
}

/* ------------------------------------------------------------------ *
 * --plan
 * ------------------------------------------------------------------ */

function runPlan(samplePath: string): void {
  const records = readSample(samplePath)
  const errors = validateAll(records)
  if (errors.length) {
    console.error('INVALID sample:')
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }

  let total = 0
  for (const r of records) {
    const worst = WORST_CASE[r.path]
    total = round2(total + worst)
    console.log(
      `${r.slot} ${r.path} ${r.state} ${r.county} ${r.property_type} ` +
        `endpoint=${ENDPOINTS[r.path]} worst=$${worst.toFixed(2)}`,
    )
  }
  console.log(`TOTAL worst case: $${total.toFixed(2)} across ${records.length} record(s)`)
}

/* ------------------------------------------------------------------ *
 * Spend accounting — pure, tested by --selftest
 * ------------------------------------------------------------------ */

interface SpendExchange {
  host: string
  path: string
  response_body: unknown
}

function unwrapBody(body: unknown): unknown {
  return Array.isArray(body) ? body[0] : body
}

interface SpendResult {
  dollars: number
  credits: number
  credits_inferred: boolean
}

/**
 * Spend per call from the vendor's own answers (brief, "The call each path makes"):
 *   Tracerfy credits_deducted, when numeric, is authoritative (array bodies unwrapped to [0]).
 *   A Tracerfy body with hit === true and no numeric credits_deducted is INFERRED: 10 credits on
 *   a property-search path (the dossier), 5 otherwise.
 *   A FastAppend body with hit === true counts a flat $0.10.
 *   Dollars = credits x 0.02 + FastAppend dollars, rounded to the cent.
 */
function computeSpend(exchanges: SpendExchange[]): SpendResult {
  let credits = 0
  let fastappendDollars = 0
  let creditsInferred = false

  for (const ex of exchanges) {
    const body = unwrapBody(ex.response_body)
    if (!isObj(body)) continue

    if (ex.host === FASTAPPEND_HOST) {
      if (body.hit === true) fastappendDollars = round2(fastappendDollars + 0.1)
      continue
    }

    if (typeof body.credits_deducted === 'number') {
      credits += body.credits_deducted
    } else if (body.hit === true) {
      const isPropertySearch = ex.path.includes('property-search')
      credits += isPropertySearch ? 10 : 5
      creditsInferred = true
    }
  }

  return {
    dollars: round2(credits * 0.02 + fastappendDollars),
    credits,
    credits_inferred: creditsInferred,
  }
}

/* ------------------------------------------------------------------ *
 * --live refusal preflight — pure enough to self-test without files
 * ------------------------------------------------------------------ */

function refuseLiveReason(n: number, gateBPath: string): string | null {
  if (!(n > 0)) return 'max-dollars must be a number greater than 0'

  let gate: unknown
  try {
    gate = JSON.parse(readFileSync(gateBPath, 'utf8'))
  } catch {
    return `${gateBPath} is missing or unreadable`
  }
  if (!isObj(gate)) return `${gateBPath} does not contain a JSON object`
  if (typeof gate.approved_dollars !== 'number' || !(gate.approved_dollars > 0)) {
    return 'gate-b approved_dollars must be a positive number'
  }
  if (typeof gate.answered_by !== 'string' || !gate.answered_by.trim()) {
    return 'gate-b answered_by must be a non-empty string'
  }
  if (typeof gate.david_words !== 'string' || !gate.david_words.trim()) {
    return 'gate-b david_words must be a non-empty string'
  }
  if (!(n <= gate.approved_dollars)) return 'max-dollars exceeds gate-b approved_dollars'
  return null
}

/* ------------------------------------------------------------------ *
 * .env.local — parsed by hand, same as dossier-client-check.ts, so this script runs with
 * nothing but tsx. Reads only; never prints a value.
 * ------------------------------------------------------------------ */

function loadEnvLocal(path: string): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.error(`Could not read ${path}. --live and --balance need it for the vendor API keys.`)
    return
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

/* ------------------------------------------------------------------ *
 * Fetch allowlist + exchange recorder, installed only inside --live / --balance
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

/** Reset before each production call; the fetch wrapper appends every HTTP exchange it makes. */
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
    const requestBody =
      init?.body && typeof init.body === 'string' ? parseJsonSafe(init.body) : null
    const start = Date.now()

    if (host !== TRACERFY_HOST && host !== FASTAPPEND_HOST) {
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
      throw new Error(`BLOCKED host ${host}`)
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

/** Refuse to run --live/--balance against anything but the real vendor. A sandbox lies. */
async function assertRealTracerfyHost(): Promise<void> {
  const { TRACERFY } = await import('../../../lib/constants')
  const baseUrl = process.env.TRACERFY_API_URL || TRACERFY.BASE_URL
  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    host = ''
  }
  if (host !== TRACERFY_HOST) {
    console.error(
      `REFUSED: TRACERFY_API_URL/TRACERFY.BASE_URL resolves to host "${host}", not ${TRACERFY_HOST}. ` +
        'A sandbox returns fake data.',
    )
    process.exit(2)
  }
}

/* ------------------------------------------------------------------ *
 * --live
 * ------------------------------------------------------------------ */

async function runLive(n: number, samplePath: string): Promise<void> {
  const reason = refuseLiveReason(n, GATE_B_PATH)
  if (reason) {
    console.error(`REFUSED: ${reason}`)
    process.exit(2)
  }

  loadEnvLocal(ENV_PATH)
  delete process.env.SUPABASE_SERVICE_ROLE_KEY // .env.local could reintroduce it; scrub again

  if (!process.env.TRACERFY_API_KEY || !process.env.FASTAPPEND_API_KEY) {
    console.error('REFUSED: TRACERFY_API_KEY and FASTAPPEND_API_KEY must both be set')
    process.exit(2)
  }
  if (existsSync(CALLS_PATH)) {
    console.error(`REFUSED: ${CALLS_PATH} already exists. A re-run re-buys; move it first.`)
    process.exit(2)
  }

  await assertRealTracerfyHost()
  installFetchWrapper()

  const { lookupPersonTrace, lookupBusinessTrace } = await import('../../../lib/tracerfy/client')
  const { lookupDossier } = await import('../../../lib/tracerfy/dossier')
  const { planRoute, splitPersonName } = await import('../../../lib/routing/ownerRoute')
  const { executeRoute, contactVendorFrom } = await import('../../../lib/routing/executeRoute')
  const { parcelForFullTrace } = await import('../../../lib/trace/fullPropertyTrace')

  const records = readSample(samplePath)
  const errors = validateAll(records)
  if (errors.length) {
    console.error('INVALID sample, refusing to spend:')
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }

  let spent = 0
  for (const record of records) {
    const worst = WORST_CASE[record.path]
    if (!affordable(spent, worst, n)) {
      console.log(
        `STOPPED before ${record.slot}: spent $${round2(spent).toFixed(2)}, next worst case ` +
          `$${worst.toFixed(2)} would exceed cap $${n.toFixed(2)}.`,
      )
      return
    }

    currentExchanges = []
    let thrown: string | null = null
    let result: ContactResult | ExecutionResult | null = null
    let sentName = ''
    const start = Date.now()

    try {
      switch (record.path) {
        case 'tracerfy_address': {
          const name = splitPersonName(record.owner_name ?? '')
          sentName = [name.first_name, name.last_name].filter(Boolean).join(' ')
          result = await lookupPersonTrace({
            ...name,
            address: record.site_address ?? '',
            city: record.situs_city ?? '',
            state: record.state,
            ...(record.situs_zip ? { zip: record.situs_zip } : {}),
            find_owner: false,
          })
          break
        }
        case 'tracerfy_apn': {
          const name = splitPersonName(record.owner_name ?? '')
          // Carried for the parser, never sent: lookupPersonTrace's byParcel branch omits it.
          result = await lookupPersonTrace({
            ...name,
            parcel_id: record.parcel_id_local ?? '',
            county: record.county,
            state: record.state,
          })
          break
        }
        case 'fastappend': {
          sentName = record.owner_name ?? ''
          result = await lookupBusinessTrace({ company_name: record.owner_name ?? '', state: record.state })
          break
        }
        case 'apn_probe': {
          result = await lookupPersonTrace({
            first_name: '',
            last_name: '',
            parcel_id: record.parcel_id_local ?? '',
            county: record.county,
            state: record.state,
          })
          break
        }
        case 'dossier': {
          const parcel = parcelForFullTrace({
            address: record.site_address ?? '',
            city: record.situs_city ?? '',
            state: record.state,
            zip: record.situs_zip,
            apn: record.parcel_id_local,
            county: record.county,
          })
          const plan = planRoute(parcel, 'pro')
          const exec = await executeRoute(plan, {
            lookupDossier,
            traceEntity: lookupBusinessTrace,
            tracePerson: lookupPersonTrace,
          })
          result = exec
          const vendor = contactVendorFrom(exec.steps)
          const contactStep = exec.steps.find(
            (s) =>
              s.kind === 'FASTAPPEND_ENTITY' ||
              s.kind === 'TRACERFY_INSTANT_NAMED' ||
              s.kind === 'TRACERFY_PARCEL_APN',
          )
          if (vendor === 'fastappend' && exec.ownerName) {
            sentName = exec.ownerName
          } else if (vendor === 'tracerfy' && contactStep?.kind === 'TRACERFY_INSTANT_NAMED' && exec.ownerName) {
            const n2 = splitPersonName(exec.ownerName)
            sentName = [n2.first_name, n2.last_name].filter(Boolean).join(' ')
          }
          break
        }
      }
    } catch (err) {
      thrown = msg(err)
    }

    const ms = Date.now() - start
    const spend = computeSpend(currentExchanges)
    spent = round2(spent + spend.dollars)

    const line = {
      slot: record.slot,
      path: record.path,
      state: record.state,
      county: record.county,
      fips: record.fips,
      property_type: record.property_type,
      owner_name: record.owner_name,
      sent_name: sentName,
      ms,
      dollars: spend.dollars,
      credits: spend.credits,
      credits_inferred: spend.credits_inferred,
      thrown,
      result,
      raw: currentExchanges,
    }
    appendFileSync(CALLS_PATH, JSON.stringify(line) + '\n')

    const codes = currentExchanges.map((e) => e.status ?? 'ERR').join(',') || 'none'
    console.log(
      `${record.slot} ${record.path} ${record.state} ${record.county}: status ${codes}, ` +
        `$${spend.dollars.toFixed(2)}, total $${spent.toFixed(2)}`,
    )

    await sleep(300)
  }

  console.log(`DONE. Spent $${spent.toFixed(2)} of $${n.toFixed(2)}.`)
}

/* ------------------------------------------------------------------ *
 * --balance
 * ------------------------------------------------------------------ */

async function runBalance(): Promise<void> {
  loadEnvLocal(ENV_PATH)
  delete process.env.SUPABASE_SERVICE_ROLE_KEY

  await assertRealTracerfyHost()
  installFetchWrapper()

  const { getAnalytics } = await import('../../../lib/tracerfy/client')
  const at = new Date().toISOString()
  const res = await getAnalytics()
  const entry = {
    at,
    success: res.success,
    balance: res.data?.balance ?? null,
    error: res.error ?? null,
  }
  appendFileSync(BALANCE_PATH, JSON.stringify(entry) + '\n')
  console.log(JSON.stringify(entry))
}

/* ------------------------------------------------------------------ *
 * --report
 * ------------------------------------------------------------------ */

interface CallLine {
  slot: string
  path: Path
  state: string
  county: string
  fips: string
  property_type: string
  owner_name: string | null
  sent_name: string
  ms: number
  dollars: number
  credits: number
  credits_inferred: boolean
  thrown: string | null
  result: unknown
  raw: RawExchange[]
}

/**
 * Decide the host FIRST. The substring 'trace/lookup' is literally contained inside
 * 'business-trace/lookup/' ('...business-' + 'trace/lookup/'), so a path-only substring check
 * mislabels every FastAppend exchange as 'instant'. FASTAPPEND_HOST is unambiguous and is the
 * same signal computeSpend() already keys its own vendor split on.
 */
function classifyEndpoint(host: string, path: string): 'instant' | 'apn' | 'dossier' | 'fastappend' | 'unknown' {
  if (host === FASTAPPEND_HOST) return 'fastappend'
  if (path.includes('property-search')) return 'dossier'
  if (path.includes('trace/parcel/lookup')) return 'apn'
  if (path.includes('trace/lookup')) return 'instant'
  return 'unknown'
}

function personsOf(body: unknown): Array<Record<string, unknown>> {
  const b = unwrapBody(body)
  if (!isObj(b) || !Array.isArray(b.persons)) return []
  return b.persons.filter(isObj)
}

function exchangeSummary(ex: RawExchange): string {
  const body = unwrapBody(ex.response_body)
  const hit = isObj(body) ? body.hit : undefined
  const credits = isObj(body) && typeof body.credits_deducted === 'number' ? body.credits_deducted : 'n/a'
  const people = isObj(body)
    ? typeof body.persons_count === 'number'
      ? body.persons_count
      : Array.isArray(body.persons)
        ? body.persons.length
        : Array.isArray(body.associated_people)
          ? body.associated_people.length
          : 'n/a'
    : 'n/a'
  return (
    `endpoint ${classifyEndpoint(ex.host, ex.path)}, HTTP ${ex.status ?? 'none'}, hit ${String(hit)}, ` +
    `people ${people}, credits_deducted ${credits}, ${ex.ms}ms`
  )
}

type MatchFn = (person: { first_name?: unknown; last_name?: unknown }, ownerName: string) => string | null

function contactCounts(result: unknown): { phones: number; emails: number } {
  const r = isObj(result) ? result : null
  const contacts = r && isObj(r.contacts) ? r.contacts : null
  const phones = contacts && Array.isArray(contacts.phones) ? contacts.phones.length : 0
  const emails = contacts && Array.isArray(contacts.emails) ? contacts.emails.length : 0
  return { phones, emails }
}

function costLine(call: CallLine): string {
  return `cost: ${call.dollars > 0 ? `$${call.dollars.toFixed(2)}` : 'free'}`
}

function reportTracerfySection(call: CallLine, personMatchesOwner: MatchFn): string[] {
  const lines: string[] = []
  for (const ex of call.raw) lines.push(`- ${exchangeSummary(ex)}`)
  if (!call.raw.length) lines.push('- no exchange recorded')

  const persons = personsOf(call.raw[0]?.response_body)
  let matchKind = 'none'
  let matched: Record<string, unknown> | undefined
  for (const p of persons) {
    const mk = personMatchesOwner({ first_name: p.first_name, last_name: p.last_name }, call.owner_name ?? '')
    if (mk) {
      matchKind = mk
      matched = p
      break
    }
  }
  lines.push(`- name test: ${matchKind}`)
  if (matched) {
    lines.push(`- matched person property_owner: ${String(matched.property_owner === true)}`)
    const phones = Array.isArray(matched.phones) ? matched.phones.length : 0
    const emails = Array.isArray(matched.emails) ? matched.emails.length : 0
    lines.push(`- matched person phones: ${phones}, emails: ${emails}`)
  } else {
    lines.push('- no matched person')
  }

  const parser = contactCounts(call.result)
  lines.push(`- production parser (falls back to persons[0], client.ts:602) phones: ${parser.phones}, emails: ${parser.emails}`)
  lines.push(`- ${costLine(call)}`)
  return lines
}

function reportFastappendSection(call: CallLine): string[] {
  const lines: string[] = []
  for (const ex of call.raw) lines.push(`- ${exchangeSummary(ex)}`)
  if (!call.raw.length) lines.push('- no exchange recorded')

  const body = unwrapBody(call.raw[0]?.response_body)
  const hit = isObj(body) ? body.hit === true : false
  lines.push(`- ${hit ? 'hit' : 'miss'}`)
  const people = isObj(body) && Array.isArray(body.associated_people) ? body.associated_people.filter(isObj) : []
  lines.push(`- people returned: ${people.length}`)
  const parser = contactCounts(call.result)
  lines.push(`- production parser phones: ${parser.phones}, emails: ${parser.emails}`)
  const roles = people
    .map((p) => (typeof p.role === 'string' ? p.role : ''))
    .filter(Boolean)
  if (roles.length) lines.push(`- role values: ${roles.join('; ')}`)
  lines.push(`- ${costLine(call)}`)
  return lines
}

function reportApnProbeSection(call: CallLine): string[] {
  const lines: string[] = []
  const ex = call.raw[0]
  if (!ex) {
    lines.push('- no exchange recorded')
    lines.push(`- ${costLine(call)}`)
    return lines
  }
  lines.push(`- HTTP ${ex.status ?? 'none'}`)
  const body = unwrapBody(ex.response_body)
  const keys = isObj(body) ? Object.keys(body) : []
  lines.push(`- body keys: ${keys.join(', ') || 'none'}`)
  const hit = isObj(body) ? body.hit : undefined
  lines.push(`- hit: ${String(hit)}`)
  const credits = isObj(body) && typeof body.credits_deducted === 'number' ? body.credits_deducted : 'n/a'
  lines.push(`- credits_deducted: ${credits}`)
  if (hit !== true) {
    const detail = isObj(body) ? (body.error ?? body.detail ?? body.message) : undefined
    if (typeof detail === 'string' && detail) lines.push(`- message: ${detail.slice(0, 120)}`)
  }
  lines.push(`- ${costLine(call)}`)
  return lines
}

function reportDossierSection(call: CallLine, personMatchesOwner: MatchFn): string[] {
  const lines: string[] = []
  const exec = isObj(call.result) ? call.result : null
  const steps = exec && Array.isArray(exec.steps) ? (exec.steps as Array<Record<string, unknown>>) : []

  const dossierHit = steps.find(
    (s) => (s.kind === 'DOSSIER_APN' || s.kind === 'DOSSIER_ADDRESS') && s.outcome === 'hit',
  )
  lines.push(`- dossier step hit: ${dossierHit ? String(dossierHit.kind) : 'none'}`)
  lines.push(`- ownerFound: ${String(exec?.ownerFound)}`)
  lines.push(`- ownerType: ${String(exec?.ownerType)}`)

  for (const ex of call.raw) lines.push(`- exchange: ${exchangeSummary(ex)}`)

  const contactStep = steps.find(
    (s) => s.kind === 'FASTAPPEND_ENTITY' || s.kind === 'TRACERFY_INSTANT_NAMED' || s.kind === 'TRACERFY_PARCEL_APN',
  )
  const vendor = contactStep ? (contactStep.kind === 'FASTAPPEND_ENTITY' ? 'fastappend' : 'tracerfy') : null
  lines.push(`- second-lookup vendor: ${vendor ?? 'none'}, outcome: ${contactStep ? String(contactStep.outcome) : 'n/a'}`)

  if (vendor === 'tracerfy') {
    const contactExchange = call.raw.find((e) => {
      const label = classifyEndpoint(e.host, e.path)
      return label === 'instant' || label === 'apn'
    })
    const ownerName = typeof exec?.ownerName === 'string' ? exec.ownerName : ''
    const persons = personsOf(contactExchange?.response_body)
    let matchKind = 'none'
    let matched: Record<string, unknown> | undefined
    for (const p of persons) {
      const mk = personMatchesOwner({ first_name: p.first_name, last_name: p.last_name }, ownerName)
      if (mk) {
        matchKind = mk
        matched = p
        break
      }
    }
    lines.push(`- pass-2 name test against result.ownerName: ${matchKind}`)
    if (matched) {
      const phones = Array.isArray(matched.phones) ? matched.phones.length : 0
      const emails = Array.isArray(matched.emails) ? matched.emails.length : 0
      lines.push(`- pass-2 matched person phones: ${phones}, emails: ${emails}`)
    }
  }

  const parser = contactCounts(call.result)
  lines.push(`- production-parser contacts phones: ${parser.phones}, emails: ${parser.emails}`)
  lines.push(`- needsManualReview: ${String(exec?.needsManualReview)}`)
  const success = exec?.success
  const error = typeof exec?.error === 'string' ? exec.error : null
  lines.push(`- success: ${String(success)}${error ? `, error: ${error}` : ''}`)
  lines.push(`- ${costLine(call)}`)
  return lines
}

function verdictFor(call: CallLine, personMatchesOwner: MatchFn): string {
  if (call.thrown) return `failed: ${call.thrown}`

  if (call.path === 'apn_probe') {
    const body = unwrapBody(call.raw[0]?.response_body)
    if (!isObj(body) || typeof body.hit !== 'boolean') return 'failed: no hit flag returned'
    return body.hit === false ? 'works' : 'hit (unexpected, not free)'
  }

  const res = isObj(call.result) ? call.result : null
  if (!res) return 'failed: no result'
  if (typeof res.error === 'string' && res.error) return `failed: ${res.error}`
  if (res.success === false) return 'failed: unknown error'

  if (call.path === 'fastappend') {
    if (res.hit !== true) return 'did not find the owner'
    const { phones, emails } = contactCounts(res)
    return phones > 0 || emails > 0 ? 'works' : 'did not find the owner'
  }

  if (call.path === 'tracerfy_address' || call.path === 'tracerfy_apn') {
    if (res.hit !== true) return 'did not find the owner'
    const persons = personsOf(call.raw[0]?.response_body)
    for (const p of persons) {
      const mk = personMatchesOwner({ first_name: p.first_name, last_name: p.last_name }, call.owner_name ?? '')
      if (mk) {
        const phones = Array.isArray(p.phones) ? p.phones.length : 0
        const emails = Array.isArray(p.emails) ? p.emails.length : 0
        return phones > 0 || emails > 0 ? 'works' : 'did not find the owner'
      }
    }
    return 'did not find the owner'
  }

  // dossier
  if (res.ownerFound !== true) return 'did not find the owner'
  const steps = Array.isArray(res.steps) ? (res.steps as Array<Record<string, unknown>>) : []
  const contactStep = steps.find(
    (s) => s.kind === 'FASTAPPEND_ENTITY' || s.kind === 'TRACERFY_INSTANT_NAMED' || s.kind === 'TRACERFY_PARCEL_APN',
  )
  if (!contactStep || contactStep.outcome !== 'hit') return 'did not find the owner'
  if (contactStep.kind === 'FASTAPPEND_ENTITY') {
    const { phones, emails } = contactCounts(res)
    return phones > 0 || emails > 0 ? 'works' : 'did not find the owner'
  }
  const contactExchange = call.raw.find((e) => {
    const label = classifyEndpoint(e.host, e.path)
    return label === 'instant' || label === 'apn'
  })
  const ownerName = typeof res.ownerName === 'string' ? res.ownerName : ''
  const persons = personsOf(contactExchange?.response_body)
  for (const p of persons) {
    const mk = personMatchesOwner({ first_name: p.first_name, last_name: p.last_name }, ownerName)
    if (mk) {
      const phones = Array.isArray(p.phones) ? p.phones.length : 0
      const emails = Array.isArray(p.emails) ? p.emails.length : 0
      return phones > 0 || emails > 0 ? 'works' : 'did not find the owner'
    }
  }
  return 'did not find the owner'
}

/* ------------------------------------------------------------------ *
 * PII check, run on the fully-assembled report text before it is ever written or printed
 * ------------------------------------------------------------------ */

function collectSampleNeedles(records: SmallRecord[]): string[] {
  const needles: string[] = []
  for (const r of records) {
    if (r.owner_name) needles.push(r.owner_name)
    if (r.site_address) needles.push(r.site_address)
    if (r.parcel_id_local && r.parcel_id_local.replace(/[^A-Za-z0-9]/g, '').length >= 6) {
      needles.push(r.parcel_id_local)
    }
  }
  return needles
}

const NAME_ISH_KEY = /name|street|address/i

function looksLikeNeedleValue(s: string): boolean {
  const trimmed = s.trim()
  const words = trimmed.split(/\s+/).filter(Boolean)
  return words.length >= 2 && trimmed.length >= 6
}

function collectResponseNeedles(callLines: CallLine[]): string[] {
  const needles: string[] = []

  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item)
      return
    }
    if (!isObj(v)) return

    const fn = v.first_name
    const ln = v.last_name
    if (typeof fn === 'string' && typeof ln === 'string' && (fn.trim() || ln.trim())) {
      const pair = [fn.trim(), ln.trim()].filter(Boolean).join(' ')
      if (pair) needles.push(pair)
    }

    for (const [key, value] of Object.entries(v)) {
      if (typeof value === 'string' && NAME_ISH_KEY.test(key) && looksLikeNeedleValue(value)) {
        needles.push(value)
      } else {
        visit(value)
      }
    }
  }

  for (const call of callLines) {
    for (const ex of call.raw) visit(ex.response_body)
  }
  return needles
}

function piiCheck(reportText: string, needles: string[]): { failed: boolean; count: number } {
  const lower = reportText.toLowerCase()
  let count = 0
  for (const needle of needles) {
    const n = needle.trim().toLowerCase()
    if (n && lower.includes(n)) count++
  }
  return { failed: count > 0, count }
}

/* ------------------------------------------------------------------ *
 * --report main
 * ------------------------------------------------------------------ */

async function runReport(samplePath: string): Promise<void> {
  const records = readSample(samplePath)

  let callLines: CallLine[] = []
  try {
    const raw = readFileSync(CALLS_PATH, 'utf8')
    const bySlot = new Map<string, CallLine>()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as CallLine
      bySlot.set(parsed.slot, parsed)
    }
    callLines = [...bySlot.values()]
  } catch (err) {
    console.error(`Could not read ${CALLS_PATH}: ${msg(err)}`)
    process.exit(1)
  }

  let gate: { approved_dollars?: number; answered_by?: string; david_words?: string } | null = null
  try {
    gate = JSON.parse(readFileSync(GATE_B_PATH, 'utf8'))
  } catch {
    gate = null
  }

  let balances: Array<{ at?: string; success?: boolean; balance?: number | null; error?: string | null }> = []
  try {
    balances = readFileSync(BALANCE_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  } catch {
    balances = []
  }

  const { personMatchesOwner } = await import('./match')

  const callBySlot = new Map(callLines.map((c) => [c.slot, c]))
  const totalSpent = round2(callLines.reduce((a, c) => a + (c.dollars || 0), 0))

  const lines: string[] = []
  lines.push('# Phase 0 small sample report')
  lines.push('')
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`)
  lines.push(
    `Approved: ${
      gate && typeof gate.approved_dollars === 'number'
        ? `$${gate.approved_dollars.toFixed(2)}`
        : 'unknown (small-gate-b.json not found)'
    }`,
  )
  lines.push(`Spent: $${totalSpent.toFixed(2)}`)
  if (balances.length >= 2) {
    const before = balances[0].balance
    const after = balances[balances.length - 1].balance
    lines.push(`Tracerfy balance before: ${before ?? 'unknown'}, after: ${after ?? 'unknown'}`)
  } else if (balances.length === 1) {
    lines.push(`Tracerfy balance: ${balances[0].balance ?? 'unknown'} (single snapshot)`)
  }
  lines.push('')

  for (const record of records) {
    const call = callBySlot.get(record.slot)
    lines.push(`## ${record.slot} (${record.path}, ${record.state}, ${record.county}, ${record.property_type})`)
    lines.push('')
    if (!call) {
      lines.push('No call recorded for this slot.')
      lines.push('')
      continue
    }

    let body: string[]
    switch (record.path) {
      case 'tracerfy_address':
      case 'tracerfy_apn':
        body = reportTracerfySection(call, personMatchesOwner)
        break
      case 'fastappend':
        body = reportFastappendSection(call)
        break
      case 'apn_probe':
        body = reportApnProbeSection(call)
        break
      case 'dossier':
        body = reportDossierSection(call, personMatchesOwner)
        break
      default:
        body = ['- unknown path']
    }
    lines.push(...body)
    lines.push('')
    lines.push(`Result: ${verdictFor(call, personMatchesOwner)}.`)
    lines.push('')
  }

  const reportText = lines.join('\n')

  const needles = [...collectSampleNeedles(records), ...collectResponseNeedles(callLines)]
    .map((s) => s.trim())
    .filter(Boolean)
  const check = piiCheck(reportText, needles)
  if (check.failed) {
    console.error(`PII CHECK FAILED (${check.count} needle${check.count === 1 ? '' : 's'} found)`)
    process.exit(1)
  }

  writeFileSync(REPORT_PATH, reportText)
  console.log(reportText)
}

/* ------------------------------------------------------------------ *
 * --selftest
 * ------------------------------------------------------------------ */

function runSelftest(): void {
  // Spend accounting.
  assert.deepEqual(
    computeSpend([{ host: TRACERFY_HOST, path: 'trace/lookup/', response_body: { hit: true, credits_deducted: 5 } }]),
    { dollars: 0.1, credits: 5, credits_inferred: false },
  )
  assert.deepEqual(
    computeSpend([{ host: TRACERFY_HOST, path: 'trace/lookup/', response_body: { hit: false, credits_deducted: 0 } }]),
    { dollars: 0, credits: 0, credits_inferred: false },
  )
  assert.deepEqual(
    computeSpend([{ host: TRACERFY_HOST, path: 'property-search/lookup/', response_body: { hit: true } }]),
    { dollars: 0.2, credits: 10, credits_inferred: true },
  )
  assert.deepEqual(
    computeSpend([{ host: FASTAPPEND_HOST, path: 'business-trace/lookup/', response_body: { hit: true } }]),
    { dollars: 0.1, credits: 0, credits_inferred: false },
  )
  assert.deepEqual(
    computeSpend([
      { host: TRACERFY_HOST, path: 'trace/lookup/', response_body: [{ hit: true, credits_deducted: 5 }] },
    ]),
    { dollars: 0.1, credits: 5, credits_inferred: false },
  )

  // --live refusals that need no fixture files.
  assert.equal(refuseLiveReason(0, '/tmp/phase0-selftest-does-not-exist.json') !== null, true)
  assert.equal(refuseLiveReason(-5, '/tmp/phase0-selftest-does-not-exist.json') !== null, true)
  assert.equal(refuseLiveReason(10, '/tmp/phase0-selftest-does-not-exist.json') !== null, true)

  // classifyEndpoint: host decides first. 'business-trace/lookup/' contains the substring
  // 'trace/lookup', so a path-only check mislabels every FastAppend exchange as 'instant' --
  // this is the exact regression fix round 1 found and pins down.
  assert.equal(classifyEndpoint(FASTAPPEND_HOST, '/v1/api/business-trace/lookup/'), 'fastappend')
  assert.equal(classifyEndpoint(TRACERFY_HOST, '/v1/api/trace/lookup/'), 'instant')
  assert.equal(classifyEndpoint(TRACERFY_HOST, '/v1/api/trace/parcel/lookup/'), 'apn')
  assert.equal(classifyEndpoint(TRACERFY_HOST, '/v1/api/property-search/lookup/'), 'dossier')

  console.log('run-small selftest OK')
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const samplePath = flag('sample') || SAMPLE_PATH_DEFAULT

  if (has('selftest')) {
    runSelftest()
    return
  }
  if (has('live')) {
    const n = Number(flag('max-dollars'))
    await runLive(n, samplePath)
    return
  }
  if (has('balance')) {
    await runBalance()
    return
  }
  if (has('report')) {
    await runReport(samplePath)
    return
  }
  runPlan(samplePath)
}

main().catch((err) => {
  console.error(msg(err))
  process.exit(1)
})
