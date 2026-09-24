import { beforeEach, describe, expect, it, vi } from "vitest";
import { BLANK_OWNER_SKIP_REASON, BLANK_OWNER_SKIP_STATUS } from "@/lib/trace/blankOwnerSkip";
import {
  ENTITY_TRACE_FAILED_REASON,
  ENTITY_TRACE_FAILED_STATUS,
} from "@/lib/trace/entityTraceAttempts";
import { EXPORT_COLUMNS } from "@/lib/trace/exportCsv";

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
  pages: [] as Array<[number, number]>,
  /** Fail the Nth history read (1-based). 0 = never fail. */
  failOnRequest: 0,
  /** Ignore .range() and always return the first page, as a broken client would. */
  ignoreRange: false,
}));

/**
 * A history query, one page at a time.
 *
 * The stub SLICES on the range it is given, because the route now pages and a
 * stub that ignored the range would loop forever on its own first page. It also
 * counts the pages it served, which is how the pagination test proves a job
 * bigger than one page comes back whole.
 */
function historyChain() {
  const node: Record<string, unknown> = {};
  let from = 0;
  let to = -1;
  const add =
    (method: string) =>
    (...args: unknown[]) => {
      H.filters.push([method, ...args]);
      return node;
    };
  for (const m of ["select", "eq", "or", "order"]) node[m] = add(m);
  node.range = (start: number, end: number) => {
    H.filters.push(["range", start, end]);
    from = start;
    to = end;
    return node;
  };
  node.then = (res: (v: unknown) => unknown) => {
    H.pages.push([from, to]);
    if (H.failOnRequest === H.pages.length) {
      return Promise.resolve({ data: null, error: { message: 'connection reset' } }).then(res);
    }
    const slice = H.ignoreRange ? H.rows : H.rows.slice(from, to + 1);
    return Promise.resolve({ data: slice, error: null }).then(res);
  };
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
  H.pages = [];
  H.job = { id: "job-1", status: "completed", tracerfy_job_id: "tf-1" };
  H.rows = [];
  H.failOnRequest = 0;
  H.ignoreRange = false;
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

  it("keeps the skip column on a job where nothing was skipped, blank", async () => {
    // It USED to be conditional, and a conditional header is a header that
    // changes shape between two downloads of the same product. The column is now
    // always there and empty when there is nothing to explain -- which is also
    // what lets the 105 be a stable set.
    H.rows = [row(), row({ status: "no_match", trace_result: null, charge: 0 })];
    const { text } = await csv();
    const header = text.split("\n")[0].split(",");
    expect(header).toContain("skip_reason");
    expect(header).toEqual([...EXPORT_COLUMNS]);
    expect(text.split("\n")[1].split(",")[20]).toBe("");
  });
});

describe("a job bigger than one page", () => {
  it("comes back whole instead of silently stopping at 1,000 rows", async () => {
    // MUTATION: drop the loop (or the .range) and this returns 1,000 rows with a
    // 200 and a valid-looking CSV. That is the failure mode: nothing to see.
    H.rows = Array.from({ length: 2300 }, (_, i) => row({ normalized_address: `ROW ${i}` }));
    const { text } = await csv();
    const lines = text.split("\n");

    expect(lines).toHaveLength(2301); // header + every row
    expect(lines[1]).toContain("ROW 0");
    expect(lines[1000]).toContain("ROW 999"); // the old cap, now just a boundary
    expect(lines[1001]).toContain("ROW 1000"); // the first row that used to vanish
    expect(lines[2300]).toContain("ROW 2299");
  });

  it("asks for consecutive pages and stops on an empty one", async () => {
    H.rows = Array.from({ length: 2300 }, (_, i) => row({ normalized_address: `ROW ${i}` }));
    await csv();
    expect(H.pages).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [2300, 3299],
    ]);
  });

  it("orders by a tiebreaker, so a page boundary cannot drop or repeat a row", async () => {
    // Two rows written in the same instant have no defined order between them.
    // Without a second key, paging across them loses one and duplicates another.
    H.rows = [row()];
    await csv();
    const orders = H.filters.filter((f) => f[0] === "order").map((f) => f[1]);
    expect(orders).toContain("created_at");
    expect(orders).toContain("id");
  });

  it("fails the whole download when a page errors, rather than serving a short file", async () => {
    // MUTATION: change the in-loop `return` to `break` and this goes red.
    //
    // THIS IS THE FAILURE MODE THE TRUNCATION FIX CAN RELOCATE INTO ITSELF. An
    // error on page 2 of 3, swallowed, produces a 200 and a valid-looking CSV
    // holding the first 1,000 rows and nothing else -- byte for byte the silent
    // truncation this pagination exists to eliminate, wearing an error handler
    // as a disguise. A customer cannot tell a short file from a complete one.
    H.rows = Array.from({ length: 2300 }, (_, i) => row({ normalized_address: `ROW ${i}` }));
    H.failOnRequest = 2;

    const { res, text } = await csv();

    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).not.toBe("text/csv");
    expect(text).not.toContain("ROW 0");
    expect(JSON.parse(text).success).toBe(false);
  });

  it("fails rather than looping forever if the range is ignored", async () => {
    // A client that ignored .range() would return a full, non-empty page every
    // time. Unbounded, that never terminates and holds the whole table in
    // memory. The cap turns a hang into a 500.
    H.rows = Array.from({ length: 1000 }, (_, i) => row({ normalized_address: `ROW ${i}` }));
    H.ignoreRange = true;

    const { res } = await csv();

    expect(res.status).toBe(500);
    expect(H.pages.length).toBe(11); // ceil(10000 / 1000) + 1
  });

  it("confirms the end with one empty page rather than guessing from a short one", async () => {
    // The extra round trip is the point. Stopping on a SHORT page would also
    // stop early if the server's own row cap were below ours, which is the same
    // silent truncation this fixes, wearing a different hat.
    H.rows = [row()];
    await csv();
    expect(H.pages).toEqual([
      [0, 999],
      [1, 1000],
    ]);
  });
});
