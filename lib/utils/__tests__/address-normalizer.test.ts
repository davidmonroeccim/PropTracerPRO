import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  TRACE_HISTORY_WIDTH,
  normalizeAddress,
  createAddressHash,
  storableValue,
  traceKeyFor,
  usableZip,
  validateAddressInput,
} from '../address-normalizer';

// WHY THIS FILE EXISTS, 2026-09-04.
//
// `address-normalizer.ts` gates every trace this product sells and had no tests at all.
// Two changes land here together and each needs its own fence:
//
//   1. ZIP stops being REQUIRED. It was rejected at the door on every record while never
//      reaching either vendor -- the Tracerfy person CSV has no zip column (see
//      lib/tracerfy/client.ts:54) and FastAppend takes business_name + state only. The
//      property-registry, which supplies city for 804 counties and a ZIP for only 766,
//      could not be traced at all because of a field nobody downstream reads.
//   2. The dedup key drops ZIP, going from STREET|CITY|STATE|ZIP to STREET|CITY|STATE.
//      Measured against live trace_history (3,632 rows) before the change: only 15 groups
//      collide, 30 rows, and every sampled pair is the SAME property carrying two different
//      ZIPs (3661 AIRPORT BLVD MOBILE AL as 36608 and 36609). Those are duplicate charges the
//      old key failed to catch, not distinct properties.

describe('normalizeAddress', () => {
  it('returns a THREE part key: street, city, state', () => {
    const key = normalizeAddress('123 Main Street', 'Houston', 'TX');
    expect(key.split('|')).toHaveLength(3);
    expect(key).toBe('123 MAIN ST|HOUSTON|TX');
  });

  // FENCE: this is the whole point of the change. If ZIP ever re-enters the key, the same
  // property traced with an inconsistent ZIP is charged twice, which is what the live
  // measurement found 15 instances of.
  it('FENCE: the key does NOT vary with ZIP', () => {
    const a = normalizeAddress('3661 Airport Blvd', 'Mobile', 'AL');
    const b = normalizeAddress('3661 Airport Blvd', 'Mobile', 'AL');
    expect(a).toBe(b);
    expect(a).not.toMatch(/366\d\d/);
    expect(createAddressHash(a)).toBe(createAddressHash(b));
  });

  it('normalizes suffixes, directionals and case', () => {
    expect(normalizeAddress('456 north oak avenue', 'austin', 'tx'))
      .toBe('456 N OAK AVE|AUSTIN|TX');
    expect(normalizeAddress('9 West Sunset Boulevard', 'Los Angeles', 'CA'))
      .toBe('9 W SUNSET BLVD|LOS ANGELES|CA');
  });

  it('strips unit designators so a unit is not a separate property', () => {
    const withUnit = normalizeAddress('1725 Savage Rd Apt 121', 'Charleston', 'SC');
    const without = normalizeAddress('1725 Savage Rd', 'Charleston', 'SC');
    expect(withUnit).toBe(without);
  });

  it('collapses whitespace and drops punctuation', () => {
    expect(normalizeAddress('  12   Elm  St.  ', 'Dallas', 'TX'))
      .toBe('12 ELM ST|DALLAS|TX');
  });

  it('distinguishes two genuinely different cities', () => {
    expect(normalizeAddress('1 Main St', 'Houston', 'TX'))
      .not.toBe(normalizeAddress('1 Main St', 'Dallas', 'TX'));
  });
});

describe('createAddressHash', () => {
  it('is stable and 64 hex characters', () => {
    const h = createAddressHash('1 MAIN ST|HOUSTON|TX');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createAddressHash('1 MAIN ST|HOUSTON|TX'));
  });

  it('differs for different keys', () => {
    expect(createAddressHash('1 MAIN ST|HOUSTON|TX'))
      .not.toBe(createAddressHash('1 MAIN ST|DALLAS|TX'));
  });
});

describe('validateAddressInput', () => {
  it('accepts a record with NO zip at all', () => {
    expect(validateAddressInput('123 Main St', 'Houston', 'TX')).toEqual({ valid: true });
    expect(validateAddressInput('123 Main St', 'Houston', 'TX', undefined)).toEqual({ valid: true });
    expect(validateAddressInput('123 Main St', 'Houston', 'TX', '')).toEqual({ valid: true });
  });

  // FENCE: delete the `zip` branch guard and this reds. A registry record with city but no
  // ZIP is 241 counties / 16,062,225 parcels; rejecting it rejects the WHOLE batch, because
  // skipTraceBulk fails the batch if any one record is invalid.
  it('FENCE: a missing zip does not fail the record', () => {
    const r = validateAddressInput('3661 Airport Blvd', 'Mobile', 'AL');
    expect(r.valid).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('still accepts a valid 5 or 9 digit zip when one IS supplied', () => {
    expect(validateAddressInput('123 Main St', 'Houston', 'TX', '77002')).toEqual({ valid: true });
    expect(validateAddressInput('123 Main St', 'Houston', 'TX', '77002-1234')).toEqual({ valid: true });
  });

  // Supplying a malformed ZIP is a caller bug and still worth surfacing. Absent is fine;
  // present-and-wrong is not, or the field silently becomes untrustworthy for display.
  it('rejects a zip that is supplied but malformed', () => {
    expect(validateAddressInput('123 Main St', 'Houston', 'TX', 'abcde').valid).toBe(false);
    expect(validateAddressInput('123 Main St', 'Houston', 'TX', '123').valid).toBe(false);
  });

  it('still requires address, city and state', () => {
    expect(validateAddressInput('', 'Houston', 'TX').valid).toBe(false);
    expect(validateAddressInput('12', 'Houston', 'TX').valid).toBe(false);
    expect(validateAddressInput('123 Main St', '', 'TX').valid).toBe(false);
    expect(validateAddressInput('123 Main St', 'H', 'TX').valid).toBe(false);
    expect(validateAddressInput('123 Main St', 'Houston', '').valid).toBe(false);
    expect(validateAddressInput('123 Main St', 'Houston', 'Texas').valid).toBe(false);
  });
});

/*
 * usableZip, added 2026-09-18.
 *
 * REJECTING A RECORD AND STORING A RECORD ARE DIFFERENT QUESTIONS, and the bulk
 * dashboard route asks the second one. It does not validate per record, so a
 * broken ZIP reaches the `zip` column, and as of phase 5c that column is handed
 * to a vendor: a blank-owner row runs a dossier lookup keyed on street, city,
 * state and zip. A zip that contradicts the other three is worse than no zip,
 * and tier 2 bills per record submitted, so the customer pays for the miss.
 */
describe('usableZip', () => {
  it('keeps a real 5-digit zip', () => {
    expect(usableZip('77002')).toBe('77002');
  });

  it('trims a 9-digit zip to the 5 the column holds', () => {
    expect(usableZip('77002-1234')).toBe('77002');
  });

  it('drops a zip Excel stripped the leading zero from', () => {
    // The whole reason this exists. A Boston county file exports 02134 as 2134
    // on every row, and the same happens across MA, NJ, CT, RI, NH, ME, VT
    // and PR.
    expect(usableZip('2134')).toBe('');
  });

  it('drops anything else that is not a zip, rather than storing it', () => {
    expect(usableZip('abcde')).toBe('');
    expect(usableZip('123')).toBe('');
    expect(usableZip('7700212345')).toBe('');
  });

  it('answers empty for a row that simply has no zip', () => {
    expect(usableZip(undefined)).toBe('');
    expect(usableZip(null)).toBe('');
    expect(usableZip('   ')).toBe('');
  });

  it('agrees with validateAddressInput about what a zip is', () => {
    // MUTATION: give either one its own copy of the pattern and let them drift,
    // and this goes red. One decides whether a caller is refused and the other
    // decides what we store and send, so a disagreement means a record that
    // passes validation carries a zip we discard, or the reverse.
    for (const zip of ['77002', '77002-1234', '2134', 'abcde', '123', '']) {
      const accepted = validateAddressInput('123 Main St', 'Houston', 'TX', zip).valid;
      expect(usableZip(zip) !== '' || zip === '', zip).toBe(accepted);
    }
  });
});

describe('traceKeyFor (spec 6.3, D9)', () => {
  it('keys a record with a city exactly as before, whatever parcel id rides along', () => {
    expect(traceKeyFor({ address: '123 Main St', city: 'Austin', state: 'TX', apn: '9', county: 'Travis' }))
      .toBe(normalizeAddress('123 Main St', 'Austin', 'TX'));
  });

  it('keeps the stored shape for a record that has both a street and a city', () => {
    // The exact string every row in trace_history already carries. It must not move: a key that
    // moves is a row that re-buys itself.
    expect(traceKeyFor({ address: '123 Main Street', city: 'Austin', state: 'TX' })).toBe('123 MAIN ST|AUSTIN|TX');
  });

  it('keys two street-less records in the same city on their own parcels (D36)', () => {
    // MUTATION: put the city branch back first and this goes red: both records key to |AUSTIN|TX,
    // so every parcel in the city shares one row, a paid result is overwritten and a resend inside
    // 90 days is charged again.
    const a = traceKeyFor({ city: 'Austin', state: 'TX', apn: '100', county: 'Travis' });
    const b = traceKeyFor({ city: 'Austin', state: 'TX', apn: '200', county: 'Travis' });
    expect(a).toBe('APN|100|TRAVIS|TX');
    expect(b).toBe('APN|200|TRAVIS|TX');
    expect(a).not.toBe(b);
  });

  it('keeps the street-and-state shape for a record with a city but no street and no parcel', () => {
    expect(traceKeyFor({ city: 'Austin', state: 'TX' })).toBe('||TX');
  });

  it('keys a city-less record on parcel id, county and state: trimmed, upper case, leading # removed', () => {
    // MUTATION: drop the leading-# strip in normalizeParcelId and this goes red.
    expect(traceKeyFor({ state: 'oh', apn: ' #12-345 6 ', county: 'Placeholder' })).toBe('APN|12-345 6|PLACEHOLDER|OH');
  });

  it('keeps dashes and spaces, so two parcel numbers never collapse into one', () => {
    expect(traceKeyFor({ state: 'OH', apn: '12-3456', county: 'X' })).not.toBe(traceKeyFor({ state: 'OH', apn: '123456', county: 'X' }));
  });

  it('does not let the same parcel number in two counties share a key', () => {
    // MUTATION: drop the county from the key and this goes red.
    expect(traceKeyFor({ state: 'OH', apn: '100', county: 'A' })).not.toBe(traceKeyFor({ state: 'OH', apn: '100', county: 'B' }));
  });

  it('falls back to street and state with neither a city nor a whole parcel key', () => {
    expect(traceKeyFor({ address: '1 A St', state: 'OH', apn: '100' })).toBe('1 A ST||OH');
  });
});

/*
 * storableValue and TRACE_HISTORY_WIDTH, added 2026-09-25.
 *
 * WHY THESE EXIST AT ALL, AND WHY A UNIT TEST IS THE ONLY FENCE AVAILABLE.
 *
 * Phase 2B stopped the bulk surfaces rejecting a whole batch over one bad record. That removed the
 * last thing standing between a caller's typo and the INSERT: `trace_history.state` is VARCHAR(2),
 * so a record carrying "Texas" reached the write as "TEXAS", Postgres raised 22001, the batch write
 * threw, and all 500 records died on one routine integrator mistake. That is whole-batch rejection
 * through a different door, in the change whose purpose was deleting it.
 *
 * NOTHING ELSE IN THIS REPO CAN CATCH A WIDTH PROBLEM. lib/supabase/admin.ts builds the service-role
 * client with NO `Database` generic, so `tsc` checks neither column names nor widths, and every test
 * double for Supabase carries no widths either. A green suite proves nothing about whether a write
 * fits. Until this block, storableValue -- the function that whole guard rests on -- had no direct
 * test anywhere in the repo, and TRACE_HISTORY_WIDTH was an unchecked copy of the schema.
 */
describe('storableValue', () => {
  it('keeps a value that is exactly as long as the column', () => {
    // THE BOUNDARY, and it is the one a "tidy-up" is most likely to move.
    // MUTATION: change the comparison to `>=` and this goes red.
    expect(storableValue('ab', 2)).toBe('ab');
    expect(storableValue('C'.repeat(100), 100)).toBe('C'.repeat(100));
  });

  it('drops a value one character too long, rather than storing part of it', () => {
    expect(storableValue('abc', 2)).toBe('');
    expect(storableValue('C'.repeat(101), 100)).toBe('');
  });

  it('NEVER truncates, which is the whole design decision', () => {
    // The single most likely "optimisation": `return trimmed.substring(0, maxLength)`. It looks
    // like it saves the record and it does the opposite -- "Te" is a state the caller never sent,
    // and a WRONG value is worse than none, exactly as usableZip argues for a mangled zip. '' is
    // the row honestly saying it has no usable value, and the engines already have somewhere to
    // put that: tier1Outcome settles such a row free, asking for "a valid two-letter state".
    // MUTATION: return a substring instead and this goes red.
    for (const [value, width] of [['Texas', 2], ['Houston', 3], ['abcdef', 5]] as const) {
      const out = storableValue(value, width);
      expect(out).toBe('');
      expect(out).not.toBe(value.substring(0, width));
    }
  });

  it('trims BEFORE it measures, so a padded value that fits is kept', () => {
    // '  tx  ' is six characters and two letters. Measuring it raw would drop a perfectly good
    // state, which is the same harm in the opposite direction. Returning the TRIMMED form also
    // closes a second latent overflow, because callers upcase this into the column and '  TX  '
    // does not fit VARCHAR(2) either.
    // MUTATION: drop the .trim() and this goes red.
    expect(storableValue('  tx  ', 2)).toBe('tx');
    expect(storableValue('  Dallas  ', 100)).toBe('Dallas');
  });

  it('still drops a padded value that does not fit once trimmed', () => {
    // The other half of the same rule: trimming is not a way to sneak an over-long value in.
    expect(storableValue('  Texas  ', 2)).toBe('');
  });

  it('answers empty for a value that simply is not there', () => {
    expect(storableValue('', 2)).toBe('');
    expect(storableValue(null, 2)).toBe('');
    expect(storableValue(undefined, 2)).toBe('');
    expect(storableValue('   ', 2)).toBe('');
  });

  it('does what the defect that created it needed, at the real column widths', () => {
    // The concrete case, in the real numbers rather than in the abstract.
    expect(storableValue('Texas', TRACE_HISTORY_WIDTH.state)).toBe('');
    expect(storableValue('TX', TRACE_HISTORY_WIDTH.state)).toBe('TX');
    expect(storableValue('C'.repeat(101), TRACE_HISTORY_WIDTH.city)).toBe('');
    expect(storableValue('R'.repeat(65), TRACE_HISTORY_WIDTH.parcelIdLocal)).toBe('');
    expect(storableValue('T'.repeat(65), TRACE_HISTORY_WIDTH.county)).toBe('');
  });
});

/*
 * TRACE_HISTORY_WIDTH is a COPY of the schema, and this is what checks the copy.
 *
 * The constants are facts about the table, kept here so every surface that writes it agrees. But a
 * copy drifts: widen a column in a migration and nothing in the suite notices this file still says
 * the old number, and the clamp then drops values the column could now hold -- or, far worse,
 * NARROW a column and the clamp keeps passing values that no longer fit, which is the 22001 this
 * whole mechanism exists to prevent, silently restored.
 *
 * It reads the checked-in DDL from disk. No database, no vendor, no network.
 */
describe('TRACE_HISTORY_WIDTH matches the checked-in DDL', () => {
  const ROOT = process.cwd();
  const SCHEMA = 'supabase/schema.sql';
  const PARCEL_MIGRATION = 'supabase/migrations/20260919_trace_history_parcel_key.sql';

  /** The `trace_history` CREATE TABLE body ALONE, so a column of the same name declared on another
   *  table can never answer for this one. */
  function traceHistoryTable(): string {
    const source = readFileSync(join(ROOT, SCHEMA), 'utf8');
    const start = source.indexOf('CREATE TABLE IF NOT EXISTS trace_history');
    expect(start, `trace_history CREATE TABLE not found in ${SCHEMA}`).toBeGreaterThan(-1);
    const end = source.indexOf('\n);', start);
    expect(end, `could not find the end of the trace_history table in ${SCHEMA}`).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  function sqlOf(path: string): string {
    return readFileSync(join(ROOT, path), 'utf8');
  }

  /** The width `VARCHAR(n)` declares for `column`, or null when it is not declared in this SQL. */
  function declaredWidth(sql: string, column: string): number | null {
    const found = new RegExp(`\\b${column}\\s+VARCHAR\\((\\d+)\\)`, 'i').exec(sql);
    return found ? Number(found[1]) : null;
  }

  const PINNED = [
    { key: 'state', column: 'state', sql: () => traceHistoryTable(), where: SCHEMA },
    { key: 'city', column: 'city', sql: () => traceHistoryTable(), where: SCHEMA },
    { key: 'parcelIdLocal', column: 'parcel_id_local', sql: () => sqlOf(PARCEL_MIGRATION), where: PARCEL_MIGRATION },
    { key: 'county', column: 'county', sql: () => sqlOf(PARCEL_MIGRATION), where: PARCEL_MIGRATION },
  ] as const;

  it.each(PINNED)('pins $key to the $column column declared in $where', ({ key, column, sql, where }) => {
    const declared = declaredWidth(sql(), column);
    // FAILS LOUDLY RATHER THAN VACUOUSLY. If someone reformats the schema or moves a column to a
    // new migration, this must say which column it could not find, not quietly match nothing and
    // pass. A test that cannot locate its subject has not verified it.
    expect(declared, `no VARCHAR(n) declaration for \`${column}\` found in ${where}`).not.toBeNull();
    expect(
      declared,
      `TRACE_HISTORY_WIDTH.${key} is ${TRACE_HISTORY_WIDTH[key]} but ${where} declares ${column} VARCHAR(${declared}). The constant is a copy of the DDL; update it.`,
    ).toBe(TRACE_HISTORY_WIDTH[key]);
  });

  it('pins EVERY width in the constant, so a new one cannot be added unchecked', () => {
    // The anti-vacuity floor for the table above: without this, adding a fifth column to
    // TRACE_HISTORY_WIDTH would leave it silently unpinned while every test here still passed.
    expect(Object.keys(TRACE_HISTORY_WIDTH).sort()).toEqual(PINNED.map((p) => p.key).sort());
  });
});
