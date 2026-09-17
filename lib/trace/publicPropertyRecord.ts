/**
 * THE ONE LIST OF DOSSIER KEYS THAT MAY NOT LEAVE PTP, AND THE FILTER THAT
 * APPLIES IT.
 *
 * ------------------------------------------------------------------------
 * STORAGE IS NOT FILTERED. EGRESS IS.
 * ------------------------------------------------------------------------
 *
 * `trace_history.property_record` keeps the vendor's object VERBATIM, all 86
 * keys, unfiltered and unrenamed. The raw dump IS the product: a key that is
 * empty in Ohio, California and Utah may be populated in another county, the
 * $0.20 was already spent to fetch it, and a filter on the way IN destroys
 * history that cannot be re-bought. Nothing in this module runs before a write.
 *
 * It runs on the way OUT, at every door a property record leaves through: the
 * v1 API, the session API, both poll routes, the `trace.completed` webhook, and
 * the on-screen card. David, 2026-09-17, extending the export rule already
 * settled for the CSV: a payload lands in a customer's own system, where a
 * wrong `estimated_value` looks authoritative and outlives any caveat we could
 * put on a screen.
 *
 * ------------------------------------------------------------------------
 * WHY THESE 21, AND WHY THE TWO GROUPS MUST NEVER BE MERGED
 * ------------------------------------------------------------------------
 *
 * GROUP A, SIX FIELDS: PROVABLY WRONG, NOT MERELY MISSING. Measured over 24
 * saved dossiers, 2026-09-16.
 *
 *   estimated_value    100% populated and equal to `assessed_value` on 23 of
 *                      23 parcels. There is no AVM behind it.
 *   estimated_equity   derived from it
 *   equity_percent     derived from it
 *   high_equity        derived from it
 *   free_clear         derived from it
 *   corporate_owned    returned FALSE for a Delaware limited partnership
 *
 * More counties will not fix these. The defect is in the vendor's math, not in
 * county coverage.
 *
 * GROUP B, FIFTEEN PROPENSITY AND RENOVATION KEYS. Two independent reasons:
 * they are contaminated by the equity math above, and the renovation models are
 * RESIDENTIAL models. Verbatim from a factors array on a 41,588 sqft commercial
 * building carrying $175,000,000 of blanket debt: "41,588 sqft - large home,
 * higher HVAC cost and complexity".
 *
 * NOT ON THIS LIST, DELIBERATELY:
 *
 *   price_per_sqft     was moved OUT on 2026-09-17. It is
 *                      `last_sale_price / building_size_sqft` and has nothing
 *                      to do with assessed value (64 against a sale/sqft of
 *                      64.43 where assessed/sqft was 19.45). It was blocked on
 *                      a REDUNDANCY argument, never a correctness one, and the
 *                      two arguments are not the same.
 *
 *   the 18 keys never seen populated in the sample (tax_delinquent, vacant,
 *                      inherited, ...). That is a statement about OH, CA and UT
 *                      and not about the field. Coverage, not correctness, so
 *                      they ship — blank when the county published nothing.
 *
 * A DENYLIST, NOT AN ALLOWLIST, ON PURPOSE. A key the vendor adds tomorrow
 * reaches the customer rather than being silently swallowed, which is the same
 * reason storage is raw. The tests hold the other end of that bargain: they
 * fail if a NEW key arrives in the propensity family, so an addition is a
 * decision somebody makes rather than a default.
 */

/** The 21 keys withheld from every response, payload, export and screen. */
export const BLOCKED_PROPERTY_RECORD_KEYS = [
  // Group A: provably wrong, not missing.
  'estimated_value',
  'estimated_equity',
  'equity_percent',
  'high_equity',
  'free_clear',
  'corporate_owned',
  // Group B: equity-contaminated, and residential models run on commercial stock.
  'sell_propensity_score',
  'sell_propensity_category',
  'sell_propensity_factors',
  'refi_propensity_score',
  'refi_propensity_category',
  'refi_propensity_factors',
  'roof_renovate_propensity_score',
  'roof_renovate_propensity_category',
  'roof_renovate_propensity_factors',
  'hvac_renovate_propensity_score',
  'hvac_renovate_propensity_category',
  'hvac_renovate_propensity_factors',
  'solar_renovate_propensity_score',
  'solar_renovate_propensity_category',
  'solar_renovate_propensity_factors',
] as const;

export type BlockedPropertyRecordKey = (typeof BLOCKED_PROPERTY_RECORD_KEYS)[number];

const BLOCKED = new Set<string>(BLOCKED_PROPERTY_RECORD_KEYS);

/**
 * A COPY of the vendor's property record with the 21 blocked keys removed.
 *
 * PURE. No I/O, no clock, no environment.
 *
 * IT MUST NOT MUTATE ITS ARGUMENT, and that is a storage guarantee rather than
 * a style preference: both submit routes persist the RAW record and then return
 * the filtered one FROM THE SAME VARIABLE. Deleting in place would write a
 * 65-key row to `trace_history` and destroy the raw dump the product is built
 * on. A test fences this.
 *
 * Returns null for anything that is not a plain object — null, undefined, an
 * array, a string the vendor sent where an object was expected. A record that
 * is not a record is an absence, and an absence is reported as null rather than
 * as an empty object that would read as "the county published nothing".
 *
 * The copy is SHALLOW. Every blocked key is top-level (the `_factors` arrays
 * are themselves blocked wholesale), so no blocked value survives inside a
 * nested structure, and no caller mutates what it is handed.
 */
export function toPublicPropertyRecord(record: unknown): Record<string, unknown> | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (BLOCKED.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * THE 65 DOSSIER KEYS THE CSV EXPORT EMITS, AS COLUMNS, IN VENDOR ORDER.
 *
 * ------------------------------------------------------------------------
 * WHY A FIXED LIST NEXT TO A DENYLIST, WHICH LOOKS LIKE A CONTRADICTION
 * ------------------------------------------------------------------------
 *
 * `toPublicPropertyRecord` is deliberately a DENYLIST: a key the vendor adds
 * tomorrow reaches the customer instead of being silently swallowed. A CSV
 * cannot work that way. A spreadsheet whose column set moves under a customer
 * breaks every importer pointed at it, so the export needs a set that is stable
 * until a human changes it.
 *
 * Both hold at once because of the DRIFT TEST in
 * `lib/trace/__tests__/propertyRecordEgress.test.ts`: every public key of the
 * committed 86-key fixture must appear in this list. A new vendor key turns the
 * suite RED, and somebody adds the column on purpose. The payload surfaces keep
 * their open default; the export gets its stable set; neither is silent.
 *
 * ORDER IS THE VENDOR'S, not alphabetical and not regrouped. It is the order
 * the dossier arrives in and the order the fixture records, so a diff against a
 * raw payload reads straight down.
 *
 * NOTHING HERE MAY BE A BLOCKED KEY. The fence asserts that too, because this
 * list is the one place a blocked field could reach a customer without ever
 * passing through the filter above.
 */
export const DOSSIER_EXPORT_KEYS = [
  'address',
  'city',
  'state',
  'zip_code',
  'county',
  'latitude',
  'longitude',
  'apn',
  'subdivision',
  'property_type',
  'property_use',
  'land_use',
  'year_built',
  'beds',
  'baths',
  'units_count',
  'stories',
  'building_size_sqft',
  'lot_size_sqft',
  'has_ac',
  'has_garage',
  'has_pool',
  'has_basement',
  'has_deck',
  'last_sale_date',
  'last_sale_price',
  'years_owned',
  'absentee_owner',
  'owner_occupied',
  'vacant',
  'pre_foreclosure',
  'foreclosure',
  'tax_delinquent',
  'tax_delinquent_year',
  'tax_lien',
  'inherited',
  'death',
  'judgment',
  'hoa',
  'price_per_sqft',
  'assessed_value',
  'area_median_income',
  'open_mortgage_balance',
  'lender_name',
  'estimated_mortgage_payment',
  'total_properties_owned',
  'total_portfolio_value',
  'cash_buyer',
  'roof_material',
  'roof_construction',
  'flood_zone',
  'prior_sale_price',
  'prior_sale_date',
  'document_type',
  'quit_claim',
  'recording_date',
  'mls_active',
  'mls_pending',
  'mls_cancelled',
  'mls_sold',
  'mls_failed',
  'mls_days_on_market',
  'mls_listing_price',
  'adjustable_rate',
  'investor_buyer',
] as const;

export type DossierExportKey = (typeof DOSSIER_EXPORT_KEYS)[number];
