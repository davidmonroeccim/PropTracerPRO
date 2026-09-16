// Tracerfy Property Search dossier, APN mode, same 12 parcels.
// POST /v1/api/property-search/lookup/  { apn, county, state }
// 10 credits ($0.20) per property hit. 0 on miss. THIS SPENDS. Requires --live.
import dotenv from 'dotenv'
import { writeFileSync, mkdirSync } from 'node:fs'
dotenv.config({ path: '/Users/davidmonroe/PropTracerPRO/.env.local', override: true })
delete process.env.FASTAPPEND_API_KEY
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const KEY = process.env.TRACERFY_API_KEY
const LIVE = process.argv.includes('--live')
const MAX = 12
const OUT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/dossier'

const ALLOWED = new Set(['tracerfy.com'])
const realFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any) => {
  const host = new URL(typeof input === 'string' ? input : input?.url).hostname
  if (!ALLOWED.has(host)) throw new Error(`BLOCKED host: ${host}`)
  return realFetch(input, init)
}) as typeof fetch

type P = { n: string; apn: string; county: string; state: string; address: string; cls: string; truth?: string }
const PARCELS: P[] = [
  { n: '1', apn: '10000052', county: 'Stark', state: 'OH', address: '4898 Hills And Dales Rd, Canton OH', cls: 'industrial', truth: 'CUTTING EDGE HOLDINGS LLC' },
  { n: '2', apn: '00318B41056', county: 'Medina', state: 'OH', address: '1299 Industrial Pkwy N, Brunswick OH', cls: 'medical office' },
  { n: '3', apn: '005-21-221-03-000', county: 'Richland', state: 'OH', address: '1121 Clayberg Rd, Greenwich OH', cls: 'mobile home park' },
  { n: '4', apn: 'A0700006000156', county: 'Butler', state: 'OH', address: '5201 Dixie Hwy, Fairfield OH', cls: 'self storage', truth: 'STORAGE TRUST PROPERTIES, L.P.' },
  { n: '5', apn: '003330004000', county: 'Napa', state: 'CA', address: '1440 First St, Napa CA', cls: 'retail' },
  { n: '6', apn: '001-011-017-000', county: 'Placer', state: 'CA', address: '185 Palm Av, Auburn CA', cls: 'medical office' },
  { n: '7', apn: '05802620200000', county: 'Sacramento', state: 'CA', address: '2473 Sunrise Blvd, Rancho Cordova CA', cls: 'mobile home park' },
  { n: '8', apn: '360010032', county: 'Contra Costa', state: 'CA', address: '2770 Estates Ave, Pinole CA', cls: 'multifamily' },
  { n: '9', apn: '16183060290000', county: 'Salt Lake', state: 'UT', address: '1815 S State St, Salt Lake City UT', cls: 'retail', truth: 'COLMAVEN, LLC' },
  { n: '10', apn: '120220101', county: 'Davis', state: 'UT', address: '305 W Center St, Clearfield UT', cls: 'industrial' },
  { n: '11', apn: 'B-1994-0001-0000', county: 'Iron', state: 'UT', address: '990 S Main St, Cedar City UT', cls: 'retail' },
  { n: '12', apn: '1A-0588-0000', county: 'Carbon', state: 'UT', address: '213 Duchesne St, Helper UT', cls: 'multifamily' },
]

const ENTITY_RE = /\b(LLC|L\.?L\.?C|INC|CORP(ORATION)?|LTD|LP|L\.P\.|LLP|PLLC|TRUST|TR|TTEE|ESTATE|CHURCH|FOUNDATION|PARTNERSHIP|ASSOC(IATION)?|HOLDINGS?|PROPERT(Y|IES)|ENTERPRISES?|GROUP|VENTURES?|REALTY|MANAGEMENT|BANK|INVESTMENTS?|STORAGE|DEVELOPMENT|AUTHORITY|DISTRICT|CITY OF|COUNTY OF|STATE OF)\b/i
const fromName = (s: string) => !s.trim() ? 'unknown' : ENTITY_RE.test(s) ? 'entity' : 'individual'
// owners[] keys are unknown for corporate-owned parcels; join whatever strings are present.
const ownerStr = (o: any): string =>
  typeof o === 'string' ? o
    : Object.entries(o ?? {}).filter(([k, v]) => typeof v === 'string' && !/^(age|dob)$/i.test(k)).map(([, v]) => v).join(' ').replace(/\s+/g, ' ').trim()

const run = async () => {
  if (!KEY) { console.error('TRACERFY_API_KEY missing'); process.exit(1) }
  if (!LIVE) { console.error('Refusing to run without --live'); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  console.log(`LIVE — ${MAX} property dossier lookups. 10 credits ($0.20)/hit, 0 on miss. Max $${(MAX * 0.2).toFixed(2)}.\n`)

  const rows: any[] = []
  let credits = 0
  for (const p of PARCELS.slice(0, MAX)) {
    let raw: any = null, err: string | null = null, status = 0
    const t0 = Date.now()
    try {
      const res = await fetch('https://tracerfy.com/v1/api/property-search/lookup/', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ apn: p.apn, county: p.county, state: p.state }),
      })
      status = res.status
      const t = await res.text()
      try { raw = JSON.parse(t) } catch { raw = { parse_error: true, body: t.slice(0, 800) } }
    } catch (e: any) { err = String(e?.message ?? e) }

    const prop = raw?.property ?? {}
    const owners: any[] = raw?.owners ?? []
    const names = owners.map(ownerStr).filter(Boolean)
    const ownerName = names.join(' | ') || null
    const deducted = raw?.credits_deducted ?? 0
    credits += deducted
    const ph = raw?.contacts?.phones?.length ?? 0
    const em = raw?.contacts?.emails?.length ?? 0

    const row = {
      ...p, status, error: err,
      hit: raw?.hit ?? null, skip_trace_hit: raw?.skip_trace_hit ?? null, credits_deducted: deducted,
      corporate_owned: prop?.corporate_owned ?? null,
      owner_name: ownerName,
      owner_keys: owners[0] && typeof owners[0] === 'object' ? Object.keys(owners[0]) : null,
      type_from_flag: prop?.corporate_owned === true ? 'entity' : prop?.corporate_owned === false ? 'individual' : 'unknown',
      type_from_name: ownerName ? fromName(ownerName) : 'unknown',
      mailing: raw?.mailing_address ? `${raw.mailing_address.address ?? ''}, ${raw.mailing_address.city ?? ''} ${raw.mailing_address.state ?? ''}`.trim() : null,
      owner_occupied: prop?.owner_occupied ?? null, absentee_owner: prop?.absentee_owner ?? null,
      total_properties_owned: prop?.total_properties_owned ?? null,
      property_type: prop?.property_type ?? null, land_use: prop?.land_use ?? null,
      phones: ph, emails: em,
      truth: p.truth ?? null,
      truth_match: p.truth && ownerName ? ownerName.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(p.truth.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)) : null,
      ms: Date.now() - t0,
    }
    rows.push(row)
    writeFileSync(`${OUT}/raw-${p.n}.json`, JSON.stringify({ request: { apn: p.apn, county: p.county, state: p.state }, response: raw }, null, 2))
    console.log(`[${p.n.padStart(2)}] hit=${String(row.hit).padEnd(5)} cr=${String(deducted).padStart(2)} corp=${String(row.corporate_owned).padEnd(5)} ph=${ph} em=${em} | ${row.owner_name ?? '(no owner returned)'}${row.truth ? `  [truth: ${row.truth} -> ${row.truth_match ? 'MATCH' : 'MISS'}]` : ''}${err ? ` ERR ${err}` : ''}`)
    await new Promise(r => setTimeout(r, 400))
  }

  const hits = rows.filter(r => r.hit === true).length
  const withOwner = rows.filter(r => r.owner_name).length
  const corp = rows.filter(r => r.corporate_owned === true).length
  const scored = rows.filter(r => r.truth)
  const summary = {
    generated_at: new Date().toISOString(), endpoint: 'POST /v1/api/property-search/lookup/ (APN mode)',
    parcels: rows.length, hits, owner_name_returned: withOwner,
    owner_rate_pct: +(withOwner / rows.length * 100).toFixed(1),
    corporate_owned_true: corp,
    credits_deducted: credits, dollars: +(credits * 0.02).toFixed(2), rate: '$0.02/credit, 10 credits/hit',
    cost_per_owner: withOwner ? +(credits * 0.02 / withOwner).toFixed(3) : null,
    verified_scoring: { scored: scored.length, matched: scored.filter(r => r.truth_match).length },
    rows,
  }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(summary, null, 2))
  console.log(`\nhits ${hits}/${rows.length} | owner name returned ${withOwner}/${rows.length} (${summary.owner_rate_pct}%) | corporate_owned=true ${corp}`)
  console.log(`verified scoring: ${summary.verified_scoring.matched}/${summary.verified_scoring.scored} matched county truth`)
  console.log(`credits ${credits} = $${summary.dollars}${summary.cost_per_owner ? ` | $${summary.cost_per_owner} per owner returned` : ''}`)
  console.log(`wrote ${OUT}/results.json`)
}
run()
