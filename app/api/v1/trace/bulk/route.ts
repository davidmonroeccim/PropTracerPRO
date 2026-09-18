import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { removeBatchDuplicates, checkDuplicates } from '@/lib/utils/deduplication';
import { submitBulkTrace } from '@/lib/tracerfy/client';
import { isLikelyBusiness } from '@/lib/trace/ownerClassification';
import { queuedStatusFor } from '@/lib/trace/propertyTraceAttempts';
import {
  TIER2_CAPACITY_REFUSAL,
  inFlightUnbilledCost,
  tracerfyCanRunTier2,
} from '@/lib/trace/bulkPreflight';
import { rawChargePerRecord } from '@/lib/api/pricing';
import { getChargePerTrace } from '@/lib/constants';
import type { AddressInput } from '@/types';

export const maxDuration = 60;

/**
 * THE CAP IS 500 RECORDS. David, 2026-09-18, measured against all 92 historical
 * jobs: median 20, average 51, p90 100, p95 223, max 654, and exactly one job in
 * the whole history exceeds 500.
 *
 * It is NOT the money guard -- the two pre-flight checks below are. Its job is
 * bounding blast radius and stopping one caller eating the Tracerfy credit pool
 * every other customer's jobs draw from. The same number now holds on all three
 * submit surfaces instead of two different ones.
 */
const MAX_RECORDS = 500;

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
        {
          success: false,
          error: `You can send up to ${MAX_RECORDS} records per request. Split this batch into smaller ones and send them one after another.`,
        },
        { status: 400 }
      );
    }

    // Per-record validation. Without this, a record missing address/city/state/zip
    // throws inside normalizeAddress and the whole batch returns an opaque 500.
    // Surface a structured 400 instead so callers know exactly which records failed.
    const invalidRecords: { index: number; error: string }[] = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const v = validateAddressInput(
        r?.address as string,
        r?.city as string,
        r?.state as string,
        r?.zip as string
      );
      if (!v.valid) {
        invalidRecords.push({ index: i, error: v.error || 'invalid record' });
      }
    }
    if (invalidRecords.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `${invalidRecords.length} of ${records.length} records failed validation`,
          invalidRecords,
        },
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

    // Step 3: Split records into three buckets, and the third one changed
    // meaning on 2026-09-18.
    // - Person rows (owner_name looks like a human) go straight to Tracerfy in
    //   the bulk CSV submit, preserving the existing fast path.
    // - Entity rows (owner_name that looks like an LLC / trust / business) are
    //   queued for the sweep-entity-traces cron, which resolves them through a
    //   FastAppend business trace and then, if it gets a person's name and no
    //   contacts, submits its own single Tracerfy trace for that person.
    // - Blank-owner rows used to have no route at all and were accepted,
    //   skipped and never charged. Phase 5c built the route: a Tracerfy dossier
    //   buys the county property record and names the owner, then one contact
    //   lookup resolves them. David's decision, 2026-09-17: the row now runs
    //   that Full Property Trace AUTOMATICALLY. So it is queued into
    //   `property_trace_status` for sweep-property-traces, and it is BILLED,
    //   per RECORD SUBMITTED rather than per successful trace.
    //
    // THE TWO QUEUES ARE SEPARATE COLUMNS AND A ROW BELONGS TO EXACTLY ONE.
    // `ai_research_status` settles tier 1, where a miss is FREE.
    // `property_trace_status` settles tier 2, where a miss is BILLED. A row on
    // both would be settled twice, by two engines, under two billing models.
    //
    // No fourth bucket for an unusable address: this route validates every
    // record above and rejects the whole batch, so a row with no city never
    // reaches here. The dashboard route, which does not validate, has one.
    const personRecords: AddressInput[] = [];
    const entityRecords: AddressInput[] = [];
    const tier2Records: AddressInput[] = [];

    for (const record of newRecords) {
      const owner = (record.owner_name || '').trim();
      if (!owner) {
        tier2Records.push(record);
      } else if (isLikelyBusiness(owner)) {
        entityRecords.push(record);
      } else {
        personRecords.push(record);
      }
    }

    // The rows a vendor is actually asked about, which as of phase 5c is all of
    // them. Used twice and it has to be the same number both times: it is what
    // the wallet reserve is quoted on and what the job row claims was submitted.
    const traceableCount = personRecords.length + entityRecords.length + tier2Records.length;

    // TRACK B PRICING, AND IT MAY NOT BORROW TRACK A'S HELPERS. This is the
    // /api/v1/* API-key surface: it derives RAW, from the profile's own columns,
    // and deliberately does not consult the Suite Gateway grant snapshot.
    // Reusing chargePerTrace() / chargePerRecord() here would move an existing
    // API caller's tier 2 bill from $0.40 to $0.25, in the direction nobody
    // reports. See lib/api/pricing.ts.
    //
    // Tier 1 is per SUCCESSFUL trace and free on a miss, so one charge per owned
    // record is its worst case. Tier 2 is per RECORD SUBMITTED, so it is owed
    // whether or not the county has a parcel at that address: not a worst case
    // at all, just the price. Owner type selects the VENDOR, never the rate
    // (L-005), so there is no entity term in either.
    const tier1Rate = getChargePerTrace(
      profile.subscription_tier,
      profile.is_acquisition_pro_member
    );
    const tier2Rate = rawChargePerRecord(profile);
    const estimatedCost =
      (personRecords.length + entityRecords.length) * tier1Rate +
      tier2Records.length * tier2Rate;

    const adminClient = createAdminClient();

    // CAN PTP EXECUTE? Asked BEFORE the wallet question, so that a caller is
    // never told to add funds for a job PTP could not have run. The Tracerfy
    // credit pool is shared across every customer's jobs, so this is sized
    // against what is already queued as well as what is being asked for. Silent
    // by David's decision, 2026-09-18: no string here claims anyone was told,
    // because PTP has no alerting channel and he chose no alert over a fake one.
    if (!(await tracerfyCanRunTier2(adminClient, tier2Records.length))) {
      return NextResponse.json(
        { success: false, error: TIER2_CAPACITY_REFUSAL },
        { status: 503 }
      );
    }

    // CAN THE CALLER PAY? This used to be a bare comparison that reserved
    // nothing: the route never writes `wallet_balance` and the real debit lands
    // per record at settle time, so two jobs submitted back to back both passed
    // against the same dollars. Settlement fails closed, so no customer was
    // harmed and no balance went negative; PTP ate the vendor spend instead.
    const inFlight = await inFlightUnbilledCost(adminClient, profile.id, {
      tier1: tier1Rate,
      tier2: tier2Rate,
    });
    if (profile.wallet_balance < estimatedCost + inFlight) {
      return NextResponse.json(
        {
          success: false,
          // This one names their funds, because this one IS their balance.
          error:
            inFlight > 0
              ? `This batch could cost up to $${estimatedCost.toFixed(2)}, and you have another $${inFlight.toFixed(2)} of traces already running that have not been billed yet. Your wallet holds $${profile.wallet_balance.toFixed(2)}. Add funds and send it again.`
              : `This batch could cost up to $${estimatedCost.toFixed(2)} but your wallet holds $${profile.wallet_balance.toFixed(2)}. Add funds and send it again.`,
        },
        { status: 402 }
      );
    }

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
        // Only the rows a vendor is actually asked about, which is the same
        // meaning app/api/trace/bulk/route.ts writes here. This column is the
        // DENOMINATOR of the match rate: the v1 status route reports it, the
        // bulk_job.completed webhook carries it, and the history page divides
        // records_matched by it.
        //
        // As of phase 5c that INCLUDES the queued tier 2 rows. It used to
        // exclude blank-owner rows because nobody was ever asked about them and
        // counting them overstated the work. They are asked about now, and
        // billed per record submitted, so the opposite is true: leaving them out
        // would understate the work the customer paid for and overstate the
        // match rate by exactly that many rows.
        records_submitted: traceableCount,
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
    // the sweep-entity-traces cron can aggregate per-record state.
    const buildHistoryRow = (
      record: AddressInput,
      opts: {
        aiResearchStatus: string | null;
        status?: 'processing' | 'no_match';
        /**
         * The TIER 2 queue, and it is a different column from
         * `aiResearchStatus` on purpose. Omitted on every tier 1 row: a row
         * carrying both is claimed by two crons and settled under two billing
         * models, one of which bills a miss and one of which does not.
         */
        propertyTraceStatus?: string;
      }
    ) => {
      const normalizedAddress = normalizeAddress(record.address, record.city, record.state);
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
        status: opts.status ?? ('processing' as const),
        // WRITTEN ON EVERY ROW, NULL INCLUDED, and it used to be omitted on a
        // tier 1 row. The upsert only touches the keys in this payload and the
        // row is REUSED rather than re-inserted (UNIQUE(user_id, address_hash)),
        // so an omitted key leaves whatever the row already carried. A row that
        // was tier 2 before -- reachable on this surface today, because
        // checkDuplicates is inert without a session cookie -- then keeps its
        // tier 2 terminal value while settling as tier 1, and rowSkipReason()
        // asks tier 2 FIRST, so the customer is served a sentence about the
        // other billing model's money. Same reasoning as ai_research_status
        // above, in the opposite direction.
        property_trace_status: opts.propertyTraceStatus ?? null,
      };
    };

    const BATCH_SIZE = 500;

    // TIER 2 ROWS, ONTO THEIR OWN QUEUE. Attempt 1 of the ladder, which is the
    // bare 'queued' that sweep-property-traces claims on. `ai_research_status`
    // stays null: that is the ENTITY queue and it settles a different billing
    // model, so a row on both is billed twice by two engines.
    //
    // Written first, before any vendor is asked anything, so the cron can start
    // on them the moment this handler returns and a failed person submit below
    // cannot strand them. No tracerfy_job_id, which is what keeps every tier 1
    // settle path away from them.
    if (tier2Records.length > 0) {
      const tier2HistoryRows = tier2Records.map((r) =>
        buildHistoryRow(r, {
          aiResearchStatus: null,
          propertyTraceStatus: queuedStatusFor(1),
        })
      );
      for (let i = 0; i < tier2HistoryRows.length; i += BATCH_SIZE) {
        const batch = tier2HistoryRows.slice(i, i + BATCH_SIZE);
        const { error: insertError } = await adminClient
          .from('trace_history')
          .upsert(batch, { onConflict: 'user_id,address_hash' });
        if (insertError) {
          console.error('API v1 bulk trace - failed to insert tier 2 history batch:', insertError.message);
        }
      }
    }

    // Insert entity rows next with ai_research_status='queued' so the cron
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
    // Set when the person CSV submit fails but other work survives. NOT
    // derivable from `tracerfyBulkJobId` being null, which is also true when the
    // batch simply had no person records in it.
    let personSubmitFailed = false;
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

        // THE TIER 2 TERM IS NEW AND IT IS THE POINT. This guard was written
        // when the third bucket did not exist, so it asked only whether the
        // ENTITY queue still had work. The tier 2 rows were written above and
        // sweep-property-traces claims on `property_trace_status` alone, never
        // reading the parent job, so failing the job here stops nothing: it
        // works them and bills every one. The caller would be told the submit
        // failed and charged for it, and a resubmit inside the 90-day window
        // comes back as duplicates, so they could not re-run what they paid for.
        if (entityRecords.length === 0 && tier2Records.length === 0) {
          await adminClient
            .from('trace_jobs')
            .update({ status: 'failed', error_message: submitResult.error || 'Submit failed' })
            .eq('id', job.id);
          return NextResponse.json(
            { success: false, error: submitResult.error || 'Failed to submit bulk trace' },
            { status: 500 }
          );
        }

        // SURVIVORS ONLY FROM HERE. The person rows are terminal errors: no
        // vendor was ever asked about them, so they are not running and they
        // cannot be billed. Every count and every price below has to be computed
        // from what is left, or the caller gets a 200 quoting work that will
        // never happen and reconciles it against a bill that does not match.
        personSubmitFailed = true;

        // records_submitted is the DENOMINATOR of the match rate, read back by
        // the status route and carried in the bulk_job.completed webhook. It was
        // written before this failure and counts the person rows, so leaving it
        // would understate the match rate by exactly the rows nobody was asked
        // about -- the same reasoning the column's own comment gives, applied to
        // the case that removes rows after the fact.
        await adminClient
          .from('trace_jobs')
          .update({ records_submitted: entityRecords.length + tier2Records.length })
          .eq('id', job.id);
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

    // WHAT IS ACTUALLY RUNNING, WHICH IS NOT THE SAME AS WHAT WAS ACCEPTED.
    //
    // When the person CSV submit fails, those rows are written terminal as
    // errors above and no vendor is ever asked about them. Reporting them here
    // as in-progress, and pricing them, tells the caller a 200 about work that
    // will never happen: they reconcile that quote against a bill short by
    // exactly the person half, and the only way they notice is by doing the
    // arithmetic themselves. Same vocabulary as the dashboard route's partial
    // response, deliberately -- three surfaces describing one partial failure in
    // three different sets of words is how the next reader decides they are
    // three different situations.
    const personsRunning = personSubmitFailed ? 0 : personRecords.length;
    const personsFailed = personSubmitFailed ? personRecords.length : 0;

    return NextResponse.json({
      success: true,
      jobId: job.id,
      totalRecords: records.length,
      duplicatesRemoved: totalDeduped,
      recordsToProcess: personsRunning + entityRecords.length + tier2Records.length,
      recordsDirectTrace: personsRunning,
      recordsPendingResearch: entityRecords.length,
      // Rows with no owner of record, now queued for a Full Property Trace
      // rather than skipped. `recordsSkipped` is gone rather than zeroed out:
      // this route no longer skips anything, and reporting a skip count of 0
      // alongside a reason of undefined invited a caller to keep reading a key
      // that had stopped meaning what it used to.
      recordsQueued: tier2Records.length,
      // Records accepted and then dropped because the vendor could not be
      // reached. Always present, 0 on the happy path: a key that appears only
      // when something went wrong is one nobody writes a branch for.
      recordsFailed: personsFailed,
      // REQUOTED FOR THE SURVIVORS. Charging shape is unchanged: tier 1 per
      // successful trace, tier 2 per record submitted.
      estimatedCost:
        (personsRunning + entityRecords.length) * tier1Rate + tier2Records.length * tier2Rate,
      status: 'processing',
      message: [
        personsFailed > 0
          ? `We could not send the ${personsFailed} records that came with an owner name, so those were not traced and you were not charged for them.`
          : null,
        `Poll /api/v1/trace/bulk/status?job_id=${job.id} for results.`,
        entityRecords.length > 0
          ? `${entityRecords.length} entity-owned records are queued for a business trace.`
          : null,
        // The one survivor bucket that is billed whatever it finds, so it is the
        // one that can carry a charge statement without a condition on it.
        tier2Records.length > 0
          ? `${tier2Records.length} records arrived with no owner name and are running a full property trace, which you will be charged for.`
          : null,
      ]
        .filter(Boolean)
        .join(' '),
    });
  } catch (error) {
    console.error('API v1 bulk trace error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Bulk trace failed: ${message}` },
      { status: 500 }
    );
  }
}
