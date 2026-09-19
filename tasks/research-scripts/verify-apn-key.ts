/**
 * LIVE VERIFICATION of the dossier's second lookup key. 2026-09-19.
 *
 * SPENDS REAL MONEY. A dossier HIT costs $0.20 (10 Tracerfy credits at $0.02). A MISS is
 * free. Expected total for this run: $0.20.
 *
 * WHAT IT PROVES, and why this parcel.
 * Napa 003330004000 was measured during the 2026-09-16 research as hitting on APN and
 * MISSING on address. It is therefore the one parcel that can demonstrate the new key
 * doing something the old key cannot. Any parcel that hits both ways would prove only
 * that the dossier works, which was never in doubt.
 *
 * WHAT IT EXERCISES. The real wiring, not a reconstruction of it:
 *   parcelForRow(row)  -- the exported function the tier 2 cron now calls
 *   planRoute(parcel)  -- emits DOSSIER_APN then DOSSIER_ADDRESS
 *   lookupDossier(key) -- the live vendor call, once per step
 *
 * The row below is shaped exactly as sweep-property-traces reads one out of
 * trace_history, including normalized_address in its STREET|CITY|STATE form, so
 * parcelForRow performs the same split it performs in production.
 *
 * Run:  npx tsx --env-file=.env.local tasks/research-scripts/verify-apn-key.ts
 *
 * Uses node's built-in --env-file rather than dotenv, which is not a repo dependency (see
 * this directory's README: tsx and dotenv were installed in a scratchpad, not here).
 */

// Belt and braces, copied from dossier-lookup.ts in this directory: drop credentials this
// script has no business touching, so a mistake cannot reach the wrong vendor or the
// production database.
delete process.env.FASTAPPEND_API_KEY
delete process.env.SUPABASE_SERVICE_ROLE_KEY

import { planRoute } from '../../lib/routing/ownerRoute'
import { lookupDossier, type DossierKey } from '../../lib/tracerfy/dossier'
import { parcelForRow } from '../../app/api/cron/sweep-property-traces/route'
import { normalizeAddress } from '../../lib/utils/address-normalizer'

// The parcel, from tasks/research-scripts/run-research.ts line 113.
const APN = '003330004000'
const COUNTY = 'Napa'
const STATE = 'CA'
const ADDRESS = '1440 FIRST ST'
const CITY = 'Napa'
const ZIP = '94559'

function line(s = '') { console.log(s) }

async function main() {
  line('LIVE VERIFICATION: the dossier APN key')
  line('======================================')
  line(`parcel ${APN}, ${COUNTY} County, ${STATE}`)
  line('')

  // 1. Build the row exactly as the cron reads it.
  const row = {
    id: 'verify-apn-key',
    user_id: 'verify',
    trace_job_id: null,
    normalized_address: normalizeAddress(ADDRESS, CITY, STATE),
    city: CITY,
    state: STATE,
    zip: ZIP,
    source: 'mcp',
    property_trace_status: 'queued',
    charge: 0,
    tier: 2,
    property_record: null,
    parcel_id_local: APN,
    county: COUNTY,
  }
  line(`row.normalized_address = ${JSON.stringify(row.normalized_address)}`)

  // 2. The function the cron calls. This is the wiring under test.
  const parcel = parcelForRow(row as never)
  line('')
  line('parcelForRow produced:')
  line(`  parcelIdLocal = ${JSON.stringify(parcel.parcelIdLocal)}`)
  line(`  county        = ${JSON.stringify(parcel.county)}`)
  line(`  state         = ${JSON.stringify(parcel.state)}    <- the third part of the key`)
  line(`  situsAddress  = ${JSON.stringify(parcel.situsAddress)}`)

  if (!parcel.parcelIdLocal || !parcel.county || !parcel.state) {
    line('')
    line('ABORT: the APN key is incomplete. It is a THREE-part key and a partial request')
    line('is answered with a FREE miss, so spending on it would prove nothing.')
    process.exit(1)
  }

  // 3. The plan. Both steps, APN first.
  const plan = planRoute(parcel, 'pro')
  line('')
  line(`planRoute emitted: ${plan.steps.map((s) => s.kind).join(', ')}`)
  const apnStep = plan.steps.find((s) => s.kind === 'DOSSIER_APN')
  const addrStep = plan.steps.find((s) => s.kind === 'DOSSIER_ADDRESS')
  if (!apnStep) {
    line('ABORT: no DOSSIER_APN step. hasApn() is still false and nothing changed.')
    process.exit(1)
  }
  line(`DOSSIER_APN request: ${JSON.stringify(apnStep.request)}`)
  line(`DOSSIER_ADDRESS request: ${JSON.stringify(addrStep?.request)}`)

  let spent = 0

  // 4. ADDRESS FIRST, deliberately. It is expected to MISS and a miss is free, so this
  //    costs nothing and establishes the baseline the APN key is being measured against.
  line('')
  line('--- calling the vendor, ADDRESS mode (expected: MISS, free) ---')
  const addrKey: DossierKey = { mode: 'address', address: ADDRESS, city: CITY, state: STATE, zip_code: ZIP }
  const addrResult = await lookupDossier(addrKey)
  line(`  success=${addrResult.success} hit=${addrResult.hit} credits=${addrResult.creditsDeducted ?? 0}`)
  if (!addrResult.success) line(`  error: ${addrResult.error}`)
  spent += (addrResult.creditsDeducted ?? 0) * 0.02

  // 5. APN MODE. The thing under test. Expected to HIT, at $0.20.
  line('')
  line('--- calling the vendor, APN mode (expected: HIT, $0.20) ---')
  const apnKey: DossierKey = { mode: 'apn', apn: APN, county: COUNTY, state: STATE }
  const apnResult = await lookupDossier(apnKey)
  line(`  success=${apnResult.success} hit=${apnResult.hit} credits=${apnResult.creditsDeducted ?? 0}`)
  if (!apnResult.success) line(`  error: ${apnResult.error}`)
  spent += (apnResult.creditsDeducted ?? 0) * 0.02

  if (apnResult.hit) {
    const owners = apnResult.owners ?? []
    line('')
    line('OWNER OF RECORD returned by the APN key:')
    for (const o of owners) {
      line(`  ${JSON.stringify([o.first_name, o.last_name].filter(Boolean).join(' '))}`)
    }
    const p = apnResult.property as Record<string, unknown> | null
    line(`property keys returned: ${p ? Object.keys(p).length : 0}`)
    if (p) {
      line(`  apn returned      = ${JSON.stringify(p.apn)}`)
      line(`  address returned  = ${JSON.stringify(p.address)}, ${JSON.stringify(p.city)} ${JSON.stringify(p.state)}`)
      line(`  assessed_value    = ${JSON.stringify(p.assessed_value)}  (county assessment, NOT a market value)`)
    }
  }

  line('')
  line('VERDICT')
  line('=======')
  line(`  address mode: ${addrResult.hit ? 'HIT' : 'MISS'}`)
  line(`  apn mode:     ${apnResult.hit ? 'HIT' : 'MISS'}`)
  line(`  spent:        $${spent.toFixed(2)}`)
  line('')
  if (apnResult.hit && !addrResult.hit) {
    line('  PROVEN: the APN key resolved a parcel the address key could not.')
  } else if (apnResult.hit && addrResult.hit) {
    line('  APN key works. Address also hit this time, so this run does not by itself')
    line('  demonstrate the APN key reaching something the address key cannot.')
  } else {
    line('  NOT PROVEN. Read the errors above before concluding anything.')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
