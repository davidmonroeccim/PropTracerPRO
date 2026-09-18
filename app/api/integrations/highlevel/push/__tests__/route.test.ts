import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHY THIS FILE EXISTS. This route returned `NextResponse.json(result)` for the
 * single push, so a client result of `{ success: false }` left the server as an
 * HTTP **200**, and it hardcoded `{ success: true, pushed, failed, total }` for
 * the bulk push, so a 50 record job where every write 401'd came back green
 * reading "0 contacts pushed". The button downstream checks `response.ok`, so
 * both were invisible to the customer.
 *
 * The assertions below are on the STATUS and the classification the body
 * carries, never on two responses merely differing.
 */

const H = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  profile: null as Record<string, unknown> | null,
  trace: null as Record<string, unknown> | null,
  job: null as Record<string, unknown> | null,
  traces: null as Array<Record<string, unknown>> | null,
  pushResults: [] as unknown[],
  pushCalls: 0,
}));

/** Minimal PostgREST-shaped builder: chainable, and awaitable at either terminator. */
function chain(rows: { single?: unknown; list?: unknown }) {
  const node: Record<string, unknown> = {};
  const self = () => node;
  for (const m of ['eq', 'not', 'is', 'select', 'order', 'limit', 'ilike']) node[m] = self;
  node.single = () => Promise.resolve({ data: rows.single ?? null, error: null });
  node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows.list ?? null, error: null }).then(res, rej);
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
      select: () => {
        if (table === 'user_profiles') return chain({ single: H.profile });
        if (table === 'trace_jobs') return chain({ single: H.job });
        return chain({ single: H.trace, list: H.traces });
      },
    }),
  }),
}));

vi.mock('@/lib/highlevel/client', () => ({
  pushTraceToHighLevel: vi.fn(async () => {
    const next = H.pushResults[Math.min(H.pushCalls, H.pushResults.length - 1)];
    H.pushCalls += 1;
    return next;
  }),
}));

const { POST } = await import('@/app/api/integrations/highlevel/push/route');

const PRO_PROFILE = {
  highlevel_api_key: 'key-1',
  highlevel_location_id: 'loc-1',
  subscription_tier: 'pro',
  is_acquisition_pro_member: false,
  gateway_products: null,
};

const TRACE = {
  trace_result: { owner_name: 'Jane Smith', phones: [], emails: [] },
  normalized_address: '1815 S State St',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  is_successful: true,
};

/**
 * The route's two branches are each guarded by `if (trace_id)` / `if (job_id)`
 * with no final return, so TypeScript infers `NextResponse | undefined`. The
 * `:20` guard makes that unreachable. If it ever IS reached, fail here loudly
 * rather than let a test assert against nothing.
 */
async function post(body: Record<string, unknown>): Promise<Response> {
  const res = await POST(
    new Request('http://localhost/api/integrations/highlevel/push', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never
  );
  if (!res) throw new Error('the push route returned nothing at all');
  return res;
}

/** A failure shaped exactly as the client now returns one. */
const CREDENTIAL_FAILURE = {
  success: false,
  kind: 'credential',
  reason: 'scope',
  status: 401,
  error: 'Your HighLevel token is missing the contacts.write permission. Reconnect it with that scope granted.',
};
const RECORD_FAILURE = {
  success: false,
  kind: 'record',
  status: 422,
  error: 'HighLevel would not accept this contact.',
};
const TRANSIENT_FAILURE = {
  success: false,
  kind: 'transient',
  status: 503,
  error: 'HighLevel is not accepting pushes right now. Try again shortly.',
};
const CREATED = { success: true, contactId: 'c-1', action: 'created' };

beforeEach(() => {
  H.user = { id: 'user-1' };
  H.profile = { ...PRO_PROFILE };
  H.trace = { ...TRACE };
  H.job = { tracerfy_job_id: 'tj-1', status: 'completed' };
  H.traces = [TRACE, TRACE, TRACE];
  H.pushResults = [CREATED];
  H.pushCalls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {}).mockClear();
});

// ---------------------------------------------------------------------------

describe('a single push that worked', () => {
  it('is a 200 that says so', async () => {
    const res = await post({ trace_id: 't-1' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, action: 'created' });
  });
});

describe('a single push that failed no longer leaves as an HTTP 200', () => {
  /**
   * The old line was `return NextResponse.json(result)`. A `{success:false}`
   * body at status 200 makes every `!response.ok` check in the app report a
   * success. Each kind gets a status chosen for what the CALLER should do:
   *
   *   credential -> 502  the upstream refused US. It is deliberately not 401 or
   *                      403: those are this route's own auth answers (:14, :36)
   *                      and a 401 on the wire makes a browser think the PTP
   *                      session died, which would log the user out over a bad
   *                      HighLevel key.
   *   record     -> 422  this payload is the problem, nothing else is.
   *   transient  -> 503  the standard retryable status. Not 5xx-as-catch-all.
   */

  it('a dead or under-scoped credential is a 502 naming the credential', async () => {
    H.pushResults = [CREDENTIAL_FAILURE];
    const res = await post({ trace_id: 't-1' });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      success: false,
      kind: 'credential',
      reason: 'scope',
      error: CREDENTIAL_FAILURE.error,
    });
  });

  it('a rejected record is a 422 that does not blame the credential', async () => {
    H.pushResults = [RECORD_FAILURE];
    const res = await post({ trace_id: 't-1' });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ success: false, kind: 'record', error: RECORD_FAILURE.error });
    expect(body.error).not.toMatch(/key|token|credential/i);
  });

  it('a transient failure is a 503, which is the retryable one', async () => {
    H.pushResults = [TRANSIENT_FAILURE];
    const res = await post({ trace_id: 't-1' });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      success: false,
      kind: 'transient',
      error: TRANSIENT_FAILURE.error,
    });
  });

  it('never answers 401 or 403 for a HighLevel credential problem', async () => {
    // Those two codes belong to THIS route's own auth. Reusing them for the
    // upstream's refusal is how a bad CRM key becomes a surprise logout.
    H.pushResults = [CREDENTIAL_FAILURE];
    const res = await post({ trace_id: 't-1' });
    expect([401, 403]).not.toContain(res.status);
  });
});

// ---------------------------------------------------------------------------

describe('a bulk push reports what actually happened', () => {
  it('all pushed is a 200 success carrying the counts', async () => {
    H.pushResults = [CREATED];
    const res = await post({ job_id: 'j-1' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      pushed: 3,
      failed: 0,
      total: 3,
    });
  });

  it('every record failing is a FAILURE, not a green "0 contacts pushed"', async () => {
    H.pushResults = [CREDENTIAL_FAILURE];
    const res = await post({ job_id: 'j-1' });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      kind: 'credential',
      reason: 'scope',
      pushed: 0,
      failed: 3,
      total: 3,
    });
    // The customer must be able to read the cause off the message.
    expect(body.error).toContain('contacts.write');
  });

  it('a partial job is not a success, and says how many failed', async () => {
    H.pushResults = [CREATED, CREATED, RECORD_FAILURE];
    const res = await post({ job_id: 'j-1' });

    // 207 Multi-Status: the parts genuinely had different outcomes. The body,
    // not the transport code, is what the UI now reads.
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      kind: 'record',
      pushed: 2,
      failed: 1,
      total: 3,
    });
    expect(body.error).toContain('1');
  });

  it('surfaces the DOMINANT failure kind, not whichever failed first', async () => {
    // One bad payload among two credential failures is still a credential
    // problem: "3 records had bad payloads" and "your key is dead" need
    // different answers from the user.
    H.pushResults = [RECORD_FAILURE, CREDENTIAL_FAILURE, CREDENTIAL_FAILURE];
    const res = await post({ job_id: 'j-1' });

    const body = await res.json();
    expect(body).toMatchObject({ kind: 'credential', reason: 'scope', pushed: 0, failed: 3 });
    expect(res.status).toBe(502);
  });

  it('breaks a tie towards credential, because that one keeps failing', async () => {
    H.traces = [TRACE, TRACE];
    H.pushResults = [RECORD_FAILURE, CREDENTIAL_FAILURE];
    const res = await post({ job_id: 'j-1' });

    await expect(res.json()).resolves.toMatchObject({ kind: 'credential' });
  });

  it('reports a transient-dominated job as retryable', async () => {
    H.pushResults = [TRANSIENT_FAILURE];
    const res = await post({ job_id: 'j-1' });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ kind: 'transient', pushed: 0, failed: 3 });
  });
});

// ---------------------------------------------------------------------------

describe('the gates in front of all of that still hold', () => {
  it('rejects an anonymous caller', async () => {
    H.user = null;
    expect((await post({ trace_id: 't-1' })).status).toBe(401);
  });

  it('rejects a non-pro caller', async () => {
    H.profile = { ...PRO_PROFILE, subscription_tier: 'free' };
    expect((await post({ trace_id: 't-1' })).status).toBe(403);
  });

  it('rejects a caller with no HighLevel credentials stored', async () => {
    H.profile = { ...PRO_PROFILE, highlevel_api_key: null };
    expect((await post({ trace_id: 't-1' })).status).toBe(400);
  });

  it('rejects a request naming neither a trace nor a job', async () => {
    expect((await post({})).status).toBe(400);
  });
});
