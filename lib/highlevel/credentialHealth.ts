import { createAdminClient } from '@/lib/supabase/admin';
import type { HighLevelPushResult } from '@/lib/highlevel/client';
import {
  recordTracePushes,
  type HighLevelOutcome,
  type HighLevelOutcomeEntry,
} from '@/lib/highlevel/pushRecord';

/**
 * WHAT THE LAST HIGHLEVEL CALL SAID ABOUT THE CREDENTIAL.
 *
 * PTP calls HighLevel in exactly three places and a person started every one of
 * them: the Push to CRM button (app/api/integrations/highlevel/push), Save on
 * the integrations page, and Test Connection. Nothing automatic pushes any
 * more, so there is no longer a path running with nobody watching.
 *
 * The verdict is still recorded against the CREDENTIAL rather than only shown
 * in the moment, because a key that worked on Tuesday can be revoked on
 * Wednesday and the badge on the integrations page is what tells the user. A
 * push that succeeds clears the flag; a push refused for the credential sets it.
 *
 * The three columns live on `user_profiles` and `anon` and `authenticated` hold
 * no UPDATE grant on that table, which is deliberate: a user must not be able
 * to clear their own red badge from the browser. Every write here therefore
 * goes through the admin (service_role) client. See
 * supabase/migrations/20260918_highlevel_credential_health.sql.
 */

/**
 * Re-exported so a caller needs one import, not two. The entry type carries a
 * trace id alongside each outcome: see lib/highlevel/pushRecord.ts for why the
 * record of the push rides this funnel rather than one of its own.
 */
export type { HighLevelOutcome, HighLevelOutcomeEntry };

type CredentialFailure = Extract<HighLevelPushResult, { kind: 'credential' }>;

export type HighLevelVerdict =
  | { kind: 'dead'; failure: CredentialFailure }
  | { kind: 'healthy' }
  | { kind: 'no_signal' };

/**
 * THE GATE, AND IT IS L-007 POINTED AT PUSHES. All three failure classes are
 * `success: false` and the next reader will see three false-y values and want
 * to merge them. Do not. They answer three different questions:
 *
 *   credential  401, 403        the stored key is dead for EVERY future push.
 *                               Mark it, because nobody will otherwise find out.
 *   record      400, 404, 422   THIS payload was refused. The credential is
 *                               fine and every other record will still push.
 *                               Marking it dead sends the user to reconnect a
 *                               key that works.
 *   transient   429, 5xx, throw nothing is broken. A retry is the answer, and
 *                               "your key is dead" would be a lie.
 *
 * Only the credential class says anything about the credential, so only it
 * writes. And note the asymmetry: "not dead" is not "alive". A batch of nothing
 * but rate limits is `no_signal`, not `healthy`, because clearing a red badge
 * requires evidence the key WORKS, which only a success provides.
 */
export function highLevelVerdict(
  outcomes: ReadonlyArray<HighLevelOutcome | undefined>
): HighLevelVerdict {
  let healthy = false;

  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (outcome.success) {
      healthy = true;
      continue;
    }
    // A credential complaint anywhere in a batch wins over any number of
    // successes beside it: it is the outcome that keeps failing until somebody
    // acts on it, and it is the one the user has to hear about.
    if (outcome.kind === 'credential') return { kind: 'dead', failure: outcome };
  }

  return healthy ? { kind: 'healthy' } : { kind: 'no_signal' };
}

/**
 * Record what a run of HighLevel calls said about the credential, and record on
 * each trace row that it reached the CRM.
 *
 * TWO INDEPENDENT FACTS THROUGH ONE FUNNEL. The credential verdict is about the
 * KEY and a batch of it is ONE decision: a fifty record bulk push that all
 * succeeded must not produce fifty profile writes. The push record is about the
 * ROW and there is one per row, because each carries its own contact id. They
 * are recorded separately and neither may take the other down: a failed row
 * update must not stop a dead key being flagged, and a failed flag must not
 * lose the record of a contact that really was created.
 *
 * NEVER THROWS. A health write that fell over must not turn a push the customer
 * just watched succeed into an error on their screen.
 */
export async function recordHighLevelOutcomes(
  userId: string,
  entries: ReadonlyArray<HighLevelOutcomeEntry | undefined>
): Promise<void> {
  // Has its own try/catch and never throws, so the credential verdict below
  // runs whatever happened here.
  await recordTracePushes(entries);

  try {
    const verdict = highLevelVerdict(entries.map((entry) => entry?.outcome));
    if (verdict.kind === 'no_signal') return;

    const adminClient = createAdminClient();

    if (verdict.kind === 'dead') {
      const { failure } = verdict;
      const { error } = await adminClient
        .from('user_profiles')
        .update({
          highlevel_invalid_at: new Date().toISOString(),
          // Diagnosis only. It cannot carry the remediation: a revoked token
          // and a missing scope are both 401.
          highlevel_invalid_status: failure.status,
          highlevel_invalid_reason: failure.reason,
        })
        .eq('id', userId);

      if (error) {
        console.error('HighLevel credential health: failed to flag credential', error);
      }
      return;
    }

    // HEALTHY. Clearing is REQUIRED, not a nicety. HighLevel scopes are
    // editable on an existing token, so a user can fix a scope problem without
    // ever saving anything in PTP. If only save cleared the flag, that user
    // stays red forever while their pushes work.
    //
    // Read first so a healthy account does not eat a write on every push.
    const { data } = await adminClient
      .from('user_profiles')
      .select('highlevel_invalid_at')
      .eq('id', userId)
      .single();

    if (!data?.highlevel_invalid_at) return;

    const { error } = await adminClient
      .from('user_profiles')
      .update({
        highlevel_invalid_at: null,
        highlevel_invalid_status: null,
        highlevel_invalid_reason: null,
      })
      .eq('id', userId);

    if (error) {
      console.error('HighLevel credential health: failed to clear credential flag', error);
    }
  } catch (error) {
    console.error('HighLevel credential health write failed:', error);
  }
}
