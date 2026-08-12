import { createBrowserClient } from '@supabase/ssr';

// No cookieOptions override: @supabase/ssr's defaults (SameSite=Lax) are correct for a first-party
// app. The previous SameSite=None override existed only so cookies survived inside the
// AcquisitionPRO/GoHighLevel iframe embed. Those links were removed, and None is a third-party
// cookie -- exactly the kind browsers now restrict, which is how the PKCE code_verifier went
// missing and made emailed sign-in links fail.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
