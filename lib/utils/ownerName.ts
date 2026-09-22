/**
 * D25: the 90-day cache serves an earlier result only to the SAME owner.
 *
 * Normalised so the same owner written two ways still matches: case, punctuation (periods
 * dropped, so "L.L.C." is "LLC"; other marks become spaces), the suffixes JR SR II III IV, and
 * single letters (middle initials). The ORDER is kept: "SMITH JOHN" and "JOHN SMITH" are different
 * strings on a single trace, as D22 keeps single-trace name order.
 */
const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV'])

export function normalizeOwnerName(name?: string | null): string {
  return (name ?? '')
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !SUFFIXES.has(t))
    .join(' ')
}

/** True only when both names normalise to the same non-empty string. */
export function ownerNamesMatch(a?: string | null, b?: string | null): boolean {
  const x = normalizeOwnerName(a)
  return x !== '' && x === normalizeOwnerName(b)
}
