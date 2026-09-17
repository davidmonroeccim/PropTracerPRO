import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toPublicPropertyRecord } from '@/lib/trace/publicPropertyRecord';

/**
 * The county property record bought by a Full Property Trace (tier 2).
 *
 * PURE AND SERVER-RENDERABLE ON PURPOSE. No 'use client', no hooks, no state,
 * exactly like FullTraceDisclosure, so renderToStaticMarkup() is the whole test
 * harness: no jsdom, no testing-library, no new dependency.
 *
 * WHAT IT IS HANDED. `property_record` is the raw Tracerfy dossier
 * `response.property` object, 86 keys, stored verbatim. It is typed `unknown`
 * here rather than given a hand-written interface because it is a vendor
 * payload: a key that changes shape must fail to render one row, not throw and
 * take the page with it. Every read goes through a runtime-checked accessor.
 *
 * ------------------------------------------------------------------------
 * THREE DISPLAY RULES. The first two are correctness, not style.
 * ------------------------------------------------------------------------
 *
 * 1 AND 2. THE 21 BLOCKED KEYS NEVER REACH THE SCREEN, and this file does not
 *    hold its own copy of that list. The record is run through
 *    toPublicPropertyRecord() before a single accessor touches it, so every one
 *    of them is GONE by the time any row below is built: six provably-wrong
 *    fields (estimated_value and the four derived from it, plus corporate_owned)
 *    and fifteen propensity and renovation scores. The reasons, the measurements
 *    and the list itself live in ONE place, lib/trace/publicPropertyRecord.ts,
 *    which is the same list the v1 API, the session API, both poll routes and
 *    the trace.completed webhook apply.
 *
 *    That is deliberate. Two lists that have to agree drift, and the drift is
 *    silent: a field re-added to this panel would quietly reappear on screen
 *    while the API still withheld it, or the reverse. Here it cannot happen --
 *    adding `{ label: 'Estimated value', value: money(p.estimated_value) }`
 *    below renders nothing at all, because the key is not there.
 *
 *    price_per_sqft is NOT blocked and IS displayed. It is
 *    last_sale_price / building_size_sqft and has nothing to do with assessed
 *    value (64 vs a sale/sqft of 64.43 where assessed/sqft was 19.45). Its 0
 *    renders blank, because a 0 there means "no sale price on record".
 *
 * 3. BLANK MEANS BLANK. A field the county did not publish is OMITTED. Never a
 *    0, never "N/A", never "Unknown", never a placeholder.
 *
 *    That extends to numeric zero everywhere, not just price_per_sqft. This
 *    vendor returns 0 and false as its unpopulated defaults, so a "$0 mortgage
 *    balance" or a "0 sqft lot" is an absence wearing a number, and printing it
 *    would assert something the county never said. Same for booleans: 18 of the
 *    flags came back false on all 24 parcels measured, which makes false
 *    indistinguishable from unknown, so a flag is shown only when it is TRUE.
 */

/** Rows are built as label/value pairs and dropped when the value is blank. */
interface Row {
  label: string;
  value: string;
}

/** Trimmed string, or '' when the vendor sent nothing usable. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A finite, non-zero number, or null.
 *
 * Zero is null here by design. See rule 3 above: it is this vendor's empty
 * value, not a measurement.
 */
function figure(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return null;
  return value;
}

/** True only for a literal true. A missing flag and a false flag read the same. */
function flagged(value: unknown): boolean {
  return value === true;
}

const CURRENCY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function money(value: unknown): string {
  const n = figure(value);
  return n === null ? '' : CURRENCY.format(n);
}

function amount(value: unknown, unit: string): string {
  const n = figure(value);
  return n === null ? '' : `${n.toLocaleString('en-US')} ${unit}`;
}

function count(value: unknown): string {
  const n = figure(value);
  return n === null ? '' : n.toLocaleString('en-US');
}

/** Years and parcel identifiers are digits, not quantities, so no thousands separator. */
function plain(value: unknown): string {
  const n = figure(value);
  return n === null ? '' : String(n);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * "2022-05-13" becomes "May 13, 2022".
 *
 * Parsed by hand rather than through Date, which would shift the day backwards
 * for anyone west of UTC and silently misreport a recording date.
 */
function date(value: unknown): string {
  const raw = text(value);
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!parts) return raw;
  const month = MONTHS[Number(parts[2]) - 1];
  const day = Number(parts[3]);
  // "0000-00-00" is this vendor's empty date, the same absence that 0 and false
  // are elsewhere in the payload. It used to fall through and print itself
  // verbatim, which is a date nobody recorded rendered as though somebody had.
  // Blank means blank (rule 3).
  if (!month || day < 1 || day > 31) return '';
  return `${month} ${day}, ${parts[1]}`;
}

function coordinates(record: Record<string, unknown>): string {
  const lat = figure(record.latitude);
  const lng = figure(record.longitude);
  if (lat === null || lng === null) return '';
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function streetLine(record: Record<string, unknown>): string {
  const regionAndZip = [text(record.state), text(record.zip_code)].filter(Boolean).join(' ');
  return [text(record.address), text(record.city), regionAndZip].filter(Boolean).join(', ');
}

/** Only the flags that are actually true, in the order given. */
function flags(record: Record<string, unknown>, pairs: [string, string][]): string[] {
  return pairs.filter(([key]) => flagged(record[key])).map(([, label]) => label);
}

function Section({
  title,
  rows,
  chips,
  chipTone = 'neutral',
  note,
}: {
  title: string;
  rows: Row[];
  chips?: string[];
  chipTone?: 'neutral' | 'alert';
  note?: string;
}) {
  const present = rows.filter((row) => row.value !== '');
  const marks = chips ?? [];
  if (present.length === 0 && marks.length === 0) return null;

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{title}</h3>
      {present.length > 0 && (
        <dl className="divide-y divide-gray-100 rounded-md border border-gray-100">
          {present.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 px-3 py-2">
              <dt className="text-sm text-gray-500">{row.label}</dt>
              <dd className="text-sm font-medium text-gray-900 text-right">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {marks.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {marks.map((mark) => (
            <Badge
              key={mark}
              variant="outline"
              className={
                chipTone === 'alert'
                  ? 'border-amber-300 bg-amber-50 text-amber-900'
                  : 'border-gray-200 bg-gray-50 text-gray-700'
              }
            >
              {mark}
            </Badge>
          ))}
        </div>
      )}
      {note && <p className="text-xs text-gray-500 mt-2">{note}</p>}
    </div>
  );
}

export function PropertyRecordCard({ record }: { record: unknown }) {
  // THE BLOCKED KEYS ARE REMOVED BEFORE ANYTHING READS THEM, from the one list
  // every egress shares. This is also the guard for a payload that is not a
  // property record at all: a vendor object that is not a plain object returns
  // null here, and the card simply is not there -- nothing to show and nothing
  // to apologize for.
  //
  // The panel is normally handed an ALREADY-filtered record, because the API
  // that fed it filtered on the way out. Filtering again is not redundant: it
  // is what stops this file from needing a second copy of the list, and it
  // keeps the panel correct if it is ever handed a raw record directly.
  const p = toPublicPropertyRecord(record);
  if (!p) return null;

  const identity: Row[] = [
    { label: 'Address', value: streetLine(p) },
    { label: 'County', value: text(p.county) },
    { label: 'Parcel number', value: text(p.apn) },
    { label: 'Subdivision', value: text(p.subdivision) },
    { label: 'Property type', value: text(p.property_type) },
    { label: 'Property use', value: text(p.property_use) },
    { label: 'Land use', value: text(p.land_use) },
    { label: 'Coordinates', value: coordinates(p) },
  ];

  const building: Row[] = [
    { label: 'Year built', value: plain(p.year_built) },
    { label: 'Stories', value: count(p.stories) },
    { label: 'Units', value: count(p.units_count) },
    { label: 'Building size', value: amount(p.building_size_sqft, 'sqft') },
    { label: 'Lot size', value: amount(p.lot_size_sqft, 'sqft') },
    { label: 'Bedrooms', value: count(p.beds) },
    { label: 'Bathrooms', value: count(p.baths) },
    { label: 'Roof material', value: text(p.roof_material) },
    { label: 'Roof construction', value: text(p.roof_construction) },
  ];
  const features = flags(p, [
    ['has_ac', 'Air conditioning'],
    ['has_garage', 'Garage'],
    ['has_pool', 'Pool'],
    ['has_basement', 'Basement'],
    ['has_deck', 'Deck'],
  ]);

  const assessed = money(p.assessed_value);
  const valuation: Row[] = [
    { label: 'Assessed value', value: assessed },
    { label: 'Area median income', value: money(p.area_median_income) },
  ];

  const sale: Row[] = [
    { label: 'Last sale date', value: date(p.last_sale_date) },
    { label: 'Last sale price', value: money(p.last_sale_price) },
    { label: 'Sale price per sqft', value: money(p.price_per_sqft) },
    { label: 'Recording date', value: date(p.recording_date) },
    { label: 'Document type', value: text(p.document_type) },
    { label: 'Prior sale date', value: date(p.prior_sale_date) },
    { label: 'Prior sale price', value: money(p.prior_sale_price) },
  ];
  const saleFlags = flags(p, [['quit_claim', 'Quit claim deed']]);

  const listing: Row[] = [
    { label: 'Days on market', value: count(p.mls_days_on_market) },
    { label: 'Listing price', value: money(p.mls_listing_price) },
  ];
  const listingFlags = flags(p, [
    ['mls_active', 'MLS active'],
    ['mls_pending', 'MLS pending'],
    ['mls_sold', 'MLS sold'],
    ['mls_cancelled', 'MLS cancelled'],
    ['mls_failed', 'MLS failed'],
  ]);

  const debt: Row[] = [
    { label: 'Open mortgage balance', value: money(p.open_mortgage_balance) },
    { label: 'Lender', value: text(p.lender_name) },
    { label: 'Estimated mortgage payment', value: money(p.estimated_mortgage_payment) },
  ];
  const debtFlags = flags(p, [['adjustable_rate', 'Adjustable rate']]);

  // total_portfolio_value reads as the sum of the vendor's per-parcel values,
  // and those per-parcel values are identical to ASSESSED value on 23 of 23
  // parcels measured. Two fixtures make the same point from the other end: 15
  // properties at $70,006,885 against a $2,799,600 assessment on this parcel,
  // and 3 at $1,032,972 against $203,740. It is neither this parcel's
  // assessment times the count nor a market figure, so it is labelled for what
  // it is: county assessments, added up. Portfolio scale is a genuinely useful
  // signal. A number that sounds like a market valuation and is not is exactly
  // what got estimated_value blocked.
  const portfolio = money(p.total_portfolio_value);
  const owner: Row[] = [
    { label: 'Years owned', value: count(p.years_owned) },
    { label: 'Properties owned', value: count(p.total_properties_owned) },
    { label: 'Portfolio assessed value', value: portfolio },
  ];
  const ownerFlags = flags(p, [
    ['absentee_owner', 'Absentee owner'],
    ['owner_occupied', 'Owner occupied'],
    ['investor_buyer', 'Investor buyer'],
    ['cash_buyer', 'Cash buyer'],
  ]);

  const status: Row[] = [
    { label: 'Tax delinquent since', value: plain(p.tax_delinquent_year) },
  ];
  const statusFlags = flags(p, [
    ['vacant', 'Vacant'],
    ['pre_foreclosure', 'Pre-foreclosure'],
    ['foreclosure', 'Foreclosure'],
    ['tax_delinquent', 'Tax delinquent'],
    ['tax_lien', 'Tax lien'],
    ['inherited', 'Inherited'],
    ['death', 'Death of owner'],
    ['judgment', 'Judgment'],
    ['hoa', 'HOA'],
    ['flood_zone', 'Flood zone'],
  ]);

  const sections: {
    title: string;
    rows: Row[];
    chips: string[];
    chipTone?: 'neutral' | 'alert';
    note?: string;
  }[] = [
    { title: 'Location and identity', rows: identity, chips: [] },
    { title: 'Building and land', rows: building, chips: features },
    {
      title: 'Valuation',
      rows: valuation,
      chips: [],
      note: assessed
        ? 'Assessed value is the county assessment. It is not a market valuation.'
        : undefined,
    },
    { title: 'Sale and transaction history', rows: sale, chips: saleFlags },
    { title: 'Listing history', rows: listing, chips: listingFlags },
    { title: 'Debt', rows: debt, chips: debtFlags },
    {
      title: 'Owner and occupancy',
      rows: owner,
      chips: ownerFlags,
      note: portfolio
        ? 'Portfolio assessed value adds up the county assessments on the properties this owner holds. It is a measure of how much they own, not a market valuation.'
        : undefined,
    },
    { title: 'Recorded status', rows: status, chips: statusFlags, chipTone: 'alert' },
  ];

  // A dossier that published nothing we may show gets no card at all, rather
  // than an empty shell implying the answer is on screen somewhere.
  const anyContent = sections.some(
    (s) => s.chips.length > 0 || s.rows.some((row) => row.value !== '')
  );
  if (!anyContent) return null;

  return (
    <Card data-testid="property-record-card">
      <CardHeader>
        <CardTitle>Property Record</CardTitle>
        <CardDescription>
          What the county has on file for this parcel. Only the fields the county published are
          listed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {sections.map((section) => (
          <Section
            key={section.title}
            title={section.title}
            rows={section.rows}
            chips={section.chips}
            chipTone={section.chipTone}
            note={section.note}
          />
        ))}
      </CardContent>
    </Card>
  );
}
