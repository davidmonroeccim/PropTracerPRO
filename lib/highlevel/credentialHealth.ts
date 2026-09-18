import { after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { HighLevelPushResult } from '@/lib/highlevel/client';
import {
  recordTracePushes,
  type HighLevelOutcome,
  type HighLevelOutcomeEntry,
  type HighLevelPushEntry,
} from '@/lib/highlevel/pushRecord';

/**
 * THE CHANNEL THE AUTOMATIC PATHS DID NOT HAVE.
 *
 * Seven places call `pushTraceToHighLevel`. Five of them run with nobody
 * watching (two poll routes, two v1 poll routes, one cron) and every one of
 * them threw the result away, so a customer whose HighLevel key was revoked got
 * silence and an empty CRM for as long as they cared to wait.
 *
 * There is no synchronous channel on those paths, so the outcome is recorded
 * against the CREDENTIAL instead, on a row the integrations page reads. The
 * user finds out on a page they will visit rather than not at all.
 *
 * The three columns live on `user_profiles` and `anon` and `authenticated` hold
 * no UPDATE grant on that table, which is deliberate: a user must not be able
 * to clear their own red badge from the browser. Every write here therefore
 * goes through the admin (service_role) client. See
 * supabase/migrations/20260918_highlevel_credential_health.sql.
 */

/**
 * Re-exported so a caller needs one import, not three. The entry types carry a
 * trace id alongside each outcome: see lib/highlevel/pushRecord.ts for why the
 * record of the push rides this funnel rather than one of its own.
 */
export type { HighLevelOutcome, HighLevelOutcomeEntry, HighLevelPushEntry };

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
 * NEVER THROWS. Five of the callers are fire-and-forget on a request path that
 * still has to return the customer's trace result, so a broken health write may
 * not take the response down with it.
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

/**
 * The fire-and-forget form, for the call sites that do not await the push.
 *
 * Returns a promise so a test can wait on it; callers are not expected to, and
 * it resolves rather than rejects whatever happens.
 */
function settleAndRecord(
  userId: string,
  pushes: ReadonlyArray<HighLevelPushEntry>
): Promise<void> {
  return Promise.all(
    pushes.map((entry) =>
      entry.push.then(
        (outcome): HighLevelOutcomeEntry | undefined => ({
          traceId: entry.traceId,
          outcome,
        }),
        (error): undefined => {
          // pushTraceToHighLevel returns its failures rather than throwing, so
          // reaching here means something unexpected broke. It tells us nothing
          // about the credential and nothing reached the CRM, so it is dropped
          // rather than classified or recorded.
          console.error('HighLevel push threw:', error);
          return undefined;
        }
      )
    )
  )
    .then((entries) => recordHighLevelOutcomes(userId, entries))
    .catch((error) => {
      console.error('HighLevel credential health write failed:', error);
    });
}

/**
 * THE WRITE HAS TO OUTLIVE THE RESPONSE, which is why this is not a bare
 * floating promise.
 *
 * Five callers are fire-and-forget on a request path that must still return the
 * customer's trace result. On serverless, work still running when the response
 * flushes can be killed with it. The code this replaces only stood to lose a
 * `console.error`; this stands to lose the credential flag, and that flag is
 * the ENTIRE channel by which a user with a dead key finds out. A flag that
 * usually lands is the same silent failure in a different hat.
 *
 * `after()` hands the work to the runtime to run once the response is flushed.
 * It throws outside a request scope, so a cron or a script degrades to running
 * inline: losing the scheduling is much better than losing the write. This is
 * the pattern `lib/suite/access.ts` has used for the entitlement refresh, copied
 * rather than reinvented.
 */
export function recordHighLevelPushes(
  userId: string,
  pushes: ReadonlyArray<HighLevelPushEntry>
): Promise<void> {
  const work = () => settleAndRecord(userId, pushes);
  try {
    after(work);
    return Promise.resolve();
  } catch {
    return work();
  }
}
