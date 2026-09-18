import { describe, expect, it } from 'vitest';
import {
  HIGHLEVEL_REMEDIATION,
  highLevelConnectionState,
} from '@/lib/highlevel/connectionState';

/**
 * WHY THIS FILE EXISTS. "Connected" used to be
 * `!!(profile?.highlevel_api_key && profile?.highlevel_location_id)`, so typing
 * `x` and `y` and pressing Save produced a permanent green badge. Two non-empty
 * strings are not a working credential, and a credential that HighLevel refused
 * on the last push is not a working credential either.
 *
 * The assertions are on the STATE each profile maps to and on the sentence that
 * state carries, never on two states merely differing.
 */

const CONNECTED = {
  highlevel_api_key: 'key-1',
  highlevel_location_id: 'loc-1',
  highlevel_invalid_at: null,
  highlevel_invalid_reason: null,
};

describe('a credential is not connected until both halves are stored', () => {
  it('calls a null profile not connected', () => {
    expect(highLevelConnectionState(null)).toEqual({ status: 'not_connected' });
  });

  it('calls a missing location id not connected', () => {
    expect(
      highLevelConnectionState({ ...CONNECTED, highlevel_location_id: null })
    ).toEqual({ status: 'not_connected' });
  });

  it('calls a missing api key not connected', () => {
    expect(highLevelConnectionState({ ...CONNECTED, highlevel_api_key: null })).toEqual({
      status: 'not_connected',
    });
  });

  it('calls a stored, unflagged credential connected', () => {
    expect(highLevelConnectionState(CONNECTED)).toEqual({ status: 'connected' });
  });
});

describe('a flagged credential is its own state, and it names the fix', () => {
  it.each(['token', 'scope', 'location', 'unknown'] as const)(
    'reason %s produces the invalid state carrying that reason',
    (reason) => {
      const state = highLevelConnectionState({
        ...CONNECTED,
        highlevel_invalid_at: '2026-09-18T10:00:00.000Z',
        highlevel_invalid_reason: reason,
      });

      expect(state.status).toBe('invalid');
      if (state.status !== 'invalid') throw new Error('unreachable');
      expect(state.reason).toBe(reason);
      expect(state.remediation).toBe(HIGHLEVEL_REMEDIATION[reason]);
    }
  );

  it('the four remediations are four different instructions', () => {
    // Each reason has a DIFFERENT fix: paste a new token, tick a scope, correct
    // the location id, or go and test it. Collapsing any two sends a user down
    // a path that cannot work.
    const sentences = Object.values(HIGHLEVEL_REMEDIATION);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('the scope remediation names contacts.write, because that is the missing grant', () => {
    expect(HIGHLEVEL_REMEDIATION.scope).toContain('contacts.write');
  });

  it('the location remediation talks about the location id, not the key', () => {
    expect(HIGHLEVEL_REMEDIATION.location).toContain('location ID');
    expect(HIGHLEVEL_REMEDIATION.location).not.toContain('contacts.write');
  });

  it('an unrecognised reason in the column degrades to unknown rather than guessing', () => {
    // The column is plain text and a future writer could put anything in it.
    // Inventing a specific remediation from a value we do not recognise is
    // exactly the instruction most likely to be wrong.
    const state = highLevelConnectionState({
      ...CONNECTED,
      highlevel_invalid_at: '2026-09-18T10:00:00.000Z',
      highlevel_invalid_reason: 'teapot',
    });

    expect(state.status).toBe('invalid');
    if (state.status !== 'invalid') throw new Error('unreachable');
    expect(state.reason).toBe('unknown');
    expect(state.remediation).toBe(HIGHLEVEL_REMEDIATION.unknown);
  });

  it('a flag with no reason at all still shows the invalid state', () => {
    const state = highLevelConnectionState({
      ...CONNECTED,
      highlevel_invalid_at: '2026-09-18T10:00:00.000Z',
      highlevel_invalid_reason: null,
    });
    expect(state.status).toBe('invalid');
  });

  it('a reason left behind with no timestamp does NOT flag the credential', () => {
    // `highlevel_invalid_at` is the flag. The reason is a description of it.
    expect(
      highLevelConnectionState({ ...CONNECTED, highlevel_invalid_reason: 'token' })
    ).toEqual({ status: 'connected' });
  });
});

describe('the copy rules, which are enforced and not advisory', () => {
  it('no dashes, asterisks or markdown artifacts in anything a user reads', () => {
    for (const sentence of Object.values(HIGHLEVEL_REMEDIATION)) {
      expect(sentence).not.toMatch(/[–—*_`#]/);
    }
  });
});
