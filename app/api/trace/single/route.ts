import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { checkSingleDuplicate } from '@/lib/utils/deduplication';
import {
  excludeBilledRows,
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
} from '@/lib/trace/fullPropertyTrace';
import { deductOrZero } from '@/lib/wallet/deduct';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { STALE_PROCESSING } from '@/lib/constants';
import { chargePerRecord, chargePerTrace, pricePlanFor } from '@/lib/suite/pricing';
import type { SingleTraceRequest, TraceResult, AIResearchResult } from '@/types';

/**
 * Tier 2 runs the whole route SYNCHRONOUSLY: a dossier lookup (sometimes two,
 * stopping at the first hit) and then one contact lookup, all JSON POSTs with
 * no queue and no polling. Three vendor round trips do not fit in the default
 * function timeout. 60 matches the only other route in this codebase that
 * makes inline vendor calls (app/api/v1/trace/single, which polls FastAppend
 * inline on a 15s budget). Tier 1 is unaffected: it still returns as soon as
 * Tracerfy accepts the job.
 */
export const maxDuration = 60;

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
    const body = await request.json();
    const { address, city, state, zip, owner_name, ai_research, skip_cache, full_property_trace } =
      body as SingleTraceRequest & {
        ai_research?: AIResearchResult;
        skip_cache?: boolean;
        /**
         * Full Property Trace opt-in, for a caller who already HAS the owner of
         * record and wants the county property record anyway. Absent owner_name
         * triggers tier 2 on its own; this flag is the other half of the
         * trigger. Its own flag, deliberately: `ai_research` belongs to a
         * feature that is being removed.
         */
        full_property_trace?: boolean;
      };

    // Validate input
    const validation = validateAddressInput(address, city, state, zip);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
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

    // Tier 2 (Full Property Trace) when the owner of record is missing, or when
    // the caller asked for the property record outright.
    const fullPropertyTrace = isFullPropertyTrace({ owner_name, full_property_trace });

    // Check wallet balance for all users, AGAINST THE RATE THIS REQUEST WILL
    // CHARGE. Reserving the tier 1 rate for a tier 2 request under-reserves by
    // $0.10-$0.15 and lets a wallet that cannot pay reach the vendors -- where
    // the money is spent on our side whether or not we can collect it.
    const minBalance = fullPropertyTrace ? chargePerRecord(profile) : chargePerTrace(profile);
    if (profile.wallet_balance < minBalance) {
      return NextResponse.json(
        {
          success: false,
          error: 'Insufficient wallet balance. Please add funds to continue.',
        },
        { status: 402 }
      );
    }

    // Create normalized address and hash
    const normalizedAddress = normalizeAddress(address, city, state);
    const addressHash = createAddressHash(normalizedAddress);

    const adminClient = createAdminClient();

    // Every delete below is narrowed by excludeBilledRows() and its error is
    // checked. A refused delete used to be invisible: the row survived, this
    // route carried on as though it had not, and the INSERT at the bottom died
    // on UNIQUE(user_id, address_hash) with a 500 that named nothing. See
    // lib/trace/billedRows.ts.
    const deleteErrors: string[] = [];
    const runDelete = async (
      label: string,
      build: () => PromiseLike<{ error: { message: string } | null }>
    ) => {
      const { error } = await build();
      if (error) {
        console.error(`Single trace - ${label} delete failed:`, error.message);
        deleteErrors.push(error.message);
      }
    };

    if (skip_cache) {
      // User explicitly cleared cache — delete this address's trace_history rows.
      // A billed row survives on purpose: the customer paid for what it holds, so
      // it is theirs to be served from, not ours to throw away. The reuse branch
      // below picks it up instead of colliding with it.
      await runDelete('skip_cache', () =>
        excludeBilledRows(
          adminClient
            .from('trace_history')
            .delete()
            .eq('user_id', user.id)
            .eq('address_hash', addressHash)
        )
      );
    } else {
      // Check for duplicate (cached result)
      const cachedResult = await checkSingleDuplicate(user.id, address, city, state);

      if (cachedResult) {
        const cached = cachedResult.trace_result as TraceResult | null;
        const hasData = cached &&
          ((cached.phones?.length || 0) > 0 || (cached.emails?.length || 0) > 0);

        if (hasData) {
          // Return cached result with actual data - no charge.
          // property_record rides along: on a tier 2 row it is the thing the
          // customer paid for, and dropping it here would serve them a cache
          // hit poorer than the response they originally got.
          return NextResponse.json({
            success: true,
            is_cached: true,
            trace_id: cachedResult.id,
            result: cached,
            property_record: cachedResult.property_record ?? null,
            tier: cachedResult.tier ?? null,
            charge: 0,
          });
        }

        // A BILLED TIER 2 ROW IS SERVED FROM THE DATABASE WHATEVER IT CONTAINS.
        // David, 2026-09-17: if serving the request spends money at Tracerfy the
        // user is charged, and if it is served from their own stored record it
        // is free. A tier 2 miss holds no contacts and no property record -- it
        // is a paid-for "the county has no parcel at this address" -- and
        // re-running the dossier would bill them a second time for the same
        // absence. isCacheHitRow is the JS twin of CACHE_HIT_FILTER, which is
        // what let this row out of the database in the first place.
        if (fullPropertyTrace && isCacheHitRow(cachedResult)) {
          return NextResponse.json({
            success: true,
            is_cached: true,
            trace_id: cachedResult.id,
            status: cachedResult.status,
            result: cached,
            property_record: cachedResult.property_record ?? null,
            tier: cachedResult.tier ?? null,
            charge: 0,
          });
        }

        // Cached row holds no contacts, so re-trace. Delete it only if the
        // customer has not paid for it: a tier 2 row's property record IS the
        // thing they bought, and its wallet_transactions row references this id.
        if (!isBilledRow(cachedResult)) {
          await runDelete('cached-empty', () =>
            adminClient.from('trace_history').delete().eq('id', cachedResult.id)
          );
        }
      }

      // Delete any existing failed traces for this address (to allow retry).
      // is_successful = false is ALSO the tier 2 paid-but-no-contacts shape,
      // which is why this sweep must exclude billed rows.
      await runDelete('failed', () =>
        excludeBilledRows(
          adminClient
            .from('trace_history')
            .delete()
            .eq('user_id', user.id)
            .eq('address_hash', addressHash)
            .eq('is_successful', false)
        )
      );

      // Delete stale processing traces (stuck for longer than threshold)
      const staleCutoff = new Date();
      staleCutoff.setMinutes(staleCutoff.getMinutes() - STALE_PROCESSING.STALE_MINUTES);
      await runDelete('stale-processing', () =>
        excludeBilledRows(
          adminClient
            .from('trace_history')
            .delete()
            .eq('user_id', user.id)
            .eq('address_hash', addressHash)
            .eq('status', 'processing')
            .lt('created_at', staleCutoff.toISOString())
        )
      );

      // If a different owner name is provided, delete any existing trace for this address.
      // This allows re-tracing when AI research resolves a person name from an LLC.
      if (owner_name) {
        await runDelete('owner-changed', () =>
          excludeBilledRows(
            adminClient
              .from('trace_history')
              .delete()
              .eq('user_id', user.id)
              .eq('address_hash', addressHash)
              .neq('input_owner_name', owner_name)
          )
        );
      }
    }

    if (deleteErrors.length > 0) {
      // Stop here rather than walking into the unique-constraint violation the
      // surviving row guarantees. The customer gets the real reason.
      return NextResponse.json(
        { success: false, error: `Failed to clear previous trace: ${deleteErrors[0]}` },
        { status: 500 }
      );
    }

    // Insert pending trace record (include AI research data if provided)
    const insertData: Record<string, unknown> = {
      user_id: user.id,
      address_hash: addressHash,
      normalized_address: normalizedAddress,
      city: city.toUpperCase(),
      state: state.toUpperCase(),
      // The zip is OPTIONAL at validation (it is not part of address_hash), so
      // it can legitimately be absent. `zip.substring(0, 5)` on an absent one
      // threw a TypeError and surfaced as a bare 500 before any vendor was
      // called -- and an absent zip is precisely the case tier 2 backfills.
      zip: zip ? zip.substring(0, 5) : null,
      input_owner_name: owner_name || null,
      status: 'processing',
    };

    if (ai_research) {
      insertData.ai_research = ai_research;
      insertData.ai_research_status = ai_research.owner_name ? 'found' : 'not_found';
    }

    // UNIQUE(user_id, address_hash) means ONE row per address per user. A row
    // that survived the guarded deletes above is a billed row, so this submit
    // enriches it in place instead of inserting a second one that cannot exist.
    // That is also the shape tier 2 wants: one row gaining a property record
    // first and contacts second.
    const { data: surviving, error: survivingError } = await adminClient
      .from('trace_history')
      .select('id')
      .eq('user_id', user.id)
      .eq('address_hash', addressHash)
      .maybeSingle();

    if (survivingError) {
      console.error('Failed to look up existing trace record:', survivingError.message);
      return NextResponse.json(
        { success: false, error: 'Failed to process request' },
        { status: 500 }
      );
    }

    let traceRecord: { id: string } | null = null;
    let insertError: { message: string } | null = null;

    if (surviving) {
      // Reset only the columns that describe THIS attempt. The identity columns
      // (user_id, address_hash) already match, and charge, ai_research_charge,
      // property_record and tier are left untouched: they are what the customer
      // already paid for.
      const { user_id: _u, address_hash: _h, ...resubmitData } = insertData;
      void _u;
      void _h;
      const { data, error } = await adminClient
        .from('trace_history')
        .update({ ...resubmitData, tracerfy_job_id: null })
        .eq('id', surviving.id)
        .select()
        .single();
      traceRecord = data;
      insertError = error;
    } else {
      const { data, error } = await adminClient
        .from('trace_history')
        .insert(insertData)
        .select()
        .single();
      traceRecord = data;
      insertError = error;
    }

    if (insertError || !traceRecord) {
      console.error('Failed to create trace record:', insertError?.message);
      return NextResponse.json(
        { success: false, error: 'Failed to process request' },
        { status: 500 }
      );
    }

    /* ---------------------------------------------------------------- *
     * TIER 2 — FULL PROPERTY TRACE
     *
     * Synchronous end to end: the dossier and the contact lookup are both
     * plain JSON POSTs, so the spend and the charge happen in this request
     * rather than in a later poll. That is the whole reason billing lives
     * here and nowhere else.
     *
     * THE CHARGE SEQUENCE, in order, and none of these steps may move:
     *   1. plan the route (pure, no spend) at the CALLER'S OWN rate
     *   2. run it -- dossier, then contacts for whatever owner it found
     *   3. if a vendor FAILED, charge nothing and let them retry for free
     *   4. otherwise deduct, ONCE, and read back what actually moved
     *   5. persist the record, the tier, and the amount that was collected
     * ---------------------------------------------------------------- */
    if (fullPropertyTrace) {
      // 1. The caller's REAL plan, derived from their profile exactly as the
      //    tier 1 rate is. planRoute takes it as a required argument so no
      //    route can quietly bill the wrong column.
      const plan = planRoute(
        parcelForFullTrace({ address, city, state, zip }),
        pricePlanFor(profile)
      );

      // Defence in depth: planRoute emits no step at all when the parcel has
      // no usable key. Address validation makes that unreachable from this
      // route, and it is guarded anyway because the rule is that the charge
      // follows the VENDOR CALL -- a record no vendor was ever asked about
      // must not reach the deduct below.
      if (plan.steps.length === 0) {
        await adminClient
          .from('trace_history')
          .update({ status: 'error', tracerfy_job_id: null })
          .eq('id', traceRecord.id);

        return NextResponse.json(
          {
            success: false,
            status: 'error',
            trace_id: traceRecord.id,
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

      // 3. A VENDOR FAILURE IS NEVER BILLED. `success: false` means we could
      //    not ask -- an outage, a rate limit, a rejected key. It is NOT the
      //    same as `ownerFound: false`, which is also what a legitimate,
      //    billable miss looks like. Gating on ownerFound would bill customers
      //    for our outages; gating on a hit would give away records we paid
      //    for. Nothing is charged and nothing billable is persisted, so the
      //    row stays retryable rather than becoming a free cache entry that
      //    can never acquire the contacts it is missing.
      if (!execution.success) {
        await adminClient
          .from('trace_history')
          .update({ status: 'error', tracerfy_job_id: null })
          .eq('id', traceRecord.id);

        return NextResponse.json(
          {
            success: false,
            status: 'error',
            trace_id: traceRecord.id,
            tier: TRACE_TIER.PER_RECORD_SUBMITTED,
            charge: 0,
            error: execution.error || 'Property lookup failed. Please try again.',
          },
          { status: 502 }
        );
      }

      // 4. Billable. A TOTAL MISS IS STILL BILLED: tier 2 is per RECORD
      //    SUBMITTED, so "the county has no parcel at this address" is a real
      //    answer the customer pays for. deductOrZero returns what actually
      //    moved -- 0 when the wallet came up short between the gate above and
      //    now -- and that is the only number that may be persisted or shown.
      const attemptedCharge = plan.billing.amount;
      const charge = await deductOrZero(adminClient, {
        p_user_id: user.id,
        p_amount: attemptedCharge,
        p_trace_history_id: traceRecord.id,
        p_description: FULL_PROPERTY_TRACE_DESCRIPTION,
      });

      // 5. Persist. property_record is the vendor's object BY REFERENCE, all
      //    86 keys, unfiltered and unrenamed: the raw dump is the product, and
      //    a key that is empty in OH, CA and UT may be populated elsewhere.
      const result = traceResultFor(execution);
      const isSuccessful = hasContactData(result);

      const { error: persistError } = await adminClient
        .from('trace_history')
        .update({
          status: isSuccessful ? 'success' : 'no_match',
          trace_result: result,
          phone_count: result?.phones?.length || 0,
          email_count: result?.emails?.length || 0,
          is_successful: isSuccessful,
          property_record: execution.property,
          tier: TRACE_TIER.PER_RECORD_SUBMITTED,
          charge,
          // What the vendors actually took, read from their own credit
          // counters rather than assumed from a price list.
          cost: execution.vendorSpend,
          tracerfy_job_id: null,
          // The situs zip the dossier taught us, and ONLY when the caller had
          // none. address_hash is sha256 of STREET|CITY|STATE and deliberately
          // excludes the zip (migration 20260904), so this column is free to
          // gain a value: the row keeps matching its own cache key. Never
          // recompute the hash here -- a row whose hash moves is a row that
          // re-buys itself forever.
          ...(execution.learnedZip ? { zip: execution.learnedZip } : {}),
        })
        .eq('id', traceRecord.id);

      if (persistError) {
        // The money is gone and the record is bought. Say so loudly rather
        // than returning a clean 500 that hides a paid-for result.
        console.error('Full Property Trace - failed to persist result:', persistError.message);
      }

      // Fire-and-forget, same rule as the poll route: a charge was attempted,
      // so top the wallet up if it has dropped below the threshold. Still
      // fires when the deduct failed -- that is exactly the wallet that needs it.
      triggerAutoRebillIfNeeded(user.id).catch(() => {});

      const warnings = [...execution.warnings];
      if (charge === 0) {
        warnings.push(
          'The wallet did not cover this record, so nothing was charged for it.'
        );
      }

      return NextResponse.json({
        success: true,
        status: isSuccessful ? 'success' : 'no_match',
        trace_id: traceRecord.id,
        tier: TRACE_TIER.PER_RECORD_SUBMITTED,
        charge,
        result,
        property_record: execution.property,
        owner_name: execution.ownerName,
        owner_type: execution.ownerType,
        needs_manual_review: execution.needsManualReview,
        warnings,
      });
    }

    // Submit to Tracerfy
    const submitResult = await submitSingleTrace({
      address,
      city,
      state,
      zip,
      owner_name,
    });

    if (!submitResult.success || !submitResult.jobId) {
      // Update trace record with error
      await adminClient
        .from('trace_history')
        .update({
          status: 'error',
          tracerfy_job_id: null,
        })
        .eq('id', traceRecord.id);

      return NextResponse.json(
        { success: false, error: submitResult.error || 'Failed to submit trace' },
        { status: 500 }
      );
    }

    // Save Tracerfy job ID and return immediately.
    // Client will poll /api/trace/status for results.
    await adminClient
      .from('trace_history')
      .update({
        tracerfy_job_id: submitResult.jobId,
      })
      .eq('id', traceRecord.id);

    return NextResponse.json({
      success: true,
      status: 'processing',
      trace_id: traceRecord.id,
      tracerfy_job_id: submitResult.jobId,
    });
  } catch (error) {
    console.error('Single trace error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Internal server error: ${message}` },
      { status: 500 }
    );
  }
}
