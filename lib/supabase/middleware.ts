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
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, {
              ...options,
              sameSite: 'none',
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
  const publicRoutes = ['/', '/login', '/register', '/verify', '/auth/callback'];
  const isPublicRoute = publicRoutes.some(
    (route) =>
      request.nextUrl.pathname === route ||
      request.nextUrl.pathname.startsWith('/auth/')
  );

  // Redirect unauthenticated users to login
  if (!user && !isPublicRoute && !request.nextUrl.pathname.startsWith('/api/')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const response = NextResponse.redirect(url);
    response.headers.set('Content-Security-Policy', CSP_HEADER);
    return response;
  }

  // Redirect authenticated users away from auth pages
  if (user && isPublicRoute && request.nextUrl.pathname !== '/auth/callback') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    const response = NextResponse.redirect(url);
    response.headers.set('Content-Security-Policy', CSP_HEADER);
    return response;
  }

  return supabaseResponse;
}
