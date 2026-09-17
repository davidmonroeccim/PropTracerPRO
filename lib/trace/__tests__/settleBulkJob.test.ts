import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING, AI_RESEARCH } from "@/lib/constants";
import { settleBulkJob, type TraceHistoryRow } from "@/lib/trace/settleBulkJob";
import { TRACE_TIER } from "@/lib/trace/billedRows";

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

/**
 * Recording admin: `.rpc` captures every wallet call so we can assert amounts,
 * and `.from(t).update(p)` captures every persisted payload so we can assert
 * what actually lands in trace_history.charge (not just the in-memory row).
 *
 * `deductResult` overrides ONLY the deduct_wallet_balance envelope, so a test
 * can simulate an insufficient-balance wallet (`{ data: false }`) while
 * credit_wallet_balance still succeeds.
 */
function makeAdmin(opts: { deductResult?: unknown; priorDebit?: number } = {}) {
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const rpc = vi.fn().mockImplementation((fn: string) =>
    Promise.resolve(
      fn === "deduct_wallet_balance" && "deductResult" in opts
        ? opts.deductResult
        : { data: true, error: null }
    )
  );
  // `priorDebit` stands in for a wallet_transactions debit already booked
  // against this row, which is what collectedChargeFor() reads to decide the
  // row has already been paid for. Absent = no prior debit = still chargeable.
  const ledgerRows =
    opts.priorDebit === undefined ? [] : [{ amount: opts.priorDebit }];
  const from = vi.fn((table: string) => ({
    update: vi.fn((payload: Record<string, unknown>) => {
      updates.push({ table, payload });
      return {
        eq: vi.fn().mockResolvedValue({ error: null }),
        in: vi.fn().mockResolvedValue({ error: null }),
      };
    }),
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue({
            data: table === "wallet_transactions" ? ledgerRows : [],
            error: null,
          }),
        })),
      })),
    })),
  }));
  return { rpc, from, updates };
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

  /**
   * THE CROSS-FILE DOUBLE CHARGE, found in review 2026-09-17.
   *
   * sweep-entity-traces deducts on a FastAppend hit and then throws, so the row
   * is requeued. On the retry FastAppend returns nothing, the row settles down
   * the Tracerfy path HERE, and is charged a second time for the same answer.
   * Two files, one row, two debits, and it needs no unusual failure to reach.
   *
   * The ledger is the guard because deduct_wallet_balance writes the debit in
   * the SAME transaction as the balance change, so it cannot disagree with the
   * money the way a `charged_at` column could.
   */
  it("never charges a row the wallet has already paid for, on the Tracerfy branch", async () => {
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [
        {
          address: "1 Main St",
          phones: [{ number: "5125551234", type: "mobile" }],
          emails: [],
        },
      ],
    });
    // A debit for $0.25 is already on the ledger against this row.
    const admin = makeAdmin({ priorDebit: PRICING.CHARGE_PER_SUCCESS_WALLET });
    const row = mkRow({ id: "row-already-paid" });

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-paid",
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    // No second deduct, at any amount.
    expect(
      admin.rpc.mock.calls.filter((c) => c[0] === "deduct_wallet_balance")
    ).toHaveLength(0);
    // The row still reports what the customer actually paid, not zero. Writing
    // 0 here would make a paid row look unbilled to excludeBilledRows, and an
    // unbilled row is a deletable one.
    expect(row.charge).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    const persisted = admin.updates.filter(
      (u) => u.table === "trace_history" && "charge" in u.payload
    );
    expect(persisted[0].payload.charge).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("never charges twice on the FastAppend branch, but still owes the historical refund", async () => {
    // This is the arm the cron books its charge on, so it is the one most
    // likely to be settling a row that has already paid. The refund is keyed on
    // ai_research_charge, which the cron never hands back, so it must STILL run
    // even though the charge is skipped.
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [{ address: "1 Main St", phones: [], emails: [] }],
    });
    const admin = makeAdmin({ priorDebit: PRICING.CHARGE_PER_SUCCESS_WALLET });
    const row = mkRow({
      id: "row-entity-paid",
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

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-entity-paid",
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    const calls = admin.rpc.mock.calls;
    expect(calls.filter((c) => c[0] === "deduct_wallet_balance")).toHaveLength(0);
    // The refund is NOT suppressed by the already-paid guard.
    const credit = calls.find((c) => c[0] === "credit_wallet_balance");
    expect(credit?.[1].p_amount).toBe(AI_RESEARCH.CHARGE_PER_RECORD);
    expect(row.charge).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(row.ai_research_charge).toBe(0);
  });
});

/**
 * deduct_wallet_balance RETURNS BOOLEAN and returns FALSE **without deducting**
 * when the wallet is short (supabase/schema.sql:290). trace_history.charge is
 * now SUMMED by the dashboard and history pages, so a charge written next to a
 * deduct that returned false is money the customer is shown as having paid and
 * that was never collected. One test per deduct call site in settleBulkJob.
 */
describe('settleBulkJob records $0 when the wallet deduct fails', () => {
  /** ai_research payload carrying FastAppend contacts (drives the credit branch). */
  const fastAppendResearch = {
    owner_name: 'Jane Principal',
    owner_type: 'business' as const,
    business_name: 'Acme LLC',
    individual_behind_business: 'Jane Principal',
    is_deceased: null,
    deceased_details: null,
    relatives: [],
    decision_makers: [],
    property_type: 'commercial',
    confidence: 80,
    confidence_reasoning: null,
    sources: [],
    business_trace_contacts: {
      owner_name: 'Jane Principal',
      phones: [{ number: '5125550000', type: 'mobile' }],
      emails: ['jane@acme.com'],
      address: '1 Main St',
    },
  };

  const historyUpdates = (admin: ReturnType<typeof makeAdmin>) =>
    admin.updates.filter((u) => u.table === 'trace_history');

  it('site 1 (entity row, Tracerfy contacts): persists charge 0, keeps the contacts', async () => {
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [
        {
          address: '1 Main St',
          phones: [{ number: '5125550123', type: 'mobile' }],
          emails: [],
        },
      ],
    });
    const admin = makeAdmin({ deductResult: { data: false, error: null } });
    const row = mkRow({ id: 'row-entity' });

    await settleBulkJob(admin as never, {
      tracerfyJobId: 'tj-poor-1',
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    const persisted = historyUpdates(admin)[0].payload;
    expect(persisted.charge).toBe(0);
    expect(persisted.charge).not.toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(row.charge).toBe(0);
    // The customer's data survives a short wallet: the trace result still lands.
    expect(persisted.status).toBe('success');
    expect(persisted.phone_count).toBe(1);
    expect(row.is_successful).toBe(true);
    // Every charge write stamps the billing model that produced it: 0.25 is
    // both the tier 1 wallet per-success rate and the tier 2 pro per-record
    // rate, so the amount alone is ambiguous (lib/constants.ts:34-36).
    // MUTATION: remove `tier:` from this update payload and this goes red.
    expect(persisted.tier).toBe(TRACE_TIER.PER_SUCCESSFUL_TRACE);
  });

  it('stamps tier = 1 on EVERY charge write in the bulk settle path', async () => {
    // Five sites write trace_history.charge in settleBulkJob. A site that
    // forgets `tier` leaves an unattributable row in the billing ledger.
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [
        {
          address: '1 Main St',
          phones: [{ number: '5125550123', type: 'mobile' }],
          emails: [],
        },
      ],
    });
    const admin = makeAdmin({ deductResult: { data: true, error: null } });

    await settleBulkJob(admin as never, {
      tracerfyJobId: 'tj-tier-1',
      bucketRows: [mkRow({ id: 'row-a' }), mkRow({ id: 'row-b' })],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    const chargeWrites = historyUpdates(admin).filter((u) => 'charge' in u.payload);
    expect(chargeWrites.length).toBeGreaterThan(0);
    for (const write of chargeWrites) {
      expect(write.payload.tier).toBe(TRACE_TIER.PER_SUCCESSFUL_TRACE);
    }
  });

  it('site 2 (FastAppend credit): persists charge 0 after the refund', async () => {
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [{ address: '1 Main St', phones: [], emails: [] }],
    });
    const admin = makeAdmin({ deductResult: { data: false, error: null } });
    const row = mkRow({
      id: 'row-entity',
      ai_research_charge: AI_RESEARCH.CHARGE_PER_RECORD,
      ai_research: fastAppendResearch as never,
    });

    await settleBulkJob(admin as never, {
      tracerfyJobId: 'tj-poor-2',
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    // The research refund still goes out -- that money genuinely moves back.
    const credits = admin.rpc.mock.calls.filter((c) => c[0] === 'credit_wallet_balance');
    expect(credits).toHaveLength(1);

    const persisted = historyUpdates(admin)[0].payload;
    expect(persisted.charge).toBe(0);
    expect(persisted.charge).not.toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(row.charge).toBe(0);
    expect(persisted.status).toBe('success');
    expect(persisted.email_count).toBe(1);
  });

  it('site 3 (shared bulk person match): persists charge 0', async () => {
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [
        { city: 'Austin', state: 'TX', phones: [{ number: '5125550123', type: 'mobile' }], emails: [] },
      ],
    });
    const admin = makeAdmin({ deductResult: { data: false, error: null } });
    const rows = [
      mkRow({ id: 'row-a', city: 'Austin', state: 'TX' }),
      mkRow({ id: 'row-b', city: 'Dallas', state: 'TX' }),
    ];

    await settleBulkJob(admin as never, {
      tracerfyJobId: 'tj-poor-3',
      bucketRows: rows,
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS,
    });

    const persisted = historyUpdates(admin)[0].payload;
    expect(persisted.charge).toBe(0);
    expect(persisted.charge).not.toBe(PRICING.CHARGE_PER_SUCCESS);
    expect(rows[0].charge).toBe(0);
    expect(persisted.status).toBe('success');
    expect(rows[0].is_successful).toBe(true);
  });

  it('a missing rpc envelope is NOT treated as a failed charge', async () => {
    // Production supabase-js always resolves { data, error }; a bare `undefined`
    // only comes from a loose test double. Guarding it must not silently zero a
    // charge that really was collected -- see the comment in lib/wallet/deduct.ts.
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [
        { city: 'Austin', state: 'TX', phones: [{ number: '5125550123', type: 'mobile' }], emails: [] },
      ],
    });
    const admin = makeAdmin({ deductResult: undefined });
    const rows = [
      mkRow({ id: 'row-a', city: 'Austin', state: 'TX' }),
      mkRow({ id: 'row-b', city: 'Dallas', state: 'TX' }),
    ];

    await settleBulkJob(admin as never, {
      tracerfyJobId: 'tj-undef',
      bucketRows: rows,
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS,
    });

    expect(historyUpdates(admin)[0].payload.charge).toBe(PRICING.CHARGE_PER_SUCCESS);
    expect(rows[0].charge).toBe(PRICING.CHARGE_PER_SUCCESS);
  });
});
