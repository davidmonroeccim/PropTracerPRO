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
function makeAdmin(
  opts: {
    deductResult?: unknown;
    priorDebit?: number | number[];
    /**
     * wallet_transactions CREDITS already linked to this row -- money handed
     * back. Since migration 20260917 a refund can name the row it refunds, so
     * this is reachable state for any row one of the two refunding settle sites
     * has already touched, whichever path settles it afterwards.
     */
    priorCredit?: number | number[];
  } = {}
) {
  const updates: Array<{
    table: string;
    payload: Record<string, unknown>;
    // Every filter method called on the update chain, in order. The blanket
    // "sweep the leftovers" update is identified by its `.in()`, and the guard
    // that has to narrow it (excludeBilledRows) is a pair of `.or()`s plus an
    // `.is()`, so the filters have to be recorded, not just the payload.
    filters: Array<[string, ...unknown[]]>;
  }> = [];
  // `priorDebit` stands in for a wallet_transactions debit already booked
  // against this row, which is what collectedChargeFor() reads to decide the
  // row has already been paid for. Absent = no prior debit = still chargeable.
  // One reused row can carry SEVERAL real debits -- a tier 2 record purchase
  // and a later tier 1 contact charge both point at it -- so this takes a list.
  //
  // EVERY ENTRY CARRIES ITS `type`, because collectedChargeFor NETS debits
  // against credits. An entry with no type reads as money handed BACK and flips
  // the sign of the probe's answer; PostgREST never omits a selected column, so
  // a stub that does is telling settleBulkJob a lie no database can tell it.
  const asRows = (v: number | number[] | undefined, type: string) =>
    v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((amount) => ({ amount, type }));
  const ledgerRows: Array<{ amount: number; type: string }> = [
    ...asRows(opts.priorDebit, "debit"),
    ...asRows(opts.priorCredit, "credit"),
  ];
  // THE LEDGER IS WRITTEN BY THE WALLET FUNCTIONS, exactly as in production, and
  // ONLY when the call names a trace_history row. Both deduct_wallet_balance and
  // credit_wallet_balance INSERT into wallet_transactions carrying
  // `p_trace_history_id`; a call that omits it writes a row linked to nothing,
  // which no probe can see.
  //
  // That is what makes the refund's `p_trace_history_id` load-bearing rather
  // than cosmetic: drop it from the route and the credit stops reaching the
  // probe below, which is the defect migration 20260917 closed.
  const rpc = vi.fn().mockImplementation((fn: string, args?: Record<string, unknown>) => {
    if (
      (fn === "deduct_wallet_balance" || fn === "credit_wallet_balance") &&
      args?.p_trace_history_id
    ) {
      ledgerRows.push({
        amount: Number(args.p_amount),
        type: fn === "deduct_wallet_balance" ? "debit" : "credit",
      });
    }
    return Promise.resolve(
      fn === "deduct_wallet_balance" && "deductResult" in opts
        ? opts.deductResult
        : { data: true, error: null }
    );
  });
  const from = vi.fn((table: string) => ({
    update: vi.fn((payload: Record<string, unknown>) => {
      const filters: Array<[string, ...unknown[]]> = [];
      updates.push({ table, payload, filters });
      const node: Record<string, unknown> = {};
      const add =
        (method: string) =>
        (...args: unknown[]) => {
          filters.push([method, ...args]);
          return node;
        };
      for (const m of ["eq", "in", "or", "is"]) node[m] = add(m);
      node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(res, rej);
      return node;
    }),
    // The ledger probe builds `.select('amount').eq(...).eq(...)` and AWAITS it
    // directly -- there is no `.limit()` any more, because it must total every
    // debit against the row rather than return an arbitrary one. So each link
    // of the chain is itself thenable.
    select: vi.fn(() => {
      const resolved = {
        data: table === "wallet_transactions" ? ledgerRows : [],
        error: null,
      };
      const node: Record<string, unknown> = {};
      node.eq = vi.fn(() => node);
      node.limit = vi.fn(() => node);
      node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resolved).then(res, rej);
      return node;
    }),
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

  it("charges a Tracerfy row whose earlier debit was refunded by another path", async () => {
    // THE SAME GUARD, ON THE BRANCH THAT NEVER REFUNDS. This branch cannot
    // produce a net-zero row by itself, which is exactly why its `> 0` survived
    // every mutation until this test: no fixture could reach the state.
    //
    // It is reachable in production. One trace_history row is settled by all
    // three paths, and TWO of them refund a historical research fee against it
    // (this file's FastAppend arm and sweep-business-traces). A row that
    // collected a fee and had it handed back arrives here with a ledger that
    // nets to zero, and zero is not money in our pocket.
    //
    // MUTATION: test `!== null` instead of `> 0` on this branch and it goes red
    // at zero deducts -- the row is delivered free and recorded as having paid
    // the $0.15 that is sitting back in the customer's wallet.
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
    const admin = makeAdmin({
      priorDebit: AI_RESEARCH.CHARGE_PER_RECORD,
      priorCredit: AI_RESEARCH.CHARGE_PER_RECORD,
    });
    const row = mkRow({ id: "row-netted-to-zero" });

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-netted",
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    const deducts = admin.rpc.mock.calls.filter((c) => c[0] === "deduct_wallet_balance");
    expect(deducts).toHaveLength(1);
    expect(deducts[0][1].p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(row.charge).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(row.charge).not.toBe(0);
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
    // TWO LINKED DEBITS, WHICH IS WHAT THIS ROW REALLY LOOKS LIKE. It carries
    // `ai_research_charge` = $0.15, and that column and its wallet_transactions
    // debit are written by the same act -- a fee on the row with no debit behind
    // it is a state nothing can produce. The cron's $0.25 trace charge is the
    // second. The refund below hands the $0.15 back, so the row's NET collection
    // is the $0.25 the customer really paid for the trace, and that is what the
    // assertions at the bottom demand.
    const admin = makeAdmin({
      priorDebit: [AI_RESEARCH.CHARGE_PER_RECORD, PRICING.CHARGE_PER_SUCCESS_WALLET],
    });
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

  /**
   * A REFUND IS NOT A COLLECTION, and this is the shape the defect lived in.
   *
   * The row carries ONLY the historical research fee: one linked $0.15 debit,
   * `ai_research_charge` = $0.15, no trace charge. This arm hands the $0.15
   * back and then asks the ledger what the row has collected. Before migration
   * 20260917 the credit could not name the row, so the probe reported the
   * refunded $0.15 as still collected, the deduct was SKIPPED, and the customer
   * received the contacts free while `charge` said $0.15 -- money that was back
   * in their wallet.
   */
  it("charges a row whose only prior debit it just refunded", async () => {
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [{ address: "1 Main St", phones: [], emails: [] }],
    });
    const admin = makeAdmin({ priorDebit: AI_RESEARCH.CHARGE_PER_RECORD });
    const row = mkRow({
      id: "row-refunded-to-zero",
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
      tracerfyJobId: "tj-refunded",
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    const calls = admin.rpc.mock.calls;
    // The refund goes out and NAMES THE ROW.
    // MUTATION: drop `p_trace_history_id` from the refund and the deduct
    // assertion below goes red -- the credit is then linked to nothing and the
    // probe cannot subtract it.
    const credit = calls.find((c) => c[0] === "credit_wallet_balance");
    expect(credit?.[1].p_amount).toBe(AI_RESEARCH.CHARGE_PER_RECORD);
    expect(credit?.[1].p_trace_history_id).toBe("row-refunded-to-zero");

    // Net collected is now ZERO, and zero is not a collection.
    // MUTATION: sum debits alone in collectedChargeFor, or test `!== null`
    // instead of `> 0` here, and this goes red -- the row is delivered free.
    const deducts = calls.filter((c) => c[0] === "deduct_wallet_balance");
    expect(deducts).toHaveLength(1);
    expect(deducts[0][1].p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(row.charge).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(row.charge).not.toBe(AI_RESEARCH.CHARGE_PER_RECORD);
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

/* ------------------------------------------------------------------ *
 * RECEIPTS SURVIVE A SECOND SETTLE.
 *
 * `UNIQUE(user_id, address_hash)` means one trace_history row per (user,
 * address), REUSED rather than re-inserted, and `wallet_transactions
 * .trace_history_id` references it with ON DELETE NO ACTION. So every write
 * below lands on a row that may ALREADY carry a receipt: under bulk tier 2 a
 * billed miss is `tier = 2, charge > 0, is_successful = false`, which is
 * exactly the shape these settle arms target.
 *
 * The fixture for that is `mkRow({ charge: 0.25, tier: 2 })`: a row the
 * customer has already paid $0.25 for. What must NOT happen to it:
 *   - `charge` replaced (the receipt vanishes, excludeBilledRows reads the row
 *     as unbilled, the next submit's delete hits 23503 and that address 500s
 *     forever), and
 *   - `tier` downgraded to 1 (isCacheHitRow's third arm dies and the customer
 *     re-buys the same absence).
 * ------------------------------------------------------------------ */
describe("settleBulkJob never erases a receipt already on the row", () => {
  const BILLED_TIER2 = { charge: 0.25, tier: 2 } as const;

  const historyUpdates = (admin: ReturnType<typeof makeAdmin>) =>
    admin.updates.filter((u) => u.table === "trace_history");

  it("site 257 (entity row, neither vendor hit): keeps the tier 2 charge and tier", async () => {
    // Tracerfy returned a row with no contacts and there is no ai_research, so
    // this is the free-miss arm. Free means "collect nothing further", never
    // "declare the row was always free".
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [{ address: "1 Main St", phones: [], emails: [] }],
    });
    const admin = makeAdmin();
    const row = mkRow({ id: "row-t2-miss", ...BILLED_TIER2 });

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-t2-miss",
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    const persisted = historyUpdates(admin)[0].payload;
    // MUTATION: write `charge: 0, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE` flat
    // instead of the folded values and this goes red on both lines.
    expect(persisted.charge).toBe(0.25);
    expect(persisted.tier).toBe(TRACE_TIER.PER_RECORD_SUBMITTED);
  });

  it("site 308 (shared bulk person match): ACCUMULATES the new debit onto the old one", async () => {
    // Two real debits against one row are two real debits. Writing only the
    // second drops the first out of SUM(trace_history.charge), which is what
    // the dashboard and both status routes report as total_charge.
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [
        {
          city: "Austin",
          state: "TX",
          phones: [{ number: "5125550123", type: "mobile" }],
          emails: [],
        },
      ],
    });
    const admin = makeAdmin();
    const rows = [
      mkRow({ id: "row-a", city: "Austin", state: "TX", ...BILLED_TIER2 }),
      mkRow({ id: "row-b", city: "Dallas", state: "TX" }),
    ];

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-t2-match",
      bucketRows: rows,
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    const persisted = historyUpdates(admin)[0].payload;
    // MUTATION: write the bare `charge` instead of `billing.charge` and this
    // goes red -- the first debit disappears from the row.
    expect(persisted.charge).toBe(0.5);
    expect(persisted.charge).not.toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(persisted.tier).toBe(TRACE_TIER.PER_RECORD_SUBMITTED);
    expect(rows[0].charge).toBe(0.5);
  });

  /* ---------------------------------------------------------------- *
   * SITE 333, THE BLANKET LEFTOVER SWEEP.
   *
   * STATUS IS NOT A RECEIPT. excludeBilledRows exists to protect `charge` and
   * `tier`; `status`, `is_successful` and the counts are DELIVERY facts. Put
   * them behind the same guard and a billed tier 2 row that got no vendor
   * result is skipped entirely and keeps `status = 'processing'` -- while the
   * caller marks the job completed and never polls it again. An hour later
   * sweep-stale-traces stage 1 claims it (it filters on status + created_at
   * with no trace_job_id restriction) and settles it against whatever OTHER
   * record in the shared Tracerfy batch happened to carry a phone. The
   * customer is billed a second time and handed a stranger's contacts on their
   * parcel.
   *
   * So it is TWO statements. Money behind the guard, delivery in front of it.
   * ---------------------------------------------------------------- */
  const blanketFixture = async () => {
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [
        {
          city: "Austin",
          state: "TX",
          phones: [{ number: "5125550123", type: "mobile" }],
          emails: [],
        },
      ],
    });
    const admin = makeAdmin();
    const rows = [
      mkRow({ id: "row-a", city: "Austin", state: "TX" }),
      // Never matched by the result set, so it falls into the blanket sweep
      // carrying a live tier 2 receipt.
      mkRow({ id: "row-b", city: "Dallas", state: "TX", ...BILLED_TIER2 }),
    ];

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-t2-blanket",
      bucketRows: rows,
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    const blanket = historyUpdates(admin).filter((u) =>
      u.filters.some((f) => f[0] === "in")
    );
    return {
      rows,
      // The full recorded sequence, so a test can assert the ORDER the two
      // blanket statements ran in and not merely that both exist.
      writes: admin.updates,
      guarded: blanket.filter((u) => u.filters.some((f) => f[0] === "or")),
      unguarded: blanket.filter((u) => !u.filters.some((f) => f[0] === "or")),
    };
  };

  it("site 333: the GUARDED statement carries the money and no delivery facts", async () => {
    const { guarded } = await blanketFixture();
    expect(guarded).toHaveLength(1);
    // excludeBilledRows: two `.or()` disjunctions plus `property_record IS NULL`.
    // MUTATION: unwrap the excludeBilledRows() call and these go red.
    expect(guarded[0].filters.filter((f) => f[0] === "or")).toHaveLength(2);
    expect(
      guarded[0].filters.some((f) => f[0] === "is" && f[1] === "property_record")
    ).toBe(true);
    // MONEY ONLY. Safe precisely because the guard means the statement cannot
    // match a row that collected anything.
    expect(guarded[0].payload.charge).toBe(0);
    expect(guarded[0].payload.tier).toBe(TRACE_TIER.PER_SUCCESSFUL_TRACE);
    // MUTATION: move `status` into this payload and this goes red -- that is
    // the change that strands a paid row.
    expect(Object.keys(guarded[0].payload)).not.toContain("status");
    expect(Object.keys(guarded[0].payload)).not.toContain("is_successful");
  });

  it("site 333: an UNGUARDED statement resolves every row, billed or not", async () => {
    const { unguarded } = await blanketFixture();
    // MUTATION: delete this statement, or wrap it in excludeBilledRows, and
    // this goes red -- a billed row is then left in 'processing' inside a job
    // that has been marked completed, where only sweep-stale-traces can reach
    // it, and it settles that row against another property's contacts.
    expect(unguarded).toHaveLength(1);
    expect(unguarded[0].payload.status).toBe("no_match");
    expect(unguarded[0].payload.is_successful).toBe(false);
    // And it carries no money, or the guard above was pointless.
    expect(Object.keys(unguarded[0].payload)).not.toContain("charge");
    expect(Object.keys(unguarded[0].payload)).not.toContain("tier");
  });

  it("site 333: the UNGUARDED statement is narrowed to rows still processing", async () => {
    const { unguarded } = await blanketFixture();
    // ITS TWO SIBLINGS IN bulk/status AND sweep-stale-traces BOTH CARRY THIS
    // FILTER; this one did not until 2026-09-17. `ids` is read at the top of
    // settleBulkJob and this statement runs several vendor round-trips later.
    // Within one request a successful row cannot be in the list -- the
    // per-result loop only matches rows still 'processing' -- but nothing stops
    // a CONCURRENT settle of the same Tracerfy job from succeeding one between
    // the read and this write. Without the filter this statement then stamps
    // `no_match, is_successful: false` over a row that has real contacts on it,
    // and the guarded money statement above has already declined to touch it.
    //
    // MUTATION: delete the `.eq('status','processing')` and this goes red.
    expect(
      unguarded[0].filters.some(
        (f) => f[0] === "eq" && f[1] === "status" && f[2] === "processing"
      )
    ).toBe(true);
  });

  it("site 333: the MONEY statement runs FIRST, while the rows are still processing", async () => {
    const { writes, guarded, unguarded } = await blanketFixture();
    // ORDER IS LOAD-BEARING AND IT IS NOT VISIBLE IN EITHER STATEMENT ALONE.
    // The delivery write sets `status = 'no_match'`, and now that BOTH
    // statements select on `status = 'processing'`, running delivery first
    // makes the money statement match NOTHING: every unbilled leftover row
    // keeps a NULL `charge` and an unstamped `tier` instead of being
    // normalised to `charge: 0, tier: 1`. An unstamped tier is exactly what
    // isCacheHitRow's third arm and excludeBilledRows read.
    //
    // MUTATION: swap the two statements in the source and this goes red.
    expect(writes.indexOf(guarded[0])).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf(guarded[0])).toBeLessThan(writes.indexOf(unguarded[0]));
  });

  it("site 333: the billed row keeps its receipt and its in-memory status is honest", async () => {
    const { rows, unguarded } = await blanketFixture();
    // The v1 status route and the MCP bulk_status both SUM `row.charge` off
    // these in-memory objects to report total_charge.
    expect(rows[1].charge).toBe(0.25);
    // Both callers ALSO decide job completion from these mutated copies, so a
    // copy saying 'no_match' while the database still says 'processing' would
    // finalize a job around an unresolved row -- and buildPerRecordResult would
    // then report that row as 'processing' forever inside a completed job.
    expect(rows[1].status).toBe("no_match");
    // THE TWO MUST AGREE, and this is the assertion that proves it rather than
    // assuming it: the billed row's id is in the statement that actually wrote
    // the status, not merely in the mutated array.
    const ids = unguarded[0].filters.find((f) => f[0] === "in")?.[2] as string[];
    expect(ids).toContain(rows[1].id);
  });

  /**
   * The two SAFE sites, pinned so a later refactor cannot "helpfully" fold them.
   *
   * 165 and 224 resolve the amount from the LEDGER (collectedChargeFor) before
   * writing. Folding on top of that would add the ledger amount to a row that
   * may already carry it, double-counting the same debit. They stay raw, and
   * the ALLOWED_RAW_WRITES exemption for this file exists for exactly these
   * two.
   */
  it("sites 165/224 write the ledger TOTAL raw, and still never downgrade the tier", async () => {
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
    // A CONSISTENT fixture, which matters because the previous one was not: it
    // put a $0.25 receipt on the row and a single $0.05 debit in the ledger,
    // two numbers that cannot both be true, so it froze the behaviour instead
    // of proving it safe.
    //
    // Here the row is a billed tier 2 miss ($0.25 collected per record
    // SUBMITTED), and the ledger holds that debit PLUS a $0.25 tier 1 contact
    // charge a previous attempt booked before it died. Both are real; the row
    // has collected $0.50.
    const admin = makeAdmin({
      priorDebit: [PRICING.CHARGE_PER_SUCCESS_WALLET, PRICING.CHARGE_PER_SUCCESS_WALLET],
    });
    const row = mkRow({ id: "row-ledger", ...BILLED_TIER2 });

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-ledger",
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    // The ledger total is written AS-IS. Folding it would give 0.25 + 0.50 =
    // 0.75 and invent money that never moved -- which is precisely why this
    // site keeps its ALLOWED_RAW_WRITES exemption.
    expect(historyUpdates(admin)[0].payload.charge).toBe(0.5);
    // ...but `tier` is not the ledger's to answer, and a flat 1 here silently
    // downgrades a tier 2 receipt. The exemption was argued for `charge` and
    // must not extend to `tier`.
    expect(historyUpdates(admin)[0].payload.tier).toBe(TRACE_TIER.PER_RECORD_SUBMITTED);
  });

  /**
   * The SECOND ledger site, which the first test above cannot reach.
   *
   * Site 165 is the Tracerfy-contacts branch; site 224 is the FastAppend-credit
   * branch, and only a row whose Tracerfy poll came back EMPTY while
   * ai_research carries contacts goes down it. A mutation that flattened the
   * tier there survived the whole suite, because every existing fixture on that
   * branch has no tier at all and `Number(undefined)` is NaN, which the fold
   * treats as "no prior tier" -- so 1 and the folded value agree and the
   * assertion is a tautology. Only a row that really is tier 2 separates them.
   */
  it("site 224 (FastAppend credit) also refuses to downgrade the tier", async () => {
    getJobStatus.mockResolvedValue({
      success: true,
      pending: false,
      results: [{ address: "1 Main St", phones: [], emails: [] }],
    });
    const admin = makeAdmin({ priorDebit: [0.25, 0.25] });
    const row = mkRow({
      id: "row-entity-t2",
      ...BILLED_TIER2,
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
      } as never,
    });

    await settleBulkJob(admin as never, {
      tracerfyJobId: "tj-entity-t2",
      bucketRows: [row],
      userId: USER_ID,
      personRate: PRICING.CHARGE_PER_SUCCESS_WALLET,
    });

    const persisted = historyUpdates(admin)[0].payload;
    // MUTATION: flatten this to TRACE_TIER.PER_SUCCESSFUL_TRACE and this goes
    // red. Before this test existed, that mutation survived the full suite.
    expect(persisted.tier).toBe(TRACE_TIER.PER_RECORD_SUBMITTED);
    // The ledger total, raw, for the same reason as site 165.
    expect(persisted.charge).toBe(0.5);
  });
});
