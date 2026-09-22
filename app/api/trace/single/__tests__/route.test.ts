import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING, VENDOR_TIMEOUT } from "@/lib/constants";
import { requestKeyFor } from "@/lib/routing/executeRoute";
import { planRoute } from "@/lib/routing/ownerRoute";
import { parcelForFullTrace } from "@/lib/trace/fullPropertyTrace";

/**
 * Delete/insert fence for the session-side single-trace SUBMIT route.
 *
 * This route decides which trace_history rows survive a resubmission. Every row
 * it destroys is either a receipt (`wallet_transactions.trace_history_id`
 * references it) or a record the customer has already paid for, so the tests
 * below pin the exact PostgREST predicates of every delete it issues, not just
 * the HTTP status it returns.
 *
 * Written as characterization tests FIRST (2026-09-17, phase 2) because the
 * route had zero coverage and was about to be changed on the billing path.
 */

type Filter = [string, ...unknown[]];

interface Recorded {
  table: string;
  op: "select" | "delete" | "insert" | "update";
  filters: Filter[];
  payload?: unknown;
}

const H = vi.hoisted(() => ({
  ops: [] as Array<{
    table: string;
    op: "select" | "delete" | "insert" | "update";
    filters: Array<[string, ...unknown[]]>;
    payload?: unknown;
  }>,
  /** Every Postgres function call, so the wallet deduct can be counted exactly. */
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** What deduct_wallet_balance resolves with. `false` = the wallet was short. */
  deductData: true as unknown,
  deductError: null as { message: string } | null,
  user: { id: "user-1" } as { id: string } | null,
  profile: null as unknown as Record<string, unknown> | null,
  cached: null as Record<string, unknown> | null,
  /** Row the INSERT (or the reuse UPDATE) resolves with. */
  insertedRow: { id: "trace-new" } as Record<string, unknown> | null,
  insertError: null as { message: string; code?: string } | null,
  /** Error every trace_history DELETE resolves with. */
  deleteError: null as { message: string; code?: string } | null,
  /** Row the post-delete "does a row still exist?" probe resolves with. */
  survivingRow: null as Record<string, unknown> | null,
  /** Rows wallet_transactions holds against the trace id. */
  ledgerRefs: [] as Array<Record<string, unknown>>,
  /** Rows usage_records holds against it. A SECOND FK into trace_history. */
  usageRefs: [] as Array<Record<string, unknown>>,
  ledgerRefsError: null as { message: string } | null,
  /** How many times the BLIND anon client was asked for trace_history. */
  anonTraceSelects: 0,
  submit: { success: true, jobId: "tj-1" } as {
    success: boolean;
    jobId?: string;
    error?: string;
  },
  /** What lookupDossier resolves with. Set per test. */
  dossier: null as unknown,
  /** What the FastAppend entity lookup resolves with. */
  entity: null as unknown,
  /** What the Tracerfy person lookup resolves with. */
  person: null as unknown,
  /** Every outbound webhook POST the route made. */
  webhookPosts: [] as Array<{ url: string; body: Record<string, unknown> }>,
  /** What the mocked HighLevel client answers. A push success by default. */
  pushResult: { success: true, contactId: "hl-1", action: "created" } as Record<
    string,
    unknown
  >,
  /** Callbacks handed to `after()`, run explicitly by flushDeferred(). */
  scheduled: [] as Array<() => unknown>,
}));

function envelopeFor(rec: Recorded): { data: unknown; error: unknown } {
  if (rec.op === "delete") return { data: null, error: H.deleteError };
  if (rec.op === "insert") {
    return H.insertError
      ? { data: null, error: H.insertError }
      : { data: H.insertedRow, error: null };
  }
  if (rec.op === "update") {
    // A reuse-the-existing-row UPDATE returns the row it updated.
    return { data: H.insertedRow, error: null };
  }
  if (rec.table === "user_profiles") return { data: H.profile, error: null };
  // The two tables that hold FK receipts pointing INTO trace_history. A row
  // either of them references can never be a delete candidate, whatever
  // trace_history's own columns say about it.
  if (rec.table === "wallet_transactions") {
    return { data: H.ledgerRefs, error: H.ledgerRefsError };
  }
  if (rec.table === "usage_records") {
    return { data: H.usageRefs, error: H.ledgerRefsError };
  }
  // The cache lookup, answered the way PostgREST answers it: the row, or
  // PGRST116 for no rows. checkSingleDuplicate THROWS on any other error, so
  // returning a bare null here would hide a broken query as a cache miss.
  if (isDedupSelect(rec)) {
    return H.cached
      ? { data: H.cached, error: null }
      : { data: null, error: { code: "PGRST116", message: "no rows" } };
  }
  return { data: H.survivingRow, error: null };
}

/** True when this select is the dedup lookup: only it carries the cache filter. */
function isDedupSelect(rec: Recorded): boolean {
  return rec.op === "select" && rec.filters.some((f) => f[0] === "or");
}

function recordingClient() {
  return {
    from(table: string) {
      const begin = (op: Recorded["op"], payload?: unknown) => {
        const rec: Recorded = { table, op, filters: [], payload };
        H.ops.push(rec);
        const node: Record<string, unknown> = {};
        const add =
          (method: string) =>
          (...args: unknown[]) => {
            rec.filters.push([method, ...args]);
            return node;
          };
        for (const m of [
          "eq",
          "neq",
          "gte",
          "lte",
          "lt",
          "gt",
          "is",
          "or",
          "in",
          "not",
          "select",
          "limit",
        ]) {
          node[m] = add(m);
        }
        node.single = () => Promise.resolve(envelopeFor(rec));
        node.maybeSingle = () => Promise.resolve(envelopeFor(rec));
        node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(envelopeFor(rec)).then(res, rej);
        return node;
      };
      return {
        select: (...args: unknown[]) => begin("select", args[0]),
        delete: () => begin("delete"),
        insert: (payload: unknown) => begin("insert", payload),
        update: (payload: unknown) => begin("update", payload),
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      H.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: H.deductData, error: H.deductError });
    },
  };
}

/**
 * The COOKIE-BACKED ANON client. It answers `user_profiles`, which is the
 * caller's own row and what this route legitimately reads through it, and it is
 * BLIND on `trace_history`.
 *
 * That blindness is a FENCE, not a fidelity claim: with a session cookie RLS
 * would let this client see the caller's own traces. It is wired blind so that
 * pointing the cache lookup back at it fails here as loudly as it does on the
 * API-key surface, where there is no cookie and the lookup really does see
 * nothing.
 */
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const client = recordingClient();
    return {
      auth: { getUser: async () => ({ data: { user: H.user } }) },
      ...client,
      from: (table: string) =>
        table === "trace_history"
          ? {
              select: () => {
                H.anonTraceSelects += 1;
                const node: Record<string, unknown> = {};
                const self = () => node;
                for (const m of ["eq", "neq", "gte", "lte", "lt", "gt", "is", "or", "in", "not", "limit"]) {
                  node[m] = self;
                }
                const empty = { data: null, error: { code: "PGRST116", message: "no rows" } };
                node.single = () => Promise.resolve(empty);
                node.maybeSingle = () => Promise.resolve(empty);
                node.then = (res: (v: unknown) => unknown) =>
                  Promise.resolve({ data: [], error: null }).then(res);
                return node;
              },
            }
          : client.from(table),
    };
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => recordingClient(),
}));

// DEDUPLICATION IS NOT MOCKED. It was, and that made every cache assertion in
// this file a statement about the mock rather than about the lookup. The real
// one now runs against the two clients above, so a lookup that cannot see the
// caller's rows fails here instead of passing (lessons.md L-009).

vi.mock("@/lib/tracerfy/client", () => ({
  submitSingleTrace: vi.fn(async () => H.submit),
  // The two SYNCHRONOUS contact endpoints. Only the vendors are mocked: the
  // real planRoute and the real executeRoute run, so these tests cover the
  // routing and the spend accounting, not just the route's own branches.
  lookupBusinessTrace: vi.fn(async () => H.entity),
  lookupPersonTrace: vi.fn(async () => H.person),
}));

vi.mock("@/lib/tracerfy/dossier", () => ({
  lookupDossier: vi.fn(async () => H.dossier),
}));

vi.mock("@/lib/utils/auto-rebill", () => ({
  triggerAutoRebillIfNeeded: vi.fn(async () => undefined),
}));

vi.mock("@/lib/highlevel/client", () => ({
  pushTraceToHighLevel: vi.fn(async () => H.pushResult),
}));

/**
 * `after()` is captured, not executed. The CRM push and the record of it are
 * handed to `after()` so they outlive the response; running the real one here
 * would schedule work these tests never wait on, so the assertions would be
 * reading a race. Same shape as lib/highlevel/__tests__/credentialHealth.test.ts.
 */
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    H.scheduled.push(fn);
  },
}));

const { POST } = await import("@/app/api/trace/single/route");
const { pushTraceToHighLevel } = await import("@/lib/highlevel/client");

/** Drain everything `after()` was handed, in order. */
async function flushDeferred(): Promise<void> {
  while (H.scheduled.length > 0) await H.scheduled.shift()!();
}

/**
 * The TIER 1 body. It carries an owner of record on purpose: since 2026-09-17
 * an ABSENT owner is itself the tier 2 trigger, so a body without one no longer
 * describes the async per-successful-trace path these tests characterize.
 */
const BODY = {
  address: "123 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
  owner_name: "ACME HOLDINGS LLC",
};

/** The TIER 2 body: same address, no owner of record. */
const TIER2_BODY = {
  address: "123 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
};

function post(body: Record<string, unknown> = BODY) {
  return POST(
    new Request("http://localhost/api/trace/single", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
}

/** Every DELETE issued against trace_history, in order. */
function deletes(): Recorded[] {
  return H.ops.filter((o) => o.table === "trace_history" && o.op === "delete");
}

function hasFilter(rec: Recorded, method: string, column: string, value?: unknown): boolean {
  return rec.filters.some(
    (f) =>
      f[0] === method &&
      f[1] === column &&
      (value === undefined || JSON.stringify(f[2]) === JSON.stringify(value))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  H.ops = [];
  H.rpcCalls = [];
  H.deductData = true;
  H.deductError = null;
  H.dossier = { success: true, hit: false, owners: [], property: null, mailingAddress: null, creditsDeducted: 0 };
  H.entity = { success: true, hit: false, contacts: null };
  H.person = { success: true, hit: false, contacts: null };
  H.user = { id: "user-1" };
  H.cached = null;
  H.insertedRow = { id: "trace-new" };
  H.insertError = null;
  H.deleteError = null;
  H.survivingRow = null;
  H.ledgerRefs = [];
  H.usageRefs = [];
  H.ledgerRefsError = null;
  H.anonTraceSelects = 0;
  H.submit = { success: true, jobId: "tj-1" };
  H.profile = {
    id: "user-1",
    subscription_tier: "wallet",
    wallet_balance: 100,
    is_acquisition_pro_member: false,
    gateway_products: null,
  };
  H.webhookPosts = [];
  H.pushResult = { success: true, contactId: "hl-1", action: "created" };
  H.scheduled = [];
  // The trace.completed webhook is a raw fetch to the customer's own URL.
  // Capture it rather than letting a test reach the network.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown, init: unknown) => {
    H.webhookPosts.push({
      url: String(url),
      body: JSON.parse(String((init as { body?: unknown })?.body ?? "{}")),
    });
    return new Response("{}", { status: 200 });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/trace/single — auth and balance gates", () => {
  it("401s with no session", async () => {
    H.user = null;
    const res = await post();
    expect(res.status).toBe(401);
    expect(deletes()).toHaveLength(0);
  });

  it("400s on an invalid address before touching the database", async () => {
    const res = await post({ ...BODY, address: "" });
    expect(res.status).toBe(400);
    expect(H.ops.filter((o) => o.table === "trace_history")).toHaveLength(0);
  });

  it("400s when the profile is missing", async () => {
    H.profile = null;
    const res = await post();
    expect(res.status).toBe(400);
  });

  it("402s when the wallet cannot cover one tier 1 trace", async () => {
    H.profile = { ...H.profile, wallet_balance: PRICING.CHARGE_PER_SUCCESS_WALLET - 0.01 };
    const res = await post();
    expect(res.status).toBe(402);
    expect(deletes()).toHaveLength(0);
  });
});

describe("POST /api/trace/single — cache hit", () => {
  it("returns the cached contacts free of charge and deletes nothing", async () => {
    H.cached = {
      id: "trace-cached",
      input_owner_name: "ACME HOLDINGS LLC",
      trace_result: { phones: ["512-555-0100"], emails: [] },
    };

    const res = await post();
    const body = await res.json();

    expect(body).toMatchObject({ success: true, is_cached: true, charge: 0, trace_id: "trace-cached" });
    expect(deletes()).toHaveLength(0);
    expect(H.ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("emails alone count as contact data", async () => {
    H.cached = {
      id: "trace-cached",
      input_owner_name: "ACME HOLDINGS LLC",
      trace_result: { phones: [], emails: ["a@b.com"] },
    };
    const body = await (await post()).json();
    expect(body.is_cached).toBe(true);
  });
});

/** Asserts a delete carries the full not-billed predicate. */
function expectBilledGuard(rec: Recorded) {
  expect(
    rec.filters.some((f) => f[0] === "is" && f[1] === "property_record" && f[2] === null)
  ).toBe(true);
  const orClauses = rec.filters.filter((f) => f[0] === "or").map((f) => String(f[1]));
  expect(orClauses).toContain("charge.is.null,charge.lte.0");
  expect(orClauses).toContain("ai_research_charge.is.null,ai_research_charge.lte.0");
}

describe("POST /api/trace/single — cached row with no contacts", () => {
  it("does not delete a row the customer paid for", async () => {
    // Deleting it raises 23503 against wallet_transactions and destroys a
    // receipt if it ever succeeded.
    // MUTATION: drop the `if (!isBilledRow(...))` guard and this goes red.
    H.cached = {
      id: "trace-billed",
      trace_result: { phones: [], emails: [] },
      charge: 0.25,
      ai_research_charge: 0,
      property_record: null,
    };
    H.survivingRow = { id: "trace-billed" };

    await post();

    expect(deletes().some((d) => hasFilter(d, "eq", "id", "trace-billed"))).toBe(false);
  });

  it("does not delete a row carrying a property_record even at charge 0", async () => {
    // Tier 2 shape: the property record IS what was bought, and the contact
    // step that would set `charge` may never have run.
    H.cached = {
      id: "trace-tier2",
      trace_result: null,
      charge: 0,
      ai_research_charge: 0,
      property_record: { parcel_id: "abc" },
    };
    H.survivingRow = { id: "trace-tier2" };

    await post();

    expect(deletes().some((d) => hasFilter(d, "eq", "id", "trace-tier2"))).toBe(false);
  });

  it("still deletes an unbilled empty row so it can be retried", async () => {
    // The guard must not become "never delete anything".
    H.cached = {
      id: "trace-free",
      trace_result: { phones: [], emails: [] },
      charge: 0,
      ai_research_charge: 0,
      property_record: null,
    };

    await post();

    expect(deletes().some((d) => hasFilter(d, "eq", "id", "trace-free"))).toBe(true);
  });
});

describe("POST /api/trace/single — the sweep deletes", () => {
  it("never targets a billed row when clearing failed traces", async () => {
    // is_successful = false is EXACTLY the tier 2 paid-but-no-contacts shape.
    // MUTATION: unwrap excludeBilledRows() here and this goes red.
    await post();

    const failedSweep = deletes().find((d) => hasFilter(d, "eq", "is_successful", false));
    expect(failedSweep).toBeDefined();
    expectBilledGuard(failedSweep!);
  });

  it("never targets a billed row when clearing stale processing traces", async () => {
    await post();

    const staleSweep = deletes().find((d) => hasFilter(d, "eq", "status", "processing"));
    expect(staleSweep).toBeDefined();
    expectBilledGuard(staleSweep!);
  });

  it("never targets a billed row when the owner name changes", async () => {
    await post({ ...BODY, owner_name: "JANE DOE" });

    const ownerSweep = deletes().find((d) => hasFilter(d, "neq", "input_owner_name", "JANE DOE"));
    expect(ownerSweep).toBeDefined();
    expectBilledGuard(ownerSweep!);
  });

  it("never targets a billed row on skip_cache", async () => {
    // "Clear cache" means "let me re-trace", not "destroy my receipt".
    await post({ ...BODY, skip_cache: true });

    const all = deletes();
    expect(all).toHaveLength(1);
    expect(hasFilter(all[0], "eq", "address_hash")).toBe(true);
    expectBilledGuard(all[0]);
  });

  it("skip_cache bypasses the cache lookup entirely", async () => {
    // Asserted on the query the lookup would have issued rather than on a spy,
    // because deduplication is no longer mocked in this file. The cache lookup
    // is the only select here that carries CACHE_HIT_FILTER.
    await post({ ...BODY, skip_cache: true });

    expect(H.ops.some(isDedupSelect)).toBe(false);
  });
});

describe("POST /api/trace/single — delete errors are checked", () => {
  it("fails with the real reason instead of walking into a unique violation", async () => {
    // 23503 from wallet_transactions_trace_history_id_fkey. Until 2026-09-17
    // the route ignored it, the row survived, and the INSERT died on
    // UNIQUE(user_id, address_hash) as a 500 that named nothing.
    // MUTATION: delete the `if (deleteErrors.length > 0)` branch and this
    // goes red on both assertions.
    H.deleteError = { message: "violates foreign key constraint", code: "23503" };

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(String(body.error)).toContain("foreign key");
    expect(H.ops.some((o) => o.op === "insert")).toBe(false);
  });
});

describe("POST /api/trace/single — reuse instead of collide", () => {
  it("updates the surviving billed row rather than inserting a duplicate", async () => {
    // UNIQUE(user_id, address_hash) makes a second row impossible, and tier 2
    // wants one row enriched in two phases anyway.
    // MUTATION: replace the reuse branch with the unconditional insert and
    // this goes red.
    H.survivingRow = { id: "trace-billed" };
    H.insertedRow = { id: "trace-billed" };

    const body = await (await post()).json();

    expect(H.ops.some((o) => o.op === "insert")).toBe(false);
    const reuse = H.ops.find(
      (o) => o.op === "update" && o.filters.some((f) => f[0] === "eq" && f[1] === "id")
    );
    expect(reuse).toBeDefined();
    expect(reuse!.payload).toMatchObject({ status: "processing", tracerfy_job_id: null });
    expect(body.trace_id).toBe("trace-billed");
  });

  it("the reuse UPDATE never touches what the customer paid for", async () => {
    H.survivingRow = { id: "trace-billed" };
    H.insertedRow = { id: "trace-billed" };

    await post();

    const reuse = H.ops.find(
      (o) => o.op === "update" && o.filters.some((f) => f[0] === "eq" && f[1] === "id")
    );
    const keys = Object.keys(reuse!.payload as object);
    for (const paid of ["charge", "ai_research_charge", "property_record", "tier", "cost"]) {
      expect(keys).not.toContain(paid);
    }
    // Nor the identity columns, which already match.
    expect(keys).not.toContain("user_id");
    expect(keys).not.toContain("address_hash");
  });

  it("inserts when nothing survived", async () => {
    H.survivingRow = null;

    await post();

    expect(H.ops.some((o) => o.op === "insert")).toBe(true);
  });
});

describe("POST /api/trace/single: row creation, then the inline tier 1 settle", () => {
  it("inserts a processing row and settles it in the same request", async () => {
    const res = await post();
    const body = await res.json();

    const insert = H.ops.find((o) => o.op === "insert");
    expect(insert!.payload).toMatchObject({ user_id: "user-1", city: "AUSTIN", state: "TX", zip: "78701", status: "processing" });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: "no_match", trace_id: "trace-new", tier: 1, charge: 0 });
  });

  it("500s when the row cannot be created", async () => {
    H.insertError = { message: "duplicate key value violates unique constraint", code: "23505" };
    const res = await post();
    expect(res.status).toBe(500);
  });
});

/* ==================================================================== *
 * TIER 2 — FULL PROPERTY TRACE
 *
 * A NEW BILLING PATH. Tier 2 bills per RECORD SUBMITTED, which makes two
 * things true that are false everywhere else in this codebase:
 *   - a row can carry `charge > 0` with `is_successful = false`
 *   - a customer can receive NOTHING and still be charged
 *
 * The one distinction every test below is protecting: `success` is the
 * billing gate, never `ownerFound`. A billed MISS and an unbillable vendor
 * FAILURE both come back with ownerFound: false.
 *
 * Only the vendors are mocked here. The real planRoute and the real
 * executeRoute run, so these also cover which vendor a discovered owner is
 * routed to and what the route does with the spend report it gets back.
 * ==================================================================== */

import dossierEntityFixture from "@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json";
import dossierIndividualFixture from "@/lib/tracerfy/__tests__/fixtures/individual-hit.json";
import {
  BLOCKED_PROPERTY_RECORD_KEYS,
  toPublicPropertyRecord,
} from "@/lib/trace/publicPropertyRecord";

/** A dossier HIT on an entity-owned parcel, carrying the real 86-key record. */
const DOSSIER_ENTITY_HIT = {
  success: true,
  hit: true,
  owners: dossierEntityFixture.response.owners,
  property: dossierEntityFixture.response.property,
  mailingAddress: dossierEntityFixture.response.mailing_address,
  creditsDeducted: 10,
};

/** A dossier HIT on an individually-owned parcel. */
const DOSSIER_INDIVIDUAL_HIT = {
  success: true,
  hit: true,
  owners: dossierIndividualFixture.response.owners,
  property: dossierIndividualFixture.response.property,
  mailingAddress: dossierIndividualFixture.response.mailing_address,
  creditsDeducted: 10,
};

/** The county has no parcel at this address. Free at the vendor, BILLED to the customer. */
const DOSSIER_MISS = {
  success: true,
  hit: false,
  owners: [],
  property: null,
  mailingAddress: null,
  creditsDeducted: 0,
};

/** We could not ask. Never billed. */
const DOSSIER_FAILURE = {
  success: false,
  hit: false,
  owners: [],
  property: null,
  mailingAddress: null,
  creditsDeducted: 0,
  error: "Tracerfy service unavailable",
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

const PAYG_PROFILE = {
  id: "user-1",
  subscription_tier: "wallet",
  wallet_balance: 100,
  is_acquisition_pro_member: false,
  gateway_products: null,
};
const PRO_PROFILE = { ...PAYG_PROFILE, subscription_tier: "pro" };
const ACQ_PRO_PROFILE = { ...PAYG_PROFILE, is_acquisition_pro_member: true };

/** Every call to deduct_wallet_balance. */
const deducts = () => H.rpcCalls.filter((c) => c.fn === "deduct_wallet_balance");

/** The UPDATE that writes the tier 2 outcome. */
function persisted(): Record<string, unknown> | undefined {
  const rec = H.ops.find(
    (o) =>
      o.op === "update" &&
      o.payload !== null &&
      typeof o.payload === "object" &&
      "property_record" in (o.payload as object)
  );
  return rec?.payload as Record<string, unknown> | undefined;
}

async function vendorsCalled() {
  const { lookupDossier } = await import("@/lib/tracerfy/dossier");
  const { submitSingleTrace, lookupBusinessTrace, lookupPersonTrace } = await import(
    "@/lib/tracerfy/client"
  );
  return { lookupDossier, submitSingleTrace, lookupBusinessTrace, lookupPersonTrace };
}

describe("tier 2 — the trigger", () => {
  it("runs automatically when no owner of record was supplied", async () => {
    H.dossier = DOSSIER_MISS;
    const { lookupDossier, submitSingleTrace } = await vendorsCalled();

    const body = await (await post(TIER2_BODY)).json();

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(body.tier).toBe(2);
  });

  it("does NOT run when the owner of record was supplied", async () => {
    // WAS: submitted to the Tracerfy batch. A supplied owner now runs the tier 1 ladder inline.
    const { lookupDossier, submitSingleTrace, lookupBusinessTrace } = await vendorsCalled();

    const body = await (await post(BODY)).json();

    expect(lookupDossier).not.toHaveBeenCalled();
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
    expect(body.tier).toBe(1);
    expect(deducts()).toHaveLength(0);
  });

  it("runs on the explicit opt-in even when the owner IS supplied", async () => {
    // The caller has the owner and wants the county property record anyway.
    H.dossier = DOSSIER_MISS;
    const { lookupDossier, submitSingleTrace } = await vendorsCalled();

    await post({ ...BODY, full_property_trace: true });

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(submitSingleTrace).not.toHaveBeenCalled();
  });

  it("does not reuse the ai_research flag", async () => {
    // AI Search is being removed; overloading its flag would couple the two.
    const { lookupDossier } = await vendorsCalled();
    await post({ ...BODY, ai_research: { owner_name: "ACME HOLDINGS LLC" } });
    expect(lookupDossier).not.toHaveBeenCalled();
  });

  it("keys the dossier on the submitted address", async () => {
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await vendorsCalled();

    await post(TIER2_BODY);

    expect(lookupDossier).toHaveBeenCalledWith(
      {
        mode: "address",
        address: "123 Main St",
        city: "Austin",
        state: "TX",
        zip_code: "78701",
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });
});

describe("tier 2 — the pre-flight balance gate", () => {
  it("402s a pay-as-you-go wallet that cannot cover ONE record", async () => {
    // 0.39 covers the tier 1 wallet rate (0.25) and not the tier 2 one (0.40).
    // MUTATION: reserve chargePerTrace() here and this goes red -- the request
    // reaches the vendors, we spend, and there is nothing to collect from.
    H.profile = { ...PAYG_PROFILE, wallet_balance: 0.39 };
    const { lookupDossier } = await vendorsCalled();

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(402);
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
  });

  it("lets a pro wallet through at the pro rate", async () => {
    H.profile = { ...PRO_PROFILE, wallet_balance: 0.25 };
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await vendorsCalled();

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(200);
    expect(lookupDossier).toHaveBeenCalledTimes(1);
  });
});

describe("tier 2 — a vendor FAILURE is never billed", () => {
  it("charges nothing when the dossier could not be asked", async () => {
    // success:false and ownerFound:false. A miss looks identical on ownerFound,
    // which is exactly why the gate is `success`.
    // MUTATION: gate the deduct on execution.ownerFound and this goes red.
    H.dossier = DOSSIER_FAILURE;

    const res = await post(TIER2_BODY);
    const body = await res.json();

    expect(deducts()).toHaveLength(0);
    expect(res.status).toBe(502);
    expect(body.charge).toBe(0);
    expect(body.error).toContain("unavailable");
  });

  it("persists nothing billable, so the customer can retry for free", async () => {
    H.dossier = DOSSIER_FAILURE;

    await post(TIER2_BODY);

    expect(persisted()).toBeUndefined();
    const errored = H.ops.find(
      (o) => o.op === "update" && (o.payload as Record<string, unknown>)?.status === "error"
    );
    expect(errored).toBeDefined();
  });

  it("charges nothing when the CONTACT step fails after the dossier hit", async () => {
    // The $0.20 dossier is already spent on our side. It is still not billed:
    // we could not complete the ask, so the customer must be able to retry.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = { success: false, hit: false, contacts: null, error: "FastAppend auth failed (403)" };

    const res = await post(TIER2_BODY);

    expect(deducts()).toHaveLength(0);
    expect(res.status).toBe(502);
    expect(persisted()).toBeUndefined();
  });
});

describe("tier 2 — a TOTAL MISS is still billed", () => {
  it("charges the full per-record rate when the county has no parcel", async () => {
    // "Per record submitted" is literal: the customer receives nothing and is
    // charged. David, 2026-09-17.
    // MUTATION: skip the deduct when execution.property is null and this goes red.
    H.dossier = DOSSIER_MISS;

    const body = await (await post(TIER2_BODY)).json();

    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(0.4);
    expect(deducts()[0].args.p_trace_history_id).toBe("trace-new");
    expect(body).toMatchObject({ success: true, status: "no_match", tier: 2, charge: 0.4 });
  });

  it("writes the cacheable billed-miss row shape", async () => {
    // tier = 2, charge > 0, property_record IS NULL, status = 'no_match'.
    // This is the row CACHE_HIT_FILTER's third arm exists to find.
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(persisted()).toMatchObject({
      tier: 2,
      charge: 0.4,
      property_record: null,
      status: "no_match",
      is_successful: false,
    });
  });

  it("charges a dossier hit whose contact step found nothing", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = { success: true, hit: false, contacts: null };

    const body = await (await post(TIER2_BODY)).json();

    expect(deducts()).toHaveLength(1);
    expect(body.status).toBe("no_match");
    expect(persisted()).toMatchObject({ is_successful: false, charge: 0.4, tier: 2 });
  });
});

describe("tier 2 — the caller's REAL plan is billed", () => {
  it("bills pay-as-you-go at the wallet column", async () => {
    // MUTATION: hardcode planRoute's plan argument to 'pro' and this goes red.
    // That is the 40% undercharge FAILSAFE_PRICE_PLAN was written against.
    H.profile = PAYG_PROFILE;
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(deducts()[0].args.p_amount).toBe(0.4);
  });

  it("bills a pro at the pro column", async () => {
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(deducts()[0].args.p_amount).toBe(0.25);
  });

  it("bills an AcquisitionPRO member at the pro column", async () => {
    H.profile = ACQ_PRO_PROFILE;
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(deducts()[0].args.p_amount).toBe(0.25);
  });

  it("deducts exactly ONCE per record", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    expect(deducts()).toHaveLength(1);
  });

  it("persists only what was actually collected", async () => {
    // deduct_wallet_balance returns FALSE without moving money when the wallet
    // is short. Writing the intended amount would show the customer a charge
    // they never paid.
    // MUTATION: persist plan.billing.amount instead of the deductOrZero result
    // and this goes red.
    H.dossier = DOSSIER_MISS;
    H.deductData = false;

    const body = await (await post(TIER2_BODY)).json();

    expect(persisted()).toMatchObject({ charge: 0 });
    expect(body.charge).toBe(0);
    expect(String(body.warnings.join(" "))).toContain("did not cover");
  });
});

describe("tier 2 — what gets persisted", () => {
  it("stores the property record RAW, all 86 keys", async () => {
    // The fidelity rule: no filtering, no renaming, no subsetting. A field
    // empty in OH, CA and UT may be populated in another county, and the $0.20
    // was already spent to fetch it.
    // MUTATION: subset the object to the fields we display and this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    const stored = persisted()!.property_record as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(
      Object.keys(dossierEntityFixture.response.property).length
    );
    expect(stored).toEqual(dossierEntityFixture.response.property);
  });

  it("returns the PUBLISHABLE record to the caller, 65 of the stored 86", async () => {
    // CHARACTERIZATION CHANGED, 2026-09-17, David: this asserted that the
    // response equalled the stored record key for key. The 21 blocked fields
    // are now withheld from every egress, not only from the screen, for the
    // reason that already blocked them from the CSV export: the payload lands
    // in a customer's own system, where a wrong `estimated_value` looks
    // authoritative and outlives any caveat we could put on a screen.
    //
    // MUTATION: drop toPublicPropertyRecord from the response and this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    const body = await (await post(TIER2_BODY)).json();

    expect(body.property_record).toEqual(
      toPublicPropertyRecord(dossierEntityFixture.response.property)
    );
    expect(Object.keys(body.property_record)).toHaveLength(65);
  });

  it("carries no blocked key in the response, and all 86 in the row", async () => {
    // The whole point in one test: the same variable leaves by two doors and
    // only one of them is filtered.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    const body = await (await post(TIER2_BODY)).json();
    const stored = persisted()!.property_record as Record<string, unknown>;

    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(body.property_record, `${key} left PTP`).not.toHaveProperty(key);
      expect(stored, `${key} was filtered out of STORAGE`).toHaveProperty(key);
    }
  });

  it("does not let the response filter mutate the row it just wrote", async () => {
    // The route persists execution.property and returns THE SAME VARIABLE
    // filtered. An in-place delete would write a 65-key record to
    // trace_history and destroy the raw dump, silently and permanently.
    // MUTATION: make toPublicPropertyRecord delete from its argument and this
    // goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    const stored = persisted()!.property_record as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(86);
    expect(stored).toEqual(dossierEntityFixture.response.property);
  });

  it("puts contacts where tier 1 already puts them", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    const row = persisted()!;
    expect(row).toMatchObject({
      status: "success",
      is_successful: true,
      phone_count: 1,
      email_count: 1,
      tier: 2,
      charge: 0.4,
    });
    const result = row.trace_result as Record<string, unknown>;
    expect(result.owner_name).toBe("Testowner Placeholder");
    // The OWNER OF RECORD the dossier bought, which has nowhere else to live:
    // the 86-key property object carries no owner field.
    expect(result.owner_name_2).toBe("Colmaven, Llc");
    expect(result.emails).toEqual(["principal@example.invalid"]);
  });

  it("keeps the owner of record even when no contacts came back", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = { success: true, hit: false, contacts: null };

    await post(TIER2_BODY);

    const result = persisted()!.trace_result as Record<string, unknown>;
    expect(result.owner_name_2).toBe("Colmaven, Llc");
    expect(result.owner_name).toBeNull();
    expect(result.phones).toEqual([]);
  });

  it("records what the vendors actually took, not a price-list guess", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    // $0.20 dossier (10 credits) + $0.10 entity contact call.
    expect(persisted()!.cost).toBe(0.3);
  });

  it("clears the Tracerfy job id: there is nothing to poll", async () => {
    H.dossier = DOSSIER_MISS;

    const body = await (await post(TIER2_BODY)).json();

    expect(persisted()!.tracerfy_job_id).toBeNull();
    expect(body.tracerfy_job_id).toBeUndefined();
  });
});

describe("tier 2 — the discovered owner picks the vendor", () => {
  it("routes an entity owner to FastAppend, keyed on name plus state", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    const { lookupBusinessTrace, lookupPersonTrace } = await vendorsCalled();

    await post(TIER2_BODY);

    expect(lookupBusinessTrace).toHaveBeenCalledWith(
      {
        company_name: "Colmaven, Llc",
        state: "TX",
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(lookupPersonTrace).not.toHaveBeenCalled();
  });

  it("routes an individual owner to the named Tracerfy lookup", async () => {
    H.dossier = DOSSIER_INDIVIDUAL_HIT;
    H.person = CONTACTS_HIT;
    const { lookupBusinessTrace, lookupPersonTrace } = await vendorsCalled();

    await post(TIER2_BODY);

    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(lookupPersonTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        first_name: "Testowner",
        last_name: "Placeholder",
        address: "123 Main St",
        find_owner: false,
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });
});

describe("tier 2 — a billed row is served from the database, free", () => {
  it("serves a billed MISS without re-running the dossier", async () => {
    // The row carries no contacts and no property record, so only the third
    // arm of CACHE_HIT_FILTER can find it. Re-buying it bills the customer a
    // second time for the same absence.
    // MUTATION: delete the isCacheHitRow branch in the route and this goes red.
    H.cached = {
      id: "trace-billed-miss",
      trace_result: null,
      status: "no_match",
      is_successful: false,
      charge: 0.4,
      ai_research_charge: 0,
      property_record: null,
      tier: 2,
    };
    H.survivingRow = { id: "trace-billed-miss" };
    const { lookupDossier } = await vendorsCalled();

    const body = await (await post(TIER2_BODY)).json();

    expect(lookupDossier).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
    expect(body).toMatchObject({ success: true, is_cached: true, charge: 0, trace_id: "trace-billed-miss" });
  });

  it("serves a paid property record with no contacts, free", async () => {
    H.cached = {
      id: "trace-tier2",
      trace_result: null,
      is_successful: false,
      charge: 0.4,
      ai_research_charge: 0,
      property_record: { apn: "abc" },
      tier: 2,
    };
    H.survivingRow = { id: "trace-tier2" };
    const { lookupDossier } = await vendorsCalled();

    const body = await (await post(TIER2_BODY)).json();

    expect(lookupDossier).not.toHaveBeenCalled();
    expect(body.property_record).toEqual({ apn: "abc" });
    expect(body.charge).toBe(0);
  });

  it("re-buys an UNBILLED failure rather than serving nothing forever", async () => {
    // The guard must not become "never trace this address again".
    H.cached = {
      id: "trace-free",
      trace_result: { phones: [], emails: [] },
      is_successful: false,
      charge: 0,
      ai_research_charge: 0,
      property_record: null,
      tier: null,
    };
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await vendorsCalled();

    await post(TIER2_BODY);

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(deducts()).toHaveLength(1);
  });

  it("re-buys a tier 2 row where nothing was ever collected", async () => {
    // charge = 0 means the deduct returned false. There is no purchase to
    // serve back, so this correctly spends again.
    H.cached = {
      id: "trace-uncollected",
      trace_result: null,
      is_successful: false,
      charge: 0,
      ai_research_charge: 0,
      property_record: null,
      tier: 2,
    };
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await vendorsCalled();

    await post(TIER2_BODY);

    expect(lookupDossier).toHaveBeenCalledTimes(1);
  });

  it("skip_cache re-buys, because it forces a fresh vendor call", async () => {
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await vendorsCalled();

    await post({ ...TIER2_BODY, skip_cache: true });

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(deducts()).toHaveLength(1);
  });
});

describe("tier 2 — the learned zip is persisted without moving the cache key", () => {
  it("writes the situs zip the dossier taught us when the caller sent none", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    const { zip: _dropped, ...noZip } = TIER2_BODY;
    void _dropped;

    await post(noZip);

    const situsZip = String(
      (dossierEntityFixture.response.property as Record<string, unknown>).zip_code
    );
    expect(persisted()!.zip).toBe(situsZip);
  });

  it("NEVER touches address_hash", async () => {
    // address_hash is sha256 of STREET|CITY|STATE and deliberately excludes the
    // zip (migration 20260904). A row whose hash moves stops matching its own
    // cache key and re-buys itself forever.
    // MUTATION: add address_hash to the tier 2 update payload and this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    const { zip: _dropped, ...noZip } = TIER2_BODY;
    void _dropped;

    await post(noZip);

    const insertedHash = (H.ops.find((o) => o.op === "insert")!.payload as Record<string, unknown>)
      .address_hash;
    expect(insertedHash).toBeTruthy();
    expect(Object.keys(persisted()!)).not.toContain("address_hash");
    expect(Object.keys(persisted()!)).not.toContain("normalized_address");
  });

  it("does not rewrite a zip the caller supplied", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    expect(Object.keys(persisted()!)).not.toContain("zip");
  });

  it("no longer 500s on a submission with no zip at all", async () => {
    // `zip.substring(0, 5)` threw before the row was even created, which made
    // the backfill unreachable from this route.
    H.dossier = DOSSIER_MISS;
    const { zip: _dropped, ...noZip } = TIER2_BODY;
    void _dropped;

    const res = await post(noZip);

    expect(res.status).toBe(200);
    expect((H.ops.find((o) => o.op === "insert")!.payload as Record<string, unknown>).zip).toBeNull();
  });
});

describe("tier 2 — the charge follows the vendor call", () => {
  it("never deducts when no vendor was asked", async () => {
    // planRoute emits no step when the parcel carries no usable key. Address
    // validation makes that unreachable from this route; the guard exists
    // because a record nobody was asked about must never reach the deduct.
    const { planRoute } = await import("@/lib/routing/ownerRoute");
    const spy = vi.spyOn(await import("@/lib/routing/ownerRoute"), "planRoute");
    spy.mockImplementationOnce((parcel, plan) => ({
      ...planRoute(parcel, plan),
      steps: [],
    }));
    const { lookupDossier } = await vendorsCalled();

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(400);
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
    spy.mockRestore();
  });
});

/* ==================================================================== *
 * THE trace.completed WEBHOOK, session route.
 *
 * Tier 1 completes in app/api/trace/status and fires trace.completed from
 * there. Tier 2 completes INLINE inside this request and never reaches
 * that route, so without the dispatch below a webhook customer silently
 * stops receiving events -- and silence is the failure mode nobody
 * notices. Phase 3b flagged this as a known gap; phase 4 closes it.
 *
 * Deliberately NOT tested here, because it is deliberately NOT wired:
 * the HighLevel CRM push. That is phase 4b -- it needs all 65 dossier
 * fields auto-created as custom fields plus a Private Integration Token
 * scope warning, and the poll route's `isSuccessful && result` gate is
 * wrong for tier 2.
 * ==================================================================== */
const WEBHOOK_PROFILE = { ...PRO_PROFILE, webhook_url: "https://hooks.example.invalid/ptp" };

function webhooks() {
  return H.webhookPosts.filter((p) => p.body.event === "trace.completed");
}

describe("tier 2 — trace.completed", () => {
  it("fires after a successful tier 2, carrying the three new keys", async () => {
    H.profile = WEBHOOK_PROFILE;
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    expect(webhooks()).toHaveLength(1);
    expect(webhooks()[0].url).toBe("https://hooks.example.invalid/ptp");
    expect(webhooks()[0].body).toMatchObject({
      event: "trace.completed",
      trace_id: "trace-new",
      status: "success",
      tier: 2,
      owner_type: "entity",
      charge: 0.25,
    });
    expect(webhooks()[0].body.property_record).not.toBeNull();
  });

  it("keeps the poll route's payload shape, key for key", async () => {
    // An existing webhook consumer parses the poll route's payload. Tier 2 adds
    // keys; it must not remove or rename any.
    H.profile = WEBHOOK_PROFILE;
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    for (const key of [
      "event",
      "trace_id",
      "status",
      "address",
      "city",
      "state",
      "zip",
      "result",
      "research",
      "charge",
      "timestamp",
    ]) {
      expect(Object.keys(webhooks()[0].body)).toContain(key);
    }
  });

  it("FIRES ON A BILLED MISS, which is the case a customer most needs told about", async () => {
    // The poll route's rule is "send for all completed traces", not "send for
    // successful ones". A billed miss is a completed trace the customer paid for.
    // MUTATION: gate the dispatch on isSuccessful and this goes red.
    H.profile = WEBHOOK_PROFILE;
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(webhooks()).toHaveLength(1);
    expect(webhooks()[0].body).toMatchObject({
      status: "no_match",
      charge: 0.25,
      tier: 2,
      property_record: null,
    });
  });

  it("does NOT fire on a vendor failure, which charges nothing", async () => {
    // MUTATION: move the dispatch above the !execution.success return and this
    // goes red. The poll route's stall-error branch fires nothing either.
    H.profile = WEBHOOK_PROFILE;
    H.dossier = DOSSIER_FAILURE;

    await post(TIER2_BODY);

    expect(webhooks()).toHaveLength(0);
  });

  it("does not fire for a caller with no webhook configured", async () => {
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_MISS;
    await post(TIER2_BODY);
    expect(webhooks()).toHaveLength(0);
  });

  it("FIRES on the tier 1 path, which now completes inline, carrying tier 1 and its outcome", async () => {
    // MUTATION: delete the tier 1 dispatchTraceCompleted call and this goes red.
    H.profile = WEBHOOK_PROFILE;
    await post(BODY);
    expect(webhooks()).toHaveLength(1);
    expect(webhooks()[0].body).toMatchObject({
      event: "trace.completed", status: "no_match", tier: 1, charge: 0, property_record: null,
      found_by: null, outcome_code: "no_match",
      skip_reason: "We looked this owner up by company name and found no match. You were not charged.",
    });
  });

  it("does not fire when the answer was served free from the cache", async () => {
    // Nothing completed: the row was already the customer's.
    H.profile = WEBHOOK_PROFILE;
    H.cached = { id: "trace-billed-miss", trace_result: null, charge: 0.25, tier: 2 };
    await post(TIER2_BODY);
    expect(webhooks()).toHaveLength(0);
  });

  it("never fails the request or the charge when the webhook throws", async () => {
    H.profile = WEBHOOK_PROFILE;
    H.dossier = DOSSIER_MISS;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("customer endpoint down"));

    const res = await post(TIER2_BODY);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.charge).toBe(0.25);
    expect(deducts()).toHaveLength(1);
  });

  it("reports the charge that was COLLECTED, not the one attempted", async () => {
    H.profile = WEBHOOK_PROFILE;
    H.dossier = DOSSIER_MISS;
    H.deductData = false;

    await post(TIER2_BODY);

    expect(webhooks()[0].body.charge).toBe(0);
  });

  it("reports the address that was persisted, including a learned zip", async () => {
    H.profile = WEBHOOK_PROFILE;
    H.dossier = DOSSIER_ENTITY_HIT;
    const { address, city, state } = TIER2_BODY;

    await post({ address, city, state });

    const sent = webhooks()[0].body;
    expect(sent.city).toBe("AUSTIN");
    expect(sent.state).toBe("TX");
    expect(typeof sent.zip).toBe("string");
    expect(String(sent.zip)).toHaveLength(5);
  });
});

/* ====================================================================
 * EVERY DOOR, NOT JUST THE ONE THAT SPENDS MONEY.
 *
 * The tier 2 response above is the obvious egress. These are the two that
 * are easy to miss, because the record comes back out of our own database
 * rather than from a vendor call and so does not look like it is leaving.
 * A cached row holds the RAW 86 keys; a cache hit must publish 65 just as
 * the purchase did, or the blocked fields reach the customer on their
 * SECOND request instead of their first.
 * ==================================================================== */

describe("session tier 2 — the cached branches filter too", () => {
  /** The real stored shape: a row holding all 86 keys, raw. */
  const STORED_RAW = dossierEntityFixture.response.property as Record<string, unknown>;

  it("filters the cache hit that carries contacts", async () => {
    // MUTATION: drop toPublicPropertyRecord from the contacts cache branch and
    // this goes red.
    H.cached = {
      id: "trace-cached",
      trace_result: { phones: [{ number: "5125550100" }], emails: [] },
      property_record: STORED_RAW,
      tier: 2,
    };

    const body = await (await post(TIER2_BODY)).json();

    expect(body.is_cached).toBe(true);
    expect(Object.keys(body.property_record)).toHaveLength(65);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(body.property_record, `${key} left PTP on a cache hit`).not.toHaveProperty(key);
    }
  });

  it("filters the billed tier 2 row served with no contacts", async () => {
    // MUTATION: drop toPublicPropertyRecord from the isCacheHitRow branch and
    // this goes red.
    H.cached = {
      id: "trace-tier2",
      trace_result: null,
      is_successful: false,
      charge: 0.4,
      ai_research_charge: 0,
      property_record: STORED_RAW,
      tier: 2,
    };
    H.survivingRow = { id: "trace-tier2" };

    const body = await (await post(TIER2_BODY)).json();

    expect(body.charge).toBe(0);
    expect(Object.keys(body.property_record)).toHaveLength(65);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(body.property_record, `${key} left PTP on a billed cache hit`).not.toHaveProperty(key);
    }
  });

  it("publishes the same 65 keys whether the record was just bought or cached", async () => {
    // A customer must not be able to tell the two apart by field count. If
    // they can, one of the two branches is the leak.
    H.cached = {
      id: "trace-cached",
      trace_result: { phones: [{ number: "5125550100" }], emails: [] },
      property_record: STORED_RAW,
      tier: 2,
    };
    const cachedBody = await (await post(TIER2_BODY)).json();

    H.ops = [];
    H.cached = null;
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    const freshBody = await (await post(TIER2_BODY)).json();

    expect(Object.keys(cachedBody.property_record).sort()).toEqual(
      Object.keys(freshBody.property_record).sort()
    );
  });

  it("still reports a row with no record as null, not as an empty object", async () => {
    H.cached = {
      id: "trace-billed-miss",
      trace_result: null,
      status: "no_match",
      is_successful: false,
      charge: 0.4,
      ai_research_charge: 0,
      property_record: null,
      tier: 2,
    };
    H.survivingRow = { id: "trace-billed-miss" };

    const body = await (await post(TIER2_BODY)).json();

    expect(body.property_record).toBeNull();
  });
});

/* ====================================================================
 * TELLING THE TRUTH WHEN NOTHING WAS COLLECTED.
 *
 * lib/wallet/deduct.ts answered 0 for an insufficient balance AND for an
 * RPC that never ran, and both routes then said "the wallet did not cover
 * this record". A customer with a full wallet was told they were short.
 * ==================================================================== */
describe("POST /api/trace/single — the two zeros say different things", () => {
  it("blames the balance only when the balance was actually short", async () => {
    H.deductData = false;
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    const body = await (await post(TIER2_BODY)).json();

    expect(body.charge).toBe(0);
    expect(String(body.warnings.join(" "))).toContain("did not cover");
  });

  it("owns the failure when the deduct RPC itself errored", async () => {
    // WAS: the same "your wallet did not cover this" sentence, which is false
    // for a customer whose wallet is full.
    // MUTATION: collapse the two outcomes back into `charge === 0` and this
    // goes red.
    H.deductData = true;
    H.deductError = { message: "fetch failed" };
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    const body = await (await post(TIER2_BODY)).json();

    expect(body.charge).toBe(0);
    const said = String(body.warnings.join(" "));
    expect(said).not.toContain("did not cover");
    expect(said).toContain("error on our side");
    expect(said).toContain("nothing was taken from your balance");
  });

  it("says nothing about the wallet at all when the charge went through", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    const body = await (await post(TIER2_BODY)).json();

    expect(String(body.warnings.join(" "))).not.toContain("wallet");
  });

  it("delivers the record either way, because we already bought it", async () => {
    // The decision, named rather than buried: on an RPC failure we spent at the
    // vendor and could not collect. The customer is not billed and keeps the
    // record. Billing them later for a record already delivered is exactly the
    // surprise charge this phase exists to remove.
    H.deductError = { message: "connection reset" };
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    const body = await (await post(TIER2_BODY)).json();

    expect(body.property_record).not.toBeNull();
    expect(body.result.phones).toHaveLength(1);
  });
});

/* ====================================================================
 * A ROW A LEDGER ROW POINTS AT IS NEVER A DELETE CANDIDATE.
 *
 * excludeBilledRows derives billed-ness from trace_history's own columns,
 * which is exactly what failed when a settle zeroed them: the guard was
 * wrong because its inputs were. Asking the ledger is the only question
 * that stays right, and it is the only thing that can free a row whose
 * receipt columns were ALREADY zeroed before the monotonic rule landed.
 * ==================================================================== */
describe("POST /api/trace/single — the deletes consult the ledger", () => {
  it("issues no delete when wallet_transactions references the row", async () => {
    // The row looks unbilled: charge 0, no property record, no research
    // charge. Only the FK knows better, and a delete would raise 23503.
    // MUTATION: drop the ledgerProtected guard from runDelete and this goes red.
    H.survivingRow = {
      id: "trace-zeroed",
      charge: 0,
      ai_research_charge: 0,
      property_record: null,
      tier: 1,
    };
    H.ledgerRefs = [{ id: "wt-1" }];

    await post();

    expect(deletes()).toHaveLength(0);
  });

  it("still deletes a row nothing references", async () => {
    // The guard must not become a blanket refusal: an ordinary stale row is
    // still swept.
    H.survivingRow = {
      id: "trace-free",
      charge: 0,
      ai_research_charge: 0,
      property_record: null,
      tier: 1,
    };
    H.ledgerRefs = [];

    await post();

    expect(deletes().length).toBeGreaterThan(0);
  });

  it("fails CLOSED when the ledger cannot be read", async () => {
    // Not knowing whether a row is referenced is not permission to delete it.
    // A refused delete is a 500 the customer cannot get past; a skipped one
    // just reuses the row in place.
    H.survivingRow = {
      id: "trace-unknown",
      charge: 0,
      ai_research_charge: 0,
      property_record: null,
    };
    H.ledgerRefsError = { message: "statement timeout" };

    await post();

    expect(deletes()).toHaveLength(0);
  });

  it("does not ask the ledger about a row that already reads billed", async () => {
    // isBilledRow answers first. The extra round trip is only spent on the rows
    // where the columns and the ledger can actually disagree.
    H.survivingRow = { id: "trace-billed", charge: 0.25, property_record: null };

    await post();

    expect(H.ops.some((o) => o.table === "wallet_transactions")).toBe(false);
    expect(deletes()).toHaveLength(0);
  });

  it("asks about nothing at all when the address has no row", async () => {
    H.survivingRow = null;

    await post();

    expect(H.ops.some((o) => o.table === "wallet_transactions")).toBe(false);
    expect(deletes().length).toBeGreaterThan(0);
  });
});

describe("POST /api/trace/single — the cache lookup reaches the caller's own rows", () => {
  it("runs on a client that can see them, not on the session client", async () => {
    // MUTATION: build checkSingleDuplicate's client from @/lib/supabase/server
    // again and this goes red here and on the v1 surface, where it is not a
    // fence but the live defect.
    await post();

    expect(H.anonTraceSelects).toBe(0);
    expect(H.ops.some(isDedupSelect)).toBe(true);
  });

  it("keys the lookup to the CALLER, unconditionally", async () => {
    // RLS is no longer a second fence on this query, so this filter is the only
    // thing between two customers who traced the same parcel. Two of them hold
    // two separate rows and BOTH pay; serving user B from user A's purchase
    // would redistribute one customer's paid-for data to another.
    //
    // MUTATION: delete `.eq('user_id', userId)` from checkSingleDuplicate and
    // this goes red.
    await post();

    const lookup = H.ops.find(isDedupSelect)!;
    expect(lookup.filters).toContainEqual(["eq", "user_id", "user-1"]);
  });
});

describe("POST /api/trace/single — clear cache and re-run ADDS to the receipt", () => {
  it("folds the second purchase into the first rather than replacing it", async () => {
    // David's rule: a re-run that pulls from Tracerfy rather than the database
    // IS charged, and this is the button that forces one. The row is the single
    // receipt for this address (UNIQUE(user_id, address_hash)), so after two
    // real debits it must read as both. Replacing would drop the first from
    // SUM(trace_history.charge) while wallet_transactions still holds it.
    // MUTATION: write `charge` straight into the payload and this goes red.
    H.survivingRow = { id: "trace-billed", charge: 0.4, tier: 2, property_record: null };
    H.insertedRow = { id: "trace-billed", charge: 0.4, tier: 2 };
    H.dossier = DOSSIER_MISS;

    await post({ ...TIER2_BODY, skip_cache: true });

    // Pay-As-You-Go: 0.40 already collected, 0.40 collected again.
    expect(persisted()).toMatchObject({ charge: 0.8, tier: 2 });
    expect(deducts()).toHaveLength(1);
  });

  it("deletes nothing on that path, because the row is the receipt", async () => {
    H.survivingRow = { id: "trace-billed", charge: 0.4, tier: 2, property_record: null };
    H.insertedRow = { id: "trace-billed", charge: 0.4, tier: 2 };
    H.dossier = DOSSIER_MISS;

    await post({ ...TIER2_BODY, skip_cache: true });

    expect(deletes()).toHaveLength(0);
  });

  it("leaves a fresh row's receipt exactly as this submit collected it", async () => {
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(persisted()).toMatchObject({ charge: 0.4, tier: 2 });
  });
});

describe("POST /api/trace/single — usage_records is the SECOND FK into trace_history", () => {
  it("protects a row only usage_records references", async () => {
    // wallet_transactions is the one that fires today, but usage_records
    // carries the same `REFERENCES trace_history(id)` with no ON DELETE clause,
    // so a row it points at raises 23503 exactly the same way. Nothing writes
    // it at present, which is precisely why it would be the branch nobody
    // noticed was missing.
    // MUTATION: drop usage_records from LEDGER_TABLES and this goes red.
    H.survivingRow = {
      id: "trace-usage-only",
      charge: 0,
      ai_research_charge: 0,
      property_record: null,
    };
    H.ledgerRefs = [];
    H.usageRefs = [{ id: "ur-1" }];

    await post();

    expect(deletes()).toHaveLength(0);
  });
});

describe("POST /api/trace/single — one address, submitted twice", () => {
  /**
   * The repeat submit end to end, with the database in between: whatever the
   * first submit persisted is what the second submit's cache lookup finds.
   * Deduplication is not mocked here, so this exercises the real lookup.
   */
  async function submitTwice() {
    H.profile = { ...H.profile, webhook_url: "https://hooks.example.invalid/ptp" };
    H.insertedRow = { id: "trace-1" };
    H.dossier = DOSSIER_MISS;

    const first = await (await post(TIER2_BODY)).json();
    const row = persisted();
    H.cached = row ? { id: "trace-1", ...row } : null;
    H.survivingRow = { id: "trace-1" };
    const second = await (await post(TIER2_BODY)).json();
    return { first, second };
  }

  it("charges once and serves the second from the caller's own row", async () => {
    const { first, second } = await submitTwice();

    expect(first.charge).toBe(0.4);
    expect(deducts()).toHaveLength(1);
    expect(second).toMatchObject({ is_cached: true, charge: 0, trace_id: "trace-1" });
  });

  it("fires trace.completed ONCE for one trace_id", async () => {
    // FIX 2, which falls out of the cache fix: the surviving row is REUSED
    // rather than re-inserted, so traceRecord.id is identical on the second
    // submit. A second event with the same trace_id and a second non-zero
    // charge is silently dropped by a consumer deduplicating on trace_id, and
    // double-counted by one that is not.
    await submitTwice();

    expect(webhooks()).toHaveLength(1);
    expect(webhooks()[0].body).toMatchObject({ trace_id: "trace-1", charge: 0.4 });
  });

  it("calls no vendor on the second submit", async () => {
    const { lookupDossier } = await import("@/lib/tracerfy/dossier");

    await submitTwice();

    expect(lookupDossier).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * THE FENCE. THIS ROUTE MUST NEVER CALL HIGHLEVEL.
 *
 * PTP's own push only ever creates Contacts. Most PTP users reach their CRM
 * through the Suite Gateway, which holds the GoHighLevel snapshot and knows the
 * object model: an entity owner is a Company, a person is a Contact and only
 * when there is a phone or an email, and the property hangs on a property
 * custom object. An automatic push from here writes the WRONG OBJECT TYPE into
 * that snapshot, and for a user with no gateway there is no snapshot for it to
 * populate at all.
 *
 * PTP never calls HighLevel unless a person asked it to. The customer sees this
 * result on screen with a Push to CRM button beside it, and that button is the
 * only thing that starts a push: app/api/integrations/highlevel/push.
 *
 * Set up with EXACTLY the conditions that used to push: a credential on the
 * profile and a tier 2 single settling inline with real contacts on it.
 * ------------------------------------------------------------------ */
describe("tier 2 single never pushes to HighLevel", () => {
  /** A connected profile. Tier 2 needs the wallet balance too. */
  const CONNECTED = {
    id: "user-1",
    subscription_tier: "wallet",
    wallet_balance: 100,
    is_acquisition_pro_member: false,
    gateway_products: null,
    highlevel_api_key: "hl-key",
    highlevel_location_id: "loc-1",
  };

  /** Any trace_history update carrying the push record columns. */
  const pushRecords = () =>
    H.ops
      .filter(
        (o) =>
          o.table === "trace_history" &&
          o.op === "update" &&
          o.payload !== null &&
          typeof o.payload === "object" &&
          "highlevel_pushed_at" in (o.payload as object)
      )
      .map((o) => o.payload as Record<string, unknown>);

  beforeEach(() => {
    H.profile = { ...CONNECTED };
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    vi.mocked(pushTraceToHighLevel).mockClear();
  });

  it("does not call HighLevel on a tier 2 single that resolved contacts", async () => {
    await post(TIER2_BODY);
    await flushDeferred();

    expect(pushTraceToHighLevel).not.toHaveBeenCalled();
  });

  it("writes no push record and no credential verdict, because nothing was pushed", async () => {
    await post(TIER2_BODY);
    await flushDeferred();

    expect(pushRecords()).toEqual([]);
    expect(
      H.ops.filter(
        (o) =>
          o.table === "user_profiles" &&
          o.op === "update" &&
          o.payload !== null &&
          typeof o.payload === "object" &&
          "highlevel_invalid_at" in (o.payload as object)
      )
    ).toEqual([]);
  });

  it("still settles the trace and returns the contacts the customer paid for", async () => {
    // The removal took the push out, not the trace. A green fence on a route
    // that stopped working would be worthless.
    const body = await (await post(TIER2_BODY)).json();
    await flushDeferred();

    expect(body.success).toBe(true);
    expect(persisted()!.is_successful).toBe(true);
    expect(body.result.phones?.[0]?.number).toBe("5550000101");
  });
});

/* ==================================================================== *
 * TIER 1, INLINE (spec D1, D26). The owner was supplied: planRoute and
 * executeRoute run inside the request. Only the vendors are mocked.
 * ==================================================================== */

/** The UPDATE that writes a tier 1 outcome: it carries outcome_code and never property_record. */
function tier1Persisted(): Record<string, unknown> | undefined {
  const rec = H.ops.find(
    (o) =>
      o.op === "update" &&
      o.payload !== null &&
      typeof o.payload === "object" &&
      "outcome_code" in (o.payload as object) &&
      !("property_record" in (o.payload as object))
  );
  return rec?.payload as Record<string, unknown> | undefined;
}

describe("tier 1 inline: what the caller gets", () => {
  it("returns the finished result with found_by, outcome_code and skip_reason, and no step log", async () => {
    H.entity = CONTACTS_HIT;
    const { submitSingleTrace, lookupBusinessTrace, lookupDossier } = await vendorsCalled();

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(lookupBusinessTrace).toHaveBeenCalledWith(
      { company_name: "ACME HOLDINGS LLC", state: "TX" },
      { timeoutMs: expect.any(Number) }
    );
    expect(body).toMatchObject({
      success: true, status: "success", trace_id: "trace-new", tier: 1,
      charge: PRICING.CHARGE_PER_SUCCESS_WALLET, found_by: "company_name",
      outcome_code: "found_by_company_name", skip_reason: null, property_record: null,
    });
    expect(body.result.phones).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/trace_steps|requestKey/);
  });

  it("persists the outcome, the key, the vendor and the step log, and never property_record", async () => {
    H.entity = CONTACTS_HIT;
    await post();
    expect(tier1Persisted()).toMatchObject({
      status: "success", is_successful: true, charge: PRICING.CHARGE_PER_SUCCESS_WALLET, tier: 1,
      contact_vendor: "fastappend", found_by: "company_name", outcome_code: "found_by_company_name",
      tracerfy_job_id: null, ai_research_status: null, property_trace_status: null,
    });
    expect(Array.isArray(tier1Persisted()!.trace_steps)).toBe(true);
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args).toMatchObject({
      p_amount: PRICING.CHARGE_PER_SUCCESS_WALLET, p_trace_history_id: "trace-new",
      p_description: "Skip trace - successful match",
    });
  });

  it("a miss is free and says which key was tried", async () => {
    const body = await (await post()).json();
    expect(deducts()).toHaveLength(0);
    expect(body).toMatchObject({
      status: "no_match", charge: 0, result: null, outcome_code: "no_match",
      skip_reason: "We looked this owner up by company name and found no match. You were not charged.",
    });
  });

  it("a person owner whose returned people do not match is free and says so", async () => {
    // D29: the step log stores a COUNT, never names. `people` rides alongside peopleCount at
    // runtime (H.person is typed unknown, so tsc will not catch a missed edit) so the assertions
    // below can actually fail if a name ever leaked into the log or the response.
    H.person = {
      success: true, hit: true, contacts: null, nameNotMatched: true,
      peopleCount: 1, creditsDeducted: 5,
      people: [{ first_name: "Someoneelse", last_name: "Different" }],
    };
    const body = await (await post({ ...BODY, owner_name: "Testowner Placeholder" })).json();
    expect(deducts()).toHaveLength(0);
    expect(body.outcome_code).toBe("owner_name_not_matched");
    expect(body.skip_reason).toBe(
      "We found people linked to this property, but none matched the owner name, so no contacts were returned. You were not charged."
    );
    // D29: never a name reaches the persisted step log or the response, only the count.
    expect(JSON.stringify(tier1Persisted())).not.toMatch(/Someoneelse|Different/);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/trace_steps/);
    expect(bodyStr).not.toMatch(/peopleCount/);
  });

  it("a vendor failure is busy_try_again: 503, Retry-After, free, no webhook", async () => {
    // MUTATION: return 200 on the busy branch and this goes red.
    H.profile = WEBHOOK_PROFILE;
    H.entity = { success: false, hit: false, contacts: null, error: "FastAppend service unavailable" };
    const res = await post();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(body).toMatchObject({
      success: false, status: "error", trace_id: "trace-new", tier: 1, charge: 0, result: null,
      found_by: null, outcome_code: "busy_try_again",
      skip_reason: "The system is busy. Try again in 5 minutes. You were not charged.",
      error: "The system is busy. Try again in 5 minutes. You were not charged.",
    });
    expect(deducts()).toHaveLength(0);
    expect(webhooks()).toHaveLength(0);
    expect(tier1Persisted()).toMatchObject({ status: "error", outcome_code: "busy_try_again" });
  });

  it("passes the request budget to every vendor call", async () => {
    // MUTATION: pass `deadlineMs: startedAt + 10 * 60 * 1000` and this goes red.
    const { lookupBusinessTrace } = await vendorsCalled();
    await post();
    const calls = vi.mocked(lookupBusinessTrace).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const opts = call[1] as { timeoutMs: number };
      expect(opts.timeoutMs).toBeGreaterThan(0);
      expect(opts.timeoutMs).toBeLessThanOrEqual(VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS);
    }
  });

  it("passes the request budget to every vendor call on a two-step ladder", async () => {
    // A trust owner with a first name: the Instant lookup misses (the H.person default), so
    // FastAppend runs next. Both calls must carry the request budget, not just the first.
    const { lookupPersonTrace, lookupBusinessTrace } = await vendorsCalled();
    await post({ ...BODY, owner_name: "Marcus Halloway Revocable Trust" });
    expect(lookupPersonTrace).toHaveBeenCalledTimes(1);
    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
    for (const mocked of [lookupPersonTrace, lookupBusinessTrace]) {
      for (const call of vi.mocked(mocked).mock.calls) {
        const opts = call[1] as { timeoutMs: number };
        expect(opts.timeoutMs).toBeGreaterThan(0);
        expect(opts.timeoutMs).toBeLessThanOrEqual(VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS);
      }
    }
  });

  it("400s an owner name with no letters, before touching the database", async () => {
    const res = await post({ ...BODY, owner_name: "???" });
    expect(res.status).toBe(400);
    expect(H.ops.filter((o) => o.table === "trace_history")).toHaveLength(0);
  });
});

describe("tier 1 inline: money on this call site (L-018)", () => {
  it("records, and does not take again, a debit an earlier attempt booked", async () => {
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", charge: 0, tier: null };
    H.insertedRow = { id: "trace-new", charge: 0, tier: null };
    H.ledgerRefs = [{ amount: 0.25, type: "debit", created_at: new Date(Date.now() - 60 * 1000).toISOString() }];
    const body = await (await post()).json();
    expect(deducts()).toHaveLength(0);
    expect(body.charge).toBe(0.25);
    expect(tier1Persisted()).toMatchObject({ charge: 0.25, tier: 1 });
  });

  it("folds a new charge onto the reused row's receipt", async () => {
    // MUTATION: pass `row: { id: traceRecord.id }` to runSingleTier1 and this goes red.
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", charge: 0.25, tier: 2, property_record: null };
    H.insertedRow = { id: "trace-new", charge: 0.25, tier: 2, property_record: null };
    H.ledgerRefs = [{ amount: 0.25, type: "debit", created_at: "2026-08-01T00:00:00.000Z" }];
    const body = await (await post()).json();
    expect(deducts()).toHaveLength(1);
    expect(tier1Persisted()).toMatchObject({ charge: 0.5, tier: 2 });
    // The receipt reads 0.50 (both purchases), but this REQUEST only collected its own 0.25.
    expect(body.charge).toBe(0.25);
  });
});

describe("tier 1 inline: warnings are wallet-only, the routing notes stay internal (fix round 1)", () => {
  it("does not leak a routing warning into body.warnings", async () => {
    // MUTATION: return tier1.execution.warnings instead of the wallet-only array and this goes
    // red: planRoute always warns on an entity step with no registrationState ("Sending the
    // property state..."), and BODY's owner (ACME HOLDINGS LLC) takes that step.
    H.entity = CONTACTS_HIT;
    const body = await (await post()).json();
    expect(body.warnings).toEqual([]);
  });
});

describe("tier 1 inline: auto-rebill fires only when money moved or should have (fix round 1)", () => {
  it("does not trigger on a free outcome", async () => {
    // MUTATION: call triggerAutoRebillIfNeeded unconditionally and this goes red.
    const { triggerAutoRebillIfNeeded } = await import("@/lib/utils/auto-rebill");
    await post(); // default entity/business miss: no_match, deduction 'not_attempted'
    expect(triggerAutoRebillIfNeeded).not.toHaveBeenCalled();
  });

  it("triggers on a charged outcome", async () => {
    const { triggerAutoRebillIfNeeded } = await import("@/lib/utils/auto-rebill");
    H.entity = CONTACTS_HIT;
    await post();
    expect(triggerAutoRebillIfNeeded).toHaveBeenCalledWith("user-1");
  });
});

describe("tier 1 inline: Track A price, grant-aware (fix round 1)", () => {
  it("charges a pro profile the pro rate, not the wallet rate", async () => {
    // MUTATION: swap chargePerTrace(profile) for a Track B derivation, or hard-code 0.25, and
    // this goes red.
    H.profile = { ...H.profile, subscription_tier: "pro" };
    H.entity = CONTACTS_HIT;
    await post();
    expect(deducts()[0].args).toMatchObject({ p_amount: PRICING.CHARGE_PER_SUCCESS });
  });
});

describe("tier 1 inline: the busy_try_again resend (spec 5.2)", () => {
  const TRUST_BODY = { ...BODY, owner_name: "Marcus Halloway Revocable Trust" };
  const instantKey = () =>
    requestKeyFor(planRoute({ ...parcelForFullTrace(TRUST_BODY), ownerName: TRUST_BODY.owner_name }, "wallet").steps[0]);
  const busyRow = () => ({
    id: "trace-new", charge: 0, tier: 1, is_successful: false, property_record: null,
    outcome_code: "busy_try_again",
    trace_steps: [{
      kind: "TRACERFY_INSTANT_NAMED", outcome: "miss", cost: 0,
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), requestKey: instantKey(),
    }],
  });

  it("keeps the busy row: no sweep deletes it", async () => {
    // MUTATION: drop `|| busyResend` from runDelete and the failed sweep deletes it.
    H.survivingRow = busyRow();
    H.insertedRow = busyRow();
    await post(TRUST_BODY);
    expect(deletes()).toHaveLength(0);
  });

  it("does not buy the answered step again", async () => {
    H.survivingRow = busyRow();
    H.insertedRow = busyRow();
    const { lookupPersonTrace, lookupBusinessTrace } = await vendorsCalled();
    await post(TRUST_BODY);
    expect(lookupPersonTrace).not.toHaveBeenCalled();
    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
  });
});

describe("tier 1 inline: a row with live work is never touched (fix round 1)", () => {
  it("answers busy without touching a row whose Tier 2 rung is still queued (cron crash window)", async () => {
    // Path A: the Tier 2 cron's crash window (sweep-property-traces: deduct, throw, requeue)
    // leaves the row on a queued rung. Under the old code it was merely ledgerProtected, which
    // only spared the SWEEPS -- the reuse branch still took it.
    // MUTATION: drop the isPropertyTracePending() clause and this goes red.
    H.survivingRow = { id: "trace-live-a", property_trace_status: "queued_2", charge: 0, tier: 2 };
    const { lookupDossier, lookupBusinessTrace, lookupPersonTrace } = await vendorsCalled();

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(body).toMatchObject({
      success: false, outcome_code: "busy_try_again", charge: 0, trace_id: "trace-live-a",
    });
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(lookupPersonTrace).not.toHaveBeenCalled();
    expect(H.ops.filter((o) => o.op === "update")).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
    expect(deducts()).toHaveLength(0);
  });

  it("answers busy for a busy row bulk re-enqueued, even though outcome_code alone would exempt it", async () => {
    // Path B: a bulk upload re-enqueues a busy single row (ai_research_status back to a queued
    // rung) without clearing outcome_code, so the busy exemption alone would spare this live row.
    // MUTATION: drop the isEntityTracePending() clause and this goes red.
    H.survivingRow = {
      id: "trace-live-b", outcome_code: "busy_try_again", ai_research_status: "queued",
      charge: 0, tier: 1,
    };
    const { lookupBusinessTrace } = await vendorsCalled();

    const res = await post();

    expect(res.status).toBe(503);
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(H.ops.filter((o) => o.op === "update")).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
    expect(deducts()).toHaveLength(0);
  });

  it("answers busy for a fresh processing row from a concurrent request", async () => {
    // MUTATION: drop the processingIsLive clause and this goes red.
    H.survivingRow = {
      id: "trace-live-c", status: "processing", created_at: new Date().toISOString(),
      charge: 0, tier: null,
    };
    const { lookupBusinessTrace } = await vendorsCalled();

    const res = await post();

    expect(res.status).toBe(503);
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(H.ops.filter((o) => o.op === "update")).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
    expect(deducts()).toHaveLength(0);
  });

  it("still reuses an ordinary processing row abandoned longer ago than the cron's own threshold", async () => {
    // Not live work: this proves the gate is not a blanket refusal of every 'processing' row.
    H.entity = CONTACTS_HIT;
    H.survivingRow = {
      id: "trace-old", status: "processing",
      created_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      charge: 0, tier: null,
    };
    H.insertedRow = { id: "trace-old", charge: 0, tier: null };
    const res = await post();
    expect(res.status).toBe(200);
  });
});

describe("tier 1 inline: a reused row's owner and its result change together (fix round 1, D25 money)", () => {
  it("the reuse UPDATE never carries the new owner ahead of the new result", async () => {
    // MUTATION: put input_owner_name back in the reuse UPDATE and this goes red.
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", input_owner_name: "JANE DOE", charge: 0, tier: null };
    H.insertedRow = { id: "trace-new", charge: 0, tier: null };
    await post(); // BODY's owner is ACME HOLDINGS LLC
    const reuse = H.ops.find(
      (o) =>
        o.op === "update" &&
        o.filters.some((f) => f[0] === "eq" && f[1] === "id") &&
        !("outcome_code" in (o.payload as object))
    );
    expect(reuse).toBeDefined();
    expect(reuse!.payload).not.toHaveProperty("input_owner_name");
  });

  it("the write carrying trace_result carries the new owner", async () => {
    // MUTATION: drop input_owner_name from the settle persist (runSingleTier1) and this goes red.
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", input_owner_name: "JANE DOE", charge: 0, tier: null };
    H.insertedRow = { id: "trace-new", charge: 0, tier: null };
    await post();
    expect(tier1Persisted()).toMatchObject({ input_owner_name: "ACME HOLDINGS LLC" });
  });
});

describe("tier 1 inline: the 90-day cache serves only the SAME owner (D25)", () => {
  const CACHED_CONTACTS = { phones: [{ number: "5550000101", type: "mobile" }], emails: [] };

  it("runs a new trace when the cached contacts belong to a different owner", async () => {
    // MUTATION: serve the cached row whatever its owner and this goes red.
    H.cached = { id: "trace-cached", input_owner_name: "JANE DOE", trace_result: CACHED_CONTACTS, is_successful: true, charge: 0.25, tier: 1 };
    const { lookupBusinessTrace } = await vendorsCalled();
    const body = await (await post()).json();
    expect(body.is_cached).toBeUndefined();
    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
  });

  it("serves the same owner written differently, free, with its found_by", async () => {
    H.cached = {
      id: "trace-cached", input_owner_name: "Acme Holdings, L.L.C.", trace_result: CACHED_CONTACTS,
      is_successful: true, found_by: "company_name", outcome_code: "found_by_company_name",
    };
    const body = await (await post()).json();
    expect(body).toMatchObject({ is_cached: true, charge: 0, trace_id: "trace-cached", found_by: "company_name" });
  });
});

describe("tier 2 single: the shared-code changes reach this route (L-018)", () => {
  it("writes contact_vendor and clears any stale tier 1 outcome", async () => {
    // MUTATION: delete the contact_vendor line from the tier 2 persist and this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    await post(TIER2_BODY);
    expect(persisted()).toMatchObject({ contact_vendor: "fastappend", outcome_code: null, found_by: null });
  });

  it("never falls back to the dossier's own contacts: a Full Property Trace whose owner lookups all miss is a true null (D32)", async () => {
    // Task 6b withdrew the dossier-contacts fallback entirely (spec D32): there is no toggle left
    // at this route to mutate, so this asserts the shape rather than a deletable guard.
    H.dossier = {
      ...DOSSIER_INDIVIDUAL_HIT,
      contacts: { ownerName: "Not The Real Contact", phones: [{ number: "5550000901", type: "mobile" }], emails: ["fallback@example.invalid"], mailingAddress: null },
    };
    const body = await (await post(TIER2_BODY)).json();
    expect(body.result).toMatchObject({ phones: [], emails: [] });
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("5550000901");
    expect(bodyStr).not.toContain("fallback@example.invalid");
    expect(bodyStr).not.toMatch(/name_verified/);
  });
});

describe("tier 2 single: input_owner_name rides the same write as trace_result (fix round 1, D25 money)", () => {
  it("writes null when no owner was supplied", async () => {
    // MUTATION: drop input_owner_name from the tier 2 settle persist and this goes red.
    H.dossier = DOSSIER_MISS;
    await post(TIER2_BODY);
    expect(persisted()).toMatchObject({ input_owner_name: null });
  });

  it("writes the supplied owner on the Full Property Trace opt-in", async () => {
    H.dossier = DOSSIER_MISS;
    await post({ ...BODY, full_property_trace: true });
    expect(persisted()).toMatchObject({ input_owner_name: "ACME HOLDINGS LLC" });
  });
});

describe("tier 2 single: the request budget reaches every vendor call (fix round 1)", () => {
  it("passes VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS to every tier 2 vendor call", async () => {
    // MUTATION: pass `deadlineMs: startedAt + 10 * 60 * 1000` to the tier 2 executeRoute call and
    // this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    const { lookupDossier, lookupBusinessTrace } = await vendorsCalled();
    await post(TIER2_BODY);
    let calls = 0;
    for (const mocked of [lookupDossier, lookupBusinessTrace]) {
      for (const call of vi.mocked(mocked).mock.calls) {
        calls += 1;
        const opts = call[1] as { timeoutMs: number };
        expect(opts.timeoutMs).toBeGreaterThan(0);
        expect(opts.timeoutMs).toBeLessThanOrEqual(VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS);
      }
    }
    expect(calls).toBeGreaterThan(0);
  });
});
