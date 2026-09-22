import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TraceResultCard } from '@/components/trace/TraceResultCard';
import type { TraceResult } from '@/types';

/**
 * What this pins: the two owner names are told apart.
 *
 * They are different things and they used to share one unlabelled "Owner Name"
 * heading, so a user reading "JOHN SMITH" above "STORAGE TRUST PROPERTIES, L.P."
 * had no way to know which one was the person to call and which one was the
 * name on the county roll.
 *
 *   owner_name    the CONTACT PERSON we resolved. Null for an entity with no
 *                 named principal.
 *   owner_name_2  the OWNER OF RECORD, which is what the dossier bought.
 */

const BASE: TraceResult = {
  owner_name: null,
  owner_name_2: null,
  phones: [],
  emails: [],
  mailing_address: null,
  mailing_city: null,
  mailing_state: null,
  mailing_zip: null,
  match_confidence: 0,
};

function render(result: TraceResult): string {
  return renderToStaticMarkup(
    <TraceResultCard result={result} isCached={false} charge={0.4} address="1815 S State St" />
  );
}

describe('the two owner names', () => {
  test('both are labelled for what they are', () => {
    const markup = render({
      ...BASE,
      owner_name: 'John Smith',
      owner_name_2: 'Storage Trust Properties, L.P.',
    });
    expect(markup).toContain('Contact Person');
    expect(markup).toContain('Owner of Record');
    expect(markup).toContain('John Smith');
    expect(markup).toContain('Storage Trust Properties, L.P.');
  });

  test('the contact person is named above the owner of record', () => {
    const markup = render({
      ...BASE,
      owner_name: 'John Smith',
      owner_name_2: 'Storage Trust Properties, L.P.',
    });
    expect(markup.indexOf('Contact Person')).toBeLessThan(markup.indexOf('Owner of Record'));
  });

  test('an entity with no named principal shows only the owner of record', () => {
    // The common tier 2 outcome: the county names a company and no person was
    // resolved behind it. Labelling that company "Contact Person" would be a
    // lie, and it is exactly what the old shared heading implied.
    const markup = render({ ...BASE, owner_name_2: 'Storage Trust Properties, L.P.' });
    expect(markup).toContain('Owner of Record');
    expect(markup).not.toContain('Contact Person');
  });

  test('a person with no county name shows only the contact person', () => {
    const markup = render({ ...BASE, owner_name: 'John Smith' });
    expect(markup).toContain('Contact Person');
    expect(markup).not.toContain('Owner of Record');
  });

  test('the copy buttons still exist, one per name', () => {
    const markup = render({
      ...BASE,
      owner_name: 'John Smith',
      owner_name_2: 'Storage Trust Properties, L.P.',
    });
    expect(markup.split('lucide-copy').length - 1).toBe(2);
  });
});

describe('when nothing came back', () => {
  test('shows the real reason, not the three generic guesses', () => {
    // MUTATION: put the "This may be due to" list back and this goes red.
    const markup = renderToStaticMarkup(
      <TraceResultCard
        result={null}
        isCached={false}
        charge={0}
        address="1 A St"
        skipReason="We looked this owner up by address and found no match. You were not charged."
      />
    );
    expect(markup).toContain('We looked this owner up by address and found no match. You were not charged.');
    expect(markup).not.toContain('Recently transferred');
    expect(markup).not.toContain('Address format mismatch');
  });
});

describe('Found by and the charge label', () => {
  const HIT: TraceResult = { ...BASE, owner_name: 'John Smith', phones: [{ number: '5550000101', type: 'mobile' }] };

  test('names the key that found the owner', () => {
    const markup = renderToStaticMarkup(
      <TraceResultCard result={HIT} isCached={false} charge={0.15} address="1 A St" foundBy="parcel_id" />
    );
    expect(markup).toContain('Found by: Parcel ID');
  });

  test('a zero charge that was not cached says Free, not Free (cached)', () => {
    // MUTATION: restore the unconditional 'Free (cached)' and this goes red.
    const markup = renderToStaticMarkup(<TraceResultCard result={HIT} isCached={false} charge={0} address="1 A St" />);
    expect(markup).toContain('>Free<');
    expect(markup).not.toContain('Free (cached)');
  });

  test('a cached zero charge still says Free (cached)', () => {
    const markup = renderToStaticMarkup(<TraceResultCard result={HIT} isCached={true} charge={0} address="1 A St" />);
    expect(markup).toContain('Free (cached)');
  });
});
