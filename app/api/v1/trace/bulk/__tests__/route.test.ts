import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { BLANK_OWNER_SKIP_STATUS } from "@/lib/trace/blankOwnerSkip";

/**
 * Money fences for the PUBLIC v1 bulk-trace SUBMIT route.
 *
 * This route is the SOURCE OF TRUTH the MCP submit mirrors, so the wallet
 * reserve it computes is the reserve the whole product is measured against.
 *
 * Two things changed on 2026-09-17 with the removal of AI Search, and both are
 * money:
 *
 * 1. The reserve used to be `records x tier1Rate + entityRecords x $0.15`. The
 *    $0.15 was the research fee the old sweep-bulk-research cron booked the
 *    moment it identified an owner. Nothing books it now, so quoting it would
 *    402 wallets that can genuinely afford the batch.
 * 2. A record with no owner name used to be queued for that cron. There is no
 *    engine behind the queue any more, so it is accepted, written terminal with
 *    a reason, and never charged.
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
      const add =
        () =>
        () =>
          node;
      for (const m of ["eq", "select"]) node[m] = add();
      node.single = async () => ({ data: H.job, error: null });
      node.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
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
vi.mock("@/lib/api/auth", () => ({
  validateApiKey: async () => ({ profile: H.profile }),
  isAuthError: (r: unknown) => Boolean((r as { response?: unknown })?.response),
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

const { POST } = await import("@/app/api/v1/trace/bulk/route");

const rec = (owner_name?: string, n = 1) => ({
  owner_name,
  address: `${n} Main St`,
  city: "Dallas",
  state: "TX",
  zip: "75001",
});

function post(records: unknown[]) {
  return POST(
    new Request("http://localhost/api/v1/trace/bulk", {
      method: "POST",
      body: JSON.stringify({ records }),
      headers: { "content-type": "application/json" },
    })
  );
}

/** Every trace_history row upserted, flattened. */
const historyRows = () =>
  H.ops
    .filter((o) => o.table === "trace_history" && o.op === "upsert")
    .flatMap((o) => o.payload as Array<Record<string, unknown>>);

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
  it("quotes one tier 1 rate per record, with no research fee on the entity", async () => {
    // MUTATION: add AI_RESEARCH.CHARGE_PER_RECORD back onto the entity count and
    // this goes red.
    const body = await (
      await post([rec("John Smith", 1), rec("Acme Holdings Llc", 2)])
    ).json();
    expect(body.estimatedCost).toBeCloseTo(2 * PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("quotes nothing for a record with no owner name", async () => {
    // It is skipped, not traced, so there is no charge to reserve for it.
    // MUTATION: count skipped records into estimatedCost and this goes red.
    const body = await (
      await post([rec("John Smith", 1), rec(undefined, 2), rec("   ", 3)])
    ).json();
    expect(body.recordsSkipped).toBe(2);
    expect(body.estimatedCost).toBeCloseTo(PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("lets through a wallet that holds exactly the traceable cost", async () => {
    // The old reserve (tier1 + 0.15 per entity) 402'd this wallet even though the
    // batch could never cost more than one tier 1 charge.
    H.profile = { ...H.profile, wallet_balance: PRICING.CHARGE_PER_SUCCESS_WALLET };
    const res = await post([rec("Acme Holdings Llc", 1)]);
    expect(res.status).not.toBe(402);
  });

  it("still 402s a wallet that cannot cover the traceable records", async () => {
    H.profile = { ...H.profile, wallet_balance: 0 };
    const res = await post([rec("John Smith", 1)]);
    expect(res.status).toBe(402);
    expect(H.ops).toHaveLength(0);
  });
});

describe("the three-way split", () => {
  it("writes a blank-owner row terminal with the skip status, never queued", async () => {
    // MUTATION: queue it ('queued') like the old route did and this goes red. A
    // queued row waits on a cron that can no longer resolve it and holds the
    // whole bulk job open.
    await post([rec(undefined, 1)]);
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ai_research_status: BLANK_OWNER_SKIP_STATUS,
      status: "no_match",
      input_owner_name: null,
    });
  });

  it("writes nothing money-shaped on a skipped row", async () => {
    await post([rec(undefined, 1)]);
    for (const paid of ["charge", "ai_research_charge", "tier", "property_record"]) {
      expect(Object.keys(historyRows()[0])).not.toContain(paid);
    }
  });

  it("still queues a NAMED entity for the business trace", async () => {
    await post([rec("Acme Holdings Llc", 1)]);
    expect(historyRows()[0]).toMatchObject({
      ai_research_status: "queued",
      status: "processing",
    });
  });

  it("still sends a person straight to the Tracerfy bulk CSV", async () => {
    const { submitBulkTrace } = await import("@/lib/tracerfy/client");
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(submitBulkTrace).toHaveBeenCalledTimes(1);
    expect(body.recordsDirectTrace).toBe(1);
    expect(historyRows()[0]).toMatchObject({ ai_research_status: null, status: "processing" });
  });

  it("never sends a blank-owner record to a vendor", async () => {
    const { submitBulkTrace } = await import("@/lib/tracerfy/client");
    vi.mocked(submitBulkTrace).mockClear();
    await post([rec(undefined, 1)]);
    expect(submitBulkTrace).not.toHaveBeenCalled();
  });
});

describe("what the job row claims was submitted", () => {
  /** The single trace_jobs insert this route makes. */
  const jobInsert = () =>
    H.ops.find((o) => o.table === "trace_jobs" && o.op === "insert")?.payload as
      | Record<string, unknown>
      | undefined;

  it("counts only the rows a vendor was actually asked about", async () => {
    // records_submitted is the DENOMINATOR of the match rate. It is read back by
    // the v1 status route, by the bulk_job.completed webhook and by the history
    // page, and it used to be every row that survived dedup -- blank-owner rows
    // included, which are skipped and never sent anywhere. A 100-row upload with
    // 40 blank owners then reported 100 submitted against however many of the 60
    // matched, so the customer's match rate read 40 percent low.
    // MUTATION: put newRecords.length back and this goes red.
    await post([
      rec("John Smith", 1),
      rec("Acme Holdings Llc", 2),
      rec(undefined, 3),
      rec("   ", 4),
    ]);
    expect(jobInsert()?.records_submitted).toBe(2);
  });

  it("agrees with the dashboard route, which counts traceable rows too", async () => {
    // app/api/trace/bulk/route.ts writes traceableRecords.length here with a
    // comment saying counting skipped rows "would overstate the work". Two
    // routes writing the same column with two different meanings is how a
    // reported match rate ends up depending on which door the batch came in.
    await post([rec(undefined, 1), rec(undefined, 2)]);
    expect(jobInsert()?.records_submitted).toBe(0);
  });

  it("still counts every uploaded row as total_records", async () => {
    // The skipped rows are not hidden, they are just not claimed as work. The
    // customer can still see they arrived: total_records - records_submitted is
    // the skipped count, and recordsSkipped says it outright.
    const body = await (await post([rec("John Smith", 1), rec(undefined, 2)])).json();
    expect(jobInsert()?.total_records).toBe(2);
    expect(jobInsert()?.records_submitted).toBe(1);
    expect(body.recordsSkipped).toBe(1);
  });
});

describe("what the caller is told", () => {
  it("reports the skipped count and the reason a human can read", async () => {
    const body = await (await post([rec(undefined, 1)])).json();
    expect(body.recordsSkipped).toBe(1);
    expect(typeof body.skippedReason).toBe("string");
    expect(body.message).toContain("no owner name");
    // Never a bare no-match with nothing said about it.
    expect(body.skippedReason).toContain("not charged");
  });

  it("says nothing about skipping when nothing was skipped", async () => {
    const body = await (await post([rec("John Smith", 1)])).json();
    expect(body.recordsSkipped).toBe(0);
    expect(body.skippedReason).toBeUndefined();
    expect(body.message).not.toContain("skipped");
  });
});
