import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const adminClient = createAdminClient();

    const { error } = await adminClient
      .from('user_profiles')
      .update({
        highlevel_api_key: null,
        highlevel_location_id: null,
        // The health columns describe the credential being removed here, so
        // they go with it. Left behind, they would attach the old key's
        // diagnosis to whatever the user connects next, and the reason column
        // names a specific fix, so a stale one is a wrong instruction.
        highlevel_invalid_at: null,
        highlevel_invalid_status: null,
        highlevel_invalid_reason: null,
      })
      .eq('id', user.id);

    if (error) {
      console.error('Failed to disconnect HighLevel:', error);
      return NextResponse.json(
        { success: false, error: 'Failed to disconnect' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('HighLevel disconnect error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
