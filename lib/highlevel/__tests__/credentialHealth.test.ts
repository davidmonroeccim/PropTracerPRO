import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHY THIS FILE EXISTS. Five of the seven `pushTraceToHighLevel` call sites run
 * with nobody watching, and every one of them threw the result away. A customer
 * whose HighLevel key was revoked got silence forever. This helper is the only
 * channel those paths have, so its routing is the whole fix.
 *
 * THE THREE FAILURE CLASSES ARE NOT INTERCHANGEABLE and the tests below assert
 * the CLASSIFICATION and the STORED VALUES, never that two runs merely differ
 * (L-015). A record failure and a transient failure must write NOTHING, and
 * "wrote nothing" is asserted as an empty update list rather than as an absent
 * key, because an absent key is also what a half-written payload looks like.
 */

interface Update {
  table: string;
  payload: Record<string, unknown>;
}

const H = vi.hoisted(() => ({
  /** The row `select('highlevel_invalid_at')` comes back with. */
  profileRow: null as Record<string, unknown> | null,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  selects: [] as string[],
  /** Set to make every update come back as a PostgREST error. */
  updateError: null as unknown,
  /** Set to make createAdminClient itself blow up. */
  adminThrows: false,
}));

function chainTo(data: unknown, error: unknown = null) {
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.eq = self;
  node.single = () => Promise.resolve({ data, error });
  node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(res, rej);
  return node;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (H.adminThrows) throw new Error('missing service role key');
    return {
      from: (table: string) => ({
        select: (columns: string) => {
          H.selects.push(`${table}:${columns}`);
          return chainTo(H.profileRow);
        },
        update: (payload: Record<string, unknown>) => {
          H.updates.push({ table, payload });
          return chainTo(null, H.updateError);
        },
      }),
    };
  },
}));

const { recordHighLevelOutcomes, recordHighLevelPushes, highLevelVerdict } = await import(
  '@/lib/highlevel/credentialHealth'
);
type Entry = NonNullable<Parameters<typeof recordHighLevelOutcomes>[1][number]>;
type Outcome = Entry['outcome'];

/**
 * The credential verdict does not depend on WHICH row a push was for, so the
 * tests about it hand the outcomes over without a trace id. The tests that are
 * about the row call recordHighLevelOutcomes directly with full entries.
 */
const record = (userId: string, outcomes: Outcome[]) =>
  recordHighLevelOutcomes(
    userId,
    outcomes.map((outcome) => ({ outcome }))
  );

const SUCCESS = { success: true, contactId: 'c-1', action: 'created' } as const;

const TOKEN_DEAD = {
  success: false,
  kind: 'credential',
  reason: 'token',
  status: 401,
  error: 'HighLevel rejected your API key. Reconnect HighLevel in Settings.',
} as const;

const SCOPE_DEAD = {
  success: false,
  kind: 'credential',
  reason: 'scope',
  status: 401,
  error: 'Your HighLevel token is missing the contacts.write permission.',
} as const;

const LOCATION_DEAD = {
  success: false,
  kind: 'credential',
  reason: 'location',
  status: 403,
  error: 'Your HighLevel token does not have access to that location.',
} as const;

const UNKNOWN_DEAD = {
  success: false,
  kind: 'credential',
  reason: 'unknown',
  status: 401,
  error: 'HighLevel refused the credential.',
} as const;

const RECORD_FAILURE = {
  success: false,
  kind: 'record',
  status: 422,
  error: 'HighLevel would not accept this contact.',
} as const;

const RATE_LIMITED = {
  success: false,
  kind: 'transient',
  status: 429,
  error: 'HighLevel is not accepting pushes right now.',
} as const;

/** A thrown fetch: transient with NO status at all. */
const NETWORK_DOWN = {
  success: false,
  kind: 'transient',
  error: 'HighLevel is not accepting pushes right now.',
} as const;

beforeEach(() => {
  H.updates = [];
  H.selects = [];
  H.profileRow = null;
  H.updateError = null;
  H.adminThrows = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** The update rows this run wrote to user_profiles, in order. */
function profileUpdates(): Update[] {
  return H.updates.filter((u) => u.table === 'user_profiles');
}

// ---------------------------------------------------------------------------

describe('a credential-class failure marks the credential dead, with the reason', () => {
  it.each([
    ['token', TOKEN_DEAD, 401],
    ['scope', SCOPE_DEAD, 401],
    ['location', LOCATION_DEAD, 403],
    ['unknown', UNKNOWN_DEAD, 401],
  ] as const)('reason %s is stored, not inferred from the status', async (reason, failure, status) => {
    await record('user-1', [failure as Outcome]);

    const updates = profileUpdates();
    expect(updates).toHaveLength(1);
    const payload = updates[0].payload;

    // All three columns must be PRESENT. A payload carrying only the timestamp
    // leaves a stale reason behind and the badge then names the wrong fix.
    expect('highlevel_invalid_at' in payload).toBe(true);
    expect('highlevel_invalid_status' in payload).toBe(true);
    expect('highlevel_invalid_reason' in payload).toBe(true);

    expect(payload.highlevel_invalid_reason).toBe(reason);
    expect(payload.highlevel_invalid_status).toBe(status);
    expect(typeof payload.highlevel_invalid_at).toBe('string');
    expect(Number.isNaN(Date.parse(String(payload.highlevel_invalid_at)))).toBe(false);
  });

  it('401 alone does not decide the reason: two 401s store two different reasons', async () => {
    // The point of the reason column. A revoked token and a missing scope are
    // BOTH 401 and need different instructions from the user.
    await record('user-1', [TOKEN_DEAD as Outcome]);
    await record('user-1', [SCOPE_DEAD as Outcome]);

    const updates = profileUpdates();
    expect(updates.map((u) => u.payload.highlevel_invalid_status)).toEqual([401, 401]);
    expect(updates.map((u) => u.payload.highlevel_invalid_reason)).toEqual(['token', 'scope']);
  });
});

describe('a failure that says nothing about the credential changes nothing', () => {
  it('a record failure writes nothing at all', async () => {
    await record('user-1', [RECORD_FAILURE as Outcome]);
    expect(H.updates).toEqual([]);
  });

  it('a rate limit writes nothing at all', async () => {
    await record('user-1', [RATE_LIMITED as Outcome]);
    expect(H.updates).toEqual([]);
  });

  it('a network throw writes nothing at all', async () => {
    await record('user-1', [NETWORK_DOWN as Outcome]);
    expect(H.updates).toEqual([]);
  });

  it('a record failure does not even read the profile, so it cannot clear one either', async () => {
    H.profileRow = { highlevel_invalid_at: '2026-09-17T00:00:00.000Z' };
    await record('user-1', [RECORD_FAILURE as Outcome]);
    expect(H.selects).toEqual([]);
    expect(H.updates).toEqual([]);
  });
});

describe('a success CLEARS the flag, which is the half nobody sees until it is missing', () => {
  it('clears all three columns to null when the flag is set', async () => {
    // HighLevel scopes are editable without regenerating the token, so a user
    // can fix a scope problem with no save ever happening in PTP. If only save
    // cleared the flag, that user stays red forever while pushes work.
    H.profileRow = { highlevel_invalid_at: '2026-09-17T00:00:00.000Z' };

    await record('user-1', [SUCCESS as Outcome]);

    const updates = profileUpdates();
    expect(updates).toHaveLength(1);
    const payload = updates[0].payload;

    // `in` rather than `?? null`: an ABSENT key satisfies a null assertion just
    // as well as a null value, and an absent key leaves the flag standing.
    expect('highlevel_invalid_at' in payload).toBe(true);
    expect('highlevel_invalid_status' in payload).toBe(true);
    expect('highlevel_invalid_reason' in payload).toBe(true);
    expect(payload.highlevel_invalid_at).toBeNull();
    expect(payload.highlevel_invalid_status).toBeNull();
    expect(payload.highlevel_invalid_reason).toBeNull();
  });

  it('writes nothing when the flag is already clear, so a healthy push costs one read', async () => {
    H.profileRow = { highlevel_invalid_at: null };
    await record('user-1', [SUCCESS as Outcome]);
    expect(H.updates).toEqual([]);
    expect(H.selects).toEqual(['user_profiles:highlevel_invalid_at']);
  });

  it('writes nothing when the profile row cannot be read', async () => {
    H.profileRow = null;
    await record('user-1', [SUCCESS as Outcome]);
    expect(H.updates).toEqual([]);
  });
});

describe('a batch is one decision, not one write per record', () => {
  it('clears once for fifty successful pushes', async () => {
    H.profileRow = { highlevel_invalid_at: '2026-09-17T00:00:00.000Z' };
    const outcomes = Array.from({ length: 50 }, () => SUCCESS as Outcome);

    await record('user-1', outcomes);

    expect(profileUpdates()).toHaveLength(1);
    expect(H.selects).toHaveLength(1);
  });

  it('one credential failure among successes marks the credential dead', async () => {
    // Credential wins over success deliberately: a key that refused any write
    // is the outcome that keeps failing until somebody acts on it.
    await record('user-1', [
      SUCCESS as Outcome,
      SCOPE_DEAD as Outcome,
      SUCCESS as Outcome,
    ]);

    const updates = profileUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.highlevel_invalid_reason).toBe('scope');
    expect(updates[0].payload.highlevel_invalid_at).not.toBeNull();
  });

  it('successes mixed with record failures still clear, because no credential complaint was made', async () => {
    H.profileRow = { highlevel_invalid_at: '2026-09-17T00:00:00.000Z' };

    await record('user-1', [
      RECORD_FAILURE as Outcome,
      SUCCESS as Outcome,
      RECORD_FAILURE as Outcome,
    ]);

    const updates = profileUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.highlevel_invalid_at).toBeNull();
  });

  it('an all-transient batch writes nothing', async () => {
    H.profileRow = { highlevel_invalid_at: '2026-09-17T00:00:00.000Z' };
    await record('user-1', [RATE_LIMITED as Outcome, NETWORK_DOWN as Outcome]);
    expect(H.updates).toEqual([]);
  });
});

describe('it never throws into the caller, because five call sites are on a request path', () => {
  it('survives a failed update', async () => {
    H.updateError = { message: 'permission denied' };
    await expect(record('user-1', [TOKEN_DEAD as Outcome])).resolves.toBeUndefined();
  });

  it('survives createAdminClient throwing', async () => {
    H.adminThrows = true;
    await expect(record('user-1', [TOKEN_DEAD as Outcome])).resolves.toBeUndefined();
  });

  it('survives a push promise that rejects, and records nothing from it', async () => {
    await expect(
      recordHighLevelPushes('user-1', [{ push: Promise.reject(new Error('boom')) }])
    ).resolves.toBeUndefined();
    expect(H.updates).toEqual([]);
  });

  it('records the resolved outcomes of the promises it is handed', async () => {
    await recordHighLevelPushes('user-1', [
      { push: Promise.resolve(SUCCESS as Outcome) },
      { push: Promise.resolve(LOCATION_DEAD as Outcome) },
    ]);

    const updates = profileUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.highlevel_invalid_reason).toBe('location');
    expect(updates[0].payload.highlevel_invalid_status).toBe(403);
  });
});

/**
 * RECORDING THAT THE TRACE REACHED THE CRM.
 *
 * The same funnel, because a second mechanism beside it is a second thing to
 * forget at the eighth push site. Every caller already hands its outcomes here;
 * handing the trace id alongside is what makes "did this row reach the CRM"
 * answerable at all.
 *
 * THE PAIRING IS THE RULE. `highlevel_contact_id` and `highlevel_pushed_at` are
 * written together or not at all: a row with one and not the other is a bug,
 * not a state, and every reader that asks "has this been pushed" looks at the
 * timestamp while every reader that asks "where did it go" looks at the id.
 */
describe('the push is recorded on the trace row it was for', () => {
  const traceUpdates = (): Update[] => H.updates.filter((u) => u.table === 'trace_history');

  it('writes the contact id and the timestamp together, with the action', async () => {
    await recordHighLevelOutcomes('user-1', [{ traceId: 'trace-1', outcome: SUCCESS as Outcome }]);

    const updates = traceUpdates();
    expect(updates).toHaveLength(1);
    const payload = updates[0].payload;

    // `in` rather than a value check alone: an ABSENT key satisfies a null
    // assertion just as well as a null value, and an absent key here is exactly
    // the half-written row the pairing rule exists to forbid.
    expect('highlevel_contact_id' in payload).toBe(true);
    expect('highlevel_pushed_at' in payload).toBe(true);
    expect('highlevel_push_action' in payload).toBe(true);

    expect(payload.highlevel_contact_id).toBe('c-1');
    expect(payload.highlevel_push_action).toBe('created');
    expect(typeof payload.highlevel_pushed_at).toBe('string');
    expect(Number.isNaN(Date.parse(String(payload.highlevel_pushed_at)))).toBe(false);
  });

  it('stores the action HighLevel reported, so an update is not read as a new contact', async () => {
    await recordHighLevelOutcomes('user-1', [
      { traceId: 'trace-1', outcome: { success: true, contactId: 'c-9', action: 'updated' } as Outcome },
    ]);

    const updates = traceUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.highlevel_push_action).toBe('updated');
    expect(updates[0].payload.highlevel_contact_id).toBe('c-9');
  });

  it('records each row against its own id, never one row against another', async () => {
    await recordHighLevelOutcomes('user-1', [
      { traceId: 'trace-a', outcome: { success: true, contactId: 'c-a', action: 'created' } as Outcome },
      { traceId: 'trace-b', outcome: { success: true, contactId: 'c-b', action: 'updated' } as Outcome },
    ]);

    const updates = traceUpdates();
    expect(updates).toHaveLength(2);
    expect(updates.map((u) => u.payload.highlevel_contact_id).sort()).toEqual(['c-a', 'c-b']);
  });

  it('records nothing for a failed push, because nothing reached the CRM', async () => {
    await recordHighLevelOutcomes('user-1', [
      { traceId: 'trace-1', outcome: TOKEN_DEAD as Outcome },
    ]);

    expect(traceUpdates()).toEqual([]);
  });

  it('records nothing when HighLevel gave us no contact id, rather than a timestamp alone', async () => {
    // A success with no id cannot answer "where did it go", and half the pair
    // is worse than neither: a later reader would treat the row as pushed and
    // have nothing to point at.
    await recordHighLevelOutcomes('user-1', [
      { traceId: 'trace-1', outcome: { success: true, action: 'created' } as Outcome },
    ]);

    expect(traceUpdates()).toEqual([]);
  });

  it('records nothing for a credential check, which is not about any row', async () => {
    // validateHighLevelCredential answers { success: true } with no action and
    // no contact. It must not stamp a push onto anything.
    await recordHighLevelOutcomes('user-1', [{ outcome: { success: true } as Outcome }]);

    expect(traceUpdates()).toEqual([]);
  });

  it('still records the push when the credential verdict writes nothing', async () => {
    // A healthy push against an already-clear flag writes no profile row at
    // all. The trace record must not ride on that decision.
    H.profileRow = { highlevel_invalid_at: null };

    await recordHighLevelOutcomes('user-1', [{ traceId: 'trace-1', outcome: SUCCESS as Outcome }]);

    expect(profileUpdates()).toEqual([]);
    expect(traceUpdates()).toHaveLength(1);
  });

  it('records through the fire-and-forget form the automatic paths use', async () => {
    await recordHighLevelPushes('user-1', [
      { traceId: 'trace-1', push: Promise.resolve(SUCCESS as Outcome) },
    ]);

    const updates = traceUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.highlevel_contact_id).toBe('c-1');
  });

  it('a failed trace update does not stop the credential write', async () => {
    // The two are independent facts. A row update that fails must not cost the
    // user the flag that tells them their key is dead, and vice versa.
    H.updateError = { message: 'permission denied' };
    H.profileRow = { highlevel_invalid_at: '2026-09-17T00:00:00.000Z' };

    await expect(
      recordHighLevelOutcomes('user-1', [{ traceId: 'trace-1', outcome: SUCCESS as Outcome }])
    ).resolves.toBeUndefined();

    // Both were attempted, in spite of the first one erroring.
    expect(traceUpdates()).toHaveLength(1);
    expect(profileUpdates()).toHaveLength(1);
    expect(profileUpdates()[0].payload.highlevel_invalid_at).toBeNull();
  });
});

describe('the verdict itself, so the routing is readable without a database', () => {
  it('names the credential failure it is acting on', () => {
    expect(highLevelVerdict([RECORD_FAILURE as Outcome, SCOPE_DEAD as Outcome])).toEqual({
      kind: 'dead',
      failure: SCOPE_DEAD,
    });
  });

  it('calls a run with only non-credential failures no signal, not healthy', () => {
    // "Not dead" is not "alive". Treating a rate limit as proof the key works
    // would clear a red badge that is still correct.
    expect(highLevelVerdict([RATE_LIMITED as Outcome, RECORD_FAILURE as Outcome])).toEqual({
      kind: 'no_signal',
    });
  });

  it('calls a run with a success healthy', () => {
    expect(highLevelVerdict([RATE_LIMITED as Outcome, SUCCESS as Outcome])).toEqual({
      kind: 'healthy',
    });
  });

  it('calls an empty run no signal', () => {
    expect(highLevelVerdict([])).toEqual({ kind: 'no_signal' });
  });
});

/**
 * THE WRITE HAS TO SURVIVE THE RESPONSE.
 *
 * Five of the callers are fire-and-forget on a request path. On serverless a
 * promise still running when the response flushes can be killed with it, and
 * the old code only stood to lose a `console.error`. This code stands to lose
 * the credential flag, which is the ENTIRE channel by which a user with a dead
 * key finds out. A flag that usually lands is the same silent failure wearing a
 * different hat.
 *
 * `after()` from next/server is the repo's existing answer to exactly this;
 * `lib/suite/access.ts` has used it for the entitlement refresh for months, and
 * the pattern there is the one copied here, including the fallback. Mock shape
 * is lifted from `lib/suite/__tests__/access.test.ts`.
 */
describe('the health write is scheduled to outlive the response', () => {
  it('hands the work to after() so it runs once the response has flushed', async () => {
    const scheduled: Array<() => unknown> = [];
    vi.doMock('next/server', () => ({
      after: (fn: () => unknown) => {
        scheduled.push(fn);
      },
    }));
    vi.resetModules();
    const mod = await import('@/lib/highlevel/credentialHealth');

    await mod.recordHighLevelPushes('user-1', [{ push: Promise.resolve(TOKEN_DEAD as Outcome) }]);

    // Asserted as "after() received the work", not as "an update happened".
    // The whole point is that the write is DEFERRED, and a test that only
    // checks the row would pass just as well with the bare fire-and-forget
    // this replaces.
    expect(scheduled).toHaveLength(1);
    expect(H.updates).toHaveLength(0);

    await scheduled[0]();
    expect(H.updates).toHaveLength(1);
    expect(H.updates[0].payload.highlevel_invalid_reason).toBe('token');

    vi.doUnmock('next/server');
    vi.resetModules();
  });

  it('still records when after() is unavailable, because a cron has no request scope', async () => {
    vi.doMock('next/server', () => ({
      after: () => {
        throw new Error('after() called outside a request scope');
      },
    }));
    vi.resetModules();
    const mod = await import('@/lib/highlevel/credentialHealth');

    await mod.recordHighLevelPushes('user-1', [{ push: Promise.resolve(TOKEN_DEAD as Outcome) }]);

    // Degrades to running inline rather than dropping the write. Losing the
    // flag outside a request scope would be worse than the scheduling we lose.
    expect(H.updates).toHaveLength(1);
    expect(H.updates[0].payload.highlevel_invalid_reason).toBe('token');

    vi.doUnmock('next/server');
    vi.resetModules();
  });
});
