/**
 * Full Property Trace (tier 2): the pure glue between the route executor and
 * the two trace_history columns that hold its output.
 *
 * No I/O, no billing, no database. Billing lives in the route, which is the
 * only layer that knows whether the money actually moved; this module only
 * shapes what that route reads and writes.
 *
 * WHAT TIER 2 IS. The owner of record was not supplied, or the caller asked
 * for the property record. We buy the county dossier, read the owner off it,
 * and then buy contacts for that owner. Billed per RECORD SUBMITTED at
 * $0.25 (Pro / AcquisitionPRO) or $0.40 (Pay-As-You-Go), which means a total
 * miss is billed too: the customer can receive nothing and still be charged.
 */
import type { ExecutionResult } from '@/lib/routing/executeRoute'
import type { ParcelInput } from '@/lib/routing/ownerRoute'
import type { TraceResult } from '@/types'

/** What a single-trace entry point has: an address, and on the API sometimes only a parcel id. */
export interface TraceAddressInput {
  address?: string | null
  city?: string | null
  state: string
  zip?: string | null
}

/** The wallet ledger line. One string, so the transaction list reads consistently. */
export const FULL_PROPERTY_TRACE_DESCRIPTION = 'Full Property Trace - per record submitted'

/**
 * WHAT WE TELL A CUSTOMER WHEN NOTHING WAS COLLECTED, and why there are two
 * sentences rather than one.
 *
 * Both routes used to say the first one for both outcomes, because the wallet
 * helper answered 0 for a short balance AND for an RPC that never ran. A
 * customer with a full wallet was told they were short, which is a false
 * statement about their money and blames them for our failure.
 *
 * Neither sentence quotes a rate. Four prices exist and each caller has exactly
 * one of them; naming a number here would name the wrong one for somebody.
 */
export const WALLET_SHORT_WARNING =
  'The wallet did not cover this record, so nothing was charged for it.'

export const WALLET_NOT_COLLECTED_WARNING =
  'We could not charge your wallet for this record because of an error on our side, so nothing was taken from your balance. The record is yours to keep.'

/**
 * Should this request run tier 2?
 *
 * TWO triggers, and they are NOT the same thing:
 *   - the owner of record is absent, so we cannot route contacts without buying it
 *   - the caller HAS the owner and wants the property record anyway (opt-in)
 *
 * The opt-in flag is deliberately its own flag and was never `ai_research`. AI
 * Search was removed on 2026-09-17; overloading its flag would have coupled a
 * feature that is shipping to one that was being deleted. Nothing reads
 * `ai_research` off a request body any more, so do not fold the two.
 */
export function isFullPropertyTrace(input: {
  owner_name?: string | null
  full_property_trace?: unknown
}): boolean {
  if (input.full_property_trace === true) return true
  return !input.owner_name?.trim()
}

/**
 * The parcel planRoute() plans from.
 *
 * `ownerName` is deliberately null even when the caller supplied one. Tier 2 is
 * dossier-first by definition: on the opt-in path the customer is paying for
 * the county record, and planRoute with an owner name present returns a tier 1
 * plan with no dossier step at all. The supplied name is still stored on the
 * row as `input_owner_name`; it is the ROUTE that must not short-circuit.
 *
 * A caller CAN now supply `apn` and `county`: the Suite Gateway holds a county
 * parcel id from the property registry and passes it through here. Address
 * mode remains the proven key (it returned the owner the county recorder
 * confirms on a parcel where APN mode missed) and still fires whenever a
 * situs exists; the parcel id is a second, independent attempt, not a
 * replacement.
 */
export function parcelForFullTrace(
  input: TraceAddressInput & { apn?: string | null; county?: string | null },
): ParcelInput {
  const state = input.state.trim().toUpperCase()
  return {
    state,
    situsAddress: (input.address ?? '').trim(),
    situsCity: (input.city ?? '').trim(),
    situsState: state,
    situsZip: input.zip?.trim() || null,
    // THE SECOND DOSSIER KEY, and the first caller that has ever supplied it. hasApn()
    // needs BOTH of these plus `state` above: apn, county and state is a three-part key
    // and a request missing any part is malformed. Blank trims to null rather than to ''
    // because an empty apn would make hasApn() true and spend an attempt on a request the
    // vendor answers with a free, silent miss (CLAUDE.md rule 7).
    parcelIdLocal: input.apn?.trim() || null,
    county: input.county?.trim() || null,
    ownerName: null,
  }
}

/** Tracerfy and FastAppend both emit free-text phone types; TraceResult has a union. */
function phoneType(raw: string): TraceResult['phones'][number]['type'] {
  const t = raw.toLowerCase()
  return t === 'mobile' || t === 'landline' || t === 'voip' ? t : 'unknown'
}

/**
 * Shape an execution into the `trace_result` column.
 *
 * CONTACTS GO WHERE TIER 1 ALREADY PUTS THEM. Every downstream reader -- the
 * results card, the CSV export, the HighLevel push, resolveOwnerContact() --
 * reads `trace_result`, so tier 2 writes the same shape rather than a second
 * one nobody reads.
 *
 * TWO NAMES, TWO MEANINGS, and the convention is the one lib/ai-research/
 * contacts.ts already documents:
 *   owner_name    the PERSON we resolved behind the owner. Null for an entity
 *                 with no named principal -- a company name is NEVER a contact
 *                 person.
 *   owner_name_2  the OWNER OF RECORD as the county roll has it, which is what
 *                 the dossier bought. It has nowhere else to live: the 86-key
 *                 property object carries no owner field (the owner arrives in
 *                 `response.owners[]`), and that object is stored RAW, so
 *                 injecting a key into it is not an option.
 *
 * Returns null only when there is genuinely nothing: no contacts and no owner.
 * An owner of record with no contacts is still a real, paid-for answer and is
 * stored with empty phone and email arrays rather than discarded.
 */
export function traceResultFor(execution: ExecutionResult): TraceResult | null {
  const contacts = execution.contacts
  // The OWNER OF RECORD is what a Full Property Trace bought from the county. On a tier 1 trace the
  // owner was SUPPLIED by the caller, and labelling it "the name on the county roll" would be
  // false (spec 7.2), so a tier 1 result carries no owner_name_2 and a tier 1 miss is null.
  const ownerOfRecord = execution.tier === 2 ? execution.ownerName?.trim() || null : null
  if (!contacts && !ownerOfRecord) return null

  const phones = (contacts?.phones ?? []).map((p) => ({
    number: p.number,
    type: phoneType(p.type),
  }))
  const emails = [...(contacts?.emails ?? [])]

  // The contact vendor's mailing address belongs to the PERSON it named, so it
  // wins. The dossier's belongs to the owner of record and is the fallback.
  const mailing = execution.mailingAddress
  const useContactMailing = Boolean(contacts?.mailingAddress)

  return {
    owner_name: contacts?.ownerName?.trim() || null,
    owner_name_2: ownerOfRecord,
    phones,
    emails,
    mailing_address: useContactMailing ? contacts!.mailingAddress : mailing?.address || null,
    mailing_city: useContactMailing ? null : mailing?.city || null,
    mailing_state: useContactMailing ? null : mailing?.state || null,
    mailing_zip: useContactMailing ? null : mailing?.zip || null,
    // Same convention as parseTracerfyResult: contacts present or nothing.
    match_confidence: phones.length > 0 || emails.length > 0 ? 80 : 0,
  }
}

/** True when the customer received contact data. The tier 1 definition, unchanged. */
export function hasContactData(result: TraceResult | null): boolean {
  if (!result) return false
  return (result.phones?.length || 0) > 0 || (result.emails?.length || 0) > 0
}
