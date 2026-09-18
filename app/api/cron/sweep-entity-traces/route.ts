import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { lookupBusinessTrace, submitSingleTrace } from '@/lib/tracerfy/client';
import { traceCreditFromFastAppend, resolveOwnerContact } from '@/lib/ai-research/contacts';
import { deductOrZero } from '@/lib/wallet/deduct';
import { collectedChargeFor } from '@/lib/wallet/collectedCharge';
import { TRACE_TIER, foldBillingWrite } from '@/lib/trace/billedRows';
import { BLANK_OWNER_SKIP_STATUS } from '@/lib/trace/blankOwnerSkip';
import {
  ENTITY_QUEUED_STATUSES,
  ENTITY_TRACE_ATTEMPTS,
  MAX_ENTITY_TRACE_ATTEMPTS,
  attemptOf,
  nextAfterFailedAttempt,
  processingStatusFor,
} from '@/lib/trace/entityTraceAttempts';
import { PRICING, getChargePerTrace } from '@/lib/constants';
import { chargePerTrace, isTrackASource } from '@/lib/suite/pricing';
import type { AIResearchResult } from '@/types';

/**
 * Vercel Cron: resolves the ENTITY-owned rows of a bulk job, the ones parked in
 * `ai_research_status = 'queued'`.
 *
 * RENAMED 2026-09-17 from sweep-bulk-research. It used to call
 * researchProperty(), the Brave plus Claude AI Search engine, which has been
 * removed. It now calls lookupBusinessTrace(), the SYNCHRONOUS FastAppend
 * business-trace lookup, which does the same FastAppend half with no web search
 * and no LLM in the path. Everything else about this cron is unchanged on
 * purpose: the state machine, the stale-claim recovery, the atomic claim, and
 * what it does with the money.
 *
 * WHAT CHANGED IN THE MONEY. The $0.15 AI research fee is gone. It paid for the
 * search-and-extract step that no longer happens, so `ai_research_charge` is
 * written as 0 on every row this cron touches from here on. The column stays,
 * and the two refund sites that read it (app/api/cron/sweep-business-traces and
 * lib/trace/settleBulkJob) keep working for the 1,301 historical rows that
 * carry a real value in it. Pricing is now the plain tier 1 model: a successful
 * trace bills the caller's plan rate, a miss is free.
 *
 * WHAT HAPPENS TO A ROW WITH NO OWNER NAME. Nothing, and it costs nothing. The
 * engine that used to find an owner from an address alone is gone and no
 * replacement is wired on the bulk path yet, so the row is marked with
 * BLANK_OWNER_SKIP_STATUS and the reason is served alongside it. See
 * lib/trace/blankOwnerSkip.ts. The v1 bulk route and the MCP submit no longer
 * queue such rows at all; this branch is the safety net for rows queued by an
 * earlier deployment, and it is what stops them sitting in 'queued' forever.
 *
 * WHAT HAPPENS WHEN THE VENDOR CANNOT BE REACHED. lookupBusinessTrace() never
 * throws; a lapsed API key, a blank state and a 503 all return success:false.
 * Retrying that is right, because most of it is transient, but retrying it
 * FOREVER is not: the claim below takes the five OLDEST queued rows every
 * minute, so five poisoned rows used to be re-claimed and re-queued every
 * minute and no newer row was ever reached. Each row now carries its attempt
 * number in `ai_research_status` and gives up after
 * MAX_ENTITY_TRACE_ATTEMPTS with a readable reason and no charge. See
 * lib/trace/entityTraceAttempts.ts.
 *
 * ON business_trace_jobs. That table and its sweeper are untouched and still
 * finalize every job the old engine queued. This cron adds no new rows to it:
 * lookupBusinessTrace answers on the same request, so there is no pending state
 * to record. A late FastAppend result therefore still reaches a row through
 * sweep-business-traces, which is the async recovery path, unchanged.
 */
export const maxDuration = 300;

// Unchanged from sweep-bulk-research. Each row is now far cheaper (one
// synchronous FastAppend call, plus at most one Tracerfy submit) so this is a
// conservative ceiling rather than a tight one. Raising it is safe but is a
// throughput change, not part of this removal.
const MAX_ROWS_PER_RUN = 5;

// A claim older than this is, by construction, from a cron run that was
// killed externally before it could finish (maxDuration is 300s; a healthy
// run finishes in well under that). Reverting these to 'queued' is the only
// way the row gets retried -- the next claim query only looks at 'queued'.
const STALE_CLAIM_MINUTES = 5;

/**
 * The AIResearchResult we persist for a FastAppend business trace.
 *
 * `ai_research` is still the storage shape for entity contacts: resolveOwnerContact()
 * and traceCreditFromFastAppend() both read `business_trace_contacts` out of it,
 * and sweep-business-traces merges into the same object. What is gone is the
 * SEARCH half, so the fields only the LLM could ever produce are written at
 * their honest "we do not know" values rather than invented:
 * relatives and sources are empty, is_deceased is null, property_type is
 * unknown, and there is no confidence percentage because nothing scored one.
 */
function storedEntityTrace(
  companyName: string,
  contacts: {
    ownerName: string | null;
    phones: Array<{ number: string; type: string }>;
    emails: string[];
    mailingAddress: string | null;
  } | null
): AIResearchResult {
  const person = contacts?.ownerName?.trim() || null;
  return {
    owner_name: person,
    owner_type: person ? 'individual' : 'unknown',
    business_name: companyName,
    individual_behind_business: person,
    is_deceased: null,
    deceased_details: null,
    relatives: [],
    decision_makers: person ? [person] : [],
    property_type: 'unknown',
    confidence: 0,
    confidence_reasoning:
      'No confidence score on this path. The contacts came from a FastAppend business trace keyed on the company name and state.',
    sources: [],
    business_trace_status: person
      ? `Found: ${person} (${contacts?.phones.length || 0} phones, ${contacts?.emails.length || 0} emails)`
      : `No principal returned for "${companyName}"`,
    business_trace_contacts: contacts
      ? {
          owner_name: contacts.ownerName,
          phones: contacts.phones,
          emails: contacts.emails,
          address: contacts.mailingAddress,
        }
      : null,
  };
}

/**
 * The already-collected-charge probe now lives in lib/wallet/collectedCharge.ts.
 *
 * It was local to this file until review found the same double-charge reachable
 * ACROSS files with no unusual failure at all: this cron deducts on a FastAppend
 * hit and then throws, the row is requeued, and on the retry FastAppend returns
 * nothing so the row settles down the Tracerfy path in lib/trace/settleBulkJob.ts
 * and is charged a second time. A guard that lives in only one of the two files
 * cannot see that, which is exactly why it is shared now.
 */

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  let processed = 0;
  let resolvedToPerson = 0;
  let noMatch = 0;
  let fastAppendCredited = 0;
  let skippedNoOwner = 0;
  let errored = 0;
  let staleReverted = 0;
  // Rows that used up every attempt this run and were written terminal. Not a
  // subset of `errored`: a stale claim can exhaust a row without this run ever
  // calling the vendor for it.
  let exhausted = 0;

  // Tier 1 per-successful-trace rate, resolved once per (user, track) per run.
  //
  // OWNER TYPE SELECTS THE VENDOR, NEVER THE PRICE (lessons.md L-005). This
  // cron settles the ENTITY rows of a bulk job while the job's own status route
  // settles the PERSON rows, so if the two disagree about the rate, one batch
  // bills two different prices for the same work, split by owner type. That is
  // exactly the rule David restated three times.
  //
  // THE TRACK IS THE AXIS, not the user. PTP has two price derivations and the
  // split is deliberate (lib/suite/pricing.ts): Track A (session, MCP) is
  // GRANT-AWARE, Track B (the /api/v1/* API-key surface) is RAW and does not
  // consult the gateway snapshot. This cron used the grant-aware rate for
  // everything, so on a v1 bulk job a gateway-grant holder on the wallet tier
  // paid $0.25 for person rows (raw, from the v1 status route) and $0.15 for
  // entity rows (grant-aware, from here). Same job, same work, two prices.
  //
  // Which track a row belongs to is read off its `source` tag, and the tags and
  // their meaning live in lib/suite/pricing.ts so this cron, its twin
  // sweep-business-traces, and the routes that WRITE the tag cannot drift. An
  // untagged row is Track B, which is also the RAW and dearer derivation,
  // making the fallback the safe direction.
  const tier1RateCache = new Map<string, number>();
  const tier1RateFor = async (
    userId: string,
    source: string | null | undefined
  ): Promise<number> => {
    const isTrackA = isTrackASource(source);
    const key = `${userId}:${isTrackA ? 'A' : 'B'}`;
    const cached = tier1RateCache.get(key);
    if (cached !== undefined) return cached;
    const { data: rateProfile } = await adminClient
      .from('user_profiles')
      .select('subscription_tier, is_acquisition_pro_member, gateway_products')
      .eq('id', userId)
      .single();
    const rate = !rateProfile
      ? PRICING.CHARGE_PER_SUCCESS_WALLET
      : isTrackA
        ? chargePerTrace(rateProfile)
        : getChargePerTrace(
            rateProfile.subscription_tier,
            rateProfile.is_acquisition_pro_member
          );
    tier1RateCache.set(key, rate);
    return rate;
  };

  try {
    // Stale-claim recovery: revert rows whose previous claim never finished
    // (cron killed mid-run by Vercel timeout, OOM, deploy restart, etc.) so
    // they're eligible to be re-claimed below.
    const staleCutoff = new Date(
      Date.now() - STALE_CLAIM_MINUTES * 60 * 1000
    ).toISOString();
    // One statement per rung of the ladder, because the revert has to know
    // which attempt the row was on and 'processing' alone does not say. A claim
    // that never came back IS a spent attempt: a row that kills the run every
    // time is exactly as poisonous as one the vendor keeps refusing, and
    // reverting it to attempt 1 would let it loop forever.
    for (const attempt of ENTITY_TRACE_ATTEMPTS) {
      const next = nextAfterFailedAttempt(attempt);
      const { data: revertedRows } = await adminClient
        .from('trace_history')
        .update(
          next.exhausted
            ? {
                ai_research_status: next.status,
                ai_research_claimed_at: null,
                status: 'error',
                is_successful: false,
              }
            : { ai_research_status: next.status, ai_research_claimed_at: null }
        )
        .eq('ai_research_status', processingStatusFor(attempt))
        // BOTH arms, because SQL `<` never matches NULL. A row sitting in
        // processing_N with a null ai_research_claimed_at is invisible to the
        // claim query below (which only looks at the queued rungs) and was
        // invisible to this sweep too, so nothing in the system could touch it
        // and it held its parent bulk job at 'processing' forever. No writer
        // produces that pair today -- the claim always sets the timestamp with
        // the status -- so this is a latch on a door nobody currently opens,
        // not a live bug. A claim with no timestamp is by definition older than
        // any cutoff, so treating it as stale is the honest reading.
        .or(
          `ai_research_claimed_at.is.null,ai_research_claimed_at.lt.${staleCutoff}`
        )
        .select('id');
      const moved = revertedRows?.length || 0;
      staleReverted += moved;
      if (next.exhausted) exhausted += moved;
    }
    if (staleReverted > 0) {
      console.log(
        `[sweep-entity-traces] reverted ${staleReverted} stale claim(s) older than ${STALE_CLAIM_MINUTES}m`
      );
    }

    // Claim up to N queued rows by flipping them to 'processing' first so
    // concurrent cron invocations don't double-process the same row. Every rung
    // of the retry ladder is claimable; the row's own status says which attempt
    // it is on.
    const { data: queuedRows } = await adminClient
      .from('trace_history')
      .select('*')
      .in('ai_research_status', ENTITY_QUEUED_STATUSES)
      .order('created_at', { ascending: true })
      .limit(MAX_ROWS_PER_RUN);

    if (!queuedRows || queuedRows.length === 0) {
      // `exhausted` is reported even here: the stale sweep above can retire a
      // row on its last rung without this run claiming anything at all.
      return NextResponse.json({ success: true, processed: 0, exhausted, staleReverted });
    }

    for (const row of queuedRows) {
      // Which try this is. Carried in the status itself, so it survives between
      // cron runs with no extra column. A row written before the ladder existed
      // reads as attempt 1.
      const attempt = attemptOf(row.ai_research_status);

      // What this row gets if this attempt fails, decided once so the vendor
      // branch and the catch below cannot drift apart.
      const onFailure = nextAfterFailedAttempt(attempt);
      const failRow = async (logLine: string) => {
        console.error(logLine);
        await adminClient
          .from('trace_history')
          .update(
            onFailure.exhausted
              ? {
                  // Terminal. No charge, no tier, no ai_research_charge: we
                  // never got an answer out of the vendor, and an outage on our
                  // side is not billable (L-007). The status is what releases
                  // the queue behind it and lets the parent bulk job settle.
                  ai_research_status: onFailure.status,
                  ai_research_claimed_at: null,
                  status: 'error',
                  is_successful: false,
                }
              : { ai_research_status: onFailure.status, ai_research_claimed_at: null }
          )
          .eq('id', row.id);
        if (onFailure.exhausted) exhausted++;
      };

      // Atomic claim: only proceed if we successfully flip the row out of the
      // queued status it arrived in. Another cron instance may have grabbed it
      // already. ai_research_claimed_at is the lifeline for stale-claim
      // recovery above -- always set it together with the status flip.
      const { data: claimed } = await adminClient
        .from('trace_history')
        .update({
          ai_research_status: processingStatusFor(attempt),
          ai_research_claimed_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('ai_research_status', row.ai_research_status)
        .select('id')
        .maybeSingle();

      if (!claimed) continue;

      processed++;

      try {
        // normalized_address is a pipe-delimited dedup key of exactly THREE
        // fields, street|city|state, like
        //   "160 MINE LAKE CT|RALEIGH|NC"
        // There is no zip in it. normalizeAddress() dropped it deliberately
        // (lib/utils/address-normalizer.ts, migration 20260904) because zip
        // never reached either vendor and requiring it was rejecting traceable
        // records at the door. The zip lives in its own column; do not try to
        // parse one out of this string. Pull the street portion back out before
        // handing it to a vendor, which expects a raw street address and
        // separate city/state/zip.
        const streetAddress = row.normalized_address.split('|')[0] || row.normalized_address;

        const companyName = (row.input_owner_name || '').trim();

        if (!companyName) {
          // No owner of record came in, and nothing on this path can find one
          // now that AI Search is gone. Say so, charge nothing, and leave the
          // row in a terminal state so the parent bulk job can finish. NOT a
          // bare no_match: no vendor was ever asked. No charge, no tier, and no
          // ai_research_charge is written here, which also keeps the row
          // deletable (lib/trace/billedRows.ts treats a charged row as a
          // receipt, and this one is not).
          await adminClient
            .from('trace_history')
            .update({
              ai_research_status: BLANK_OWNER_SKIP_STATUS,
              ai_research_claimed_at: null,
              status: 'no_match',
              is_successful: false,
            })
            .eq('id', row.id);
          skippedNoOwner++;
          continue;
        }

        // FastAppend is keyed on the company name plus its STATE OF
        // REGISTRATION, which is not necessarily the property state. A bulk row
        // carries only the property state, so that is what we send, exactly as
        // the old inline path did. planRoute() calls out the same fallback.
        const lookup = await lookupBusinessTrace({
          company_name: companyName,
          state: (row.state || '').trim(),
        });

        // BILL ON WHETHER WE COULD ASK, NEVER ON WHETHER WE FOUND ANYTHING.
        // success:false means the call itself failed (no key, transport error,
        // malformed body). That is our outage, not the customer's miss, and the
        // two are indistinguishable from the outside because both come back
        // with no contacts. Charge nothing either way. The claim goes back on
        // the queue for another try, one rung further up the ladder, until the
        // attempts run out and the row is written terminal instead of blocking
        // every newer row behind it.
        if (!lookup.success) {
          errored++;
          await failRow(
            `[sweep-entity-traces] business trace failed for row ${row.id} on attempt ${attempt} of ${MAX_ENTITY_TRACE_ATTEMPTS}: ${lookup.error}`
          );
          continue;
        }

        const researchForStorage = storedEntityTrace(
          companyName,
          lookup.hit ? lookup.contacts : null
        );

        // Determine the best person name to use for the follow-up person-
        // skip-trace, via the shared resolveOwnerContact precedence. This row
        // has not been traced yet, so there is no trace_result to consider --
        // passing null leaves ONE definition of "who is the human behind this
        // owner" for the whole codebase.
        const { owner_contact_name: resolvedPerson } = resolveOwnerContact({
          trace_result: null,
          ai_research: researchForStorage,
        });

        const ownerFound = !!researchForStorage.owner_name;

        // FastAppend path: the lookup produced phones/emails, so the row has
        // already delivered everything the user needs. Bill ONE tier 1
        // per-success charge at the user's plan rate and skip the per-row
        // Tracerfy submit entirely -- FastAppend's commercial-DB contacts are
        // what the user paid for.
        const fastAppendCredit = traceCreditFromFastAppend(researchForStorage);
        if (fastAppendCredit) {
          // CHARGE ONCE PER ROW, EVER. A previous attempt may have deducted and
          // then died before it could write this row back, which puts the row
          // straight back on the queue with the money already gone. The ledger
          // is the only durable record of that, so it is asked first. When it
          // answers, the amount it reports is the amount persisted: not zero,
          // which would tell the customer the row was free while their wallet
          // says otherwise, and not today's rate, which would restate a past
          // charge at a price that may since have moved.
          //
          // `> 0`, NOT `!== null`. The probe answers the NET of the row's
          // debits and credits. This file never refunds, but its two twins do
          // -- against rows this cron also settles -- so a row can arrive here
          // having collected a fee and had it handed back. That nets to 0, and
          // 0 is not a collection: treating it as one gives the row away free.
          const alreadyCollected = await collectedChargeFor(adminClient, row.id);
          const charge =
            alreadyCollected !== null && alreadyCollected > 0
              ? alreadyCollected
              : // Deduct FIRST, then persist the amount that actually moved.
                await deductOrZero(adminClient, {
                  p_user_id: row.user_id,
                  p_amount: await tier1RateFor(row.user_id, row.source),
                  p_trace_history_id: row.id,
                  p_description: 'FastAppend business-trace contacts (successful trace)',
                });

          await adminClient
            .from('trace_history')
            .update({
              ai_research: researchForStorage,
              ai_research_status: 'found',
              ai_research_charge: 0, // The research fee is retired; nothing to book.
              ai_research_claimed_at: null,
              status: 'success',
              trace_result: fastAppendCredit.trace_result,
              phone_count: fastAppendCredit.phone_count,
              email_count: fastAppendCredit.email_count,
              is_successful: true,
              cost: PRICING.COST_PER_RECORD,
              // `charge` is the LEDGER's answer and is written as-is: folding
              // it would add money already recorded to money already on the
              // row. `tier` is NOT the ledger's to answer, and a flat 1
              // silently downgrades a tier 2 receipt, so it comes from the
              // fold, which never downgrades.
              charge,
              tier: foldBillingWrite(row, { charge, tier: TRACE_TIER.PER_SUCCESSFUL_TRACE }).tier,
            })
            .eq('id', row.id);
          fastAppendCredited++;
          continue;
        }

        // No usable FastAppend contacts. Persist what the lookup did say and
        // fall through to the Tracerfy person submit. ai_research_charge is 0:
        // identifying an owner is no longer a billable step of its own.
        await adminClient
          .from('trace_history')
          .update({
            ai_research: researchForStorage,
            ai_research_status: ownerFound ? 'found' : 'not_found',
            ai_research_charge: 0,
            ai_research_claimed_at: null,
          })
          .eq('id', row.id);

        if (!resolvedPerson) {
          // FastAppend answered and had no person for us. That is a real miss,
          // and under tier 1 a miss is free.
          //
          // FREE MEANS "COLLECT NOTHING FURTHER", NOT "THIS ROW WAS ALWAYS
          // FREE". The row is REUSED, never re-inserted
          // (UNIQUE(user_id, address_hash)), so it can already carry a tier 2
          // receipt -- tier 2 bills per record SUBMITTED, which makes
          // `is_successful = false, charge > 0` a row the customer PAID for. A
          // flat `charge: 0, tier: 1` over it erased that receipt while
          // wallet_transactions still referenced the row by FK. Folding a
          // collection of 0 changes nothing on a row that never paid, and
          // preserves one that did.
          const billing = foldBillingWrite(row, {
            charge: 0,
            tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
          });
          await adminClient
            .from('trace_history')
            .update({
              status: 'no_match',
              is_successful: false,
              charge: billing.charge,
              tier: billing.tier,
            })
            .eq('id', row.id);
          noMatch++;
          continue;
        }

        // Submit a per-row Tracerfy person-skip-trace for the resolved name.
        const submitResult = await submitSingleTrace({
          address: streetAddress,
          city: row.city || '',
          state: row.state || '',
          zip: row.zip || '',
          owner_name: resolvedPerson,
        });

        if (!submitResult.success || !submitResult.jobId) {
          console.error(
            `[sweep-entity-traces] Tracerfy submit failed for row ${row.id}: ${submitResult.error}`
          );
          // No FastAppend contacts (already established above) and the
          // Tracerfy submit also failed -- mark no_match. Free either way, and
          // folded for the same reason as the miss arm above: free means
          // "collect nothing further", never "this row was always free".
          const billing = foldBillingWrite(row, {
            charge: 0,
            tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
          });
          await adminClient
            .from('trace_history')
            .update({
              status: 'no_match',
              is_successful: false,
              charge: billing.charge,
              tier: billing.tier,
            })
            .eq('id', row.id);
          noMatch++;
          continue;
        }

        // Row now has its own Tracerfy job; status endpoint will poll it.
        await adminClient
          .from('trace_history')
          .update({
            tracerfy_job_id: submitResult.jobId,
          })
          .eq('id', row.id);
        resolvedToPerson++;
      } catch (err) {
        errored++;
        // Same ladder as the vendor failure above. Retry a transient throw,
        // give up honestly on a row that throws every time rather than let it
        // hold the five-oldest claim window shut.
        await failRow(
          `[sweep-entity-traces] row ${row.id} processing error on attempt ${attempt} of ${MAX_ENTITY_TRACE_ATTEMPTS}: ${err}`
        );
      }
    }

    return NextResponse.json({
      success: true,
      processed,
      resolvedToPerson,
      noMatch,
      fastAppendCredited,
      skippedNoOwner,
      errored,
      exhausted,
      staleReverted,
    });
  } catch (error) {
    console.error('[sweep-entity-traces] fatal error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
