import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { rawChargePerRecord, rawPricePlanFor } from '@/lib/api/pricing';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { checkSingleDuplicate } from '@/lib/utils/deduplication';
import {
  excludeBilledRows,
  foldBillingWrite,
  hasLedgerReceipt,
  isBilledRow,
  isCacheHitRow,
  TRACE_TIER,
} from '@/lib/trace/billedRows';
import {
  submitSingleTrace,
  lookupBusinessTrace,
  lookupPersonTrace,
} from '@/lib/tracerfy/client';
import { lookupDossier } from '@/lib/tracerfy/dossier';
import { executeRoute } from '@/lib/routing/executeRoute';
import { planRoute } from '@/lib/routing/ownerRoute';
import {
  FULL_PROPERTY_TRACE_DESCRIPTION,
  hasContactData,
  isFullPropertyTrace,
  parcelForFullTrace,
  traceResultFor,
  WALLET_NOT_COLLECTED_WARNING,
  WALLET_SHORT_WARNING,
} from '@/lib/trace/fullPropertyTrace';
import { dispatchTraceCompleted } from '@/lib/trace/traceCompletedWebhook';
import { toPublicPropertyRecord } from '@/lib/trace/publicPropertyRecord';
import { deductWallet } from '@/lib/wallet/deduct';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { getChargePerTrace } from '@/lib/constants';
import type { TraceResult } from '@/types';

/**
 * Tier 2 runs the whole route SYNCHRONOUSLY: a dossier lookup (sometimes two, stopping
 * at the first hit) and then one contact lookup, all JSON POSTs with no queue and no
 * polling. Three vendor round trips do not fit in the default function timeout. Already
 * 60 on this route; kept, and now load-bearing for tier 2 as well.
 */
export const maxDuration = 60;

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
    // `aiResearch` used to be accepted here and would run the AI Search engine when no
    // ownerName was supplied. That engine was removed on 2026-09-17, so the field is no
    // longer read. It is not rejected either: an integration still sending it keeps working
    // and simply gets the plain trace. What now serves a submit with no owner is TIER 2,
    // below.
    const { address, city, state, zip, ownerName } = body;

    // Validate input
    const validation = validateAddressInput(address, city, state, zip);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    /**
     * Tier 2 (Full Property Trace) when the owner of record is missing, or when the
     * caller asked for the property record outright. AUTOMATIC on an absent owner,
     * matching app/api/trace/single -- David's decision, 2026-09-17, so the two surfaces
     * price the same request the same way.
     *
     * isFullPropertyTrace() is the SHARED predicate, deliberately: it is consulted by the
     * balance gate, the cache branch and the execution below, and by both routes, so the
     * two surfaces and the three call sites cannot drift apart.
     *
     * v1's body is camelCase (`ownerName`), so the mapping is explicit. The opt-in flag is
     * `fullPropertyTrace`; `full_property_trace` is honoured too because that is the
     * spelling on the session route, and a caller who sends it has unambiguously asked for
     * a full property trace -- getting a silently cheaper tier 1 instead is not a kindness,
     * it is the wrong answer.
     */
    const fullPropertyTrace = isFullPropertyTrace({
      owner_name: ownerName,
      full_property_trace: body.fullPropertyTrace === true || body.full_property_trace === true,
    });

    /**
     * Check wallet balance for all users, AGAINST THE RATE THIS REQUEST WILL CHARGE.
     * Reserving the tier 1 rate for a tier 2 request under-reserves by $0.10-$0.15 and
     * lets a wallet that cannot pay reach the vendors, where the money is spent on our
     * side whether or not we can collect it.
     *
     * Both rates are RAW (Track B). lib/api/pricing.ts documents why the grant-aware
     * Track A helpers must not be used on this surface.
     */
    const minBalance = fullPropertyTrace
      ? rawChargePerRecord(profile)
      : getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member);
    if (profile.wallet_balance < minBalance) {
      return NextResponse.json(
        { success: false, error: 'Insufficient wallet balance' },
        { status: 402 }
      );
    }

    // Normalize address and create hash
    const normalizedAddress = normalizeAddress(address, city, state);
    const addressHash = createAddressHash(normalizedAddress);

    const adminClient = createAdminClient();

    // A ROW A LEDGER ROW POINTS AT IS NEVER A DELETE CANDIDATE.
    //
    // UNIQUE(user_id, address_hash) means there is at most ONE row here, and
    // every delete below is confined to it, so one probe answers for all of
    // them. excludeBilledRows() derives billed-ness from trace_history's own
    // columns; this asks the LEDGER, which is the only question that stays
    // right for a row whose receipt columns were already zeroed by the settle
    // bug fixed alongside this. Those rows exist and are currently locked out
    // of every retrace with a 500 that names nothing.
    const { data: existingRow, error: existingRowError } = await adminClient
      .from('trace_history')
      .select('id, charge, ai_research_charge, property_record, tier')
      .eq('user_id', profile.id)
      .eq('address_hash', addressHash)
      .maybeSingle();

    // Fails CLOSED. Not knowing whether a row exists is not permission to
    // delete one: a refused delete is a 500 the caller cannot get past, while
    // a skipped delete just reuses the row in place, which is what a billed row
    // does anyway.
    const ledgerProtected = existingRowError
      ? true
      : existingRow
        ? isBilledRow(existingRow) || (await hasLedgerReceipt(adminClient, existingRow.id))
        : false;

    // Every delete below is narrowed by excludeBilledRows() and its error is
    // checked. wallet_transactions.trace_history_id references these rows with
    // no ON DELETE clause, so a delete on a billed row fails with 23503 — and
    // an unchecked failure walks straight into the UNIQUE(user_id, address_hash)
    // violation below. See lib/trace/billedRows.ts.
    const deleteErrors: string[] = [];
    const runDelete = async (
      label: string,
      build: () => PromiseLike<{ error: { message: string } | null }>
    ) => {
      if (ledgerProtected) return;
      const { error } = await build();
      if (error) {
        console.error(`API v1 single trace - ${label} delete failed:`, error.message);
        deleteErrors.push(error.message);
      }
    };

    // Check for cached result (90-day dedup)
    const cachedResult = await checkSingleDuplicate(profile.id, address, city, state);

    if (cachedResult) {
      const cached = cachedResult.trace_result as TraceResult | null;
      const hasData = cached &&
        ((cached.phones?.length || 0) > 0 || (cached.emails?.length || 0) > 0);

      if (hasData) {
        // property_record rides along: on a tier 2 row it is the thing the customer
        // paid for, and dropping it here would serve them a cache hit poorer than
        // the response they originally got.
        //
        // The STORED row is raw (86 keys) and the RESPONSE is filtered (65). A
        // cache hit is an egress like any other, and it is the easiest one to
        // miss: the record comes from our own database rather than from a vendor
        // call, so it does not look like it is leaving.
        return NextResponse.json({
          success: true,
          cached: true,
          charge: 0,
          traceId: cachedResult.id,
          result: cached,
          propertyRecord: toPublicPropertyRecord(cachedResult.property_record),
          tier: cachedResult.tier ?? null,
        });
      }

      // A BILLED TIER 2 ROW IS SERVED FROM THE DATABASE WHATEVER IT CONTAINS.
      // David, 2026-09-17: if serving the request spends money at Tracerfy the user is
      // charged, and if it is served from their own stored record it is free. A tier 2
      // miss holds no contacts and no property record -- it is a paid-for "the county
      // has no parcel at this address" -- and re-running the dossier would bill them a
      // second time for the same absence. Without this branch the row falls through to
      // the submit below and the customer re-buys a record they already own.
      // isCacheHitRow is the JS twin of CACHE_HIT_FILTER, which is what let this row out
      // of the database in checkSingleDuplicate in the first place.
      if (fullPropertyTrace && isCacheHitRow(cachedResult)) {
        return NextResponse.json({
          success: true,
          cached: true,
          charge: 0,
          traceId: cachedResult.id,
          status: cachedResult.status,
          result: cached,
          propertyRecord: toPublicPropertyRecord(cachedResult.property_record),
          tier: cachedResult.tier ?? null,
        });
      }

      // Cached row holds no contacts, so re-trace. Delete it only if the
      // customer has not paid for it — a tier 2 property record is billed
      // whether or not contacts ever followed.
      if (!isBilledRow(cachedResult)) {
        await runDelete('cached-empty', () =>
          adminClient.from('trace_history').delete().eq('id', cachedResult.id)
        );
      }
    }

    // Delete any existing failed traces for this address.
    // is_successful = false is ALSO the tier 2 paid-but-no-contacts shape.
    await runDelete('failed', () =>
      excludeBilledRows(
        adminClient
          .from('trace_history')
          .delete()
          .eq('user_id', profile.id)
          .eq('address_hash', addressHash)
          .eq('is_successful', false)
      )
    );

    // If a different owner name is provided, delete any existing trace for this address.
    // This allows re-tracing once the caller has resolved a person name behind an LLC.
    if (ownerName) {
      await runDelete('owner-changed', () =>
        excludeBilledRows(
          adminClient
            .from('trace_history')
            .delete()
            .eq('user_id', profile.id)
            .eq('address_hash', addressHash)
            .neq('input_owner_name', ownerName)
        )
      );
    }

    if (deleteErrors.length > 0) {
      return NextResponse.json(
        { success: false, error: `Failed to clear previous trace: ${deleteErrors[0]}` },
        { status: 500 }
      );
    }

    // UNIQUE(user_id, address_hash) means ONE row per address per user. A row
    // that survived the guarded deletes is a billed row, so enrich it in place
    // rather than inserting a second one that cannot exist.
    const { data: surviving, error: survivingError } = await adminClient
      .from('trace_history')
      .select('id')
      .eq('user_id', profile.id)
      .eq('address_hash', addressHash)
      .maybeSingle();

    if (survivingError) {
      console.error('API v1 single trace - existing row lookup failed:', survivingError.message);
      return NextResponse.json(
        { success: false, error: 'Failed to process request' },
        { status: 500 }
      );
    }

    const resubmitData = {
      normalized_address: normalizedAddress,
      city: city.toUpperCase(),
      state: state.toUpperCase(),
      // The zip is OPTIONAL at validation (it is not part of address_hash), so it can
      // legitimately be absent. `zip.substring(0, 5)` on an absent one threw a TypeError
      // and surfaced as a bare 500 before any vendor was called -- and an absent zip is
      // precisely the case tier 2 backfills. Same shape as app/api/trace/single:273.
      zip: zip ? zip.substring(0, 5) : null,
      input_owner_name: ownerName || null,
      status: 'processing',
    };

    // Insert pending trace record, or reuse the billed row that survived.
    // charge, ai_research_charge, property_record and tier are never touched
    // here: they are what the customer already paid for.
    const { data: traceRecord, error: insertError } = surviving
      ? await adminClient
          .from('trace_history')
          .update({ ...resubmitData, tracerfy_job_id: null })
          .eq('id', surviving.id)
          .select()
          .single()
      : await adminClient
          .from('trace_history')
          .insert({
            user_id: profile.id,
            address_hash: addressHash,
            ...resubmitData,
          })
          .select()
          .single();

    if (insertError || !traceRecord) {
      console.error('API v1 single trace - failed to create record:', insertError?.message);
      return NextResponse.json(
        { success: false, error: 'Failed to process request' },
        { status: 500 }
      );
    }

    /* ---------------------------------------------------------------- *
     * TIER 2 — FULL PROPERTY TRACE
     *
     * Mirrors app/api/trace/single:339-497 step for step. Synchronous end to
     * end: the dossier and the contact lookup are both plain JSON POSTs, so the
     * spend and the charge happen in this request rather than in a later poll.
     * That is the whole reason billing lives here and nowhere else, and it is
     * also why tier 2 returns the finished record INLINE while tier 1 still
     * returns a traceId to poll.
     *
     * THE CHARGE SEQUENCE, in order, and none of these steps may move:
     *   1. plan the route (pure, no spend) at the CALLER'S OWN rate
     *   2. run it -- dossier, then contacts for whatever owner it found
     *   3. if a vendor FAILED, charge nothing and let them retry for free
     *   4. otherwise deduct, ONCE, and read back what actually moved
     *   5. persist the record, the tier, and the amount that was collected
     *   6. fire trace.completed, because nothing else will
     * ---------------------------------------------------------------- */
    if (fullPropertyTrace) {
      // 1. The caller's REAL plan, derived from their profile exactly as the tier 1
      //    rate above is, and RAW because this is Track B. planRoute takes it as a
      //    required argument so no route can quietly bill the wrong column: a
      //    hardcoded 'pro' once billed pay-as-you-go customers 40% under rate,
      //    silently, because nobody reports being undercharged (FAILSAFE_PRICE_PLAN).
      const plan = planRoute(
        parcelForFullTrace({ address, city, state, zip }),
        rawPricePlanFor(profile)
      );

      // Defence in depth: planRoute emits no step at all when the parcel has no usable
      // key. Address validation makes that unreachable from this route, and it is
      // guarded anyway because the rule is that the charge follows the VENDOR CALL -- a
      // record no vendor was ever asked about must not reach the deduct below.
      if (plan.steps.length === 0) {
        await adminClient
          .from('trace_history')
          .update({ status: 'error', tracerfy_job_id: null })
          .eq('id', traceRecord.id);

        return NextResponse.json(
          {
            success: false,
            status: 'error',
            traceId: traceRecord.id,
            tier: TRACE_TIER.PER_RECORD_SUBMITTED,
            charge: 0,
            error: plan.warnings[0] || 'No usable lookup key for this address.',
          },
          { status: 400 }
        );
      }

      // 2. Spend. executeRoute never throws and reports each step separately.
      const execution = await executeRoute(plan, {
        lookupDossier,
        traceEntity: lookupBusinessTrace,
        tracePerson: lookupPersonTrace,
      });

      // 3. A VENDOR FAILURE IS NEVER BILLED. `success: false` means we could not ask --
      //    an outage, a rate limit, a rejected key. It is NOT the same as
      //    `ownerFound: false`, which is also what a legitimate, billable miss looks
      //    like. Gating on ownerFound would bill customers for our outages; gating on a
      //    hit would give away records we paid for (lessons.md L-007). Nothing is
      //    charged and nothing billable is persisted, so the row stays retryable rather
      //    than becoming a free cache entry that can never acquire its contacts.
      //    No webhook either: there is no completion to report, which matches the poll
      //    route's stall-error branch.
      if (!execution.success) {
        await adminClient
          .from('trace_history')
          .update({ status: 'error', tracerfy_job_id: null })
          .eq('id', traceRecord.id);

        return NextResponse.json(
          {
            success: false,
            status: 'error',
            traceId: traceRecord.id,
            tier: TRACE_TIER.PER_RECORD_SUBMITTED,
            charge: 0,
            error: execution.error || 'Property lookup failed. Please try again.',
          },
          { status: 502 }
        );
      }

      // 4. Billable. A TOTAL MISS IS STILL BILLED: tier 2 is per RECORD SUBMITTED, so
      //    "the county has no parcel at this address" is a real answer the customer pays
      //    for. deductWallet reports what actually moved -- 0 when the wallet came up
      //    short between the gate above and now -- and that is the only number that may
      //    be persisted, returned or sent in a webhook. It also says WHICH of the two
      //    zero outcomes happened, because one of them is the customer's balance and
      //    the other one is ours to own.
      const attemptedCharge = plan.billing.amount;
      const deduction = await deductWallet(adminClient, {
        p_user_id: profile.id,
        p_amount: attemptedCharge,
        p_trace_history_id: traceRecord.id,
        p_description: FULL_PROPERTY_TRACE_DESCRIPTION,
      });
      const charge = deduction.collected;

      if (deduction.outcome === 'error') {
        // WE SPENT AT THE VENDOR AND FAILED TO COLLECT. The customer is not
        // billed and keeps the record, which is the same outcome as before and
        // is the right one: billing them later for a record already delivered
        // is exactly the surprise charge this phase exists to remove. Logged so
        // the shortfall is findable rather than silent; the row that results
        // carries cost > 0 with charge = 0, which is the query for it.
        console.error(
          'API v1 Full Property Trace - wallet deduct failed, record delivered uncharged:',
          traceRecord.id,
          deduction.message
        );
      }

      // 5. Persist. property_record is the vendor's object BY REFERENCE, all 86 keys,
      //    unfiltered and unrenamed: the raw dump is the product, and a key that is
      //    empty in OH, CA and UT may be populated elsewhere.
      const result = traceResultFor(execution);
      const isSuccessful = hasContactData(result);
      const status = isSuccessful ? 'success' : 'no_match';
      const persistedZip = execution.learnedZip ?? resubmitData.zip;

      // RECEIPTS ARE MONOTONIC. `traceRecord` is the row this submit reused or
      // inserted, still carrying whatever it had been charged before, so the
      // amount collected NOW is folded into it rather than replacing it. A row
      // that was billed can never come out of here unbilled, and the dashboard's
      // SUM(charge) stays in agreement with wallet_transactions.
      const billing = foldBillingWrite(traceRecord, {
        charge,
        tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      });

      const { error: persistError } = await adminClient
        .from('trace_history')
        .update({
          status,
          trace_result: result,
          phone_count: result?.phones?.length || 0,
          email_count: result?.emails?.length || 0,
          is_successful: isSuccessful,
          property_record: execution.property,
          tier: billing.tier,
          charge: billing.charge,
          // What the vendors actually took, read from their own credit counters rather
          // than assumed from a price list.
          cost: execution.vendorSpend,
          tracerfy_job_id: null,
          // The situs zip the dossier taught us, and ONLY when the caller had none.
          // address_hash is sha256 of STREET|CITY|STATE and deliberately excludes the
          // zip (migration 20260904), so this column is free to gain a value: the row
          // keeps matching its own cache key. Never recompute the hash here -- a row
          // whose hash moves is a row that re-buys itself forever.
          ...(execution.learnedZip ? { zip: execution.learnedZip } : {}),
        })
        .eq('id', traceRecord.id);

      if (persistError) {
        // The money is gone and the record is bought. Say so loudly rather than
        // returning a clean 500 that hides a paid-for result.
        console.error('API v1 Full Property Trace - failed to persist result:', persistError.message);
      }

      // Fire-and-forget, same rule as the poll route: a charge was attempted, so top the
      // wallet up if it has dropped below the threshold. Still fires when the deduct
      // failed -- that is exactly the wallet that needs it.
      triggerAutoRebillIfNeeded(profile.id).catch(() => {});

      // 6. trace.completed. Tier 2 never reaches the poll route that normally sends it,
      //    so without this a webhook customer silently stops receiving events. Fires for
      //    EVERY completed tier 2 including a billed miss, and never on the vendor
      //    failure above, which returned already. `profile` came from the ADMIN client in
      //    validateApiKey via select('*'), so webhook_url is present on it; no re-read
      //    is needed on this surface.
      dispatchTraceCompleted({
        webhookUrl: profile.webhook_url,
        traceId: traceRecord.id,
        status,
        address: normalizedAddress,
        city: resubmitData.city,
        state: resubmitData.state,
        zip: persistedZip,
        result,
        charge,
        propertyRecord: execution.property,
        ownerType: execution.ownerType,
        tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      });

      // 7. NO CRM PUSH HERE, AND THAT IS THE DESIGN. PTP never calls HighLevel
      //    unless a person asked it to. An API caller gets the result back and
      //    sends it wherever they want it; a push from PTP starts only at the
      //    Push to CRM button, which is app/api/integrations/highlevel/push.

      // Two different zeros, two different sentences. Saying "your wallet did
      // not cover this" to a customer whose wallet is full, because OUR RPC
      // fell over, is a false statement about their money.
      const warnings = [...execution.warnings];
      if (deduction.outcome === 'insufficient_balance') {
        warnings.push(WALLET_SHORT_WARNING);
      } else if (deduction.outcome === 'error') {
        warnings.push(WALLET_NOT_COLLECTED_WARNING);
      }

      return NextResponse.json({
        success: true,
        status,
        traceId: traceRecord.id,
        tier: TRACE_TIER.PER_RECORD_SUBMITTED,
        // What THIS request cost. The row carries the running total for the
        // address; a caller is told what they were just charged.
        charge,
        result,
        // THE SAME VARIABLE THAT WAS JUST PERSISTED RAW. toPublicPropertyRecord
        // returns a copy and never touches its argument -- an in-place delete
        // here would have written a 65-key row to trace_history and destroyed
        // the raw dump. 65 keys out, 86 keys stored.
        propertyRecord: toPublicPropertyRecord(execution.property),
        ownerName: execution.ownerName,
        ownerType: execution.ownerType,
        needsManualReview: execution.needsManualReview,
        warnings,
      });
    }

    // TIER 1, unchanged: submit and return a traceId to poll. Reaching here means the
    // caller supplied an owner of record, because an absent one is the tier 2 trigger
    // above. Nothing here goes looking for an owner and nothing here books a charge --
    // the per-successful-trace deduct still happens in the poll route.
    const submitResult = await submitSingleTrace({
      address,
      city,
      state,
      zip,
      owner_name: ownerName || undefined,
    });

    if (!submitResult.success || !submitResult.jobId) {
      await adminClient
        .from('trace_history')
        .update({ status: 'error' })
        .eq('id', traceRecord.id);

      return NextResponse.json(
        { success: false, error: submitResult.error || 'Failed to submit trace' },
        { status: 500 }
      );
    }

    // Save Tracerfy job ID
    await adminClient
      .from('trace_history')
      .update({ tracerfy_job_id: submitResult.jobId })
      .eq('id', traceRecord.id);

    return NextResponse.json({
      success: true,
      status: 'processing',
      traceId: traceRecord.id,
      tracerfyJobId: submitResult.jobId,
      message: 'Trace submitted. Poll /api/v1/trace/status?trace_id=' + traceRecord.id + ' for results.',
    });
  } catch (error) {
    console.error('API v1 single trace error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
