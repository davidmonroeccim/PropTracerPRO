import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { normalizeAddress, createAddressHash } from '@/lib/utils/address-normalizer';
import { removeBatchDuplicates, checkDuplicates } from '@/lib/utils/deduplication';
import { submitBulkTrace } from '@/lib/tracerfy/client';
import { PRICING, getChargePerTrace } from '@/lib/constants';
import type { AddressInput } from '@/types';

const MAX_RECORDS = 10000;

export async function POST(request: Request) {
  try {
    // Authenticate via API key
    const authResult = await validateApiKey(request);
    if (isAuthError(authResult)) {
      return authResult.response;
    }
    const { profile } = authResult;

    // Parse request body
    const body = await request.json();
    const { records, webhookUrl } = body as { records: AddressInput[]; webhookUrl?: string };

    if (!records || !Array.isArray(records) || records.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No records provided' },
        { status: 400 }
      );
    }

    if (records.length > MAX_RECORDS) {
      return NextResponse.json(
        { success: false, error: `Maximum ${MAX_RECORDS} records per request` },
        { status: 400 }
      );
    }

    // Step 1: Remove internal batch duplicates
    const { unique, internalDuplicates } = removeBatchDuplicates(records);

    // Step 2: Check against 90-day history
    const dedupeResult = await checkDuplicates(profile.id, unique);
    const newRecords = dedupeResult.newRecords;
    const historyDuplicates = dedupeResult.duplicates.length;
    const totalDeduped = internalDuplicates + historyDuplicates;

    if (newRecords.length === 0) {
      return NextResponse.json({
        success: true,
        jobId: null,
        totalRecords: records.length,
        duplicatesRemoved: totalDeduped,
        recordsToProcess: 0,
        estimatedCost: 0,
        status: 'completed',
        message: 'All records are duplicates of previous traces',
      });
    }

    // Check wallet balance for all users
    const perTrace = getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member);
    const estimatedCost = newRecords.length * perTrace;
    if (profile.wallet_balance < estimatedCost) {
      return NextResponse.json(
        {
          success: false,
          error: `Insufficient wallet balance. Need $${estimatedCost.toFixed(2)} but have $${profile.wallet_balance.toFixed(2)}.`,
        },
        { status: 402 }
      );
    }

    const adminClient = createAdminClient();

    // Save webhook URL if provided (overrides profile setting for this job)
    if (webhookUrl) {
      await adminClient
        .from('user_profiles')
        .update({ webhook_url: webhookUrl })
        .eq('id', profile.id);
    }

    // Create trace_jobs row
    const { data: job, error: jobError } = await adminClient
      .from('trace_jobs')
      .insert({
        user_id: profile.id,
        file_name: 'API bulk upload',
        total_records: records.length,
        dedupe_removed: totalDeduped,
        records_submitted: newRecords.length,
        records_matched: 0,
        status: 'processing',
      })
      .select()
      .single();

    if (jobError || !job) {
      console.error('API v1 bulk trace - failed to create job:', jobError?.message);
      return NextResponse.json(
        { success: false, error: 'Failed to create trace job' },
        { status: 500 }
      );
    }

    // Build Tracerfy CSV
    const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;
    const csvLines = [
      'address,city,state,first_name,last_name,mail_address,mail_city,mail_state',
    ];

    for (const record of newRecords) {
      let firstName = '';
      let lastName = '';
      if (record.owner_name) {
        const parts = record.owner_name.trim().split(' ');
        firstName = parts[0] || '';
        lastName = parts.slice(1).join(' ') || '';
      }

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

    // Insert pending trace_history rows
    const historyRows = newRecords.map((record) => {
      const normalizedAddress = normalizeAddress(record.address, record.city, record.state, record.zip);
      const addressHash = createAddressHash(normalizedAddress);
      return {
        user_id: profile.id,
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

    const BATCH_SIZE = 500;
    for (let i = 0; i < historyRows.length; i += BATCH_SIZE) {
      const batch = historyRows.slice(i, i + BATCH_SIZE);
      const { error: insertError } = await adminClient
        .from('trace_history')
        .upsert(batch, { onConflict: 'user_id,address_hash' });

      if (insertError) {
        console.error('API v1 bulk trace - failed to insert history batch:', insertError.message);
      }
    }

    return NextResponse.json({
      success: true,
      jobId: job.id,
      totalRecords: records.length,
      duplicatesRemoved: totalDeduped,
      recordsToProcess: newRecords.length,
      estimatedCost,
      status: 'processing',
      message: 'Poll /api/trace/bulk/status?job_id=' + job.id + ' for results.',
    });
  } catch (error) {
    console.error('API v1 bulk trace error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
