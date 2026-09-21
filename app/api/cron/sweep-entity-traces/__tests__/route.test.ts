import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "@/lib/constants";
import { BLANK_OWNER_SKIP_STATUS, skipReasonFor } from "@/lib/trace/blankOwnerSkip";
import {
  ENTITY_TRACE_FAILED_STATUS,
  MAX_ENTITY_TRACE_ATTEMPTS,
  isEntityTracePending,
} from "@/lib/trace/entityTraceAttempts";

/**
 * Money fences for the entity sweep, the cron that resolves the entity-owned
 * rows of a bulk job.
 *
 * It was sweep-bulk-research until 2026-09-17, when the Brave plus Claude AI
 * Search engine behind it was removed and it was re-pointed at the synchronous
 * FastAppend business trace. 987 of the 1,301 rows the old engine ever produced
 * came through here, so this is the path that has to keep working.
 *
 * THREE THINGS THESE TESTS EXIST TO HOLD:
 *
 * 1. The $0.15 research fee is GONE. Nothing here books it. It is not enough to
 *    read the code for that, because 0.15 is ALSO the tier 1 Pro rate
 *    (lib/constants.ts warns the digits collide), so every test below uses a
 *    Pay-As-You-Go profile whose tier 1 rate is 0.25. A stray 0.15 deduction is
 *    then unambiguous.
 * 2. Bill on whether we could ASK, never on whether we FOUND anything (L-007).
 *    A FastAppend outage and a FastAppend miss both come back with no contacts,
 *    and only one of them is the customer's problem.
 * 3. A row with no owner name is never charged, never queued and never left to
 *    speak for itself as a bare no_match.
 */

type Filter = [string, ...unknown[]];

interface Op {
  table: string;
  op: "select" | "update";
  payload?: Record<string, unknown>;
  filters: Filter[];
}

const H = vi.hoisted(() => ({
  ops: [] as Array<{
    table: string;
    op: "select" | "update";
    payload?: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  queuedRows: [] as Array<Record<string, unknown>>,
  // wallet_transactions rows already booked against the row being processed.
  // A non-empty array is the state a row is in after a previous run deducted
  // and then died before it could write the result back.
  //
  // `type` IS LOAD-BEARING AND EVERY ENTRY MUST CARRY IT. collectedChargeFor
  // nets debits against credits, so a row with no `type` reads as money handed
  // BACK and flips the sign of the probe's answer. PostgREST would never omit a
  // selected column; a stub that does is telling the route a lie no database
  // can tell it.
  priorDebits: [] as Array<Record<string, unknown>>,
  claimOk: true,
  profile: {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: [] as string[],
  } as Record<string, unknown> | null,
  businessTrace: { success: true, hit: false, contacts: null } as Record<string, unknown>,
  submit: { success: true, jobId: "tf-person-1" } as Record<string, unknown>,
}));

/** Records every trace_history read and write and resolves each chain the way
 *  PostgREST would for the shape the route actually builds. */
function recordingClient() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      H.rpcCalls.push({ fn, args });
      return { data: true, error: null };
    },
    from(table: string) {
      const node: Record<string, unknown> = {};
      let rec: Op | null = null;
      let sawSelect = false;

      const add =
        (method: string) =>
        (...args: unknown[]) => {
          if (method === "select") sawSelect = true;
          rec?.filters.push([method, ...args]);
          return node;
        };
      for (const m of ["select", "eq", "lt", "or", "order", "limit", "in", "is"])
        node[m] = add(m);

      const settle = () => {
        if (table === "user_profiles") return { data: H.profile, error: null };
        if (table === "wallet_transactions") return { data: H.priorDebits, error: null };
        if (rec?.op === "select") return { data: H.queuedRows, error: null };
        // An update that asked for `.select('id')` and is awaited directly is the
        // stale-claim revert; it wants an array back.
        if (rec?.op === "update" && sawSelect) return { data: [], error: null };
        return { data: null, error: null };
      };

      node.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(settle()).then(res, rej);
      node.maybeSingle = async () => {
        // The atomic claim: `.update(...).eq(id).eq(status).select('id').maybeSingle()`.
        if (rec?.op === "update") return { data: H.claimOk ? { id: "row-1" } : null, error: null };
        return { data: null, error: null };
      };
      node.single = async () => ({ data: H.profile, error: null });

      return {
        select: (...args: unknown[]) => {
          rec = { table, op: "select", filters: [["select", ...args]] };
          H.ops.push(rec);
          return node;
        },
        update: (payload: Record<string, unknown>) => {
          rec = { table, op: "update", payload, filters: [] };
          H.ops.push(rec);
          return node;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => recordingClient() }));
vi.mock("@/lib/tracerfy/client", () => ({
  lookupBusinessTrace: vi.fn(async () => H.businessTrace),
  submitSingleTrace: vi.fn(async () => H.submit),
}));

const { GET } = await import("@/app/api/cron/sweep-entity-traces/route");
const { lookupBusinessTrace, submitSingleTrace } = await import("@/lib/tracerfy/client");

const ROW = {
  id: "row-1",
  user_id: "user-1",
  normalized_address: "100 MAIN ST|DALLAS|TX|75001",
  city: "DALLAS",
  state: "TX",
  zip: "75001",
  address_hash: "hash-1",
  input_owner_name: "Acme Holdings Llc",
};

function run(secret = "s3cret") {
  return GET(
    new Request("http://localhost/api/cron/sweep-entity-traces", {
      headers: { authorization: `Bearer ${secret}` },
    })
  );
}

/** Every trace_history update payload, in order. */
const historyWrites = () =>
  H.ops.filter((o) => o.table === "trace_history" && o.op === "update").map((o) => o.payload!);

/** The payload of the LAST trace_history update, which is the row's final state. */
const finalWrite = () => historyWrites()[historyWrites().length - 1];

const deducts = () => H.rpcCalls.filter((c) => c.fn === "deduct_wallet_balance");

/**
 * The stale-claim age filter on an update, whatever shape it takes.
 *
 * It used to be a bare `.lt('ai_research_claimed_at', cutoff)`, which cannot
 * match a NULL claim timestamp. It is now an `.or()` carrying both arms, so the
 * assertion asks for the filter rather than for one particular operator.
 */
const staleFilter = (op: Op) =>
  op.filters.find(
    (f) => f[0] === "or" && String(f[1]).includes("ai_research_claimed_at")
  );

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  H.ops = [];
  H.rpcCalls = [];
  H.queuedRows = [{ ...ROW }];
  H.priorDebits = [];
  H.claimOk = true;
  H.profile = {
    subscription_tier: "wallet",
    is_acquisition_pro_member: false,
    gateway_products: [],
  };
  H.businessTrace = { success: true, hit: false, contacts: null };
  H.submit = { success: true, jobId: "tf-person-1" };
  vi.mocked(lookupBusinessTrace).mockClear();
  vi.mocked(submitSingleTrace).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("auth", () => {
  it("401s without the cron secret and touches nothing", async () => {
    const res = await run("wrong");
    expect(res.status).toBe(401);
    expect(H.ops).toHaveLength(0);
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
  });
});

describe("a row with no owner name", () => {
  beforeEach(() => {
    H.queuedRows = [{ ...ROW, input_owner_name: null }];
  });

  it("is skipped with a reason, never traced and never charged", async () => {
    // The engine that used to find an owner from an address alone is gone. There
    // is no vendor to ask, so asking one would be inventing work to bill for.
    // MUTATION: delete the blank-owner branch and this goes red -- the row falls
    // through to lookupBusinessTrace with an empty company name.
    const res = await run();
    const body = await res.json();

    expect(lookupBusinessTrace).not.toHaveBeenCalled();
    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
    expect(body.skippedNoOwner).toBe(1);
    expect(finalWrite()).toMatchObject({
      ai_research_status: BLANK_OWNER_SKIP_STATUS,
      status: "no_match",
      is_successful: false,
    });
  });

  it("does not leave the row queued, so the bulk job can finish", async () => {
    // A row parked in 'queued' behind a cron that cannot resolve it holds its
    // parent bulk job open forever. The terminal status is what closes it.
    await run();
    expect(finalWrite().ai_research_status).not.toBe("queued");
    expect(finalWrite().ai_research_status).not.toBe("processing");
    expect(finalWrite().ai_research_claimed_at).toBeNull();
  });

  it("writes nothing money-shaped, so the row stays deletable", async () => {
    // isBilledRow() treats charge / ai_research_charge / property_record as the
    // marks of a receipt. A row we never traced is not a receipt.
    await run();
    for (const paid of ["charge", "ai_research_charge", "tier", "cost"]) {
      expect(Object.keys(finalWrite())).not.toContain(paid);
    }
  });
});

describe("the vendor could not be asked", () => {
  it("charges nothing and re-queues the row for a retry", async () => {
    // L-007. success:false is OUR outage, not the customer's miss, and the two
    // are indistinguishable from outside: both come back with no contacts.
    // MUTATION: gate the charge on `hit` instead of `success` and a FastAppend
    // outage starts billing.
    H.businessTrace = { success: false, hit: false, contacts: null, error: "FastAppend 503" };

    const res = await run();
    const body = await res.json();

    expect(deducts()).toHaveLength(0);
    expect(body.errored).toBe(1);
    expect(body.noMatch).toBe(0);
    // Back on the queue, one rung further up the ladder.
    expect(finalWrite()).toMatchObject({
      ai_research_status: "queued_2",
      ai_research_claimed_at: null,
    });
    // Nothing is settled: the row must not be closed out as a miss.
    expect(finalWrite().status).toBeUndefined();
  });
});

/**
 * The bound. lookupBusinessTrace() never throws, so a lapsed FASTAPPEND_API_KEY
 * or an hour of 503s used to re-queue the same five oldest rows every minute
 * forever, and no newer row was ever claimed. The parent bulk job read 'queued'
 * as pending and never settled either.
 */
describe("the retry ladder", () => {
  beforeEach(() => {
    H.businessTrace = { success: false, hit: false, contacts: null, error: "FastAppend 503" };
  });

  it("climbs one rung per failure while attempts remain", async () => {
    H.queuedRows = [{ ...ROW, ai_research_status: "queued_2" }];
    await run();
    expect(finalWrite().ai_research_status).toBe("queued_3");
  });

  it("claims a retried row on the status it is actually in", async () => {
    // MUTATION: claim with a hardcoded .eq('ai_research_status','queued') and a
    // retried row can never be picked up again -- it sits at queued_2 forever,
    // which is the starvation this ladder exists to end.
    H.queuedRows = [{ ...ROW, ai_research_status: "queued_2" }];
    await run();
    const claim = H.ops.find(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload?.ai_research_status === "processing_2"
    );
    expect(claim).toBeDefined();
    expect(claim!.filters.some((f) => f[0] === "eq" && f[2] === "queued_2")).toBe(true);
  });

  it("gives up on the last attempt and writes the row terminal", async () => {
    // MUTATION: drop the exhausted branch so it re-queues instead, and this goes
    // red -- the row goes back to the front of the claim window and the five
    // oldest rows block every newer row behind them again.
    H.queuedRows = [{ ...ROW, ai_research_status: `queued_${MAX_ENTITY_TRACE_ATTEMPTS}` }];
    const body = await (await run()).json();

    expect(body.exhausted).toBe(1);
    expect(finalWrite()).toMatchObject({
      ai_research_status: ENTITY_TRACE_FAILED_STATUS,
      ai_research_claimed_at: null,
      status: "error",
      is_successful: false,
    });
    // Terminal, so nothing reads it as pending and the bulk job can settle.
    expect(isEntityTracePending(ENTITY_TRACE_FAILED_STATUS)).toBe(false);
  });

  it("charges nothing on the way to terminal, because we never got an answer", async () => {
    // L-007 again, at the end of the ladder rather than the start of it. A
    // vendor we could not reach is our outage for all five tries.
    H.queuedRows = [{ ...ROW, ai_research_status: `queued_${MAX_ENTITY_TRACE_ATTEMPTS}` }];
    await run();
    expect(deducts()).toHaveLength(0);
    for (const paid of ["charge", "ai_research_charge", "tier", "cost"]) {
      expect(Object.keys(finalWrite())).not.toContain(paid);
    }
  });

  it("gives the customer a reason instead of a silent empty row", async () => {
    const reason = skipReasonFor(ENTITY_TRACE_FAILED_STATUS);
    expect(reason).toBeTruthy();
    expect(reason).toContain("not charged");
  });

  it("exhausts a claim that never came back, rather than resetting it", async () => {
    // A row that kills the run every time is exactly as poisonous as one the
    // vendor keeps refusing. Reverting it to attempt 1 would loop forever.
    await run();
    const topRung = H.ops.find(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload?.ai_research_status === ENTITY_TRACE_FAILED_STATUS &&
        o.filters.some(
          (f) => f[0] === "eq" && f[2] === `processing_${MAX_ENTITY_TRACE_ATTEMPTS}`
        )
    );
    expect(topRung).toBeDefined();
    expect(staleFilter(topRung!)).toBeDefined();
  });
});

describe("the vendor answered with a miss", () => {
  it("settles the row free, because a tier 1 miss is not billed", async () => {
    H.businessTrace = { success: true, hit: false, contacts: null };

    const res = await run();
    const body = await res.json();

    expect(deducts()).toHaveLength(0);
    expect(body.noMatch).toBe(1);
    expect(finalWrite()).toMatchObject({
      status: "no_match",
      is_successful: false,
      charge: 0,
      tier: 1,
    });
  });

  it("books no research fee on the way past", async () => {
    // The retired $0.15 fee used to land here the moment an owner was named.
    // MUTATION: restore the research deduct and this goes red.
    H.businessTrace = { success: true, hit: false, contacts: null };
    await run();
    const researchWrite = historyWrites().find((p) => "ai_research_charge" in p);
    expect(researchWrite?.ai_research_charge).toBe(0);
  });
});

describe("the vendor returned contacts", () => {
  beforeEach(() => {
    H.businessTrace = {
      success: true,
      hit: true,
      contacts: {
        ownerName: "Testowner Placeholder",
        phones: [{ number: "5550000101", type: "mobile" }],
        emails: ["principal@example.invalid"],
        mailingAddress: "100 Placeholder Way, Redacted, ZZ, 00000",
      },
    };
  });

  it("charges the caller's tier 1 rate exactly ONCE and nothing else", async () => {
    // The profile here is Pay-As-You-Go, so the tier 1 rate is 0.25. A 0.15
    // deduction could only be the retired research fee, never this rate.
    // MUTATION: add the research deduct back and the length assertion goes red.
    const res = await run();
    const body = await res.json();

    expect(body.fastAppendCredited).toBe(1);
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(deducts().some((d) => d.args.p_amount === 0.15)).toBe(false);
    expect(deducts()[0].args.p_trace_history_id).toBe("row-1");
  });

  it("persists the amount that actually moved, with tier 1 stamped on it", async () => {
    await run();
    expect(finalWrite()).toMatchObject({
      status: "success",
      is_successful: true,
      charge: PRICING.CHARGE_PER_SUCCESS_WALLET,
      tier: 1,
      ai_research_charge: 0,
      phone_count: 1,
      email_count: 1,
    });
  });

  it("skips the Tracerfy person submit, because FastAppend already delivered", async () => {
    await run();
    expect(submitSingleTrace).not.toHaveBeenCalled();
  });

  /**
   * THE RATE FOLLOWS THE TRACK, NOT THE OWNER TYPE.
   *
   * This cron settles the ENTITY rows of a bulk job; the job's own status route
   * settles the PERSON rows. If the two disagree about the rate, one batch bills
   * two prices for the same work, split by owner type -- the exact thing L-005
   * says is impossible, since owner type selects the vendor and never the price.
   *
   * It used to use the grant-aware Track A rate for everything, so a gateway
   * grant holder on the wallet tier running a v1 bulk job paid $0.25 for person
   * rows (raw, Track B, from the v1 status route) and $0.15 for entity rows
   * (grant-aware, from here). Same job, same work, two prices.
   *
   * Both tests run with NEXT_PUBLIC_SUITE_SIGNIN_ENABLED set, because the ONLY
   * thing separating the two tracks is hasSuiteAccess(), which is behind that
   * flag. With the flag off both collapse to `wallet`, both assertions pass
   * under either implementation, and the pair proves nothing. That is L-009,
   * which this build earned twice.
   */
  it("bills a grant holder the GRANT-AWARE rate on a Track A row", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["prop-tracer-pro"],
    };
    // source 'mcp' is Track A, tagged by lib/suite/mcp-tools.ts.
    H.queuedRows = H.queuedRows.map((r) => ({ ...r, source: "mcp" }));
    await run();
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });

  it("bills that same grant holder the RAW rate on a Track B row, matching the v1 person rows", async () => {
    process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED = "true";
    H.profile = {
      subscription_tier: "wallet",
      is_acquisition_pro_member: false,
      gateway_products: ["prop-tracer-pro"],
    };
    // A v1 bulk row carries no source. Untagged is Track B, which is also the
    // dearer derivation, so the fallback errs in the safe direction.
    await run();
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    // The whole point: the same profile, same vendor, two tracks, and the entity
    // row is never cheaper than the person row sitting beside it in the job.
    expect(deducts()[0].args.p_amount).not.toBe(PRICING.CHARGE_PER_SUCCESS);
    delete process.env.NEXT_PUBLIC_SUITE_SIGNIN_ENABLED;
  });
});

/**
 * The double-charge window.
 *
 * deductOrZero moves real money the moment it is called, and the row is only
 * written back AFTERWARDS. Anything that throws in between -- and the catch
 * below hands the row to failRow, which puts it back on the queue -- leaves the
 * wallet lighter with nothing on the row to show for it. The next run re-claims
 * the same row, calls FastAppend again, and deducts again. supabase-js returns
 * errors rather than throwing, so this needs an unusual failure, but nothing
 * made the second charge impossible.
 *
 * WHAT MAKES IT IMPOSSIBLE NOW. `deduct_wallet_balance` writes a
 * wallet_transactions debit carrying the trace_history_id it charged
 * (supabase/schema.sql). That ledger row IS the idempotency marker: it is
 * durable, it is keyed on the row, and it needs no new column. The cron asks for
 * it before deducting and, when one exists, persists the amount that already
 * moved instead of taking a second bite.
 *
 * A non-empty priorDebits here is exactly the state a row is left in by such a
 * throw: charged, requeued, and back in the claim window.
 */
describe("a row that has already been charged", () => {
  beforeEach(() => {
    H.businessTrace = {
      success: true,
      hit: true,
      contacts: {
        ownerName: "Testowner Placeholder",
        phones: [{ number: "5550000101", type: "mobile" }],
        emails: ["principal@example.invalid"],
        mailingAddress: null,
      },
    };
    // Deliberately an amount NO current rate can produce. If the row comes out
    // carrying 0.05 it can only have read the ledger; if it comes out carrying a
    // plan rate it re-derived the price, which is the bug wearing a disguise.
    H.priorDebits = [{ amount: 0.05, type: "debit" }];
  });

  it("cannot be charged a second time by this cron", async () => {
    // MUTATION: delete the prior-debit probe and deduct unconditionally, and
    // this goes red -- the customer pays twice for one row.
    await run();
    expect(deducts()).toHaveLength(0);
  });

  it("persists the amount that already moved, not zero and not a fresh rate", async () => {
    // Zero would tell the customer the row was free while their wallet says
    // otherwise, and re-deriving the rate would restate a past charge at
    // today's price. The ledger holds the only true number.
    await run();
    expect(finalWrite()).toMatchObject({
      status: "success",
      is_successful: true,
      charge: 0.05,
      tier: 1,
    });
  });

  it("asks the ledger about THIS row, not the user's debits in general", async () => {
    // Keyed on trace_history_id. Keyed on user_id it would refuse to charge any
    // second row of a bulk job, which is the opposite failure and just as bad.
    H.priorDebits = [{ amount: 0.05, type: "debit" }];
    await run();
    const probe = H.ops.find((o) => o.table === "wallet_transactions" && o.op === "select");
    expect(probe).toBeDefined();
    expect(
      probe!.filters.some((f) => f[0] === "eq" && f[1] === "trace_history_id" && f[2] === "row-1")
    ).toBe(true);
    // ...and NOT narrowed to debits. The probe used to end `.eq('type','debit')`
    // and that filter is what hid a refund from it: a credit the query never
    // returns cannot be subtracted. `type` is selected and classified in JS now.
    // MUTATION: put the filter back and this goes red.
    expect(probe!.filters.some((f) => f[0] === "eq" && f[1] === "type")).toBe(false);
  });

  it("still charges a row the ledger has never seen", async () => {
    // The guard must not become a blanket refusal to bill. A first attempt on a
    // clean row is the normal case and it still pays.
    H.priorDebits = [];
    await run();
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
  });

  it("still charges a row whose every debit was handed back", async () => {
    // A REFUND IS NOT A COLLECTION. This file never refunds, but its two twins
    // do -- sweep-business-traces and lib/trace/settleBulkJob both hand back a
    // historical research fee -- and they refund rows THIS cron also settles.
    // So a row can reach here having collected a fee and had it returned, and
    // the ledger nets to zero. Zero is not money in our pocket.
    //
    // MUTATION: sum the debits alone in collectedChargeFor, or test `!== null`
    // instead of `> 0` at the call site, and this goes red at zero deducts --
    // the row is delivered free and recorded as having paid $0.05.
    H.priorDebits = [
      { amount: 0.05, type: "debit" },
      { amount: 0.05, type: "credit" },
    ];
    await run();
    expect(deducts()).toHaveLength(1);
    expect(deducts()[0].args.p_amount).toBe(PRICING.CHARGE_PER_SUCCESS_WALLET);
    expect(finalWrite()).toMatchObject({
      charge: PRICING.CHARGE_PER_SUCCESS_WALLET,
      is_successful: true,
    });
  });

  it("does not probe the ledger on a row it is not about to charge", async () => {
    // A miss is free, so there is no charge to be idempotent about and no
    // reason to spend a query on every swept row.
    H.priorDebits = [];
    H.businessTrace = { success: true, hit: false, contacts: null };
    await run();
    expect(H.ops.some((o) => o.table === "wallet_transactions")).toBe(false);
  });
});

describe("the vendor named a principal but gave no contacts", () => {
  beforeEach(() => {
    H.businessTrace = {
      success: true,
      hit: true,
      contacts: {
        ownerName: "Testowner Placeholder",
        phones: [],
        emails: [],
        mailingAddress: null,
      },
    };
  });

  it("settles it free and never asks Tracerfy, because FastAppend IS Tracerfy", async () => {
    // David's ruling, 2026-09-21: "DO NOT send a fastappend contact to Tracerfy. This will
    // produce no new results and waste time. Fastappend is a tracerfy company and if the
    // contact info is not found in Fastappend, it will not be found in Tracerfy either. Even
    // if the contact is found in FastAppend, and that contact has no email or phone, it gets
    // treated as null result and the search is free for tier 1."
    //
    // So a named principal with no phone and no email is a MISS, not a lead to chase. The
    // previous behaviour submitted a second vendor call on a row the first vendor had already
    // failed to deliver, against a database owned by the same company.
    const res = await run();
    const body = await res.json();

    expect(submitSingleTrace).not.toHaveBeenCalled();
    expect(deducts()).toHaveLength(0);
    expect(body.noMatch).toBe(1);
    expect(finalWrite()).toMatchObject({ status: "no_match", is_successful: false, charge: 0 });
  });

  it("never leaves a Tracerfy job id behind for the status poller to chase", async () => {
    // The old path wrote tracerfy_job_id and handed the row to the status endpoint. A row
    // that still carried one would be polled forever against a job nobody submitted.
    await run();
    expect(finalWrite()).not.toHaveProperty("tracerfy_job_id");
  });

  it("keys FastAppend on the company name and the state we hold", async () => {
    await run();
    expect(lookupBusinessTrace).toHaveBeenCalledWith({
      company_name: "Acme Holdings Llc",
      state: "TX",
    });
  });

  it("settles free when the Tracerfy submit itself fails", async () => {
    H.submit = { success: false, jobId: null, error: "Tracerfy 503" };
    const res = await run();
    const body = await res.json();

    expect(deducts()).toHaveLength(0);
    expect(body.noMatch).toBe(1);
    expect(finalWrite()).toMatchObject({ status: "no_match", charge: 0, tier: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * RECEIPTS SURVIVE THIS SWEEP.
 *
 * Every row this cron settles is a REUSED row: UNIQUE(user_id, address_hash)
 * guarantees one per (user, address), and wallet_transactions references it
 * with ON DELETE NO ACTION. Under bulk tier 2 a billed miss looks like
 * `tier = 2, charge > 0, is_successful = false`, and both free-miss arms below
 * target precisely that shape.
 *
 * Writing a flat `charge: 0, tier: 1` over it does two things at once: the row
 * reads unbilled to excludeBilledRows, so the next submit's delete raises 23503
 * and the address 500s forever; and the tier downgrade kills isCacheHitRow's
 * third arm, so the customer re-buys the same absence.
 * ------------------------------------------------------------------ */
describe("a row that already carries a tier 2 receipt", () => {
  beforeEach(() => {
    H.queuedRows = [{ ...ROW, charge: 0.25, tier: 2 }];
  });

  it("site 467 (FastAppend named nobody): keeps the charge and the tier", async () => {
    // A tier 1 miss is free, and free means "collect nothing further", never
    // "declare the row was always free".
    H.businessTrace = { success: true, hit: false, contacts: null };
    await run();

    expect(deducts()).toHaveLength(0);
    // MUTATION: write `charge: 0, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE` flat
    // instead of the folded values and this goes red on both lines.
    expect(finalWrite().charge).toBe(0.25);
    expect(finalWrite().tier).toBe(2);
  });

  it("site 495 (Tracerfy submit failed): keeps the charge and the tier", async () => {
    H.businessTrace = {
      success: true,
      hit: true,
      contacts: {
        ownerName: "Testowner Placeholder",
        phones: [],
        emails: [],
        mailingAddress: null,
      },
    };
    H.submit = { success: false, jobId: null, error: "Tracerfy 503" };
    await run();

    expect(deducts()).toHaveLength(0);
    // MUTATION: same as site 467 -- unfold either value and this goes red.
    expect(finalWrite().charge).toBe(0.25);
    expect(finalWrite().tier).toBe(2);
  });

  /**
   * Site 438 is the SAFE one and it stays raw on purpose. It resolves the
   * amount from the LEDGER (collectedChargeFor) before writing, so folding on
   * top would add the ledger amount to a row that may already carry it and
   * double-count one debit. It is also the arm that ends `is_successful = true`,
   * which is isCacheHitRow's FIRST arm, so the tier stamp costs nothing there.
   * This is the exemption ALLOWED_RAW_WRITES keeps for this file.
   */
  it("site 438 writes the ledger TOTAL raw, and still never downgrades the tier", async () => {
    H.businessTrace = {
      success: true,
      hit: true,
      contacts: {
        ownerName: "Testowner Placeholder",
        phones: [{ number: "5550000101", type: "mobile" }],
        emails: [],
        mailingAddress: null,
      },
    };
    // A CONSISTENT fixture: the row is a billed tier 2 miss ($0.25 collected
    // per record SUBMITTED) and the ledger holds that debit PLUS a $0.25 tier 1
    // contact charge a previous attempt booked before it died. Both are real,
    // and the row has collected $0.50. A fixture whose row and ledger disagree
    // freezes behaviour rather than proving it safe.
    H.priorDebits = [{ amount: 0.25, type: "debit" }, { amount: 0.25, type: "debit" }];
    await run();

    // The ledger TOTAL, written as-is. Folding would give 0.25 + 0.50 = 0.75
    // and invent money -- which is why this site keeps its exemption.
    expect(finalWrite().charge).toBe(0.5);
    // ...but `tier` is not the ledger's to answer. A flat 1 here downgrades a
    // tier 2 receipt, and the exemption was argued for `charge` alone.
    expect(finalWrite().tier).toBe(2);
    expect(finalWrite().is_successful).toBe(true);
  });
});

describe("claiming", () => {
  it("does no work on a row another run already claimed", async () => {
    H.claimOk = false;
    const res = await run();
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(lookupBusinessTrace).not.toHaveBeenCalled();
  });

  it("reverts stale claims before looking for queued rows", async () => {
    // The only way a row killed mid-run is ever retried: the claim query below
    // looks at the queued rungs alone. The revert steps the ladder, so a claim
    // taken at attempt 1 comes back as attempt 2.
    await run();
    const revert = H.ops.find(
      (o) =>
        o.table === "trace_history" &&
        o.op === "update" &&
        o.payload?.ai_research_status === "queued_2" &&
        o.filters.some((f) => f[0] === "eq" && f[2] === "processing")
    );
    expect(revert).toBeDefined();
    expect(staleFilter(revert!)).toBeDefined();
  });

  it("sweeps a claimed row whose claim timestamp is NULL", async () => {
    // SQL `<` never matches NULL, so a row sitting in processing_N with a null
    // ai_research_claimed_at was invisible to BOTH queries: the claim query only
    // looks at the queued rungs, and the stale sweep only looked at claims older
    // than the cutoff. Such a row held its parent bulk job at 'processing'
    // forever with nothing able to touch it. No writer produces that pair today,
    // which is why this was latent rather than live.
    // MUTATION: put the bare .lt() back and this goes red.
    await run();
    const filter = staleFilter(
      H.ops.find(
        (o) =>
          o.table === "trace_history" &&
          o.op === "update" &&
          o.payload?.ai_research_status === "queued_2"
      )!
    );
    expect(filter).toBeDefined();
    expect(String(filter![1])).toContain("ai_research_claimed_at.is.null");
    expect(String(filter![1])).toContain("ai_research_claimed_at.lt.");
  });
});
