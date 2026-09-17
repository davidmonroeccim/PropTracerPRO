import { afterEach, describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FullTraceDisclosure } from '@/components/trace/FullTraceDisclosure';
import { chargePerRecord } from '@/lib/suite/pricing';
import { PRICING } from '@/lib/constants';
import type { EntitlementProfile } from '@/lib/suite/entitlements';

/**
 * What this pins: a customer is never shown a price they will not be charged.
 *
 * Tier 2 bills per RECORD SUBMITTED and bills a total miss too, so this
 * disclosure is the only thing standing between a blank owner name and a
 * silent charge for nothing. Two failure modes are tested to death here:
 * the disclosure going missing, and the disclosure quoting the wrong column
 * of the price table.
 */

const FLAG = 'NEXT_PUBLIC_SUITE_SIGNIN_ENABLED';
const originalFlag = process.env[FLAG];
afterEach(() => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

const PAYG: EntitlementProfile = {
  subscription_tier: 'wallet',
  is_acquisition_pro_member: false,
  gateway_products: [],
};
const NATIVE_PRO: EntitlementProfile = { ...PAYG, subscription_tier: 'pro' };
const ACQ_PRO: EntitlementProfile = { ...PAYG, is_acquisition_pro_member: true };
const GRANT_HOLDER: EntitlementProfile = { ...PAYG, gateway_products: ['prop-tracer-pro'] };

/** Visible text, with markup, HTML comments and JSX indentation removed. */
function visibleText(markup: string): string {
  return markup
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function render(ownerName: string, profile: EntitlementProfile | null): string {
  return visibleText(
    renderToStaticMarkup(<FullTraceDisclosure ownerName={ownerName} profile={profile} />)
  );
}

/** The dollar figure the customer actually reads, or null if the copy quotes none. */
function quotedRate(text: string): string | null {
  const match = text.match(/\$(\d+\.\d{2})/);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ *
 * Presence: it shows exactly when the route would bill tier 2
 * ------------------------------------------------------------------ */

describe('when the disclosure appears', () => {
  test('appears when the owner name is empty', () => {
    expect(render('', PAYG)).toContain('Full Property Trace');
  });

  test('appears when the owner name is whitespace only', () => {
    // isFullPropertyTrace() trims, so "   " is blank to the biller. It has to be
    // blank to the disclosure as well or the charge arrives unannounced.
    expect(render('   ', PAYG)).toContain('Full Property Trace');
  });

  test('disappears once the owner name is filled in', () => {
    expect(
      renderToStaticMarkup(<FullTraceDisclosure ownerName="John Smith" profile={PAYG} />)
    ).toBe('');
  });

  test('disappears for an entity owner name too', () => {
    expect(
      renderToStaticMarkup(<FullTraceDisclosure ownerName="Bhf L L C" profile={PAYG} />)
    ).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * The number: the caller's own rate, never a constant
 * ------------------------------------------------------------------ */

describe('the rate it quotes', () => {
  test('Pay-As-You-Go is quoted the wallet tier 2 rate', () => {
    expect(quotedRate(render('', PAYG))).toBe(
      PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET.toFixed(2)
    );
  });

  test('Pro is quoted the pro tier 2 rate', () => {
    expect(quotedRate(render('', NATIVE_PRO))).toBe(
      PRICING.TIER2_PER_RECORD_SUBMITTED_PRO.toFixed(2)
    );
  });

  test('AcquisitionPRO is quoted the pro tier 2 rate', () => {
    expect(quotedRate(render('', ACQ_PRO))).toBe(
      PRICING.TIER2_PER_RECORD_SUBMITTED_PRO.toFixed(2)
    );
  });

  test('a gateway grant-holder is quoted the pro rate while Suite sign-in is on', () => {
    process.env[FLAG] = 'true';
    expect(quotedRate(render('', GRANT_HOLDER))).toBe(
      PRICING.TIER2_PER_RECORD_SUBMITTED_PRO.toFixed(2)
    );
  });

  test('kill-switch: the same grant-holder is quoted the wallet rate when Suite is off', () => {
    delete process.env[FLAG];
    expect(quotedRate(render('', GRANT_HOLDER))).toBe(
      PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET.toFixed(2)
    );
  });

  // THE ONE THAT MATTERS. Not "does it equal 0.40", which a hardcoded 0.40
  // also passes, but "does it equal what the route will actually deduct from
  // this profile". Point the component at a literal and every row fails.
  test('the quoted figure is chargePerRecord() for that profile, not a constant', () => {
    for (const profile of [PAYG, NATIVE_PRO, ACQ_PRO]) {
      expect(quotedRate(render('', profile))).toBe(chargePerRecord(profile).toFixed(2));
    }
  });

  test('the plans are not quoted the same number', () => {
    // Guards the failure this whole slice exists to prevent: showing $0.25 to
    // someone who is about to be charged $0.40.
    const payg = quotedRate(render('', PAYG));
    const pro = quotedRate(render('', NATIVE_PRO));
    expect(payg).not.toBe(pro);
    expect(render('', PAYG)).not.toContain(`$${pro}`);
    expect(render('', NATIVE_PRO)).not.toContain(`$${payg}`);
  });
});

/* ------------------------------------------------------------------ *
 * No profile: an honest sentence with no number
 * ------------------------------------------------------------------ */

describe('before the profile has loaded', () => {
  test('quotes no figure at all', () => {
    expect(quotedRate(render('', null))).toBeNull();
  });

  test('still says the charge applies, and points at billing', () => {
    const text = render('', null);
    expect(text).toContain('your per-record rate');
    expect(text).toContain('whether or not we come back with contacts');
    expect(
      renderToStaticMarkup(<FullTraceDisclosure ownerName="" profile={null} />)
    ).toContain('/settings/billing');
  });
});

/* ------------------------------------------------------------------ *
 * What the copy has to say, and how it has to read
 * ------------------------------------------------------------------ */

describe('the copy', () => {
  test('names the feature, the lookup, and the charge-on-a-miss', () => {
    expect(render('', PAYG)).toBe(
      'No owner name, so this runs as a Full Property Trace. We go find the owner of record and ' +
        'pull the full property record for this address. Your rate is $0.40 per record, and you ' +
        'are charged whether or not we come back with contacts.'
    );
  });

  test('carries no em-dashes, en-dashes, asterisks or smart quotes', () => {
    for (const profile of [PAYG, NATIVE_PRO, null]) {
      expect(render('', profile)).not.toMatch(/[‐-―‘’“”*]/);
    }
  });
});
