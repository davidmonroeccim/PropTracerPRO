// Tracerfy APN lookup against the same 12 parcels (+ calibration).
// POST /v1/api/trace/parcel/lookup/  -> parcel_id + county + state. 5 credits/hit, 0 on miss.
// THIS SPENDS. Requires --live. Hard cap 13 lookups.
import dotenv from 'dotenv'
import { writeFileSync, mkdirSync } from 'node:fs'
dotenv.config({ path: '/Users/davidmonroe/PropTracerPRO/.env.local', override: true })

// This script MAY call tracerfy. It must never call fastappend.
delete process.env.FASTAPPEND_API_KEY
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const KEY = process.env.TRACERFY_API_KEY
const LIVE = process.argv.includes('--live')
const MAX_LOOKUPS = 13
const OUT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/apn'

const ALLOWED = new Set(['tracerfy.com'])
const realFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url
  const host = new URL(url).hostname
  if (!ALLOWED.has(host)) throw new Error(`BLOCKED host: ${host}`)
  return realFetch(input, init)
}) as typeof fetch

type P = { label: string; parcel_id: string; county: string; state: string; address: string; asset_class: string }
const PARCELS: P[] = [
  { label: 'CAL', parcel_id: '2906400011035', county: 'Mobile', state: 'AL', address: '203 DAUPHIN ST, Mobile AL', asset_class: 'retail' },
  { label: '1', parcel_id: '10000052', county: 'Stark', state: 'OH', address: '4898 HILLS AND DALES RD, Canton OH', asset_class: 'industrial' },
  { label: '2', parcel_id: '00318B41056', county: 'Medina', state: 'OH', address: '1299 INDUSTRIAL PKWY N, Brunswick OH', asset_class: 'medical office' },
  { label: '3', parcel_id: '005-21-221-03-000', county: 'Richland', state: 'OH', address: '1121 CLAYBERG RD, Greenwich OH', asset_class: 'mobile home park' },
  { label: '4', parcel_id: 'A0700006000156', county: 'Butler', state: 'OH', address: '5201 DIXIE HWY, Fairfield OH', asset_class: 'self storage' },
  { label: '5', parcel_id: '003330004000', county: 'Napa', state: 'CA', address: '1440 FIRST ST, Napa CA', asset_class: 'retail' },
  { label: '6', parcel_id: '001-011-017-000', county: 'Placer', state: 'CA', address: '185 PALM AV, Auburn CA', asset_class: 'medical office' },
  { label: '7', parcel_id: '05802620200000', county: 'Sacramento', state: 'CA', address: '2473 SUNRISE BLVD, Rancho Cordova CA', asset_class: 'mobile home park' },
  { label: '8', parcel_id: '360010032', county: 'Contra Costa', state: 'CA', address: '2770 ESTATES AVE, Pinole CA', asset_class: 'multifamily' },
  { label: '9', parcel_id: '16183060290000', county: 'Salt Lake', state: 'UT', address: '1815 S STATE ST, Salt Lake City UT', asset_class: 'retail' },
  { label: '10', parcel_id: '120220101', county: 'Davis', state: 'UT', address: '305 W CENTER ST, Clearfield UT', asset_class: 'industrial' },
  { label: '11', parcel_id: 'B-1994-0001-0000', county: 'Iron', state: 'UT', address: '990 S MAIN ST, Cedar City UT', asset_class: 'retail' },
  { label: '12', parcel_id: '1A-0588-0000', county: 'Carbon', state: 'UT', address: '213 DUCHESNE ST, Helper UT', asset_class: 'multifamily' },
]

// Deterministic entity/individual classifier on the owner-name string.
const ENTITY_RE = /\b(LLC|L\.?L\.?C|INC|CORP(ORATION)?|CO|LTD|LP|LLP|PLLC|TRUST|TR|TTEE|TRS|ESTATE|CHURCH|FOUNDATION|PARTNERSHIP|ASSOC(IATION)?|HOLDINGS?|PROPERT(Y|IES)|ENTERPRISES?|GROUP|VENTURES?|REALTY|MANAGEMENT|MGMT|BANK|INVESTMENTS?|DEVELOPMENT|AUTHORITY|DISTRICT|SCHOOL|CITY OF|COUNTY OF|STATE OF|FARMS?|RANCH)\b/i
const INDIV_RE = /\b(ET AL|ET UX|JR|SR|III?|IV)\b|&| AND /i
const classify = (n?: string | null): string => {
  if (!n || !n.trim()) return 'unknown'
  if (ENTITY_RE.test(n)) return 'entity'
  if (INDIV_RE.test(n)) return 'individual-joint'
  return n.trim().split(/\s+/).length <= 4 ? 'individual' : 'ambiguous'
}

const run = async () => {
  if (!KEY) { console.error('TRACERFY_API_KEY missing'); process.exit(1) }
  if (!LIVE) { console.error('Refusing to run without --live (this spends credits)'); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  const targets = PARCELS.slice(0, MAX_LOOKUPS)
  console.log(`LIVE — ${targets.length} APN lookups, 5 credits/hit ($0.10), misses free. Max $${(targets.length * 0.10).toFixed(2)}.\n`)

  const results: any[] = []
  let credits = 0
  for (const p of targets) {
    const t0 = Date.now()
    let raw: any = null, err: string | null = null, status = 0
    try {
      const res = await fetch('https://tracerfy.com/v1/api/trace/parcel/lookup/', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ parcel_id: p.parcel_id, county: p.county, state: p.state }),
      })
      status = res.status
      const text = await res.text()
      try { raw = JSON.parse(text) } catch { raw = { parse_error: true, body: text.slice(0, 600) } }
    } catch (e: any) { err = String(e?.message ?? e) }

    const persons: any[] = raw?.persons ?? raw?.results?.[0]?.persons ?? []
    const flagged = persons.filter((x: any) => x?.property_owner === true)
    const deducted = raw?.credits_deducted ?? 0
    credits += deducted
    // Top-level owner name, if the endpoint returns one independent of persons[].
    const topOwner = raw?.owner_name ?? raw?.owner ?? raw?.results?.[0]?.owner_name ?? null
    const flaggedName = flagged[0]?.full_name ?? (flagged[0] ? `${flagged[0].first_name ?? ''} ${flagged[0].last_name ?? ''}`.trim() : null)
    const ownerName = flaggedName ?? topOwner ?? null

    const row = {
      ...p, status, error: err, hit: raw?.hit ?? null, credits_deducted: deducted,
      persons_count: persons.length, flagged_count: flagged.length,
      owner_name: ownerName, owner_name_source: flaggedName ? 'persons[].property_owner' : (topOwner ? 'top-level' : null),
      classified_type: classify(ownerName),
      top_level_keys: raw && !raw.parse_error ? Object.keys(raw) : null,
      unflagged_names: persons.filter((x: any) => x?.property_owner !== true).map((x: any) => x?.full_name ?? `${x?.first_name ?? ''} ${x?.last_name ?? ''}`.trim()),
      ms: Date.now() - t0,
    }
    results.push(row)
    writeFileSync(`${OUT}/raw-${p.label}.json`, JSON.stringify({ request: { parcel_id: p.parcel_id, county: p.county, state: p.state }, response: raw }, null, 2))
    console.log(`[${p.label.padStart(3)}] ${String(row.hit).padEnd(5)} persons=${String(row.persons_count).padStart(2)} flagged=${row.flagged_count} cr=${String(deducted).padStart(2)} | ${row.owner_name ?? '(none)'} | ${row.classified_type}${err ? ` | ERR ${err}` : ''}`)
    await new Promise(r => setTimeout(r, 400))
  }

  const hits = results.filter(r => r.hit === true).length
  const withFlag = results.filter(r => r.flagged_count > 0).length
  const summary = {
    generated_at: new Date().toISOString(), parcels: results.length,
    hits, hit_rate_pct: +(hits / results.length * 100).toFixed(1),
    with_property_owner_flag: withFlag, flag_rate_pct: +(withFlag / results.length * 100).toFixed(1),
    credits_deducted: credits, dollars: +(credits * 0.02).toFixed(2), rate: '$0.02/credit, 5 credits/hit',
    type_split: results.reduce((a: any, r) => { a[r.classified_type] = (a[r.classified_type] ?? 0) + 1; return a }, {}),
    results,
  }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(summary, null, 2))
  console.log(`\nhits ${hits}/${results.length} (${summary.hit_rate_pct}%) | flagged owner ${withFlag}/${results.length} (${summary.flag_rate_pct}%)`)
  console.log(`credits ${credits} = $${summary.dollars}`)
  console.log(`type split: ${JSON.stringify(summary.type_split)}`)
  console.log(`wrote ${OUT}/results.json`)
}
run()
