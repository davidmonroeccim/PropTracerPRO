import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";

/**
 * Delete/insert fence for the session-side single-trace SUBMIT route.
 *
 * This route decides which trace_history rows survive a resubmission. Every row
 * it destroys is either a receipt (`wallet_transactions.trace_history_id`
 * references it) or a record the customer has already paid for, so the tests
 * below pin the exact PostgREST predicates of every delete it issues, not just
 * the HTTP status it returns.
 *
 * Written as characterization tests FIRST (2026-09-17, phase 2) because the
 * route had zero coverage and was about to be changed on the billing path.
 */

type Filter = [string, ...unknown[]];

interface Recorded {
  table: string;
  op: "select" | "delete" | "insert" | "update";
  filters: Filter[];
  payload?: unknown;
}

const H = vi.hoisted(() => ({
  ops: [] as Array<{
    table: string;
    op: "select" | "delete" | "insert" | "update";
    filters: Array<[string, ...unknown[]]>;
    payload?: unknown;
  }>,
  /** Every Postgres function call, so the wallet deduct can be counted exactly. */
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** What deduct_wallet_balance resolves with. `false` = the wallet was short. */
  deductData: true as unknown,
  deductError: null as { message: string } | null,
  user: { id: "user-1" } as { id: string } | null,
  profile: null as unknown as Record<string, unknown> | null,
  cached: null as Record<string, unknown> | null,
  /** Row the INSERT (or the reuse UPDATE) resolves with. */
  insertedRow: { id: "trace-new" } as Record<string, unknown> | null,
  insertError: null as { message: string; code?: string } | null,
  /** Error every trace_history DELETE resolves with. */
  deleteError: null as { message: string; code?: string } | null,
  /** Row the post-delete "does a row still exist?" probe resolves with. */
  survivingRow: null as Record<string, unknown> | null,
  submit: { success: true, jobId: "tj-1" } as {
    success: boolean;
    jobId?: string;
    error?: string;
  },
  /** What lookupDossier resolves with. Set per test. */
  dossier: null as unknown,
  /** What the FastAppend entity lookup resolves with. */
  entity: null as unknown,
  /** What the Tracerfy person lookup resolves with. */
  person: null as unknown,
}));

function envelopeFor(rec: Recorded): { data: unknown; error: unknown } {
  if (rec.op === "delete") return { data: null, error: H.deleteError };
  if (rec.op === "insert") {
    return H.insertError
      ? { data: null, error: H.insertError }
      : { data: H.insertedRow, error: null };
  }
  if (rec.op === "update") {
    // A reuse-the-existing-row UPDATE returns the row it updated.
    return { data: H.insertedRow, error: null };
  }
  if (rec.table === "user_profiles") return { data: H.profile, error: null };
  return { data: H.survivingRow, error: null };
}

function recordingClient() {
  return {
    from(table: string) {
      const begin = (op: Recorded["op"], payload?: unknown) => {
        const rec: Recorded = { table, op, filters: [], payload };
        H.ops.push(rec);
        const node: Record<string, unknown> = {};
        const add =
          (method: string) =>
          (...args: unknown[]) => {
            rec.filters.push([method, ...args]);
            return node;
          };
        for (const m of [
          "eq",
          "neq",
          "gte",
          "lte",
          "lt",
          "gt",
          "is",
          "or",
          "in",
          "not",
          "select",
          "limit",
        ]) {
          node[m] = add(m);
        }
        node.single = () => Promise.resolve(envelopeFor(rec));
        node.maybeSingle = () => Promise.resolve(envelopeFor(rec));
        node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(envelopeFor(rec)).then(res, rej);
        return node;
      };
      return {
        select: (...args: unknown[]) => begin("select", args[0]),
        delete: () => begin("delete"),
        insert: (payload: unknown) => begin("insert", payload),
        update: (payload: unknown) => begin("update", payload),
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      H.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: H.deductData, error: H.deductError });
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: H.user } }) },
    ...recordingClient(),
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => recordingClient(),
}));

vi.mock("@/lib/utils/deduplication", () => ({
  checkSingleDuplicate: vi.fn(async () => H.cached),
}));

vi.mock("@/lib/tracerfy/client", () => ({
  submitSingleTrace: vi.fn(async () => H.submit),
  // The two SYNCHRONOUS contact endpoints. Only the vendors are mocked: the
  // real planRoute and the real executeRoute run, so these tests cover the
  // routing and the spend accounting, not just the route's own branches.
  lookupBusinessTrace: vi.fn(async () => H.entity),
  lookupPersonTrace: vi.fn(async () => H.person),
}));

vi.mock("@/lib/tracerfy/dossier", () => ({
  lookupDossier: vi.fn(async () => H.dossier),
}));

vi.mock("@/lib/utils/auto-rebill", () => ({
  triggerAutoRebillIfNeeded: vi.fn(async () => undefined),
}));

const { POST } = await import("@/app/api/trace/single/route");

/**
 * The TIER 1 body. It carries an owner of record on purpose: since 2026-09-17
 * an ABSENT owner is itself the tier 2 trigger, so a body without one no longer
 * describes the async per-successful-trace path these tests characterize.
 */
const BODY = {
  address: "123 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
  owner_name: "ACME HOLDINGS LLC",
};

/** The TIER 2 body: same address, no owner of record. */
const TIER2_BODY = {
  address: "123 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
};

function post(body: Record<string, unknown> = BODY) {
  return POST(
    new Request("http://localhost/api/trace/single", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
}

/** Every DELETE issued against trace_history, in order. */
function deletes(): Recorded[] {
  return H.ops.filter((o) => o.table === "trace_history" && o.op === "delete");
}

function hasFilter(rec: Recorded, method: string, column: string, value?: unknown): boolean {
  return rec.filters.some(
    (f) =>
      f[0] === method &&
      f[1] === column &&
      (value === undefined || JSON.stringify(f[2]) === JSON.stringify(value))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  H.ops = [];
  H.rpcCalls = [];
  H.deductData = true;
  H.deductError = null;
  H.dossier = { success: true, hit: false, owners: [], property: null, mailingAddress: null, creditsDeducted: 0 };
  H.entity = { success: true, hit: false, contacts: null };
  H.person = { success: true, hit: false, contacts: null };
  H.user = { id: "user-1" };
  H.cached = null;
  H.insertedRow = { id: "trace-new" };
  H.insertError = null;
  H.deleteError = null;
  H.survivingRow = null;
  H.submit = { success: true, jobId: "tj-1" };
  H.profile = {
    id: "user-1",
    subscription_tier: "wallet",
    wallet_balance: 100,
    is_acquisition_pro_member: false,
    gateway_products: null,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/trace/single — auth and balance gates", () => {
  it("401s with no session", async () => {
    H.user = null;
    const res = await post();
    expect(res.status).toBe(401);
    expect(deletes()).toHaveLength(0);
  });

  it("400s on an invalid address before touching the database", async () => {
    const res = await post({ ...BODY, address: "" });
    expect(res.status).toBe(400);
    expect(H.ops.filter((o) => o.table === "trace_history")).toHaveLength(0);
  });

  it("400s when the profile is missing", async () => {
    H.profile = null;
    const res = await post();
    expect(res.status).toBe(400);
  });

  it("402s when the wallet cannot cover one tier 1 trace", async () => {
    H.profile = { ...H.profile, wallet_balance: PRICING.CHARGE_PER_SUCCESS_WALLET - 0.01 };
    const res = await post();
    expect(res.status).toBe(402);
    expect(deletes()).toHaveLength(0);
  });
});

describe("POST /api/trace/single — cache hit", () => {
  it("returns the cached contacts free of charge and deletes nothing", async () => {
    H.cached = {
      id: "trace-cached",
      trace_result: { phones: ["512-555-0100"], emails: [] },
    };

    const res = await post();
    const body = await res.json();

    expect(body).toMatchObject({ success: true, is_cached: true, charge: 0, trace_id: "trace-cached" });
    expect(deletes()).toHaveLength(0);
    expect(H.ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("emails alone count as contact data", async () => {
    H.cached = { id: "trace-cached", trace_result: { phones: [], emails: ["a@b.com"] } };
    const body = await (await post()).json();
    expect(body.is_cached).toBe(true);
  });
});

/** Asserts a delete carries the full not-billed predicate. */
function expectBilledGuard(rec: Recorded) {
  expect(
    rec.filters.some((f) => f[0] === "is" && f[1] === "property_record" && f[2] === null)
  ).toBe(true);
  const orClauses = rec.filters.filter((f) => f[0] === "or").map((f) => String(f[1]));
  expect(orClauses).toContain("charge.is.null,charge.lte.0");
  expect(orClauses).toContain("ai_research_charge.is.null,ai_research_charge.lte.0");
}

describe("POST /api/trace/single — cached row with no contacts", () => {
  it("does not delete a row the customer paid for", async () => {
    // Deleting it raises 23503 against wallet_transactions and destroys a
    // receipt if it ever succeeded.
    // MUTATION: drop the `if (!isBilledRow(...))` guard and this goes red.
    H.cached = {
      id: "trace-billed",
      trace_result: { phones: [], emails: [] },
      charge: 0.25,
      ai_research_charge: 0,
      property_record: null,
    };
    H.survivingRow = { id: "trace-billed" };

    await post();

    expect(deletes().some((d) => hasFilter(d, "eq", "id", "trace-billed"))).toBe(false);
  });

  it("does not delete a row carrying a property_record even at charge 0", async () => {
    // Tier 2 shape: the property record IS what was bought, and the contact
    // step that would set `charge` may never have run.
    H.cached = {
      id: "trace-tier2",
      trace_result: null,
      charge: 0,
      ai_research_charge: 0,
      property_record: { parcel_id: "abc" },
    };
    H.survivingRow = { id: "trace-tier2" };

    await post();

    expect(deletes().some((d) => hasFilter(d, "eq", "id", "trace-tier2"))).toBe(false);
  });

  it("still deletes an unbilled empty row so it can be retried", async () => {
    // The guard must not become "never delete anything".
    H.cached = {
      id: "trace-free",
      trace_result: { phones: [], emails: [] },
      charge: 0,
      ai_research_charge: 0,
      property_record: null,
    };

    await post();

    expect(deletes().some((d) => hasFilter(d, "eq", "id", "trace-free"))).toBe(true);
  });
});

describe("POST /api/trace/single — the sweep deletes", () => {
  it("never targets a billed row when clearing failed traces", async () => {
    // is_successful = false is EXACTLY the tier 2 paid-but-no-contacts shape.
    // MUTATION: unwrap excludeBilledRows() here and this goes red.
    await post();

    const failedSweep = deletes().find((d) => hasFilter(d, "eq", "is_successful", false));
    expect(failedSweep).toBeDefined();
    expectBilledGuard(failedSweep!);
  });

  it("never targets a billed row when clearing stale processing traces", async () => {
    await post();

    const staleSweep = deletes().find((d) => hasFilter(d, "eq", "status", "processing"));
    expect(staleSweep).toBeDefined();
    expectBilledGuard(staleSweep!);
  });

  it("never targets a billed row when the owner name changes", async () => {
    await post({ ...BODY, owner_name: "JANE DOE" });

    const ownerSweep = deletes().find((d) => hasFilter(d, "neq", "input_owner_name", "JANE DOE"));
    expect(ownerSweep).toBeDefined();
    expectBilledGuard(ownerSweep!);
  });

  it("never targets a billed row on skip_cache", async () => {
    // "Clear cache" means "let me re-trace", not "destroy my receipt".
    await post({ ...BODY, skip_cache: true });

    const all = deletes();
    expect(all).toHaveLength(1);
    expect(hasFilter(all[0], "eq", "address_hash")).toBe(true);
    expectBilledGuard(all[0]);
  });

  it("skip_cache bypasses the cache lookup entirely", async () => {
    const { checkSingleDuplicate } = await import("@/lib/utils/deduplication");
    await post({ ...BODY, skip_cache: true });
    expect(checkSingleDuplicate).not.toHaveBeenCalled();
  });
});

describe("POST /api/trace/single — delete errors are checked", () => {
  it("fails with the real reason instead of walking into a unique violation", async () => {
    // 23503 from wallet_transactions_trace_history_id_fkey. Until 2026-09-17
    // the route ignored it, the row survived, and the INSERT died on
    // UNIQUE(user_id, address_hash) as a 500 that named nothing.
    // MUTATION: delete the `if (deleteErrors.length > 0)` branch and this
    // goes red on both assertions.
    H.deleteError = { message: "violates foreign key constraint", code: "23503" };

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(String(body.error)).toContain("foreign key");
    expect(H.ops.some((o) => o.op === "insert")).toBe(false);
  });
});

describe("POST /api/trace/single — reuse instead of collide", () => {
  it("updates the surviving billed row rather than inserting a duplicate", async () => {
    // UNIQUE(user_id, address_hash) makes a second row impossible, and tier 2
    // wants one row enriched in two phases anyway.
    // MUTATION: replace the reuse branch with the unconditional insert and
    // this goes red.
    H.survivingRow = { id: "trace-billed" };
    H.insertedRow = { id: "trace-billed" };

    const body = await (await post()).json();

    expect(H.ops.some((o) => o.op === "insert")).toBe(false);
    const reuse = H.ops.find(
      (o) => o.op === "update" && o.filters.some((f) => f[0] === "eq" && f[1] === "id")
    );
    expect(reuse).toBeDefined();
    expect(reuse!.payload).toMatchObject({ status: "processing", tracerfy_job_id: null });
    expect(body.trace_id).toBe("trace-billed");
  });

  it("the reuse UPDATE never touches what the customer paid for", async () => {
    H.survivingRow = { id: "trace-billed" };
    H.insertedRow = { id: "trace-billed" };

    await post();

    const reuse = H.ops.find(
      (o) => o.op === "update" && o.filters.some((f) => f[0] === "eq" && f[1] === "id")
    );
    const keys = Object.keys(reuse!.payload as object);
    for (const paid of ["charge", "ai_research_charge", "property_record", "tier", "cost"]) {
      expect(keys).not.toContain(paid);
    }
    // Nor the identity columns, which already match.
    expect(keys).not.toContain("user_id");
    expect(keys).not.toContain("address_hash");
  });

  it("inserts when nothing survived", async () => {
    H.survivingRow = null;

    await post();

    expect(H.ops.some((o) => o.op === "insert")).toBe(true);
  });
});

describe("POST /api/trace/single — row creation and submission", () => {
  it("inserts a processing row and returns the Tracerfy job id", async () => {
    const res = await post();
    const body = await res.json();

    const insert = H.ops.find((o) => o.op === "insert");
    expect(insert).toBeDefined();
    expect(insert!.payload).toMatchObject({
      user_id: "user-1",
      city: "AUSTIN",
      state: "TX",
      zip: "78701",
      status: "processing",
    });
    expect(body).toMatchObject({
      success: true,
      status: "processing",
      trace_id: "trace-new",
      tracerfy_job_id: "tj-1",
    });
  });

  it("500s when the row cannot be created", async () => {
    H.insertError = { message: "duplicate key value violates unique constraint", code: "23505" };
    const res = await post();
    expect(res.status).toBe(500);
  });

  it("marks the row errored and 500s when Tracerfy refuses the submission", async () => {
    H.submit = { success: false, error: "Tracerfy down" };

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Tracerfy down");
    const statusUpdate = H.ops.find(
      (o) => o.op === "update" && (o.payload as Record<string, unknown>)?.status === "error"
    );
    expect(statusUpdate).toBeDefined();
  });
});

/* ==================================================================== *
 * TIER 2 — FULL PROPERTY TRACE
 *
 * A NEW BILLING PATH. Tier 2 bills per RECORD SUBMITTED, which makes two
 * things true that are false everywhere else in this codebase:
 *   - a row can carry `charge > 0` with `is_successful = false`
 *   - a customer can receive NOTHING and still be charged
 *
 * The one distinction every test below is protecting: `success` is the
 * billing gate, never `ownerFound`. A billed MISS and an unbillable vendor
 * FAILURE both come back with ownerFound: false.
 *
 * Only the vendors are mocked here. The real planRoute and the real
 * executeRoute run, so these also cover which vendor a discovered owner is
 * routed to and what the route does with the spend report it gets back.
 * ==================================================================== */

import dossierEntityFixture from "@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json";
import dossierIndividualFixture from "@/lib/tracerfy/__tests__/fixtures/individual-hit.json";

/** A dossier HIT on an entity-owned parcel, carrying the real 86-key record. */
const DOSSIER_ENTITY_HIT = {
  success: true,
  hit: true,
  owners: dossierEntityFixture.response.owners,
  property: dossierEntityFixture.response.property,
  mailingAddress: dossierEntityFixture.response.mailing_address,
  creditsDeducted: 10,
};

/** A dossier HIT on an individually-owned parcel. */
const DOSSIER_INDIVIDUAL_HIT = {
  success: true,
  hit: true,
  owners: dossierIndividualFixture.response.owners,
  property: dossierIndividualFixture.response.property,
  mailingAddress: dossierIndividualFixture.response.mailing_address,
  creditsDeducted: 10,
};

/** The county has no parcel at this address. Free at the vendor, BILLED to the customer. */
const DOSSIER_MISS = {
  success: true,
  hit: false,
  owners: [],
  property: null,
  mailingAddress: null,
  creditsDeducted: 0,
};

/** We could not ask. Never billed. */
const DOSSIER_FAILURE = {
  success: false,
  hit: false,
  owners: [],
  property: null,
  mailingAddress: null,
  creditsDeducted: 0,
  error: "Tracerfy service unavailable",
};

const CONTACTS_HIT = {
  success: true,
  hit: true,
  contacts: {
    ownerName: "Testowner Placeholder",
    phones: [{ number: "5550000101", type: "mobile" }],
    emails: ["principal@example.invalid"],
    mailingAddress: "100 Placeholder Way, Redacted, ZZ, 00000",
  },
};

const PAYG_PROFILE = {
  id: "user-1",
  subscription_tier: "wallet",
  wallet_balance: 100,
  is_acquisition_pro_member: false,
  gateway_products: null,
};
const PRO_PROFILE = { ...PAYG_PROFILE, subscription_tier: "pro" };
const ACQ_PRO_PROFILE = { ...PAYG_PROFILE, is_acquisition_pro_member: true };

/** Every call to deduct_wallet_balance. */
const deducts = () => H.rpcCalls.filter((c) => c.fn === "deduct_wallet_balance");

/** The UPDATE that writes the tier 2 outcome. */
function persisted(): Record<string, unknown> | undefined {
  const rec = H.ops.find(
    (o) =>
      o.op === "update" &&
      o.payload !== null &&
      typeof o.payload === "object" &&
      "property_record" in (o.payload as object)
  );
  return rec?.payload as Record<string, unknown> | undefined;
}

async function vendorsCalled() {
  const { lookupDossier } = await import("@/lib/tracerfy/dossier");
  const { submitSingleTrace, lookupBusinessTrace, lookupPersonTrace } = await import(
    "@/lib/tracerfy/client"
  );
  return { lookupDossier, submitSingleTrace, lookupBusinessTrace, lookupPersonTrace };
}

describe("tier 2 — the trigger", () => {
  it("runs automatically when no owner of record was supplied", async () => {
    H.dossier = DOSSIER_MISS;
    const { lookupDossier, submitSingleTrace } = await vendorsCalled();

    const body = await (await post(TIER2_BODY)).json();

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(body.tier).toBe(2);
  });

  it("does NOT run when the owner of record was supplied", async () => {
    const { lookupDossier, submitSingleTrace } = await vendorsCalled();

    const body = await (await post(BODY)).json();

    expect(lookupDossier).not.toHaveBeenCalled();
    expect(submitSingleTrace).toHaveBeenCalledTimes(1);
    expect(body.tier).toBeUndefined();
    expect(deducts()).toHaveLength(0);
  });

  it("runs on the explicit opt-in even when the owner IS supplied", async () => {
    // The caller has the owner and wants the county property record anyway.
    H.dossier = DOSSIER_MISS;
    const { lookupDossier, submitSingleTrace } = await vendorsCalled();

    await post({ ...BODY, full_property_trace: true });

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(submitSingleTrace).not.toHaveBeenCalled();
  });

  it("does not reuse the ai_research flag", async () => {
    // AI Search is being removed; overloading its flag would couple the two.
    const { lookupDossier } = await vendorsCalled();
    await post({ ...BODY, ai_research: { owner_name: "ACME HOLDINGS LLC" } });
    expect(lookupDossier).not.toHaveBeenCalled();
  });

  it("keys the dossier on the submitted address", async () => {
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await vendorsCalled();

    await post(TIER2_BODY);

    expect(lookupDossier).toHaveBeenCalledWith({
      mode: "address",
      address: "123 Main St",
      city: "Austin",
      state: "TX",
      zip_code: "78701",
    });
  });
});

describe("tier 2 — the pre-flight balance gate", () => {
  it("402s a pay-as-you-go wallet that cannot cover ONE record", async () => {
    // 0.39 covers the tier 1 wallet rate (0.25) and not the tier 2 one (0.40).
    // MUTATION: reserve chargePerTrace() here and this goes red -- the request
    // reaches the vendors, we spend, and there is nothing to collect from.
    H.profile = { ...PAYG_PROFILE, wallet_balance: 0.39 };
    const { lookupDossier } = await vendorsCalled();

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(402);
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
  });

  it("lets a pro wallet through at the pro rate", async () => {
    H.profile = { ...PRO_PROFILE, wallet_balance: 0.25 };
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await vendorsCalled();

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(200);
    expect(lookupDossier).toHaveBeenCalledTimes(1);
  });
});

describe("tier 2 — a vendor FAILURE is never billed", () => {
  it("charges nothing when the dossier could not be asked", async () => {
    // success:false and ownerFound:false. A miss looks identical on ownerFound,
    // which is exactly why the gate is `success`.
    // MUTATION: gate the deduct on execution.ownerFound and this goes red.
    H.dossier = DOSSIER_FAILURE;

    const res = await post(TIER2_BODY);
    const body = await res.json();

    expect(deducts()).toHaveLength(0);
    expect(res.status).toBe(502);
    expect(body.charge).toBe(0);
    expect(body.error).toContain("unavailable");
  });

  it("persists nothing billable, so the customer can retry for free", async () => {
    H.dossier = DOSSIER_FAILURE;

    await post(TIER2_BODY);

    expect(persisted()).toBeUndefined();
    const errored = H.ops.find(
      (o) => o.op === "update" && (o.payload as Record<string, unknown>)?.status === "error"
    );
    expect(errored).toBeDefined();
  });

  it("charges nothing when the CONTACT step fails after the dossier hit", async () => {
    // The $0.20 dossier is already spent on our side. It is still not billed:
    // we could not complete the ask, so the customer must be able to retry.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = { success: false, hit: false, contacts: null, error: "FastAppend auth failed (403)" };

    const res = await post(TIER2_BODY);

    expect(deducts()).toHaveLength(0);
    expect(res.status).toBe(502);
    expect(persisted()).toBeUndefined();
  });
});

describe("tier 2 — a TOTAL MISS is still billed", () => {
  it("charges the full per-record rate when the county has no parcel", async () => {
    // "Per record submitted" is literal: the customer receives nothing and is
    // charged. David, 2026-09-17.
    // MUTATION: skip the deduct when execution.property is null and this goes red.
    H.dossier = DOSSIER_MISS;

    const body = await (await post(TIER2_BODY)).json();

    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(0.4);
    expect(deducts()[0].args.p_trace_history_id).toBe("trace-new");
    expect(body).toMatchObject({ success: true, status: "no_match", tier: 2, charge: 0.4 });
  });

  it("writes the cacheable billed-miss row shape", async () => {
    // tier = 2, charge > 0, property_record IS NULL, status = 'no_match'.
    // This is the row CACHE_HIT_FILTER's third arm exists to find.
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(persisted()).toMatchObject({
      tier: 2,
      charge: 0.4,
      property_record: null,
      status: "no_match",
      is_successful: false,
    });
  });

  it("charges a dossier hit whose contact step found nothing", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = { success: true, hit: false, contacts: null };

    const body = await (await post(TIER2_BODY)).json();

    expect(deducts()).toHaveLength(1);
    expect(body.status).toBe("no_match");
    expect(persisted()).toMatchObject({ is_successful: false, charge: 0.4, tier: 2 });
  });
});

describe("tier 2 — the caller's REAL plan is billed", () => {
  it("bills pay-as-you-go at the wallet column", async () => {
    // MUTATION: hardcode planRoute's plan argument to 'pro' and this goes red.
    // That is the 40% undercharge FAILSAFE_PRICE_PLAN was written against.
    H.profile = PAYG_PROFILE;
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(deducts()[0].args.p_amount).toBe(0.4);
  });

  it("bills a pro at the pro column", async () => {
    H.profile = PRO_PROFILE;
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(deducts()[0].args.p_amount).toBe(0.25);
  });

  it("bills an AcquisitionPRO member at the pro column", async () => {
    H.profile = ACQ_PRO_PROFILE;
    H.dossier = DOSSIER_MISS;

    await post(TIER2_BODY);

    expect(deducts()[0].args.p_amount).toBe(0.25);
  });

  it("deducts exactly ONCE per record", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    expect(deducts()).toHaveLength(1);
  });

  it("persists only what was actually collected", async () => {
    // deduct_wallet_balance returns FALSE without moving money when the wallet
    // is short. Writing the intended amount would show the customer a charge
    // they never paid.
    // MUTATION: persist plan.billing.amount instead of the deductOrZero result
    // and this goes red.
    H.dossier = DOSSIER_MISS;
    H.deductData = false;

    const body = await (await post(TIER2_BODY)).json();

    expect(persisted()).toMatchObject({ charge: 0 });
    expect(body.charge).toBe(0);
    expect(String(body.warnings.join(" "))).toContain("did not cover");
  });
});

describe("tier 2 — what gets persisted", () => {
  it("stores the property record RAW, all 86 keys", async () => {
    // The fidelity rule: no filtering, no renaming, no subsetting. A field
    // empty in OH, CA and UT may be populated in another county, and the $0.20
    // was already spent to fetch it.
    // MUTATION: subset the object to the fields we display and this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    const stored = persisted()!.property_record as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(
      Object.keys(dossierEntityFixture.response.property).length
    );
    expect(stored).toEqual(dossierEntityFixture.response.property);
  });

  it("returns the same raw record to the caller", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    const body = await (await post(TIER2_BODY)).json();

    expect(body.property_record).toEqual(dossierEntityFixture.response.property);
  });

  it("puts contacts where tier 1 already puts them", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    const row = persisted()!;
    expect(row).toMatchObject({
      status: "success",
      is_successful: true,
      phone_count: 1,
      email_count: 1,
      tier: 2,
      charge: 0.4,
    });
    const result = row.trace_result as Record<string, unknown>;
    expect(result.owner_name).toBe("Testowner Placeholder");
    // The OWNER OF RECORD the dossier bought, which has nowhere else to live:
    // the 86-key property object carries no owner field.
    expect(result.owner_name_2).toBe("Colmaven, Llc");
    expect(result.emails).toEqual(["principal@example.invalid"]);
  });

  it("keeps the owner of record even when no contacts came back", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = { success: true, hit: false, contacts: null };

    await post(TIER2_BODY);

    const result = persisted()!.trace_result as Record<string, unknown>;
    expect(result.owner_name_2).toBe("Colmaven, Llc");
    expect(result.owner_name).toBeNull();
    expect(result.phones).toEqual([]);
  });

  it("records what the vendors actually took, not a price-list guess", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    // $0.20 dossier (10 credits) + $0.10 entity contact call.
    expect(persisted()!.cost).toBe(0.3);
  });

  it("clears the Tracerfy job id: there is nothing to poll", async () => {
    H.dossier = DOSSIER_MISS;

    const body = await (await post(TIER2_BODY)).json();

    expect(persisted()!.tracerfy_job_id).toBeNull();
    expect(body.tracerfy_job_id).toBeUndefined();
  });
});

describe("tier 2 — the discovered owner picks the vendor", () => {
  it("routes an entity owner to FastAppend, keyed on name plus state", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    const { lookupBusinessTrace, lookupPersonTrace } = await vendorsCalled();

    await post(TIER2_BODY);

    expect(lookupBusinessTrace).toHaveBeenCalledWith({
      company_name: "Colmaven, Llc",
      state: "TX",
    });
    expect(lookupPersonTrace).not.toHaveBeenCalled();
  });

  it("routes an individual owner to the named Tracerfy lookup", async () => {
    H.dossier = DOSSIER_INDIVIDUAL_HIT;
    H.person = CONTACTS_HIT;
    const { lookupBusinessTrace, lookupPersonTrace } = await vendorsCalled();

    await post(TIER2_BODY);

    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(lookupPersonTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        first_name: "Testowner",
        last_name: "Placeholder",
        address: "123 Main St",
        find_owner: false,
      })
    );
  });
});

describe("tier 2 — a billed row is served from the database, free", () => {
  it("serves a billed MISS without re-running the dossier", async () => {
    // The row carries no contacts and no property record, so only the third
    // arm of CACHE_HIT_FILTER can find it. Re-buying it bills the customer a
    // second time for the same absence.
    // MUTATION: delete the isCacheHitRow branch in the route and this goes red.
    H.cached = {
      id: "trace-billed-miss",
      trace_result: null,
      status: "no_match",
      is_successful: false,
      charge: 0.4,
      ai_research_charge: 0,
      property_record: null,
      tier: 2,
    };
    H.survivingRow = { id: "trace-billed-miss" };
    const { lookupDossier } = await vendorsCalled();

    const body = await (await post(TIER2_BODY)).json();

    expect(lookupDossier).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
    expect(body).toMatchObject({ success: true, is_cached: true, charge: 0, trace_id: "trace-billed-miss" });
  });

  it("serves a paid property record with no contacts, free", async () => {
    H.cached = {
      id: "trace-tier2",
      trace_result: null,
      is_successful: false,
      charge: 0.4,
      ai_research_charge: 0,
      property_record: { apn: "abc" },
      tier: 2,
    };
    H.survivingRow = { id: "trace-tier2" };
    const { lookupDossier } = await vendorsCalled();

    const body = await (await post(TIER2_BODY)).json();

    expect(lookupDossier).not.toHaveBeenCalled();
    expect(body.property_record).toEqual({ apn: "abc" });
    expect(body.charge).toBe(0);
  });

  it("re-buys an UNBILLED failure rather than serving nothing forever", async () => {
    // The guard must not become "never trace this address again".
    H.cached = {
      id: "trace-free",
      trace_result: { phones: [], emails: [] },
      is_successful: false,
      charge: 0,
      ai_research_charge: 0,
      property_record: null,
      tier: null,
    };
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await vendorsCalled();

    await post(TIER2_BODY);

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(deducts()).toHaveLength(1);
  });

  it("re-buys a tier 2 row where nothing was ever collected", async () => {
    // charge = 0 means the deduct returned false. There is no purchase to
    // serve back, so this correctly spends again.
    H.cached = {
      id: "trace-uncollected",
      trace_result: null,
      is_successful: false,
      charge: 0,
      ai_research_charge: 0,
      property_record: null,
      tier: 2,
    };
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await vendorsCalled();

    await post(TIER2_BODY);

    expect(lookupDossier).toHaveBeenCalledTimes(1);
  });

  it("skip_cache re-buys, because it forces a fresh vendor call", async () => {
    H.dossier = DOSSIER_MISS;
    const { lookupDossier } = await vendorsCalled();

    await post({ ...TIER2_BODY, skip_cache: true });

    expect(lookupDossier).toHaveBeenCalledTimes(1);
    expect(deducts()).toHaveLength(1);
  });
});

describe("tier 2 — the learned zip is persisted without moving the cache key", () => {
  it("writes the situs zip the dossier taught us when the caller sent none", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    const { zip: _dropped, ...noZip } = TIER2_BODY;
    void _dropped;

    await post(noZip);

    const situsZip = String(
      (dossierEntityFixture.response.property as Record<string, unknown>).zip_code
    );
    expect(persisted()!.zip).toBe(situsZip);
  });

  it("NEVER touches address_hash", async () => {
    // address_hash is sha256 of STREET|CITY|STATE and deliberately excludes the
    // zip (migration 20260904). A row whose hash moves stops matching its own
    // cache key and re-buys itself forever.
    // MUTATION: add address_hash to the tier 2 update payload and this goes red.
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;
    const { zip: _dropped, ...noZip } = TIER2_BODY;
    void _dropped;

    await post(noZip);

    const insertedHash = (H.ops.find((o) => o.op === "insert")!.payload as Record<string, unknown>)
      .address_hash;
    expect(insertedHash).toBeTruthy();
    expect(Object.keys(persisted()!)).not.toContain("address_hash");
    expect(Object.keys(persisted()!)).not.toContain("normalized_address");
  });

  it("does not rewrite a zip the caller supplied", async () => {
    H.dossier = DOSSIER_ENTITY_HIT;
    H.entity = CONTACTS_HIT;

    await post(TIER2_BODY);

    expect(Object.keys(persisted()!)).not.toContain("zip");
  });

  it("no longer 500s on a submission with no zip at all", async () => {
    // `zip.substring(0, 5)` threw before the row was even created, which made
    // the backfill unreachable from this route.
    H.dossier = DOSSIER_MISS;
    const { zip: _dropped, ...noZip } = TIER2_BODY;
    void _dropped;

    const res = await post(noZip);

    expect(res.status).toBe(200);
    expect((H.ops.find((o) => o.op === "insert")!.payload as Record<string, unknown>).zip).toBeNull();
  });
});

describe("tier 2 — the charge follows the vendor call", () => {
  it("never deducts when no vendor was asked", async () => {
    // planRoute emits no step when the parcel carries no usable key. Address
    // validation makes that unreachable from this route; the guard exists
    // because a record nobody was asked about must never reach the deduct.
    const { planRoute } = await import("@/lib/routing/ownerRoute");
    const spy = vi.spyOn(await import("@/lib/routing/ownerRoute"), "planRoute");
    spy.mockImplementationOnce((parcel, plan) => ({
      ...planRoute(parcel, plan),
      steps: [],
    }));
    const { lookupDossier } = await vendorsCalled();

    const res = await post(TIER2_BODY);

    expect(res.status).toBe(400);
    expect(lookupDossier).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
    spy.mockRestore();
  });
});
