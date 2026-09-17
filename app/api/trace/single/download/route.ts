import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { buildExportCsv } from '@/lib/trace/exportCsv';
import type { TraceHistory } from '@/types';

/**
 * ONE TRACE, AS THE SAME SPREADSHEET A BULK JOB PRODUCES.
 *
 * WHY THIS EXISTS. Without it the export is bulk-only in practice: a customer
 * who traces a single address can read the result on screen and has no way to
 * get it into their own system except by retyping it. The county dossier makes
 * that worse, not better -- 65 more facts on a card that nothing can carry off.
 *
 * SAME 103 COLUMNS, from `lib/trace/exportCsv.ts`, on purpose. A single-record
 * file that had its own shape would mean a customer's importer worked for one
 * button and not the other, and the difference would only show up in their
 * system, not ours.
 *
 * AUTH IS THE BULK ROUTE'S, deliberately unchanged: the session cookie says who
 * is asking, and the row is fetched through the admin client with an explicit
 * `user_id` filter so the ownership check cannot be skipped by a missing
 * policy. A trace that is not yours is a 404, not a 403 -- the existence of
 * another customer's trace id is not ours to confirm.
 *
 * NO BILLING HAPPENS HERE. This is a re-read of a row already paid for. Nothing
 * in this file touches the wallet, a tier, or a charge.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const traceId = searchParams.get('trace_id');

    if (!traceId) {
      return NextResponse.json({ success: false, error: 'Missing trace_id' }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const adminClient = createAdminClient();

    const { data: trace } = await adminClient
      .from('trace_history')
      .select('*')
      .eq('id', traceId)
      .eq('user_id', user.id)
      .single();

    if (!trace) {
      return NextResponse.json({ success: false, error: 'Trace not found' }, { status: 404 });
    }

    const csvContent = buildExportCsv([trace as TraceHistory]);
    const date = new Date().toISOString().substring(0, 10);

    return new Response(csvContent, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="trace-result-${date}.csv"`,
      },
    });
  } catch (error) {
    console.error('Single download error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
