7 CLAUDE Rules
1. First think through the problem, read the codebase for relevant files, and write a plan to tasks/todo.md.
2. The plan should have a list of todo items that you can check off as you complete them
3. Before you begin working, check in with me and I will verify the plan.
4. Then, begin working on the todo items, marking them as complete as you go.
5. Please every step of the way just give me a high level explanation of what changes you made
6. Make every task and code change you do as simple as possible. We want to avoid making any massive or complex changes. Every change should impact as little code as possible. Everything is about simplicity.
7. NEVER create fallback/fake/made up data or results. Allow the application to fail if it's missing what the tool is looking for.
8. Finally, add a review section to the [todo.md](http://todo.md/) file with a summary of the changes you made and any other relevant information.
9. After every completed task, update History.md with a brief summary of what was done (date, task name, bullet points of changes) before moving on to the next task.

## Supabase Migration Template

Starting Oct 30, 2026, Supabase enforces explicit GRANTs for Data API access to new `public` schema objects. Any new `CREATE TABLE`, `CREATE FUNCTION` called via `.rpc()`, or `CREATE SEQUENCE` in `public` MUST include explicit GRANTs or the app (supabase-js / PostgREST) will get `42501` errors.

Reference: https://github.com/orgs/supabase/discussions/45329

### New Table

```sql
CREATE TABLE IF NOT EXISTS public.your_table (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- ... columns ...
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Data API grants — LEAST PRIVILEGE. This is a security boundary, not boilerplate.
-- RLS gates WHICH ROWS; GRANTs gate WHICH COLUMNS a role may write. A table-wide
-- `GRANT UPDATE ... TO authenticated` plus an "edit your own row" RLS policy lets any signed-in
-- user rewrite ANY column on their own row straight from the browser console (the anon key ships
-- in the JS bundle). That is the self-write vuln class: self-upgrade subscription_tier, self-grant
-- is_acquisition_pro_member, mint wallet_balance, pre-plant gateway_products. Never grant
-- table-wide writes to authenticated.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO service_role;  -- the server owns writes
GRANT SELECT ON public.your_table TO authenticated;                        -- reads only, by default
-- If (and ONLY if) the browser must write this table directly, grant the EXACT columns it writes,
-- never the whole row — and never a privileged column (subscription_tier, is_acquisition_pro_member,
-- wallet_balance, gateway_*, api_key, stripe_*), which must be written server-side via the admin
-- (service_role) client:
--   GRANT INSERT (col_a, col_b), UPDATE (col_a, col_b) ON public.your_table TO authenticated;
-- Grant to `anon` ONLY if the table is genuinely public-READABLE (rare); never anon writes.

-- Required RLS
ALTER TABLE public.your_table ENABLE ROW LEVEL SECURITY;

-- Policies (example for user-scoped table)
CREATE POLICY "users read own rows" ON public.your_table
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own rows" ON public.your_table
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
```

### New Function (called via `supabase.rpc(...)`)

Functions are subject to the same opt-in. If a function isn't reachable, supabase-js returns the same `42501` error.

```sql
CREATE OR REPLACE FUNCTION public.your_fn(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- ...
END;
$$;

-- Required GRANTs (Data API exposure for RPC)
GRANT EXECUTE ON FUNCTION public.your_fn(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.your_fn(uuid) TO service_role;
-- Skip anon unless unauthenticated callers need it.
```

### New Sequence (only if you use SERIAL / BIGSERIAL)

PTP convention is `uuid` PKs, so this is rarely needed. If a column uses `SERIAL` / `BIGSERIAL`, the underlying sequence also needs grants:

```sql
GRANT USAGE, SELECT ON SEQUENCE public.your_table_id_seq TO authenticated, service_role;
```

### Notes

- **Existing PTP objects** (tables, functions, sequences created before 2026-10-30) keep their grants — no changes needed.
- `ALTER TABLE` / `ADD COLUMN` and `CREATE OR REPLACE FUNCTION` on **pre-existing** signatures do NOT need new GRANTs.
- `CREATE OR REPLACE FUNCTION` with a **new** argument signature creates a new function — it needs a GRANT.
- If you forget the GRANT, PostgREST returns error code `42501` with the exact missing GRANT statement in the hint field.
- This rule applies only to the `public` schema. `auth`, `storage`, `realtime`, and custom schemas are unaffected.