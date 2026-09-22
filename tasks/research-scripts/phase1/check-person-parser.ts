/**
 * Tier 1 Phase 1, Task 3 check (spec 11, lessons L-008): run the NEW Tracerfy person parser over
 * every saved Instant and parcel response in tasks/research-test/ and print COUNTS ONLY.
 *
 * Those files hold purchased PII. This script never prints a name, phone, email, address or parcel
 * id, writes nothing, and is not a test. Its output is not saved or committed.
 *
 *   npx tsx tasks/research-scripts/phase1/check-person-parser.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// House pattern (tasks/research-scripts/phase0/run-small.ts): never carry the database key into a
// process that imports lib/ code. This script needs no database.
delete process.env.SUPABASE_SERVICE_ROLE_KEY

type Want = { first_name?: string; last_name?: string } | undefined

interface Sample {
  source: string
  body: unknown
  want: Want
}

const RT = join(process.cwd(), 'tasks/research-test')

/** The envelope keys the parser was written against, for both endpoints. */
const KNOWN_KEYS = new Set([
  'address', 'city', 'state', 'zip', 'find_owner', 'parcel_id', 'county',
  'hit', 'persons_count', 'credits_deducted', 'persons', 'meta', 'error',
])

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

async function main(): Promise<void> {
  const { parsePersonTraceResponse } = await import('../../../lib/tracerfy/client')
  const { splitPersonName } = await import('../../../lib/routing/ownerRoute')
  const wantFor = (owner: unknown): Want =>
    typeof owner === 'string' && owner.trim() ? splitPersonName(owner) : undefined

  const samples: Sample[] = []

  // 1. The 2026-09-15 parcel study. The owner of record comes from its results.json, by parcel id.
  const apnDir = join(RT, 'apn')
  if (existsSync(apnDir)) {
    const results = (rec(readJson(join(apnDir, 'results.json'))).results as unknown[] | undefined) ?? []
    for (const f of readdirSync(apnDir).filter((n) => n.startsWith('raw-'))) {
      const d = rec(readJson(join(apnDir, f)))
      const parcel = rec(d.request).parcel_id
      const row = results.map(rec).find((r) => r.parcel_id === parcel)
      samples.push({ source: 'apn', body: d.response, want: wantFor(row?.owner_name) })
    }
  }

  // 2. The 2026-09-16 Instant study: one parcel, one owner of record.
  const tiDir = join(RT, 'tracerfy-individual')
  if (existsSync(tiDir)) {
    const owner = rec(readJson(join(tiDir, 'results.json'))).owner_of_record
    for (const f of readdirSync(tiDir).filter((n) => n.startsWith('raw-'))) {
      samples.push({ source: 'instant', body: rec(readJson(join(tiDir, f))).response, want: wantFor(owner) })
    }
  }

  // 3. Phase 0: every Instant or parcel exchange, with the names production asked about.
  const p0 = join(RT, 'phase0/small-calls.jsonl')
  if (existsSync(p0)) {
    for (const line of readFileSync(p0, 'utf8').split('\n').filter(Boolean)) {
      const o = rec(JSON.parse(line))
      for (const x of Array.isArray(o.raw) ? o.raw : []) {
        const r = rec(x)
        const path = String(r.path ?? '')
        if (!path.includes('/trace/lookup/') && !path.includes('/trace/parcel/lookup/')) continue
        const req = rec(r.request_body)
        const want: Want =
          typeof req.last_name === 'string'
            ? { first_name: String(req.first_name ?? ''), last_name: req.last_name }
            : wantFor(o.owner_name)
        samples.push({ source: `phase0:${String(o.slot)}`, body: r.response_body, want })
      }
    }
  }

  const count: Record<string, number> = {}
  const bump = (k: string): void => {
    count[k] = (count[k] ?? 0) + 1
  }
  const unexpected = new Set<string>()

  for (const s of samples) {
    bump(`responses_${s.source.split(':')[0]}`)
    for (const k of Object.keys(rec(Array.isArray(s.body) ? s.body[0] : s.body))) {
      if (!KNOWN_KEYS.has(k)) unexpected.add(k)
    }
    const res = parsePersonTraceResponse(s.body, s.want)
    const verdict = !res.success
      ? 'parse_failure'
      : !res.hit
        ? 'miss'
        : res.contacts
          ? 'name_matched'
          : res.nameNotMatched
            ? 'name_not_matched'
            : 'hit_without_people'
    bump(verdict)
    if (res.hit && res.creditsDeducted === undefined) bump('hits_without_credits')
    if (res.hit && !s.want) bump('hits_with_no_owner_name_to_match')
    if (s.source.startsWith('phase0:')) console.log(`${s.source}: ${verdict}`)
  }

  console.log(JSON.stringify(count, null, 2))
  console.log(`unexpected top-level keys: ${[...unexpected].sort().join(', ') || 'none'}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
