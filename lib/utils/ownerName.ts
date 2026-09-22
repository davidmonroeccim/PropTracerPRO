/**
 * D25: the 90-day cache serves an earlier result only to the SAME owner.
 *
 * Normalised so the same owner written two ways still matches: case, punctuation (periods
 * dropped, so "L.L.C." is "LLC"; other marks become spaces), and, for an INDIVIDUAL name only,
 * the suffixes JR SR II III IV and single letters (middle initials). The ORDER is kept: "SMITH
 * JOHN" and "JOHN SMITH" are different strings on a single trace, as D22 keeps single-trace name
 * order.
 *
 * FIX ROUND 1, D25 money. The suffix and single-letter drops used to run on every name, which
 * merges DISTINCT entities that happen to differ only in a dropped token: "J & J Properties LLC"
 * read as "K & K Properties LLC", "Acme Fund II LLC" as "Acme Fund III LLC", "Oak Partners IV LP"
 * as "Oak Partners LP", "Series A Holdings LLC" as "Series B Holdings LLC". D25 says a different
 * owner runs a new trace; classifyOwnerName decides which names are people (where "John T. Smith
 * Jr" and "John Smith" really are the one owner) before either drop is applied, so an entity, a
 * trust or an unclassifiable name keeps every token intact.
 */
import { classifyOwnerName } from '@/lib/routing/ownerRoute'

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV'])

export function normalizeOwnerName(name?: string | null): string {
  const tokens = (name ?? '')
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)

  // classifyOwnerName reads the ORIGINAL name, not the cleaned tokens: it is case-insensitive on
  // its own and its decision (entity / trust / individual / unknown) does not depend on whether
  // "L.L.C." or "LLC" reached it.
  const isIndividual = classifyOwnerName(name) === 'individual'
  const kept = isIndividual ? tokens.filter((t) => t.length > 1 && !SUFFIXES.has(t)) : tokens

  return kept.join(' ')
}

/** True only when both names normalise to the same non-empty string. */
export function ownerNamesMatch(a?: string | null, b?: string | null): boolean {
  const x = normalizeOwnerName(a)
  return x !== '' && x === normalizeOwnerName(b)
}
