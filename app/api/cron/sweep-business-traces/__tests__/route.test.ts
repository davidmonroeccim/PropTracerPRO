import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";

/**
 * Money fences for the async FastAppend recovery cron.
 *
 * This is the quietest write in the whole billing surface. It re-evaluates the
 * billing of a trace_history row when a business trace lands late, and its
 * upgrade guard is `!historyRow.is_successful` -- which is EXACTLY the shape of
 * a billed tier 2 row (`is_successful = false` AND `charge > 0`). So it fires
 * on precisely the rows it must not touch, replaces the larger charge with the
 * smaller tier 1 rate, and downgrades the tier. The row stays non-zero, so it
 * never trips the 23503 lockout that makes the other sites loud. It just
 * under-reports money that moved and makes the customer re-buy the record.
 *
 * L-009 APPLIES TO EVERY RATE ASSERTION BELOW. `NEXT_PUBLIC_SUITE_SIGNIN_ENABLED`
 * is false in .env.local and true in production, and it is the only thing
 * separating the grant-aware rate from the raw one. With it off both collapse to
 * the same number and a test comparing them proves nothing, so the two
 * track-split tests set it explicitly.
 */

type Filter = [string, ...unknown[]];

interface Op {
  table: string;
  op: "select" | "update";
  payload?: Record<string, unknown>;
  filters: Filter[];
}

const H = vi.hoisted(() => ({
  ops: [] as Array<{
    table: string;
    op: "select" | "update";
    payload?: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  pendingJobs: [] as Array<Record<string, unknown>>,
  historyRow: null as Record<string, unknown> | null,
  parentJob: null as Record<string, unknown> | null,
  profile: {} as Record<string, unknown> | null,
  status: { success: true, pending: false, downloadUrl: "https://fa.example/r" } as Record<
    string,
    unknown
  >,
  parsed: null as Record<string, unknown> | null,
  // The wallet_transactions rows linked to the trace_history row being settled.
  // Non-empty is the state a row is left in when another path charged it.
  //
  // IT IS A LEDGER, NOT A DEBIT LIST, AND EVERY ENTRY CARRIES ITS `type`.
  // collectedChargeFor nets debits against credits, so an entry with no `type`
  // reads as money handed BACK and flips the sign of the probe's answer.
  // PostgREST never omits a selected column; a stub that does is telling the
  // route a lie no database can tell it.
  //
  // The rpc handler below APPENDS to this, so a refund issued during the run is
  // visible to a probe that happens after it -- which is the entire mechanism of
  // the defect this file now fences.
  priorLedger: [] as Array<Record<string, unknown>>,
}));

/**
 * POSTGREST COLUMN PROJECTION, EMULATED. Adopted from the phase 4b stubs in
 * lib/suite/__tests__/mcp-tools.test.ts.
 *
 * A column the query never asked for does not come back, and a stub that
 * ignores `.select(...)` hides exactly that. Here it is the whole ballgame:
 * isCacheHitRow's third arm is `tier = 2 AND charge > 0`, so dropping `charge`
 * from this route's select makes the guard return false, restores the
 * overwrite-a-paid-row defect in full, and leaves every assertion green. The
 * select list IS the guard.
 *
 * `*` passes everything through. Only keys the row actually carries are copied,
 * so an absent column stays absent rather than becoming an explicit `undefined`.
 */
function projectRow(row: unknown, select: string): unknown {
  if (row === null || row === undefined) return row;
  if (select.trim() === "*") return row;
  const columns = new Set(select.split(",").map((c) => c.trim()));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (columns.has(key)) out[key] = value;
  }
  return out;
}

function recordingClient() {
  return {
    // THE LEDGER IS WRITTEN BY THE WALLET FUNCTIONS, exactly as in production,
    // and ONLY when the call names a trace_history row. Both
    // `deduct_wallet_balance` and `credit_wallet_balance` INSERT into
    // wallet_transactions carrying `p_trace_history_id`, and a call that omits
    // it writes a row linked to nothing -- invisible to collectedChargeFor.
    //
    // Modelling that here is what makes the refund's `p_trace_history_id` a
    // load-bearing argument rather than a cosmetic one: drop it from the route
    // and the credit stops reaching the probe, which is the defect itself.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      H.rpcCalls.push({ fn, args });
      const type = fn === "deduct_wallet_balance" ? "debit" : "credit";
      if (
        (fn === "deduct_wallet_balance" || fn === "credit_wallet_balance") &&
        args.p_trace_history_id
      ) {
        H.priorLedger.push({ amount: args.p_amount, type });
      }
      return { data: true, error: null };
    },
    from(table: string) {
      const node: Record<string, unknown> = {};
      let rec: Op | null = null;
      let selectCols = "*";
      const add =
        (method: string) =>
        (...args: unknown[]) => {
          rec?.filters.push([method, ...args]);
          return node;
        };
      for (const m of ["select", "eq", "lt", "or", "order", "limit", "in", "is"])
        node[m] = add(m);

      const project = (data: unknown) =>
        Array.isArray(data)
          ? data.map((r) => projectRow(r, selectCols))
          : projectRow(data, selectCols);

      const settle = () => {
        if (table === "business_trace_jobs" && rec?.op === "select")
          return { data: project(H.pendingJobs), error: null };
        if (table === "wallet_transactions") return { data: H.priorLedger, error: null };
        return { data: null, error: null };
      };

      node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(settle()).then(res, rej);
      node.maybeSingle = async () => ({ data: project(H.historyRow), error: null });
      node.single = async () => ({
        data: project(
          table === "user_profiles"
            ? H.profile
            : table === "trace_jobs"
              ? H.parentJob
              : null
        ),
        error: null,
      });

      return {
        select: (...args: unknown[]) => {
          rec = { table, op: "select", filters: [["select", ...args]] };
          selectCols = typeof args[0] === "string" ? args[0] : "*";
          H.ops.push(rec);
          return node;
        },
        update: (payload: Record<string, unknown>) => {
          rec = { table, op: "update", payload, filters: [] };
          H.ops.push(rec);
          return node;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => recordingClient() }));
vi.mock("@/lib/tracerfy/client", () => ({
  getBusinessTraceStatus: vi.fn(async () => H.status),
  downloadBusinessTraceResults: vi.fn(async () => H.parsed),
}));

const { GET } = await import("@/app/api/cron/sweep-business-traces/route");

const JOB = {
  id: "btj-1",
  user_id: "user-1",
  fastappend_queue_id: "fa-1",
  address_hash: "hash-1",
  business_name: "Acme Holdings Llc",
  normalized_address: "100 MAIN ST|DALLAS|TX",
  city: "DALLAS",
  property_state: "TX",
  zip: "75001",
};

/** FastAppend came back with real contacts, which is what drives the upgrade arm. */
const CONTACTS = {
  owner_name: "Testowner Placeholder",
  phones: [{ number: "5550000101", type: "mobile" }],
  emails: ["principal@example.invalid"],
};

function run(secret = "s3cret") {
  return GET(
    new Request("http://localhost/api/cron/sweep-business-traces", {
      headers: { authorization: `Bearer ${secret}` },
    })
  );
}

const historyWrites = () =>
  H.ops.filter((o) => o.table === "trace_history" && o.op === "update").map((o) => o.payload!);

const finalWrite = () => historyWrites()[historyWrites().length - 1];

const deducts = () => H.rpcCalls.filter((c) => c.fn === "deduct_wallet_balance");
const credits = () => H.rpcCalls.filter((c) => c.fn === "credit_wallet_balance");

const FLAG = "NEXT_PUBLIC_SUITE_SIGNIN_ENABLED";

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  delete process.env[FLAG];
  H.ops = [];
  H.rpcCalls = [];
  H.pendingJobs = [{ ...JOB }];
  H.parentJob = null;
  H.parsed = { ...CONTACTS };
  H.priorLedger = [];
  H.status = { success: true, pending: false, downloadUrl: "https://fa.example/r" };
  H.profile = {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: [],
    webhook_url: null,
  };
  H.historyRow = {
    id: "hist-1",
    ai_research: null,
    status: "no_match",
    is_successful: false,
    charge: 0,
    ai_research_charge: 0,
    trace_job_id: null,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("auth", () => {
  it("401s without the cron secret and touches nothing", async () => {
    const res = await run("wrong");
    expect(res.status).toBe(401);
    expect(H.ops).toHaveLength(0);
  });
});

describe("the ordinary late-landing upgrade", () => {
  it("refunds a historical research fee, then charges one tier 1 trace", async () => {
    // The 1,301 rows the retired AI Search engine wrote are the reason this arm
    // exists at all: they carry a real ai_research_charge and no trace charge.
    // Narrowing the upgrade guard must NOT take this case with it.
    //
    // THE FIXTURE THAT HID THE DEFECT, NOW PRODUCTION-SHAPED. This used to set
    // `ai_research_charge: 0.15` against an EMPTY ledger -- a fee on the row
    // with no debit behind it, which is a state nothing can produce: the charge
    // column and the wallet_transactions row are written by the same act. On a
    // real row the $0.15 has a linked debit, which means the probe below has
    // something to find, which is the whole reason the refund had to be able to
    // cancel it out. With the empty ledger the probe answered null, the deduct
    // ran, and the defect was invisible.
    H.historyRow = { ...H.historyRow, ai_research_charge: 0.15 };
    H.priorLedger = [{ amount: 0.15, type: "debit" }];
    await run();

    expect(credits()[0].args.p_amount).toBe(0.15);
    // AND THE CHARGE STILL HAPPENS. The refund cancels the linked debit, so the
    // row's net collection is 0 and 0 is not a collection.
    //
    // MUTATION: sum the debits alone in collectedChargeFor (the pre-20260917
    // behaviour), or drop `p_trace_history_id` from the refund above, or test
    // `!== null` instead of `> 0` at the call site, and this goes red at zero
    // deducts -- the refunded $0.15 reads as collected, the deduct is skipped,
    // and the customer gets the contacts free while the row reports a $0.15
    // charge that is back in their wallet.
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(finalWrite()).toMatchObject({
      status: "success",
      is_successful: true,
      ai_research_charge: 0,
      charge: PRICING.CHARGE_PER_SUCCESS_WALLET,
      tier: 1,
    });
  });

  it("links the refund to the row it refunds", async () => {
    // Migration 20260917 exists for this argument. Without it the credit lands
    // in wallet_transactions with a NULL trace_history_id, where no probe can
    // see it, and the refunded money goes on counting as collected forever.
    // MUTATION: delete `p_trace_history_id` from the refund and this goes red.
    H.historyRow = { ...H.historyRow, ai_research_charge: 0.15 };
    H.priorLedger = [{ amount: 0.15, type: "debit" }];
    await run();
    expect(credits()[0].args.p_trace_history_id).toBe("hist-1");
  });

  it("leaves an already-successful row alone", async () => {
    H.historyRow = { ...H.historyRow, is_successful: true, charge: 0.25 };
    await run();
    expect(deducts()).toHaveLength(0);
    expect(Object.keys(finalWrite())).not.toContain("charge");
  });

  it("charges nothing when FastAppend found no contacts", async () => {
    H.parsed = { owner_name: null, phones: [], emails: [] };
    await run();
    expect(deducts()).toHaveLength(0);
    expect(Object.keys(finalWrite())).not.toContain("charge");
  });
});

/* ------------------------------------------------------------------ *
 * THE BILLED TIER 2 ROW.
 *
 * `is_successful = false` AND `charge > 0` is not a failed row, it is a row the
 * customer PAID for: tier 2 bills per RECORD SUBMITTED, so a county with no
 * parcel at that address is still billed. The upgrade guard reads that shape as
 * "not yet successful, go ahead and bill it", replaces the larger charge with
 * the smaller tier 1 rate, and downgrades the tier so isCacheHitRow stops
 * serving the row and the customer re-buys the same absence.
 * ------------------------------------------------------------------ */
describe("a row that already carries a tier 2 receipt", () => {
  beforeEach(() => {
    // Pro rate is $0.15, so a write of 0.15 over a 0.25 receipt is unambiguous.
    H.profile = { ...H.profile, subscription_tier: "pro" };
    H.historyRow = { ...H.historyRow, charge: 0.25, tier: 2 };
  });

  it("is not re-billed, and its charge is not replaced with the smaller rate", async () => {
    await run();

    // MUTATION: put the old `!historyRow.is_successful` guard back and all
    // three go red -- the arm takes a second $0.15 and writes it over the
    // $0.25 receipt, downgrading the tier on the way past.
    expect(deducts()).toHaveLength(0);
    expect(Object.keys(finalWrite())).not.toContain("charge");
    expect(Object.keys(finalWrite())).not.toContain("tier");
  });

  it("keeps the contacts, which is what the customer bought", async () => {
    // Whatever happens to the money, the FastAppend contacts must still land on
    // the row: under tier 2 the record was paid for whether or not it is empty.
    await run();
    const research = finalWrite().ai_research as Record<string, unknown>;
    expect(research.business_trace_contacts).toMatchObject({
      owner_name: CONTACTS.owner_name,
    });
  });

  /* ---------------------------------------------------------------- *
   * STATUS IS NOT A RECEIPT, HERE TOO.
   *
   * Declining to re-bill must not also decline to DELIVER. The customer paid
   * $0.25 under tier 2 and FastAppend has now produced contacts for that
   * record. If the upgrade arm is skipped wholesale, the row keeps
   * `status = 'no_match'` and an empty `trace_result`, and:
   *
   *   - lib/trace/exportCsv reads `trace_result`, so the CSV shows six blank
   *     contact columns for a row we DO have contacts for;
   *   - the dashboard and history page show the trace as a failure;
   *   - v1 and the MCP read `ai_research.business_trace_contacts` and DO show
   *     them, so the API and the CSV now disagree about the same row.
   *
   * Gate the money. Never the delivery.
   * ---------------------------------------------------------------- */
  it("still delivers the contacts as a successful trace", async () => {
    await run();
    // MUTATION: gate the delivery write on `shouldBill` instead of
    // `shouldDeliver` and every line here goes red -- the CSV then shows six
    // blank contact columns for a row we do have contacts for.
    expect(finalWrite().status).toBe("success");
    expect(finalWrite().is_successful).toBe(true);
    expect(finalWrite().trace_result).toMatchObject({
      owner_name: CONTACTS.owner_name,
    });
    expect(finalWrite().phone_count).toBe(1);
    expect(finalWrite().email_count).toBe(1);
    // ...and still no money, which is the other half of the split.
    expect(Object.keys(finalWrite())).not.toContain("charge");
    expect(Object.keys(finalWrite())).not.toContain("tier");
    // The refund never ran, so the fee it would have handed back must not be
    // zeroed out from under it.
    expect(Object.keys(finalWrite())).not.toContain("ai_research_charge");
  });

  it("counts the row against its parent bulk job's records_matched", async () => {
    H.historyRow = { ...H.historyRow, trace_job_id: "job-9" };
    H.parentJob = { records_matched: 4 };
    await run();
    const bump = H.ops.find((o) => o.table === "trace_jobs" && o.op === "update");
    // MUTATION: move the bump back inside the billing arm and this goes red --
    // a delivered record would be missing from its job's match count.
    expect(bump!.payload).toMatchObject({ records_matched: 5 });
  });
});

/**
 * Site 201 folds rather than replaces.
 *
 * A row carrying a real debit and still not successful is the case where the
 * difference is visible: this settle books a SECOND debit, and both are real
 * money against one reused row. Writing only the second drops the first out of
 * SUM(trace_history.charge), which is what every surface reports as
 * total_charge.
 */
describe("the charge write reports the ledger total, never a sum of its own", () => {
  it("does not add the ledger's answer to money the row already shows", async () => {
    // A COHERENT fixture: the row shows $0.25 collected AND the ledger holds
    // exactly that one $0.25 debit. Those are the same money described twice,
    // not two payments. (The previous fixture had the row showing 0.25 with an
    // EMPTY ledger, which cannot happen -- a charge with no debit behind it --
    // and it made a fold look correct.)
    //
    // Now that this site probes the ledger, the ledger is authoritative: its
    // total already includes every debit against the row, so folding it onto
    // the row's own column counts the same debit twice. Its two twins write the
    // ledger amount RAW for exactly this reason, and this file now matches them.
    H.historyRow = { ...H.historyRow, charge: 0.25, tier: 1 };
    H.priorLedger = [{ amount: 0.25, type: "debit" }];
    await run();
    // MUTATION: fold the ledger's answer onto historyRow.charge and this goes
    // red -- one debit becomes two on every surface that SUMs the column.
    expect(finalWrite().charge).toBe(0.25);
    expect(finalWrite().charge).not.toBe(0.5);
  });

  it("keeps the tier off the ledger's answer and out of a downgrade", async () => {
    // `tier` is not the ledger's to answer. It comes from foldBillingWrite,
    // which never downgrades, so a tier 2 receipt survives a tier 1 settle.
    H.historyRow = { ...H.historyRow, charge: 0.25, tier: 2, is_successful: false };
    H.priorLedger = [{ amount: 0.25, type: "debit" }];
    await run();
    // A billed tier 2 row is a cache hit, so no money moves at all here...
    expect(deducts()).toHaveLength(0);
    // ...and the row keeps the tier it was billed under.
    expect(Object.keys(finalWrite())).not.toContain("tier");
  });

  /**
   * THE TIER WRITE IS FOLDED, AND THIS IS THE FIXTURE THAT PROVES IT.
   *
   * The test above never reaches the fold -- a billed tier 2 row is a cache hit,
   * so `shouldBill` is false and nothing is written at all. Every OTHER fixture
   * in this file carries tier 1 or no tier, where the fold's answer and a flat
   * `TRACE_TIER.PER_SUCCESSFUL_TRACE` are the same number 1. So flattening the
   * fold killed nothing: a tautology, and the third instance of that class in
   * this billing surface.
   *
   * The shape that separates them is a tier 2 row that collected NOTHING:
   * `tier = 2, charge = 0`. That is real, and billedRows.ts names it -- "a row
   * where the wallet deduct returned false collected nothing, so there is no
   * purchase to serve back and re-buying it is correct". It fails all three arms
   * of isCacheHitRow, so this arm DOES bill it, and the fold is the only thing
   * standing between it and a silent downgrade to tier 1.
   *
   * The downgrade is not cosmetic. isCacheHitRow's third arm is
   * `tier = 2 AND charge > 0`; once this settle has taken the tier 1 charge, a
   * row stamped `tier: 1` can never satisfy it again, so the next submit of that
   * address re-buys a record the customer has already bought.
   */
  it("folds the tier so a tier 2 row it DOES bill is not downgraded to 1", async () => {
    H.historyRow = { ...H.historyRow, charge: 0, tier: 2, is_successful: false };
    H.priorLedger = [];
    await run();

    // This row is genuinely billable: nothing was ever collected against it.
    expect(deducts()).toHaveLength(1);
    expect(finalWrite().charge).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    // MUTATION: replace `foldBillingWrite(historyRow, ...).tier` with a flat
    // TRACE_TIER.PER_SUCCESSFUL_TRACE and this goes red at 1.
    expect(finalWrite().tier).toBe(2);
    expect(finalWrite().tier).not.toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * THE RATE FOLLOWS THE TRACK, NOT THE OWNER TYPE.
 *
 * lib/suite/pricing.ts splits PTP's two price derivations: Track A (session,
 * MCP) is GRANT-AWARE, Track B (the /api/v1/* API-key surface) is RAW. This
 * cron's twin, sweep-entity-traces:178, takes the row's `source` tag and picks
 * the derivation from it. This one never got the argument, so it bills every
 * row grant-aware -- including a v1 row whose person siblings settle raw in the
 * same job, at the same moment, for the same work.
 *
 * Both tests set NEXT_PUBLIC_SUITE_SIGNIN_ENABLED, because hasSuiteAccess() is
 * behind it and without it the two rates are the same number (L-009).
 * ------------------------------------------------------------------ */
describe("which price derivation a row is billed at", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
    H.profile = {
      ...H.profile,
      subscription_tier: "wallet",
      gateway_products: ["prop-tracer-pro"],
    };
  });

  it("bills a grant holder the GRANT-AWARE rate on a Track A row", async () => {
    H.historyRow = { ...H.historyRow, source: "mcp" };
    await run();
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS);
  });

  it("bills that same grant holder the RAW rate on an untagged Track B row", async () => {
    // A v1 bulk row carries no source. Untagged is Track B, which is also the
    // dearer derivation, so the fallback errs in the safe direction.
    await run();
    // MUTATION: drop the `source` argument from tier1RateFor (which is what
    // this cron did until 2026-09-17) and this goes red.
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    // The whole point: the same profile, same vendor, two tracks, and the
    // entity row is never cheaper than the person rows settling beside it.
    expect(deducts()[0].args.p_amount).not.toBe(PRICING.CHARGE_PER_SUCCESS);
  });
});

/**
 * THE CROSS-FILE DOUBLE CHARGE, at the third door.
 *
 * `deductOrZero` moves real money the instant it is called, and the row is only
 * written back afterwards. Both of this cron's twins -- sweep-entity-traces and
 * lib/trace/settleBulkJob -- ask the ledger first via collectedChargeFor,
 * precisely because the guard "cannot live in either one of them alone": one
 * row is reachable by all three paths, and a debit booked by any of them means
 * the customer has already paid for that row.
 *
 * This file was the one door without the guard.
 */
describe("a row the ledger has already been charged for", () => {
  beforeEach(() => {
    // Deliberately an amount NO current rate can produce. A row that comes out
    // carrying 0.07 can only have read the ledger; one carrying a plan rate
    // re-derived the price, which is the bug wearing a disguise.
    H.priorLedger = [{ amount: 0.07, type: "debit" }];
  });

  it("is not charged a second time by this cron", async () => {
    await run();
    expect(deducts()).toHaveLength(0);
  });

  it("persists the amount that already moved, not zero and not a fresh rate", async () => {
    await run();
    expect(finalWrite().charge).toBe(0.07);
    expect(finalWrite().status).toBe("success");
  });

  it("still charges a row the ledger has never seen", async () => {
    // The guard must not become a blanket refusal to bill.
    H.priorLedger = [];
    await run();
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("does not probe the ledger on a row it is not about to charge", async () => {
    // A row already delivered as a success is not being billed, so there is no
    // charge to be idempotent about and no reason to spend a query per row.
    H.priorLedger = [];
    H.historyRow = { ...H.historyRow, is_successful: true, charge: 0.25 };
    await run();
    expect(H.ops.some((o) => o.table === "wallet_transactions")).toBe(false);
  });
});
