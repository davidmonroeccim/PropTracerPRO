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
  /** Every update the route (or the credential recorder) wrote. */
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  /**
   * Every SELECT, with the columns asked for and the filters applied.
   *
   * Recorded because the job branch's bug was a FILTER: it selected the job's
   * rows by `tracerfy_job_id`, which a tier 2 row never has. The stub cannot
   * model PostgREST filtering, so the predicate itself is what the test reads.
   */
  selects: [] as Array<{ table: string; columns: string; filters: Array<[string, ...unknown[]]> }>,
}));

/** Minimal PostgREST-shaped builder: chainable, and awaitable at either terminator. */
function chain(
  rows: { single?: unknown; list?: unknown },
  filters?: Array<[string, ...unknown[]]>
) {
  const node: Record<string, unknown> = {};
  const add =
    (method: string) =>
    (...args: unknown[]) => {
      filters?.push([method, ...args]);
      return node;
    };
  for (const m of ['eq', 'not', 'is', 'select', 'order', 'limit', 'ilike']) node[m] = add(m);
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
      select: (columns?: string) => {
        const filters: Array<[string, ...unknown[]]> = [];
        H.selects.push({ table, columns: String(columns ?? ''), filters });
        if (table === 'user_profiles') return chain({ single: H.profile }, filters);
        if (table === 'trace_jobs') return chain({ single: H.job }, filters);
        return chain({ single: H.trace, list: H.traces }, filters);
      },
      update: (payload: Record<string, unknown>) => {
        H.updates.push({ table, payload });
        return chain({});
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
  H.updates = [];
  H.selects = [];
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

/**
 * THE BUTTON IS A PUSH SITE LIKE ANY OTHER, and it has to record the outcome
 * against the credential too. Two reasons, neither optional:
 *
 *  - a manual push is often the FIRST thing a user does after setting the key
 *    up, so it is the first chance anyone has to find out the key is dead;
 *  - a manual push that WORKS has to clear a flag an earlier automatic push
 *    set, or the badge stays red beside a push that just succeeded.
 *
 * These run through the real recorder and the same mocked admin client, so the
 * assertions are on the values that reach user_profiles.
 */
describe('the manual push records what happened to the credential', () => {
  const flagWrite = () =>
    H.updates.find((u) => u.table === 'user_profiles' && 'highlevel_invalid_at' in u.payload);

  it('flags the credential, with the reason, on a single credential failure', async () => {
    H.pushResults = [CREDENTIAL_FAILURE];

    await post({ trace_id: 't-1' });

    const flag = flagWrite();
    expect(flag).toBeDefined();
    expect(flag?.payload.highlevel_invalid_reason).toBe('scope');
    expect(flag?.payload.highlevel_invalid_status).toBe(401);
    expect(flag?.payload.highlevel_invalid_at).not.toBeNull();
  });

  it('leaves the credential alone when only the record was refused', async () => {
    H.pushResults = [RECORD_FAILURE];
    await post({ trace_id: 't-1' });
    expect(flagWrite()).toBeUndefined();
  });

  it('leaves the credential alone on a transient failure', async () => {
    H.pushResults = [TRANSIENT_FAILURE];
    await post({ trace_id: 't-1' });
    expect(flagWrite()).toBeUndefined();
  });

  it('clears the flag when a push succeeds against a credential that was flagged', async () => {
    H.profile = { ...PRO_PROFILE, highlevel_invalid_at: '2026-09-17T00:00:00.000Z' };
    H.pushResults = [CREATED];

    await post({ trace_id: 't-1' });

    const cleared = flagWrite();
    expect(cleared).toBeDefined();
    expect('highlevel_invalid_status' in (cleared?.payload ?? {})).toBe(true);
    expect('highlevel_invalid_reason' in (cleared?.payload ?? {})).toBe(true);
    expect(cleared?.payload.highlevel_invalid_at).toBeNull();
    expect(cleared?.payload.highlevel_invalid_status).toBeNull();
    expect(cleared?.payload.highlevel_invalid_reason).toBeNull();
  });

  it('writes nothing when a push succeeds against a credential nobody flagged', async () => {
    H.pushResults = [CREATED];
    await post({ trace_id: 't-1' });
    expect(H.updates).toEqual([]);
  });

  it('flags the credential ONCE for a bulk job where every write was refused', async () => {
    H.pushResults = [CREDENTIAL_FAILURE, CREDENTIAL_FAILURE, CREDENTIAL_FAILURE];

    await post({ job_id: 'j-1' });

    const flags = H.updates.filter(
      (u) => u.table === 'user_profiles' && 'highlevel_invalid_at' in u.payload
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].payload.highlevel_invalid_reason).toBe('scope');
  });

  it('flags the credential on a partial bulk job, because one refusal is enough', async () => {
    // 207 territory: some pushed, some did not. A credential complaint anywhere
    // in the batch is still a credential complaint.
    H.pushResults = [CREATED, CREDENTIAL_FAILURE, CREATED];

    await post({ job_id: 'j-1' });

    expect(flagWrite()?.payload.highlevel_invalid_reason).toBe('scope');
  });
});

/* ------------------------------------------------------------------ *
 * THE JOB BUTTON HAS TO FIND THE JOB'S OWN ROWS.
 *
 * It selected them with `.eq('tracerfy_job_id', job.tracerfy_job_id)`. A Full
 * Property Trace row never has a tracerfy_job_id -- it is nulled the moment the
 * row settles -- so a MIXED job pushed only its tier 1 half and said nothing
 * about the rest, and an all-tier-2 job answered "No successful results to
 * push" while holding a full set of paid-for contacts.
 *
 * `trace_job_id` is the job's own foreign key and every row of the job carries
 * it, whichever tier it is.
 * ------------------------------------------------------------------ */
describe('the job push finds tier 2 rows', () => {
  /** A tier 1 row: settled through Tracerfy's batch, so it has a batch id. */
  const TIER1_ROW = {
    id: 'row-tier1',
    trace_result: { owner_name: 'Tier One Owner', phones: [], emails: [] },
    normalized_address: '1 FIRST ST',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    is_successful: true,
    tracerfy_job_id: 'tj-1',
  };

  /** A tier 2 row: settled inline or by the cron, so it has NO batch id at all. */
  const TIER2_ROW = {
    id: 'row-tier2',
    trace_result: { owner_name: 'Tier Two Owner', phones: [], emails: [] },
    normalized_address: '2 SECOND ST',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    is_successful: true,
    tracerfy_job_id: null,
  };

  const traceSelect = () =>
    H.selects.find((s) => s.table === 'trace_history' && s.filters.some((f) => f[0] === 'eq'));

  it("selects the job's rows by trace_job_id, which a tier 2 row actually has", async () => {
    H.job = { tracerfy_job_id: null, status: 'completed' };
    H.traces = [TIER1_ROW, TIER2_ROW];
    H.pushResults = [CREATED];

    await post({ job_id: 'j-1' });

    const select = traceSelect();
    expect(select).toBeDefined();
    expect(select!.filters).toContainEqual(['eq', 'trace_job_id', 'j-1']);
    // The predicate that excluded every tier 2 row is gone, not merely joined.
    expect(select!.filters.some((f) => f[1] === 'tracerfy_job_id')).toBe(false);
  });

  it('pushes the tier 2 half of a mixed job, not only the tier 1 half', async () => {
    H.job = { tracerfy_job_id: 'tj-1', status: 'completed' };
    H.traces = [TIER1_ROW, TIER2_ROW];
    H.pushResults = [CREATED];

    const res = await post({ job_id: 'j-1' });
    const body = await res.json();

    expect(body).toMatchObject({ success: true, pushed: 2, failed: 0, total: 2 });

    const { pushTraceToHighLevel } = await import('@/lib/highlevel/client');
    const owners = vi
      .mocked(pushTraceToHighLevel)
      .mock.calls.map((c) => c[0].traceResult.owner_name);
    expect(owners).toContain('Tier Two Owner');
  });

  it("never pushes the internal parcel key into the customer's CRM (D38)", async () => {
    // Both push sites, the single and the job loop (L-018).
    // MUTATION: put `trace.normalized_address || undefined` back at EITHER call site and this
    // goes red for that site.
    const APN_ROW = {
      id: 'row-apn',
      trace_result: { owner_name: 'Parcel Owner', phones: [], emails: [] },
      normalized_address: 'APN|0123-456|TRAVIS|TX',
      city: null,
      state: 'TX',
      zip: null,
      parcel_id_local: '0123-456',
      county: 'Travis',
      is_successful: true,
      tracerfy_job_id: null,
    };
    const { pushTraceToHighLevel } = await import('@/lib/highlevel/client');

    H.trace = APN_ROW as never;
    vi.mocked(pushTraceToHighLevel).mockClear();
    await post({ trace_id: 't-1' });
    expect(vi.mocked(pushTraceToHighLevel).mock.calls[0][0].propertyAddress).toBe(
      'Parcel 0123-456, Travis County'
    );

    H.job = { tracerfy_job_id: null, status: 'completed' };
    H.traces = [APN_ROW];
    H.pushResults = [CREATED];
    vi.mocked(pushTraceToHighLevel).mockClear();
    await post({ job_id: 'j-1' });
    expect(vi.mocked(pushTraceToHighLevel).mock.calls[0][0].propertyAddress).toBe(
      'Parcel 0123-456, Travis County'
    );
  });

  it('records each pushed row against its own id', async () => {
    H.job = { tracerfy_job_id: null, status: 'completed' };
    H.traces = [TIER1_ROW, TIER2_ROW];
    H.pushResults = [
      { success: true, contactId: 'c-one', action: 'created' },
      { success: true, contactId: 'c-two', action: 'updated' },
    ];

    await post({ job_id: 'j-1' });

    const records = H.updates.filter(
      (u) => u.table === 'trace_history' && 'highlevel_pushed_at' in u.payload
    );
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.payload.highlevel_contact_id).sort()).toEqual([
      'c-one',
      'c-two',
    ]);
    for (const record of records) {
      expect('highlevel_contact_id' in record.payload).toBe(true);
      expect('highlevel_pushed_at' in record.payload).toBe(true);
    }
  });

  it('records the single push too, on the trace the caller named', async () => {
    H.trace = { ...TRACE, id: 't-1' };
    H.pushResults = [{ success: true, contactId: 'c-single', action: 'updated' }];

    await post({ trace_id: 't-1' });

    const records = H.updates.filter(
      (u) => u.table === 'trace_history' && 'highlevel_pushed_at' in u.payload
    );
    expect(records).toHaveLength(1);
    expect(records[0].payload.highlevel_contact_id).toBe('c-single');
    expect(records[0].payload.highlevel_push_action).toBe('updated');
  });
});

/* ------------------------------------------------------------------ *
 * THE BUTTON IS THE ONLY THING LEFT THAT PUSHES, SO IT HAS TO WORK.
 *
 * Every automatic push was removed: PTP never calls HighLevel unless a person
 * asked it to. This route IS the person asking. The eight fences around the
 * settle paths all assert an ABSENCE, and an absence is cheap to satisfy by
 * breaking the push everywhere at once. These assert the presence at both
 * tiers, on both branches, so a removal that went one file too far is not
 * reported as a clean run.
 * ------------------------------------------------------------------ */
describe('the manual push still reaches HighLevel, at both tiers', () => {
  /** A tier 1 row: settled through Tracerfy's batch, so it carries a batch id. */
  const TIER1 = {
    id: 'row-tier1',
    trace_result: { owner_name: 'Tier One Owner', phones: [], emails: [] },
    normalized_address: '1 FIRST ST',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    is_successful: true,
    tracerfy_job_id: 'tj-1',
  };

  /** A tier 2 row: a Full Property Trace, which has NO batch id at all. */
  const TIER2 = {
    id: 'row-tier2',
    trace_result: { owner_name: 'Tier Two Owner', phones: [], emails: [] },
    normalized_address: '2 SECOND ST',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    is_successful: true,
    tracerfy_job_id: null,
  };

  /**
   * The client mock is module-level and its call history accumulates across
   * this whole file, so "it pushed Tier Two Owner" would otherwise be
   * satisfiable by an earlier test's call (L-013). Cleared per test.
   */
  beforeEach(async () => {
    const { pushTraceToHighLevel } = await import('@/lib/highlevel/client');
    vi.mocked(pushTraceToHighLevel).mockClear();
  });

  it.each([
    ['tier 1', TIER1, 'Tier One Owner'],
    ['tier 2', TIER2, 'Tier Two Owner'],
  ])('pushes a %s single and answers 200', async (_label, row, owner) => {
    H.trace = { ...row };
    H.pushResults = [CREATED];

    const res = await post({ trace_id: row.id });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, action: 'created' });

    const { pushTraceToHighLevel } = await import('@/lib/highlevel/client');
    // Exactly one push, and it carried the contacts off THIS row with the
    // credential off the profile.
    expect(pushTraceToHighLevel).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(pushTraceToHighLevel).mock.calls[0][0];
    expect(arg.traceResult.owner_name).toBe(owner);
    expect(arg.apiKey).toBe('key-1');
    expect(arg.locationId).toBe('loc-1');
  });

  it('pushes a job holding one row of each tier, and counts both', async () => {
    H.job = { tracerfy_job_id: null, status: 'completed' };
    H.traces = [TIER1, TIER2];
    H.pushResults = [CREATED];

    const body = await (await post({ job_id: 'j-1' })).json();
    expect(body).toMatchObject({ success: true, pushed: 2, failed: 0, total: 2 });

    const { pushTraceToHighLevel } = await import('@/lib/highlevel/client');
    expect(pushTraceToHighLevel).toHaveBeenCalledTimes(2);
    const owners = vi
      .mocked(pushTraceToHighLevel)
      .mock.calls.map((c) => c[0].traceResult.owner_name);
    expect(owners).toContain('Tier One Owner');
    expect(owners).toContain('Tier Two Owner');
  });
});
