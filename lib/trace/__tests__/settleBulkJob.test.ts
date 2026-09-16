import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING, AI_RESEARCH } from "@/lib/constants";
import { settleBulkJob, type TraceHistoryRow } from "@/lib/trace/settleBulkJob";

// Mock the tracerfy client so getJobStatus returns a controlled result set and
// parseTracerfyResult is identity (the money-contract test controls `parsed`
// directly via the raw result objects, isolating the settlement branches).
const { getJobStatus, parseTracerfyResult } = vi.hoisted(() => ({
  getJobStatus: vi.fn(),
  parseTracerfyResult: vi.fn((r: unknown) => r),
}));
vi.mock("@/lib/tracerfy/client", async (orig) => ({
  ...((await orig()) as object),
  getJobStatus,
  parseTracerfyResult,
}));

/** Recording admin: `.rpc` captures every wallet call so we can assert amounts. */
function makeAdmin() {
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
  const from = vi.fn(() => ({
    update: vi.fn(() => ({
      eq: vi.fn().mockResolvedValue({ error: null }),
      in: vi.fn().mockResolvedValue({ error: null }),
    })),
  }));
  return { rpc, from };
}

/** A trace_history row with every required field defaulted; override per test. */
function mkRow(overrides: Partial<TraceHistoryRow>): TraceHistoryRow {
  return {
    id: "row",
    user_id: "user-123",
    trace_job_id: "job-1",
    address_hash: "hash",
    normalized_address: "1 Main St",
    city: null,
    state: null,
    zip: null,
    input_owner_name: null,
    tracerfy_job_id: "tj",
    status: "processing",
    trace_result: null,
    ai_research: null,
    ai_research_status: null,
    ai_research_charge: null,
    phone_count: 0,
    email_count: 0,
    is_successful: null,
    charge: null,
    ...overrides,
  };
}

const USER_ID = "user-123";

beforeEach(() => {
  getJobStatus.mockReset();
  parseTracerfyResult.mockReset();
  parseTracerfyResult.mockImplementation((r: unknown) => r);
});

describe("settleBulkJob money contract", () => {
  it("charges the injected personRate on a successful person match", async () => {
    // Shared-bulk (person) branch requires bucketRows.length > 1. One result
    // matches row-a by city/state and carries a phone -> successful.
    const injectedRate = PRICING.CHARGE_PER_SUCCESS; // the tier 1 pro/grant per-success rate
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [
        { city: "Austin", state: "TX", phones: [{ number: "5125550123", type: "mobile" }], emails: [] },
      ],
    });
    const admin = makeAdmin();
    const rows = [
      mkRow({ id: "row-a", city: "Austin", state: "TX" }),
      mkRow({ id: "row-b", city: "Dallas", state: "TX" }),
    ];

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-1",
      bucketRows: rows,
      userId: USER_ID,
      personRate: injectedRate,
    });

    const deducts = admin.rpc.mock.calls.filter((c) => c[0] === "deduct_wallet_balance");
    expect(deducts).toHaveLength(1);
    // The exact injected rate flows through as the charge (mutation-fence target).
    expect(deducts[0][1].p_amount).toBe(injectedRate);
    // Wallet owner is always the local profile id passed in, never row/input data.
    expect(deducts[0][1].p_user_id).toBe(USER_ID);
    expect(rows[0].charge).toBe(injectedRate);
    expect(rows[0].is_successful).toBe(true);
  });

  it("charges $0 and issues no deduct on a no-match person row", async () => {
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [{ city: "Austin", state: "TX", phones: [], emails: [] }],
    });
    const admin = makeAdmin();
    const rows = [
      mkRow({ id: "row-a", city: "Austin", state: "TX" }),
      mkRow({ id: "row-b", city: "Dallas", state: "TX" }),
    ];

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-2",
      bucketRows: rows,
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS,
    });

    expect(admin.rpc.mock.calls.filter((c) => c[0] === "deduct_wallet_balance")).toHaveLength(0);
    expect(rows[0].charge).toBe(0);
    expect(rows[0].is_successful).toBe(false);
  });

  it("refunds the AI research charge then charges the tier 1 rate on an entity match", async () => {
    // Owner type selects the VENDOR, not the price: a FastAppend entity success bills the SAME
    // injected tier 1 rate a Tracerfy person success does. The old flat per-entity constant
    // PRICING.CHARGE_PER_FASTAPPEND_SUCCESS is retired and must not come back.
    expect(PRICING).not.toHaveProperty("CHARGE_PER_FASTAPPEND_SUCCESS");
    expect(AI_RESEARCH.CHARGE_PER_RECORD).toBe(0.15);
    // Entity single-trace branch (bucketRows.length === 1). Tracerfy whiffed
    // (no phones/emails) but FastAppend contacts are present in ai_research.
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [{ address: "1 Main St", phones: [], emails: [] }],
    });
    const admin = makeAdmin();
    const row = mkRow({
      id: "row-entity",
      ai_research_charge: AI_RESEARCH.CHARGE_PER_RECORD,
      ai_research: {
        owner_name: "Jane Principal",
        owner_type: "business",
        business_name: "Acme LLC",
        individual_behind_business: "Jane Principal",
        is_deceased: null,
        deceased_details: null,
        relatives: [],
        decision_makers: [],
        property_type: "commercial",
        confidence: 80,
        confidence_reasoning: null,
        sources: [],
        business_trace_contacts: {
          owner_name: "Jane Principal",
          phones: [{ number: "5125550000", type: "mobile" }],
          emails: ["jane@acme.com"],
          address: "1 Main St",
        },
      },
    });

    // Inject the PAY-AS-YOU-GO rate ($0.25) deliberately. The Pro rate ($0.15) collides with
    // AI_RESEARCH.CHARGE_PER_RECORD, so injecting it would let a settle path that charged the
    // research fee instead of the trace rate pass unnoticed. The wallet rate discriminates.
    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-3",
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    const calls = admin.rpc.mock.calls;
    const creditIdx = calls.findIndex((c) => c[0] === "credit_wallet_balance");
    const deductIdx = calls.findIndex((c) => c[0] === "deduct_wallet_balance");
    expect(creditIdx).toBeGreaterThanOrEqual(0);
    expect(deductIdx).toBeGreaterThanOrEqual(0);
    // Refund the prior research charge, then charge ONE tier 1 per-success trace at the
    // caller's plan rate. Same rate the Tracerfy branch bills: the vendor changed, not the price.
    expect(calls[creditIdx][1].p_amount).toBe(AI_RESEARCH.CHARGE_PER_RECORD);
    expect(calls[deductIdx][1].p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(calls[deductIdx][1].p_amount).not.toBe(AI_RESEARCH.CHARGE_PER_RECORD);
    // Choreography: refund BEFORE charge; must not be netted or reordered.
    expect(creditIdx).toBeLessThan(deductIdx);
    expect(calls[creditIdx][1].p_user_id).toBe(USER_ID);
    expect(calls[deductIdx][1].p_user_id).toBe(USER_ID);
    // And the row records exactly what the wallet moved.
    expect(row.charge).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(row.ai_research_charge).toBe(0);
  });
});
