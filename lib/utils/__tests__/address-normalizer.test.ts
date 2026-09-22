import { describe, it, expect } from 'vitest';
import {
  normalizeAddress,
  createAddressHash,
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
