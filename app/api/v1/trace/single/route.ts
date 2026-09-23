import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateApiKey, isAuthError } from '@/lib/api/auth';
import { chargePerRecord, chargePerTrace, pricePlanFor } from '@/lib/suite/pricing';
import { createAddressHash, traceKeyFor, usableZip, validateAddressInput } from '@/lib/utils/address-normalizer';
import { checkSingleDuplicateByHash } from '@/lib/utils/deduplication';
import {
  excludeBilledRows,
  foldBillingWrite,
  hasLedgerReceipt,
  isBilledRow,
  isCacheHitRow,
  TRACE_TIER,
} from '@/lib/trace/billedRows';
import { lookupBusinessTrace, lookupPersonTrace } from '@/lib/tracerfy/client';
import { lookupDossier } from '@/lib/tracerfy/dossier';
import { contactVendorFrom, executeRoute } from '@/lib/routing/executeRoute';
import { runSingleTier1 } from '@/lib/trace/singleTier1';
import {
  BUSY_TRY_AGAIN_REASON,
  missingLookupKey,
  noLookupKeyReason,
  TIER1_OUTCOME,
} from '@/lib/trace/tier1Outcome';
import { isPropertyTracePending } from '@/lib/trace/propertyTraceAttempts';
import { isEntityTracePending } from '@/lib/trace/entityTraceAttempts';
import { ownerNamesMatch } from '@/lib/utils/ownerName';
import { planRoute } from '@/lib/routing/ownerRoute';
import {
  FULL_PROPERTY_TRACE_DESCRIPTION,
  hasContactData,
  isFullPropertyTrace,
  parcelForFullTrace,
  traceResultFor,
  WALLET_NOT_COLLECTED_WARNING,
  WALLET_SHORT_WARNING,
} from '@/lib/trace/fullPropertyTrace';
import { dispatchTraceCompleted } from '@/lib/trace/traceCompletedWebhook';
import { toPublicPropertyRecord } from '@/lib/trace/publicPropertyRecord';
import { deductWallet } from '@/lib/wallet/deduct';
import { triggerAutoRebillIfNeeded } from '@/lib/utils/auto-rebill';
import { STALE_PROCESSING, VENDOR_TIMEOUT } from '@/lib/constants';
import type { TraceResult } from '@/types';

/**
 * Both tiers now finish INSIDE this request: tier 2 buys the dossier and then contacts, tier 1 runs
 * its ladder (spec D1, D26). Every vendor call is capped at 25 s and no call starts later than 50 s
 * after the request began (VENDOR_TIMEOUT), which leaves 10 s of this 60 for our own writes. The
 * arithmetic is in docs/superpowers/plans/2026-09-21-tier1-phase1-single-traces.md.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const startedAt = Date.now();
    // Authenticate via API key
    const authResult = await validateApiKey(request);
    if (isAuthError(authResult)) {
      return authResult.response;
    }
    const { profile } = authResult;

    // Parse request body
    const body = await request.json();
    // `aiResearch` used to be accepted here and would run the AI Search engine when no
    // ownerName was supplied. That engine was removed on 2026-09-17, so the field is no
    // longer read. It is not rejected either: an integration still sending it keeps working
    // and simply gets the plain trace. What now serves a submit with no owner is TIER 2,
    // below.
    const { address, city, state, zip, ownerName } = body;
    // D23: a record with no city can be sent with its parcel id (`apn`, or `parcelId`) and county,
    // so Tracerfy's parcel lookup can serve an individual; a company needs only its name and
    // state. The web app stays address-only (D5).
    // A field that is present but not text (a number, say) is a caller bug. It is refused here,
    // before any write, rather than read as absent -- which answered "missing the city and the
    // parcel ID" and sent the caller looking for a field they did send -- or carried into a trim()
    // that throws and surfaces as a bare 500.
    for (const field of ['apn', 'parcelId', 'county', 'ownerName'] as const) {
      const value: unknown = body[field];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return NextResponse.json(
          { success: false, error: `${field} must be a string when supplied` },
          { status: 400 }
        );
      }
    }
    const apn: string | undefined =
      typeof body.apn === 'string' ? body.apn : typeof body.parcelId === 'string' ? body.parcelId : undefined;
    const county: string | undefined = typeof body.county === 'string' ? body.county : undefined;
    const hasCity = typeof city === 'string' && city.trim() !== '';
    const hasStreet = typeof address === 'string' && address.trim() !== '';

    if (typeof state !== 'string' || !/^[A-Za-z]{2}$/.test(state.trim())) {
      const skipReason = noLookupKeyReason('state');
      return NextResponse.json(
        { success: false, outcomeCode: TIER1_OUTCOME.NO_LOOKUP_KEY, skipReason, error: skipReason },
        { status: 400 }
      );
    }

    // A street and a city sent together are validated exactly as before. Either one alone is judged
    // below by whether any lookup key is left, rather than refused here.
    if (hasStreet && hasCity) {
      const validation = validateAddressInput(address, city, state, zip);
      if (!validation.valid) {
        return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
      }
    } else if (typeof zip === 'string' && zip.trim() !== '' && usableZip(zip) === '') {
      return NextResponse.json(
        { success: false, error: 'ZIP code must be 5 or 9 digits when supplied' },
        { status: 400 }
      );
    }

    if (typeof ownerName === 'string' && ownerName.trim() !== '' && !/[A-Za-z]/.test(ownerName)) {
      return NextResponse.json(
        { success: false, error: 'ownerName must contain at least one letter' },
        { status: 400 }
      );
    }

    /**
     * Tier 2 (Full Property Trace) when the owner of record is missing, or when the
     * caller asked for the property record outright. AUTOMATIC on an absent owner,
     * matching app/api/trace/single -- David's decision, 2026-09-17, so the two surfaces
     * price the same request the same way.
     *
     * isFullPropertyTrace() is the SHARED predicate, deliberately: it is consulted by the
     * balance gate, the cache branch and the execution below, and by both routes, so the
     * two surfaces and the three call sites cannot drift apart.
     *
     * v1's body is camelCase (`ownerName`), so the mapping is explicit. The opt-in flag is
     * `fullPropertyTrace`; `full_property_trace` is honoured too because that is the
     * spelling on the session route, and a caller who sends it has unambiguously asked for
     * a full property trace -- getting a silently cheaper tier 1 instead is not a kindness,
     * it is the wrong answer.
     */
    const fullPropertyTrace = isFullPropertyTrace({
      owner_name: ownerName,
      full_property_trace: body.fullPropertyTrace === true || body.full_property_trace === true,
    });

    // D23: the record is judged by whether ANY lookup key is left, using the same planRoute that
    // will run it, instead of demanding a street and city of every record. No step means no key:
    // nothing is written and nothing is charged.
    const parcel = parcelForFullTrace({ address, city, state, zip, apn, county });
    const tier1Owner = fullPropertyTrace ? null : String(ownerName).trim();
    // PRICE-INERT, no test needed: this plan is consulted only for keyPlan.steps.length below, to
    // learn whether ANY lookup key exists. Nothing here reads a rate off it, so a plan derived from
    // the wrong price column would still answer this question correctly.
    const keyPlan = planRoute({ ...parcel, ownerName: tier1Owner }, pricePlanFor(profile));
    if (keyPlan.steps.length === 0) {
      // INVARIANT: planRoute emits no step exactly when missingLookupKey names what is missing. The
      // state and an owner name with no letters were refused above; a company, or a trust or
      // unreadable name with no first name left (D16), always gets its FastAppend step; and a
      // person's steps, like a Full Property Trace's dossier steps, need a street and city or a
      // parcel id with its county, which is the test missingLookupKey makes. A null here is a
      // broken invariant, never a reason to invent a sentence (CLAUDE.md rule 7).
      const missing = missingLookupKey({ address, city, state, apn, county });
      if (!missing) {
        throw new Error('Invariant broken: planRoute found no lookup key but missingLookupKey found one');
      }
      const skipReason = noLookupKeyReason(missing);
      return NextResponse.json(
        { success: false, outcomeCode: TIER1_OUTCOME.NO_LOOKUP_KEY, skipReason, error: skipReason },
        { status: 400 }
      );
    }

    /**
     * Check wallet balance for all users, AGAINST THE RATE THIS REQUEST WILL CHARGE.
     * Reserving the tier 1 rate for a tier 2 request under-reserves by $0.10-$0.15 and
     * lets a wallet that cannot pay reach the vendors, where the money is spent on our
     * side whether or not we can collect it.
     *
     * Both rates come from the ONE derivation in lib/suite/pricing.ts, which is grant-aware:
     * a Suite Gateway grant is a pro entitlement for price exactly as it is for access
     * (lessons.md L-030). The gate and the charge below read the same two functions, because a
     * gate on a different derivation from the charge reserves the wrong number.
     */
    const minBalance = fullPropertyTrace
      ? chargePerRecord(profile)
      : chargePerTrace(profile);
    if (profile.wallet_balance < minBalance) {
      return NextResponse.json(
        { success: false, error: 'Insufficient wallet balance' },
        { status: 402 }
      );
    }

    // The duplicate key (spec 6.3, D36): street, city and state when the record has BOTH a street
    // and a city, as before; parcel id, county and state when it has a parcel id and county but no
    // street; the street-and-state key otherwise.
    const normalizedAddress = traceKeyFor({ address, city, state, apn, county });
    const addressHash = createAddressHash(normalizedAddress);
    // The webhook's `address`, keyed the SAME way traceKeyFor is: the normalized key only when
    // there is both a street and a city, else the street as sent, else nothing. Never the internal
    // "APN|..." or "||STATE" key, which is ours and means nothing to a caller.
    const webhookAddress =
      hasStreet && hasCity ? normalizedAddress : hasStreet ? String(address).trim() : null;

    const adminClient = createAdminClient();

    // A ROW A LEDGER ROW POINTS AT IS NEVER A DELETE CANDIDATE.
    //
    // UNIQUE(user_id, address_hash) means there is at most ONE row here, and
    // every delete below is confined to it, so one probe answers for all of
    // them. excludeBilledRows() derives billed-ness from trace_history's own
    // columns; this asks the LEDGER, which is the only question that stays
    // right for a row whose receipt columns were already zeroed by the settle
    // bug fixed alongside this. Those rows exist and are currently locked out
    // of every retrace with a 500 that names nothing.
    const { data: existingRow, error: existingRowError } = await adminClient
      .from('trace_history')
      .select('id, charge, ai_research_charge, property_record, tier, outcome_code, property_trace_status, ai_research_status, trace_job_id, status, created_at')
      .eq('user_id', profile.id)
      .eq('address_hash', addressHash)
      .maybeSingle();

    // LIVE WORK IS NEVER TOUCHED BY THIS ROUTE (the rule app/api/trace/single carries, Task 9).
    //
    // A row with work still in flight (a Tier 2 cron row back on a queued rung after its crash
    // window, a busy row a bulk upload re-enqueued, or a 'processing' row a concurrent request is
    // still running) must not be reused: runSingleTier1 would count the cron's own debit as THIS
    // request's charge and null the queue columns under the worker. Such a row answers the SAME
    // busy_try_again shape a vendor failure does, completely untouched: no delete, no write, no
    // vendor call, no deduct, no webhook. STALE_PROCESSING.CRON_TIMEOUT_MINUTES is the age at which
    // app/api/cron/sweep-stale-traces itself gives up on a 'processing' row, so a younger one is
    // presumptively still running somewhere.
    //
    // THE THRESHOLD DEPENDS ON WHO OWNS THE ROW, the rule app/api/trace/single carries. A row a
    // BULK job owns is worked by a cron on its own schedule, so CRON_TIMEOUT_MINUTES is right for
    // it. A row a SINGLE trace wrote (trace_job_id NULL) finishes inside its own request, capped
    // at 60 s by maxDuration, so it cannot still be running an hour later: the cron's hour meant
    // one request that died after its insert answered busy to every resend for up to an hour.
    const processingTimeoutMinutes = existingRow?.trace_job_id
      ? STALE_PROCESSING.CRON_TIMEOUT_MINUTES
      : STALE_PROCESSING.SINGLE_REQUEST_TIMEOUT_MINUTES;
    const staleProcessingCutoff = new Date(
      Date.now() - processingTimeoutMinutes * 60 * 1000
    );
    const processingIsLive =
      existingRow?.status === 'processing' &&
      Boolean(existingRow.created_at) &&
      new Date(existingRow.created_at) >= staleProcessingCutoff;
    const liveWork = Boolean(
      existingRow &&
        (isPropertyTracePending(existingRow.property_trace_status) ||
          isEntityTracePending(existingRow.ai_research_status) ||
          processingIsLive)
    );

    if (liveWork) {
      return NextResponse.json(
        {
          success: false,
          status: 'error',
          traceId: existingRow!.id,
          // THE TIER THIS REQUEST ACTUALLY IS. Hard-coding tier 1 told a Full Property Trace
          // caller they had submitted a per-successful-trace record.
          tier: fullPropertyTrace ? TRACE_TIER.PER_RECORD_SUBMITTED : TRACE_TIER.PER_SUCCESSFUL_TRACE,
          charge: 0,
          result: null,
          foundBy: null,
          outcomeCode: TIER1_OUTCOME.BUSY_TRY_AGAIN,
          skipReason: BUSY_TRY_AGAIN_REASON,
          error: BUSY_TRY_AGAIN_REASON,
        },
        { status: 503, headers: { 'Retry-After': '300' } }
      );
    }

    // Fails CLOSED. Not knowing whether a row exists is not permission to
    // delete one: a refused delete is a 500 the caller cannot get past, while
    // a skipped delete just reuses the row in place, which is what a billed row
    // does anyway.
    const ledgerProtected = existingRowError
      ? true
      : existingRow
        ? isBilledRow(existingRow) || (await hasLedgerReceipt(adminClient, existingRow.id))
        : false;

    // A busy_try_again row is the one a resend RESUMES (spec 5.2): its step log is what spares the
    // retry from buying the answered steps again, so no sweep below may delete it. It is reused in
    // place by the update branch further down, like a billed row. `liveWork` is already false by
    // this line (live work returned above), named here so the rule, busy AND no live work, reads
    // the same in code as in the web route.
    const busyResend = !liveWork && existingRow?.outcome_code === TIER1_OUTCOME.BUSY_TRY_AGAIN;

    // Every delete below is narrowed by excludeBilledRows() and its error is
    // checked. wallet_transactions.trace_history_id references these rows with
    // no ON DELETE clause, so a delete on a billed row fails with 23503 — and
    // an unchecked failure walks straight into the UNIQUE(user_id, address_hash)
    // violation below. See lib/trace/billedRows.ts.
    const deleteErrors: string[] = [];
    const runDelete = async (
      label: string,
      build: () => PromiseLike<{ error: { message: string } | null }>
    ) => {
      if (ledgerProtected || busyResend) return;
      const { error } = await build();
      if (error) {
        console.error(`API v1 single trace - ${label} delete failed:`, error.message);
        deleteErrors.push(error.message);
      }
    };

    // Check for cached result (90-day dedup)
    const cachedResult = await checkSingleDuplicateByHash(profile.id, addressHash);

    if (cachedResult) {
      const cached = cachedResult.trace_result as TraceResult | null;
      const hasData = cached &&
        ((cached.phones?.length || 0) > 0 || (cached.emails?.length || 0) > 0);

      // D25: a supplied owner is served an earlier result only when it is the SAME owner. A
      // different owner runs a new trace, charged only on a name-matched result with contacts. A
      // Full Property Trace request is served as before.
      const sameOwner =
        fullPropertyTrace || ownerNamesMatch(cachedResult.input_owner_name, ownerName);

      if (hasData && sameOwner) {
        // property_record rides along: on a tier 2 row it is the thing the customer
        // paid for, and dropping it here would serve them a cache hit poorer than
        // the response they originally got.
        //
        // The STORED row is raw (86 keys) and the RESPONSE is filtered (65). A
        // cache hit is an egress like any other, and it is the easiest one to
        // miss: the record comes from our own database rather than from a vendor
        // call, so it does not look like it is leaving.
        return NextResponse.json({
          success: true,
          cached: true,
          charge: 0,
          foundBy: cachedResult.found_by ?? null,
          outcomeCode: cachedResult.outcome_code ?? null,
          traceId: cachedResult.id,
          result: cached,
          propertyRecord: toPublicPropertyRecord(cachedResult.property_record),
          tier: cachedResult.tier ?? null,
        });
      }

      // A BILLED TIER 2 ROW IS SERVED FROM THE DATABASE WHATEVER IT CONTAINS.
      // David, 2026-09-17: if serving the request spends money at Tracerfy the user is
      // charged, and if it is served from their own stored record it is free. A tier 2
      // miss holds no contacts and no property record -- it is a paid-for "the county
      // has no parcel at this address" -- and re-running the dossier would bill them a
      // second time for the same absence. Without this branch the row falls through to
      // the submit below and the customer re-buys a record they already own.
      // isCacheHitRow is the JS twin of CACHE_HIT_FILTER, which is what let this row out
      // of the database in checkSingleDuplicateByHash in the first place.
      if (fullPropertyTrace && isCacheHitRow(cachedResult)) {
        return NextResponse.json({
          success: true,
          cached: true,
          charge: 0,
          traceId: cachedResult.id,
          status: cachedResult.status,
          result: cached,
          propertyRecord: toPublicPropertyRecord(cachedResult.property_record),
          tier: cachedResult.tier ?? null,
        });
      }

      // Re-trace: either the cached row holds no contacts, or it holds a DIFFERENT owner's
      // contacts (D25: sameOwner false above). Delete it only if the customer has not paid for
      // it: a tier 2 property record is billed whether or not contacts ever followed.
      if (!isBilledRow(cachedResult)) {
        await runDelete('cached-empty', () =>
          adminClient.from('trace_history').delete().eq('id', cachedResult.id)
        );
      }
    }

    // Delete any existing failed traces for this address.
    // is_successful = false is ALSO the tier 2 paid-but-no-contacts shape.
    await runDelete('failed', () =>
      excludeBilledRows(
        adminClient
          .from('trace_history')
          .delete()
          .eq('user_id', profile.id)
          .eq('address_hash', addressHash)
          .eq('is_successful', false)
      )
    );

    // If a different owner name is provided, delete any existing trace for this address.
    // This allows re-tracing once the caller has resolved a person name behind an LLC.
    if (ownerName) {
      await runDelete('owner-changed', () =>
        excludeBilledRows(
          adminClient
            .from('trace_history')
            .delete()
            .eq('user_id', profile.id)
            .eq('address_hash', addressHash)
            .neq('input_owner_name', ownerName)
        )
      );
    }

    if (deleteErrors.length > 0) {
      return NextResponse.json(
        { success: false, error: `Failed to clear previous trace: ${deleteErrors[0]}` },
        { status: 500 }
      );
    }

    // UNIQUE(user_id, address_hash) means ONE row per address per user. A row
    // that survived the guarded deletes is a billed row, so enrich it in place
    // rather than inserting a second one that cannot exist.
    const { data: surviving, error: survivingError } = await adminClient
      .from('trace_history')
      .select('id')
      .eq('user_id', profile.id)
      .eq('address_hash', addressHash)
      .maybeSingle();

    if (survivingError) {
      console.error('API v1 single trace - existing row lookup failed:', survivingError.message);
      return NextResponse.json(
        { success: false, error: 'Failed to process request' },
        { status: 500 }
      );
    }

    const resubmitData = {
      normalized_address: normalizedAddress,
      city: hasCity ? city.toUpperCase() : null,
      state: state.trim().toUpperCase(),
      // The zip is OPTIONAL at validation (it is not part of address_hash), so it can
      // legitimately be absent. `zip.substring(0, 5)` on an absent one threw a TypeError
      // and surfaced as a bare 500 before any vendor was called -- and an absent zip is
      // precisely the case tier 2 backfills. Same shape as app/api/trace/single:273.
      zip: zip ? zip.substring(0, 5) : null,
      // D23: the parcel id and county as sent, beside the key built from them (spec 6.3).
      parcel_id_local: parcel.parcelIdLocal,
      county: parcel.county,
      status: 'processing',
    };

    // Insert pending trace record, or reuse the billed row that survived.
    // charge, ai_research_charge, property_record and tier are never touched
    // here: they are what the customer already paid for.
    //
    // input_owner_name is written by the INSERT only (D25 money, the web route's Task 9 rule): on
    // a reused row it must change in the SAME write as trace_result, never ahead of it, or the row
    // would name a new owner while still holding the old owner's contacts and a second request for
    // the new owner could be served them free. runSingleTier1 and the Tier 2 persist below write it
    // together with trace_result.
    const { data: traceRecord, error: insertError } = surviving
      ? await adminClient
          .from('trace_history')
          .update({ ...resubmitData, tracerfy_job_id: null })
          .eq('id', surviving.id)
          .select()
          .single()
      : await adminClient
          .from('trace_history')
          .insert({
            user_id: profile.id,
            address_hash: addressHash,
            input_owner_name: ownerName || null,
            ...resubmitData,
          })
          .select()
          .single();

    if (insertError || !traceRecord) {
      console.error('API v1 single trace - failed to create record:', insertError?.message);
      return NextResponse.json(
        { success: false, error: 'Failed to process request' },
        { status: 500 }
      );
    }

    /* ---------------------------------------------------------------- *
     * TIER 2 — FULL PROPERTY TRACE
     *
     * Mirrors app/api/trace/single:339-497 step for step. Synchronous end to
     * end: the dossier and the contact lookup are both plain JSON POSTs, so the
     * spend and the charge happen in this request rather than in a later poll.
     * That is the whole reason billing lives here and nowhere else.
     *
     * THE CHARGE SEQUENCE, in order, and none of these steps may move:
     *   1. plan the route (pure, no spend) at the CALLER'S OWN rate
     *   2. run it -- dossier, then contacts for whatever owner it found
     *   3. if a vendor FAILED, charge nothing and let them retry for free
     *   4. otherwise deduct, ONCE, and read back what actually moved
     *   5. persist the record, the tier, and the amount that was collected
     *   6. fire trace.completed, because nothing else will
     * ---------------------------------------------------------------- */
    if (fullPropertyTrace) {
      // 1. The caller's REAL plan, derived from their profile exactly as the tier 1
      //    rate above is, through the one grant-aware derivation. planRoute takes it as a
      //    required argument so no route can quietly bill the wrong column: a
      //    hardcoded 'pro' once billed pay-as-you-go customers 40% under rate,
      //    silently, because nobody reports being undercharged (FAILSAFE_PRICE_PLAN).
      //    D24: the parcel id key rides along, so a Full Property Trace sent with one tries it
      //    first and the address second.
      const plan = planRoute(parcel, pricePlanFor(profile));

      // Defence in depth: planRoute emits no step at all when the parcel has no usable
      // key. The keyPlan check above makes that unreachable from this route, and it is
      // guarded anyway because the rule is that the charge follows the VENDOR CALL -- a
      // record no vendor was ever asked about must not reach the deduct below.
      if (plan.steps.length === 0) {
        await adminClient
          .from('trace_history')
          .update({ status: 'error', tracerfy_job_id: null })
          .eq('id', traceRecord.id);

        return NextResponse.json(
          {
            success: false,
            status: 'error',
            traceId: traceRecord.id,
            tier: TRACE_TIER.PER_RECORD_SUBMITTED,
            charge: 0,
            error: plan.warnings[0] || 'No usable lookup key for this address.',
          },
          { status: 400 }
        );
      }

      // 2. Spend. executeRoute never throws and reports each step separately.
      const execution = await executeRoute(
        plan,
        { lookupDossier, traceEntity: lookupBusinessTrace, tracePerson: lookupPersonTrace },
        { deadlineMs: startedAt + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS }
      );

      // 3. A VENDOR FAILURE IS NEVER BILLED. `success: false` means we could not ask --
      //    an outage, a rate limit, a rejected key. It is NOT the same as
      //    `ownerFound: false`, which is also what a legitimate, billable miss looks
      //    like. Gating on ownerFound would bill customers for our outages; gating on a
      //    hit would give away records we paid for (lessons.md L-007). Nothing is
      //    charged and nothing billable is persisted, so the row stays retryable rather
      //    than becoming a free cache entry that can never acquire its contacts.
      //    No webhook either: there is no completion to report, which matches the poll
      //    route's stall-error branch.
      if (!execution.success) {
        await adminClient
          .from('trace_history')
          .update({ status: 'error', tracerfy_job_id: null })
          .eq('id', traceRecord.id);

        return NextResponse.json(
          {
            success: false,
            status: 'error',
            traceId: traceRecord.id,
            tier: TRACE_TIER.PER_RECORD_SUBMITTED,
            charge: 0,
            error: execution.error || 'Property lookup failed. Please try again.',
          },
          { status: 502 }
        );
      }

      // 4. Billable. A TOTAL MISS IS STILL BILLED: tier 2 is per RECORD SUBMITTED, so
      //    "the county has no parcel at this address" is a real answer the customer pays
      //    for. deductWallet reports what actually moved -- 0 when the wallet came up
      //    short between the gate above and now -- and that is the only number that may
      //    be persisted, returned or sent in a webhook. It also says WHICH of the two
      //    zero outcomes happened, because one of them is the customer's balance and
      //    the other one is ours to own.
      const attemptedCharge = plan.billing.amount;
      const deduction = await deductWallet(adminClient, {
        p_user_id: profile.id,
        p_amount: attemptedCharge,
        p_trace_history_id: traceRecord.id,
        p_description: FULL_PROPERTY_TRACE_DESCRIPTION,
      });
      const charge = deduction.collected;

      if (deduction.outcome === 'error') {
        // WE SPENT AT THE VENDOR AND FAILED TO COLLECT. The customer is not
        // billed and keeps the record, which is the same outcome as before and
        // is the right one: billing them later for a record already delivered
        // is exactly the surprise charge this phase exists to remove. Logged so
        // the shortfall is findable rather than silent; the row that results
        // carries cost > 0 with charge = 0, which is the query for it.
        console.error(
          'API v1 Full Property Trace - wallet deduct failed, record delivered uncharged:',
          traceRecord.id,
          deduction.message
        );
      }

      // 5. Persist. property_record is the vendor's object BY REFERENCE, all 86 keys,
      //    unfiltered and unrenamed: the raw dump is the product, and a key that is
      //    empty in OH, CA and UT may be populated elsewhere.
      const result = traceResultFor(execution);
      const isSuccessful = hasContactData(result);
      const status = isSuccessful ? 'success' : 'no_match';
      const persistedZip = execution.learnedZip ?? resubmitData.zip;

      // RECEIPTS ARE MONOTONIC. `traceRecord` is the row this submit reused or
      // inserted, still carrying whatever it had been charged before, so the
      // amount collected NOW is folded into it rather than replacing it. A row
      // that was billed can never come out of here unbilled, and the dashboard's
      // SUM(charge) stays in agreement with wallet_transactions.
      const billing = foldBillingWrite(traceRecord, {
        charge,
        tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      });

      const { error: persistError } = await adminClient
        .from('trace_history')
        .update({
          status,
          trace_result: result,
          // D25 money: the owner this result describes changes in the SAME write as the result,
          // never a separate one. The supplied owner if there was one, else null.
          input_owner_name: ownerName || null,
          phone_count: result?.phones?.length || 0,
          email_count: result?.emails?.length || 0,
          is_successful: isSuccessful,
          property_record: execution.property,
          tier: billing.tier,
          charge: billing.charge,
          // What the vendors actually took, read from their own credit counters rather
          // than assumed from a price list.
          cost: execution.vendorSpend,
          // Which contact vendor was asked (spec 6.1); NULL when none was.
          contact_vendor: contactVendorFrom(execution.steps),
          // A tier 2 row carries no tier 1 outcome. Cleared because this row may be REUSED from a
          // tier 1 trace whose outcome would otherwise answer rowSkipReason for it.
          outcome_code: null,
          found_by: null,
          trace_steps: execution.steps,
          tracerfy_job_id: null,
          // The situs zip the dossier taught us, and ONLY when the caller had none.
          // address_hash is sha256 of the duplicate key (street, city and state, or the
          // parcel key), and every form of it deliberately excludes the zip (migration
          // 20260904, D36), so this column is free to gain a value: the row keeps matching
          // its own cache key. Never recompute the hash here -- a row whose hash moves is
          // a row that re-buys itself forever.
          ...(execution.learnedZip ? { zip: execution.learnedZip } : {}),
        })
        .eq('id', traceRecord.id);

      if (persistError) {
        // The money is gone and the record is bought. Say so loudly rather than
        // returning a clean 500 that hides a paid-for result.
        console.error('API v1 Full Property Trace - failed to persist result:', persistError.message);
      }

      // Fire-and-forget, same rule as the poll route: a charge was attempted, so top the
      // wallet up if it has dropped below the threshold. Still fires when the deduct
      // failed -- that is exactly the wallet that needs it.
      triggerAutoRebillIfNeeded(profile.id).catch(() => {});

      // 6. trace.completed. Tier 2 never reaches the poll route that normally sends it,
      //    so without this a webhook customer silently stops receiving events. Fires for
      //    EVERY completed tier 2 including a billed miss, and never on the vendor
      //    failure above, which returned already. `profile` came from the ADMIN client in
      //    validateApiKey via select('*'), so webhook_url is present on it; no re-read
      //    is needed on this surface.
      dispatchTraceCompleted({
        webhookUrl: profile.webhook_url,
        traceId: traceRecord.id,
        status,
        address: webhookAddress,
        city: resubmitData.city,
        state: resubmitData.state,
        zip: persistedZip,
        result,
        charge,
        propertyRecord: execution.property,
        ownerType: execution.ownerType,
        tier: TRACE_TIER.PER_RECORD_SUBMITTED,
      });

      // 7. NO CRM PUSH HERE, AND THAT IS THE DESIGN. PTP never calls HighLevel
      //    unless a person asked it to. An API caller gets the result back and
      //    sends it wherever they want it; a push from PTP starts only at the
      //    Push to CRM button, which is app/api/integrations/highlevel/push.

      // Two different zeros, two different sentences. Saying "your wallet did
      // not cover this" to a customer whose wallet is full, because OUR RPC
      // fell over, is a false statement about their money.
      // ONLY THE TWO WALLET SENTENCES REACH THE CALLER, the rule Task 9 set for tier 1.
      // execution.warnings are OUR routing notes -- "Sending the property state. FastAppend keys
      // on STATE OF REGISTRATION...", "The $0.20 dossier charge is sunk on a hit..." -- and they
      // quote a vendor price, which no customer-facing sentence may do (spec 7.3). They stay
      // internal; the step log and the server log are where we read them.
      const warnings: string[] = [];
      if (deduction.outcome === 'insufficient_balance') {
        warnings.push(WALLET_SHORT_WARNING);
      } else if (deduction.outcome === 'error') {
        warnings.push(WALLET_NOT_COLLECTED_WARNING);
      }

      return NextResponse.json({
        success: true,
        status,
        traceId: traceRecord.id,
        tier: TRACE_TIER.PER_RECORD_SUBMITTED,
        // What THIS request cost. The row carries the running total for the
        // address; a caller is told what they were just charged.
        charge,
        result,
        // THE SAME VARIABLE THAT WAS JUST PERSISTED RAW. toPublicPropertyRecord
        // returns a copy and never touches its argument -- an in-place delete
        // here would have written a 65-key row to trace_history and destroyed
        // the raw dump. 65 keys out, 86 keys stored.
        propertyRecord: toPublicPropertyRecord(execution.property),
        ownerName: execution.ownerName,
        ownerType: execution.ownerType,
        needsManualReview: execution.needsManualReview,
        warnings,
      });
    }

    /* ---------------------------------------------------------------- *
     * TIER 1, INLINE (spec D1, D26). The owner was supplied: planRoute
     * picks the ladder, executeRoute runs it inside this request, and the
     * finished result comes back here. The old "processing, then poll"
     * contract is removed for new traces; /api/v1/trace/status still
     * answers for trace ids already issued.
     * ---------------------------------------------------------------- */
    const tier1 = await runSingleTier1({
      adminClient,
      userId: profile.id,
      row: traceRecord,
      parcel: { ...parcel, ownerName: tier1Owner },
      // PRICE-INERT, no test needed: runSingleTier1 reads only plan.tier off the plan it builds
      // from this (lib/trace/singleTier1.ts:107,113), to enforce that this is a tier 1 record. The
      // charge itself arrives separately, below, as chargeAmount.
      pricePlan: pricePlanFor(profile),
      chargeAmount: chargePerTrace(profile),
      deadlineMs: startedAt + VENDOR_TIMEOUT.SINGLE_ROUTE_BUDGET_MS,
      deps: { lookupDossier, traceEntity: lookupBusinessTrace, tracePerson: lookupPersonTrace },
      // D25 money: written into the same UPDATE as trace_result inside runSingleTier1, never ahead
      // of it.
      inputOwnerName: ownerName || null,
    });

    if (tier1.persistError) {
      console.error('API v1 single trace tier 1 - failed to persist result:', tier1.persistError);
    }

    if (tier1.outcome === TIER1_OUTCOME.BUSY_TRY_AGAIN) {
      // D7: free, no webhook, and the row keeps its step log so a resend within 24 hours resumes.
      return NextResponse.json(
        {
          success: false,
          status: 'error',
          traceId: traceRecord.id,
          tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
          charge: 0,
          result: null,
          foundBy: null,
          outcomeCode: tier1.outcome,
          skipReason: tier1.skipReason,
          error: tier1.skipReason,
        },
        { status: 503, headers: { 'Retry-After': '300' } }
      );
    }

    if (tier1.deduction === 'charged' || tier1.deduction === 'insufficient_balance' || tier1.deduction === 'error') {
      triggerAutoRebillIfNeeded(profile.id).catch(() => {});
    }

    const tier1Status = tier1.status === 'success' ? 'success' : 'no_match';

    // trace.completed fires from here now; an integrator who never polls still hears about it.
    dispatchTraceCompleted({
      webhookUrl: profile.webhook_url,
      traceId: traceRecord.id,
      status: tier1Status,
      address: webhookAddress,
      city: resubmitData.city,
      state: resubmitData.state,
      zip: resubmitData.zip,
      result: tier1.result,
      charge: tier1.charge,
      propertyRecord: null,
      ownerType: tier1.execution.ownerType,
      tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
      foundBy: tier1.foundBy,
      outcomeCode: tier1.outcome,
      skipReason: tier1.skipReason,
    });

    // Only the two wallet sentences reach the caller; the routing notes are internal.
    const tier1Warnings: string[] = [];
    if (tier1.deduction === 'insufficient_balance') tier1Warnings.push(WALLET_SHORT_WARNING);
    else if (tier1.deduction === 'error') tier1Warnings.push(WALLET_NOT_COLLECTED_WARNING);

    return NextResponse.json({
      success: true,
      status: tier1Status,
      traceId: traceRecord.id,
      tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
      charge: tier1.charge,
      result: tier1.result,
      propertyRecord: null,
      ownerName: tier1Owner,
      ownerType: tier1.execution.ownerType,
      needsManualReview: tier1.execution.needsManualReview,
      foundBy: tier1.foundBy,
      outcomeCode: tier1.outcome,
      skipReason: tier1.skipReason,
      warnings: tier1Warnings,
    });
  } catch (error) {
    console.error('API v1 single trace error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
