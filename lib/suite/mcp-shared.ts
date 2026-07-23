export const PTP_MCP_CAVEAT =
  "PropTracerPRO resolves contact info (phones, emails) from third-party data and can be incomplete or out of date. Verify before outreach, and use it only for lawful, permission-based contact. Each successful person trace costs $0.07 and each successful entity trace up to $0.25, drawn from your wallet.";

type Extra = { authInfo?: { scopes: string[]; extra?: { userId?: string } } };

/** Resolve the authenticated caller from the MCP tool `extra`. */
export function ctx(extra: Extra): { userId: string; products: string[] } {
  const userId = extra.authInfo?.extra?.userId;
  if (!userId) throw new Error("Not authenticated.");
  return { userId, products: extra.authInfo?.scopes ?? [] };
}

/** Gate: every PTP tool must hold the prop-tracer-pro grant. Deleting the throw is a security
 *  regression and is fenced by mcp-shared.test.ts. */
export function assertPtpAccess(scopes: string[]): void {
  if (!scopes.includes("prop-tracer-pro")) {
    throw new Error("Your account does not include PropTracerPRO. Contact David to get access.");
  }
}

export function ok(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: `${JSON.stringify(payload, null, 2)}\n\n${PTP_MCP_CAVEAT}` },
    ],
  };
}

export function err(e: unknown) {
  const message = e instanceof Error ? e.message : "Unexpected error.";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}
