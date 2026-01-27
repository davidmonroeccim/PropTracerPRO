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
