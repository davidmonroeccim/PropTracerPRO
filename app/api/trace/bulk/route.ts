import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  normalizeAddress,
  createAddressHash,
  validateAddressInput,
} from '@/lib/utils/address-normalizer';
import { removeBatchDuplicates, checkDuplicates } from '@/lib/utils/deduplication';
import { submitBulkTrace } from '@/lib/tracerfy/client';
import {
  PROPERTY_TRACE_NO_KEY_REASON,
  PROPERTY_TRACE_NO_KEY_STATUS,
  queuedStatusFor,
} from '@/lib/trace/propertyTraceAttempts';
import {
  TIER2_CAPACITY_REFUSAL,
  inFlightUnbilledCost,
  tracerfyCanRunTier2,
} from '@/lib/trace/bulkPreflight';
import { chargePerRecord, chargePerTrace, TRACE_SOURCE } from '@/lib/suite/pricing';
import type { AddressInput } from '@/types';

/**
 * THE CAP IS 500 RECORDS. David, 2026-09-18, measured against all 92 historical
 * jobs rather than guessed: median 20, average 51, p90 100, p95 223, max 654,
 * and exactly ONE job in the whole history exceeds 500.
 *
 * Recorded honestly because it is the uncomfortable half: the one job it blocks
 * is the only large job that ever worked (552 of 654 matched), and the other
 * five over 200 records returned 2, 1, 1, 5 and 0. That was accepted knowingly.
 *
 * THE CAP IS NOT THE MONEY GUARD. The two pre-flight checks below are. Its job
 * is bounding blast radius when a run goes wrong, and stopping one user eating
 * the Tracerfy credit pool that every other customer's jobs draw from. The same
 * number now holds on all three submit surfaces (lib/suite/mcp-tools.ts and the
 * v1 route), instead of two different ones.
 */
const MAX_RECORDS = 500;

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
        {
          success: false,
          error: `You can send up to ${MAX_RECORDS} records at a time. Split this file into smaller batches and send them one after another.`,
        },
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

    // SPLIT THE BATCH IN THREE, AND THE MIDDLE BUCKET IS WHAT PHASE 5c EXISTS
    // FOR.
    //
    // Until 2026-09-17 a row with no owner of record had no route at all: the AI
    // Search engine that used to find an owner from an address alone was
    // removed, so the row was accepted, skipped with a reason, and charged
    // nothing. Phase 5c built the engine that CAN do it. David's decision,
    // 2026-09-17: a blank-owner bulk row now runs a Full Property Trace
    // AUTOMATICALLY, the same as a single trace. A Tracerfy dossier buys the
    // county property record and names the owner, then one contact lookup
    // resolves them.
    //
    // So the row is ENQUEUED into `property_trace_status` for
    // app/api/cron/sweep-property-traces, and it is BILLED, per record
    // submitted. 273 of 1,270 historical bulk rows arrived this way, so this is
    // a real change to what existing bulk users pay.
    //
    //   tier 1      owner of record present. Tracerfy person CSV, billed per
    //               SUCCESSFUL trace, free on a miss.
    //   tier 2      no owner of record, but an address a vendor can be asked
    //               about. Queued for the cron, billed per RECORD SUBMITTED.
    //   no key      no owner of record AND no usable address. Nobody can be
    //               asked, so it is terminal and free.
    //
    // THE THIRD BUCKET EXISTS BECAUSE THIS ROUTE DOES NOT VALIDATE PER RECORD,
    // and it is the only submit surface that does not: the v1 route and the MCP
    // tool both reject the whole batch up front, so a row with no city cannot
    // reach their queues. It can reach this one. planRoute() emits no step at
    // all for such a parcel, so queueing it would spend five claim slots asking
    // an unanswerable question; the cron already writes exactly this status for
    // the same row shape when it meets one.
    //
    // NOTE ON THE SENTENCE IT GETS. It is NOT lib/trace/blankOwnerSkip.ts's.
    // That one ends "send it again with the owner of record and we will run
    // it", which for a row missing its city is advice that fails when followed.
    // PROPERTY_TRACE_NO_KEY_REASON names the actual fix. BLANK_OWNER_SKIP_* is
    // now HISTORICAL: still readable for the rows already carrying it, never
    // written again for a merely missing owner.
    const tier1Records: AddressInput[] = [];
    const tier2Records: AddressInput[] = [];
    const noKeyRecords: AddressInput[] = [];
    for (const record of newRecords) {
      if ((record.owner_name || '').trim()) {
        tier1Records.push(record);
        continue;
      }
      const usable = validateAddressInput(
        record.address,
        record.city,
        record.state,
        record.zip
      );
      if (usable.valid) tier2Records.push(record);
      else noKeyRecords.push(record);
    }

    // The rows a vendor is actually asked about, and therefore the rows that can
    // be billed. Used three times and it has to be the same number every time:
    // it is what the reserve is quoted on, what the job row claims was
    // submitted, and the denominator of the match rate.
    const tier1Rate = chargePerTrace(profile);
    const tier2Rate = chargePerRecord(profile);
    const estimatedCost = tier1Records.length * tier1Rate + tier2Records.length * tier2Rate;

    const adminClient = createAdminClient();

    /* ---------------------------------------------------------------- *
     * THE TWO PRE-FLIGHT CHECKS. They ask different questions, they fail
     * for opposite reasons, and they must never be merged.
     *
     * OURS FIRST, DELIBERATELY. If PTP cannot run the job, the customer
     * must never be told to add funds for it: their wallet is fine, ours
     * is the problem, and taking payment for a fix that changes nothing
     * is the worse of the two wrong answers. Asking our question first
     * means the 402 below can only ever fire on a job we could have run.
     * ---------------------------------------------------------------- */

    // CAN PTP EXECUTE? The Tracerfy credit pool is SHARED across every
    // customer's jobs, so this is sized against what is already queued as well
    // as what is being asked for. Silent by David's decision, 2026-09-18: PTP
    // has no alerting channel and he chose no alert over a fake one, so nothing
    // here claims anyone was told. lib/trace/bulkPreflight.ts logs for the
    // operator, which is the only surface that exists.
    if (!(await tracerfyCanRunTier2(adminClient, tier2Records.length))) {
      return NextResponse.json(
        { success: false, error: TIER2_CAPACITY_REFUSAL },
        { status: 503 }
      );
    }

    // CAN THE CUSTOMER PAY? This used to be a bare comparison that reserved
    // nothing: this route never writes `wallet_balance`, and the real debit
    // happens per record at settle time, so two jobs submitted back to back both
    // passed against the same dollars. Settlement fails closed, so no customer
    // was ever harmed and no balance went negative -- PTP just ate the vendor
    // spend, which at tier 2 is up to 500 records of it. Sizing against
    // in-flight unbilled work is what makes this a reserve.
    const inFlight = await inFlightUnbilledCost(adminClient, user.id, {
      tier1: tier1Rate,
      tier2: tier2Rate,
    });
    if (profile.wallet_balance < estimatedCost + inFlight) {
      return NextResponse.json(
        {
          success: false,
          // THIS one names their funds, because this one IS their balance. The
          // in-flight half is only mentioned when there is some, or the sentence
          // would read as an unexplained surcharge.
          error:
            inFlight > 0
              ? `This batch could cost up to $${estimatedCost.toFixed(2)}, and you have another $${inFlight.toFixed(2)} of traces already running that have not been billed yet. Your wallet holds $${profile.wallet_balance.toFixed(2)}. Add funds and send it again.`
              : `This batch could cost up to $${estimatedCost.toFixed(2)} but your wallet holds $${profile.wallet_balance.toFixed(2)}. Add funds and send it again.`,
        },
        { status: 402 }
      );
    }

    // Create trace_jobs row
    const { data: job, error: jobError } = await adminClient
      .from('trace_jobs')
      .insert({
        user_id: user.id,
        file_name: fileName || null,
        total_records: records.length,
        dedupe_removed: totalDeduped,
        // Only the rows a vendor is actually asked about, which as of phase 5c
        // INCLUDES the queued tier 2 rows: they are billed per record
        // submitted, so leaving them out would understate the work and
        // overstate the match rate by exactly the number of rows the customer
        // paid for. A no-key row is still excluded, because nobody is ever
        // asked about it.
        records_submitted: tier1Records.length + tier2Records.length,
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
      // The `|| ''` guards are for the no-key bucket, whose whole definition is
      // that one of these three is missing. They are not a substitute for
      // validation: removeBatchDuplicates already normalizes every record ahead
      // of this, so a genuinely absent field throws there first. These keep the
      // row writable for the empty-string case, which is the one that reaches
      // here.
      const normalizedAddress = normalizeAddress(
        record.address || '',
        record.city || '',
        record.state || ''
      );
      return {
        user_id: user.id,
        trace_job_id: job.id,
        address_hash: createAddressHash(normalizedAddress),
        normalized_address: normalizedAddress,
        city: (record.city || '').toUpperCase(),
        state: (record.state || '').toUpperCase(),
        // WRITTEN EXPLICITLY, ON EVERY ROW, BECAUSE THE UPSERT ONLY TOUCHES THE
        // KEYS IN THIS PAYLOAD. This route never uses the entity queue, so null
        // is always the right value -- but a row is REUSED rather than
        // re-inserted (UNIQUE(user_id, address_hash)), and omitting the key
        // leaves whatever the row already carried. A pre-5c blank-owner row
        // carries 'skipped_no_owner', and 273 of them exist: left in place, the
        // row is enqueued and billed while summarizeSkips() reads that stale
        // value through skipReasonFor() and tells the customer "you were not
        // charged" on a row that was. A stale 'queued' is worse still, putting
        // one row on two queues to be settled twice under two billing models.
        // The v1 route and the MCP submit both write this null for the same
        // reason.
        ai_research_status: null,
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

    // Rows nobody can be asked about land already finished. No tracerfy_job_id
    // and no queue rung, so neither the status route nor the cron ever picks
    // them up, and nothing money-shaped is written: no charge, no
    // ai_research_charge, no tier, because nothing was billed and nothing was
    // spent. The reason reaches the user through the response below and the
    // skip_reason column of the results CSV, via propertyTraceSkipReason().
    if (noKeyRecords.length > 0) {
      await insertHistoryRows(
        noKeyRecords.map((r) => ({
          ...buildHistoryRow(r),
          property_trace_status: PROPERTY_TRACE_NO_KEY_STATUS,
          status: 'no_match' as const,
        }))
      );
    }

    // TIER 2 ROWS, ONTO THE QUEUE. Attempt 1 of the ladder, which is the bare
    // 'queued' the cron's claim window looks for. Written BEFORE the Tracerfy
    // submit below so the cron can start on them the moment this handler
    // returns, and so a failed person submit does not strand them.
    //
    // `status: 'processing'` because the row genuinely is in flight. It carries
    // no tracerfy_job_id, which is what keeps every tier 1 settle path away
    // from it: bulk/status finds its billable rows by that column, and a tier 2
    // row settled there would be billed the tier 1 rate by the wrong engine.
    // sweep-stale-traces cannot reach it either, because its single-trace stage
    // filters on `trace_job_id IS NULL`.
    if (tier2Records.length > 0) {
      await insertHistoryRows(
        tier2Records.map((r) => ({
          ...buildHistoryRow(r),
          property_trace_status: queuedStatusFor(1),
          status: 'processing' as const,
        }))
      );
    }

    /** What the customer is told about rows nobody could be asked about. */
    const noKeyFields =
      noKeyRecords.length > 0
        ? {
            records_skipped: noKeyRecords.length,
            skipped_reason: PROPERTY_TRACE_NO_KEY_REASON,
          }
        : { records_skipped: 0, skipped_reason: undefined };

    // NOTHING LEFT TO WAIT FOR. Only true when there is no tier 1 CSV to submit
    // AND nothing on the queue: a no-key row is finished the moment it is
    // written. A QUEUED row is not, so a job holding one must stay open -- the
    // cron has not touched it, and closing here would stop the page polling
    // before results the customer is billed for ever arrive.
    if (tier1Records.length === 0 && tier2Records.length === 0) {
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
        records_queued: 0,
        ...noKeyFields,
        cached_count: dedupeResult.cachedResults.length,
        estimated_cost: 0,
        message: `${noKeyRecords.length} records could not be looked up. ${PROPERTY_TRACE_NO_KEY_REASON}`,
      });
    }

    // NO PERSON CSV TO BUILD. Every remaining row is queued, so there is no
    // Tracerfy bulk submit to make and no tracerfy_job_id for this job. The
    // cron owns the whole of it from here; the status route waits on the queue.
    if (tier1Records.length === 0) {
      return NextResponse.json({
        success: true,
        job_id: job.id,
        total_records: records.length,
        dedupe_removed: totalDeduped,
        records_submitted: tier2Records.length,
        records_queued: tier2Records.length,
        ...noKeyFields,
        cached_count: dedupeResult.cachedResults.length,
        estimated_cost: estimatedCost,
      });
    }

    // Build the Tracerfy person CSV from the TIER 1 records only. A tier 2 row
    // has no owner to put in it: the dossier is what discovers one.
    const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;

    const csvLines = [
      'address,city,state,first_name,last_name,mail_address,mail_city,mail_state',
    ];

    for (const record of tier1Records) {
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
      // THE TIER 2 ROWS ARE ALREADY ON THE QUEUE, AND THIS BRANCH USED TO
      // DECLARE THE WHOLE JOB DEAD OVER THEM.
      //
      // They were written above, before this call, deliberately. The cron claims
      // on `property_trace_status` alone and never reads the parent job, so
      // marking the job failed here stops nothing: it works all of them and
      // bills every one. The customer would get an HTTP 500, a job reading
      // failed, and a charge for work they were told did not happen -- and
      // because the rows now exist, a resubmit inside the 90-day window comes
      // back "all records are duplicates", so they cannot even re-run what they
      // paid for. Charged, told nothing ran, and blocked from retrying.
      //
      // The tier 1 half really did fail, so those rows are written terminal as
      // errors. Every accepted record therefore has a row, which keeps the job's
      // records_submitted honest as the denominator of the match rate.
      await insertHistoryRows(
        tier1Records.map((record) => ({
          ...buildHistoryRow(record),
          status: 'error' as const,
        }))
      );

      if (tier2Records.length === 0) {
        // Nothing survives the failure. The job really is dead, which is what
        // this branch was written for.
        await adminClient
          .from('trace_jobs')
          .update({ status: 'failed', error_message: submitResult.error || 'Submit failed' })
          .eq('id', job.id);

        return NextResponse.json(
          { success: false, error: submitResult.error || 'Failed to submit bulk trace' },
          { status: 500 }
        );
      }

      // PARTIAL. The job stays open because the queue is still working, and the
      // customer is told exactly which half failed rather than being handed a
      // blanket failure for a job that is still running and will still be
      // billed.
      return NextResponse.json({
        success: true,
        job_id: job.id,
        total_records: records.length,
        dedupe_removed: totalDeduped,
        records_submitted: tier2Records.length,
        records_queued: tier2Records.length,
        records_failed: tier1Records.length,
        ...noKeyFields,
        cached_count: dedupeResult.cachedResults.length,
        estimated_cost: tier2Records.length * tier2Rate,
        message: `We could not send the ${tier1Records.length} records that came with an owner name, so those were not traced and you were not charged for them. The other ${tier2Records.length} are running a full property trace and will finish on their own.`,
      });
    }

    // Update job with Tracerfy job ID
    await adminClient
      .from('trace_jobs')
      .update({ tracerfy_job_id: submitResult.jobId })
      .eq('id', job.id);

    // Insert pending trace_history rows for each TIER 1 record. No
    // property_trace_status on any of them: a tier 1 row that landed on the
    // tier 2 queue would be billed per record submitted instead of per
    // successful trace, and by two engines rather than one.
    await insertHistoryRows(
      tier1Records.map((record) => ({
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
      records_submitted: tier1Records.length + tier2Records.length,
      records_queued: tier2Records.length,
      ...noKeyFields,
      cached_count: dedupeResult.cachedResults.length,
      estimated_cost: estimatedCost,
      message:
        noKeyRecords.length > 0
          ? `${noKeyRecords.length} records could not be looked up. ${PROPERTY_TRACE_NO_KEY_REASON}`
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
