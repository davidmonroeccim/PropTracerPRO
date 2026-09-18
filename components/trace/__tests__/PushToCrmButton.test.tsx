import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PushOutcomeMessage, requestPush } from '@/components/trace/PushToCrmButton';

/**
 * WHY THIS FILE EXISTS. The button branched on `response.ok`, then on
 * `data.pushed`, then on `data.action`, and never once read `data.success`. A
 * dead API key produced `{success:false, error:'Failed to create contact'}` at
 * HTTP 200, so `response.ok` was true, `pushed` and `action` were both
 * undefined, and the customer got a GREEN CHECK reading "Contact created" for a
 * contact that was never created.
 *
 * The repo has no DOM environment (no jsdom, no testing-library) and component
 * tests here are static renders. So the decision the handler used to make
 * inline now lives in `requestPush`, which is a plain async function these
 * tests call directly, and the two result states render through
 * `PushOutcomeMessage`. `PushToCrmButtonProps` is UNCHANGED: the component is
 * mounted in six places and none of them had to move.
 */

let errorSpy: ReturnType<typeof vi.spyOn>;

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
    )
  );
}

beforeEach(() => {
  // L-013: the same spy object comes back on a re-spy and its history survives.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  errorSpy.mockClear();
  vi.unstubAllGlobals();
});

/** The visible words, markup removed, which is what the customer actually reads. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function render(outcome: Awaited<ReturnType<typeof requestPush>>): string {
  return renderToStaticMarkup(<PushOutcomeMessage outcome={outcome} />);
}

// ---------------------------------------------------------------------------

describe('a push that worked', () => {
  it('reads a created contact as a success', async () => {
    answer(200, { success: true, contactId: 'c-1', action: 'created' });
    expect(await requestPush({ trace_id: 't-1' })).toEqual({
      status: 'success',
      message: 'Contact created',
    });
  });

  it('reads an updated contact as a success', async () => {
    answer(200, { success: true, contactId: 'c-1', action: 'updated' });
    expect(await requestPush({ trace_id: 't-1' })).toEqual({
      status: 'success',
      message: 'Contact updated',
    });
  });

  it('renders a success in green with a check', async () => {
    answer(200, { success: true, action: 'created' });
    const markup = render(await requestPush({ trace_id: 't-1' }));
    expect(markup).toContain('text-green-600');
    expect(markup).not.toContain('text-red-600');
    expect(visibleText(markup)).toBe('Contact created');
  });
});

// ---------------------------------------------------------------------------

describe('a push that failed is never reported as a success', () => {
  it('a failure at a real error status renders an ERROR state', async () => {
    answer(502, {
      success: false,
      kind: 'credential',
      reason: 'token',
      error: 'HighLevel rejected your API key. Reconnect HighLevel in Settings.',
    });

    const outcome = await requestPush({ trace_id: 't-1' });
    expect(outcome).toEqual({
      status: 'error',
      message: 'HighLevel rejected your API key. Reconnect HighLevel in Settings.',
    });

    const markup = render(outcome);
    expect(markup).toContain('text-red-600');
    expect(markup).not.toContain('text-green-600');
  });

  it('a failure smuggled inside an HTTP 200 STILL renders an ERROR state', async () => {
    // This is the whole bug. The transport said 200; the body said it failed.
    // Reading `response.ok` alone is what produced a green "Contact created"
    // for a contact that does not exist, and this test is what stops it
    // coming back.
    answer(200, {
      success: false,
      kind: 'credential',
      reason: 'token',
      error: 'HighLevel rejected your API key. Reconnect HighLevel in Settings.',
    });

    const outcome = await requestPush({ trace_id: 't-1' });
    expect(outcome.status).toBe('error');
    expect(outcome.message).toBe('HighLevel rejected your API key. Reconnect HighLevel in Settings.');

    const markup = render(outcome);
    expect(markup).toContain('text-red-600');
    expect(visibleText(markup)).not.toContain('Contact created');
  });

  it('a 200 that does not positively claim success is an error, not a guess', async () => {
    // Repo rule 7. An absent `success` is not a success; we do not know what
    // happened, so we do not tell the customer their contact is in the CRM.
    answer(200, { contactId: 'c-1', action: 'created' });
    expect((await requestPush({ trace_id: 't-1' })).status).toBe('error');
  });

  it('falls back to a plain sentence when the body carries no error text', async () => {
    answer(502, { success: false, kind: 'credential' });
    expect(await requestPush({ trace_id: 't-1' })).toEqual({
      status: 'error',
      message: 'The push to HighLevel failed.',
    });
  });

  it('survives a body that is not JSON at all', async () => {
    answer(502, '<html>Bad Gateway</html>');
    expect((await requestPush({ trace_id: 't-1' })).status).toBe('error');
  });

  it('reports an unreachable server rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    expect(await requestPush({ trace_id: 't-1' })).toEqual({
      status: 'error',
      message: 'Could not reach the server. Check your connection and try again.',
    });
  });
});

// ---------------------------------------------------------------------------

describe('a bulk push tells the truth about the failures', () => {
  it('a clean bulk job reads as a success with its count', async () => {
    answer(200, { success: true, pushed: 3, failed: 0, total: 3 });
    expect(await requestPush({ job_id: 'j-1' })).toEqual({
      status: 'success',
      message: '3 contacts pushed',
    });
  });

  it('singularises one contact', async () => {
    answer(200, { success: true, pushed: 1, failed: 0, total: 1 });
    expect((await requestPush({ job_id: 'j-1' })).message).toBe('1 contact pushed');
  });

  it('a partial job does NOT render as a clean success', async () => {
    answer(207, {
      success: false,
      kind: 'record',
      pushed: 2,
      failed: 1,
      total: 3,
      error: '2 of 3 pushed. 1 failed. HighLevel would not accept this contact.',
    });

    const outcome = await requestPush({ job_id: 'j-1' });
    expect(outcome.status).toBe('error');
    expect(outcome.message).toContain('1 failed');

    const markup = render(outcome);
    expect(markup).toContain('text-red-600');
    expect(markup).not.toContain('text-green-600');
  });

  it('a job where every record failed never reads as "0 contacts pushed"', async () => {
    // The old bulk branch hardcoded success:true, so 50 failed writes came back
    // as a green check reading "0 contacts pushed".
    answer(502, {
      success: false,
      kind: 'credential',
      reason: 'scope',
      pushed: 0,
      failed: 50,
      total: 50,
      error:
        'None of the 50 contacts reached HighLevel. Your HighLevel token is missing the contacts.write permission. Reconnect it with that scope granted.',
    });

    const outcome = await requestPush({ job_id: 'j-1' });
    expect(outcome.status).toBe('error');
    expect(outcome.message).not.toContain('0 contacts pushed');
    expect(outcome.message).toContain('contacts.write');
  });
});

// ---------------------------------------------------------------------------

describe('what the request actually asks for', () => {
  it('sends the trace id for a single push and the job id for a bulk one', async () => {
    answer(200, { success: true, action: 'created' });
    await requestPush({ trace_id: 't-1' });
    const single = vi.mocked(fetch).mock.calls[0];
    expect(single[0]).toBe('/api/integrations/highlevel/push');
    expect(JSON.parse(String((single[1] as RequestInit).body))).toEqual({ trace_id: 't-1' });

    answer(200, { success: true, pushed: 0, failed: 0, total: 0 });
    await requestPush({ job_id: 'j-1' });
    const bulk = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String((bulk[1] as RequestInit).body))).toEqual({ job_id: 'j-1' });
  });
});

// ---------------------------------------------------------------------------

describe('the copy rules', () => {
  it('the strings this component composes carry no dash artifact, asterisk or emoji', async () => {
    const composed: string[] = [];
    for (const [status, body] of [
      [200, { success: true, action: 'created' }],
      [200, { success: true, action: 'updated' }],
      [200, { success: true, pushed: 1, failed: 0, total: 1 }],
      [200, { success: true, pushed: 4, failed: 0, total: 4 }],
      [502, { success: false }],
    ] as Array<[number, unknown]>) {
      answer(status, body);
      composed.push((await requestPush({ trace_id: 't-1' })).message);
    }

    expect(composed).toHaveLength(5);
    for (const message of composed) {
      expect(message).not.toMatch(/[–—*`#_]/u);
      expect(message).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
