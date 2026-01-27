import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user profile
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier, is_acquisition_pro_member')
      .eq('id', user.id)
      .single();

    // Check if user has API access
    const hasApiAccess = profile?.subscription_tier === 'pro' || profile?.is_acquisition_pro_member;

    if (!hasApiAccess) {
      return NextResponse.json(
        { error: 'API access requires Pro subscription or AcquisitionPRO membership' },
        { status: 403 }
      );
    }

    // Generate new API key (ptp_ prefix + 60 hex chars = 64 chars to fit VARCHAR(64))
    const bytes = new Uint8Array(30);
    globalThis.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const apiKey = `ptp_${hex}`;

    // Save to database
    const adminClient = createAdminClient();
    const { error: updateError } = await adminClient
      .from('user_profiles')
      .update({
        api_key: apiKey,
        api_key_created_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Failed to save API key:', updateError);
      return NextResponse.json({ error: 'Failed to generate API key' }, { status: 500 });
    }

    return NextResponse.json({ apiKey });
  } catch (error) {
    console.error('Generate API key error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
