import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

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
    const { highlevel_api_key, highlevel_location_id } = body;

    if (!highlevel_api_key || !highlevel_location_id) {
      return NextResponse.json(
        { success: false, error: 'API Key and Location ID are required' },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();

    const { error } = await adminClient
      .from('user_profiles')
      .update({
        highlevel_api_key,
        highlevel_location_id,
      })
      .eq('id', user.id);

    if (error) {
      console.error('Failed to save HighLevel credentials:', error);
      return NextResponse.json(
        { success: false, error: 'Failed to save credentials' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('HighLevel save error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
