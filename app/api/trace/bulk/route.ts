import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeAddress, createAddressHash } from '@/lib/utils/address-normalizer';
import { removeBatchDuplicates, checkDuplicates } from '@/lib/utils/deduplication';
import { submitBulkTrace } from '@/lib/tracerfy/client';
import { BLANK_OWNER_SKIP_REASON, BLANK_OWNER_SKIP_STATUS } from '@/lib/trace/blankOwnerSkip';
import { chargePerTrace, TRACE_SOURCE } from '@/lib/suite/pricing';
import type { AddressInput } from '@/types';

const MAX_RECORDS = 10000;

export async function POST(request: Request) {
  try {
    // Check authentication
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Parse request body
    const body: { records: AddressInput[]; fileName: string } = await request.json();
    const { records, fileName } = body;

    if (!records || !Array.isArray(records) || records.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No records provided' },
        { status: 400 }
      );
    }

    if (records.length > MAX_RECORDS) {
      return NextResponse.json(
        { success: false, error: `Maximum ${MAX_RECORDS} records per upload` },
        { status: 400 }
      );
    }

    // Get user profile for billing
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (!profile) {
      return NextResponse.json(
        { success: false, error: 'User profile not found' },
        { status: 400 }
      );
    }

    // Step 1: Remove internal batch duplicates
    const { unique, internalDuplicates } = removeBatchDuplicates(records);

    // Step 2: Check against 90-day history
    const dedupeResult = await checkDuplicates(user.id, unique);
    const newRecords = dedupeResult.newRecords;
    const historyDuplicates = dedupeResult.duplicates.length;
    const totalDeduped = internalDuplicates + historyDuplicates;

    // If no new records, return early
    if (newRecords.length === 0) {
      return NextResponse.json({
        success: true,
        job_id: null,
        total_records: records.length,
        dedupe_removed: totalDeduped,
        records_submitted: 0,
        cached_count: dedupeResult.cachedResults.length,
        estimated_cost: 0,
        message: 'All records are duplicates of previous traces',
      });
    }

    // Split the batch in two. A row with no owner of record has no route: the
    // AI Search engine that used to find an owner from an address alone was
    // removed on 2026-09-17, and the page's AI Research toggle went with it.
    // Sending it to Tracerfy anyway means a CSV line with an empty first and
    // last name, and bulk/status then deducts the tier 1 rate on whatever comes
    // back. David's rule: accept the file, skip the row, say why, charge
    // nothing. See lib/trace/blankOwnerSkip.ts, which the v1 bulk route and the
    // MCP submit already use.
    const traceableRecords: AddressInput[] = [];
    const skippedRecords: AddressInput[] = [];
    for (const record of newRecords) {
      if ((record.owner_name || '').trim()) {
        traceableRecords.push(record);
      } else {
        skippedRecords.push(record);
      }
    }

    // Check wallet balance for all users. Skipped rows are excluded because
    // they can never be charged.
    const perTrace = chargePerTrace(profile);
    const estimatedCost = traceableRecords.length * perTrace;
    if (profile.wallet_balance < estimatedCost) {
      return NextResponse.json(
        {
          success: false,
          error: `Insufficient wallet balance. Need $${estimatedCost.toFixed(2)} but have $${profile.wallet_balance.toFixed(2)}. Please add funds.`,
        },
        { status: 402 }
      );
    }

    const adminClient = createAdminClient();

    // Create trace_jobs row
    const { data: job, error: jobError } = await adminClient
      .from('trace_jobs')
      .insert({
        user_id: user.id,
        file_name: fileName || null,
        total_records: records.length,
        dedupe_removed: totalDeduped,
        // Only the rows a vendor is actually asked about. A skipped row was
        // never submitted, and counting it here would overstate the work.
        records_submitted: traceableRecords.length,
        records_matched: 0,
        status: 'processing',
        // THE SOURCE TAG IS A PRICE DECISION, NOT A LABEL. This route settles
        // through app/api/trace/bulk/status, which prices with the GRANT-AWARE
        // chargePerTrace() -- Track A. The two cron sweeps pick their
        // derivation from this tag and read an UNTAGGED row as Track B, the raw
        // and dearer one, so an entity row from this job would be billed $0.25
        // while its person siblings settled at $0.15 in the same batch. That is
        // the owner-type price split L-005 rules out. Tagged the same way
        // lib/suite/mcp-tools.ts tags its own job and rows.
        source: TRACE_SOURCE.WEB,
      })
      .select()
      .single();

    if (jobError || !job) {
      console.error('Failed to create trace job:', jobError?.message);
      return NextResponse.json(
        { success: false, error: 'Failed to create trace job' },
        { status: 500 }
      );
    }

    const BATCH_SIZE = 500;

    // trace_job_id links every row of this upload to its job, the same way the
    // v1 route does. Without it the skipped rows, which never get a
    // tracerfy_job_id, are invisible to the results CSV.
    const buildHistoryRow = (record: AddressInput) => {
      const normalizedAddress = normalizeAddress(record.address, record.city, record.state);
      return {
        user_id: user.id,
        trace_job_id: job.id,
        address_hash: createAddressHash(normalizedAddress),
        normalized_address: normalizedAddress,
        city: record.city.toUpperCase(),
        state: record.state.toUpperCase(),
        zip: (record.zip || '').substring(0, 5),
        input_owner_name: record.owner_name || null,
        // Same tag as the job above, and on EVERY row including the skipped
        // ones: the crons read the row's tag, not the job's.
        source: TRACE_SOURCE.WEB,
      };
    };

    const insertHistoryRows = async (rows: Record<string, unknown>[]) => {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const { error: insertError } = await adminClient
          .from('trace_history')
          .upsert(rows.slice(i, i + BATCH_SIZE), { onConflict: 'user_id,address_hash' });
        if (insertError) {
          console.error('Failed to insert trace history batch:', insertError.message);
        }
      }
    };

    // Blank-owner rows land already finished. No tracerfy_job_id, so the status
    // route never picks them up to settle or bill, and nothing money-shaped is
    // written: no charge, no ai_research_charge, no tier, because nothing was
    // billed. The reason reaches the user through the response below and the
    // skip_reason column of the results CSV.
    if (skippedRecords.length > 0) {
      await insertHistoryRows(
        skippedRecords.map((r) => ({
          ...buildHistoryRow(r),
          ai_research_status: BLANK_OWNER_SKIP_STATUS,
          status: 'no_match' as const,
        }))
      );
    }

    // Nothing to trace. Close the job out here rather than leave the page
    // polling a job no vendor will ever finish.
    if (traceableRecords.length === 0) {
      await adminClient
        .from('trace_jobs')
        .update({
          status: 'completed',
          records_matched: 0,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      return NextResponse.json({
        success: true,
        job_id: job.id,
        total_records: records.length,
        dedupe_removed: totalDeduped,
        records_submitted: 0,
        records_skipped: skippedRecords.length,
        skipped_reason: BLANK_OWNER_SKIP_REASON,
        cached_count: dedupeResult.cachedResults.length,
        estimated_cost: 0,
        message: `${skippedRecords.length} records arrived with no owner name and were skipped. ${BLANK_OWNER_SKIP_REASON}`,
      });
    }

    // Build Tracerfy CSV from the traceable records only.
    const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;

    const csvLines = [
      'address,city,state,first_name,last_name,mail_address,mail_city,mail_state',
    ];

    for (const record of traceableRecords) {
      // Split owner_name into first/last.
      const parts = (record.owner_name || '').trim().split(' ');
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';

      // Use property address as mail fallback
      const mailAddress = record.mailing_address || record.address;
      const mailCity = record.city;
      const mailState = record.state;

      csvLines.push(
        `${esc(record.address)},${esc(record.city)},${esc(record.state)},${esc(firstName)},${esc(lastName)},${esc(mailAddress)},${esc(mailCity)},${esc(mailState)}`
      );
    }

    const csvContent = csvLines.join('\n');

    // Submit to Tracerfy
    const submitResult = await submitBulkTrace(csvContent);

    if (!submitResult.success || !submitResult.jobId) {
      // Update job as failed
      await adminClient
        .from('trace_jobs')
        .update({ status: 'failed', error_message: submitResult.error || 'Submit failed' })
        .eq('id', job.id);

      return NextResponse.json(
        { success: false, error: submitResult.error || 'Failed to submit bulk trace' },
        { status: 500 }
      );
    }

    // Update job with Tracerfy job ID
    await adminClient
      .from('trace_jobs')
      .update({ tracerfy_job_id: submitResult.jobId })
      .eq('id', job.id);

    // Insert pending trace_history rows for each traceable record
    await insertHistoryRows(
      traceableRecords.map((record) => ({
        ...buildHistoryRow(record),
        tracerfy_job_id: submitResult.jobId,
        status: 'processing' as const,
      }))
    );

    return NextResponse.json({
      success: true,
      job_id: job.id,
      total_records: records.length,
      dedupe_removed: totalDeduped,
      records_submitted: traceableRecords.length,
      records_skipped: skippedRecords.length,
      skipped_reason: skippedRecords.length > 0 ? BLANK_OWNER_SKIP_REASON : undefined,
      cached_count: dedupeResult.cachedResults.length,
      estimated_cost: estimatedCost,
      message:
        skippedRecords.length > 0
          ? `${skippedRecords.length} records arrived with no owner name and were skipped. ${BLANK_OWNER_SKIP_REASON}`
          : undefined,
    });
  } catch (error) {
    console.error('Bulk trace error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Internal server error: ${message}` },
      { status: 500 }
    );
  }
}
