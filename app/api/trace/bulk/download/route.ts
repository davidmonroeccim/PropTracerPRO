import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { buildExportCsv } from '@/lib/trace/exportCsv';
import type { TraceJob, TraceHistory } from '@/types';

/**
 * How many rows are asked for at a time.
 *
 * THIS ROUTE USED TO HAVE NO RANGE AT ALL, and PostgREST silently caps an
 * unbounded select at 1,000. A job with more rows than that lost the rest with
 * NO error: a 200, a valid CSV, and a customer who has no way to tell that the
 * file is short. The biggest job to date is 345 rows so nobody has been bitten,
 * but MAX_RECORDS is 10,000, so it was waiting.
 *
 * The loop stops on an EMPTY page rather than on a short one. A short page would
 * also be the answer if the server's own cap were below this number, and
 * treating that as "the end" is the same silent truncation in a new place.
 */
const PAGE_SIZE = 1000;

/**
 * The most rows a bulk job can contain, mirroring `MAX_RECORDS` in the two
 * submit routes (`app/api/trace/bulk/route.ts` and its v1 twin) and the upload
 * guard on the bulk page. Kept as a local constant rather than imported, because
 * importing a submit route would drag its whole vendor and billing graph into a
 * download.
 *
 * It exists here only to BOUND THE LOOP. If a future client ever ignored
 * `.range()`, every page would come back full and non-empty and the loop would
 * run forever holding the whole table in memory. The cap turns that into an
 * error instead of a hang.
 */
const MAX_EXPORT_ROWS = 10000;

/** Full pages for a maximum job, plus the one empty page that confirms the end. */
const MAX_PAGES = Math.ceil(MAX_EXPORT_ROWS / PAGE_SIZE) + 1;

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
    //
    // REBUILT PER PAGE rather than reused: a PostgREST builder is a one-shot
    // thenable, and handing the same one two ranges is how a paginated read
    // quietly returns the first page twice.
    const pageOf = (from: number) => {
      const query = adminClient.from('trace_history').select('*').eq('user_id', user.id);

      return (
        traceJob.tracerfy_job_id
          ? query.or(`tracerfy_job_id.eq.${traceJob.tracerfy_job_id},trace_job_id.eq.${traceJob.id}`)
          : query.eq('trace_job_id', traceJob.id)
      )
        .order('created_at', { ascending: true })
        // The tiebreaker is not decoration. Two rows written in the same
        // instant have no defined order between them, and an undefined order
        // across a page boundary drops one row and repeats another.
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
    };

    const historyRows: TraceHistory[] = [];
    let from = 0;
    let complete = false;

    for (let requests = 0; requests < MAX_PAGES; requests++) {
      const { data, error: queryError } = await pageOf(from);

      // A FAILED PAGE MUST NOT BECOME A SHORT FILE. Breaking out here instead of
      // returning would hand back a 200 and a valid-looking CSV missing every
      // row after the failure, which is byte for byte the silent truncation this
      // pagination exists to remove, just moved into the error branch. The whole
      // download fails or none of it does.
      if (queryError) {
        console.error('Failed to query trace history:', queryError.message);
        return NextResponse.json(
          { success: false, error: 'Failed to retrieve results' },
          { status: 500 }
        );
      }

      const page = (data || []) as TraceHistory[];
      if (page.length === 0) {
        complete = true;
        break;
      }
      historyRows.push(...page);
      from += page.length;
    }

    // Ran out of pages without ever seeing the end. Something is wrong with the
    // read, and a truncated file is the one answer that must never ship.
    if (!complete) {
      console.error(
        `Bulk download exceeded ${MAX_PAGES} pages for job ${traceJob.id}; refusing to serve a partial file`
      );
      return NextResponse.json(
        { success: false, error: 'Failed to retrieve results' },
        { status: 500 }
      );
    }

    // The 103 columns live in lib/trace/exportCsv.ts, shared with the
    // single-record download so the two files cannot drift apart. The header is
    // FIXED: it no longer depends on whether a row in this particular job
    // happens to carry research or a skip reason, because a header that changes
    // shape between two downloads of the same product breaks the importer
    // pointed at it.
    const csvContent = buildExportCsv(historyRows);
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
