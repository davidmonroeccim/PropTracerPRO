import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bulkRowExclusion, foundByLabel, isParcelKey, propertyAddressLabel } from '@/lib/trace/historyDisplay'

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

describe('propertyAddressLabel: the internal parcel key is never shown as an address (D38)', () => {
  const PARCEL_ROW = {
    normalized_address: 'APN|0123-456|TRAVIS|TX',
    parcel_id_local: '0123-456',
    county: 'Travis',
  }

  it('reads a street-keyed row back exactly as it is stored', () => {
    expect(propertyAddressLabel({ normalized_address: '100 MAIN ST|AUSTIN|TX' })).toBe('100 MAIN ST|AUSTIN|TX')
  })

  it('says the parcel and its county instead of the key', () => {
    // MUTATION: return row.normalized_address unconditionally and this goes red.
    expect(propertyAddressLabel(PARCEL_ROW)).toBe('Parcel 0123-456, Travis County')
  })

  it('prefers the row\'s own columns, which hold the parcel and county as the caller sent them', () => {
    // MUTATION: read the parcel and county from the key first and this goes red: the key
    // uppercases both (traceKeyFor), so the customer would be shown TRAVIS, not Travis.
    expect(propertyAddressLabel({ ...PARCEL_ROW, parcel_id_local: '#0123-456' })).toBe(
      'Parcel #0123-456, Travis County'
    )
  })

  it('falls back to the key itself when a column is absent, which is parsing, not inventing', () => {
    // MUTATION: drop the `|| text(parts[n])` fallbacks and this goes red (the county disappears).
    expect(propertyAddressLabel({ normalized_address: 'APN|0123-456|TRAVIS|TX' })).toBe(
      'Parcel 0123-456, TRAVIS County'
    )
  })

  it('does not say County twice when the stored value already ends in it', () => {
    // MUTATION: append " County" unconditionally and this goes red.
    expect(propertyAddressLabel({ ...PARCEL_ROW, county: 'Travis County' })).toBe(
      'Parcel 0123-456, Travis County'
    )
  })

  it('names only the parcel when no county is recorded anywhere, and never guesses one', () => {
    expect(propertyAddressLabel({ normalized_address: 'APN|0123-456||TX' })).toBe('Parcel 0123-456')
  })

  it('says nothing rather than something wrong for an empty key', () => {
    expect(propertyAddressLabel({ normalized_address: '' })).toBeNull()
    expect(propertyAddressLabel({ normalized_address: null })).toBeNull()
  })

  it('knows a parcel key from a street key', () => {
    expect(isParcelKey('APN|0123-456|TRAVIS|TX')).toBe(true)
    expect(isParcelKey('100 MAIN ST|AUSTIN|TX')).toBe(false)
    expect(isParcelKey(null)).toBe(false)
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

  it.each(['app/(dashboard)/history/page.tsx', 'app/(dashboard)/dashboard/page.tsx'])(
    '%s shows the parcel label, never the raw key (D38)',
    (path) => {
      // MUTATION: put `{trace.normalized_address}` back in the page and this goes red.
      const src = read(path)
      expect(src).toContain('propertyAddressLabel(trace)')
      expect(src).not.toContain('{trace.normalized_address}')
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
