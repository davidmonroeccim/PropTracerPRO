import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { normalizeAddress, createAddressHash } from '@/lib/utils/address-normalizer';
import { removeBatchDuplicates, checkDuplicates } from '@/lib/utils/deduplication';
import { submitBulkTrace } from '@/lib/tracerfy/client';
import { isLikelyBusiness } from '@/lib/ai-research/client';
import { AI_RESEARCH, getChargePerTrace } from '@/lib/constants';
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

    // Step 3: Split records into person vs. entity buckets.
    // - Person rows (owner_name looks like a human) go straight to Tracerfy in
    //   the bulk CSV submit, preserving the existing fast path.
    // - Entity rows (empty owner_name, or owner_name that looks like an LLC /
    //   trust / business) are queued for AI research via the sweep-bulk-research
    //   cron. Each resolved entity row then gets its own single-trace Tracerfy
    //   submission with the discovered decision-maker's name.
    const personRecords: AddressInput[] = [];
    const entityRecords: AddressInput[] = [];

    for (const record of newRecords) {
      const owner = (record.owner_name || '').trim();
      if (owner && !isLikelyBusiness(owner)) {
        personRecords.push(record);
      } else {
        entityRecords.push(record);
      }
    }

    // Wallet balance covers worst case: trace cost for every record + research
    // fee for every entity record that resolves to an owner.
    const perTrace = getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member);
    const estimatedTraceCost = newRecords.length * perTrace;
    const estimatedResearchCost = entityRecords.length * AI_RESEARCH.CHARGE_PER_RECORD;
    const estimatedCost = estimatedTraceCost + estimatedResearchCost;

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

    // Insert pending trace_history rows for ALL records up front, linked to
    // the bulk job via the new trace_job_id column so the status endpoint and
    // the sweep-bulk-research cron can aggregate per-record state.
    const buildHistoryRow = (
      record: AddressInput,
      opts: { aiResearchStatus: string | null }
    ) => {
      const normalizedAddress = normalizeAddress(record.address, record.city, record.state, record.zip);
      const addressHash = createAddressHash(normalizedAddress);
      return {
        user_id: profile.id,
        trace_job_id: job.id,
        address_hash: addressHash,
        normalized_address: normalizedAddress,
        city: record.city.toUpperCase(),
        state: record.state.toUpperCase(),
        zip: (record.zip || '').substring(0, 5),
        input_owner_name: record.owner_name || null,
        ai_research_status: opts.aiResearchStatus,
        status: 'processing' as const,
      };
    };

    const BATCH_SIZE = 500;

    // Insert entity rows first with ai_research_status='queued' so the cron
    // can start picking them up as soon as this handler returns.
    if (entityRecords.length > 0) {
      const entityHistoryRows = entityRecords.map((r) =>
        buildHistoryRow(r, { aiResearchStatus: 'queued' })
      );
      for (let i = 0; i < entityHistoryRows.length; i += BATCH_SIZE) {
        const batch = entityHistoryRows.slice(i, i + BATCH_SIZE);
        const { error: insertError } = await adminClient
          .from('trace_history')
          .upsert(batch, { onConflict: 'user_id,address_hash' });
        if (insertError) {
          console.error('API v1 bulk trace - failed to insert entity history batch:', insertError.message);
        }
      }
    }

    // Submit person records to Tracerfy as a single bulk CSV (fast path).
    let tracerfyBulkJobId: string | null = null;
    if (personRecords.length > 0) {
      const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;
      const csvLines = [
        'address,city,state,first_name,last_name,mail_address,mail_city,mail_state',
      ];
      for (const record of personRecords) {
        const parts = (record.owner_name || '').trim().split(' ');
        const firstName = parts[0] || '';
        const lastName = parts.slice(1).join(' ') || '';
        const mailAddress = record.mailing_address || record.address;
        csvLines.push(
          `${esc(record.address)},${esc(record.city)},${esc(record.state)},${esc(firstName)},${esc(lastName)},${esc(mailAddress)},${esc(record.city)},${esc(record.state)}`
        );
      }
      const csvContent = csvLines.join('\n');

      const submitResult = await submitBulkTrace(csvContent);
      if (!submitResult.success || !submitResult.jobId) {
        // Bulk CSV submission failed — mark just the person rows as error and
        // report back. Entity rows remain queued; cron will still process them.
        const personHistoryRows = personRecords.map((r) =>
          buildHistoryRow(r, { aiResearchStatus: null })
        );
        for (let i = 0; i < personHistoryRows.length; i += BATCH_SIZE) {
          const batch = personHistoryRows
            .slice(i, i + BATCH_SIZE)
            .map((r) => ({ ...r, status: 'error' as const }));
          await adminClient
            .from('trace_history')
            .upsert(batch, { onConflict: 'user_id,address_hash' });
        }

        if (entityRecords.length === 0) {
          await adminClient
            .from('trace_jobs')
            .update({ status: 'failed', error_message: submitResult.error || 'Submit failed' })
            .eq('id', job.id);
          return NextResponse.json(
            { success: false, error: submitResult.error || 'Failed to submit bulk trace' },
            { status: 500 }
          );
        }
      } else {
        tracerfyBulkJobId = submitResult.jobId;
        await adminClient
          .from('trace_jobs')
          .update({ tracerfy_job_id: tracerfyBulkJobId })
          .eq('id', job.id);

        const personHistoryRows = personRecords.map((r) => ({
          ...buildHistoryRow(r, { aiResearchStatus: null }),
          tracerfy_job_id: tracerfyBulkJobId,
        }));
        for (let i = 0; i < personHistoryRows.length; i += BATCH_SIZE) {
          const batch = personHistoryRows.slice(i, i + BATCH_SIZE);
          const { error: insertError } = await adminClient
            .from('trace_history')
            .upsert(batch, { onConflict: 'user_id,address_hash' });
          if (insertError) {
            console.error('API v1 bulk trace - failed to insert person history batch:', insertError.message);
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      jobId: job.id,
      totalRecords: records.length,
      duplicatesRemoved: totalDeduped,
      recordsToProcess: newRecords.length,
      recordsDirectTrace: personRecords.length,
      recordsPendingResearch: entityRecords.length,
      estimatedCost,
      status: 'processing',
      message:
        entityRecords.length > 0
          ? `Poll /api/v1/trace/bulk/status?job_id=${job.id} for results. ${entityRecords.length} entity-owned records queued for AI research.`
          : `Poll /api/v1/trace/bulk/status?job_id=${job.id} for results.`,
    });
  } catch (error) {
    console.error('API v1 bulk trace error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
