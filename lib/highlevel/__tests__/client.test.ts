import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import type { TraceResult } from '@/types';

/**
 * WHY THIS FILE EXISTS. `pushTraceToHighLevel` had no test of any kind, and it
 * returned `{ success: false, error: 'Failed to create contact' }` for a dead
 * API key, a malformed record and a rate limit alike. `response.status` never
 * left the function and never reached the log, so a customer reporting "nothing
 * arrives in my CRM" was undiagnosable from the outside.
 *
 * Every assertion here is on the CLASSIFICATION a result carries, never on two
 * results merely differing (L-015). Three outputs that differ from one another
 * is satisfied by the vendor's own message text varying, which it does anyway.
 */

const BASE: TraceResult = {
  owner_name: 'Jane Smith',
  owner_name_2: null,
  phones: [{ number: '5125551234', type: 'mobile' }],
  emails: ['jane@example.com'],
  mailing_address: '1815 S State St',
  mailing_city: 'Austin',
  mailing_state: 'TX',
  mailing_zip: '78701',
  match_confidence: 95,
};

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** What each leg of the call should answer with. A leg left unset must not be reached. */
interface Legs {
  search?: Response | Error;
  update?: Response | Error;
  create?: Response | Error;
}

let calls: FetchCall[] = [];
let legs: Legs = {};
let errorSpy: ReturnType<typeof vi.spyOn>;

function json(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Which leg a call is, decided the way the real API decides it. */
function legOf(call: FetchCall): keyof Legs {
  if (call.method === 'GET') return 'search';
  if (call.method === 'PUT') return 'update';
  return 'create';
}

beforeEach(() => {
  calls = [];
  legs = {};
  // L-013: vi.spyOn returns the SAME spy object on a second call and the history
  // accumulates across tests, so an assertion about a log line can be satisfied
  // by an earlier test's output. Clear it, every time.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  errorSpy.mockClear();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const call: FetchCall = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const leg = legs[legOf(call)];
      if (leg === undefined) {
        throw new Error(`unexpected ${call.method} to ${call.url}`);
      }
      if (leg instanceof Error) throw leg;
      return leg;
    })
  );
});

function push(overrides: Partial<TraceResult> = {}) {
  return pushTraceToHighLevel({
    apiKey: 'key-1',
    locationId: 'loc-1',
    traceResult: { ...BASE, ...overrides },
  });
}

/** The search answering "no such contact", which sends the code down CREATE. */
const NO_MATCH = () => json(200, { contacts: [] });
/** The search answering "here it is", which sends the code down UPDATE. */
const ONE_MATCH = () => json(200, { contacts: [{ id: 'contact-9' }] });

// ---------------------------------------------------------------------------

describe('the happy paths, so the failure tests below are not the only shape proved', () => {
  it('creates when the search finds nobody', async () => {
    legs = { search: NO_MATCH(), create: json(201, { contact: { id: 'new-1' } }) };

    await expect(push()).resolves.toEqual({
      success: true,
      contactId: 'new-1',
      action: 'created',
    });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('updates when the search finds somebody', async () => {
    legs = { search: ONE_MATCH(), update: json(200, {}) };

    await expect(push()).resolves.toEqual({
      success: true,
      contactId: 'contact-9',
      action: 'updated',
    });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1].url).toContain('/contacts/contact-9');
  });

  /**
   * HighLevel's Update Contact endpoint OVERWRITES the whole tag array:
   * "This field will overwrite all current tags associated with the contact."
   * https://marketplace.gohighlevel.com/docs/ghl/contacts/update-contact/
   *
   * So every update push was deleting every tag the customer had on that
   * contact. In HighLevel tags drive workflows, so it destroyed their
   * automation triggers too, silently, on a push that reported success.
   *
   * Asserted as "the key is ABSENT", not as "tags is empty" and not as
   * "tags differs from create". An empty array would still overwrite, and
   * `toEqual` against a different value passes for the wrong reason the
   * moment someone sends `tags: []` thinking it is the safe form.
   */
  it('sends NO tags key on update, because update overwrites the whole array', async () => {
    legs = { search: ONE_MATCH(), update: json(200, {}) };

    await push();

    const put = calls[1];
    expect(put.method).toBe('PUT');
    expect(put.body).toBeDefined();
    expect(Object.keys(put.body!)).not.toContain('tags');
  });

  /**
   * The other half of the same rule, and it has to be asserted or the fix
   * above is satisfied by deleting tagging altogether. On CREATE there is no
   * existing tag array to overwrite, so the tag is correct there and must stay.
   */
  it('still tags on create, where there is nothing to overwrite', async () => {
    legs = { search: json(200, { contacts: [] }), create: json(201, { contact: { id: 'new-1' } }) };

    await push();

    const post = calls[1];
    expect(post.method).toBe('POST');
    expect(post.body!.tags).toEqual(['proptracerpro']);
  });

  it('skips the search and creates when there is nothing to search BY', async () => {
    // Not the same as a failed search. No phone and no email is a KNOWN state:
    // we cannot look, so creating is not a guess. The test below covers the
    // case where we looked and were refused, which is a guess.
    legs = { create: json(201, { contact: { id: 'new-2' } }) };

    await expect(push({ phones: [], emails: [] })).resolves.toEqual({
      success: true,
      contactId: 'new-2',
      action: 'created',
    });
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });
});

// ---------------------------------------------------------------------------

describe('a failed SEARCH stops the push instead of creating a duplicate', () => {
  /**
   * The defect this describes. The old code tested `searchRes.ok` with no else,
   * so a 401 on the search left `existingContactId` null and fell through to
   * CREATE. On a partly-working credential that create SUCCEEDS, and the
   * customer silently gets a second copy of a contact they already had. A
   * refused search means we do not KNOW whether the contact exists, and
   * creating on unknown state is inventing a result (repo rule 7).
   */

  it('a 401 on the search never reaches the create call', async () => {
    legs = { search: json(401, { statusCode: 401, message: 'Invalid JWT' }) };

    const result = await push();

    expect(result).toEqual({
      success: false,
      kind: 'credential',
      reason: 'token',
      status: 401,
      error: 'HighLevel rejected your API key. Reconnect HighLevel in Settings.',
    });
    // The point of the whole test. Not "fetch was called once" by accident:
    // no POST to /contacts/ exists in the call log at all.
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('a 500 on the search never reaches the create call either', async () => {
    legs = { search: json(500, 'upstream exploded') };

    const result = await push();

    expect(result).toEqual({
      success: false,
      kind: 'transient',
      status: 500,
      error: 'HighLevel is not accepting pushes right now. Try again shortly.',
    });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('a thrown network error on the search never reaches the create call', async () => {
    legs = { search: new Error('ECONNRESET') };

    const result = await push();

    expect(result).toEqual({
      success: false,
      kind: 'transient',
      error: 'HighLevel is not accepting pushes right now. Try again shortly.',
    });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('what the status says is broken', () => {
  /**
   * Asserted on the kind itself, per status, because the three kinds are the
   * whole point: who has to act. credential means the stored key is dead for
   * every future push. transient means nothing is broken and a retry is right.
   * record means this one payload was refused and the key is fine.
   */

  async function createFailing(status: number, body: unknown) {
    legs = { search: NO_MATCH(), create: json(status, body) };
    return push();
  }

  it.each([
    [401, 'credential'],
    [403, 'credential'],
  ])('%i is a credential failure', async (status, kind) => {
    const result = await createFailing(status, { message: 'nope' });
    expect(result).toMatchObject({ success: false, kind, status });
  });

  it.each([
    [429, 'transient'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
  ])('%i is a transient failure', async (status, kind) => {
    const result = await createFailing(status, 'busy');
    expect(result).toEqual({
      success: false,
      kind,
      status,
      error: 'HighLevel is not accepting pushes right now. Try again shortly.',
    });
  });

  it.each([
    [400, 'record'],
    [404, 'record'],
    [422, 'record'],
  ])('%i is a record failure', async (status, kind) => {
    const result = await createFailing(status, { message: 'bad payload' });
    expect(result).toEqual({
      success: false,
      kind,
      status,
      error: 'HighLevel would not accept this contact.',
    });
  });

  it('a thrown network error on the create is transient, not a record problem', async () => {
    legs = { search: NO_MATCH(), create: new Error('socket hang up') };
    await expect(push()).resolves.toEqual({
      success: false,
      kind: 'transient',
      error: 'HighLevel is not accepting pushes right now. Try again shortly.',
    });
  });

  it('classifies an UPDATE failure the same way it classifies a create failure', async () => {
    legs = { search: ONE_MATCH(), update: json(422, { message: 'bad payload' }) };
    await expect(push()).resolves.toEqual({
      success: false,
      kind: 'record',
      status: 422,
      error: 'HighLevel would not accept this contact.',
    });
  });
});

// ---------------------------------------------------------------------------

describe('which credential problem it is, because the remediation differs', () => {
  /**
   * A missing scope and a revoked token are BOTH 401 in HighLevel. Status alone
   * cannot tell them apart; only the body's `message` can. Telling a user to
   * re-paste a token when the real problem is an unticked contacts.write scope
   * sends them down the wrong path, and contacts.readonly / contacts.write are
   * separate scopes, so a read-only token is a real shape in the wild.
   *
   * Each case asserts the REASON VALUE, not that the three differ. Three
   * different vendor messages differ from one another whatever we do with them.
   */

  async function credentialFailure(status: number, body: unknown) {
    legs = { search: json(status, body) };
    return push();
  }

  it('a revoked or invalid token reads as token', async () => {
    const result = await credentialFailure(401, { statusCode: 401, message: 'Invalid JWT' });
    expect(result).toMatchObject({ kind: 'credential', reason: 'token' });
    expect(result).toMatchObject({
      error: 'HighLevel rejected your API key. Reconnect HighLevel in Settings.',
    });
  });

  it('a missing scope reads as scope, and says so', async () => {
    const result = await credentialFailure(401, {
      statusCode: 401,
      message: 'The token is not authorized for this scope.',
    });
    expect(result).toMatchObject({ kind: 'credential', reason: 'scope' });
    expect(result).toMatchObject({
      error:
        'Your HighLevel token is missing the contacts.write permission. Reconnect it with that scope granted.',
    });
  });

  it('a wrong location reads as location, and says so', async () => {
    const result = await credentialFailure(403, {
      statusCode: 403,
      message: 'The token does not have access to this location.',
    });
    expect(result).toMatchObject({ kind: 'credential', reason: 'location' });
    expect(result).toMatchObject({
      error:
        'Your HighLevel token does not have access to that location. Check the location ID in Settings.',
    });
  });

  it('an unrecognised 401 body reads as unknown rather than guessing token', async () => {
    // The scope wording came from a developer forum, not from HighLevel staff.
    // If they reword it, degrading to a generic credential failure is correct;
    // mislabelling it "your token is revoked" is not.
    const result = await credentialFailure(401, { statusCode: 401, message: 'Nope.' });
    expect(result).toMatchObject({ kind: 'credential', reason: 'unknown' });
    expect(result).toMatchObject({
      error: 'HighLevel refused the credential. Check your HighLevel connection in Settings.',
    });
  });

  it('an unrecognised 403 body reads as unknown too', async () => {
    const result = await credentialFailure(403, { statusCode: 403, message: 'Forbidden' });
    expect(result).toMatchObject({ kind: 'credential', reason: 'unknown' });
  });

  it('a body that is not JSON reads as unknown and does not throw', async () => {
    const result = await credentialFailure(401, '<html>502 Bad Gateway</html>');
    expect(result).toMatchObject({ kind: 'credential', reason: 'unknown' });
  });

  it('a body with no message field at all reads as unknown', async () => {
    const result = await credentialFailure(401, { statusCode: 401 });
    expect(result).toMatchObject({ kind: 'credential', reason: 'unknown' });
  });

  it('matches the message case-insensitively and as a substring', async () => {
    const result = await credentialFailure(401, {
      message: 'AUTH ERROR: the token is not authorized for this SCOPE, contact support',
    });
    expect(result).toMatchObject({ kind: 'credential', reason: 'scope' });
  });

  it('only a credential failure carries a reason', async () => {
    legs = { search: NO_MATCH(), create: json(422, { message: 'The token is not authorized for this scope.' }) };
    // The same words in a 422 body are not a credential problem. The kind gates
    // the reason; the reason must not leak onto a record failure.
    expect(await push()).toEqual({
      success: false,
      kind: 'record',
      status: 422,
      error: 'HighLevel would not accept this contact.',
    });
  });
});

// ---------------------------------------------------------------------------

describe('the log line a support request is diagnosed from', () => {
  it('carries the status and the kind, which it never used to', async () => {
    // The body deliberately does NOT contain the number 422, so "the log
    // mentions 422" can only be true if the status itself was logged.
    legs = { search: NO_MATCH(), create: json(422, { message: 'bad payload' }) };

    await push();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][1]).toMatchObject({ status: 422, kind: 'record' });
  });

  it('carries the credential reason on a credential failure', async () => {
    legs = { search: json(401, { message: 'The token is not authorized for this scope.' }) };

    await push();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][1]).toMatchObject({
      status: 401,
      kind: 'credential',
      reason: 'scope',
    });
  });
});

// ---------------------------------------------------------------------------

describe('the copy rules, which are enforced elsewhere in this repo', () => {
  it('no message this module can emit carries a dash artifact, an asterisk or an emoji', async () => {
    const messages: string[] = [];
    for (const [status, body] of [
      [401, { message: 'Invalid JWT' }],
      [401, { message: 'The token is not authorized for this scope.' }],
      [403, { message: 'The token does not have access to this location.' }],
      [401, { message: 'something new' }],
      [422, { message: 'bad payload' }],
      [503, 'busy'],
    ] as Array<[number, unknown]>) {
      legs = { search: json(status, body) };
      const result = await push();
      if (result.success === false) messages.push(result.error);
    }

    expect(messages).toHaveLength(6);
    for (const message of messages) {
      expect(message).not.toMatch(/[–—*`#_]/u);
      expect(message).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
