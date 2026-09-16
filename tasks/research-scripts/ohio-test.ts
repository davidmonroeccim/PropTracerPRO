// OHIO DEFINITIVE TEST: dossier -> classify -> FastAppend, 12 parcels, 4 counties.
import dotenv from 'dotenv'
import { writeFileSync, mkdirSync } from 'node:fs'
dotenv.config({ path: '/Users/davidmonroe/PropTracerPRO/.env.local', override: true })
delete process.env.SUPABASE_SERVICE_ROLE_KEY
const TK = process.env.TRACERFY_API_KEY!, FK = process.env.FASTAPPEND_API_KEY!
const OUT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/ohio'
const ALLOWED = new Set(['tracerfy.com', 'app.fastappend.com'])
const rf = globalThis.fetch
globalThis.fetch = ((i: any, o?: any) => {
  const h = new URL(typeof i === 'string' ? i : i?.url).hostname
  if (!ALLOWED.has(h)) throw new Error(`BLOCKED ${h}`); return rf(i, o)
}) as typeof fetch

const P = [
  { n: '1', c: 'Cuyahoga', apn: '00120057', a: '1362 W 116 St, Cleveland', cls: 'retail', size: 'large' },
  { n: '2', c: 'Cuyahoga', apn: '00128012', a: '10107 Detroit Ave, Cleveland', cls: 'multifamily 40+', size: 'large' },
  { n: '3', c: 'Cuyahoga', apn: '01126001B', a: '2700 Brookpark Rd, Cleveland', cls: 'mobile home park', size: 'large' },
  { n: '4', c: 'Montgomery', apn: 'A01 00203 0075', a: '3620 Lightner Rd, Vandalia', cls: 'industrial', size: 'large' },
  { n: '5', c: 'Montgomery', apn: 'B02 01410 0001', a: '1201 Brindlestone Dr, Vandalia', cls: 'multifamily', size: 'large' },
  { n: '6', c: 'Montgomery', apn: 'C04 00602 0097', a: '7083 Brookville Rd, Brookville', cls: 'mobile home park', size: 'large' },
  { n: '7', c: 'Allen', apn: '25300001001003', a: '1102 Elida Ave, Delphos', cls: 'retail', size: 'small' },
  { n: '8', c: 'Allen', apn: '25190001004000', a: '1600 Gressel Dr, Delphos', cls: 'industrial', size: 'small' },
  { n: '9', c: 'Allen', apn: '25200003005000', a: '1775 E 5th St, Delphos', cls: 'medical office', size: 'small' },
  { n: '10', c: 'Clark', apn: '0500200013300045', a: '2443 Troy Rd, Springfield', cls: 'retail', size: 'small' },
  { n: '11', c: 'Clark', apn: '0300500033000123', a: '600 N Dayton-Lakeview Rd, New Carlisle', cls: 'industrial', size: 'small' },
  { n: '12', c: 'Clark', apn: '0500600018000037', a: '1540 Faux Satin Dr, Springfield', cls: 'multifamily 152u', size: 'small' },
]
const ENTITY = /\b(LLC|L\.?L\.?C|INC|CORP(ORATION)?|LTD|LP|L\.P\.|LLP|PLLC|TRUST|TR|TTEE|ESTATE|CHURCH|FOUNDATION|PARTNERSHIP|ASSOC(IATION)?|HOLDINGS?|PROPERT(Y|IES)|ENTERPRISES?|GROUP|VENTURES?|REALTY|MANAGEMENT|BANK|INVESTMENTS?|STORAGE|DEVELOPMENT|AUTHORITY|DISTRICT|APARTMENTS?|VILLAGE|PARK|CITY OF|COUNTY OF|STATE OF|COMPANY|CO)\b/i
const oStr = (o: any) => typeof o === 'string' ? o : Object.entries(o ?? {}).filter(([k, v]) => typeof v === 'string' && !/^(age|dob)$/i.test(k)).map(([, v]) => v).join(' ').replace(/\s+/g, ' ').trim()

const run = async () => {
  if (!process.argv.includes('--live')) { console.error('need --live'); process.exit(2) }
  mkdirSync(OUT, { recursive: true })
  console.log(`OHIO TEST — 12 parcels, 4 counties. Dossier $0.20/hit then FastAppend $0.10/hit. Max $3.60.\n`)
  const rows: any[] = []; let dCr = 0, fCr = 0
  for (const p of P) {
    const r1 = await fetch('https://tracerfy.com/v1/api/property-search/lookup/', {
      method: 'POST', headers: { Authorization: `Bearer ${TK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apn: p.apn, county: p.c, state: 'OH' }),
    })
    let d: any; try { d = JSON.parse(await r1.text()) } catch { d = null }
    dCr += d?.credits_deducted ?? 0
    const owners: any[] = d?.owners ?? []
    const name = owners.map(oStr).filter(Boolean).join(' | ') || null
    const type = name ? (ENTITY.test(name) ? 'entity' : 'individual') : 'none'
    const row: any = { ...p, dossier_hit: d?.hit ?? null, dossier_credits: d?.credits_deducted ?? 0,
      owner_name: name, type, corporate_owned: d?.property?.corporate_owned ?? null,
      dossier_phones: d?.contacts?.phones?.length ?? 0, dossier_emails: d?.contacts?.emails?.length ?? 0,
      fa_hit: null, fa_credits: 0, fa_people: 0, fa_principals: 0, fa_agents: 0, fa_names: [] as string[] }
    writeFileSync(`${OUT}/dossier-${p.n}.json`, JSON.stringify(d, null, 2))

    if (type === 'entity') {
      await new Promise(r => setTimeout(r, 300))
      const r2 = await fetch('https://app.fastappend.com/v1/api/business-trace/lookup/', {
        method: 'POST', headers: { Authorization: `Bearer ${FK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_name: name, state: 'OH' }),
      })
      let f: any; try { f = JSON.parse(await r2.text()) } catch { f = null }
      fCr += f?.credits_deducted ?? 0
      const ppl: any[] = f?.associated_people ?? []
      row.fa_hit = f?.hit ?? false; row.fa_credits = f?.credits_deducted ?? 0
      row.fa_people = ppl.length
      row.fa_agents = ppl.filter(x => x?.is_registered_agent === true).length
      row.fa_principals = ppl.filter(x => x?.is_registered_agent !== true).length
      row.fa_names = ppl.map(x => `${x.full_name ?? [x.first_name, x.last_name].filter(Boolean).join(' ')} [${x.role ?? '-'}]`)
      writeFileSync(`${OUT}/fa-${p.n}.json`, JSON.stringify(f, null, 2))
    }
    rows.push(row)
    console.log(`[${p.n.padStart(2)}] ${p.c.padEnd(11)} dossier=${String(row.dossier_hit).padEnd(5)} | ${(row.owner_name ?? '(none)').slice(0, 42).padEnd(42)} | ${row.type.padEnd(10)} | FA=${row.fa_hit === null ? 'n/a ' : String(row.fa_hit).padEnd(5)} ppl=${row.fa_people}`)
    for (const nm of row.fa_names.slice(0, 3)) console.log(`      - ${nm}`)
    await new Promise(r => setTimeout(r, 300))
  }
  const ents = rows.filter(r => r.type === 'entity')
  const byCounty: any = {}
  for (const r of rows) { byCounty[r.c] ??= { dossier: 0, entities: 0, fa_hits: 0 }; if (r.dossier_hit) byCounty[r.c].dossier++; if (r.type === 'entity') byCounty[r.c].entities++; if (r.fa_hit === true) byCounty[r.c].fa_hits++ }
  const s = { generated_at: new Date().toISOString(), state: 'OH', parcels: rows.length,
    dossier_hits: rows.filter(r => r.dossier_hit).length, owner_names: rows.filter(r => r.owner_name).length,
    entities: ents.length, individuals: rows.filter(r => r.type === 'individual').length,
    fa_hits: rows.filter(r => r.fa_hit === true).length,
    dossier_dollars: +(dCr * 0.02).toFixed(2), fa_dollars: +(fCr * 0.10).toFixed(2),
    total_dollars: +(dCr * 0.02 + fCr * 0.10).toFixed(2), by_county: byCounty, rows }
  writeFileSync(`${OUT}/results.json`, JSON.stringify(s, null, 2))
  console.log(`\ndossier ${s.dossier_hits}/12 hits, ${s.owner_names}/12 owner names | entities ${s.entities}, individuals ${s.individuals}`)
  console.log(`FastAppend ${s.fa_hits}/${s.entities} entity hits`)
  console.log(`by county: ${JSON.stringify(byCounty)}`)
  console.log(`cost: dossier $${s.dossier_dollars} + FastAppend $${s.fa_dollars} = $${s.total_dollars}`)
}
run()
