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
