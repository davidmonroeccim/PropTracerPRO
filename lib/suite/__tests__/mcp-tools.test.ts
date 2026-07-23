import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePtpProfile } from "@/lib/suite/mcp-shared";
import {
  walletBalance,
  listTraces,
  skipTraceQuote,
  worstCaseCost,
  MAX_RECORDS,
  skipTraceBulk,
  bulkStatus,
} from "@/lib/suite/mcp-tools";
import { checkDuplicates } from "@/lib/utils/deduplication";
import { submitBulkTrace } from "@/lib/tracerfy/client";
import { settleBulkJob } from "@/lib/trace/settleBulkJob";

// Mock ONLY the boundary primitives that reach the network (submitBulkTrace,
// settleBulkJob) or the cookie-scoped server client (checkDuplicates). The pure
// helpers that actually enforce the guards -- removeBatchDuplicates,
// isLikelyBusiness, validateAddressInput, worstCaseCost -- stay REAL so the
// money fences are exercised for real, not stubbed away.
vi.mock("@/lib/utils/deduplication", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/deduplication")>();
  return { ...actual, checkDuplicates: vi.fn() };
});
vi.mock("@/lib/tracerfy/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tracerfy/client")>();
  return { ...actual, submitBulkTrace: vi.fn() };
});
vi.mock("@/lib/trace/settleBulkJob", () => ({ settleBulkJob: vi.fn() }));

beforeEach(() => {
  // Default: history dedup passes everything through as new.
  vi.mocked(checkDuplicates).mockReset();
  vi.mocked(checkDuplicates).mockImplementation(
    async (_userId, records) => ({ newRecords: records, duplicates: [], cachedResults: [] }),
  );
  // Default: Tracerfy bulk submit succeeds.
  vi.mocked(submitBulkTrace).mockReset();
  vi.mocked(submitBulkTrace).mockResolvedValue({ success: true, jobId: "tf-1" });
  // Default: settlement is a no-op (leaves rows untouched).
  vi.mocked(settleBulkJob).mockReset();
  vi.mocked(settleBulkJob).mockResolvedValue({ stalledErrorReason: null });
});

/** Admin stub whose from().select().eq().maybeSingle() resolves to `profile` (or `profileError` when
 *  set), whose from().select().eq().order().limit() resolves to `traces`, and whose
 *  from().select().eq().eq().gte() (walletBalance's today's-spend query) also resolves to `traces`
 *  (unused by the walletBalance tests below, which don't assert on mcp_spend_today).
 *  NOTE: adjusted from the brief's stub to add the `gte` terminal (walletBalance's actual chain awaits
 *  `.gte()` directly, not `.limit()` or `.maybeSingle()`); the implementation is the source of truth.
 *  `limitFn` lets a test capture the clamped value passed to `.limit(n)`. */
function adminStub({
  profile = null,
  profileError = null,
  traces = [],
  limitFn,
}: {
  profile?: unknown;
  profileError?: { message: string } | null;
  traces?: unknown[];
  limitFn?: (n: number) => void;
}) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    maybeSingle: async () => ({ data: profile, error: profileError }),
    limit: async (n: number) => {
      limitFn?.(n);
      return { data: traces, error: null };
    },
    gte: async () => ({ data: traces, error: null }),
  };
  return { from: () => chain } as never;
}

describe("resolvePtpProfile", () => {
  it("returns the linked profile", async () => {
    const admin = adminStub({ profile: { id: "p1", wallet_balance: 5 } });
    expect(await resolvePtpProfile(admin, "sub-1")).toMatchObject({ id: "p1", wallet_balance: 5 });
  });
  it("returns null for an unlinked gateway sub (genuine no-row: error null, data null)", async () => {
    const admin = adminStub({ profile: null, profileError: null });
    expect(await resolvePtpProfile(admin, "sub-x")).toBeNull();
  });
  it("throws (does not return null) on a real DB error, distinct from the no-row case", async () => {
    const admin = adminStub({ profile: null, profileError: { message: "db down" } });
    await expect(resolvePtpProfile(admin, "sub-1")).rejects.toThrow(/db down/);
  });
});

describe("walletBalance", () => {
  it("returns the balance for a linked user", async () => {
    const admin = adminStub({ profile: { id: "p1", wallet_balance: 12.5 } });
    const out = await walletBalance(admin, "sub-1");
    expect(out).toMatchObject({ wallet_balance: 12.5 });
  });
  it("returns the setup message for an unlinked user", async () => {
    const admin = adminStub({ profile: null });
    const out = await walletBalance(admin, "sub-x");
    expect(JSON.stringify(out)).toMatch(/Sign into PropTracerPRO/i);
  });
});

describe("listTraces", () => {
  it("returns the caller's own past traces", async () => {
    const admin = adminStub({ profile: { id: "p1", wallet_balance: 0 }, traces: [{ id: "t1" }] });
    const out = await listTraces(admin, "sub-1", { limit: 10 });
    expect(out).toMatchObject({ traces: [{ id: "t1" }] });
  });
  it("returns the setup message for an unlinked user", async () => {
    const admin = adminStub({ profile: null });
    const out = await listTraces(admin, "sub-x", {});
    expect(JSON.stringify(out)).toMatch(/Sign into PropTracerPRO/i);
  });

  describe("limit clamp", () => {
    it("clamps 0 up to the floor of 1", async () => {
      const limitFn = vi.fn();
      const admin = adminStub({ profile: { id: "p1", wallet_balance: 0 }, limitFn });
      await listTraces(admin, "sub-1", { limit: 0 });
      expect(limitFn).toHaveBeenCalledWith(1);
    });
    it("clamps 5000 down to the ceiling of 200", async () => {
      const limitFn = vi.fn();
      const admin = adminStub({ profile: { id: "p1", wallet_balance: 0 }, limitFn });
      await listTraces(admin, "sub-1", { limit: 5000 });
      expect(limitFn).toHaveBeenCalledWith(200);
    });
    it("defaults to 25 when no limit is given", async () => {
      const limitFn = vi.fn();
      const admin = adminStub({ profile: { id: "p1", wallet_balance: 0 }, limitFn });
      await listTraces(admin, "sub-1", {});
      expect(limitFn).toHaveBeenCalledWith(25);
    });
  });
});

describe("worstCaseCost", () => {
  const proProfile = { subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"] } as never;
  it("prices persons at the grant rate and entities at the $0.25 ceiling", () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    const out = worstCaseCost(
      [
        { owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" },
        { owner_name: "Acme LLC", address: "2 B St", city: "X", state: "TX", zip: "75001" },
      ],
      proProfile,
    );
    expect(out.persons).toBeCloseTo(0.07);
    expect(out.entities).toBeCloseTo(0.25);
    expect(out.total).toBeCloseTo(0.32);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });
});

/** skipTraceQuote's return type is a union of the quote payload and the readonly UNLINKED_MESSAGE
 *  literal; narrow to the quote branch so tests can access its fields without an `any`/`as` escape
 *  hatch. Throws (failing the test loudly) if a "linked" fixture unexpectedly comes back unlinked. */
function expectQuote(out: Awaited<ReturnType<typeof skipTraceQuote>>) {
  if ("error" in out) throw new Error(`expected a quote, got the unlinked message: ${out.message}`);
  return out;
}

describe("skip_trace_quote", () => {
  it("dedups, splits, and returns worst-case + balance + over-cap flag", async () => {
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"], wallet_balance: 1.0 } });
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    const out = await skipTraceQuote(admin, "sub-1", {
      records: [{ owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" }],
    });
    expect(out).toMatchObject({ wallet_balance: 1.0, over_cap: false });
    expect(expectQuote(out).worst_case_cost).toBeGreaterThan(0);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });
  it("flags a list over the 500 cap", async () => {
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"], wallet_balance: 0 } });
    const records = Array.from({ length: MAX_RECORDS + 1 }, (_, i) => ({ owner_name: `X ${i}`, address: `${i} A`, city: "X", state: "TX", zip: "75001" }));
    const out = await skipTraceQuote(admin, "sub-1", { records });
    expect(expectQuote(out).over_cap).toBe(true);
  });
  it("returns the setup message for an unlinked user", async () => {
    const admin = adminStub({ profile: null });
    const out = await skipTraceQuote(admin, "sub-x", { records: [{ owner_name: "A", address: "1", city: "X", state: "TX", zip: "1" }] });
    expect(JSON.stringify(out)).toMatch(/Sign into PropTracerPRO/i);
  });
  it("collapses duplicate addresses before pricing (real dedup, not a pass-through)", async () => {
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"], wallet_balance: 5 } });
    const dupe = { owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" };
    const out = expectQuote(await skipTraceQuote(admin, "sub-1", { records: [dupe, { ...dupe }, { ...dupe }] }));
    expect(out.submitted).toBe(3);
    expect(out.after_dedup).toBe(1);
    expect(out.duplicates_removed).toBe(2);
    expect(out.persons).toBe(1);
    expect(out.entities).toBe(0);
  });
  it("splits a mixed batch into the correct person/entity counts", async () => {
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"], wallet_balance: 5 } });
    const out = expectQuote(
      await skipTraceQuote(admin, "sub-1", {
        records: [
          { owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" },
          { owner_name: "Acme LLC", address: "2 B St", city: "X", state: "TX", zip: "75001" },
          { owner_name: "Jane Realty Holdings", address: "3 C St", city: "X", state: "TX", zip: "75001" },
          { address: "4 D St", city: "X", state: "TX", zip: "75001" },
        ],
      }),
    );
    expect(out.persons).toBe(2);
    expect(out.entities).toBe(2);
    expect(out.after_dedup).toBe(4);
  });
});

// ---- Task 6: skip_trace_bulk (guarded submit) --------------------------------

/** Richer admin stub for the submit path: routes by table, captures the
 *  trace_jobs insert payload and the trace_history upsert batches, and returns a
 *  created job id from `.insert().select().single()`. `.then` makes the builder
 *  awaitable for the fire-and-forget trace_jobs updates. */
function submitAdminStub(opts: {
  profile: unknown;
  jobId?: string;
  jobInsertError?: { message: string } | null;
}) {
  const { profile, jobId = "job-1", jobInsertError = null } = opts;
  const captured = {
    traceJobsInsert: undefined as Record<string, unknown> | undefined,
    traceJobsUpdates: [] as unknown[],
    traceHistoryUpserts: [] as Array<{ batch: Array<Record<string, unknown>>; opts: unknown }>,
  };
  const chainFor = (table: string) => {
    let op: "insert" | "update" | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      insert: (payload: Record<string, unknown>) => {
        op = "insert";
        if (table === "trace_jobs") captured.traceJobsInsert = payload;
        return chain;
      },
      update: (payload: unknown) => {
        op = "update";
        if (table === "trace_jobs") captured.traceJobsUpdates.push(payload);
        return chain;
      },
      upsert: async (batch: Array<Record<string, unknown>>, upsertOpts: unknown) => {
        if (table === "trace_history") captured.traceHistoryUpserts.push({ batch, opts: upsertOpts });
        return { error: null };
      },
      single: async () =>
        table === "trace_jobs" && op === "insert"
          ? jobInsertError
            ? { data: null, error: jobInsertError }
            : { data: { id: jobId }, error: null }
          : { data: null, error: null },
      maybeSingle: async () =>
        table === "user_profiles" ? { data: profile, error: null } : { data: null, error: null },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
    };
    return chain;
  };
  return { admin: { from: (t: string) => chainFor(t) } as never, captured };
}

describe("skip_trace_bulk", () => {
  const linked = {
    id: "p1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: ["prop-tracer-pro"],
    wallet_balance: 100,
  };

  it("returns the setup message for an unlinked user, before any spend", async () => {
    const { admin } = submitAdminStub({ profile: null });
    const out = await skipTraceBulk(admin, "sub-x", {
      records: [{ owner_name: "A", address: "1", city: "X", state: "TX", zip: "1" }],
      confirm: true,
    });
    expect(JSON.stringify(out)).toMatch(/Sign into PropTracerPRO/i);
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });

  it("rejects a missing confirm (no submit, no spend)", async () => {
    const { admin } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ owner_name: "A", address: "1", city: "X", state: "TX", zip: "1" }],
    });
    expect(JSON.stringify(out)).toMatch(/confirm/i);
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });

  it("rejects a list over the 500 cap (no submit)", async () => {
    const { admin } = submitAdminStub({ profile: linked });
    const records = Array.from({ length: MAX_RECORDS + 1 }, (_, i) => ({
      owner_name: `X ${i}`,
      address: `${i} A`,
      city: "X",
      state: "TX",
      zip: "1",
    }));
    const out = await skipTraceBulk(admin, "sub-1", { records, confirm: true });
    expect(JSON.stringify(out)).toMatch(/500/);
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });

  it("402s when the worst-case exceeds the wallet (no submit, no spend)", async () => {
    const { admin } = submitAdminStub({ profile: { ...linked, wallet_balance: 0 } });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ owner_name: "A", address: "1", city: "X", state: "TX", zip: "1" }],
      confirm: true,
    });
    expect(JSON.stringify(out)).toMatch(/balance|402|insufficient/i);
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });

  it("writes source:'mcp' on the trace_jobs insert AND the trace_history rows, then submits", async () => {
    const { admin, captured } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [
        { owner_name: "John Smith", address: "100 Main St", city: "Dallas", state: "TX", zip: "75001" },
      ],
      confirm: true,
    });
    // Fence #5: source:'mcp' on the job row.
    expect(captured.traceJobsInsert).toMatchObject({ source: "mcp", status: "processing", user_id: "p1" });
    // ...and on every trace_history row.
    const allRows = captured.traceHistoryUpserts.flatMap((u) => u.batch);
    expect(allRows.length).toBeGreaterThan(0);
    for (const r of allRows) expect(r).toMatchObject({ source: "mcp" });
    expect(submitBulkTrace).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ job_id: "job-1", accepted: 1, persons: 1, entities: 0 });
  });
});

// ---- Task 6: bulk_status (shared settlement + ownership fence) ----------------

/** Admin stub for the poll/settle path: profile + job come back from
 *  `.maybeSingle()` keyed by table; the trace_history rows come back from the
 *  awaited (`.then`) builder. */
function statusAdminStub(opts: { profile: unknown; job: unknown; rows?: unknown[] }) {
  const { profile, job, rows = [] } = opts;
  const captured = { traceJobsUpdates: [] as unknown[] };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      update: (payload: unknown) => {
        if (table === "trace_jobs") captured.traceJobsUpdates.push(payload);
        return chain;
      },
      maybeSingle: async () =>
        table === "user_profiles"
          ? { data: profile, error: null }
          : table === "trace_jobs"
            ? { data: job, error: null }
            : { data: null, error: null },
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === "trace_history" ? rows : null, error: null }),
    };
    return chain;
  };
  return { admin: { from: (t: string) => chainFor(t) } as never, captured };
}

describe("bulk_status", () => {
  const profile = {
    id: "p1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: ["prop-tracer-pro"],
    wallet_balance: 50,
  };

  it("returns the setup message for an unlinked user", async () => {
    const { admin } = statusAdminStub({ profile: null, job: null });
    const out = await bulkStatus(admin, "sub-x", { job_id: "job-1" });
    expect(JSON.stringify(out)).toMatch(/Sign into PropTracerPRO/i);
    expect(settleBulkJob).not.toHaveBeenCalled();
  });

  it("returns not_found when the job does not exist", async () => {
    const { admin } = statusAdminStub({ profile, job: null });
    const out = await bulkStatus(admin, "sub-1", { job_id: "missing" });
    expect(out).toMatchObject({ error: "not_found" });
    expect(settleBulkJob).not.toHaveBeenCalled();
  });

  it("OWNERSHIP FENCE: a job owned by another user returns forbidden and settles nothing", async () => {
    const { admin } = statusAdminStub({
      profile,
      job: { id: "job-1", user_id: "someone-else", status: "processing", records_submitted: 1 },
      rows: [
        {
          id: "r1",
          status: "processing",
          tracerfy_job_id: "tf-1",
          is_successful: null,
          charge: 0,
          ai_research_status: null,
        },
      ],
    });
    const out = await bulkStatus(admin, "sub-1", { job_id: "job-1" });
    expect(out).toMatchObject({ error: "forbidden" });
    // The money fence: no settlement / wallet RPC for a non-owner.
    expect(settleBulkJob).not.toHaveBeenCalled();
  });

  it("settles unresolved buckets through the shared path with the grant-aware person rate", async () => {
    const { admin } = statusAdminStub({
      profile,
      job: { id: "job-1", user_id: "p1", status: "processing", records_submitted: 1 },
      rows: [
        {
          id: "r1",
          status: "processing",
          tracerfy_job_id: "tf-1",
          is_successful: null,
          charge: 0,
          ai_research_status: null,
        },
      ],
    });
    const out = await bulkStatus(admin, "sub-1", { job_id: "job-1" });
    expect(settleBulkJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(settleBulkJob).mock.calls[0][1]).toMatchObject({
      tracerfyJobId: "tf-1",
      userId: "p1",
      personRate: 0.11,
    });
    // The no-op settle left the row 'processing', so the job is still in flight.
    expect(out).toMatchObject({ status: "processing", job_id: "job-1" });
  });
});
