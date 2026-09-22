import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bulkRowExclusion, foundByLabel } from '@/lib/trace/historyDisplay'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('bulkRowExclusion: single traces stay visible for a user who has run a bulk job', () => {
  it('keeps a row whose tracerfy_job_id is NULL, which every inline single trace is', () => {
    // SQL: NOT (col IN (...)) is NULL, so false, on a NULL column. Without the is.null arm the old
    // filter hid every inline single trace from anyone with a bulk job (research 10.2, item 11).
    // MUTATION: drop the `tracerfy_job_id.is.null,` arm and this goes red.
    expect(bulkRowExclusion(['j1', 'j2'])).toBe('tracerfy_job_id.is.null,tracerfy_job_id.not.in.(j1,j2)')
  })

  it('adds nothing when the user has no bulk jobs', () => {
    expect(bulkRowExclusion([])).toBeNull()
  })
})

describe('foundByLabel: the key, never the vendor', () => {
  it.each([
    ['address', 'Address'],
    ['parcel_id', 'Parcel ID'],
    ['company_name', 'Company name'],
  ])('%s reads %s', (value, label) => {
    expect(foundByLabel(value)).toBe(label)
  })

  it('says nothing for a row with no key, or a value it does not know', () => {
    expect(foundByLabel(null)).toBeNull()
    expect(foundByLabel('tracerfy')).toBeNull()
  })
})

describe('the pages use them (source scan, like rowSkipReason.test.ts)', () => {
  it.each(['app/(dashboard)/history/page.tsx', 'app/(dashboard)/dashboard/page.tsx'])(
    '%s keeps single traces visible and keeps bulk rows out',
    (path) => {
      const src = read(path)
      expect(src).toContain('bulkRowExclusion(')
      expect(src).toContain(".is('trace_job_id', null)")
      expect(src).not.toMatch(/\.not\(\s*'tracerfy_job_id'/)
    }
  )

  it('History shows a Found by column and the reason on rows that found nothing', () => {
    const src = read('app/(dashboard)/history/page.tsx')
    expect(src).toContain('Found by')
    expect(src).toContain('foundByLabel(')
    expect(src).toContain('rowSkipReason(')
  })

  it('the single-trace page no longer polls, and hands the card the new fields', () => {
    const src = read('app/(dashboard)/trace/single/page.tsx')
    expect(src).not.toContain('/api/trace/status')
    expect(src).toContain('skipReason={')
    expect(src).toContain('foundBy={')
  })
})
