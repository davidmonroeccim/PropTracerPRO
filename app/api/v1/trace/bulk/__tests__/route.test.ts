import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { BLANK_OWNER_SKIP_STATUS } from "@/lib/trace/blankOwnerSkip";
import { TRACE_SOURCE, chargePerRecord, chargePerTrace } from "@/lib/suite/pricing";
import {
  PROPERTY_TRACE_NO_KEY_REASON,
  PROPERTY_TRACE_NO_KEY_STATUS,
  isPropertyTracePending,
  queuedStatusFor,
} from "@/lib/trace/propertyTraceAttempts";
import { TIER1_QUEUED_STATUSES, tier1QueuedStatusFor } from "@/lib/trace/tier1Queue";
import { TIER1_OUTCOME } from "@/lib/trace/tier1Outcome";
import { TIER2_CAPACITY_REFUSAL } from "@/lib/trace/bulkPreflight";
import {
  createAddressHash,
  normalizeAddress,
  traceKeyFor,
} from "@/lib/utils/address-normalizer";

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
  canRunTier2: true,
  inFlight: 0,
  upsertError: null as { message: string } | null,
  jobUpdateError: null as { message: string } | null,
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
      // `rec` is read at AWAIT time, not at definition time, so it is the op this chain ended up
      // being. Two writes get their own lever: the trace_history upsert, because that write IS the
      // submit on this surface now, and the trace_jobs update, because it is what makes a failed
      // submit terminal instead of a job that polls forever.
      node.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          rec?.op === "upsert" && rec.table === "trace_history"
            ? { data: null, error: H.upsertError }
            : rec?.op === "update" && rec.table === "trace_jobs"
              ? { data: null, error: H.jobUpdateError }
              : { data: null, error: null }
        ).then(res);
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
// There is no Tracerfy person submit on this route any more (Phase 2B, spec 3.3). The mock stays
// only so the tests below can assert it is NEVER called; what it would resolve with is irrelevant.
vi.mock("@/lib/tracerfy/client", () => ({
  submitBulkTrace: vi.fn(async () => ({ success: true, jobId: "tf-1" })),
}));
// The pre-flight module has its own unit tests. Here it is a lever, so these
// tests can ask what the ROUTE does with each answer. The refusal string stays
// REAL, because the copy rules apply to what the caller actually receives.
vi.mock("@/lib/trace/bulkPreflight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trace/bulkPreflight")>();
  return {
    ...actual,
    // Faithful to the real contract: a batch empty on BOTH tiers asks no vendor and can never be
    // refused. Without that short circuit here, a route passing the wrong counts would still look
    // correct, because every batch would reach the pool question.
    tracerfyCanRun: vi.fn(async (_admin: unknown, n: { tier1: number; tier2: number }) =>
      n.tier1 <= 0 && n.tier2 <= 0 ? true : H.canRunTier2,
    ),
    inFlightUnbilledCost: vi.fn(async () => H.inFlight),
  };
});

const { POST } = await import("@/app/api/v1/trace/bulk/route");
const { submitBulkTrace } = await import("@/lib/tracerfy/client");
const { tracerfyCanRun, inFlightUnbilledCost } = await import("@/lib/trace/bulkPreflight");
const { checkDuplicates } = await import("@/lib/utils/deduplication");

const TIER1 = PRICING.CHARGE_PER_SUCCESS_WALLET;
const TIER2 = 0.4; // wallet column, per record submitted

/**
 * One submitted record.
 *
 * `extra` overrides any field, and it exists because this route stopped rejecting the whole batch
 * over one bad record: the cases worth fencing now are the malformed ones (no city, no street, a
 * ZIP Excel mangled, a parcel id instead of a street), and they have to be expressible here rather
 * than in a second helper that drifts from this one.
 */
const rec = (owner_name?: string, n = 1, extra: Record<string, unknown> = {}) => ({
  owner_name,
  address: `${n} Main St`,
  city: "Dallas",
  state: "TX",
  zip: "75001",
  ...extra,
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
  H.canRunTier2 = true;
  H.inFlight = 0;
  H.upsertError = null;
  H.jobUpdateError = null;
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

  it("queues a NAMED entity on the Tier 1 queue, with the tier 2 column written null", async () => {
    // WAS "still queues a NAMED entity for the business trace, on its own queue", which asserted
    // the bare 'queued' of the LEGACY entity ladder. That value is claimed by the wrong lane of the
    // same cron and handed to FastAppend with no route planned (spec 3.2, D1).
    await post([rec("Acme Holdings Llc", 1)]);
    expect(historyRows()[0]).toMatchObject({
      ai_research_status: tier1QueuedStatusFor(1),
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

  it("sends a person to the Tier 1 queue instead of the Tracerfy bulk CSV", async () => {
    // WAS "still sends a person straight to the Tracerfy bulk CSV". There is no CSV on this surface
    // any more (spec 3.3): planRoute decides person-versus-company inside the cron, which is what
    // lets a city-less or parcel-keyed record trace at all.
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(submitBulkTrace).not.toHaveBeenCalled();
    // The response key survives at 0 rather than disappearing: a caller's branch keeps reading a
    // number it understands, and the work shows up in the count that is now true of it.
    expect(body.recordsDirectTrace).toBe(0);
    expect(body.recordsPendingResearch).toBe(1);
    expect(historyRows()[0]).toMatchObject({
      ai_research_status: tier1QueuedStatusFor(1),
      status: "processing",
    });
    // Written, not merely absent. See the entity test above.
    expect(Object.keys(historyRows()[0])).toContain("property_trace_status");
    expect(historyRows()[0].property_trace_status).toBeNull();
  });

  it("never sends a blank-owner record to the person CSV", async () => {
    // It has no owner to put in it: the dossier is what discovers one.
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

  it("is asked about BOTH tiers now, not the tier 2 records alone", async () => {
    // WAS "is asked about the tier 2 records only", with tier1: 0. That 0 was true while every named
    // record went to the Tracerfy BATCH endpoint, a different credit bucket from the per-record
    // lookups this check sizes. They are on the queue now and draw on the same pool.
    await post([rec("John Smith", 1), rec("Acme Holdings Llc", 2), rec(undefined, 3)]);
    expect(tracerfyCanRun).toHaveBeenCalledWith(expect.anything(), { tier1: 2, tier2: 1 });
  });

  it("now DOES refuse a batch of named records when the pool is short", async () => {
    // THE CONSEQUENCE OF THE COUNT, and the direction that protects other customers: 500 named
    // records used to pass this gate unexamined and could drain the shared pool. MUTATION: pass
    // tier1: 0 again and this goes red.
    H.canRunTier2 = false;
    const res = await post([rec("John Smith", 1)]);
    expect(res.status).toBe(503);
    expect(H.ops).toHaveLength(0);
  });

  it("never refuses a batch nobody can be asked about", async () => {
    // A no-key row asks no vendor anything, so there is nothing for the pool to cover and a refusal
    // would be PTP's outage charged against a caller whose batch we were never going to send.
    H.canRunTier2 = false;
    const res = await post([rec(undefined, 1, { address: "", state: "" })]);
    expect(res.status).not.toBe(503);
    expect(tracerfyCanRun).toHaveBeenCalledWith(expect.anything(), { tier1: 0, tier2: 0 });
  });
});

/**
 * THE ROW WRITE IS THE SUBMIT NOW, SO A FAILED WRITE IS A FAILED JOB.
 *
 * REPLACES "when the Tracerfy person submit fails" (10 tests). That block fenced a real and
 * carefully reasoned partial failure: the person CSV submit could fail while the entity and tier 2
 * rows survived, so the route corrected records_submitted, wrote the person rows terminal, requoted
 * for the survivors and told the caller which half failed and that it was free. Phase 2B deletes
 * that submit, so there is no partial failure left to describe -- every accepted row is written to
 * one of the two queues and nothing else happens before this handler returns.
 *
 * What replaced it is a WORSE failure with a smaller surface: the three upsert sites used to
 * console.error and carry on. With no vendor call left between the caller and the database, a
 * swallowed upsert error means this route answers success with records_submitted counting rows that
 * were never written, and app/api/v1/trace/bulk/status then finalizes the job `completed` with
 * records_matched 0 on its first poll and answers every later poll from those stored stats. The
 * caller sent 500 rows, was told it worked, and polls an empty results array forever.
 */
describe("when the rows cannot be written", () => {
  const failedJob = () =>
    H.ops.find(
      (o) =>
        o.table === "trace_jobs" &&
        o.op === "update" &&
        (o.payload as Record<string, unknown>)?.status === "failed"
    );

  beforeEach(() => {
    H.upsertError = { message: "deadlock detected" };
  });

  // MUTATION: swallow the insert error with console.error and return, and this goes red.
  it("fails the job and answers 500 when the row write fails", async () => {
    const res = await post([rec("Jane Smith", 1)]);
    expect(res.status).toBe(500);
    expect(failedJob()?.payload).toMatchObject({ status: "failed" });
  });

  it("does NOT answer success, which is what hid this before", async () => {
    // THE WHOLE DEFECT IN ONE ASSERTION. The only report of the failure was a console line on a
    // server the caller cannot read.
    const res = await post([rec("Jane Smith", 1), rec("John Smith", 2)]);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
    expect(body.jobId).toBeUndefined();
  });

  it("writes the job terminal, so the status route cannot finalize it as an empty success", async () => {
    // A 500 alone is not enough. THE JOB MUST REACH A TERMINAL STATE: the Suite Gateway and this API
    // both poll the job for completion, and a job parked at 'processing' never completes for them.
    await post([rec("Jane Smith", 1)]);
    const payload = failedJob()?.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    // The FIXED GENERIC sentence David approved, never the raw Postgres text, because this
    // surface's status route returns error_message to the caller verbatim.
    expect(payload!.error_message).toBe(
      "We could not finish starting your upload. Some records may already be running, so check your results before uploading those addresses again."
    );
    // NO "not charged" claim: a part-way failure can leave rows already written and billable, so
    // that claim would be a false statement about money.
    expect(String(payload!.error_message)).not.toMatch(/not charged/i);
    expect(String(payload!.error_message)).not.toMatch(/[—–*]/);
  });

  it("keeps the detailed failure in the server log, so generalizing the caller's sentence loses nothing", async () => {
    await post([rec("Jane Smith", 1)]);
    expect(console.error).toHaveBeenCalledWith(
      "API v1 bulk trace - failed to enqueue rows:",
      expect.stringContaining("deadlock detected")
    );
  });

  it("stops at the FIRST failed batch rather than reporting on rows it never tried", async () => {
    // records_submitted is the denominator of the match rate. Carrying on past a failed batch and
    // then answering with a count that includes it is the same lie in a smaller size.
    await post([rec("Jane Smith", 1), rec(undefined, 2), rec(undefined, 3, { address: "", state: "" })]);
    const upserts = H.ops.filter((o) => o.table === "trace_history" && o.op === "upsert");
    expect(upserts).toHaveLength(1);
  });

  it("logs the job id when it cannot even write the job terminal, so it stays findable", async () => {
    // The last line of defence, and the only action available: the caller is already being told this
    // failed, so there is no success to withdraw. But a job left at 'processing' polls forever for
    // the Suite Gateway and this API, and with nothing logged the operator has no way to find it.
    H.jobUpdateError = { message: "connection reset" };
    const res = await post([rec("Jane Smith", 1)]);
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      "API v1 bulk trace - job left NOT terminal after a failed enqueue:",
      "job-1",
      expect.stringContaining("connection reset")
    );
  });

  it("fails the job whichever bucket was being written when it broke", async () => {
    // The guard the old block spent four tests on was "do not fail the job while OTHER work is
    // queued", and it existed because one vendor call could fail while written rows survived. There
    // is no such asymmetry now: a failed write means rows this response would have counted do not
    // exist, whatever bucket they were in, so the job is failed and the caller is told.
    const res = await post([rec(undefined, 1), rec("Jane Smith", 2)]);
    expect(res.status).toBe(500);
    expect(failedJob()).toBeDefined();
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
    //
    // recordsSkipped is asserted WITHOUT `?? 0` now. It used to be absent from this response, so
    // `?? 0` was satisfied by the key not existing; it is always present since the owner's ruling,
    // and 0 has to be a number this route wrote rather than a hole a reader fills in.
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.recordsSkipped).toBe(0);
    expect(body.skippedReason).toBeUndefined();
    expect(String(body.message)).not.toContain("not charged");
  });

  it("counts the rows nobody could be asked about, and says why", async () => {
    // THE OWNER'S RULING. A no-key row appears in totalRecords and in no other count, so before
    // this the only way to learn it existed was to subtract. recordsSkipped and skippedReason carry
    // the dashboard route's meaning exactly, and the reason is the approved constant rather than a
    // sentence written here. MUTATION: drop either field from the response and this goes red.
    // TWO no-key rows, and they need DISTINCT streets to stay two rows. A record with no street and
    // no state keys on `||` whatever its city, so two of those are one record by the time dedup has
    // finished -- today's recorded collision risk for the fallback key (spec 6.3), not a defect of
    // this change. A file whose state column never got mapped is the realistic shape anyway.
    const body = await (
      await post([
        rec(undefined, 1, { state: "" }),
        rec(undefined, 2, { state: "" }),
        rec("Jane Smith", 3),
      ])
    ).json();
    expect(body.recordsSkipped).toBe(2);
    expect(body.skippedReason).toBe(PROPERTY_TRACE_NO_KEY_REASON);
    // It is a count of rows NOT being worked, so it must not leak into the ones that are, nor into
    // the quote: a skipped row is free.
    expect(body.recordsToProcess).toBe(1);
    expect(body.totalRecords).toBe(3);
    expect(body.estimatedCost).toBeCloseTo(TIER1);
  });

  it("keeps recordsQueued meaning the TIER 2 queue, and reports Tier 1 in its own key", async () => {
    // RE-DERIVED. It used to read "says nothing about queueing when nothing was queued", and a
    // named record was genuinely not queued anywhere: it went straight into the Tracerfy CSV. It IS
    // queued now, on the Tier 1 column. recordsQueued keeps its documented meaning (the tier 2
    // queue) so an existing caller's number does not silently change what it counts, and the Tier 1
    // work is reported in recordsPendingResearch, which is the cron that owns it.
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(body.recordsQueued).toBe(0);
    expect(body.recordsPendingResearch).toBe(1);
    expect(body.recordsToProcess).toBe(1);
    // And the row really is on the queue, so the 0 above is not hiding a dropped record.
    expect(historyRows()[0].ai_research_status).toBe(tier1QueuedStatusFor(1));
  });

  it("tells a caller IN WORDS about rows nobody could be looked up, not only in a count", async () => {
    // The sentence is the one the dashboard route already uses, and it is the one reason allowed to
    // invite a resend, because supplying the missing street or state genuinely changes the key and
    // produces a record that runs. recordsSkipped carries the number; this carries the fix.
    const body = await (
      await post([rec(undefined, 1, { address: "", state: "" }), rec("Jane Smith", 2)])
    ).json();
    expect(body.message).toContain("1 records could not be looked up.");
    expect(body.message).toContain("Send it again with the full property address");
    expect(body.message).not.toMatch(/[—–*]/);
  });
});

/* ------------------------------------------------------------------ *
 * PHASE 2B: EVERY RECORD IS JUDGED ON ITS OWN.
 *
 * One bad record used to 400 the whole batch, and the validation it was judged
 * by included the ZIP, so a leading zero Excel had stripped killed a 500-record
 * file at the door. Records are judged one at a time now, and only a record no
 * vendor can be asked about at all is filed no-key.
 * ------------------------------------------------------------------ */

describe("per-record judging replaces the whole-batch 400", () => {
  // MUTATION: restore the `if (invalidRecords.length > 0) return 400` block and this goes red.
  it("runs the good records when one record has no city", async () => {
    const res = await post([
      rec("Jane Smith", 1),
      rec("John Doe", 2, { city: "" }),
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recordsToProcess).toBe(2);
    expect(historyRows()).toHaveLength(2);
  });

  // The ZIP is the sharpest case: Excel strips a leading zero on export, so the four-argument
  // validate killed entire New England and Puerto Rico files.
  it("does not reject a batch over a malformed ZIP", async () => {
    const res = await post([rec("Jane Smith", 1, { zip: "2139" })]);
    expect(res.status).toBe(200);
    // THE CONSEQUENCE, not the status code: the row runs, and the mangled ZIP is dropped at the
    // write by usableZip rather than stored and sent to a vendor to contradict its own street.
    const row = historyRows()[0];
    expect(row.ai_research_status).toBe(tier1QueuedStatusFor(1));
    expect(row.zip).toBe("");
  });

  it("files a BLANK-OWNER record with no street and no state as no-key, free, without queueing it", async () => {
    // Blank owner, because the no-key bucket is only ever reachable from a blank owner: a record
    // with an owner name is Tier 1 whatever its address, and settles inside the cron.
    await post([rec(undefined, 1, { address: "", state: "" })]);
    const row = historyRows()[0];
    expect(row.property_trace_status).toBe(PROPERTY_TRACE_NO_KEY_STATUS);
    expect(row.ai_research_status).toBeNull();
    expect(row.status).toBe("no_match");
    expect(row.charge ?? 0).toBe(0);
  });

  it("never files a NAMED record as no-key, however broken its address (D4)", async () => {
    // The rule Step 3 states in as many words: a Tier 1 record is never no-key at submit. A company
    // traces on name and state alone, and a person with no lookup key settles no_lookup_key, free,
    // with a sentence, INSIDE the cron. Filing it no-key here would deny both of them the route
    // that exists for them.
    await post([rec("Jane Smith", 1, { address: "", state: "" })]);
    const row = historyRows()[0];
    expect(row.ai_research_status).toBe(tier1QueuedStatusFor(1));
    expect(row.property_trace_status).toBeNull();
  });

  it("treats an ABSENT field as an empty one, so one missing key cannot kill the batch", async () => {
    // WHOLE-BATCH REJECTION THROUGH A DIFFERENT DOOR, in the task that exists to delete it. The key
    // derivation is the only place that disagreed: traceKeyFor takes `state: string` and threw on an
    // absent one inside removeBatchDuplicates, before any per-record judging happened, so one record
    // omitting a key returned a 500 for all 500. That told an integrator WE broke rather than that
    // their record was unusable.
    //
    // Absent and empty are the same fact -- the caller gave us no state -- and this route already
    // treats them the same everywhere else (`record.state || ''` in the row builder). Normalising is
    // not fabricating a value: the row still lands no-key, free, with a reason.
    // MUTATION: drop the normalisation and this goes red with a 500.
    const res = await post([
      { owner_name: "", address: "1 Main St", city: "Dallas" },
      rec("Jane Smith", 2),
    ]);
    expect(res.status).toBe(200);
    const rows = historyRows();
    expect(rows).toHaveLength(2);
    // The survivor runs.
    const named = rows.find((r) => r.input_owner_name === "Jane Smith");
    expect(named!.ai_research_status).toBe(tier1QueuedStatusFor(1));
    // The record that omitted `state` is judged exactly as one sending state: "" would be.
    const stateless = rows.find((r) => r.input_owner_name === null);
    expect(stateless!.property_trace_status).toBe(PROPERTY_TRACE_NO_KEY_STATUS);
    expect(stateless!.status).toBe("no_match");
    expect(stateless!.state).toBe("");
    const body = await res.json();
    expect(body.recordsSkipped).toBe(1);
    expect(body.recordsToProcess).toBe(1);
  });

  it("charges nothing for a no-key row and still bills the survivors beside it", async () => {
    // The quote is the other half of "free": a no-key row that reached the estimate would be a
    // charge for a vendor call nobody makes.
    const body = await (
      await post([rec(undefined, 1, { address: "", state: "" }), rec("Jane Smith", 2)])
    ).json();
    expect(body.estimatedCost).toBeCloseTo(TIER1);
  });
});

describe("the Tier 1 enqueue", () => {
  // ASSERT THE CONSEQUENCE, NOT THE FIELD (L-036): tier1_queued is the value the cron's
  // .in(TIER1_QUEUED_STATUSES) claim actually matches. A bare 'queued' would be handed to
  // FastAppend on the owner name with no route planned at all.
  it("queues a named record onto the TIER 1 queue, not the legacy entity ladder", async () => {
    await post([rec("Acme Holdings Llc", 1)]);
    const row = historyRows()[0];
    expect(row.ai_research_status).toBe(tier1QueuedStatusFor(1));
    expect(TIER1_QUEUED_STATUSES).toContain(row.ai_research_status);
    expect(row.ai_research_status).not.toBe("queued");
    expect(row.status).toBe("processing");
    // WRITTEN null, not omitted: the upsert reuses this row, and a stale CSV-era tracerfy_job_id
    // would let the CSV settle paths bill a row the Tier 1 cron also owns.
    expect(Object.keys(row)).toContain("tracerfy_job_id");
    expect(row.tracerfy_job_id).toBeNull();
  });

  it("makes no person/entity distinction at submit any more", async () => {
    await post([rec("Acme Holdings Llc", 1), rec("Jane Smith", 2)]);
    const rows = historyRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ai_research_status === tier1QueuedStatusFor(1))).toBe(true);
  });

  it("never builds a Tracerfy person CSV", async () => {
    await post([rec("Jane Smith", 1)]);
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });

  // MUTATION: change tier1: tier1Records.length back to tier1: 0 and this goes red.
  it("sizes the credit pool against the real Tier 1 count", async () => {
    await post([rec("Jane Smith", 1), rec(undefined, 2)]);
    expect(tracerfyCanRun).toHaveBeenCalledWith(expect.anything(), { tier1: 1, tier2: 1 });
  });

  it("tags every row it writes with the API source, so a live check can tell them apart", async () => {
    await post([rec("Jane Smith", 1), rec(undefined, 2), rec(undefined, 3, { city: "" })]);
    const rows = historyRows();
    expect(rows).toHaveLength(3);
    // The literal as well as the constant: TRACE_SOURCE.API does not exist before this task, and
    // `undefined === undefined` would have let an unwritten tag pass as a written one.
    for (const row of rows) {
      expect(row.source).toBe(TRACE_SOURCE.API);
      expect(row.source).toBe("api");
    }
  });
});

describe("the duplicate key aligns with the single surfaces (spec 6.3, D36)", () => {
  // MUTATION: put normalizeAddress back in buildHistoryRow and this goes red. The dedup hash
  // and the stored hash would then disagree for any parcel-keyed record, and the same address
  // sent through single and bulk would land on two rows.
  it("keys a city-less record on its parcel, exactly as traceKeyFor does", async () => {
    const record = {
      address: "",
      city: "",
      state: "TX",
      owner_name: "Jane Smith",
      apn: "R-123",
      county: "Travis",
    };
    await post([record]);
    const row = historyRows()[0];
    expect(row.normalized_address).toBe(traceKeyFor(record));
    expect(row.normalized_address).toBe("APN|R-123|TRAVIS|TX");
    expect(row.address_hash).toBe(createAddressHash(traceKeyFor(record)));
    // THE DIVERGENCE THIS EXISTS TO STOP. checkDuplicates already hashes with traceKeyFor; the row
    // builder stored normalizeAddress. For a parcel-keyed record those are two different keys, so
    // the row dedup looked for is not the row that was written.
    expect(row.address_hash).not.toBe(createAddressHash(normalizeAddress("", "", "TX")));
  });

  it("stores the parcel id and county it was given (D23)", async () => {
    await post([rec("Jane Smith", 1, { apn: "R-123", county: "Travis" })]);
    const row = historyRows()[0];
    expect(row.parcel_id_local).toBe("R-123");
    expect(row.county).toBe("Travis");
  });
});

describe("D33: a reused row does not answer with a stale outcome", () => {
  it("clears outcome_code, found_by and trace_steps on a reused row", async () => {
    await post([rec("Jane Smith", 1)]);
    expect(historyRows()[0]).toMatchObject({
      outcome_code: null,
      found_by: null,
      trace_steps: null,
    });
  });

  it("does NOT clear them on a busy resume, which needs the step log", async () => {
    // The one exemption, and it is money: a busy row's step log is what stops the resend buying
    // the answers this record already paid for.
    vi.mocked(checkDuplicates).mockResolvedValueOnce({
      newRecords: [rec("Jane Smith", 1)],
      duplicates: [],
      cachedResults: [
        {
          address_hash: createAddressHash(traceKeyFor(rec("Jane Smith", 1))),
          outcome_code: TIER1_OUTCOME.BUSY_TRY_AGAIN,
        },
      ],
    } as unknown as Awaited<ReturnType<typeof checkDuplicates>>);
    await post([rec("Jane Smith", 1)]);
    const row = historyRows()[0];
    expect(row.outcome_code).toBeUndefined();
    expect(row.found_by).toBeUndefined();
    expect(row.trace_steps).toBeUndefined();
    expect(row.ai_research_status).toBe(tier1QueuedStatusFor(1));
  });
});
