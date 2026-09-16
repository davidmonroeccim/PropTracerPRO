import type { SupabaseClient } from "@supabase/supabase-js";
import { AI_RESEARCH, PRICING } from "@/lib/constants";

/** Rates quoted here are the TIER 1 per-successful-trace rates, which is what these MCP tools
 *  bill. Owner type selects the vendor, not the price, so there is ONE rate per plan and no entity
 *  carve-out. Read from the constants so the caveat can never drift from the ledger. Tier 2
 *  per-record pricing is deliberately absent: no MCP tool routes to it yet.
 *
 *  THE NO-MATCH SENTENCE IS A MONEY PROMISE. Claude quotes this before spending a user's wallet,
 *  so it must match lib/trace/settleBulkJob.ts and the two cron sweeps exactly. It is scoped to
 *  the case that is genuinely free: a record submitted with an INDIVIDUAL owner name that comes
 *  back empty. A record whose owner is blank or a company goes through owner research first
 *  (isEntityRecord in mcp-tools.ts), and app/api/cron/sweep-bulk-research/route.ts books that
 *  research charge the moment it finds an owner. settleBulkJob.ts then leaves that charge in place
 *  on a no_match. Do not widen this sentence back into "a record that comes back with no match is
 *  not charged". It is false. */
export const PTP_MCP_CAVEAT =
  "PropTracerPRO resolves contact info (phones, emails) from third-party data and can be incomplete or out of date. Verify before outreach, and use it only for lawful, permission-based contact. " +
  `Each successful trace costs $${PRICING.CHARGE_PER_SUCCESS.toFixed(2)} on Pro or AcquisitionPRO and $${PRICING.CHARGE_PER_SUCCESS_WALLET.toFixed(2)} on Pay-As-You-Go, drawn from your wallet. ` +
  `Give us an individual owner's name and a trace that finds nothing is not charged. When the owner is blank or a company, we research the owner first, and that research step costs $${AI_RESEARCH.CHARGE_PER_RECORD.toFixed(2)} once we identify them, even if no contacts follow.`;

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

export type PtpProfile = {
  id: string;
  subscription_tier: string | null;
  is_acquisition_pro_member: boolean | null;
  gateway_products: string[] | null;
  wallet_balance: number;
};

/** Map a verified gateway `sub` to the LOCAL PTP user_profiles row (the spend key + wallet). Returns
 *  null ONLY on a genuine no-row result (error null, data null) — the gateway user has never
 *  completed Suite sign-in on PTP, so no local row carries the sub. A real DB/network error is
 *  thrown, not swallowed into null: every money tool goes through this choke point, and returning
 *  null on a real error would misreport a genuinely-linked user as unlinked and hide the failure.
 *  A pure read (no side effects), unlike lib/suite/link.ts resolveSuiteUser which may create/link. */
export async function resolvePtpProfile(
  admin: SupabaseClient,
  gatewaySub: string,
): Promise<PtpProfile | null> {
  const { data, error } = await admin
    .from("user_profiles")
    .select("id, subscription_tier, is_acquisition_pro_member, gateway_products, wallet_balance")
    .eq("gateway_sub", gatewaySub)
    .maybeSingle();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  return (data as PtpProfile | null) ?? null;
}

/** Standard "no wallet yet" payload for an unlinked gateway user. */
export const UNLINKED_MESSAGE = {
  error: "not_linked",
  message:
    "Sign into PropTracerPRO once through the gateway to set up your wallet, then retry. (Your gateway account is not yet linked to a PropTracerPRO account.)",
} as const;
