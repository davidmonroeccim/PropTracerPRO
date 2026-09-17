import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";

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
  submit: { success: true, jobId: "tj-1" } as {
    success: boolean;
    jobId?: string;
    error?: string;
  },
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
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: H.user } }) },
    ...recordingClient(),
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => recordingClient(),
}));

vi.mock("@/lib/utils/deduplication", () => ({
  checkSingleDuplicate: vi.fn(async () => H.cached),
}));

vi.mock("@/lib/tracerfy/client", () => ({
  submitSingleTrace: vi.fn(async () => H.submit),
}));

const { POST } = await import("@/app/api/trace/single/route");

const BODY = {
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
  H.user = { id: "user-1" };
  H.cached = null;
  H.insertedRow = { id: "trace-new" };
  H.insertError = null;
  H.deleteError = null;
  H.survivingRow = null;
  H.submit = { success: true, jobId: "tj-1" };
  H.profile = {
    id: "user-1",
    subscription_tier: "wallet",
    wallet_balance: 100,
    is_acquisition_pro_member: false,
    gateway_products: null,
  };
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
      trace_result: { phones: ["512-555-0100"], emails: [] },
    };

    const res = await post();
    const body = await res.json();

    expect(body).toMatchObject({ success: true, is_cached: true, charge: 0, trace_id: "trace-cached" });
    expect(deletes()).toHaveLength(0);
    expect(H.ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("emails alone count as contact data", async () => {
    H.cached = { id: "trace-cached", trace_result: { phones: [], emails: ["a@b.com"] } };
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
    const { checkSingleDuplicate } = await import("@/lib/utils/deduplication");
    await post({ ...BODY, skip_cache: true });
    expect(checkSingleDuplicate).not.toHaveBeenCalled();
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

describe("POST /api/trace/single — row creation and submission", () => {
  it("inserts a processing row and returns the Tracerfy job id", async () => {
    const res = await post();
    const body = await res.json();

    const insert = H.ops.find((o) => o.op === "insert");
    expect(insert).toBeDefined();
    expect(insert!.payload).toMatchObject({
      user_id: "user-1",
      city: "AUSTIN",
      state: "TX",
      zip: "78701",
      status: "processing",
    });
    expect(body).toMatchObject({
      success: true,
      status: "processing",
      trace_id: "trace-new",
      tracerfy_job_id: "tj-1",
    });
  });

  it("500s when the row cannot be created", async () => {
    H.insertError = { message: "duplicate key value violates unique constraint", code: "23505" };
    const res = await post();
    expect(res.status).toBe(500);
  });

  it("marks the row errored and 500s when Tracerfy refuses the submission", async () => {
    H.submit = { success: false, error: "Tracerfy down" };

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Tracerfy down");
    const statusUpdate = H.ops.find(
      (o) => o.op === "update" && (o.payload as Record<string, unknown>)?.status === "error"
    );
    expect(statusUpdate).toBeDefined();
  });
});
