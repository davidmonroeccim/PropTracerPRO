/**
 * Phase 0 prototype of the Tier 1 name match (spec 4.3). Throwaway: Phase 1 ports the rule into
 * lib/tracerfy/client.ts with its own tests. Pure, no I/O.
 */
import { splitPersonName } from '../../../lib/routing/ownerRoute'

const TRUST_WORDS = new Set([
  'TRUST', 'TRUSTS', 'REVOCABLE', 'IRREVOCABLE', 'LIVING', 'FAMILY', 'TRUSTEE', 'TRUSTEES',
  'TTEE', 'TTEES', 'TR', 'TRS', 'UA', 'UAD', 'DTD', 'DATED', 'THE', 'OF', 'AGREEMENT',
])
// A month only when a date number follows it. A bare prefix match would eat surnames:
// MARTIN, MAYFIELD, DECKER, and a whole-word match would eat the surname MAY.
const MONTHS = /\b(JAN(UARY)?|FEB(RUARY)?|MAR(CH)?|APR(IL)?|MAY|JUNE?|JULY?|AUG(UST)?|SEPT?(EMBER)?|OCT(OBER)?|NOV(EMBER)?|DEC(EMBER)?)\.?\s+(?=\d)/g

/** "John Smith Revocable Trust" -> "JOHN SMITH"; "Smith Family Trust" -> "SMITH". */
export function stripTrustWords(name: string): string {
  return name
    .toUpperCase()
    .replace(/U\s*\/\s*A/g, ' ')
    .replace(MONTHS, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^A-Z&\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !TRUST_WORDS.has(t))
    .join(' ')
    .trim()
}

const norm = (v: unknown): string =>
  (typeof v === 'string' ? v : '').toUpperCase().replace(/[^A-Z]/g, '')

export type MatchKind = 'natural' | 'swapped' | 'surname_only' | null

/**
 * Is this vendor person the owner? Same rule the production parser uses today (last name exact,
 * first initial) plus two things Phase 0 must measure: the SWAPPED order (assessor "LAST FIRST"
 * with no middle initial, which splitPersonName reads backwards) and SURNAME ONLY (a trust that
 * strips to one token). Never falls back to persons[0].
 */
export function personMatchesOwner(
  person: { first_name?: unknown; last_name?: unknown },
  ownerName: string,
): MatchKind {
  const pFirst = norm(person.first_name)
  const pLast = norm(person.last_name)
  if (!pLast) return null
  const { first_name, last_name } = splitPersonName(ownerName)
  const oFirst = norm(first_name)
  const oLast = norm(last_name)
  if (!oLast) return oFirst && pLast === oFirst ? 'surname_only' : null
  if (pLast === oLast && (!oFirst || pFirst.startsWith(oFirst.charAt(0)))) return 'natural'
  if (pLast === oFirst && pFirst.startsWith(oLast.charAt(0))) return 'swapped'
  return null
}
