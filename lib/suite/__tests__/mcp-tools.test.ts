import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePtpProfile } from "@/lib/suite/mcp-shared";
import {
  walletBalance,
  listTraces,
  skipTraceQuote,
  worstCaseCost,
  isEntityRecord,
  isBlankOwnerRecord,
  MAX_RECORDS,
  skipTraceBulk,
  bulkStatus,
} from "@/lib/suite/mcp-tools";
import { PRICING } from "@/lib/constants";
import { BLANK_OWNER_SKIP_REASON, BLANK_OWNER_SKIP_STATUS } from "@/lib/trace/blankOwnerSkip";
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

  // list_traces used to return input_owner_name (the COMPANY) plus bare phone/email COUNTS
  // and no contact at all, so an agent reviewing past traces could not see who was found.
  it("names the resolved contact person on each listed trace", async () => {
    const admin = adminStub({
      profile: { id: "p1", wallet_balance: 0 },
      traces: [
        {
          id: "t1",
          input_owner_name: "Magnolia Property Company",
          trace_result: { owner_name: "Daniel Hamann" },
          ai_research: {
            owner_name: "Magnolia Property Company",
            owner_type: "business",
            business_trace_contacts: { owner_name: "Daniel Hamann" },
          },
        },
      ],
    });
    const out = (await listTraces(admin, "sub-1", { limit: 10 })) as {
      traces: Array<{ owner_contact_name: string | null; owner_contact_source: string | null }>;
    };
    expect(out.traces[0].owner_contact_name).toBe("Daniel Hamann");
    expect(out.traces[0].owner_contact_source).toBe("fastappend");
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

describe("isEntityRecord (single source of truth for the person/entity split)", () => {
  // The gate (worstCaseCost) and the submit split (skipTraceBulk) both classify through this one
  // helper, so they can never disagree. Entity == empty/absent/whitespace owner OR a business name.
  it("treats an empty owner_name as an ENTITY (routes to FastAppend)", () => {
    expect(isEntityRecord("")).toBe(true);
  });
  it("treats an absent owner_name as an ENTITY", () => {
    expect(isEntityRecord(undefined)).toBe(true);
  });
  it("treats a whitespace-only owner_name as an ENTITY", () => {
    expect(isEntityRecord("   ")).toBe(true);
  });
  it("treats a plain person name as NOT an entity", () => {
    expect(isEntityRecord("John Smith")).toBe(false);
  });
  it("treats a business name as an ENTITY", () => {
    expect(isEntityRecord("Acme LLC")).toBe(true);
  });
});

describe("worstCaseCost", () => {
  const proProfile = { subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"] } as never;
  const walletProfile = { subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: [] } as never;

  /** REWRITTEN 2026-09-17 for the removal of AI Search. These assertions used to pin an entity
   *  record at `tier1Rate + AI_RESEARCH.CHARGE_PER_RECORD`, because the entity route booked BOTH:
   *  the old sweep-bulk-research cron charged a $0.15 research fee the moment it identified an
   *  owner, and settleBulkJob charged the tier 1 rate on top when contacts landed. That cron is
   *  gone and nothing books the research fee any more, so keeping the old ceiling would have
   *  over-quoted every entity record by $0.15 before a wallet spend. The fences below are the same
   *  fences, re-pointed at the model that is now true.
   *
   *  What an ENTITY record can cost end to end: ONE tier 1 per-success charge, the same as a
   *  person. Owner type picks the vendor (FastAppend vs Tracerfy) and never the price. */
  const entityCeiling = (tier1Rate: number) => tier1Rate;

  /** The reserve app/api/v1/trace/bulk/route.ts computes for the same batch: every record that
   *  has an owner of record, at the tier 1 rate. A blank-owner record contributes nothing there
   *  because it is skipped rather than traced, so it must contribute nothing here either. The MCP
   *  gate must never come out below this for the rate that surface settles at. */
  const v1Reserve = (records: { owner_name?: string }[], tier1Rate: number) =>
    records.filter((r) => !isBlankOwnerRecord(r.owner_name)).length * tier1Rate;

  it("prices persons and named entities at the same tier 1 rate, with no research fee", () => {
    // MUTATION: add AI_RESEARCH.CHARGE_PER_RECORD back onto the entity arm and this goes red.
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    const out = worstCaseCost(
      [
        { owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" },
        { owner_name: "Acme LLC", address: "2 B St", city: "X", state: "TX", zip: "75001" },
      ],
      proProfile,
    );
    expect(out.persons).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS);
    expect(out.entities).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS);
    expect(out.total).toBeCloseTo(2 * PRICING.CHARGE_PER_SUCCESS);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });

  // MONEY-GATE FENCE (defect 2, 2026-09-16, re-pointed 2026-09-17). The MCP gate must never
  // reserve LESS than the v1 route reserves for the same batch, or the MCP submits work the
  // wallet cannot cover. Both surfaces now reserve one tier 1 charge per traceable record.
  it("never reserves less than the v1 bulk route does for the same batch", () => {
    const records = [
      { owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" },
      { owner_name: "Acme LLC", address: "2 B St", city: "X", state: "TX", zip: "75001" },
      { owner_name: "Jane Realty Holdings", address: "3 C St", city: "X", state: "TX", zip: "75001" },
      { address: "4 D St", city: "X", state: "TX", zip: "75001" },
    ];
    // Non-grant profile: both surfaces use the same tier 1 rate, so the two reserves must match.
    const wallet = worstCaseCost(records, walletProfile);
    expect(wallet.total).toBeGreaterThanOrEqual(v1Reserve(records, PRICING.CHARGE_PER_SUCCESS_WALLET));
    expect(wallet.total).toBeCloseTo(v1Reserve(records, PRICING.CHARGE_PER_SUCCESS_WALLET));

    // Grant holder: the MCP settles at the lower grant rate, so that is the rate it must cover.
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    const grant = worstCaseCost(records, proProfile);
    expect(grant.total).toBeGreaterThanOrEqual(v1Reserve(records, PRICING.CHARGE_PER_SUCCESS));
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });

  // MONEY-GATE CORRECTNESS, the case that changed. An address-only record has NO route on this
  // surface: the engine that used to find an owner from an address alone is gone, so the record
  // is skipped with a reason and never charged. Reserving anything for it would quote a caller
  // money the submit cannot spend and would 402 a wallet that can afford the real batch.
  // MUTATION: price it as an entity (drop the isBlankOwnerRecord guard) and this goes red.
  it("reserves NOTHING for an address-only record with no owner_name", () => {
    const out = worstCaseCost(
      [{ address: "4 D St", city: "X", state: "TX", zip: "75001" }],
      walletProfile,
    );
    expect(out.persons).toBe(0);
    expect(out.entities).toBe(0);
    expect(out.total).toBe(0);
  });

  it("reserves nothing for a whitespace-only owner_name either", () => {
    const out = worstCaseCost(
      [{ owner_name: "   ", address: "5 E St", city: "X", state: "TX", zip: "75001" }],
      walletProfile,
    );
    expect(out.total).toBe(0);
  });

  it("prices a business-name record at the bare tier 1 rate", () => {
    const out = worstCaseCost(
      [{ owner_name: "Acme LLC", address: "2 B St", city: "X", state: "TX", zip: "75001" }],
      walletProfile,
    );
    expect(out.entities).toBeCloseTo(entityCeiling(PRICING.CHARGE_PER_SUCCESS_WALLET));
    expect(out.persons).toBe(0);
  });

  it("prices a plain-person-name record at the bare tier 1 rate", () => {
    const out = worstCaseCost(
      [{ owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" }],
      walletProfile,
    );
    expect(out.persons).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(out.entities).toBe(0);
  });

  // CONSISTENCY: the set worstCaseCost prices as entities is EXACTLY the set skipTraceBulk routes
  // to entityRecords, because both classify through isEntityRecord AND isBlankOwnerRecord.
  it("prices exactly the named-entity set as entities (gate == submit split)", () => {
    const records = [
      { owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" }, // person
      { owner_name: "Acme LLC", address: "2 B St", city: "X", state: "TX", zip: "75001" }, // entity
      { owner_name: "Jane Realty Holdings", address: "3 C St", city: "X", state: "TX", zip: "75001" }, // entity
      { address: "4 D St", city: "X", state: "TX", zip: "75001" }, // skipped (no owner)
      { owner_name: "   ", address: "5 E St", city: "X", state: "TX", zip: "75001" }, // skipped (whitespace)
    ];
    const expectedEntities = records.filter(
      (r) => isEntityRecord(r.owner_name) && !isBlankOwnerRecord(r.owner_name),
    ).length;
    const out = worstCaseCost(records, walletProfile);
    const pricedAsEntities = Math.round(
      out.entities / entityCeiling(PRICING.CHARGE_PER_SUCCESS_WALLET),
    );
    expect(pricedAsEntities).toBe(expectedEntities); // 2
    expect(pricedAsEntities).toBe(2);
    // And the two skipped records are priced at nothing, not folded into persons.
    expect(out.persons).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET);
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
          { owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" }, // person
          { owner_name: "Acme LLC", address: "2 B St", city: "X", state: "TX", zip: "75001" }, // entity
          { owner_name: "Jane Realty Holdings", address: "3 C St", city: "X", state: "TX", zip: "75001" }, // entity
          { address: "4 D St", city: "X", state: "TX", zip: "75001" }, // entity: no owner_name -> FastAppend
        ],
      }),
    );
    // The address-only record is neither a person nor a traceable entity: it is SKIPPED, and
    // reported as such with the reason, so the caller can see why it came back empty and free.
    expect(out.persons).toBe(1);
    expect(out.entities).toBe(2);
    expect(out.skipped).toBe(1);
    expect(out.skipped_reason).toBe(BLANK_OWNER_SKIP_REASON);
    expect(out.after_dedup).toBe(4);
    // And the skipped record costs nothing: three traceable records at the wallet tier 1 rate.
    expect(out.worst_case_cost).toBeCloseTo(3 * PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("reports no skip reason when every record has an owner", () => {
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: [], wallet_balance: 5 } });
    return skipTraceQuote(admin, "sub-1", {
      records: [{ owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" }],
    }).then((raw) => {
      const out = expectQuote(raw);
      expect(out.skipped).toBe(0);
      expect(out.skipped_reason).toBeNull();
    });
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

  it("SKIPS an address-only record (NO owner_name) instead of queueing it, and charges nothing", async () => {
    // Submit-split side of the money-gate consistency, rewritten 2026-09-17. This record used to
    // be queued to the AI Search cron, which went and found an owner from the web. That engine is
    // gone, so queueing it now would park the row in 'queued' forever behind a cron that cannot
    // resolve it, and hold the whole bulk job open. It is accepted, written terminal with the
    // skip status, and never charged.
    // MUTATION: route it to entityRecords (drop the isBlankOwnerRecord arm) and this goes red on
    // both the counts and the ai_research_status of the upserted row.
    const { admin, captured } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ address: "100 Main St", city: "Dallas", state: "TX", zip: "75001" }],
      confirm: true,
    });
    expect(out).toMatchObject({
      job_id: "job-1",
      accepted: 1,
      persons: 0,
      entities: 0,
      skipped: 1,
      skipped_reason: BLANK_OWNER_SKIP_REASON,
      committed_worst_case: 0,
    });
    // Not submitted to Tracerfy either: no vendor is asked about this record at all.
    expect(submitBulkTrace).not.toHaveBeenCalled();

    const rows = captured.traceHistoryUpserts.flatMap((u) => u.batch) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ai_research_status: BLANK_OWNER_SKIP_STATUS,
      status: "no_match",
      input_owner_name: null,
    });
    // Nothing money-shaped is written, so the row is not a receipt and stays deletable.
    for (const paid of ["charge", "ai_research_charge", "tier"]) {
      expect(Object.keys(rows[0])).not.toContain(paid);
    }
    // And it is NOT queued, so no cron is left waiting on an engine that no longer exists.
    expect(rows[0].ai_research_status).not.toBe("queued");
  });

  it("still queues a NAMED entity for the business trace", async () => {
    // The other half of the split: a company name is a real owner of record, so it keeps its
    // route and keeps reserving one tier 1 charge.
    const { admin, captured } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ owner_name: "Acme Holdings LLC", address: "100 Main St", city: "Dallas", state: "TX", zip: "75001" }],
      confirm: true,
    });
    expect(out).toMatchObject({ accepted: 1, persons: 0, entities: 1, skipped: 0 });
    const rows = captured.traceHistoryUpserts.flatMap((u) => u.batch) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ ai_research_status: "queued", status: "processing" });
    expect(submitBulkTrace).not.toHaveBeenCalled();
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
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });
    // The no-op settle left the row 'processing', so the job is still in flight.
    expect(out).toMatchObject({ status: "processing", job_id: "job-1" });
  });

  // DEFECT 3 FENCE (2026-09-16): a finalized job's total_charge must SUM THE STORED per-row
  // charges, never records_matched x a live rate. The rate moves, the history does not, so the
  // old formula restated every past job the instant a pricing constant changed. The row charges
  // below are deliberately amounts no current constant produces, so restoring
  // `records_matched * personRate` cannot coincidentally pass.
  it("totals a finalized job from the stored per-row charges, not from a live rate", async () => {
    const { admin } = statusAdminStub({
      profile,
      job: {
        id: "job-1",
        user_id: "p1",
        status: "completed",
        records_submitted: 3,
        records_matched: 2,
      },
      rows: [
        { id: "r1", status: "success", is_successful: true, charge: 0.07, ai_research_status: null },
        { id: "r2", status: "success", is_successful: true, charge: 0.11, ai_research_status: null },
        { id: "r3", status: "no_match", is_successful: false, charge: 0, ai_research_status: null },
      ],
    });
    const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
      status: string;
      total_charge: number;
    };
    expect(out.status).toBe("completed");
    expect(out.total_charge).toBeCloseTo(0.18);
    // What the old formula would have reported for this same job.
    expect(out.total_charge).not.toBeCloseTo(2 * PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(settleBulkJob).not.toHaveBeenCalled();
  });

  it("RE-POLL IDEMPOTENCY: only still-processing rows enter the settlement bucket, never already-settled rows", async () => {
    // A second poll must never re-charge rows already settled on an earlier poll.
    // This fences the MCP-level bucketing filter (`row.status !== "processing"
    // continue`) specifically. settleBulkJob ALSO has its own internal
    // `status === "processing"` guard as a second defense layer; this test does
    // not rely on that -- it proves the MCP tool never even hands settled rows to
    // settleBulkJob in the first place.
    const { admin } = statusAdminStub({
      profile,
      job: { id: "job-1", user_id: "p1", status: "processing", records_submitted: 3 },
      rows: [
        // already settled on a prior poll -- must be excluded from the bucket
        { id: "r1", status: "success", tracerfy_job_id: "tf-1", is_successful: true, charge: PRICING.CHARGE_PER_SUCCESS_WALLET, ai_research_status: null },
        { id: "r2", status: "no_match", tracerfy_job_id: "tf-1", is_successful: false, charge: 0, ai_research_status: null },
        // still in flight -- the only row that should be settled this round
        { id: "r3", status: "processing", tracerfy_job_id: "tf-1", is_successful: null, charge: 0, ai_research_status: null },
      ],
    });
    await bulkStatus(admin, "sub-1", { job_id: "job-1" });
    expect(settleBulkJob).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(settleBulkJob).mock.calls[0][1] as {
      bucketRows: Array<{ id: string; status: string }>;
    };
    expect(arg.bucketRows.map((r) => r.id)).toEqual(["r3"]);
    for (const r of arg.bucketRows) expect(r.status).toBe("processing");
  });

  // Regression: the 2026-08-13 Dallas run resolved a person behind every entity, but the
  // delivered CSV carried only the company name, its phone and the person's email. The
  // person WAS in the payload -- as trace_result.owner_name, a key that reads as a
  // restatement of the owner the consumer already had -- so it was discarded. The payload
  // must name the resolved person for what it is.
  it("names the resolved contact person at the top level of each per-record result", async () => {
    const { admin } = statusAdminStub({
      profile,
      job: {
        id: "job-1",
        user_id: "p1",
        status: "completed",
        records_submitted: 2,
        records_matched: 2,
      },
      rows: [
        {
          id: "r1",
          status: "success",
          normalized_address: "1904 AIRPORT FWY|BEDFORD|TX|76022",
          input_owner_name: "Magnolia Property Company",
          is_successful: true,
          charge: 0.25,
          ai_research_status: "found",
          trace_result: { owner_name: "Daniel Hamann", phones: [], emails: [] },
          ai_research: {
            owner_name: "Magnolia Property Company",
            owner_type: "business",
            individual_behind_business: "Daniel Hamann",
            business_trace_contacts: {
              owner_name: "Daniel Hamann",
              phones: [],
              emails: ["dhamann2@gmail.com"],
              address: null,
            },
          },
        },
        // An entity with NO resolved human must stay empty, never fall back to the LLC.
        {
          id: "r2",
          status: "no_match",
          normalized_address: "4846 E 62ND ST|INDIANAPOLIS|IN|46220",
          input_owner_name: "Fountain Parc Apartments LLC",
          is_successful: false,
          charge: 0,
          ai_research_status: "found",
          trace_result: null,
          ai_research: {
            owner_name: "Fountain Parc Apartments LLC",
            owner_type: "business",
          },
        },
      ],
    });

    const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
      results: Array<{
        input_owner_name: string;
        owner_contact_name: string | null;
        owner_contact_source: string | null;
      }>;
    };

    const magnolia = out.results.find((r) => r.input_owner_name === "Magnolia Property Company")!;
    expect(magnolia.owner_contact_name).toBe("Daniel Hamann");
    expect(magnolia.owner_contact_source).toBe("fastappend");

    const fountain = out.results.find(
      (r) => r.input_owner_name === "Fountain Parc Apartments LLC",
    )!;
    expect(fountain.owner_contact_name).toBeNull();
    expect(fountain.owner_contact_source).toBeNull();
  });
});
