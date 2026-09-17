import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { checkSingleDuplicate } from '@/lib/utils/deduplication';
import { excludeBilledRows, isBilledRow } from '@/lib/trace/billedRows';
import { submitSingleTrace } from '@/lib/tracerfy/client';
import { researchProperty } from '@/lib/ai-research/client';
import { PRICING, AI_RESEARCH, getChargePerTrace } from '@/lib/constants';
import type { TraceResult } from '@/types';

export const maxDuration = 60;

// Cap inline FastAppend poll so the route returns within the function timeout.
// Entity research that needs more time should use /api/v1/research/single, which
// has full async recovery support via business_trace_jobs.
const SYNC_POLL_BUDGET_MS = 15000;

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
    const { address, city, state, zip, ownerName, aiResearch } = body;

    // Validate input
    const validation = validateAddressInput(address, city, state, zip);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    // Check wallet balance for all users (include research fee if applicable)
    const minBalance = getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member)
      + (aiResearch && !ownerName ? AI_RESEARCH.CHARGE_PER_RECORD : 0);
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
        return NextResponse.json({
          success: true,
          cached: true,
          charge: 0,
          result: cached,
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
    // This allows re-tracing when AI research resolves a person name from an LLC.
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
      zip: zip.substring(0, 5),
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

    // AI Research: if aiResearch is true and no ownerName provided, discover the owner
    let resolvedOwnerName = ownerName || null;
    let researchResult = null;
    let researchCharge = 0;

    if (aiResearch && !ownerName) {
      const research = await researchProperty(
        address,
        city,
        state,
        zip,
        undefined,
        undefined,
        SYNC_POLL_BUDGET_MS
      );
      researchResult = research;

      if (research.owner_name) {
        // Use individual_behind_business if available, otherwise owner_name
        resolvedOwnerName = research.individual_behind_business || research.owner_name;

        // Charge for research
        const { data: deducted } = await adminClient.rpc('deduct_wallet_balance', {
          p_user_id: profile.id,
          p_amount: AI_RESEARCH.CHARGE_PER_RECORD,
          p_description: 'AI property research (API auto-research)',
        });

        if (!deducted) {
          // Clean up the trace record — unless it is a billed row this request
          // reused rather than created, in which case it is not ours to remove.
          await runDelete('research-deduct-failed', () =>
            excludeBilledRows(
              adminClient.from('trace_history').delete().eq('id', traceRecord.id)
            )
          );

          return NextResponse.json(
            { success: false, error: 'Failed to deduct wallet balance for AI research' },
            { status: 402 }
          );
        }
        researchCharge = AI_RESEARCH.CHARGE_PER_RECORD;
      }

      // Store research on the trace record
      await adminClient
        .from('trace_history')
        .update({
          ai_research: research,
          ai_research_status: research.owner_name ? 'found' : 'not_found',
          ai_research_charge: researchCharge,
        })
        .eq('id', traceRecord.id);
    }

    // Submit to Tracerfy
    const submitResult = await submitSingleTrace({
      address,
      city,
      state,
      zip,
      owner_name: resolvedOwnerName || undefined,
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
      research: researchResult || undefined,
      researchCharge: researchCharge || undefined,
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
