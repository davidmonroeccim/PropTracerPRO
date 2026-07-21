/**
 * Suite sign-in: PropTracerPRO federates identity to the Suite Gateway's Supabase (an OIDC
 * provider). This is NOT an enterprise "bring your own IdP" feature — different thing.
 */

/** PTP's product name in the gateway's grants table (confirmed against the gateway PRODUCTS list). */
export const SUITE_PRODUCT = "prop-tracer-pro";

/** Feature flag. Rollback is flipping this to anything but "true". */
export function isSuiteSignInEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED === "true";
}

export interface SuiteConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  gatewayApiKey: string;
  gatewayUrl: string;
  redirectUri: string;
}

/** Server-only. Throws if misconfigured so a broken deploy fails loudly, not silently. */
export function suiteConfig(): SuiteConfig {
  const required = {
    issuer: process.env.SUITE_ISSUER,
    clientId: process.env.SUITE_CLIENT_ID,
    clientSecret: process.env.SUITE_CLIENT_SECRET,
    gatewayApiKey: process.env.SUITE_GATEWAY_API_KEY,
    gatewayUrl: process.env.SUITE_GATEWAY_URL,
    redirectUri: process.env.SUITE_REDIRECT_URI,
  };
  for (const [k, v] of Object.entries(required)) {
    if (!v) throw new Error(`Suite sign-in is misconfigured: ${k} is not set.`);
  }
  return required as SuiteConfig;
}
