import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
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

    return NextResponse.json(result);
  } catch (error) {
    console.error('Member verification error:', error);
    return NextResponse.json(
      { verified: false, message: 'Verification service unavailable' },
      { status: 500 }
    );
  }
}
