import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { chargePerTrace } from "@/lib/suite/pricing";
import { BLANK_OWNER_SKIP_STATUS, skipReasonFor } from "@/lib/trace/blankOwnerSkip";
import {
  ENTITY_TRACE_FAILED_STATUS,
  MAX_ENTITY_TRACE_ATTEMPTS,
  isEntityTracePending,
} from "@/lib/trace/entityTraceAttempts";
import { planRoute, type RouteStep, type StepKind } from "@/lib/routing/ownerRoute";
import type { Tier1RecordResult } from "@/lib/trace/singleTier1";
import { TIER1_OUTCOME } from "@/lib/trace/tier1Outcome";
import { VENDOR_RATE_LIMIT } from "@/lib/trace/vendorRateBudget";

/**
 * Money fences for the entity sweep, the cron that resolves the entity-owned
 * rows of a bulk job.
 *
 * It was sweep-bulk-research until 2026-09-17, when the Brave plus Claude AI
 * Search engine behind it was removed and it was re-pointed at the synchronous
 * FastAppend business trace. 987 of the 1,301 rows the old engine ever produced
 * came through here, so this is the path that has to keep working.
 *
 * THREE THINGS THESE TESTS EXIST TO HOLD:
 *
 * 1. The $0.15 research fee is GONE. Nothing here books it. It is not enough to
 *    read the code for that, because 0.15 is ALSO the tier 1 Pro rate
 *    (lib/constants.ts warns the digits collide), so every test below uses a
 *    Pay-As-You-Go profile whose tier 1 rate is 0.25. A stray 0.15 deduction is
 *    then unambiguous.
 * 2. Bill on whether we could ASK, never on whether we FOUND anything (L-007).
 *    A FastAppend outage and a FastAppend miss both come back with no contacts,
 *    and only one of them is the customer's problem.
 * 3. A row with no owner name is never charged, never queued and never left to
 *    speak for itself as a bare no_match.
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
  queuedRows: [] as Array<Record<string, unknown>>,
  // wallet_transactions rows already booked against the row being processed.
  // A non-empty array is the state a row is in after a previous run deducted
  // and then died before it could write the result back.
  //
  // `type` IS LOAD-BEARING AND EVERY ENTRY MUST CARRY IT. collectedChargeFor
  // nets debits against credits, so a row with no `type` reads as money handed
  // BACK and flips the sign of the probe's answer. PostgREST would never omit a
  // selected column; a stub that does is telling the route a lie no database
  // can tell it.
  priorDebits: [] as Array<Record<string, unknown>>,
  claimOk: true,
  /** Rows whose atomic claim loses the race, by id. The Tier 1 lane's per-row form of claimOk. */
  claimFails: new Set<string>(),
  profile: {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: [] as string[],
  } as Record<string, unknown> | null,
  /** Per-user profile overrides, so a Tier 1 row's own user can be priced. */
  profiles: new Map<string, Record<string, unknown> | null>(),
  /** trace_jobs rows, keyed by id. The Tier 1 lane reads created_at off one to bound its probe. */
  jobs: new Map<string, Record<string, unknown>>(),
  /** Every deduct_wallet_balance the route asked the database for, as a spy. */
  deductWallet: vi.fn(),
  businessTrace: { success: true, hit: false, contacts: null } as Record<string, unknown>,
  submit: { success: true, jobId: "tf-person-1" } as Record<string, unknown>,
}));

/**
 * One clause of a PostgREST `.or()` expression, evaluated against a seeded row.
 *
 * The Tier 1 stale sweep and the entity one both carry BOTH arms
 * (`claimed_at.is.null,claimed_at.lt.<iso>`), and a stub that ignored the filter could not tell a
 * missing NULL arm from a present one. The ISO timestamp contains dots, so the value is rejoined.
 */
function orMatches(expr: string, row: Record<string, unknown>): boolean {
  return expr.split(",").some((clause) => {
    const [column, op, ...rest] = clause.split(".");
    const value = rest.join(".");
    const held = row[column];
    if (op === "is") return held === null || held === undefined;
    if (op === "lt") return held !== null && held !== undefined && String(held) < value;
    return false;
  });
}

/**
 * The seeded rows a statement's filters actually select.
 *
 * The stub used to hand every row to every query, which cannot tell the two lanes apart: the whole
 * safety argument for sharing one column is that the Tier 1 lane claims `.in(TIER1_QUEUED_STATUSES)`
 * and the entity lane claims `.in(ENTITY_QUEUED_STATUSES)`, so a stub blind to `.in()` would pass
 * whether or not that held.
 */
function rowsMatching(filters: Filter[]): Array<Record<string, unknown>> {
  let rows = H.queuedRows;
  for (const f of filters) {
    const column = String(f[1]);
    if (f[0] === "in") {
      const values = (f[2] as unknown[]) || [];
      rows = rows.filter((r) => values.includes(r[column] as never));
    } else if (f[0] === "eq") {
      rows = rows.filter((r) => r[column] === f[2]);
    } else if (f[0] === "lt") {
      rows = rows.filter(
        (r) => r[column] !== null && r[column] !== undefined && String(r[column]) < String(f[2])
      );
    } else if (f[0] === "or") {
      rows = rows.filter((r) => orMatches(String(f[1]), r));
    }
  }
  const limit = filters.find((f) => f[0] === "limit");
  return limit ? rows.slice(0, Number(limit[1])) : rows;
}

/** The `.eq('id', x)` a statement was aimed at, or '' for a bulk statement. */
const targetId = (filters: Filter[]): string => {
  const f = filters.find((x) => x[0] === "eq" && x[1] === "id");
  return f ? String(f[2]) : "";
};

/**
 * Payloads are snapshotted with their ARRAYS COPIED.
 *
 * The Tier 1 lane's per-arrival step-log write passes the same accumulator array on every call, and
 * PostgREST serialises it at call time. A stub that kept the reference would show the final length
 * on every write, so "one step, then two" could not be told from "two, then two".
 */
const snapshot = (payload: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) out[k] = Array.isArray(v) ? [...v] : v;
  return out;
};

/** Records every trace_history read and write and resolves each chain the way
 *  PostgREST would for the shape the route actually builds. */
function recordingClient() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      H.rpcCalls.push({ fn, args });
      if (fn === "deduct_wallet_balance") H.deductWallet(args);
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
        if (table === "wallet_transactions") return { data: H.priorDebits, error: null };
        if (rec?.op === "select") return { data: rowsMatching(rec.filters), error: null };
        // An update that asked for `.select('id')` and is awaited directly is the
        // stale-claim revert; it wants back the rows its filters actually moved.
        if (rec?.op === "update" && sawSelect)
          return { data: rowsMatching(rec.filters).map((r) => ({ id: r.id })), error: null };
        return { data: null, error: null };
      };

      node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(settle()).then(res, rej);
      node.maybeSingle = async () => {
        // The atomic claim: `.update(...).eq(id).eq(status).select('id').maybeSingle()`.
        if (rec?.op === "update") {
          const id = targetId(rec.filters) || "row-1";
          if (!H.claimOk || H.claimFails.has(id)) return { data: null, error: null };
          return { data: { id }, error: null };
        }
        return { data: null, error: null };
      };
      node.single = async () => {
        const id = rec ? targetId(rec.filters) : "";
        if (table === "trace_jobs") return { data: H.jobs.get(id) ?? null, error: null };
        return {
          data: H.profiles.has(id) ? H.profiles.get(id)! : H.profile,
          error: null,
        };
      };

      return {
        select: (...args: unknown[]) => {
          rec = { table, op: "select", filters: [["select", ...args]] };
          H.ops.push(rec);
          return node;
        },
        update: (payload: Record<string, unknown>) => {
          rec = { table, op: "update", payload: snapshot(payload), filters: [] };
          H.ops.push(rec);
          return node;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => recordingClient() }));
vi.mock("@/lib/tracerfy/client", () => ({
  lookupBusinessTrace: vi.fn(async () => H.businessTrace),
  submitSingleTrace: vi.fn(async () => H.submit),
  // Never reached while runTier1Record is mocked, and mocked anyway so that a regression which
  // stopped going through runTier1Record would show up as an unexpected vendor call, not a real one.
  lookupPersonTrace: vi.fn(),
}));
vi.mock("@/lib/tracerfy/dossier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tracerfy/dossier")>()),
  lookupDossier: vi.fn(),
}));

/**
 * `reservationForSteps` STAYS REAL. The per-call reservation test asserts what it returns, and a stub
 * would assert the stub. Only the two functions that would touch the database are replaced, and
 * `reserveVendorCalls` grants by default so every existing test passes unchanged.
 */
vi.mock("@/lib/trace/vendorRateBudget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trace/vendorRateBudget")>()),
  reserveVendorCalls: vi.fn(async () => true),
  pruneVendorRateWindows: vi.fn(async () => {}),
}));

/**
 * `NotATier1PlanError` and `VendorBudgetThrottledError` STAY REAL, via importOriginal.
 *
 * The Tier 1 lane matches both with `instanceof`, and a factory that replaced a class would break
 * that silently: the lane would fall through to its generic "walk the ladder" arm, a throttled row
 * would spend an attempt, and the test would fail for a reason with nothing to do with the code
 * under test.
 */
vi.mock("@/lib/trace/singleTier1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trace/singleTier1")>()),
  runTier1Record: vi.fn(),
}));

const {
  GET,
  parcelForTier1Row,
  TIER1_MAX_ROWS_PER_RUN,
  TIER1_CONCURRENCY,
  TIER1_RUN_BUDGET_MS,
} = await import("@/app/api/cron/sweep-entity-traces/route");
const { lookupBusinessTrace, submitSingleTrace, lookupPersonTrace } = await import(
  "@/lib/tracerfy/client"
);
const { runTier1Record, VendorBudgetThrottledError } = await import("@/lib/trace/singleTier1");
const { reserveVendorCalls } = await import("@/lib/trace/vendorRateBudget");

const runTier1RecordMock = vi.mocked(runTier1Record);
const reserveVendorCallsMock = vi.mocked(reserveVendorCalls);
const lookupBusinessTraceMock = vi.mocked(lookupBusinessTrace);
const tracePersonMock = vi.mocked(lookupPersonTrace);
const deductWalletMock = H.deductWallet;

const ROW = {
  id: "row-1",
  user_id: "user-1",
  // Present and honest, because the stub now evaluates `.in()`: the two lanes claim DISJOINT status
  // sets, and a fixture with no status could not be on either side of that line.
  ai_research_status: "queued",
  normalized_address: "100 MAIN ST|DALLAS|TX|75001",
  city: "DALLAS",
  state: "TX",
  zip: "75001",
  address_hash: "hash-1",
  input_owner_name: "Acme Holdings Llc",
};

function run(secret = "s3cret") {
  return GET(
    new Request("http://localhost/api/cron/sweep-entity-traces", {
      headers: { authorization: `Bearer ${secret}` },
    })
  );
}

/* ------------------------------------------------------------------ *
 * The TIER 1 lane's fixtures and readers.
 * ------------------------------------------------------------------ */

/** Seed the queue. Every row starts from ROW, so a row needs only the columns it is about. */
const seedRows = (rows: Array<Record<string, unknown>>) => {
  H.queuedRows = rows.map((r) => ({ ...ROW, ...r }));
};

const seedProfile = (userId: string, profile: Record<string, unknown> | null) => {
  H.profiles.set(userId, profile);
};

const seedJob = (jobId: string, job: Record<string, unknown>) => {
  H.jobs.set(jobId, job);
};

const failTheClaim = (id: string) => {
  H.claimFails.add(id);
};

const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000).toISOString();

const runCron = async () => (await run()).json();

/**
 * Every trace_history update that reaches this row: the ones aimed at its id, and the per-rung bulk
 * statements whose status filter is the status the row was seeded in.
 */
const rowUpdates = (id: string): Array<Record<string, unknown>> => {
  const seeded = H.queuedRows.find((r) => r.id === id);
  return H.ops
    .filter((o) => o.table === "trace_history" && o.op === "update")
    .filter((o) => {
      const byId = o.filters.find((f) => f[0] === "eq" && f[1] === "id");
      if (byId) return byId[2] === id;
      const byStatus = o.filters.find((f) => f[0] === "eq" && f[1] === "ai_research_status");
      return !!byStatus && !!seeded && byStatus[2] === seeded.ai_research_status;
    })
    .map((o) => o.payload!);
};

/** The `.eq()` columns each update on this row compared against, in order. */
const claimFilters = (id: string): Array<Record<string, unknown>> =>
  H.ops
    .filter(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.filters.some((f) => f[0] === "eq" && f[1] === "id" && f[2] === id)
    )
    .map((o) => {
      const eqs: Record<string, unknown> = {};
      for (const f of o.filters) if (f[0] === "eq") eqs[String(f[1])] = f[2];
      return eqs;
    });

/** The Tier 1 claim window: the select that asked for the tier1_ rungs. */
const claimWindow = () => {
  const op = H.ops.find(
    (o) =>
      o.table === "trace_history" &&
      o.op === "select" &&
      o.filters.some(
        (f) => f[0] === "in" && (f[2] as string[]).some((v) => String(v).startsWith("tier1"))
      )
  );
  const limit = op?.filters.find((f) => f[0] === "limit");
  const order = op?.filters.find((f) => f[0] === "order");
  return { limit: limit ? Number(limit[1]) : undefined, order: order ? order[1] : undefined };
};

/** A RouteStep of the given kind. Only `kind` selects a pool; the rest is the type's own shape. */
const step = (kind: StepKind): RouteStep => ({
  kind,
  endpoint: '/test',
  request: {},
  costOnHit: 0,
  freeOnMiss: true,
  why: 'test',
});

/** A settled Tier 1 record: a miss, free, which is the default every Tier 1 test starts from. */
const okResult = (): Tier1RecordResult => ({
  execution: { steps: [] } as unknown as Tier1RecordResult["execution"],
  outcome: TIER1_OUTCOME.NO_MATCH,
  foundBy: null,
  skipReason: "No match.",
  result: null,
  status: "no_match",
  charge: 0,
  deduction: "not_attempted",
  persistError: null,
});

/** Every trace_history update payload, in order. */
const historyWrites = () =>
  H.ops.filter((o) => o.table === "trace_history" && o.op === "update").map((o) => o.payload!);

/** The payload of the LAST trace_history update, which is the row's final state. */
const finalWrite = () => historyWrites()[historyWrites().length - 1];

const deducts = () => H.rpcCalls.filter((c) => c.fn === "deduct_wallet_balance");

/**
 * The stale-claim age filter on an update, whatever shape it takes.
 *
 * It used to be a bare `.lt('ai_research_claimed_at', cutoff)`, which cannot
 * match a NULL claim timestamp. It is now an `.or()` carrying both arms, so the
 * assertion asks for the filter rather than for one particular operator.
 */
const staleFilter = (op: Op) =>
  op.filters.find(
    (f) => f[0] === "or" && String(f[1]).includes("ai_research_claimed_at")
  );

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  H.ops = [];
  H.rpcCalls = [];
  H.queuedRows = [{ ...ROW }];
  H.priorDebits = [];
  H.claimOk = true;
  H.claimFails = new Set();
  H.profile = {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: [],
  };
  H.profiles = new Map();
  H.jobs = new Map();
  H.businessTrace = { success: true, hit: false, contacts: null };
  H.submit = { success: true, jobId: "tf-person-1" };
  vi.mocked(lookupBusinessTrace).mockClear();
  vi.mocked(submitSingleTrace).mockClear();
  tracePersonMock.mockClear();
  deductWalletMock.mockClear();
  reserveVendorCallsMock.mockClear();
  reserveVendorCallsMock.mockResolvedValue(true);
  runTier1RecordMock.mockReset();
  runTier1RecordMock.mockResolvedValue(okResult());
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("auth", () => {
  it("401s without the cron secret and touches nothing", async () => {
    const res = await run("wrong");
    expect(res.status).toBe(401);
    expect(H.ops).toHaveLength(0);
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
  });
});

describe("a row with no owner name", () => {
  beforeEach(() => {
    H.queuedRows = [{ ...ROW, input_owner_name: null }];
  });

  it("is skipped with a reason, never traced and never charged", async () => {
    // The engine that used to find an owner from an address alone is gone. There
    // is no vendor to ask, so asking one would be inventing work to bill for.
    // MUTATION: delete the blank-owner branch and this goes red -- the row falls
    // through to lookupBusinessTrace with an empty company name.
    const res = await run();
    const body = await res.json();

    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
    expect(body.skippedNoOwner).toBe(1);
    expect(finalWrite()).toMatchObject({
      ai_research_status: BLANK_OWNER_SKIP_STATUS,
      status: "no_match",
      is_successful: false,
    });
  });

  it("does not leave the row queued, so the bulk job can finish", async () => {
    // A row parked in 'queued' behind a cron that cannot resolve it holds its
    // parent bulk job open forever. The terminal status is what closes it.
    await run();
    expect(finalWrite().ai_research_status).not.toBe("queued");
    expect(finalWrite().ai_research_status).not.toBe("processing");
    expect(finalWrite().ai_research_claimed_at).toBeNull();
  });

  it("writes nothing money-shaped, so the row stays deletable", async () => {
    // isBilledRow() treats charge / ai_research_charge / property_record as the
    // marks of a receipt. A row we never traced is not a receipt.
    await run();
    for (const paid of ["charge", "ai_research_charge", "tier", "cost"]) {
      expect(Object.keys(finalWrite())).not.toContain(paid);
    }
  });
});

describe("the vendor could not be asked", () => {
  it("charges nothing and re-queues the row for a retry", async () => {
    // L-007. success:false is OUR outage, not the customer's miss, and the two
    // are indistinguishable from outside: both come back with no contacts.
    // MUTATION: gate the charge on `hit` instead of `success` and a FastAppend
    // outage starts billing.
    H.businessTrace = { success: false, hit: false, contacts: null, error: "FastAppend 503" };

    const res = await run();
    const body = await res.json();

    expect(deducts()).toHaveLength(0);
    expect(body.errored).toBe(1);
    expect(body.noMatch).toBe(0);
    // Back on the queue, one rung further up the ladder.
    expect(finalWrite()).toMatchObject({
      ai_research_status: "queued_2",
      ai_research_claimed_at: null,
    });
    // Nothing is settled: the row must not be closed out as a miss.
    expect(finalWrite().status).toBeUndefined();
  });
});

/**
 * The bound. lookupBusinessTrace() never throws, so a lapsed FASTAPPEND_API_KEY
 * or an hour of 503s used to re-queue the same five oldest rows every minute
 * forever, and no newer row was ever claimed. The parent bulk job read 'queued'
 * as pending and never settled either.
 */
describe("the retry ladder", () => {
  beforeEach(() => {
    H.businessTrace = { success: false, hit: false, contacts: null, error: "FastAppend 503" };
  });

  it("climbs one rung per failure while attempts remain", async () => {
    H.queuedRows = [{ ...ROW, ai_research_status: "queued_2" }];
    await run();
    expect(finalWrite().ai_research_status).toBe("queued_3");
  });

  it("claims a retried row on the status it is actually in", async () => {
    // MUTATION: claim with a hardcoded .eq('ai_research_status','queued') and a
    // retried row can never be picked up again -- it sits at queued_2 forever,
    // which is the starvation this ladder exists to end.
    H.queuedRows = [{ ...ROW, ai_research_status: "queued_2" }];
    await run();
    const claim = H.ops.find(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload?.ai_research_status === "processing_2"
    );
    expect(claim).toBeDefined();
    expect(claim!.filters.some((f) => f[0] === "eq" && f[2] === "queued_2")).toBe(true);
  });

  it("gives up on the last attempt and writes the row terminal", async () => {
    // MUTATION: drop the exhausted branch so it re-queues instead, and this goes
    // red -- the row goes back to the front of the claim window and the five
    // oldest rows block every newer row behind them again.
    H.queuedRows = [{ ...ROW, ai_research_status: `queued_${MAX_ENTITY_TRACE_ATTEMPTS}` }];
    const body = await (await run()).json();

    expect(body.exhausted).toBe(1);
    expect(finalWrite()).toMatchObject({
      ai_research_status: ENTITY_TRACE_FAILED_STATUS,
      ai_research_claimed_at: null,
      status: "error",
      is_successful: false,
    });
    // Terminal, so nothing reads it as pending and the bulk job can settle.
    expect(isEntityTracePending(ENTITY_TRACE_FAILED_STATUS)).toBe(false);
  });

  it("charges nothing on the way to terminal, because we never got an answer", async () => {
    // L-007 again, at the end of the ladder rather than the start of it. A
    // vendor we could not reach is our outage for all five tries.
    H.queuedRows = [{ ...ROW, ai_research_status: `queued_${MAX_ENTITY_TRACE_ATTEMPTS}` }];
    await run();
    expect(deducts()).toHaveLength(0);
    for (const paid of ["charge", "ai_research_charge", "tier", "cost"]) {
      expect(Object.keys(finalWrite())).not.toContain(paid);
    }
  });

  it("gives the customer a reason instead of a silent empty row", async () => {
    const reason = skipReasonFor(ENTITY_TRACE_FAILED_STATUS);
    expect(reason).toBeTruthy();
    expect(reason).toContain("not charged");
  });

  it("exhausts a claim that never came back, rather than resetting it", async () => {
    // A row that kills the run every time is exactly as poisonous as one the
    // vendor keeps refusing. Reverting it to attempt 1 would loop forever.
    await run();
    const topRung = H.ops.find(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload?.ai_research_status === ENTITY_TRACE_FAILED_STATUS &&
        o.filters.some(
          (f) => f[0] === "eq" && f[2] === `processing_${MAX_ENTITY_TRACE_ATTEMPTS}`
        )
    );
    expect(topRung).toBeDefined();
    expect(staleFilter(topRung!)).toBeDefined();
  });
});

describe("the vendor answered with a miss", () => {
  it("settles the row free, because a tier 1 miss is not billed", async () => {
    H.businessTrace = { success: true, hit: false, contacts: null };

    const res = await run();
    const body = await res.json();

    expect(deducts()).toHaveLength(0);
    expect(body.noMatch).toBe(1);
    expect(finalWrite()).toMatchObject({
      status: "no_match",
      is_successful: false,
      charge: 0,
      tier: 1,
    });
  });

  it("books no research fee on the way past", async () => {
    // The retired $0.15 fee used to land here the moment an owner was named.
    // MUTATION: restore the research deduct and this goes red.
    H.businessTrace = { success: true, hit: false, contacts: null };
    await run();
    const researchWrite = historyWrites().find((p) => "ai_research_charge" in p);
    expect(researchWrite?.ai_research_charge).toBe(0);
  });
});

describe("the vendor returned contacts", () => {
  beforeEach(() => {
    H.businessTrace = {
      success: true,
      hit: true,
      contacts: {
        ownerName: "Testowner Placeholder",
        phones: [{ number: "5550000101", type: "mobile" }],
        emails: ["principal@example.invalid"],
        mailingAddress: "100 Placeholder Way, Redacted, ZZ, 00000",
      },
    };
  });

  it("charges the caller's tier 1 rate exactly ONCE and nothing else", async () => {
    // The profile here is Pay-As-You-Go, so the tier 1 rate is 0.25. A 0.15
    // deduction could only be the retired research fee, never this rate.
    // MUTATION: add the research deduct back and the length assertion goes red.
    const res = await run();
    const body = await res.json();

    expect(body.fastAppendCredited).toBe(1);
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(deducts().some((d) => d.args.p_amount === 0.15)).toBe(false);
    expect(deducts()[0].args.p_trace_history_id).toBe("row-1");
  });

  it("persists the amount that actually moved, with tier 1 stamped on it", async () => {
    await run();
    expect(finalWrite()).toMatchObject({
      status: "success",
      is_successful: true,
      charge: PRICING.CHARGE_PER_SUCCESS_WALLET,
      tier: 1,
      ai_research_charge: 0,
      phone_count: 1,
      email_count: 1,
    });
  });

  it("skips the Tracerfy person submit, because FastAppend already delivered", async () => {
    await run();
    expect(submitSingleTrace).not.toHaveBeenCalled();
  });

  /**
   * THE RATE FOLLOWS THE TRACK, NOT THE OWNER TYPE.
   *
   * This cron settles the ENTITY rows of a bulk job; the job's own status route
   * settles the PERSON rows. If the two disagree about the rate, one batch bills
   * two prices for the same work, split by owner type -- the exact thing L-005
   * says is impossible, since owner type selects the vendor and never the price.
   *
   * It used to branch on the row's `source` tag and settle an untagged (/api/v1/*) row through a
   * raw, grant-blind rate, so a gateway-grant holder on a v1 bulk job paid $0.25 for person rows
   * and $0.15 for entity rows. Same job, same work, two prices. David's decision, 2026-09-23 --
   * "One price: make the API grant-aware" -- removed the branch, and these tests now assert the
   * tag makes NO difference.
   *
   * Both tests run with NEXT_PUBLIC_SUITE_SIGNIN_ENABLED set, because the ONLY
   * thing that makes a grant count is hasSuiteAccess(), which is behind that
   * flag. With the flag off everything collapses to `wallet`, every assertion
   * passes under either implementation, and the pair proves nothing. That is
   * L-009, which this build earned twice.
   */
  it("bills a grant holder the GRANT-AWARE rate on a tagged row", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["prop-tracer-pro"],
    };
    // source 'mcp' is Track A, tagged by lib/suite/mcp-tools.ts.
    H.queuedRows = H.queuedRows.map((r) => ({ ...r, source: "mcp" }));
    await run();
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });

  it("bills that same grant holder the SAME grant-aware rate on an UNTAGGED v1 row", async () => {
    // SITE: app/api/cron/sweep-entity-traces/route.ts tier1RateFor -> chargePerTrace.
    // MUTATION: restore the source branch (untagged -> a raw, grant-blind rate) and this goes red.
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["prop-tracer-pro"],
    };
    // A v1 bulk row carries no source, and under one price that changes nothing.
    await run();
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS);
    expect(deducts()[0].args.p_amount).not.toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    // The entity rows this cron settles and the person rows the v1 status route settles now read
    // the SAME function, so this compares against the route's own derivation, not a copied number.
    expect(deducts()[0].args.p_amount).toBe(chargePerTrace(H.profile));
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });
});

/**
 * The double-charge window.
 *
 * deductOrZero moves real money the moment it is called, and the row is only
 * written back AFTERWARDS. Anything that throws in between -- and the catch
 * below hands the row to failRow, which puts it back on the queue -- leaves the
 * wallet lighter with nothing on the row to show for it. The next run re-claims
 * the same row, calls FastAppend again, and deducts again. supabase-js returns
 * errors rather than throwing, so this needs an unusual failure, but nothing
 * made the second charge impossible.
 *
 * WHAT MAKES IT IMPOSSIBLE NOW. `deduct_wallet_balance` writes a
 * wallet_transactions debit carrying the trace_history_id it charged
 * (supabase/schema.sql). That ledger row IS the idempotency marker: it is
 * durable, it is keyed on the row, and it needs no new column. The cron asks for
 * it before deducting and, when one exists, persists the amount that already
 * moved instead of taking a second bite.
 *
 * A non-empty priorDebits here is exactly the state a row is left in by such a
 * throw: charged, requeued, and back in the claim window.
 */
describe("a row that has already been charged", () => {
  beforeEach(() => {
    H.businessTrace = {
      success: true,
      hit: true,
      contacts: {
        ownerName: "Testowner Placeholder",
        phones: [{ number: "5550000101", type: "mobile" }],
        emails: ["principal@example.invalid"],
        mailingAddress: null,
      },
    };
    // Deliberately an amount NO current rate can produce. If the row comes out
    // carrying 0.05 it can only have read the ledger; if it comes out carrying a
    // plan rate it re-derived the price, which is the bug wearing a disguise.
    H.priorDebits = [{ amount: 0.05, type: "debit" }];
  });

  it("cannot be charged a second time by this cron", async () => {
    // MUTATION: delete the prior-debit probe and deduct unconditionally, and
    // this goes red -- the customer pays twice for one row.
    await run();
    expect(deducts()).toHaveLength(0);
  });

  it("persists the amount that already moved, not zero and not a fresh rate", async () => {
    // Zero would tell the customer the row was free while their wallet says
    // otherwise, and re-deriving the rate would restate a past charge at
    // today's price. The ledger holds the only true number.
    await run();
    expect(finalWrite()).toMatchObject({
      status: "success",
      is_successful: true,
      charge: 0.05,
      tier: 1,
    });
  });

  it("asks the ledger about THIS row, not the user's debits in general", async () => {
    // Keyed on trace_history_id. Keyed on user_id it would refuse to charge any
    // second row of a bulk job, which is the opposite failure and just as bad.
    H.priorDebits = [{ amount: 0.05, type: "debit" }];
    await run();
    const probe = H.ops.find((o) => o.table === "wallet_transactions" && o.op === "select");
    expect(probe).toBeDefined();
    expect(
      probe!.filters.some((f) => f[0] === "eq" && f[1] === "trace_history_id" && f[2] === "row-1")
    ).toBe(true);
    // ...and NOT narrowed to debits. The probe used to end `.eq('type','debit')`
    // and that filter is what hid a refund from it: a credit the query never
    // returns cannot be subtracted. `type` is selected and classified in JS now.
    // MUTATION: put the filter back and this goes red.
    expect(probe!.filters.some((f) => f[0] === "eq" && f[1] === "type")).toBe(false);
  });

  it("still charges a row the ledger has never seen", async () => {
    // The guard must not become a blanket refusal to bill. A first attempt on a
    // clean row is the normal case and it still pays.
    H.priorDebits = [];
    await run();
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("still charges a row whose every debit was handed back", async () => {
    // A REFUND IS NOT A COLLECTION. This file never refunds, but its two twins
    // do -- sweep-business-traces and lib/trace/settleBulkJob both hand back a
    // historical research fee -- and they refund rows THIS cron also settles.
    // So a row can reach here having collected a fee and had it returned, and
    // the ledger nets to zero. Zero is not money in our pocket.
    //
    // MUTATION: sum the debits alone in collectedChargeFor, or test `!== null`
    // instead of `> 0` at the call site, and this goes red at zero deducts --
    // the row is delivered free and recorded as having paid $0.05.
    H.priorDebits = [
      { amount: 0.05, type: "debit" },
      { amount: 0.05, type: "credit" },
    ];
    await run();
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(finalWrite()).toMatchObject({
      charge: PRICING.CHARGE_PER_SUCCESS_WALLET,
      is_successful: true,
    });
  });

  it("does not probe the ledger on a row it is not about to charge", async () => {
    // A miss is free, so there is no charge to be idempotent about and no
    // reason to spend a query on every swept row.
    H.priorDebits = [];
    H.businessTrace = { success: true, hit: false, contacts: null };
    await run();
    expect(H.ops.some((o) => o.table === "wallet_transactions")).toBe(false);
  });
});

describe("the vendor named a principal but gave no contacts", () => {
  beforeEach(() => {
    H.businessTrace = {
      success: true,
      hit: true,
      contacts: {
        ownerName: "Testowner Placeholder",
        phones: [],
        emails: [],
        mailingAddress: null,
      },
    };
  });

  it("settles it free and never asks Tracerfy, because FastAppend IS Tracerfy", async () => {
    // David's ruling, 2026-09-21: "DO NOT send a fastappend contact to Tracerfy. This will
    // produce no new results and waste time. Fastappend is a tracerfy company and if the
    // contact info is not found in Fastappend, it will not be found in Tracerfy either. Even
    // if the contact is found in FastAppend, and that contact has no email or phone, it gets
    // treated as null result and the search is free for tier 1."
    //
    // So a named principal with no phone and no email is a MISS, not a lead to chase. The
    // previous behaviour submitted a second vendor call on a row the first vendor had already
    // failed to deliver, against a database owned by the same company.
    const res = await run();
    const body = await res.json();

    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
    expect(body.noMatch).toBe(1);
    expect(finalWrite()).toMatchObject({ status: "no_match", is_successful: false, charge: 0 });
  });

  it("never leaves a Tracerfy job id behind for the status poller to chase", async () => {
    // The old path wrote tracerfy_job_id and handed the row to the status endpoint. A row
    // that still carried one would be polled forever against a job nobody submitted.
    await run();
    expect(finalWrite()).not.toHaveProperty("tracerfy_job_id");
  });

  it("keys FastAppend on the company name and the state we hold", async () => {
    await run();
    expect(lookupBusinessTrace).toHaveBeenCalledWith({
      company_name: "Acme Holdings Llc",
      state: "TX",
    });
  });

  it("settles free when the Tracerfy submit itself fails", async () => {
    H.submit = { success: false, jobId: null, error: "Tracerfy 503" };
    const res = await run();
    const body = await res.json();

    expect(deducts()).toHaveLength(0);
    expect(body.noMatch).toBe(1);
    expect(finalWrite()).toMatchObject({ status: "no_match", charge: 0, tier: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * RECEIPTS SURVIVE THIS SWEEP.
 *
 * Every row this cron settles is a REUSED row: UNIQUE(user_id, address_hash)
 * guarantees one per (user, address), and wallet_transactions references it
 * with ON DELETE NO ACTION. Under bulk tier 2 a billed miss looks like
 * `tier = 2, charge > 0, is_successful = false`, and both free-miss arms below
 * target precisely that shape.
 *
 * Writing a flat `charge: 0, tier: 1` over it does two things at once: the row
 * reads unbilled to excludeBilledRows, so the next submit's delete raises 23503
 * and the address 500s forever; and the tier downgrade kills isCacheHitRow's
 * third arm, so the customer re-buys the same absence.
 * ------------------------------------------------------------------ */
describe("a row that already carries a tier 2 receipt", () => {
  beforeEach(() => {
    H.queuedRows = [{ ...ROW, charge: 0.25, tier: 2 }];
  });

  it("site 467 (FastAppend named nobody): keeps the charge and the tier", async () => {
    // A tier 1 miss is free, and free means "collect nothing further", never
    // "declare the row was always free".
    H.businessTrace = { success: true, hit: false, contacts: null };
    await run();

    expect(deducts()).toHaveLength(0);
    // MUTATION: write `charge: 0, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE` flat
    // instead of the folded values and this goes red on both lines.
    expect(finalWrite().charge).toBe(0.25);
    expect(finalWrite().tier).toBe(2);
  });

  it("site 495 (Tracerfy submit failed): keeps the charge and the tier", async () => {
    H.businessTrace = {
      success: true,
      hit: true,
      contacts: {
        ownerName: "Testowner Placeholder",
        phones: [],
        emails: [],
        mailingAddress: null,
      },
    };
    H.submit = { success: false, jobId: null, error: "Tracerfy 503" };
    await run();

    expect(deducts()).toHaveLength(0);
    // MUTATION: same as site 467 -- unfold either value and this goes red.
    expect(finalWrite().charge).toBe(0.25);
    expect(finalWrite().tier).toBe(2);
  });

  /**
   * Site 438 is the SAFE one and it stays raw on purpose. It resolves the
   * amount from the LEDGER (collectedChargeFor) before writing, so folding on
   * top would add the ledger amount to a row that may already carry it and
   * double-count one debit. It is also the arm that ends `is_successful = true`,
   * which is isCacheHitRow's FIRST arm, so the tier stamp costs nothing there.
   * This is the exemption ALLOWED_RAW_WRITES keeps for this file.
   */
  it("site 438 writes the ledger TOTAL raw, and still never downgrades the tier", async () => {
    H.businessTrace = {
      success: true,
      hit: true,
      contacts: {
        ownerName: "Testowner Placeholder",
        phones: [{ number: "5550000101", type: "mobile" }],
        emails: [],
        mailingAddress: null,
      },
    };
    // A CONSISTENT fixture: the row is a billed tier 2 miss ($0.25 collected
    // per record SUBMITTED) and the ledger holds that debit PLUS a $0.25 tier 1
    // contact charge a previous attempt booked before it died. Both are real,
    // and the row has collected $0.50. A fixture whose row and ledger disagree
    // freezes behaviour rather than proving it safe.
    H.priorDebits = [{ amount: 0.25, type: "debit" }, { amount: 0.25, type: "debit" }];
    await run();

    // The ledger TOTAL, written as-is. Folding would give 0.25 + 0.50 = 0.75
    // and invent money -- which is why this site keeps its exemption.
    expect(finalWrite().charge).toBe(0.5);
    // ...but `tier` is not the ledger's to answer. A flat 1 here downgrades a
    // tier 2 receipt, and the exemption was argued for `charge` alone.
    expect(finalWrite().tier).toBe(2);
    expect(finalWrite().is_successful).toBe(true);
  });
});

describe("claiming", () => {
  it("does no work on a row another run already claimed", async () => {
    H.claimOk = false;
    const res = await run();
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
  });

  it("reverts stale claims before looking for queued rows", async () => {
    // The only way a row killed mid-run is ever retried: the claim query below
    // looks at the queued rungs alone. The revert steps the ladder, so a claim
    // taken at attempt 1 comes back as attempt 2.
    await run();
    const revert = H.ops.find(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload?.ai_research_status === "queued_2" &&
        o.filters.some((f) => f[0] === "eq" && f[2] === "processing")
    );
    expect(revert).toBeDefined();
    expect(staleFilter(revert!)).toBeDefined();
  });

  it("sweeps a claimed row whose claim timestamp is NULL", async () => {
    // SQL `<` never matches NULL, so a row sitting in processing_N with a null
    // ai_research_claimed_at was invisible to BOTH queries: the claim query only
    // looks at the queued rungs, and the stale sweep only looked at claims older
    // than the cutoff. Such a row held its parent bulk job at 'processing'
    // forever with nothing able to touch it. No writer produces that pair today,
    // which is why this was latent rather than live.
    // MUTATION: put the bare .lt() back and this goes red.
    await run();
    const filter = staleFilter(
      H.ops.find(
        (o) =>
          o.table === "trace_history" &&
          o.op === "update" &&
          o.payload?.ai_research_status === "queued_2"
      )!
    );
    expect(filter).toBeDefined();
    expect(String(filter![1])).toContain("ai_research_claimed_at.is.null");
    expect(String(filter![1])).toContain("ai_research_claimed_at.lt.");
  });
});

/* ------------------------------------------------------------------ *
 * THE TIER 1 LANE.
 *
 * ONE CRON, TWO LANES, ONE COLUMN, DISJOINT STATUS SETS. The lane claims only tier1_ rungs, settles
 * every record through the ONE Tier 1 billing path (lib/trace/singleTier1.ts runTier1Record), and
 * reserves every vendor call it is about to make against the shared per-minute budget.
 *
 * runTier1Record IS MOCKED IN THIS FILE ON PURPOSE. These tests are about the cron: which rows it
 * claims, what it hands the billing path, and what it does with a throttle. The gate, the ledger
 * probe, the fold and the persist are fenced where they live, in
 * lib/trace/__tests__/singleTier1.test.ts, which calls runTier1Record directly. So nothing here can
 * be read as proof about the money core itself, and a mutation inside that core is not killable from
 * this file.
 * ------------------------------------------------------------------ */
describe("the TIER 1 lane", () => {
  it("claims only tier1_ rows, and never a legacy entity row", async () => {
    // A lane that claimed the other's rows would run a FastAppend business trace against a record
    // planRoute was never asked about, or plan a route for a row whose contacts the entity lane is
    // already buying.
    seedRows([
      { id: "row-t1", ai_research_status: "tier1_queued", input_owner_name: "Jane Smith", user_id: "u1" },
      { id: "row-legacy", ai_research_status: "queued", input_owner_name: "Acme LLC", user_id: "u1" },
    ]);
    const body = await runCron();
    expect(body.tier1.processed).toBe(1);
    expect(body.processed).toBe(1);
    expect(rowUpdates("row-t1").some((u) => u.ai_research_status === "tier1_processing")).toBe(true);
    expect(rowUpdates("row-legacy").some((u) => String(u.ai_research_status).startsWith("tier1"))).toBe(
      false
    );
  });

  it("takes the claim with a compare-and-swap on the status it read", async () => {
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued_3", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    await runCron();
    const claim = rowUpdates("row-1")[0];
    expect(claim).toMatchObject({ ai_research_status: "tier1_processing_3" });
    expect(claim.ai_research_claimed_at).toBeTruthy();
    // The compare is against the value READ, not a literal 'tier1_queued': every rung is claimable
    // and a hardcoded attempt 1 would strand a retried row forever.
    expect(claimFilters("row-1")[0]).toMatchObject({ ai_research_status: "tier1_queued_3" });
  });

  it("does nothing at all to a row another worker claimed first", async () => {
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    failTheClaim("row-1");
    const body = await runCron();
    expect(body.tier1.processed).toBe(0);
    expect(runTier1RecordMock).not.toHaveBeenCalled();
    expect(tracePersonMock).not.toHaveBeenCalled();
    expect(deductWalletMock).not.toHaveBeenCalled();
  });

  it("bills through runTier1Record and nowhere else", async () => {
    // The whole point of Task 7. A cron with its own gate, probe or fold is the Track A/Track B
    // defect in a new file, against bulk volume (lessons L-030).
    //
    // A PRO profile is seeded rather than assumed: this file's default fixture is Pay-As-You-Go
    // (see the header), so asserting 0.15 against the default would assert nothing about the
    // derivation. 0.15 here is chargePerTrace() answering for a pro subscriber.
    seedProfile("u1", {
      subscription_tier: "pro",
      is_acquisition_pro_member: false,
      gateway_products: [],
    });
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    await runCron();
    expect(runTier1RecordMock).toHaveBeenCalledTimes(1);
    const arg = runTier1RecordMock.mock.calls[0][0];
    expect(arg.chargeAmount).toBe(0.15);
    expect(arg.pricePlan).toBe("pro");
    expect(arg.queueWrite).toEqual({ ai_research_status: "tier1_done", property_trace_status: null });
    expect(arg.resumeFromStepLog).toBe(true);
    expect(typeof arg.onStep).toBe("function");
    // REQUIRED BUT NULLABLE on Tier1RecordInput, so omitting it is a compile error and passing
    // `undefined` is not. An unbounded ladder is held only by the 25 s per-call vendor ceiling.
    expect(typeof arg.deadlineMs).toBe("number");
    // THE OWNER NAME HAS TO REACH THE PLAN. Without it planRoute returns a TIER 2 plan,
    // runTier1Record throws NotATier1PlanError, and every row in the queue settles tier1_done /
    // no_match, free, delivering nothing. parcelForTier1Row's own describe block below pins the
    // wiring; this pins that the cron passes the result of it.
    expect(arg.parcel.ownerName).toBe("Jane Smith");
    expect(arg.parcel.situsAddress).toBe("100 MAIN ST");
    expect(arg.parcel.state).toBe("TX");
    // D25: the name and the result it describes are written in ONE persist. A null here writes null
    // over the owner name the customer submitted.
    expect(arg.inputOwnerName).toBe("Jane Smith");
  });

  it("prices a grant holder at the PRO rate, through the one derivation", async () => {
    // lib/suite/pricing.ts, grant-aware through effectiveIsPro. $0.15 per tier 1 success for pro,
    // AcquisitionPRO and a Suite Gateway grant; $0.25 pay-as-you-go (lessons L-030).
    //
    // THE FLAG IS LOAD-BEARING (L-009). hasSuiteAccess() is what makes a grant count, and it is
    // behind NEXT_PUBLIC_SUITE_SIGNIN_ENABLED. With the flag off this profile collapses to 'wallet'
    // and the assertion would pass under any implementation.
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    seedProfile("u1", {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["prop-tracer-pro"],
    });
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].chargeAmount).toBe(0.15);
    expect(runTier1RecordMock.mock.calls[0][0].pricePlan).toBe("pro");
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });

  it("prices a pay-as-you-go caller with no grant at the wallet rate", async () => {
    seedProfile("u1", {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: [],
    });
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].chargeAmount).toBe(0.25);
    expect(runTier1RecordMock.mock.calls[0][0].pricePlan).toBe("wallet");
  });

  it("prices a row whose profile cannot be read at the DEAREST column", async () => {
    // FAILSAFE_PRICE_PLAN is 'wallet' and must never point at the cheap column: an overcharge is
    // visible on a statement and gets refunded, an undercharge is invisible to both sides.
    seedProfile("u1", null);
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].pricePlan).toBe("wallet");
    expect(runTier1RecordMock.mock.calls[0][0].chargeAmount).toBe(0.25);
  });

  it("bounds the crash probe to THIS row s bulk job", async () => {
    // The row is REUSED, so an unbounded probe answers with a debit from an earlier submit, skips
    // the deduct, and gives this job's work away free, repeatably. Same bound the tier 2 cron takes.
    seedJob("job-9", { created_at: "2026-09-23T10:00:00.000Z" });
    seedRows([
      {
        id: "row-1",
        ai_research_status: "tier1_queued",
        input_owner_name: "Jane Smith",
        user_id: "u1",
        trace_job_id: "job-9",
      },
    ]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].ledgerSince).toBe("2026-09-23T10:00:00.000Z");
  });

  it("passes an UNBOUNDED probe when the job cannot be read, which is the safe direction", async () => {
    seedRows([
      {
        id: "row-1",
        ai_research_status: "tier1_queued",
        input_owner_name: "Jane Smith",
        user_id: "u1",
        trace_job_id: null,
      },
    ]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].ledgerSince).toBeNull();
  });

  it("writes the Tier 1 terminal status so the parent job can settle", async () => {
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    await runCron();
    expect(runTier1RecordMock.mock.calls[0][0].queueWrite.ai_research_status).toBe("tier1_done");
  });

  it("writes the step log as each answer arrives", async () => {
    // What a queue needs and an inline request does not: a killed run leaves the answers on the row,
    // so the re-claim one rung up does not buy them again.
    runTier1RecordMock.mockImplementationOnce(async (input) => {
      await input.onStep!({ kind: "TRACERFY_INSTANT_NAMED", outcome: "miss", cost: 0 });
      await input.onStep!({ kind: "FASTAPPEND_ENTITY", outcome: "hit", cost: 0.1 });
      return okResult();
    });
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    await runCron();
    const logWrites = rowUpdates("row-1").filter((u) => "trace_steps" in u);
    expect(logWrites).toHaveLength(2);
    expect((logWrites[0].trace_steps as unknown[]).length).toBe(1);
    expect((logWrites[1].trace_steps as unknown[]).length).toBe(2);
  });

  it("releases a record the rate budget refused back to its OWN rung, unspent", async () => {
    // Throttling is NOT a failure (spec 5.1): the record waits for the next minute and spends
    // nothing. No attempt is consumed, because no vendor was asked.
    //
    // runTier1Record throws VendorBudgetThrottledError when executeRoute reports a refused call
    // (Task 7), so the lane sees a throttle as a thrown type rather than as a result field. That is
    // what keeps Tier1RecordResult's key set unchanged, which is what keeps Task 7's byte-identical
    // proof of a single trace true.
    runTier1RecordMock.mockRejectedValueOnce(new VendorBudgetThrottledError());
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued_2", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    const body = await runCron();
    expect(body.tier1.throttled).toBe(1);
    expect(body.tier1.processed).toBe(0);
    // A throttle counted as a fault reads as a fault in the live check and in every dashboard.
    expect(body.tier1.errored).toBe(0);
    expect(rowUpdates("row-1").at(-1)).toMatchObject({
      ai_research_status: "tier1_queued_2",
      ai_research_claimed_at: null,
    });
  });

  it("does not judge, charge or persist a record the budget refused", async () => {
    // The money half of the throttle. A throttled record has NO outcome: settling it would file
    // "We looked this owner up by address and found no match" on a lookup nobody made, and that
    // sentence would then answer for the row in History and in the results CSV (CLAUDE.md rule 7).
    //
    // WHAT THIS TEST DOES AND DOES NOT PROVE. It fences the CRON's half: nothing money-shaped is
    // written and no deduct is asked for. It cannot fence runTier1Record's own pre-judge throw,
    // because the mock rejects regardless; that guard is fenced in
    // lib/trace/__tests__/singleTier1.test.ts, which calls the real function.
    runTier1RecordMock.mockRejectedValueOnce(new VendorBudgetThrottledError());
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    await runCron();
    const last = rowUpdates("row-1").at(-1)!;
    for (const column of ["charge", "tier", "outcome_code", "is_successful", "trace_result", "status"]) {
      expect(last, column).not.toHaveProperty(column);
    }
    expect(deductWalletMock).not.toHaveBeenCalled();
  });

  it("reserves each call it is about to make, ONE AT A TIME, never a per-record guess", async () => {
    // THE DEFECT THIS SHAPE CLOSES. A per-record reservation is a GUESS at a worst case, and
    // ownerRoute.ts calls its own tier 2 figure "A FLOOR, NOT A CEILING". This lane's plan is
    // bounded, so a per-record figure would be correct HERE, but it would be a second way of doing
    // the same thing and the tier 2 lane cannot use it. One shape, both lanes.
    //
    // THE TWO STEPS ARE MEASURED, NOT ASSUMED. 'John Smith Revocable Trust' plans
    // TRACERFY_INSTANT_NAMED then FASTAPPEND_ENTITY: one call from each pool, reserved separately.
    // The mock stands in for executeRoute and asks the hook for each of them, because the cron does
    // not call planRoute itself: it hands canSpend down and executeRoute asks it per call.
    runTier1RecordMock.mockImplementationOnce(async (input) => {
      await input.canSpend!(step("TRACERFY_INSTANT_NAMED"));
      await input.canSpend!(step("FASTAPPEND_ENTITY"));
      return okResult();
    });
    seedRows([
      {
        id: "row-1",
        ai_research_status: "tier1_queued",
        input_owner_name: "John Smith Revocable Trust",
        user_id: "u1",
      },
    ]);
    await runCron();
    expect(reserveVendorCallsMock).toHaveBeenCalledTimes(2);
    expect(reserveVendorCallsMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      tracerfy: 1,
      fastappend: 0,
    });
    expect(reserveVendorCallsMock).toHaveBeenNthCalledWith(2, expect.anything(), {
      tracerfy: 0,
      fastappend: 1,
    });
  });

  it("hands runTier1Record a canSpend hook at all, which is what makes the budget reachable", async () => {
    seedRows([
      { id: "row-1", ai_research_status: "tier1_queued", input_owner_name: "Jane Smith", user_id: "u1" },
    ]);
    await runCron();
    expect(typeof runTier1RecordMock.mock.calls[0][0].canSpend).toBe("function");
  });

  it("reverts a stale claim ONE RUNG UP, never back to attempt 1", async () => {
    // A claim that never came back is a SPENT attempt. Reverting to attempt 1 lets a row that kills
    // the run every time loop forever and hold a claim slot that belongs to rows that can work.
    seedRows([
      {
        id: "row-1",
        ai_research_status: "tier1_processing_2",
        ai_research_claimed_at: minutesAgo(9),
        input_owner_name: "Jane Smith",
        user_id: "u1",
      },
    ]);
    const body = await runCron();
    expect(body.tier1.staleReverted).toBe(1);
    expect(rowUpdates("row-1")[0]).toMatchObject({
      ai_research_status: "tier1_queued_3",
      ai_research_claimed_at: null,
    });
  });

  it("treats a claim with NO timestamp as stale, because SQL < never matches NULL", async () => {
    seedRows([
      {
        id: "row-1",
        ai_research_status: "tier1_processing",
        ai_research_claimed_at: null,
        input_owner_name: "Jane Smith",
        user_id: "u1",
      },
    ]);
    expect((await runCron()).tier1.staleReverted).toBe(1);
  });

  it("retires a row on its last rung terminally, free, and tells the customer it can be resent", async () => {
    seedRows([
      {
        id: "row-1",
        ai_research_status: "tier1_processing_5",
        ai_research_claimed_at: minutesAgo(9),
        input_owner_name: "Jane Smith",
        user_id: "u1",
      },
    ]);
    const body = await runCron();
    expect(body.tier1.exhausted).toBe(1);
    const update = rowUpdates("row-1")[0];
    expect(update).toMatchObject({
      ai_research_status: "tier1_failed",
      ai_research_claimed_at: null,
      status: "error",
      is_successful: false,
      outcome_code: "busy_try_again",
    });
    // NO MONEY COLUMNS. The row is REUSED and can already carry a tier 2 receipt; a receipt is
    // monotonic (lib/trace/billedRows.ts), and `charge: 0, tier: 1` over it un-protects a paid row
    // from every delete sweep while wallet_transactions still references it by FK.
    expect(update).not.toHaveProperty("charge");
    expect(update).not.toHaveProperty("tier");
    expect(update).not.toHaveProperty("ai_research_charge");
  });

  it("writes a row with no owner name terminal rather than retrying it", async () => {
    // planRoute answers a nameless record with a TIER 2 plan, which runTier1Record refuses
    // (NotATier1PlanError) precisely so a $0.20 dossier cannot be bought here and billed at the
    // tier 1 rate. Five retries would ask the same unanswerable question five times.
    seedRows([{ id: "row-1", ai_research_status: "tier1_queued", input_owner_name: "", user_id: "u1" }]);
    const body = await runCron();
    expect(body.tier1.skippedNoOwner).toBe(1);
    expect(runTier1RecordMock).not.toHaveBeenCalled();
    expect(rowUpdates("row-1").at(-1)).toMatchObject({
      ai_research_status: "tier1_done",
      status: "no_match",
      is_successful: false,
    });
  });

  it("works rows oldest first, at the sizing this phase pinned", async () => {
    seedRows(
      Array.from({ length: 130 }, (_, i) => ({
        id: `row-${i}`,
        ai_research_status: "tier1_queued",
        input_owner_name: "Jane Smith",
        user_id: "u1",
      }))
    );
    const body = await runCron();
    // 120 rows a minute clears a 500-record job in 4.2 minutes, inside spec 3.2's 2-to-5 minutes.
    expect(body.tier1.processed).toBe(120);
    expect(claimWindow().limit).toBe(120);
    expect(claimWindow().order).toBe("created_at");
  });

  it("keeps the legacy entity lane exactly as it was", async () => {
    // 2B moves API bulk and the MCP tool onto the queue; until then their rows are settled here by
    // the lane that has always settled them, through lookupBusinessTrace, at the same rate.
    seedRows([{ id: "row-1", ai_research_status: "queued", input_owner_name: "Acme LLC", user_id: "u1" }]);
    // Set through the fixture rather than mockResolvedValue: an implementation override is NOT
    // undone by mockClear and would leak into every later test in the file (L-013).
    H.businessTrace = { success: true, hit: false, contacts: null };
    const body = await runCron();
    expect(lookupBusinessTraceMock).toHaveBeenCalledTimes(1);
    expect(body.noMatch).toBe(1);
    expect(body.tier1.processed).toBe(0);
    expect(runTier1RecordMock).not.toHaveBeenCalled();
  });
});

describe("the Tier 1 lane s sizing, pinned", () => {
  it("is 120 rows at concurrency 8, which is a THROUGHPUT choice and not the rate ceiling", () => {
    // WHAT THESE TWO NUMBERS ARE. 120 rows at concurrency 8 is 15 rounds; at the 3 s per record the
    // Phase 1 live check measured (1.5-2.0 s on a miss, 4.1-4.4 s on a hit) that is ~45 s per run,
    // inside maxDuration 300 with room for the entity lane's five sequential rows, and it clears a
    // 500-record job in 4.2 minutes, inside spec 3.2's 2-to-5 minute target.
    //
    // WHAT THEY ARE NOT. They are not what keeps the vendor's rate limit. The old version of this
    // test asserted `TIER1_MAX_ROWS_PER_RUN * 1 + 240 <= VENDOR_RATE_LIMIT.tracerfy`, which reads
    // like a proof and is not one: the 240 is the tier 2 cron's FLOOR, not its ceiling
    // (lib/routing/ownerRoute.ts says so about its own figure, in capitals, and D21(c) with D40 put
    // no cap on the owner count), so the inequality holds on paper while the real demand is 960.
    // Pinning arithmetic that cannot hold is worse than pinning nothing, because the next reader
    // trusts it. The bound is lib/trace/vendorRateBudget.ts, drawn per CALL on this lane and once per
    // record on the tier 2 lane, whose unreserved remainder the plan's Task 6 header sizes.
    expect(TIER1_MAX_ROWS_PER_RUN).toBe(120);
    expect(TIER1_CONCURRENCY).toBe(8);
    // 15 rounds at ~3 s is ~45 s, which has to leave room for the entity lane inside maxDuration.
    expect(Math.ceil(TIER1_MAX_ROWS_PER_RUN / TIER1_CONCURRENCY) * 3_000).toBeLessThan(
      TIER1_RUN_BUDGET_MS
    );
  });

  it("cannot start a record it has no room to make a call for", () => {
    // The ONE relationship between this lane and the budget that IS a guarantee: a single record's
    // single call can always be asked for, because one call is never larger than the whole budget.
    // If someone ever raises a per-call ask above the limit, claim_vendor_rate's `p_calls > p_limit`
    // arm refuses it forever and the queue stops draining with no error anywhere.
    expect(1).toBeLessThanOrEqual(VENDOR_RATE_LIMIT.tracerfy);
    expect(1).toBeLessThanOrEqual(VENDOR_RATE_LIMIT.fastappend);
  });
});

/**
 * parcelForTier1Row, tested DIRECTLY: no cron, no stub, no mocks in the path.
 *
 * WHY THIS BLOCK EXISTS, and it is the same reason the tier 2 cron's parcelForRow has one
 * (app/api/cron/sweep-property-traces/__tests__/route.test.ts). This function is the ONLY place the
 * owner name and the address reach the vendor, and `ParcelInput` makes every field optional except
 * `state`, so deleting a line of it leaves `tsc` at exit 0 and every cron test green. Measured:
 * deleting the `ownerName` line compiles clean and passes all 2029 tests, while in production every
 * record then plans as ownerless, planRoute returns a TIER 2 plan, runTier1Record throws
 * NotATier1PlanError, and the whole queue settles tier1_done / no_match, free. The lane would deliver
 * nothing to every customer with a fully green suite. Pinning it here closes that.
 *
 * planRoute() is called on the result rather than only the fields, because the TIER of the plan is
 * the consequence that matters and it is one line away from the wiring.
 */
describe("parcelForTier1Row", () => {
  const baseRow = {
    id: "row-1",
    user_id: "user-1",
    trace_job_id: "job-1",
    normalized_address: "100 MAIN ST|DALLAS|TX",
    city: "DALLAS",
    state: "TX",
    zip: "75001",
    parcel_id_local: null,
    county: null,
    input_owner_name: "Jane Smith",
    ai_research_status: "tier1_queued",
    charge: null,
    tier: null,
    trace_result: null,
    trace_steps: null,
    outcome_code: null,
  };

  it("carries the owner name through, which is what makes the plan TIER 1 at all", () => {
    // THE WHOLE DIFFERENCE FROM TIER 2. parcelForFullTrace passes ownerName: null on purpose; a
    // Tier 1 row HAS its owner. MUTATION: delete the ownerName line and this goes red on both the
    // name and the tier, which is the difference between delivering contacts and delivering nothing.
    const parcel = parcelForTier1Row({ ...baseRow });
    expect(parcel.ownerName).toBe("Jane Smith");
    const plan = planRoute(parcel, "wallet");
    expect(plan.tier).toBe(1);
    expect(plan.ownerName).toBe("Jane Smith");
  });

  it("plans TIER 2 for a row with no owner name, which is why the line above is load-bearing", () => {
    // Not a defect: it is what runTier1Record refuses (NotATier1PlanError) so a $0.20 dossier can
    // never be bought on this lane and billed at the tier 1 rate. It is recorded here so the cost of
    // losing the owner name is visible next to the line that carries it.
    const plan = planRoute(parcelForTier1Row({ ...baseRow, input_owner_name: null }), "wallet");
    expect(plan.tier).toBe(2);
  });

  it("treats a blank or whitespace owner name as absent, never as an empty string", () => {
    expect(parcelForTier1Row({ ...baseRow, input_owner_name: "   " }).ownerName).toBeNull();
    expect(parcelForTier1Row({ ...baseRow, input_owner_name: "" }).ownerName).toBeNull();
  });

  it("trims the owner name rather than sending the vendor the customer's whitespace", () => {
    expect(parcelForTier1Row({ ...baseRow, input_owner_name: "  Jane Smith  " }).ownerName).toBe(
      "Jane Smith"
    );
  });

  it("pulls the STREET out of the pipe-delimited dedup key and nothing else", () => {
    // normalized_address is street|city|state with NO zip in it (migration 20260904); the zip lives
    // in its own column. MUTATION: hand the whole key through and the vendor gets
    // "100 MAIN ST|DALLAS|TX" as a street.
    const parcel = parcelForTier1Row({ ...baseRow });
    expect(parcel.situsAddress).toBe("100 MAIN ST");
    expect(parcel.situsCity).toBe("DALLAS");
    expect(parcel.situsZip).toBe("75001");
  });

  it("never reads the literal APN out of a parcel-keyed row as the street (D38)", () => {
    // A row keyed APN|<parcel>|<COUNTY>|<STATE> has no street at all, so split('|')[0] on it is the
    // word "APN", which would go to the vendor as an address. The web upload sends no parcel id (D5)
    // so this cannot arrive today; the guard is here so 2B cannot start to quietly.
    // MUTATION: drop the isParcelKey() arm and this goes red with situsAddress "APN".
    const parcel = parcelForTier1Row({
      ...baseRow,
      normalized_address: "APN|0123-456|TRAVIS|TX",
      city: null,
      state: "TX",
      parcel_id_local: "0123-456",
      county: "Travis",
    });
    expect(parcel.situsAddress).toBe("");
    // No street is '', never a fabricated one (CLAUDE.md rule 7).
    expect(parcel.situsCity).toBe("");
  });

  it("falls back to the whole value when the key carries no pipe at all", () => {
    const parcel = parcelForTier1Row({ ...baseRow, normalized_address: "100 MAIN ST" });
    expect(parcel.situsAddress).toBe("100 MAIN ST");
  });

  it("upper-cases the state and puts it in BOTH fields planRoute reads", () => {
    // `state` is the only field ParcelInput requires, and hasSitus() reads situsState. A lower-case
    // state reaches the vendor as typed and reaches planRoute's own comparisons unnormalised.
    // MUTATION: drop .toUpperCase() and this goes red on both lines.
    const parcel = parcelForTier1Row({ ...baseRow, state: " tx " });
    expect(parcel.state).toBe("TX");
    expect(parcel.situsState).toBe("TX");
  });

  it("carries parcel_id_local and county when a row has them", () => {
    const parcel = parcelForTier1Row({ ...baseRow, parcel_id_local: " R022901 ", county: " Mobile " });
    expect(parcel.parcelIdLocal).toBe("R022901");
    expect(parcel.county).toBe("Mobile");
  });

  it("treats a blank zip, county or parcel_id_local as absent, never as an empty string", () => {
    // An empty string is a value the vendor would be asked about. Null is the honest answer.
    const parcel = parcelForTier1Row({
      ...baseRow,
      zip: "   ",
      county: "",
      parcel_id_local: "  ",
    });
    expect(parcel.situsZip).toBeNull();
    expect(parcel.county).toBeNull();
    expect(parcel.parcelIdLocal).toBeNull();
  });
});

describe("the Tier 1 lane's run budget", () => {
  it("stops TAKING new records once the run is nearly out of time", async () => {
    // WHAT THIS GUARDS. A worker that started a record the run could not finish would leave a live
    // claim behind, and the next run's stale sweep SPENDS an attempt on it. Rows not taken are left
    // queued and unmarked instead, which costs a minute and spends nothing.
    //
    // HOW IT IS OBSERVED WITHOUT EXPORTING THE LANE. The mocked billing core is the injection point:
    // the FIRST settled record moves the system clock past runStartedAt + TIER1_RUN_BUDGET_MS. All
    // eight workers take their first index and pass the deadline check synchronously, before any
    // await, so exactly the first round is worked. Nothing in the stub uses timers -- every chain
    // settles on Promise.resolve -- so microtask ordering is untouched.
    // MUTATION: delete `if (Date.now() >= runDeadlineMs) return;` and this goes red at 20.
    vi.useFakeTimers();
    try {
      runTier1RecordMock.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + TIER1_RUN_BUDGET_MS + 1_000);
        return okResult();
      });
      seedRows(
        Array.from({ length: 20 }, (_, i) => ({
          id: `row-${i}`,
          ai_research_status: "tier1_queued",
          input_owner_name: "Jane Smith",
          user_id: "u1",
        }))
      );
      const body = await runCron();
      expect(body.tier1.processed).toBe(TIER1_CONCURRENCY);
    } finally {
      vi.useRealTimers();
    }
  });
});
