/**
 * Tier 1 Phase 1, Task 3 check (spec 11, lessons L-008): run the NEW Tracerfy person parser over
 * every saved Instant and parcel response in tasks/research-test/ and print COUNTS ONLY.
 *
 * Those files hold purchased PII. This script never prints a name, phone, email, address or parcel
 * id, writes nothing, and is not a test. Its output is not saved or committed.
 *
 * Fix round 1, finding 2: the first version of this script only bumped ONE flat set of verdict
 * counters, so there was no way to tell which study a "no owner name to match" sample came from,
 * or whether that meant "no results.json row for this parcel at all" versus "a row was found but
 * it carries no owner name". That version also built EVERY `want` from results.json's recorded
 * owner name.
 *
 * Fix round 1, coordinator ruling on the BLOCKED reply: that was a defect in THIS SCRIPT, not in
 * the parser. tasks/research-test/tracerfy-individual/raw-B.json's own `request` carries
 * first_name and last_name, and the one returned person matches THOSE exactly. results.json's
 * owner_of_record is a 6-word county string whose last word is not the owner's last name --
 * splitting it produced a `want` that was never actually sent to the vendor. Production's parser
 * (parsePersonTraceResponse via lookupPersonTrace) always compares against the names the STEP'S
 * REQUEST carried, which is the question D6 answers -- never against a re-derived owner string.
 *
 * So now: whenever a saved raw file's own `request` carries first_name or last_name (every Instant
 * named lookup, and any parcel lookup captured after Task 2 started sending names on that step
 * too), THOSE are `want`, labelled `want_from_request`. Only when the request carries no names at
 * all (every saved parcel-lookup capture, so far, predates that) does `want` fall back to the study's
 * recorded owner name, split the way production splits an owner string for the person steps
 * (`personNameFor`/`splitPersonName` in lib/routing/ownerRoute.ts -- both halves required, or no
 * want at all), labelled `want_from_owner_of_record`. Every count is still broken down by source
 * study (apn / instant / phase0) and by which of the two `want` sources produced it. Still counts
 * and reason-labels only -- never a name, phone, email, address or parcel id.
 *
 *   npx tsx tasks/research-scripts/phase1/check-person-parser.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// House pattern (tasks/research-scripts/phase0/run-small.ts): never carry the database key into a
// process that imports lib/ code. This script needs no database.
delete process.env.SUPABASE_SERVICE_ROLE_KEY

type Want = { first_name?: string; last_name?: string } | undefined

/** Which field produced `want`. Never which file, never the name. */
type WantSource = 'want_from_request' | 'want_from_owner_of_record'

/** Why `want` came back undefined. Never which file, never the name. */
type NoNameReason = 'no_row_found' | 'row_found_no_owner_name' | 'row_found_name_incomplete' | 'no_owner_name_recorded'

interface Sample {
  /** Top-level study: apn, instant or phase0. */
  family: string
  /** Full label, phase0 also carries its slot. Only used for the per-line phase0 log. */
  source: string
  body: unknown
  want: Want
  wantSource?: WantSource
  noNameReason?: NoNameReason
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

/**
 * `want` from the names a saved request actually carried, when it carried any -- this is the
 * question D6 answers in production, since lookupPersonTrace always compares against its own
 * request's names, never a name re-derived some other way.
 */
function wantFromRequest(req: Record<string, unknown>): Want {
  if (typeof req.first_name !== 'string' && typeof req.last_name !== 'string') return undefined
  return {
    first_name: typeof req.first_name === 'string' ? req.first_name : '',
    last_name: typeof req.last_name === 'string' ? req.last_name : '',
  }
}

/**
 * Resolve `want` for one sample: prefer the request's own names; only fall back to splitting a
 * recorded owner string (production's personNameFor rule -- both halves required, or no want)
 * when the request carried none. Returns the reason no `want` exists, when that is the outcome.
 */
function resolveWant(
  req: Record<string, unknown>,
  ownerString: unknown,
  ownerRowFound: boolean,
  splitPersonName: (name: string) => { first_name: string; last_name: string },
): { want: Want; wantSource?: WantSource; noNameReason?: NoNameReason } {
  const fromRequest = wantFromRequest(req)
  if (fromRequest) return { want: fromRequest, wantSource: 'want_from_request' }

  if (typeof ownerString === 'string' && ownerString.trim()) {
    const who = splitPersonName(ownerString)
    if (who.first_name && who.last_name) return { want: who, wantSource: 'want_from_owner_of_record' }
    return { want: undefined, noNameReason: 'row_found_name_incomplete' }
  }
  return { want: undefined, noNameReason: ownerRowFound ? 'row_found_no_owner_name' : 'no_row_found' }
}

async function main(): Promise<void> {
  const { parsePersonTraceResponse } = await import('../../../lib/tracerfy/client')
  const { splitPersonName } = await import('../../../lib/routing/ownerRoute')

  const samples: Sample[] = []

  // 1. The 2026-09-15 parcel study. The owner of record comes from its results.json, by parcel id.
  const apnDir = join(RT, 'apn')
  if (existsSync(apnDir)) {
    const results = (rec(readJson(join(apnDir, 'results.json'))).results as unknown[] | undefined) ?? []
    for (const f of readdirSync(apnDir).filter((n) => n.startsWith('raw-'))) {
      const d = rec(readJson(join(apnDir, f)))
      const req = rec(d.request)
      const parcel = req.parcel_id
      const row = results.map(rec).find((r) => r.parcel_id === parcel)
      const resolved = resolveWant(req, row?.owner_name, Boolean(row), splitPersonName)
      samples.push({ family: 'apn', source: 'apn', body: d.response, ...resolved })
    }
  }

  // 2. The 2026-09-16 Instant study: one parcel, one owner of record. Every raw file's own request
  // is checked individually (raw-B.json carries first_name/last_name; raw-A.json, a miss, does not).
  const tiDir = join(RT, 'tracerfy-individual')
  if (existsSync(tiDir)) {
    const ownerOfRecord = rec(readJson(join(tiDir, 'results.json'))).owner_of_record
    for (const f of readdirSync(tiDir).filter((n) => n.startsWith('raw-'))) {
      const d = rec(readJson(join(tiDir, f)))
      const req = rec(d.request)
      // The one results.json row for this study always exists (read above without throwing).
      const resolved = resolveWant(req, ownerOfRecord, true, splitPersonName)
      samples.push({ family: 'instant', source: 'instant', body: d.response, ...resolved })
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
        // No results.json "row" concept here; a missing owner_name is 'no_owner_name_recorded',
        // never 'no_row_found'.
        const resolved = resolveWant(req, o.owner_name, false, splitPersonName)
        if (!resolved.want && resolved.noNameReason === 'no_row_found') resolved.noNameReason = 'no_owner_name_recorded'
        samples.push({ family: 'phase0', source: `phase0:${String(o.slot)}`, body: r.response_body, ...resolved })
      }
    }
  }

  const count: Record<string, number> = {}
  const bump = (k: string): void => {
    count[k] = (count[k] ?? 0) + 1
  }
  const unexpected = new Set<string>()

  for (const s of samples) {
    bump(`responses_${s.family}`)
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
    bump(`${s.family}_${verdict}`)
    if (res.hit && res.creditsDeducted === undefined) bump('hits_without_credits')
    if (s.want && s.wantSource) bump(`want_source_${s.family}_${s.wantSource}`)
    if (res.hit && !s.want) {
      bump('hits_with_no_owner_name_to_match')
      if (s.noNameReason) bump(`no_want_reason_${s.family}_${s.noNameReason}`)
    }
    // The finding this round of fixes chases: a REAL hit tested against a REAL owner name that
    // still came out unmatched is the one case Step 5a's stop rule exists for. Flag it by family
    // AND by want source, never by name.
    if (res.hit && s.want) {
      bump(`named_hit_${res.contacts ? 'matched' : 'not_matched'}_${s.family}_${s.wantSource}`)
    }
    if (s.source.startsWith('phase0:')) console.log(`${s.source}: ${verdict} (${s.wantSource ?? s.noNameReason})`)
  }

  console.log(JSON.stringify(count, null, 2))
  console.log(`unexpected top-level keys: ${[...unexpected].sort().join(', ') || 'none'}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
