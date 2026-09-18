import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { validateHighLevelCredential } from '@/lib/highlevel/client';
import type { HighLevelValidation } from '@/lib/highlevel/client';

/**
 * WHAT THIS BUTTON CAN AND CANNOT PROVE. It reads one contact, and every push
 * PTP makes is a WRITE. `contacts.readonly` and `contacts.write` are separate
 * HighLevel scopes, so a token can pass this test and fail every push, or fail
 * this test and push perfectly. The messages below say which one happened
 * rather than calling everything "Invalid API key", which was the old answer to
 * every 401 and is the wrong instruction for three of the four reasons.
 *
 * The classification itself lives in lib/highlevel/client.ts, shared with the
 * push path and with save, so all three agree about what a refusal means.
 */
function messageFor(validation: HighLevelValidation): string {
  if (validation.success) return '';

  if (validation.kind === 'credential') {
    if (validation.reason === 'token') {
      return 'HighLevel rejected this API key. Check that you copied the whole key, then try again.';
    }
    if (validation.reason === 'location') {
      return 'This token does not have access to this location ID. Check the location ID in HighLevel.';
    }
    if (validation.reason === 'scope') {
      return 'This token cannot read your contacts, because it is missing contacts.readonly. Pushes may still work if it has contacts.write, so you can save it and watch the first push.';
    }
    return 'HighLevel refused this connection and did not say why. Check the key and the location ID in HighLevel.';
  }

  if (validation.kind === 'transient') {
    return 'HighLevel did not answer just now. Nothing here is wrong as far as we can tell, so try again shortly.';
  }

  return `HighLevel refused the check with status ${validation.status}.`;
}

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
        { connected: false, error: 'API Key and Location ID are required' },
        { status: 400 }
      );
    }

    const validation = await validateHighLevelCredential({
      apiKey: highlevel_api_key,
      locationId: highlevel_location_id,
    });

    if (!validation.success) {
      return NextResponse.json({ connected: false, error: messageFor(validation) });
    }

    return NextResponse.json({ connected: true });
  } catch (error) {
    console.error('HighLevel test error:', error);
    return NextResponse.json(
      { connected: false, error: 'Could not reach HighLevel API' },
      { status: 500 }
    );
  }
}
