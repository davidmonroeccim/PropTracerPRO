import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import {
  TRACE_HISTORY_WIDTH,
  createAddressHash,
  storableValue,
  traceKeyFor,
  usableZip,
  validateAddressInput,
} from '@/lib/utils/address-normalizer';
import { removeBatchDuplicates, checkDuplicates } from '@/lib/utils/deduplication';
import { TIER1_OUTCOME } from '@/lib/trace/tier1Outcome';
import { tier1QueuedStatusFor } from '@/lib/trace/tier1Queue';
import { insertHistoryRows } from '@/lib/trace/insertHistoryRows';
import {
  PROPERTY_TRACE_NO_KEY_REASON,
  PROPERTY_TRACE_NO_KEY_STATUS,
  queuedStatusFor,
} from '@/lib/trace/propertyTraceAttempts';
import {
  TIER2_CAPACITY_REFUSAL,
  inFlightUnbilledCost,
  tracerfyCanRun,
} from '@/lib/trace/bulkPreflight';
import { chargePerRecord, chargePerTrace, TRACE_SOURCE } from '@/lib/suite/pricing';
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

    // THERE IS NO WHOLE-BATCH VALIDATION HERE ANY MORE, AND ITS REMOVAL IS THE POINT.
    //
    // Until Phase 2B one bad record returned a 400 with an `invalidRecords` list and NOTHING in the
    // batch ran. Two things made that indefensible. It judged the ZIP, and Excel strips the leading
    // zero from a ZIP column on export, so a single '2139' killed a 500-record file: every MA, NJ,
    // CT, RI, NH, ME, VT and PR county file arrives that way, wholesale. And it judged a city-less
    // row as unusable when a company traces on name and state alone (D4) and a person with no
    // lookup key settles no_lookup_key, free, with a sentence, inside the cron.
    //
    // So each record is judged on its own below: an owner name makes it Tier 1, a blank owner with
    // a usable address makes it tier 2, and only a record no vendor can be asked about at all is
    // filed no-key, free, with a reason. A malformed ZIP is dropped at the row write by usableZip
    // rather than allowed to veto its own row.
    //
    // AN ABSENT FIELD IS THE SAME FACT AS AN EMPTY ONE, AND IT IS NORMALISED HERE SO IT IS JUDGED
    // THE SAME WAY.
    //
    // This closes the last door whole-batch rejection had left. An EMPTY street, city or state was
    // already judged per record below, but an ABSENT one -- the key missing from the JSON object
    // rather than blank -- threw inside removeBatchDuplicates on the next line: traceKeyFor guards
    // `address` and `city` with `?? ''` and passes `state` through raw, so one record omitting it
    // returned the outer catch's 500 for all 500 records. That is whole-batch rejection through a
    // different door, in the change whose whole purpose is deleting it, and a 500 tells an
    // integrator WE broke rather than that their record was unusable.
    //
    // THIS IS NOT FABRICATING DATA (CLAUDE.md rule 7). Absent and blank say the identical thing --
    // the caller gave us no state -- and every other line of this route already reads them as one:
    // `record.state || ''` and `(record.state || '').toUpperCase()` in the row builder below, and
    // `!address` inside validateAddressInput. Only the key derivation disagreed. The record is not
    // rescued by this: with no street, city or state it still lands in the no-key bucket, free,
    // with the reason that tells the caller exactly which component to send. What changes is that
    // the OTHER 499 records run.
    //
    // AND A VALUE THE COLUMN CANNOT HOLD IS NORMALISED IN THE SAME BREATH, FOR THE SAME REASON.
    //
    // `trace_history.state` is VARCHAR(2), and a record carrying an owner name is pushed to tier 1
    // below without being validated at all, so "Texas" used to reach the insert as "TEXAS":
    // Postgres raises 22001, the batch write throws, and one routine integrator typo answered 500
    // for all 500 records with the job written failed. Same door, same harm. storableValue() treats
    // an unstorable value as absent rather than truncating it, because "Te" would be a state the
    // caller never sent; see its docblock for the full argument and for why the trim matters.
    //
    // BOTH NORMALISATIONS HAPPEN HERE, BEFORE THE KEY IS DERIVED, AND THAT PLACEMENT IS LOAD-BEARING
    // (spec 6.3, D36). removeBatchDuplicates on the next line, checkDuplicates after it, and
    // buildHistoryRow below must all see ONE value. Clamping at the row write instead would store ''
    // while the dedup hash still said 'TEXAS', which is the divergence this whole task exists to
    // close.
    const submitted: AddressInput[] = records.map((record) => ({
      ...record,
      address: record?.address ?? '',
      city: storableValue(record?.city, TRACE_HISTORY_WIDTH.city),
      state: storableValue(record?.state, TRACE_HISTORY_WIDTH.state),
      // The two parcel-key columns, which this is the only bulk surface that writes. An unstorable
      // one drops the APN branch of traceKeyFor rather than the whole row: the record keys on its
      // address instead, exactly as one that never sent a parcel id does.
      apn: storableValue(record?.apn, TRACE_HISTORY_WIDTH.parcelIdLocal),
      county: storableValue(record?.county, TRACE_HISTORY_WIDTH.county),
    }));

    // Step 1: Remove internal batch duplicates
    const { unique, internalDuplicates } = removeBatchDuplicates(submitted);

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
        // PRESENT HERE TOO, or the claim the main response makes about them is false on exactly one
        // path. A caller branching on recordsSkipped got undefined from the one response that is
        // otherwise the simplest to handle. Nothing was judged on this path, so nothing was skipped.
        //
        // This early return still omits recordsDirectTrace, recordsPendingResearch, recordsQueued
        // and recordsFailed. That is pre-existing and deliberately left alone: re-shaping a response
        // this task did not touch is not this task's to do.
        recordsSkipped: 0,
        skippedReason: undefined,
        estimatedCost: 0,
        status: 'completed',
        message: 'All records are duplicates of previous traces',
      });
    }

    // Step 3: Split records into three buckets. The split is BINARY on the owner name now, and the
    // classifier MOVED (spec 4.1, D1).
    //
    //   tier 1      an owner of record is present. ENQUEUED into `ai_research_status` for
    //               app/api/cron/sweep-entity-traces, which runs planRoute() and executeRoute() per
    //               record. Billed per SUCCESSFUL trace, free on a miss.
    //   tier 2      no owner of record, but an address a vendor can be asked about. Queued into
    //               `property_trace_status` for app/api/cron/sweep-property-traces, billed per
    //               RECORD SUBMITTED, so it is owed whether or not the county has a parcel there.
    //   no key      no owner of record AND no usable address. Nobody can be asked, so it is
    //               terminal and free.
    //
    // THERE IS NO PERSON-VERSUS-ENTITY SPLIT ANY MORE. planRoute() decides inside the cron whether
    // a record is a person, a company or a trust, and it decides from the whole row rather than
    // from the name alone. The isLikelyBusiness call that used to make that decision here is gone:
    // it is a substring test that calls "Vincent Crews", "Ralph Holland" and "Lincoln Garland"
    // businesses. The function itself survives until Phase 4, for the rows already in flight.
    //
    // THE TWO QUEUES ARE SEPARATE COLUMNS AND A ROW BELONGS TO EXACTLY ONE. `ai_research_status`
    // settles tier 1, where a miss is FREE. `property_trace_status` settles tier 2, where a miss is
    // BILLED. A row on both would be settled twice, by two engines, under two billing models.
    //
    // A TIER 1 RECORD IS NEVER NO-KEY AT SUBMIT. A company traces on name and state alone (D4), and
    // a person with no lookup key settles `no_lookup_key` free, with a sentence, inside the cron.
    // The no-key bucket is only ever reachable from a BLANK owner whose address cannot be sent
    // anywhere, which is why the usability question is asked in that branch and nowhere else.
    const tier1Records: AddressInput[] = [];
    const tier2Records: AddressInput[] = [];
    const noKeyRecords: AddressInput[] = [];

    for (const record of newRecords) {
      if ((record.owner_name || '').trim()) {
        tier1Records.push(record);
        continue;
      }
      // NO ZIP ARGUMENT, AND ITS ABSENCE IS THE POINT. This asks one question: can a vendor be asked
      // about this row at all. validateAddressInput also carries a ZIP rule, and joining that rule
      // to this question filed rows with a perfectly good street, city and state as no-key over a
      // ZIP Excel had stripped a leading zero from -- told they were missing a component they had,
      // and locked out of a resend for 90 days, because the dedup key excludes the ZIP entirely so a
      // corrected resend hashes identically. That is every MA, NJ, CT, RI, NH, ME, VT and PR file
      // wholesale. The ZIP is not load-bearing for the lookup either: the tier 2 dossier accepts
      // address mode with no zip and BACKFILLS the property's own on a hit. So a malformed one is
      // dropped at the row write below by usableZip, and PROPERTY_TRACE_NO_KEY_STATUS is reserved
      // for a row genuinely missing something the lookup needs -- which is also the only population
      // its sentence's resend advice is true for.
      const usable = validateAddressInput(record.address, record.city, record.state);
      if (usable.valid) tier2Records.push(record);
      else noKeyRecords.push(record);
    }

    // The rows a vendor is actually asked about, and therefore the rows that can be billed. Used
    // twice and it has to be the same number both times: it is what the wallet reserve is quoted on
    // and what the job row claims was submitted. A no-key row is excluded, because nobody is ever
    // asked about it and nothing is ever charged for it.
    const traceableCount = tier1Records.length + tier2Records.length;

    // THE ONE PRICE DERIVATION (lib/suite/pricing.ts), the same one the dashboard
    // and the Suite MCP quote from. It is grant-aware: a Suite Gateway grant is a
    // pro entitlement for price exactly as it is for access (lessons.md L-030), so
    // a wallet-tier caller holding one is quoted the pro rates here, and the cron
    // that settles these rows quotes the same two numbers back.
    //
    // Tier 1 is per SUCCESSFUL trace and free on a miss, so one charge per owned
    // record is its worst case. Tier 2 is per RECORD SUBMITTED, so it is owed
    // whether or not the county has a parcel at that address: not a worst case
    // at all, just the price. Owner type selects the VENDOR, never the rate
    // (L-005), so there is no entity term in either.
    const tier1Rate = chargePerTrace(profile);
    const tier2Rate = chargePerRecord(profile);
    const estimatedCost = tier1Records.length * tier1Rate + tier2Records.length * tier2Rate;

    const adminClient = createAdminClient();

    // CAN PTP EXECUTE? Asked BEFORE the wallet question, so that a caller is
    // never told to add funds for a job PTP could not have run. The Tracerfy
    // credit pool is shared across every customer's jobs, so this is sized
    // against what is already queued as well as what is being asked for. Silent
    // by David's decision, 2026-09-18: no string here claims anyone was told,
    // because PTP has no alerting channel and he chose no alert over a fake one.
    //
    // THE TIER 1 COUNT IS REAL NOW, and it used to be a true 0: this surface posted its tier 1
    // records to the Tracerfy BATCH endpoint, a different credit bucket from the per-record instant
    // lookups this check sizes. They are on the queue as of Phase 2B, so they draw on the same pool
    // as every other per-record lookup and a batch of 500 named records can exhaust it.
    if (
      !(await tracerfyCanRun(adminClient, {
        tier1: tier1Records.length,
        tier2: tier2Records.length,
      }))
    ) {
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

    /**
     * Rows this submit is RESUMING rather than starting: the ones whose stored outcome is
     * busy_try_again (spec 5.2).
     *
     * checkDuplicates lets a busy row through as a new record rather than a duplicate, because its
     * own sentence told the customer to send it again. Its step log is the money: it is what stops
     * executeRoute re-buying the lookups this record already paid for. So the D33 clear below skips
     * these rows, and ONLY these rows.
     *
     * ON THIS SURFACE THE SET IS EMPTY IN PRACTICE TODAY, and it is still written. checkDuplicates
     * opens a COOKIE-SCOPED client and an API-key request carries no cookie, so it sees nothing here
     * and returns no cachedResults -- its own docblock records that as a known defect. Coding the
     * exemption as though that were permanent would make the day someone fixes the client the day a
     * resend silently wipes the paid step log it was told to send again.
     */
    const busyResumeHashes = new Set(
      dedupeResult.cachedResults
        .filter((r) => r.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN)
        .map((r) => r.address_hash)
    );

    // Insert pending trace_history rows for ALL records up front, linked to the bulk job via
    // trace_job_id so the status endpoint and both crons can aggregate per-record state.
    const buildHistoryRow = (record: AddressInput) => {
      // ONE KEY DERIVATION (spec 6.3, D36), the same one the single routes and
      // lib/utils/deduplication.ts use, so a record sent through single and bulk lands on ONE row.
      //
      // IT HAD TO MOVE IN THE SAME CHANGE AS THE VALIDATION ABOVE, and that is why this task is one
      // task. checkDuplicates and removeBatchDuplicates already hash with traceKeyFor while this
      // builder stored plain normalizeAddress. The two agree on every record carrying a street AND a
      // city, which is exactly what the whole-batch 400 used to guarantee. Without that 400 a
      // parcel-keyed record reaches here, and then dedup looks for `APN|R-123|TRAVIS|TX` while the
      // row is stored under `||TX`: the same record sent through single and through bulk lands on
      // two rows, and every street-less parcel in one batch collides on one of them.
      //
      // The `|| ''` guards are for the shapes that reach here now rather than a substitute for
      // validation: a no-key row is missing one of the three by definition, and a parcel-keyed row
      // has neither street nor city.
      const normalizedAddress = traceKeyFor({
        address: record.address || '',
        city: record.city || '',
        state: record.state || '',
        apn: record.apn,
        county: record.county,
      });
      const addressHash = createAddressHash(normalizedAddress);
      return {
        user_id: profile.id,
        trace_job_id: job.id,
        address_hash: addressHash,
        normalized_address: normalizedAddress,
        city: (record.city || '').toUpperCase(),
        state: (record.state || '').toUpperCase(),
        // ONLY WHEN IT IS A ZIP, and this is the other half of dropping the ZIP from the usability
        // question above. The row is allowed through, and the mangled number is NOT carried into a
        // dossier call it would contradict: usableZip() records why sending a wrong zip is worse
        // than sending none, and tier 2 bills per record submitted, so a miss we caused with our own
        // mangled input is a miss the customer pays for.
        zip: usableZip(record.zip),
        input_owner_name: record.owner_name || null,
        // D23: the parcel id and county exactly as the caller sent them, beside the key built from
        // them (spec 6.3). This is the surface that HAS them, and until now it dropped them at
        // submit, so the cron rebuilding the parcel from this row alone could never use the second
        // lookup key the caller had supplied.
        parcel_id_local: record.apn || null,
        county: record.county || null,
        // BOTH QUEUE COLUMNS ARE WRITTEN ON EVERY ROW, NULL INCLUDED, and the three call sites below
        // spread their own value over the one they own. The upsert touches only the keys in this
        // payload and the row is REUSED rather than re-inserted (UNIQUE(user_id, address_hash)), so
        // an omitted key leaves whatever the row already carried. A stale tier 2 terminal value on a
        // tier 1 row is served to the customer by rowSkipReason(), which asks tier 2 FIRST, so a
        // successful tier 1 trace would say "you were charged for it, because a full property trace
        // is charged for every record you send" on a row billed per successful trace. A stale
        // 'queued' in either column is worse: one row on two queues, settled twice by two engines
        // under two billing models.
        ai_research_status: null,
        property_trace_status: null,
        // `status` is NOT defaulted here. All three call sites below state their own, and a default
        // that every one of them overrides is a value no reader can trust: it would read as the
        // answer for a fourth bucket that does not exist.
        //
        // Provenance, not price (L-030). The crons read the ROW's tag rather than the job's, and
        // these rows are otherwise indistinguishable from the dashboard's now that both enqueue.
        source: TRACE_SOURCE.API,
        // THE D33 BULK HALF (carried item 5). A row is REUSED, and a bulk submit never used to clear
        // the Tier 1 answer on it, so a sentence written for an earlier trace could answer for this
        // one: "You were not charged" over a row this job is about to charge. D33 chose to gate the
        // sentence on trace_job_id instead and recorded this half as Phase 2 code.
        //
        // NOT on a busy resume: that row's step log is what spares the resend from buying its
        // answered lookups again, and the resume is keyed on finding outcome_code busy_try_again.
        //
        // ------------------------------------------------------------------
        // DISCLOSED COST. This clear runs on EVERY reused row, not only the Tier 1 ones. A row that
        // already holds PAID contacts from an earlier single trace loses its `found_by` label here.
        // It keeps the contacts, the charge and the counts (D39 protects those inside the settle),
        // so nothing the customer bought is lost -- but between submit and settle the `found_by`
        // cell is EMPTY on a row holding real, paid-for phone numbers, so it reads as though nobody
        // knows which key found them.
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

    try {
      // ROWS NOBODY CAN BE ASKED ABOUT LAND ALREADY FINISHED. No tracerfy_job_id and no queue rung,
      // so neither the status route nor either cron ever picks them up, and nothing money-shaped is
      // written: no charge, no ai_research_charge, no tier, because nothing was billed and nothing
      // was spent. The reason reaches the caller through the response below and, via
      // propertyTraceSkipReason(), the skip_reason column of the results CSV.
      if (noKeyRecords.length > 0) {
        await insertHistoryRows(
          adminClient,
          noKeyRecords.map((r) => ({
            ...buildHistoryRow(r),
            property_trace_status: PROPERTY_TRACE_NO_KEY_STATUS,
            status: 'no_match' as const,
            // Written for the same reason as the two queued writes below: this row is terminal, and
            // a stale job id left on a REUSED row would hand a finished, free row to a CSV settle
            // path that bills.
            tracerfy_job_id: null,
          }))
        );
      }

      // TIER 2 ROWS, ONTO THEIR OWN QUEUE. Attempt 1 of the ladder, which is the bare 'queued' that
      // sweep-property-traces claims on. `status: 'processing'` because the row genuinely is in
      // flight. `tracerfy_job_id: null` is what keeps every tier 1 settle path away from it:
      // bulk/status finds its billable rows by that column, and a tier 2 row settled there would be
      // billed the tier 1 rate by the wrong engine. It is WRITTEN, for the reason the Tier 1 block
      // below sets out in full -- this comment used to claim the row "carries no tracerfy_job_id"
      // while the payload merely OMITTED the key, which on an onConflict upsert leaves whatever the
      // reused row already had. A CSV-era row rewritten as tier 2 kept a live job id.
      if (tier2Records.length > 0) {
        await insertHistoryRows(
          adminClient,
          tier2Records.map((r) => ({
            ...buildHistoryRow(r),
            property_trace_status: queuedStatusFor(1),
            status: 'processing' as const,
            tracerfy_job_id: null,
          }))
        );
      }

      // TIER 1 ROWS, ONTO THE TIER 1 QUEUE (spec 3.2, D1). Attempt 1 of the Tier 1 ladder, which is
      // the rung app/api/cron/sweep-entity-traces claims in its Tier 1 lane. `tier1_queued`, NEVER a
      // bare 'queued': that value is the LEGACY entity ladder's attempt 1 on the same column, and a
      // row wearing it is handed to FastAppend on its owner name with no route planned at all.
      //
      // `tracerfy_job_id: null`, WRITTEN rather than omitted: the upsert is
      // onConflict: 'user_id,address_hash', so this row is REUSED, and an omitted key leaves
      // whatever it already carried. A CSV-era row from this very surface can carry a stale
      // tracerfy_job_id -- every named record here went to the batch endpoint until this change --
      // and both CSV settle paths (app/api/trace/bulk/status, app/api/cron/sweep-stale-traces) find
      // their rows by that column, so a stale value would let the CSV engine settle or fail a row
      // the Tier 1 cron also owns, and it would surface in the OLD job's results.
      if (tier1Records.length > 0) {
        await insertHistoryRows(
          adminClient,
          tier1Records.map((r) => ({
            ...buildHistoryRow(r),
            ai_research_status: tier1QueuedStatusFor(1),
            status: 'processing' as const,
            tracerfy_job_id: null,
          }))
        );
      }
    } catch (enqueueError) {
      // A 500 ALONE IS NOT ENOUGH, and that is why this is caught here rather than by the outer
      // catch: `job` is in scope, and the job ROW has to carry the failure before this handler
      // returns. app/api/v1/trace/bulk/status finalizes a job whose queues hold nothing as
      // `completed` with records_matched 0 and then answers every later poll from the stored stats,
      // so without this write the caller's only evidence is an empty results array.
      //
      // THE JOB MUST REACH A TERMINAL STATE, not merely get a response. The Suite Gateway and this
      // API both poll the job for completion, and a job parked at 'processing' never completes for
      // them. Rows already enqueued by an EARLIER batch in this same submit keep running and bill as
      // disclosed: tier 2 is charged per record submitted whatever the result, and the caller is
      // told that before they submit.
      //
      // THE CALLER-FACING SENTENCE IS THE FIXED GENERIC ONE, and it is the same string
      // app/api/trace/bulk/route.ts writes. The thrown message names a table and raw Postgres text,
      // so it goes to the server log only, never to `trace_jobs.error_message`, which this surface's
      // status route returns verbatim. It deliberately carries NO "not charged" claim: a part-way
      // failure can leave rows that were already written and will be billed.
      const reason = enqueueError instanceof Error ? enqueueError.message : 'Unknown error';
      console.error('API v1 bulk trace - failed to enqueue rows:', reason);
      // THE ERROR IS DESTRUCTURED AND LOGGED, and a log is genuinely the only action left: the
      // caller is already being told this failed, so there is no success to withdraw. What the log
      // buys is the one thing silence would cost -- if this write fails too, the job is stuck at
      // 'processing' and polls forever for the Gateway and this API, and the operator is the only
      // party who can find it. Not logging it is how an orphaned job becomes undiscoverable.
      const { error: failWriteError } = await adminClient
        .from('trace_jobs')
        .update({
          status: 'failed',
          error_message:
            'We could not finish starting your upload. Some records may already be running, so check your results before uploading those addresses again.',
        })
        .eq('id', job.id);
      if (failWriteError) {
        console.error(
          'API v1 bulk trace - job left NOT terminal after a failed enqueue:',
          job.id,
          failWriteError.message
        );
      }
      return NextResponse.json(
        { success: false, error: 'Failed to submit bulk trace' },
        { status: 500 }
      );
    }

    // EVERY ACCEPTED ROW IS NOW QUEUED, on one of the two columns, so this handler is done the
    // moment the rows are written. The job stays 'processing' and app/api/v1/trace/bulk/status
    // finishes it when both queues have drained, including a job whose only rows were no-key: those
    // are terminal at birth, so nothing is still working and the first poll finalizes it.
    //
    // THE RESPONSE KEEPS EVERY KEY IT HAD, AND THE ONLY ADDITIONS ARE ADDITIVE. Integrators read
    // these, so nothing is removed and nothing is re-pointed; what changed is what two of them can
    // honestly say. `recordsDirectTrace` counted the rows sent straight to the Tracerfy person CSV,
    // and there is no such submit on this surface any more, so it is 0 -- kept rather than deleted
    // so a caller's branch keeps reading a number it understands instead of undefined.
    // `recordsPendingResearch` counted the entity half of a split that no longer happens at submit;
    // every Tier 1 record is now queued for the research cron, so it is the Tier 1 count.
    // `recordsQueued` keeps its documented meaning, the tier 2 queue.
    //
    // `recordsSkipped` and `skippedReason` are BACK, by David's decision. They were removed when the
    // whole-batch 400 meant this endpoint could never skip anything. Per-record judging brings the
    // case back for real: a batch can now hold rows nobody can be asked about ALONGSIDE rows that
    // run, and without these two the only way to learn the skipped ones existed was to subtract
    // recordsToProcess from totalRecords. Same meaning and same shape as the dashboard route's
    // records_skipped / skipped_reason, down to leaving the reason undefined when there is nothing
    // to explain, so the two surfaces cannot drift into describing one thing two ways.
    return NextResponse.json({
      success: true,
      jobId: job.id,
      totalRecords: records.length,
      duplicatesRemoved: totalDeduped,
      recordsToProcess: traceableCount,
      // Nothing goes straight to a vendor from here any more: a Tier 1 record is planned and run by
      // the cron (spec 4.1), which is what lets a city-less or parcel-keyed record trace at all.
      recordsDirectTrace: 0,
      recordsPendingResearch: tier1Records.length,
      // Rows with no owner of record, queued for a Full Property Trace rather than skipped.
      recordsQueued: tier2Records.length,
      // Rows nobody can be asked about at all: no owner name AND no street, city or state to look a
      // property up by. Terminal at submit and FREE, which is what separates them from every other
      // count here. Present on BOTH exits this handler can succeed through, 0 when there are none,
      // because a key that appears only when something went wrong is one nobody writes a branch for
      // -- the all-duplicates early return above carries it for that reason. The reason string is
      // the approved constant and is undefined when there is nothing to explain, exactly as the
      // dashboard route does it.
      recordsSkipped: noKeyRecords.length,
      skippedReason: noKeyRecords.length > 0 ? PROPERTY_TRACE_NO_KEY_REASON : undefined,
      // Records accepted and then dropped because the vendor could not be reached. Always 0 now:
      // there is no vendor call at submit to fail. Kept at 0 rather than removed because a key that
      // appears only when something went wrong is one nobody writes a branch for.
      recordsFailed: 0,
      // Charging shape is unchanged: tier 1 per successful trace, tier 2 per record submitted. A
      // no-key row is in neither term, because nobody is ever asked about it.
      estimatedCost,
      status: 'processing',
      message: [
        `Poll /api/v1/trace/bulk/status?job_id=${job.id} for results.`,
        // The one bucket that is billed whatever it finds, so it is the one that can carry a charge
        // statement with no condition on it. The sentence that used to sit beside this one claimed
        // "N entity-owned records are queued for a business trace", and it is GONE rather than
        // repointed at the Tier 1 count: nothing at submit decides any more whether a record is an
        // entity, so the sentence would have been a false statement about every person in the batch.
        tier2Records.length > 0
          ? `${tier2Records.length} records arrived with no owner name and are running a full property trace, which you will be charged for.`
          : null,
        // Rows nobody could be asked about, in the words app/api/trace/bulk/route.ts already uses
        // for them. They are excluded from recordsToProcess and from the quote, so without this the
        // caller would have to subtract to discover they existed.
        noKeyRecords.length > 0
          ? `${noKeyRecords.length} ${noKeyRecords.length === 1 ? 'record' : 'records'} could not be looked up. ${PROPERTY_TRACE_NO_KEY_REASON}`
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
