import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateHighLevelCredential } from '@/lib/highlevel/client';
import type { HighLevelValidation } from '@/lib/highlevel/client';
import { recordHighLevelOutcomes } from '@/lib/highlevel/credentialHealth';

/**
 * THE SAVE POLICY, AND IT IS NARROWER THAN "REFUSE ANY 401".
 *
 * This route used to presence-check two fields and write them, so `x` and `y`
 * produced a permanent green "Connected". It now asks HighLevel first. But the
 * only check available is a contacts READ, and every product call PTP makes is
 * a WRITE, with `contacts.readonly` and `contacts.write` as SEPARATE HighLevel
 * scopes. A failed read does not always prove a write would fail, so the answer
 * decides what we are entitled to conclude:
 *
 *   token      REFUSE  a rejected token is rejected for every verb
 *   location   REFUSE  the wrong location is wrong for every verb
 *   scope      SAVE    the token may hold contacts.write and push perfectly.
 *                      Refusing here would block a working credential, which is
 *                      the exact failure this change exists to end.
 *   transient  SAVE    HighLevel being down is not the user's fault
 *   unknown    SAVE    we could not read the refusal, so we assert nothing
 *   record     SAVE    same: an answer we cannot generalise from
 *
 * Everything we save without confirming is saved WITH A WARNING that names what
 * we could not confirm. We never claim to have verified something we did not.
 */

/** The two refusals, each naming the fix for its own reason. */
const REFUSAL = {
  token:
    'HighLevel rejected this API key, so we did not save it. Check that you copied the whole key, then try again.',
  location:
    'HighLevel says this token has no access to this location ID, so we did not save it. Check the location ID, then try again.',
} as const;

function refusalFor(validation: HighLevelValidation): string | null {
  if (validation.success || validation.kind !== 'credential') return null;
  if (validation.reason === 'token') return REFUSAL.token;
  if (validation.reason === 'location') return REFUSAL.location;
  return null;
}

/** One sentence, saying what we could not confirm. Never a claim that it works. */
function warningFor(validation: HighLevelValidation): string {
  if (!validation.success && validation.kind === 'credential' && validation.reason === 'scope') {
    return 'Saved, but we could not confirm it: this token is missing contacts.readonly so our check could not read your contacts, and your pushes may still work if it has contacts.write.';
  }
  if (!validation.success && validation.kind === 'transient') {
    return 'Saved, but we could not confirm it: HighLevel did not answer our check just now, so we have not seen this key work yet.';
  }
  return 'Saved, but we could not confirm it: HighLevel refused our check and did not say why, so we have not seen this key work yet.';
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
        { success: false, error: 'API Key and Location ID are required' },
        { status: 400 }
      );
    }

    const validation = await validateHighLevelCredential({
      apiKey: highlevel_api_key,
      locationId: highlevel_location_id,
    });

    // Refused for every verb: storing it would put a badge on screen for a
    // credential we already know cannot work.
    const refusal = refusalFor(validation);
    if (refusal) {
      return NextResponse.json({ success: false, error: refusal }, { status: 400 });
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

    if (validation.success) {
      // Clears any standing red badge, and only if one is standing.
      await recordHighLevelOutcomes(user.id, [validation]);
      return NextResponse.json({ success: true, connected: true });
    }

    // DELIBERATELY NOT CLEARED HERE. We confirmed nothing, so an existing flag
    // still describes the last push that actually happened, and its wording
    // says so. The next real push corrects it either way: a success clears it
    // and a credential failure refreshes it.
    return NextResponse.json({
      success: true,
      connected: false,
      warning: warningFor(validation),
    });
  } catch (error) {
    console.error('HighLevel save error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
