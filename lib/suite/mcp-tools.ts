import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { resolvePtpProfile, UNLINKED_MESSAGE } from "@/lib/suite/mcp-shared";
import type { PtpProfile } from "@/lib/suite/mcp-shared";
import { chargePerRecord, chargePerTrace } from "@/lib/suite/pricing";
import { isLikelyBusiness } from "@/lib/trace/ownerClassification";
import { propertyAddressLabel } from "@/lib/trace/historyDisplay";
import { rowSkipReason } from "@/lib/trace/rowSkipReason";
import { isEntityTracePending } from "@/lib/trace/entityTraceAttempts";
import {
  PROPERTY_TRACE_NO_KEY_STATUS,
  isPropertyTracePending,
  queuedStatusFor,
} from "@/lib/trace/propertyTraceAttempts";
import { isRowStillWorking } from "@/lib/trace/finalizeBulkJob";
import { TIER1_OUTCOME } from "@/lib/trace/tier1Outcome";
import { tier1QueuedStatusFor } from "@/lib/trace/tier1Queue";
import { insertHistoryRows } from "@/lib/trace/insertHistoryRows";
import { TIER2_CAPACITY_REFUSAL, inFlightUnbilledCost, tracerfyCanRun } from "@/lib/trace/bulkPreflight";
import { toPublicPropertyRecord } from "@/lib/trace/publicPropertyRecord";
import { resolveOwnerContact } from "@/lib/ai-research/contacts";
import { removeBatchDuplicates, checkDuplicates } from "@/lib/utils/deduplication";
import {
  TRACE_HISTORY_WIDTH,
  createAddressHash,
  storableValue,
  traceKeyFor,
  usableZip,
  validateAddressInput,
} from "@/lib/utils/address-normalizer";
import { settleBulkJob, type TraceHistoryRow } from "@/lib/trace/settleBulkJob";
import type { AddressInput, TraceJob, TraceResult, AIResearchResult } from "@/types";

// ---- wallet_balance ---------------------------------------------------------
export async function walletBalance(admin: SupabaseClient, gatewaySub: string) {
  const profile = await resolvePtpProfile(admin, gatewaySub);
  if (!profile) return UNLINKED_MESSAGE;
  // Today's MCP-attributed spend (source tag added in Task 4); best-effort, 0 if the column/rows absent.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data: todays } = await admin
    .from("trace_history")
    .select("charge")
    .eq("user_id", profile.id)
    .eq("source", "mcp")
    .gte("created_at", since.toISOString());
  const mcpSpendToday = (todays ?? []).reduce(
    (sum: number, r: { charge: number | null }) => sum + (r.charge ?? 0),
    0,
  );
  return { wallet_balance: profile.wallet_balance, mcp_spend_today: mcpSpendToday };
}

// ---- list_traces ------------------------------------------------------------
export const listTracesSchema = z.object({
  limit: z.number().int().optional(),
  since: z.string().optional(), // ISO date; optional lower bound on created_at
});

export async function listTraces(admin: SupabaseClient, gatewaySub: string, raw: unknown) {
  const args = listTracesSchema.parse(raw);
  const profile = await resolvePtpProfile(admin, gatewaySub);
  if (!profile) return UNLINKED_MESSAGE;
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
  // trace_result + ai_research are selected ONLY to derive owner_contact_name below; they are
  // not echoed back. Without them this tool returned input_owner_name (the COMPANY) plus bare
  // phone/email COUNTS, so a caller reviewing past traces could not see who was actually found.
  //
  // property_record + tier ARE echoed back, filtered. They must be named in this select or the
  // columns never arrive and the tool emits null for every row -- a failure indistinguishable
  // from a customer who simply never bought a Full Property Trace. mcp-tools.test.ts projects
  // its stub rows through this exact string so a column dropped here turns the tests red.
  //
  // THE LAST SIX COLUMNS ARE THE ONE TRAP IN THIS SELECT, and it fails SILENTLY.
  // outcome_code and found_by are echoed. The other four are NOT: they are what rowSkipReason
  // needs to answer at all, and they are destructured out below alongside parcel_id_local and
  // county. rowSkipReason gates the Tier 1 sentence on
  // `trace_job_id === null || isTier1QueueRow(ai_research_status)` and answers tier 2 from
  // property_trace_status, and a column missing from this string arrives as `undefined`.
  // `undefined === null` is false and isTier1QueueRow(undefined) is false, so dropping any one
  // of them does not throw and does not blank the payload: it makes EVERY row come back with a
  // blank reason while outcome_code still shows the code, which reads exactly like a customer
  // whose traces all simply succeeded. trace_steps is here because no_match is the only outcome
  // whose sentence is built from the step log rather than being a constant (noMatchReason names
  // the keys that answered), so without it the most common non-success outcome reports a code
  // with no explanation while bulk_status, which selects '*', explains the very same row.
  // Each of the four has its own SELECT FENCE test pinned to it alone.
  let q = admin
    .from("trace_history")
    .select(
      "id, normalized_address, city, state, zip, input_owner_name, status, is_successful, phone_count, email_count, charge, created_at, trace_result, ai_research, property_record, tier, parcel_id_local, county, outcome_code, found_by, ai_research_status, property_trace_status, trace_job_id, trace_steps",
    )
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (args.since) q = q.gte("created_at", args.since);
  const { data, error } = await q;
  if (error) throw new Error(`list_traces failed: ${error.message}`);
  const traces = (data ?? []).map((row) => {
    // property_record is destructured OUT of `rest` on purpose. The filtered key below would
    // win the collision anyway while `...rest` stays FIRST (mutation-verified: leaving it in
    // `rest` turns nothing red), so this is defence in depth rather than the guard -- it means
    // reordering the spread to the end cannot silently promote the raw 86-key object. The
    // actual guard is the filter, and the test that catches the reordering is the one that
    // scans the whole serialized trace for blocked key names.
    //
    // The six columns added below split two ways, and the difference matters.
    //
    // ai_research_status, property_trace_status, trace_job_id and trace_steps are INTERNAL.
    // For them the destructure IS the guard rather than defence in depth: nothing below writes
    // them back, so leaving them in `rest` would hand a gateway caller our queue state and our
    // internal job id. They exist in this scope only to be read by rowSkipReason.
    //
    // outcome_code and found_by ARE echoed, and are destructured only so they can be emitted
    // through `?? null` below. Riding the spread would make a row written before migration
    // 20260922 come back with the keys MISSING rather than null, which is a different answer.
    const {
      trace_result,
      ai_research,
      property_record,
      tier,
      parcel_id_local,
      county,
      ai_research_status,
      property_trace_status,
      trace_job_id,
      trace_steps,
      outcome_code,
      found_by,
      ...rest
    } = row as Record<string, unknown> & {
      trace_result: TraceResult | null;
      ai_research: AIResearchResult | null;
      property_record: unknown;
      tier: number | null;
      parcel_id_local: string | null;
      county: string | null;
      ai_research_status: string | null;
      property_trace_status: string | null;
      trace_job_id: string | null;
      trace_steps: unknown;
      outcome_code: string | null;
      found_by: string | null;
    };
    // THE NAME ONLY, never the source. resolveOwnerContact returns both, and a spread would
    // put the source back in the payload no matter how many other call sites removed it.
    //
    // contact_vendor is deliberately NOT selected here. This tool emits the name and not the
    // source, and the NAME does not depend on the vendor: the vendor only decides what we
    // call the source. Selecting it would add a column that has to be destructured out of
    // `rest` on pain of leaking, to influence a value this tool never returns. The label is
    // read from the column where it is needed, which is trace_history itself.
    const { owner_contact_name } = resolveOwnerContact({ trace_result, ai_research });
    return {
      ...rest,
      // D38: a row keyed on a parcel carries an INTERNAL key in normalized_address. It is never
      // handed to the gateway as the address; the caller gets "Parcel 0123-456, Travis County".
      // Written AFTER the spread on purpose, so it wins over the raw column `rest` still holds.
      normalized_address: propertyAddressLabel({
        normalized_address: rest.normalized_address as string | null,
        parcel_id_local,
        county,
      }),
      owner_contact_name,
      // 65 of the 86 stored keys. The other 21 are provably wrong, not merely missing, and this
      // payload is one the Suite Gateway maps into a customer's own CRM.
      property_record: toPublicPropertyRecord(property_record),
      // Null on a tier 1 row and on every row written before migration 20260917. Never 0, never
      // a guess: an unknown tier is an absence.
      tier: tier ?? null,
      // THE OUTCOME, matching what bulk_status reports for the same row. found_by is the KEY
      // that found the owner ('address', 'parcel_id', 'company_name'), never the vendor.
      // Emitted explicitly rather than left to ride the spread, so a row written before
      // migration 20260922 reads as null rather than as a missing key.
      found_by: found_by ?? null,
      outcome_code: outcome_code ?? null,
      // The sentence behind the code, asked of BOTH queues. Built from the four columns
      // destructured out above; see the select string for why dropping one of them is silent.
      skip_reason: rowSkipReason({
        outcome_code,
        trace_steps,
        is_successful: rest.is_successful as boolean | null,
        // THE RAW COLUMN, not the friendly label written into the payload above. A parcel-keyed
        // row holds `APN|...` here and streetOf() reads that prefix to decide the row has no
        // street; handing it "Parcel 0123-456, Travis County" would make it look like one, and
        // a no_lookup_key row would then name the wrong missing field.
        normalized_address: rest.normalized_address as string | null,
        city: rest.city as string | null,
        state: rest.state as string | null,
        parcel_id_local,
        county,
        ai_research_status,
        property_trace_status,
        trace_job_id,
      }),
    };
  });
  return { traces };
}

// ---- skip_trace_quote (free) -------------------------------------------------
export const MAX_RECORDS = 500;

export const recordSchema = z.object({
  owner_name: z.string().optional(),
  address: z.string(),
  /** OPTIONAL as of 2026-09-25, and THIS is what was blocking the Suite Gateway.
   *
   *  It was `z.string()`, so a parcel-keyed request -- parcel id, county and state, which is
   *  exactly what the gateway sends for an APN-bearing parcel -- was refused by Zod before
   *  skipTraceBulk ran a line. No guard inside could ever be reached, so no amount of per-record
   *  judging downstream could have helped: the call failed at the door.
   *
   *  Nothing needs a city. D4: a company traces on its name and state alone. The dossier's second
   *  lookup key is `apn` + `county` + `state` (see below), which has no city term at all. And
   *  where a situs address IS the key, the routing gates on hasSitus (lib/routing/ownerRoute.ts:346),
   *  which requires street AND city AND state TOGETHER -- so making this field optional cannot let a
   *  partial address be sent as a situs key: the route simply does not take that branch.
   *
   *  Same reasoning as `zip` below, one field over: requiring a field nothing downstream reads
   *  rejects records at the door for no gain. A record that genuinely has no lookup key at all is
   *  filed no-key, free, with a reason, per record -- it no longer takes the batch with it. */
  city: z.string().optional(),
  state: z.string(),
  // OPTIONAL as of 2026-09-04. ZIP never reached either vendor -- the Tracerfy person CSV has
  // no zip column and FastAppend takes business_name + state -- while rejecting whole batches
  // at the door, since skipTraceBulk fails the batch if any one record is invalid. The
  // property-registry supplies a city for 804 counties and a ZIP for only 766, so requiring it
  // made 241 counties / 16,062,225 parcels untraceable for a field nothing downstream reads.
  // Still validated by validateAddressInput when supplied; absent is fine, wrong is not.
  zip: z.string().optional(),
  /** The dossier's SECOND lookup key, with county and state. Optional: every caller before
   *  the Suite Gateway sent an address only, and address mode stays the proven key. The two
   *  keys fail INDEPENDENTLY (Napa hit on APN and missed on address; Salt Lake did the
   *  reverse), so supplying this adds a second attempt rather than replacing the first, and
   *  a dossier miss is free at the vendor so the extra attempt costs nothing unless it works. */
  apn: z.string().optional(),
  /** Bare county name for the APN key. Tracerfy wants "Stark", never "Stark County". */
  county: z.string().optional(),
});
export type TraceRecord = z.infer<typeof recordSchema>;

export const quoteSchema = z.object({ records: z.array(recordSchema).min(1) });

/** SINGLE SOURCE OF TRUTH for the person/entity split (closes ledger M7). A record is an ENTITY
 *  when it has no usable owner_name (empty/whitespace/absent) OR the classifier calls that name a
 *  business. This is the EXACT negation of skipTraceBulk's person condition
 *  (`owner && !isLikelyBusiness(owner)`, where `owner = (owner_name || "").trim()`), so the
 *  worst-case wallet gate and the submit split can NEVER disagree on how a record is priced vs
 *  routed. The split selects the ROUTE, not the rate: a named entity goes to FastAppend, a person
 *  goes straight to Tracerfy, and a settled success on either route bills the same tier 1 rate
 *  (grant-aware chargePerTrace: CHARGE_PER_SUCCESS for a grant-holder, CHARGE_PER_SUCCESS_WALLET
 *  otherwise). An address-only record with no owner_name is NOT a person, so it lands here too --
 *  but it has no vendor at all, which is what isBlankOwnerRecord below separates out. */
export function isEntityRecord(owner_name?: string): boolean {
  const owner = (owner_name || "").trim();
  return !owner || isLikelyBusiness(owner);
}

/** A record that arrived with no owner of record at all. It is a strict subset of isEntityRecord:
 *  every blank-owner record is a non-person, but not every non-person is blank. It matters because
 *  it selects a different TIER, and therefore a different billing model. A record with an owner is
 *  tier 1, charged per SUCCESSFUL trace and free on a miss. A record without one is tier 2: a
 *  Tracerfy dossier buys the county property record and names the owner, then one contact lookup
 *  resolves them, and it is charged per RECORD SUBMITTED whether or not anything is found.
 *
 *  It used to mean "free", because the engine that finds an owner from an address alone had been
 *  removed and the record was skipped instead of traced. Phase 5c built that engine. Keep this as
 *  the one test, so the quote, the wallet gate and the submit split cannot disagree about which
 *  records are priced which way. */
export function isBlankOwnerRecord(owner_name?: string): boolean {
  return (owner_name || "").trim().length === 0;
}

/** Worst-case pre-flight cost, in dollars, for the caller's own plan.
 *
 *  THE MODEL THIS RESERVES FOR. Every record that has an owner of record is tier 1: charged per
 *  SUCCESSFUL trace, free on a miss. Owner type picks the vendor and never the price, so a
 *  FastAppend business trace on an LLC and a Tracerfy trace on a person reserve the identical
 *  amount. The $0.15 AI research fee that used to be added on top of every entity record is gone
 *  with the engine that charged it, so there is no per-entity surcharge to reserve any more.
 *
 *  A BLANK-OWNER RECORD NOW RESERVES THE TIER 2 PER-RECORD RATE. It used to reserve nothing,
 *  because this surface had no tier 2 route and the record was skipped rather than traced. Phase 5c
 *  wired that route, so the record is submitted, queued and BILLED, and a gate that still reserved
 *  nothing for it would let a caller commit to a batch their wallet cannot cover. Note the model
 *  difference: tier 2 is not a worst case at all, it is simply the price, because it is owed per
 *  record submitted rather than per success.
 *
 *  `persons`, `entities` and `blanks` are DOLLARS, not counts. This stays at or above what
 *  app/api/v1/trace/bulk/route.ts reserves for the same batch; mcp-tools.test.ts fences that. */
export function worstCaseCost(records: TraceRecord[], profile: PtpProfile) {
  const tier1Rate = chargePerTrace(profile);
  const tier2Rate = chargePerRecord(profile);
  let persons = 0;
  let entities = 0;
  let blanks = 0;
  for (const r of records) {
    if (isBlankOwnerRecord(r.owner_name)) blanks += tier2Rate;
    else if (isEntityRecord(r.owner_name)) entities += tier1Rate;
    else persons += tier1Rate;
  }
  return { persons, entities, blanks, total: persons + entities + blanks };
}

/** Free, mandatory first step before any paid trace: dedups, splits person vs entity, and returns
 *  the worst-case cost + current wallet balance + whether the list exceeds the 500-record cap.
 *  NOTE: the live `removeBatchDuplicates` returns `{ unique, internalDuplicates }`, not the bare
 *  array the brief assumed (`(records) => records`); adapted here. `internalDuplicates` is used
 *  directly instead of re-deriving it from `records.length - unique.length`. */
export async function skipTraceQuote(admin: SupabaseClient, gatewaySub: string, raw: unknown) {
  const { records } = quoteSchema.parse(raw);
  const profile = await resolvePtpProfile(admin, gatewaySub);
  if (!profile) return UNLINKED_MESSAGE;
  // `city` became OPTIONAL on recordSchema in Phase 2B, so it can now arrive absent here, and
  // removeBatchDuplicates takes AddressInput, which declares it required. An absent key and an
  // empty one say the identical thing -- the caller gave us no city -- and traceKeyFor already
  // guards it with `?? ''` internally. This normalisation is the minimum that keeps the QUOTE
  // callable for the parcel-keyed record the SUBMIT now accepts; the quote is the mandatory first
  // step, so a shape the submit takes and the quote throws on would be no unblock at all.
  const { unique, internalDuplicates } = removeBatchDuplicates(
    records.map((record) => ({ ...record, city: record.city ?? "" })),
  );
  // THE SUBMIT'S OWN SPLIT, ASKED IN THE SUBMIT'S OWN ORDER, so the two surfaces cannot drift
  // again. skipTraceBulk asks exactly these two questions: a record with an owner of record is
  // tier 1, and a BLANK-owner record is tier 2 only if validateAddressInput says a vendor can be
  // asked about it at all. Otherwise it is no-key: terminal at submit, FREE, and never traced.
  //
  // `validateAddressInput` used to appear NOWHERE in this function, and that was the bug. This
  // quote counted every blank-owner record as a full property trace, so it told the caller that a
  // record with no owner AND no usable address WILL run and WILL be billed, about a record that
  // does neither. The tool description tells the caller to show that count to the user beside the
  // words "those records are billed whether or not anything is found", so the falsehood was
  // repeated to the user in the one place that exists to tell them what a batch will cost.
  //
  // It only became observable in Phase 2B: before it, the submit refused the whole batch over such
  // a record, so no submit ever accepted one to contradict the quote.
  //
  // NO ZIP ARGUMENT, matching the submit exactly. A malformed ZIP must never make a row unlookable.
  const tier1Records = unique.filter((r) => !isBlankOwnerRecord(r.owner_name));
  const blankOwnerRecords = unique.filter((r) => isBlankOwnerRecord(r.owner_name));
  const tier2Records = blankOwnerRecords.filter(
    (r) => validateAddressInput(r.address, r.city, r.state).valid,
  );
  const billableRecords = [...tier1Records, ...tier2Records];
  // PRICED OVER THE RECORDS THAT WILL ACTUALLY RUN, which is the same set skipTraceBulk reserves
  // from, through the same one price derivation. A no-key record is in neither term, because
  // nobody is ever asked about it and nothing is ever charged for it.
  //
  // LOWERING A NUMBER NAMED AS A CEILING IS SAFE HERE, AND THE REASON IS STRUCTURAL RATHER THAN A
  // MATTER OF JUDGEMENT. This value feeds no gate: it is returned to the caller and nothing reads
  // it back. The money gate is skipTraceBulk's own, computed independently from its own
  // billableRecords. And this quote can never promise LESS than that gate reserves, because
  // EXACTLY TWO mechanisms separate the two sets and both run one way:
  //
  //   1. DEDUP. This function drops internal batch duplicates only; the submit drops those AND
  //      90-day history duplicates, so its set is a subset of this one.
  //   2. THE WIDTH CLAMP. The submit passes every record through storableValue for the four
  //      constrained columns BEFORE it classifies, and this function classifies the raw record.
  //      A clamp can only empty a value, never lengthen one, so it can only move a record from
  //      billable to no-key -- never the reverse -- and in the key it can only collapse two
  //      records into one, never split one into two.
  //
  // Both directions therefore subtract, so quoted >= committed for every record shape, not merely
  // for the ones anyone has tried. The one observable consequence is a blank-owner record whose
  // city exceeds VARCHAR(100): this quote prices it tier 2 and the submit files it no-key and free.
  // That over-states, which is the safe direction. Both are pinned by tests in skip_trace_quote,
  // including one where history dedup drops a record so the inequality is STRICT rather than an
  // equality dressed as a proof.
  const cost = worstCaseCost(billableRecords, profile);
  const entities = tier1Records.filter((r) => isEntityRecord(r.owner_name)).length;
  return {
    submitted: records.length,
    after_dedup: unique.length,
    duplicates_removed: internalDuplicates,
    // Derived from the TIER 1 set, never by subtracting the tier 2 count from the total. Narrowing
    // the blank-owner bucket above without narrowing the subtrahend would quietly reclassify a
    // record with no owner name at all as a person, which is a worse falsehood than the one this
    // change removes. Same arithmetic the submit uses for the same two keys.
    persons: tier1Records.length - entities,
    entities,
    // Records with no owner of record THAT A VENDOR CAN BE ASKED ABOUT. They run a Full Property
    // Trace, which is charged per RECORD SUBMITTED rather than per successful trace, so they carry
    // the tier 2 share of worst_case_cost. The key is named for what happens to them rather than
    // what does not: it replaced `skipped`, which said they were free, and that stopped being true
    // in phase 5c.
    //
    // A blank-owner record with no usable address is in NO count here. That is an omission, and a
    // deliberate one: reporting it needs a new key, which is a payload addition and a separate
    // decision. Saying nothing about a record is honest; saying it will be traced and billed is
    // not, and that is what this used to do.
    full_property_trace: tier2Records.length,
    worst_case_cost: Number(cost.total.toFixed(2)),
    wallet_balance: profile.wallet_balance,
    over_cap: unique.length > MAX_RECORDS,
    max_records_per_call: MAX_RECORDS,
  };
}

// ---- skip_trace_bulk (guarded submit) ---------------------------------------
//
// SUBMITS a bulk skip-trace job. It moves NO money itself: the wallet gate here
// is a worst-case pre-flight only. Real spend happens later, at poll time, in
// bulk_status -> settleBulkJob. The submit orchestration mirrors the live
// app/api/v1/trace/bulk/route.ts (the source of truth) with exactly three
// deliberate differences: the source:'mcp' tag, the grant-aware tier 1 rate
// inside worstCaseCost, and the confirm + MAX_RECORDS guards. The gate's SHAPE
// is the v1 route's shape (every traceable record at the tier 1 rate, and
// nothing for a record that cannot be traced), so it can never reserve less
// than the route does. Everything else (dedup, the split, the insert shapes,
// the Tier 1 enqueue for sweep-entity-traces) is the route's behavior, reused.
//
// THERE IS NO TRACERFY PERSON CSV HERE ANY MORE (Phase 2B, spec 3.3). Every record with an owner
// of record is enqueued onto the Tier 1 queue for app/api/cron/sweep-entity-traces, which plans
// and runs the route per record. That is what lets a city-less or parcel-keyed record trace at
// all: the CSV took a street, a city and a state and nothing else. With the CSV goes the only
// thing that could fail at submit besides the row write, so THE ROW WRITE IS THE SUBMIT, and it
// throws rather than being logged past (lib/trace/insertHistoryRows.ts).

export const bulkSchema = z.object({
  records: z.array(recordSchema).min(1),
  confirm: z.boolean().optional(),
});

export async function skipTraceBulk(admin: SupabaseClient, gatewaySub: string, raw: unknown) {
  const { records, confirm } = bulkSchema.parse(raw);
  const profile = await resolvePtpProfile(admin, gatewaySub);
  if (!profile) return UNLINKED_MESSAGE;

  // Guard 1 (confirm gate): never submit or spend without an explicit confirm.
  if (confirm !== true) {
    return {
      error: "confirm_required",
      message: "Run skip_trace_quote first, then call again with confirm: true.",
    };
  }

  // Guard 2 (cap): the MCP caps a single call at MAX_RECORDS (500).
  if (records.length > MAX_RECORDS) {
    return {
      error: "over_cap",
      message: `Split into batches of at most ${MAX_RECORDS} records.`,
      max_records_per_call: MAX_RECORDS,
    };
  }

  // A VALUE THE COLUMN CANNOT HOLD IS NORMALISED FIRST, AND THE PLACEMENT IS LOAD-BEARING.
  //
  // `trace_history.state` is VARCHAR(2) (supabase/schema.sql:69), `city` is VARCHAR(100), and
  // `parcel_id_local` / `county` are VARCHAR(64). Records are judged one at a time below, so a
  // record carrying "Texas" instead of "TX" would reach the insert as "TEXAS": Postgres raises
  // 22001, the batch write throws, and the WHOLE BATCH dies on one routine integrator typo. That
  // is whole-batch rejection through a different door, in the change whose purpose is deleting it.
  // Until now this surface was protected from it only by the whole-batch refusal below, which is
  // gone. storableValue() treats an unstorable value as ABSENT rather than truncating it, because
  // "Te" would be a state the caller never sent; see its docblock for the argument and for why it
  // measures the TRIMMED value ('  tx  ' is six characters and two letters).
  //
  // BEFORE THE DUPLICATE KEY IS DERIVED, NEVER AT THE ROW WRITE (spec 6.3, D36).
  // removeBatchDuplicates on the next line, checkDuplicates after it, and buildHistoryRow below
  // must all see ONE value. Clamping at the write instead would store '' while the dedup hash
  // still said 'TEXAS', which is the divergence this task exists to close.
  //
  // THESE FOUR ARE EVERY CONSTRAINED COLUMN THIS SURFACE WRITES. There is no `address` column: the
  // street goes into `normalized_address`, which is TEXT, as is `input_owner_name`. `zip` is
  // VARCHAR(10) and is clamped at the row write by usableZip, which is the same rule with a shape
  // check on top. `address_hash` is a 64-character digest in a VARCHAR(64), and both queue values
  // and `status` are constants inside their columns' widths.
  const submitted: AddressInput[] = records.map((record) => ({
    ...record,
    city: storableValue(record.city, TRACE_HISTORY_WIDTH.city),
    state: storableValue(record.state, TRACE_HISTORY_WIDTH.state),
    // The two parcel-key columns. An unstorable one drops the APN branch of traceKeyFor rather
    // than the whole row: the record keys on its address instead, exactly as one that never sent
    // a parcel id does.
    apn: storableValue(record.apn, TRACE_HISTORY_WIDTH.parcelIdLocal),
    county: storableValue(record.county, TRACE_HISTORY_WIDTH.county),
  }));

  // Dedup: internal batch dupes, then the 90-day history window. Reuses the
  // exact primitives the v1 route uses (checkDuplicates runs its own
  // cookie-scoped server client, same as the route's API-key context).
  const { unique } = removeBatchDuplicates(submitted);
  const { newRecords, cachedResults } = await checkDuplicates(profile.id, unique);
  const duplicatesRemoved = records.length - newRecords.length;

  if (newRecords.length === 0) {
    return {
      job_id: null,
      accepted: 0,
      duplicates_removed: duplicatesRemoved,
      // PRESENT HERE TOO, or the claim the main response makes about this key is false on exactly
      // one path. A caller branching on it would get undefined from the one response that is
      // otherwise the simplest to handle. Nothing reached the split on this path, so nothing
      // lacked a lookup key. See the main return for why the key is named this.
      no_lookup_key: 0,
      message: "All records are duplicates of previous traces.",
    };
  }

  // THE SPLIT IS BINARY ON THE OWNER NAME NOW, and the person/entity classifier MOVED (spec 4.1,
  // D1). There are three buckets but only one question decides the first two:
  //
  //   tier 1      an owner of record is present. ENQUEUED onto `ai_research_status` for
  //               app/api/cron/sweep-entity-traces, which runs planRoute() and executeRoute() per
  //               record. Billed per SUCCESSFUL trace, free on a miss.
  //   tier 2      no owner of record, but an address a vendor can be asked about. Queued onto
  //               `property_trace_status` for app/api/cron/sweep-property-traces, billed per
  //               RECORD SUBMITTED, so it is owed whether or not the county has a parcel there.
  //   no key      no owner of record AND no usable address. Nobody can be asked, so it is
  //               terminal and free.
  //
  // THERE IS NO PERSON-VERSUS-ENTITY SPLIT AT SUBMIT ANY MORE. planRoute() decides inside the cron
  // whether a record is a person, a company or a trust, and it decides from the whole row rather
  // than from the name alone. isEntityRecord still exists and still prices the batch, and it still
  // reports the two counts in the payload below, but it no longer selects a route here.
  //
  // THE TWO QUEUES ARE SEPARATE COLUMNS AND A ROW BELONGS TO EXACTLY ONE. `ai_research_status`
  // settles tier 1, where a miss is FREE. `property_trace_status` settles tier 2, where a miss is
  // BILLED. A row on both would be settled twice, by two engines, under two billing models.
  //
  // A TIER 1 RECORD IS NEVER NO-KEY AT SUBMIT. A company traces on name and state alone (D4), and
  // a person with no lookup key settles `no_lookup_key` free, with a sentence, inside the cron.
  // The no-key bucket is only ever reachable from a BLANK owner whose address cannot be sent
  // anywhere, which is why the usability question is asked in that branch and nowhere else.
  const tier1Records: AddressInput[] = [];
  const tier2Records: AddressInput[] = [];
  const noKeyRecords: AddressInput[] = [];
  for (const record of newRecords) {
    if (!isBlankOwnerRecord(record.owner_name)) {
      tier1Records.push(record);
      continue;
    }
    // NO ZIP ARGUMENT, AND ITS ABSENCE IS THE POINT. This asks one question: can a vendor be asked
    // about this row at all. validateAddressInput also carries a ZIP rule, and joining that rule
    // to this question would file rows with a perfectly good street, city and state as no-key over
    // a ZIP Excel had stripped a leading zero from, then lock them out of a resend for 90 days,
    // because the dedup key excludes the ZIP so a corrected resend hashes identically. That is
    // every MA, NJ, CT, RI, NH, ME, VT and PR county file, wholesale. A malformed ZIP is dropped
    // at the row write by usableZip instead, and PROPERTY_TRACE_NO_KEY_STATUS is reserved for a
    // row genuinely missing something the lookup needs.
    const usable = validateAddressInput(record.address, record.city, record.state);
    if (usable.valid) tier2Records.push(record);
    else noKeyRecords.push(record);
  }

  // The rows a vendor is actually asked about, and therefore the rows that can be billed. Used
  // three times and it has to be the same number every time: it is what the wallet reserve is
  // quoted on, what the job row claims was submitted, and what the caller is told is running. A
  // no-key row is excluded, because nobody is ever asked about it and nothing is ever charged.
  const billableRecords = [...tier1Records, ...tier2Records];

  // Guard 3 (can PTP EXECUTE?): the Tracerfy credit pool is SHARED across every customer's
  // jobs, so this is sized against what is already queued as well as what is being asked for.
  // Asked BEFORE the wallet gate below, so a caller is never told to add funds for a job PTP
  // could not have run: their wallet is fine, ours is what is short. Silent by David's decision
  // of 2026-09-18 -- PTP has no alerting channel and he chose no alert over a fake one -- so
  // nothing here claims anyone was told.
  //
  // THE TIER 1 COUNT IS REAL NOW, and it used to be a true 0: this surface posted its tier 1
  // records to the Tracerfy BATCH endpoint, a different credit bucket from the per-record instant
  // lookups this check sizes. They are on the queue as of Phase 2B, so they draw on the same pool
  // as every other per-record lookup and a batch of 500 named records can exhaust it.
  if (
    !(await tracerfyCanRun(admin, { tier1: tier1Records.length, tier2: tier2Records.length }))
  ) {
    return { error: "capacity_unavailable", message: TIER2_CAPACITY_REFUSAL };
  }

  // Guard 4 (money fence): worst-case pre-flight, using the SAME formula the v1
  // route uses -- every owned record at the tier 1 per-success rate, plus every
  // blank-owner record at the tier 2 per-record rate. The only difference from v1
  // is that both rates here are grant-aware, and those are also the rates this
  // surface settles at. Nothing is submitted or charged when the wallet cannot
  // cover it.
  //
  // Sized against IN-FLIGHT UNBILLED WORK too. This was a bare comparison that
  // reserved nothing: the real debit lands per record at settle time, so two
  // batches submitted back to back both passed against the same dollars.
  // QUOTED ON THE BILLABLE RECORDS, NOT ON EVERY RECORD. It used to be quoted on `newRecords`,
  // which was the same set: a record with no owner and no usable address was refused by the
  // whole-batch check below, so it never reached this line. It does now, and worstCaseCost prices
  // a blank-owner record at the tier 2 rate -- so quoting the whole set would reserve money for a
  // row nobody is ever asked about, and report that charge to the caller as committed.
  //
  // ONE derivation still (lib/suite/pricing.ts, via worstCaseCost): the same function, handed the
  // set that can actually be billed. This is exactly what app/api/v1/trace/bulk/route.ts reserves
  // for the same batch, so this gate still cannot reserve less than the route does.
  const worstCase = worstCaseCost(billableRecords, profile);
  const worst = worstCase.total;
  const inFlight = await inFlightUnbilledCost(admin, profile.id, {
    tier1: chargePerTrace(profile),
    tier2: chargePerRecord(profile),
  });
  if (profile.wallet_balance < worst + inFlight) {
    return {
      error: "insufficient_balance",
      worst_case_cost: Number(worst.toFixed(2)),
      in_flight_cost: Number(inFlight.toFixed(2)),
      wallet_balance: profile.wallet_balance,
      message:
        inFlight > 0
          ? `This batch could cost up to $${worst.toFixed(2)}, and you have another $${inFlight.toFixed(2)} of traces already running that have not been billed yet. Your wallet holds $${profile.wallet_balance.toFixed(2)}. Add funds and send it again.`
          : `This batch could cost up to $${worst.toFixed(2)} but your wallet holds $${profile.wallet_balance.toFixed(2)}. Add funds and send it again.`,
    };
  }

  // THERE IS NO WHOLE-BATCH VALIDATION HERE ANY MORE, AND ITS REMOVAL IS THE POINT.
  //
  // Until Phase 2B one bad record returned `invalid_records` and NOTHING in the batch ran. Three
  // things made that indefensible. It judged the ZIP, and Excel strips the leading zero from a ZIP
  // column on export, so a single '2139' killed a 500-record file: every MA, NJ, CT, RI, NH, ME,
  // VT and PR county file arrives that way, wholesale. It judged a city-less row as unusable when
  // a company traces on name and state alone (D4) and the dossier's parcel key has no city term at
  // all. And it is the reason `city` was a required Zod field: the schema comment on `zip` records
  // that it was made optional "while rejecting whole batches at the door, since skipTraceBulk
  // fails the batch if any one record is invalid."
  //
  // Each record is judged on its own above instead: an owner name makes it Tier 1, a blank owner
  // with a usable address makes it tier 2, and only a record no vendor can be asked about at all
  // is filed no-key, free, with a reason. A malformed ZIP is dropped at the row write by usableZip
  // rather than allowed to veto its own row.

  // Create the trace_jobs row, tagged source:'mcp'.
  const { data: jobRow, error: jobError } = await admin
    .from("trace_jobs")
    .insert({
      user_id: profile.id,
      file_name: "MCP bulk submit",
      total_records: records.length,
      dedupe_removed: duplicatesRemoved,
      // Only the rows a vendor is actually asked about, which is the same meaning both bulk REST
      // routes write here. This column is the DENOMINATOR of the match rate: bulk_status reports
      // it and the history page divides records_matched by it.
      //
      // As of phase 5c that INCLUDES the queued tier 2 rows, which are billed per record
      // submitted, so leaving them out would understate the work the customer paid for. As of
      // Phase 2B it EXCLUDES the no-key rows, which are terminal and free at submit: nobody is
      // ever asked about them, so counting them would overstate the work and drag the match rate
      // down by exactly that many rows.
      records_submitted: billableRecords.length,
      records_matched: 0,
      status: "processing",
      source: "mcp",
    })
    .select()
    .single();

  const job = jobRow as { id: string } | null;
  if (jobError || !job) {
    return { error: "job_create_failed", message: jobError?.message || "Failed to create trace job." };
  }

  /**
   * Rows this submit is RESUMING rather than starting: the ones whose stored outcome is
   * busy_try_again (spec 5.2).
   *
   * checkDuplicates lets a busy row through as a new record rather than a duplicate, because its
   * own sentence told the customer to send it again. Its step log is the money: it is what stops
   * executeRoute re-buying the lookups this record already paid for. So the D33 clear below skips
   * these rows, and ONLY these rows.
   *
   * ON THIS SURFACE THE SET IS EMPTY IN PRACTICE TODAY, and it is still written. checkDuplicates
   * opens a COOKIE-SCOPED client and a gateway call carries no cookie, so it sees nothing here and
   * returns no cachedResults -- its own docblock records that as a known defect. Coding the
   * exemption as though that were permanent would make the day someone fixes the client the day a
   * resend silently wipes the paid step log it was told to send again.
   */
  const busyResumeHashes = new Set(
    (cachedResults ?? [])
      .filter((r) => r.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN)
      .map((r) => r.address_hash),
  );

  // Per-record pending trace_history row, tagged source:'mcp' and linked to the
  // bulk job via trace_job_id so bulk_status + the cron aggregate per-record.
  const buildHistoryRow = (record: AddressInput) => {
    // ONE KEY DERIVATION (spec 6.3, D36), the same one the single routes and
    // lib/utils/deduplication.ts use, so a record sent through single and bulk lands on ONE row.
    //
    // IT HAD TO MOVE IN THE SAME CHANGE AS THE VALIDATION ABOVE. checkDuplicates and
    // removeBatchDuplicates already hash with traceKeyFor while this builder stored plain
    // normalizeAddress. The two agree on every record carrying a street AND a city, which is
    // exactly what the whole-batch refusal used to guarantee. Without it a parcel-keyed record
    // reaches here, and then dedup looks for `APN|R-123|TRAVIS|TX` while the row is stored under
    // `||TX`: the same record sent through single and through bulk lands on two rows, and every
    // street-less parcel in one batch collides on one of them.
    //
    // The `|| ''` guards are for the shapes that reach here now rather than a substitute for
    // validation: a no-key row is missing one of the three by definition, and a parcel-keyed row
    // has neither street nor city.
    const normalizedAddress = traceKeyFor({
      address: record.address || "",
      city: record.city || "",
      state: record.state || "",
      apn: record.apn,
      county: record.county,
    });
    const addressHash = createAddressHash(normalizedAddress);
    return {
      user_id: profile.id,
      trace_job_id: job.id,
      address_hash: addressHash,
      normalized_address: normalizedAddress,
      city: (record.city || "").toUpperCase(),
      state: (record.state || "").toUpperCase(),
      // ONLY WHEN IT IS A ZIP, and this is the other half of dropping the ZIP from the usability
      // question above. The row is allowed through, and the mangled number is NOT carried into a
      // dossier call it would contradict: usableZip() records why sending a wrong zip is worse than
      // sending none, and tier 2 bills per record submitted, so a miss we caused with our own
      // mangled input is a miss the customer pays for. The old `.substring(0, 5)` was survivable
      // only while the whole-batch check refused a malformed ZIP outright; it would now store
      // '2139' and send it to a vendor.
      zip: usableZip(record.zip),
      input_owner_name: record.owner_name || null,
      // D23: the parcel id and county exactly as the caller sent them, beside the key built from
      // them (spec 6.3). Stored since before Phase 2A and read by nothing on the Tier 1 lane,
      // because rows from this surface never wore a tier1_ status; the enqueue below is what puts
      // them within reach of the cron's own parcelForTier1Row.
      parcel_id_local: record.apn?.trim() || null,
      county: record.county?.trim() || null,
      // BOTH QUEUE COLUMNS ARE WRITTEN ON EVERY ROW, NULL INCLUDED, and the three call sites below
      // spread their own value over the one they own. The upsert touches only the keys in this
      // payload and the row is REUSED rather than re-inserted (UNIQUE(user_id, address_hash)), so
      // an omitted key leaves whatever the row already carried. A stale tier 2 terminal value on a
      // tier 1 row is served to the customer by rowSkipReason(), which asks tier 2 FIRST, so a
      // successful tier 1 trace would say "you were charged for it, because a full property trace
      // is charged for every record you send" on a row billed per successful trace. A stale
      // 'queued' in either column is worse: one row on two queues, settled twice by two engines
      // under two billing models.
      ai_research_status: null,
      property_trace_status: null,
      // `status` is NOT defaulted here. All three call sites below state their own, and a default
      // that every one of them overrides is a value no reader can trust: it would read as the
      // answer for a fourth bucket that does not exist.
      source: "mcp",
      // THE D33 BULK HALF (carried item 5). A row is REUSED, and a bulk submit never used to clear
      // the Tier 1 answer on it, so a sentence written for an earlier trace could answer for this
      // one: "You were not charged" over a row this job is about to charge. D33 chose to gate the
      // sentence on trace_job_id instead and recorded this half as Phase 2 code.
      //
      // NOT on a busy resume: that row's step log is what spares the resend from buying its
      // answered lookups again.
      //
      // DISCLOSED COST, and it is D33's own trade. This clear runs on EVERY reused row. A row that
      // already holds PAID contacts from an earlier single trace loses its `found_by` label here.
      // It keeps the contacts, the charge and the counts (D39 protects those inside the settle), so
      // nothing the customer bought is lost -- but between submit and settle the `found_by` cell is
      // empty on a row holding real, paid-for numbers. The alternative is a stale sentence from an
      // earlier trace answering for this one, which is a row saying "You were not charged" over
      // work this job is about to charge for. Blank, never wrong (CLAUDE.md rule 7).
      ...(busyResumeHashes.has(addressHash)
        ? {}
        : { outcome_code: null, found_by: null, trace_steps: null }),
    };
  };

  try {
    // ROWS NOBODY CAN BE ASKED ABOUT LAND ALREADY FINISHED. No tracerfy_job_id and no queue rung,
    // so neither bulk_status nor either cron ever picks them up, and nothing money-shaped is
    // written: no charge, no ai_research_charge, no tier, because nothing was billed and nothing
    // was spent. The reason reaches the caller through bulk_status's per-record `skip_reason`,
    // which rowSkipReason() already serves for this status.
    if (noKeyRecords.length > 0) {
      await insertHistoryRows(
        admin,
        noKeyRecords.map((r) => ({
          ...buildHistoryRow(r),
          property_trace_status: PROPERTY_TRACE_NO_KEY_STATUS,
          status: "no_match" as const,
          // Written for the same reason as the two queued writes below: this row is terminal, and
          // a stale job id left on a REUSED row would hand a finished, free row to a CSV settle
          // path that bills.
          tracerfy_job_id: null,
        })),
      );
    }

    // TIER 2 ROWS, ONTO THEIR OWN QUEUE. Attempt 1 of the ladder, which is the bare 'queued' that
    // sweep-property-traces claims on. `status: 'processing'` because the row genuinely is in
    // flight. `tracerfy_job_id: null` is what keeps every tier 1 settle path away from it:
    // bulk_status finds its billable CSV rows by that column, and a tier 2 row settled there would
    // be billed the tier 1 rate by the wrong engine. It is WRITTEN rather than omitted, for the
    // reason the Tier 1 block below sets out in full.
    if (tier2Records.length > 0) {
      await insertHistoryRows(
        admin,
        tier2Records.map((r) => ({
          ...buildHistoryRow(r),
          property_trace_status: queuedStatusFor(1),
          status: "processing" as const,
          tracerfy_job_id: null,
        })),
      );
    }

    // TIER 1 ROWS, ONTO THE TIER 1 QUEUE (spec 3.2, D1). Attempt 1 of the Tier 1 ladder, which is
    // the rung app/api/cron/sweep-entity-traces claims in its Tier 1 lane. `tier1_queued`, NEVER a
    // bare 'queued': that value is the LEGACY entity ladder's attempt 1 on the same column, and a
    // row wearing it is handed to FastAppend on its owner name with no route planned at all. It is
    // what this surface used to write for a named entity.
    //
    // `tracerfy_job_id: null`, WRITTEN rather than omitted: the upsert is
    // onConflict: 'user_id,address_hash', so this row is REUSED, and an omitted key leaves whatever
    // it already carried. A CSV-era row from this very surface can carry a stale tracerfy_job_id --
    // every named person here went to the batch endpoint until this change -- and both CSV settle
    // paths (bulk_status, app/api/cron/sweep-stale-traces) find their rows by that column, so a
    // stale value would let the CSV engine settle or fail a row the Tier 1 cron also owns, and it
    // would surface in the OLD job's results.
    if (tier1Records.length > 0) {
      await insertHistoryRows(
        admin,
        tier1Records.map((r) => ({
          ...buildHistoryRow(r),
          ai_research_status: tier1QueuedStatusFor(1),
          status: "processing" as const,
          tracerfy_job_id: null,
        })),
      );
    }
  } catch (enqueueError) {
    // THE ROW WRITE IS THE SUBMIT, so this is the only thing left that can fail, and it may not be
    // swallowed. The old code awaited each upsert and discarded its error: the caller was told
    // their batch was accepted, bulk_status found no pending rows on its first poll and finalized
    // the job `completed` with records_matched 0, and its own early return made that verdict
    // permanent. The customer sent 500 rows, was told it worked, and read an empty results array.
    //
    // THE JOB MUST REACH A TERMINAL STATE, not merely get an error payload. The Suite Gateway polls
    // bulk_status for completion, and a job parked at 'processing' never completes for it. Rows
    // already written by an EARLIER bucket in this same submit keep running and bill as disclosed.
    //
    // THE CALLER-FACING SENTENCE IS THE FIXED GENERIC ONE, and it is the same string both bulk REST
    // routes write. The thrown message names a table and raw Postgres text, so it goes to the
    // server log only, never to `trace_jobs.error_message`, which bulk_status returns verbatim. It
    // deliberately carries NO "not charged" claim: a part-way failure can leave rows that were
    // already written and will be billed.
    const reason = enqueueError instanceof Error ? enqueueError.message : "Unknown error";
    console.error("MCP skip_trace_bulk - failed to enqueue rows:", reason);
    // THE ERROR IS DESTRUCTURED AND LOGGED, and a log is genuinely the only action left: the caller
    // is already being told this failed, so there is no success to withdraw. What the log buys is
    // the one thing silence would cost -- if this write fails too, the job is stuck at 'processing'
    // and polls forever, and the operator is the only party who can find it.
    const { error: failWriteError } = await admin
      .from("trace_jobs")
      .update({
        status: "failed",
        error_message:
          "We could not finish starting your upload. Some records may already be running, so check your results before uploading those addresses again.",
      })
      .eq("id", job.id);
    if (failWriteError) {
      console.error(
        "MCP skip_trace_bulk - job left NOT terminal after a failed enqueue:",
        job.id,
        failWriteError.message,
      );
    }
    return { error: "submit_failed", message: "Failed to submit bulk trace." };
  }

  // EVERY ACCEPTED ROW IS NOW QUEUED, on one of the two columns, so this tool is done the moment
  // the rows are written. The job stays 'processing' and bulk_status finishes it when both queues
  // have drained, including a job whose only rows were no-key: those are terminal at birth, so
  // nothing is still working and the first poll finalizes it.
  //
  // THE PAYLOAD KEEPS EVERY KEY A SUCCESSFUL SUBMIT EVER CARRIED. A model and the Suite Gateway
  // both read these, so no key is removed and no key is re-pointed at a different quantity.
  //
  // `persons` and `entities` still count the owner names the caller sent, through the same shared
  // classifier that prices the batch, but they no longer select a ROUTE -- every owner-bearing
  // record takes the one Tier 1 lane and planRoute() decides person, company or trust inside the
  // cron, from the whole row rather than from the name. They still sum to the Tier 1 count, so
  // persons + entities + full_property_trace === accepted still holds.
  //
  // THE ONE KEY NOT LISTED BELOW IS `message`, and it was already absent from every payload this
  // return can now produce. Its only content was the person-submit-failure sentence; on the happy
  // path it was `undefined`, which never reached a caller at all. The failure returns above carry
  // their own `message`, unchanged.
  const entities = tier1Records.filter((r) => isEntityRecord(r.owner_name)).length;

  return {
    job_id: job.id,
    accepted: billableRecords.length,
    persons: tier1Records.length - entities,
    entities,
    // Records with no owner of record, queued for a Full Property Trace. Named for what
    // happens to them rather than what does not: the `skipped` key it replaces said they were
    // free, and that stopped being true in phase 5c.
    full_property_trace: tier2Records.length,
    // ROWS NOBODY CAN BE ASKED ABOUT AT ALL: no owner name AND no street, city or state to look a
    // property up by. Terminal at submit and FREE, which is what separates them from every other
    // count here. ADDITIVE, by the owner's ruling of 2026-09-25: no key above changed what it
    // counts, and this is the count that did not exist.
    //
    // IT WAS COMPLETELY INVISIBLE BEFORE, not merely inconvenient. Such a row is in none of
    // `accepted`, `full_property_trace` or `records_failed`, and unlike the v1 route's response
    // this payload carries no total to subtract from -- a caller sending 3 records and reading
    // `accepted: 2` could not tell whether the third was a duplicate or unlookupable.
    //
    // WHY `no_lookup_key` AND NOT `skipped` OR `records_skipped`, AND DO NOT "HARMONISE" IT WITH
    // THE v1 ROUTE'S `recordsSkipped` LATER. `skipped` is the exact key `full_property_trace`
    // above replaced, because it said those records were free and phase 5c made that false; reusing
    // the word here would walk that fix back and re-teach a caller that a skipped row is a free row,
    // on the one payload where a tier 2 row sits beside it being billed. The two surfaces differ ON
    // PURPOSE.
    //
    // `no_lookup_key` is the name because it is the phrase BOTH lanes already use for this one
    // fact: we were given nothing to look this record up by. Tier 1 settles an owner-bearing row
    // that way inside the cron (TIER1_OUTCOME.NO_LOOKUP_KEY, lib/trace/tier1Outcome.ts); tier 2
    // says it at submit with PROPERTY_TRACE_NO_KEY_STATUS and reads it back as
    // PROPERTY_TRACE_NO_KEY_REASON. So the name is the shared vocabulary, not a borrowed column
    // value.
    //
    // BE PRECISE ABOUT WHICH ROWS THESE ARE, because the obvious reading is wrong. Every
    // owner-bearing record goes to tier 1 unconditionally in the split above, so the rows counted
    // here are STRICTLY blank-owner. They are written property_trace_status =
    // PROPERTY_TRACE_NO_KEY_STATUS with status 'no_match' and, via the D33 spread in
    // buildHistoryRow, outcome_code NULL -- and they are terminal at birth, so no cron ever claims
    // them and they NEVER acquire outcome_code 'no_lookup_key'. That column is the TIER 1 lane's,
    // and a row that reaches it is counted in `accepted` and `persons`/`entities`, never here.
    //
    // The REASON reaches the caller through bulk_status's per-record `skip_reason`, served by
    // rowSkipReason() from PROPERTY_TRACE_NO_KEY_REASON. These rows are terminal at birth, so the
    // very first poll carries it.
    no_lookup_key: noKeyRecords.length,
    // ALWAYS 0 NOW, AND KEPT RATHER THAN DELETED. It counted records accepted and then dropped
    // because the Tracerfy person CSV submit failed. There is no vendor call at submit any more, so
    // there is nothing left to drop: a write failure fails the whole submit above, with an error
    // payload and no job_id. A key that appears only when something went wrong is one nobody writes
    // a branch for, so it stays present and 0 for the caller that already branches on it.
    records_failed: 0,
    // THE COMMITTED AMOUNT IS THE RESERVED AMOUNT, from the one derivation the gate reserved from.
    // It used to be requoted for the survivors of a part-way failure; nothing can partly survive
    // now, so the two numbers are the same number and there is no second arithmetic to drift.
    committed_worst_case: Number(worst.toFixed(2)),
  };
}

// ---- bulk_status (shared settlement) ----------------------------------------
//
// POLLS a bulk job and SETTLES it. This is where money actually moves, via the
// shared settleBulkJob from Task 4 -- the SAME code path the v1 REST route uses,
// so the two surfaces can never diverge on money. The person rate is
// chargePerTrace(profile) (CHARGE_PER_SUCCESS for a grant holder), which is the SAME rate the v1
// route passes: one derivation, no MCP-specific price.
// The ownership fence below is the money-safety boundary: a caller can only ever
// settle their OWN job.

/**
 * THE SIZE FENCE, AND WHY IT NEEDS AN OFFSET AS WELL AS A LIMIT.
 *
 * This tool returned EVERY row of the job, each carrying a 65-key property
 * record, JSON pretty-printed at 2-space indent, with no bound of any kind. The
 * cap is 500 records a job, so the worst case is a single tool response of 500
 * dossiers. list_traces, which returns strictly less per row, has been default
 * 25 / max 200 all along.
 *
 * So the limit mirrors list_traces exactly: same numbers, same clamp, because
 * two neighbouring tools that bound themselves differently is how a caller
 * learns one of them by surprise.
 *
 * IT DOES NOT MATCH THE v1 REST TWIN (500 / 500), AND THAT IS DELIBERATE. Do not
 * reconcile the two. THIS limit exists because the consumer is a MODEL with a
 * context budget: a 500-row payload of 65-key records crowds out the
 * conversation it is supposed to inform, so a small default and an explicit ask
 * for more is the right shape: a context budget is the binding constraint here.
 * The v1 limit exists because of bytes over the wire to a program that asked for
 * them, where a small default would instead break every existing caller
 * silently. Different reasons produce different numbers honestly; matching them
 * would serve neither consumer.
 *
 * THE OFFSET IS NOT MIRRORED FROM ANYWHERE, and it is the part worth explaining.
 * list_traces pages with `since`, which works on a list ordered by time and open
 * at one end. A job's results are a FIXED set, so a bare max of 200 would make
 * the last 300 rows of a 500-record job unreachable on this surface: the caller
 * pays for 500 records and can read 200 of them. A tool that structurally cannot
 * return what the customer bought is a worse defect than the size it fixes, so
 * results_total and results_returned come back alongside, and a caller that sees
 * a gap knows to ask for the rest rather than having to infer it.
 */
export const BULK_STATUS_DEFAULT_LIMIT = 25;
export const BULK_STATUS_MAX_LIMIT = 200;

export const bulkStatusSchema = z.object({
  job_id: z.string(),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
});

/** Per-record payload, matching the v1 bulk/status route's buildPerRecordResult.
 *
 *  owner_contact_name is the RESOLVED HUMAN behind input_owner_name (which is the entity that
 *  was asked about). It is surfaced at the top level, next to the entity it belongs to, because
 *  the person previously appeared only as `result.owner_name` / `contacts.owner_name` -- keys
 *  that collide semantically with `input_owner_name` and `research.owner_name` (both the
 *  COMPANY). Consumers matched the company they already had and dropped the person; the
 *  2026-08-13 Dallas run lost all 45 resolved people that way. Null when no human was
 *  resolved -- never the company name. */
function buildPerRecordResult(row: TraceHistoryRow) {
  // THE NAME ONLY. owner_contact_source is OURS, not the customer's: it says which vendor
  // lane ran, which is an operational fact about how we work rather than something they
  // bought. It was also WRONG on every tier 2 FastAppend row until contact_vendor existed,
  // so it was shipping a false claim about provenance. The lane is still recorded, on
  // trace_history.contact_vendor, where we can read it and they cannot.
  //
  // REMOVED FROM BOTH TWINS IN ONE CHANGE. lib/trace/__tests__/payloadParity.test.ts
  // compares the two key sets, so dropping it here alone would go red.
  const { owner_contact_name } = resolveOwnerContact(row);
  return {
    // D38: never the internal `APN|...` duplicate key. Same line as the v1 bulk status twin.
    address: propertyAddressLabel(row),
    city: row.city,
    state: row.state,
    zip: row.zip,
    status: row.status,
    input_owner_name: row.input_owner_name,
    owner_contact_name,
    result: row.trace_result,
    research: row.ai_research,
    contacts: row.ai_research?.business_trace_contacts || null,
    // THE PUBLIC PROPERTY RECORD: 65 of the 86 keys stored on the row. Filtered here because
    // the Suite Gateway maps this payload into a customer's own GoHighLevel, where a wrong
    // estimated_value looks authoritative and outlives any caveat. Null on a tier 1 row -- an
    // absence is reported as an absence, never as an empty object.
    property_record: toPublicPropertyRecord(row.property_record),
    // Which billing tier bought this row: 1 = per successful trace, 2 = per record submitted.
    // Null on a row written before migration 20260917 added the column.
    tier: row.tier ?? null,
    // HOW the record ended and WHICH KEY found the owner. skip_reason below is the sentence;
    // these two are the machine-readable pair behind it. found_by is the KEY ('address',
    // 'parcel_id', 'company_name'), never the vendor, which stays internal on contact_vendor.
    // Both null on a tier 2 row and on a row written before migration 20260922.
    //
    // ADDED TO BOTH TWINS IN ONE COMMIT, same line as the v1 bulk status twin.
    found_by: row.found_by ?? null,
    outcome_code: row.outcome_code ?? null,
    // Why a row came back with no contacts. Asked of BOTH queues through
    // rowSkipReason(): serving only the tier 1 accessor left every tier 2
    // terminal value speaking as a bare no_match, including the billed row whose
    // contact vendor never answered.
    skip_reason: rowSkipReason(row),
    charge: row.charge || 0,
    ai_research_charge: row.ai_research_charge || 0,
  };
}

export async function bulkStatus(admin: SupabaseClient, gatewaySub: string, raw: unknown) {
  const { job_id, limit: rawLimit, offset: rawOffset } = bulkStatusSchema.parse(raw);
  const profile = await resolvePtpProfile(admin, gatewaySub);
  if (!profile) return UNLINKED_MESSAGE;

  // Clamped exactly as list_traces clamps its own. A negative offset would slice
  // from the end of the array, which silently returns the wrong rows rather than
  // failing, so it is floored at 0.
  const limit = Math.min(Math.max(rawLimit ?? BULK_STATUS_DEFAULT_LIMIT, 1), BULK_STATUS_MAX_LIMIT);
  const offset = Math.max(rawOffset ?? 0, 0);
  /** One page of results, plus the two counts that say whether there are more. */
  const page = (all: TraceHistoryRow[]) => ({
    results_total: all.length,
    results_returned: Math.min(Math.max(all.length - offset, 0), limit),
    results_offset: offset,
    results: all.slice(offset, offset + limit).map(buildPerRecordResult),
  });

  // Load the job.
  const { data: jobData } = await admin.from("trace_jobs").select("*").eq("id", job_id).maybeSingle();
  const job = jobData as TraceJob | null;
  if (!job) return { error: "not_found" };

  // OWNERSHIP FENCE (money-safety, critical): a caller can only poll/settle their
  // OWN job. Without this a caller could settle another user's job and move that
  // user's wallet. No settlement / wallet RPC runs for a non-owner.
  if (job.user_id !== profile.id) return { error: "forbidden" };

  // Grant-aware person rate -- this is the intentional MCP/v1 difference.
  const personRate = chargePerTrace(profile);

  // Pull this job's trace_history rows.
  const { data: rowsRaw } = await admin
    .from("trace_history")
    .select("*")
    .eq("user_id", profile.id)
    .eq("trace_job_id", job.id);
  const rows = (rowsRaw || []) as TraceHistoryRow[];

  // Already finalized: emit the stored summary + per-record details.
  // total_charge SUMS THE STORED PER-ROW CHARGES. It must never be
  // records_matched x a live rate: the rate moves, the history does not, and a
  // repriced constant would restate what the user was actually billed on every
  // past job. The stored charge is the amount settleBulkJob wrote at the time.
  if (job.status === "completed" || job.status === "failed") {
    return {
      status: job.status,
      job_id: job.id,
      records_submitted: job.records_submitted,
      records_matched: job.records_matched,
      total_charge: Number(rows.reduce((sum, r) => sum + (r.charge || 0), 0).toFixed(4)),
      error_message: job.error_message ?? null,
      ...page(rows),
    };
  }

  // Settle each unresolved Tracerfy job through the ONE shared money path.
  // settleBulkJob mutates the bucket rows in place (same as the v1 route), so the
  // completion check below stays accurate.
  const unresolvedByJobId = new Map<string, TraceHistoryRow[]>();
  for (const row of rows) {
    if (row.status !== "processing" || !row.tracerfy_job_id) continue;
    const bucket = unresolvedByJobId.get(row.tracerfy_job_id) || [];
    bucket.push(row);
    unresolvedByJobId.set(row.tracerfy_job_id, bucket);
  }
  for (const [tracerfyJobId, bucketRows] of unresolvedByJobId) {
    await settleBulkJob(admin, { tracerfyJobId, bucketRows, userId: profile.id, personRate });
  }

  // Still in flight while any row awaits research or its Tracerfy result.
  // Asked of lib/trace/entityTraceAttempts.ts, not compared against two
  // literals: a retried entity row carries its attempt number in that column,
  // and a row whose attempts ran out is terminal rather than pending.
  const isPendingResearch = (r: TraceHistoryRow) => isEntityTracePending(r.ai_research_status);
  // AND while any row still owes its FULL PROPERTY TRACE. Same shape as the
  // entity gate above and deliberately not a second one: that gate is already
  // load-bearing and correct, and two near-identical checks that differ slightly
  // is how one of them rots. Asked of lib/trace/propertyTraceAttempts.ts rather
  // than compared against literals, because a retried row carries its attempt
  // number in the column and every terminal value must read as NOT pending or it
  // holds the job open forever.
  //
  // Without this the job finalizes the moment the Tracerfy leg lands, while its
  // tier 2 rows are still queued: the caller gets `completed` and a results
  // payload that is short by however many rows they are about to be billed for.
  const isPendingProperty = (r: TraceHistoryRow) =>
    isPropertyTracePending((r as { property_trace_status?: string | null }).property_trace_status);
  const anyPendingResearch = rows.some(isPendingResearch);
  const anyPendingProperty = rows.some(isPendingProperty);
  const anyPendingTrace = rows.some((r) => r.status === "processing");
  // lib/trace/tier1Queue is not imported into this file at all, so without this arm a queued
  // Tier 1 row (ai_research_status: 'tier1_queued...') would not hold the job open here:
  // isPendingResearch asks the LEGACY entity ladder, which holds no tier1_ value, and status
  // reads as a terminal 'success'/'no_match' the moment the Tier 1 cron delivers its outcome,
  // before it clears the queue column. isRowStillWorking is the shared tier 2 + Tier 1 predicate
  // (lib/trace/finalizeBulkJob.ts). Point-free: FinalizableRow.property_trace_status was widened
  // to accept TraceHistoryRow's optional (string | null | undefined) shape directly.
  const anyPendingQueue = rows.some(isRowStillWorking);
  if (anyPendingResearch || anyPendingProperty || anyPendingTrace || anyPendingQueue) {
    return {
      status: "processing",
      job_id: job.id,
      records_submitted: job.records_submitted,
      records_pending_research: rows.filter(isPendingResearch).length,
      records_pending_property_trace: rows.filter(isPendingProperty).length,
      records_pending_trace: rows.filter((r) => r.status === "processing").length,
    };
  }

  // Finalize.
  const recordsMatched = rows.filter((r) => r.is_successful).length;
  const totalCharge = rows.reduce((sum, r) => sum + (r.charge || 0), 0);
  await admin
    .from("trace_jobs")
    .update({ status: "completed", records_matched: recordsMatched, completed_at: new Date().toISOString() })
    .eq("id", job.id);

  return {
    status: "completed",
    job_id: job.id,
    records_submitted: job.records_submitted,
    records_matched: recordsMatched,
    total_charge: Number(totalCharge.toFixed(4)),
    ...page(rows),
  };
}
