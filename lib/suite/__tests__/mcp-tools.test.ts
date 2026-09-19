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
  recordSchema,
} from "@/lib/suite/mcp-tools";
import { PRICING } from "@/lib/constants";
import { chargePerRecord } from "@/lib/suite/pricing";
import { queuedStatusFor } from "@/lib/trace/propertyTraceAttempts";
import { checkDuplicates } from "@/lib/utils/deduplication";
import { submitBulkTrace } from "@/lib/tracerfy/client";
import { settleBulkJob } from "@/lib/trace/settleBulkJob";
import { BLOCKED_PROPERTY_RECORD_KEYS } from "@/lib/trace/publicPropertyRecord";
import entityHitAddress from "@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json";

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

/** Levers for the two pre-flight checks. Defaults are the healthy case: PTP can run the job and
 *  the caller owes nothing on work already accepted. */
const H = vi.hoisted(() => ({ canRunTier2: true, inFlight: 0 }));

// The two pre-flight checks are boundary-shaped in the same way: one reaches Tracerfy's
// analytics endpoint over the network and the other runs an aggregate query this file's admin
// stub is not built for. Both are covered for real in lib/trace/__tests__/bulkPreflight.test.ts,
// so here they are levers. The real money fence for this surface, worstCaseCost, stays REAL.
vi.mock("@/lib/trace/bulkPreflight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trace/bulkPreflight")>();
  return {
    ...actual,
    // Faithful to the real contract: a batch with no tier 2 records asks no vendor and can
    // never be refused. Without that short circuit a submit passing the wrong count would
    // still look correct.
    tracerfyCanRunTier2: vi.fn(async (_admin: unknown, n: number) => (n <= 0 ? true : H.canRunTier2)),
    inFlightUnbilledCost: vi.fn(async () => H.inFlight),
  };
});

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
  // Default pre-flight: PTP can run the job and the caller owes nothing on work
  // already accepted. Both are reset per test so one refusal cannot leak forward.
  H.canRunTier2 = true;
  H.inFlight = 0;
});

/** POSTGREST COLUMN PROJECTION, EMULATED. A column the query never asked for does not come
 *  back, and a stub that ignores `.select(...)` hides exactly that: a test asserting on
 *  `property_record` would stay green even after the column was dropped from the select, which
 *  is the failure that looks identical to success. `*` passes everything through. Only keys the
 *  row actually carries are copied, so an absent column stays absent rather than becoming an
 *  explicit `undefined`. */
function projectRow(row: unknown, select: string): unknown {
  if (select.trim() === "*") return row;
  const columns = new Set(select.split(",").map((c) => c.trim()));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (columns.has(key)) out[key] = value;
  }
  return out;
}

/** Admin stub whose from().select().eq().maybeSingle() resolves to `profile` (or `profileError` when
 *  set), whose from().select().eq().order().limit() resolves to `traces`, and whose
 *  from().select().eq().eq().gte() (walletBalance's today's-spend query) also resolves to `traces`
 *  (unused by the walletBalance tests below, which don't assert on mcp_spend_today).
 *  NOTE: adjusted from the brief's stub to add the `gte` terminal (walletBalance's actual chain awaits
 *  `.gte()` directly, not `.limit()` or `.maybeSingle()`); the implementation is the source of truth.
 *  `limitFn` lets a test capture the clamped value passed to `.limit(n)`.
 *  The `.limit()` terminal PROJECTS through the last `.select(...)` string, so listTraces only ever
 *  sees the columns it actually asked for. */
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
  // The trace_history select is the LAST one issued (resolvePtpProfile reads user_profiles first).
  let lastSelect = "*";
  const chain = {
    select: (columns?: string) => {
      if (typeof columns === "string") lastSelect = columns;
      return chain;
    },
    eq: () => chain,
    order: () => chain,
    maybeSingle: async () => ({ data: profile, error: profileError }),
    limit: async (n: number) => {
      limitFn?.(n);
      return { data: traces.map((r) => projectRow(r, lastSelect)), error: null };
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
   *  has an owner of record at the tier 1 rate, PLUS every blank-owner record at the tier 2
   *  per-record rate. The blank arm was worth nothing until phase 5c, because the record was
   *  skipped rather than traced; it is queued and billed now, so it has to be covered on both
   *  surfaces. The MCP gate must never come out below this for the rate that surface settles at. */
  const v1Reserve = (records: { owner_name?: string }[], tier1Rate: number, tier2Rate: number) =>
    records.filter((r) => !isBlankOwnerRecord(r.owner_name)).length * tier1Rate +
    records.filter((r) => isBlankOwnerRecord(r.owner_name)).length * tier2Rate;

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
    // Non-grant profile: both surfaces use the same two rates, so the reserves must match.
    const wallet = worstCaseCost(records, walletProfile);
    expect(wallet.total).toBeGreaterThanOrEqual(
      v1Reserve(records, PRICING.CHARGE_PER_SUCCESS_WALLET, 0.4),
    );
    expect(wallet.total).toBeCloseTo(v1Reserve(records, PRICING.CHARGE_PER_SUCCESS_WALLET, 0.4));

    // Grant holder: the MCP settles at the lower grant rates, so those are what it must cover.
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    const grant = worstCaseCost(records, proProfile);
    expect(grant.total).toBeGreaterThanOrEqual(
      v1Reserve(records, PRICING.CHARGE_PER_SUCCESS, 0.25),
    );
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });

  // MONEY-GATE CORRECTNESS, AND THIS IS THE CASE PHASE 5c INVERTED. An address-only record used
  // to reserve NOTHING, because it had no route: the engine that finds an owner from an address
  // alone had been removed, so the record was skipped and never charged. 5c built that engine, so
  // the record is now submitted, queued and billed per RECORD SUBMITTED. A gate still reserving
  // zero would let a caller commit to a batch their wallet cannot cover.
  // MUTATION: restore the `continue` that made the blank arm free and this goes red.
  it("reserves the TIER 2 per-record rate for an address-only record", () => {
    const out = worstCaseCost(
      [{ address: "4 D St", city: "X", state: "TX", zip: "75001" }],
      walletProfile,
    );
    expect(out.persons).toBe(0);
    expect(out.entities).toBe(0);
    expect(out.blanks).toBeCloseTo(0.4);
    expect(out.total).toBeCloseTo(0.4);
    // Not folded into either tier 1 arm: it is a different billing model, not a
    // different vendor, and the two rates are genuinely different numbers.
    expect(out.total).not.toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("reserves it for a whitespace-only owner_name too", () => {
    const out = worstCaseCost(
      [{ owner_name: "   ", address: "5 E St", city: "X", state: "TX", zip: "75001" }],
      walletProfile,
    );
    expect(out.total).toBeCloseTo(0.4);
  });

  it("prices the blank arm grant-aware, like the rest of this surface", () => {
    // L-009: with the flag off a grant counts for nothing and this assertion
    // holds under a raw implementation too, so the flag is set and then cleared
    // to show it is what makes the difference.
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    const records = [{ address: "4 D St", city: "X", state: "TX", zip: "75001" }];
    expect(worstCaseCost(records, proProfile).total).toBeCloseTo(0.25);
    expect(chargePerRecord(proProfile)).toBeCloseTo(0.25);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
    expect(worstCaseCost(records, proProfile).total).toBeCloseTo(0.4);
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
      { address: "4 D St", city: "X", state: "TX", zip: "75001" }, // tier 2 (no owner)
      { owner_name: "   ", address: "5 E St", city: "X", state: "TX", zip: "75001" }, // tier 2 (whitespace)
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
    // The two blank-owner records are priced in their OWN arm, not folded into
    // either tier 1 one. Folding them into persons or entities would bill them
    // per successful trace, which is free on a miss, and a tier 2 miss is not.
    expect(out.persons).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(out.blanks).toBeCloseTo(2 * 0.4);
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
    // The address-only record is neither a person nor a named entity: it is a TIER 2 record,
    // reported under its own key so the caller can see it is being traced rather than skipped.
    expect(out.persons).toBe(1);
    expect(out.entities).toBe(2);
    expect(out.full_property_trace).toBe(1);
    expect(out.after_dedup).toBe(4);
    // And it costs the tier 2 per-record rate on top of the three tier 1 records, where it used
    // to cost nothing. MUTATION: drop the blank arm from worstCaseCost and this goes red.
    expect(out.worst_case_cost).toBeCloseTo(3 * PRICING.CHARGE_PER_SUCCESS_WALLET + 0.4);
  });

  it("counts no full property traces when every record has an owner", () => {
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: [], wallet_balance: 5 } });
    return skipTraceQuote(admin, "sub-1", {
      records: [{ owner_name: "John Smith", address: "1 A St", city: "X", state: "TX", zip: "75001" }],
    }).then((raw) => {
      const out = expectQuote(raw);
      expect(out.full_property_trace).toBe(0);
      expect(out.worst_case_cost).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET);
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

  it("ENQUEUES an address-only record (NO owner_name) for a Full Property Trace", async () => {
    // Submit-split side of the money-gate consistency, and phase 5c inverted it. This record was
    // accepted, written terminal with a skip status and never charged, because the engine that
    // finds an owner from an address alone had been removed. 5c built it back properly: a
    // Tracerfy dossier buys the county record and names the owner, then one contact lookup
    // resolves them. So the record is queued and BILLED, per record submitted.
    // MUTATION: restore the BLANK_OWNER_SKIP_STATUS write and this goes red on the counts, the
    // queue column and the committed worst case alike.
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
      full_property_trace: 1,
    });
    // It commits real money now, where it used to commit zero.
    expect((out as { committed_worst_case: number }).committed_worst_case).toBeGreaterThan(0);
    // Still not in the person CSV: it has no owner to put in one.
    expect(submitBulkTrace).not.toHaveBeenCalled();

    const rows = captured.traceHistoryUpserts.flatMap((u) => u.batch) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      property_trace_status: queuedStatusFor(1),
      status: "processing",
      input_owner_name: null,
    });
    // Nothing money-shaped at submit: the cron bills it when the dossier answers.
    for (const paid of ["charge", "ai_research_charge", "tier"]) {
      expect(Object.keys(rows[0])).not.toContain(paid);
    }
    // And it is NOT on the ENTITY queue. That column settles tier 1, where a miss
    // is free; this row is tier 2, where a miss is billed. A row on both is
    // settled twice by two engines under two billing models.
    expect(rows[0].ai_research_status ?? null).toBeNull();
  });

  it("still queues a NAMED entity for the business trace", async () => {
    // The other half of the split: a company name is a real owner of record, so it keeps its
    // route and keeps reserving one tier 1 charge.
    const { admin, captured } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ owner_name: "Acme Holdings LLC", address: "100 Main St", city: "Dallas", state: "TX", zip: "75001" }],
      confirm: true,
    });
    expect(out).toMatchObject({ accepted: 1, persons: 0, entities: 1, full_property_trace: 0 });
    const rows = captured.traceHistoryUpserts.flatMap((u) => u.batch) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ ai_research_status: "queued", status: "processing" });
    // On the ENTITY queue only. A named owner is tier 1 work: the FastAppend
    // business trace bills per successful trace and a miss is free. Landing it on
    // the tier 2 queue as well would bill it per record submitted, by a second
    // engine, for an owner it never needed discovering.
    //
    // ASSERTED ON THE KEY, NOT ON `?? null`. The upsert touches only the keys in
    // its payload and the row is REUSED, so an omitted key leaves a previous
    // tier 2 terminal value on the row for rowSkipReason() to serve. An absent
    // key satisfied the old assertion, so it could not fail.
    expect(Object.keys(rows[0])).toContain("property_trace_status");
    expect(rows[0].property_trace_status).toBeNull();
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------- *
   * THE TWO PRE-FLIGHT CHECKS. Different questions, different owners,
   * different sentences, and they must never be merged.
   * ---------------------------------------------------------------- */

  it("refuses without writing anything when PTP's own credit pool is short", async () => {
    // Billing a caller for a job we cannot run is the outcome this check exists to prevent, so
    // it lands before the job row, before the history rows and before any vendor.
    H.canRunTier2 = false;
    const { admin, captured } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ address: "100 Main St", city: "Dallas", state: "TX", zip: "75001" }],
      confirm: true,
    });
    expect(out).toMatchObject({ error: "capacity_unavailable" });
    expect(captured.traceHistoryUpserts).toHaveLength(0);
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });

  it("NEVER tells the caller to add funds when it is PTP's balance that is short", async () => {
    // David, 2026-09-18, binding. Their wallet is fine; ours is the problem, and pointing them
    // at a top-up takes money for a fix that changes nothing. Nothing may claim anyone was
    // notified either, because PTP has no alerting channel.
    // MUTATION: return the insufficient_balance payload here and this goes red.
    H.canRunTier2 = false;
    const { admin } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ address: "100 Main St", city: "Dallas", state: "TX", zip: "75001" }],
      confirm: true,
    });
    const message = (out as { message: string }).message.toLowerCase();
    expect(message).not.toContain("add funds");
    expect(message).not.toMatch(/your wallet|your balance/);
    expect(message).not.toMatch(/notif|alerted|our team/);
    expect((out as { error: string }).error).not.toBe("insufficient_balance");
  });

  it("does not ask the pool about a batch with no blank-owner records", async () => {
    // A tier 1 only batch draws nothing from the dossier pool, so a short pool must not refuse
    // it. MUTATION: pass newRecords.length instead of tier2Records.length and this goes red.
    H.canRunTier2 = false;
    const { admin } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" }],
      confirm: true,
    });
    expect(out).not.toMatchObject({ error: "capacity_unavailable" });
  });

  it("does NOT fail the job when the person submit fails but tier 2 rows are queued", async () => {
    // The guard was written when the third bucket did not exist, so it asked
    // only whether the ENTITY queue still had work. sweep-property-traces never
    // reads the parent job, so failing it here stops nothing: it works every
    // tier 2 row and bills each one, against a caller told the submit failed.
    // MUTATION: drop the `&& tier2Records.length === 0` term and this goes red.
    vi.mocked(submitBulkTrace).mockResolvedValue({ success: false, error: "Tracerfy 503" });
    const { admin, captured } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [
        { owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" },
        { address: "2 B St", city: "Dallas", state: "TX", zip: "75001" },
      ],
      confirm: true,
    });
    expect(out).not.toMatchObject({ error: "submit_failed" });
    expect(
      captured.traceJobsUpdates.filter(
        (u) => (u as Record<string, unknown>)?.status === "failed",
      ),
    ).toHaveLength(0);
  });

  it("stops counting and pricing the errored person records", async () => {
    // THE HALF THAT WAS MISSED. The billing hole was closed but the payload
    // still described the dead half as accepted and priced it.
    // MUTATION: report personRecords.length or the pre-failure worst case and
    // this goes red.
    vi.mocked(submitBulkTrace).mockResolvedValue({ success: false, error: "Tracerfy 503" });
    const { admin } = submitAdminStub({ profile: linked });
    const out = (await skipTraceBulk(admin, "sub-1", {
      records: [
        { owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" },
        { address: "2 B St", city: "Dallas", state: "TX", zip: "75001" },
      ],
      confirm: true,
    })) as Record<string, unknown>;

    expect(out.persons).toBe(0);
    expect(out.accepted).toBe(1);
    // Only the surviving tier 2 record is committed, at the tier 2 rate.
    expect(out.committed_worst_case).toBeCloseTo(0.4);
  });

  it("carries the failure as a FIELD, because a model reads this payload", async () => {
    // Prose can be summarised away by the model consuming this. A named count it
    // can compare against `accepted` cannot be dropped silently.
    // MUTATION: delete records_failed and leave only the message, and this goes red.
    vi.mocked(submitBulkTrace).mockResolvedValue({ success: false, error: "Tracerfy 503" });
    const { admin } = submitAdminStub({ profile: linked });
    const out = (await skipTraceBulk(admin, "sub-1", {
      records: [
        { owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" },
        { address: "2 B St", city: "Dallas", state: "TX", zip: "75001" },
      ],
      confirm: true,
    })) as Record<string, unknown>;

    expect(out.records_failed).toBe(1);
    expect(typeof out.records_failed).toBe("number");
    expect(String(out.message)).toContain("not charged");
    expect(String(out.message)).not.toMatch(/[—–*]/);
  });

  it("keeps the field present and zero when nothing failed", async () => {
    const { admin } = submitAdminStub({ profile: linked });
    const out = (await skipTraceBulk(admin, "sub-1", {
      records: [
        { owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" },
      ],
      confirm: true,
    })) as Record<string, unknown>;
    expect(out.records_failed).toBe(0);
    expect(out.persons).toBe(1);
  });

  it("corrects the job's records_submitted, the match-rate denominator", async () => {
    vi.mocked(submitBulkTrace).mockResolvedValue({ success: false, error: "Tracerfy 503" });
    const { admin, captured } = submitAdminStub({ profile: linked });
    await skipTraceBulk(admin, "sub-1", {
      records: [
        { owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" },
        { address: "2 B St", city: "Dallas", state: "TX", zip: "75001" },
      ],
      confirm: true,
    });
    const corrected = captured.traceJobsUpdates.filter(
      (u) => (u as Record<string, unknown>)?.records_submitted !== undefined,
    );
    expect(corrected).toHaveLength(1);
    expect(corrected[0]).toMatchObject({ records_submitted: 1 });
  });

  it("STILL fails a job where the person submit failed and nothing else was queued", async () => {
    // The guard must not become a blanket refusal to ever fail a job.
    vi.mocked(submitBulkTrace).mockResolvedValue({ success: false, error: "Tracerfy 503" });
    const { admin } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [
        { owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" },
      ],
      confirm: true,
    });
    expect(out).toMatchObject({ error: "submit_failed" });
  });

  it("sizes the wallet gate against work already accepted and not yet billed", async () => {
    // Two batches submitted back to back both passed against the same dollars, because the gate
    // reserved nothing and the real debit lands per record at settle time.
    // MUTATION: drop the in-flight term and this goes red.
    H.inFlight = 99.9;
    const { admin, captured } = submitAdminStub({ profile: linked }); // wallet_balance 100
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" }],
      confirm: true,
    });
    expect(out).toMatchObject({ error: "insufficient_balance" });
    expect(captured.traceHistoryUpserts).toHaveLength(0);
  });
});

describe("skip_trace_bulk carries the dossier parcel key", () => {
  const linked = {
    id: "p1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: ["prop-tracer-pro"],
    wallet_balance: 100,
  };

  /** Submits `records` through the real skipTraceBulk() with the existing submit stub, then
   *  returns every trace_history row it upserted. Built on submitAdminStub rather than a second
   *  harness, matching every other test in this describe group. */
  async function capturedHistoryRowsFor(records: unknown[]) {
    const { admin, captured } = submitAdminStub({ profile: linked });
    await skipTraceBulk(admin, "sub-1", { records, confirm: true });
    return captured.traceHistoryUpserts.flatMap((u) => u.batch);
  }

  it("accepts apn and county on a record", () => {
    const parsed = recordSchema.safeParse({
      address: "203 Dauphin St", city: "Mobile", state: "AL",
      apn: "R022901", county: "Mobile",
    });
    expect(parsed.success).toBe(true);
  });

  it("still accepts a record with neither, which is every caller today", () => {
    expect(recordSchema.safeParse({
      address: "203 Dauphin St", city: "Mobile", state: "AL",
    }).success).toBe(true);
  });

  it("persists both onto the trace_history row", async () => {
    // The whole point of the migration. If these are not written at submit, the cron
    // cannot use them a minute later and the APN step stays dead with no error anywhere.
    const rows = await capturedHistoryRowsFor([{
      address: "203 Dauphin St", city: "Mobile", state: "AL",
      apn: "R022901", county: "Mobile",
    }]);
    expect(rows[0].parcel_id_local).toBe("R022901");
    expect(rows[0].county).toBe("Mobile");
  });

  it("writes null, never an empty string, when they are absent", async () => {
    const rows = await capturedHistoryRowsFor([{
      address: "203 Dauphin St", city: "Mobile", state: "AL",
    }]);
    expect(rows[0].parcel_id_local).toBeNull();
    expect(rows[0].county).toBeNull();
  });
});

// ---- Task 6: bulk_status (shared settlement + ownership fence) ----------------

/** Admin stub for the poll/settle path: profile + job come back from
 *  `.maybeSingle()` keyed by table; the trace_history rows come back from the
 *  awaited (`.then`) builder. */
function statusAdminStub(opts: { profile: unknown; job: unknown; rows?: unknown[] }) {
  const { profile, job, rows = [] } = opts;
  const captured = { traceJobsUpdates: [] as unknown[] };
  // Same projection fence as adminStub: bulkStatus reads trace_history with select("*"), and
  // narrowing that select to a list without property_record / tier must turn the tests red
  // rather than silently emit nulls.
  let historySelect = "*";
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {
      select: (columns?: string) => {
        if (table === "trace_history" && typeof columns === "string") historySelect = columns;
        return chain;
      },
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
        resolve({
          data: table === "trace_history" ? rows.map((r) => projectRow(r, historySelect)) : null,
          error: null,
        }),
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

  /* ---------------------------------------------------------------- *
   * THE JOB MAY NOT FINISH OVER WORK THAT HAS NOT RUN.
   *
   * isPropertyTracePending() was written for this and had no caller
   * until the submit routes learned to enqueue. Without the gate a
   * MIXED job finalizes the moment its Tracerfy leg lands, while its
   * tier 2 rows are still queued: the caller gets `completed` and a
   * results payload short by exactly the rows they are about to be
   * billed for, and a `completed` job is never polled again.
   * ---------------------------------------------------------------- */

  it("stays processing while a tier 2 row is still queued, even with everything else settled", async () => {
    // MUTATION: delete the isPropertyTracePending arm and this goes red -- the
    // job reports completed over a row no vendor has answered for yet.
    const { admin, captured } = statusAdminStub({
      profile,
      job: { id: "job-1", user_id: "p1", status: "processing", records_submitted: 2 },
      rows: [
        // The tier 1 half: finished and settled.
        { id: "r1", status: "success", tracerfy_job_id: null, is_successful: true, charge: 0.25, ai_research_status: null },
        // The tier 2 half: still on the queue, and NOT status 'processing', so
        // the pre-existing gates cannot see it.
        { id: "r2", status: "no_match", tracerfy_job_id: null, is_successful: false, charge: 0, ai_research_status: null, property_trace_status: "queued" },
      ],
    });
    const out = await bulkStatus(admin, "sub-1", { job_id: "job-1" });
    expect(out).toMatchObject({ status: "processing", records_pending_property_trace: 1 });
    // And the job row is NOT written completed, which is what would stop it ever
    // being polled again.
    expect(captured.traceJobsUpdates).toHaveLength(0);
  });

  it("counts a RETRIED tier 2 row as pending, not just a first attempt", async () => {
    // The attempt number rides in the column itself, so a literal comparison
    // against 'queued' would read queued_3 as terminal and finish the job early.
    const { admin } = statusAdminStub({
      profile,
      job: { id: "job-1", user_id: "p1", status: "processing", records_submitted: 1 },
      rows: [
        { id: "r1", status: "no_match", tracerfy_job_id: null, is_successful: false, charge: 0, ai_research_status: null, property_trace_status: "processing_3" },
      ],
    });
    const out = await bulkStatus(admin, "sub-1", { job_id: "job-1" });
    expect(out).toMatchObject({ status: "processing" });
  });

  it("finishes once every tier 2 row reaches a terminal value", async () => {
    // The other side of the fence: a terminal value must read as NOT pending, or
    // the job is held open forever and never reports at all.
    const { admin } = statusAdminStub({
      profile,
      job: { id: "job-1", user_id: "p1", status: "processing", records_submitted: 1 },
      rows: [
        { id: "r1", status: "no_match", tracerfy_job_id: null, is_successful: false, charge: 0.4, ai_research_status: null, property_trace_status: "property_trace_done" },
      ],
    });
    const out = await bulkStatus(admin, "sub-1", { job_id: "job-1" });
    expect(out).toMatchObject({ status: "completed", job_id: "job-1" });
    // And the tier 2 charge the cron booked is in the total, which a tier 1 only
    // settle loop could never have seen.
    expect(out).toMatchObject({ total_charge: 0.4 });
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

// ---------------------------------------------------------------------------
// PHASE 4b: the public property record and the tier on the GATEWAY-FACING surface
// ---------------------------------------------------------------------------
//
// The Suite Gateway never reads PTP's database. It reads PTP over MCP, so a field
// that is not on THIS surface cannot reach a customer's GoHighLevel no matter what
// the REST routes return. Both readers that hand back trace rows -- list_traces and
// bulk_status -- therefore carry `property_record` and `tier`, named exactly as
// app/api/trace/single and app/api/v1/trace/single already name them, because the
// gateway parses by exact key.
//
// THE RECORD IS FILTERED AT THIS DOOR, like every other. Storage keeps all 86 keys;
// egress carries 65. The 21 withheld are provably WRONG rather than merely missing
// (estimated_value is literally assessed_value, and the renovation models score a
// 41,588 sqft commercial building as a "large home"), and this payload lands in a
// customer's own CRM where it outlives any caveat.
//
// The blocked list is IMPORTED, never retyped. A hand-copied list in a test cannot
// fail when the vendor adds a 22nd bad key, which is the only thing a test like this
// is for.

const RAW_PROPERTY_RECORD = (
  entityHitAddress as unknown as { response: { property: Record<string, unknown> } }
).response.property;

/** A tier 2 row as the database holds it: the vendor's object verbatim, all 86 keys. */
function tier2Row(overrides: Record<string, unknown> = {}) {
  return {
    id: "r-tier2",
    normalized_address: "1300 MAYFIELD DR",
    city: "ASHTABULA",
    state: "OH",
    zip: "44004",
    input_owner_name: null,
    status: "success",
    is_successful: true,
    phone_count: 0,
    email_count: 0,
    charge: 0.4,
    created_at: "2026-09-17T00:00:00.000Z",
    trace_result: null,
    ai_research: null,
    ai_research_status: null,
    property_record: RAW_PROPERTY_RECORD,
    tier: 2,
    ...overrides,
  };
}

/** A tier 1 row: owner of record supplied, no dossier bought, so the column is NULL. */
function tier1Row(overrides: Record<string, unknown> = {}) {
  return {
    id: "r-tier1",
    normalized_address: "500 MAIN ST",
    city: "AUSTIN",
    state: "TX",
    zip: "78701",
    input_owner_name: "Colmaven, Llc",
    status: "success",
    is_successful: true,
    phone_count: 1,
    email_count: 1,
    charge: 0.15,
    created_at: "2026-09-17T00:00:00.000Z",
    trace_result: { owner_name: "Daniel Hamann" },
    ai_research: null,
    ai_research_status: null,
    property_record: null,
    tier: 1,
    ...overrides,
  };
}

/** The 65 keys a gateway caller is entitled to, derived rather than asserted from a
 *  literal, so this stays correct when the vendor adds a key that is NOT blocked. */
const PUBLIC_KEY_COUNT =
  Object.keys(RAW_PROPERTY_RECORD).length - BLOCKED_PROPERTY_RECORD_KEYS.length;

describe("the property record and tier on the gateway-facing MCP surface", () => {
  // The two sides of this comparison CAN differ (L-009): the fixture carries all 21
  // blocked keys populated, so an unfiltered emission is 86 keys and a filtered one
  // is 65. If the fixture ever stops carrying them the filter tests below become
  // tautologies, so the difference itself is asserted first.
  it("the fixture can actually fail the filter tests, so they are not tautologies", () => {
    expect(Object.keys(RAW_PROPERTY_RECORD)).toHaveLength(86);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(RAW_PROPERTY_RECORD, `${key} absent from the fixture`).toHaveProperty(key);
    }
    expect(PUBLIC_KEY_COUNT).toBe(65);
  });

  describe("list_traces", () => {
    it("emits the 65 public keys and none of the 21 blocked ones on a tier 2 row", async () => {
      const admin = adminStub({
        profile: { id: "p1", wallet_balance: 0 },
        traces: [tier2Row()],
      });
      const out = (await listTraces(admin, "sub-1", {})) as {
        traces: Array<{ property_record: Record<string, unknown> | null }>;
      };
      const record = out.traces[0].property_record!;
      // MUTATION: drop toPublicPropertyRecord from listTraces and this goes red.
      for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
        expect(record, `${key} reached the gateway`).not.toHaveProperty(key);
      }
      expect(Object.keys(record)).toHaveLength(PUBLIC_KEY_COUNT);
      expect(record.assessed_value).toBe(RAW_PROPERTY_RECORD.assessed_value);
      expect(record).toHaveProperty("price_per_sqft");
    });

    it("emits property_record: null on a tier 1 row, never an empty object", async () => {
      // An empty object reads as "the county published nothing". It is the placeholder
      // CLAUDE.md rule 7 forbids, and a gateway mapping it would write 65 blanks.
      const admin = adminStub({
        profile: { id: "p1", wallet_balance: 0 },
        traces: [tier1Row()],
      });
      const out = (await listTraces(admin, "sub-1", {})) as {
        traces: Array<{ property_record: unknown }>;
      };
      expect(out.traces[0].property_record).toBeNull();
    });

    it("carries the tier on both a tier 1 and a tier 2 row", async () => {
      const admin = adminStub({
        profile: { id: "p1", wallet_balance: 0 },
        traces: [tier2Row(), tier1Row()],
      });
      const out = (await listTraces(admin, "sub-1", {})) as {
        traces: Array<{ tier: number | null }>;
      };
      expect(out.traces.map((t) => t.tier)).toEqual([2, 1]);
    });

    it("reports a row written before the tier column existed as tier null", async () => {
      const admin = adminStub({
        profile: { id: "p1", wallet_balance: 0 },
        traces: [tier1Row({ tier: null })],
      });
      const out = (await listTraces(admin, "sub-1", {})) as { traces: Array<{ tier: unknown }> };
      expect(out.traces[0].tier).toBeNull();
    });

    it("never leaks the raw record alongside the filtered one", async () => {
      // property_record is destructured OUT of the spread. If it were left in `rest`,
      // the raw 86-key object would ride along under the same key and the filtered
      // copy would be overwritten by whichever came last.
      const admin = adminStub({
        profile: { id: "p1", wallet_balance: 0 },
        traces: [tier2Row()],
      });
      const out = (await listTraces(admin, "sub-1", {})) as { traces: Array<unknown> };
      const serialized = JSON.stringify(out.traces[0]);
      for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
        expect(serialized, `${key} present somewhere in the trace`).not.toContain(`"${key}"`);
      }
    });

    it("does not mutate the row it was handed", async () => {
      // The same guarantee the submit routes depend on: the filter returns a copy.
      const row = tier2Row({ property_record: { ...RAW_PROPERTY_RECORD } });
      const admin = adminStub({ profile: { id: "p1", wallet_balance: 0 }, traces: [row] });
      await listTraces(admin, "sub-1", {});
      expect(Object.keys(row.property_record as object)).toHaveLength(86);
    });

    it("SELECT FENCE: asks the database for property_record and tier", async () => {
      // The stub projects through .select(...), exactly as PostgREST does. Removing
      // either column from the select makes the row arrive without it, the tool emits
      // null, and this assertion fails -- which is the only way a select regression is
      // distinguishable from a working filter.
      const admin = adminStub({
        profile: { id: "p1", wallet_balance: 0 },
        traces: [tier2Row()],
      });
      const out = (await listTraces(admin, "sub-1", {})) as {
        traces: Array<{ property_record: Record<string, unknown> | null; tier: number | null }>;
      };
      expect(out.traces[0].property_record).not.toBeNull();
      expect(Object.keys(out.traces[0].property_record!)).toHaveLength(PUBLIC_KEY_COUNT);
      expect(out.traces[0].tier).toBe(2);
    });
  });

  describe("bulk_status", () => {
    const profile = {
      id: "p1",
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["prop-tracer-pro"],
      wallet_balance: 50,
    };
    const completedJob = {
      id: "job-1",
      user_id: "p1",
      status: "completed",
      records_submitted: 2,
      records_matched: 2,
    };

    it("emits the 65 public keys and none of the 21 blocked ones on a tier 2 row", async () => {
      const { admin } = statusAdminStub({ profile, job: completedJob, rows: [tier2Row()] });
      const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
        results: Array<{ property_record: Record<string, unknown> | null }>;
      };
      const record = out.results[0].property_record!;
      // MUTATION: drop toPublicPropertyRecord from buildPerRecordResult and this goes red.
      for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
        expect(record, `${key} reached the gateway`).not.toHaveProperty(key);
      }
      expect(Object.keys(record)).toHaveLength(PUBLIC_KEY_COUNT);
      expect(record.assessed_value).toBe(RAW_PROPERTY_RECORD.assessed_value);
    });

    it("emits property_record: null on a tier 1 row, never an empty object", async () => {
      const { admin } = statusAdminStub({ profile, job: completedJob, rows: [tier1Row()] });
      const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
        results: Array<{ property_record: unknown }>;
      };
      expect(out.results[0].property_record).toBeNull();
    });

    it("carries the tier on both a tier 1 and a tier 2 row", async () => {
      const { admin } = statusAdminStub({
        profile,
        job: completedJob,
        rows: [tier2Row(), tier1Row()],
      });
      const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
        results: Array<{ tier: number | null }>;
      };
      expect(out.results.map((r) => r.tier)).toEqual([2, 1]);
    });

    it("reports a row written before the tier column existed as tier null", async () => {
      const { admin } = statusAdminStub({
        profile,
        job: completedJob,
        rows: [tier1Row({ tier: null })],
      });
      const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
        results: Array<{ tier: unknown }>;
      };
      expect(out.results[0].tier).toBeNull();
    });

    it("carries both on the freshly-finalized branch, not only the already-completed one", async () => {
      // bulkStatus has TWO exits that emit results: the stored-summary branch for an
      // already completed/failed job, and the finalize branch it reaches the first
      // time every row has landed. Both map buildPerRecordResult, and a payload that
      // only appears on a re-poll is a payload the first caller never sees.
      const { admin } = statusAdminStub({
        profile,
        job: { ...completedJob, status: "processing" },
        rows: [tier2Row()],
      });
      const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
        status: string;
        results: Array<{ property_record: Record<string, unknown> | null; tier: number | null }>;
      };
      expect(out.status).toBe("completed");
      expect(Object.keys(out.results[0].property_record!)).toHaveLength(PUBLIC_KEY_COUNT);
      expect(out.results[0].tier).toBe(2);
    });

    it("does not mutate the row it was handed", async () => {
      const row = tier2Row({ property_record: { ...RAW_PROPERTY_RECORD } });
      const { admin } = statusAdminStub({ profile, job: completedJob, rows: [row] });
      await bulkStatus(admin, "sub-1", { job_id: "job-1" });
      expect(Object.keys(row.property_record as object)).toHaveLength(86);
    });

    it("SELECT FENCE: asks the database for property_record and tier", async () => {
      // bulkStatus reads trace_history with select("*"), so the columns arrive today.
      // The stub projects through that select: narrowing it to a list without either
      // column turns the assertions below red instead of silently emitting nulls.
      const { admin } = statusAdminStub({ profile, job: completedJob, rows: [tier2Row()] });
      const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
        results: Array<{ property_record: Record<string, unknown> | null; tier: number | null }>;
      };
      expect(out.results[0].property_record).not.toBeNull();
      expect(Object.keys(out.results[0].property_record!)).toHaveLength(PUBLIC_KEY_COUNT);
      expect(out.results[0].tier).toBe(2);
    });
  });
});

/**
 * THE SIZE FENCE ON bulk_status.
 *
 * It returned EVERY row of the job, each carrying a 65-key property record,
 * JSON pretty-printed at 2-space indent, with no bound of any kind. The cap is
 * 500 records a job, so the worst case was a single tool response of 500
 * dossiers. list_traces, which returns strictly less per row, has been default
 * 25 / max 200 all along.
 */
describe("bulk_status paging", () => {
  const profile = {
    id: "p1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: ["prop-tracer-pro"],
    wallet_balance: 50,
  };
  const completedJob = {
    id: "job-1",
    user_id: "p1",
    status: "completed",
    records_submitted: 300,
    records_matched: 300,
  };
  /** A job bigger than the default page and bigger than the max page. */
  const manyRows = (n: number) =>
    Array.from({ length: n }, (_, i) => tier2Row({ id: `r-${i}`, normalized_address: `ROW ${i}` }));

  it("returns 25 rows by default rather than all of them", async () => {
    // MUTATION: drop the slice and this goes red.
    const { admin } = statusAdminStub({ profile, job: completedJob, rows: manyRows(300) });
    const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
      results: unknown[];
      results_total: number;
      results_returned: number;
    };
    expect(out.results).toHaveLength(25);
    // AND IT SAYS SO. A silently truncated payload is the failure this is meant
    // to avoid, not a smaller version of it: the caller has to be able to tell
    // that 275 rows they paid for are still waiting.
    expect(out.results_total).toBe(300);
    expect(out.results_returned).toBe(25);
  });

  it("clamps an oversized limit to the same 200 list_traces uses", async () => {
    const { admin } = statusAdminStub({ profile, job: completedJob, rows: manyRows(300) });
    const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1", limit: 5000 })) as {
      results: unknown[];
    };
    expect(out.results).toHaveLength(200);
  });

  it("clamps a zero or negative limit up to one row rather than returning none", async () => {
    const { admin } = statusAdminStub({ profile, job: completedJob, rows: manyRows(10) });
    const zero = (await bulkStatus(admin, "sub-1", { job_id: "job-1", limit: 0 })) as {
      results: unknown[];
    };
    expect(zero.results).toHaveLength(1);
  });

  it("reaches the rows past the max, so a 500-record job is fully readable", async () => {
    // THE REASON THE OFFSET EXISTS. list_traces pages with `since`, which works
    // on a list open at one end. A job's results are a FIXED set, so a bare max
    // of 200 would leave the last 300 rows of a 500-record job unreachable: the
    // customer pays for 500 records and can read 200. A tool that structurally
    // cannot return what was bought is a worse defect than the size it fixes.
    const { admin } = statusAdminStub({ profile, job: completedJob, rows: manyRows(300) });
    const out = (await bulkStatus(admin, "sub-1", {
      job_id: "job-1",
      limit: 200,
      offset: 200,
    })) as {
      results: Array<{ address: string }>;
      results_total: number;
      results_returned: number;
      results_offset: number;
    };
    expect(out.results).toHaveLength(100);
    expect(out.results[0].address).toBe("ROW 200");
    expect(out.results_total).toBe(300);
    expect(out.results_returned).toBe(100);
    expect(out.results_offset).toBe(200);
  });

  it("floors a negative offset instead of slicing from the end", async () => {
    // A negative offset would silently return the WRONG rows rather than fail,
    // which is the shape of bug nobody reports.
    const { admin } = statusAdminStub({ profile, job: completedJob, rows: manyRows(10) });
    const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1", offset: -5 })) as {
      results: Array<{ address: string }>;
      results_offset: number;
    };
    expect(out.results[0].address).toBe("ROW 0");
    expect(out.results_offset).toBe(0);
  });

  it("reports an offset past the end as zero rows and does not go negative", async () => {
    const { admin } = statusAdminStub({ profile, job: completedJob, rows: manyRows(10) });
    const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1", offset: 999 })) as {
      results: unknown[];
      results_total: number;
      results_returned: number;
    };
    expect(out.results).toHaveLength(0);
    expect(out.results_total).toBe(10);
    expect(out.results_returned).toBe(0);
  });

  it("pages the freshly-finalized branch too, not only the already-completed one", async () => {
    // bulkStatus has TWO exits that emit results. A cap on one of them is not a
    // cap: the first caller to finish a job hits the other exit.
    const { admin } = statusAdminStub({
      profile,
      job: { ...completedJob, status: "processing" },
      rows: manyRows(300),
    });
    const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
      status: string;
      results: unknown[];
      results_total: number;
    };
    expect(out.status).toBe("completed");
    expect(out.results).toHaveLength(25);
    expect(out.results_total).toBe(300);
  });
});
