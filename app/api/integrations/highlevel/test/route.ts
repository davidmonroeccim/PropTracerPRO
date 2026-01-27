import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { HIGHLEVEL } from '@/lib/constants';

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

    // Test the credentials by fetching contacts
    const testUrl = `${HIGHLEVEL.BASE_URL}/contacts/?locationId=${highlevel_location_id}&limit=1`;

    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${highlevel_api_key}`,
        Version: HIGHLEVEL.API_VERSION,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('HighLevel test failed:', response.status, errorText);
      return NextResponse.json({
        connected: false,
        error: response.status === 401
          ? 'Invalid API key'
          : `HighLevel returned status ${response.status}`,
      });
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
