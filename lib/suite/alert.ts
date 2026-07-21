/**
 * PTP has no Sentry. This is the structured alert channel the suite modules call on every refusal,
 * operational failure, or self-heal (one tagged console.error, greppable in Vercel logs).
 *
 * PROD-ENABLE PREREQUISITE: wire to a real channel before flipping the flag on in production.
 * context carries opaque ids only (gateway sub, user id, error code) — never email/token/secret.
 */
export function alertSuite(kind: string, reason: string, context: Record<string, string> = {}): void {
  console.error("[suite-signin][ALERT]", { kind, reason, ...context });
}
