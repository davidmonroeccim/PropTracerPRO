import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEDUPE, STALE_PROCESSING } from "@/lib/constants";
import { normalizeAddress, createAddressHash, traceKeyFor } from "@/lib/utils/address-normalizer";

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
  /** Which Supabase client factory each lookup reached for, in order. */
  clientsBuilt: [] as string[],
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

/**
 * Which client each lookup builds is a BILLING fact, not a plumbing detail.
 * `@/lib/supabase/server` is the cookie-backed ANON client and `trace_history`
 * carries RLS `USING (auth.uid() = user_id)`, so on any surface with no session
 * cookie it matches zero rows and every repeat call re-buys. Both factories are
 * mocked and counted so a test can name which one ran.
 */
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    H.clientsBuilt.push("anon");
    return recordingClient();
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    H.clientsBuilt.push("admin");
    return recordingClient();
  },
}));

const { checkDuplicates, checkSingleDuplicate, checkSingleDuplicateByHash, removeBatchDuplicates } =
  await import("@/lib/utils/deduplication");

function filter(rec: Recorded, method: string, column: string): Filter | undefined {
  return rec.filters.find((f) => f[0] === method && f[1] === column);
}

/** Seeds the rows the next `.select().eq().in().gte()` chain resolves with. */
function stubRows(rows: unknown[]): void {
  H.results = [{ data: rows, error: null }];
  H.resultIndex = 0;
}

beforeEach(() => {
  H.ops = [];
  H.results = [];
  H.resultIndex = 0;
  H.clientsBuilt = [];
});

describe("checkSingleDuplicate's client", () => {
  it("is the SERVICE-ROLE client, so the lookup works on every surface", async () => {
    // WAS, until 2026-09-17: the cookie-backed anon client. trace_history
    // carries RLS `USING (auth.uid() = user_id)`, and an /api/v1/* request
    // authenticates by API key with no Supabase session cookie, so `auth.uid()`
    // was NULL, the select matched zero rows, and this returned null every time
    // on that surface. Both cache branches in the v1 route were unreachable and
    // every repeat call re-bought the dossier and charged the wallet again.
    //
    // MUTATION: build it from @/lib/supabase/server again and this goes red.
    H.results = [{ data: null, error: { code: "PGRST116" } }];

    await checkSingleDuplicate("user-1", "123 Main St", "Austin", "TX");

    expect(H.clientsBuilt).toEqual(["admin"]);
  });

  it("leaves the bulk lookup on the anon client, which is a KNOWN open defect", async () => {
    // Pinned so the asymmetry is deliberate rather than forgotten. checkDuplicates
    // has the identical blindness on v1 bulk and on the MCP surface, and moving
    // it is not purely a billing fix: it counts ANY row in the window as a
    // duplicate, including a plain failure, so the move would also start
    // blocking retries of failed addresses on a public API. That is a product
    // call and it belongs to whoever owns the bulk routes.
    H.results = [{ data: [], error: null }];

    await checkDuplicates("user-1", [
      { address: "123 Main St", city: "Austin", state: "TX", zip: "78701" },
    ]);

    expect(H.clientsBuilt).toEqual(["anon"]);
  });
});

/**
 * THE CROSS-USER FENCE.
 *
 * `trace_history` is UNIQUE(user_id, address_hash), so two customers who trace
 * the same parcel hold two separate rows and BOTH pay: serving user B from user
 * A's purchase would redistribute one customer's paid-for data to another. That
 * is a product rule and a vendor-contract boundary, not an optimisation
 * (SESSION-HANDOFF, 2026-09-17).
 *
 * These assert the predicate rather than a return value, because a mock will
 * hand back whatever it is told regardless of filters. Delete the `user_id`
 * filter from either lookup and they go red.
 */
describe("every lookup is keyed to the caller, unconditionally", () => {
  it("keys the single lookup to the user id it was given, whoever that is", async () => {
    // Two different callers, two different filter values. A constant, a
    // hardcoded id or a dropped filter all fail this.
    H.results = [
      { data: null, error: { code: "PGRST116" } },
      { data: null, error: { code: "PGRST116" } },
    ];

    await checkSingleDuplicate("user-a", "123 Main St", "Austin", "TX");
    await checkSingleDuplicate("user-b", "123 Main St", "Austin", "TX");

    expect(filter(H.ops[0], "eq", "user_id")).toEqual(["eq", "user_id", "user-a"]);
    expect(filter(H.ops[1], "eq", "user_id")).toEqual(["eq", "user_id", "user-b"]);
  });

  it("keys the bulk lookup to the user id it was given", async () => {
    H.results = [{ data: [], error: null }];

    await checkDuplicates("user-b", [
      { address: "123 Main St", city: "Austin", state: "TX", zip: "78701" },
    ]);

    expect(filter(H.ops[0], "eq", "user_id")).toEqual(["eq", "user_id", "user-b"]);
  });

  it("emits the user_id filter on the single lookup whatever else the row looks like", async () => {
    // The filter has no branch to hide behind: the same predicate is sent for a
    // hit and for a miss. A `user_id` filter applied only on some paths is the
    // shape that leaks.
    H.results = [
      { data: { id: "t1", is_successful: true }, error: null },
      { data: null, error: { code: "PGRST116" } },
    ];

    await checkSingleDuplicate("user-1", "123 Main St", "Austin", "TX");
    await checkSingleDuplicate("user-1", "999 Other Rd", "Austin", "TX");

    for (const rec of H.ops) {
      expect(filter(rec, "eq", "user_id")).toEqual(["eq", "user_id", "user-1"]);
    }
  });
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
    // Asserted by arm rather than by whole string: the filter grew a third arm
    // on 2026-09-17 for the billed tier 2 MISS, and the exact spelling is
    // pinned once, in lib/trace/__tests__/billedRows.test.ts.
    expect(String(or![1])).toContain("is_successful.eq.true");
    expect(String(or![1])).toContain("property_record.not.is.null");
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

describe("checkSingleDuplicateByHash (the API keys a city-less record on its parcel id)", () => {
  it("looks up exactly the hash it is handed, on the admin client, for the caller only", async () => {
    // MUTATION: drop `.eq('user_id', userId)` from checkSingleDuplicateByHash and this goes red.
    H.results = [{ data: null, error: { code: "PGRST116" } }];
    await checkSingleDuplicateByHash("user-1", "hash-apn");
    expect(H.clientsBuilt).toEqual(["admin"]);
    expect(filter(H.ops[0], "eq", "user_id")).toEqual(["eq", "user_id", "user-1"]);
    expect(filter(H.ops[0], "eq", "address_hash")).toEqual(["eq", "address_hash", "hash-apn"]);
  });
});

describe('the bulk duplicate key (spec 6.3, D36)', () => {
  it('is traceKeyFor, so one record cannot land on two rows through two doors', () => {
    // WHY THIS MATTERS EVEN THOUGH THE TWO AGREE ON EVERY WEB RECORD TODAY. The single routes key
    // with traceKeyFor (app/api/v1/trace/single/route.ts) and the bulk routes keyed with plain
    // normalizeAddress. On the web upload the two answers are identical for every record the page
    // can send, because the page requires a street and a state and the web app has no parcel id
    // column (D5). They diverge the moment a surface carries a parcel id, which is exactly what
    // 2B wires up, and a divergence there is the same record stored twice: paid once, charged
    // again inside the 90 days. One derivation now, proven, rather than two that happen to agree.
    const withStreetAndCity = { address: '100 Main St', city: 'Dallas', state: 'TX' }
    expect(traceKeyFor(withStreetAndCity)).toBe(normalizeAddress('100 Main St', 'Dallas', 'TX'))

    const streetNoCity = { address: '100 Main St', city: '', state: 'TX' }
    expect(traceKeyFor(streetNoCity)).toBe(normalizeAddress('100 Main St', '', 'TX'))

    // The 2B shape, keyed on the parcel rather than on `|CITY|STATE` (D36).
    expect(traceKeyFor({ city: 'Austin', state: 'TX', apn: '0123-456', county: 'Travis' })).toBe(
      'APN|0123-456|TRAVIS|TX'
    )
  })

  it('removeBatchDuplicates keys on traceKeyFor', async () => {
    const { removeBatchDuplicates } = await import('@/lib/utils/deduplication')
    const a = { address: '100 Main St', city: '', state: 'TX', apn: '0123-456', county: 'Travis' }
    const b = { address: '200 Oak Ave', city: '', state: 'TX', apn: '0123-456', county: 'Travis' }
    // Same parcel, two different street strings: under D36 that is ONE record, and under plain
    // normalizeAddress it was two.
    const { unique, internalDuplicates } = removeBatchDuplicates([a, b])
    expect(unique).toHaveLength(1)
    expect(internalDuplicates).toBe(1)
  })
})

describe('the busy_try_again resend exemption (spec 5.2)', () => {
  it('does NOT count a busy row as a duplicate', async () => {
    // Spec 5.2: "A resend of a busy_try_again record is NOT a duplicate. It reuses the same row
    // (same address hash) and goes back on the queue. This exemption is what makes 'try again in 5
    // minutes' true." Without it the sentence is advice that fails when followed: the row is
    // written status 'error', so the stale-processing escape below does not reach it either, and
    // the resend lands in Duplicates Removed with no explanation.
    const record = { address: '100 Main St', city: 'Dallas', state: 'TX' }
    const hash = createAddressHash(traceKeyFor(record))
    stubRows([
      {
        address_hash: hash,
        status: 'error',
        outcome_code: 'busy_try_again',
        created_at: new Date().toISOString(),
      },
    ])
    const result = await checkDuplicates('user-1', [record])
    expect(result.newRecords).toHaveLength(1)
    expect(result.duplicates).toHaveLength(0)
  })

  it('still counts every OTHER finished row as a duplicate, busy being the one exemption', async () => {
    // Open task 17 is unchanged by this: a row that came back without contacts still blocks a
    // resend for 90 days. Only busy is exempt, because only busy is the outcome whose own sentence
    // tells the customer to send it again.
    const record = { address: '100 Main St', city: 'Dallas', state: 'TX' }
    const hash = createAddressHash(traceKeyFor(record))
    for (const outcome of ['no_match', 'owner_name_not_matched', 'no_lookup_key', null]) {
      stubRows([
        {
          address_hash: hash,
          status: 'no_match',
          outcome_code: outcome,
          created_at: new Date().toISOString(),
        },
      ])
      const result = await checkDuplicates('user-1', [record])
      expect(result.newRecords, `outcome ${outcome}`).toHaveLength(0)
      expect(result.duplicates, `outcome ${outcome}`).toHaveLength(1)
    }
  })
})
