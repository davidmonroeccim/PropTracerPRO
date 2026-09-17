import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { BLANK_OWNER_SKIP_STATUS } from "@/lib/trace/blankOwnerSkip";

/**
 * Money fences for the DASHBOARD bulk-trace submit route (Track A).
 *
 * The v1 route and the MCP submit both got the blank-owner skip on 2026-09-17.
 * This one did not, and it is the path the bulk page posts to. It built a
 * Tracerfy CSV with an empty first and last name for a record with no
 * owner_name, and app/api/trace/bulk/status then deducted the tier 1 rate on
 * any Tracerfy success against it. Until AI Search was deleted this phase the
 * page's AI Research toggle found those owners first; nothing replaced it.
 *
 * David's rule: a bulk row with no owner of record is accepted, skipped with a
 * readable reason, and charged NOTHING. It is not traced.
 */

type Op = { table: string; op: string; payload?: unknown; opts?: unknown };

const H = vi.hoisted(() => ({
  ops: [] as Array<{ table: string; op: string; payload?: unknown; opts?: unknown }>,
  profile: {} as Record<string, unknown>,
  job: { id: "job-1" } as Record<string, unknown> | null,
  submit: { success: true, jobId: "tf-1" } as Record<string, unknown>,
}));

function recordingClient() {
  return {
    from(table: string) {
      const node: Record<string, unknown> = {};
      let rec: Op | null = null;
      const add = () => () => node;
      for (const m of ["eq", "select"]) node[m] = add();
      node.single = async () => ({ data: H.job, error: null });
      node.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(res);
      return {
        insert: (payload: unknown) => {
          rec = { table, op: "insert", payload };
          H.ops.push(rec);
          return node;
        },
        upsert: (payload: unknown, opts: unknown) => {
          rec = { table, op: "upsert", payload, opts };
          H.ops.push(rec);
          return node;
        },
        update: (payload: unknown) => {
          rec = { table, op: "update", payload };
          H.ops.push(rec);
          return node;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => recordingClient() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => {
      const node: Record<string, unknown> = {};
      node.select = () => node;
      node.eq = () => node;
      node.single = async () => ({ data: H.profile, error: null });
      return node;
    },
  }),
}));
vi.mock("@/lib/utils/deduplication", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/deduplication")>();
  return {
    ...actual,
    // Dedup passes everything through; removeBatchDuplicates stays REAL.
    checkDuplicates: vi.fn(async (_userId: string, records: unknown[]) => ({
      newRecords: records,
      duplicates: [],
      cachedResults: [],
    })),
  };
});
vi.mock("@/lib/tracerfy/client", () => ({ submitBulkTrace: vi.fn(async () => H.submit) }));

const { POST } = await import("@/app/api/trace/bulk/route");
const { submitBulkTrace } = await import("@/lib/tracerfy/client");

const rec = (owner_name?: string, n = 1) => ({
  owner_name,
  address: `${n} Main St`,
  city: "Dallas",
  state: "TX",
  zip: "75001",
});

function post(records: unknown[]) {
  return POST(
    new Request("http://localhost/api/trace/bulk", {
      method: "POST",
      body: JSON.stringify({ records, fileName: "leads.csv" }),
      headers: { "content-type": "application/json" },
    })
  );
}

/** Every trace_history row upserted, flattened. */
const historyRows = () =>
  H.ops
    .filter((o) => o.table === "trace_history" && o.op === "upsert")
    .flatMap((o) => o.payload as Array<Record<string, unknown>>);

/** The CSV body handed to Tracerfy, split into data lines. */
const submittedCsvLines = () => {
  const call = vi.mocked(submitBulkTrace).mock.calls[0];
  return call ? String(call[0]).split("\n").slice(1) : [];
};

beforeEach(() => {
  vi.clearAllMocks();
  H.ops = [];
  H.job = { id: "job-1" };
  H.submit = { success: true, jobId: "tf-1" };
  H.profile = {
    id: "user-1",
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    wallet_balance: 100,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the wallet reserve", () => {
  it("quotes nothing for a record with no owner name", async () => {
    // MUTATION: count skipped records into estimated_cost and this goes red.
    const body = await (
      await post([rec("John Smith", 1), rec(undefined, 2), rec("   ", 3)])
    ).json();
    expect(body.records_skipped).toBe(2);
    expect(body.estimated_cost).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("lets through a wallet that holds exactly the traceable cost", async () => {
    H.profile = { ...H.profile, wallet_balance: PRICING.CHARGE_PER_SUCCESS_WALLET };
    const res = await post([rec("John Smith", 1), rec(undefined, 2)]);
    expect(res.status).not.toBe(402);
  });

  it("still 402s a wallet that cannot cover the traceable records", async () => {
    H.profile = { ...H.profile, wallet_balance: 0 };
    const res = await post([rec("John Smith", 1)]);
    expect(res.status).toBe(402);
    expect(H.ops).toHaveLength(0);
  });
});

describe("a row with no owner name", () => {
  it("never reaches the Tracerfy CSV", async () => {
    // The old CSV carried a line with empty first_name and last_name for it,
    // and bulk/status charged the tier 1 rate on any success that came back.
    // MUTATION: build the CSV from every record again and this goes red.
    await post([rec("John Smith", 1), rec(undefined, 2)]);
    expect(submittedCsvLines()).toHaveLength(1);
    expect(submittedCsvLines()[0]).toContain("John");
  });

  it("is written terminal with the skip status, so nothing polls it", async () => {
    await post([rec(undefined, 1)]);
    const skipped = historyRows().filter(
      (r) => r.ai_research_status === BLANK_OWNER_SKIP_STATUS
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      status: "no_match",
      input_owner_name: null,
      trace_job_id: "job-1",
    });
    // Never handed a Tracerfy job id: bulk/status finds its billable rows by
    // that column, and a row carrying one is a row it will settle and charge.
    expect(skipped[0].tracerfy_job_id ?? null).toBeNull();
  });

  it("writes nothing money-shaped, so it stays free and deletable", async () => {
    await post([rec(undefined, 1)]);
    for (const paid of ["charge", "ai_research_charge", "tier", "property_record"]) {
      expect(Object.keys(historyRows()[0])).not.toContain(paid);
    }
  });

  it("calls no vendor at all when every row is blank-owner", async () => {
    const body = await (await post([rec(undefined, 1), rec("  ", 2)])).json();
    expect(submitBulkTrace).not.toHaveBeenCalled();
    expect(body.records_submitted).toBe(0);
    expect(body.records_skipped).toBe(2);
    expect(body.estimated_cost).toBe(0);
    // The job is closed out here, or the page polls a job nothing will finish.
    const done = H.ops.find(
      (o) =>
        o.table === "trace_jobs" &&
        o.op === "update" &&
        (o.payload as Record<string, unknown>)?.status === "completed"
    );
    expect(done).toBeDefined();
  });
});

describe("what the user is told", () => {
  it("reports the skipped count and a reason a human can read", async () => {
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.records_skipped).toBe(1);
    expect(typeof body.skipped_reason).toBe("string");
    expect(body.skipped_reason).toContain("not charged");
    expect(body.message).toContain("no owner name");
  });

  it("says nothing about skipping when nothing was skipped", async () => {
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(body.records_skipped).toBe(0);
    expect(body.skipped_reason).toBeUndefined();
  });
});

describe("a traced row", () => {
  it("still goes to Tracerfy and is still linked to the bulk job", async () => {
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(submitBulkTrace).toHaveBeenCalledTimes(1);
    expect(body.records_submitted).toBe(1);
    expect(historyRows()[0]).toMatchObject({
      status: "processing",
      tracerfy_job_id: "tf-1",
      trace_job_id: "job-1",
    });
  });
});
