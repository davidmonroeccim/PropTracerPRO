import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { PRICE, planRoute } from "@/lib/routing/ownerRoute";
import {
  MAX_PROPERTY_TRACE_ATTEMPTS,
  PROPERTY_TRACE_FAILED_STATUS,
  PROPERTY_TRACE_NO_KEY_STATUS,
  PROPERTY_TRACE_NO_REACH_STATUS,
  PROPERTY_TRACE_SETTLED_STATUS,
  isPropertyTracePending,
  propertyTraceSkipReason,
} from "@/lib/trace/propertyTraceAttempts";

/**
 * Money and claim fences for the TIER 2 bulk worker.
 *
 * WHAT MAKES THIS FILE DIFFERENT FROM ITS TWIN next door. sweep-entity-traces
 * settles TIER 1 rows, where a miss is FREE. This cron settles TIER 2 rows,
 * where the customer is billed per RECORD SUBMITTED and a miss IS billed. The
 * two rules disagree about the most dangerous question in this codebase, so
 * every test below states which one it is asserting.
 *
 * FOUR THINGS THESE TESTS EXIST TO HOLD:
 *
 * 1. BILL ON WHETHER THE DOSSIER ANSWERED, NEVER ON WHETHER IT FOUND ANYTHING
 *    (L-007). A hit and a miss are both billable; only a vendor we could not ASK
 *    is free. A miss and a failure look identical from outside -- no contacts,
 *    no record -- and merging them either bills customers for our outages or
 *    gives away records we paid for.
 * 2. THE TIER 2 RATE, AND ONLY THE TIER 2 RATE. Every test uses a
 *    Pay-As-You-Go profile, whose tier 2 per-record rate is $0.40. That number
 *    collides with nothing: the tier 1 rates are $0.15 and $0.25, and the Pro
 *    tier 2 rate is $0.25. A deduction of anything but 0.40 on a wallet profile
 *    is therefore unambiguously the wrong rate.
 * 3. A RECEIPT IS MONOTONIC. A row that already carries a tier 2 charge must
 *    come out of every path here still carrying it, exhaustion included.
 * 4. THE CLAIM PROTOCOL IS A COPY OF A LOAD-BEARING ONE. Two workers racing,
 *    a stale claim, a NULL claim timestamp, and a poison row that must not loop
 *    forever -- each of those was paid for by a real production failure in
 *    sweep-entity-traces and each is asserted here rather than assumed.
 */

/** Pay-As-You-Go tier 2, per record submitted. Not a per-success rate. */
const TIER2_WALLET = PRICE.wallet.tier2PerRecord;
/** Pro / AcquisitionPRO tier 2, per record submitted. */
const TIER2_PRO = PRICE.pro.tier2PerRecord;

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
  queuedRows: [] as Array<Record<string, unknown>>,
  // wallet_transactions rows already booked against the row being processed. A
  // non-empty array is the state a row is left in when a previous run deducted
  // and then died before it could write the result back.
  //
  // `type` IS LOAD-BEARING AND EVERY ENTRY MUST CARRY IT. collectedChargeFor
  // nets debits against credits, so an entry with no `type` reads as money
  // handed BACK and flips the sign of the probe's answer. PostgREST would never
  // omit a selected column; a stub that does is telling the route a lie no
  // database can tell it.
  //
  // SO IS `created_at`, AS OF 2026-09-18. The probe is scoped to the bulk job the
  // row is currently enqueued for, and the stub below honours that `gte` filter
  // the way PostgREST would. An entry with no timestamp is invisible to a bounded
  // probe, exactly as a NULL created_at would be to SQL.
  priorDebits: [] as Array<Record<string, unknown>>,
  // The trace_jobs row the worker reads to find out when this piece of work
  // began. Null is an unreadable job, which must fall back to an unbounded probe:
  // an unbounded probe can only skip a charge, a wrong bound charges twice.
  jobRow: { created_at: "2026-09-18T10:00:00.000Z" } as Record<string, unknown> | null,
  // Consumed in order, one per atomic claim. Empty means every claim succeeds.
  // A `false` entry is another worker having taken the row first.
  claimOutcomes: [] as boolean[],
  // Rows the stale sweep reverts, keyed by the processing rung it swept.
  staleRevertsByStatus: {} as Record<string, Array<Record<string, unknown>>>,
  profile: {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: [] as string[],
  } as Record<string, unknown> | null,
  dossier: {} as Record<string, unknown>,
  entityContacts: {} as Record<string, unknown>,
  personContacts: {} as Record<string, unknown>,
  /** What the mocked HighLevel client answers. A push success by default. */
  pushResult: { success: true, contactId: "hl-1", action: "created" } as Record<
    string,
    unknown
  >,
  /** Callbacks handed to `after()`, run explicitly by flushDeferred(). */
  scheduled: [] as Array<() => unknown>,
  // Concurrency instrumentation, filled by the dossier mock.
  inFlight: 0,
  maxInFlight: 0,
  /** When true the dossier mock defers across a macrotask so overlap is observable. */
  slowDossier: false,
}));

/** Records every read and write and resolves each chain the way PostgREST would. */
function recordingClient() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      H.rpcCalls.push({ fn, args });
      return { data: true, error: null };
    },
    from(table: string) {
      const node: Record<string, unknown> = {};
      let rec: Op | null = null;
      let sawSelect = false;

      const add =
        (method: string) =>
        (...args: unknown[]) => {
          if (method === "select") sawSelect = true;
          rec?.filters.push([method, ...args]);
          return node;
        };
      for (const m of ["select", "eq", "lt", "or", "order", "limit", "in", "is"])
        node[m] = add(m);

      const settle = () => {
        if (table === "user_profiles") return { data: H.profile, error: null };
        if (table === "trace_jobs") return { data: H.jobRow, error: null };
        // EVERY ledger row for the trace_history row, unfiltered, which is what
        // the real query asks for. collectedChargesFor applies the window itself
        // because it has to answer both the bounded and the unbounded question
        // off one read, so a stub that pre-filtered here would hide whether it
        // does.
        if (table === "wallet_transactions") return { data: H.priorDebits, error: null };
        if (rec?.op === "select") return { data: H.queuedRows, error: null };
        // An update that asked for `.select('id')` and is awaited directly is
        // the stale-claim revert; it wants an array back, and WHICH array
        // depends on the rung it swept.
        if (rec?.op === "update" && sawSelect) {
          const rung = rec.filters.find(
            (f) => f[0] === "eq" && f[1] === "property_trace_status"
          );
          return { data: H.staleRevertsByStatus[String(rung?.[2])] ?? [], error: null };
        }
        return { data: null, error: null };
      };

      node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(settle()).then(res, rej);
      node.maybeSingle = async () => {
        // The atomic claim:
        // `.update(...).eq(id).eq(property_trace_status).select('id').maybeSingle()`.
        if (rec?.op === "update") {
          const allowed = H.claimOutcomes.length ? H.claimOutcomes.shift() : true;
          return { data: allowed ? { id: "claimed" } : null, error: null };
        }
        return { data: null, error: null };
      };
      // Two tables are read with `.single()`: the rate profile, and the bulk job
      // whose creation time bounds the ledger probe. Answering both with the
      // profile would hand the worker a job row with no created_at, which reads
      // as an unreadable job and silently un-scopes the probe.
      node.single = async () =>
        table === "trace_jobs"
          ? { data: H.jobRow, error: null }
          : { data: H.profile, error: null };

      return {
        select: (...args: unknown[]) => {
          rec = { table, op: "select", filters: [["select", ...args]] };
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
vi.mock("@/lib/tracerfy/dossier", () => ({
  lookupDossier: vi.fn(async () => {
    H.inFlight++;
    H.maxInFlight = Math.max(H.maxInFlight, H.inFlight);
    if (H.slowDossier) await new Promise((resolve) => setTimeout(resolve, 0));
    H.inFlight--;
    return H.dossier;
  }),
}));
vi.mock("@/lib/tracerfy/client", () => ({
  lookupBusinessTrace: vi.fn(async () => H.entityContacts),
  lookupPersonTrace: vi.fn(async () => H.personContacts),
}));
vi.mock("@/lib/highlevel/client", () => ({
  pushTraceToHighLevel: vi.fn(async () => H.pushResult),
}));

/**
 * `after()` is captured rather than executed, and the tests run it themselves.
 *
 * The credential health write and the push record are both deliberately handed
 * to `after()` so they outlive the response. Letting the real one run here would
 * either throw (no request scope) or schedule work this test never waits for, so
 * the assertions would be reading a race. Holding the callbacks and running them
 * explicitly is the same shape lib/highlevel/__tests__/credentialHealth.test.ts
 * uses, and it keeps "the work was DEFERRED" observable.
 */
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    H.scheduled.push(fn);
  },
}));

const { GET, parcelForRow } = await import("@/app/api/cron/sweep-property-traces/route");
const { lookupDossier } = await import("@/lib/tracerfy/dossier");
const { lookupBusinessTrace, lookupPersonTrace } = await import("@/lib/tracerfy/client");
const { pushTraceToHighLevel } = await import("@/lib/highlevel/client");

/** Drain everything `after()` was handed, in order. */
async function flushDeferred(): Promise<void> {
  while (H.scheduled.length > 0) await H.scheduled.shift()!();
}

/** When the bulk job holding ROW was created, and two instants either side of it. */
const JOB_CREATED_AT = "2026-09-18T10:00:00.000Z";
/** A debit booked by THIS submit: the crash window, deduct then die. */
const DURING_THIS_JOB = "2026-09-18T10:00:05.000Z";
/** A debit booked by an EARLIER submit of the same reused row. */
const BEFORE_THIS_JOB = "2026-08-01T09:00:00.000Z";

/** A blank-owner bulk row: exactly what tier 2 exists for. */
const ROW = {
  id: "row-1",
  user_id: "user-1",
  // The job this row is CURRENTLY enqueued for. Every tier 2 row has one, and it
  // is re-pointed by each submit, which is what makes it the right scope for the
  // ledger probe.
  trace_job_id: "job-1",
  normalized_address: "100 MAIN ST|DALLAS|TX",
  city: "DALLAS",
  state: "TX",
  zip: "75001",
  address_hash: "hash-1",
  input_owner_name: null,
  source: "web",
  property_trace_status: "queued",
};

/** An ENTITY owner of record. The dossier puts the whole name in last_name. */
const ENTITY_HIT = {
  success: true,
  hit: true,
  owners: [{ first_name: "", last_name: "Acme Holdings Llc", age: "" }],
  property: { apn: "PLACEHOLDER-1", zip_code: "75001", land_use: "commercial" },
  mailingAddress: { address: "1 PO Box", city: "Dallas", state: "TX", zip: "75001" },
  creditsDeducted: 10,
};

/** The county has no parcel at that address. A complete answer, and a billable one. */
const DOSSIER_MISS = {
  success: true,
  hit: false,
  owners: [],
  property: null,
  mailingAddress: null,
  creditsDeducted: 0,
};

/** We could not ask. Not a miss, and never billable. */
const DOSSIER_FAILURE = {
  success: false,
  hit: false,
  owners: [],
  property: null,
  mailingAddress: null,
  creditsDeducted: 0,
  error: "Tracerfy 503",
};

const CONTACTS_HIT = {
  success: true,
  hit: true,
  contacts: {
    ownerName: "Testowner Placeholder",
    phones: [{ number: "5550000101", type: "mobile" }],
    emails: ["principal@example.invalid"],
    mailingAddress: "100 Placeholder Way, Redacted, ZZ, 00000",
  },
};

/** The contact vendor answered and has no record of this owner. Free, and final. */
const CONTACTS_MISS = { success: true, hit: false, contacts: null };

function run(secret = "s3cret") {
  return GET(
    new Request("http://localhost/api/cron/sweep-property-traces", {
      headers: { authorization: `Bearer ${secret}` },
    })
  );
}

/** Every trace_history update payload, in order. */
const historyWrites = () =>
  H.ops.filter((o) => o.table === "trace_history" && o.op === "update").map((o) => o.payload!);

/** The payload of the LAST trace_history update, which is the row's final state. */
const finalWrite = () => historyWrites()[historyWrites().length - 1];

const deducts = () => H.rpcCalls.filter((c) => c.fn === "deduct_wallet_balance");

/**
 * Everything this run wrote to console.error, flattened to strings.
 *
 * PTP has NO alerting channel by David's explicit decision, so these lines and
 * the response counters are the only place an operator can ever learn that a
 * vendor went down. That makes them behaviour worth asserting rather than noise.
 */
const errorLogs = (): string[] =>
  vi.mocked(console.error).mock.calls.map((args) => args.map(String).join(" "));

/** The claim window's own select. */
const claimQuery = () =>
  H.ops.find(
    (o) =>
      o.table === "trace_history" &&
      o.op === "select" &&
      o.filters.some((f) => f[0] === "in")
  );

/**
 * The stale-claim age filter on an update, whatever shape it takes.
 *
 * A bare `.lt(...)` cannot match a NULL claim timestamp, so the assertion asks
 * for the filter rather than for one particular operator.
 */
const staleFilter = (op: Op) =>
  op.filters.find(
    (f) => f[0] === "or" && String(f[1]).includes("property_trace_claimed_at")
  );

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  H.ops = [];
  H.rpcCalls = [];
  H.queuedRows = [{ ...ROW }];
  H.priorDebits = [];
  H.jobRow = { created_at: JOB_CREATED_AT };
  H.claimOutcomes = [];
  H.staleRevertsByStatus = {};
  H.profile = {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: [],
  };
  H.dossier = { ...ENTITY_HIT };
  H.entityContacts = { ...CONTACTS_HIT };
  H.personContacts = { ...CONTACTS_HIT };
  H.inFlight = 0;
  H.maxInFlight = 0;
  H.slowDossier = false;
  H.pushResult = { success: true, contactId: "hl-1", action: "created" };
  H.scheduled = [];
  vi.mocked(pushTraceToHighLevel).mockClear();
  vi.mocked(lookupDossier).mockClear();
  vi.mocked(lookupBusinessTrace).mockClear();
  vi.mocked(lookupPersonTrace).mockClear();
  // mockClear AFTER the spy, not instead of it: vi.spyOn returns the SAME spy on
  // a second call, so without this the log assertions below read every previous
  // test's output as well as their own.
  vi.spyOn(console, "error").mockImplementation(() => {}).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {}).mockClear();
});

/**
 * parcelForRow, tested directly rather than only through the whole cron.
 *
 * WHY THIS DESCRIBE BLOCK EXISTS. Before the extraction, the two lines that carried apn and
 * county into parcelForFullTrace lived inline in the claim loop. Deleting either one still
 * left tsc clean and the full suite green, because nothing exercised that wiring end to end:
 * the mutation survived. Pinning it here closes that gap without standing up the route.
 */
describe("parcelForRow", () => {
  const baseRow = {
    id: "row-1",
    user_id: "user-1",
    trace_job_id: "job-1",
    normalized_address: "203 DAUPHIN ST|MOBILE|AL",
    city: "MOBILE",
    state: "AL",
    zip: "36602",
    source: "mcp",
    property_trace_status: "queued",
    charge: null,
    tier: null,
    property_record: null,
  };

  it("carries parcel_id_local and county through, alongside state, and emits both dossier steps APN first", () => {
    const parcel = parcelForRow({ ...baseRow, parcel_id_local: "R022901", county: "Mobile" });
    expect(parcel.parcelIdLocal).toBe("R022901");
    expect(parcel.county).toBe("Mobile");
    expect(parcel.state).toBe("AL");
    const plan = planRoute(parcel, "pro");
    expect(plan.steps.map((s) => s.kind)).toEqual(["DOSSIER_APN", "DOSSIER_ADDRESS"]);
  });

  it("produces address-only, one step, for a row with no parcel key, which is every existing production row", () => {
    const parcel = parcelForRow({ ...baseRow, parcel_id_local: null, county: null });
    expect(parcel.parcelIdLocal ?? null).toBeNull();
    expect(parcel.county ?? null).toBeNull();
    const plan = planRoute(parcel, "pro");
    expect(plan.steps.map((s) => s.kind)).toEqual(["DOSSIER_ADDRESS"]);
  });

  it("treats a blank or whitespace parcel_id_local as absent, never as an empty string", () => {
    const parcel = parcelForRow({ ...baseRow, parcel_id_local: "   ", county: "" });
    expect(parcel.parcelIdLocal ?? null).toBeNull();
    expect(parcel.county ?? null).toBeNull();
  });
});

describe("auth", () => {
  it("401s without the cron secret and touches nothing", async () => {
    const res = await run("wrong");
    expect(res.status).toBe(401);
    expect(H.ops).toHaveLength(0);
    expect(lookupDossier).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * THE BILLING GATE. All four outcomes, and the two middle ones are the
 * whole point.
 * ------------------------------------------------------------------ */

describe("the dossier answered and found an owner, and contacts resolved", () => {
  it("bills the tier 2 per-record rate exactly once and settles the row a success", async () => {
    const body = await (await run()).json();

    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
    expect(deducts()[0].args.p_trace_history_id).toBe("row-1");
    // Not a tier 1 rate. Those are free on a miss and this model is not.
    expect(deducts()[0].args.p_amount).not.toBe(PRICING.CHARGE_PER_SUCCESS);
    expect(deducts()[0].args.p_amount).not.toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);

    expect(body.billed).toBe(1);
    expect(body.contactsResolved).toBe(1);
    expect(finalWrite()).toMatchObject({
      property_trace_status: PROPERTY_TRACE_SETTLED_STATUS,
      property_trace_claimed_at: null,
      status: "success",
      is_successful: true,
      charge: TIER2_WALLET,
      tier: 2,
      phone_count: 1,
      email_count: 1,
    });
  });

  it("persists the RAW property record, which is the thing tier 2 buys", async () => {
    await run();
    expect(finalWrite().property_record).toBe(H.dossier.property);
  });
});

describe("the dossier answered and found an owner, but the contact vendor has no record", () => {
  beforeEach(() => {
    H.entityContacts = { ...CONTACTS_MISS };
  });

  it("STILL BILLS, because tier 2 is per record SUBMITTED", async () => {
    // THE OUTCOME THIS WHOLE TIER EXISTS TO GET RIGHT. The customer receives an
    // 86-field county record and no phone number, and that is a complete answer
    // they paid for. MUTATION: gate the charge on contactsFound, or on
    // execution.contactsFound, and this goes red at zero deducts.
    const body = await (await run()).json();

    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
    expect(body.billed).toBe(1);
    expect(body.noContacts).toBe(1);
    expect(finalWrite()).toMatchObject({
      property_trace_status: PROPERTY_TRACE_SETTLED_STATUS,
      status: "no_match",
      is_successful: false,
      charge: TIER2_WALLET,
      tier: 2,
    });
    // `is_successful = false` AND `charge > 0` is the correct, normal shape of a
    // paid tier 2 row. Every delete sweep and the cache filter depend on it.
    expect(finalWrite().property_record).toBe(H.dossier.property);
  });
});

describe("the dossier answered and the county has no parcel", () => {
  beforeEach(() => {
    H.dossier = { ...DOSSIER_MISS };
  });

  it("STILL BILLS, and never asks a contact vendor", async () => {
    // A miss is a complete answer: we asked, and there is no record. Under a
    // per-record model that is billable. MUTATION: gate the charge on
    // execution.ownerFound and this goes red.
    const body = await (await run()).json();

    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(lookupPersonTrace).not.toHaveBeenCalled();
    expect(body.billed).toBe(1);
    expect(body.propertyRecords).toBe(0);
    expect(finalWrite()).toMatchObject({
      property_trace_status: PROPERTY_TRACE_SETTLED_STATUS,
      status: "no_match",
      is_successful: false,
      charge: TIER2_WALLET,
      tier: 2,
    });
  });

  it("writes no property_record key at all, rather than a null over a bought one", async () => {
    // This row is REUSED, never re-inserted, so it can already hold a record the
    // customer paid for. A null here would destroy the product AND flip
    // isBilledRow() to false, un-protecting a paid row from every delete sweep.
    // MUTATION: write `property_record: execution.property` unconditionally and
    // this goes red.
    await run();
    expect(Object.keys(finalWrite())).not.toContain("property_record");
  });
});

describe("the dossier could not be asked", () => {
  beforeEach(() => {
    H.dossier = { ...DOSSIER_FAILURE };
  });

  it("charges NOTHING and puts the row back on the retry ladder", async () => {
    // L-007. A failure is OUR outage, not the customer's miss, and the two are
    // indistinguishable from outside: both come back with no record and no
    // contacts. MUTATION: gate the charge on execution.steps.length, or drop the
    // outcome test from the dossierAnswered predicate, and an outage starts
    // billing customers.
    const body = await (await run()).json();

    expect(deducts()).toHaveLength(0);
    expect(body.errored).toBe(1);
    expect(body.billed).toBe(0);
    expect(finalWrite()).toMatchObject({
      property_trace_status: "queued_2",
      property_trace_claimed_at: null,
    });
    // Nothing is settled: the row must not be closed out as a miss.
    expect(finalWrite().status).toBeUndefined();
  });

  it("does not even probe the ledger, because there is no charge to be idempotent about", async () => {
    await run();
    expect(H.ops.some((o) => o.table === "wallet_transactions")).toBe(false);
  });

  it("writes nothing money-shaped on the way back to the queue", async () => {
    await run();
    for (const paid of ["charge", "tier", "ai_research_charge", "cost"]) {
      expect(Object.keys(finalWrite())).not.toContain(paid);
    }
  });
});

/**
 * THE DELIBERATE DIVERGENCE FROM app/api/trace/single, AND THE LIMIT OF IT.
 *
 * That route returns 502 and charges nothing when the CONTACT vendor fails,
 * because a customer can resubmit a single trace immediately and for free. A
 * queued bulk row cannot: the only way to run it again is to re-buy a $0.20
 * dossier out of a Tracerfy credit pool that is SHARED across every customer's
 * jobs and holds roughly 1,069 dossier hits in total. Retrying one contact
 * vendor outage across one 500-record job would put four more dossier hits on
 * every record, about 2,000 against that 1,069, so the retries alone would
 * exhaust the pool.
 *
 * So the gate is the DOSSIER, not the whole route: once the record is bought, it
 * is billed and delivered and the row does not go back on the ladder.
 *
 * THAT ARGUMENT FORCES THE NO-RETRY AND NOTHING ELSE. It says nothing about what
 * the row should then SAY, and the two are independent. A contact OUTAGE settled
 * with the same values as a genuine contact MISS tells a customer who paid full
 * price for a two-call product, and got one call, that we looked and found
 * nobody. The last three tests here are the ones that hold that line.
 */
describe("the dossier answered but the CONTACT vendor could not be asked", () => {
  beforeEach(() => {
    H.entityContacts = { success: false, hit: false, contacts: null, error: "FastAppend 503" };
  });

  it("bills the record that was bought and settles the row terminally", async () => {
    // MUTATION: gate on `execution.success` instead of the dossier steps and
    // this goes red three ways at once -- no deduct, no settle, and the row back
    // on the ladder to re-buy a dossier it already owns.
    const body = await (await run()).json();

    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
    expect(body.billed).toBe(1);
    expect(body.errored).toBe(0);
    expect(finalWrite()).toMatchObject({
      status: "no_match",
      is_successful: false,
      charge: TIER2_WALLET,
      tier: 2,
    });
    expect(finalWrite().property_record).toBe(H.dossier.property);
    // Not retried. A retry would re-buy the record we are holding.
    expect(finalWrite().property_trace_status).not.toBe("queued_2");
    expect(isPropertyTracePending(String(finalWrite().property_trace_status))).toBe(false);
  });

  it("does NOT record it as a genuine miss, because we never finished asking", async () => {
    // THE HONESTY LINE. Billing it is right and not retrying it is right, and
    // neither of those buys the right to label an outage as a result. This row
    // and a real contact miss are otherwise byte-identical -- same status, same
    // is_successful, same charge, same empty trace_result -- so the terminal
    // status is the ONLY thing that can tell them apart afterwards.
    // MUTATION: write PROPERTY_TRACE_SETTLED_STATUS unconditionally and this
    // goes red.
    const body = await (await run()).json();

    expect(finalWrite().property_trace_status).toBe(PROPERTY_TRACE_NO_REACH_STATUS);
    expect(finalWrite().property_trace_status).not.toBe(PROPERTY_TRACE_SETTLED_STATUS);
    expect(body.contactsUnreachable).toBe(1);
    // NOT counted as a miss. Summing the two would hide the outage in a number
    // that looks normal.
    expect(body.noContacts).toBe(0);
  });

  it("is distinguishable from a real contact miss on the row itself", async () => {
    // Run both outcomes through the same cron and compare what is persisted. A
    // customer and an operator can only ever see the row.
    await run();
    const outage = finalWrite().property_trace_status;

    H.ops = [];
    H.rpcCalls = [];
    H.queuedRows = [{ ...ROW }];
    H.entityContacts = { ...CONTACTS_MISS };
    await run();
    const genuineMiss = finalWrite().property_trace_status;

    expect(genuineMiss).toBe(PROPERTY_TRACE_SETTLED_STATUS);
    expect(outage).not.toBe(genuineMiss);
    // ...and each carries its own sentence, one of which must never say the row
    // was free, because it was not.
    expect(propertyTraceSkipReason(String(outage))).toBeTruthy();
    expect(propertyTraceSkipReason(String(genuineMiss))).toBeNull();
  });

  it("leaves the operator a log line naming the row and the vendor error", async () => {
    // PTP has no alerting channel by David's explicit decision, so this cron's
    // counters and logs are the only place an outage can ever surface. A
    // 500-record job billing full rate through a FastAppend outage must not
    // produce zero log lines.
    // MUTATION: delete the console.error and this goes red.
    await run();
    const logged = errorLogs().filter((line) => line.includes("contacts unreachable"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("row-1");
    expect(logged[0]).toContain("FastAppend 503");
  });
});

describe("a genuine contact miss", () => {
  it("settles as a normal billed miss, with no outage signal raised", async () => {
    // The other side of the fence above: the vendor ANSWERED and has no record
    // of this owner. That is a complete answer, it is billed, and it must not
    // trip the outage counter or write an outage log line.
    H.entityContacts = { ...CONTACTS_MISS };
    const body = await (await run()).json();

    expect(body.noContacts).toBe(1);
    expect(body.contactsUnreachable).toBe(0);
    expect(finalWrite().property_trace_status).toBe(PROPERTY_TRACE_SETTLED_STATUS);
    expect(errorLogs().filter((line) => line.includes("contacts unreachable"))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * WHICH VENDOR, AND AT WHAT PRICE.
 * ------------------------------------------------------------------ */

describe("owner type selects the vendor, never the price", () => {
  it("routes an ENTITY owner of record to the business trace", async () => {
    await run();
    expect(lookupBusinessTrace).toHaveBeenCalledWith({
      company_name: "Acme Holdings Llc",
      state: "TX",
    });
    expect(lookupPersonTrace).not.toHaveBeenCalled();
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
  });

  it("routes an INDIVIDUAL owner of record to the person trace, at the SAME price", async () => {
    // L-005 records two full implementation passes lost to an entity rate that
    // does not exist. MUTATION: introduce any owner-type branch in the pricing
    // and the two amounts stop matching.
    H.dossier = {
      ...ENTITY_HIT,
      owners: [{ first_name: "Testowner", last_name: "Placeholder", age: "50" }],
    };
    await run();
    expect(lookupPersonTrace).toHaveBeenCalled();
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
  });
});

/**
 * TRACK A AND TRACK B PRICE DIFFERENTLY, AND THE ONLY THING SEPARATING THEM IS
 * A FEATURE FLAG THAT IS OFF IN TESTS.
 *
 * hasSuiteAccess() is gated on NEXT_PUBLIC_SUITE_SIGNIN_ENABLED, which is false
 * here and TRUE in production. With the flag off, a gateway grant counts for
 * nothing and both tracks collapse to the wallet column, so a pair of tests
 * asserting that the tracks DIFFER passes under the correct implementation and
 * under the incorrect one alike. That is L-009, and this project has earned it
 * twice. Every test below sets the flag first, and the probe at the end proves
 * the flag is what makes the difference possible.
 */
describe("the track is the pricing axis, not the user", () => {
  const GRANT_HOLDER = {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: ["prop-tracer-pro"],
  };

  it("bills a grant holder the GRANT-AWARE rate on a Track A row", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = { ...GRANT_HOLDER };
    // 'web' is Track A, tagged by app/api/trace/bulk/route.ts.
    H.queuedRows = [{ ...ROW, source: "web" }];
    await run();
    expect(deducts()[0].args.p_amount).toBe(TIER2_PRO);
  });

  it("bills that same grant holder the RAW rate on a Track B row", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = { ...GRANT_HOLDER };
    // A v1 bulk row carries no source. Untagged is Track B, which is also the
    // dearer derivation, so the fallback errs in the safe direction.
    H.queuedRows = [{ ...ROW, source: null }];
    await run();
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
    // The whole point: reusing the Track A helper here would move an existing
    // API caller's bill from $0.40 to $0.25, in the direction nobody reports.
    expect(deducts()[0].args.p_amount).not.toBe(TIER2_PRO);
  });

  it("proves the flag is load-bearing, so the pair above is not a tautology", async () => {
    // WITHOUT this test the two above assert nothing. With the flag OFF the
    // grant counts for nothing, both tracks price from the wallet column, and
    // both assertions hold under an implementation that ignores the track
    // entirely. Run the Track A case again with the flag off and watch the
    // answer change.
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    H.profile = { ...GRANT_HOLDER };
    H.queuedRows = [{ ...ROW, source: "web" }];
    await run();
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
    expect(deducts()[0].args.p_amount).not.toBe(TIER2_PRO);
  });

  it("prices an unknown user from the dearest column rather than guessing", async () => {
    // A cheap default once billed pay-as-you-go customers 40% under rate,
    // silently, because nobody reports being undercharged (FAILSAFE_PRICE_PLAN).
    H.profile = null;
    await run();
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
  });
});

/* ------------------------------------------------------------------ *
 * CHARGE ONCE PER ROW, EVER.
 * ------------------------------------------------------------------ */

describe("a row that has already been charged", () => {
  beforeEach(() => {
    // Deliberately an amount NO current rate can produce. If the row comes out
    // carrying 0.05 it can only have read the ledger; if it comes out carrying a
    // plan rate it re-derived the price, which is the bug wearing a disguise.
    //
    // Booked DURING this job, which is what makes it the crash window rather
    // than an earlier submit: deduct, throw, requeue, re-claim.
    H.priorDebits = [{ amount: 0.05, type: "debit", created_at: DURING_THIS_JOB }];
  });

  it("cannot be charged a second time by this cron", async () => {
    // The reachable sequence is this cron's own catch: deduct, throw, requeue,
    // re-claim, deduct again. MUTATION: delete the collectedChargeFor probe and
    // deduct unconditionally, and this goes red -- the customer pays twice.
    await run();
    expect(deducts()).toHaveLength(0);
  });

  it("persists the amount that already moved, not zero and not a fresh rate", async () => {
    // Zero would tell the customer the row was free while their wallet says
    // otherwise; re-deriving the rate would restate a past charge at today's
    // price. The ledger holds the only true number.
    await run();
    expect(finalWrite()).toMatchObject({ charge: 0.05, tier: 2 });
  });

  it("asks the ledger about THIS row, not the user's debits in general", async () => {
    await run();
    const probe = H.ops.find((o) => o.table === "wallet_transactions" && o.op === "select");
    expect(probe).toBeDefined();
    expect(
      probe!.filters.some((f) => f[0] === "eq" && f[1] === "trace_history_id" && f[2] === "row-1")
    ).toBe(true);
  });

  it("still charges a row the ledger has never seen", async () => {
    // The guard must not become a blanket refusal to bill.
    H.priorDebits = [];
    await run();
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
  });

  it("still charges a row whose every debit was handed back", async () => {
    // A REFUND IS NOT A COLLECTION. `> 0`, not `!== null`: a row whose debits
    // were all credited back nets to zero, and zero is not money in our pocket.
    // MUTATION: test `!== null` at the call site and this goes red at zero
    // deducts, delivering the record free while the row claims it collected.
    H.priorDebits = [
      { amount: 0.05, type: "debit", created_at: DURING_THIS_JOB },
      { amount: 0.05, type: "credit", created_at: DURING_THIS_JOB },
    ];
    await run();
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
  });
});

/* ------------------------------------------------------------------ *
 * AND THE OTHER HALF OF "ONCE": ONCE PER PIECE OF WORK, NOT ONCE PER ADDRESS.
 *
 * trace_history is UNIQUE(user_id, address_hash), so a second submit of the same
 * address does not insert a second row, it RE-ENQUEUES this one under a new job.
 * That is a second, genuine piece of vendor work: the cron re-buys the $0.20
 * dossier and re-spends the shared Tracerfy pool. An unbounded ledger probe
 * answered it with the FIRST submit's debit, so the deduct was skipped and PTP
 * collected $0.00 -- repeatably, because nothing in that state ever changes.
 * Reachable today on v1 and MCP, where checkDuplicates is a documented no-op for
 * want of a session cookie, and on the dashboard the day the 90 day window
 * lapses.
 * ------------------------------------------------------------------ */

describe("a row re-enqueued by a LATER submit", () => {
  beforeEach(() => {
    // The first submit's debit, months old. The row has been settled and reused.
    H.priorDebits = [{ amount: TIER2_WALLET, type: "debit", created_at: BEFORE_THIS_JOB }];
    H.queuedRows = [{ ...ROW, charge: TIER2_WALLET, tier: 2 }];
  });

  it("is charged again, because the vendor work is being done again", async () => {
    // MUTATION: drop the `since` argument from the collectedChargeFor call and
    // this goes red at zero deducts. That is the shape the defect had: real
    // vendor money out, nothing collected, every time the caller resubmits.
    await run();
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(TIER2_WALLET);
  });

  it("adds the new collection to the receipt rather than restating the old one", async () => {
    // The ledger now holds two debits against this row and
    // `trace_history.charge` is summed as what the customer paid. Writing the
    // probe's answer raw would report one of the two.
    // MUTATION: write `charge: collected` instead of the fold and this goes red
    // at 0.4, under-reporting by exactly the earlier submit.
    await run();
    expect(finalWrite()).toMatchObject({ charge: TIER2_WALLET * 2, tier: 2 });
  });

  it("reads the job it is currently enqueued for, which is what scopes the probe", async () => {
    // The row is reused across submits, so `trace_job_id` is the only thing on it
    // that says which piece of work this is.
    await run();
    const jobRead = H.ops.find((o) => o.table === "trace_jobs" && o.op === "select");
    expect(jobRead).toBeDefined();
    expect(
      jobRead!.filters.some((f) => f[0] === "eq" && f[1] === "id" && f[2] === "job-1")
    ).toBe(true);
  });

  it("selects created_at, because the window is decided from it", async () => {
    // MUTATION: drop created_at from the ledger select and every row falls
    // outside every window, which charges a customer twice in the crash window.
    await run();
    const probe = H.ops.find((o) => o.table === "wallet_transactions" && o.op === "select");
    expect(String(probe!.filters[0][1])).toContain("created_at");
  });

  it("falls back to the WHOLE ledger when the job cannot be read", async () => {
    // The safe direction, and it is not symmetric: an unbounded probe can only
    // skip a charge PTP is owed, while a bound taken from a job we could not
    // read could charge a customer twice for one piece of work.
    // MUTATION: default the bound to "now", or to the row's claim time, and this
    // goes red with a second debit against a customer who owes nothing.
    H.jobRow = null;
    await run();
    expect(deducts()).toHaveLength(0);
    expect(finalWrite()).toMatchObject({ charge: TIER2_WALLET });
  });
});

/* ------------------------------------------------------------------ *
 * RECEIPTS ARE MONOTONIC, EXHAUSTION INCLUDED.
 *
 * lib/trace/entityTraceAttempts.ts says "an exhausted row is written terminal
 * with no charge, no tier and no ai_research_charge". Under tier 2 that sentence
 * is false: a row CAN be exhausted and billed.
 * ------------------------------------------------------------------ */
describe("a row that already carries a tier 2 receipt", () => {
  beforeEach(() => {
    H.queuedRows = [
      {
        ...ROW,
        property_trace_status: `queued_${MAX_PROPERTY_TRACE_ATTEMPTS}`,
        charge: 0.4,
        tier: 2,
      },
    ];
    H.dossier = { ...DOSSIER_FAILURE };
  });

  it("keeps the charge and the tier when it exhausts", async () => {
    // MUTATION: add `charge: 0, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE` to the
    // exhausted payload -- the shape the entity cron's sentence invites -- and
    // this goes red. In production that write makes the row read UNBILLED to
    // excludeBilledRows while wallet_transactions still references it, so the
    // next submit's delete raises 23503 and the address 500s forever.
    const body = await (await run()).json();

    expect(body.exhausted).toBe(1);
    expect(deducts()).toHaveLength(0);
    for (const paid of ["charge", "tier", "ai_research_charge"]) {
      expect(Object.keys(finalWrite())).not.toContain(paid);
    }
    expect(finalWrite()).toMatchObject({
      property_trace_status: PROPERTY_TRACE_FAILED_STATUS,
      property_trace_claimed_at: null,
      status: "error",
      is_successful: false,
    });
  });

  it("never downgrades the tier when it settles normally", async () => {
    // foldBillingWrite is one-way. A flat literal here would kill
    // isCacheHitRow's third arm and the customer would re-buy what they own.
    H.dossier = { ...ENTITY_HIT };
    await run();
    expect(finalWrite().tier).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * THE CLAIM PROTOCOL.
 * ------------------------------------------------------------------ */

describe("claiming", () => {
  it("does no work on a row another worker already claimed", async () => {
    H.claimOutcomes = [false];
    const body = await (await run()).json();
    expect(body.processed).toBe(0);
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
  });

  it("gives one row of two racing workers to exactly one of them", async () => {
    // The compare-and-swap is the whole guard: both workers read the row, both
    // try to flip it, and the database lets one win. The loser must spend
    // nothing at all. MUTATION: drop the `.eq('property_trace_status', ...)`
    // arm, or stop checking the maybeSingle() result, and both rows are traced
    // and both are billed.
    H.queuedRows = [{ ...ROW }, { ...ROW, id: "row-2" }];
    H.claimOutcomes = [true, false];
    const body = await (await run()).json();

    expect(body.processed).toBe(1);
    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(deducts()).toHaveLength(1);
  });

  it("claims on the status the row is ACTUALLY in, not a hardcoded first rung", async () => {
    // MUTATION: compare against the literal 'queued' and a retried row can never
    // be claimed again -- it sits at queued_2 forever, which is the starvation
    // the ladder exists to end.
    H.queuedRows = [{ ...ROW, property_trace_status: "queued_3" }];
    await run();
    const claim = H.ops.find(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload?.property_trace_status === "processing_3"
    );
    expect(claim).toBeDefined();
    expect(claim!.filters.some((f) => f[0] === "eq" && f[2] === "queued_3")).toBe(true);
  });

  it("sets the claim timestamp with the status flip, never after it", async () => {
    // The timestamp is the stale sweep's only lifeline. A claim written without
    // one is invisible to both queries and pins its bulk job open forever.
    await run();
    const claim = H.ops.find(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload?.property_trace_status === "processing"
    );
    expect(claim).toBeDefined();
    expect(claim!.payload!.property_trace_claimed_at).toEqual(expect.any(String));
  });

  it("takes the oldest rows first, up to the per-run budget", async () => {
    await run();
    const query = claimQuery();
    expect(query).toBeDefined();
    // 120 records at concurrency 5 is 240 calls/minute against a SHARED 500/min
    // Tracerfy pool. MUTATION: raise the limit and the pool starves every other
    // caller, single traces included.
    expect(query!.filters.some((f) => f[0] === "limit" && f[1] === 120)).toBe(true);
    expect(
      query!.filters.some((f) => f[0] === "order" && f[1] === "created_at")
    ).toBe(true);
    // Every rung is claimable, not just the first.
    const inFilter = query!.filters.find((f) => f[0] === "in");
    expect(inFilter![2]).toHaveLength(MAX_PROPERTY_TRACE_ATTEMPTS);
  });

  it("runs at most CONCURRENCY records at a time", async () => {
    // Two calls per record against a 500/min pool shared with every other
    // Tracerfy endpoint. MUTATION: await each row in sequence and maxInFlight
    // drops to 1; drop the pool and run Promise.all over every claimed row and
    // it jumps to the whole batch.
    H.slowDossier = true;
    H.queuedRows = Array.from({ length: 12 }, (_, i) => ({ ...ROW, id: `row-${i}` }));
    const body = await (await run()).json();

    expect(body.processed).toBe(12);
    expect(H.maxInFlight).toBe(5);
  });
});

describe("stale claims", () => {
  it("reverts a claim that never came back, one rung further up the ladder", async () => {
    await run();
    const revert = H.ops.find(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload?.property_trace_status === "queued_2" &&
        o.filters.some((f) => f[0] === "eq" && f[2] === "processing")
    );
    expect(revert).toBeDefined();
    expect(staleFilter(revert!)).toBeDefined();
  });

  it("sweeps a claimed row whose claim timestamp is NULL", async () => {
    // SQL `<` never matches NULL, so a row in processing_N with a null
    // property_trace_claimed_at would be invisible to BOTH queries -- the claim
    // query only looks at the queued rungs -- and would hold its parent bulk job
    // at 'processing' forever with nothing able to touch it.
    // MUTATION: replace the `.or()` with a bare `.lt()` and this goes red.
    await run();
    const filter = staleFilter(
      H.ops.find(
        (o) =>
          o.table === "trace_history" &&
          o.op === "update" &&
          o.payload?.property_trace_status === "queued_2"
      )!
    );
    expect(filter).toBeDefined();
    expect(String(filter![1])).toContain("property_trace_claimed_at.is.null");
    expect(String(filter![1])).toContain("property_trace_claimed_at.lt.");
  });

  it("counts a killed claim as a SPENT attempt, so a poison row cannot loop forever", async () => {
    // A row that kills the run every time is exactly as poisonous as one the
    // vendor keeps refusing. Reverting it to attempt 1 would let it loop until
    // somebody noticed the bill. MUTATION: revert every rung to 'queued' and
    // this goes red -- nothing ever exhausts.
    H.queuedRows = [];
    H.staleRevertsByStatus = {
      [`processing_${MAX_PROPERTY_TRACE_ATTEMPTS}`]: [{ id: "stale-1" }],
    };
    const body = await (await run()).json();

    expect(body.staleReverted).toBe(1);
    expect(body.exhausted).toBe(1);
    const retire = H.ops.find(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload?.property_trace_status === PROPERTY_TRACE_FAILED_STATUS
    );
    expect(retire).toBeDefined();
    expect(retire!.payload).toMatchObject({ status: "error", is_successful: false });
    // ...and it does NOT zero a receipt on the way out.
    for (const paid of ["charge", "tier"]) {
      expect(Object.keys(retire!.payload!)).not.toContain(paid);
    }
  });

  it("runs the stale sweep BEFORE it looks for queued rows", async () => {
    // The only way a row killed mid-run is ever retried: the claim query below
    // it looks at the queued rungs alone.
    await run();
    const firstRevert = H.ops.findIndex(
      (o) => o.op === "update" && o.payload?.property_trace_status === "queued_2"
    );
    const firstClaimQuery = H.ops.findIndex(
      (o) => o.op === "select" && o.filters.some((f) => f[0] === "in")
    );
    expect(firstRevert).toBeGreaterThanOrEqual(0);
    expect(firstRevert).toBeLessThan(firstClaimQuery);
  });
});

/* ------------------------------------------------------------------ *
 * THE LADDER.
 * ------------------------------------------------------------------ */

describe("the retry ladder", () => {
  beforeEach(() => {
    H.dossier = { ...DOSSIER_FAILURE };
  });

  it("climbs one rung per failure while attempts remain", async () => {
    H.queuedRows = [{ ...ROW, property_trace_status: "queued_2" }];
    await run();
    expect(finalWrite().property_trace_status).toBe("queued_3");
  });

  it("gives up on the last attempt and writes the row terminal", async () => {
    // MUTATION: drop the exhausted branch so it re-queues instead, and the
    // oldest poisoned rows hold the claim window shut against every newer row.
    H.queuedRows = [{ ...ROW, property_trace_status: `queued_${MAX_PROPERTY_TRACE_ATTEMPTS}` }];
    const body = await (await run()).json();

    expect(body.exhausted).toBe(1);
    expect(finalWrite()).toMatchObject({
      property_trace_status: PROPERTY_TRACE_FAILED_STATUS,
      property_trace_claimed_at: null,
      status: "error",
      is_successful: false,
    });
    // Terminal, so nothing reads it as pending and the bulk job can settle.
    expect(isPropertyTracePending(PROPERTY_TRACE_FAILED_STATUS)).toBe(false);
  });

  it("charges nothing on the way to terminal, because we never got an answer", async () => {
    H.queuedRows = [{ ...ROW, property_trace_status: `queued_${MAX_PROPERTY_TRACE_ATTEMPTS}` }];
    await run();
    expect(deducts()).toHaveLength(0);
  });

  it("gives the customer a reason instead of a silent empty row", async () => {
    const reason = propertyTraceSkipReason(PROPERTY_TRACE_FAILED_STATUS);
    expect(reason).toBeTruthy();
    expect(reason).toContain("not charged");
  });
});

/* ------------------------------------------------------------------ *
 * A ROW NO VENDOR CAN EVER BE ASKED ABOUT.
 * ------------------------------------------------------------------ */

describe("a row with no usable lookup key", () => {
  beforeEach(() => {
    // The session bulk route does not validate per record, so a row with no city
    // really does reach the queue. planRoute emits no step for it.
    H.queuedRows = [{ ...ROW, city: "", normalized_address: "100 MAIN ST||TX" }];
  });

  it("is settled terminal and free, and no vendor is called", async () => {
    // MUTATION: delete the plan.steps.length branch and the row burns all five
    // attempts asking an unanswerable question, holding claim slots that belong
    // to rows that can work.
    const body = await (await run()).json();

    expect(lookupDossier).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
    expect(body.skippedNoKey).toBe(1);
    expect(finalWrite()).toMatchObject({
      property_trace_status: PROPERTY_TRACE_NO_KEY_STATUS,
      property_trace_claimed_at: null,
      status: "no_match",
      is_successful: false,
    });
  });

  it("writes nothing money-shaped, so an unpaid row stays deletable", async () => {
    await run();
    for (const paid of ["charge", "tier", "ai_research_charge", "cost"]) {
      expect(Object.keys(finalWrite())).not.toContain(paid);
    }
  });

  it("does not leave the row queued, so the bulk job can finish", async () => {
    await run();
    expect(isPropertyTracePending(PROPERTY_TRACE_NO_KEY_STATUS)).toBe(false);
  });

  it("carries a reason that says we never looked, not that we found nobody", async () => {
    const reason = propertyTraceSkipReason(PROPERTY_TRACE_NO_KEY_STATUS);
    expect(reason).toBeTruthy();
    expect(reason).toContain("not charged");
  });
});

describe("an empty queue", () => {
  it("returns without claiming anything and still reports the stale sweep", async () => {
    H.queuedRows = [];
    const body = await (await run()).json();
    expect(body.processed).toBe(0);
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(body.staleReverted).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * THE FENCE. THIS CRON MUST NEVER CALL HIGHLEVEL.
 *
 * PTP's own push only ever creates Contacts. Most PTP users reach their CRM
 * through the Suite Gateway, which holds the GoHighLevel snapshot and knows the
 * object model: an entity owner is a Company, a person is a Contact and only
 * when there is a phone or an email, and the property hangs on a property
 * custom object. An automatic push from here writes the WRONG OBJECT TYPE into
 * that snapshot, and for a user with no gateway there is no snapshot for it to
 * populate at all.
 *
 * PTP never calls HighLevel unless a person asked it to, and a cron is the
 * furthest thing from a person asking. A settled Full Property Trace reaches
 * the CRM through the Push to CRM button, app/api/integrations/highlevel/push.
 *
 * This cron is the one place all three bulk surfaces meet (session, v1 and
 * MCP), so it is also the single site that could reach the most CRMs by
 * accident. Set up with EXACTLY the conditions that used to push: a credential
 * on the profile and a tier 2 row settling successfully with contacts on it.
 * ------------------------------------------------------------------ */

/** A push record write would be the only trace_history update carrying these columns. */
const pushRecords = () => historyWrites().filter((p) => "highlevel_pushed_at" in p);
/** The settle write, ie every trace_history update that is NOT a push record. */
const settleWrites = () => historyWrites().filter((p) => !("highlevel_pushed_at" in p));

/** A profile with a HighLevel credential on it, which is what used to unlock the push. */
const CONNECTED = {
  subscription_tier: "wallet",
  is_acquisition_pro_member: false,
  gateway_products: [],
  highlevel_api_key: "hl-key",
  highlevel_location_id: "loc-1",
};

describe("the property-trace sweep never pushes to HighLevel", () => {
  beforeEach(() => {
    H.profile = { ...CONNECTED };
    vi.mocked(pushTraceToHighLevel).mockClear();
  });

  it("does not call HighLevel on a tier 2 row it just settled with contacts", async () => {
    await run();
    await flushDeferred();

    expect(pushTraceToHighLevel).not.toHaveBeenCalled();
  });

  it("writes no push record and no credential verdict, because nothing was pushed", async () => {
    await run();
    await flushDeferred();

    expect(pushRecords()).toEqual([]);
    expect(
      H.ops.filter(
        (o) =>
          o.table === "user_profiles" &&
          o.op === "update" &&
          o.payload &&
          "highlevel_invalid_at" in o.payload
      )
    ).toEqual([]);
  });

  it("never reads the credential columns at all on this path", async () => {
    // The credential read went with the push. Reading a key on a path that
    // cannot use it is how a push gets reattached by someone who sees the
    // value already in hand.
    await run();
    await flushDeferred();

    // The recorder stores a select's column list as ["select", ...args] in
    // `filters`, so the columns asked for are read back from there.
    const profileSelects = H.ops.filter(
      (o) => o.table === "user_profiles" && o.op === "select"
    );
    // The precondition: this cron really does still read the profile, for
    // pricing. If it stopped, the assertion below would pass on an empty list.
    expect(profileSelects.length).toBeGreaterThan(0);
    for (const select of profileSelects) {
      expect(JSON.stringify(select.filters)).not.toContain("highlevel_api_key");
      expect(JSON.stringify(select.filters)).not.toContain("highlevel_location_id");
    }
  });

  it("settles the row exactly as it always did", async () => {
    // The removal took the push out, not the settle. A green fence on a cron
    // that stopped working would be worthless.
    await run();
    await flushDeferred();

    const settle = settleWrites()[settleWrites().length - 1];
    expect(settle.status).toBe("success");
    expect(settle.is_successful).toBe(true);
    expect(settle.property_trace_status).toBe(PROPERTY_TRACE_SETTLED_STATUS);
  });
});

describe("D21 in the tier 2 cron: every owner, and no dossier contacts in Phase 1", () => {
  const TWO_INDIVIDUALS = {
    ...ENTITY_HIT,
    owners: [
      { first_name: "Testowner", last_name: "Placeholder", age: "00" },
      { first_name: "Secondowner", last_name: "Placeholder", age: "00" },
    ],
    contacts: {
      ownerName: null,
      phones: [{ number: "5550000901", type: "mobile" }],
      emails: [],
      mailingAddress: null,
    },
  };

  beforeEach(() => {
    H.dossier = TWO_INDIVIDUALS;
  });

  it("asks about the second owner when the first misses", async () => {
    vi.mocked(lookupPersonTrace)
      .mockResolvedValueOnce({ ...CONTACTS_MISS })
      .mockResolvedValueOnce({ ...CONTACTS_HIT });
    await run();
    expect(lookupPersonTrace).toHaveBeenCalledTimes(2);
    expect(vi.mocked(lookupPersonTrace).mock.calls[1][0]).toMatchObject({ first_name: "Secondowner" });
    expect(finalWrite()).toMatchObject({ status: "success", is_successful: true, contact_vendor: "tracerfy" });
    expect((finalWrite().trace_result as Record<string, unknown>).name_verified).toBeUndefined();
  });

  it("does NOT return the dossier's own contacts in Phase 1, because bulk surfaces cannot show the label yet", async () => {
    // D21 (b) is switched on by the two single routes only (ExecuteOptions.dossierContactsFallback).
    // MUTATION: make the fallback ignore the flag and this goes red with phone_count 1.
    H.personContacts = { ...CONTACTS_MISS };
    await run();
    expect(lookupPersonTrace).toHaveBeenCalledTimes(2);
    expect(finalWrite()).toMatchObject({ status: "no_match", is_successful: false, phone_count: 0 });
  });
});
