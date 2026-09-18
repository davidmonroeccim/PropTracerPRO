import { createAdminClient } from '@/lib/supabase/admin';
import type { HighLevelPushResult, HighLevelValidation } from '@/lib/highlevel/client';

/**
 * RECORDING THAT A TRACE REACHED THE CUSTOMER'S CRM.
 *
 * PTP has pushed contacts to HighLevel since January and never wrote down that
 * it happened: `contactId` came back from the client and was dropped by all
 * seven callers, so "did this trace reach the CRM" was unanswerable after the
 * fact. It does two more jobs beyond reporting. A tier 2 row is now observed by
 * more than one settle path, so avoiding a double push has to rest on a FACT
 * about the row rather than on a filter that matches a code path. And a push
 * that failed is otherwise indistinguishable from one that never ran, so no
 * retry could ever be written.
 *
 * WHY IT LIVES BEHIND THE SAME FUNNEL AS THE CREDENTIAL VERDICT. Every push
 * site already hands its outcomes to lib/highlevel/credentialHealth. A second
 * mechanism bolted beside it is a second thing to forget at the eighth push
 * site. credentialHealth calls this; nothing else should need to.
 *
 * Only `service_role` may write these columns (anon and authenticated hold
 * SELECT and nothing else on trace_history), so every write here goes through
 * the admin client. See
 * supabase/migrations/20260918_trace_highlevel_push_record.sql.
 */

/** Anything a HighLevel call can answer with: a push result or a credential check. */
export type HighLevelOutcome = HighLevelPushResult | HighLevelValidation;

/** A settled HighLevel call, and the trace row it was about. */
export interface HighLevelOutcomeEntry {
  /**
   * The trace_history row this call was for. Absent or null when the call was
   * not about a row at all, which is the credential check on the save route.
   */
  traceId?: string | null;
  outcome: HighLevelOutcome;
}

/** A HighLevel call still in flight, and the trace row it is about. */
export interface HighLevelPushEntry {
  traceId?: string | null;
  push: Promise<HighLevelOutcome>;
}

/**
 * Row updates in flight at once. A bulk push can carry up to the 500-record
 * submit cap and each row takes its own contact id, so there is no one
 * statement that writes them all. Ten at a time keeps a large job off a single
 * serial chain without opening 500 connections at once.
 */
const RECORD_CONCURRENCY = 10;

/** What one row needs written, once the outcome has been read. */
interface PushRecord {
  traceId: string;
  contactId: string;
  action: 'created' | 'updated';
}

/**
 * Which entries actually put a contact in the CRM.
 *
 * THREE THINGS ARE EXCLUDED AND THEY ARE NOT THE SAME EXCLUSION:
 *
 *   no traceId     a credential check, which is about the key and not any row.
 *   not a push     `validateHighLevelCredential` also answers { success: true }.
 *                  Only a push carries an `action`, and only a push placed a
 *                  contact anywhere, so the action is what separates them.
 *   no contactId   HighLevel said yes and gave us nothing to point at. The pair
 *                  is written together or not at all: half of it is a row that
 *                  reads as pushed with no way to find what it was pushed into,
 *                  which is worse than a row that reads as unpushed.
 */
function recordsFrom(
  entries: ReadonlyArray<HighLevelOutcomeEntry | undefined>
): PushRecord[] {
  const records: PushRecord[] = [];

  for (const entry of entries) {
    if (!entry?.traceId) continue;
    const { outcome } = entry;
    if (!outcome?.success) continue;
    if (!('action' in outcome)) continue;

    if (!outcome.contactId) {
      console.error(
        'HighLevel push record: the push succeeded with no contact id, so nothing was recorded for trace',
        entry.traceId
      );
      continue;
    }

    records.push({
      traceId: entry.traceId,
      contactId: outcome.contactId,
      action: outcome.action,
    });
  }

  return records;
}

/**
 * Write the push onto every trace row that reached the CRM.
 *
 * NEVER THROWS. It shares a funnel with the credential health write and the two
 * are independent facts: a failed row update must not stop a dead key being
 * flagged, and a failed flag must not lose the record of a contact that really
 * was created.
 */
export async function recordTracePushes(
  entries: ReadonlyArray<HighLevelOutcomeEntry | undefined>
): Promise<void> {
  try {
    const records = recordsFrom(entries);
    if (records.length === 0) return;

    const adminClient = createAdminClient();
    // One instant for the whole batch. These rows were pushed by one run, and a
    // per-row clock would imply an ordering the batch does not have.
    const pushedAt = new Date().toISOString();

    for (let i = 0; i < records.length; i += RECORD_CONCURRENCY) {
      await Promise.all(
        records.slice(i, i + RECORD_CONCURRENCY).map(async (record) => {
          const { error } = await adminClient
            .from('trace_history')
            .update({
              // THE PAIR, TOGETHER. A row with one and not the other is a bug,
              // not a state: every "has this been pushed" reader looks at the
              // timestamp and every "where did it go" reader looks at the id.
              highlevel_contact_id: record.contactId,
              highlevel_pushed_at: pushedAt,
              // created or updated, as HighLevel reported it. The difference
              // between adding to the customer's CRM and touching a record they
              // already owned.
              highlevel_push_action: record.action,
            })
            .eq('id', record.traceId);

          if (error) {
            console.error(
              'HighLevel push record: failed to record the push for trace',
              record.traceId,
              error
            );
          }
        })
      );
    }
  } catch (error) {
    console.error('HighLevel push record write failed:', error);
  }
}
