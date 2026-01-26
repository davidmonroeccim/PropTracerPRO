import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { checkSingleDuplicate } from '@/lib/utils/deduplication';
import { submitSingleTrace, getJobStatus, parseTracerfyResult } from '@/lib/tracerfy/client';
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
      if (profile.wallet_balance < PRICING.CHARGE_PER_SUCCESS) {
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

    // Poll for results (with timeout)
    let result: TraceResult | null = null;
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;

      const statusResult = await getJobStatus(submitResult.jobId);

      if (!statusResult.success) {
        break;
      }

      // Results are ready
      if (statusResult.pending === false) {
        if (statusResult.results && statusResult.results.length > 0) {
          // Filter for the target address (exclude padding row and duplicates from other jobs)
          const targetResult = statusResult.results.find(
            (r) => r.address?.toUpperCase() === address.toUpperCase() &&
              (r.primary_phone || r.mobile_1 || r.email_1 || r.first_name)
          ) || statusResult.results.find(
            (r) => r.address?.toUpperCase() === address.toUpperCase()
          );
          if (targetResult) {
            result = parseTracerfyResult(targetResult);
          }
        }
        break;
      }

      // Still pending - continue polling
    }

    // Determine success
    const isSuccessful = result !== null &&
      ((result.phones?.length || 0) > 0 || (result.emails?.length || 0) > 0);

    // Calculate charge
    const charge = isSuccessful ? PRICING.CHARGE_PER_SUCCESS : 0;

    // Update trace record
    await adminClient
      .from('trace_history')
      .update({
        status: isSuccessful ? 'success' : 'no_match',
        tracerfy_job_id: submitResult.jobId,
        trace_result: result,
        phone_count: result?.phones?.length || 0,
        email_count: result?.emails?.length || 0,
        is_successful: isSuccessful,
        cost: PRICING.COST_PER_RECORD,
        charge: charge,
      })
      .eq('id', traceRecord.id);

    // Charge user if successful
    if (isSuccessful && charge > 0) {
      if (profile.subscription_tier === 'wallet') {
        // Deduct from wallet
        const { error: deductError } = await adminClient.rpc('deduct_wallet_balance', {
          p_user_id: user.id,
          p_amount: charge,
          p_trace_history_id: traceRecord.id,
          p_description: 'Skip trace - successful match',
        });

        if (deductError) {
          console.error('Failed to deduct wallet balance:', deductError);
        }

        // Check if rebill needed
        const { data: updatedProfile } = await adminClient
          .from('user_profiles')
          .select('wallet_balance, wallet_low_balance_threshold, wallet_auto_rebill_enabled')
          .eq('id', user.id)
          .single();

        if (
          updatedProfile &&
          updatedProfile.wallet_balance < updatedProfile.wallet_low_balance_threshold &&
          updatedProfile.wallet_auto_rebill_enabled
        ) {
          // TODO: Trigger wallet rebill via Stripe
          console.log('Wallet rebill needed for user:', user.id);
        }
      } else {
        // Record usage for Stripe metered billing
        await adminClient.from('usage_records').insert({
          user_id: user.id,
          trace_history_id: traceRecord.id,
          quantity: 1,
          unit_price: PRICING.CHARGE_PER_SUCCESS,
          total_amount: charge,
          billing_period_start: new Date().toISOString().substring(0, 10),
          billing_period_end: new Date().toISOString().substring(0, 10),
        });

        // TODO: Report to Stripe usage-based billing
      }
    }

    return NextResponse.json({
      success: true,
      is_cached: false,
      trace_id: traceRecord.id,
      result,
      charge,
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
