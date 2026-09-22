/**
 * Every Tier 1 record ends with one outcome code, one sentence, and the key that found the owner
 * (spec 7.1, D10). Pure: no I/O. The codes live in trace_history.outcome_code; the sentences are
 * rebuilt from the row whenever a surface shows one, so the copy has exactly one source.
 *
 * COPY RULES (spec 7.3), enforced in lib/trace/__tests__/tier1Outcome.test.ts: every sentence
 * states the charge; no price, dollar sign, dash or emoji; resend advice only on busy_try_again
 * and no_lookup_key. A sentence never says a parcel ID was "not recognized": Tracerfy answers an
 * unknown parcel id with an ordinary hit:false (Phase 0, t1_nothing_found).
 */
import { stepLogFrom, type ExecutionResult, type StepReport } from '@/lib/routing/executeRoute'
import type { StepKind } from '@/lib/routing/ownerRoute'

export const TIER1_OUTCOME = {
  FOUND_BY_ADDRESS: 'found_by_address',
  FOUND_BY_PARCEL_ID: 'found_by_parcel_id',
  FOUND_BY_COMPANY_NAME: 'found_by_company_name',
  NO_MATCH: 'no_match',
  OWNER_NAME_NOT_MATCHED: 'owner_name_not_matched',
  NO_LOOKUP_KEY: 'no_lookup_key',
  BUSY_TRY_AGAIN: 'busy_try_again',
} as const

export type Tier1OutcomeCode = (typeof TIER1_OUTCOME)[keyof typeof TIER1_OUTCOME]

/** The KEY that found the owner. Never the vendor, which stays in contact_vendor. */
export type FoundBy = 'address' | 'parcel_id' | 'company_name'

const FOUND_BY_STEP: Partial<Record<StepKind, FoundBy>> = {
  TRACERFY_INSTANT_NAMED: 'address',
  TRACERFY_PARCEL_APN: 'parcel_id',
  FASTAPPEND_ENTITY: 'company_name',
}

const FOUND_BY_OUTCOME: Record<FoundBy, Tier1OutcomeCode> = {
  address: TIER1_OUTCOME.FOUND_BY_ADDRESS,
  parcel_id: TIER1_OUTCOME.FOUND_BY_PARCEL_ID,
  company_name: TIER1_OUTCOME.FOUND_BY_COMPANY_NAME,
}

const KEY_WORDS: Record<FoundBy, string> = {
  address: 'address',
  parcel_id: 'parcel ID',
  company_name: 'company name',
}

/** A step the vendor actually answered. A skipped or failed step never was. */
const answered = (s: StepReport): boolean =>
  s.outcome === 'hit' || s.outcome === 'miss' || s.outcome === 'name_not_matched'

/** The one outcome for a Tier 1 execution, in precedence order. */
export function tier1OutcomeFor(execution: ExecutionResult): { outcome: Tier1OutcomeCode; foundBy: FoundBy | null } {
  const steps = execution.steps
  // D7: any vendor failure ends the record busy_try_again, whatever answered before it.
  if (steps.some(s => s.outcome === 'failed')) return { outcome: TIER1_OUTCOME.BUSY_TRY_AGAIN, foundBy: null }
  if (execution.contactsFound) {
    const delivering = steps.find(s => s.outcome === 'hit' && !s.noContacts)
    const foundBy = delivering ? FOUND_BY_STEP[delivering.kind] ?? null : null
    if (foundBy) return { outcome: FOUND_BY_OUTCOME[foundBy], foundBy }
  }
  // D27, D31 (3): a step that matched the owner but carried no phone or email means the owner WAS
  // matched, so "none matched the owner name" would be false. It ends no_match.
  if (steps.some(s => s.outcome === 'hit')) return { outcome: TIER1_OUTCOME.NO_MATCH, foundBy: null }
  if (steps.some(s => s.outcome === 'name_not_matched')) {
    return { outcome: TIER1_OUTCOME.OWNER_NAME_NOT_MATCHED, foundBy: null }
  }
  if (steps.some(answered)) return { outcome: TIER1_OUTCOME.NO_MATCH, foundBy: null }
  return { outcome: TIER1_OUTCOME.NO_LOOKUP_KEY, foundBy: null }
}

export const BUSY_TRY_AGAIN_REASON = 'The system is busy. Try again in 5 minutes. You were not charged.'

export const OWNER_NAME_NOT_MATCHED_REASON =
  'We found people linked to this property, but none matched the owner name, so no contacts were returned. You were not charged.'

const joinKeys = (keys: string[]): string =>
  keys.length <= 2 ? keys.join(' and ') : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`

/** "We looked this owner up by ..." naming only the keys that answered, or null when none did. */
export function noMatchReason(steps: StepReport[]): string | null {
  const keys: string[] = []
  for (const s of steps) {
    if (!answered(s)) continue
    const key = FOUND_BY_STEP[s.kind]
    if (key && !keys.includes(KEY_WORDS[key])) keys.push(KEY_WORDS[key])
  }
  if (!keys.length) return null
  return `We looked this owner up by ${joinKeys(keys)} and found no match. You were not charged.`
}

export type MissingLookupKey = 'city_and_parcel' | 'state' | 'street_and_parcel'

const MISSING_WORDS: Record<MissingLookupKey, { missing: string; resend: string }> = {
  city_and_parcel: { missing: 'the city and the parcel ID', resend: 'the city or the parcel ID' },
  state: { missing: 'a valid state', resend: 'a valid two-letter state' },
  street_and_parcel: { missing: 'a street address and the parcel ID', resend: 'the street address or the parcel ID' },
}

export function noLookupKeyReason(missing: MissingLookupKey): string {
  const w = MISSING_WORDS[missing]
  return `This record is missing ${w.missing}, so it could not be looked up. You were not charged. Send it again with ${w.resend}.`
}

/**
 * What a person, trust or unknown owner's record lacks to be looked up, or null when it has a key.
 * A parcel id counts only with its county. A company never needs this: it needs only a state.
 */
export function missingLookupKey(input: {
  address?: string | null
  city?: string | null
  state?: string | null
  apn?: string | null
  county?: string | null
}): MissingLookupKey | null {
  const has = (v?: string | null): boolean => typeof v === 'string' && v.trim() !== ''
  if (!/^[A-Za-z]{2}$/.test((input.state ?? '').trim())) return 'state'
  if (has(input.apn) && has(input.county)) return null
  if (!has(input.city)) return 'city_and_parcel'
  if (!has(input.address)) return 'street_and_parcel'
  return null
}

/** The sentence for an outcome, or null when there is nothing to explain. */
export function outcomeSentence(
  outcome: Tier1OutcomeCode,
  steps: StepReport[],
  missing: MissingLookupKey | null,
): string | null {
  switch (outcome) {
    case TIER1_OUTCOME.BUSY_TRY_AGAIN:
      return BUSY_TRY_AGAIN_REASON
    case TIER1_OUTCOME.OWNER_NAME_NOT_MATCHED:
      return OWNER_NAME_NOT_MATCHED_REASON
    case TIER1_OUTCOME.NO_MATCH:
      return noMatchReason(steps)
    case TIER1_OUTCOME.NO_LOOKUP_KEY:
      return missing ? noLookupKeyReason(missing) : null
    default:
      // found_by_*: the contacts are shown, there is nothing to explain.
      return null
  }
}

/** The columns tier1OutcomeReason reads. Structural and optional, like SkipReasonRow. */
export interface Tier1OutcomeRow {
  outcome_code?: string | null
  trace_steps?: unknown
  is_successful?: boolean | null
  normalized_address?: string | null
  city?: string | null
  state?: string | null
  parcel_id_local?: string | null
  county?: string | null
}

/** The street part of a stored duplicate key, or '' for a parcel-keyed row ("APN|..."). */
const streetOf = (normalized?: string | null): string =>
  !normalized || normalized.startsWith('APN|') ? '' : normalized.split('|')[0] ?? ''

/** Why a stored Tier 1 row came back with no contacts, or null. Nothing invented (CLAUDE.md rule 7). */
export function tier1OutcomeReason(row: Tier1OutcomeRow): string | null {
  if (row.is_successful === true || !row.outcome_code) return null
  const outcome = Object.values(TIER1_OUTCOME).find(c => c === row.outcome_code)
  if (!outcome) return null
  const missing =
    outcome === TIER1_OUTCOME.NO_LOOKUP_KEY
      ? missingLookupKey({
          address: streetOf(row.normalized_address),
          city: row.city,
          state: row.state,
          apn: row.parcel_id_local,
          county: row.county,
        })
      : null
  // The log is JSONB, so it is read through the validating reader, never cast.
  return outcomeSentence(outcome, stepLogFrom(row.trace_steps), missing)
}
