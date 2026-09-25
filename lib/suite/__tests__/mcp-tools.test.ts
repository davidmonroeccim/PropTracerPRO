import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  PROPERTY_TRACE_NO_KEY_STATUS,
  queuedStatusFor,
} from "@/lib/trace/propertyTraceAttempts";
import { TIER1_QUEUED_STATUSES, tier1QueuedStatusFor } from "@/lib/trace/tier1Queue";
import { TIER1_OUTCOME } from "@/lib/trace/tier1Outcome";
import { inFlightUnbilledCost, tracerfyCanRun } from "@/lib/trace/bulkPreflight";
import {
  createAddressHash,
  normalizeAddress,
  traceKeyFor,
} from "@/lib/utils/address-normalizer";
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
    // THE `tier1 <= 0 && tier2 <= 0 ? true` SHORT CIRCUIT IS GONE, and removing it is part of
    // Phase 2B. It was labelled "faithful to the real contract" and it is -- lib/trace/bulkPreflight.ts
    // returns true for an empty batch without spending a vendor round trip, fenced directly by
    // lib/trace/__tests__/bulkPreflight.test.ts. But this surface passed a hardcoded `tier1: 0`, so
    // EVERY tier-1-only batch arrived here as 0/0 and took the short circuit: the count was
    // structurally invisible, and a submit passing the wrong tier 1 number still looked correct.
    // Now the lever answers for every batch, so a tier-1-only batch is genuinely refusable and the
    // count it is asked about is fenced by an explicit toHaveBeenCalledWith below.
    //
    // WHAT THAT MAKES INVISIBLE: this double CAN refuse a batch the real function never would
    // (0 tier 1 and 0 tier 2). Nothing here submits an empty batch -- the schema demands at least
    // one record and the all-duplicates path returns before the pool question -- and the real 0/0
    // answer is fenced in bulkPreflight.test.ts.
    // It takes no parameters because it reads none: the lever answers every call the same way.
    // vi.fn still records the arguments it was handed, which is what the toHaveBeenCalledWith
    // assertion on the tier 1 count reads.
    tracerfyCanRun: vi.fn(async () => H.canRunTier2),
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
  // AND THE RECORDED CALLS ARE CLEARED, WHICH IS A DIFFERENT THING FROM THE LEVERS ABOVE.
  //
  // The two lines above reset what these functions RETURN. They do not touch what vi.fn has
  // RECORDED, and there is no `clearMocks` in vitest.config.ts and no setup file, so without this
  // every call accumulates for the whole file. That made the only toHaveBeenCalledWith assertions
  // on tracerfyCanRun's arguments -- the ones Amendment 5 exists to add, because the tier 1 count
  // was previously unfenced -- satisfiable by ANY matching call recorded by an earlier test. Two
  // earlier tests already produce { tier1: 1, tier2: 1 } and { tier1: 0, tier2: 0 } on their own.
  //
  // The fence still measured RED under its mutation, because changing the count corrupts every
  // call in the file at once. But it was file-global rather than test-local, and it would stop
  // biting the moment the count became conditional on anything. A spy that is never cleared is a
  // fence that cannot fail.
  //
  // mockClear, never mockReset: these two carry their implementations from the vi.mock factory
  // above, and mockReset would strip them and make every submit throw.
  vi.mocked(tracerfyCanRun).mockClear();
  vi.mocked(inFlightUnbilledCost).mockClear();
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
      traces: Array<Record<string, unknown>>;
    };
    expect(out.traces[0].owner_contact_name).toBe("Daniel Hamann");
    // OURS, NOT THEIRS. The vendor lane is an operational fact about how we work, and until
    // trace_history.contact_vendor existed the value shipped here was wrong on every tier 2
    // FastAppend row. It is recorded on the row, where we can read it and they cannot.
    expect(out.traces[0]).not.toHaveProperty("owner_contact_source");
    // The column feeding it must not ride out on the spread either.
    expect(out.traces[0]).not.toHaveProperty("contact_vendor");
  });

  it("never emits the internal parcel key as the address (D38)", async () => {
    // MUTATION: let `normalized_address` ride out on the `...rest` spread untouched and this
    // goes red. The select must carry parcel_id_local and county too: projectRow drops a column
    // the query never asked for, so narrowing the select turns this red as well.
    const admin = adminStub({
      profile: { id: "p1", wallet_balance: 0 },
      traces: [
        {
          id: "t1",
          normalized_address: "APN|0123-456|TRAVIS|TX",
          city: null,
          state: "TX",
          parcel_id_local: "0123-456",
          county: "Travis",
        },
      ],
    });
    const out = (await listTraces(admin, "sub-1", {})) as {
      traces: Array<Record<string, unknown>>;
    };
    expect(out.traces[0].normalized_address).toBe("Parcel 0123-456, Travis County");
    expect(JSON.stringify(out)).not.toContain("APN|");
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
  it("quotes the city-less parcel record the SUBMIT now accepts", async () => {
    // THE QUOTE IS THE MANDATORY FIRST STEP, so a shape skip_trace_bulk takes and this one throws
    // on is no unblock at all: the gateway would fail before it ever reached the submit. `city`
    // became optional on the shared recordSchema, and removeBatchDuplicates takes AddressInput,
    // which declares it required -- so the absent key has to be normalised here too.
    // MUTATION: drop the `city: record.city ?? ""` normalisation and this goes red.
    const admin = adminStub({ profile: { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"], wallet_balance: 5 } });
    const out = expectQuote(
      await skipTraceQuote(admin, "sub-1", {
        records: [
          { address: "", state: "TX", owner_name: "Jane Smith", apn: "R-123", county: "Travis" },
        ],
      }),
    );
    expect(out.after_dedup).toBe(1);
    expect(out.persons).toBe(1);
    expect(out.worst_case_cost).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET);
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
          // THE CITY IS A REAL ONE NOW, AND IT HAS TO BE. This fixture said `city: "X"`, and a
          // one-character city fails validateAddressInput ("City is required", which wants 2+).
          // That made this record UNLOOKUPABLE, which contradicts the premise the comment below
          // states: it was never a tier 2 record at all, and the submit files it no-key and free.
          // The quote only agreed with the fixture because it did not ask the question. Every
          // assertion below is unchanged; only the record now means what the test says it means.
          { address: "4 D St", city: "Dallas", state: "TX", zip: "75001" }, // no owner_name -> tier 2
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

  /* ------------------------------------------------------------------ *
   * THE QUOTE MUST NOT PROMISE A TRACE THAT WILL NOT RUN.
   *
   * `full_property_trace` was computed from isBlankOwnerRecord alone -- validateAddressInput
   * appeared NOWHERE in skipTraceQuote -- so a record with no owner AND no usable address was
   * counted as a full property trace that WILL run and WILL be billed. The submit files exactly
   * that record no-key, free, and never traces it.
   *
   * This is not a missing number, it is a false one, and it is on the surface the tool description
   * calls the mandatory first step, next to the words "those records are billed whether or not
   * anything is found". Before Phase 2B the submit refused the whole batch for such a record, so
   * the claim was never contradicted by a submit that accepted it; it is now.
   * ------------------------------------------------------------------ */
  const quoteProfile = { id: "p1", subscription_tier: "wallet", is_acquisition_pro_member: false, gateway_products: ["prop-tracer-pro"], wallet_balance: 100 };
  /** Blank owner, no street, no state: the record the submit files no-key, free. */
  const noKeyRecord = { address: "", city: "Dallas", state: "", zip: "75001" };
  const namedRecord = { owner_name: "Jane Smith", address: "1 Main St", city: "Dallas", state: "TX", zip: "75001" };
  /** Blank owner WITH a usable address: the record that genuinely does run a full property trace. */
  const tier2Record = { address: "2 B St", city: "Dallas", state: "TX", zip: "75001" };

  it("does not promise a full property trace for a record that cannot be looked up", async () => {
    // MUTATION: revert the classification to isBlankOwnerRecord alone and this goes red.
    const out = expectQuote(
      await skipTraceQuote(adminStub({ profile: quoteProfile }), "sub-1", {
        records: [namedRecord, noKeyRecord],
      }),
    );
    expect(out.full_property_trace).toBe(0);
  });

  it("does not let the unlookupable record fall into the person count instead", async () => {
    // THE REGRESSION THIS FIX COULD EASILY INTRODUCE, and it would be worse than the bug: `persons`
    // is derived by subtraction, so narrowing the blank bucket without narrowing the subtrahend
    // would quietly reclassify a record with NO owner name as a person.
    const out = expectQuote(
      await skipTraceQuote(adminStub({ profile: quoteProfile }), "sub-1", {
        records: [namedRecord, noKeyRecord],
      }),
    );
    expect(out.persons).toBe(1);
    expect(out.entities).toBe(0);
    expect(out.after_dedup).toBe(2);
  });

  it("still quotes a blank-owner record WITH a usable address as a full property trace", async () => {
    // The other direction, so the fix cannot be "delete the blank arm". This record has no owner
    // either, and it DOES run and IS billed per record submitted.
    const out = expectQuote(
      await skipTraceQuote(adminStub({ profile: quoteProfile }), "sub-1", {
        records: [namedRecord, tier2Record],
      }),
    );
    expect(out.full_property_trace).toBe(1);
    expect(out.worst_case_cost).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET + 0.4);
  });

  it("still quotes a full property trace when only the ZIP is mangled", async () => {
    // NO ZIP ARGUMENT, and this is the test that makes that load-bearing rather than incidental.
    // The submit asks validateAddressInput ONE question -- can a vendor be asked about this row --
    // and deliberately leaves the ZIP out of it, because Excel strips a leading zero on export and
    // a row with a perfectly good street, city and state must not be filed unlookupable over it.
    //
    // Adding `r.zip` here would make this quote say the record is free and will not run, while the
    // submit queues and BILLS it: an UNDER-quote, which is the one direction that is never
    // defensible. MUTATION: pass r.zip as the fourth argument and this goes red.
    const out = expectQuote(
      await skipTraceQuote(adminStub({ profile: quoteProfile }), "sub-1", {
        records: [{ address: "2 B St", city: "Dallas", state: "TX", zip: "2139" }],
      }),
    );
    expect(out.full_property_trace).toBe(1);
    expect(out.worst_case_cost).toBeCloseTo(0.4);
  });

  it("treats a one-character city as unlookupable, exactly as the submit does", async () => {
    // FOUND BY THIS FIX, and pinned so it is not lost. validateAddressInput wants a city of at
    // least two characters, so a blank-owner record carrying `city: "X"` is no-key, not tier 2 --
    // and the submit has always filed it that way. The quote disagreed only because it never asked.
    // A terse test fixture elsewhere in this file relied on the old answer and had to be corrected.
    const out = expectQuote(
      await skipTraceQuote(adminStub({ profile: quoteProfile }), "sub-1", {
        records: [{ address: "4 D St", city: "X", state: "TX", zip: "75001" }],
      }),
    );
    expect(out.full_property_trace).toBe(0);
    expect(out.worst_case_cost).toBe(0);
    // And it is NOT silently promoted to a person: it has no owner of record.
    expect(out.persons).toBe(0);
    expect(out.entities).toBe(0);
  });

  it("stops charging for the record it stopped promising to trace", async () => {
    // MUTATION: price the quote over `unique` instead of the billable subset and this goes red at
    // 0.65 against 0.25.
    const out = expectQuote(
      await skipTraceQuote(adminStub({ profile: quoteProfile }), "sub-1", {
        records: [namedRecord, noKeyRecord],
      }),
    );
    expect(out.worst_case_cost).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("PROOF: never quotes less than the submit will commit for the same batch", async () => {
    // THE PROOF OBLIGATION for lowering a number named as a ceiling. The quote feeds no gate -- it
    // is returned to the model and nothing reads it back -- so the only question that matters is
    // whether the quote can now promise LESS than the submit will actually reserve and bill. It
    // cannot, and the reason is structural: both derive from the same billable split through the
    // same worstCaseCost, and the quote dedups only INTERNALLY while the submit also drops 90-day
    // history duplicates, so the quote's set is always a superset of the submit's.
    const batch = [namedRecord, tier2Record, noKeyRecord];
    const quoted = expectQuote(
      await skipTraceQuote(adminStub({ profile: quoteProfile }), "sub-1", { records: batch }),
    );
    const { admin } = submitAdminStub({ profile: quoteProfile });
    const submitted = (await skipTraceBulk(admin, "sub-1", {
      records: batch,
      confirm: true,
    })) as { committed_worst_case: number };
    expect(quoted.worst_case_cost).toBeGreaterThanOrEqual(submitted.committed_worst_case);
    // And they AGREE exactly when nothing is dropped by history dedup, which is the common case.
    expect(quoted.worst_case_cost).toBeCloseTo(submitted.committed_worst_case);
  });

  it("PROOF: the inequality is not vacuous when history dedup drops a record", async () => {
    // The superset arm, exercised rather than asserted in prose: the submit sees one fewer record
    // than the quote did, so it commits strictly less and the quote still covers it.
    const batch = [namedRecord, tier2Record];
    const quoted = expectQuote(
      await skipTraceQuote(adminStub({ profile: quoteProfile }), "sub-1", { records: batch }),
    );
    vi.mocked(checkDuplicates).mockResolvedValueOnce({
      newRecords: [namedRecord],
      duplicates: [tier2Record],
      cachedResults: [],
    } as unknown as Awaited<ReturnType<typeof checkDuplicates>>);
    const { admin } = submitAdminStub({ profile: quoteProfile });
    const submitted = (await skipTraceBulk(admin, "sub-1", {
      records: batch,
      confirm: true,
    })) as { committed_worst_case: number };
    expect(submitted.committed_worst_case).toBeLessThan(quoted.worst_case_cost);
    expect(quoted.worst_case_cost).toBeGreaterThanOrEqual(submitted.committed_worst_case);
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
  /** The trace_history upsert's own error. It is a lever of its own because as of Phase 2B that
   *  write IS the submit on this surface: there is no vendor call left to fail, so a swallowed
   *  upsert error is the one way a caller can be told their batch is running when nothing was
   *  written. */
  upsertError?: { message: string } | null;
  /** The trace_jobs UPDATE's own error. Its own lever because it is the write that makes a failed
   *  submit terminal: if it fails too, the job is parked at 'processing' and polls forever for the
   *  Suite Gateway, and an operator reading the log is the only party who can ever find it. */
  jobUpdateError?: { message: string } | null;
}) {
  const {
    profile,
    jobId = "job-1",
    jobInsertError = null,
    upsertError = null,
    jobUpdateError = null,
  } = opts;
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
        return { error: table === "trace_history" ? upsertError : null };
      },
      single: async () =>
        table === "trace_jobs" && op === "insert"
          ? jobInsertError
            ? { data: null, error: jobInsertError }
            : { data: { id: jobId }, error: null }
          : { data: null, error: null },
      maybeSingle: async () =>
        table === "user_profiles" ? { data: profile, error: null } : { data: null, error: null },
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: table === "trace_jobs" ? jobUpdateError : null }),
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

  it("writes source:'mcp' on the trace_jobs insert AND the trace_history rows, then enqueues", async () => {
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
    // NOTHING GOES TO A VENDOR FROM HERE ANY MORE (Phase 2B, spec 3.3). The record is enqueued for
    // app/api/cron/sweep-entity-traces, which is what lets a city-less or parcel-keyed record trace
    // at all: the CSV took a street, a city and a state and nothing else.
    expect(submitBulkTrace).not.toHaveBeenCalled();
    expect(allRows[0]).toMatchObject({ ai_research_status: tier1QueuedStatusFor(1) });
    // `persons` and `entities` still describe the owner names the caller sent. They no longer
    // select a route: planRoute() decides person, company or trust inside the cron.
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

  it("still queues a NAMED entity, on the TIER 1 rung rather than the legacy entity one", async () => {
    // The other half of the split: a company name is a real owner of record, so it keeps a tier 1
    // route and keeps reserving one tier 1 charge. What changed is the RUNG. It used to write a
    // bare 'queued', which is the LEGACY entity ladder's attempt 1 on this column: a row wearing it
    // is claimed by the entity lane and handed to FastAppend on its owner name with no route
    // planned at all. The Tier 1 lane claims .in(TIER1_QUEUED_STATUSES), and the two value sets are
    // disjoint by design, so the value here decides which engine owns the row.
    const { admin, captured } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ owner_name: "Acme Holdings LLC", address: "100 Main St", city: "Dallas", state: "TX", zip: "75001" }],
      confirm: true,
    });
    expect(out).toMatchObject({ accepted: 1, persons: 0, entities: 1, full_property_trace: 0 });
    const rows = captured.traceHistoryUpserts.flatMap((u) => u.batch) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      ai_research_status: tier1QueuedStatusFor(1),
      status: "processing",
    });
    expect(rows[0].ai_research_status).not.toBe("queued");
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

  it("DOES ask the pool about a batch with no blank-owner records, and can be refused", async () => {
    // THIS TEST INVERTED IN PHASE 2B, AND IT INVERTED FOR THE RIGHT REASON. It used to assert that
    // a tier-1-only batch could never be refused, and that was true: its records went to the
    // Tracerfy BATCH endpoint, a different credit bucket from the per-record instant lookups this
    // check sizes, so this surface passed a hardcoded `tier1: 0` and the batch drew nothing here.
    //
    // Tier 1 records are on the per-record queue now and draw the same credits every instant lookup
    // draws, so a batch of 500 named records can exhaust the pool. Being unable to refuse it would
    // be accepting -- and later billing -- a job PTP cannot run, which is the one outcome this check
    // exists to prevent. Nothing is written when it refuses.
    // MUTATION: pass `tier1: 0` again and this goes red.
    H.canRunTier2 = false;
    const { admin, captured } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", {
      records: [{ owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" }],
      confirm: true,
    });
    expect(out).toMatchObject({ error: "capacity_unavailable" });
    expect(captured.traceHistoryUpserts).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- *
   * THE SIX TESTS THAT USED TO LIVE HERE FENCED THE TRACERFY PERSON CSV SUBMIT FAILING while other
   * work survived: which counts were corrected, which job was failed, and which sentence the
   * caller got. Phase 2B deletes that submit (spec 3.3), so there is no vendor call at submit to
   * fail and no partial survival to describe. Each one is rewritten below rather than dropped,
   * repointed at the contract that replaced it -- the counting rule, and the ONE failure this
   * surface has left, which is the row write. Four of them moved into "when the rows cannot be
   * written" at the end of this describe, where that failure is fenced together.
   * ---------------------------------------------------------------- */

  it("counts and prices only the records a vendor is asked about", async () => {
    // HEIR TO "stops counting and pricing the errored person records". Its subject -- a person half
    // that died at the vendor -- is gone, but the rule it protected is the same one and now has a
    // new population to protect it from: a record nobody can be asked about at all. It is written
    // terminal and free, so counting it in `accepted` would claim work that is not running, and
    // pricing it in `committed_worst_case` would quote a charge for a vendor call nobody makes.
    // MUTATION: quote worstCaseCost over newRecords instead of the billable records, or count the
    // no-key rows in `accepted`, and this goes red.
    const { admin, captured } = submitAdminStub({ profile: linked });
    const out = (await skipTraceBulk(admin, "sub-1", {
      records: [
        { owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" },
        { address: "2 B St", city: "Dallas", state: "TX", zip: "75001" },
        { address: "", city: "", state: "", zip: "75001" },
      ],
      confirm: true,
    })) as Record<string, unknown>;

    expect(out.accepted).toBe(2);
    expect(out.persons).toBe(1);
    expect(out.full_property_trace).toBe(1);
    // One tier 1 record at the per-success rate plus one tier 2 record at the per-record rate. The
    // third record is in neither term.
    expect(out.committed_worst_case).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET + 0.4);
    // And the match-rate denominator agrees: three rows were written, two are being worked.
    expect(captured.traceHistoryUpserts.flatMap((u) => u.batch)).toHaveLength(3);
    expect(captured.traceJobsInsert).toMatchObject({ records_submitted: 2, total_records: 3 });
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

  it("makes no claim about charges on a submit that succeeded", async () => {
    // HEIR TO "carries the failure as a FIELD, because a model reads this payload". That test
    // fenced two things: that a failure is a structured field a model cannot summarise away, and
    // that the sentence beside it carries no formatting artifacts. The field half moved to
    // "does NOT answer success" below, where the failure now lives. This half is what is left of
    // the sentence: there is no partial-failure message any more, so the happy-path payload must
    // not carry a leftover claim about what was or was not charged -- the caller is charged per
    // successful tier 1 trace and per tier 2 record submitted, settled later by bulk_status.
    const { admin } = submitAdminStub({ profile: linked });
    const out = (await skipTraceBulk(admin, "sub-1", {
      records: [
        { owner_name: "John Smith", address: "1 A St", city: "Dallas", state: "TX", zip: "75001" },
      ],
      confirm: true,
    })) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/not charged/i);
    expect(JSON.stringify(out)).not.toMatch(/[—–]/);
    expect(out.records_failed).toBe(0);
  });

  it("PROOF: the wallet gate reserves what the submit will bill, and not the rows it will not", async () => {
    // THE GATE-SIDE HALF OF THE PROOF for lowering the quote. The submit's reserve is computed
    // INDEPENDENTLY of the quote, from billableRecords, and this pins the boundary exactly: one
    // tier 1 record at 0.25 plus one tier 2 record at 0.40 is 0.65, and the no-key record beside
    // them adds nothing. A wallet holding exactly 0.65 is let through; one cent less is refused.
    //
    // It is also the fence against the opposite mistake. If the gate priced the no-key row like the
    // quote used to, the reserve would be 1.05 and the 0.65 wallet would be refused a job it can
    // afford. MUTATION: price the gate over newRecords instead of billableRecords and this goes red.
    const batch = [
      rec("Jane Smith", 1),
      rec(undefined, 2),
      rec(undefined, 3, { address: "", state: "" }),
    ];
    const exact = submitAdminStub({ profile: { ...linked, wallet_balance: 0.65 } });
    const accepted = await skipTraceBulk(exact.admin, "sub-1", { records: batch, confirm: true });
    expect(accepted).not.toHaveProperty("error");
    expect((accepted as { committed_worst_case: number }).committed_worst_case).toBeCloseTo(0.65);

    const short = submitAdminStub({ profile: { ...linked, wallet_balance: 0.64 } });
    const refused = await skipTraceBulk(short.admin, "sub-1", { records: batch, confirm: true });
    expect(refused).toMatchObject({ error: "insufficient_balance" });
    expect(short.captured.traceHistoryUpserts).toHaveLength(0);
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

  /* ================================================================== *
   * PHASE 2B: PER-RECORD JUDGING, THE TIER 1 ENQUEUE, AND THE CLAMPS.
   *
   * Everything below mirrors the fences app/api/v1/trace/bulk/route.ts
   * grew in the same phase. That route is the source of truth this
   * surface mirrors, so a rule fenced there and not here is a rule the
   * two surfaces are free to disagree about.
   * ================================================================== */

  /** One submitted record. `extra` overrides any field, because the cases worth fencing now are
   *  the malformed ones -- no city, no street, a ZIP Excel mangled, a parcel id instead of a
   *  street, a value the column cannot hold -- and they have to be expressible here. */
  const rec = (owner_name?: string, n = 1, extra: Record<string, unknown> = {}) => ({
    owner_name,
    address: `${n} Main St`,
    city: "Dallas",
    state: "TX",
    zip: "75001",
    ...extra,
  });

  /** Submits through the real skipTraceBulk() and returns every trace_history row it upserted. */
  async function submit(records: unknown[]) {
    const { admin, captured } = submitAdminStub({ profile: linked });
    const out = await skipTraceBulk(admin, "sub-1", { records, confirm: true });
    return {
      out: out as Record<string, unknown>,
      rows: captured.traceHistoryUpserts.flatMap((u) => u.batch),
      captured,
    };
  }

  describe("recordSchema stops refusing the Suite Gateway's parcel request", () => {
    it("accepts a record with no city key at all, which is what blocked the gateway", () => {
      // THE ACTUAL BLOCKER, AND IT WAS NEVER THE VALIDATOR. `city: z.string()` refused an
      // APN-bearing parcel request -- parcel id, county and state, no city -- before
      // skipTraceBulk ran a line, so no guard inside it could ever have been reached.
      expect(
        recordSchema.safeParse({ address: "", state: "TX", apn: "R-123", county: "Travis" })
          .success,
      ).toBe(true);
    });

    it("still refuses a record that OMITS address, and that is not this task's to fix", () => {
      // RECORDED FOR THE GATEWAY HANDOFF, not fixed here. `address: z.string()` is still
      // required, so `address: ''` is accepted and an absent `address` key is refused by Zod
      // before any guard runs. A gateway caller must send the key, empty when it has no street.
      expect(recordSchema.safeParse({ city: "Austin", state: "TX" }).success).toBe(false);
      expect(recordSchema.safeParse({ address: "", city: "Austin", state: "TX" }).success).toBe(
        true,
      );
    });

    it("accepts a record with no city when it carries a parcel key", async () => {
      const { out } = await submit([
        {
          address: "",
          city: "",
          state: "TX",
          owner_name: "Jane Smith",
          apn: "R-123",
          county: "Travis",
        },
      ]);
      expect(out).not.toHaveProperty("error");
    });

    it("runs the whole batch when the city key is ABSENT rather than empty", async () => {
      // An absent key and an empty one say the identical thing -- the caller gave us no city --
      // and the gateway's parcel request omits it entirely.
      const { out, rows } = await submit([
        { address: "", state: "TX", owner_name: "Jane Smith", apn: "R-123", county: "Travis" },
        rec("John Doe", 2),
      ]);
      expect(out).not.toHaveProperty("error");
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.ai_research_status === tier1QueuedStatusFor(1))).toBe(true);
      expect(rows.find((r) => r.input_owner_name === "Jane Smith")!.city).toBe("");
    });

    // The APN has been stored on every row since before 2A and read by nothing on the tier 1
    // lane, because MCP rows never wore a tier1_ status. This is the assertion that it is now
    // reachable: the cron's own parcelForTier1Row is what consumes it.
    it("puts the stored parcel key within reach of the Tier 1 cron", async () => {
      const { rows } = await submit([
        {
          address: "1 Main St",
          city: "Austin",
          state: "TX",
          owner_name: "Jane Smith",
          apn: "R-123",
          county: "Travis",
        },
      ]);
      expect(rows[0].parcel_id_local).toBe("R-123");
      expect(TIER1_QUEUED_STATUSES).toContain(rows[0].ai_research_status);
    });
  });

  describe("per-record judging replaces the whole-batch refusal", () => {
    // MUTATION: restore the `if (invalidRecords.length > 0) return { error: 'invalid_records' }`
    // block and every test in this describe goes red.
    it("runs the good records when one record has no city", async () => {
      const { out, rows } = await submit([rec("Jane Smith", 1), rec("John Doe", 2, { city: "" })]);
      expect(out).not.toHaveProperty("error");
      expect(out.accepted).toBe(2);
      expect(rows).toHaveLength(2);
    });

    // The ZIP is the sharpest case: Excel strips a leading zero on export, so the four-argument
    // validate killed entire New England and Puerto Rico files.
    it("does not reject a batch over a malformed ZIP", async () => {
      const { out, rows } = await submit([rec("Jane Smith", 1, { zip: "2139" })]);
      expect(out).not.toHaveProperty("error");
      // THE CONSEQUENCE, not the acceptance: the row runs, and the mangled ZIP is dropped at the
      // write by usableZip rather than stored and sent to a vendor to contradict its own street.
      // MUTATION: put the old `(record.zip || '').substring(0, 5)` back and this goes red.
      expect(rows[0].ai_research_status).toBe(tier1QueuedStatusFor(1));
      expect(rows[0].zip).toBe("");
    });

    it("files a BLANK-OWNER record with no street and no state as no-key, free, without queueing it", async () => {
      // Blank owner, because the no-key bucket is only ever reachable from a blank owner: a
      // record with an owner name is Tier 1 whatever its address, and settles inside the cron.
      const { rows } = await submit([rec(undefined, 1, { address: "", state: "" })]);
      expect(rows[0].property_trace_status).toBe(PROPERTY_TRACE_NO_KEY_STATUS);
      expect(rows[0].ai_research_status).toBeNull();
      expect(rows[0].status).toBe("no_match");
      // FREE MEANS THE KEY IS NEVER WRITTEN, not that it is written as zero. `charge ?? 0` passed
      // either way, so it could not detect a row that started carrying a charge it should not. The
      // row is REUSED on an upsert, so writing 0 would also overwrite a real charge from an earlier
      // paid trace; absent is the only correct state. Same form this file uses for the tier 2 row.
      for (const paid of ["charge", "ai_research_charge", "tier"]) {
        expect(Object.keys(rows[0])).not.toContain(paid);
      }
      // AND THE OUTCOME COLUMN IS NULL, NEVER 'no_lookup_key'. This row is terminal at birth and no
      // cron ever claims it, so it never acquires the TIER 1 outcome code that shares this key's
      // name. The count reported as `no_lookup_key` is named for the shared vocabulary, not for a
      // value this row carries; see the comment on that key.
      expect(rows[0].outcome_code).toBeNull();
    });

    /* ---------------------------------------------------------------- *
     * THE no_lookup_key COUNT. Owner ruling, 2026-09-25.
     *
     * A row nobody can be asked about was in NONE of this payload's counts -- not `accepted`, not
     * `full_property_trace`, not `records_failed` -- and unlike the v1 route's response there is no
     * total here to subtract from, so it could not even be derived. It was completely invisible: a
     * caller sending 3 records and reading `accepted: 2` could not tell whether the third was a
     * duplicate or unlookupable.
     * ---------------------------------------------------------------- */
    it("counts the rows nobody can be asked about, which were invisible before", async () => {
      // THE TWO NO-KEY RECORDS MUST DIFFER IN THEIR STREET, and that is a fact about the key rather
      // than about this test. traceKeyFor falls back to STREET||STATE when there is no street AND
      // city pair, so two records with no street and no state hash IDENTICALLY and
      // removeBatchDuplicates collapses them into one -- the collision the spec records for that
      // fallback rather than solves. Written with two blank ones this asserted 2 and measured 1.
      // So: one with no street at all, one with a street too short to look anything up by. Both are
      // no-key, and they key apart.
      // MUTATION: drop no_lookup_key from the response and this goes red.
      const { out } = await submit([
        rec(undefined, 1, { address: "", state: "" }),
        rec(undefined, 2, { address: "A", state: "" }),
        rec("Jane Smith", 3),
      ]);
      expect(out.no_lookup_key).toBe(2);
      // ADDITIVE, so every other count still says exactly what it said before.
      expect(out.accepted).toBe(1);
      expect(out.persons).toBe(1);
      expect(out.full_property_trace).toBe(0);
      expect(out.records_failed).toBe(0);
    });

    it("keeps no_lookup_key present and zero when every record has a key", async () => {
      // A key that appears only when it is non-zero is one nobody writes a branch for, which is the
      // same rule `records_failed` is held to.
      const { out } = await submit([rec("Jane Smith", 1)]);
      expect(out.no_lookup_key).toBe(0);
      expect(Object.keys(out)).toContain("no_lookup_key");
    });

    it("carries no_lookup_key on the all-duplicates path too, where nothing was judged", async () => {
      // The other exit this tool can succeed through. Nothing reached the split on this path, so
      // nothing lacked a lookup key -- and a caller branching on the key would otherwise get
      // undefined from the one response that is otherwise the simplest to handle.
      vi.mocked(checkDuplicates).mockResolvedValueOnce({
        newRecords: [],
        duplicates: [rec("Jane Smith", 1)],
        cachedResults: [],
      } as unknown as Awaited<ReturnType<typeof checkDuplicates>>);
      const { out } = await submit([rec("Jane Smith", 1)]);
      expect(out).toMatchObject({ job_id: null, accepted: 0, no_lookup_key: 0 });
      expect(Object.keys(out)).toContain("no_lookup_key");
    });

    it("never files a NAMED record as no-key, however broken its address (D4)", async () => {
      // A company traces on name and state alone, and a person with no lookup key settles
      // no_lookup_key, free, with a sentence, INSIDE the cron. Filing it no-key here would deny
      // both of them the route that exists for them.
      const { rows } = await submit([rec("Jane Smith", 1, { address: "", state: "" })]);
      expect(rows[0].ai_research_status).toBe(tier1QueuedStatusFor(1));
      expect(rows[0].property_trace_status).toBeNull();
    });

  });

  /* ---------------------------------------------------------------- *
   * A VALUE THE COLUMN CANNOT HOLD IS THE LAST DOOR WHOLE-BATCH REJECTION HAD.
   *
   * trace_history.state is VARCHAR(2) (supabase/schema.sql:69). Once records are judged one at a
   * time a record carrying "Texas" reaches the insert as "TEXAS", Postgres raises 22001, the
   * write throws, and the WHOLE BATCH dies -- whole-batch rejection through a different door, in
   * the change whose purpose is deleting it. Until this phase the only thing protecting this
   * surface was the whole-batch refusal that is now gone.
   *
   * WHAT THESE TESTS CANNOT SEE, SAID PLAINLY. submitAdminStub mocks Supabase, so it enforces no
   * column width: the 22001 cannot happen here. `tsc` cannot catch it either, because
   * lib/supabase/admin.ts builds the client with NO `Database` generic, so neither column names
   * nor widths are typed.
   *
   * SO BE EXACT ABOUT WHAT IS FENCED WHERE, because an earlier draft of this comment cited a unit
   * test suite that does not exist:
   *   - The CLAMP'S BEHAVIOUR on this surface is fenced by the four tests below plus the padded
   *     state one, and by their twins on app/api/v1/trace/bulk.
   *   - storableValue() ITSELF has NO direct unit tests anywhere in the repo. Every assertion on it
   *     is indirect, through these two bulk surfaces.
   *   - The WIDTH VALUES are facts about the table, from supabase/schema.sql:68-69 and
   *     supabase/migrations/20260919_trace_history_parcel_key.sql:19-22, mirrored in
   *     TRACE_HISTORY_WIDTH. Nothing in the suite checks that mirror still matches the DDL.
   *   - The OVERFLOW ITSELF can only be caught by a live check.
   * ---------------------------------------------------------------- */
  describe("a value the column cannot hold is treated as absent, not as a dead batch", () => {
    it("does not let one record saying Texas kill the batch, and keys it on what it STORED", async () => {
      // THE PLACEMENT IS THE WHOLE TEST. Clamping at the row write instead of before the key is
      // derived would store "" while keying on "TEXAS", which is precisely the D36 divergence
      // spec 6.3 exists to close.
      // MUTATION: drop the state clamp and this goes red on the stored value.
      const { out, rows } = await submit([
        rec("Jane Smith", 1, { state: "Texas" }),
        rec("John Doe", 2),
      ]);
      expect(out).not.toHaveProperty("error");
      expect(rows).toHaveLength(2);
      const texan = rows.find((r) => r.input_owner_name === "Jane Smith")!;
      expect(texan.state).toBe("");
      expect(texan.ai_research_status).toBe(tier1QueuedStatusFor(1));
      // ONE VALUE, seen by the key derivation and by the row write alike (spec 6.3, D36).
      expect(texan.normalized_address).toBe("1 MAIN ST|DALLAS|");
      expect(String(texan.normalized_address)).not.toContain("TEXAS");
      expect(texan.address_hash).toBe(createAddressHash("1 MAIN ST|DALLAS|"));
    });

    it("keeps a padded two-letter state, which the column CAN hold", async () => {
      // The clamp measures the TRIMMED value, and it has to: "  tx  " is six characters and two
      // letters. It also closes a second latent overflow, because the row write upcases whatever
      // it is given and "  TX  " does not fit VARCHAR(2) either.
      const { rows } = await submit([rec("Jane Smith", 1, { state: "  tx  " })]);
      expect(rows[0].state).toBe("TX");
    });

    it("does not let an over-long city kill the batch", async () => {
      // MUTATION: drop the city clamp and this goes red.
      const { rows } = await submit([
        rec("Jane Smith", 1, { city: "C".repeat(101) }),
        rec("John Doe", 2),
      ]);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.input_owner_name === "Jane Smith")!.city).toBe("");
    });

    it("does not let an over-long parcel id kill the batch", async () => {
      // MUTATION: drop the parcel id clamp and this goes red.
      const { rows } = await submit([
        rec("Jane Smith", 1, { address: "", city: "", apn: "R".repeat(65), county: "Travis" }),
        rec("John Doe", 2),
      ]);
      const row = rows.find((r) => r.input_owner_name === "Jane Smith")!;
      expect(row.parcel_id_local).toBeNull();
      // And the key does not take the APN branch, because there is no storable parcel id to key on.
      expect(row.normalized_address).toBe("||TX");
    });

    it("does not let an over-long county kill the batch", async () => {
      // MUTATION: drop the county clamp and this goes red.
      const { rows } = await submit([
        rec("Jane Smith", 1, { address: "", city: "", apn: "R-123", county: "T".repeat(65) }),
        rec("John Doe", 2),
      ]);
      const row = rows.find((r) => r.input_owner_name === "Jane Smith")!;
      expect(row.county).toBeNull();
      expect(row.normalized_address).toBe("||TX");
    });
  });

  describe("the Tier 1 enqueue", () => {
    // ASSERT THE CONSEQUENCE, NOT THE FIELD: tier1_queued is the value the cron's
    // .in(TIER1_QUEUED_STATUSES) claim actually matches. A bare 'queued' is the LEGACY entity
    // ladder's attempt 1 on the same column, and a row wearing it is handed to FastAppend on its
    // owner name with no route planned at all.
    it("queues a named record onto the TIER 1 queue, not the legacy entity ladder", async () => {
      const { rows } = await submit([rec("Acme Holdings Llc", 1)]);
      expect(rows[0].ai_research_status).toBe(tier1QueuedStatusFor(1));
      expect(TIER1_QUEUED_STATUSES).toContain(rows[0].ai_research_status);
      expect(rows[0].ai_research_status).not.toBe("queued");
      expect(rows[0].status).toBe("processing");
      // WRITTEN null, not omitted: the upsert reuses this row, and a stale CSV-era
      // tracerfy_job_id -- every named record on this surface went to the batch endpoint until
      // this change -- would let the CSV settle paths bill a row the Tier 1 cron also owns.
      expect(Object.keys(rows[0])).toContain("tracerfy_job_id");
      expect(rows[0].tracerfy_job_id).toBeNull();
    });

    it("makes no person/entity distinction at submit any more", async () => {
      const { rows } = await submit([rec("Acme Holdings Llc", 1), rec("Jane Smith", 2)]);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.ai_research_status === tier1QueuedStatusFor(1))).toBe(true);
    });

    it("never builds a Tracerfy person CSV", async () => {
      await submit([rec("Jane Smith", 1)]);
      expect(submitBulkTrace).not.toHaveBeenCalled();
    });

    it("writes tracerfy_job_id null on EVERY row, tier 2 and no-key included", async () => {
      // WRITTEN, NOT OMITTED, on all three buckets. The upsert is
      // onConflict: 'user_id,address_hash', so the row is REUSED and an omitted key leaves whatever
      // it already carried. A CSV-era row from this very surface can carry a live tracerfy_job_id --
      // every named record here went to the Tracerfy batch endpoint until this change -- and both
      // CSV settle paths find their billable rows by that column. A stale value on a tier 2 row has
      // it billed the tier 1 rate by an engine that does not know it is tier 2; on a terminal,
      // FREE no-key row it hands a finished row to a settle path that bills; and it surfaces in the
      // OLD job's results either way.
      // MUTATION: omit the key from any one of the three buckets and this goes red.
      const { rows } = await submit([
        rec("Jane Smith", 1),
        rec(undefined, 2),
        rec(undefined, 3, { address: "", state: "" }),
      ]);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(Object.keys(row)).toContain("tracerfy_job_id");
        expect(row.tracerfy_job_id).toBeNull();
      }
    });

    it("never sets tracerfy_job_id on the job row either", async () => {
      // There is no Tracerfy batch job to point at any more, and a job id here is what both CSV
      // settle paths find their billable rows by.
      const { captured } = await submit([rec("Jane Smith", 1)]);
      for (const update of captured.traceJobsUpdates) {
        expect(Object.keys(update as Record<string, unknown>)).not.toContain("tracerfy_job_id");
      }
      expect(Object.keys(captured.traceJobsInsert ?? {})).not.toContain("tracerfy_job_id");
    });

    // MUTATION: change `tier1: tier1Records.length` back to `tier1: 0` and this goes red. It is
    // the FIRST assertion in this file on tracerfyCanRun's arguments: the only
    // toHaveBeenCalledWith calls here were against limitFn, so the hardcoded 0 was unfenced.
    it("sizes the credit pool against the real Tier 1 count", async () => {
      await submit([rec("Jane Smith", 1), rec(undefined, 2)]);
      expect(tracerfyCanRun).toHaveBeenCalledWith(expect.anything(), { tier1: 1, tier2: 1 });
    });

    it("asks the pool for NOTHING when nobody can be asked about the batch", async () => {
      // A no-key row draws no credits from either pool, and the real tracerfyCanRun short circuits
      // 0/0 to true without spending a vendor round trip -- so such a batch can never be refused
      // for capacity. THAT half is fenced in lib/trace/__tests__/bulkPreflight.test.ts, not here:
      // this file replaces the function with a lever, and the lever answers every call, so it can
      // refuse a 0/0 batch the real one never would. What THIS surface controls is what it ASKS,
      // which is what this asserts.
      await submit([rec(undefined, 1, { address: "", state: "" })]);
      expect(tracerfyCanRun).toHaveBeenCalledWith(expect.anything(), { tier1: 0, tier2: 0 });
    });
  });

  describe("the duplicate key aligns with the single surfaces (spec 6.3, D36)", () => {
    // MUTATION: put normalizeAddress back in buildHistoryRow and this goes red. The dedup hash
    // and the stored hash would then disagree for any parcel-keyed record, and the same record
    // sent through single and bulk would land on two rows.
    it("keys a city-less record on its parcel, exactly as traceKeyFor does", async () => {
      const record = {
        address: "",
        city: "",
        state: "TX",
        owner_name: "Jane Smith",
        apn: "R-123",
        county: "Travis",
      };
      const { rows } = await submit([record]);
      expect(rows[0].normalized_address).toBe(traceKeyFor(record));
      expect(rows[0].normalized_address).toBe("APN|R-123|TRAVIS|TX");
      expect(rows[0].address_hash).toBe(createAddressHash(traceKeyFor(record)));
      // THE DIVERGENCE THIS EXISTS TO STOP. checkDuplicates already hashes with traceKeyFor; the
      // row builder stored normalizeAddress. For a parcel-keyed record those are two different
      // keys, so the row dedup looked for is not the row that was written, and every street-less
      // parcel in one batch collided on one row.
      expect(rows[0].address_hash).not.toBe(createAddressHash(normalizeAddress("", "", "TX")));
    });

    it("stores the parcel id and county it was given (D23)", async () => {
      const { rows } = await submit([rec("Jane Smith", 1, { apn: "R-123", county: "Travis" })]);
      expect(rows[0].parcel_id_local).toBe("R-123");
      expect(rows[0].county).toBe("Travis");
    });
  });

  describe("D33: a reused row does not answer with a stale outcome", () => {
    it("clears outcome_code, found_by and trace_steps on a reused row", async () => {
      // A trace_history row is REUSED (UNIQUE(user_id, address_hash)), and this surface never
      // cleared the Tier 1 answer on it, so a sentence written for an earlier trace could answer
      // for this one: "You were not charged" over a row this job is about to charge.
      const { rows } = await submit([rec("Jane Smith", 1)]);
      expect(rows[0]).toMatchObject({ outcome_code: null, found_by: null, trace_steps: null });
    });

    it("does NOT clear them on a busy resume, which needs the step log", async () => {
      // The one exemption, and it is money: a busy row's step log is what stops the resend buying
      // the answers this record already paid for.
      vi.mocked(checkDuplicates).mockResolvedValueOnce({
        newRecords: [rec("Jane Smith", 1)],
        duplicates: [],
        cachedResults: [
          {
            address_hash: createAddressHash(traceKeyFor(rec("Jane Smith", 1))),
            outcome_code: TIER1_OUTCOME.BUSY_TRY_AGAIN,
          },
        ],
      } as unknown as Awaited<ReturnType<typeof checkDuplicates>>);
      const { rows } = await submit([rec("Jane Smith", 1)]);
      // ALL THREE FIELDS THE SPREAD CLEARS TOGETHER. Asserting two of them let the third be
      // deleted from the exemption unnoticed, and `found_by` is the one carrying the disclosed cost
      // this exemption exists to avoid paying twice: it is the label on a row that may already hold
      // paid contacts.
      // MUTATION: delete found_by from the exemption spread and this goes red.
      expect(Object.keys(rows[0])).not.toContain("outcome_code");
      expect(Object.keys(rows[0])).not.toContain("found_by");
      expect(Object.keys(rows[0])).not.toContain("trace_steps");
    });
  });

  describe("when the rows cannot be written", () => {
    // THE ROW WRITE IS THE SUBMIT NOW. There is no vendor call left at submit, so nothing stands
    // between the caller and this upsert. The old code awaited it and discarded its error: the
    // caller would be told their batch was accepted, bulk_status would find no pending rows on
    // its first poll and finalize the job `completed` with records_matched 0, and its own early
    // return makes that verdict permanent. The customer sent 500 rows, was told it worked, and
    // reads an empty results array.
    //
    // THREE OF THE FOUR TESTS HERE ARE REWRITES of the person-submit-failure tests deleted above,
    // repointed from the vendor failure that no longer exists to the write failure that replaced
    // it: "does NOT answer success" inherits the structured-failure fence, "writes the job
    // terminal" inherits the trace_jobs correction, and "stops at the FIRST failed bucket"
    // inherits the partial-survival rule.
    // SILENCED HERE AND RESTORED AFTERWARDS. Without the restore the spy outlives this describe --
    // there is no `restoreMocks` in vitest.config.ts -- so every later describe in the file,
    // bulk_status included, ran with console.error swallowed. Nothing depended on it, and that is
    // the point: a real error in those tests would have vanished silently.
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.mocked(console.error).mockRestore();
    });

    it("stops at the FIRST failed bucket rather than writing rows it cannot report on", async () => {
      // The buckets are written one statement at a time, and insertHistoryRows THROWS on the first
      // failure rather than logging and continuing. So a batch whose no-key bucket fails never
      // attempts the Tier 1 bucket: the caller is told the submit failed and no row is left queued
      // and running behind a failure they were told about.
      // MUTATION: swallow the error inside insertHistoryRows and all three buckets get written
      // under a job answering success.
      const { admin, captured } = submitAdminStub({
        profile: linked,
        upsertError: { message: "boom" },
      });
      const out = await skipTraceBulk(admin, "sub-1", {
        records: [rec(undefined, 1, { address: "", state: "" }), rec("Jane Smith", 2)],
        confirm: true,
      });
      expect(out).toMatchObject({ error: "submit_failed" });
      expect(captured.traceHistoryUpserts).toHaveLength(1);
    });

    it("does NOT answer success, which is what hid this before", async () => {
      // MUTATION: swallow the upsert error (drop insertHistoryRows' throw, or catch and ignore)
      // and this goes red.
      const { admin } = submitAdminStub({
        profile: linked,
        upsertError: { message: 'value too long for type character varying(2)' },
      });
      const out = await skipTraceBulk(admin, "sub-1", {
        records: [rec("Jane Smith", 1)],
        confirm: true,
      });
      expect(out).toMatchObject({ error: "submit_failed" });
      expect(out).not.toHaveProperty("job_id");
    });

    it("writes the job terminal, so bulk_status cannot finalize it as an empty success", async () => {
      const { admin, captured } = submitAdminStub({
        profile: linked,
        upsertError: { message: "boom" },
      });
      await skipTraceBulk(admin, "sub-1", { records: [rec("Jane Smith", 1)], confirm: true });
      const failed = captured.traceJobsUpdates.filter(
        (u) => (u as Record<string, unknown>)?.status === "failed",
      );
      expect(failed).toHaveLength(1);
    });

    it("keeps the raw database text out of the caller's payload", async () => {
      // trace_jobs.error_message is returned verbatim by bulk_status, and the thrown message
      // names a table and raw Postgres text. The caller-facing sentence is the fixed generic one
      // both REST routes already write; the detail goes to the server log.
      const { admin, captured } = submitAdminStub({
        profile: linked,
        upsertError: { message: "duplicate key value violates unique constraint trace_history_pkey" },
      });
      const out = await skipTraceBulk(admin, "sub-1", {
        records: [rec("Jane Smith", 1)],
        confirm: true,
      });
      expect(JSON.stringify(out)).not.toContain("trace_history_pkey");
      const failed = captured.traceJobsUpdates.find(
        (u) => (u as Record<string, unknown>)?.status === "failed",
      ) as Record<string, unknown>;
      expect(String(failed.error_message)).not.toContain("trace_history_pkey");
      expect(String(failed.error_message)).not.toMatch(/[—–*]/);
      expect(console.error).toHaveBeenCalled();
    });

    it("logs the job id when it cannot even write the job terminal, so it stays findable", async () => {
      // THE SECOND WRITE CAN FAIL TOO, and its error may not be swallowed either. The caller is
      // already being told this failed, so there is no success to withdraw and a log is the only
      // action left -- but the job is then parked at 'processing' and polls forever for the Suite
      // Gateway, and an operator is the only party who can find it. Not logging the id is how an
      // orphaned job becomes undiscoverable.
      // MUTATION: drop the `if (failWriteError)` log and this goes red.
      const { admin } = submitAdminStub({
        profile: linked,
        upsertError: { message: "boom" },
        jobUpdateError: { message: "trace_jobs is unreachable" },
      });
      const out = await skipTraceBulk(admin, "sub-1", {
        records: [rec("Jane Smith", 1)],
        confirm: true,
      });
      expect(out).toMatchObject({ error: "submit_failed" });
      expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("job-1");
    });
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

  it("never emits the internal parcel key as a record's address (D38)", async () => {
    // MUTATION: put `address: row.normalized_address` back in buildPerRecordResult and this
    // goes red. Its twin in app/api/v1/trace/bulk/status has the same test; payloadParity
    // compares the two key sets, so the two surfaces stay one payload.
    const { admin } = statusAdminStub({
      profile,
      job: { id: "job-1", user_id: "p1", status: "completed", records_submitted: 1, records_matched: 0 },
      rows: [
        {
          id: "r1",
          status: "no_match",
          normalized_address: "APN|0123-456|TRAVIS|TX",
          city: null,
          state: "TX",
          parcel_id_local: "0123-456",
          county: "Travis",
          is_successful: false,
          charge: 0,
          ai_research_status: null,
        },
      ],
    });
    const out = (await bulkStatus(admin, "sub-1", { job_id: "job-1" })) as {
      results: Array<Record<string, unknown>>;
    };
    expect(out.results[0].address).toBe("Parcel 0123-456, Travis County");
    expect(JSON.stringify(out)).not.toContain("APN|");
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
      results: Array<Record<string, unknown> & { input_owner_name: string }>;
    };

    const magnolia = out.results.find((r) => r.input_owner_name === "Magnolia Property Company")!;
    expect(magnolia.owner_contact_name).toBe("Daniel Hamann");
    // OURS, NOT THEIRS. See the listTraces twin: removed from BOTH payloads together, which
    // lib/trace/__tests__/payloadParity.test.ts requires.
    expect(magnolia).not.toHaveProperty("owner_contact_source");

    const fountain = out.results.find(
      (r) => r.input_owner_name === "Fountain Parc Apartments LLC",
    )!;
    expect(fountain.owner_contact_name).toBeNull();
    // Absent, not null: the key is gone from the payload entirely, for every row and not
    // only the ones that resolved somebody.
    expect(fountain).not.toHaveProperty("owner_contact_source");
  });

  /**
   * THE TIER 1 QUEUE HOLDS THE JOB OPEN TOO, and it is not this tool's own gate that used to do
   * it. `lib/trace/tier1Queue` is not imported into mcp-tools.ts at all: isPendingResearch asks
   * isEntityTracePending, the LEGACY predicate, which holds no tier1_ value, and the
   * status === 'processing' arm catches a queued Tier 1 row only incidentally -- the Tier 1 cron
   * writes the row's delivery `status` before it clears the queue column, so the overlap ends on
   * exactly the row that matters. Without `isRowStillWorking` in the disjunction this tool
   * finalizes over live, billable Tier 1 work, and would report `completed` while the job's
   * trace_jobs row is still 'processing'. Mirrors Task 3's twin in
   * app/api/v1/trace/bulk/status/__tests__/route.test.ts. Per the 2026-09-25 controller ruling
   * this task takes only the pending-gate fix -- records_matched stays the flat is_successful
   * count, so only three of that file's four tests are mirrored here; a fourth asserting a
   * matched LEGACY row does NOT count as a Tier 1 match would assert the wrong behaviour under
   * this ruling.
   */
  describe("the Tier 1 queue holds the job open too", () => {
    it("reports processing while a Tier 1 row is queued", async () => {
      // MUTATION: drop the isRowStillWorking arm from the disjunction and this goes red. Neither
      // remaining arm recognizes a tier1_ value, so this job would read as finished and get
      // written 'completed' while row r1's Tier 1 work is still live.
      const { admin, captured } = statusAdminStub({
        profile,
        job: { id: "job-1", user_id: "p1", status: "processing", records_submitted: 2 },
        rows: [
          {
            id: "r1",
            status: "success",
            tracerfy_job_id: null,
            is_successful: true,
            charge: 0,
            ai_research_status: "tier1_queued",
            property_trace_status: null,
          },
          {
            id: "r2",
            status: "success",
            tracerfy_job_id: null,
            is_successful: true,
            charge: 0,
            ai_research_status: "tier1_done",
            property_trace_status: null,
          },
        ],
      });
      const out = await bulkStatus(admin, "sub-1", { job_id: "job-1" });
      expect(out).toMatchObject({ status: "processing" });
      // And the job row is NOT written completed, which is what would stop it ever being
      // polled again.
      expect(captured.traceJobsUpdates).toHaveLength(0);
    });

    it("stays processing even after the cron has flipped status off processing", async () => {
      // The incidental status === 'processing' arm cannot be what holds this row open: the Tier 1
      // cron writes the row's delivery status before it clears ai_research_status, so a poll that
      // lands in between sees a terminal `status` next to a still-queued Tier 1 value.
      const { admin } = statusAdminStub({
        profile,
        job: { id: "job-1", user_id: "p1", status: "processing", records_submitted: 1 },
        rows: [
          {
            id: "r1",
            status: "no_match",
            tracerfy_job_id: null,
            is_successful: false,
            charge: 0,
            ai_research_status: "tier1_queued_3",
            property_trace_status: null,
          },
        ],
      });
      const out = await bulkStatus(admin, "sub-1", { job_id: "job-1" });
      expect(out).toMatchObject({ status: "processing" });
    });

    it("completes once every Tier 1 row is settled, and counts the successes", async () => {
      // The other side of the fence: a terminal tier1_done value must read as NOT pending, or the
      // job is held open forever and never reports at all. records_matched is the pre-existing
      // flat is_successful count (Amendment 1: left untouched), not recordsMatchedFor.
      const { admin } = statusAdminStub({
        profile,
        job: { id: "job-1", user_id: "p1", status: "processing", records_submitted: 2 },
        rows: [
          {
            id: "r1",
            status: "success",
            tracerfy_job_id: null,
            is_successful: true,
            charge: 0,
            ai_research_status: "tier1_done",
            property_trace_status: null,
          },
          {
            id: "r2",
            status: "no_match",
            tracerfy_job_id: null,
            is_successful: false,
            charge: 0,
            ai_research_status: "tier1_done",
            property_trace_status: null,
          },
        ],
      });
      const out = await bulkStatus(admin, "sub-1", { job_id: "job-1" });
      expect(out).toMatchObject({ status: "completed", records_matched: 1 });
    });
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
    // A REAL tier 2 row carries this, and the fixture must too. Without it the leak guard
    // below is vacuous: there is nothing on the row to spread, so leaving contact_vendor in
    // the destructure passes just as happily as removing it. Found by the mutation that was
    // supposed to fail and did not.
    contact_vendor: "fastappend",
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

    it("never leaks which vendor lane ran, on any row", async () => {
      // OURS, NOT THEIRS. owner_contact_source says which vendor was asked, which is an
      // operational fact about how we work rather than something the customer bought. It
      // was also WRONG on every tier 2 FastAppend row until trace_history.contact_vendor
      // existed, so it shipped a false claim about provenance.
      //
      // SCANS THE WHOLE SERIALIZED ROW rather than checking two keys, because both names
      // can reappear by accident: contact_vendor rides the `...rest` spread the moment it
      // is dropped from the destructure, and owner_contact_source comes back the moment
      // anyone spreads resolveOwnerContact() instead of picking the name off it. Those are
      // the two ways this regresses and neither is visible at the call site.
      const admin = adminStub({
        profile: { id: "p1", wallet_balance: 0 },
        traces: [tier2Row()],
      });
      const out = (await listTraces(admin, "sub-1", {})) as { traces: Array<unknown> };
      const serialized = JSON.stringify(out.traces[0]);
      expect(serialized, "owner_contact_source reached the customer payload")
        .not.toContain('"owner_contact_source"');
      // POSITIVE CONTROL. Without it this passes just as happily on an empty row, which is
      // the shape that proves nothing: the payload really was built and really does carry
      // the name, so the missing key is a removal rather than an absence of output.
      expect(serialized).toContain('"owner_contact_name"');

      // contact_vendor is NOT asserted here, deliberately. listTraces does not select it, so
      // the stub never puts it on the row and an assertion that it is absent would pass for
      // the wrong reason. The fixture below carries the column so a future change that adds
      // it to the select has something real to leak; if that happens, assert it here and
      // mutation-check it, because the first version of this test did exactly that and the
      // mutation SURVIVED.
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
