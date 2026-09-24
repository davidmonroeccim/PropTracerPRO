/**
 * THE ONE CSV THE CUSTOMER GETS, AND THE ONE PLACE ITS SHAPE IS DECIDED.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT TWO ROUTES
 * ------------------------------------------------------------------------
 *
 * Two doors hand a customer a spreadsheet: the bulk job download and the
 * single-record download. If each built its own header they would drift within a
 * release, and the drift would be invisible -- both files open, both look
 * plausible, and a column means something different depending on which button
 * was pressed. One module, one column list, one renderer, so they cannot.
 *
 * It also gives the egress fence a single target. The fence in
 * `lib/trace/__tests__/propertyRecordEgress.test.ts` finds leaks by matching a
 * record written into an object KEY. A builder that reads `row.property_record`
 * and writes 65 separate columns writes no such key and is invisible to it, so
 * the fence tests THIS FILE's column set directly instead.
 *
 * ------------------------------------------------------------------------
 * THE COLUMN SET IS APPEND-ONLY. 105 COLUMNS, THE FIRST 16 NEVER MOVE.
 * ------------------------------------------------------------------------
 *
 * Every index that already existed keeps its index, so an importer keyed on
 * column position survives this change. That is the whole reason the layout is
 * ugly: `phone_4` lands after the research block rather than beside `phone_3`,
 * because putting it where it belongs would shift `email_1` and every column
 * after it. Ugly and stable beats tidy and breaking.
 *
 * The research block and `skip_reason` are now UNCONDITIONAL, and that is still
 * a pure append. Measured 2026-09-17 over the 44 bulk jobs carrying rows: 40 have
 * the research columns and ZERO have `skip_reason`. So for every existing job the
 * header was base + research, and base + research + skip_reason appends to it.
 * Had one single job carried skip-without-research this ordering would have been
 * a reorder -- it was checked, not assumed.
 *
 * WHAT IS NOT HERE: `match_confidence`. It is internal scoring, not a fact the
 * customer bought.
 */

import { propertyAddressLabel } from '@/lib/trace/historyDisplay';
import { rowSkipReason } from '@/lib/trace/rowSkipReason';
import { DOSSIER_EXPORT_KEYS, toPublicPropertyRecord } from '@/lib/trace/publicPropertyRecord';
import type { AIResearchResult, TraceHistory, TraceResult } from '@/types';

/**
 * How many phone and email columns the file carries.
 *
 * DELIBERATELY LOCAL CONSTANTS RATHER THAN `TRACERFY.MAX_PHONES` READ DIRECTLY,
 * even though they must equal it. The column set has to be stable: someone
 * raising the vendor cap must not silently reshape every customer's spreadsheet,
 * and must not silently leave the 9th phone unexported either. A test asserts
 * these two equal the constants, so moving the cap turns the suite RED and a
 * human adds the column on purpose.
 */
export const PHONE_COLUMN_COUNT = 8;
export const EMAIL_COLUMN_COUNT = 5;

/** The 3 phone and 3 email columns that already existed, at their original indices. */
const LEGACY_PHONE_COLUMNS = 3;
const LEGACY_EMAIL_COLUMNS = 3;

/**
 * THE PREFIX ON EVERY DOSSIER COLUMN, AND WHY IT IS NOT COSMETIC.
 *
 * The vendor's key names collide with column names this file already had:
 * `address`, `city`, `state` and `property_type` all exist twice over. They are
 * different facts -- the customer's INPUT address against the county's address
 * of record, the retired research engine's `property_type` against the county's
 * -- and two columns with one name is a defect in anything that reads the file
 * by name. pandas silently renames the second to `address.1`; a HighLevel column
 * mapping shows two identical entries and the user guesses.
 *
 * It also hid a bug in our own tests. A helper that indexed the rendered row by
 * column name resolved the duplicates last-wins, so `state` and the research
 * `property_type` were unreachable by name and went unasserted -- both survived
 * being replaced with `null` in a mutation run. Distinct names made them
 * addressable; the assertions were then written.
 */
export const DOSSIER_COLUMN_PREFIX = 'prop_';

/** The 65 dossier columns, prefixed. Vendor key order is preserved exactly. */
export const DOSSIER_EXPORT_COLUMNS = DOSSIER_EXPORT_KEYS.map(
  (key) => `${DOSSIER_COLUMN_PREFIX}${key}`
);

const appendedPhoneColumns = Array.from(
  { length: PHONE_COLUMN_COUNT - LEGACY_PHONE_COLUMNS },
  (_, i) => `phone_${i + LEGACY_PHONE_COLUMNS + 1}`
);
const phoneTypeColumns = Array.from(
  { length: PHONE_COLUMN_COUNT },
  (_, i) => `phone_${i + 1}_type`
);
const appendedEmailColumns = Array.from(
  { length: EMAIL_COLUMN_COUNT - LEGACY_EMAIL_COLUMNS },
  (_, i) => `email_${i + LEGACY_EMAIL_COLUMNS + 1}`
);

/** The header, in order. Append only; never reorder, never rename. */
export const EXPORT_COLUMNS: readonly string[] = [
  // 1-16. The original sixteen, untouched.
  'address',
  'city',
  'state',
  'zip',
  'owner_name',
  'status',
  'phone_1',
  'phone_2',
  'phone_3',
  'email_1',
  'email_2',
  'email_3',
  'mailing_address',
  'mailing_city',
  'mailing_state',
  'charge',
  // 17-20. Research. Historical data from the retired AI Search engine, still
  // owed to the 1,301 rows that carry it, now emitted for every job so the
  // header is one fixed thing rather than a function of the rows.
  'owner_type',
  'deceased',
  'relatives',
  'property_type',
  // 21. Why a row came back with no contacts. Blank when there is nothing to
  // explain. It is NOT only a "never traced" column any more: a tier 2 row whose
  // property record was bought and whose contact vendor could not be reached
  // fills it too, and says outright that it was charged.
  'skip_reason',
  // 22. THE OWNER OF RECORD, which had no column at all. `owner_name` above is
  // the resolved PERSON and falls back to the input; for a blank-owner tier 2
  // row with no principal found, both are empty and the customer sees nothing
  // after paying specifically to discover who owns the parcel.
  'owner_of_record',
  // 23-27, 28-35, 36-37, 38. Contacts already bought and never exported.
  ...appendedPhoneColumns,
  ...phoneTypeColumns,
  ...appendedEmailColumns,
  'mailing_zip',
  // 39-103. The county dossier, in vendor order, every name prefixed.
  ...DOSSIER_EXPORT_COLUMNS,
  // 104-105. WHICH KEY FOUND THE OWNER, AND WHAT THE OUTCOME WAS (spec 7.1, 7.2, D10).
  //
  // AT THE VERY END, AFTER THE DOSSIER BLOCK, because this header is append-only and an importer
  // keyed on column position has to survive the change. Putting them beside `skip_reason`, where
  // they belong logically, would shift 84 columns right.
  //
  // `found_by` is the KEY (address, parcel_id, company_name), never the vendor: the vendor lives in
  // contact_vendor, which is internal and deliberately has no column here. `outcome_code` is the
  // machine-readable twin of `skip_reason` at column 21, which carries the sentence.
  //
  // Blank on every row written before 2026-09-22 and on every tier 2 row, because both columns are
  // NULL there. Blank, never a plausible guess (CLAUDE.md rule 7).
  'found_by',
  'outcome_code',
];

/**
 * THE KEYS WHERE A NUMERIC ZERO CANNOT BE A REAL VALUE, SO IT MEANS ABSENT.
 *
 * ------------------------------------------------------------------------
 * THIS LIST IS SHORT ON PURPOSE. THE GENERAL RULE WAS WRONG.
 * ------------------------------------------------------------------------
 *
 * Phase 5a originally blanked EVERY numeric 0, citing the handoff's note that
 * fill rates "treat 0 as absent". That was a MEASUREMENT convention for
 * computing coverage percentages, not a rendering rule, and the `price_per_sqft`
 * precedent behind it was measured on PRICE fields only. Generalised, it
 * destroys facts the customer paid for:
 *
 *   years_owned: 0          bought this year
 *   mls_days_on_market: 0   listed today
 *   beds / baths: 0         genuinely zero on commercial stock
 *   units_count: 0          ditto
 *   stories: 0              ditto
 *
 * Commercial stock is this product's entire market, so the general rule was
 * wrong precisely where it mattered most.
 *
 * WHAT SURVIVES THE RULE IS A NAMED SET, and the test for membership is
 * IMPOSSIBLE, not merely unlikely:
 *
 *   MONEY     A parcel cannot be assessed at $0, sell for $0, carry a $0
 *             mortgage that exists, or sit in a census tract whose median
 *             income is $0. The vendor zero-fills these when the county
 *             published nothing. This is the `price_per_sqft` precedent, kept
 *             inside the family it was measured on.
 *   SIZE      A building with 0 sqft and a lot with 0 sqft do not exist.
 *   YEARS     There is no year 0. `year_built: 0` and `tax_delinquent_year: 0`
 *             are null spelled as a number.
 *   COORDS    Latitude 0, longitude 0 is a point in the Gulf of Guinea. No US
 *             parcel is there; it is the vendor's "we could not geocode it".
 *
 * Everything not on this list renders its 0 as `0`, because 0 is the answer.
 */
export const ZERO_MEANS_ABSENT_KEYS = [
  // Money.
  'last_sale_price',
  'prior_sale_price',
  'assessed_value',
  'open_mortgage_balance',
  'estimated_mortgage_payment',
  'total_portfolio_value',
  'area_median_income',
  'mls_listing_price',
  'price_per_sqft',
  // Size.
  'building_size_sqft',
  'lot_size_sqft',
  // Years.
  'year_built',
  'tax_delinquent_year',
  // Coordinates.
  'latitude',
  'longitude',
] as const;

const ZERO_MEANS_ABSENT_COLUMNS = new Set<string>(
  ZERO_MEANS_ABSENT_KEYS.map((key) => `${DOSSIER_COLUMN_PREFIX}${key}`)
);

/**
 * Columns rendered as a bare, fixed-2-decimal number rather than a quoted
 * string. `charge` is money the customer was billed, and the one column where
 * being a NUMBER to a spreadsheet matters most -- a column of quoted "0.40"
 * cannot be summed without a conversion step. It was bare before this phase and
 * it is bare again.
 */
const FIXED_2DP_COLUMNS = new Set<string>(['charge']);

/** Leading characters a spreadsheet reads as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * A string, quoted for CSV and DEFUSED for a spreadsheet.
 *
 * ------------------------------------------------------------------------
 * CSV QUOTING IS NOT A SECURITY BOUNDARY, AND THAT IS THE WHOLE PROBLEM
 * ------------------------------------------------------------------------
 *
 * `"=1+1"` is a correctly quoted CSV string. Excel, Google Sheets and
 * LibreOffice all strip the quotes on import and evaluate what is left, so a
 * value the VENDOR controls becomes a formula running on the customer's machine.
 * The dangerous forms are not arithmetic: `=HYPERLINK(...)` and the legacy DDE
 * `=cmd|...` are the ones that exfiltrate or execute.
 *
 * 65 of the 105 columns now carry vendor free text -- `lender_name`,
 * `subdivision`, `roof_material`, `document_type`, `property_use` -- so this
 * phase grew the exposed surface roughly six-fold over the 16 columns that
 * existed before it.
 *
 * THE FIX is the standard one: a leading apostrophe. A spreadsheet consumes it
 * and shows the text; a CSV parser does not, so `Papa.parse` reads `'=1+1` and
 * the value is visibly intact rather than silently altered. Guarding only the
 * leading character is correct -- a trigger in the middle of a value is inert.
 */
function quote(text: string): string {
  const defused = FORMULA_LEAD.test(text) ? `'${text}` : text;
  return `"${defused.replace(/"/g, '""')}"`;
}

/** One array element as plain text, or '' for anything a cell cannot honestly hold. */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  return '';
}

/**
 * One value, rendered for CSV.
 *
 * THE OLD `esc` WAS TYPED `string` AND THREW ON A NUMBER: `(123 || '').replace`
 * is not a function. It survived because every column it ever saw was a string.
 * Most of the 87 new columns are numbers and booleans.
 *
 * THE RULES, AND WHY:
 *
 *   null / undefined / ''   blank. Nothing was published.
 *
 *   true -> Yes, false -> No. A known negative is INFORMATION. `flood_zone:
 *                           false` means the county says it is not in a flood
 *                           zone; blanking it would turn a fact into an unknown.
 *
 *   numeric 0               renders `0`, because 0 is usually the answer. The
 *                           exception is the named set above, passed in as
 *                           `zeroMeansAbsent` by the column-aware renderer.
 *
 *   NaN / Infinity          blank. Neither is a fact. They are arithmetic that
 *                           went wrong upstream, and there is no honest way to
 *                           print one in a cell.
 *
 *   numbers                 bare and unquoted, no thousands separators, so a
 *                           spreadsheet reads them as numbers.
 *
 *   arrays                  joined with `; `, matching the `relatives`
 *                           convention this file already used.
 *
 *   objects                 blank. `String({})` is `[object Object]`, which is
 *                           not a value any county published. Putting it in a
 *                           paying customer's spreadsheet is fabricated data.
 *                           CLAUDE.md rule 7.
 *
 *   strings                 quoted, inner `"` doubled, and a leading formula
 *                           character defused. See `quote`.
 *
 * The non-scalar branches are UNREACHABLE TODAY -- every array-valued key the
 * vendor sends is blocked, and the dossier is otherwise scalars. They are here
 * because this is the single renderer for the whole product, and because the
 * drift test does NOT fire on a live vendor addition (see the fence): a new
 * array-valued key would reach this function before any human saw it.
 */
export function renderCell(value: unknown, zeroMeansAbsent = false): string {
  if (value === null || value === undefined) return '';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    if (value === 0 && zeroMeansAbsent) return '';
    return String(value);
  }

  if (typeof value === 'boolean') return quote(value ? 'Yes' : 'No');

  if (typeof value === 'string') return value === '' ? '' : quote(value);

  if (Array.isArray(value)) {
    const parts = value.map(scalarText).filter((part) => part !== '');
    return parts.length === 0 ? '' : quote(parts.join('; '));
  }

  return '';
}

/**
 * One history row as the 105 values, in column order, UNRENDERED.
 *
 * Values stay raw here so the renderer owns every blank/Yes/No/zero decision.
 * Exported for the tests, which assert the mapping without parsing a CSV back
 * out. Callers building a FILE want `toExportCells`, which applies the
 * column-aware rules this array cannot express on its own.
 */
export function toExportValues(row: TraceHistory): unknown[] {
  const result = row.trace_result as TraceResult | null;
  const research = row.ai_research as AIResearchResult | null;
  const phones = result?.phones ?? [];
  const emails = result?.emails ?? [];

  // DEFENCE IN DEPTH, and honestly labelled as such: replacing this call with
  // `row.property_record ?? {}` breaks no test, because `DOSSIER_EXPORT_KEYS`
  // already names no blocked key and fence assertion 1 pins that list. The key
  // list is what carries the weight here. The filter stays because it costs one
  // shallow copy and it is the module every other egress goes through, so a
  // reader following the pattern finds it where they expect it.
  const dossier = toPublicPropertyRecord(row.property_record) ?? {};

  return [
    // D38: a row keyed by parcel carries an INTERNAL key here (`APN|0123-456|TRAVIS|TX`).
    // It is never exported as the address; the customer gets "Parcel 0123-456, Travis County".
    propertyAddressLabel(row),
    row.city,
    row.state,
    row.zip,
    result?.owner_name || row.input_owner_name || null,
    row.status,
    phones[0]?.number ?? null,
    phones[1]?.number ?? null,
    phones[2]?.number ?? null,
    emails[0] ?? null,
    emails[1] ?? null,
    emails[2] ?? null,
    result?.mailing_address ?? null,
    result?.mailing_city ?? null,
    result?.mailing_state ?? null,
    // A NUMBER. The renderer formats it to 2dp and emits it bare, so the column
    // can be summed. A zero charge is not an absence, it is the statement "you
    // were not charged for this row".
    Number(row.charge) || 0,
    research?.owner_type ?? null,
    research?.is_deceased ?? null,
    (research?.relatives ?? []).join('; '),
    research?.property_type ?? null,
    // BOTH QUEUES, through the one accessor. Asking only the tier 1 column left
    // this cell blank on every tier 2 terminal value, including the billed row
    // whose contact vendor never answered.
    rowSkipReason(row),
    result?.owner_name_2 ?? null,
    ...appendedPhoneColumns.map((_, i) => phones[i + LEGACY_PHONE_COLUMNS]?.number ?? null),
    ...phoneTypeColumns.map((_, i) => phones[i]?.type ?? null),
    ...appendedEmailColumns.map((_, i) => emails[i + LEGACY_EMAIL_COLUMNS] ?? null),
    result?.mailing_zip ?? null,
    ...DOSSIER_EXPORT_KEYS.map((key) => dossier[key] ?? null),
    row.found_by ?? null,
    row.outcome_code ?? null,
  ];
}

/**
 * One history row as the 105 rendered cells.
 *
 * THE COLUMN NAME IS THE MISSING ARGUMENT. Two rules cannot be decided from a
 * value alone -- whether a 0 means absent, and whether money renders bare -- so
 * they are applied here, where the column is known, rather than being smuggled
 * into the values.
 */
export function toExportCells(row: TraceHistory): string[] {
  const values = toExportValues(row);
  return EXPORT_COLUMNS.map((column, i) => {
    if (FIXED_2DP_COLUMNS.has(column)) return (Number(values[i]) || 0).toFixed(2);
    return renderCell(values[i], ZERO_MEANS_ABSENT_COLUMNS.has(column));
  });
}

/** The whole file: the fixed header, then one line per row. */
export function buildExportCsv(rows: TraceHistory[]): string {
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(toExportCells(row).join(','));
  }
  return lines.join('\n');
}
