import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { pushTraceToHighLevel } from '@/lib/highlevel/client';
import type { TraceResult } from '@/types';

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
      .select('highlevel_api_key, highlevel_location_id, subscription_tier, is_acquisition_pro_member')
      .eq('id', user.id)
      .single();

    if (!profile || (profile.subscription_tier !== 'pro' && !profile.is_acquisition_pro_member)) {
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
      let failed = 0;

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
          failed++;
        }
      }

      return NextResponse.json({ success: true, pushed, failed, total: traces.length });
    }
  } catch (error) {
    console.error('CRM push error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
