import type { HighLevelCredentialReason } from '@/lib/highlevel/client';

/**
 * WHAT "CONNECTED" IS ALLOWED TO MEAN.
 *
 * It used to mean `!!(highlevel_api_key && highlevel_location_id)`: two
 * non-empty strings. Typing `x` and `y` and pressing Save produced a permanent
 * green badge, and a key HighLevel had revoked stayed green forever because
 * nothing ever looked.
 *
 * There are three states, not two, and the third is the point of this file. A
 * credential nobody has entered and a credential HighLevel refused need
 * completely different things from the user, so they cannot share a badge.
 *
 * This module is imported by a client component, so it holds no server code and
 * reaches nothing. The write side lives in lib/highlevel/credentialHealth.ts.
 */

export type HighLevelConnectionState =
  | { status: 'not_connected' }
  | { status: 'connected' }
  | { status: 'invalid'; reason: HighLevelCredentialReason; remediation: string };

/**
 * One sentence per reason, and each names a DIFFERENT fix. This is why the
 * migration stores a reason at all: a revoked token and a missing scope are
 * both 401, so a status-only design would tell a user with an unticked scope to
 * re-paste a token that is perfectly fine.
 *
 * Scope wording note: HighLevel lets you edit the scopes on an existing private
 * integration, so a wrong tick does not mean generating a new token. Saying so
 * saves the user a step they do not need.
 */
export const HIGHLEVEL_REMEDIATION: Record<HighLevelCredentialReason, string> = {
  token:
    'HighLevel rejected this API key the last time we pushed a contact. Paste a new key and save it again.',
  scope:
    'This token is missing the contacts.write permission, so HighLevel refuses every contact we send. Open the integration in HighLevel, add that permission, and save here again.',
  location:
    'This token does not have access to this location ID. Check the location ID in HighLevel and save it again.',
  unknown:
    'HighLevel refused this connection the last time we pushed a contact and did not say why. Run Test Connection, and if it passes, save your key again.',
};

const REASONS: readonly HighLevelCredentialReason[] = ['token', 'scope', 'location', 'unknown'];

/**
 * The column is plain text and a future writer could put anything in it.
 * Inventing a specific remediation from a value we do not recognise is exactly
 * the instruction most likely to be wrong, so an unrecognised value degrades to
 * the generic sentence (repo rule 7).
 */
function reasonOf(stored: string | null | undefined): HighLevelCredentialReason {
  return REASONS.find((r) => r === stored) ?? 'unknown';
}

export interface HighLevelProfileColumns {
  highlevel_api_key?: string | null;
  highlevel_location_id?: string | null;
  highlevel_invalid_at?: string | null;
  highlevel_invalid_reason?: string | null;
}

export function highLevelConnectionState(
  profile: HighLevelProfileColumns | null | undefined
): HighLevelConnectionState {
  if (!profile?.highlevel_api_key || !profile?.highlevel_location_id) {
    return { status: 'not_connected' };
  }

  // `highlevel_invalid_at` IS the flag. The reason only describes it, so a
  // reason left behind with no timestamp does not flag a working credential.
  if (!profile.highlevel_invalid_at) return { status: 'connected' };

  const reason = reasonOf(profile.highlevel_invalid_reason);
  return { status: 'invalid', reason, remediation: HIGHLEVEL_REMEDIATION[reason] };
}
