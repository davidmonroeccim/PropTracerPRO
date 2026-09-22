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
    // Fix round 1 (D25 money): the suffix and single-letter drops apply only to an INDIVIDUAL
    // name, or these four pairs of DISTINCT entities read as the same owner.
    ['J & J Properties LLC', 'K & K Properties LLC'],
    ['Acme Fund II LLC', 'Acme Fund III LLC'],
    ['Oak Partners IV LP', 'Oak Partners LP'],
    ['Series A Holdings LLC', 'Series B Holdings LLC'],
  ])('%s is not the same owner as %s', (a, b) => {
    expect(ownerNamesMatch(a, b)).toBe(false)
  })

  it('normalises case, punctuation, suffixes and middle initials, never order', () => {
    expect(normalizeOwnerName('  Smith,  John T. Jr ')).toBe('SMITH JOHN')
  })

  it('treats a mark between two names as a space, not a deletion', () => {
    expect(ownerNamesMatch('SMITH,JOHN', 'SMITH JOHN')).toBe(true)
  })

  it.each(['SR', 'II', 'III', 'IV'])('drops the suffix %s from an individual name', (suffix) => {
    expect(normalizeOwnerName(`John Smith ${suffix}`)).toBe('JOHN SMITH')
  })

  it('keeps every token of an entity name intact, single letters and rung numbers included', () => {
    expect(normalizeOwnerName('Series A Holdings LLC')).toBe('SERIES A HOLDINGS LLC')
    expect(normalizeOwnerName('Acme Fund III LLC')).toBe('ACME FUND III LLC')
  })
})
