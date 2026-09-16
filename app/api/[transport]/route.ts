import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyToken } from "@/lib/suite/mcp-auth";
import { assertPtpAccess, ctx, ok, err } from "@/lib/suite/mcp-shared";
import { AI_RESEARCH, PRICING } from "@/lib/constants";
import {
  walletBalance,
  listTraces, listTracesSchema,
  skipTraceQuote, quoteSchema,
  skipTraceBulk, bulkSchema,
  bulkStatus, bulkStatusSchema,
} from "@/lib/suite/mcp-tools";

type Extra = { authInfo?: { scopes: string[]; extra?: { userId?: string } } };

/** Wrap a tool: gate on the prop-tracer-pro grant, then run it with a service-role client and the
 *  caller's gateway sub (for profile/wallet resolution). Shapes output; never leaks a stack. */
function tool(fn: (admin: ReturnType<typeof createAdminClient>, gatewaySub: string, args: unknown) => Promise<unknown>) {
  return async (args: unknown, extra: Extra) => {
    try {
      const { userId, products } = ctx(extra);
      assertPtpAccess(products);
      return ok(await fn(createAdminClient(), userId, args));
    } catch (e) {
      return err(e);
    }
  };
}

/** The TIER 1 per-successful-trace rates these tools actually bill, read from PRICING so a tool
 *  description can never drift from the ledger. Claude quotes these to the user BEFORE spending
 *  their wallet, so a stale number here buys a wrong promise with real money. ONE rate per plan:
 *  owner type selects the vendor, never the price, so there is no entity carve-out to quote. Tier
 *  2 per-record pricing is deliberately absent: no MCP tool routes to it yet. */
const TIER_1_RATES =
  `$${PRICING.CHARGE_PER_SUCCESS.toFixed(2)} per successful trace on Pro or AcquisitionPRO and ` +
  `$${PRICING.CHARGE_PER_SUCCESS_WALLET.toFixed(2)} on Pay-As-You-Go`;

/** The no-match promise, scoped to what is ACTUALLY free. Verified against
 *  lib/trace/settleBulkJob.ts and app/api/cron/sweep-bulk-research/route.ts: a record whose owner
 *  is blank or a company is researched first, and that research fee is booked as soon as an owner
 *  is identified, whether or not contacts follow. Never restore the blanket "a record that comes
 *  back with no match is not charged". */
const NO_MATCH_TERMS =
  `Give us an individual owner's name and a trace that finds nothing is not charged. When the ` +
  `owner is blank or a company, we research the owner first, and that research step costs ` +
  `$${AI_RESEARCH.CHARGE_PER_RECORD.toFixed(2)} once we identify them, even if no contacts follow.`;

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "skip_trace_quote",
      `Free cost estimate for a skip-trace list. Give records (owner_name, address, city, state, zip). Returns the dedup count, how many are people vs entities, the worst-case cost (${TIER_1_RATES}), your current wallet balance, and whether the list exceeds the 500-per-call cap. ${NO_MATCH_TERMS} Always call this first and show the cost to the user before skip_trace_bulk.`,
      quoteSchema.shape,
      tool((admin, sub, args) => skipTraceQuote(admin, sub, args)),
    );
    server.tool(
      "skip_trace_bulk",
      `Skip-trace a list of owners to resolve the CONTACT PERSON (a named human) plus their phones and emails, drawn from the user's PropTracerPRO wallet. When the owner is a company, LLC or trust, this resolves the individual behind it, so the result is a person's name and not the company you passed in. Up to 500 records per call (use one record for a single owner). Requires confirm: true, so quote and confirm the cost with the user first. Traces are charged on success: ${TIER_1_RATES}. ${NO_MATCH_TERMS} Returns a job_id; poll bulk_status for results.`,
      bulkSchema.shape,
      tool((admin, sub, args) => skipTraceBulk(admin, sub, args)),
    );
    server.tool(
      "bulk_status",
      "Retrieve the results of a skip_trace_bulk job by job_id. Each record returns owner_contact_name (the resolved human, which is the point of the trace) with owner_contact_source showing where it came from, alongside input_owner_name (the company or person you asked about), phones and emails. owner_contact_name and input_owner_name are DIFFERENT fields: report the former as the contact person and never substitute the company name for it. It is null when no human was resolved; leave the field empty in that case. Successful matches settle their per-trace charge to the wallet as they land.",
      bulkStatusSchema.shape,
      tool((admin, sub, args) => bulkStatus(admin, sub, args)),
    );
    server.tool(
      "wallet_balance",
      "The caller's current PropTracerPRO wallet balance and how much they have spent through this MCP today.",
      {},
      tool((admin, sub) => walletBalance(admin, sub)),
    );
    server.tool(
      "list_traces",
      "List the caller's own past skip-traces (results already paid for), most recent first, including each trace's resolved owner_contact_name. Use to reuse prior contacts without tracing again.",
      listTracesSchema.shape,
      tool((admin, sub, args) => listTraces(admin, sub, args)),
    );
  },
  {},
  { basePath: "/api" },
);

const authed = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

// Ship dormant: 404 until SUITE_MCP_ENABLED=true (Track A discipline).
function gate<T extends (req: Request) => Promise<Response>>(h: T) {
  return async (req: Request): Promise<Response> => {
    if (process.env.SUITE_MCP_ENABLED !== "true") {
      return NextResponse.json({ error: "PropTracerPRO MCP is not enabled." }, { status: 404 });
    }
    return h(req);
  };
}

export const GET = gate(authed as (req: Request) => Promise<Response>);
export const POST = gate(authed as (req: Request) => Promise<Response>);
