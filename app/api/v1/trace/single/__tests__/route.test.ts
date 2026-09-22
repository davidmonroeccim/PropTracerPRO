import { beforeEach, describe, expect, it, vi } from "vitest";
import { VENDOR_TIMEOUT } from "@/lib/constants";
import { requestKeyFor } from "@/lib/routing/executeRoute";
import { planRoute } from "@/lib/routing/ownerRoute";
import { parcelForFullTrace } from "@/lib/trace/fullPropertyTrace";
import { createAddressHash } from "@/lib/utils/address-normalizer";

/**
 * Delete/insert fence for the PUBLIC v1 single-trace SUBMIT route.
 *
 * Same hazard as the session route: every trace_history row it deletes may be a
 * billing receipt referenced by `wallet_transactions.trace_history_id` (no
 * ON DELETE clause => 23503), and the row it then inserts collides on
 * UNIQUE(user_id, address_hash). Written as characterization tests FIRST
 * (2026-09-17, phase 2); the route had zero coverage.
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
  profile: null as unknown as Record<string, unknown>,
  cached: null as Record<string, unknown> | null,
  insertedRow: { id: "trace-new" } as Record<string, unknown> | null,
  insertError: null as { message: string; code?: string } | null,
  deleteError: null as { message: string; code?: string } | null,
  survivingRow: null as Record<string, unknown> | null,
  /** Rows wallet_transactions / usage_records hold against the trace id. */
  ledgerRefs: [] as Array<Record<string, unknown>>,
  ledgerRefsError: null as { message: string } | null,
  /** Every select the BLIND anon client was asked for, table by table. */
  anonSelects: [] as string[],
  submit: { success: true, jobId: "tj-1" } as {
    success: boolean;
    jobId?: string;
    error?: string;
  },
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  /** What deduct_wallet_balance resolves with. `false` = the wallet was short. */
  deductData: true as unknown,
  /** Transport / Postgres failure of the RPC itself. NOT a short wallet. */
  deductError: null as { message: string } | null,
  /** What lookupDossier resolves with. Set per test. */
  dossier: null as unknown,
  /** What the FastAppend entity lookup resolves with. */
  entity: null as unknown,
  /** What the Tracerfy person lookup resolves with. */
  person: null as unknown,
  /** Every outbound webhook POST: [url, init]. */
  webhookPosts: [] as Array<{ url: string; body: Record<string, unknown> }>,
  /** What the mocked HighLevel client answers. A push success by default. */
  pushResult: { success: true, contactId: "hl-1", action: "created" } as Record<
    string,
    unknown
  >,
  /** Callbacks handed to `after()`, run explicitly by flushDeferred(). */
  scheduled: [] as Array<() => unknown>,
}));

/** True when this select is the dedup lookup: only it carries the cache filter. */
function isDedupSelect(rec: Recorded): boolean {
  return rec.op === "select" && rec.filters.some((f) => f[0] === "or");
}

function envelopeFor(rec: Recorded): { data: unknown; error: unknown } {
  if (rec.op === "delete") return { data: null, error: H.deleteError };
  if (rec.op === "insert") {
    return H.insertError
      ? { data: null, error: H.insertError }
      : { data: H.insertedRow, error: null };
  }
  if (rec.op === "update") return { data: H.insertedRow, error: null };
  // The two tables holding FK receipts that point INTO trace_history.
  if (rec.table === "wallet_transactions" || rec.table === "usage_records") {
    return { data: H.ledgerRefs, error: H.ledgerRefsError };
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
    rpc: async (fn: string, args: unknown) => {
      H.rpcCalls.push({ fn, args });
      return { data: H.deductData, error: H.deductError };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => recordingClient(),
}));

/**
 * The COOKIE-BACKED ANON client, wired the way it really behaves here: an
 * API-key request carries no Supabase session cookie, so `auth.uid()` is NULL,
 * the RLS predicate on `trace_history` matches nothing, and every select comes
 * back empty. Any lookup that reaches for this client is blind.
 */
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: () => {
        H.anonSelects.push(table);
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
    }),
  }),
}));

vi.mock("@/lib/api/auth", () => ({
  validateApiKey: async () => ({ profile: H.profile }),
  isAuthError: (r: unknown) => Boolean((r as { response?: unknown })?.response),
}));

// DEDUPLICATION IS NOT MOCKED, and that is the point.
//
// It was, until 2026-09-17, and that made every cache assertion in this file a
// statement about the mock: `checkSingleDuplicate` was hardwired to hand back
// H.cached, so the tests agreed the cache worked while the real lookup could
// not see a single row on this surface. That is lessons.md L-009's exact shape,
// a test for a distinction that cannot occur in the environment it runs in.
//
// The real lookup now runs against the two clients above, so these tests fail
// for the real reason: point it back at the anon client and the cache misses.

vi.mock("@/lib/tracerfy/client", () => ({
  submitSingleTrace: vi.fn(async () => H.submit),
  // The two SYNCHRONOUS contact endpoints tier 2 uses. Only the vendors are
  // mocked: the real planRoute and the real executeRoute run, so these tests
  // cover the routing and the spend accounting, not just the route's branches.
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
 * would schedule work these tests never wait on.
 */
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    H.scheduled.push(fn);
  },
}));

// No AI Search mock: the engine was deleted on 2026-09-17 and this route no
// longer calls anything to discover an owner.

const { POST } = await import("@/app/api/v1/trace/single/route");
const { pushTraceToHighLevel } = await import("@/lib/highlevel/client");

/** Drain everything `after()` was handed, in order. */
async function flushDeferred(): Promise<void> {
  while (H.scheduled.length > 0) await H.scheduled.shift()!();
}

/**
 * The TIER 1 body. It carries an owner of record on purpose: since phase 4 an
 * ABSENT ownerName is itself the tier 2 trigger on this surface too, so a body
 * without one no longer describes the async per-successful-trace path.
 */
const BODY = {
  address: "123 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
  ownerName: "ACME HOLDINGS LLC",
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
    new Request("http://localhost/api/v1/trace/single", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
}

function deletes(): Recorded[] {
  return H.ops.filter((o) => o.table === "trace_history" && o.op === "delete");
}

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
  H.cached = null;
  H.insertedRow = { id: "trace-new" };
  H.insertError = null;
  H.deleteError = null;
  H.survivingRow = null;
  H.ledgerRefs = [];
  H.ledgerRefsError = null;
  H.anonSelects = [];
  H.submit = { success: true, jobId: "tj-1" };
  H.rpcCalls = [];
  H.deductData = true;
  H.deductError = null;
  H.dossier = { success: true, hit: false, owners: [], property: null, mailingAddress: null, creditsDeducted: 0 };
  H.entity = { success: true, hit: false, contacts: null };
  H.person = { success: true, hit: false, contacts: null };
  H.webhookPosts = [];
  H.pushResult = { success: true, contactId: "hl-1", action: "created" };
  H.scheduled = [];
  H.profile = {
    id: "user-1",
    subscription_tier: "pro",
    wallet_balance: 100,
    is_acquisition_pro_member: false,
  };
  // The webhook is a raw fetch to the customer's own URL. Capture it rather than
  // letting a test reach the network.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown, init: unknown) => {
    H.webhookPosts.push({
      url: String(url),
      body: JSON.parse(String((init as { body?: unknown })?.body ?? "{}")),
    });
    return new Response("{}", { status: 200 });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/v1/trace/single — gates", () => {
  it("400s a person with a city but no street and no parcel id, as no_lookup_key, before touching the database", async () => {
    // MUTATION: delete the keyPlan check and the record reaches the database.
    const res = await post({ ...BODY, ownerName: "Marcus Halloway", address: "" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ success: false, outcomeCode: "no_lookup_key" });
    expect(body.skipReason).toBe(
      "This record is missing a street address and the parcel ID, so it could not be looked up. You were not charged. Send it again with the street address or the parcel ID."
    );
    // The error is the same sentence, never a routing note or a line that does not state the
    // charge (fix round 1: the fallback chain is gone).
    expect(body.error).toBe(body.skipReason);
    expect(H.ops).toHaveLength(0);
  });

  it("400s an invalid state as no_lookup_key", async () => {
    // MUTATION (fix round 1): answer the state branch with status 200 and this goes red.
    const res = await post({ ...BODY, state: "Texas" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.outcomeCode).toBe("no_lookup_key");
    expect(body.skipReason).toContain("a valid state");
    expect(H.ops).toHaveLength(0);
  });

  it("still validates a street and city that were both sent", async () => {
    const res = await post({ ...BODY, address: "1" });
    expect(res.status).toBe(400);
    expect(H.ops).toHaveLength(0);
  });

  it("400s a malformed zip on a record sent without a street and city, before touching the database", async () => {
    // MUTATION (fix round 1): delete the zip-only branch and this goes red (the record runs).
    const res = await post({ state: "OH", apn: "0123-456", county: "Placeholder", ownerName: "Testowner Placeholder", zip: "2134" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toEqual({ success: false, error: "ZIP code must be 5 or 9 digits when supplied" });
    expect(H.ops).toHaveLength(0);
  });

  it("400s an owner name with no letters, before touching the database", async () => {
    // MUTATION (fix round 1): delete the letter check and this goes red.
    const res = await post({ ...BODY, ownerName: "???" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toEqual({ success: false, error: "ownerName must contain at least one letter" });
    expect(H.ops).toHaveLength(0);
  });

  it("400s a parcel id that is not text, before touching the database", async () => {
    // Silently treating it as absent answered "missing the city and the parcel ID", which sends
    // the caller looking for a field they did send.
    // MUTATION: delete the apn type check and this goes red.
    const res = await post({ ...BODY, apn: 12 });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toEqual({ success: false, error: "apn must be a string when supplied" });
    expect(H.ops).toHaveLength(0);
  });

  it("400s a parcelId that is not text, before touching the database", async () => {
    const body = await (await post({ ...BODY, parcelId: 12 })).json();
    expect(body).toEqual({ success: false, error: "parcelId must be a string when supplied" });
    expect(H.ops).toHaveLength(0);
  });

  it("400s a county that is not text, before touching the database", async () => {
    // MUTATION (fix round 1): delete the county type check and this goes red (it was a bare 500).
    const res = await post({ state: "OH", apn: "0123-456", county: 12, ownerName: "Testowner Placeholder" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toEqual({ success: false, error: "county must be a string when supplied" });
    expect(H.ops).toHaveLength(0);
  });

  it("402s when the wallet cannot cover one tier 1 trace", async () => {
    H.profile = { ...H.profile, wallet_balance: 0 };
    const res = await post();
    expect(res.status).toBe(402);
    expect(deletes()).toHaveLength(0);
  });
});

describe("POST /api/v1/trace/single — cache hit", () => {
  it("returns cached contacts free of charge and deletes nothing", async () => {
    H.cached = {
      id: "trace-cached",
      input_owner_name: "ACME HOLDINGS LLC",
      trace_result: { phones: ["512-555-0100"], emails: [] },
    };

    const body = await (await post()).json();

    expect(body).toMatchObject({ success: true, cached: true, charge: 0 });
    expect(deletes()).toHaveLength(0);
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

describe("POST /api/v1/trace/single — the deletes", () => {
  it("does not delete the cached contactless row when it is billed", async () => {
    H.cached = {
      id: "trace-billed",
      trace_result: { phones: [], emails: [] },
      charge: 0.25,
    };
    H.survivingRow = { id: "trace-billed" };

    await post();

    expect(deletes().some((d) => hasFilter(d, "eq", "id", "trace-billed"))).toBe(false);
  });

  it("still deletes an unbilled contactless row", async () => {
    H.cached = {
      id: "trace-free",
      trace_result: { phones: [], emails: [] },
      charge: 0,
      property_record: null,
    };

    await post();

    expect(deletes().some((d) => hasFilter(d, "eq", "id", "trace-free"))).toBe(true);
  });

  it("never targets a billed row when clearing failed traces", async () => {
    await post();

    const failedSweep = deletes().find((d) => hasFilter(d, "eq", "is_successful", false));
    expect(failedSweep).toBeDefined();
    expectBilledGuard(failedSweep!);
  });

  it("never targets a billed row when the owner name changes", async () => {
    await post({ ...BODY, ownerName: "JANE DOE" });

    const ownerSweep = deletes().find((d) => hasFilter(d, "neq", "input_owner_name", "JANE DOE"));
    expect(ownerSweep).toBeDefined();
    expectBilledGuard(ownerSweep!);
  });

  it("fails with the real reason instead of walking into a unique violation", async () => {
    H.deleteError = { message: "violates foreign key constraint", code: "23503" };

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(String(body.error)).toContain("foreign key");
    expect(H.ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("updates the surviving billed row rather than inserting a duplicate", async () => {
    H.survivingRow = { id: "trace-billed" };
    H.insertedRow = { id: "trace-billed" };

    const body = await (await post()).json();

    expect(H.ops.some((o) => o.op === "insert")).toBe(false);
    const reuse = H.ops.find(
      (o) => o.op === "update" && o.filters.some((f) => f[0] === "eq" && f[1] === "id")
    );
    expect(reuse).toBeDefined();
    const keys = Object.keys(reuse!.payload as object);
    for (const paid of ["charge", "ai_research_charge", "property_record", "tier"]) {
      expect(keys).not.toContain(paid);
    }
    expect(body.traceId).toBe("trace-billed");
  });
});

describe("POST /api/v1/trace/single: row creation, then the inline tier 1 settle", () => {
  it("inserts a processing row and settles it in the same request", async () => {
    const res = await post();
    const body = await res.json();
    const insert = H.ops.find((o) => o.op === "insert");
    // MUTATION: delete input_owner_name from the insert and this goes red. A NEW row still names
    // its owner from the start; only the reuse UPDATE leaves it to the settle (D25 money).
    expect(insert!.payload).toMatchObject({
      user_id: "user-1", city: "AUSTIN", state: "TX", status: "processing",
      input_owner_name: "ACME HOLDINGS LLC",
    });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: "no_match", traceId: "trace-new", tier: 1, charge: 0 });
  });

  it("500s when the row cannot be created", async () => {
    H.insertError = { message: "duplicate key value violates unique constraint", code: "23505" };
    const res = await post();
    expect(res.status).toBe(500);
  });
});

describe("POST /api/v1/trace/single — the removed AI Search opt-in", () => {
  // Until 2026-09-17 this route accepted `aiResearch: true` and, when no ownerName
  // came with it, ran the Brave plus Claude engine to discover one. Finding an owner
  // booked a SECOND wallet deduction of $0.15 on top of the trace charge, and the
  // pre-flight gate reserved that fee as well. Both are gone with the engine.

  it("charges nothing extra when a caller still sends aiResearch", async () => {
    // MUTATION: restore the research deduct and this goes red -- there would be a
    // deduct_wallet_balance call before the Tracerfy submit.
    await post({ ...BODY, aiResearch: true });
    expect(H.rpcCalls.filter((c) => c.fn === "deduct_wallet_balance")).toHaveLength(0);
  });

  it("writes no ai_research to the row from the request", async () => {
    // A request body must never be able to put words into trace_history.ai_research. The tier 1
    // settle DOES write ai_research_status, and only ever as null: it clears a stale bulk queue
    // value on a reused row (Tier 1 Phase 1). That null write is load-bearing.
    // MUTATION: write `ai_research_status: 'queued'` in runSingleTier1 and this goes red.
    await post({ ...BODY, aiResearch: true, ai_research: { owner_name: "ACME LLC" } });
    const payloads = H.ops
      .filter((o) => o.table === "trace_history" && (o.op === "insert" || o.op === "update"))
      .map((o) => (o.payload as Record<string, unknown>) || {});
    const written = payloads.map((p) => Object.keys(p)).flat();
    expect(written).not.toContain("ai_research");
    expect(written).not.toContain("ai_research_charge");
    for (const p of payloads) {
      if ("ai_research_status" in p) expect(p.ai_research_status).toBeNull();
    }
  });

  it("reserves only the tier 1 rate, so a wallet holding exactly that is let through", async () => {
    // The old gate was tier1 + 0.15 for this shape, which 402'd a wallet that could
    // genuinely afford the trace.
    // MUTATION: add the research fee back into minBalance and this goes red.
    H.profile = { ...H.profile, wallet_balance: 0.15 };
    const res = await post({ ...BODY, aiResearch: true });
    expect(res.status).not.toBe(402);
  });

  it("never fabricates an owner to fill the gap", async () => {
    // CLAUDE.md rule 7. Before phase 4 this route submitted to Tracerfy with
    // owner_name undefined; now an absent owner routes to tier 2, which BUYS the
    // owner from the county dossier instead of guessing one. Either way nothing
    // invents a name.
    const { lookupDossier } = await import("@/lib/tracerfy/dossier");
    await post({ ...TIER2_BODY, aiResearch: true });
    expect(lookupDossier).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "address", address: "123 Main St" }),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    const keyed = (lookupDossier as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(JSON.stringify(keyed)).not.toContain("owner");
  });
});

/* ==================================================================== *
 * WHAT CHANGED IN PHASE 4, and what it was before.
 *
 * The six tests in this block were written FIRST, against the route as it
 * stood on 2026-09-17, and passed. Wiring tier 2 in turned four of them
 * red, which is the whole reason they were written first: a test authored
 * afterwards, from the same assumption as the change, proves nothing
 * (lessons.md L-008's corollary). Each one below now asserts the NEW
 * behaviour and records the old one, so the diff of intent is readable.
 * ==================================================================== */
describe("POST /api/v1/trace/single — what phase 4 changed", () => {
  it("sends a body with NO ownerName to TIER 2, not the tier 1 async path", async () => {
    // WAS: submitted to Tracerfy and returned a traceId to poll. An absent owner
    // of record is the tier 2 trigger on the session route, and David decided on
    // 2026-09-17 that v1 matches it, so the two surfaces price the same request
    // the same way.
    const { submitSingleTrace } = await import("@/lib/tracerfy/client");
    const { lookupDossier } = await import("@/lib/tracerfy/dossier");

    const body = await (await post(TIER2_BODY)).json();

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(body.tier).toBe(2);
  });

  it("runs a body WITH an ownerName inline at the Track B tier 1 rate", async () => {
    // WAS: submitted to the Tracerfy batch and returned a traceId to poll. Removed (spec D26).
    H.entity = CONTACTS_HIT;
    const { submitSingleTrace } = await import("@/lib/tracerfy/client");
    const { lookupDossier } = await import("@/lib/tracerfy/dossier");
    const body = await (await post(BODY)).json();
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      success: true, status: "success", traceId: "trace-new", tier: 1, charge: 0.15,
      foundBy: "company_name", outcomeCode: "found_by_company_name", skipReason: null,
    });
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args).toMatchObject({ p_amount: 0.15 });
  });

  it("reserves the TIER 2 rate when there is no ownerName", async () => {
    // WAS: the raw tier 1 rate (0.15) for every shape of request, which
    // under-reserved a tier 2 request by $0.10 and let a wallet that cannot pay
    // reach the vendors.
    // MUTATION: reserve getChargePerTrace here and this goes red.
    H.profile = { ...H.profile, wallet_balance: 0.15 };
    const { lookupDossier } = await import("@/lib/tracerfy/dossier");

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(402);
    expect(lookupDossier).not.toHaveBeenCalled();
  });

  it("still reserves only the tier 1 rate when there IS an ownerName", async () => {
    H.profile = { ...H.profile, wallet_balance: 0.15 };
    const res = await post(BODY);
    expect(res.status).not.toBe(402);
  });

  it("SERVES a billed tier 2 row that holds no contacts, free", async () => {
    // WAS: it fell through and re-submitted. The row is a paid-for tier 2 MISS
    // (charge > 0, tier 2, no property record, no contacts), and the route had
    // no branch that served it, so the customer paid twice for one absence.
    //
    // THE COMMENT HERE USED TO SAY "checkSingleDuplicate already hands it back
    // via CACHE_HIT_FILTER's third arm", and while the filter was right the
    // lookup was blind: it ran on the anon client, this file mocked it, and the
    // test agreed with the mock. It now runs for real against the two clients
    // at the top, so it can fail for that reason.
    // MUTATION: delete the isCacheHitRow branch and this goes red. So does
    // pointing checkSingleDuplicate back at @/lib/supabase/server.
    H.cached = {
      id: "trace-billed-miss",
      trace_result: null,
      charge: 0.25,
      tier: 2,
      property_record: null,
      is_successful: false,
      status: "no_match",
    };
    H.survivingRow = { id: "trace-billed-miss" };
    H.insertedRow = { id: "trace-billed-miss" };
    const { submitSingleTrace } = await import("@/lib/tracerfy/client");
    const { lookupDossier } = await import("@/lib/tracerfy/dossier");

    const body = await (await post(TIER2_BODY)).json();

    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
    expect(body).toMatchObject({ cached: true, charge: 0, traceId: "trace-billed-miss" });
  });

  it("no longer 500s on a submission that carries no zip at all", async () => {
    // WAS: zip is OPTIONAL at validation (it is not part of address_hash) but the
    // route did `zip.substring(0, 5)` unguarded, so an absent one threw a
    // TypeError and surfaced as a bare 500 before any vendor was called -- and an
    // absent zip is precisely the case tier 2 backfills.
    const { address, city, state } = BODY;

    const res = await post({ address, city, state, ownerName: "ACME HOLDINGS LLC" });
    const insert = H.ops.find((o) => o.op === "insert");

    expect(res.status).toBe(200);
    expect((insert!.payload as Record<string, unknown>).zip).toBeNull();
  });

  it("stores an EMPTY zip as null rather than an empty string", async () => {
    await post({ ...BODY, zip: "" });
    const insert = H.ops.find((o) => o.op === "insert");
    expect((insert!.payload as Record<string, unknown>).zip).toBeNull();
  });

  it("stores the caller's zip truncated to five digits when one IS supplied", async () => {
    // Unchanged by the guard. Pinned so it cannot quietly alter the happy path.
    await post({ ...BODY, zip: "78701-1234" });
    const insert = H.ops.find((o) => o.op === "insert");
    expect((insert!.payload as Record<string, unknown>).zip).toBe("78701");
  });
});

/* ==================================================================== *
 * TIER 2 — FULL PROPERTY TRACE on the PUBLIC API-KEY surface (Track B).
 *
 * A NEW BILLING PATH on a public API. Tier 2 bills per RECORD SUBMITTED,
 * which makes two things true that are false everywhere else:
 *   - a row can carry `charge > 0` with `is_successful = false`
 *   - a customer can receive NOTHING and still be charged
 *
 * The one distinction every test below protects: `success` is the billing
 * gate, never `ownerFound`. A billed MISS and an unbillable vendor FAILURE
 * both come back with ownerFound: false (lessons.md L-007).
 *
 * Only the vendors are mocked. The real planRoute and the real executeRoute
 * run, so these also cover which vendor a discovered owner is routed to and
 * what the route does with the spend report it gets back.
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

/**
 * PAY-AS-YOU-GO on Track B: no local pro tier, no AcquisitionPRO flag.
 *
 * validateApiKey() currently refuses this profile with a 403, so it cannot reach
 * the route in production today. It is tested anyway, deliberately: the route
 * must derive its own price from the caller's plan rather than lean on an access
 * gate two files away to guarantee everyone is a pro. FAILSAFE_PRICE_PLAN exists
 * because a hardcoded 'pro' billed pay-as-you-go customers 40% under rate and
 * nobody reported it.
 */
const PAYG_PROFILE = {
  id: "user-1",
  subscription_tier: "wallet",
  wallet_balance: 100,
  is_acquisition_pro_member: false,
};
const PRO_PROFILE = { ...PAYG_PROFILE, subscription_tier: "pro" };
const ACQ_PRO_PROFILE = { ...PAYG_PROFILE, is_acquisition_pro_member: true };

async function v1Vendors() {
  const { lookupDossier } = await import("@/lib/tracerfy/dossier");
  const { submitSingleTrace, lookupBusinessTrace, lookupPersonTrace } = await import(
    "@/lib/tracerfy/client"
  );
  return { lookupDossier, submitSingleTrace, lookupBusinessTrace, lookupPersonTrace };
}

describe("v1 tier 2 — the trigger", () => {
  it("runs automatically when no ownerName was supplied", async () => {
    const { lookupDossier, submitSingleTrace } = await v1Vendors();

    const body = await (await post(TIER2_BODY)).json();

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(body.tier).toBe(2);
  });

  it("runs on the camelCase opt-in even when the owner IS supplied", async () => {
    // MUTATION: delete the flag arm and this goes red -- the request would take
    // the tier 1 path and never buy the property record the caller paid for.
    const { lookupDossier, submitSingleTrace } = await v1Vendors();

    await post({ ...BODY, fullPropertyTrace: true });

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(submitSingleTrace).not.toHaveBeenCalled();
  });

  it("also honours the session route's snake_case spelling of the opt-in", async () => {
    // A caller who sends full_property_trace has unambiguously asked for a full
    // property trace. Silently giving them a cheaper tier 1 is the wrong answer,
    // not a kindness.
    const { lookupDossier } = await v1Vendors();
    await post({ ...BODY, full_property_trace: true });
    expect(lookupDossier).toHaveBeenCalledTimes(1);
  });

  it("uses the SHARED predicate, so v1 and the session route cannot drift", async () => {
    const { isFullPropertyTrace } = await import("@/lib/trace/fullPropertyTrace");
    expect(isFullPropertyTrace({ owner_name: undefined })).toBe(true);
    expect(isFullPropertyTrace({ owner_name: "   " })).toBe(true);
    expect(isFullPropertyTrace({ owner_name: "ACME HOLDINGS LLC" })).toBe(false);
    expect(
      isFullPropertyTrace({ owner_name: "ACME HOLDINGS LLC", full_property_trace: true })
    ).toBe(true);
  });

  it("does not reuse the retired aiResearch flag as the trigger", async () => {
    const { lookupDossier } = await v1Vendors();
    await post({ ...BODY, aiResearch: true });
    expect(lookupDossier).not.toHaveBeenCalled();
  });

  it("keys the dossier on the submitted address", async () => {
    const { lookupDossier } = await v1Vendors();

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

describe("v1 tier 2 — the pre-flight balance gate reserves the TIER 2 rate", () => {
  it("402s a pay-as-you-go wallet that cannot cover ONE record", async () => {
    // 0.39 covers the tier 1 wallet rate (0.25) and not the tier 2 one (0.40).
    // MUTATION: reserve getChargePerTrace() here and this goes red -- the request
    // reaches the vendors, we spend, and there is nothing to collect from.
    H.profile = { ...PAYG_PROFILE, wallet_balance: 0.39 };
    const { lookupDossier } = await v1Vendors();

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(402);
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
  });

  it("402s a pro wallet that cannot cover ONE record", async () => {
    // 0.24 covers the tier 1 pro rate (0.15) and not the tier 2 one (0.25).
    H.profile = { ...PRO_PROFILE, wallet_balance: 0.24 };
    const { lookupDossier } = await v1Vendors();

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(402);
    expect(lookupDossier).not.toHaveBeenCalled();
  });

  it("lets a pro wallet through at exactly the pro rate", async () => {
    H.profile = { ...PRO_PROFILE, wallet_balance: 0.25 };
    const { lookupDossier } = await v1Vendors();

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(200);
    expect(lookupDossier).toHaveBeenCalledTimes(1);
  });
});

describe("v1 tier 2 — a vendor FAILURE is never billed", () => {
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
    // We paid $0.20 for a dossier we will not bill for. The rule is settled: a
    // vendor failure is never billed, and persisting the record unbilled would
    // make the row a free cache hit that can never acquire contacts.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = { success: false, hit: false, contacts: null, error: "FastAppend timeout" };

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(502);
    expect(deducts()).toHaveLength(0);
    expect(persisted()).toBeUndefined();
  });
});

describe("v1 tier 2 — a TOTAL MISS is still billed", () => {
  it("charges the full per-record rate when the county has no parcel", async () => {
    // Per record SUBMITTED is literal: the customer receives nothing and pays.
    // MUTATION: skip the deduct when execution.property is null and this goes red.
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_MISS;

    const body = await (await post(TIER2_BODY)).json();

    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args).toMatchObject({ p_amount: 0.25, p_trace_history_id: "trace-new" });
    expect(body.charge).toBe(0.25);
    expect(body.propertyRecord).toBeNull();
  });

  it("writes the cacheable billed-miss row shape", async () => {
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(persisted()).toMatchObject({
      status: "no_match",
      is_successful: false,
      property_record: null,
      tier: 2,
      charge: 0.25,
    });
  });

  it("charges a dossier hit whose contact step found nothing", async () => {
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = { success: true, hit: false, contacts: null };

    const body = await (await post(TIER2_BODY)).json();

    expect(deducts()).toHaveLength(1);
    expect(body.charge).toBe(0.25);
    expect(body.propertyRecord).not.toBeNull();
  });
});

describe("v1 tier 2 — the caller's REAL plan is billed, on the RAW Track B rate", () => {
  it("bills pay-as-you-go at the wallet column", async () => {
    // MUTATION: hardcode 'pro' as the plan and this goes red -- $0.25 collected
    // where $0.40 is owed, a 37.5% shortfall nobody reports.
    H.profile = PAYG_PROFILE;
    H.dossier = DOSSIER_MISS;

    const body = await (await post(TIER2_BODY)).json();

    expect(deducts()[0].args).toMatchObject({ p_amount: 0.4 });
    expect(body.charge).toBe(0.4);
  });

  it("bills a pro at the pro column", async () => {
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_MISS;
    await post(TIER2_BODY);
    expect(deducts()[0].args).toMatchObject({ p_amount: 0.25 });
  });

  it("bills an AcquisitionPRO member at the pro column", async () => {
    H.profile = ACQ_PRO_PROFILE;
    H.dossier = DOSSIER_MISS;
    await post(TIER2_BODY);
    expect(deducts()[0].args).toMatchObject({ p_amount: 0.25 });
  });

  it("is blind to a gateway grant, because v1 is Track B", async () => {
    // pricePlanFor() calls this caller a pro; rawPricePlanFor() must not. Reusing
    // the grant-aware Track A helper here would silently move an existing API-key
    // caller's bill from $0.40 to $0.25.
    //
    // NEXT_PUBLIC_SUITE_SIGNIN_ENABLED is the kill-switch hasSuiteAccess() reads.
    // It is OFF in this environment, which makes Track A and Track B AGREE -- so
    // without setting it this test passes under both implementations and proves
    // nothing. Verified: with the flag left off, swapping in the Track A helpers
    // turned ZERO tests red.
    // MUTATION: swap in chargePerRecord/pricePlanFor and this goes red.
    const prev = process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    try {
      H.profile = {
        ...PAYG_PROFILE,
        gateway_products: ["prop-tracer-pro"],
        gateway_products_checked_at: new Date().toISOString(),
      };
      H.dossier = DOSSIER_MISS;

      await post(TIER2_BODY);

      expect(deducts()[0].args).toMatchObject({ p_amount: 0.4 });
    } finally {
      process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = prev;
    }
  });

  it("gates the BALANCE on the Track B rate too, not the Track A one", async () => {
    // The gate and the charge must derive from the same track. A gate on Track A
    // would reserve $0.25 for a caller who owes $0.40 and let a wallet that
    // cannot pay reach the vendors.
    const prev = process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    try {
      H.profile = {
        ...PAYG_PROFILE,
        wallet_balance: 0.39,
        gateway_products: ["prop-tracer-pro"],
        gateway_products_checked_at: new Date().toISOString(),
      };
      const { lookupDossier } = await v1Vendors();

      const res = await post(TIER2_BODY);

      expect(res.status).toBe(402);
      expect(lookupDossier).not.toHaveBeenCalled();
    } finally {
      process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = prev;
    }
  });

  it("deducts exactly ONCE per record", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    await post(TIER2_BODY);
    expect(deducts()).toHaveLength(1);
  });

  it("persists only what was actually collected", async () => {
    // The wallet came up short between the gate and the deduct.
    // MUTATION: persist attemptedCharge and this goes red.
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_MISS;
    H.deductData = false;

    const body = await (await post(TIER2_BODY)).json();

    expect(persisted()).toMatchObject({ charge: 0 });
    expect(body.charge).toBe(0);
    expect(body.warnings.join(" ")).toContain("nothing was charged");
  });
});

describe("v1 tier 2 — what gets persisted and returned", () => {
  it("stores the property record RAW, all 86 keys", async () => {
    // MUTATION: subset it to the populated fields and this goes red. The raw dump
    // IS the product, and a key empty in OH, CA and UT may be populated elsewhere.
    H.dossier = DOSSIER_ENTITY_HIT;

    await post(TIER2_BODY);

    const stored = persisted()!.property_record as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(
      Object.keys(dossierEntityFixture.response.property as object)
    );
  });

  it("returns the PUBLISHABLE record to the caller inline, 65 of the stored 86", async () => {
    // CHARACTERIZATION CHANGED, 2026-09-17, David: this asserted that the
    // response matched the stored record key for key. The 21 blocked fields
    // are now withheld from every egress, not only from the screen, for the
    // reason that already blocked them from the CSV export: the payload lands
    // in a customer's own system, where a wrong `estimated_value` looks
    // authoritative and outlives any caveat we could put on a screen.
    //
    // Tier 2 still completes in this request. There is nothing to poll.
    // MUTATION: drop toPublicPropertyRecord from the response and this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;

    const body = await (await post(TIER2_BODY)).json();

    expect(body.propertyRecord).toEqual(
      toPublicPropertyRecord(dossierEntityFixture.response.property)
    );
    expect(Object.keys(body.propertyRecord)).toHaveLength(65);
    expect(body.traceId).toBe("trace-new");
    expect(body.tracerfyJobId).toBeUndefined();
    expect(persisted()!.tracerfy_job_id).toBeNull();
  });

  it("carries no blocked key in the response, and all 86 in the row", async () => {
    // The whole point in one test: the same variable leaves by two doors and
    // only one of them is filtered.
    H.dossier = DOSSIER_ENTITY_HIT;

    const body = await (await post(TIER2_BODY)).json();
    const stored = persisted()!.property_record as Record<string, unknown>;

    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(body.propertyRecord, `${key} left PTP`).not.toHaveProperty(key);
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

    await post(TIER2_BODY);

    const stored = persisted()!.property_record as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(86);
    expect(stored).toEqual(dossierEntityFixture.response.property);
  });

  it("puts contacts where tier 1 already puts them", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    const body = await (await post(TIER2_BODY)).json();

    expect(persisted()).toMatchObject({
      status: "success",
      is_successful: true,
      phone_count: 1,
      email_count: 1,
    });
    expect(body.result.phones[0].number).toBe("5550000101");
    expect(body.result.emails[0]).toBe("principal@example.invalid");
  });

  it("records what the vendors actually took, not a price-list guess", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    await post(TIER2_BODY);
    expect(persisted()!.cost).toBeGreaterThan(0);
  });
});

describe("v1 tier 2 — the discovered owner picks the VENDOR, never the price", () => {
  it("routes an entity owner to FastAppend", async () => {
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_ENTITY_HIT;
    const { lookupBusinessTrace, lookupPersonTrace } = await v1Vendors();

    await post(TIER2_BODY);

    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
    expect(lookupPersonTrace).not.toHaveBeenCalled();
    expect(deducts()[0].args).toMatchObject({ p_amount: 0.25 });
  });

  it("routes an individual owner to Tracerfy, at the SAME price", async () => {
    // lessons.md L-005: the cost table has a vendor axis, the PRICE table does not.
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_INDIVIDUAL_HIT;
    const { lookupBusinessTrace, lookupPersonTrace } = await v1Vendors();

    await post(TIER2_BODY);

    expect(lookupPersonTrace).toHaveBeenCalledTimes(1);
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(deducts()[0].args).toMatchObject({ p_amount: 0.25 });
  });
});

describe("v1 tier 2 — the learned zip", () => {
  it("persists the situs zip the dossier taught us when the caller sent none", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    const { address, city, state } = TIER2_BODY;

    await post({ address, city, state });

    const zip = persisted()!.zip;
    expect(typeof zip).toBe("string");
    expect(String(zip)).toHaveLength(5);
  });

  it("NEVER touches address_hash", async () => {
    // A row whose hash moves is a row that re-buys itself forever.
    H.dossier = DOSSIER_ENTITY_HIT;
    const { address, city, state } = TIER2_BODY;

    await post({ address, city, state });

    expect(Object.keys(persisted()!)).not.toContain("address_hash");
    expect(Object.keys(persisted()!)).not.toContain("normalized_address");
  });

  it("does not rewrite a zip the caller supplied", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    await post(TIER2_BODY);
    expect(Object.keys(persisted()!)).not.toContain("zip");
  });
});

describe("v1 tier 2 — the charge follows the vendor call", () => {
  it("never deducts when no vendor was asked", async () => {
    // planRoute emits no step when the parcel has no usable key. Unreachable
    // through validation, guarded anyway.
    // MUTATION: delete the plan.steps.length === 0 guard and this goes red.
    const { planRoute } = await import("@/lib/routing/ownerRoute");
    const plan = planRoute({ state: "TX", ownerName: null }, "wallet");
    expect(plan.steps).toHaveLength(0);
    expect(plan.billing.amount).toBe(0.4);
  });
});

/* ==================================================================== *
 * THE trace.completed WEBHOOK.
 *
 * Tier 2 completes inline and never reaches a poll route, which is where
 * every other trace.completed is sent from. Without this a webhook
 * customer silently stops receiving events, and silence is the failure
 * mode nobody notices.
 * ==================================================================== */
const WEBHOOK_PROFILE = { ...PRO_PROFILE, webhook_url: "https://hooks.example.invalid/ptp" };

function webhooks() {
  return H.webhookPosts.filter((p) => p.body.event === "trace.completed");
}

describe("v1 tier 2 — trace.completed", () => {
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

  it("FIRES ON A BILLED MISS, which is the case a customer most needs told about", async () => {
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
    expect(webhooks()[0].body).toMatchObject({ tier: 1, status: "no_match", outcome_code: "no_match", found_by: null, property_record: null });
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
});

/* ====================================================================
 * EVERY DOOR, NOT JUST THE ONE THAT SPENDS MONEY.
 *
 * The tier 2 response above is the obvious egress. These are the two that
 * are easy to miss, because the record comes back out of our own database
 * rather than from a vendor call and so does not look like it is leaving.
 * A cached row holds the RAW 86 keys; a cache hit must publish 65 just as
 * the purchase did, or the blocked fields reach the integrator on their
 * SECOND request instead of their first.
 * ==================================================================== */

describe("v1 tier 2 — the cached branches filter too", () => {
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

    expect(body.cached).toBe(true);
    expect(Object.keys(body.propertyRecord)).toHaveLength(65);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(body.propertyRecord, `${key} left PTP on a cache hit`).not.toHaveProperty(key);
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
    expect(Object.keys(body.propertyRecord)).toHaveLength(65);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(body.propertyRecord, `${key} left PTP on a billed cache hit`).not.toHaveProperty(key);
    }
  });

  it("publishes the same 65 keys whether the record was just bought or cached", async () => {
    // An integrator must not be able to tell the two apart by field count. If
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
    const freshBody = await (await post(TIER2_BODY)).json();

    expect(Object.keys(cachedBody.propertyRecord).sort()).toEqual(
      Object.keys(freshBody.propertyRecord).sort()
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

    expect(body.propertyRecord).toBeNull();
  });
});

/* ====================================================================
 * A ROW A LEDGER ROW POINTS AT IS NEVER A DELETE CANDIDATE.
 *
 * The same guard the session route carries, asserted here because the
 * two surfaces run the same deletes against the same table and a guard
 * on one of them is not a guard.
 * ==================================================================== */
describe("POST /api/v1/trace/single — the deletes consult the ledger", () => {
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
    H.survivingRow = { id: "trace-billed", charge: 0.25, property_record: null };

    await post();

    expect(H.ops.some((o) => o.table === "wallet_transactions")).toBe(false);
    expect(deletes()).toHaveLength(0);
  });
});

/* ====================================================================
 * TELLING THE TRUTH WHEN NOTHING WAS COLLECTED, on the surface where the
 * message is read by a machine as well as a person.
 * ==================================================================== */
describe("v1 tier 2 — the two zeros say different things", () => {
  it("blames the balance only when the balance was actually short", async () => {
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_MISS;
    H.deductData = false;

    const body = await (await post(TIER2_BODY)).json();

    expect(body.charge).toBe(0);
    expect(String(body.warnings.join(" "))).toContain("did not cover");
  });

  it("owns the failure when the deduct RPC itself errored", async () => {
    // WAS: the same "your wallet did not cover this" sentence, which is false
    // for an integrator whose wallet is full.
    // MUTATION: collapse the two outcomes back into `charge === 0` and this
    // goes red.
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    H.deductError = { message: "connection reset" };

    const body = await (await post(TIER2_BODY)).json();

    expect(body.charge).toBe(0);
    const said = String(body.warnings.join(" "));
    expect(said).not.toContain("did not cover");
    expect(said).toContain("error on our side");
  });

  it("delivers the record either way, because we already bought it", async () => {
    // The decision, named rather than buried: on an RPC failure we spent at the
    // vendor and could not collect. The caller is not billed and keeps the
    // record. Billing them later for a record already delivered is exactly the
    // surprise charge this phase exists to remove.
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    H.deductError = { message: "connection reset" };

    const body = await (await post(TIER2_BODY)).json();

    expect(body.propertyRecord).not.toBeNull();
    expect(body.result.phones).toHaveLength(1);
  });

  it("says nothing about the wallet at all when the charge went through", async () => {
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    const body = await (await post(TIER2_BODY)).json();

    expect(String(body.warnings.join(" "))).not.toContain("wallet");
  });
});

describe("v1 tier 2 — the persist FOLDS the receipt it found", () => {
  it("adds this collection to whatever the reused row already carried", async () => {
    // v1 has no clear-cache button, so this shape arrives from a row billed
    // under a model that is not a cache hit. The property asserted is the one
    // the session route's clear-cache path depends on and which must not differ
    // between the two surfaces: a second real purchase ADDS to the receipt.
    // MUTATION: write `charge` straight into the payload and this goes red.
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_MISS;
    H.survivingRow = { id: "trace-prior", charge: 0.15, property_record: null };
    H.insertedRow = { id: "trace-prior", charge: 0.15, tier: 1 };

    await post(TIER2_BODY);

    expect(persisted()).toMatchObject({ charge: 0.4, tier: 2 });
  });

  it("leaves a fresh row's receipt exactly as this submit collected it", async () => {
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(persisted()).toMatchObject({ charge: 0.25, tier: 2 });
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
 * PTP never calls HighLevel unless a person asked it to. An API caller gets the
 * result back and sends it wherever they want it; a push from PTP starts only
 * at the Push to CRM button, app/api/integrations/highlevel/push.
 *
 * Set up with EXACTLY the conditions that used to push: a credential on the
 * profile and a tier 2 single settling inline with real contacts on it.
 * ------------------------------------------------------------------ */
describe("tier 2 single (v1) never pushes to HighLevel", () => {
  const CONNECTED = {
    ...PRO_PROFILE,
    highlevel_api_key: "hl-key",
    highlevel_location_id: "loc-1",
  };

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

  it("still settles the trace and returns the contacts the caller paid for", async () => {
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
 * TIER 1 INLINE ON THE API, plus D23 (a parcel id when there is no city)
 * and D24 (a Full Property Trace keyed by parcel id).
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

const BUSY_SENTENCE = "The system is busy. Try again in 5 minutes. You were not charged.";

describe("v1 tier 1, D23: a record with no city goes by parcel id", () => {
  const APN_PERSON = { state: "OH", apn: "#0123-456", county: "Placeholder", ownerName: "Testowner Placeholder" };

  it("looks an individual up by parcel id, with the names carried for the match only", async () => {
    H.person = CONTACTS_HIT;
    const { lookupPersonTrace } = await v1Vendors();
    const body = await (await post(APN_PERSON)).json();
    expect(lookupPersonTrace).toHaveBeenCalledWith(
      expect.objectContaining({ parcel_id: "#0123-456", county: "Placeholder", state: "OH", first_name: "Testowner", last_name: "Placeholder" }),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(body).toMatchObject({ success: true, tier: 1, foundBy: "parcel_id", outcomeCode: "found_by_parcel_id" });
  });

  it("keys the row on APN, county and state, and stores the parcel id and county (spec 6.3)", async () => {
    // MUTATION: key the row with normalizeAddress(address, city, state) again and this goes red.
    await post(APN_PERSON);
    const insert = H.ops.find((o) => o.op === "insert");
    expect(insert!.payload).toMatchObject({
      normalized_address: "APN|0123-456|PLACEHOLDER|OH",
      address_hash: createAddressHash("APN|0123-456|PLACEHOLDER|OH"),
      city: null,
      parcel_id_local: "#0123-456",
      county: "Placeholder",
    });
    // The 90-day cache is searched by the SAME key (fix round 1, L-018). The dedup mock answers
    // H.cached whatever hash it is asked for, so only this filter pins which key was asked.
    // MUTATION: search the cache by createAddressHash(normalizeAddress(address ?? '', city ?? '',
    // state)) and this goes red.
    const cacheSelect = H.ops.find((o) => isDedupSelect(o));
    expect(cacheSelect).toBeDefined();
    expect(cacheSelect!.filters).toContainEqual(["eq", "address_hash", createAddressHash("APN|0123-456|PLACEHOLDER|OH")]);
  });

  it("never sends the internal APN key as the webhook's address", async () => {
    // MUTATION: send `address: normalizedAddress` on the tier 1 webhook and this goes red.
    H.profile = WEBHOOK_PROFILE;
    await post(APN_PERSON);
    expect(webhooks()).toHaveLength(1);
    expect(webhooks()[0].body).toMatchObject({ address: null, city: null, state: "OH" });
  });

  it("keys a record with a city but no street on its parcel, not on the city (D36)", async () => {
    // The shape that shared one row per city before D36: a paid result was overwritten and a
    // resend inside 90 days was charged again.
    // MUTATION: key an address with a city first in traceKeyFor and this goes red.
    await post({ city: "Austin", state: "TX", apn: "0123-456", county: "Travis", ownerName: "Testowner Placeholder" });
    const insert = H.ops.find((o) => o.op === "insert");
    expect(insert!.payload).toMatchObject({
      normalized_address: "APN|0123-456|TRAVIS|TX",
      address_hash: createAddressHash("APN|0123-456|TRAVIS|TX"),
      city: "AUSTIN",
      parcel_id_local: "0123-456",
      county: "Travis",
    });
    const cacheSelect = H.ops.find((o) => isDedupSelect(o));
    expect(cacheSelect!.filters).toContainEqual(["eq", "address_hash", createAddressHash("APN|0123-456|TRAVIS|TX")]);
  });

  it("accepts parcelId as the same field", async () => {
    H.person = CONTACTS_HIT;
    const body = await (await post({ state: "OH", parcelId: "0123-456", county: "Placeholder", ownerName: "Testowner Placeholder" })).json();
    expect(body.foundBy).toBe("parcel_id");
  });

  it("traces a company with only its name and state (D23)", async () => {
    const { lookupBusinessTrace } = await v1Vendors();
    const res = await post({ state: "OH", ownerName: "ACME HOLDINGS LLC" });
    expect(res.status).toBe(200);
    expect(lookupBusinessTrace).toHaveBeenCalledWith(
      { company_name: "ACME HOLDINGS LLC", state: "OH" },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  it("traces a trust with no first name left on its full name and state, as a company (D16)", async () => {
    // The approved docs promise it: "Smith Family Trust" leaves no first name once the trust words
    // are removed, so it is looked up as a company, by name and state, with no street, city or
    // parcel id.
    // MUTATION (fix round 1): replace the keyPlan check with missingLookupKey(...) !== null and this
    // goes red (the record is refused as missing the city and the parcel ID).
    const { lookupBusinessTrace, lookupPersonTrace } = await v1Vendors();
    const res = await post({ state: "OH", ownerName: "Smith Family Trust" });
    expect(res.status).toBe(200);
    expect(lookupBusinessTrace).toHaveBeenCalledWith(
      { company_name: "Smith Family Trust", state: "OH" },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(lookupPersonTrace).not.toHaveBeenCalled();
  });

  it("refuses a person with neither a city nor a parcel id, as no_lookup_key", async () => {
    const res = await post({ state: "OH", ownerName: "Testowner Placeholder" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.skipReason).toBe(
      "This record is missing the city and the parcel ID, so it could not be looked up. You were not charged. Send it again with the city or the parcel ID."
    );
    expect(H.ops).toHaveLength(0);
  });
});

describe("v1 tier 2, D24 and D21 on the API: the dossier by parcel id, the owner at the mailing address", () => {
  it("keys the dossier on the parcel id when there is no city, then searches the owner at the mailing address", async () => {
    H.dossier = DOSSIER_INDIVIDUAL_HIT;
    H.person = CONTACTS_HIT;
    const { lookupDossier, lookupPersonTrace } = await v1Vendors();
    const body = await (await post({ state: "OH", apn: "0123-456", county: "Placeholder" })).json();
    expect(lookupDossier).toHaveBeenCalledWith(
      { mode: "apn", apn: "0123-456", county: "Placeholder", state: "OH" },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    const personReq = vi.mocked(lookupPersonTrace).mock.calls[0][0];
    expect(personReq).toMatchObject({ address: "100 Placeholder Way", city: "Redacted", state: "ZZ", first_name: "Testowner", last_name: "Placeholder" });
    expect(personReq).not.toHaveProperty("parcel_id");
    expect(body.tier).toBe(2);
  });

  it("tries the parcel id first and the address second when both are sent", async () => {
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await v1Vendors();
    await post({ ...TIER2_BODY, apn: "0123-456", county: "Placeholder" });
    expect(vi.mocked(lookupDossier).mock.calls.map((c) => (c[0] as { mode: string }).mode)).toEqual(["apn", "address"]);
  });

  it("writes contact_vendor on the tier 2 persist", async () => {
    // MUTATION: delete the contact_vendor line from the tier 2 persist and this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    await post(TIER2_BODY);
    expect(persisted()).toMatchObject({ contact_vendor: "fastappend", outcome_code: null, found_by: null });
    // MUTATION (fix round 1): delete trace_steps from the tier 2 persist and this goes red.
    const steps = persisted()!.trace_steps as Array<{ kind: string }>;
    expect(steps.map((s) => s.kind)).toEqual(["DOSSIER_ADDRESS", "FASTAPPEND_ENTITY"]);
  });

  it("never sends the internal APN key as the tier 2 webhook's address", async () => {
    // MUTATION (fix round 1): send `address: normalizedAddress` on the tier 2 webhook and this
    // goes red.
    H.profile = WEBHOOK_PROFILE;
    H.dossier = DOSSIER_MISS;
    await post({ state: "OH", apn: "0123-456", county: "Placeholder" });
    expect(webhooks()).toHaveLength(1);
    expect(webhooks()[0].body).toMatchObject({ tier: 2, address: null, city: null, state: "OH" });
  });

  it("never falls back to the dossier's own contacts: a Full Property Trace whose owner lookups all miss is a true null (D32)", async () => {
    // D32 withdrew the dossier-contacts fallback entirely: there is no toggle left at this route
    // to mutate, so this asserts the shape rather than a deletable guard.
    H.dossier = {
      ...DOSSIER_INDIVIDUAL_HIT,
      contacts: {
        ownerName: "Not The Real Contact",
        phones: [{ number: "5550000901", type: "mobile" }],
        emails: ["fallback@example.invalid"],
        mailingAddress: null,
      },
    };
    const body = await (await post(TIER2_BODY)).json();
    expect(body.result).toMatchObject({ phones: [], emails: [] });
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("5550000901");
    expect(bodyStr).not.toContain("fallback@example.invalid");
    expect(bodyStr).not.toMatch(/name_verified/);
  });
});

describe("v1 tier 1: what the caller gets", () => {
  it("returns the finished result, camelCase, with no step log in the response or the webhook", async () => {
    H.profile = WEBHOOK_PROFILE;
    H.entity = CONTACTS_HIT;
    const res = await post();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true, status: "success", traceId: "trace-new", tier: 1, charge: 0.15,
      propertyRecord: null, ownerName: "ACME HOLDINGS LLC", ownerType: "entity",
      foundBy: "company_name", outcomeCode: "found_by_company_name", skipReason: null,
    });
    expect(body.result.phones).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/trace_steps|traceSteps|requestKey/);
    expect(JSON.stringify(webhooks()[0].body)).not.toMatch(/trace_steps|traceSteps|requestKey/);
  });

  it("persists the outcome, the key, the vendor and the step log, and never property_record", async () => {
    H.entity = CONTACTS_HIT;
    await post();
    expect(tier1Persisted()).toMatchObject({
      status: "success", is_successful: true, charge: 0.15, tier: 1,
      contact_vendor: "fastappend", found_by: "company_name", outcome_code: "found_by_company_name",
      tracerfy_job_id: null, ai_research_status: null, property_trace_status: null,
    });
    expect(Array.isArray(tier1Persisted()!.trace_steps)).toBe(true);
    expect(deducts()[0].args).toMatchObject({
      p_amount: 0.15, p_trace_history_id: "trace-new", p_description: "Skip trace - successful match",
    });
  });

  it("a miss is free and says which key was tried", async () => {
    const body = await (await post()).json();
    expect(deducts()).toHaveLength(0);
    expect(body).toMatchObject({
      status: "no_match", charge: 0, result: null, outcomeCode: "no_match",
      skipReason: "We looked this owner up by company name and found no match. You were not charged.",
    });
  });

  it("a person owner whose returned people do not match is free, and no name of theirs is kept (D29)", async () => {
    // `people` rides alongside peopleCount at runtime (H.person is typed unknown, so tsc will not
    // catch a missed edit) so the assertions below can actually fail if a name ever leaked.
    H.person = {
      success: true, hit: true, contacts: null, nameNotMatched: true,
      peopleCount: 1, creditsDeducted: 5,
      people: [{ first_name: "Someoneelse", last_name: "Different" }],
    };
    const body = await (await post({ ...BODY, ownerName: "Testowner Placeholder" })).json();
    expect(deducts()).toHaveLength(0);
    expect(body.outcomeCode).toBe("owner_name_not_matched");
    expect(body.skipReason).toBe(
      "We found people linked to this property, but none matched the owner name, so no contacts were returned. You were not charged."
    );
    expect(JSON.stringify(tier1Persisted())).not.toMatch(/Someoneelse|Different/);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/Someoneelse|Different/);
    expect(bodyStr).not.toMatch(/trace_steps|peopleCount/);
  });
});

describe("v1 tier 1: busy, money, the resend and D25 on this call site (L-018)", () => {
  it("a vendor failure is busy_try_again: 503, Retry-After, free, no webhook", async () => {
    // MUTATION: return 200 on the busy branch and this goes red.
    H.profile = WEBHOOK_PROFILE;
    H.entity = { success: false, hit: false, contacts: null, error: "FastAppend service unavailable" };
    const res = await post();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(body).toEqual({
      success: false, status: "error", traceId: "trace-new", tier: 1, charge: 0, result: null,
      foundBy: null, outcomeCode: "busy_try_again", skipReason: BUSY_SENTENCE, error: BUSY_SENTENCE,
    });
    expect(deducts()).toHaveLength(0);
    expect(webhooks()).toHaveLength(0);
    expect(tier1Persisted()).toMatchObject({ status: "error", outcome_code: "busy_try_again" });
  });

  it("records, and does not take again, a debit an earlier attempt booked", async () => {
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", charge: 0, tier: null };
    H.insertedRow = { id: "trace-new", charge: 0, tier: null };
    H.ledgerRefs = [{ amount: 0.15, type: "debit", created_at: new Date(Date.now() - 60 * 1000).toISOString() }];
    const body = await (await post()).json();
    expect(deducts()).toHaveLength(0);
    expect(body.charge).toBe(0.15);
    expect(tier1Persisted()).toMatchObject({ charge: 0.15, tier: 1 });
  });

  it("folds a new charge onto the reused row's receipt", async () => {
    // MUTATION: pass `row: { id: traceRecord.id }` to runSingleTier1 and this goes red.
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", charge: 0.25, tier: 2, property_record: null };
    H.insertedRow = { id: "trace-new", charge: 0.25, tier: 2, property_record: null };
    H.ledgerRefs = [{ amount: 0.25, type: "debit", created_at: "2026-08-01T00:00:00.000Z" }];
    const body = await (await post()).json();
    expect(deducts()).toHaveLength(1);
    expect(tier1Persisted()).toMatchObject({ charge: 0.4, tier: 2 });
    // The receipt reads 0.40 (both purchases), but this REQUEST only collected its own 0.15.
    expect(body.charge).toBe(0.15);
  });

  it("keeps a busy row: no sweep deletes it", async () => {
    // MUTATION: drop `|| busyResend` from runDelete and this goes red.
    const busy = { id: "trace-new", charge: 0, tier: 1, is_successful: false, property_record: null, outcome_code: "busy_try_again", trace_steps: [] };
    H.survivingRow = busy;
    H.insertedRow = busy;
    await post();
    expect(deletes()).toHaveLength(0);
  });

  it("resumes a busy row: the answered step is not bought again", async () => {
    const TRUST_BODY = { ...BODY, ownerName: "Marcus Halloway Revocable Trust" };
    const instantKey = requestKeyFor(
      planRoute({ ...parcelForFullTrace(TRUST_BODY), ownerName: TRUST_BODY.ownerName }, "pro").steps[0]
    );
    const busy = {
      id: "trace-new", charge: 0, tier: 1, is_successful: false, property_record: null,
      outcome_code: "busy_try_again",
      trace_steps: [{
        kind: "TRACERFY_INSTANT_NAMED", outcome: "miss", cost: 0,
        at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), requestKey: instantKey,
      }],
    };
    H.survivingRow = busy;
    H.insertedRow = busy;
    const { lookupPersonTrace, lookupBusinessTrace } = await v1Vendors();
    await post(TRUST_BODY);
    expect(lookupPersonTrace).not.toHaveBeenCalled();
    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
  });

  it("does not serve a different owner's cached contacts (D25)", async () => {
    // MUTATION: serve the cached row whatever its owner and this goes red.
    H.cached = {
      id: "trace-cached", input_owner_name: "JANE DOE",
      trace_result: { phones: [{ number: "5550000101", type: "mobile" }], emails: [] }, is_successful: true, charge: 0.15, tier: 1,
    };
    const { lookupBusinessTrace } = await v1Vendors();
    const body = await (await post()).json();
    expect(body.cached).toBeUndefined();
    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
  });

  it("serves the same owner written differently, free, with its foundBy and outcomeCode", async () => {
    H.cached = {
      id: "trace-cached", input_owner_name: "Acme Holdings, L.L.C.",
      trace_result: { phones: [{ number: "5550000101", type: "mobile" }], emails: [] },
      is_successful: true, found_by: "company_name", outcome_code: "found_by_company_name",
    };
    const body = await (await post()).json();
    expect(body).toMatchObject({
      cached: true, charge: 0, traceId: "trace-cached", foundBy: "company_name", outcomeCode: "found_by_company_name",
    });
    expect(deducts()).toHaveLength(0);
  });

  it("passes the request budget to every vendor call", async () => {
    // MUTATION: pass `deadlineMs: startedAt + 10 * 60 * 1000` and this goes red.
    const { lookupDossier, lookupBusinessTrace, lookupPersonTrace } = await v1Vendors();
    await post();
    let calls = 0;
    for (const mocked of [lookupDossier, lookupBusinessTrace, lookupPersonTrace]) {
      for (const call of vi.mocked(mocked).mock.calls as unknown[][]) {
        calls += 1;
        const opts = call[1] as { timeoutMs: number };
        expect(opts.timeoutMs).toBeGreaterThan(0);
        expect(opts.timeoutMs).toBeLessThanOrEqual(VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS);
      }
    }
    expect(calls).toBeGreaterThan(0);
  });

  it("passes the request budget to every vendor call on a two-step ladder", async () => {
    // A trust owner with a first name: the Instant lookup misses (the H.person default), so
    // FastAppend runs next. Both calls must carry the request budget, not just the first.
    const { lookupPersonTrace, lookupBusinessTrace } = await v1Vendors();
    await post({ ...BODY, ownerName: "Marcus Halloway Revocable Trust" });
    expect(lookupPersonTrace).toHaveBeenCalledTimes(1);
    expect(lookupBusinessTrace).toHaveBeenCalledTimes(1);
    for (const mocked of [lookupPersonTrace, lookupBusinessTrace]) {
      for (const call of vi.mocked(mocked).mock.calls as unknown[][]) {
        const opts = call[1] as { timeoutMs: number };
        expect(opts.timeoutMs).toBeGreaterThan(0);
        expect(opts.timeoutMs).toBeLessThanOrEqual(VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS);
      }
    }
  });
});

describe("v1 tier 1: warnings are wallet-only, the routing notes stay internal", () => {
  it("does not leak a routing warning into body.warnings", async () => {
    // MUTATION: return tier1.execution.warnings instead of the wallet-only array and this goes
    // red: planRoute always warns on an entity step with no registrationState, and BODY's owner
    // (ACME HOLDINGS LLC) takes that step.
    H.entity = CONTACTS_HIT;
    const body = await (await post()).json();
    expect(body.warnings).toEqual([]);
  });

  it("says the wallet was short when it was", async () => {
    H.entity = CONTACTS_HIT;
    H.deductData = false;
    const body = await (await post()).json();
    expect(body.charge).toBe(0);
    expect(body.warnings).toEqual(["The wallet did not cover this record, so nothing was charged for it."]);
  });
});

describe("v1 tier 1: auto-rebill fires only when money moved or should have", () => {
  it("does not trigger on a free outcome", async () => {
    // MUTATION: call triggerAutoRebillIfNeeded unconditionally and this goes red.
    const { triggerAutoRebillIfNeeded } = await import("@/lib/utils/auto-rebill");
    await post();
    expect(triggerAutoRebillIfNeeded).not.toHaveBeenCalled();
  });

  it("triggers on a charged outcome", async () => {
    const { triggerAutoRebillIfNeeded } = await import("@/lib/utils/auto-rebill");
    H.entity = CONTACTS_HIT;
    await post();
    expect(triggerAutoRebillIfNeeded).toHaveBeenCalledWith("user-1");
  });

  it("triggers on insufficient_balance", async () => {
    const { triggerAutoRebillIfNeeded } = await import("@/lib/utils/auto-rebill");
    H.entity = CONTACTS_HIT;
    H.deductData = false;
    await post();
    expect(triggerAutoRebillIfNeeded).toHaveBeenCalledWith("user-1");
  });

  it("triggers on a deduct error", async () => {
    const { triggerAutoRebillIfNeeded } = await import("@/lib/utils/auto-rebill");
    H.entity = CONTACTS_HIT;
    H.deductError = { message: "wallet RPC timed out" };
    await post();
    expect(triggerAutoRebillIfNeeded).toHaveBeenCalledWith("user-1");
  });

  it("does not trigger on already_collected: an earlier attempt already paid", async () => {
    const { triggerAutoRebillIfNeeded } = await import("@/lib/utils/auto-rebill");
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", charge: 0, tier: null };
    H.insertedRow = { id: "trace-new", charge: 0, tier: null };
    H.ledgerRefs = [{ amount: 0.15, type: "debit", created_at: new Date(Date.now() - 60 * 1000).toISOString() }];
    await post();
    expect(triggerAutoRebillIfNeeded).not.toHaveBeenCalled();
  });
});

describe("v1 tier 1: the Track B price", () => {
  it("charges a pro profile the pro rate", async () => {
    H.profile = PRO_PROFILE;
    H.entity = CONTACTS_HIT;
    await post();
    expect(deducts()[0].args).toMatchObject({ p_amount: 0.15 });
  });

  it("charges a pay-as-you-go profile the wallet rate", async () => {
    // MUTATION: pass a fixed pro rate as chargeAmount and this goes red.
    H.profile = PAYG_PROFILE;
    H.entity = CONTACTS_HIT;
    await post();
    expect(deducts()[0].args).toMatchObject({ p_amount: 0.25 });
  });

  it("is blind to a gateway grant, because v1 is Track B", async () => {
    // NEXT_PUBLIC_SUITE_SIGNIN_ENABLED is the kill-switch hasSuiteAccess() reads. With it off,
    // Track A and Track B agree and the two tests above pass under either derivation.
    // MUTATION: swap getChargePerTrace(...) for Track A's chargePerTrace(profile) and this goes
    // red (0.15 instead of 0.25).
    const prev = process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    try {
      H.profile = {
        ...PAYG_PROFILE,
        gateway_products: ["prop-tracer-pro"],
        gateway_products_checked_at: new Date().toISOString(),
      };
      H.entity = CONTACTS_HIT;
      await post();
      expect(deducts()[0].args).toMatchObject({ p_amount: 0.25 });
    } finally {
      process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = prev;
    }
  });
});

describe("v1 tier 1: a row with live work is never touched", () => {
  function expectUntouchedBusy(res: Response, body: Record<string, unknown>, traceId: string) {
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(body).toEqual({
      success: false, status: "error", traceId, tier: 1, charge: 0, result: null,
      foundBy: null, outcomeCode: "busy_try_again", skipReason: BUSY_SENTENCE, error: BUSY_SENTENCE,
    });
    expect(H.ops.filter((o) => o.op === "update" || o.op === "insert")).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
    expect(deducts()).toHaveLength(0);
    expect(webhooks()).toHaveLength(0);
  }

  it("answers busy without touching a row whose Tier 2 rung is still queued (cron crash window)", async () => {
    // MUTATION: drop the isPropertyTracePending() clause and this goes red.
    H.profile = WEBHOOK_PROFILE;
    H.survivingRow = { id: "trace-live-a", property_trace_status: "queued_2", charge: 0, tier: 2 };
    const { lookupDossier, lookupBusinessTrace, lookupPersonTrace } = await v1Vendors();
    const res = await post();
    expectUntouchedBusy(res, await res.json(), "trace-live-a");
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(lookupPersonTrace).not.toHaveBeenCalled();
  });

  it("answers busy for a busy row bulk re-enqueued, even though outcome_code alone would exempt it", async () => {
    // MUTATION: drop the isEntityTracePending() clause and this goes red.
    H.profile = WEBHOOK_PROFILE;
    H.survivingRow = {
      id: "trace-live-b", outcome_code: "busy_try_again", ai_research_status: "queued", charge: 0, tier: 1,
    };
    const { lookupBusinessTrace } = await v1Vendors();
    const res = await post();
    expectUntouchedBusy(res, await res.json(), "trace-live-b");
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
  });

  it("answers busy for a fresh processing row from a concurrent request", async () => {
    // MUTATION: drop the processingIsLive clause and this goes red.
    H.profile = WEBHOOK_PROFILE;
    H.survivingRow = { id: "trace-live-c", status: "processing", created_at: new Date().toISOString(), charge: 0, tier: null };
    const { lookupBusinessTrace } = await v1Vendors();
    const res = await post();
    expectUntouchedBusy(res, await res.json(), "trace-live-c");
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
  });

  it("still reuses an ordinary processing row abandoned longer ago than the cron's own threshold", async () => {
    // Not live work: the gate is not a blanket refusal of every 'processing' row.
    H.entity = CONTACTS_HIT;
    H.survivingRow = {
      id: "trace-old", status: "processing",
      created_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), charge: 0, tier: null,
    };
    H.insertedRow = { id: "trace-old", charge: 0, tier: null };
    const res = await post();
    expect(res.status).toBe(200);
  });
});

describe("v1 tier 1: a reused row's owner and its result change together (D25 money)", () => {
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
    // MUTATION: pass `inputOwnerName: null` to runSingleTier1 and this goes red.
    H.entity = CONTACTS_HIT;
    H.survivingRow = { id: "trace-new", input_owner_name: "JANE DOE", charge: 0, tier: null };
    H.insertedRow = { id: "trace-new", charge: 0, tier: null };
    await post();
    expect(tier1Persisted()).toMatchObject({ input_owner_name: "ACME HOLDINGS LLC" });
  });
});

describe("v1 tier 2: input_owner_name rides the same write as trace_result (D25 money)", () => {
  it("writes null when no owner was supplied", async () => {
    // MUTATION: drop input_owner_name from the tier 2 persist and this goes red.
    H.dossier = DOSSIER_MISS;
    await post(TIER2_BODY);
    expect(persisted()).toMatchObject({ input_owner_name: null });
  });

  it("writes the supplied owner on the Full Property Trace opt-in", async () => {
    H.dossier = DOSSIER_MISS;
    await post({ ...BODY, fullPropertyTrace: true });
    expect(persisted()).toMatchObject({ input_owner_name: "ACME HOLDINGS LLC" });
  });
});

describe("v1 tier 2: the request budget reaches every vendor call", () => {
  it("passes VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS to every tier 2 vendor call", async () => {
    // MUTATION: pass `deadlineMs: startedAt + 10 * 60 * 1000` to the tier 2 executeRoute call and
    // this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    const { lookupDossier, lookupBusinessTrace } = await v1Vendors();
    await post(TIER2_BODY);
    let calls = 0;
    for (const mocked of [lookupDossier, lookupBusinessTrace]) {
      for (const call of vi.mocked(mocked).mock.calls as unknown[][]) {
        calls += 1;
        const opts = call[1] as { timeoutMs: number };
        expect(opts.timeoutMs).toBeGreaterThan(0);
        expect(opts.timeoutMs).toBeLessThanOrEqual(VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS);
      }
    }
    expect(calls).toBe(2);
  });
});
