import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeAddress, createAddressHash, validateAddressInput } from '@/lib/utils/address-normalizer';
import { excludeBilledRows } from '@/lib/trace/billedRows';

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

    // `type` is accepted and deliberately not branched on: the delete below clears the
    // address's row whatever the caller asked for. The 'ai_research' arm was dropped on
    // 2026-09-17 with the AI Search engine; a stale client still sending that value is
    // ignored rather than rejected, and gets the same clear it always got.
    const body = await request.json();
    const { address, city, state, zip } = body as {
      address: string;
      city: string;
      state: string;
      zip: string;
      type?: 'trace' | 'all';
    };

    const validation = validateAddressInput(address, city, state, zip);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    const normalizedAddress = normalizeAddress(address, city, state);
    const addressHash = createAddressHash(normalizedAddress);
    const adminClient = createAdminClient();

    // Delete this address's trace_history rows regardless of type.
    //
    // BILLED ROWS SURVIVE ON PURPOSE. A row carrying a charge, a historical AI
    // research charge or a property record is something the customer paid for, and
    // `wallet_transactions.trace_history_id` references it with no ON DELETE
    // clause — deleting it raises 23503 and this route used to report success
    // anyway. "Clear cache" means "let me re-trace", not "destroy my receipt":
    // the submit route now reuses a surviving billed row instead of colliding
    // with it, so the retry still works.
    const { error: deleteError } = await excludeBilledRows(
      adminClient
        .from('trace_history')
        .delete()
        .eq('user_id', user.id)
        .eq('address_hash', addressHash)
    );

    if (deleteError) {
      console.error('Cache clear - delete failed:', deleteError.message);
      return NextResponse.json(
        { success: false, error: `Failed to clear cache: ${deleteError.message}` },
        { status: 500 }
      );
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
