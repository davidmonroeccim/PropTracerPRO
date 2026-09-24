import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { BLANK_OWNER_SKIP_STATUS } from "@/lib/trace/blankOwnerSkip";
import { TRACE_SOURCE, chargePerTrace, chargePerRecord } from "@/lib/suite/pricing";
import {
  PROPERTY_TRACE_NO_KEY_STATUS,
  isPropertyTracePending,
  queuedStatusFor,
} from "@/lib/trace/propertyTraceAttempts";
import { TIER2_CAPACITY_REFUSAL } from "@/lib/trace/bulkPreflight";
import { createAddressHash } from "@/lib/utils/address-normalizer";

/**
 * Money fences for the DASHBOARD bulk-trace submit route (Track A).
 *
 * WHAT CHANGED ON 2026-09-18, AND WHY THESE TESTS LOOK DIFFERENT FROM THE ONES
 * THEY REPLACE. Until now a bulk row with no owner of record was ACCEPTED AND
 * SKIPPED, free, because nothing on the bulk path could resolve an owner from an
 * address alone. Phase 5c built the engine that can: a Tracerfy property dossier
 * finds the owner of record, then a contact lookup resolves them. David's
 * decision, 2026-09-17, is that a blank-owner bulk row now runs that Full
 * Property Trace AUTOMATICALLY, the same as a single trace.
 *
 * So the row stops being free and starts being ENQUEUED, and the tests that
 * fenced it as free are now fencing the opposite rule. 273 of 1,270 historical
 * bulk rows arrived blank-owner, so this is a real change to what existing bulk
 * users are billed, and every number below is load-bearing for that.
 *
 * The one row that is still free is the one no vendor can be ASKED about: no
 * street, no city, or no state. That is a different fact from a missing owner
 * and it gets a different sentence.
 */

type Op = { table: string; op: string; payload?: unknown; opts?: unknown };

const H = vi.hoisted(() => ({
  ops: [] as Array<{ table: string; op: string; payload?: unknown; opts?: unknown }>,
  profile: {} as Record<string, unknown>,
  job: { id: "job-1" } as Record<string, unknown> | null,
  canRunTier2: true,
  inFlight: 0,
  upsertError: null as { message: string } | null,
}));

function recordingClient() {
  return {
    from(table: string) {
      const node: Record<string, unknown> = {};
      let rec: Op | null = null;
      const add = () => () => node;
      for (const m of ["eq", "select"]) node[m] = add();
      node.single = async () => ({ data: H.job, error: null });
      // `rec` is read at AWAIT time, not at definition time, so it is the op this chain ended up
      // being. Scoped to the trace_history upsert because that is the only write whose failure this
      // route has to survive differently from a thrown exception.
      node.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          rec?.op === "upsert" && rec.table === "trace_history"
            ? { data: null, error: H.upsertError }
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
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => {
      const node: Record<string, unknown> = {};
      node.select = () => node;
      node.eq = () => node;
      node.single = async () => ({ data: H.profile, error: null });
      return node;
    },
  }),
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
// There is no Tracerfy person submit on this route any more (Phase 2A). The mock stays only so
// the tests below can assert it is NEVER called; what it would resolve with is irrelevant.
vi.mock("@/lib/tracerfy/client", () => ({
  submitBulkTrace: vi.fn(async () => ({ success: true, jobId: "tf-1" })),
}));
// The pre-flight module has its own unit tests (lib/trace/__tests__/bulkPreflight.test.ts).
// Here it is a lever, so these tests can ask what the ROUTE does with each answer.
// TIER2_CAPACITY_REFUSAL stays REAL, because the copy rules apply to the string
// the customer actually receives.
vi.mock("@/lib/trace/bulkPreflight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trace/bulkPreflight")>();
  return {
    ...actual,
    // Faithful to the real contract: a batch empty on BOTH tiers asks no vendor and can never be
    // refused. Without that short circuit here, a route that passed records.length instead of the
    // two counts separately would still look correct, because every batch would reach the pool
    // question.
    tracerfyCanRun: vi.fn(async (_admin: unknown, n: { tier1: number; tier2: number }) =>
      n.tier1 <= 0 && n.tier2 <= 0 ? true : H.canRunTier2,
    ),
    inFlightUnbilledCost: vi.fn(async () => H.inFlight),
  };
});

const { POST } = await import("@/app/api/trace/bulk/route");
const { submitBulkTrace } = await import("@/lib/tracerfy/client");
const { tracerfyCanRun, inFlightUnbilledCost } = await import("@/lib/trace/bulkPreflight");
const { checkDuplicates } = await import("@/lib/utils/deduplication");

const TIER1 = PRICING.CHARGE_PER_SUCCESS_WALLET;
const TIER2 = 0.4; // wallet column, per record submitted

const rec = (owner_name?: string, n = 1) => ({
  owner_name,
  address: `${n} Main St`,
  city: "Dallas",
  state: "TX",
  zip: "75001",
});

/** A blank-owner record no vendor can be asked about: no city. */
const noKeyRec = (n = 1) => ({
  owner_name: "",
  address: `${n} Main St`,
  city: "",
  state: "TX",
  zip: "75001",
});

/**
 * A blank-owner record with a complete address and a BROKEN ZIP.
 *
 * '02134' is what a Boston county file holds and '2134' is what Excel writes out
 * of it, on every row of the file, for MA, NJ, CT, RI, NH, ME, VT and PR alike.
 */
const mangledZipRec = (n = 1) => ({
  owner_name: "",
  address: `${n} Beacon St`,
  city: "Boston",
  state: "MA",
  zip: "2134",
});

function post(records: unknown[]) {
  return POST(
    new Request("http://localhost/api/trace/bulk", {
      method: "POST",
      body: JSON.stringify({ records, fileName: "leads.csv" }),
      headers: { "content-type": "application/json" },
    })
  );
}

/** Every trace_history row upserted, flattened. */
const historyRows = () =>
  H.ops
    .filter((o) => o.table === "trace_history" && o.op === "upsert")
    .flatMap((o) => o.payload as Array<Record<string, unknown>>);

beforeEach(() => {
  vi.clearAllMocks();
  H.ops = [];
  H.job = { id: "job-1" };
  H.canRunTier2 = true;
  H.inFlight = 0;
  H.upsertError = null;
  H.profile = {
    id: "user-1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    wallet_balance: 100,
  };
  delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/* ------------------------------------------------------------------ *
 * TASK 15: THE ENQUEUE. The capability the whole of phase 5c exists for.
 * ------------------------------------------------------------------ */

describe("a row with no owner name", () => {
  it("is ENQUEUED for a Full Property Trace, not skipped", async () => {
    // THE CENTRAL CHANGE. MUTATION: push it to skippedRecords again and this
    // goes red. Nothing else in phase 5c runs until this row reaches the queue:
    // the cron claims on this column and returns processed: 0 without it.
    await post([rec(undefined, 1)]);
    expect(historyRows()).toHaveLength(1);
    expect(historyRows()[0]).toMatchObject({
      property_trace_status: queuedStatusFor(1),
      status: "processing",
      trace_job_id: "job-1",
    });
  });

  it("lands on a rung the cron actually claims", async () => {
    // Not a spelling check. The cron claims `.in('property_trace_status',
    // PROPERTY_TRACE_QUEUED_STATUSES)`, so a row written with any other value
    // is never picked up and never runs, silently and forever.
    await post([rec(undefined, 1)]);
    expect(isPropertyTracePending(String(historyRows()[0].property_trace_status))).toBe(true);
  });

  it("stops being written as a blank-owner skip", async () => {
    // BLANK_OWNER_SKIP_STATUS is now HISTORICAL. It still has to be readable for
    // the 273 rows already carrying it, but nothing may write it for a merely
    // missing owner any more: that row is no longer free and no longer skipped.
    await post([rec(undefined, 1)]);
    expect(historyRows()[0].ai_research_status ?? null).toBeNull();
    expect(historyRows()[0].ai_research_status).not.toBe(BLANK_OWNER_SKIP_STATUS);
  });

  it("goes on the TIER 2 queue only, never the Tier 1 one", async () => {
    // It used to assert that this row stayed out of the Tracerfy person CSV. There is no such CSV
    // from this surface any more (spec 3.3), and the question underneath it is still live and now
    // sharper: the two queues share nothing, and a blank-owner row on the TIER 1 rung would be
    // planned as a tier 2 record and refused by runTier1Record (NotATier1PlanError) after burning a
    // claim, or worse, have a $0.20 dossier bought for it and billed at the tier 1 rate.
    await post([rec("John Smith", 1), rec(undefined, 2)]);
    const byAddress = new Map(historyRows().map((r) => [r.normalized_address, r]));
    const blankOwner = byAddress.get("2 MAIN ST|DALLAS|TX")!;
    expect(blankOwner.property_trace_status).toBe("queued");
    expect(blankOwner.ai_research_status).toBeNull();
    const named = byAddress.get("1 MAIN ST|DALLAS|TX")!;
    expect(named.ai_research_status).toBe("tier1_queued");
    expect(named.property_trace_status).toBeNull();
  });

  it("carries no tracerfy_job_id, so no status route settles it", async () => {
    // bulk/status finds its billable rows by that column. A queued tier 2 row
    // holding one would be settled and billed at the TIER 1 rate by the wrong
    // engine, before the cron ever saw it.
    await post([rec(undefined, 1)]);
    expect(historyRows()[0].tracerfy_job_id ?? null).toBeNull();
  });

  it("writes nothing money-shaped at submit, because nothing has been billed yet", async () => {
    // The cron bills this row when the dossier answers. Writing a charge here
    // would book revenue before a vendor was asked.
    await post([rec(undefined, 1)]);
    for (const paid of ["charge", "ai_research_charge", "tier", "property_record"]) {
      expect(Object.keys(historyRows()[0])).not.toContain(paid);
    }
  });
});

/* ------------------------------------------------------------------ *
 * THE ROW THAT IS STILL FREE, AND IT IS A DIFFERENT ROW.
 * ------------------------------------------------------------------ */

describe("a blank-owner row no vendor can be asked about", () => {
  it("is written terminal as no-key, not queued", async () => {
    // planRoute emits no step at all for a parcel with no city, so queueing it
    // would burn five claim slots asking an unanswerable question.
    await post([noKeyRec(1)]);
    expect(historyRows()[0]).toMatchObject({
      property_trace_status: PROPERTY_TRACE_NO_KEY_STATUS,
      status: "no_match",
    });
    expect(isPropertyTracePending(String(historyRows()[0].property_trace_status))).toBe(false);
  });

  it("is NOT written as a blank-owner skip, whose advice would be false here", async () => {
    // BLANK_OWNER_SKIP_REASON ends "send it again with the owner of record and
    // we will run it". For a row missing its city, doing exactly that still
    // will not run. The no-key sentence names the real fix.
    await post([noKeyRec(1)]);
    expect(historyRows()[0].ai_research_status ?? null).toBeNull();
  });

  it("is free, and reserves nothing", async () => {
    // MUTATION: count it into the estimate and this goes red. It is the one
    // blank-owner row that still costs nothing, because no vendor is asked.
    const body = await (await post([noKeyRec(1)])).json();
    expect(body.estimated_cost).toBe(0);
    expect(body.records_skipped).toBe(1);
  });

  it("tells the customer what to fix, and that they were not charged", async () => {
    const body = await (await post([noKeyRec(1)])).json();
    expect(body.skipped_reason).toContain("not charged");
    expect(body.skipped_reason).toMatch(/street, city or state/);
  });
});

/* ------------------------------------------------------------------ *
 * AND THE ROW THAT IS NOT THAT ROW, THOUGH IT WAS TREATED AS ONE.
 *
 * A complete street, city and state with a mangled ZIP is LOOKUPABLE. The tier
 * split validated it with validateAddressInput, which carries a 5-or-9-digit
 * ZIP rule, so the row was filed as no-key and told it was missing the street,
 * city or state it plainly had -- then locked out of the resend that sentence
 * invites, because address_hash excludes the ZIP entirely and a corrected
 * resend hashes identically.
 * ------------------------------------------------------------------ */

describe("a blank-owner row whose only fault is its ZIP", () => {
  it("is ENQUEUED for the full property trace, which is what this phase exists for", async () => {
    // MUTATION: put the zip argument back on the tier split's
    // validateAddressInput call and this goes red. Every MA, NJ, CT, RI, NH, ME,
    // VT and PR file exported through Excel is this row, on every line.
    await post([mangledZipRec(1)]);
    expect(historyRows()).toHaveLength(1);
    expect(historyRows()[0]).toMatchObject({
      property_trace_status: queuedStatusFor(1),
      status: "processing",
    });
    expect(historyRows()[0].property_trace_status).not.toBe(PROPERTY_TRACE_NO_KEY_STATUS);
  });

  it("is quoted and counted as the billed work it now is", async () => {
    const body = await (await post([mangledZipRec(1)])).json();
    expect(body.records_submitted).toBe(1);
    expect(body.records_queued).toBe(1);
    expect(body.estimated_cost).toBeCloseTo(TIER2);
  });

  it("is never handed the no-key sentence, whose advice would fail here", async () => {
    // The sentence ends "Send it again with the full property address and we
    // will run it". For this row the address was already full, and the resend
    // hashes to the same key and is dropped as a duplicate for 90 days, so
    // following the instruction cannot work. It keeps its resend line only
    // because the population that receives it can genuinely act on it.
    const body = await (await post([mangledZipRec(1)])).json();
    expect(body.records_skipped).toBe(0);
    expect(body.skipped_reason).toBeUndefined();
  });

  it("drops the broken ZIP rather than sending it on to the dossier", async () => {
    // A zip that contradicts the street, city and state it travels with is worse
    // than none: the dossier accepts address mode with no zip and BACKFILLS the
    // property's own on a hit, and tier 2 bills per record submitted, so a miss
    // we caused with our own mangled input is one the customer pays for.
    // MUTATION: store record.zip unfiltered and this goes red.
    await post([mangledZipRec(1)]);
    expect(historyRows()[0].zip).toBe("");
  });

  it("keeps a ZIP that is a ZIP, and trims a 9-digit one to 5", async () => {
    // The guard may not become a blanket discard: a real zip is worth sending.
    await post([
      { owner_name: "", address: "1 Main St", city: "Dallas", state: "TX", zip: "75001" },
      { owner_name: "", address: "2 Main St", city: "Dallas", state: "TX", zip: "75001-1234" },
    ]);
    expect(historyRows()[0].zip).toBe("75001");
    expect(historyRows()[1].zip).toBe("75001");
  });

  it("still files a row genuinely missing a component as no-key", async () => {
    // The narrowing is to the ZIP alone. A row with no city has nothing any
    // vendor can be asked about and planRoute emits no step for it at all.
    await post([noKeyRec(1)]);
    expect(historyRows()[0]).toMatchObject({
      property_trace_status: PROPERTY_TRACE_NO_KEY_STATUS,
      status: "no_match",
    });
  });
});

/* ------------------------------------------------------------------ *
 * TASK 8: THE ESTIMATE. Blank rows stop being free, so every estimate
 * that excluded them now under-quotes the customer.
 * ------------------------------------------------------------------ */

describe("the submit estimate", () => {
  it("charges a blank-owner row the TIER 2 per-record rate", async () => {
    // MUTATION: leave blanks out of the estimate and this goes red. It is the
    // line that used to make them free.
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.estimated_cost).toBeCloseTo(TIER2);
  });

  it("adds the two tiers rather than pricing the batch at one rate", async () => {
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(body.estimated_cost).toBeCloseTo(TIER1 + TIER2);
    // The two rates are genuinely different, or this test proves nothing.
    expect(TIER1).not.toBe(TIER2);
  });

  it("prices tier 2 per RECORD SUBMITTED, so a miss is still quoted", async () => {
    // Tier 1 is per successful trace and free on a miss. Tier 2 is not, and
    // quoting it as if it were would under-quote every job.
    const body = await (await post([rec(undefined, 1), rec(undefined, 2)])).json();
    expect(body.estimated_cost).toBeCloseTo(2 * TIER2);
  });

  it("counts queued rows as submitted work, because they are billed", async () => {
    // records_submitted is the DENOMINATOR of the match rate and the number the
    // job row claims was worked. A billed row missing from it understates the
    // work and overstates the rate.
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(body.records_submitted).toBe(2);
    const job = H.ops.find((o) => o.table === "trace_jobs" && o.op === "insert");
    expect(job!.payload).toMatchObject({ records_submitted: 2 });
  });

  it("leaves an unaskable row out of both numbers", async () => {
    const body = await (await post([rec(undefined, 1), noKeyRec(2)])).json();
    expect(body.records_submitted).toBe(1);
    expect(body.estimated_cost).toBeCloseTo(TIER2);
  });
});

/**
 * THIS ROUTE PRICES GRANT-AWARE, AND THE ONLY THING THAT CAN HIDE THAT IS A
 * FEATURE FLAG THAT IS OFF IN TESTS.
 *
 * hasSuiteAccess() is gated on NEXT_PUBLIC_SUITE_SIGNIN_ENABLED, which is false
 * here and TRUE in production. With the flag off a gateway grant counts for
 * nothing, the derivation collapses to the wallet column regardless, and a test
 * asserting that this route prices grant-aware passes under the correct
 * implementation and under a grant-blind one alike. That is L-009, and this
 * project has earned it twice. The probe at the end proves the flag is what
 * makes the difference possible.
 */
describe("the tier 2 rate this route quotes", () => {
  const GRANT_HOLDER = {
    id: "user-1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: ["prop-tracer-pro"],
    wallet_balance: 100,
  };

  it("quotes a grant holder the GRANT-AWARE tier 2 rate", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = { ...GRANT_HOLDER };
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.estimated_cost).toBeCloseTo(chargePerRecord(GRANT_HOLDER));
    expect(body.estimated_cost).toBeCloseTo(0.25);
    expect(body.estimated_cost).not.toBeCloseTo(TIER2);
  });

  it("proves the flag is load-bearing, so the test above is not a tautology", async () => {
    // WITHOUT this, the assertion above holds under an implementation that
    // ignores the grant entirely. Run the same case with the flag off and watch
    // the answer change.
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    H.profile = { ...GRANT_HOLDER };
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.estimated_cost).toBeCloseTo(TIER2);
    expect(body.estimated_cost).not.toBeCloseTo(0.25);
  });
});

/* ------------------------------------------------------------------ *
 * TASK 13: THE WALLET CHECK RESERVES, IT NO LONGER JUST COMPARES.
 * ------------------------------------------------------------------ */

describe("the wallet reserve", () => {
  it("sizes against work already accepted and not yet billed", async () => {
    // Two jobs submitted back to back both used to pass against the same
    // dollars. Settlement fails closed, so no customer was harmed and PTP
    // simply ate the vendor spend. MUTATION: drop the in-flight term and this
    // goes red.
    H.inFlight = 99.9;
    H.profile = { ...H.profile, wallet_balance: 100 };
    const res = await post([rec(undefined, 1)]);
    expect(res.status).toBe(402);
    expect(H.ops).toHaveLength(0);
  });

  it("prices in-flight work at THIS caller's two rates", async () => {
    await post([rec(undefined, 1)]);
    expect(inFlightUnbilledCost).toHaveBeenCalledWith(expect.anything(), "user-1", {
      tier1: chargePerTrace(H.profile),
      tier2: chargePerRecord(H.profile),
    });
  });

  it("still lets a wallet that covers both through", async () => {
    H.inFlight = 1;
    H.profile = { ...H.profile, wallet_balance: 1 + TIER2 };
    const res = await post([rec(undefined, 1)]);
    expect(res.status).not.toBe(402);
  });

  it("402s a wallet that cannot cover the batch alone", async () => {
    H.profile = { ...H.profile, wallet_balance: 0 };
    const res = await post([rec("John Smith", 1)]);
    expect(res.status).toBe(402);
    expect(H.ops).toHaveLength(0);
  });

  it("tells them about the funds, because that one IS their balance", async () => {
    H.profile = { ...H.profile, wallet_balance: 0 };
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(body.error.toLowerCase()).toContain("add funds");
    expect(body.error).not.toMatch(/[—–*]/);
  });
});

/* ------------------------------------------------------------------ *
 * TASK 7, CHECK 2: CAN PTP EXECUTE? A DIFFERENT QUESTION WITH A
 * DIFFERENT OWNER AND A DIFFERENT SENTENCE.
 * ------------------------------------------------------------------ */

describe("when PTP's own credit pool cannot cover the job", () => {
  beforeEach(() => {
    H.canRunTier2 = false;
  });

  it("refuses, and writes nothing at all", async () => {
    // Billing a customer for a job we cannot run is the outcome this check
    // exists to prevent, so it has to land before any row is inserted.
    const res = await post([rec(undefined, 1)]);
    expect(res.status).toBe(503);
    expect(H.ops).toHaveLength(0);
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });

  it("NEVER tells the customer to add funds", async () => {
    // David, 2026-09-18, binding. It is PTP's balance that is short, not
    // theirs, and pointing them at a top-up takes money for a fix that changes
    // nothing. MUTATION: return the 402 copy here and this goes red.
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.error).toBe(TIER2_CAPACITY_REFUSAL);
    expect(body.error.toLowerCase()).not.toContain("add funds");
    expect(body.error.toLowerCase()).not.toMatch(/your wallet|your balance/);
  });

  it("claims nobody was notified, because nobody was", async () => {
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.error.toLowerCase()).not.toMatch(/notif|alerted|our team/);
  });

  it("is asked about both tiers, counted separately", async () => {
    H.canRunTier2 = true;
    await post([rec("John Smith", 1), rec(undefined, 2), rec(undefined, 3), noKeyRec(4)]);
    // One named row is tier 1, two blank-owner rows are tier 2, and the no-key row is in neither:
    // it draws no credit from either pool because no vendor is ever asked about it.
    expect(tracerfyCanRun).toHaveBeenCalledWith(expect.anything(), { tier1: 1, tier2: 2 });
  });

  it("DOES ask about a tier 1 only batch now, because those records draw the pool per record", async () => {
    // THE GAP THIS CLOSES. The old tier-2-only capacity check short-circuited on a zero tier 2
    // count, so an all-tier-1 batch never read the balance at all. That was true while tier 1
    // posted to the BATCH endpoint; since Phase 2A the web upload's tier 1 rows are worked per
    // record against this very pool, so a short pool must refuse them.
    H.canRunTier2 = false;
    const res = await post([rec("Jane Smith")]);
    expect(res.status).toBe(503);
    expect(historyRows()).toHaveLength(0);
    expect(vi.mocked(tracerfyCanRun).mock.calls[0][1]).toEqual({ tier1: 1, tier2: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * TASK 3: THE CAP IS 500 RECORDS.
 * ------------------------------------------------------------------ */

describe("the record cap", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => rec("John Smith", i + 1));

  it("accepts 500", async () => {
    const res = await post(many(500));
    expect(res.status).not.toBe(400);
  });

  it("refuses 501, and says the cap in records", async () => {
    // Its job is bounding blast radius and stopping one user eating the SHARED
    // vendor pool. MUTATION: restore 10,000 and this goes red.
    const res = await post(many(501));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("500");
    expect(body.error).toMatch(/record/i);
    expect(body.error).not.toMatch(/[—–*]/);
  });
});

/* ------------------------------------------------------------------ *
 * THE JOB MUST NOT CLOSE OVER WORK THAT HAS NOT RUN.
 * ------------------------------------------------------------------ */

describe("a job whose only rows are queued", () => {
  it("is NOT closed out at submit", async () => {
    // The old route closed a job with nothing to trace, because a skipped row
    // was finished the moment it was written. A queued row is not: the cron has
    // not touched it. Closing here means the page stops polling and the results
    // the customer is billed for never reach them.
    // MUTATION: close the job whenever the Tracerfy CSV is empty and this goes
    // red.
    await post([rec(undefined, 1)]);
    const closed = H.ops.find(
      (o) =>
        o.table === "trace_jobs" &&
        o.op === "update" &&
        (o.payload as Record<string, unknown>)?.status === "completed"
    );
    expect(closed).toBeUndefined();
  });

  it("asks no vendor at submit time at all, on either tier", async () => {
    await post([rec(undefined), rec("Jane Smith", 2)]);
    // Both tiers are queued now. A submit writes rows and returns; every vendor call belongs to a
    // cron, which is what keeps this handler inside its 60 second maxDuration on 500 records.
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });

  it("is still closed when every row was unaskable", async () => {
    // Nothing is queued and nothing was submitted, so there is no work to wait
    // for. Leaving it open would park the page on a job nothing will finish.
    await post([noKeyRec(1)]);
    const closed = H.ops.find(
      (o) =>
        o.table === "trace_jobs" &&
        o.op === "update" &&
        (o.payload as Record<string, unknown>)?.status === "completed"
    );
    expect(closed).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * PHASE 2A: THE TIER 1 ENQUEUE.
 * ------------------------------------------------------------------ */

describe("a row with an owner name", () => {
  it("is ENQUEUED on the Tier 1 rung the cron claims", async () => {
    await post([rec("Jane Smith")]);
    const rows = historyRows();
    expect(rows[0].ai_research_status).toBe("tier1_queued");
    // The rung has to be attempt 1 of the TIER 1 ladder specifically. A bare 'queued' is the
    // legacy entity ladder's attempt 1 and would be claimed by the wrong lane of the same cron.
    expect(rows[0].ai_research_status).not.toBe("queued");
  });

  it("is accepted and queued when it has NO CITY, which is the whole point of this phase", async () => {
    // Spec 3.1: "The page stops dropping city-less rows so the user sees why each one did or did
    // not trace." A company owner with no city traces on name and state alone (D4); a person owner
    // with no city and no parcel id ends no_lookup_key, free, with a sentence. Either way the
    // customer is told, and before this phase the row never left the browser.
    await post([
      { owner_name: "Smith Holdings LLC", address: "1 Main St", city: "", state: "TX", zip: "" },
    ]);
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].ai_research_status).toBe("tier1_queued");
    expect(rows[0].city).toBe("");
    expect(rows[0].normalized_address).toBe("1 MAIN ST||TX");
  });

  it("carries property_trace_status null, so no stale tier 2 value can answer for it", async () => {
    await post([rec("Jane Smith")]);
    expect(historyRows()[0].property_trace_status).toBeNull();
  });

  it("clears the stale Tier 1 answer a reused row was carrying (D33, carried item 5)", async () => {
    // D33 chose "single-trace rows only" for the SENTENCE and recorded the other half as Phase 2
    // code: "the bulk submit paths must clear outcome_code, found_by and trace_steps on a reused
    // row". Without it a row a single trace left saying "You were not charged" answers for the new
    // bulk trace, and Task 5 is about to let a bulk row show its own sentence.
    await post([rec("Jane Smith")]);
    const row = historyRows()[0];
    expect(row.outcome_code).toBeNull();
    expect(row.found_by).toBeNull();
    expect(row.trace_steps).toBeNull();
  });

  it("does NOT clear the step log of a busy row it is resuming (spec 5.2)", async () => {
    // The one exemption, and it is money. A busy row's step log is what stops the resend buying
    // the answers this record already paid for. checkDuplicates lets the row through (it is not a
    // duplicate); this keeps the log for executeRoute to replay.
    vi.mocked(checkDuplicates).mockResolvedValueOnce({
      newRecords: [rec("Jane Smith")],
      duplicates: [],
      cachedResults: [
        {
          address_hash: createAddressHash("1 MAIN ST|DALLAS|TX"),
          outcome_code: "busy_try_again",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof checkDuplicates>>);
    await post([rec("Jane Smith")]);
    const row = historyRows()[0];
    expect(row.outcome_code).toBeUndefined();
    expect(row.found_by).toBeUndefined();
    expect(row.trace_steps).toBeUndefined();
    expect(row.ai_research_status).toBe("tier1_queued");
  });

  it("is counted as submitted work and quoted at the tier 1 rate", async () => {
    const res = await post([rec("Jane Smith"), rec("John Smith", 2)]);
    const body = await res.json();
    expect(body.records_submitted).toBe(2);
    expect(body.estimated_cost).toBeCloseTo(2 * TIER1, 4);
  });
});

/* ------------------------------------------------------------------ *
 * PHASE 2A: A FAILED ENQUEUE IS THE FAILED SUBMIT NOW.
 *
 * The enqueue IS the submit on this surface. Until Task 3, insertHistoryRows
 * console.errored its upsert error and returned, so a failed enqueue answered
 * success: true, and bulk/status then finalized the job `completed` with
 * records_matched 0 on its first poll and made that permanent. These three
 * tests are the fence on that path.
 * ------------------------------------------------------------------ */

describe("when the rows cannot be written", () => {
  beforeEach(() => {
    H.upsertError = { message: "deadlock detected" };
  });

  it("does NOT answer success, which is what hid this before", async () => {
    // THE WHOLE DEFECT IN ONE ASSERTION. The customer uploaded rows, was told it worked, and got an
    // empty CSV, because the only report of the failure was a console line on a server they cannot
    // read.
    const res = await post([rec("Jane Smith"), rec("John Smith", 2)]);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("writes the JOB failed with a reason, so the status route cannot finalize it as an empty success", async () => {
    // A 500 alone is not enough. The page polls app/api/trace/bulk/status, which finalizes a job
    // whose two queues hold nothing as `completed` with records_matched 0 and then answers every
    // later poll from the stored stats. The job row has to carry the failure before this handler
    // returns, or an empty CSV is the customer's only evidence.
    await post([rec("Jane Smith")]);
    const failed = H.ops.find(
      (o) =>
        o.table === "trace_jobs" &&
        o.op === "update" &&
        (o.payload as Record<string, unknown>).status === "failed"
    );
    expect(failed).toBeDefined();
    // THE CUSTOMER GETS THE FIXED GENERIC SENTENCE, David approved, never the raw Postgres text.
    // No "not charged" claim: a part-way failure can leave rows already written and billable.
    expect((failed!.payload as Record<string, unknown>).error_message).toBe(
      "We could not finish starting your upload. Some records may already be running, so check your results before uploading those addresses again."
    );
    expect((failed!.payload as Record<string, unknown>).error_message).not.toMatch(/not charged/i);
  });

  it("keeps the detailed failure in the server log, so nothing is lost by generalizing the customer sentence", async () => {
    await post([rec("Jane Smith")]);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to enqueue bulk trace rows:",
      expect.stringContaining("deadlock detected")
    );
  });

  it("stops at the FIRST failed batch rather than reporting on rows it never tried", async () => {
    // records_submitted is the denominator of the match rate. Carrying on after a failed batch and
    // then answering with a count that includes it is the same lie in a smaller size.
    await post([rec("Jane Smith"), rec(undefined, 2), noKeyRec(3)]);
    const upserts = H.ops.filter((o) => o.table === "trace_history" && o.op === "upsert");
    expect(upserts).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * A REUSED ROW CARRIES WHATEVER THE LAST WRITER LEFT ON IT.
 * ------------------------------------------------------------------ */

describe("the entity-queue column on every row this route writes", () => {
  it("is written explicitly on every row: the Tier 1 rung, or null", async () => {
    // WRITTEN ON EVERY ROW BECAUSE THE UPSERT ONLY TOUCHES THE KEYS IN THIS PAYLOAD. A row is
    // REUSED rather than re-inserted (UNIQUE(user_id, address_hash)), so omitting the key leaves
    // whatever the row already carried. 273 pre-5c rows carry 'skipped_no_owner' and would be
    // enqueued and billed while summarizeSkips read that stale value and said "you were not
    // charged" on a row that was.
    await post([rec("Jane Smith"), rec(undefined, 2), noKeyRec(3)]);
    const rows = historyRows();
    const byAddress = new Map(rows.map((r) => [r.normalized_address, r]));
    // Tier 1: the rung the Tier 1 lane of the cron claims.
    expect(byAddress.get("1 MAIN ST|DALLAS|TX")!.ai_research_status).toBe("tier1_queued");
    // Tier 2 and no-key: null, because neither belongs to this column's lanes at all.
    expect(byAddress.get("2 MAIN ST|DALLAS|TX")!.ai_research_status).toBeNull();
    expect(byAddress.get("3 MAIN ST||TX")!.ai_research_status).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * UNCHANGED BEHAVIOUR THAT THE CHANGE MUST NOT BREAK.
 * ------------------------------------------------------------------ */

/**
 * THE SOURCE TAG IS A LABEL, AND AS OF 2026-09-23 THAT IS ALL IT IS.
 *
 * It used to be a PRICE DECISION: the crons chose between two derivations from it and read an
 * UNTAGGED row as the raw, dearer one, so an untagged tier 2 row from this route was billed $0.40
 * by the cron while its siblings settled at $0.25 in the same batch. David's decision -- "One
 * price: make the API grant-aware" -- left one derivation, and `isTrackASource` went with the
 * branches that called it. The tag is still WRITTEN, because it says where a row came from, and
 * these tests still fence that it is written; what they no longer claim is that it picks a rate.
 */
describe("the source tag this job is written with", () => {
  it("tags the job row with its source", async () => {
    await post([rec("John Smith", 1)]);
    const job = H.ops.find((o) => o.table === "trace_jobs" && o.op === "insert");
    expect(job!.payload).toMatchObject({ source: TRACE_SOURCE.WEB });
  });

  it("tags every trace_history row it writes, queued and unaskable alike", async () => {
    // Provenance, not price: the crons read the ROW's tag rather than the job's, and a row that
    // loses it can no longer say which surface submitted it.
    await post([rec("John Smith", 1), rec(undefined, 2), noKeyRec(3)]);
    expect(historyRows()).toHaveLength(3);
    for (const row of historyRows()) {
      expect(row.source).toBe(TRACE_SOURCE.WEB);
    }
  });

  it("is priced identically whatever the tag says, because the tag prices nothing", async () => {
    // The replacement for "names a track the settle path actually prices on", which asserted the
    // tag selected a derivation. Nothing keys off it now, so what is worth fencing is that the
    // rate follows the CALLER: a grant holder pays the pro rate, and the tag is not consulted.
    // L-009: without the flag a grant counts for nothing and this proves nothing.
    const GRANT_HOLDER = {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["prop-tracer-pro"],
    };
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    try {
      expect(chargePerTrace(GRANT_HOLDER)).toBe(PRICING.CHARGE_PER_SUCCESS);
      expect(chargePerRecord(GRANT_HOLDER)).toBe(PRICING.TIER2_PER_RECORD_SUBMITTED_PRO);
      // The tag is not an input to either function: there is nowhere to pass it.
      expect(chargePerTrace.length).toBe(1);
      expect(chargePerRecord.length).toBe(1);
    } finally {
      delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    }
  });
});

describe("a traced row", () => {
  it("goes on the TIER 1 QUEUE, not to Tracerfy, and stays linked to the bulk job", async () => {
    await post([rec("Jane Smith")]);
    // THE CHANGEOVER (spec 3.3). Nothing new is sent to the batch endpoint from this surface.
    // Rows already in flight there keep settling through settleBulkJob until none remain; Phase 4
    // deletes the path once they have drained.
    expect(submitBulkTrace).not.toHaveBeenCalled();
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].ai_research_status).toBe("tier1_queued");
    expect(rows[0].status).toBe("processing");
    expect(rows[0].trace_job_id).toBe("job-1");
    // tracerfy_job_id is WRITTEN null, not omitted: the upsert reuses this row, and an omitted
    // key would leave a stale job id from a CSV-era write in place. Both CSV settle paths find
    // their rows by this column, and a queued row carrying a stale value would be billed by the
    // wrong engine.
    expect(rows[0].tracerfy_job_id).toBeNull();
  });

  it("writes property_trace_status NULL, so no stale tier 2 value survives on it", async () => {
    // TWO FAILURES, AND THE SECOND ONE IS WHY THIS ASSERTS ON THE KEY ITSELF.
    // A tier 1 row that landed on the tier 2 queue would be charged per record
    // submitted instead of per successful trace, and billed twice over. And the
    // upsert only touches the keys in this payload, on a row REUSED rather than
    // re-inserted, so an OMITTED key leaves a previous tier 2 terminal value in
    // place -- which rowSkipReason() asks about first and serves, telling the
    // customer what the other billing model charges.
    //
    // `?? null` USED TO BE THE WHOLE ASSERTION AND IT COULD NOT FAIL: an absent
    // key satisfies it exactly as well as a written null, which is why it stayed
    // green for the entire life of the defect. MUTATION: delete the
    // `property_trace_status: null` line from buildHistoryRow and this goes red.
    await post([rec("John Smith", 1)]);
    expect(Object.keys(historyRows()[0])).toContain("property_trace_status");
    expect(historyRows()[0].property_trace_status).toBeNull();
  });
});
