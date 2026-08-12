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

- [ ] 0. Unblock Dennis today (needs David's go — see below)
- [ ] 1. Add `app/auth/confirm/route.ts`: server route consuming `token_hash` + `type` via
      `verifyOtp`, then redirect to a safe `next`. Device-independent, needs no prior cookie.
      Matches what suite-gateway already does — same pattern, sibling app.
- [ ] 2. Point `forgot-password` and `login` (magic link) at the new route; update the
      Supabase **Recovery** and **Magic Link** email templates to `{{ .TokenHash }}`.
- [ ] 3. Let `/reset-password` render for an authenticated user (exempt it from the
      middleware's authenticated-user redirect) so the reset form is reachable.
- [ ] 4. Surface the callback error on the login page (render `error`, not just `suite_error`).
- [ ] 5. Raise the Suite cookie TTL from 10 min to ~30 min so a first-run email round-trip
      fits inside it.
- [ ] 6. Tests: reset-password with a `token_hash` sets a session and updates the password;
      login page renders `error=auth_callback_error`; middleware allows an authenticated
      user onto `/reset-password`. Mutation-check each (delete the fix, watch it go red).
- [ ] 7. Verify on Preview end-to-end, then ship and have Dennis confirm.

### Unblock options for step 0
- **(a) Admin-set a temporary password** and have him sign in with password at
  `proptracerpro.com` in a normal tab, then change it. No deploy needed, works today.
  Requires David's approval — it modifies a client's credentials.
- **(b) Ship the fixes first** (a few hours), then have him retry a reset link.

## Review

(to be filled in after implementation)
