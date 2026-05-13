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

Starting Oct 30, 2026, Supabase enforces explicit GRANTs for Data API access to `public` tables. Any new `CREATE TABLE` in `public` MUST include explicit GRANTs or the app (supabase-js / PostgREST) will get `42501` errors.

Every new table migration in `supabase/migrations/` must follow this pattern:

```sql
CREATE TABLE IF NOT EXISTS public.your_table (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- ... columns ...
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Required GRANTs (Data API access)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO service_role;
-- Only add `GRANT ... TO anon` if anon (unauthenticated) clients need access.
-- Most PTP tables are user-scoped — do NOT grant to anon by default.

-- Required RLS
ALTER TABLE public.your_table ENABLE ROW LEVEL SECURITY;

-- Policies (example for user-scoped table)
CREATE POLICY "users read own rows" ON public.your_table
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users insert own rows" ON public.your_table
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
```

Notes:
- Existing PTP tables (pre-2026-05-13) already have implicit grants and need no changes.
- `ALTER TABLE` / `ADD COLUMN` migrations do NOT need GRANTs — only new tables.
- If you forget the GRANT, PostgREST returns error code `42501` with the missing GRANT statement.