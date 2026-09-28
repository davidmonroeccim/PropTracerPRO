/**
 * Tier 1 Phase 2B live check (plan Task 8). NINE records across the eight paths 2B created, on the
 * TWO surfaces 2B put on the queue: the v1 API (Bearer API key) and the MCP bulk submit (gateway
 * sub). Built on tasks/research-scripts/phase2a/run-live.ts, which is the reference implementation.
 *
 *   npx tsx tasks/research-scripts/phase2b/run-live.ts --plan
 *   npx tsx tasks/research-scripts/phase2b/run-live.ts --readback          (free, no vendor calls)
 *   PTP_LIVE_RUN=1 npx tsx tasks/research-scripts/phase2b/run-live.ts --live --max-dollars <n> \
 *       --api-key <ptp api key> --gateway-sub <david's gateway sub>
 *
 * WHO RUNS WHAT (L-031). The executor BUILDS this and proves its refusals. It never passes --live
 * and never sets PTP_LIVE_RUN. David names the dollar amount; the CONTROLLER runs the spend.
 *
 * WHAT IS DIFFERENT FROM 2A, AND WHY IT MATTERS TO THE CEILING. 2A drove the WEB bulk route, which
 * sends no parcel id, so planRoute could reach at most one Tracerfy step per Tier 1 record and
 * TRACERFY_PARCEL_APN was structurally unreachable. Both surfaces here DO carry apn and county
 * (D23), so a Tier 1 record can reach BOTH Tracerfy steps and then the D3/D16 FastAppend fallback.
 * The per-record ceiling is therefore strictly higher than 2A's and is derived from the ROW rather
 * than from the path label, because the label is a claim about how planRoute will classify an owner
 * name and the row is a fact:
 *
 *   Tier 1 record:  (hasSitus ? TRACERFY_INSTANT : 0) + (hasApn ? TRACERFY_PARCEL : 0)
 *                   + FASTAPPEND_ENTITY
 *   Tier 2 record:  DOSSIER + owners * (that same per-owner ladder)
 *
 *   hasSitus is street AND city AND state AS SUBMITTED (lib/routing/ownerRoute.ts:346), so a record
 *   submitted without a city cannot reach Tracerfy Instant at any price. hasApn is parcel id AND
 *   county, both or neither. The three step kinds are summed rather than maximised because the trust
 *   and unreadable-name ladder (D3, D16) runs the person steps AND THEN FastAppend, so the sum is
 *   the real ceiling for a name this script cannot classify in advance.
 *
 *   Only ONE dossier key can HIT on a tier 2 record, so the dossier is bought once. D21(c) with D40
 *   then tries EVERY owner the dossier names, each on its own ladder, with no cap, so `owners` is a
 *   declared BUDGET and not a bound. A tier 2 record that declares none is REFUSED: assuming a count
 *   would fabricate the single input the spend cap is checked against (CLAUDE.md rule 7).
 *
 *   A record this check expects to spend $0.00 is still budgeted at its full ladder. "This record
 *   spends nothing" is the thing the live check exists to verify, and a cap that assumes the code
 *   under test is correct is not a cap.
 *
 * THE FIVE REFUSALS (L-031). A spend cap does not stop an agent. On 2026-09-23 a subagent ran the
 * FastAppend probe `--live --max-dollars 1` as a "boundary test" against an explicit instruction,
 * the worst case was exactly $1.00, the refusal tested `total > maxDollars`, $1.00 does not exceed
 * $1.00, and ten real vendor calls went out. So:
 *   R0  --live does NOTHING unless PTP_LIVE_RUN=1 is in the environment, CHECKED BEFORE THE CAP, so
 *       no cap value an agent can invent gets past it.
 *   R1  no records file.
 *   R2  a duplicate record id.
 *   R3  a path with no record.
 *   R4  a tier 2 record declaring no owner count.
 *   And the cap itself must be STRICTLY GREATER than the computed worst case. A cap equal to the
 *   worst case is refused, because that is the shape that spent the money.
 * Every refusal fires before a credential is read, before a database is opened and before a vendor
 * is called: loadEnvLocal() is reached only after all of them pass.
 *
 * THE MCP LANE IS CALLED IN PROCESS, AND THAT IS A NAMED GAP. app/api/[transport]/route.ts wraps the
 * tools in withMcpAuth + verifyToken, which needs a gateway Supabase JWT no script can mint without
 * a browser login. So --live calls skipTraceBulk(admin, gatewaySub, ...) directly: the same function
 * the MCP tool calls, with the same admin client and the same gateway sub. What it does NOT exercise
 * is withMcpAuth, verifyToken, the entitlement cache and the tool registration. Say so in the report.
 *
 * THE LANE, DECIDED BEFORE ANY SPEND (plan Task 8 Step 1, Amendment 4). origin/main is at 2982627,
 * the Phase 2A merge, so main ALREADY knows tier1_* and vercel.json runs sweep-entity-traces AND
 * sweep-property-traces on `* * * * *`. 2A's accidental protection is therefore already gone, not
 * "gone once 2B merges": a local server pointed at production would lose BOTH lanes to production's
 * crons inside 60 seconds, and main carries none of Task 1 and Task 2's finalizeTouchedJobs wiring, so
 * a job drained by main would settle its rows and never write completed_at. That would read as a
 * failure of the one claim only this phase can prove.
 *
 * THE LANE AS ACTUALLY RUN, and it is NOT what the paragraph above proposed. David chose, 2026-09-27,
 * to MERGE the branch to main and deploy it to production rather than pause anything, having told his
 * users to hold off. Measured before the merge: every queue was EMPTY (zero rows in any tier1_queued*
 * status, zero queued property traces, zero trace_jobs at 'processing'), so the deploy could touch
 * nothing but this check's own records.
 *
 * That removes the race rather than dodging it: production's crons ARE this code now, so there is no
 * main-versus-branch mismatch left to protect against and NO CRON NEEDS PAUSING. It also means this
 * script must NOT drive the crons, for two reasons. First, .env.local's CRON_SECRET is a local-only
 * value appended during 2A and does not authenticate against production (measured: HTTP 401), and
 * reading production's is refused by the credential classifier. Second and better: production's own
 * scheduler runs both crons every 60 s on this same commit, so letting it drain is a STRONGER proof
 * than driving them by hand. Nobody drives the crons and nobody opens the status route.
 *
 * So: PTP_BASE_URL=https://proptracerpro.com, --live --no-drain, then wait for the queues to go quiet
 * and run --readback. Latency comes from created_at -> completed_at in the database rather than from
 * this script's own pass timings.
 *
 * DO NOT OPEN THE STATUS ROUTE. The one thing only this phase can prove is that the job reaches
 * `completed` with nobody polling it, so --readback queries trace_jobs and trace_history directly
 * and this script never calls /api/v1/trace/bulk/status or bulkStatus. Reading the status route
 * before the read-back confirms completed_at would destroy the evidence.
 *
 * Raw request and response pairs go to tasks/research-test/phase2b/live.jsonl (gitignored: real
 * purchased contact data). The terminal gets no owner name, street, parcel id, phone or email.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VENDOR_COST } from '../../../lib/routing/ownerRoute'
import { TRACE_HISTORY_WIDTH, createAddressHash, traceKeyFor } from '../../../lib/utils/address-normalizer'

type LivePath =
  | 'v1_named_full_address'
  | 'v1_named_no_city'
  | 'v1_named_no_city_apn'
  | 'v1_blank_unusable'
  /** THE DOSSIER TEST (2026-09-28). Blank owner, apn + county + 2-letter state, and NO city, so
   *  hasSitus is false and DOSSIER_APN is the ONLY step planRoute can emit. This key has never been
   *  sent to Tracerfy by this application in any phase: 0, 1, 2A and 2B's live check all exercised
   *  address-keyed paths. Both records are genuinely city-less IN THE REGISTRY, so the shape is the
   *  one a gateway caller would pass, not one manufactured by dropping a city we hold. */
  | 'v1_blank_apn_no_city'
  | 'v1_blank_good_address'
  | 'mcp_named_no_city_apn'
  | 'mcp_blank'
  | 'v1_mixed_batch'

/** Exactly the keys each surface accepts. A key that is ABSENT here is absent on the wire, which is
 *  the distinction Task 6 measured: the MCP refuses an OMITTED `address` key and accepts `city`
 *  omitted entirely, which is the gateway's APN shape. */
interface LiveRow {
  address: string
  city?: string
  state?: string
  zip?: string
  owner_name?: string
  apn?: string
  county?: string
}

interface LiveRecord {
  id: string
  path: LivePath
  surface: 'v1' | 'mcp'
  /** Records sharing a batch id are submitted in ONE call, which is what C8 exists to exercise. */
  batch: string
  row: LiveRow
  /** Tier 2 only: how many owners the dossier is BUDGETED to name. Required on that path. */
  owners?: number
  /** Reporting only. Never sent to a vendor. */
  state: string
  county: string
  property_type: string
  parcel_uid: string
}

const ALL_PATHS: readonly LivePath[] = [
  'v1_named_full_address',
  'v1_named_no_city',
  'v1_named_no_city_apn',
  'v1_blank_unusable',
  'v1_blank_apn_no_city',
  'v1_blank_good_address',
  'mcp_named_no_city_apn',
  'mcp_blank',
  'v1_mixed_batch',
]

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'tasks/research-test/phase2b')
const RECORDS = join(OUT_DIR, 'records.json')
const JOBS = join(OUT_DIR, 'jobs.json')
const LOG = join(OUT_DIR, 'live.jsonl')
const BASE = process.env.PTP_BASE_URL || 'http://localhost:3000'

/** A record is TIER 2 when it arrives with no owner of record, which is the same question
 *  isBlankOwnerRecord asks on both submit surfaces. Derived from the ROW, never from the path label. */
const isTier2 = (r: LiveRecord): boolean => !(r.row.owner_name || '').trim()

/** ownerRoute.ts:346. Street AND city AND state, as SUBMITTED. */
const hasSitus = (row: LiveRow): boolean =>
  Boolean(row.address?.trim() && row.city?.trim() && row.state?.trim())

/** ownerRoute.ts:350. Both halves or neither. */
const hasApn = (row: LiveRow): boolean => Boolean(row.apn?.trim() && row.county?.trim())

/** Every vendor step kind ONE owner's ladder can reach on this surface, summed. */
function ladderFor(row: LiveRow): number {
  const instant = hasSitus(row) ? VENDOR_COST.TRACERFY_INSTANT : 0
  const parcel = hasApn(row) ? VENDOR_COST.TRACERFY_PARCEL : 0
  return instant + parcel + VENDOR_COST.FASTAPPEND_ENTITY
}

/** Vendor dollars if every step this ROW can reach on THIS surface bills. */
function worstCaseFor(record: LiveRecord): number {
  if (isTier2(record)) {
    return VENDOR_COST.DOSSIER + (record.owners as number) * ladderFor(record.row)
  }
  return ladderFor(record.row)
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const worstCase = (records: LiveRecord[]): number =>
  round2(records.reduce((sum, r) => sum + worstCaseFor(r), 0))

function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, '')
  }
  return out
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function loadRecords(): LiveRecord[] {
  // REFUSAL 1. No records file.
  if (!existsSync(RECORDS)) {
    throw new Error(`REFUSED: write the chosen records to ${RECORDS} first (Task 8, Step 3). Not run.`)
  }
  const records = JSON.parse(readFileSync(RECORDS, 'utf8')) as LiveRecord[]
  if (records.length === 0) throw new Error('REFUSED: no records. Not run.')

  // REFUSAL 2. A duplicate record id. Ids identify a row in the report and in live.jsonl, so a
  // duplicate makes the evidence unreadable.
  const ids = new Set(records.map((r) => r.id))
  if (ids.size !== records.length) throw new Error('REFUSED: duplicate record id. Not run.')

  for (const r of records) {
    if (!ALL_PATHS.includes(r.path)) {
      throw new Error(`REFUSED: ${r.id} is on unknown path ${r.path}. Not run.`)
    }
    if (r.surface !== 'v1' && r.surface !== 'mcp') {
      throw new Error(`REFUSED: ${r.id} declares unknown surface ${r.surface}. Not run.`)
    }
    if (typeof r.row?.address !== 'string') {
      // Task 6 measured that the MCP refuses an OMITTED address key as a thrown ZodError rather
      // than a per-record verdict. Refusing here keeps that out of a paid run.
      throw new Error(`REFUSED: ${r.id} has no address KEY. The MCP refuses that shape. Not run.`)
    }
  }

  // REFUSAL 3. A path with no record. Every path 2B created must be exercised (L-024).
  const seen = new Set(records.map((r) => r.path))
  const missing = ALL_PATHS.filter((p) => !seen.has(p))
  if (missing.length > 0) {
    throw new Error(`REFUSED: no record on path(s) ${missing.join(', ')}. Every path is exercised. Not run.`)
  }

  // REFUSAL 4. A tier 2 record with no owner count. The dossier decides how many contact lookups
  // follow it (D21(c), D40), so without a declared count the worst case is unknown, and an assumed
  // count would be a fabricated input to the one number the spend cap is checked against.
  for (const r of records) {
    if (!isTier2(r)) continue
    if (!Number.isInteger(r.owners) || (r.owners as number) < 0) {
      throw new Error(
        `REFUSED: ${r.id} arrives with no owner of record, so it is a TIER 2 record, and it declares ` +
          'no owner count. The dossier decides how many contact lookups follow it, so the worst case ' +
          `cannot be computed and must not be guessed. Add "owners": <n> to that record. Not run.`
      )
    }
  }
  return records
}

function batchesOf(records: LiveRecord[]): { batch: string; surface: 'v1' | 'mcp'; records: LiveRecord[] }[] {
  const order: string[] = []
  const byBatch = new Map<string, LiveRecord[]>()
  for (const r of records) {
    if (!byBatch.has(r.batch)) {
      byBatch.set(r.batch, [])
      order.push(r.batch)
    }
    byBatch.get(r.batch)!.push(r)
  }
  return order.map((batch) => {
    const rows = byBatch.get(batch)!
    const surfaces = new Set(rows.map((r) => r.surface))
    if (surfaces.size !== 1) {
      throw new Error(`REFUSED: batch ${batch} mixes surfaces. One batch is one call. Not run.`)
    }
    return { batch, surface: rows[0].surface, records: rows }
  })
}

/** The wire shape, with ABSENT keys left absent. */
function wireRow(row: LiveRow): Record<string, string> {
  const out: Record<string, string> = { address: row.address }
  for (const k of ['city', 'state', 'zip', 'owner_name', 'apn', 'county'] as const) {
    if (row[k] !== undefined) out[k] = row[k] as string
  }
  return out
}

function printPlan(records: LiveRecord[], total: number): void {
  console.log(`Worst case $${total.toFixed(2)} across ${records.length} records.`)
  console.log(
    `  Per-owner ladder: TRACERFY_INSTANT $${VENDOR_COST.TRACERFY_INSTANT.toFixed(2)} only when the row ` +
      `carries street AND city AND state (hasSitus), plus TRACERFY_PARCEL $${VENDOR_COST.TRACERFY_PARCEL.toFixed(2)} ` +
      `only when it carries apn AND county (hasApn), plus FASTAPPEND_ENTITY ` +
      `$${VENDOR_COST.FASTAPPEND_ENTITY.toFixed(2)}, which the D3/D16 ladder reaches after both.`
  )
  console.log(
    `  Tier 2 adds DOSSIER $${VENDOR_COST.DOSSIER.toFixed(2)} once, then one whole ladder for each owner ` +
      'it is BUDGETED to name. That lane has no structural ceiling (D21(c), D40), so the figure is a budget.'
  )
  for (const p of ALL_PATHS) {
    const onPath = records.filter((r) => r.path === p)
    const sub = round2(onPath.reduce((s, r) => s + worstCaseFor(r), 0))
    console.log(`  ${p}: ${onPath.length} record(s), $${sub.toFixed(2)}`)
    for (const r of onPath) {
      const tier = isTier2(r) ? `tier 2, ${r.owners} owners budgeted` : 'tier 1'
      const keys = Object.keys(wireRow(r.row)).join('+')
      console.log(
        `      ${r.id}: $${worstCaseFor(r).toFixed(2)} (${tier}; ${r.state} ${r.county}; ` +
          `${r.property_type}; sends ${keys}; hasSitus=${hasSitus(r.row)} hasApn=${hasApn(r.row)})`
      )
    }
  }
  console.log('  Batches, one call each:')
  for (const b of batchesOf(records)) {
    console.log(`      ${b.batch} (${b.surface}): ${b.records.map((r) => r.id).join(', ')}`)
  }
  console.log('Nothing was run and nothing was spent. Pass --live to submit and drain.')
}

interface SubmittedJob {
  batch: string
  surface: 'v1' | 'mcp'
  jobId: string
  recordIds: string[]
  submittedAt: string
}

function logLine(entry: Record<string, unknown>): void {
  mkdirSync(OUT_DIR, { recursive: true })
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

async function submitV1(
  batch: { batch: string; records: LiveRecord[] },
  apiKey: string
): Promise<SubmittedJob> {
  const body = { records: batch.records.map((r) => wireRow(r.row)) }
  const res = await fetch(`${BASE}/api/v1/trace/bulk`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await res.json()) as Record<string, unknown>
  logLine({ kind: 'submit', surface: 'v1', batch: batch.batch, status: res.status, payload })
  const jobId = payload.jobId as string | null
  if (!res.ok || !jobId) {
    throw new Error(
      `v1 submit for batch ${batch.batch} answered HTTP ${res.status} with jobId ${String(jobId)}. ` +
        'Stopping rather than draining a job that may not exist.'
    )
  }
  console.log(
    `${batch.batch} (v1): HTTP ${res.status}, job ${jobId}, ` +
      `accepted ${String(payload.recordsSubmitted ?? payload.records_submitted ?? '?')}, ` +
      `skipped ${String(payload.recordsSkipped ?? 0)}`
  )
  return {
    batch: batch.batch,
    surface: 'v1',
    jobId,
    recordIds: batch.records.map((r) => r.id),
    submittedAt: new Date().toISOString(),
  }
}

async function submitMcp(
  batch: { batch: string; records: LiveRecord[] },
  gatewaySub: string
): Promise<SubmittedJob> {
  const { createAdminClient } = await import('../../../lib/supabase/admin')
  const { skipTraceBulk } = await import('../../../lib/suite/mcp-tools')
  const admin = createAdminClient()
  const payload = (await skipTraceBulk(admin, gatewaySub, {
    records: batch.records.map((r) => wireRow(r.row)),
    confirm: true,
  })) as Record<string, unknown>
  logLine({ kind: 'submit', surface: 'mcp', batch: batch.batch, payload })
  const jobId = payload.job_id as string | undefined
  if (!jobId) {
    throw new Error(
      `MCP submit for batch ${batch.batch} returned no job_id (error ${String(payload.error ?? 'none')}). ` +
        'Stopping rather than draining a job that may not exist.'
    )
  }
  console.log(
    `${batch.batch} (mcp): job ${jobId}, accepted ${String(payload.accepted ?? '?')}, ` +
      `no_lookup_key ${String(payload.no_lookup_key ?? 0)}`
  )
  return {
    batch: batch.batch,
    surface: 'mcp',
    jobId,
    recordIds: batch.records.map((r) => r.id),
    submittedAt: new Date().toISOString(),
  }
}

/** Drives BOTH crons. Tier 1 rows settle on ai_research_status, tier 2 rows on
 *  property_trace_status, and a job is not drained until both lanes are quiet. */
async function drain(secret: string): Promise<void> {
  const crons = ['sweep-entity-traces', 'sweep-property-traces'] as const
  for (let pass = 1; pass <= 12; pass++) {
    let moved = 0
    for (const cron of crons) {
      const started = Date.now()
      const res = await fetch(`${BASE}/api/cron/${cron}`, {
        headers: { Authorization: `Bearer ${secret}` },
      })
      const body = (await res.json()) as Record<string, unknown>
      const ms = Date.now() - started
      logLine({ kind: 'cron', pass, cron, status: res.status, ms, body })
      const tier1 = (body.tier1 ?? {}) as Record<string, number>
      const processed =
        Number(tier1.processed ?? 0) + Number((body.processed as number | undefined) ?? 0)
      const throttled =
        Number(tier1.throttled ?? 0) + Number((body.throttled as number | undefined) ?? 0)
      moved += processed + throttled
      console.log(
        `pass ${pass} | ${cron} | HTTP ${res.status} | processed ${processed} | throttled ${throttled} | ` +
          `finalized ${String(body.jobsFinalized ?? 0)} | finalizeFailed ${String(body.finalizeFailed ?? 0)} | ${ms} ms`
      )
    }
    if (moved === 0) {
      console.log('Both queues are quiet. Run --readback; do NOT open the status route first.')
      return
    }
  }
  console.log('Twelve passes and a queue is still draining. Run --readback and read what is there.')
}

/** FREE. No vendor call, no status route. Everything Step 7 asks for, read straight from the tables. */
async function readback(records: LiveRecord[]): Promise<void> {
  if (!existsSync(JOBS)) throw new Error(`No ${JOBS}. Submit first.`)
  const jobs = JSON.parse(readFileSync(JOBS, 'utf8')) as SubmittedJob[]
  const { createAdminClient } = await import('../../../lib/supabase/admin')
  const admin = createAdminClient()

  // Amendment 9: the live column widths, which no unit test can reach. A constant WIDER than the
  // column means the overflow this phase fixed is back; NARROWER means rows are emptied for nothing.
  const { data: widths, error: widthError } = await admin
    .from('information_schema.columns' as never)
    .select('column_name, character_maximum_length')
  if (widthError) {
    console.log(
      `COLUMN WIDTHS: could not read information_schema through PostgREST (${widthError.message}). ` +
        'Read them with a direct psql/\\d trace_history instead; do not skip this check.'
    )
  } else {
    console.log('COLUMN WIDTHS (compare to TRACE_HISTORY_WIDTH):', JSON.stringify(widths))
  }
  console.log(`TRACE_HISTORY_WIDTH constant: ${JSON.stringify(TRACE_HISTORY_WIDTH)}`)

  for (const job of jobs) {
    const { data: jobRow, error: jobError } = await admin
      .from('trace_jobs')
      .select('id, status, records_submitted, records_matched, created_at, completed_at, user_id')
      .eq('id', job.jobId)
      .maybeSingle()
    if (jobError) throw new Error(`trace_jobs read failed for ${job.jobId}: ${jobError.message}`)
    console.log(
      `JOB ${job.batch} (${job.surface}) ${job.jobId}: status ${jobRow?.status}, ` +
        `submitted ${jobRow?.records_submitted}, matched ${jobRow?.records_matched}, ` +
        `created ${jobRow?.created_at}, completed ${jobRow?.completed_at ?? 'null'}`
    )

    const { data: rows, error: rowError } = await admin
      .from('trace_history')
      .select(
        'id, address_hash, normalized_address, city, state, zip, parcel_id_local, county, source, ' +
          'ai_research_status, property_trace_status, outcome_code, found_by, contact_vendor, ' +
          'charge, cost, is_successful, trace_steps, tracerfy_job_id'
      )
      .eq('trace_job_id', job.jobId)
    if (rowError) throw new Error(`trace_history read failed for ${job.jobId}: ${rowError.message}`)
    for (const row of rows ?? []) {
      const steps = Array.isArray(row.trace_steps)
        ? (row.trace_steps as { kind?: string; outcome?: string }[])
            .map((s) => `${s.kind}:${s.outcome}`)
            .join(' -> ')
        : 'none'
      console.log(
        `  row ${row.id}: tier1 ${row.ai_research_status ?? 'null'} | tier2 ${row.property_trace_status ?? 'null'} | ` +
          `outcome ${row.outcome_code ?? 'null'} | found_by ${row.found_by ?? 'null'} | ` +
          `vendor ${row.contact_vendor ?? 'null'} | charge ${row.charge} | cost ${row.cost} | ` +
          `source ${row.source} | apn ${row.parcel_id_local ? 'set' : 'null'} | steps ${steps}`
      )
    }

    // D36: the stored hash must equal traceKeyFor of what was SUBMITTED, for every record.
    for (const rid of job.recordIds) {
      const rec = records.find((r) => r.id === rid)
      if (!rec) continue
      // traceKeyFor returns the PLAINTEXT normalised key; the column stores
      // createAddressHash(key), a sha256 hex digest. Comparing the key to the digest can never
      // match, so the original form of this check reported "HAS NO stored row" for every record
      // on a system where D36 actually holds. Measured 2026-09-27: 8 of 8 false negatives.
      // Nothing caught it because tsconfig.json excludes tasks/research-scripts, so `tsc --noEmit`
      // never typechecked this file and both values are `string`.
      const expectedKey = traceKeyFor({
        address: rec.row.address || '',
        city: rec.row.city || '',
        state: rec.row.state || '',
        apn: rec.row.apn,
        county: rec.row.county,
      })
      const expected = createAddressHash(expectedKey)
      const match = (rows ?? []).some((r) => r.address_hash === expected)
      console.log(
        `  D36 ${rid}: createAddressHash(traceKeyFor(input)) ` +
          `${match ? 'MATCHES a stored address_hash' : 'HAS NO stored row'}` +
          (match ? '' : ` [expected ${expected.slice(0, 12)}..., key shape ${expectedKey.startsWith('APN|') ? 'APN' : 'address'}]`)
      )
    }
  }

  // Amendment 10: the legacy exposure count. FREE.
  const { count, error: countError } = await admin
    .from('trace_history')
    .select('id', { count: 'exact', head: true })
    .not('trace_job_id', 'is', null)
    .not('outcome_code', 'is', null)
    .or('ai_research_status.is.null,ai_research_status.not.like.tier1_%')
  if (countError) throw new Error(`Amendment 10 count failed: ${countError.message}`)
  console.log(
    `AMENDMENT 10: ${count} trace_history rows have a trace_job_id and a non-null outcome_code with no ` +
      'tier1_ value on ai_research_status. Zero means the exposure was theoretical.'
  )
}

/**
 * KNOWN-ANSWER SELF-CHECK ON THE D36 COMPARISON, RUN BEFORE ANY READ AND BEFORE ANY SPEND.
 *
 * The D36 assertion in readback() shipped comparing `traceKeyFor(input)` -- the PLAINTEXT normalised
 * key -- against the stored `address_hash`, which is a sha256 hex digest. Both sides are `string`,
 * and tsconfig.json excludes tasks/research-scripts, so nothing could have caught it. It reported
 * that invariant BROKEN for all 8 production records on a system where it holds.
 *
 * THE RULE THIS ENCODES: any assertion inside a money-spending runner whose PASS and whose FAIL are
 * both plausible readings needs a fixture that MUST pass and one that MUST fail, run before the
 * first dollar. A check that could only ever print FAIL is not evidence, and by the time anyone
 * reads it the spend that produced it has already happened.
 *
 * Two fixtures, on a hardcoded throwaway address never submitted anywhere:
 *   MUST FAIL   the digest must NOT equal its own input. That IS the broken comparison, so if this
 *               ever passes, key and digest are interchangeable and D36 cannot be read either way.
 *   MUST PASS   the digest must be 64 lowercase hex characters, i.e. really a sha256 hex digest and
 *               really the same shape trace_history.address_hash stores.
 *
 * Throws rather than exiting, so it surfaces through main()'s catch like every other hard stop.
 */
function assertD36ComparesLikeWithLike(): void {
  const probe = '1 SELF CHECK WAY|NOWHERE|ZZ'
  const digest = createAddressHash(probe)
  if (digest === probe) {
    throw new Error(
      'SELF-CHECK FAILED: createAddressHash returned its own input, so the D36 check would be ' +
        'comparing a plaintext key against a stored digest and could never match. Not run.'
    )
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(
      `SELF-CHECK FAILED: createAddressHash produced a ${digest.length}-character value that is ` +
        'not a 64-character lowercase sha256 hex digest, so it is not the shape ' +
        'trace_history.address_hash stores and the D36 check cannot be trusted either way. Not run.'
    )
  }
}

async function main(): Promise<void> {
  // FIRST, ahead of loadRecords(), ahead of --readback's reads and ahead of every refusal: this is
  // the one check whose failure invalidates the EVIDENCE rather than the run, so it has to be
  // settled before a dollar is spent producing evidence nobody can read.
  assertD36ComparesLikeWithLike()
  const records = loadRecords()
  const total = worstCase(records)

  if (process.argv.includes('--readback')) {
    await loadEnvIntoProcess()
    await readback(records)
    return
  }

  if (!process.argv.includes('--live')) {
    printPlan(records, total)
    return
  }

  // REFUSAL 0. A token, not a number, and checked BEFORE the cap so no cap value an agent can
  // invent gets past it (L-031).
  if (process.env.PTP_LIVE_RUN !== '1') {
    console.error(
      'REFUSED: --live needs PTP_LIVE_RUN=1 in the environment. This exists so an agent building or ' +
        'testing this script cannot spend money by passing --live, however the cap is set. Not run.'
    )
    process.exit(2)
  }
  // No cap, no run.
  const maxDollars = Number(arg('max-dollars'))
  if (!Number.isFinite(maxDollars) || maxDollars <= 0) {
    console.error('REFUSED: --max-dollars must be a number greater than 0. Not run.')
    process.exit(2)
  }
  // STRICTLY GREATER, not "exceeds". A cap equal to the worst case is the shape that spent real
  // money on 2026-09-23, because $1.00 does not exceed $1.00.
  if (total >= maxDollars) {
    console.error(
      `REFUSED: worst case $${total.toFixed(2)} is not strictly under the approved $${maxDollars.toFixed(2)}. ` +
        'Leave headroom so the boundary case is not also the live case. Not run.'
    )
    process.exit(2)
  }

  // --only <batch>: submit ONE batch. Applied AFTER loadRecords(), so refusals 1 to 4 still
  // validate the whole records file, and the cap is still checked against the FULL $2.80 worst
  // case above rather than the filtered subset, so filtering can only ever spend less than the
  // approved figure and never loosens the guard. Exists because the run is resumable: batch v1-a
  // submitted, then the MCP batch failed on a Next request-scope dependency, and re-running the
  // whole runner would submit v1-a a second time, whose records would all be dropped as
  // duplicates against their own stored address_hash and would pollute the evidence with a
  // second job row.
  const only = arg('only')
  const allBatches = batchesOf(records)
  if (only && !allBatches.some((b) => b.batch === only)) {
    console.error(`REFUSED: --only ${only} matches no batch. Not run.`)
    process.exit(2)
  }
  const batches = only ? allBatches.filter((b) => b.batch === only) : allBatches
  const apiKey = arg('api-key') || process.env.PTP_API_KEY
  const gatewaySub = arg('gateway-sub') || process.env.PTP_GATEWAY_SUB
  if (batches.some((b) => b.surface === 'v1') && !apiKey) {
    console.error('REFUSED: a v1 batch needs --api-key (a PropTracerPRO API key). Not run.')
    process.exit(2)
  }
  if (batches.some((b) => b.surface === 'mcp') && !gatewaySub) {
    console.error('REFUSED: an MCP batch needs --gateway-sub. Not run.')
    process.exit(2)
  }

  // --no-drain: do not drive the crons at all. Used when BASE is the PRODUCTION deployment, whose
  // own Vercel scheduler already runs both crons every 60 s on the same code. See the lane note in
  // the header. CRON_SECRET is only required when this script drives the crons itself.
  const noDrain = process.argv.includes('--no-drain')
  const env = await loadEnvIntoProcess()
  if (!noDrain && !env.CRON_SECRET) throw new Error('No CRON_SECRET in .env.local. Not run.')

  console.log(`Worst case $${total.toFixed(2)}, under $${maxDollars.toFixed(2)} approved. Submitting.`)
  const submitted: SubmittedJob[] = []
  try {
    for (const b of batches) {
      submitted.push(
        b.surface === 'v1' ? await submitV1(b, apiKey as string) : await submitMcp(b, gatewaySub as string)
      )
    }
  } finally {
    // Written even on a partial failure: a job id that exists and is not recorded is unreadable
    // evidence and an un-drained queue.
    //
    // MERGED, never overwritten. A --only run must not erase a job id an earlier run recorded, or
    // the spend that produced it becomes unreadable. Same batch submitted again replaces its entry;
    // every other batch is kept.
    mkdirSync(OUT_DIR, { recursive: true })
    const prior: SubmittedJob[] = existsSync(JOBS)
      ? (JSON.parse(readFileSync(JOBS, 'utf8')) as SubmittedJob[])
      : []
    const merged = [...prior.filter((p) => !submitted.some((s) => s.batch === p.batch)), ...submitted]
    writeFileSync(JOBS, JSON.stringify(merged, null, 2))
  }
  console.log(`Wrote ${submitted.length} job id(s) to ${JOBS}.`)
  if (noDrain) {
    console.log(
      'NOT driving the crons (--no-drain). Production runs sweep-entity-traces and ' +
        'sweep-property-traces every 60 s on this same deployed commit, so its own scheduler drains ' +
        'both lanes. Nobody drives the crons and nobody opens the status route, which is the ' +
        'strongest available form of the one claim this phase can make. Wait for the queues to go ' +
        'quiet, then run --readback.'
    )
    return
  }
  await drain(env.CRON_SECRET)
}

/** .env.local into process.env, so createAdminClient and mcp-tools see what a server would. */
async function loadEnvIntoProcess(): Promise<Record<string, string>> {
  const env = loadEnvLocal()
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v
  return env
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
