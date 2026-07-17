import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { verifyIdToken } from "@/lib/suite/verify";

const ISSUER = "https://gw.example/auth/v1";
const CLIENT = "ptp-client";

beforeEach(() => {
  Object.assign(process.env, {
    SUITE_ISSUER: ISSUER,
    SUITE_CLIENT_ID: CLIENT,
    SUITE_CLIENT_SECRET: "s",
    SUITE_GATEWAY_API_KEY: "k",
    SUITE_GATEWAY_URL: "u",
    SUITE_REDIRECT_URI: "r",
  });
});
afterEach(() => vi.restoreAllMocks());

async function make(alg: string, claims: Record<string, unknown>) {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  const jwt = await new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setIssuer(ISSUER)
    .setAudience(CLIENT)
    .setExpirationTime("5m")
    .sign(privateKey);
  const jwk = await exportJWK(publicKey);
  const resolver = async () => ({ ...jwk, alg }) as never;
  return { jwt, resolver };
}

test("accepts a valid ES256 token and lowercases email", async () => {
  const { jwt, resolver } = await make("ES256", {
    sub: "S1",
    email: "Alice@Corp.com",
    email_verified: true,
    nonce: "N",
  });
  await expect(verifyIdToken(jwt, "N", resolver)).resolves.toEqual({
    sub: "S1",
    email: "alice@corp.com",
    emailVerified: true,
  });
});

test("rejects a non-ES256 algorithm (alg-substitution defense)", async () => {
  const { jwt, resolver } = await make("RS256", {
    sub: "S1",
    email: "a@c.com",
    email_verified: true,
    nonce: "N",
  });
  await expect(verifyIdToken(jwt, "N", resolver)).rejects.toThrow();
});

test("rejects on nonce mismatch", async () => {
  const { jwt, resolver } = await make("ES256", {
    sub: "S1",
    email: "a@c.com",
    email_verified: true,
    nonce: "N",
  });
  await expect(verifyIdToken(jwt, "WRONG", resolver)).rejects.toThrow(/nonce/);
});

test("reports emailVerified=false when the claim is not exactly true", async () => {
  const { jwt, resolver } = await make("ES256", {
    sub: "S1",
    email: "a@c.com",
    email_verified: "true",
    nonce: "N",
  });
  const claims = await verifyIdToken(jwt, "N", resolver);
  expect(claims.emailVerified).toBe(false);
});
