/**
 * Tier 1 Phase 1 check (spec 11, lessons L-008): run the dossier parser over every saved dossier
 * response in tasks/research-test/ and print COUNTS ONLY.
 *
 * HISTORY. This file was originally check-dossier-contacts.ts (Task 6), built to check the
 * contacts block the dossier parser briefly surfaced for spec D21 (b). Spec D32 (2026-09-22)
 * withdrew that arm entirely: the dossier's own contacts are never used, in any phase; phones and
 * emails come only from the separate Tracerfy (individual) or FastAppend (entity) call. This file
 * kept the other half of what it checked -- that parseDossierResponse's hit/miss and owners
 * parsing hold up against every real saved payload -- and dropped everything about the contacts
 * block along with the file's old name.
 *
 * Purchased PII: this script never prints a name, phone, email, address or parcel id, writes
 * nothing, and is not a test. Its output is not saved or committed.
 *
 *   npx tsx tasks/research-scripts/phase1/check-dossier-parse.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// House pattern: no database key in a process that imports lib/ code. No database is needed.
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const RT = join(process.cwd(), 'tasks/research-test')

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

async function main(): Promise<void> {
  const { parseDossierResponse } = await import('../../../lib/tracerfy/dossier')
  const { classifyOwnerName } = await import('../../../lib/routing/ownerRoute')

  const bodies: Array<{ source: string; body: unknown }> = []
  for (const dir of ['dossier', 'address-mode']) {
    const d = join(RT, dir)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d).filter((n) => n.startsWith('raw-'))) {
      bodies.push({ source: dir, body: rec(readJson(join(d, f))).response })
    }
  }
  const ohio = join(RT, 'ohio')
  if (existsSync(ohio)) {
    for (const f of readdirSync(ohio).filter((n) => n.startsWith('dossier-'))) {
      bodies.push({ source: 'ohio', body: readJson(join(ohio, f)) })
    }
  }
  const p0 = join(RT, 'phase0/small-calls.jsonl')
  if (existsSync(p0)) {
    for (const line of readFileSync(p0, 'utf8').split('\n').filter(Boolean)) {
      const o = rec(JSON.parse(line))
      for (const x of Array.isArray(o.raw) ? o.raw : []) {
        const r = rec(x)
        if (String(r.path ?? '').includes('/property-search/lookup/')) {
          bodies.push({ source: `phase0:${String(o.slot)}`, body: r.response_body })
        }
      }
    }
  }

  const count: Record<string, number> = {}
  const add = (k: string, n = 1): void => {
    count[k] = (count[k] ?? 0) + n
  }

  for (const b of bodies) {
    add(`responses_${b.source.split(':')[0]}`)
    const res = parseDossierResponse(b.body)
    if (!res.success) {
      add('parse_failures')
      continue
    }
    if (!res.hit) {
      add('misses')
      continue
    }
    add('hits')
    const joined = res.owners
      .map((o) => [o.first_name, o.last_name].map((v) => v.trim()).filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' | ')
    const type = classifyOwnerName(joined)
    add(`owner_type_${type}`)
    if (b.source.startsWith('phase0:')) {
      console.log(`${b.source}: hit, owner_type ${type}`)
    }
  }

  console.log(JSON.stringify(count, null, 2))
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
