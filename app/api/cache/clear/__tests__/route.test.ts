import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Delete fence for the "clear cache" route.
 *
 * This endpoint exists to let a user re-trace an address. It does that by
 * deleting trace_history rows, which are also billing receipts referenced by
 * `wallet_transactions.trace_history_id` (no ON DELETE clause => 23503).
 * Written as characterization tests FIRST (2026-09-17, phase 2).
 */

type Filter = [string, ...unknown[]];

interface Recorded {
  table: string;
  op: "delete";
  filters: Filter[];
}

const H = vi.hoisted(() => ({
  ops: [] as Array<{ table: string; op: "delete"; filters: Array<[string, ...unknown[]]> }>,
  user: { id: "user-1" } as { id: string } | null,
  deleteError: null as { message: string; code?: string } | null,
}));

function recordingClient() {
  return {
    from(table: string) {
      return {
        delete: () => {
          const rec: Recorded = { table, op: "delete", filters: [] };
          H.ops.push(rec);
          const node: Record<string, unknown> = {};
          const add =
            (method: string) =>
            (...args: unknown[]) => {
              rec.filters.push([method, ...args]);
              return node;
            };
          for (const m of ["eq", "neq", "is", "or", "lt", "gte"]) node[m] = add(m);
          node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve({ data: null, error: H.deleteError }).then(res, rej);
          return node;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: H.user } }) },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => recordingClient(),
}));

const { POST } = await import("@/app/api/cache/clear/route");

const BODY = { address: "123 Main St", city: "Austin", state: "TX", zip: "78701", type: "all" };

function post(body: Record<string, unknown> = BODY) {
  return POST(
    new Request("http://localhost/api/cache/clear", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
}

beforeEach(() => {
  H.ops = [];
  H.user = { id: "user-1" };
  H.deleteError = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/cache/clear", () => {
  it("401s with no session", async () => {
    H.user = null;
    const res = await post();
    expect(res.status).toBe(401);
    expect(H.ops).toHaveLength(0);
  });

  it("400s on an invalid address before deleting anything", async () => {
    const res = await post({ ...BODY, address: "" });
    expect(res.status).toBe(400);
    expect(H.ops).toHaveLength(0);
  });

  it("deletes this user's rows for this address hash", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(H.ops).toHaveLength(1);
    expect(H.ops[0].table).toBe("trace_history");
    expect(H.ops[0].filters.some((f) => f[0] === "eq" && f[1] === "user_id")).toBe(true);
    expect(H.ops[0].filters.some((f) => f[0] === "eq" && f[1] === "address_hash")).toBe(true);
  });

  it("reports the failure instead of claiming success when the delete errors", async () => {
    // Until 2026-09-17 this route ignored the error and answered {success:true}.
    // MUTATION: drop the `if (deleteError)` branch and this goes red.
    H.deleteError = { message: "violates foreign key constraint", code: "23503" };

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(String(body.error)).toContain("foreign key");
  });

  it("never targets a billed row", async () => {
    // A row carrying a charge, an AI research charge or a property record is a
    // receipt referenced by wallet_transactions. "Clear cache" means "let me
    // re-trace", not "destroy my receipt".
    // MUTATION: remove the excludeBilledRows() wrapper and this goes red.
    await post();

    const filters = H.ops[0].filters;
    expect(filters.some((f) => f[0] === "is" && f[1] === "property_record" && f[2] === null)).toBe(
      true
    );
    const orClauses = filters.filter((f) => f[0] === "or").map((f) => String(f[1]));
    expect(orClauses).toContain("charge.is.null,charge.lte.0");
    expect(orClauses).toContain("ai_research_charge.is.null,ai_research_charge.lte.0");
  });
});
