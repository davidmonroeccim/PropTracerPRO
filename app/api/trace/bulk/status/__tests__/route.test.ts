import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { BLANK_OWNER_SKIP_STATUS } from "@/lib/trace/blankOwnerSkip";
import { ENTITY_TRACE_FAILED_STATUS } from "@/lib/trace/entityTraceAttempts";

/**
 * Money fence for the session-side BULK status route.
 *
 * This route loops the Tracerfy result set, writes a per-row
 * `trace_history.charge`, and accumulates `totalCharge` -- which it then ships
 * out as `total_charge` in BOTH the `bulk_job.completed` webhook and the HTTP
 * response. The per-row deduct was unchecked, so a short wallet produced a
 * ledger full of uncollected charges and a job summary claiming money that was
 * never taken. Both the row and the running total must count only what moved.
 */

const H = vi.hoisted(() => ({
  deductResult: true as boolean,
  job: null as unknown as Record<string, unknown>,
  profile: null as unknown as Record<string, unknown>,
  historyRows: [] as Array<Record<string, unknown>>,
  // Every trace_history row belonging to the JOB, which is a different read
  // from the per-result `id` lookup above: it is scoped by trace_job_id and is
  // the only read that can see a skipped row (a skipped row never gets a
  // tracerfy_job_id, so the result loop cannot reach it).
  jobRows: [] as Array<Record<string, unknown>>,
  jobStatus: null as unknown as Record<string, unknown>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
}));

function chainTo(data: unknown) {
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.eq = self;
  node.ilike = self;
  node.limit = () => Promise.resolve({ data, error: null });
  node.single = () => Promise.resolve({ data, error: null });
  node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(res, rej);
  return node;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (cols?: string) =>
        chainTo(
          table === "trace_jobs"
            ? H.job
            : table === "user_profiles"
              ? H.profile
              : typeof cols === "string" && cols.includes("ai_research_status")
                ? H.jobRows
                : H.historyRows
        ),
      update: (payload: Record<string, unknown>) => {
        H.updates.push({ table, payload });
        return chainTo(null);
      },
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      H.rpcCalls.push([fn, args]);
      return Promise.resolve(
        fn === "deduct_wallet_balance"
          ? { data: H.deductResult, error: null }
          : { data: null, error: null }
      );
    },
  }),
}));

vi.mock("@/lib/tracerfy/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tracerfy/client")>();
  return { ...actual, getJobStatus: async () => H.jobStatus };
});

vi.mock("@/lib/utils/auto-rebill", () => ({
  triggerAutoRebillIfNeeded: vi.fn(async () => {}),
}));
vi.mock("@/lib/highlevel/client", () => ({ pushTraceToHighLevel: vi.fn() }));

const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));

beforeEach(() => {
  H.updates = [];
  H.rpcCalls = [];
  H.deductResult = true;
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);

  H.job = {
    id: "job-1",
    user_id: "user-1",
    status: "processing",
    tracerfy_job_id: "tj-1",
    records_submitted: 2,
    created_at: new Date().toISOString(),
  };

  H.profile = {
    id: "user-1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: null,
    webhook_url: "https://customer.example.com/hook",
    highlevel_api_key: null,
    highlevel_location_id: null,
  };

  // Every address resolves to a real trace_history row, so the billing branch
  // is reached for both results.
  H.historyRows = [{ id: "hist-1" }];

  // Two traced rows, nothing skipped, unless a test says otherwise.
  H.jobRows = [
    { charge: null, ai_research_status: null },
    { charge: null, ai_research_status: null },
  ];

  // Two contact-bearing rows => two billable matches.
  H.jobStatus = {
    success: true,
    pending: false,
    results: [
      {
        address: "123 MAIN ST",
        city: "Austin",
        state: "TX",
        first_name: "Jane",
        last_name: "Doe",
        primary_phone: "5125550100",
      },
      {
        address: "456 OAK AVE",
        city: "Austin",
        state: "TX",
        first_name: "John",
        last_name: "Roe",
        email_1: "john@example.com",
      },
    ],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Per-row billing updates only. The trailing "sweep the leftovers to no_match"
 * update also carries `charge`, but never `trace_result`, so keying on
 * trace_result isolates the rows this loop actually settled.
 */
function billingUpdates() {
  return H.updates.filter(
    (u) => u.table === "trace_history" && "trace_result" in u.payload
  );
}

function webhookBody() {
  const call = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
  return call ? JSON.parse(call[1].body) : null;
}

describe("bulk/status route totals only the wallet amount actually collected", () => {
  it("records and reports 0 when deduct_wallet_balance returns false", async () => {
    H.deductResult = false;

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1")
    );
    const body = await res.json();

    // Both rows attempted a deduct at the real rate...
    const deducts = H.rpcCalls.filter((c) => c[0] === "deduct_wallet_balance");
    expect(deducts).toHaveLength(2);
    expect(deducts[0][1].p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);

    // ...and none of it moved.
    const rows = billingUpdates();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.payload.charge).toBe(0);
      // The trace result itself survives.
      expect(row.payload.status).toBe("success");
      expect(row.payload.is_successful).toBe(true);
    }

    // The job summary must not claim money either -- on both doors.
    expect(body.total_charge).toBe(0);
    expect(webhookBody().total_charge).toBe(0);

    // The matches themselves still happened; only the billing did not.
    expect(body.records_matched).toBe(2);
  });

  it("records and reports the full total when the deducts succeed", async () => {
    H.deductResult = true;

    const { GET } = await import("@/app/api/trace/bulk/status/route");
    const res = await GET(
      new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1")
    );
    const body = await res.json();

    const rate = PRICING.CHARGE_PER_SUCCESS_WALLET;
    for (const row of billingUpdates()) {
      expect(row.payload.charge).toBe(rate);
    }
    expect(body.total_charge).toBeCloseTo(rate * 2, 10);
    expect(webhookBody().total_charge).toBeCloseTo(rate * 2, 10);
  });
});

/**
 * David's rule for a bulk row that arrived with no owner name: accept the file,
 * skip the row with a reason, charge nothing, and put the reason in the job
 * summary AND the CSV. The CSV half shipped; this is the job summary half.
 *
 * Without it the dashboard shows a finished job whose skipped rows read as a
 * bare no_match, which tells the customer we looked and found nobody when no
 * vendor was ever asked. The v1 status route and the MCP tool already serve
 * skipReasonFor() on every record; this route serves the same accessor, so the
 * three surfaces cannot drift on the wording.
 */
describe("the job summary says how many rows were skipped and why", () => {
  const GET = async () => {
    const mod = await import("@/app/api/trace/bulk/status/route");
    return mod.GET(
      new Request("https://proptracerpro.com/api/trace/bulk/status?job_id=job-1")
    );
  };

  it("reports the skipped count and reason on a job that finishes this poll", async () => {
    // MUTATION: drop records_skipped / skip_reason from the completed response
    // and this goes red -- the user is back to downloading the CSV to find out
    // why rows came back empty.
    H.jobRows = [
      { charge: PRICING.CHARGE_PER_SUCCESS_WALLET, ai_research_status: null },
      { charge: null, ai_research_status: BLANK_OWNER_SKIP_STATUS },
      { charge: null, ai_research_status: BLANK_OWNER_SKIP_STATUS },
    ];

    const body = await (await GET()).json();

    expect(body.status).toBe("completed");
    expect(body.records_skipped).toBe(2);
    expect(body.skip_reason).toContain("No owner name came in");
  });

  it("tells the user in the same sentence that they were not charged", async () => {
    // The row is free. A reason that does not say so leaves the customer
    // checking their wallet against a job summary that never mentions it.
    H.jobRows = [{ charge: null, ai_research_status: BLANK_OWNER_SKIP_STATUS }];
    const body = await (await GET()).json();
    expect(body.skip_reason).toContain("not charged");
  });

  it("reports them on a job that was already finished before this poll", async () => {
    // The stored-stats branch is what every poll after the first one hits, and
    // what a user who reloads the page sees. It must say the same thing.
    H.job = { ...H.job, status: "completed", records_matched: 1 };
    H.jobRows = [
      { charge: PRICING.CHARGE_PER_SUCCESS_WALLET, ai_research_status: null },
      { charge: null, ai_research_status: BLANK_OWNER_SKIP_STATUS },
    ];

    const body = await (await GET()).json();

    expect(body.records_skipped).toBe(1);
    expect(body.skip_reason).toContain("not charged");
    // The skipped row contributes nothing to the money, which is the claim the
    // reason is making.
    expect(body.total_charge).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET, 10);
  });

  it("says nothing was skipped when nothing was", async () => {
    // A reason on a job where every row was traced would be a false statement
    // in the other direction.
    const body = await (await GET()).json();
    expect(body.records_skipped).toBe(0);
    expect(body.skip_reason).toBeNull();
  });

  it("carries a vendor-exhausted row's own reason, not the blank-owner one", async () => {
    // Two different things end up as an untraced row and they are not the same
    // to a customer: a blank owner is something they can fix by resending the
    // row, an exhausted entity trace is our side failing to reach a vendor.
    // Both are free. skipReasonFor() is what keeps them distinct.
    H.jobRows = [{ charge: null, ai_research_status: ENTITY_TRACE_FAILED_STATUS }];
    const body = await (await GET()).json();
    expect(body.records_skipped).toBe(1);
    expect(body.skip_reason).toContain("business records service");
    expect(body.skip_reason).not.toContain("No owner name came in");
  });
});
