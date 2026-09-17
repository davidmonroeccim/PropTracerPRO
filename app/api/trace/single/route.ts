import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { checkSingleDuplicate } from '@/lib/utils/deduplication';
import { excludeBilledRows, isBilledRow } from '@/lib/trace/billedRows';
import { submitSingleTrace } from '@/lib/tracerfy/client';
import { STALE_PROCESSING } from '@/lib/constants';
import { chargePerTrace } from '@/lib/suite/pricing';
import type { SingleTraceRequest, TraceResult, AIResearchResult } from '@/types';

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
    const { address, city, state, zip, owner_name, ai_research, skip_cache } = body as SingleTraceRequest & { ai_research?: AIResearchResult; skip_cache?: boolean };

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

    // Check wallet balance for all users
    const minBalance = chargePerTrace(profile);
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
          // Return cached result with actual data - no charge
          return NextResponse.json({
            success: true,
            is_cached: true,
            trace_id: cachedResult.id,
            result: cached,
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
      zip: zip.substring(0, 5),
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
