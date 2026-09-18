import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHY THIS FILE EXISTS. Save made ZERO outbound calls. It presence-checked two
 * fields and wrote them, so `x` and `y` produced a permanent green "Connected".
 *
 * THE POLICY IS NARROWER THAN "REFUSE ANY 401" AND THAT IS THE POINT. The check
 * we can run is a contacts READ. PTP's product calls are WRITES, and
 * contacts.readonly and contacts.write are separate HighLevel scopes. So:
 *
 *   token     REFUSE   a revoked token is revoked for every verb
 *   location  REFUSE   the wrong location is wrong for every verb
 *   scope     SAVE     the token may hold contacts.write and push perfectly
 *   transient SAVE     HighLevel being down is not the user's fault
 *   unknown   SAVE     we could not read the refusal, so we assert nothing
 *
 * Refusing the scope case would block a working credential, which is the exact
 * failure this phase exists to end.
 */

const H = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  /** What the credential check answers with. */
  validation: { success: true } as Record<string, unknown>,
  /** The row a select comes back with, for the clear-on-success read. */
  profileRow: null as Record<string, unknown> | null,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  updateError: null as unknown,
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

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: H.user } }) },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => chainTo(H.profileRow),
      update: (payload: Record<string, unknown>) => {
        H.updates.push({ table, payload });
        return chainTo(null, H.updateError);
      },
    }),
  }),
}));

vi.mock('@/lib/highlevel/client', () => ({
  validateHighLevelCredential: vi.fn(async () => H.validation),
}));

const { POST } = await import('@/app/api/integrations/highlevel/save/route');
const { validateHighLevelCredential } = await import('@/lib/highlevel/client');

function save(body: Record<string, unknown> = { highlevel_api_key: 'key-1', highlevel_location_id: 'loc-1' }) {
  return POST(
    new Request('http://localhost/api/integrations/highlevel/save', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  );
}

/** The update that stores the credential itself, if one happened. */
function credentialWrite() {
  return H.updates.find((u) => 'highlevel_api_key' in u.payload);
}

const CREDENTIAL_FAILURE = (reason: string, status: number) => ({
  success: false,
  kind: 'credential',
  reason,
  status,
  error: 'upstream sentence, never shown verbatim by this route',
});

beforeEach(() => {
  H.user = { id: 'user-1' };
  H.validation = { success: true };
  H.profileRow = null;
  H.updates = [];
  H.updateError = null;
  // L-013: the mock's call history accumulates across tests, so a
  // `not.toHaveBeenCalled()` would be satisfied by an earlier test's call.
  vi.mocked(validateHighLevelCredential).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------

describe('a credential HighLevel refuses for every verb is REFUSED, and nothing is stored', () => {
  it.each([
    ['token', 401],
    ['location', 403],
  ] as const)('reason %s refuses the save', async (reason, status) => {
    H.validation = CREDENTIAL_FAILURE(reason, status);

    const res = await save();
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);

    // NOTHING is written. Not the credential, not the health columns.
    expect(H.updates).toEqual([]);
  });

  it('a bad token and a bad location get different instructions, and each names its own fix', async () => {
    // Two 4xx answers, two completely different actions: paste a new key, or
    // correct the location ID. Asserted on WHAT each sentence says, not on the
    // two of them merely differing, which any interpolated status satisfies.
    H.validation = CREDENTIAL_FAILURE('token', 401);
    const tokenBody = await (await save()).json();

    H.updates = [];
    H.validation = CREDENTIAL_FAILURE('location', 403);
    const locationBody = await (await save()).json();

    expect(tokenBody.error.toLowerCase()).toContain('key');
    expect(tokenBody.error.toLowerCase()).not.toContain('location id');

    expect(locationBody.error.toLowerCase()).toContain('location id');
    expect(locationBody.error.toLowerCase()).not.toContain('copied the whole key');
  });
});

describe('a refusal we cannot generalise from is SAVED, with a warning that says so', () => {
  it.each([
    ['a missing read scope', { success: false, kind: 'credential', reason: 'scope', status: 401, error: 'x' }],
    ['an unreadable refusal', { success: false, kind: 'credential', reason: 'unknown', status: 401, error: 'x' }],
    ['a rate limit', { success: false, kind: 'transient', status: 429, error: 'x' }],
    ['an outage', { success: false, kind: 'transient', error: 'x' }],
    ['a refused read', { success: false, kind: 'record', status: 422, error: 'x' }],
  ])('%s stores the credential and warns', async (_label, validation) => {
    H.validation = validation as Record<string, unknown>;

    const res = await save();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    // It must NOT claim the credential was verified.
    expect(body.connected).toBe(false);
    expect(typeof body.warning).toBe('string');
    expect(body.warning.length).toBeGreaterThan(0);

    const write = credentialWrite();
    expect(write).toBeDefined();
    expect(write?.payload.highlevel_api_key).toBe('key-1');
    expect(write?.payload.highlevel_location_id).toBe('loc-1');
  });

  it('the scope warning says the write permission may still be fine, so the user is not sent to re-paste a good token', async () => {
    H.validation = { success: false, kind: 'credential', reason: 'scope', status: 401, error: 'x' };
    const body = await (await save()).json();
    expect(body.warning).toContain('contacts.readonly');
  });

  it('an unverified save does NOT clear an existing invalid flag', async () => {
    // We did not confirm anything, so the last real push failure still stands.
    H.profileRow = { highlevel_invalid_at: '2026-09-17T00:00:00.000Z' };
    H.validation = { success: false, kind: 'transient', status: 503, error: 'x' };

    await save();

    const cleared = H.updates.find((u) => 'highlevel_invalid_at' in u.payload);
    expect(cleared).toBeUndefined();
  });
});

describe('a credential HighLevel accepted is stored and clears the red badge', () => {
  it('stores the credential and reports it verified', async () => {
    H.validation = { success: true };

    const res = await save();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.warning).toBeUndefined();

    const write = credentialWrite();
    expect(write?.payload.highlevel_api_key).toBe('key-1');
    expect(write?.payload.highlevel_location_id).toBe('loc-1');
  });

  it('clears all three health columns when the flag was set', async () => {
    H.profileRow = { highlevel_invalid_at: '2026-09-17T00:00:00.000Z' };
    H.validation = { success: true };

    await save();

    const cleared = H.updates.find((u) => 'highlevel_invalid_at' in u.payload);
    expect(cleared).toBeDefined();
    expect('highlevel_invalid_status' in (cleared?.payload ?? {})).toBe(true);
    expect('highlevel_invalid_reason' in (cleared?.payload ?? {})).toBe(true);
    expect(cleared?.payload.highlevel_invalid_at).toBeNull();
    expect(cleared?.payload.highlevel_invalid_status).toBeNull();
    expect(cleared?.payload.highlevel_invalid_reason).toBeNull();
  });
});

describe('the checks that must still happen before we ever call HighLevel', () => {
  it('refuses an unauthenticated caller', async () => {
    H.user = null;
    const res = await save();
    expect(res.status).toBe(401);
    expect(validateHighLevelCredential).not.toHaveBeenCalled();
    expect(H.updates).toEqual([]);
  });

  it('refuses a blank field without calling HighLevel', async () => {
    const res = await save({ highlevel_api_key: '', highlevel_location_id: 'loc-1' });
    expect(res.status).toBe(400);
    expect(validateHighLevelCredential).not.toHaveBeenCalled();
    expect(H.updates).toEqual([]);
  });

  it('passes the credential it was given to the check, not the stored one', async () => {
    await save({ highlevel_api_key: 'key-2', highlevel_location_id: 'loc-2' });
    expect(validateHighLevelCredential).toHaveBeenCalledWith({
      apiKey: 'key-2',
      locationId: 'loc-2',
    });
  });

  it('reports a failed write as a failure rather than a save', async () => {
    H.updateError = { message: 'permission denied' };
    const res = await save();
    expect(res.status).toBe(500);
    expect((await res.json()).success).toBe(false);
  });
});

describe('the copy rules, which are enforced and not advisory', () => {
  it('no sentence this route can emit carries a dash artifact, an asterisk or an emoji', async () => {
    const sentences: string[] = [];

    for (const validation of [
      { success: true },
      { success: false, kind: 'credential', reason: 'token', status: 401, error: 'x' },
      { success: false, kind: 'credential', reason: 'location', status: 403, error: 'x' },
      { success: false, kind: 'credential', reason: 'scope', status: 401, error: 'x' },
      { success: false, kind: 'credential', reason: 'unknown', status: 401, error: 'x' },
      { success: false, kind: 'transient', status: 429, error: 'x' },
      { success: false, kind: 'record', status: 422, error: 'x' },
    ]) {
      H.updates = [];
      H.validation = validation as Record<string, unknown>;
      const body = await (await save()).json();
      const sentence = body.error ?? body.warning;
      if (typeof sentence === 'string') sentences.push(sentence);
    }

    // Six of the seven carry a sentence; the verified save carries none.
    expect(sentences).toHaveLength(6);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/[–—*`#_]/u);
      expect(sentence).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
