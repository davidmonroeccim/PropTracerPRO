import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { resolvePtpProfile, UNLINKED_MESSAGE } from "@/lib/suite/mcp-shared";
import type { PtpProfile } from "@/lib/suite/mcp-shared";
import { chargePerTrace } from "@/lib/suite/pricing";
import { PRICING } from "@/lib/constants";
import { isLikelyBusiness } from "@/lib/ai-research/client";
import { resolveOwnerContact } from "@/lib/ai-research/contacts";
import { removeBatchDuplicates, checkDuplicates } from "@/lib/utils/deduplication";
import {
  validateAddressInput,
  normalizeAddress,
  createAddressHash,
} from "@/lib/utils/address-normalizer";
import { submitBulkTrace } from "@/lib/tracerfy/client";
import { settleBulkJob, type TraceHistoryRow } from "@/lib/trace/settleBulkJob";
import type { AddressInput, TraceJob, TraceResult, AIResearchResult } from "@/types";

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
  // trace_result + ai_research are selected ONLY to derive owner_contact_name below; they are
  // not echoed back. Without them this tool returned input_owner_name (the COMPANY) plus bare
  // phone/email COUNTS, so a caller reviewing past traces could not see who was actually found.
  let q = admin
    .from("trace_history")
    .select(
      "id, normalized_address, city, state, zip, input_owner_name, status, is_successful, phone_count, email_count, charge, created_at, trace_result, ai_research",
    )
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (args.since) q = q.gte("created_at", args.since);
  const { data, error } = await q;
  if (error) throw new Error(`list_traces failed: ${error.message}`);
  const traces = (data ?? []).map((row) => {
    const { trace_result, ai_research, ...rest } = row as Record<string, unknown> & {
      trace_result: TraceResult | null;
      ai_research: AIResearchResult | null;
    };
    return { ...rest, ...resolveOwnerContact({ trace_result, ai_research }) };
  });
  return { traces };
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

/** SINGLE SOURCE OF TRUTH for the person/entity split (closes ledger M7). A record is an ENTITY
 *  when it has no usable owner_name (empty/whitespace/absent) OR the classifier calls that name a
 *  business. This is the EXACT negation of skipTraceBulk's person condition
 *  (`owner && !isLikelyBusiness(owner)`, where `owner = (owner_name || "").trim()`), so the
 *  worst-case wallet gate and the submit split can NEVER disagree on how a record is priced vs
 *  routed. Entities settle via FastAppend at the flat $0.25 ceiling; persons settle at the
 *  grant-aware per-trace rate ($0.07 for a grant-holder, $0.11 otherwise). An address-only record
 *  with no owner_name is an ENTITY (it routes to FastAppend), so the gate reserves $0.25 for it. */
export function isEntityRecord(owner_name?: string): boolean {
  const owner = (owner_name || "").trim();
  return !owner || isLikelyBusiness(owner);
}

/** Worst-case pre-flight cost. Prices each record via the shared isEntityRecord classifier so the
 *  gate reserves exactly what the submit split will queue. */
export function worstCaseCost(records: TraceRecord[], profile: PtpProfile) {
  const personRate = chargePerTrace(profile);
  let persons = 0;
  let entities = 0;
  for (const r of records) {
    if (isEntityRecord(r.owner_name)) entities += PRICING.CHARGE_PER_FASTAPPEND_SUCCESS;
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
  const entities = unique.filter((r) => isEntityRecord(r.owner_name)).length;
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

// ---- skip_trace_bulk (guarded submit) ---------------------------------------
//
// SUBMITS a bulk skip-trace job. It moves NO money itself: the wallet gate here
// is a worst-case pre-flight only. Real spend happens later, at poll time, in
// bulk_status -> settleBulkJob. The submit orchestration mirrors the live
// app/api/v1/trace/bulk/route.ts (the source of truth) with exactly three
// deliberate differences: the source:'mcp' tag, the stricter worstCaseCost gate
// (entities at the $0.25 FastAppend ceiling), and the confirm + MAX_RECORDS
// guards. Everything else (dedup, person/entity split, insert shapes, person
// CSV, submitBulkTrace, entity queueing for the sweep-bulk-research cron) is the
// route's behavior, reused.

export const bulkSchema = z.object({
  records: z.array(recordSchema).min(1),
  confirm: z.boolean().optional(),
});

const BULK_BATCH_SIZE = 500;

export async function skipTraceBulk(admin: SupabaseClient, gatewaySub: string, raw: unknown) {
  const { records, confirm } = bulkSchema.parse(raw);
  const profile = await resolvePtpProfile(admin, gatewaySub);
  if (!profile) return UNLINKED_MESSAGE;

  // Guard 1 (confirm gate): never submit or spend without an explicit confirm.
  if (confirm !== true) {
    return {
      error: "confirm_required",
      message: "Run skip_trace_quote first, then call again with confirm: true.",
    };
  }

  // Guard 2 (cap): the MCP caps a single call at MAX_RECORDS (500).
  if (records.length > MAX_RECORDS) {
    return {
      error: "over_cap",
      message: `Split into batches of at most ${MAX_RECORDS} records.`,
      max_records_per_call: MAX_RECORDS,
    };
  }

  // Dedup: internal batch dupes, then the 90-day history window. Reuses the
  // exact primitives the v1 route uses (checkDuplicates runs its own
  // cookie-scoped server client, same as the route's API-key context).
  const { unique } = removeBatchDuplicates(records);
  const { newRecords } = await checkDuplicates(profile.id, unique);
  const duplicatesRemoved = records.length - newRecords.length;

  if (newRecords.length === 0) {
    return {
      job_id: null,
      accepted: 0,
      duplicates_removed: duplicatesRemoved,
      message: "All records are duplicates of previous traces.",
    };
  }

  // Split person vs entity through the SHARED isEntityRecord classifier -- the same
  // single source of truth worstCaseCost prices with, so the gate can never
  // under-reserve. A person (non-empty owner_name the classifier does NOT call a
  // business) goes straight to Tracerfy; everything else (empty/absent owner OR a
  // business name) queues for AI research / FastAppend.
  const personRecords: AddressInput[] = [];
  const entityRecords: AddressInput[] = [];
  for (const record of newRecords) {
    if (isEntityRecord(record.owner_name)) entityRecords.push(record);
    else personRecords.push(record);
  }

  // Guard 3 (money fence): worst-case pre-flight. Stricter than the v1 route --
  // entities are priced at the $0.25 FastAppend ceiling (not the route's $0.11
  // trace + $0.15 research split) and the person rate is grant-aware. Nothing is
  // submitted or charged when the wallet cannot cover the worst case.
  const worst = worstCaseCost(newRecords, profile).total;
  if (profile.wallet_balance < worst) {
    return {
      error: "insufficient_balance",
      worst_case_cost: Number(worst.toFixed(2)),
      wallet_balance: profile.wallet_balance,
      message: `Add funds: this batch could cost up to $${worst.toFixed(2)} but your wallet holds $${profile.wallet_balance.toFixed(2)}.`,
    };
  }

  // Structured validation (mirrors the v1 route): reject the whole batch if any
  // record is malformed rather than submit a partial/opaque batch. Placed after
  // the worst-case gate so the pre-flight ordering above stays the primary gate.
  const invalidRecords: { index: number; error: string }[] = [];
  newRecords.forEach((r, i) => {
    const v = validateAddressInput(r.address, r.city, r.state, r.zip);
    if (!v.valid) invalidRecords.push({ index: i, error: v.error || "invalid record" });
  });
  if (invalidRecords.length > 0) {
    return {
      error: "invalid_records",
      invalid_records: invalidRecords,
      message: `${invalidRecords.length} of ${newRecords.length} records failed validation.`,
    };
  }

  // Create the trace_jobs row, tagged source:'mcp'.
  const { data: jobRow, error: jobError } = await admin
    .from("trace_jobs")
    .insert({
      user_id: profile.id,
      file_name: "MCP bulk submit",
      total_records: records.length,
      dedupe_removed: duplicatesRemoved,
      records_submitted: newRecords.length,
      records_matched: 0,
      status: "processing",
      source: "mcp",
    })
    .select()
    .single();

  const job = jobRow as { id: string } | null;
  if (jobError || !job) {
    return { error: "job_create_failed", message: jobError?.message || "Failed to create trace job." };
  }

  // Per-record pending trace_history row, tagged source:'mcp' and linked to the
  // bulk job via trace_job_id so bulk_status + the cron aggregate per-record.
  const buildHistoryRow = (record: AddressInput, aiResearchStatus: string | null) => {
    const normalizedAddress = normalizeAddress(record.address, record.city, record.state, record.zip);
    return {
      user_id: profile.id,
      trace_job_id: job.id,
      address_hash: createAddressHash(normalizedAddress),
      normalized_address: normalizedAddress,
      city: record.city.toUpperCase(),
      state: record.state.toUpperCase(),
      zip: (record.zip || "").substring(0, 5),
      input_owner_name: record.owner_name || null,
      ai_research_status: aiResearchStatus,
      status: "processing" as const,
      source: "mcp",
    };
  };

  // Entity rows first, ai_research_status:'queued' so the existing
  // sweep-bulk-research cron picks them up unchanged as soon as we return.
  if (entityRecords.length > 0) {
    const entityRows = entityRecords.map((r) => buildHistoryRow(r, "queued"));
    for (let i = 0; i < entityRows.length; i += BULK_BATCH_SIZE) {
      await admin
        .from("trace_history")
        .upsert(entityRows.slice(i, i + BULK_BATCH_SIZE), { onConflict: "user_id,address_hash" });
    }
  }

  // Person rows -> single bulk Tracerfy CSV (fast path), built exactly as the
  // route builds it.
  let tracerfyBulkJobId: string | null = null;
  if (personRecords.length > 0) {
    const esc = (v: string) => `"${(v || "").replace(/"/g, '""')}"`;
    const csvLines = ["address,city,state,first_name,last_name,mail_address,mail_city,mail_state"];
    for (const record of personRecords) {
      const parts = (record.owner_name || "").trim().split(" ");
      const firstName = parts[0] || "";
      const lastName = parts.slice(1).join(" ") || "";
      const mailAddress = record.mailing_address || record.address;
      csvLines.push(
        `${esc(record.address)},${esc(record.city)},${esc(record.state)},${esc(firstName)},${esc(lastName)},${esc(mailAddress)},${esc(record.city)},${esc(record.state)}`,
      );
    }
    const submitResult = await submitBulkTrace(csvLines.join("\n"));

    if (!submitResult.success || !submitResult.jobId) {
      // Bulk submit failed: mark the person rows as error. Entity rows (if any)
      // stay queued -- the cron still processes them.
      const errorRows = personRecords.map((r) => ({ ...buildHistoryRow(r, null), status: "error" as const }));
      for (let i = 0; i < errorRows.length; i += BULK_BATCH_SIZE) {
        await admin
          .from("trace_history")
          .upsert(errorRows.slice(i, i + BULK_BATCH_SIZE), { onConflict: "user_id,address_hash" });
      }
      if (entityRecords.length === 0) {
        await admin
          .from("trace_jobs")
          .update({ status: "failed", error_message: submitResult.error || "Submit failed" })
          .eq("id", job.id);
        return { error: "submit_failed", message: submitResult.error || "Failed to submit bulk trace." };
      }
    } else {
      tracerfyBulkJobId = submitResult.jobId;
      await admin.from("trace_jobs").update({ tracerfy_job_id: tracerfyBulkJobId }).eq("id", job.id);
      const personRows = personRecords.map((r) => ({
        ...buildHistoryRow(r, null),
        tracerfy_job_id: tracerfyBulkJobId,
      }));
      for (let i = 0; i < personRows.length; i += BULK_BATCH_SIZE) {
        await admin
          .from("trace_history")
          .upsert(personRows.slice(i, i + BULK_BATCH_SIZE), { onConflict: "user_id,address_hash" });
      }
    }
  }

  return {
    job_id: job.id,
    accepted: newRecords.length,
    persons: personRecords.length,
    entities: entityRecords.length,
    committed_worst_case: Number(worst.toFixed(2)),
  };
}

// ---- bulk_status (shared settlement) ----------------------------------------
//
// POLLS a bulk job and SETTLES it. This is where money actually moves, via the
// shared settleBulkJob from Task 4 -- the SAME code path the v1 REST route uses,
// so the two surfaces can never diverge on money. The one MCP-specific value is
// the grant-aware person rate: chargePerTrace(profile) ($0.07 for a grant
// holder), deliberately different from the v1 route's non-grant getChargePerTrace.
// The ownership fence below is the money-safety boundary: a caller can only ever
// settle their OWN job.

export const bulkStatusSchema = z.object({ job_id: z.string() });

/** Per-record payload, matching the v1 bulk/status route's buildPerRecordResult.
 *
 *  owner_contact_name is the RESOLVED HUMAN behind input_owner_name (which is the entity that
 *  was asked about). It is surfaced at the top level, next to the entity it belongs to, because
 *  the person previously appeared only as `result.owner_name` / `contacts.owner_name` -- keys
 *  that collide semantically with `input_owner_name` and `research.owner_name` (both the
 *  COMPANY). Consumers matched the company they already had and dropped the person; the
 *  2026-08-13 Dallas run lost all 45 resolved people that way. Null when no human was
 *  resolved -- never the company name. */
function buildPerRecordResult(row: TraceHistoryRow) {
  const { owner_contact_name, owner_contact_source } = resolveOwnerContact(row);
  return {
    address: row.normalized_address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    status: row.status,
    input_owner_name: row.input_owner_name,
    owner_contact_name,
    owner_contact_source,
    result: row.trace_result,
    research: row.ai_research,
    contacts: row.ai_research?.business_trace_contacts || null,
    charge: row.charge || 0,
    ai_research_charge: row.ai_research_charge || 0,
  };
}

export async function bulkStatus(admin: SupabaseClient, gatewaySub: string, raw: unknown) {
  const { job_id } = bulkStatusSchema.parse(raw);
  const profile = await resolvePtpProfile(admin, gatewaySub);
  if (!profile) return UNLINKED_MESSAGE;

  // Load the job.
  const { data: jobData } = await admin.from("trace_jobs").select("*").eq("id", job_id).maybeSingle();
  const job = jobData as TraceJob | null;
  if (!job) return { error: "not_found" };

  // OWNERSHIP FENCE (money-safety, critical): a caller can only poll/settle their
  // OWN job. Without this a caller could settle another user's job and move that
  // user's wallet. No settlement / wallet RPC runs for a non-owner.
  if (job.user_id !== profile.id) return { error: "forbidden" };

  // Grant-aware person rate -- this is the intentional MCP/v1 difference.
  const personRate = chargePerTrace(profile);

  // Pull this job's trace_history rows.
  const { data: rowsRaw } = await admin
    .from("trace_history")
    .select("*")
    .eq("user_id", profile.id)
    .eq("trace_job_id", job.id);
  const rows = (rowsRaw || []) as TraceHistoryRow[];

  // Already finalized: emit the stored summary + per-record details.
  if (job.status === "completed" || job.status === "failed") {
    return {
      status: job.status,
      job_id: job.id,
      records_submitted: job.records_submitted,
      records_matched: job.records_matched,
      total_charge: Number(((job.records_matched || 0) * personRate).toFixed(4)),
      error_message: job.error_message ?? null,
      results: rows.map(buildPerRecordResult),
    };
  }

  // Settle each unresolved Tracerfy job through the ONE shared money path.
  // settleBulkJob mutates the bucket rows in place (same as the v1 route), so the
  // completion check below stays accurate.
  const unresolvedByJobId = new Map<string, TraceHistoryRow[]>();
  for (const row of rows) {
    if (row.status !== "processing" || !row.tracerfy_job_id) continue;
    const bucket = unresolvedByJobId.get(row.tracerfy_job_id) || [];
    bucket.push(row);
    unresolvedByJobId.set(row.tracerfy_job_id, bucket);
  }
  for (const [tracerfyJobId, bucketRows] of unresolvedByJobId) {
    await settleBulkJob(admin, { tracerfyJobId, bucketRows, userId: profile.id, personRate });
  }

  // Still in flight while any row awaits research or its Tracerfy result.
  const isPendingResearch = (r: TraceHistoryRow) =>
    r.ai_research_status === "queued" || r.ai_research_status === "processing";
  const anyPendingResearch = rows.some(isPendingResearch);
  const anyPendingTrace = rows.some((r) => r.status === "processing");
  if (anyPendingResearch || anyPendingTrace) {
    return {
      status: "processing",
      job_id: job.id,
      records_submitted: job.records_submitted,
      records_pending_research: rows.filter(isPendingResearch).length,
      records_pending_trace: rows.filter((r) => r.status === "processing").length,
    };
  }

  // Finalize.
  const recordsMatched = rows.filter((r) => r.is_successful).length;
  const totalCharge = rows.reduce((sum, r) => sum + (r.charge || 0), 0);
  await admin
    .from("trace_jobs")
    .update({ status: "completed", records_matched: recordsMatched, completed_at: new Date().toISOString() })
    .eq("id", job.id);

  return {
    status: "completed",
    job_id: job.id,
    records_submitted: job.records_submitted,
    records_matched: recordsMatched,
    total_charge: Number(totalCharge.toFixed(4)),
    results: rows.map(buildPerRecordResult),
  };
}
