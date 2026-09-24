import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  createAddressHash,
  traceKeyFor,
  usableZip,
  validateAddressInput,
} from '@/lib/utils/address-normalizer';
import { removeBatchDuplicates, checkDuplicates } from '@/lib/utils/deduplication';
import { TIER1_OUTCOME } from '@/lib/trace/tier1Outcome';
import { tier1QueuedStatusFor } from '@/lib/trace/tier1Queue';
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
    //   tier 1      owner of record present. ENQUEUED into ai_research_status for
    //               app/api/cron/sweep-entity-traces, which runs planRoute() and
    //               executeRoute() per record. Billed per SUCCESSFUL trace, free on a miss.
    //               The Tracerfy person CSV is gone from this surface (spec D1, 3.3): rows
    //               already in flight there keep settling through settleBulkJob, and nothing
    //               new is sent. A row with no CITY reaches this bucket now, because the page
    //               stopped dropping it: a company traces on name and state alone (D4), and a
    //               person with no city and no parcel id ends no_lookup_key, free, with a
    //               sentence that says so.
    //   tier 2      no owner of record, but an address a vendor can be asked
    //               about. Queued for the cron, billed per RECORD SUBMITTED.
    //   no key      no owner of record AND no usable address. Nobody can be
    //               asked, so it is terminal and free. MISSING A COMPONENT THE
    //               LOOKUP NEEDS, which is street, city or state, and nothing
    //               else.
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
      // NO ZIP ARGUMENT, AND ITS ABSENCE IS THE POINT. This split asks one
      // question: can a vendor be ASKED about this row. validateAddressInput
      // also carries a ZIP rule, and joining that rule to this question filed a
      // row with a perfectly good street, city and state as no-key over a
      // mangled ZIP -- told it was missing a component it had, and locked out of
      // a resend for 90 days, because `address_hash` is
      // normalizeAddress(address, city, state) and excludes the ZIP entirely, so
      // a corrected resend hashes identically and is dropped as a duplicate.
      // Excel strips the leading zero from a ZIP column on export, so that hits
      // every MA, NJ, CT, RI, NH, ME, VT and PR file wholesale.
      //
      // The ZIP is not load-bearing for the lookup either: the dossier accepts
      // address mode with no zip and BACKFILLS the property's own on a hit. So a
      // malformed one is dropped at the row write below rather than allowed to
      // veto the row, and PROPERTY_TRACE_NO_KEY_STATUS is reserved for a row
      // genuinely missing something the lookup needs -- which is also the only
      // population its sentence's resend advice is true for.
      const usable = validateAddressInput(record.address, record.city, record.state);
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
        // THE SOURCE TAG IS A LABEL: it says where a row came from and switches
        // no price. It used to BE a price decision -- the crons chose between two
        // derivations from it and read an UNTAGGED row as the raw, dearer one --
        // and that is gone: every surface and every cron now price through the
        // one grant-aware derivation in lib/suite/pricing.ts, so a row's rate
        // depends on the CALLER's entitlements and never on which door it came
        // in by. Tagged the same way lib/suite/mcp-tools.ts tags its own job and
        // rows.
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

    /**
     * Rows this submit is RESUMING rather than starting: the ones whose stored outcome is
     * busy_try_again (spec 5.2).
     *
     * checkDuplicates lets a busy row through as a new record rather than a duplicate, because
     * its own sentence told the customer to send it again. Its step log is the money: it is what
     * stops executeRoute re-buying the lookups this record already paid for. So the clear below
     * skips these rows, and ONLY these rows.
     *
     * Read off cachedResults, which is every row checkDuplicates found inside the 90-day window
     * for the hashes submitted, not just the ones it treated as duplicates.
     */
    const busyResumeHashes = new Set(
      dedupeResult.cachedResults
        .filter((r) => r.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN)
        .map((r) => r.address_hash)
    );

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
      // ONE KEY DERIVATION (spec 6.3, D36), the same one the single routes and
      // lib/utils/deduplication.ts use, so a record sent through single and bulk lands on ONE row.
      // On this surface it returns exactly what normalizeAddress returned: the page requires a
      // street and a state, and the web app has no parcel id column (D5).
      const normalizedAddress = traceKeyFor({
        address: record.address || '',
        city: record.city || '',
        state: record.state || '',
        apn: record.apn,
        county: record.county,
      });
      const addressHash = createAddressHash(normalizedAddress);
      return {
        user_id: user.id,
        trace_job_id: job.id,
        address_hash: addressHash,
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
        // THE MIRROR IMAGE, AND IT WAS MISSING. Same argument as the line above,
        // for the other queue: this payload is the whole of what the upsert
        // touches, the row is REUSED rather than re-inserted, and a tier 1 row
        // that keeps a previous tier 2 terminal value serves that value's
        // sentence. rowSkipReason() asks tier 2 FIRST, so a successful tier 1
        // trace would tell the customer "you were charged for it, because a full
        // property trace is charged for every record you send" on a row billed
        // per successful trace, or "nothing was traced and you were not charged"
        // on one that was. Two false money claims in opposite directions, out of
        // the accessor built to prevent exactly that. The tier 2 and no-key
        // writes below spread over this with their own value.
        property_trace_status: null,
        // ONLY WHEN IT IS A ZIP. A malformed one is dropped rather than stored:
        // see usableZip(). This route does not validate per record, so the
        // column is the only thing standing between an Excel-mangled '2134' and
        // a dossier call that contradicts its own street, city and state.
        zip: usableZip(record.zip),
        input_owner_name: record.owner_name || null,
        // Same tag as the job above, and on EVERY row including the skipped
        // ones: the crons read the row's tag, not the job's.
        source: TRACE_SOURCE.WEB,
        // THE D33 BULK HALF (carried item 5). A row is REUSED, and a bulk upload never used to
        // clear the Tier 1 answer on it, so a sentence written for an earlier trace could answer
        // for this one: "You were not charged" over a row this job is about to charge. D33 chose
        // to gate the sentence on trace_job_id instead and recorded this half as Phase 2 code.
        // lib/trace/rowSkipReason.ts stops gating a Tier 1 QUEUE row in Task 5, and this is what
        // makes that safe.
        //
        // NOT on a busy resume: that row's step log is what spares the resend from buying its
        // answered lookups again, and the resume is keyed on finding outcome_code busy_try_again.
        //
        // ------------------------------------------------------------------
        // DISCLOSED COST 1 OF 2 IN THIS PHASE, AND THIS IS WHERE IT HAPPENS.
        //
        // This clear runs on EVERY reused row of a web upload, not only the Tier 1 ones. A row that
        // already holds PAID contacts from an earlier single trace loses its `found_by` label here.
        // It keeps the contacts, the charge and the counts (D39 protects those inside the settle),
        // so nothing the customer bought is lost.
        //
        // WHAT THE CUSTOMER SEES, on the results CSV Task 5 adds the two columns to: for such a row
        // the `found_by` cell is EMPTY until this trace writes its own, so between submit and settle
        // a row holding real, paid-for phone numbers reads as though nobody knows which key found
        // them. If this trace then finds nothing on a row D39 preserves, it stays empty (that is
        // disclosed cost 2, in Task 8's own note).
        //
        // ACCEPTED, AND IT IS D33'S OWN TRADE: the alternative is a stale sentence from an earlier
        // trace answering for this one, which is a row saying "You were not charged" over work this
        // job is about to charge for. Blank, never wrong (CLAUDE.md rule 7). If David wants the
        // label preserved it is a per-column clear rather than this spread, and it is his call
        // because it changes stored customer data.
        // ------------------------------------------------------------------
        ...(busyResumeHashes.has(addressHash)
          ? {}
          : { outcome_code: null, found_by: null, trace_steps: null }),
      };
    };

    const insertHistoryRows = async (rows: Record<string, unknown>[]) => {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const { error: insertError } = await adminClient
          .from('trace_history')
          .upsert(rows.slice(i, i + BATCH_SIZE), { onConflict: 'user_id,address_hash' });
        if (insertError) {
          // THROWS, AND IT USED TO console.error AND RETURN. That swallow was harmless while the
          // tier 1 half had a real failure path of its own: the Tracerfy person submit could fail,
          // and this route corrected records_submitted, wrote the accepted rows terminal and told the
          // customer which half failed and that it was free. Phase 2A deletes that submit, so THIS
          // WRITE IS THE SUBMIT, and a swallowed error means: this handler answers success: true
          // with records_submitted counting rows that were never written; app/api/trace/bulk/status
          // finds zero pending rows on its first poll and finalizes the job `completed` with
          // records_matched 0; and its own early return makes that verdict permanent. The customer
          // uploaded 500 rows, was told it worked, and downloads an empty CSV.
          //
          // The message names the batch size rather than the rows, because the rows carry addresses.
          throw new Error(
            `could not write ${rows.length} trace_history row(s): ${insertError.message}`
          );
        }
      }
    };

    try {
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

      // TIER 1 ROWS, ONTO THE TIER 1 QUEUE (spec 3.2, D1). Attempt 1 of the Tier 1 ladder, which is
      // the rung app/api/cron/sweep-entity-traces claims in its Tier 1 lane. `tier1_queued`, never a
      // bare 'queued': that value is the LEGACY entity ladder's attempt 1 on the same column, and a
      // row wearing it is handed to FastAppend on its owner name with no route planned at all.
      //
      // `status: 'processing'` because the row genuinely is in flight, and because that is what the
      // wallet reserve prices (lib/trace/bulkPreflight.ts). `tracerfy_job_id: null`, WRITTEN rather
      // than omitted: the upsert is onConflict: 'user_id,address_hash', so this row is REUSED, and
      // an omitted key leaves whatever the row already carried. A CSV-era row can carry a stale
      // tracerfy_job_id from before this row was moved to the Tier 1 queue, and both CSV settle
      // paths (app/api/trace/bulk/status/route.ts, app/api/cron/sweep-stale-traces/route.ts) find
      // their rows by that column, so a stale value would let the CSV engine settle or fail a row
      // the Tier 1 cron also owns, and it would show up in the OLD job's results CSV. Same
      // reasoning and the same explicit null as lib/trace/singleTier1.ts's internalWrite.
      if (tier1Records.length > 0) {
        await insertHistoryRows(
          tier1Records.map((r) => ({
            ...buildHistoryRow(r),
            ai_research_status: tier1QueuedStatusFor(1),
            status: 'processing' as const,
            tracerfy_job_id: null,
          }))
        );
      }
    } catch (enqueueError) {
      // A 500 ALONE IS NOT ENOUGH, and that is the whole reason this is handled here rather than by
      // the outer catch: `job` is in scope here, and the job ROW has to carry the failure before
      // this handler returns. The page polls app/api/trace/bulk/status, which finalizes a job whose
      // two queues hold nothing as `completed` with records_matched 0, and then answers every later
      // poll from the stored stats. Without this write the customer's only evidence is an empty CSV.
      //
      // THE JOB MUST REACH A TERMINAL STATE, not merely get a response. David's ruling: "You cannot
      // leave the job processing because the Gateway and API will never complete." The Suite
      // Gateway and the v1 API both poll this job for completion, and a job parked at 'processing'
      // never completes for them, so 'failed' is written here even though this handler already
      // answers the browser directly. Rows already enqueued by an EARLIER batch in this same submit
      // (noKeyRecords, tier2Records) keep running and bill as disclosed: tier 2 is charged per
      // record submitted whatever the result, and the customer is told that before they submit, so
      // nothing here needs to say so again.
      //
      // THE CUSTOMER-FACING SENTENCE IS FIXED AND GENERIC, approved by David. The thrown message
      // (`reason` below) names a table and raw Postgres text, so it goes to the server log only,
      // never to `trace_jobs.error_message`, which `bulk/status` returns and the page renders
      // verbatim. It deliberately carries NO "not charged" claim: a part-way failure can leave rows
      // that were already written and will be billed, so that claim would be false, and the global
      // constraints permit "not charged" only where it is true.
      const reason = enqueueError instanceof Error ? enqueueError.message : 'Unknown error';
      console.error('Failed to enqueue bulk trace rows:', reason);
      await adminClient
        .from('trace_jobs')
        .update({
          status: 'failed',
          error_message:
            'We could not finish starting your upload. Some records may already be running, so check your results before uploading those addresses again.',
        })
        .eq('id', job.id);
      return NextResponse.json(
        { success: false, error: 'Failed to submit bulk trace' },
        { status: 500 }
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
        records_failed: 0,
        ...noKeyFields,
        cached_count: dedupeResult.cachedResults.length,
        estimated_cost: 0,
        message: `${noKeyRecords.length} records could not be looked up. ${PROPERTY_TRACE_NO_KEY_REASON}`,
      });
    }

    // EVERY ACCEPTED ROW IS NOW QUEUED, on one of the two columns, so this handler is done the
    // moment the rows are written. The job stays 'processing' and app/api/trace/bulk/status
    // finishes it when both queues have drained; closing it here would stop the page polling
    // before results the customer is billed for ever arrive.
    return NextResponse.json({
      success: true,
      job_id: job.id,
      total_records: records.length,
      dedupe_removed: totalDeduped,
      records_submitted: tier1Records.length + tier2Records.length,
      // BOTH TIERS ARE QUEUED NOW. This field used to mean the tier 2 half alone. Nothing renders
      // it (app/(dashboard)/trace/bulk/page.tsx reads records_submitted, records_skipped and
      // records_failed); it stays because the route tests assert it and it is the honest count of
      // rows a cron still owes work on.
      records_queued: tier1Records.length + tier2Records.length,
      // Always 0 on this surface now. It counted rows accepted and then never sent because the
      // Tracerfy person submit failed, and there is no such submit any more. Kept at 0 rather than
      // removed so the page's "Records We Could Not Send" tile keeps reading a number it
      // understands instead of undefined.
      records_failed: 0,
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
