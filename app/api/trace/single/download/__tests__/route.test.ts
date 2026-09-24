import Papa from "papaparse";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXPORT_COLUMNS } from "@/lib/trace/exportCsv";
import entityHitAddress from "@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json";

/**
 * The single-record download. Without it the export is bulk-only in practice
 * and a customer who traced one address has to retype 105 facts.
 *
 * What is actually tested here is the DOOR, not the file: who may open it, whose
 * row comes back, and that it is the same 105 columns the bulk button produces.
 * The contents of a row are the shared module's tests.
 */

const H = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  trace: null as Record<string, unknown> | null,
  filters: [] as Array<[string, ...unknown[]]>,
}));

function traceChain() {
  const node: Record<string, unknown> = {};
  const add =
    (method: string) =>
    (...args: unknown[]) => {
      H.filters.push([method, ...args]);
      return node;
    };
  for (const m of ["select", "eq"]) node[m] = add(m);
  node.single = async () => ({ data: H.trace, error: null });
  return node;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: H.user } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => traceChain() }),
}));

const { GET } = await import("@/app/api/trace/single/download/route");

const FIXTURE = (entityHitAddress as { response: { property: Record<string, unknown> } }).response
  .property;

const call = (query = "?trace_id=trace-1") =>
  GET(new Request(`https://proptracerpro.com/api/trace/single/download${query}`));

beforeEach(() => {
  H.user = { id: "user-1" };
  H.filters = [];
  H.trace = {
    normalized_address: "1815 S STATE ST",
    city: "SALT LAKE CITY",
    state: "UT",
    zip: "84115",
    input_owner_name: "Colmaven, Llc",
    status: "success",
    trace_result: {
      owner_name: "Jane Doe",
      owner_name_2: "Colmaven, Llc",
      phones: [{ number: "8015550100", type: "mobile" }],
      emails: ["jane@x.invalid"],
      mailing_address: "PO BOX 1",
      mailing_city: "SALT LAKE CITY",
      mailing_state: "UT",
      mailing_zip: "84115",
      match_confidence: 88,
    },
    ai_research: null,
    ai_research_status: null,
    property_record: FIXTURE,
    charge: 0.4,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the single-record download", () => {
  it("is the same 105 columns the bulk button produces", async () => {
    // One module, one header. Two shapes would mean a customer's importer works
    // for one button and not the other, and they find out, not us.
    //
    // PARSED, not split on commas. This row legitimately contains three commas
    // inside quoted values ("Colmaven, Llc" and the vendor's "Retail Stores
    // (Personal Services, Photography, Travel)"), so a naive split reports 106
    // fields. A real parser is also the only way to assert that the quoting
    // actually holds the file together.
    const res = await call();
    const text = await res.text();
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });

    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(parsed.errors).toEqual([]);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0]).toEqual([...EXPORT_COLUMNS]);
    expect(parsed.data[1]).toHaveLength(105);
  });

  it("keeps a comma inside a value in its own cell", async () => {
    // "Colmaven, Llc" is a real owner of record from the saved payload, and an
    // entity name with a comma in it is the common case, not the edge case.
    const parsed = Papa.parse<string[]>(await (await call()).text(), { skipEmptyLines: true });
    const ownerOfRecord = parsed.data[1][EXPORT_COLUMNS.indexOf("owner_of_record")];
    expect(ownerOfRecord).toBe("Colmaven, Llc");
  });

  it("carries the contacts and the county dossier that were paid for", async () => {
    const text = await (await call()).text();
    expect(text).toContain('"8015550100"');
    expect(text).toContain('"mobile"');
    expect(text).toContain('"Colmaven, Llc"'); // owner_of_record, which had no column
    expect(text).toContain('"Salt Lake County"');
    expect(text).toContain('"16-18-306-029"'); // apn
  });

  it("names the file as an attachment so a browser saves it", async () => {
    const res = await call();
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain(".csv");
  });

  it("turns away a caller with no session", async () => {
    // MUTATION: drop the user check and this goes red.
    H.user = null;
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("scopes the lookup to the caller's own rows", async () => {
    // MUTATION: remove .eq('user_id', user.id) and this goes red. Without it any
    // signed-in customer could read any other customer's trace by guessing an id.
    await call();
    expect(H.filters).toContainEqual(["eq", "user_id", "user-1"]);
    expect(H.filters).toContainEqual(["eq", "id", "trace-1"]);
  });

  it("refuses a request with no trace_id rather than exporting something else", async () => {
    const res = await call("");
    expect(res.status).toBe(400);
  });

  it("reports someone else's trace as not found, never as forbidden", async () => {
    // The row is filtered by user_id, so another customer's id simply misses.
    // A 403 would confirm that the id exists, which is not ours to say.
    H.trace = null;
    const res = await call("?trace_id=someone-elses");
    expect(res.status).toBe(404);
  });
});
