import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { researchProperty } from '@/lib/ai-research/client';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { AI_RESEARCH, DEDUPE } from '@/lib/constants';

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { address, city, state, zip, owner_name, skip_cache } = body;

    const validation = validateAddressInput(address, city, state, zip);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    // Get user profile for wallet check
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

    if (profile.wallet_balance < AI_RESEARCH.CHARGE_PER_RECORD) {
      return NextResponse.json(
        { success: false, error: 'Insufficient wallet balance for AI research ($0.15 per lookup).' },
        { status: 402 }
      );
    }

    const adminClient = createAdminClient();

    // Check for cached AI research on this address (within 90-day window)
    const normalizedAddress = normalizeAddress(address, city, state, zip);
    const addressHash = createAddressHash(normalizedAddress);

    if (!skip_cache) {
      const windowDate = new Date();
      windowDate.setDate(windowDate.getDate() - DEDUPE.WINDOW_DAYS);

      const { data: cached } = await adminClient
        .from('trace_history')
        .select('ai_research')
        .eq('user_id', user.id)
        .eq('address_hash', addressHash)
        .not('ai_research', 'is', null)
        .gte('created_at', windowDate.toISOString())
        .limit(1)
        .single();

      if (cached?.ai_research) {
        return NextResponse.json({
          success: true,
          is_cached: true,
          research: cached.ai_research,
          charge: 0,
        });
      }
    }
    // When skip_cache is true, we skip the lookup entirely and run fresh research below

    // Run AI research
    const research = await researchProperty(address, city, state, zip, owner_name);

    // Only charge if we found an owner name
    let charge = 0;
    if (research.owner_name) {
      const { data: deducted } = await adminClient.rpc('deduct_wallet_balance', {
        p_user_id: user.id,
        p_amount: AI_RESEARCH.CHARGE_PER_RECORD,
        p_description: 'AI property research',
      });

      if (!deducted) {
        return NextResponse.json(
          { success: false, error: 'Failed to deduct wallet balance' },
          { status: 402 }
        );
      }
      charge = AI_RESEARCH.CHARGE_PER_RECORD;
    }

    // Store research result on trace_history if a row exists for this address
    await adminClient
      .from('trace_history')
      .update({
        ai_research: research,
        ai_research_status: research.owner_name ? 'found' : 'not_found',
        ai_research_charge: charge,
      })
      .eq('user_id', user.id)
      .eq('address_hash', addressHash);

    return NextResponse.json({
      success: true,
      is_cached: false,
      research,
      charge,
    });
  } catch (error) {
    console.error('AI research error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `AI research failed: ${message}` },
      { status: 500 }
    );
  }
}
