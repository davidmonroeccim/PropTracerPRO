import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { researchProperty } from '@/lib/ai-research/client';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { AI_RESEARCH, DEDUPE } from '@/lib/constants';

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
    const { address, city, state, zip, ownerName, skipCache } = body;

    // Validate input
    const validation = validateAddressInput(address, city, state, zip);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    // Check wallet balance
    if (profile.wallet_balance < AI_RESEARCH.CHARGE_PER_RECORD) {
      return NextResponse.json(
        { success: false, error: 'Insufficient wallet balance for AI research ($0.15 per lookup).' },
        { status: 402 }
      );
    }

    const adminClient = createAdminClient();

    // Check for cached AI research (90-day window)
    const normalizedAddress = normalizeAddress(address, city, state, zip);
    const addressHash = createAddressHash(normalizedAddress);

    if (!skipCache) {
      const windowDate = new Date();
      windowDate.setDate(windowDate.getDate() - DEDUPE.WINDOW_DAYS);

      const { data: cached } = await adminClient
        .from('trace_history')
        .select('ai_research')
        .eq('user_id', profile.id)
        .eq('address_hash', addressHash)
        .not('ai_research', 'is', null)
        .gte('created_at', windowDate.toISOString())
        .limit(1)
        .single();

      if (cached?.ai_research) {
        return NextResponse.json({
          success: true,
          isCached: true,
          research: cached.ai_research,
          charge: 0,
        });
      }
    }

    // Run AI research — pass async recovery context so a business trace that
    // doesn't finish within the inline 45s poll gets persisted for the cron sweeper.
    const research = await researchProperty(address, city, state, zip, ownerName, {
      userId: profile.id,
      addressHash,
      normalizedAddress,
      city: city.toUpperCase(),
      state: state.toUpperCase(),
      zip: zip.substring(0, 5),
    });

    // Only charge if we found an owner name
    let charge = 0;
    if (research.owner_name) {
      const { data: deducted } = await adminClient.rpc('deduct_wallet_balance', {
        p_user_id: profile.id,
        p_amount: AI_RESEARCH.CHARGE_PER_RECORD,
        p_description: 'AI property research (API)',
      });

      if (!deducted) {
        return NextResponse.json(
          { success: false, error: 'Failed to deduct wallet balance' },
          { status: 402 }
        );
      }
      charge = AI_RESEARCH.CHARGE_PER_RECORD;
    }

    // Store research result on trace_history if a row exists for this address.
    // Strip internal pending_business_trace plumbing from the persisted payload
    // (it's exposed separately on the API response).
    const { pending_business_trace, ...researchForStorage } = research;
    await adminClient
      .from('trace_history')
      .update({
        ai_research: researchForStorage,
        ai_research_status: research.owner_name ? 'found' : 'not_found',
        ai_research_charge: charge,
      })
      .eq('user_id', profile.id)
      .eq('address_hash', addressHash);

    // If a business trace was queued for async recovery, look up the job row
    // we just inserted so we can return its id to the caller.
    let businessTracePending = false;
    let businessTraceJobId: string | null = null;
    if (pending_business_trace) {
      const { data: pendingJob } = await adminClient
        .from('business_trace_jobs')
        .select('id')
        .eq('user_id', profile.id)
        .eq('fastappend_queue_id', pending_business_trace.queue_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (pendingJob) {
        businessTracePending = true;
        businessTraceJobId = pendingJob.id;
      }
    }

    // Fire-and-forget: webhook dispatch for research.completed
    const { data: integrationProfile } = await adminClient
      .from('user_profiles')
      .select('webhook_url')
      .eq('id', profile.id)
      .single();

    // Surface FastAppend contacts at the top level for agent convenience.
    // Also present inside research.business_trace_contacts.
    const contacts = researchForStorage.business_trace_contacts || null;

    if (integrationProfile?.webhook_url) {
      fetch(integrationProfile.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'research.completed',
          address: normalizedAddress,
          city: city.toUpperCase(),
          state: state.toUpperCase(),
          zip: zip.substring(0, 5),
          research: researchForStorage,
          contacts,
          charge,
          business_trace_pending: businessTracePending,
          business_trace_job_id: businessTraceJobId,
          timestamp: new Date().toISOString(),
        }),
      }).catch((err) => console.error('Webhook dispatch error:', err));
    }

    return NextResponse.json({
      success: true,
      isCached: false,
      research: researchForStorage,
      contacts,
      charge,
      business_trace_pending: businessTracePending,
      business_trace_job_id: businessTraceJobId,
    });
  } catch (error) {
    console.error('API v1 research error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `AI research failed: ${message}` },
      { status: 500 }
    );
  }
}
