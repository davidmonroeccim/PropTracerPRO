/**
 * Tracerfy property dossier — POST /v1/api/property-search/lookup/
 *
 * The county property file behind Full Property Trace. Synchronous JSON POST, unlike the
 * batch trace endpoints in ./client.ts: one request in, one parsed record out, no queue,
 * no polling.
 *
 * COST: 10 credits, $0.20, per HIT. A miss is FREE. Measured against the account ledger
 * on 2026-09-16, not documentation: 23 of 24 commercial parcels returned an owner.
 *
 * RATE LIMIT: 500 lookups/minute, and it is a SHARED counter with Instant Trace, Enhanced
 * Trace, Phone Verification and APN Instant Lookup. A bulk run that spends two dossier
 * calls per parcel consumes two units of that shared pool per parcel, not one. No throttling
 * is implemented here on purpose; budgeting belongs to the bulk caller, which is the only
 * layer that knows how many records are in flight.
 *
 * TWO KEY MODES, MUTUALLY EXCLUSIVE. Sending both is a 400.
 *   apn      { apn, county, state }                 county is BARE: "Stark", never "Stark County"
 *   address  { address, city, state, zip_code? }    also backfills the zip we did not have
 *
 * They fail INDEPENDENTLY. Salt Lake 16183060290000 missed on APN and hit on address;
 * Napa 003330004000 did the reverse. This client does ONE lookup per call. Sequencing the
 * two keys and stopping at the first hit is the CALLER's job, not this module's, because
 * only the caller knows whether the first hit has already been paid for.
 *
 * House pattern, same as ./client.ts: never throws, returns { success: false, error } on
 * every failure path, and does NOT retry. Retry is emergent elsewhere in this codebase and
 * a retry here would silently double a real charge.
 */
import { TRACERFY } from '@/lib/constants'
import {
  callTimeoutMs,
  fetchTextWithTimeout,
  VendorTimeoutError,
  type VendorCallOptions,
} from './fetchWithTimeout'
import type { OwnerContacts } from '@/lib/routing/executeRoute'
import { readEmails, readPhones } from './client'

/** A dossier lookup key. The two modes are mutually exclusive by construction. */
export type DossierKey =
  | { mode: 'apn'; apn: string; county: string; state: string }
  | { mode: 'address'; address: string; city: string; state: string; zip_code?: string }

/**
 * One owner of record as the vendor returns it.
 *
 * `property` carries NO owner field. The owner is here and only here.
 *
 * An ENTITY arrives with the WHOLE name in last_name and an empty first_name:
 *   { first_name: '', last_name: 'Colmaven, Llc', age: '' }
 * An individual has both populated. Some parcels return TWO owners, typically a natural
 * person alongside their trust.
 *
 * Owner TYPE is deliberately not decided here. classifyOwnerName() in lib/routing/ownerRoute.ts
 * owns that, from the name string — never from the vendor's own `corporate_owned` boolean,
 * which returned false for a Delaware limited partnership.
 */
export interface DossierOwner {
  first_name: string
  last_name: string
  age: string
}

export interface DossierMailingAddress {
  address: string
  city: string
  state: string
  zip: string
}

/**
 * The property record, RAW AND COMPLETE: all 86 keys exactly as the vendor sent them.
 *
 * DATA FIDELITY RULE, David 2026-09-17, not optional. Do not filter, rename, subset or
 * normalize this object. Downstream decides what to display and what to export, and the
 * fields blocked from DISPLAY are not blocked from storage. A key that is empty in OH, CA
 * and UT may be populated in another county, and keeping it costs nothing because the
 * $0.20 was already spent to fetch it. The raw dump IS the product.
 *
 * Typed loosely on purpose: a narrower interface would invite exactly the field-pruning
 * this rule forbids, and would drop any key the vendor adds later.
 */
export type DossierProperty = Record<string, unknown>

export interface DossierResult {
  /** False on every failure path. A miss is NOT a failure: it is success:true, hit:false. */
  success: boolean
  /** True when the vendor matched a parcel. A hit costs 10 credits; a miss is free. */
  hit: boolean
  owners: DossierOwner[]
  /** All 86 keys, verbatim. Null on a miss or a failure. */
  property: DossierProperty | null
  mailingAddress: DossierMailingAddress | null
  /** 10 on a hit, 0 on a miss. Read it rather than inferring the charge from `hit`. */
  creditsDeducted: number
  /**
   * The dossier's OWN contacts block, which carries no name (spec D21 b). Used only as the last
   * resort after every owner's name-matched lookup missed, and always labelled not name-verified.
   * Null when the block holds no phone and no email. Absent on a miss or a failure.
   */
  contacts?: OwnerContacts | null
  error?: string
}

const ENDPOINT_PATH = 'property-search/lookup/'

/** The shape every failure returns, so callers never have to null-check the happy fields. */
const failure = (error: string): DossierResult => ({
  success: false,
  hit: false,
  owners: [],
  property: null,
  mailingAddress: null,
  creditsDeducted: 0,
  error,
})

/**
 * Build the request body for ONE key mode.
 *
 * Emits only the declared mode's fields, so a body carrying both keys — an automatic 400 —
 * cannot be constructed even if a caller hands us a contaminated object at runtime.
 */
export function buildDossierRequest(key: DossierKey): Record<string, unknown> {
  if (key.mode === 'address') {
    return {
      address: key.address,
      city: key.city,
      state: key.state,
      // Omitted rather than sent empty. Address mode returned the correct owner without a
      // zip in testing, but a common street name in a large city can mismatch without one.
      ...(key.zip_code?.trim() ? { zip_code: key.zip_code } : {}),
    }
  }
  return { apn: key.apn, county: key.county, state: key.state }
}

/**
 * Reject a key we should not spend on. Returns an error string, or null when the key is good.
 *
 * A contaminated key (fields from both modes) is refused rather than silently stripped:
 * the caller believed it was sending an address, and quietly keying on the APN instead could
 * charge $0.20 for the wrong parcel.
 */
function validateKey(key: DossierKey): string | null {
  const k = key as Record<string, unknown>
  const hasApnFields = Boolean(k.apn || k.county)
  const hasAddressFields = Boolean(k.address || k.city || k.zip_code)

  if (hasApnFields && hasAddressFields) {
    return 'Dossier key carries both an APN and an address. The two modes are mutually exclusive; sending both is a 400.'
  }

  if (key.mode === 'apn') {
    if (!key.apn?.trim() || !key.county?.trim() || !key.state?.trim()) {
      return 'APN mode requires apn, county and state'
    }
    // Cheap guard on the one transform this endpoint is fussy about.
    if (/\bcounty\b/i.test(key.county)) {
      return `County must be a bare name: "${key.county.replace(/\s*county\s*/i, '').trim()}", not "${key.county}"`
    }
    return null
  }

  if (key.mode === 'address') {
    if (!key.address?.trim() || !key.city?.trim() || !key.state?.trim()) {
      return 'Address mode requires address, city and state'
    }
    return null
  }

  return `Unknown dossier key mode: ${String((key as { mode?: unknown }).mode)}`
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * The nameless contacts block. Parsed through the SAME readPhones/readEmails the contact clients
 * in ./client.ts use on their own phones/emails arrays (identical vendor shape: an array of
 * { number, type } objects and an array of { email } objects or bare strings), so the dedupe, the
 * `type` fallback and the TRACERFY.MAX_* caps can never drift between the two call sites.
 */
function dossierContacts(v: unknown): OwnerContacts | null {
  if (!isRecord(v)) return null
  const phones = readPhones(v.phones)
  const emails = readEmails(v.emails)
  if (!phones.length && !emails.length) return null
  return { ownerName: null, phones, emails, mailingAddress: null }
}

/**
 * Parse a dossier response body. Pure, so it is testable without a network.
 *
 * A MISS is a success. The vendor returns { hit: false, credits_deducted: 0 } and echoes the
 * request keys back; there is no property, owners, contacts or skip_trace_hit key at all.
 *
 * `response.contacts` is surfaced as `contacts` only for the D21 (b) fallback in executeRoute: it
 * has no name, so it is never used while a name-matched lookup can still answer.
 */
export function parseDossierResponse(body: unknown): DossierResult {
  if (!isRecord(body)) {
    return failure('Malformed dossier response')
  }

  if (typeof body.hit !== 'boolean') {
    return failure('Dossier response missing hit flag')
  }

  const creditsDeducted = typeof body.credits_deducted === 'number' ? body.credits_deducted : 0

  if (!body.hit) {
    return {
      success: true,
      hit: false,
      owners: [],
      property: null,
      mailingAddress: null,
      creditsDeducted,
    }
  }

  const owners: DossierOwner[] = Array.isArray(body.owners)
    ? body.owners.filter(isRecord).map((o) => ({
        // Entity names live entirely in last_name with first_name empty. Passed through
        // untouched: no trimming, no title casing, no splitting. "Colmaven, Llc" keeps its comma.
        first_name: str(o.first_name),
        last_name: str(o.last_name),
        age: str(o.age),
      }))
    : []

  // RAW AND COMPLETE. Handed through by reference to the same object the JSON parse produced.
  const property = isRecord(body.property) ? (body.property as DossierProperty) : null

  const mailingAddress = isRecord(body.mailing_address)
    ? {
        address: str(body.mailing_address.address),
        city: str(body.mailing_address.city),
        state: str(body.mailing_address.state),
        zip: str(body.mailing_address.zip),
      }
    : null

  return {
    success: true, hit: true, owners, property, mailingAddress, creditsDeducted,
    contacts: dossierContacts(body.contacts),
  }
}

/**
 * Run ONE dossier lookup.
 *
 * Never throws. No retries. Does not sequence the second key mode — see the module header.
 */
export async function lookupDossier(key: DossierKey, opts: VendorCallOptions = {}): Promise<DossierResult> {
  // Read at call time rather than at module load: the module-level capture in ./client.ts
  // freezes the value at import, which leaves the missing-key branch untestable.
  const apiKey = process.env.TRACERFY_API_KEY
  const baseUrl = process.env.TRACERFY_API_URL || TRACERFY.BASE_URL

  if (!apiKey) {
    return failure('Tracerfy API key not configured')
  }

  const invalid = validateKey(key)
  if (invalid) {
    return failure(invalid)
  }

  try {
    const res = await fetchTextWithTimeout(
      `${baseUrl}${ENDPOINT_PATH}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildDossierRequest(key)),
      },
      callTimeoutMs(opts.timeoutMs)
    )

    if (!res.ok) {
      console.error('Tracerfy dossier lookup error:', res.status, res.text)

      if (res.status === 429) {
        // The 500/min counter is SHARED with the other Tracerfy lookup endpoints, so this
        // can fire even when the dossier itself is running well under its own volume.
        return failure('Rate limit exceeded. Please wait a moment before trying again.')
      }
      if (res.status === 503) {
        return failure('Tracerfy service unavailable (503)')
      }
      if (res.status === 401 || res.status === 403) {
        return failure(`Tracerfy auth failed (${res.status})`)
      }

      return failure(`Dossier lookup failed (${res.status})`)
    }

    return parseDossierResponse(JSON.parse(res.text))
  } catch (error) {
    if (error instanceof VendorTimeoutError) return failure(`Tracerfy dossier ${error.message}`)
    console.error('Tracerfy dossier lookup error:', error)
    return failure('Tracerfy service unavailable')
  }
}
