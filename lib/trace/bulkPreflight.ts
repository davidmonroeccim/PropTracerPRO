/**
 * THE TWO PRE-FLIGHT CHECKS A BULK SUBMIT RUNS BEFORE IT ACCEPTS TIER 2 WORK,
 * AND THE SIZING THAT TURNS THE WALLET CHECK FROM A GLANCE INTO A RESERVE.
 *
 * | check                    | question                | on failure                       |
 * |--------------------------|-------------------------|----------------------------------|
 * | the customer's wallet    | can the CUSTOMER pay?   | 402, and tell them to add funds  |
 * | PTP's Tracerfy credits   | can PTP EXECUTE?        | refuse, and NEVER mention funds  |
 *
 * THEY MUST NEVER BE MERGED. Billing a customer for a job we cannot run is the
 * outcome the second one exists to prevent, and the two fail for opposite
 * reasons so they are owed opposite sentences. A short wallet is a fact about
 * the customer's balance and it is safe and useful to say so. A short credit
 * pool is a fact about OURS, and saying it to them in the first check's words
 * blames them for our shortage and invites them to spend money that fixes
 * nothing.
 *
 * THE CAPACITY REFUSAL IS SILENT, AND THAT IS A DECISION, NOT AN OVERSIGHT.
 * David, 2026-09-18. PTP has no alerting channel: no Sentry, no email provider,
 * no Slack, and lib/suite/alert.ts is one tagged console.error whose own
 * docstring says to wire it to a real channel before production. David chose no
 * alert over a fake one, so no string here may claim anyone was notified,
 * because nobody is. The console.error below is the only place this can ever
 * reach an operator, which is why it is not optional.
 *
 * WHERE THE LINE BETWEEN A REFUSAL AND A 500 SITS. A vendor we cannot read is a
 * capacity ANSWER: we do not know that we can run the job, so we do not accept
 * it. Our own table failing is not an answer at all, it is an infrastructure
 * failure, and it is raised so the route's catch reports it as ours. Dressing
 * one up as the other would tell a customer our credit pool is short when what
 * actually happened is that a query timed out.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAnalytics } from '@/lib/tracerfy/client';
import { STALE_PROCESSING } from '@/lib/constants';
import {
  PROPERTY_TRACE_PENDING_STATUSES,
  isPropertyTracePending,
} from '@/lib/trace/propertyTraceAttempts';
import { TIER1_PENDING_STATUSES, isTier1QueuePending } from '@/lib/trace/tier1Queue';

/**
 * What one queued tier 2 record costs the SHARED Tracerfy pool, in credits.
 *
 * THIS IS A FLOOR, NOT A CEILING, AND THAT IS DELIBERATE. It is the dossier
 * leg, which every tier 2 record spends and which is what actually draws this
 * pool. The contact leg that follows draws it too, but only for an INDIVIDUAL
 * owner (Tracerfy's person lookup, 5 more credits); an ENTITY owner's contact
 * leg goes to FastAppend, a different vendor with a separate pool, and costs
 * this one nothing.
 *
 * At submit time the owner type is unknown BY DEFINITION -- the dossier is what
 * discovers it -- so the check has to size on one number. Measured rates say 22
 * of 24 commercial owners are entities, so sizing at 15 would refuse jobs PTP
 * can comfortably run in order to guard against the 1-in-12 case. Sizing at 10
 * accepts that an all-individual job would draw half as much again as this
 * check reserved.
 *
 * THE INDIVIDUAL CONTACT LEG IS NOT THE ONLY THING THIS UNDER-COUNTS, AND A
 * READER WHO STOPS AT THE PARAGRAPH ABOVE WILL THINK IT IS. Tier 1 person
 * traces draw the SAME Tracerfy account balance, both the ones in the batch
 * being submitted and the ones already in flight, and neither appears in
 * `needed` nor in the queued term below. The `newRecords <= 0` short circuit
 * goes further: a 500-record all-tier-1 batch never reads the balance at all.
 * That is inside the brief, which scoped this check to tier 2 sizing, so it is
 * deliberate rather than missed -- but it means the real headroom is always
 * lower than this function computes, in three directions rather than one.
 *
 * What makes the whole floor safe is that running short mid-job is not a
 * billing event: a vendor we could not ask is our outage, not the customer's
 * miss (L-007), so the cron's retry ladder absorbs it and the row settles free.
 * The cost of under-sizing is a slow honest failure. The cost of over-sizing is
 * refusing work we could have done. This check exists to stop one obviously
 * oversized job from eating the pool, not to be an accounting of it.
 */
export const TRACERFY_DOSSIER_CREDITS = 10;

/**
 * The sentence a customer reads when PTP's own credit pool cannot cover their
 * job.
 *
 * IT MAY NOT MENTION THEIR MONEY. Not their wallet, not their balance, not
 * adding funds. Their wallet is fine; ours is the problem, and pointing them at
 * a top-up they do not need would take money for a fix that changes nothing.
 * The 402 in the submit routes is the only place funds are ever mentioned.
 *
 * It may not claim anyone was told either, because nobody was: PTP has no
 * alerting channel and David chose no alert over a fake one.
 *
 * No price, for the same reason the sibling constants in
 * lib/trace/propertyTraceAttempts.ts carry none: four rates exist and each
 * caller has exactly one of them. It does say they were not charged, which is
 * true and is the thing they most want to know.
 */
export const TIER2_CAPACITY_REFUSAL =
  'We cannot run a full property trace on these records right now, so nothing was submitted and you were not charged. Send them again later and we will run them.';

/** Rows this module reads, named so a schema rename fails at compile time. */
interface UnsettledRow {
  status: string | null;
  property_trace_status: string | null;
  ai_research_status: string | null;
}

/**
 * Can PTP's shared Tracerfy pool cover `newRecords` more tier 2 records?
 *
 * SIZED AGAINST WHAT IS ALREADY QUEUED, NOT THE RAW BALANCE. The pool is shared
 * across every customer's jobs, so a check that looks only at the balance
 * passes for two jobs that cannot both run: each sees the same credits and
 * neither sees the other. The queued term is what makes the second one wait.
 * Every rung of the retry ladder counts, claimed rows included, because a row
 * mid-retry still owes the pool a dossier.
 *
 * Returns false rather than throwing on a capacity answer, and throws on OUR
 * failure. See the file header for why those are different.
 */
export async function tracerfyCanRunTier2(
  admin: SupabaseClient,
  newRecords: number
): Promise<boolean> {
  // A tier 1 only batch draws no dossier credits at all, so there is no
  // question to ask and no reason to spend a vendor round trip asking it.
  if (newRecords <= 0) return true;

  const analytics = await getAnalytics();
  const balance = analytics.data?.balance;
  if (!analytics.success || typeof balance !== 'number') {
    // AN UNREADABLE BALANCE IS NOT A BALANCE OF PLENTY. Assuming one here would
    // invent the answer to the only question this check exists to ask, which is
    // the one thing this project is least allowed to do. Refusing costs a
    // customer a retry; assuming costs them a job we take payment for and
    // cannot run.
    console.error(
      `[bulk-preflight] refusing ${newRecords} tier 2 record(s): could not read the Tracerfy balance (${analytics.error || 'no balance in the analytics response'})`
    );
    return false;
  }

  const { count, error } = await admin
    .from('trace_history')
    .select('id', { count: 'exact', head: true })
    .in('property_trace_status', PROPERTY_TRACE_PENDING_STATUSES);

  if (error) {
    throw new Error(`could not size the Tracerfy queue: ${error.message}`);
  }

  const queued = count ?? 0;
  const needed = (newRecords + queued) * TRACERFY_DOSSIER_CREDITS;

  if (needed > balance) {
    // THE ONLY SURFACE THIS EVER REACHES AN OPERATOR THROUGH. There is no
    // alerting channel to raise instead, so a pool running dry is invisible
    // without this line.
    console.error(
      `[bulk-preflight] refusing ${newRecords} tier 2 record(s): needs ${needed} Tracerfy credit(s) against a balance of ${balance}, with ${queued} record(s) already queued`
    );
    return false;
  }

  return true;
}

/**
 * Money this user already owes on work PTP has accepted and not yet billed, in
 * dollars.
 *
 * WHY THE SUBMIT CHECK NEEDS IT. Until now that check was a bare comparison
 * against `wallet_balance` and reserved nothing: neither submit route writes
 * that column, and the real debit happens per record at settle time. So two
 * jobs submitted back to back both passed against the same dollars. Settlement
 * fails closed, so no customer was ever harmed and no balance went negative,
 * which is why it went unnoticed -- PTP simply ate the vendor spend and
 * collected nothing. At tier 2 that is up to 500 records of real spend.
 *
 * WHAT COUNTS AS IN FLIGHT, AND WHY THIS POPULATION. A row is in flight when
 * PTP has accepted it and the money for it has not moved yet:
 *
 *   a pending tier 2 row   the cron WILL bill it, per record submitted, whether
 *                          or not it finds anything. Certain money.
 *   a processing tier 1 row  a status route MAY bill it, per successful trace.
 *                          Reserved in full because the worst case is what a
 *                          reserve is for, and because a wallet sized for the
 *                          best case is the one that comes up short.
 *   a queued tier 1 row    the Tier 1 cron WILL work it and MAY bill it, per successful trace.
 *                          Reserved in full and NOT age-bounded, unlike the bare processing row
 *                          above: that bound exists for an ORPHANED single-trace row nothing can
 *                          resolve, and a queued bulk row is not orphaned. Its ladder and the
 *                          cron's stale-claim sweep guarantee it reaches a terminal, so it is the
 *                          same kind of certainty a pending tier 2 row has, and under-reserving
 *                          certain money is the wrong direction to fail in.
 *
 * A settled row is excluded because it has already been billed; reserving for
 * it twice would refuse a wallet that has already paid.
 *
 * THE TIER 1 ARM IS AGE-BOUNDED AND THE TIER 2 ARM IS NOT, AND THE ASYMMETRY IS
 * THE POINT. A tier 1 row can be ORPHANED at `status: 'processing'`: a billed
 * row inside a job already marked completed is invisible to both stages of
 * sweep-stale-traces (stage 2 only claims jobs still processing, stage 1 only
 * rows with no parent job), so nothing ever resolves it. Unbounded, 40 such rows
 * would reserve $10 of a customer's wallet permanently, and their 402 would
 * describe traces as still running that will never run and never be billed. That
 * is the same harm the capacity refusal's wording rules exist to prevent,
 * arriving through the other check.
 *
 * STALE_PROCESSING.CRON_TIMEOUT_MINUTES is the bound because it is the age at
 * which the system ITSELF declares a processing row stale and resolves it. Past
 * that, a row still sitting there is orphaned by the system's own definition,
 * and the reserve and the sweep now agree about what "still running" means
 * rather than each having a private answer.
 *
 * A tier 2 row needs no such bound and must not have one. It is bounded already,
 * by MAX_PROPERTY_TRACE_ATTEMPTS and the cron's stale-claim recovery, so it
 * always reaches a terminal value. Bounding it by age instead would stop
 * reserving for a row that IS going to be billed, and under-reserving certain
 * money is the wrong direction to fail in.
 *
 * THIS IS A RESERVE, NOT A LOCK, AND THE DIFFERENCE IS HONEST. Nothing here
 * takes a row out of anyone else's reach: it reads accepted work and prices it.
 * The window it does not close is the few hundred milliseconds between one
 * submit reading this number and writing its own rows, so two requests landing
 * inside that window can still both pass. Closing that properly needs a hold
 * written in the same transaction as the check, which is a migration and is not
 * this task. What it does close is the case that was actually reachable and
 * actually observed: a user submitting a second job after the first one's rows
 * are on the table.
 */
export async function inFlightUnbilledCost(
  admin: SupabaseClient,
  userId: string,
  rates: { tier1: number; tier2: number }
): Promise<number> {
  // The tier 1 arm carries the age bound, the tier 2 arm deliberately does not.
  // Written as one `or` with a nested `and` so the database does the filtering:
  // a tier 1 row older than the cutoff is never returned at all, while a tier 2
  // row on any rung of the ladder is returned however old it is.
  const tier1Cutoff = new Date(
    Date.now() - STALE_PROCESSING.CRON_TIMEOUT_MINUTES * 60 * 1000
  ).toISOString();

  const { data, error } = await admin
    .from('trace_history')
    .select('status, property_trace_status, ai_research_status')
    .eq('user_id', userId)
    .or(
      `and(status.eq.processing,created_at.gte.${tier1Cutoff}),property_trace_status.in.(${PROPERTY_TRACE_PENDING_STATUSES.join(',')}),ai_research_status.in.(${TIER1_PENDING_STATUSES.join(',')})`
    );

  if (error) {
    // NOT ZERO. Zero is the claim that this user owes nothing, and making that
    // claim because a query failed is precisely the fabricated result the
    // reserve exists to stop anyone acting on. The route's catch owns this.
    throw new Error(`could not size in-flight work: ${error.message}`);
  }

  let total = 0;
  for (const row of (data || []) as UnsettledRow[]) {
    // ELSE-IF, NOT THREE IFS. A queued row of EITHER tier is also `status: 'processing'`, so
    // counting more than one column would reserve two rates added together for a row that can
    // only ever cost one of them, and 402 a wallet that can afford the batch.
    //
    // TIER 2 FIRST, for the reason lib/trace/rowSkipReason.ts orders the two queues the same way:
    // it is certain money, billed per record submitted whatever the result.
    if (isPropertyTracePending(row.property_trace_status)) total += rates.tier2;
    else if (isTier1QueuePending(row.ai_research_status)) total += rates.tier1;
    else if (row.status === 'processing') total += rates.tier1;
  }
  return total;
}
