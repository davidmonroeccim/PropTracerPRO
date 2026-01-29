import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { checkSingleDuplicate } from '@/lib/utils/deduplication';
import { submitSingleTrace } from '@/lib/tracerfy/client';
import { PRICING } from '@/lib/constants';
import type { TraceResult } from '@/types';

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
    const { address, city, state, zip, ownerName } = body;

    // Validate input
    const validation = validateAddressInput(address, city, state, zip);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    // Check wallet balance for pay-as-you-go users
    if (profile.subscription_tier === 'wallet') {
      if (profile.wallet_balance < PRICING.CHARGE_PER_SUCCESS_WALLET) {
        return NextResponse.json(
          { success: false, error: 'Insufficient wallet balance' },
          { status: 402 }
        );
      }
    }

    // Normalize address and create hash
    const normalizedAddress = normalizeAddress(address, city, state, zip);
    const addressHash = createAddressHash(normalizedAddress);

    const adminClient = createAdminClient();

    // Check for cached result (90-day dedup)
    const cachedResult = await checkSingleDuplicate(profile.id, address, city, state, zip);

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

      // Cached result has no contact data — delete and re-trace
      await adminClient
        .from('trace_history')
        .delete()
        .eq('id', cachedResult.id);
    }

    // Delete any existing failed traces for this address
    await adminClient
      .from('trace_history')
      .delete()
      .eq('user_id', profile.id)
      .eq('address_hash', addressHash)
      .eq('is_successful', false);

    // Insert pending trace record
    const { data: traceRecord, error: insertError } = await adminClient
      .from('trace_history')
      .insert({
        user_id: profile.id,
        address_hash: addressHash,
        normalized_address: normalizedAddress,
        city: city.toUpperCase(),
        state: state.toUpperCase(),
        zip: zip.substring(0, 5),
        input_owner_name: ownerName || null,
        status: 'processing',
      })
      .select()
      .single();

    if (insertError) {
      console.error('API v1 single trace - failed to create record:', insertError.message);
      return NextResponse.json(
        { success: false, error: 'Failed to process request' },
        { status: 500 }
      );
    }

    // Submit to Tracerfy
    const submitResult = await submitSingleTrace({
      address,
      city,
      state,
      zip,
      owner_name: ownerName,
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
      message: 'Trace submitted. Poll /api/trace/status?trace_id=' + traceRecord.id + ' for results.',
    });
  } catch (error) {
    console.error('API v1 single trace error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
