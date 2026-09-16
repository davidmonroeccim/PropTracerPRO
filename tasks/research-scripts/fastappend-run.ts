// FastAppend business trace on the 10 entity owners returned by the Tracerfy dossier.
// POST https://app.fastappend.com/v1/api/business-trace/lookup/  { company_name, state }
// 1 business credit ($0.10) per HIT. Misses free. Requires --live.
//
// Two controlled experiments ride along, both free on a miss:
//   A) STATE: send the PROPERTY state (what PTP does today). Butler's owner is a DELAWARE LP,
//      so if the registration-state theory holds, OH misses and DE hits.
//   B) NAME: Stark's owner name carries the county assessor's typo ("Hodings"). Retry corrected.
import dotenv from 'dotenv'
import { writeFileSync, mkdirSync } from 'node:fs'
dotenv.config({ path: '/Users/davidmonroe/PropTracerPRO/.env.local', override: true })
delete process.env.TRACERFY_API_KEY
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const KEY = process.env.FASTAPPEND_API_KEY
const LIVE = process.argv.includes('--live')
const OUT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/fastappend'

const ALLOWED = new Set(['app.fastappend.com'])
const realFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any) => {
  const host = new URL(typeof input === 'string' ? input : input?.url).hostname
  if (!ALLOWED.has(host)) throw new Error(`BLOCKED host: ${host}`)
  return realFetch(input, init)
}) as typeof fetch

type Q = { n: string; company: string; state: string; note: string; propertyState: string }
const QUERIES: Q[] = [
  { n: '1', company: 'Cutting Edge Hodings Llc', state: 'OH', propertyState: 'OH', note: 'as returned by dossier (county typo)' },
  { n: '2', company: 'Brunswick 1299 Mp Rk6 Llc', state: 'OH', propertyState: 'OH', note: '' },
  { n: '3', company: 'Pin Oak Estates Ltd', state: 'OH', propertyState: 'OH', note: '' },
  { n: '4', company: 'Storage Trust Properties', state: 'OH', propertyState: 'OH', note: 'DE LP; property state sent (PTP behaviour today)' },
  { n: '5', company: 'John Anthony Investments Llc', state: 'CA', propertyState: 'CA', note: '' },
  { n: '6', company: 'Kt Investments Llc', state: 'CA', propertyState: 'CA', note: '' },
  { n: '7', company: 'Country Club Investors', state: 'CA', propertyState: 'CA', note: '' },
  { n: '8', company: 'Estates Ave Properties Llc', state: 'CA', propertyState: 'CA', note: '' },
  { n: '11', company: 'Bhf L L C', state: 'UT', propertyState: 'UT', note: '' },
  { n: '12', company: 'Abc Rentals Llc', state: 'UT', propertyState: 'UT', note: '' },
]
// Controlled retries, only fired if the primary missed.
const RETRIES: Q[] = [
  { n: '4R', company: 'Storage Trust Properties', state: 'DE', propertyState: 'OH', note: 'RETRY: true registration state (Delaware)' },
  { n: '4R2', company: 'Storage Trust Properties, L.P.', state: 'DE', propertyState: 'OH', note: 'RETRY: full legal name + DE' },
  { n: '1R', company: 'Cutting Edge Holdings LLC', state: 'OH', propertyState: 'OH', note: 'RETRY: county typo corrected' },
]

const call = async (q: Q) => {
  const t0 = Date.now()
  try {
    const res = await fetch('https://app.fastappend.com/v1/api/business-trace/lookup/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ company_name: q.company, state: q.state }),
    })
    const text = await res.text()
    let raw: any; try { raw = JSON.parse(text) } catch { raw = { parse_error: true, body: text.slice(0, 600) } }
    return { raw, status: res.status, ms: Date.now() - t0, error: null as string | null }
  } catch (e: any) { return { raw: null, status: 0, ms: Date.now() - t0, error: String(e?.message ?? e) } }
}

const summarize = (q: Q, r: any) => {
  const raw = r.raw ?? {}
  const people: any[] = raw?.associated_people ?? []
  const agents = people.filter(p => p?.is_registered_agent === true)
  const principals = people.filter(p => p?.is_registered_agent !== true)
  return {
    ...q, status: r.status, error: r.error, ms: r.ms,
    hit: raw?.hit ?? null, credits_deducted: raw?.credits_deducted ?? 0,
    api_error: raw?.error ?? null,
    people_count: people.length,
    registered_agents: agents.length, non_agents: principals.length,
    roles: [...new Set(people.map(p => p?.role).filter(Boolean))],
    addresses: (raw?.addresses ?? []).map((a: any) => `${a.street ?? a.address ?? ''}, ${a.city ?? ''} ${a.state ?? ''}`.trim()),
    people: people.map(p => ({
      name: p?.full_name ?? `${p?.first_name ?? ''} ${p?.last_name ?? ''}`.trim(),
      role: p?.role ?? null, is_registered_agent: p?.is_registered_agent ?? null, rank: p?.rank ?? null,
      phones: (p?.phones ?? []).length, emails: (p?.emails ?? []).length,
      top_phone: p?.phones?.[0]?.number ?? null, top_phone_dnc: p?.phones?.[0]?.dnc ?? null,
      top_email: p?.emails?.[0]?.email ?? null,
    })),
  }
}

const run = async () => {
  if (!KEY) { console.error('FASTAPPEND_API_KEY missing'); process.exit(1) }
  if (!LIVE) { console.error('Refusing to run without --live'); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  console.log(`LIVE — ${QUERIES.length} FastAppend business traces. 1 credit ($0.10)/hit, misses free. Max $${(QUERIES.length * 0.1).toFixed(2)}.\n`)

  const rows: any[] = []
  let credits = 0
  for (const q of QUERIES) {
    const r = await call(q)
    const s = summarize(q, r)
    credits += s.credits_deducted
    rows.push(s)
    writeFileSync(`${OUT}/raw-${q.n}.json`, JSON.stringify({ request: { company_name: q.company, state: q.state }, response: r.raw }, null, 2))
    console.log(`[${q.n.padStart(3)}] hit=${String(s.hit).padEnd(5)} cr=${s.credits_deducted} people=${String(s.people_count).padStart(2)} agents=${s.registered_agents} | ${q.company} (${q.state})${s.api_error ? ` | ${s.api_error}` : ''}`)
    if (s.people_count) for (const p of s.people.slice(0, 3)) console.log(`         - ${p.name}  role=${p.role ?? '-'}  regAgent=${p.is_registered_agent}  ph=${p.phones} em=${p.emails}`)
    await new Promise(res => setTimeout(res, 300))
  }

  console.log('\n--- controlled retries (only where the primary missed) ---')
  const retryRows: any[] = []
  for (const q of RETRIES) {
    const primary = rows.find(x => x.n === q.n.replace(/R\d?$/, ''))
    if (primary?.hit === true) { console.log(`[${q.n}] skipped, primary already hit`); continue }
    const r = await call(q)
    const s = summarize(q, r)
    credits += s.credits_deducted
    retryRows.push(s)
    writeFileSync(`${OUT}/raw-${q.n}.json`, JSON.stringify({ request: { company_name: q.company, state: q.state }, response: r.raw }, null, 2))
    console.log(`[${q.n.padStart(3)}] hit=${String(s.hit).padEnd(5)} cr=${s.credits_deducted} people=${String(s.people_count).padStart(2)} | ${q.company} (${q.state})  <- ${q.note}`)
    if (s.people_count) for (const p of s.people.slice(0, 3)) console.log(`         - ${p.name}  role=${p.role ?? '-'}  regAgent=${p.is_registered_agent}  ph=${p.phones} em=${p.emails}`)
    await new Promise(res => setTimeout(res, 300))
  }

  const hits = rows.filter(r => r.hit === true).length
  const totalPeople = rows.reduce((a, r) => a + r.people_count, 0)
  const totalAgents = rows.reduce((a, r) => a + r.registered_agents, 0)
  const summary = {
    generated_at: new Date().toISOString(), endpoint: 'POST /v1/api/business-trace/lookup/',
    entities: rows.length, hits, hit_rate_pct: +(hits / rows.length * 100).toFixed(1),
    credits_deducted: credits, dollars: +(credits * 0.10).toFixed(2), rate: '$0.10/hit, misses free',
    cost_per_hit: hits ? +(credits * 0.10 / hits).toFixed(3) : null,
    people_returned: totalPeople, registered_agents_returned: totalAgents,
    primary: rows, retries: retryRows,
  }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(summary, null, 2))
  console.log(`\nhits ${hits}/${rows.length} (${summary.hit_rate_pct}%) | people ${totalPeople} | flagged registered agents ${totalAgents}`)
  console.log(`credits ${credits} = $${summary.dollars}`)
  console.log(`wrote ${OUT}/results.json`)
}
run()
