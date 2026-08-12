# Dennis Bamford lockout — diagnosis + fix plan (2026-08-12)

Report: `ventexproperty@gmail.com` cannot log in with password, magic link, or the Suite
button, and forgot-password does not work.

## What the evidence shows

Account state (both sides) is healthy — this is not an account problem.

| Check | Result |
|---|---|
| PTP `auth.users` | confirmed 2026-02-05, bcrypt password set, not banned, not deleted |
| PTP `user_profiles` | `email` matches `auth.users.email` exactly, `gateway_sub` = NULL, onboarded |
| Gateway `auth.users` | confirmed 2026-08-11 17:14 (admin-provisioned) |
| Gateway `grants` | lifetime, includes `prop-tracer-pro`, no expiry, not revoked |
| GoTrue config | SITE_URL correct; `/auth/callback` + `/reset-password` both allowlisted |
| Email delivery | WORKING — see below |

**Emails are being delivered.** Every one of his `auth.flow_state` rows has
`auth_code_issued_at` set 20–30s after the send, i.e. he clicked each link promptly:

| When (UTC) | Flow | Link clicked | PTP session created |
|---|---|---|---|
| 08-10 17:36 | email/signup | 17:37:31 | no |
| 08-12 11:38 | magiclink | 11:39:04 | no |
| 08-12 11:41 | recovery | 11:41:39 | no |
| 08-12 12:10 | magiclink | 12:10:43 | no |

Newest session in `auth.sessions` is **2026-08-09**. So four clicked links produced zero
sessions: the PKCE code reaches the app and is never successfully exchanged.

`last_sign_in_at` is still 08-09, so his password attempts genuinely failed the credential
check (the endpoint is healthy — probing it returns a normal `invalid_credentials`).

No deploy since ~2026-07-24, so nothing regressed in code between his 08-09 success and now.

## Root causes (all in PTP, all affect every user)

**A. `/reset-password` never exchanges the code — forgot-password is broken for everyone.**
`app/(auth)/reset-password/page.tsx` receives `?code=` and only calls
`updateUser({ password })`. With no session that returns "Auth session missing!".
Nothing on the page calls `exchangeCodeForSession`. This alone fully explains
"forgot password is not working".

**B. Middleware bounces authenticated users off the reset page.**
`lib/supabase/middleware.ts` lists `/reset-password` + `/forgot-password` in `publicRoutes`,
then redirects any authenticated user away from public routes to `/dashboard`. Confirmed
live in Chrome: `/forgot-password` → `/dashboard`. So fixing A without B just moves the
wall — both must change together.

**C. Magic-link failures are silent.**
`app/auth/callback/route.ts` redirects failures to `/login?error=auth_callback_error`, but
`app/(auth)/login/page.tsx` only reads the `suite_error` param. The user lands back on the
login form with no message. This is why it reads as "nothing happens", and why it went
undiagnosed this long.

**D. Suite button assumes a live gateway session.**
The OAuth chain itself is configured correctly (client registered, redirect_uri matches,
consent page reachable and unprotected, `next` preserved through gateway login, grant
present). But the gateway is invite-only passwordless, so a first-time member must do an
email round-trip mid-flow, while PTP's `suite_state`/`suite_verifier`/`suite_nonce` cookies
expire after 10 minutes (`app/api/auth/suite/start/route.ts`). Exceed that and the callback
fails `invalid_request`. His gateway sign-in (08-12 03:12) never produced a link
(`gateway_sub` still NULL), consistent with an abandoned/expired first-run flow.

## Open question (needs one datum from Dennis)

Why the PKCE `code_verifier` cookie was absent at exchange time. Two candidates, neither of
which PKCE can survive:
1. He opens the emailed link on a different device/browser than the one that requested it.
2. He is using the AcquisitionPRO/GoHighLevel embed, where the `SameSite=None` verifier
   cookie is dropped as a third-party cookie. (That `SameSite=None` config in
   `lib/supabase/client.ts` exists precisely for iframe embedding — commit d0f7c02.)

Top-level cookies are fine, so this is contextual, not blanket-broken.

## Plan

- [x] 1. Add `app/auth/confirm/route.ts`: server route consuming `token_hash` + `type` via
      `verifyOtp`, then redirect to a safe `next`. Device-independent, needs no prior cookie.
- [x] 2. Point `forgot-password` and `login` (magic link) at the new route; update the
      Supabase **Recovery** and **Magic Link** email templates to `{{ .TokenHash }}`.
- [x] 3. Let `/reset-password` render for an authenticated user.
- [x] 4. Surface the callback error on the login page (`error`, not just `suite_error`).
- [x] 5. Raise the Suite cookie TTL from 10 min to 30 min.
- [x] 6. Tests + mutation checks.
- [x] 7. Verify end-to-end in production.
- [x] 8. `SameSite=None` → `Lax` (dead iframe config; David confirmed the embed is gone).

David's call on sequencing: fix first, Dennis waits. No temporary password was set.

## Review

Shipped on branch `fix/auth-email-links` (commit `4349955`, off `origin/main`), deployed to
production 2026-08-12.

**Verified live on proptracerpro.com**, not just in tests:

| Check | Result |
|---|---|
| `/auth/confirm` with no token | 307 → `/login?error=link_invalid` |
| Recovery email link | 307 → `/reset-password` + `sb-…-auth-token` cookie, `SameSite=lax` |
| `GET /reset-password` **with** that session | 200, renders "Set new password" (previously bounced to `/dashboard`) |
| Magic link email | 307 → `/dashboard` + session cookie |
| Template rendering | `{{ .RedirectTo }}` produced a well-formed link, inspected in Gmail |
| Test suite | 129 passing across 23 files; `tsc --noEmit` clean |
| Mutation checks | open-redirect guard → 1 red; middleware allowance → 2 red; `error` param read → 1 red |

Throwaway test accounts (`david+ptpauthtest…`) were deleted; zero remain. Two test emails
are sitting in David's inbox and can be deleted.

### Open follow-ups

1. **`main` does not have this fix.** Production currently runs the `fix/auth-email-links`
   branch build. Merge the branch into `main` before any future deploy, or the next
   deploy from `main` silently reverts all of it. This is the one thing that must not be
   forgotten.
2. **Dennis's password is genuinely wrong** (`last_sign_in_at` never advanced past 08-09,
   and the endpoint returns a normal `invalid_credentials`). He should use "Forgot
   password", which now works. No admin password reset needed.
3. Signup confirmation emails still use `{{ .ConfirmationURL }}` → `/auth/callback`, so a
   new user who opens the confirmation on a different device than they signed up on still
   hits the old PKCE limitation. Lower stakes (a fresh signup can simply retry), but it is
   the same class of bug and worth migrating.
4. CSP `frame-ancestors` in `lib/supabase/middleware.ts` still allowlists the GoHighLevel
   domains. Dead config now that the embed is gone; left alone to keep this diff focused.
5. `password_min_length` in Supabase is 6 while `reset-password/page.tsx` enforces 8.
   Harmless (the stricter one wins in the UI) but inconsistent.
6. Auth audit logging is empty (`auth.audit_log_entries` has 0 rows) and Vercel runtime
   logs had already rolled off, so `[suite-signin]` alerts left no trail. `alertSuite` is
   console-only by design and its own comment flags this as a prod prerequisite. Worth
   wiring to a real channel before the next auth incident.
