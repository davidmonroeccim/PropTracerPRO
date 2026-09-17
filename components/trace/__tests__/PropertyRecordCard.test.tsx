import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PropertyRecordCard } from '@/components/trace/PropertyRecordCard';
import { BLOCKED_PROPERTY_RECORD_KEYS } from '@/lib/trace/publicPropertyRecord';
import entityHitAddress from '@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json';

/**
 * What this pins: the panel shows the county's record and nothing the county
 * did not say.
 *
 * Three failure modes are tested to death here, because each one is a product
 * defect rather than a styling nit:
 *
 *   1. A BLOCKED FIELD COMES BACK. Six dossier fields are provably wrong
 *      (estimated_value equals assessed_value on 23 of 23 parcels, and four
 *      fields are derived from it; corporate_owned returned FALSE for a
 *      Delaware limited partnership) and fifteen propensity scores are both
 *      equity-contaminated and residential models run on commercial buildings.
 *      The "blocked fields stay blocked" suite below renders the panel with a
 *      sentinel value in each of those 21 keys and fails if the output moves at
 *      all, so re-adding one to the panel breaks a test rather than shipping.
 *      Those 21 keys are NOT this file's own list: they are pinned to
 *      BLOCKED_PROPERTY_RECORD_KEYS, the single list every egress applies.
 *
 *   2. AN ABSENCE RENDERS AS A NUMBER. The vendor returns 0 and false as its
 *      unpopulated defaults. A "$0" mortgage balance or a "No" next to
 *      Foreclosure is fabricated data, which is the product owner's single
 *      biggest complaint. Blank means blank.
 *
 *   3. A FIELD QUIETLY STOPS RENDERING. The coverage suite proves all 65
 *      displayable keys reach the screen, one at a time.
 *
 * The fixture is the committed, sanitized dossier. Real dossiers live in a
 * gitignored directory and are never read by a test.
 */

const FIXTURE = (entityHitAddress as { response: { property: Record<string, unknown> } }).response
  .property;

function render(record: unknown): string {
  return renderToStaticMarkup(<PropertyRecordCard record={record} />);
}

/** Visible text, with markup, HTML comments and JSX indentation removed. */
function visibleText(markup: string): string {
  return markup
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * The committed dossier, rendered
 * ------------------------------------------------------------------ */

describe('the sanitized Salt Lake County dossier', () => {
  const markup = render(FIXTURE);
  const text = visibleText(markup);

  test('reads as a property record, in sections, not as a JSON dump', () => {
    for (const heading of [
      'Location and identity',
      'Building and land',
      'Valuation',
      'Sale and transaction history',
      'Owner and occupancy',
    ]) {
      expect(text).toContain(heading);
    }
  });

  test('a section with nothing in it is absent, not an empty heading', () => {
    // This parcel has no lender, a 0 mortgage balance and no MLS history, so
    // Debt and Listing history have nothing to say and do not appear. They do
    // appear on a parcel that carries them.
    expect(text).not.toContain('Debt');
    expect(text).not.toContain('Listing history');
    const fuller = visibleText(render(MAXIMAL));
    expect(fuller).toContain('Debt');
    expect(fuller).toContain('Listing history');
  });

  test('carries the identity the county recorded', () => {
    expect(text).toContain('1815 S State St, Salt Lake City, UT 84115');
    expect(text).toContain('Salt Lake County');
    expect(text).toContain('16-18-306-029');
    expect(text).toContain('Retail Store');
  });

  test('formats sizes and dates for a human', () => {
    expect(text).toContain('36,037 sqft');
    expect(text).toContain('37,897 sqft');
    // The recording date is 2022-05-13. Parsed through Date() this renders as
    // May 12 for anyone west of UTC, which misreports a recorded instrument.
    expect(text).toContain('May 13, 2022');
  });

  test('labels the assessment as assessed, never as market value', () => {
    expect(text).toContain('Assessed value');
    expect(text).toContain('$2,799,600');
    expect(text).not.toMatch(/market value/i);
    expect(text).toContain('It is not a market valuation.');
  });

  test('the assessed figure appears exactly once', () => {
    // estimated_value is the same 2,799,600 on this parcel, which is the whole
    // reason it is blocked. Two copies of that number means the panel is
    // printing the AVM that does not exist.
    expect(text.split('$2,799,600').length - 1).toBe(1);
  });

  test('shows the status flags that are true', () => {
    expect(text).toContain('Absentee owner');
    expect(text).toContain('Investor buyer');
    expect(text).toContain('Cash buyer');
    expect(text).toContain('Flood zone');
  });

  test('says nothing at all about the flags that are false', () => {
    // False is this vendor's default for a flag it has no data for: 18 of them
    // came back false on all 24 parcels measured. Printing "No" next to
    // Foreclosure would assert an absence of foreclosure that nobody verified.
    for (const label of [
      'Owner occupied',
      'Vacant',
      'Foreclosure',
      'Pre-foreclosure',
      'Tax delinquent',
      'Tax lien',
      'Inherited',
      'Judgment',
      'HOA',
      'Pool',
      'Deck',
      'Garage',
      'Air conditioning',
      'Quit claim deed',
      'MLS active',
    ]) {
      expect(text).not.toContain(label);
    }
  });

  test('omits every field the county left empty, with no placeholder of any kind', () => {
    // subdivision, lender_name, roof_material and roof_construction are '' on
    // this parcel; beds, baths and the MLS numbers are null.
    for (const label of [
      'Subdivision',
      'Lender',
      'Roof material',
      'Roof construction',
      'Bedrooms',
      'Bathrooms',
      'Days on market',
      'Listing price',
      'Tax delinquent since',
    ]) {
      expect(text).not.toContain(label);
    }
    expect(text).not.toMatch(/N\/A|Unknown|None|--|TBD/);
  });

  test('a zero is never printed as a number', () => {
    // last_sale_price, price_per_sqft, open_mortgage_balance and
    // estimated_mortgage_payment are all 0 on this parcel. Each 0 means "not on
    // record", and $0 would read as a fact.
    expect(text).not.toContain('$0');
    expect(text).not.toMatch(/(^|\s)0(\s|$)/);
    for (const label of [
      'Last sale price',
      'Sale price per sqft',
      'Open mortgage balance',
      'Estimated mortgage payment',
    ]) {
      expect(text).not.toContain(label);
    }
  });

  test('carries no em-dashes, en-dashes, asterisks or smart quotes', () => {
    // Escaped rather than literal so an editor that helpfully curls a quote
    // cannot quietly change which characters this test bans.
    expect(text).not.toMatch(/[\u2010-\u2015\u2018\u2019\u201C\u201D*]/);
  });
});

/* ------------------------------------------------------------------ *
 * A record holding every displayable key, for coverage and for the ban
 * ------------------------------------------------------------------ */

/**
 * The 65 keys that MAY be displayed, each with a distinct, non-zero, non-false
 * value so that dropping any one of them is visible in the output.
 */
const MAXIMAL: Record<string, unknown> = {
  // location and identity
  address: '400 Sentinel Ave',
  city: 'Testville',
  state: 'OH',
  zip_code: '44101',
  county: 'Cuyahoga County',
  apn: '111-22-333',
  subdivision: 'Sentinel Heights',
  property_type: 'Industrial Warehouse',
  property_use: 'Warehouse Distribution',
  land_use: 'Industrial',
  latitude: 41.123456,
  longitude: -81.654321,
  // building and land
  year_built: 1971,
  beds: 3,
  baths: 2,
  units_count: 7,
  stories: 4,
  building_size_sqft: 41588,
  lot_size_sqft: 79684,
  roof_material: 'Membrane',
  roof_construction: 'Flat',
  has_ac: true,
  has_garage: true,
  has_pool: true,
  has_basement: true,
  has_deck: true,
  // valuation
  assessed_value: 1234567,
  area_median_income: 58211,
  // sale and transaction history
  last_sale_date: '2022-05-13',
  last_sale_price: 8200000,
  price_per_sqft: 197,
  recording_date: '2022-06-01',
  document_type: 'Special Warranty Deed',
  prior_sale_date: '2014-09-30',
  prior_sale_price: 5100000,
  quit_claim: true,
  // listing history
  mls_days_on_market: 143,
  mls_listing_price: 8750000,
  mls_active: true,
  mls_pending: true,
  mls_sold: true,
  mls_cancelled: true,
  mls_failed: true,
  // debt
  open_mortgage_balance: 3300000,
  lender_name: 'Sentinel Bank NA',
  estimated_mortgage_payment: 19400,
  adjustable_rate: true,
  // owner and occupancy
  years_owned: 12,
  total_properties_owned: 15,
  total_portfolio_value: 70006885,
  absentee_owner: true,
  owner_occupied: true,
  investor_buyer: true,
  cash_buyer: true,
  // recorded status
  tax_delinquent_year: 2019,
  vacant: true,
  pre_foreclosure: true,
  foreclosure: true,
  tax_delinquent: true,
  tax_lien: true,
  inherited: true,
  death: true,
  judgment: true,
  hoa: true,
  flood_zone: true,
};

/** The 21 keys that must never reach the screen, with a value that would shout. */
const BLOCKED: Record<string, unknown> = {
  // Group A: provably wrong, not missing.
  estimated_value: 987654321,
  estimated_equity: 987654322,
  equity_percent: 93,
  high_equity: true,
  free_clear: true,
  corporate_owned: true,
  // Group B: equity-contaminated, and residential models on commercial stock.
  sell_propensity_score: 987654323,
  sell_propensity_category: 'SENTINELCATEGORY',
  sell_propensity_factors: [{ name: 'free_clear', points: 4, reason: 'SENTINELREASON' }],
  refi_propensity_score: 987654324,
  refi_propensity_category: 'SENTINELCATEGORY',
  refi_propensity_factors: [{ name: 'high_equity', points: 15, reason: 'SENTINELREASON' }],
  roof_renovate_propensity_score: 987654325,
  roof_renovate_propensity_category: 'SENTINELCATEGORY',
  roof_renovate_propensity_factors: [{ name: 'home_age', points: 25, reason: 'SENTINELREASON' }],
  hvac_renovate_propensity_score: 987654326,
  hvac_renovate_propensity_category: 'SENTINELCATEGORY',
  hvac_renovate_propensity_factors: [{ name: 'home_size', points: 10, reason: 'SENTINELREASON' }],
  solar_renovate_propensity_score: 987654327,
  solar_renovate_propensity_category: 'SENTINELCATEGORY',
  solar_renovate_propensity_factors: [{ name: 'sun_index', points: 8, reason: 'SENTINELREASON' }],
};

describe('field coverage', () => {
  test('the dossier has 86 keys, 21 of them blocked, and this file accounts for all of them', () => {
    expect(Object.keys(FIXTURE)).toHaveLength(86);
    expect(Object.keys(BLOCKED)).toHaveLength(21);
    expect(Object.keys(MAXIMAL)).toHaveLength(65);
    // Every key in the fixture is either displayable or blocked. A new vendor
    // key shows up here as a failure rather than as a silent omission.
    const accounted = new Set([...Object.keys(MAXIMAL), ...Object.keys(BLOCKED)]);
    expect(Object.keys(FIXTURE).filter((key) => !accounted.has(key))).toEqual([]);
  });

  test('all 65 displayable keys reach the screen', () => {
    const full = render(MAXIMAL);
    for (const key of Object.keys(MAXIMAL)) {
      const without = { ...MAXIMAL };
      delete without[key];
      expect(render(without), `${key} is not rendered anywhere`).not.toBe(full);
    }
  });
});

describe('blocked fields stay blocked', () => {
  const base = render(MAXIMAL);

  test('the panel filters through the shared list instead of keeping its own', () => {
    // A SOURCE assertion, because this one cannot be caught by rendering. The
    // panel gates by ENUMERATION -- it renders 65 named fields and no others --
    // so deleting the shared filter changes no pixel today and leaves the file
    // silently carrying its own second copy of the rule. That is exactly the
    // drift this is built to prevent: the day someone adds an "Estimated value"
    // row here, the screen would publish a field the API withholds.
    //
    // MUTATION: replace toPublicPropertyRecord(record) with a plain cast in
    // PropertyRecordCard.tsx and this goes red. Nothing else in the suite does.
    const source = readFileSync(
      join(process.cwd(), 'components/trace/PropertyRecordCard.tsx'),
      'utf8'
    );
    expect(source).toContain('toPublicPropertyRecord(record)');
  });

  test('the panel never names a blocked key, so no row can go silently blank', () => {
    // Belt to the filter's braces. A row built on a blocked key renders nothing
    // whatever, which is correct but looks like a bug to whoever wrote it. It
    // should not be in the file at all.
    const source = readFileSync(
      join(process.cwd(), 'components/trace/PropertyRecordCard.tsx'),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(source, `the panel reads p.${key}`).not.toContain(`p.${key}`);
      expect(source, `the panel names '${key}'`).not.toContain(`'${key}'`);
    }
  });

  test('this file and the shared egress list name the SAME 21 keys', () => {
    // THE ANTI-DRIFT TEST. The panel no longer keeps its own copy of the list:
    // it runs the record through toPublicPropertyRecord() before reading a
    // single key, so the screen and the v1 API, the session API, both poll
    // routes and the trace.completed webhook are gated by one list in
    // lib/trace/publicPropertyRecord.ts. The sentinel map below is this file's
    // TEST DATA, and it is the one place a second list could still creep back
    // in, so it is pinned to the shared one here. Add a key to either and this
    // goes red the same day rather than drifting silently for a quarter.
    expect(Object.keys(BLOCKED).sort()).toEqual([...BLOCKED_PROPERTY_RECORD_KEYS].sort());
  });

  test.each(Object.keys(BLOCKED))('%s changes nothing on screen', (key) => {
    expect(render({ ...MAXIMAL, [key]: BLOCKED[key] })).toBe(base);
  });

  test('all 21 at once change nothing on screen', () => {
    expect(render({ ...MAXIMAL, ...BLOCKED })).toBe(base);
  });

  test('none of their labels appear, whatever the data', () => {
    const text = visibleText(render({ ...MAXIMAL, ...BLOCKED }));
    for (const banned of [
      /estimated value/i,
      /equity/i,
      /free and clear/i,
      /corporate/i,
      /propensity/i,
      /renovat/i,
      /likelihood to sell/i,
      /refinance/i,
    ]) {
      expect(text).not.toMatch(banned);
    }
    expect(text).not.toContain('SENTINELCATEGORY');
    expect(text).not.toContain('SENTINELREASON');
    expect(text).not.toContain('987,654,321');
  });
});

/* ------------------------------------------------------------------ *
 * price_per_sqft: allowed, but its 0 is an absence
 * ------------------------------------------------------------------ */

describe('sale price per square foot', () => {
  test('is shown when the county has a sale price behind it', () => {
    expect(visibleText(render({ ...MAXIMAL, price_per_sqft: 197 }))).toContain(
      'Sale price per sqft'
    );
  });

  test('is blank at 0, because a 0 there means no sale price on record', () => {
    const text = visibleText(render({ ...MAXIMAL, price_per_sqft: 0 }));
    expect(text).not.toContain('Sale price per sqft');
    expect(text).not.toContain('$0');
  });
});

/* ------------------------------------------------------------------ *
 * Nothing to show is nothing on screen
 * ------------------------------------------------------------------ */

describe('when there is no record', () => {
  test('renders nothing for null, undefined or a non-object', () => {
    expect(render(null)).toBe('');
    expect(render(undefined)).toBe('');
    expect(render('not a record')).toBe('');
    expect(render([1, 2, 3])).toBe('');
  });

  test('renders nothing for an empty object rather than an empty shell', () => {
    expect(render({})).toBe('');
  });

  test('renders nothing when every key the vendor sent is blank or blocked', () => {
    const empty = {
      address: '',
      county: '   ',
      assessed_value: 0,
      lot_size_sqft: 0,
      beds: null,
      absentee_owner: false,
      foreclosure: false,
      ...BLOCKED,
    };
    expect(render(empty)).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * total_portfolio_value: labelled, not blocked
 * ------------------------------------------------------------------ */

describe('portfolio value', () => {
  test('is labelled as assessed, the way the single-parcel assessment is', () => {
    // It reads as the sum of the vendor's per-parcel values, and those are
    // identical to assessed value on 23 of 23 parcels. Left as "Portfolio
    // value" it inherits exactly the defect that got estimated_value blocked:
    // a number the reader takes for a market figure.
    const text = visibleText(render(MAXIMAL));
    expect(text).toContain('Portfolio assessed value');
    expect(text).not.toMatch(/(^|\s)Portfolio value/);
  });

  test('carries a note saying it is not a market valuation', () => {
    const text = visibleText(render(MAXIMAL));
    expect(text).toContain('not a market valuation');
  });

  test('the note is absent when the vendor sent no portfolio figure', () => {
    // Blank means blank applies to the explanation too: nothing on screen to
    // explain, nothing explaining it.
    const without = { ...MAXIMAL };
    delete without.total_portfolio_value;
    const text = visibleText(render(without));
    expect(text).not.toContain('Portfolio assessed value');
    expect(text).not.toContain('adds up the county assessments');
  });

  test('is still shown, because portfolio scale is a real signal', () => {
    expect(visibleText(render(MAXIMAL))).toContain('$70,006,885');
  });
});

/* ------------------------------------------------------------------ *
 * The vendor's empty date
 * ------------------------------------------------------------------ */

describe('a date the county never recorded', () => {
  test('renders blank rather than printing 0000-00-00 at the reader', () => {
    const text = visibleText(render({ ...MAXIMAL, last_sale_date: '0000-00-00' }));
    expect(text).not.toContain('0000-00-00');
    expect(text).not.toContain('Last sale date');
  });

  test('every zeroed date field goes blank, not just the first one', () => {
    const text = visibleText(
      render({
        ...MAXIMAL,
        last_sale_date: '0000-00-00',
        recording_date: '0000-00-00',
        prior_sale_date: '0000-00-00',
      })
    );
    expect(text).not.toContain('0000');
    for (const label of ['Last sale date', 'Recording date', 'Prior sale date']) {
      expect(text).not.toContain(label);
    }
  });

  test('a real date is untouched', () => {
    expect(visibleText(render({ ...MAXIMAL, last_sale_date: '2022-05-13' }))).toContain(
      'May 13, 2022'
    );
  });
});
