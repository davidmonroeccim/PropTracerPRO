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
  submit: { success: true, jobId: "tf-1" } as Record<string, unknown>,
  canRunTier2: true,
  inFlight: 0,
}));

function recordingClient() {
  return {
    from(table: string) {
      const node: Record<string, unknown> = {};
      let rec: Op | null = null;
      const add = () => () => node;
      for (const m of ["eq", "select"]) node[m] = add();
      node.single = async () => ({ data: H.job, error: null });
      node.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(res);
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
vi.mock("@/lib/tracerfy/client", () => ({ submitBulkTrace: vi.fn(async () => H.submit) }));
// The pre-flight module has its own unit tests (lib/trace/__tests__/bulkPreflight.test.ts).
// Here it is a lever, so these tests can ask what the ROUTE does with each answer.
// TIER2_CAPACITY_REFUSAL stays REAL, because the copy rules apply to the string
// the customer actually receives.
vi.mock("@/lib/trace/bulkPreflight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trace/bulkPreflight")>();
  return {
    ...actual,
    // Faithful to the real contract: a batch with no tier 2 records asks no
    // vendor and can never be refused. Without that short circuit here, a route
    // that passed records.length instead of the tier 2 count would still look
    // correct, because every batch would reach the pool question.
    tracerfyCanRunTier2: vi.fn(async (_admin: unknown, n: number) =>
      n <= 0 ? true : H.canRunTier2,
    ),
    inFlightUnbilledCost: vi.fn(async () => H.inFlight),
  };
});

const { POST } = await import("@/app/api/trace/bulk/route");
const { submitBulkTrace } = await import("@/lib/tracerfy/client");
const { tracerfyCanRunTier2, inFlightUnbilledCost } = await import("@/lib/trace/bulkPreflight");

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

/** The CSV body handed to Tracerfy, split into data lines. */
const submittedCsvLines = () => {
  const call = vi.mocked(submitBulkTrace).mock.calls[0];
  return call ? String(call[0]).split("\n").slice(1) : [];
};

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

  it("never reaches the Tracerfy person CSV", async () => {
    // The old CSV carried a line with empty first_name and last_name for it.
    // It has no owner to look up: the dossier is what discovers one.
    await post([rec("John Smith", 1), rec(undefined, 2)]);
    expect(submittedCsvLines()).toHaveLength(1);
    expect(submittedCsvLines()[0]).toContain("John");
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
 * TRACK A PRICES GRANT-AWARE, AND THE ONLY THING SEPARATING IT FROM TRACK B IS
 * A FEATURE FLAG THAT IS OFF IN TESTS.
 *
 * hasSuiteAccess() is gated on NEXT_PUBLIC_SUITE_SIGNIN_ENABLED, which is false
 * here and TRUE in production. With the flag off a gateway grant counts for
 * nothing, both derivations collapse to the wallet column, and a test asserting
 * that this route prices grant-aware passes under the correct implementation and
 * under a raw one alike. That is L-009, and this project has earned it twice.
 * The probe at the end proves the flag is what makes the difference possible.
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

  it("is asked about the tier 2 records only", async () => {
    H.canRunTier2 = true;
    await post([rec("John Smith", 1), rec(undefined, 2), rec(undefined, 3), noKeyRec(4)]);
    // The no-key row draws no dossier credit: no vendor is ever asked about it.
    expect(tracerfyCanRunTier2).toHaveBeenCalledWith(expect.anything(), 2);
  });

  it("does not block a tier 1 only batch", async () => {
    // A batch with no blank-owner rows draws nothing from the dossier pool, so
    // a short pool must not refuse it.
    H.canRunTier2 = true;
    const res = await post([rec("John Smith", 1)]);
    expect(res.status).not.toBe(503);
    expect(tracerfyCanRunTier2).toHaveBeenCalledWith(expect.anything(), 0);
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

  it("asks no person vendor, because there is no person to ask about", async () => {
    await post([rec(undefined, 1)]);
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
 * A FAILED PERSON SUBMIT IS NOT A FAILED JOB ANY MORE.
 *
 * The tier 2 rows are written BEFORE the Tracerfy call, deliberately.
 * sweep-property-traces claims on property_trace_status alone and never
 * reads the parent job, so marking the job failed here stops nothing:
 * it works every one of those rows and bills each one. The customer
 * would get an HTTP 500, a job reading failed, and a charge for work
 * they were told did not happen -- and since the rows now exist, a
 * resubmit inside the 90-day window comes back as duplicates, so they
 * could not even re-run what they paid for.
 * ------------------------------------------------------------------ */

describe("when the Tracerfy person submit fails", () => {
  beforeEach(() => {
    H.submit = { success: false, error: "Tracerfy 503" };
  });

  it("does NOT mark the job failed while tier 2 rows are queued", async () => {
    // MUTATION: fail the job unconditionally again and this goes red.
    await post([rec("John Smith", 1), rec(undefined, 2)]);
    const failed = H.ops.find(
      (o) =>
        o.table === "trace_jobs" &&
        o.op === "update" &&
        (o.payload as Record<string, unknown>)?.status === "failed"
    );
    expect(failed).toBeUndefined();
  });

  it("does not hand back a 500 for a job that is still running and will be billed", async () => {
    const res = await post([rec("John Smith", 1), rec(undefined, 2)]);
    expect(res.status).not.toBe(500);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.records_queued).toBe(1);
    expect(body.records_failed).toBe(1);
  });

  it("quotes only the rows that are actually going to run", async () => {
    // The tier 1 half was never submitted, so charging for it would be a
    // statement about money that is not true.
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(body.estimated_cost).toBeCloseTo(TIER2);
  });

  it("tells the customer which half failed and that it was free", async () => {
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(body.message).toContain("not charged");
    expect(body.message).not.toMatch(/[—–*]/);
  });

  it("writes the tier 1 rows terminal so every accepted record has one", async () => {
    // records_submitted is the denominator of the match rate. A record with no
    // row at all would leave the job permanently un-finishable.
    await post([rec("John Smith", 1), rec(undefined, 2)]);
    const errored = historyRows().filter((r) => r.status === "error");
    expect(errored).toHaveLength(1);
    expect(errored[0].input_owner_name).toBe("John Smith");
  });

  it("corrects the job's records_submitted, which is the match-rate denominator", async () => {
    // Written before the failure, counting the tier 1 rows. Left alone, the
    // payload and the job row disagree about one job, and the status route and
    // the webhook report the job's version.
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

  it("gets BOTH charge statements right in the same breath", async () => {
    // The errored records are NOT billed and the surviving tier 2 records WILL
    // be. Saying only one is how a customer is surprised by the other.
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(body.message).toContain("not charged");
    expect(body.message).toContain("will be charged");
  });

  it("STILL fails the job when nothing survives the failure", async () => {
    // The guard must not become a blanket refusal to ever fail a job. With no
    // tier 2 rows there is nothing left running, and this branch is exactly what
    // it was written for.
    const res = await post([rec("John Smith", 1)]);
    expect(res.status).toBe(500);
    const failed = H.ops.find(
      (o) =>
        o.table === "trace_jobs" &&
        o.op === "update" &&
        (o.payload as Record<string, unknown>)?.status === "failed"
    );
    expect(failed).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * A REUSED ROW CARRIES WHATEVER THE LAST WRITER LEFT ON IT.
 * ------------------------------------------------------------------ */

describe("the entity-queue column on every row this route writes", () => {
  it("is written null rather than left alone", async () => {
    // THE UPSERT ONLY TOUCHES THE KEYS IN THE PAYLOAD. A row is REUSED, not
    // re-inserted, so an omitted key keeps its old value. A pre-5c blank-owner
    // row carries 'skipped_no_owner' and 273 of them exist: left in place, the
    // row is enqueued and billed while summarizeSkips() reads that stale value
    // and tells the customer "you were not charged" on a row that was. A stale
    // 'queued' is worse, putting one row on two queues to be settled twice.
    // MUTATION: drop the ai_research_status key and this goes red.
    await post([rec("John Smith", 1), rec(undefined, 2), noKeyRec(3)]);
    expect(historyRows()).toHaveLength(3);
    for (const row of historyRows()) {
      expect(Object.keys(row)).toContain("ai_research_status");
      expect(row.ai_research_status).toBeNull();
    }
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
  it("still goes to Tracerfy and is still linked to the bulk job", async () => {
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(submitBulkTrace).toHaveBeenCalledTimes(1);
    expect(body.records_submitted).toBe(1);
    expect(historyRows()[0]).toMatchObject({
      status: "processing",
      tracerfy_job_id: "tf-1",
      trace_job_id: "job-1",
    });
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
