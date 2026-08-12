import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const CSP_HEADER = "frame-ancestors 'self' https://*.gohighlevel.com https://*.highlevel.com https://*.leadconnectorhq.com https://goacquisitionpro.com https://*.goacquisitionpro.com https://acquisitionpro.io https://*.acquisitionpro.io";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });
  supabaseResponse.headers.set('Content-Security-Policy', CSP_HEADER);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          supabaseResponse.headers.set('Content-Security-Policy', CSP_HEADER);
          // SameSite=Lax, not None. None existed only so the session cookie survived inside the
          // AcquisitionPRO/GoHighLevel iframe embed; those links were removed, so None is now dead
          // config that needlessly ships the session cookie on cross-site requests. Lax still
          // covers the top-level navigation an emailed link performs.
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, {
              ...options,
              sameSite: 'lax',
              secure: true,
            })
          );
        },
      },
    }
  );

  // Refresh session if expired
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Define public routes that don't require authentication
  const publicRoutes = ['/', '/login', '/register', '/verify', '/auth/callback', '/forgot-password', '/reset-password', '/api/auth/suite/start', '/api/auth/suite/callback'];
  const isPublicRoute = publicRoutes.some(
    (route) =>
      request.nextUrl.pathname === route ||
      request.nextUrl.pathname.startsWith('/auth/')
  );

  // Public routes an AUTHENTICATED user must still be able to reach.
  //
  // /reset-password is the load-bearing one: the emailed recovery link establishes a session at
  // /auth/confirm BEFORE the form renders, so the user arrives here already signed in. Bouncing
  // them to /dashboard (the rule below) left the password form permanently unreachable -- fixing
  // the token exchange without this is not a fix. /auth/* is here because those routes exist to
  // complete a sign-in and must run to their own redirect.
  const authedAllowedRoutes = ['/reset-password'];
  const isAuthedAllowed =
    authedAllowedRoutes.includes(request.nextUrl.pathname) ||
    request.nextUrl.pathname.startsWith('/auth/');

  // Redirect unauthenticated users to login
  if (!user && !isPublicRoute && !request.nextUrl.pathname.startsWith('/api/') && !request.nextUrl.pathname.startsWith('/.well-known/')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const response = NextResponse.redirect(url);
    response.headers.set('Content-Security-Policy', CSP_HEADER);
    return response;
  }

  // Redirect authenticated users away from auth pages
  if (user && isPublicRoute && !isAuthedAllowed) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    const response = NextResponse.redirect(url);
    response.headers.set('Content-Security-Policy', CSP_HEADER);
    return response;
  }

  return supabaseResponse;
}
