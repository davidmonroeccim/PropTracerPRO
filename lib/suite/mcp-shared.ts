import type { SupabaseClient } from "@supabase/supabase-js";
import { PRICING } from "@/lib/constants";

/** TWO BILLING MODELS ARE QUOTED HERE, AND NEITHER SENTENCE MAY BE READ AS THE OTHER.
 *
 *  Tier 1 is a record that arrives WITH the owner of record: charged per successful trace, free on
 *  a miss. Owner type selects the vendor, not the price, so there is ONE tier 1 rate per plan and
 *  no entity carve-out. Tier 2 is a record that arrives with NO owner name: it runs a Full Property
 *  Trace and is charged per RECORD SUBMITTED, so a miss is billed.
 *
 *  BOTH plan rates are named on both models, never one of them: quoting a single figure is how a
 *  Pay-As-You-Go caller gets told a Pro price. All four are read from the constants so the caveat
 *  can never drift from the ledger.
 *
 *  THE NO-MATCH SENTENCE IS A MONEY PROMISE. Claude quotes this before spending a user's wallet,
 *  so it must match lib/trace/settleBulkJob.ts, app/api/cron/sweep-property-traces and the two
 *  cron sweeps exactly.
 *
 *  WHAT CHANGED ON 2026-09-18, and why the old shape was dangerous. This block used to say that a
 *  record with no owner name "is not traced on this surface yet, so it comes back skipped with a
 *  reason and costs nothing", and its own header said tier 2 pricing was deliberately absent
 *  because nothing routed to it. Phase 5c-3A wired skip_trace_bulk's blank-owner bucket straight
 *  onto the tier 2 queue. Both statements became false in the same commit, and the failure mode was
 *  the worst available: Claude quoting "costs nothing" to a user immediately before spending their
 *  wallet on exactly those records.
 *
 *  Do not collapse the two models back into one sentence, and do not add a research fee to either:
 *  the $0.15 AI research step was retired on 2026-09-17 and nothing books it. */
export const PTP_MCP_CAVEAT =
  "PropTracerPRO resolves contact info (phones, emails) from third-party data and can be incomplete or out of date. Verify before outreach, and use it only for lawful, permission-based contact. " +
  `Give us the owner of record and you are charged per successful trace, $${PRICING.CHARGE_PER_SUCCESS.toFixed(2)} on Pro or AcquisitionPRO and $${PRICING.CHARGE_PER_SUCCESS_WALLET.toFixed(2)} on Pay-As-You-Go, drawn from your wallet, and a trace that finds nothing is free whether the owner is a person or a company. ` +
  `A record with no owner name runs a full property trace instead, which looks up the county record to find the owner and then goes after their contacts. That one is charged for every record you send, $${PRICING.TIER2_PER_RECORD_SUBMITTED_PRO.toFixed(2)} on Pro or AcquisitionPRO and $${PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET.toFixed(2)} on Pay-As-You-Go, so those records cost the same whether or not contacts come back.`;

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
