import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';

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
    const { address, city, state, zip, type } = body as {
      address: string;
      city: string;
      state: string;
      zip: string;
      type: 'ai_research' | 'trace' | 'all';
    };

    const validation = validateAddressInput(address, city, state, zip);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    const normalizedAddress = normalizeAddress(address, city, state, zip);
    const addressHash = createAddressHash(normalizedAddress);
    const adminClient = createAdminClient();

    if (type === 'ai_research') {
      // Null out AI research columns on matching trace_history rows
      await adminClient
        .from('trace_history')
        .update({
          ai_research: null,
          ai_research_status: null,
          ai_research_charge: null,
        })
        .eq('user_id', user.id)
        .eq('address_hash', addressHash);
    } else if (type === 'trace') {
      // Delete trace_history rows for this address
      await adminClient
        .from('trace_history')
        .delete()
        .eq('user_id', user.id)
        .eq('address_hash', addressHash);
    } else {
      // 'all' — delete the rows entirely (clears both trace + AI research)
      await adminClient
        .from('trace_history')
        .delete()
        .eq('user_id', user.id)
        .eq('address_hash', addressHash);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Cache clear error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Failed to clear cache: ${message}` },
      { status: 500 }
    );
  }
}
