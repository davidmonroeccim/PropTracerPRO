import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Disconnect removes the credential, so it also removes the DIAGNOSIS of that
 * credential. `highlevel_invalid_reason` names a specific fix (paste a new key,
 * tick contacts.write, correct the location ID), so one left over from a key
 * that no longer exists is a wrong instruction attached to the next key the
 * user connects.
 */

const H = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  updateError: null as unknown,
}));

function chainTo(data: unknown, error: unknown = null) {
  const node: Record<string, unknown> = {};
  node.eq = () => Promise.resolve({ data, error });
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
      update: (payload: Record<string, unknown>) => {
        H.updates.push({ table, payload });
        return chainTo(null, H.updateError);
      },
    }),
  }),
}));

const { POST } = await import('@/app/api/integrations/highlevel/disconnect/route');

beforeEach(() => {
  H.user = { id: 'user-1' };
  H.updates = [];
  H.updateError = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('disconnecting clears the credential AND its health record', () => {
  it('nulls all five columns in one write', async () => {
    const res = await POST();
    expect(res.status).toBe(200);

    expect(H.updates).toHaveLength(1);
    const payload = H.updates[0].payload;

    // `in` rather than a null check: an ABSENT key satisfies "is null" just as
    // well as a null value, and an absent key leaves the column standing.
    for (const column of [
      'highlevel_api_key',
      'highlevel_location_id',
      'highlevel_invalid_at',
      'highlevel_invalid_status',
      'highlevel_invalid_reason',
    ]) {
      expect(column in payload, `${column} was not written`).toBe(true);
      expect(payload[column], `${column} was not nulled`).toBeNull();
    }
  });

  it('refuses an unauthenticated caller and writes nothing', async () => {
    H.user = null;
    const res = await POST();
    expect(res.status).toBe(401);
    expect(H.updates).toEqual([]);
  });

  it('reports a failed write rather than claiming a disconnect', async () => {
    H.updateError = { message: 'permission denied' };
    const res = await POST();
    expect(res.status).toBe(500);
    expect((await res.json()).success).toBe(false);
  });
});
