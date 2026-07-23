import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { resolvePtpProfile, UNLINKED_MESSAGE } from "@/lib/suite/mcp-shared";
import type { PtpProfile } from "@/lib/suite/mcp-shared";
import { chargePerTrace } from "@/lib/suite/pricing";
import { PRICING } from "@/lib/constants";
import { isLikelyBusiness } from "@/lib/ai-research/client";
import { removeBatchDuplicates } from "@/lib/utils/deduplication";

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

// ---- skip_trace_quote (free) -------------------------------------------------
export const MAX_RECORDS = 500;

export const recordSchema = z.object({
  owner_name: z.string().optional(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
});
export type TraceRecord = z.infer<typeof recordSchema>;

export const quoteSchema = z.object({ records: z.array(recordSchema).min(1) });

/** A record is an "entity" iff it carries an owner_name AND the classifier calls it a business;
 *  everything else prices as a person. Entities cost the flat $0.25 FastAppend ceiling; persons
 *  price at the grant-aware per-trace rate ($0.07 for a grant-holder, $0.11 otherwise). */
export function worstCaseCost(records: TraceRecord[], profile: PtpProfile) {
  const personRate = chargePerTrace(profile);
  let persons = 0;
  let entities = 0;
  for (const r of records) {
    if (r.owner_name && isLikelyBusiness(r.owner_name)) entities += PRICING.CHARGE_PER_FASTAPPEND_SUCCESS;
    else persons += personRate;
  }
  return { persons, entities, total: persons + entities };
}

/** Free, mandatory first step before any paid trace: dedups, splits person vs entity, and returns
 *  the worst-case cost + current wallet balance + whether the list exceeds the 500-record cap.
 *  NOTE: the live `removeBatchDuplicates` returns `{ unique, internalDuplicates }`, not the bare
 *  array the brief assumed (`(records) => records`); adapted here. `internalDuplicates` is used
 *  directly instead of re-deriving it from `records.length - unique.length`. */
export async function skipTraceQuote(admin: SupabaseClient, gatewaySub: string, raw: unknown) {
  const { records } = quoteSchema.parse(raw);
  const profile = await resolvePtpProfile(admin, gatewaySub);
  if (!profile) return UNLINKED_MESSAGE;
  const { unique, internalDuplicates } = removeBatchDuplicates(records);
  const cost = worstCaseCost(unique, profile);
  const entities = unique.filter((r) => r.owner_name && isLikelyBusiness(r.owner_name)).length;
  return {
    submitted: records.length,
    after_dedup: unique.length,
    duplicates_removed: internalDuplicates,
    persons: unique.length - entities,
    entities,
    worst_case_cost: Number(cost.total.toFixed(2)),
    wallet_balance: profile.wallet_balance,
    over_cap: unique.length > MAX_RECORDS,
    max_records_per_call: MAX_RECORDS,
  };
}
