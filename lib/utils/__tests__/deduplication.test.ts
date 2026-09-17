import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEDUPE, STALE_PROCESSING } from "@/lib/constants";
import { normalizeAddress, createAddressHash } from "@/lib/utils/address-normalizer";

/**
 * Cache / dedup fence for lib/utils/deduplication.ts.
 *
 * This module decides whether a customer is BILLED. A row it fails to see is a
 * row the customer pays for a second time, so the tests below pin the exact
 * PostgREST predicates the two lookups send, not just their return values.
 *
 * Written as characterization tests FIRST (2026-09-17, phase 2) because the
 * module had zero coverage and was about to be changed on the billing path.
 */

type Filter = [string, ...unknown[]];

interface Recorded {
  table: string;
  op: string;
  filters: Filter[];
}

const H = vi.hoisted(() => ({
  ops: [] as Array<{ table: string; op: string; filters: Array<[string, ...unknown[]]> }>,
  /** Envelope every awaited/`.single()`-ed query resolves with, in call order. */
  results: [] as Array<{ data: unknown; error: unknown }>,
  resultIndex: 0,
}));

function nextResult(): { data: unknown; error: unknown } {
  const r = H.results[H.resultIndex] ?? { data: null, error: null };
  H.resultIndex += 1;
  return r;
}

/** Records the full filter chain, then resolves with the queued envelope. */
function recordingClient() {
  return {
    from(table: string) {
      const begin = (op: string) => {
        const rec: Recorded = { table, op, filters: [] };
        H.ops.push(rec);
        const node: Record<string, unknown> = {};
        const add =
          (method: string) =>
          (...args: unknown[]) => {
            rec.filters.push([method, ...args]);
            return node;
          };
        for (const m of ["eq", "neq", "gte", "lte", "lt", "gt", "is", "or", "in", "not"]) {
          node[m] = add(m);
        }
        node.single = () => Promise.resolve(nextResult());
        node.maybeSingle = () => Promise.resolve(nextResult());
        node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(nextResult()).then(res, rej);
        return node;
      };
      return {
        select: (...args: unknown[]) => {
          const node = begin("select");
          H.ops[H.ops.length - 1].filters.push(["select", ...args]);
          return node;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => recordingClient(),
}));

const { checkDuplicates, checkSingleDuplicate, removeBatchDuplicates } = await import(
  "@/lib/utils/deduplication"
);

function filter(rec: Recorded, method: string, column: string): Filter | undefined {
  return rec.filters.find((f) => f[0] === method && f[1] === column);
}

beforeEach(() => {
  H.ops = [];
  H.results = [];
  H.resultIndex = 0;
});

describe("checkSingleDuplicate", () => {
  it("queries trace_history keyed on the caller's user id and the 3-part address hash", async () => {
    H.results = [{ data: null, error: { code: "PGRST116" } }];

    await checkSingleDuplicate("user-1", "123 Main St", "Austin", "TX");

    expect(H.ops).toHaveLength(1);
    const rec = H.ops[0];
    expect(rec.table).toBe("trace_history");

    const expectedHash = createAddressHash(normalizeAddress("123 Main St", "Austin", "TX"));
    expect(filter(rec, "eq", "user_id")).toEqual(["eq", "user_id", "user-1"]);
    expect(filter(rec, "eq", "address_hash")).toEqual(["eq", "address_hash", expectedHash]);
  });

  it("bounds the lookup to the DEDUPE window", async () => {
    H.results = [{ data: null, error: { code: "PGRST116" } }];
    const before = Date.now();

    await checkSingleDuplicate("user-1", "123 Main St", "Austin", "TX");

    const gte = filter(H.ops[0], "gte", "created_at");
    expect(gte).toBeDefined();
    const cutoff = new Date(String(gte![2])).getTime();
    const expected = before - DEDUPE.WINDOW_DAYS * 24 * 60 * 60 * 1000;
    // Same instant give or take the few ms the call itself takes.
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000);
  });

  it("counts a paid property_record as a cache hit, not just a contact success", async () => {
    // THE TIER 2 SHAPE: is_successful = false AND charge > 0. The customer
    // bought an 86-field property record; the contact step is separate and may
    // return nothing. Narrowing to is_successful = true (what this did until
    // 2026-09-17) makes that row invisible and bills them a second time for
    // data they already own.
    //
    // MUTATION: put `.eq('is_successful', true)` back in place of `.or(...)`
    // and this test goes red on both halves.
    H.results = [{ data: null, error: { code: "PGRST116" } }];

    await checkSingleDuplicate("user-1", "123 Main St", "Austin", "TX");

    const rec = H.ops[0];
    const or = rec.filters.find((f) => f[0] === "or");
    expect(or).toBeDefined();
    expect(String(or![1])).toBe("is_successful.eq.true,property_record.not.is.null");
    // The unconditional equality filter must be GONE. Leaving it alongside the
    // .or() would AND the two together and the tier 2 row stays invisible.
    expect(filter(rec, "eq", "is_successful")).toBeUndefined();
  });

  it("uses the shared CACHE_HIT_FILTER so the definition cannot drift", async () => {
    const { CACHE_HIT_FILTER } = await import("@/lib/trace/billedRows");
    H.results = [{ data: null, error: { code: "PGRST116" } }];

    await checkSingleDuplicate("user-1", "123 Main St", "Austin", "TX");

    expect(String(H.ops[0].filters.find((f) => f[0] === "or")![1])).toBe(CACHE_HIT_FILTER);
  });

  it("returns the cached row when one is found", async () => {
    const row = { id: "trace-1", address_hash: "abc", is_successful: true };
    H.results = [{ data: row, error: null }];

    const result = await checkSingleDuplicate("user-1", "123 Main St", "Austin", "TX");

    expect(result).toEqual(row);
  });

  it("returns null for PGRST116 (no rows) rather than throwing", async () => {
    H.results = [{ data: null, error: { code: "PGRST116", message: "no rows" } }];

    await expect(
      checkSingleDuplicate("user-1", "123 Main St", "Austin", "TX")
    ).resolves.toBeNull();
  });

  it("throws on any other PostgREST error so a broken cache cannot read as a miss", async () => {
    // A swallowed error here reads as "not cached" and bills the customer again.
    H.results = [{ data: null, error: { code: "42703", message: "column does not exist" } }];

    await expect(
      checkSingleDuplicate("user-1", "123 Main St", "Austin", "TX")
    ).rejects.toThrow("Failed to check duplicate: column does not exist");
  });
});

describe("checkDuplicates (bulk)", () => {
  it("does not filter on is_successful, so any row in the window is a cache hit", async () => {
    // Documented deliberately: the bulk path already sees a tier 2 row because
    // it never narrowed to successes. It needs no property_record change.
    H.results = [{ data: [], error: null }];

    await checkDuplicates("user-1", [
      { address: "123 Main St", city: "Austin", state: "TX", zip: "78701" },
    ]);

    expect(H.ops).toHaveLength(1);
    expect(
      H.ops[0].filters.some((f) => f[0] === "eq" && f[1] === "is_successful")
    ).toBe(false);
  });

  it("splits input into new records and duplicates on the returned hashes", async () => {
    const dupHash = createAddressHash(normalizeAddress("123 Main St", "Austin", "TX"));
    H.results = [
      {
        data: [
          {
            address_hash: dupHash,
            status: "success",
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      },
    ];

    const result = await checkDuplicates("user-1", [
      { address: "123 Main St", city: "Austin", state: "TX", zip: "78701" },
      { address: "999 Other Rd", city: "Austin", state: "TX", zip: "78701" },
    ]);

    expect(result.duplicates.map((d) => d.address)).toEqual(["123 Main St"]);
    expect(result.newRecords.map((d) => d.address)).toEqual(["999 Other Rd"]);
    expect(result.cachedResults).toHaveLength(1);
  });

  it("ignores a stale processing row so a stuck trace cannot block resubmission", async () => {
    const hash = createAddressHash(normalizeAddress("123 Main St", "Austin", "TX"));
    const stale = new Date();
    stale.setMinutes(stale.getMinutes() - STALE_PROCESSING.STALE_MINUTES - 5);
    H.results = [
      {
        data: [{ address_hash: hash, status: "processing", created_at: stale.toISOString() }],
        error: null,
      },
    ];

    const result = await checkDuplicates("user-1", [
      { address: "123 Main St", city: "Austin", state: "TX", zip: "78701" },
    ]);

    expect(result.duplicates).toHaveLength(0);
    expect(result.newRecords).toHaveLength(1);
  });

  it("batches the .in() lookup at 100 hashes so the PostgREST URL cannot overflow", async () => {
    const records = Array.from({ length: 250 }, (_, i) => ({
      address: `${i} Main St`,
      city: "Austin",
      state: "TX",
      zip: "78701",
    }));
    H.results = [
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ];

    await checkDuplicates("user-1", records);

    expect(H.ops).toHaveLength(3);
    const batchSizes = H.ops.map((op) => {
      const inFilter = op.filters.find((f) => f[0] === "in");
      return (inFilter![2] as string[]).length;
    });
    expect(batchSizes).toEqual([100, 100, 50]);
  });

  it("throws when the lookup errors rather than reporting every record as new", async () => {
    H.results = [{ data: null, error: { message: "boom" } }];

    await expect(
      checkDuplicates("user-1", [
        { address: "123 Main St", city: "Austin", state: "TX", zip: "78701" },
      ])
    ).rejects.toThrow("Failed to check duplicates: boom");
  });
});

describe("removeBatchDuplicates", () => {
  it("collapses addresses that normalize to the same hash", () => {
    const { unique, internalDuplicates } = removeBatchDuplicates([
      { address: "123 Main Street", city: "Austin", state: "TX", zip: "78701" },
      { address: "123 MAIN ST", city: "AUSTIN", state: "tx", zip: "78701" },
      { address: "999 Other Rd", city: "Austin", state: "TX", zip: "78701" },
    ]);

    expect(unique).toHaveLength(2);
    expect(internalDuplicates).toBe(1);
  });

  it("keeps the first occurrence", () => {
    const { unique } = removeBatchDuplicates([
      { address: "123 Main Street", city: "Austin", state: "TX", zip: "78701" },
      { address: "123 MAIN ST", city: "AUSTIN", state: "tx", zip: "78701" },
    ]);

    expect(unique[0].address).toBe("123 Main Street");
  });
});
