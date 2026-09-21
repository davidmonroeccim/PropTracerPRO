import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyToken } from "@/lib/suite/mcp-auth";
import { assertPtpAccess, ctx, ok, err } from "@/lib/suite/mcp-shared";
import { PRICING } from "@/lib/constants";
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

/** The TIER 1 per-successful-trace rates, read from PRICING so a tool description can never drift
 *  from the ledger. Claude quotes these to the user BEFORE spending their wallet, so a stale number
 *  here buys a wrong promise with real money. ONE rate per plan: owner type selects the vendor,
 *  never the price, so there is no entity carve-out to quote.
 *
 *  TIER 1 IS THE MODEL WHERE A MISS IS FREE. Never interpolate it into a sentence describing a
 *  record with no owner name; that record is tier 2 and is billed on a miss. */
const TIER_1_RATES =
  `$${PRICING.CHARGE_PER_SUCCESS.toFixed(2)} per successful trace on Pro or AcquisitionPRO and ` +
  `$${PRICING.CHARGE_PER_SUCCESS_WALLET.toFixed(2)} on Pay-As-You-Go`;

/** The TIER 2 per-record-submitted rates, for a record that arrives with NO owner name and runs a
 *  Full Property Trace.
 *
 *  IT EXISTS BECAUSE THE PRICE IS NOW REACHABLE FROM THIS SURFACE. Phase 5c-3A routed
 *  skip_trace_bulk's blank-owner bucket onto the tier 2 queue, where it is charged per record
 *  submitted. Until then these tools billed one model and the descriptions honestly quoted one set
 *  of rates. Quoting only TIER_1_RATES now means a caller is shown $0.15 or $0.25 per SUCCESS
 *  immediately before being billed $0.25 or $0.40 per RECORD, on the exact records the old copy
 *  called free.
 *
 *  Same shape as TIER_1_RATES on purpose, both plans named together, so a Pay-As-You-Go caller can
 *  never be shown a Pro price. And read from PRICING: note TIER2_PER_RECORD_SUBMITTED_PRO shares
 *  its digits with CHARGE_PER_SUCCESS_WALLET and means something completely different. */
const TIER_2_RATES =
  `$${PRICING.TIER2_PER_RECORD_SUBMITTED_PRO.toFixed(2)} per record submitted on Pro or ` +
  `AcquisitionPRO and $${PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET.toFixed(2)} on Pay-As-You-Go`;

/** The money promise, both models. Verified against lib/trace/settleBulkJob.ts,
 *  app/api/cron/sweep-entity-traces/route.ts and app/api/cron/sweep-property-traces/route.ts.
 *
 *  A record with an owner of record is tier 1, charged only on a successful trace, and the vendor
 *  it routes to (Tracerfy for a person, FastAppend for a company) changes nothing about the price.
 *  A record with no owner name is tier 2, charged for every record sent.
 *
 *  BOTH SENTENCES NAME THEIR MODEL, and that is the rule this string exists to hold. Its previous
 *  version said "you are charged only when the trace succeeds. A trace that finds nothing is free",
 *  full stop, and then told the caller a record with no owner name "costs nothing". The first half
 *  was true of tier 1 only and the second was false outright once 5c-3A wired the queue. A sentence
 *  that is true of one model and false of the other, with nothing saying which it applies to, is
 *  how nearly every string in this dispatch went wrong.
 *
 *  Do not put an AI research fee back in here: that engine was removed on 2026-09-17 and nothing
 *  books the fee. Carries NO figure of its own; the four rates live in the two constants above. */
const NO_MATCH_TERMS =
  `Give us the owner of record, a person or a company, and you are charged only when the trace ` +
  `succeeds, so a trace that finds nothing is free. A record with no owner name runs a full ` +
  `property trace instead, and that one is charged for every record you send, so it costs the ` +
  `same whether or not contacts come back.`;

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "skip_trace_quote",
      `Free cost estimate for a skip-trace list. Give records (owner_name, address, city, state, zip). Returns the dedup count, how many are people vs entities, how many will run a full property trace because they arrived with no owner name (the full_property_trace count), the worst-case cost (${TIER_1_RATES}; ${TIER_2_RATES}), your current wallet balance, and whether the list exceeds the 500-per-call cap. ${NO_MATCH_TERMS} Show the user the full_property_trace count alongside the cost, because those records are billed whether or not anything is found. Always call this first and show the cost to the user before skip_trace_bulk.`,
      quoteSchema.shape,
      tool((admin, sub, args) => skipTraceQuote(admin, sub, args)),
    );
    server.tool(
      "skip_trace_bulk",
      `Skip-trace a list of owners to resolve the CONTACT PERSON (a named human) plus their phones and emails, drawn from the user's PropTracerPRO wallet. When the owner is a company, LLC or trust, this resolves the individual behind it, so the result is a person's name and not the company you passed in. Up to 500 records per call (use one record for a single owner). Requires confirm: true, so quote and confirm the cost with the user first. A record that comes with an owner of record is charged on success: ${TIER_1_RATES}. A record with no owner name runs a full property trace and is charged for every record sent: ${TIER_2_RATES}. ${NO_MATCH_TERMS} On a record with no owner name you may also supply apn (a county parcel id) and county (the bare county name). These are optional and used together as a second lookup key for the full property trace, independent of the address, not a more accurate one; either key can find an owner the other misses. The record's tier 2 charge is the same regardless of which key succeeds. Returns a job_id; poll bulk_status for results.`,
      bulkSchema.shape,
      tool((admin, sub, args) => skipTraceBulk(admin, sub, args)),
    );
    server.tool(
      "bulk_status",
      "Retrieve the results of a skip_trace_bulk job by job_id. Each record returns owner_contact_name (the resolved human, which is the point of the trace), alongside input_owner_name (the company or person you asked about), phones and emails. owner_contact_name and input_owner_name are DIFFERENT fields: report the former as the contact person and never substitute the company name for it. It is null when no human was resolved; leave the field empty in that case. A record can also come back with skip_reason set, which says why that row has no contacts. Read it out as it stands and never call such a row a no match: some of those rows were never traced and were free, and one of them is a full property trace that was charged and whose contact lookup could not be completed, so the sentence itself says which. Successful matches settle their per-trace charge to the wallet as they land. A record traced as a Full Property Trace also carries tier 2 and a property record, holding the county record for that address at up to 65 fields covering the building, the land, the assessed value, the sale and recording history, the debt and the recorded status flags. It is null on a tier 1 trace, and the assessed value is a county assessment rather than a market valuation. Results are paged: pass limit (default 25, max 200) and offset, and compare results_returned against results_total to see whether more rows are waiting.",
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
      "List the caller's own past skip-traces (results already paid for), most recent first, including each trace's resolved owner_contact_name. Use to reuse prior contacts without tracing again. A trace that ran as a Full Property Trace carries tier 2 and a property_record, the county record for that address at up to 65 fields; both are null on a tier 1 trace. Reading a stored record here is free, because the customer has already paid for it.",
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
