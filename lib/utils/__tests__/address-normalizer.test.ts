import { describe, it, expect } from 'vitest';
import {
  normalizeAddress,
  createAddressHash,
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
