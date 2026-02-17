import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAcquisitionProMember } from '@/lib/highlevel/client';

export async function POST() {
  try {
    // Check authentication
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { verified: false, message: 'Unauthorized' },
        { status: 401 }
      );
    }

    if (!user.email) {
      return NextResponse.json(
        { verified: false, message: 'Email address required for verification' },
        { status: 400 }
      );
    }

    // Verify with HighLevel by checking for sp3-owner tag
    const result = await verifyAcquisitionProMember(user.email);

    // Persist verification result server-side (prevents client-side bypass)
    if (result.verified) {
      const adminClient = createAdminClient();
      await adminClient
        .from('user_profiles')
        .update({
          is_acquisition_pro_member: true,
          acquisition_pro_verified_at: new Date().toISOString(),
        })
        .eq('id', user.id);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Member verification error:', error);
    return NextResponse.json(
      { verified: false, message: 'Verification service unavailable' },
      { status: 500 }
    );
  }
}
