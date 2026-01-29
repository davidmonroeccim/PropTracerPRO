import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { UserProfile } from '@/types';

interface AuthResult {
  profile: UserProfile;
}

interface AuthError {
  response: NextResponse;
}

/**
 * Validates an API key from the Authorization header.
 * Extracts Bearer token, looks up user_profiles, verifies Pro tier or AcquisitionPRO membership.
 * Logs the request to api_logs. No rate limiting.
 *
 * Returns { profile } on success, or { response } with a 401/403 NextResponse on failure.
 */
export async function validateApiKey(
  request: Request
): Promise<AuthResult | AuthError> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      response: NextResponse.json(
        { success: false, error: 'Missing or invalid Authorization header. Use: Bearer YOUR_API_KEY' },
        { status: 401 }
      ),
    };
  }

  const apiKey = authHeader.slice(7).trim();

  if (!apiKey) {
    return {
      response: NextResponse.json(
        { success: false, error: 'API key is empty' },
        { status: 401 }
      ),
    };
  }

  const adminClient = createAdminClient();

  // Look up user by API key
  const { data: profile, error } = await adminClient
    .from('user_profiles')
    .select('*')
    .eq('api_key', apiKey)
    .single();

  if (error || !profile) {
    return {
      response: NextResponse.json(
        { success: false, error: 'Invalid API key' },
        { status: 401 }
      ),
    };
  }

  // Verify Pro tier or AcquisitionPRO membership
  const hasAccess = profile.subscription_tier === 'pro' || profile.is_acquisition_pro_member;

  if (!hasAccess) {
    return {
      response: NextResponse.json(
        { success: false, error: 'API access requires a Pro subscription or AcquisitionPRO membership' },
        { status: 403 }
      ),
    };
  }

  // Log the API request (fire-and-forget)
  adminClient
    .from('api_logs')
    .insert({
      user_id: profile.id,
      method: request.method,
      path: new URL(request.url).pathname,
      status_code: 200,
    })
    .then(() => {});

  return { profile };
}

/**
 * Type guard to check if the result is an auth error.
 */
export function isAuthError(result: AuthResult | AuthError): result is AuthError {
  return 'response' in result;
}
