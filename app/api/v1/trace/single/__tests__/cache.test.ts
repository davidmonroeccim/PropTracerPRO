import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE CACHE ON THE PUBLIC v1 SURFACE, exercised through the REAL lookup.
 *
 * Why this file exists separately from route.test.ts: that file mocks
 * `checkSingleDuplicate` outright, so every cache assertion in it is a statement
 * about the mock rather than about the route. It cannot fail for the reason that
 * matters, which is that the lookup could not see the caller's rows at all
 * (lessons.md L-009).
 *
 * Here nothing about deduplication is mocked. Only the two Supabase clients are,
 * and they are wired to behave the way the real ones do on an API-key request:
 *
 *   - `@/lib/supabase/server` is the COOKIE-BACKED ANON client. `trace_history`
 *     carries RLS `USING (auth.uid() = user_id)` (supabase/schema.sql:239-241)
 *     and a /api/v1/* request carries no Supabase session cookie, so `auth.uid()`
 *     is NULL and every select matches ZERO rows. That is what the mock returns.
 *   - `@/lib/supabase/admin` is the SERVICE-ROLE client, which sees the row.
 *
 * So a test here goes red for the real reason: point the lookup at the cookie
 * client and the caller is billed twice.
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
  /** Every select the BLIND anon client was asked for, table by table. */
  anonSelects: [] as string[],
  profile: null as unknown as Record<string, unknown>,
  /** The row the database holds for this address. Null = nothing stored. */
  cached: null as Record<string, unknown> | null,
  survivingRow: null as Record<string, unknown> | null,
  insertedRow: { id: "trace-1" } as Record<string, unknown> | null,
  /** Rows wallet_transactions / usage_records hold against the trace id. */
  ledgerRefs: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  deductData: true as unknown,
  dossier: null as unknown,
  entity: null as unknown,
  person: null as unknown,
  webhookPosts: [] as Array<{ url: string; body: Record<string, unknown> }>,
}));

/** True when this select is the dedup lookup: only it carries the cache filter. */
function isDedupSelect(rec: Recorded): boolean {
  return rec.op === "select" && rec.filters.some((f) => f[0] === "or");
}

function envelopeFor(rec: Recorded): { data: unknown; error: unknown } {
  if (rec.op === "delete") return { data: null, error: null };
  if (rec.op === "insert" || rec.op === "update") {
    return { data: H.insertedRow, error: null };
  }
  if (rec.table === "wallet_transactions" || rec.table === "usage_records") {
    return { data: H.ledgerRefs, error: null };
  }
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
        node.limit = (...args: unknown[]) => {
          rec.filters.push(["limit", ...args]);
          return Promise.resolve(envelopeFor(rec));
        };
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
    rpc: async (fn: string, args: Record<string, unknown>) => {
      H.rpcCalls.push({ fn, args });
      return { data: H.deductData, error: null };
    },
  };
}

/**
 * The anon client an API-key request would get: authenticated as nobody, so RLS
 * matches no row of `trace_history`. It records what it was ASKED for, which is
 * how a regression to it is named rather than merely detected.
 */
function blindAnonClient() {
  const node: Record<string, unknown> = {};
  const self = () => node;
  for (const m of ["eq", "neq", "gte", "lte", "lt", "gt", "is", "or", "in", "not", "limit"]) {
    node[m] = self;
  }
  const empty = { data: null, error: { code: "PGRST116", message: "no rows" } };
  node.single = () => Promise.resolve(empty);
  node.maybeSingle = () => Promise.resolve(empty);
  node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(res, rej);
  return {
    from: (table: string) => ({
      select: () => {
        H.anonSelects.push(table);
        return node;
      },
    }),
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => recordingClient(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => blindAnonClient(),
}));

vi.mock("@/lib/api/auth", () => ({
  validateApiKey: async () => ({ profile: H.profile }),
  isAuthError: (r: unknown) => Boolean((r as { response?: unknown })?.response),
}));

vi.mock("@/lib/tracerfy/client", () => ({
  submitSingleTrace: vi.fn(async () => ({ success: true, jobId: "tj-1" })),
  lookupBusinessTrace: vi.fn(async () => H.entity),
  lookupPersonTrace: vi.fn(async () => H.person),
}));

vi.mock("@/lib/tracerfy/dossier", () => ({
  lookupDossier: vi.fn(async () => H.dossier),
}));

vi.mock("@/lib/utils/auto-rebill", () => ({
  triggerAutoRebillIfNeeded: vi.fn(async () => undefined),
}));

const { POST } = await import("@/app/api/v1/trace/single/route");

/** No ownerName, so this is the automatic tier 2 trigger. */
const TIER2_BODY = {
  address: "123 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
};

const DOSSIER_MISS = {
  success: true,
  hit: false,
  owners: [],
  property: null,
  mailingAddress: null,
  creditsDeducted: 0,
};

function post(body: Record<string, unknown> = TIER2_BODY) {
  return POST(
    new Request("http://localhost/api/v1/trace/single", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
}

const deducts = () => H.rpcCalls.filter((c) => c.fn === "deduct_wallet_balance");
const webhooks = () => H.webhookPosts.filter((p) => p.body.event === "trace.completed");

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

/**
 * One address, submitted twice by the same caller, with the database in between:
 * whatever the first submit persisted is what the second submit's cache lookup
 * finds. This is the sequence the review describes, not an approximation of it.
 */
async function submitTwice() {
  const first = await (await post()).json();
  const row = persisted();
  H.cached = row ? { id: "trace-1", ...row } : null;
  H.survivingRow = { id: "trace-1" };
  const second = await (await post()).json();
  return { first, second };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.ops = [];
  H.anonSelects = [];
  H.cached = null;
  H.survivingRow = null;
  H.insertedRow = { id: "trace-1" };
  H.ledgerRefs = [];
  H.rpcCalls = [];
  H.deductData = true;
  H.dossier = DOSSIER_MISS;
  H.entity = { success: true, hit: false, contacts: null };
  H.person = { success: true, hit: false, contacts: null };
  H.webhookPosts = [];
  H.profile = {
    id: "user-1",
    subscription_tier: "pro",
    wallet_balance: 100,
    is_acquisition_pro_member: false,
    webhook_url: "https://hooks.example.invalid/ptp",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown, init: unknown) => {
    H.webhookPosts.push({
      url: String(url),
      body: JSON.parse(String((init as { body?: unknown })?.body ?? "{}")),
    });
    return new Response("{}", { status: 200 });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("v1 single trace — the cache lookup reaches the caller's own rows", () => {
  it("runs the lookup on a client that can see them, not on the session client", async () => {
    // The whole defect in one assertion. An API-key request carries no Supabase
    // session cookie, so a lookup built on the anon client matches zero rows and
    // both cache branches in the route are unreachable code.
    //
    // MUTATION: build checkSingleDuplicate's client from @/lib/supabase/server
    // again and this goes red.
    await post();

    expect(H.anonSelects).not.toContain("trace_history");
    expect(H.ops.some((o) => o.table === "trace_history" && o.filters.some((f) => f[0] === "or")))
      .toBe(true);
  });

  it("keys the lookup to the CALLER, unconditionally", async () => {
    // Moving off the anon client removes RLS as the backstop, so this filter is
    // the only thing between two customers who traced the same parcel. Serving
    // user B from user A's purchase would redistribute one customer's paid-for
    // data to another, which is the product rule and the vendor boundary both.
    //
    // MUTATION: delete `.eq('user_id', userId)` from checkSingleDuplicate and
    // this goes red.
    await post();

    const lookup = H.ops.find(
      (o) => o.table === "trace_history" && o.filters.some((f) => f[0] === "or")
    )!;
    expect(lookup.filters).toContainEqual(["eq", "user_id", "user-1"]);
  });
});

describe("v1 single trace — a repeat submit of a paid-for address", () => {
  it("is served from the caller's own row and charges nothing the second time", async () => {
    // WAS, until this fix: the lookup ran on the anon client, saw nothing, and
    // the identical call re-bought the dossier and charged the wallet again. Ten
    // calls for one address were ten charges.
    //
    // MUTATION: delete the isCacheHitRow branch, or point the lookup back at the
    // anon client, and this goes red.
    const { first, second } = await submitTwice();

    expect(first.charge).toBe(0.25);
    expect(deducts()).toHaveLength(1);
    expect(second).toMatchObject({ cached: true, charge: 0, traceId: "trace-1" });
  });

  it("calls no vendor on the second submit", async () => {
    const { lookupDossier } = await import("@/lib/tracerfy/dossier");

    await submitTwice();

    expect(lookupDossier).toHaveBeenCalledTimes(1);
  });

  it("fires trace.completed ONCE for one trace_id", async () => {
    // FIX 2, which falls out of FIX 1: the surviving row is REUSED rather than
    // re-inserted, so traceRecord.id was identical on the second submit and a
    // second webhook went out with the same trace_id and a second non-zero
    // charge. A consumer deduplicating on trace_id silently dropped the second
    // charge; one that did not, double-counted it.
    await submitTwice();

    expect(webhooks()).toHaveLength(1);
    expect(webhooks()[0].body).toMatchObject({ trace_id: "trace-1", charge: 0.25 });
  });

  it("re-buys once the stored row is outside the caller's reach", async () => {
    // The cache is not a promise never to charge. A lookup that finds nothing
    // still re-buys, which is correct: David's rule is that the charge follows
    // the vendor call.
    await post();
    H.cached = null;
    H.survivingRow = { id: "trace-1" };
    await post();

    expect(deducts()).toHaveLength(2);
  });
});
