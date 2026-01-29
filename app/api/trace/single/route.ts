import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { checkSingleDuplicate } from '@/lib/utils/deduplication';
import { submitSingleTrace } from '@/lib/tracerfy/client';
import { PRICING } from '@/lib/constants';
import type { SingleTraceRequest, TraceResult } from '@/types';

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
    const body: SingleTraceRequest = await request.json();
    const { address, city, state, zip, owner_name } = body;

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

    // Check wallet balance for pay-as-you-go users
    if (profile.subscription_tier === 'wallet') {
      if (profile.wallet_balance < PRICING.CHARGE_PER_SUCCESS_WALLET) {
        return NextResponse.json(
          {
            success: false,
            error: 'Insufficient wallet balance. Please add funds to continue.',
          },
          { status: 402 }
        );
      }
    }

    // Create normalized address and hash
    const normalizedAddress = normalizeAddress(address, city, state, zip);
    const addressHash = createAddressHash(normalizedAddress);

    const adminClient = createAdminClient();

    // Check for duplicate (cached result)
    const cachedResult = await checkSingleDuplicate(user.id, address, city, state, zip);

    if (cachedResult) {
      const cached = cachedResult.trace_result as TraceResult | null;
      const hasData = cached &&
        ((cached.phones?.length || 0) > 0 || (cached.emails?.length || 0) > 0);

      if (hasData) {
        // Return cached result with actual data - no charge
        return NextResponse.json({
          success: true,
          is_cached: true,
          trace_id: cachedResult.id,
          result: cached,
          charge: 0,
        });
      }

      // Cached result has no contact data - delete it and re-trace
      await adminClient
        .from('trace_history')
        .delete()
        .eq('id', cachedResult.id);
    }

    // Delete any existing failed traces for this address (to allow retry)
    await adminClient
      .from('trace_history')
      .delete()
      .eq('user_id', user.id)
      .eq('address_hash', addressHash)
      .eq('is_successful', false);

    // Insert pending trace record
    const { data: traceRecord, error: insertError } = await adminClient
      .from('trace_history')
      .insert({
        user_id: user.id,
        address_hash: addressHash,
        normalized_address: normalizedAddress,
        city: city.toUpperCase(),
        state: state.toUpperCase(),
        zip: zip.substring(0, 5),
        input_owner_name: owner_name || null,
        status: 'processing',
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create trace record:', insertError.message);
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
