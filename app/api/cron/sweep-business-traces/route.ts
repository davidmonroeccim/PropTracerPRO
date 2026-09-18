import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getBusinessTraceStatus, downloadBusinessTraceResults } from '@/lib/tracerfy/client';
import { traceCreditFromFastAppend } from '@/lib/ai-research/contacts';
import { deductOrZero } from '@/lib/wallet/deduct';
import { collectedChargeFor } from '@/lib/wallet/collectedCharge';
import { PRICING, getChargePerTrace } from '@/lib/constants';
import { chargePerTrace, isTrackASource } from '@/lib/suite/pricing';
import { TRACE_TIER, foldBillingWrite, isCacheHitRow } from '@/lib/trace/billedRows';
import type { AIResearchResult, BusinessTraceJob } from '@/types';

/**
 * Vercel Cron: sweeps `business_trace_jobs` rows stuck in 'pending'.
 *
 * These are FastAppend business-trace jobs that were queued during AI research
 * but didn't complete within the 45-second inline poll in resolveEntityChain().
 * FastAppend can take minutes to hours to finish; this cron polls each pending
 * job, downloads results when ready, merges them into trace_history.ai_research,
 * and fires a `business_trace.completed` webhook to the user's configured URL.
 *
 * Runs every 5 minutes. Jobs older than 24 hours that are still pending are
 * marked as 'error' and skipped on subsequent runs.
 */
const STALE_HOURS = 24;
const MAX_JOBS_PER_RUN = 50;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminClient = createAdminClient();
  const now = Date.now();
  const staleCutoff = new Date(now - STALE_HOURS * 60 * 60 * 1000).toISOString();

  let swept = 0;
  let resolved = 0;
  let stillPending = 0;
  let erroredStale = 0;

  // Tier 1 per-successful-trace rate, resolved once per (user, track) per run.
  // Owner type selects the VENDOR, not the price, so a FastAppend entity success
  // bills the same plan rate a Tracerfy person success does.
  //
  // THE TRACK IS THE AXIS, not the user, and this is the same rule its twin
  // sweep-entity-traces:178 follows. PTP has two price derivations
  // (lib/suite/pricing.ts): Track A (session, MCP) is GRANT-AWARE, Track B (the
  // /api/v1/* API-key surface) is RAW. This cron used the grant-aware rate for
  // every row, so a gateway-grant holder on the wallet tier settling a v1 job
  // paid $0.15 for the entity row this cron recovered and $0.25 for the person
  // rows the v1 status route settled beside it. Same job, same work, two prices.
  //
  // An untagged row is Track B, which is also the dearer derivation, so the
  // fallback errs in the safe direction.
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
    // Mark anything older than 24h as error before working the rest
    await adminClient
      .from('business_trace_jobs')
      .update({
        status: 'error',
        error_message: `Timed out after ${STALE_HOURS}h`,
        completed_at: new Date().toISOString(),
      })
      .eq('status', 'pending')
      .lt('created_at', staleCutoff);

    // Pull the remaining pending jobs
    const { data: pendingJobs } = await adminClient
      .from('business_trace_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(MAX_JOBS_PER_RUN);

    if (!pendingJobs || pendingJobs.length === 0) {
      return NextResponse.json({ success: true, swept: 0, resolved: 0, stillPending: 0 });
    }

    for (const job of pendingJobs as BusinessTraceJob[]) {
      swept++;

      const statusResult = await getBusinessTraceStatus(job.fastappend_queue_id);

      if (!statusResult.success) {
        console.error(`[sweep-business-traces] status error for job ${job.id}: ${statusResult.error}`);
        continue;
      }

      if (statusResult.pending) {
        stillPending++;
        continue;
      }

      // Not pending: attempt to download the results
      let parsed = null;
      if (statusResult.downloadUrl) {
        parsed = await downloadBusinessTraceResults(statusResult.downloadUrl);
      }

      const finalStatus = parsed && (parsed.owner_name || parsed.phones.length > 0 || parsed.emails.length > 0)
        ? 'completed'
        : 'no_match';

      // Update the business_trace_jobs row
      await adminClient
        .from('business_trace_jobs')
        .update({
          status: finalStatus,
          result: parsed,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      // Merge contacts into the linked trace_history row, if one exists
      let mergedResearch: AIResearchResult | null = null;
      if (job.address_hash) {
        const { data: historyRow } = await adminClient
          .from('trace_history')
          // `tier`, `property_record` and `source` are not decoration:
          // isCacheHitRow() reads the first two to decide whether this row has
          // already been paid for, and `source` decides which price derivation
          // a re-bill would use. Selecting `charge` and never reading it is how
          // the upgrade arm below came to overwrite a larger receipt with a
          // smaller rate.
          .select(
            'id, ai_research, status, is_successful, charge, tier, property_record, source, ai_research_charge, trace_job_id'
          )
          .eq('user_id', job.user_id)
          .eq('address_hash', job.address_hash)
          .limit(1)
          .maybeSingle();

        if (historyRow) {
          const existing = (historyRow.ai_research || {}) as AIResearchResult & Record<string, unknown>;

          // Merge contacts discovered by FastAppend into decision_makers + sources.
          // We don't overwrite fields the AI already found — we append.
          const updatedDecisionMakers = Array.isArray(existing.decision_makers)
            ? [...existing.decision_makers]
            : [];

          if (parsed?.owner_name && !updatedDecisionMakers.includes(parsed.owner_name)) {
            updatedDecisionMakers.push(parsed.owner_name);
          }

          mergedResearch = {
            ...existing,
            decision_makers: updatedDecisionMakers,
            business_trace_status: finalStatus === 'completed'
              ? `Recovered async: ${parsed?.owner_name || 'unnamed'} (${parsed?.phones.length || 0} phones, ${parsed?.emails.length || 0} emails)`
              : `Recovered async: no match for "${job.business_name || ''}"`,
          } as AIResearchResult;

          // Stash the full FastAppend contact payload on the research object
          // under a dedicated field so downstream consumers can find phones/emails.
          (mergedResearch as AIResearchResult & { business_trace_contacts?: typeof parsed }).business_trace_contacts = parsed;

          // If AI research didn't find an owner but FastAppend did, promote it
          if (!existing.owner_name && parsed?.owner_name) {
            mergedResearch.owner_name = parsed.owner_name;
            mergedResearch.individual_behind_business = parsed.owner_name;
          }

          // Re-evaluate billing for this row now that FastAppend has landed.
          // If the row was previously finalised as no_match (with a research
          // charge already booked) and FastAppend now provides phones/emails,
          // refund the research charge and apply ONE tier 1 per-success charge
          // at the user's plan rate, so the user is billed once for a
          // successful row. Rows already credited as success are left alone.
          //
          // THE GUARD IS isCacheHitRow, NOT `!is_successful`, AND THE
          // DIFFERENCE IS MONEY. `is_successful = false` AND `charge > 0` is
          // not a failed row: tier 2 bills per record SUBMITTED, so a county
          // with no parcel at that address is a row the customer PAID for.
          // `!is_successful` matches that shape exactly, so this arm fired on
          // precisely the rows it must not touch -- taking a second tier 1
          // charge and writing the smaller rate over the larger receipt, while
          // downgrading `tier` so isCacheHitRow stopped serving the row and the
          // customer re-bought the same absence. The row stayed non-zero
          // throughout, so it never tripped the 23503 lockout that makes the
          // other sites loud. Nothing surfaced it.
          //
          // isCacheHitRow is the one definition of "the customer already has
          // this, free" (lib/trace/billedRows.ts), and it is strictly narrower
          // than the old test: it still admits the 1,301 historical rows this
          // arm exists for, which carry an ai_research_charge, no trace charge
          // and no property record.
          //
          // TWO GATES, AND THEY ARE NOT THE SAME GATE. **STATUS IS NOT A
          // RECEIPT.**
          //
          // DELIVERY (`shouldDeliver`): has FastAppend produced contacts for a
          // row that is not already recorded as successful? If so the row gets
          // its status, trace_result and counts, FULL STOP. Withholding them
          // from a row the customer PAID for is the worse failure of the two:
          // lib/trace/exportCsv reads `trace_result`, so the CSV would show six
          // blank contact columns while v1 and the MCP, which read
          // `ai_research.business_trace_contacts`, show the contacts -- the same
          // row described two different ways by two of our own surfaces.
          //
          // MONEY (`shouldBill`): strictly narrower. `is_successful = false` AND
          // `charge > 0` is not a failed row -- tier 2 bills per record
          // SUBMITTED, so a county with no parcel at that address is a row the
          // customer already paid for. The old `!is_successful` test matched
          // that shape exactly, so this arm took a SECOND tier 1 charge and
          // wrote the smaller rate over the larger receipt, downgrading `tier`
          // on the way so the customer re-bought the same absence. The row
          // stayed non-zero throughout, so it never tripped the 23503 lockout
          // that makes the other sites loud. Nothing surfaced it.
          //
          // isCacheHitRow is the one definition of "the customer already has
          // this, free" (lib/trace/billedRows.ts). It still admits the 1,301
          // historical rows this arm exists for, which carry an
          // ai_research_charge, no trace charge and no property record.
          const fastAppendCredit = traceCreditFromFastAppend(mergedResearch);
          const shouldDeliver = !!fastAppendCredit && !historyRow.is_successful;
          const shouldBill = !!fastAppendCredit && !isCacheHitRow(historyRow);

          // The money, resolved first and ONLY behind the billing gate. Null
          // when nothing was collected, which is what keeps `charge`, `tier` and
          // `ai_research_charge` out of the delivery write below: a refund that
          // did not happen must not zero the fee it would have handed back.
          let collected: { charge: number; tier: number } | null = null;
          if (shouldBill) {
            const tier1Rate = await tier1RateFor(job.user_id, historyRow.source);
            const priorResearchCharge = historyRow.ai_research_charge || 0;
            if (priorResearchCharge > 0) {
              await adminClient.rpc('credit_wallet_balance', {
                p_user_id: job.user_id,
                p_amount: priorResearchCharge,
                p_description:
                  'Refund: AI research folded into the successful trace charge',
                // THE REFUND NAMES THE ROW IT REFUNDS, and the probe two lines
                // below is the reason. It sums wallet_transactions for this row;
                // an unlinked credit is invisible to it, so the money we just
                // handed back would still read as collected, the deduct would be
                // skipped, and the customer would get the contacts free while
                // `charge` reported an amount that had been returned. Migration
                // 20260917 added this parameter for exactly this call.
                p_trace_history_id: historyRow.id,
              });
            }
            // CHARGE ONCE PER ROW, EVER. One trace_history row is reachable by
            // all three settle paths -- this cron, sweep-entity-traces and
            // lib/trace/settleBulkJob -- and a debit booked by ANY of them
            // means the customer has already paid for it. That is why the probe
            // is shared (lib/wallet/collectedCharge.ts) rather than local to one
            // file: a guard living in only one of the three cannot see the
            // other two. This was the door without it.
            //
            // When the ledger answers, the amount it reports is what gets
            // persisted: not zero, which would tell the customer the row was
            // free while their wallet says otherwise, and not today's rate,
            // which would restate a past charge at a price that may have moved.
            //
            // `> 0`, NOT `!== null`. The probe answers the NET of the row's
            // debits and credits, so the refund issued immediately above is
            // already subtracted from it. A row whose only debit was that
            // research fee comes back as 0 -- money collected and given back --
            // and 0 is not a collection: skipping the deduct on it is how the
            // customer ends up with the contacts for free.
            const alreadyCollected = await collectedChargeFor(adminClient, historyRow.id);
            const charge =
              alreadyCollected !== null && alreadyCollected > 0
                ? alreadyCollected
                : // Persist the amount that actually moved, not the intended one.
                  await deductOrZero(adminClient, {
                    p_user_id: job.user_id,
                    p_amount: tier1Rate,
                    p_trace_history_id: historyRow.id,
                    p_description:
                      'FastAppend business-trace contacts (successful trace, async)',
                  });

            // THE LEDGER TOTAL, WRITTEN RAW -- the same rule its two twins
            // follow. `collectedChargeFor` returns every debit booked against
            // this row, so once the probe above has run the ledger is
            // authoritative and folding its answer onto the row's own column
            // would count the same debit twice. On the other branch the probe
            // found nothing, so the deduct we just made IS the whole total.
            //
            // `tier` is NOT the ledger's to answer, and a flat 1 would silently
            // downgrade a tier 2 receipt, so it still comes from the fold, which
            // never downgrades.
            collected = {
              charge,
              tier: foldBillingWrite(historyRow, {
                charge,
                tier: TRACE_TIER.PER_SUCCESSFUL_TRACE,
              }).tier,
            };
          }

          if (shouldDeliver && fastAppendCredit) {
            await adminClient
              .from('trace_history')
              .update({
                ai_research: mergedResearch,
                ai_research_status: 'found',
                status: 'success',
                trace_result: fastAppendCredit.trace_result,
                phone_count: fastAppendCredit.phone_count,
                email_count: fastAppendCredit.email_count,
                is_successful: true,
                cost: PRICING.COST_PER_RECORD,
                // Money only when money moved.
                ...(collected
                  ? {
                      ai_research_charge: 0,
                      charge: collected.charge,
                      tier: collected.tier,
                    }
                  : {}),
              })
              .eq('id', historyRow.id);

            // Bump the parent bulk job's records_matched so the totals
            // surfaced to the agent stay correct after async credit.
            //
            // This sits with the DELIVERY, not with the billing, because it
            // counts matched RECORDS and not collected money. It is reached
            // exactly once per row: `shouldDeliver` requires the row was not
            // already `is_successful`, and this write makes it so.
            if (historyRow.trace_job_id) {
              const { data: parentJob } = await adminClient
                .from('trace_jobs')
                .select('records_matched')
                .eq('id', historyRow.trace_job_id)
                .single();
              if (parentJob) {
                await adminClient
                  .from('trace_jobs')
                  .update({
                    records_matched: (parentJob.records_matched || 0) + 1,
                  })
                  .eq('id', historyRow.trace_job_id);
              }
            }
          } else {
            // Nothing to deliver -- just persist the merged research data
            // (FastAppend either didn't find contacts, or the row is already
            // recorded as a success and its own trace_result must not be
            // overwritten by this one).
            await adminClient
              .from('trace_history')
              .update({
                ai_research: mergedResearch,
                ai_research_status: mergedResearch.owner_name
                  ? 'found'
                  : ((existing.ai_research_status as string) || 'not_found'),
              })
              .eq('id', historyRow.id);
          }
        }
      }

      // Fire webhook
      const { data: profile } = await adminClient
        .from('user_profiles')
        .select('webhook_url')
        .eq('id', job.user_id)
        .single();

      if (profile?.webhook_url) {
        try {
          await fetch(profile.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'business_trace.completed',
              business_trace_job_id: job.id,
              status: finalStatus,
              business_name: job.business_name,
              address: job.normalized_address,
              city: job.city,
              state: job.property_state,
              zip: job.zip,
              contacts: parsed,
              research: mergedResearch,
              timestamp: new Date().toISOString(),
            }),
          });

          await adminClient
            .from('business_trace_jobs')
            .update({ webhook_dispatched: true })
            .eq('id', job.id);
        } catch (err) {
          console.error(`[sweep-business-traces] webhook dispatch error for job ${job.id}:`, err);
        }
      }

      resolved++;
    }

    console.log(`[sweep-business-traces] swept=${swept} resolved=${resolved} stillPending=${stillPending}`);

    return NextResponse.json({
      success: true,
      swept,
      resolved,
      stillPending,
      erroredStale,
    });
  } catch (error) {
    console.error('[sweep-business-traces] error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
