import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { suiteConfig } from "./config";
import type { SuiteIdentity } from "./link";

/** Exchange the authorization code for tokens. Returns the raw id_token. */
export async function exchangeCode(code: string, verifier: string): Promise<string> {
  const { issuer, clientId, clientSecret, redirectUri } = suiteConfig();
  const res = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Suite sign-in: token exchange failed (${res.status}).`);
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("Suite sign-in: the gateway returned no ID token.");
  return tokens.id_token;
}

/**
 * Mint a GENUINE local Supabase session for an EXISTING PTP user. Resolves the address from
 * auth.users BY ID, so the only email ever passed to generateLink is one an account already has —
 * making "conjure a new account from a stale claim email" structurally impossible (the stranding bug).
 * generateLink is verified side-effect-free (Phase 0 T2).
 */
export async function mintLocalSession(identity: SuiteIdentity): Promise<void> {
  const admin = createAdminClient();
  const { data: found, error: lookupError } = await admin.auth.admin.getUserById(identity.userId);
  const email = found?.user?.email;
  if (lookupError || !email) {
    throw new Error("Suite sign-in: could not establish your PropTracerPRO session.");
  }
  if (email !== identity.email) {
    console.warn("[suite-signin] user_profiles.email diverges from auth.users.email; minted by id.", {
      userId: identity.userId,
    });
  }
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) {
    throw new Error("Suite sign-in: could not establish your PropTracerPRO session.");
  }
  const supabase = await createClient();
  const { error: otpError } = await supabase.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: "magiclink",
  });
  if (otpError) throw new Error("Suite sign-in: could not establish your PropTracerPRO session.");
}
