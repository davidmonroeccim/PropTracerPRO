/**
 * Dossier client check — exercises lib/tracerfy/dossier.ts and PRINTS the parsed record.
 *
 * Phase 1 of Full Property Trace ships a client and a test suite, neither of which you can
 * look at. This is the part you can look at: it runs the real client and prints the real
 * 86-field record it returns.
 *
 *   npx tsx tasks/research-scripts/dossier-client-check.ts --dry-run
 *       Parses a committed SANITIZED fixture through the real parseDossierResponse().
 *       ZERO network calls, $0.00. Pick which one with --fixture=<name>.
 *
 *   npx tsx tasks/research-scripts/dossier-client-check.ts --live --address="1815 S State St" \
 *       --city="Salt Lake City" --state=UT
 *       One real lookup. $0.20 on a HIT, free on a miss.
 *
 *   npx tsx tasks/research-scripts/dossier-client-check.ts --live --apn=10-000052 \
 *       --county=Stark --state=OH
 *
 * SAFETY INVARIANTS, in this order:
 *   1. .env.local is read by ABSOLUTE path. No env VALUE is ever printed.
 *   2. FASTAPPEND_API_KEY and SUPABASE_SERVICE_ROLE_KEY are deleted before the PTP module
 *      is imported, so this script cannot touch the entity vendor or the database.
 *   3. globalThis.fetch is replaced with a hard allowlist: tracerfy.com only.
 *   4. Without --live nothing leaves the machine, and --live does exactly ONE lookup.
 */
import { readFileSync } from 'node:fs'
// Type-only: erased at runtime, so the dynamic import below still happens after the env scrub.
import type { DossierKey, DossierResult } from '../../lib/tracerfy/dossier'

const ENV_PATH = '/Users/davidmonroe/PropTracerPRO/.env.local'
const FIXTURE_DIR = '/Users/davidmonroe/PropTracerPRO/lib/tracerfy/__tests__/fixtures'
const ENDPOINT_HOST = 'tracerfy.com'

/**
 * Same absolute-path .env.local load as the other scripts here, WITHOUT the dotenv import.
 * dotenv is not a repo dependency — it was installed in a scratchpad — so importing it is
 * both a `tsc --noEmit` error and the reason the sibling scripts cannot be run as-is. This
 * script has to actually run, so it parses the file itself. Reads only; prints no value.
 */
function loadEnvLocal(path: string) {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.error(`Could not read ${path}. --live needs TRACERFY_API_KEY from it.`)
    return
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

loadEnvLocal(ENV_PATH)
delete process.env.FASTAPPEND_API_KEY
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const host = new URL(typeof input === 'string' ? input : (input as Request).url ?? String(input))
    .hostname
  if (host !== ENDPOINT_HOST) throw new Error(`BLOCKED ${host}`)
  return realFetch(input, init)
}) as typeof fetch

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : ''
}
const has = (name: string) => flag(name) !== undefined

const FIXTURES = [
  'entity-hit-address',
  'entity-hit-apn',
  'individual-hit',
  'two-owner-hit',
  'miss-apn',
  'miss-address',
]

const usage = (): never => {
  console.error(
    [
      'Pick a mode:',
      '  --dry-run [--fixture=<name>]   parse a committed sanitized fixture. $0.00.',
      `                                 fixtures: ${FIXTURES.join(', ')}`,
      '  --live --apn=X --county=Y --state=ZZ',
      '  --live --address="X" --city="Y" --state=ZZ [--zip=00000]',
      '                                 ONE real lookup. $0.20 on a hit, free on a miss.',
    ].join('\n'),
  )
  process.exit(2)
}

const fmt = (v: unknown): string => {
  if (v === null) return '(empty)'
  if (v === '') return '(empty)'
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Print the parsed record the way a human reads it. */
function printRecord(source: string, request: Record<string, unknown>, r: DossierResult) {
  const line = '─'.repeat(78)
  console.log(line)
  console.log(`SOURCE   ${source}`)
  console.log(`REQUEST  ${JSON.stringify(request)}`)
  console.log(line)

  if (!r.success) {
    console.log(`FAILED   ${r.error}`)
    console.log(`         success=false, hit=${r.hit}, credits=${r.creditsDeducted}`)
    console.log(line)
    return
  }

  console.log(
    `RESULT   success=${r.success}  hit=${r.hit}  credits_deducted=${r.creditsDeducted}` +
      `  ($${(r.creditsDeducted * 0.02).toFixed(2)})`,
  )

  if (!r.hit) {
    console.log('         MISS. No property, no owners, and no charge.')
    console.log(line)
    return
  }

  console.log('')
  console.log(`OWNERS   ${r.owners.length}   (property carries NO owner field; the owner is here)`)
  r.owners.forEach((o, i) => {
    const entity = !o.first_name
    const name = entity ? o.last_name : `${o.first_name} ${o.last_name}`
    console.log(
      `  [${i}] ${name}` +
        `\n      first_name=${JSON.stringify(o.first_name)} last_name=${JSON.stringify(o.last_name)} age=${JSON.stringify(o.age)}` +
        `\n      ^ ${entity ? 'ENTITY: whole name in last_name, first_name empty' : 'INDIVIDUAL: both names populated'}` +
        ' — this client does NOT classify; classifyOwnerName() does.',
    )
  })

  console.log('')
  const m = r.mailingAddress
  console.log(
    `MAILING  ${m ? [m.address, m.city, m.state, m.zip].filter(Boolean).join(', ') : '(none)'}`,
  )

  const keys = Object.keys(r.property ?? {})
  console.log('')
  console.log(`PROPERTY RECORD — ${keys.length} keys, RAW AND COMPLETE. Nothing filtered.`)
  console.log(line)
  const width = Math.max(...keys.map((k) => k.length))
  for (const k of keys) {
    console.log(`  ${k.padEnd(width)}  ${fmt(r.property![k])}`)
  }
  console.log(line)
  const empty = keys.filter((k) => r.property![k] === null || r.property![k] === '').length
  console.log(
    `${keys.length} keys returned, ${empty} empty for this parcel. The empty ones are STORED anyway:` +
      '\na key blank in OH may be populated in another county, and the $0.20 already bought it.',
  )
  console.log(line)
}

async function main() {
  // Dynamic import so the env scrub above lands before any PTP module is evaluated.
  const { lookupDossier, parseDossierResponse, buildDossierRequest } = await import(
    '../../lib/tracerfy/dossier'
  )

  if (has('dry-run')) {
    const name = flag('fixture') || 'two-owner-hit'
    if (!FIXTURES.includes(name)) {
      console.error(`Unknown fixture "${name}". One of: ${FIXTURES.join(', ')}`)
      process.exit(2)
    }
    const raw = JSON.parse(readFileSync(`${FIXTURE_DIR}/${name}.json`, 'utf8'))
    const parsed = parseDossierResponse(raw.response)
    printRecord(`fixture ${name}.json (sanitized derivative of a real vendor response)`, raw.request, parsed)
    console.log('DRY RUN. Zero network calls, $0.00 spent.')
    return
  }

  if (!has('live')) usage()

  const state = flag('state') ?? ''
  const apn = flag('apn') ?? ''
  const address = flag('address') ?? ''
  const zip = flag('zip') ?? ''
  if (!state || (!apn && !address)) usage()

  const key: DossierKey = apn
    ? { mode: 'apn', apn, county: flag('county') ?? '', state }
    : {
        mode: 'address',
        address,
        city: flag('city') ?? '',
        state,
        ...(zip ? { zip_code: zip } : {}),
      }

  const body = buildDossierRequest(key)
  console.log(`LIVE. One lookup, $0.20 on a hit, free on a miss.`)
  const parsed = await lookupDossier(key)
  printRecord('LIVE tracerfy.com/v1/api/property-search/lookup/', body, parsed)
  console.log(`Spent $${(parsed.creditsDeducted * 0.02).toFixed(2)}.`)
}

main()
