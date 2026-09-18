// One place that knows how to read the answer `deduct_wallet_balance` gives.
//
// `deduct_wallet_balance` RETURNS BOOLEAN (supabase/schema.sql:290). When the
// wallet balance is short it returns FALSE and does NOT move any money. Call
// sites that ignore that return value and then write the intended amount into
// `trace_history.charge` record revenue that was never collected -- and the
// dashboard and history pages now SUM `trace_history.charge`, so that phantom
// charge is shown straight back to the customer as money they paid.
//
// The rule this helper enforces: the amount you persist is the amount that
// actually moved. Deduct FIRST, then write what `deductOrZero` hands back.

export type DeductWalletArgs = {
  /** Wallet owner: always the local user_profiles.id, never request input. */
  p_user_id: string;
  p_amount: number;
  p_trace_history_id?: string | null;
  p_description: string;
};

/** Structural shape of the client -- any Supabase client satisfies it. */
type RpcClient = {
  rpc: (fn: string, args: DeductWalletArgs) => unknown;
};

/**
 * WHY THERE ARE THREE OUTCOMES AND NOT TWO.
 *
 * Until 2026-09-17 this helper answered a single number, and 0 meant two
 * entirely different things: the wallet genuinely came up short, and the RPC
 * itself never ran (transport, Postgres, a bad envelope). Both call sites then
 * told the customer "the wallet did not cover this record", so a customer with
 * a full wallet was told they were short. That is a false statement about
 * money, and it points the blame at them for our failure.
 *
 * - `charged`: the money moved. `collected` is the amount.
 * - `insufficient_balance`: the function returned FALSE and moved nothing.
 *   This is a fact about the customer's balance and it is safe to say so.
 * - `error`: we could not ask. OUR failure, never theirs, and nothing moved.
 */
export type DeductOutcome = 'charged' | 'insufficient_balance' | 'error';

export interface DeductResult {
  /** The amount that ACTUALLY moved. 0 for both failure outcomes. */
  collected: number;
  outcome: DeductOutcome;
  /** Present only on `error`, for the log. Never shown to the customer. */
  message?: string;
}

/**
 * Runs `deduct_wallet_balance` and reports what happened as well as how much.
 *
 * Envelope handling -- deliberate choice: only two things PROVE the money did
 * not move, an explicit `false` from the function (insufficient balance) and a
 * transport/Postgres `error`. Everything else, including a missing envelope or
 * a missing `data` key, is treated as success.
 *
 * Why not fail closed on `undefined`? Production supabase-js always resolves
 * `{ data, error }`, and for a `RETURNS BOOLEAN` function `data` is always the
 * literal boolean -- so a bare `undefined` can only come from a loose test
 * double. Failing closed there would silently rewrite every such test's
 * expectation to `charge: 0` and hide whether the real guard works. A genuine
 * runtime failure still arrives as `error`, which IS caught, so nothing real is
 * masked; and a genuine `false` is never swallowed, which is the bug this
 * exists to kill.
 */
export async function deductWallet(
  client: RpcClient,
  args: DeductWalletArgs
): Promise<DeductResult> {
  const envelope = (await client.rpc('deduct_wallet_balance', args)) as
    | { data?: unknown; error?: unknown }
    | null
    | undefined;

  if (envelope?.error) {
    const err = envelope.error as { message?: string };
    return {
      collected: 0,
      outcome: 'error',
      message: typeof err?.message === 'string' ? err.message : String(envelope.error),
    };
  }

  if (envelope?.data === false) {
    return { collected: 0, outcome: 'insufficient_balance' };
  }

  return { collected: args.p_amount, outcome: 'charged' };
}

/**
 * The amount ACTUALLY charged, and nothing about why it was not.
 *
 * Kept as the narrow answer for the call sites that only ever write the number
 * into a row. Anywhere the customer is TOLD something about the failure, call
 * `deductWallet` instead: this signature cannot tell a short wallet from a
 * broken RPC, and saying the wrong one is the defect it was split to fix.
 *
 * WHY THIS ONE LOGS AND `deductWallet` DOES NOT. The return value collapses
 * three outcomes into one number, and that is correct -- `collected` means the
 * amount that moved, and nothing moved in either failure. What was wrong is
 * that both failures were also SILENT. A settle path that takes this answer
 * writes the row DELIVERED at `charge: 0`: shared-pool vendor credits spent,
 * nothing collected, and no log, no counter and no warning anywhere. An empty
 * wallet and a broken database produced byte-identical evidence.
 *
 * So the distinction the caller threw away is recorded here instead, at the one
 * place that still knows it. A short wallet is an expected business outcome and
 * is recorded as revenue we did not collect; an RPC error is OUR infrastructure
 * failing and is named as such, with the vendor's own message. PTP has no
 * alerting channel -- no Sentry, no email, no Slack, and David chose no alert
 * over a fake one -- so these two lines are the entire surface an operator has.
 *
 * Callers of `deductWallet` already branch on the outcome themselves, which is
 * why it stays quiet: logging there too would double every line.
 */
export async function deductOrZero(
  client: RpcClient,
  args: DeductWalletArgs
): Promise<number> {
  const result = await deductWallet(client, args);

  if (result.outcome === 'error') {
    console.error(
      `[wallet] deduct FAILED for row ${args.p_trace_history_id ?? 'none'}: ${result.message}. Nothing was collected and the work was still delivered.`
    );
  } else if (result.outcome === 'insufficient_balance') {
    console.error(
      `[wallet] wallet short for row ${args.p_trace_history_id ?? 'none'}: $${args.p_amount} was not collected and the work was still delivered.`
    );
  }

  return result.collected;
}
