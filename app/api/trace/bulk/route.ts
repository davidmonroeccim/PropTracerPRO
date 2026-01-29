import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeAddress, createAddressHash } from '@/lib/utils/address-normalizer';
import { removeBatchDuplicates, checkDuplicates } from '@/lib/utils/deduplication';
import { submitBulkTrace } from '@/lib/tracerfy/client';
import { PRICING } from '@/lib/constants';
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

    // Check wallet balance for pay-as-you-go users
    const estimatedCost = newRecords.length * PRICING.CHARGE_PER_SUCCESS_WALLET;
    if (profile.subscription_tier === 'wallet') {
      if (profile.wallet_balance < estimatedCost) {
        return NextResponse.json(
          {
            success: false,
            error: `Insufficient wallet balance. Need $${estimatedCost.toFixed(2)} but have $${profile.wallet_balance.toFixed(2)}. Please add funds.`,
          },
          { status: 402 }
        );
      }
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
        records_submitted: newRecords.length,
        records_matched: 0,
        status: 'processing',
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

    // Build Tracerfy CSV from new records
    const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;

    const csvLines = [
      'address,city,state,first_name,last_name,mail_address,mail_city,mail_state',
    ];

    for (const record of newRecords) {
      // Split owner_name into first/last if needed
      let firstName = '';
      let lastName = '';
      if (record.owner_name) {
        const parts = record.owner_name.trim().split(' ');
        firstName = parts[0] || '';
        lastName = parts.slice(1).join(' ') || '';
      }

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

    // Insert pending trace_history rows for each new record
    const historyRows = newRecords.map((record) => {
      const normalizedAddress = normalizeAddress(record.address, record.city, record.state, record.zip);
      const addressHash = createAddressHash(normalizedAddress);
      return {
        user_id: user.id,
        address_hash: addressHash,
        normalized_address: normalizedAddress,
        city: record.city.toUpperCase(),
        state: record.state.toUpperCase(),
        zip: (record.zip || '').substring(0, 5),
        input_owner_name: record.owner_name || null,
        tracerfy_job_id: submitResult.jobId,
        status: 'processing' as const,
      };
    });

    // Insert in batches to avoid payload limits
    const BATCH_SIZE = 500;
    for (let i = 0; i < historyRows.length; i += BATCH_SIZE) {
      const batch = historyRows.slice(i, i + BATCH_SIZE);
      const { error: insertError } = await adminClient
        .from('trace_history')
        .upsert(batch, { onConflict: 'user_id,address_hash' });

      if (insertError) {
        console.error('Failed to insert trace history batch:', insertError.message);
      }
    }

    return NextResponse.json({
      success: true,
      job_id: job.id,
      total_records: records.length,
      dedupe_removed: totalDeduped,
      records_submitted: newRecords.length,
      cached_count: dedupeResult.cachedResults.length,
      estimated_cost: estimatedCost,
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
