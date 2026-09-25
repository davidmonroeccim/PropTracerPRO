import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyBulkJobCompleted } from '@/lib/trace/notifyBulkJobCompleted';

/**
 * notifyBulkJobCompleted fires the SAME fire-and-forget webhook shape sweep-stale-traces has used
 * since before Phase 2B (fetch(...).catch(...), no retry, no signing header, event
 * 'bulk_job.completed' with job_id/records_submitted/records_matched/timestamp). This module exists
 * so the two crons Task 2 adds to the queue do not become a fourth and fifth inline copy of that
 * fetch (controller ruling; see lib/trace/finalizeBulkJob.ts for the sibling ruling on the count).
 *
 * FETCH IS STUBBED HERE, EXPLICITLY, so this suite never reaches a real network endpoint (global
 * constraint: tests never call a live vendor). The fenced behaviour is "did we call the right URL
 * with the right payload", not "did a server answer" -- the mocked fetch always resolves.
 */

function stubAdmin(opts: {
  job?: { user_id: string; records_submitted: number } | null;
  jobError?: { message: string };
  profile?: { webhook_url: string | null } | null;
  profileError?: { message: string };
}) {
  return {
    from: (table: string) => {
      if (table === 'trace_jobs') {
        return {
          select: () => ({
            eq: () => ({
              single: async () =>
                opts.jobError
                  ? { data: null, error: opts.jobError }
                  : { data: opts.job ?? null, error: null },
            }),
          }),
        };
      }
      if (table === 'user_profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: async () =>
                opts.profileError
                  ? { data: null, error: opts.profileError }
                  : { data: opts.profile ?? null, error: null },
            }),
          }),
        };
      }
      throw new Error(`stubAdmin: unexpected table "${table}"`);
    },
  } as never;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('notifyBulkJobCompleted', () => {
  it('fires the webhook with the sweep-stale-traces payload shape when one is configured', async () => {
    const admin = stubAdmin({
      job: { user_id: 'u1', records_submitted: 10 },
      profile: { webhook_url: 'https://example.com/hook' },
    });
    await notifyBulkJobCompleted(admin, 'job-1', 4);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      event: 'bulk_job.completed',
      job_id: 'job-1',
      records_submitted: 10,
      records_matched: 4,
    });
    expect(typeof body.timestamp).toBe('string');
  });

  // MUTATION: drop the `if (!profile?.webhook_url) return;` guard and this goes red -- every
  // customer with no webhook configured would get a POST fired at a null/undefined URL.
  it('does NOT fire when the owner has no webhook configured', async () => {
    const admin = stubAdmin({
      job: { user_id: 'u1', records_submitted: 10 },
      profile: { webhook_url: null },
    });
    await notifyBulkJobCompleted(admin, 'job-1', 4);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // NEVER TREAT A FAILED READ AS AN EMPTY JOB (the amendment fixed in finalizeJobIfDrained applies
  // here too): a Supabase error reading trace_jobs is not "there is no job", and must not throw
  // past this function into the cron's loop over other jobs.
  it('does NOT fire, and does not throw, when the trace_jobs read errors', async () => {
    const admin = stubAdmin({ jobError: { message: 'read timeout' } });
    await expect(notifyBulkJobCompleted(admin, 'job-1', 4)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT fire, and does not throw, when the user_profiles read errors', async () => {
    const admin = stubAdmin({
      job: { user_id: 'u1', records_submitted: 10 },
      profileError: { message: 'connection reset' },
    });
    await expect(notifyBulkJobCompleted(admin, 'job-1', 4)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
