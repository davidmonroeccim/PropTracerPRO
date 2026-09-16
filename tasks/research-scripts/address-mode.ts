// Can the dossier answer from an ADDRESS alone, with no parcel id?
// Controls: parcels whose APN-mode answer we already know. 10 credits ($0.20)/hit, 0 on miss.
import dotenv from 'dotenv'
import { writeFileSync, mkdirSync } from 'node:fs'
dotenv.config({ path: '/Users/davidmonroe/PropTracerPRO/.env.local', override: true })
delete process.env.FASTAPPEND_API_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY
const KEY = process.env.TRACERFY_API_KEY!
const OUT = '/Users/davidmonroe/PropTracerPRO/tasks/research-test/address-mode'
const ALLOWED = new Set(['tracerfy.com'])
const rf = globalThis.fetch
globalThis.fetch = ((i:any,o?:any)=>{const h=new URL(typeof i==='string'?i:i?.url).hostname
  if(!ALLOWED.has(h))throw new Error(`BLOCKED ${h}`); return rf(i,o)}) as typeof fetch

const T = [
  { n:'1', body:{address:'4898 Hills And Dales Rd',city:'Canton',state:'OH',zip_code:'44708'}, apnAnswer:'Cutting Edge Hodings Llc' },
  { n:'1-nozip', body:{address:'4898 Hills And Dales Rd',city:'Canton',state:'OH'}, apnAnswer:'Cutting Edge Hodings Llc' },
  { n:'4', body:{address:'5201 Dixie Hwy',city:'Fairfield',state:'OH',zip_code:'45014'}, apnAnswer:'Storage Trust Properties' },
  { n:'5', body:{address:'1440 First St',city:'Napa',state:'CA',zip_code:'94559'}, apnAnswer:'John Anthony Investments Llc' },
  { n:'8', body:{address:'2770 Estates Ave',city:'Pinole',state:'CA',zip_code:'94564'}, apnAnswer:'Estates Ave Properties Llc' },
  // APN mode MISSED this one entirely. County recorder says COLMAVEN, LLC.
  { n:'9', body:{address:'1815 S State St',city:'Salt Lake City',state:'UT'}, apnAnswer:'(APN MODE MISSED — county says COLMAVEN, LLC)' },
]
const oStr=(o:any)=>[o.first_name,o.last_name].filter(Boolean).join(' ').trim()
const run = async () => {
  if(!process.argv.includes('--live')){console.error('need --live');process.exit(2)}
  mkdirSync(OUT,{recursive:true}); let cr=0
  console.log(`ADDRESS MODE — ${T.length} lookups, $0.20/hit, misses free. Max $${(T.length*0.2).toFixed(2)}.\n`)
  for(const t of T){
    const res=await fetch('https://tracerfy.com/v1/api/property-search/lookup/',{method:'POST',
      headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'},body:JSON.stringify(t.body)})
    let d:any; try{d=JSON.parse(await res.text())}catch{d=null}
    cr += d?.credits_deducted ?? 0
    const name=(d?.owners??[]).map(oStr).filter(Boolean).join(' | ')||null
    const p=d?.property??{}
    const match = name && t.apnAnswer.toLowerCase().includes(name.toLowerCase().slice(0,12))
    writeFileSync(`${OUT}/raw-${t.n}.json`,JSON.stringify({request:t.body,response:d},null,2))
    console.log(`[${t.n.padEnd(8)}] hit=${String(d?.hit).padEnd(5)} cr=${d?.credits_deducted??0} | ${(name??'(none)').slice(0,38).padEnd(40)} | apn-mode said: ${t.apnAnswer}`)
    console.log(`            returned addr: ${p.address??'-'}, ${p.city??'-'} ${p.state??'-'} ${p.zip_code??''}  match=${match?'YES':'NO'}`)
    await new Promise(r=>setTimeout(r,400))
  }
  console.log(`\ncredits ${cr} = $${(cr*0.02).toFixed(2)}`)
}
run()
