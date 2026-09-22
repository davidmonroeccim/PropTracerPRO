import { describe, expect, it } from 'vitest'
import { normalizeOwnerName, ownerNamesMatch } from '@/lib/utils/ownerName'

describe('ownerNamesMatch (D25)', () => {
  it.each([
    ['ACME HOLDINGS LLC', 'Acme Holdings, L.L.C.'],
    ['John T. Smith', 'JOHN SMITH'],
    ['John Smith Jr', 'john smith'],
  ])('%s is the same owner as %s', (a, b) => {
    expect(ownerNamesMatch(a, b)).toBe(true)
  })

  it.each([
    ['John Smith', 'Jane Smith'],
    ['SMITH JOHN', 'JOHN SMITH'],
    ['Acme Holdings LLC', null],
    [null, null],
  ])('%s is not the same owner as %s', (a, b) => {
    expect(ownerNamesMatch(a, b)).toBe(false)
  })

  it('normalises case, punctuation, suffixes and middle initials, never order', () => {
    expect(normalizeOwnerName('  Smith,  John T. Jr ')).toBe('SMITH JOHN')
  })
})
