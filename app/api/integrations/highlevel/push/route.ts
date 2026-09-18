import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { effectiveIsPro } from '@/lib/suite/entitlements';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import type { HighLevelFailureKind, HighLevelPushResult } from '@/lib/highlevel/client';
import type { TraceResult } from '@/types';

type PushFailure = Extract<HighLevelPushResult, { success: false }>;

/**
 * What the CALLER should do, expressed as a status code.
 *
 * Deliberately not 401 or 403 for a credential failure: those two are this
 * route's own auth answers (:14 and :36 below), and a 401 on the wire makes a
 * browser think the PTP session died, so a bad HighLevel key would read as a
 * surprise logout. 502 says what is true: the request was fine and the user is
 * authorised here, but the upstream CRM refused us.
 */
const STATUS_FOR_KIND: Record<HighLevelFailureKind, number> = {
  credential: 502, // the upstream refused our credential; the user must reconnect it
  record: 422, // this payload is the problem and nothing else is
  transient: 503, // the standard retryable status
};

/**
 * Which failure a mixed batch should be REPORTED as. The most common one, and a
 * tie goes to credential: "3 records had bad payloads" and "your key is dead"
 * need different answers from the user, and the dead key is the one that will
 * keep failing until someone acts on it.
 */
const KIND_PRECEDENCE: HighLevelFailureKind[] = ['credential', 'record', 'transient'];

function dominantFailure(failures: PushFailure[]): PushFailure {
  const counts = new Map<HighLevelFailureKind, number>();
  for (const f of failures) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);

  // Walk in precedence order and only ever take a STRICTLY larger count, so an
  // equal count leaves the earlier (more urgent) kind in place.
  let winner = KIND_PRECEDENCE[0];
  for (const kind of KIND_PRECEDENCE.slice(1)) {
    if ((counts.get(kind) ?? 0) > (counts.get(winner) ?? 0)) winner = kind;
  }
  // The first failure OF the winning kind: its `error` already carries the
  // remediation sentence, so there is no second copy of that copy to drift.
  return failures.find((f) => f.kind === winner) ?? failures[0];
}

/** The classification a failure carries, flattened for the JSON body. */
function failureBody(failure: PushFailure, error?: string) {
  return {
    success: false as const,
    kind: failure.kind,
    ...(failure.kind === 'credential' ? { reason: failure.reason } : {}),
    error: error ?? failure.error,
  };
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { trace_id, job_id } = body;

    if (!trace_id && !job_id) {
      return NextResponse.json({ error: 'trace_id or job_id required' }, { status: 400 });
    }

    // Get user's HighLevel credentials and subscription info
    const adminClient = createAdminClient();
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('highlevel_api_key, highlevel_location_id, subscription_tier, is_acquisition_pro_member, gateway_products')
      .eq('id', user.id)
      .single();

    if (!profile || !effectiveIsPro(profile)) {
      return NextResponse.json(
        { error: 'CRM push requires a Pro subscription. Upgrade at Settings → Billing.' },
        { status: 403 }
      );
    }

    if (!profile?.highlevel_api_key || !profile?.highlevel_location_id) {
      return NextResponse.json(
        { error: 'HighLevel not configured. Set it up in Settings → Integrations.' },
        { status: 400 }
      );
    }

    // Single trace push
    if (trace_id) {
      const { data: trace } = await adminClient
        .from('trace_history')
        .select('trace_result, normalized_address, city, state, zip, is_successful')
        .eq('id', trace_id)
        .eq('user_id', user.id)
        .single();

      if (!trace) {
        return NextResponse.json({ error: 'Trace not found' }, { status: 404 });
      }

      if (!trace.is_successful || !trace.trace_result) {
        return NextResponse.json({ error: 'No results to push' }, { status: 400 });
      }

      const result = await pushTraceToHighLevel({
        apiKey: profile.highlevel_api_key,
        locationId: profile.highlevel_location_id,
        traceResult: trace.trace_result as TraceResult,
        propertyAddress: trace.normalized_address || undefined,
        propertyCity: trace.city || undefined,
        propertyState: trace.state || undefined,
        propertyZip: trace.zip || undefined,
      });

      // A `{ success: false }` body used to leave here as an HTTP 200, which
      // made every `!response.ok` check downstream report a success.
      if (!result.success) {
        return NextResponse.json(failureBody(result), { status: STATUS_FOR_KIND[result.kind] });
      }

      return NextResponse.json(result);
    }

    // Bulk job push
    if (job_id) {
      // Verify job belongs to user
      const { data: job } = await adminClient
        .from('trace_jobs')
        .select('tracerfy_job_id, status')
        .eq('id', job_id)
        .eq('user_id', user.id)
        .single();

      if (!job) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 });
      }

      if (job.status !== 'completed') {
        return NextResponse.json({ error: 'Job not completed' }, { status: 400 });
      }

      // Get all successful traces for this job
      const { data: traces } = await adminClient
        .from('trace_history')
        .select('trace_result, normalized_address, city, state, zip')
        .eq('user_id', user.id)
        .eq('tracerfy_job_id', job.tracerfy_job_id)
        .eq('is_successful', true)
        .not('trace_result', 'is', null);

      if (!traces || traces.length === 0) {
        return NextResponse.json({ error: 'No successful results to push' }, { status: 400 });
      }

      let pushed = 0;
      const failures: PushFailure[] = [];

      for (const trace of traces) {
        const result = await pushTraceToHighLevel({
          apiKey: profile.highlevel_api_key,
          locationId: profile.highlevel_location_id,
          traceResult: trace.trace_result as TraceResult,
          propertyAddress: trace.normalized_address || undefined,
          propertyCity: trace.city || undefined,
          propertyState: trace.state || undefined,
          propertyZip: trace.zip || undefined,
        });

        if (result.success) {
          pushed++;
        } else {
          failures.push(result);
        }
      }

      const failed = failures.length;
      const total = traces.length;

      if (failed === 0) {
        return NextResponse.json({ success: true, pushed, failed, total });
      }

      // `failed` used to be counted here and rendered nowhere, under a
      // hardcoded `success: true`. A 50 record job where every write 401'd came
      // back as a green check reading "0 contacts pushed".
      const failure = dominantFailure(failures);

      if (pushed === 0) {
        return NextResponse.json(
          {
            ...failureBody(
              failure,
              `None of the ${total} contacts reached HighLevel. ${failure.error}`
            ),
            pushed,
            failed,
            total,
          },
          { status: STATUS_FOR_KIND[failure.kind] }
        );
      }

      // 207 Multi-Status: the parts genuinely had different outcomes. The body,
      // not the transport code, is what says so.
      return NextResponse.json(
        {
          ...failureBody(
            failure,
            `${pushed} of ${total} pushed. ${failed} failed. ${failure.error}`
          ),
          pushed,
          failed,
          total,
        },
        { status: 207 }
      );
    }
  } catch (error) {
    console.error('CRM push error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
