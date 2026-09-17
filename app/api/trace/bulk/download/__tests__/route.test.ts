import { beforeEach, describe, expect, it, vi } from "vitest";
import { BLANK_OWNER_SKIP_REASON, BLANK_OWNER_SKIP_STATUS } from "@/lib/trace/blankOwnerSkip";
import {
  ENTITY_TRACE_FAILED_REASON,
  ENTITY_TRACE_FAILED_STATUS,
} from "@/lib/trace/entityTraceAttempts";

/**
 * The results CSV is where a bulk customer actually reads what happened to each
 * row, so it is where "we skipped this and charged you nothing" has to appear.
 *
 * A skipped row has NO tracerfy_job_id, because no vendor was ever asked about
 * it. This route used to find its rows by that column alone, so the skipped
 * ones were invisible: the reason existed only in a database column nobody can
 * see, and the row read as a plain no_match, which is the one thing it must
 * never look like.
 */

const H = vi.hoisted(() => ({
  job: {} as Record<string, unknown> | null,
  rows: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, ...unknown[]]>,
}));

function historyChain() {
  const node: Record<string, unknown> = {};
  const add =
    (method: string) =>
    (...args: unknown[]) => {
      H.filters.push([method, ...args]);
      return node;
    };
  for (const m of ["select", "eq", "or", "order"]) node[m] = add(m);
  node.then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: H.rows, error: null }).then(res);
  return node;
}

function jobChain() {
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.select = self;
  node.eq = self;
  node.single = async () => ({ data: H.job, error: null });
  return node;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => (table === "trace_jobs" ? jobChain() : historyChain()),
  }),
}));

const { GET } = await import("@/app/api/trace/bulk/download/route");

const row = (over: Record<string, unknown> = {}) => ({
  normalized_address: "100 MAIN ST",
  city: "DALLAS",
  state: "TX",
  zip: "75001",
  input_owner_name: "John Smith",
  status: "success",
  trace_result: { phones: [{ number: "5125550100" }], emails: ["a@b.invalid"] },
  ai_research: null,
  ai_research_status: null,
  charge: 0.25,
  ...over,
});

async function csv() {
  const res = await GET(
    new Request("https://proptracerpro.com/api/trace/bulk/download?job_id=job-1")
  );
  return { res, text: await res.text() };
}

beforeEach(() => {
  H.filters = [];
  H.job = { id: "job-1", status: "completed", tracerfy_job_id: "tf-1" };
  H.rows = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a skipped row in the results CSV", () => {
  it("carries the reason, in a column, where the customer can read it", async () => {
    H.rows = [
      row(),
      row({
        input_owner_name: null,
        status: "no_match",
        trace_result: null,
        ai_research_status: BLANK_OWNER_SKIP_STATUS,
        charge: 0,
      }),
    ];
    const { text } = await csv();

    expect(text.split("\n")[0]).toContain("skip_reason");
    expect(text).toContain(BLANK_OWNER_SKIP_REASON);
    // And it cost nothing.
    expect(text.split("\n")[2]).toContain("0.00");
  });

  it("is found by the bulk job, not only by a Tracerfy job it never had", async () => {
    // MUTATION: go back to filtering on tracerfy_job_id alone and the skipped
    // rows vanish from the file.
    H.rows = [row()];
    await csv();
    const or = H.filters.find((f) => f[0] === "or");
    expect(or).toBeDefined();
    expect(String(or![1])).toContain("trace_job_id.eq.job-1");
    expect(String(or![1])).toContain("tracerfy_job_id.eq.tf-1");
  });

  it("is downloadable even when the whole upload was skipped", async () => {
    // Every row blank-owner means no Tracerfy job at all. The route used to
    // refuse the download outright, which left the reason unreadable.
    H.job = { id: "job-1", status: "completed", tracerfy_job_id: null };
    H.rows = [
      row({
        input_owner_name: null,
        status: "no_match",
        trace_result: null,
        ai_research_status: BLANK_OWNER_SKIP_STATUS,
        charge: 0,
      }),
    ];
    const { res, text } = await csv();

    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(text).toContain(BLANK_OWNER_SKIP_REASON);
    expect(H.filters.some((f) => f[0] === "eq" && f[1] === "trace_job_id")).toBe(true);
  });

  it("explains a row whose entity trace ran out of attempts too", async () => {
    H.rows = [
      row({
        status: "error",
        trace_result: null,
        ai_research_status: ENTITY_TRACE_FAILED_STATUS,
        charge: 0,
      }),
    ];
    const { text } = await csv();
    expect(text).toContain(ENTITY_TRACE_FAILED_REASON);
  });

  it("adds no skip column to a job where nothing was skipped", async () => {
    H.rows = [row(), row({ status: "no_match", trace_result: null, charge: 0 })];
    const { text } = await csv();
    expect(text.split("\n")[0]).not.toContain("skip_reason");
  });
});
