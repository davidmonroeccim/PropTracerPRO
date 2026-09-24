import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { BLANK_OWNER_SKIP_STATUS } from "@/lib/trace/blankOwnerSkip";
import { chargePerRecord, chargePerTrace } from "@/lib/suite/pricing";
import {
  isPropertyTracePending,
  queuedStatusFor,
} from "@/lib/trace/propertyTraceAttempts";
import { TIER2_CAPACITY_REFUSAL } from "@/lib/trace/bulkPreflight";

/**
 * Money fences for the PUBLIC v1 bulk-trace SUBMIT route.
 *
 * This route is the SOURCE OF TRUTH the MCP submit mirrors, so the wallet
 * reserve it computes is the reserve the whole product is measured against.
 *
 * WHAT CHANGED ON 2026-09-18. A record with no owner name used to be accepted,
 * written terminal with a reason and never charged, because nothing on the bulk
 * path could resolve an owner from an address alone. Phase 5c built the engine
 * that can, so that record now runs a Full Property Trace automatically and is
 * billed per RECORD SUBMITTED. The tests that fenced it as free now fence the
 * opposite rule.
 *
 * THE OTHER THING THIS ROUTE MUST KEEP GETTING RIGHT IS ITS PRICE, and as of 2026-09-23 there is
 * only one. This route used to price RAW, from the profile's own columns, deliberately blind to a
 * Suite Gateway grant, while every other surface priced grant-aware. David's decision -- "One
 * price: make the API grant-aware" -- collapsed the two, so the reserve below now quotes
 * chargePerTrace / chargePerRecord, the same functions the dashboard, the MCP and the crons use.
 */

type Op = { table: string; op: string; payload?: unknown; opts?: unknown };

const H = vi.hoisted(() => ({
  ops: [] as Array<{ table: string; op: string; payload?: unknown; opts?: unknown }>,
  profile: {} as Record<string, unknown>,
  job: { id: "job-1" } as Record<string, unknown> | null,
  submit: { success: true, jobId: "tf-1" } as Record<string, unknown>,
  canRunTier2: true,
  inFlight: 0,
}));

function recordingClient() {
  return {
    from(table: string) {
      const node: Record<string, unknown> = {};
      let rec: Op | null = null;
      const add =
        () =>
        () =>
          node;
      for (const m of ["eq", "select"]) node[m] = add();
      node.single = async () => ({ data: H.job, error: null });
      node.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
      return {
        insert: (payload: unknown) => {
          rec = { table, op: "insert", payload };
          H.ops.push(rec);
          return node;
        },
        upsert: (payload: unknown, opts: unknown) => {
          rec = { table, op: "upsert", payload, opts };
          H.ops.push(rec);
          return node;
        },
        update: (payload: unknown) => {
          rec = { table, op: "update", payload };
          H.ops.push(rec);
          return node;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => recordingClient() }));
vi.mock("@/lib/api/auth", () => ({
  validateApiKey: async () => ({ profile: H.profile }),
  isAuthError: (r: unknown) => Boolean((r as { response?: unknown })?.response),
}));
vi.mock("@/lib/utils/deduplication", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/deduplication")>();
  return {
    ...actual,
    // Dedup passes everything through; removeBatchDuplicates stays REAL.
    checkDuplicates: vi.fn(async (_userId: string, records: unknown[]) => ({
      newRecords: records,
      duplicates: [],
      cachedResults: [],
    })),
  };
});
vi.mock("@/lib/tracerfy/client", () => ({ submitBulkTrace: vi.fn(async () => H.submit) }));
// The pre-flight module has its own unit tests. Here it is a lever, so these
// tests can ask what the ROUTE does with each answer. The refusal string stays
// REAL, because the copy rules apply to what the caller actually receives.
vi.mock("@/lib/trace/bulkPreflight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trace/bulkPreflight")>();
  return {
    ...actual,
    // Faithful to the real contract: a batch empty on BOTH tiers asks no vendor and can never be
    // refused. This surface always passes tier1: 0 until 2B, because its tier 1 records go to the
    // Tracerfy BATCH endpoint, a different credit bucket from the per-record lookups this check
    // sizes. Without the short circuit a route passing the wrong count would still look correct.
    tracerfyCanRun: vi.fn(async (_admin: unknown, n: { tier1: number; tier2: number }) =>
      n.tier1 <= 0 && n.tier2 <= 0 ? true : H.canRunTier2,
    ),
    inFlightUnbilledCost: vi.fn(async () => H.inFlight),
  };
});

const { POST } = await import("@/app/api/v1/trace/bulk/route");
const { tracerfyCanRun, inFlightUnbilledCost } = await import("@/lib/trace/bulkPreflight");

const TIER1 = PRICING.CHARGE_PER_SUCCESS_WALLET;
const TIER2 = 0.4; // wallet column, per record submitted

const rec = (owner_name?: string, n = 1) => ({
  owner_name,
  address: `${n} Main St`,
  city: "Dallas",
  state: "TX",
  zip: "75001",
});

function post(records: unknown[]) {
  return POST(
    new Request("http://localhost/api/v1/trace/bulk", {
      method: "POST",
      body: JSON.stringify({ records }),
      headers: { "content-type": "application/json" },
    })
  );
}

/** Every trace_history row upserted, flattened. */
const historyRows = () =>
  H.ops
    .filter((o) => o.table === "trace_history" && o.op === "upsert")
    .flatMap((o) => o.payload as Array<Record<string, unknown>>);

/** The single trace_jobs insert this route makes. */
const jobInsert = () =>
  H.ops.find((o) => o.table === "trace_jobs" && o.op === "insert")?.payload as
    | Record<string, unknown>
    | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  H.ops = [];
  H.job = { id: "job-1" };
  H.submit = { success: true, jobId: "tf-1" };
  H.canRunTier2 = true;
  H.inFlight = 0;
  H.profile = {
    id: "user-1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    wallet_balance: 100,
  };
  delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the wallet reserve", () => {
  it("quotes one tier 1 rate per owned record, with no research fee on the entity", async () => {
    // MUTATION: add AI_RESEARCH.CHARGE_PER_RECORD back onto the entity count and
    // this goes red.
    const body = await (
      await post([rec("John Smith", 1), rec("Acme Holdings Llc", 2)])
    ).json();
    expect(body.estimatedCost).toBeCloseTo(2 * TIER1);
  });

  it("quotes a blank-owner record at the TIER 2 per-record rate", async () => {
    // It used to quote nothing, because the record was skipped rather than
    // traced. It is traced now, and billed whether or not the county has a
    // parcel at that address. MUTATION: leave blanks out and this goes red.
    const body = await (
      await post([rec("John Smith", 1), rec(undefined, 2), rec("   ", 3)])
    ).json();
    expect(body.estimatedCost).toBeCloseTo(TIER1 + 2 * TIER2);
  });

  it("sizes against work already accepted and not yet billed", async () => {
    // The check was a bare comparison and reserved nothing, so two jobs
    // submitted back to back both passed against the same dollars.
    // MUTATION: drop the in-flight term and this goes red.
    H.inFlight = 99.9;
    H.profile = { ...H.profile, wallet_balance: 100 };
    const res = await post([rec("John Smith", 1)]);
    expect(res.status).toBe(402);
    expect(H.ops).toHaveLength(0);
  });

  it("prices in-flight work at THIS surface's two rates", async () => {
    await post([rec("John Smith", 1)]);
    expect(inFlightUnbilledCost).toHaveBeenCalledWith(expect.anything(), "user-1", {
      tier1: TIER1,
      tier2: TIER2,
    });
  });

  it("lets through a wallet that holds exactly the reserve", async () => {
    H.profile = { ...H.profile, wallet_balance: TIER1 };
    const res = await post([rec("Acme Holdings Llc", 1)]);
    expect(res.status).not.toBe(402);
  });

  it("still 402s a wallet that cannot cover the batch", async () => {
    H.profile = { ...H.profile, wallet_balance: 0 };
    const res = await post([rec("John Smith", 1)]);
    expect(res.status).toBe(402);
    expect(H.ops).toHaveLength(0);
  });
});

/**
 * THE RATES AN API-KEY CALLER IS QUOTED, AND THE TEST FOR THEM WILL LIE TO YOU.
 *
 * hasSuiteAccess() is gated on NEXT_PUBLIC_SUITE_SIGNIN_ENABLED, false in tests
 * and TRUE in production. With the flag off a gateway grant counts for nothing,
 * every shape collapses to the wallet column, and a test asserting anything
 * about a grant holder passes under a grant-aware implementation and a
 * grant-blind one alike. That is L-009, and this project has earned it twice.
 * Every test here sets the flag, and one of them proves the flag is what makes
 * the difference visible.
 */
describe("the rates an API-key caller is quoted", () => {
  const GRANT_HOLDER = {
    id: "user-1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: ["prop-tracer-pro"],
    wallet_balance: 100,
  };

  it("quotes a grant holder the PRO tier 2 rate, the same as every other surface", async () => {
    // SITE: route.ts tier2Rate -> chargePerRecord(profile).
    // MUTATION: swap in a grant-blind raw rate and this goes red (0.40 quoted for 0.25 owed).
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = { ...GRANT_HOLDER };
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.estimatedCost).toBeCloseTo(chargePerRecord(GRANT_HOLDER));
    expect(body.estimatedCost).toBeCloseTo(0.25);
    expect(body.estimatedCost).not.toBeCloseTo(TIER2);
  });

  it("quotes a grant holder the PRO tier 1 rate too", async () => {
    // SITE: route.ts tier1Rate -> chargePerTrace(profile). A named owner is a tier 1 record.
    // MUTATION: swap in a grant-blind raw rate and this goes red (0.25 quoted for 0.15 owed).
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = { ...GRANT_HOLDER };
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(body.estimatedCost).toBeCloseTo(chargePerTrace(GRANT_HOLDER));
    expect(body.estimatedCost).toBeCloseTo(0.15);
    expect(body.estimatedCost).not.toBeCloseTo(TIER1);
  });

  it("reserves in-flight work at those same two grant-aware rates", async () => {
    // SITE: route.ts inFlightUnbilledCost({ tier1, tier2 }). The reserve and the quote must come
    // from the same two functions, or a second job is sized against rates the first never used.
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = { ...GRANT_HOLDER };
    await post([rec("John Smith", 1)]);
    expect(inFlightUnbilledCost).toHaveBeenCalledWith(expect.anything(), "user-1", {
      tier1: 0.15,
      tier2: 0.25,
    });
  });

  it("proves the flag is load-bearing, so the assertions above are not tautologies", async () => {
    // With the flag OFF the grant counts for nothing and this caller is quoted their native
    // pay-as-you-go rates, which is what the whole file would be measuring by default.
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    H.profile = { ...GRANT_HOLDER };
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.estimatedCost).toBeCloseTo(TIER2);
    expect(body.estimatedCost).not.toBeCloseTo(0.25);
  });

  it("charges a genuine pro the pro rate, so this is not just 'always cheapest'", async () => {
    H.profile = { ...GRANT_HOLDER, subscription_tier: "pro" };
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.estimatedCost).toBeCloseTo(0.25);
  });

  it("still charges a caller with NO entitlement the pay-as-you-go rates", async () => {
    // The direction that matters for existing customers: the collapse must not have made
    // everybody a pro. MUTATION: default either rate to the pro column and this goes red.
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = { ...GRANT_HOLDER, gateway_products: [] };
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(body.estimatedCost).toBeCloseTo(TIER1 + TIER2);
  });
});

describe("the three-way split", () => {
  it("ENQUEUES a blank-owner row for a Full Property Trace", async () => {
    // THE CENTRAL CHANGE. MUTATION: write BLANK_OWNER_SKIP_STATUS again and this
    // goes red. Nothing reaches the tier 2 cron without it.
    await post([rec(undefined, 1)]);
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      property_trace_status: queuedStatusFor(1),
      status: "processing",
      input_owner_name: null,
    });
    expect(isPropertyTracePending(String(rows[0].property_trace_status))).toBe(true);
  });

  it("stops writing the blank-owner skip, which is now historical", async () => {
    await post([rec(undefined, 1)]);
    expect(historyRows()[0].ai_research_status ?? null).toBeNull();
    expect(historyRows()[0].ai_research_status).not.toBe(BLANK_OWNER_SKIP_STATUS);
  });

  it("keeps the tier 2 row off the ENTITY queue, which bills a different model", async () => {
    // ai_research_status settles per SUCCESSFUL trace and a miss there is free.
    // property_trace_status settles per RECORD SUBMITTED and a miss is billed.
    // One row on both queues is settled twice, by two engines, at two models.
    await post([rec(undefined, 1)]);
    expect(historyRows()[0].ai_research_status ?? null).toBeNull();
  });

  it("writes nothing money-shaped at submit", async () => {
    await post([rec(undefined, 1)]);
    for (const paid of ["charge", "ai_research_charge", "tier", "property_record"]) {
      expect(Object.keys(historyRows()[0])).not.toContain(paid);
    }
  });

  it("still queues a NAMED entity for the business trace, on its own queue", async () => {
    await post([rec("Acme Holdings Llc", 1)]);
    expect(historyRows()[0]).toMatchObject({
      ai_research_status: "queued",
      status: "processing",
    });
    // THE KEY MUST BE PRESENT, NOT MERELY NULLISH. This upsert touches only the
    // keys it carries and the row is REUSED (UNIQUE(user_id, address_hash)), so
    // an omitted key leaves a previous tier 2 terminal value in place and
    // rowSkipReason() serves it over this tier 1 row. `?? null` alone was
    // satisfied by the key being absent, which is the state the defect lived in.
    expect(Object.keys(historyRows()[0])).toContain("property_trace_status");
    expect(historyRows()[0].property_trace_status).toBeNull();
  });

  it("still sends a person straight to the Tracerfy bulk CSV", async () => {
    const { submitBulkTrace } = await import("@/lib/tracerfy/client");
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(submitBulkTrace).toHaveBeenCalledTimes(1);
    expect(body.recordsDirectTrace).toBe(1);
    expect(historyRows()[0]).toMatchObject({ ai_research_status: null, status: "processing" });
    // Written, not merely absent. See the entity test above.
    expect(Object.keys(historyRows()[0])).toContain("property_trace_status");
    expect(historyRows()[0].property_trace_status).toBeNull();
  });

  it("never sends a blank-owner record to the person CSV", async () => {
    // It has no owner to put in it: the dossier is what discovers one.
    const { submitBulkTrace } = await import("@/lib/tracerfy/client");
    vi.mocked(submitBulkTrace).mockClear();
    await post([rec(undefined, 1)]);
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });
});

describe("when PTP's own credit pool cannot cover the job", () => {
  it("refuses before writing anything", async () => {
    H.canRunTier2 = false;
    const res = await post([rec(undefined, 1)]);
    expect(res.status).toBe(503);
    expect(H.ops).toHaveLength(0);
  });

  it("NEVER tells the caller to add funds", async () => {
    // It is PTP's balance that is short, not theirs. MUTATION: return the 402
    // copy here and this goes red.
    H.canRunTier2 = false;
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.error).toBe(TIER2_CAPACITY_REFUSAL);
    expect(body.error.toLowerCase()).not.toContain("add funds");
    expect(body.error.toLowerCase()).not.toMatch(/notif|alerted|our team/);
  });

  it("is asked about the tier 2 records only", async () => {
    await post([rec("John Smith", 1), rec("Acme Holdings Llc", 2), rec(undefined, 3)]);
    expect(tracerfyCanRun).toHaveBeenCalledWith(expect.anything(), { tier1: 0, tier2: 1 });
  });

  it("does not block a batch with no blank-owner records", async () => {
    H.canRunTier2 = false;
    const res = await post([rec("John Smith", 1)]);
    expect(res.status).not.toBe(503);
    expect(tracerfyCanRun).toHaveBeenCalledWith(expect.anything(), { tier1: 0, tier2: 0 });
  });
});

/**
 * A FAILED PERSON SUBMIT IS NOT A FAILED JOB.
 *
 * This guard was written when the third bucket did not exist, so it asked only
 * whether the ENTITY queue still had work. sweep-property-traces claims on
 * property_trace_status alone and never reads the parent job, so failing the job
 * here stops nothing: it works every tier 2 row written above and bills each
 * one. The caller would be told the submit failed and charged for it, and a
 * resubmit inside the 90-day window comes back as duplicates.
 */
describe("when the Tracerfy person submit fails", () => {
  const failedJob = () =>
    H.ops.find(
      (o) =>
        o.table === "trace_jobs" &&
        o.op === "update" &&
        (o.payload as Record<string, unknown>)?.status === "failed"
    );

  beforeEach(() => {
    H.submit = { success: false, error: "Tracerfy 503" };
  });

  it("does NOT fail the job while tier 2 rows are queued", async () => {
    // MUTATION: drop the `&& tier2Records.length === 0` term and this goes red.
    const res = await post([rec("John Smith", 1), rec(undefined, 2)]);
    expect(failedJob()).toBeUndefined();
    expect(res.status).not.toBe(500);
  });

  it("does NOT fail the job while entity rows are queued either", async () => {
    // The original half of the guard, still holding.
    const res = await post([rec("John Smith", 1), rec("Acme Holdings Llc", 2)]);
    expect(failedJob()).toBeUndefined();
    expect(res.status).not.toBe(500);
  });

  it("STILL fails a job where nothing else was queued", async () => {
    // The guard must not become a blanket refusal to ever fail a job.
    const res = await post([rec("John Smith", 1)]);
    expect(res.status).toBe(500);
    expect(failedJob()).toBeDefined();
  });

  it("stops counting the errored person records as running", async () => {
    // THE HALF THAT WAS MISSED. The billing hole was closed but the payload
    // still described the dead half as in progress. MUTATION: report
    // personRecords.length again and this goes red.
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(body.recordsDirectTrace).toBe(0);
    expect(body.recordsFailed).toBe(1);
    expect(body.recordsToProcess).toBe(1);
  });

  it("requotes for the survivors instead of pricing work that will never run", async () => {
    // A caller reconciles this number against their bill. Quoting the person
    // half means the bill comes back short and the only way they find out is by
    // doing the arithmetic themselves.
    // MUTATION: return the pre-failure estimatedCost and this goes red.
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(body.estimatedCost).toBeCloseTo(TIER2);
    expect(body.estimatedCost).not.toBeCloseTo(TIER1 + TIER2);
  });

  it("corrects the job's records_submitted, which is the match-rate denominator", async () => {
    // Read back by the status route and carried in the bulk_job.completed
    // webhook, so leaving it would have the payload and the job disagree about
    // one job.
    await post([rec("John Smith", 1), rec(undefined, 2)]);
    const corrected = H.ops.filter(
      (o) =>
        o.table === "trace_jobs" &&
        o.op === "update" &&
        (o.payload as Record<string, unknown>)?.records_submitted !== undefined
    );
    expect(corrected).toHaveLength(1);
    expect(corrected[0].payload).toMatchObject({ records_submitted: 1 });
  });

  it("names the failed half and gets BOTH charge statements right", async () => {
    // The errored person records are NOT billed and the surviving tier 2
    // records WILL be. Saying only one of those is how a caller ends up
    // surprised by the half that was left out.
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(body.message).toContain("not charged");
    expect(body.message).toContain("will be charged");
    expect(body.message).not.toMatch(/[—–*]/);
  });

  it("makes no charge promise about the ENTITY survivors, which bill on success only", async () => {
    // Tier 1 is per successful trace and free on a miss, so a blanket "you will
    // be charged for these" would be false for an entity row that misses.
    const body = await (
      await post([rec("John Smith", 1), rec("Acme Holdings Llc", 2)])
    ).json();
    expect(body.message).toContain("not charged");
    expect(body.message).not.toContain("will be charged");
  });

  it("reports nothing failed on the happy path, with the key still present", async () => {
    // A key that appears only when something went wrong is one nobody writes a
    // branch for.
    H.submit = { success: true, jobId: "tf-1" };
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(body.recordsFailed).toBe(0);
    expect(body.recordsDirectTrace).toBe(1);
  });

  it("leaves the queued tier 2 rows on the queue, not errored", async () => {
    // Only the person rows failed. Rewriting the tier 2 rows here would strand
    // work the cron is about to run and the customer is about to be billed for.
    await post([rec("John Smith", 1), rec(undefined, 2)]);
    const queued = historyRows().filter(
      (r) => r.property_trace_status === queuedStatusFor(1)
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("processing");
  });
});

describe("the record cap", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => rec("John Smith", i + 1));

  it("accepts 500", async () => {
    const res = await post(many(500));
    expect(res.status).not.toBe(400);
  });

  it("refuses 501, and says the cap in records", async () => {
    // MUTATION: restore 10,000 and this goes red. One number across all three
    // submit surfaces.
    const res = await post(many(501));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("500");
    expect(body.error).toMatch(/record/i);
    expect(body.error).not.toMatch(/[—–*]/);
  });
});

describe("what the job row claims was submitted", () => {
  it("counts every row a vendor is asked about, queued rows included", async () => {
    // records_submitted is the DENOMINATOR of the match rate, read back by the
    // v1 status route, the bulk_job.completed webhook and the history page. A
    // tier 2 row is billed, so leaving it out understates the work the customer
    // paid for. MUTATION: drop the tier 2 term and this goes red.
    await post([
      rec("John Smith", 1),
      rec("Acme Holdings Llc", 2),
      rec(undefined, 3),
      rec("   ", 4),
    ]);
    expect(jobInsert()?.records_submitted).toBe(4);
  });

  it("agrees with the dashboard route, which counts its queued rows too", async () => {
    // Two routes writing the same column with two different meanings is how a
    // reported match rate ends up depending on which door the batch came in.
    await post([rec(undefined, 1), rec(undefined, 2)]);
    expect(jobInsert()?.records_submitted).toBe(2);
  });

  it("still counts every uploaded row as total_records", async () => {
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(jobInsert()?.total_records).toBe(2);
    expect(jobInsert()?.records_submitted).toBe(2);
    expect(body.recordsQueued).toBe(1);
  });
});

describe("what the caller is told", () => {
  it("reports the queued count and where to poll", async () => {
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.recordsQueued).toBe(1);
    expect(body.message).toContain("job-1");
  });

  it("no longer claims a blank-owner row was skipped and not charged", async () => {
    // It is neither. Saying so would be a false statement about money in the
    // direction that matters: the customer WILL be billed for this row.
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.recordsSkipped ?? 0).toBe(0);
    expect(body.skippedReason).toBeUndefined();
    expect(String(body.message)).not.toContain("not charged");
  });

  it("says nothing about queueing when nothing was queued", async () => {
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(body.recordsQueued).toBe(0);
  });
});
