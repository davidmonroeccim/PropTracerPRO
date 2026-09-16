// Tracerfy instant lookup on the ONE individually-owned parcel.
// Parcel 10: 305 W Center St, Clearfield UT 84015. Owner: Robert P Strebel / Strebel Living Trust.
// Dossier skip_trace_hit=false, 0 contacts. Absentee owner. 5 credits ($0.10)/hit, 0 on miss.
import dotenv from 'dotenv'
import { writeFileSync, mkdirSync } from 'node:fs'
dotenv.config({ path: '/Users/davidmonroe/PropTracerPRO/.env.local', override: true })
delete process.env.FASTAPPEND_API_KEY
delete process.env.SUPABASE_SERVICE_ROLE_KEY
const KEY = process.env.TRACERFY_API_KEY!
const OUT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/tracerfy-individual'
const ALLOWED = new Set(['tracerfy.com'])
const rf = globalThis.fetch
globalThis.fetch = ((i: any, o?: any) => {
  const h = new URL(typeof i === 'string' ? i : i?.url).hostname
  if (!ALLOWED.has(h)) throw new Error(`BLOCKED ${h}`); return rf(i, o)
}) as typeof fetch

const VARIANTS = [
  { n: 'A', note: 'find_owner:true at the property address (designed owner path)', body: { address: '305 W Center St', city: 'Clearfield', state: 'UT', zip: '84015', find_owner: true } },
  { n: 'B', note: 'find_owner:false, named person at the property address', body: { address: '305 W Center St', city: 'Clearfield', state: 'UT', zip: '84015', find_owner: false, first_name: 'Robert', last_name: 'Strebel' } },
]
const run = async () => {
  if (!process.argv.includes('--live')) { console.error('need --live'); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  let cr = 0; const rows: any[] = []
  for (const v of VARIANTS) {
    const res = await fetch('https://tracerfy.com/v1/api/trace/lookup/', {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(v.body),
    })
    const t = await res.text(); let raw: any; try { raw = JSON.parse(t) } catch { raw = { parse_error: true, body: t.slice(0, 500) } }
    const one = Array.isArray(raw) ? raw[0] : raw
    const persons: any[] = one?.persons ?? []
    const flagged = persons.filter(p => p?.property_owner === true)
    cr += one?.credits_deducted ?? 0
    rows.push({ ...v, hit: one?.hit, credits: one?.credits_deducted ?? 0, persons: persons.length, flagged: flagged.length,
      names: persons.map(p => `${p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(' ')}${p.property_owner ? ' *OWNER*' : ''} (ph${(p.phones ?? []).length}/em${(p.emails ?? []).length})`) })
    writeFileSync(`${OUT}/raw-${v.n}.json`, JSON.stringify({ request: v.body, response: raw }, null, 2))
    console.log(`[${v.n}] hit=${one?.hit} cr=${one?.credits_deducted ?? 0} persons=${persons.length} flaggedOwner=${flagged.length}  <- ${v.note}`)
    for (const nm of rows[rows.length - 1].names.slice(0, 6)) console.log(`      - ${nm}`)
    await new Promise(r => setTimeout(r, 400))
  }
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ parcel: '10 / 305 W Center St, Clearfield UT', owner_of_record: 'Robert P Strebel; Strebel Living Trust', credits: cr, dollars: +(cr * 0.02).toFixed(2), rows }, null, 2))
  console.log(`\ncredits ${cr} = $${(cr * 0.02).toFixed(2)}`)
}
run()
