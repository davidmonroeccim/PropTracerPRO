import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { suiteConfig } from "./config";

export interface SuiteClaims {
  sub: string;
  email: string;
  /** Reported, not enforced here. link.ts's decideLink refuses on false. */
  emailVerified: boolean;
}

let cachedJwks: JWTVerifyGetKey | undefined;
function jwks(): JWTVerifyGetKey {
  const { issuer } = suiteConfig();
  cachedJwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return cachedJwks;
}

/** Verify a gateway ID token: signature (JWKS), iss, aud, exp, ES256 allowlist, nonce. */
export async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
  keyResolver: JWTVerifyGetKey = jwks(),
): Promise<SuiteClaims> {
  const { issuer, clientId } = suiteConfig();

  const { payload } = await jwtVerify(idToken, keyResolver, {
    issuer,
    audience: clientId,
    algorithms: ["ES256"],
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error("Suite sign-in: nonce mismatch. The sign-in request could not be verified.");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Suite sign-in: the ID token has no subject.");
  }
  if (typeof payload.email !== "string" || !payload.email) {
    throw new Error("Suite sign-in: the ID token has no email.");
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
  };
}
