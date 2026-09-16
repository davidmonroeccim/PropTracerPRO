// Is county parcel-portal content in Brave's index AT ALL?
// Not "can we find it with a good query" but "does it exist in the index".
import dotenv from 'dotenv'
dotenv.config({ path: '/Users/davidmonroe/PropTracerPRO/.env.local', override: true })
delete process.env.FASTAPPEND_API_KEY
delete process.env.TRACERFY_API_KEY
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const KEY = process.env.BRAVE_SEARCH_API_KEY
if (!KEY) { console.error('no brave key'); process.exit(1) }

// Known-good: the Mobile County portal page for the calibration parcel was
// fetched successfully earlier at esearch.mobilecopropertytax.com/Property/View?Id=761633
// qpublic + beacon are the two largest multi-county portal vendors in the US.
const QUERIES = [
  'site:esearch.mobilecopropertytax.com',
  'site:esearch.mobilecopropertytax.com "NOBLE SOUTH"',
  'site:qpublic.net owner parcel',
  'site:beacon.schneidercorp.com owner parcel',
  'site:publicaccess.dauphincounty.gov OR site:auditor.co.stark.oh.us owner',
]

const run = async () => {
  let spent = 0
  for (const q of QUERIES) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10`
    const res = await fetch(url, { headers: { 'X-Subscription-Token': KEY, Accept: 'application/json' } })
    spent += 0.005
    if (!res.ok) { console.log(`${res.status}  ${q}`); continue }
    const body: any = await res.json()
    const hits = body?.web?.results ?? []
    console.log(`\nn=${String(hits.length).padStart(2)}  ${q}`)
    for (const h of hits.slice(0, 4)) {
      try { console.log(`        ${new URL(h.url).hostname}  ${String(h.title).slice(0, 70)}`) } catch {}
    }
    await new Promise(r => setTimeout(r, 1100))
  }
  console.log(`\nspent $${spent.toFixed(3)}`)
}
run()
