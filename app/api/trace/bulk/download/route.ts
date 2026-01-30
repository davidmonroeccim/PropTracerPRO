import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { TraceJob, TraceHistory, TraceResult, AIResearchResult } from '@/types';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('job_id');

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'Missing job_id' },
        { status: 400 }
      );
    }

    // Check authentication
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const adminClient = createAdminClient();

    // Look up the trace job
    const { data: job } = await adminClient
      .from('trace_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .single();

    if (!job) {
      return NextResponse.json(
        { success: false, error: 'Job not found' },
        { status: 404 }
      );
    }

    const traceJob = job as TraceJob;

    if (traceJob.status !== 'completed') {
      return NextResponse.json(
        { success: false, error: 'Job is not yet completed' },
        { status: 400 }
      );
    }

    if (!traceJob.tracerfy_job_id) {
      return NextResponse.json(
        { success: false, error: 'No results available' },
        { status: 400 }
      );
    }

    // Query trace_history rows for this job
    const { data: rows, error: queryError } = await adminClient
      .from('trace_history')
      .select('*')
      .eq('user_id', user.id)
      .eq('tracerfy_job_id', traceJob.tracerfy_job_id)
      .order('created_at', { ascending: true });

    if (queryError) {
      console.error('Failed to query trace history:', queryError.message);
      return NextResponse.json(
        { success: false, error: 'Failed to retrieve results' },
        { status: 500 }
      );
    }

    const historyRows = (rows || []) as TraceHistory[];

    // Check if any rows have AI research data
    const hasResearch = historyRows.some((row) => row.ai_research);

    // Build CSV
    const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;

    const baseHeaders = 'address,city,state,zip,owner_name,status,phone_1,phone_2,phone_3,email_1,email_2,email_3,mailing_address,mailing_city,mailing_state,charge';
    const researchHeaders = hasResearch ? ',owner_type,deceased,relatives,property_type' : '';

    const csvLines = [baseHeaders + researchHeaders];

    for (const row of historyRows) {
      const result = row.trace_result as TraceResult | null;
      const phones = result?.phones || [];
      const emails = result?.emails || [];

      const baseCols = [
        esc(row.normalized_address || ''),
        esc(row.city || ''),
        esc(row.state || ''),
        esc(row.zip || ''),
        esc(result?.owner_name || row.input_owner_name || ''),
        esc(row.status),
        esc(phones[0]?.number || ''),
        esc(phones[1]?.number || ''),
        esc(phones[2]?.number || ''),
        esc(emails[0] || ''),
        esc(emails[1] || ''),
        esc(emails[2] || ''),
        esc(result?.mailing_address || ''),
        esc(result?.mailing_city || ''),
        esc(result?.mailing_state || ''),
        (row.charge || 0).toFixed(2),
      ];

      if (hasResearch) {
        const research = row.ai_research as AIResearchResult | null;
        baseCols.push(
          esc(research?.owner_type || ''),
          esc(research?.is_deceased === true ? 'Yes' : research?.is_deceased === false ? 'No' : ''),
          esc((research?.relatives || []).join('; ')),
          esc(research?.property_type || ''),
        );
      }

      csvLines.push(baseCols.join(','));
    }

    const csvContent = csvLines.join('\n');
    const date = new Date().toISOString().substring(0, 10);

    return new Response(csvContent, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="bulk-results-${date}.csv"`,
      },
    });
  } catch (error) {
    console.error('Bulk download error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
