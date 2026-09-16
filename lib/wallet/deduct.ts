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
 * Runs `deduct_wallet_balance` and returns the amount ACTUALLY charged:
 * `p_amount` when the wallet covered it, `0` when it did not.
 *
 * Envelope handling -- deliberate choice: only two things PROVE the money did
 * not move, an explicit `false` from the function (insufficient balance) and a
 * transport/Postgres `error`. Those return 0. Everything else, including a
 * missing envelope or a missing `data` key, is treated as success.
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
export async function deductOrZero(
  client: RpcClient,
  args: DeductWalletArgs
): Promise<number> {
  const envelope = (await client.rpc('deduct_wallet_balance', args)) as
    | { data?: unknown; error?: unknown }
    | null
    | undefined;

  const failed = envelope?.data === false || Boolean(envelope?.error);
  return failed ? 0 : args.p_amount;
}
