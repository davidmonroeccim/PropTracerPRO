import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
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
    const injectedRate = PRICING.CHARGE_PER_SUCCESS; // 0.07
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

  it("refunds the $0.15 research then charges $0.25 on a FastAppend-sourced entity match", async () => {
    expect(PRICING.CHARGE_PER_FASTAPPEND_SUCCESS).toBe(0.25);
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
      ai_research_charge: 0.15,
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

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-3",
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS,
    });

    const calls = admin.rpc.mock.calls;
    const creditIdx = calls.findIndex((c) => c[0] === "credit_wallet_balance");
    const deductIdx = calls.findIndex((c) => c[0] === "deduct_wallet_balance");
    expect(creditIdx).toBeGreaterThanOrEqual(0);
    expect(deductIdx).toBeGreaterThanOrEqual(0);
    // Refund the prior $0.15 research charge, then charge the bundled $0.25.
    expect(calls[creditIdx][1].p_amount).toBe(0.15);
    expect(calls[deductIdx][1].p_amount).toBe(PRICING.CHARGE_PER_FASTAPPEND_SUCCESS);
    // Choreography: refund BEFORE charge; must not be netted or reordered.
    expect(creditIdx).toBeLessThan(deductIdx);
    expect(calls[creditIdx][1].p_user_id).toBe(USER_ID);
    expect(calls[deductIdx][1].p_user_id).toBe(USER_ID);
    // Person rate is NOT used on the FastAppend branch (flat constants only).
    expect(calls[deductIdx][1].p_amount).not.toBe(PRICING.CHARGE_PER_SUCCESS);
  });
});
