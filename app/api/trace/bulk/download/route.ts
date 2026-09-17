import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { skipReasonFor } from '@/lib/trace/blankOwnerSkip';
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

    // NOTE: a missing tracerfy_job_id is no longer a reason to refuse. A job
    // whose every row was skipped for a blank owner name never gets a Tracerfy
    // job at all, and it still has rows that have to be downloadable, or the
    // only place the skip reason is written is a database column the customer
    // cannot see.
    //
    // Query trace_history rows for this job. TWO keys, because the two kinds of
    // row are found by different columns: a traced row by the Tracerfy job it
    // was submitted in, a skipped row by the bulk job it belongs to. Rows
    // written before trace_job_id was populated on this path carry only the
    // former, which is why the Tracerfy arm stays.
    const historyQuery = adminClient
      .from('trace_history')
      .select('*')
      .eq('user_id', user.id);

    const { data: rows, error: queryError } = await (traceJob.tracerfy_job_id
      ? historyQuery.or(
          `tracerfy_job_id.eq.${traceJob.tracerfy_job_id},trace_job_id.eq.${traceJob.id}`
        )
      : historyQuery.eq('trace_job_id', traceJob.id)
    ).order('created_at', { ascending: true });

    if (queryError) {
      console.error('Failed to query trace history:', queryError.message);
      return NextResponse.json(
        { success: false, error: 'Failed to retrieve results' },
        { status: 500 }
      );
    }

    const historyRows = (rows || []) as TraceHistory[];

    // The four research columns are HISTORICAL. `deceased` and `relatives` could only ever
    // be produced by the AI Search engine, which was removed on 2026-09-17, and a row
    // written since then carries neither. They stay because the 1,301 rows that do carry
    // them are data the customer paid for and this download is one of the places that
    // serves it. The header only appears when a row in this job actually has research, so a
    // new job exports the base columns and nothing empty.
    const hasResearch = historyRows.some((row) => row.ai_research);

    // A row we accepted and did not trace carries a reason. Asked of
    // skipReasonFor(), the one accessor for "why did this come back empty
    // without being traced", so the column appears for every such row and not
    // just the blank-owner kind. Only added when one of them is in the file, so
    // a normal job's CSV is unchanged. Without it a skipped row reads as a
    // plain no_match, which is the one thing it must never silently look like.
    const hasSkipped = historyRows.some((row) => skipReasonFor(row.ai_research_status) !== null);

    // Build CSV
    const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;

    const baseHeaders = 'address,city,state,zip,owner_name,status,phone_1,phone_2,phone_3,email_1,email_2,email_3,mailing_address,mailing_city,mailing_state,charge';
    const skipHeader = hasSkipped ? ',skip_reason' : '';
    const researchHeaders = hasResearch ? ',owner_type,deceased,relatives,property_type' : '';

    const csvLines = [baseHeaders + skipHeader + researchHeaders];

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

      if (hasSkipped) {
        baseCols.push(esc(skipReasonFor(row.ai_research_status) || ''));
      }

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
