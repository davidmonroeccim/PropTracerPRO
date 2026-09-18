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
import {
  PROPERTY_TRACE_PENDING_STATUSES,
  isPropertyTracePending,
} from '@/lib/trace/propertyTraceAttempts';

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
 * What makes that safe is that running short mid-job is not a billing event: a
 * vendor we could not ask is our outage, not the customer's miss (L-007), so
 * the cron's retry ladder absorbs it and the row settles free. The cost of
 * under-sizing is a slow honest failure. The cost of over-sizing is refusing
 * work we could have done. The floor is the right side to err on.
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
 *
 * A settled row is excluded because it has already been billed; reserving for
 * it twice would refuse a wallet that has already paid.
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
  const { data, error } = await admin
    .from('trace_history')
    .select('status, property_trace_status')
    .eq('user_id', userId)
    .or(
      `status.eq.processing,property_trace_status.in.(${PROPERTY_TRACE_PENDING_STATUSES.join(',')})`
    );

  if (error) {
    // NOT ZERO. Zero is the claim that this user owes nothing, and making that
    // claim because a query failed is precisely the fabricated result the
    // reserve exists to stop anyone acting on. The route's catch owns this.
    throw new Error(`could not size in-flight work: ${error.message}`);
  }

  let total = 0;
  for (const row of (data || []) as UnsettledRow[]) {
    // ELSE-IF, NOT TWO IFS. A queued tier 2 row is ALSO `status: 'processing'`,
    // so counting both columns would reserve the two rates added together for a
    // row that can only ever cost one of them, and 402 a wallet that can afford
    // the batch.
    if (isPropertyTracePending(row.property_trace_status)) total += rates.tier2;
    else if (row.status === 'processing') total += rates.tier1;
  }
  return total;
}
