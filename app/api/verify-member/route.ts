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

    // Persist the verdict HERE, server-side, with service_role.
    //
    // This used to be done by the browser: onboarding/page.tsx read this response into React
    // state and then wrote `is_acquisition_pro_member: verificationStatus === 'verified'`
    // itself. The server verified honestly and the client decided what to save, which is a
    // self-grant: is_acquisition_pro_member gates /api/v1 access AND selects the per-trace
    // rate ($0.07 vs $0.11), so it is entitlement and money, not a preference.
    //
    // Migration 20260716 revokes UPDATE on this column from `authenticated`, so the old
    // browser write can no longer succeed. This is the replacement path, not an addition.
    // service_role bypasses that revoke by design.
    //
    // Behavior is otherwise unchanged: we write exactly the verdict the client used to write
    // (verified -> true + timestamp, not verified -> false + null). Only the writer moved.
    const adminClient = createAdminClient();
    const { error: persistError } = await adminClient
      .from('user_profiles')
      .update({
        is_acquisition_pro_member: result.verified,
        acquisition_pro_verified_at: result.verified ? new Date().toISOString() : null,
      })
      .eq('id', user.id);

    if (persistError) {
      // Fail loudly rather than reporting a verification the account did not receive.
      // Returning verified:true here would strand the user: onboarding would advance while
      // the entitlement was never stored.
      console.error('Failed to persist member verification:', persistError);
      return NextResponse.json(
        { verified: false, message: 'Verification could not be saved. Please try again.' },
        { status: 500 }
      );
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
