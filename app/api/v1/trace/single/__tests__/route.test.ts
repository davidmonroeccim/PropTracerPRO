import { beforeEach, describe, expect, it, vi } from "vitest";

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
  if (rec.op === "update") return { data: H.insertedRow, error: null };
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
    rpc: async () => ({ data: true, error: null }),
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => recordingClient(),
}));

vi.mock("@/lib/api/auth", () => ({
  validateApiKey: async () => ({ profile: H.profile }),
  isAuthError: (r: unknown) => Boolean((r as { response?: unknown })?.response),
}));

vi.mock("@/lib/utils/deduplication", () => ({
  checkSingleDuplicate: vi.fn(async () => H.cached),
}));

vi.mock("@/lib/tracerfy/client", () => ({
  submitSingleTrace: vi.fn(async () => H.submit),
}));

vi.mock("@/lib/ai-research/client", () => ({
  researchProperty: vi.fn(async () => ({ owner_name: null })),
}));

const { POST } = await import("@/app/api/v1/trace/single/route");

const BODY = {
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
  H.submit = { success: true, jobId: "tj-1" };
  H.profile = {
    id: "user-1",
    subscription_tier: "pro",
    wallet_balance: 100,
    is_acquisition_pro_member: false,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/v1/trace/single — gates", () => {
  it("400s on an invalid address before touching the database", async () => {
    const res = await post({ ...BODY, address: "" });
    expect(res.status).toBe(400);
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
    H.cached = { id: "trace-cached", trace_result: { phones: ["512-555-0100"], emails: [] } };

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

describe("POST /api/v1/trace/single — row creation and submission", () => {
  it("inserts a processing row and returns the Tracerfy job id", async () => {
    const body = await (await post()).json();

    const insert = H.ops.find((o) => o.op === "insert");
    expect(insert!.payload).toMatchObject({
      user_id: "user-1",
      city: "AUSTIN",
      state: "TX",
      status: "processing",
    });
    expect(body).toMatchObject({ success: true, status: "processing", traceId: "trace-new" });
  });

  it("500s when the row cannot be created", async () => {
    H.insertError = { message: "duplicate key value violates unique constraint", code: "23505" };
    const res = await post();
    expect(res.status).toBe(500);
  });

  it("marks the row errored and 500s when Tracerfy refuses the submission", async () => {
    H.submit = { success: false, error: "Tracerfy down" };

    const body = await (await post()).json();

    expect(body.error).toBe("Tracerfy down");
    expect(
      H.ops.some(
        (o) => o.op === "update" && (o.payload as Record<string, unknown>)?.status === "error"
      )
    ).toBe(true);
  });
});
