import { describe, expect, it } from 'vitest';
import {
  BLOCKED_PROPERTY_RECORD_KEYS,
  toPublicPropertyRecord,
} from '@/lib/trace/publicPropertyRecord';
import entityHitAddress from '@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json';
import individualHit from '@/lib/tracerfy/__tests__/fixtures/individual-hit.json';
import twoOwnerHit from '@/lib/tracerfy/__tests__/fixtures/two-owner-hit.json';

/**
 * The filter that stands between the raw dossier and every customer.
 *
 * The fixtures are the committed, sanitized dossiers. The real ones live in a
 * gitignored directory holding purchased data on real people and are never read
 * by a test.
 */

const FIXTURE = (entityHitAddress as { response: { property: Record<string, unknown> } }).response
  .property;

const OTHER_FIXTURES = [individualHit, twoOwnerHit].map(
  (f) => (f as { response: { property: Record<string, unknown> } }).response.property
);

describe('the blocked list itself', () => {
  it('is the 6 provably-wrong fields plus the 15 propensity keys, and nothing else', () => {
    expect(BLOCKED_PROPERTY_RECORD_KEYS).toHaveLength(21);
    expect([...BLOCKED_PROPERTY_RECORD_KEYS].sort()).toEqual(
      [
        'corporate_owned',
        'equity_percent',
        'estimated_equity',
        'estimated_value',
        'free_clear',
        'high_equity',
        'hvac_renovate_propensity_category',
        'hvac_renovate_propensity_factors',
        'hvac_renovate_propensity_score',
        'refi_propensity_category',
        'refi_propensity_factors',
        'refi_propensity_score',
        'roof_renovate_propensity_category',
        'roof_renovate_propensity_factors',
        'roof_renovate_propensity_score',
        'sell_propensity_category',
        'sell_propensity_factors',
        'sell_propensity_score',
        'solar_renovate_propensity_category',
        'solar_renovate_propensity_factors',
        'solar_renovate_propensity_score',
      ].sort()
    );
  });

  it('names 21 keys that the vendor actually sends', () => {
    // A blocked key with a typo in it blocks NOTHING and looks exactly like a
    // key that is doing its job. This is the test that catches that, and it is
    // also the test that catches the vendor RENAMING one of the six: the
    // renamed field would start flowing to customers, and the old name would
    // sit in the list above blocking an object that no longer has it.
    const present = Object.keys(FIXTURE);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(present, `${key} is not a key this vendor sends`).toContain(key);
    }
  });

  it('claims the WHOLE propensity family, so a new score cannot slip through', () => {
    // A denylist's one failure mode: the vendor ships flip_propensity_score
    // next quarter and it flows straight to a customer because nobody thought
    // to add it. Every key in the family is checked against the list, on every
    // fixture, so an addition is a decision somebody makes rather than a
    // default. Same reasoning as the equity family below it.
    for (const property of [FIXTURE, ...OTHER_FIXTURES]) {
      const family = Object.keys(property).filter((k) => /propensity|renovate/.test(k));
      expect(family).toHaveLength(15);
      for (const key of family) {
        expect(BLOCKED_PROPERTY_RECORD_KEYS, `${key} is not blocked`).toContain(key);
      }
    }
  });

  it('does NOT block price_per_sqft, which was moved out on purpose', () => {
    // It is last_sale_price / building_size_sqft, not assessed-value math. It
    // was blocked on a redundancy argument, never a correctness one, and
    // merging those two arguments is what put it in this list by mistake.
    expect(BLOCKED_PROPERTY_RECORD_KEYS).not.toContain('price_per_sqft');
    expect(toPublicPropertyRecord(FIXTURE)).toHaveProperty('price_per_sqft');
  });
});

describe('toPublicPropertyRecord', () => {
  it('turns the vendor 86 into the 65 a customer receives', () => {
    expect(Object.keys(FIXTURE)).toHaveLength(86);
    const published = toPublicPropertyRecord(FIXTURE)!;
    expect(Object.keys(published)).toHaveLength(65);
  });

  it('removes every blocked key and keeps every other one, in order', () => {
    const published = toPublicPropertyRecord(FIXTURE)!;
    expect(Object.keys(published)).toEqual(
      Object.keys(FIXTURE).filter(
        (k) => !(BLOCKED_PROPERTY_RECORD_KEYS as readonly string[]).includes(k)
      )
    );
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(published).not.toHaveProperty(key);
    }
  });

  it('carries the surviving values through untouched', () => {
    const published = toPublicPropertyRecord(FIXTURE)!;
    for (const [key, value] of Object.entries(published)) {
      expect(value).toEqual(FIXTURE[key]);
    }
  });

  it('passes a key it has never seen straight through', () => {
    // A denylist on purpose: a field the vendor adds tomorrow reaches the
    // customer rather than being silently swallowed. Same bargain as raw
    // storage.
    const published = toPublicPropertyRecord({ ...FIXTURE, brand_new_county_field: 'kept' })!;
    expect(published.brand_new_county_field).toBe('kept');
  });

  it('DOES NOT MUTATE the record it was handed', () => {
    // MUTATION: change the implementation to `delete copy[key]` on the argument
    // itself and this goes red. It is a storage guarantee, not a style rule:
    // both submit routes persist the raw record and return the filtered one
    // from the SAME variable, so an in-place delete writes a 65-key row to
    // trace_history and destroys the raw dump the product is built on.
    const record: Record<string, unknown> = { ...FIXTURE };
    const before = JSON.parse(JSON.stringify(record));

    toPublicPropertyRecord(record);

    expect(Object.keys(record)).toHaveLength(86);
    expect(record).toEqual(before);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(record).toHaveProperty(key);
    }
  });

  it('returns a new object rather than the one it was given', () => {
    const record = { ...FIXTURE };
    expect(toPublicPropertyRecord(record)).not.toBe(record);
  });

  it('reports an absent record as null, never as an empty object', () => {
    // An empty object would read as "the county published nothing about this
    // parcel", which is a claim. null is the absence of a claim.
    expect(toPublicPropertyRecord(null)).toBeNull();
    expect(toPublicPropertyRecord(undefined)).toBeNull();
    expect(toPublicPropertyRecord([])).toBeNull();
    expect(toPublicPropertyRecord([FIXTURE])).toBeNull();
    expect(toPublicPropertyRecord('')).toBeNull();
    expect(toPublicPropertyRecord('a string where an object was expected')).toBeNull();
    expect(toPublicPropertyRecord(0)).toBeNull();
    expect(toPublicPropertyRecord(true)).toBeNull();
  });

  it('keeps an empty object empty rather than inventing keys', () => {
    expect(toPublicPropertyRecord({})).toEqual({});
  });

  it('filters the other sanitized dossiers to 65 as well', () => {
    for (const property of OTHER_FIXTURES) {
      expect(Object.keys(property)).toHaveLength(86);
      expect(Object.keys(toPublicPropertyRecord(property)!)).toHaveLength(65);
    }
  });
});
