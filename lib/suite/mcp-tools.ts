import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { resolvePtpProfile, UNLINKED_MESSAGE } from "@/lib/suite/mcp-shared";

// ---- wallet_balance ---------------------------------------------------------
export async function walletBalance(admin: SupabaseClient, gatewaySub: string) {
  const profile = await resolvePtpProfile(admin, gatewaySub);
  if (!profile) return UNLINKED_MESSAGE;
  // Today's MCP-attributed spend (source tag added in Task 4); best-effort, 0 if the column/rows absent.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data: todays } = await admin
    .from("trace_history")
    .select("charge")
    .eq("user_id", profile.id)
    .eq("source", "mcp")
    .gte("created_at", since.toISOString());
  const mcpSpendToday = (todays ?? []).reduce(
    (sum: number, r: { charge: number | null }) => sum + (r.charge ?? 0),
    0,
  );
  return { wallet_balance: profile.wallet_balance, mcp_spend_today: mcpSpendToday };
}

// ---- list_traces ------------------------------------------------------------
export const listTracesSchema = z.object({
  limit: z.number().int().optional(),
  since: z.string().optional(), // ISO date; optional lower bound on created_at
});

export async function listTraces(admin: SupabaseClient, gatewaySub: string, raw: unknown) {
  const args = listTracesSchema.parse(raw);
  const profile = await resolvePtpProfile(admin, gatewaySub);
  if (!profile) return UNLINKED_MESSAGE;
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
  let q = admin
    .from("trace_history")
    .select(
      "id, normalized_address, city, state, zip, input_owner_name, status, is_successful, phone_count, email_count, charge, created_at",
    )
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (args.since) q = q.gte("created_at", args.since);
  const { data, error } = await q;
  if (error) throw new Error(`list_traces failed: ${error.message}`);
  return { traces: data ?? [] };
}
