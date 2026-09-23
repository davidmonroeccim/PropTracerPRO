/**
 * What the History page and the dashboard show about a single trace, in one place.
 */

const FOUND_BY_LABEL: Record<string, string> = {
  address: 'Address',
  parcel_id: 'Parcel ID',
  company_name: 'Company name',
};

/** The KEY that found the owner, as a column label. Never the vendor. */
export function foundByLabel(foundBy?: string | null): string | null {
  return foundBy ? FOUND_BY_LABEL[foundBy] ?? null : null;
}

/**
 * The prefix of a duplicate key built from a parcel id (spec 6.3, D36):
 * `APN|<parcel>|<COUNTY>|<STATE>`.
 */
export const PARCEL_KEY_PREFIX = 'APN|'

/** True when this stored duplicate key is a parcel key rather than a street key. */
export function isParcelKey(normalized?: string | null): boolean {
  return typeof normalized === 'string' && normalized.startsWith(PARCEL_KEY_PREFIX)
}

/** The columns propertyAddressLabel reads. Structural and optional, like SkipReasonRow. */
export interface PropertyAddressRow {
  normalized_address?: string | null
  parcel_id_local?: string | null
  county?: string | null
}

const text = (v?: string | null): string => (typeof v === 'string' ? v.trim() : '')

/** "<county> County", unless the stored value already ends in County. */
const countyPhrase = (county: string): string =>
  /county$/i.test(county) ? county : `${county} County`

/**
 * WHAT A CUSTOMER IS SHOWN AS THE PROPERTY ADDRESS (spec D38). One helper, every surface.
 *
 * A row keyed on a street reads back exactly as it is stored, which is every row written before
 * D23 and every row a street and a city produced since. A row keyed on a PARCEL carries an
 * INTERNAL duplicate key in `normalized_address` -- `APN|0123-456|TRAVIS|TX` -- and that key is
 * ours: it is how we find the row again, it is not where the property is, and shown as an address
 * it reads as a malformed street. It says "Parcel 0123-456, Travis County" instead.
 *
 * The parcel and the county come from the row's OWN `parcel_id_local` and `county` columns, which
 * hold them as the caller sent them. Only when a column is absent is the value read back out of
 * the key, which is parsing what we already stored rather than inventing anything (CLAUDE.md rule
 * 7). A parcel with no county in either place says only the parcel: D41 refuses such a record at
 * the door, so it cannot be written today, and no county is ever guessed to finish the sentence.
 */
export function propertyAddressLabel(row: PropertyAddressRow): string | null {
  const normalized = text(row.normalized_address)
  if (!isParcelKey(normalized)) return normalized || null
  const parts = normalized.split('|')
  const parcel = text(row.parcel_id_local) || text(parts[1])
  const county = text(row.county) || text(parts[2])
  if (!parcel) return null
  return county ? `Parcel ${parcel}, ${countyPhrase(county)}` : `Parcel ${parcel}`
}

/**
 * The PostgREST OR filter that keeps single traces while leaving pre-2026-04-11 bulk rows out.
 *
 * WHY THE is.null ARM. The old `.not('tracerfy_job_id', 'in', (...))` is `NOT (col = ANY(...))`,
 * which is NULL, so false, on a NULL column. Every inline single trace carries tracerfy_job_id NULL,
 * so for any user who had ever run a bulk job the page hid every single trace written since
 * (research 10.2, item 11). Bulk rows written since 2026-04-11 carry trace_job_id and are kept out
 * by `.is('trace_job_id', null)` on the same query.
 */
export function bulkRowExclusion(bulkTracerfyJobIds: string[]): string | null {
  if (bulkTracerfyJobIds.length === 0) return null;
  return `tracerfy_job_id.is.null,tracerfy_job_id.not.in.(${bulkTracerfyJobIds.join(',')})`;
}
