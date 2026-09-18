import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HighLevelInvalidNotice,
  HighLevelStatusBadge,
} from '@/components/integrations/HighLevelConnectionStatus';
import {
  HIGHLEVEL_REMEDIATION,
  highLevelConnectionState,
} from '@/lib/highlevel/connectionState';

/**
 * The badge is the whole customer-facing point of this phase: a user whose key
 * HighLevel refused has to be able to SEE it. A static render is the entire
 * harness here, no jsdom and no testing library, the same shape as
 * app/(dashboard)/trace/single/__tests__/page.test.tsx.
 *
 * `>Connected<` is asserted rather than `Connected`, because "Not Connected"
 * contains "Connected" and a substring check would pass on the opposite state.
 */

const STORED = { highlevel_api_key: 'key-1', highlevel_location_id: 'loc-1' };

function badge(profile: Parameters<typeof highLevelConnectionState>[0]) {
  return renderToStaticMarkup(<HighLevelStatusBadge state={highLevelConnectionState(profile)} />);
}

function notice(profile: Parameters<typeof highLevelConnectionState>[0]) {
  return renderToStaticMarkup(<HighLevelInvalidNotice state={highLevelConnectionState(profile)} />);
}

describe('the badge', () => {
  it('says Connected only when nothing has flagged the credential', () => {
    const markup = badge({ ...STORED, highlevel_invalid_at: null });
    expect(markup).toContain('data-hl-status="connected"');
    expect(markup).toContain('>Connected<');
  });

  it('does NOT say Connected when the credential is flagged invalid', () => {
    // This is the bug. Two non-empty strings used to be the entire test, so a
    // revoked key stayed green forever.
    const markup = badge({
      ...STORED,
      highlevel_invalid_at: '2026-09-18T10:00:00.000Z',
      highlevel_invalid_reason: 'token',
    });
    expect(markup).toContain('data-hl-status="invalid"');
    expect(markup).not.toContain('>Connected<');
  });

  it('renders a state distinct from Not Connected, because they need different actions', () => {
    const invalid = badge({
      ...STORED,
      highlevel_invalid_at: '2026-09-18T10:00:00.000Z',
      highlevel_invalid_reason: 'scope',
    });
    const absent = badge({ highlevel_api_key: null, highlevel_location_id: null });

    expect(invalid).toContain('data-hl-status="invalid"');
    expect(absent).toContain('data-hl-status="not_connected"');
    expect(absent).toContain('>Not Connected<');
    expect(invalid).not.toContain('>Not Connected<');
  });
});

describe('the notice under it names the fix for the reason that was stored', () => {
  it.each(['token', 'scope', 'location', 'unknown'] as const)(
    'reason %s renders its own remediation',
    (reason) => {
      const markup = notice({
        ...STORED,
        highlevel_invalid_at: '2026-09-18T10:00:00.000Z',
        highlevel_invalid_reason: reason,
      });
      expect(markup).toContain(HIGHLEVEL_REMEDIATION[reason]);
    }
  );

  it('renders nothing when the credential is healthy', () => {
    expect(notice({ ...STORED, highlevel_invalid_at: null })).toBe('');
  });

  it('renders nothing when there is no credential at all', () => {
    expect(notice({ highlevel_api_key: null, highlevel_location_id: null })).toBe('');
  });
});
