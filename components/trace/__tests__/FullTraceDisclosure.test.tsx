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

/** The opt-in path: the caller has the owner and ticked the property record box. */
function renderOptIn(ownerName: string, profile: EntitlementProfile | null): string {
  return visibleText(
    renderToStaticMarkup(
      <FullTraceDisclosure ownerName={ownerName} profile={profile} fullPropertyTrace />
    )
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

  // THE OPT-IN TRIGGER. isFullPropertyTrace() bills tier 2 on EITHER a blank
  // owner name or full_property_trace: true, so a disclosure that only watches
  // the owner name lets the second trigger charge the customer in silence.
  test('appears when the owner name is filled in but the property record was asked for', () => {
    expect(renderOptIn('John Smith', PAYG)).toContain('Full Property Trace');
  });

  test('appears on the opt-in for an entity owner name too', () => {
    expect(renderOptIn('Storage Trust Properties, L.P.', PAYG)).toContain('Full Property Trace');
  });

  test('the opt-in quotes the same tier 2 rate as the blank-owner case', () => {
    expect(quotedRate(renderOptIn('John Smith', PAYG))).toBe(
      PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET.toFixed(2)
    );
    expect(quotedRate(renderOptIn('John Smith', NATIVE_PRO))).toBe(
      PRICING.TIER2_PER_RECORD_SUBMITTED_PRO.toFixed(2)
    );
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

  test('the opt-in case opens with its own sentence, not the no-owner one', () => {
    const text = renderOptIn('John Smith', PAYG);
    // Telling a customer who just typed an owner name that there is no owner
    // name reads as a bug and undermines the price that follows it.
    expect(text).not.toContain('No owner name');
    expect(text).toBe(
      'You asked for the property record, so this runs as a Full Property Trace. We pull the ' +
        'full property record for this address and find contacts for the owner of record. Your ' +
        'rate is $0.40 per record, and you are charged whether or not we come back with contacts.'
    );
  });

  test('both cases carry the charge-on-a-miss rule, and only one price sentence', () => {
    for (const text of [render('', PAYG), renderOptIn('John Smith', PAYG)]) {
      expect(text).toContain('charged whether or not we come back with contacts');
      expect(text.match(/\$\d+\.\d{2}/g)).toHaveLength(1);
    }
  });

  test('both cases still derive the figure from the profile, not a literal', () => {
    for (const profile of [PAYG, NATIVE_PRO, ACQ_PRO]) {
      const expected = chargePerRecord(profile).toFixed(2);
      expect(quotedRate(render('', profile))).toBe(expected);
      expect(quotedRate(renderOptIn('John Smith', profile))).toBe(expected);
    }
    expect(quotedRate(renderOptIn('John Smith', null))).toBeNull();
  });

  // Escaped rather than literal so an editor that helpfully curls a quote
  // cannot quietly change which characters this test bans.
  const SLOP = /[\u2010-\u2015\u2018\u2019\u201C\u201D*]/;

  test('carries no em-dashes, en-dashes, asterisks or smart quotes', () => {
    for (const profile of [PAYG, NATIVE_PRO, null]) {
      expect(render('', profile)).not.toMatch(SLOP);
      expect(renderOptIn('John Smith', profile)).not.toMatch(SLOP);
    }
  });
});
