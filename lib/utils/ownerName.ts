/**
 * D25: the 90-day cache serves an earlier result only to the SAME owner.
 *
 * `normalizeOwnerName` is a DISPLAY/key form: case, punctuation (periods dropped, so "L.L.C." is
 * "LLC"; other marks become spaces) always normalised, and, for an INDIVIDUAL name only, the
 * suffixes JR SR II III IV and single letters (middle initials) dropped. The ORDER is kept:
 * "SMITH JOHN" and "JOHN SMITH" are different strings, as D22 keeps single-trace name order.
 *
 * `ownerNamesMatch` is the MATCHING rule the cache actually gates on, and fix round 2 found it is
 * NOT simply `normalizeOwnerName(a) === normalizeOwnerName(b)`. Two problems with that:
 *
 *   - classifyOwnerName's own heuristics read some entity-shaped names as 'individual':
 *     INDIVIDUAL_MARKER counts a bare "&", and the token-count fallback (2-4 words, no entity
 *     word) counts "Acme Fund II" and "J & J Farms" as a person's name (FARMS and FUND are not
 *     entity words). Dropping single letters and suffixes on THOSE names merged distinct owners:
 *     "J & J Farms" / "K & K Farms" both became "FARMS"; "Acme Fund II" / "Acme Fund III" both
 *     became "ACME FUND".
 *   - dropping a generational suffix unconditionally is wrong for real people too: "John Smith
 *     Jr" and "John Smith Sr" are different people, often at the same address, and so are
 *     "John A Smith" and "John B Smith".
 *
 * So `ownerNamesMatch` tokenizes both names (no drops) and only lets a token be OPTIONAL --
 * present on one side and absent on the other -- when BOTH names classify as 'individual' AND
 * the token is a generational suffix, or a single letter that is not the FIRST token (a
 * first-token single letter, "J & J Farms", is never optional: it is part of the name). Even
 * then, when BOTH sides carry one of these optional tokens, they must be equal to each other,
 * not merely both droppable: "John Smith Jr" != "John Smith Sr", "John A Smith" != "John B
 * Smith". Anything not classified 'individual' on BOTH sides matches only on the full,
 * unmodified token list -- no drop is safe when classifyOwnerName cannot be trusted to tell two
 * such owners apart.
 */
import { classifyOwnerName } from '@/lib/routing/ownerRoute'

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV'])

/** Upper case, periods dropped, every other mark a space, collapsed to non-empty tokens. */
function cleanTokens(name?: string | null): string[] {
  return (name ?? '')
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

export function normalizeOwnerName(name?: string | null): string {
  const tokens = cleanTokens(name)
  // classifyOwnerName reads the ORIGINAL name, not the cleaned tokens: it is case-insensitive on
  // its own and its decision (entity / trust / individual / unknown) does not depend on whether
  // "L.L.C." or "LLC" reached it.
  const isIndividual = classifyOwnerName(name) === 'individual'
  const kept = isIndividual ? tokens.filter((t) => t.length > 1 && !SUFFIXES.has(t)) : tokens
  return kept.join(' ')
}

/** A token an individual match MAY drop when the other side lacks it: a generational suffix, or
 *  a single letter past the first token. The first token is never optional. */
const isOptionalForIndividual = (token: string, index: number): boolean =>
  SUFFIXES.has(token) || (token.length === 1 && index !== 0)

/** The tokens that must appear, in order, for two individual names to be the same owner. */
const coreTokens = (tokens: string[]): string[] =>
  tokens.filter((t, i) => !isOptionalForIndividual(t, i))

const sameTokens = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((t, i) => t === b[i])

/** True only when both names describe the same owner (D25). */
export function ownerNamesMatch(a?: string | null, b?: string | null): boolean {
  const tokensA = cleanTokens(a)
  const tokensB = cleanTokens(b)
  if (tokensA.length === 0 || tokensB.length === 0) return false

  const bothIndividual =
    classifyOwnerName(a) === 'individual' && classifyOwnerName(b) === 'individual'

  // Not an individual on both sides: no drop is safe, so match on the full token list only.
  if (!bothIndividual) return sameTokens(tokensA, tokensB)

  const coreA = coreTokens(tokensA)
  const coreB = coreTokens(tokensB)
  if (coreA.length === 0 || coreB.length === 0 || !sameTokens(coreA, coreB)) return false

  // (b) A generational suffix present on BOTH sides must be the same suffix.
  const suffixA = tokensA.find((t) => SUFFIXES.has(t))
  const suffixB = tokensB.find((t) => SUFFIXES.has(t))
  if (suffixA && suffixB && suffixA !== suffixB) return false

  // (c) A single letter (a middle initial) present on BOTH sides at the same place must be the
  // same letter. Starts at index 1: the first token is never optional, so an index-0 mismatch is
  // already caught by the core comparison above and does not belong to this "optional" check.
  const shorter = Math.min(tokensA.length, tokensB.length)
  for (let i = 1; i < shorter; i++) {
    if (tokensA[i].length === 1 && tokensB[i].length === 1 && tokensA[i] !== tokensB[i]) {
      return false
    }
  }

  return true
}
