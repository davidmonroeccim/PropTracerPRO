-- ONE shared vendor call budget for the two crons, over a SLIDING 60-second window (spec 5.3).
--
-- WHY IT CANNOT BE A COUNTER IN MEMORY. The Tier 1 lane and the Tier 2 cron are SEPARATE Vercel
-- function invocations on separate instances, both scheduled every minute (vercel.json). A
-- process-local counter would give each of them its own 450 and the vendor its 900, which is the
-- opposite of the guarantee spec 5.3 asks for. Shared state across invocations is the database.
--
-- WHY A RESERVATION AND NOT A POST-HOC COUNT. Tracerfy's limit is 500 lookups a minute across the
-- instant, APN and dossier endpoints (docs :661, :1332), and FastAppend has its own 500
-- (lib/tracerfy/client.ts:566). Counting calls AFTER making them cannot refuse the call that trips
-- the limit. So the call is reserved before it is made, and a refused reservation means the call is
-- not made at all.
--
-- A RECORD IS THROTTLED AT ITS START OR NOT AT ALL, AND THAT IS THE WHOLE POINT. Nothing draws from
-- this budget in a way that can refuse a record part-way through a ladder it has already paid for,
-- because releasing such a record means re-running it and re-buying its dossier. So:
--   the TIER 1 lane draws ONE CALL AT A TIME, from executeRoute's canSpend hook, which is safe
--   because that ladder's steps are independent and a refusal lands before the call it refused;
--   the TIER 2 cron draws ONCE PER RECORD, immediately before the record's first vendor call, for
--   the steps planRoute planned, and then that record runs to completion.
-- The cost of the tier 2 shape is that the pass-2 owner lookups are not reserved, so an in-flight
-- ladder can overshoot: D21(c) and D40 cap nothing, and lib/routing/ownerRoute.ts says of its own
-- tier 2 figure, in capitals, "A FLOOR, NOT A CEILING ... the real cost of a tier 2 record is the
-- dossier plus up to $0.30 for each owner named, and the owner count is unknowable here". The
-- overshoot is bounded by that cron's CONCURRENCY (5) times a record's worst-case remaining ladder
-- (2N calls for N owners, so 30 at three owners), and the gap below each vendor's own 500 absorbs
-- it. The plan's Task 6 header carries the arithmetic and says where it runs out.
--
-- WHY 450 AND NOT 500. Spec 5.3: 50 under the limit. That gap carries what cannot be reserved: the
-- single traces, which run inside a customer's request, and the tier 2 overshoot above.
--
-- THROTTLING IS NOT A FAILURE, AND IT SPENDS NOTHING (spec 5.1). A refused record has bought
-- nothing, because it was refused before it began (tier 2) or before the call it was asked about
-- (tier 1). Its row goes back to the rung it was claimed from with its claim cleared, no attempt is
-- spent, and the customer is told nothing. Nothing here is on the billing path.
--
-- THE WINDOW SLIDES, AND A FIXED MINUTE WOULD NOT BE A LIMIT AT ALL. With a bucket truncated to the
-- MINUTE instead of the second, 450 calls at :59.9 and 450 more at :00.1 are two legal
-- minutes and ONE 60-second span carrying 900 calls, against a vendor limit of 500. So the bucket is
-- one SECOND wide and a claim sums the trailing 60 seconds. Both crons being scheduled on the minute
-- does not save it: a run takes about 45 seconds, so its calls land across the boundary by design.
--
-- THE WORDING ABOVE AVOIDS SPELLING THE MINUTE-BUCKET CALL LITERALLY, ON PURPOSE. A later task's
-- gate greps this file for that exact expression and expects to find nothing, because finding it is
-- how the 900-calls-in-one-span defect would announce itself. The explanation is worth keeping; the
-- literal it used to contain would have tripped that gate from inside a comment and cost somebody an
-- investigation to discover it was only prose.
--
-- WHAT THIS COSTS, SAID PLAINLY. Up to 86,400 bucket rows a day per vendor instead of 1,440, and one
-- indexed aggregate per claim instead of a single upsert. The aggregate is served by the primary key
-- and touches at most 60 rows; pruneVendorRateWindows keeps the table at about 900 rows per vendor.
--
-- AND IT COSTS THE ROW-LOCK TRICK, which is why the lock below is explicit. The old shape leaned on
-- ON CONFLICT DO UPDATE taking a lock on the row it was about to write, with a WHERE that refused.
-- A sliding window cannot: the rows being COUNTED are not the row being WRITTEN, so two workers
-- could both read 440 and both add 20. pg_advisory_xact_lock, keyed per vendor and released when the
-- transaction ends, serialises the read and the write together, which is strictly stronger than what
-- it replaces. Per vendor, so Tracerfy claims never wait behind FastAppend ones. At 450 claims a
-- minute across both crons that is 7.5 claims a second on a lock held for well under a millisecond.

CREATE TABLE IF NOT EXISTS public.vendor_rate_windows (
  vendor text NOT NULL,
  -- ONE SECOND WIDE: date_trunc('second', now()). The column keeps its name so nothing that reads it
  -- has to change, and the table comment says what it now means.
  window_start timestamptz NOT NULL,
  calls_used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (vendor, window_start)
);

-- NO SECOND INDEX. The claim's aggregate is `WHERE vendor = $1 AND window_start > $2`, which is a
-- leading-column equality then a range on the primary key: exactly what the PK's btree serves.

-- Data API grants: LEAST PRIVILEGE, and this table has NO browser surface at all.
--
-- CLAUDE.md's template defaults a new table to `GRANT SELECT ... TO authenticated`. This one gets
-- nothing: no page, no route and no client reads it, and the anon key ships in the JS bundle. The
-- brief's ceiling for this phase is "nothing new for anon or authenticated beyond SELECT"; granting
-- neither of them anything stays inside that ceiling rather than spending it.
--
-- BUT GRANTING NOTHING IS NOT ENOUGH ON ITS OWN, and that was measured here rather than assumed.
-- The REVOKE block below says what came back anyway and why it has to be revoked by name.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_rate_windows TO service_role;

-- AND THE REVOKES, BY NAME, BECAUSE GRANTING NOTHING IS NOT THE SAME AS HAVING NOTHING.
--
-- MEASURED ON THIS TABLE, 2026-09-24, AND IT IS THE CLAUDE.md 2026-09-17 LESSON ONE OBJECT TYPE
-- OVER. The statements above grant anon and authenticated nothing at all, and the ACL still came
-- back reading `anon=rm/postgres | authenticated=rm/postgres`. Supabase ships ALTER DEFAULT
-- PRIVILEGES for TABLES in public, not only for functions: pg_default_acl carries
-- `anon=rm/postgres` and `authenticated=rm/postgres` for objtype 'r', and those land as EXPLICIT
-- grants to named roles at CREATE time. So the absence of a GRANT in a migration is not the
-- absence of a privilege on the object, exactly as it is not for a function.
--
-- WHAT `rm` ACTUALLY IS, said plainly rather than implied: r = SELECT, m = MAINTAIN. There is no
-- a, w or d, so neither role can INSERT, UPDATE or DELETE and the server still owns every write.
-- The SELECT is already dead through the Data API because RLS is enabled below with ZERO policies,
-- and MAINTAIN (VACUUM/ANALYZE/REINDEX) is not reachable through PostgREST at all. So this is not
-- a live read of anyone's data. It is revoked anyway, for the reason the function revokes exist:
-- least privilege is the state of the OBJECT, not the intent of the migration, and a table nobody
-- outside the server may touch should not be one RLS policy away from being readable.
REVOKE ALL ON TABLE public.vendor_rate_windows FROM PUBLIC;
REVOKE ALL ON TABLE public.vendor_rate_windows FROM anon;
REVOKE ALL ON TABLE public.vendor_rate_windows FROM authenticated;

-- Required RLS. service_role bypasses it; with no policies and no grants, nobody else can read or
-- write a row through the Data API even if a future grant were added by accident.
ALTER TABLE public.vendor_rate_windows ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.vendor_rate_windows IS
  'Vendor call budget shared by app/api/cron/sweep-entity-traces (the Tier 1 lane) and app/api/cron/sweep-property-traces (tier 2), over a SLIDING 60-second window. One row per vendor per wall-clock SECOND; a claim sums the trailing 60 of them. A fixed calendar minute would permit 450 calls at :59 and 450 at the next :00, which is 900 in one 60-second span against a vendor limit of 500. Written only through claim_vendor_rate(); see lib/trace/vendorRateBudget.ts and spec 5.3.';

-- Reserve p_calls against the TRAILING 60 SECONDS for one vendor. TRUE when they are granted.
--
-- ATOMIC BY AN EXPLICIT ADVISORY LOCK, and it has to be explicit. The row-lock trick the fixed-minute
-- version used (ON CONFLICT DO UPDATE with a WHERE that refuses) cannot serialise this one: the rows
-- being COUNTED are the last 60 buckets, not the single bucket being WRITTEN, so two workers could
-- both read 440 and both add 20. pg_advisory_xact_lock holds from here to the end of the transaction
-- and covers the read AND the write, which is strictly stronger. Keyed per VENDOR, so a Tracerfy
-- claim never waits behind a FastAppend one.
CREATE OR REPLACE FUNCTION public.claim_vendor_rate(
  p_vendor text,
  p_calls integer,
  p_limit integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket timestamptz := date_trunc('second', now());
  v_since  timestamptz := now() - interval '60 seconds';
  v_used   integer;
BEGIN
  -- Nothing asked for is always granted, and costs no lock and no round trip.
  IF p_calls IS NULL OR p_calls <= 0 THEN
    RETURN true;
  END IF;
  -- A single ask bigger than the whole budget can never be granted. Refused BEFORE the lock and
  -- before any write, so it can never insert a bucket it was not allowed to fill.
  IF p_limit IS NULL OR p_limit <= 0 OR p_calls > p_limit THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('vendor_rate:' || p_vendor));

  SELECT coalesce(sum(w.calls_used), 0) INTO v_used
    FROM public.vendor_rate_windows w
   WHERE w.vendor = p_vendor
     AND w.window_start > v_since;

  -- REFUSES WITHOUT WRITING ANYTHING. The old shape refused by leaving v_used NULL through a
  -- RETURNING that matched no row; this one refuses in one readable line, and the contract
  -- lib/trace/vendorRateBudget.ts depends on is identical: anything but true is a refusal.
  IF v_used + p_calls > p_limit THEN
    RETURN false;
  END IF;

  INSERT INTO public.vendor_rate_windows AS w (vendor, window_start, calls_used)
  VALUES (p_vendor, v_bucket, p_calls)
  ON CONFLICT (vendor, window_start) DO UPDATE
    SET calls_used = w.calls_used + p_calls;

  RETURN true;
END;
$$;

-- GRANTS, ALL FOUR STATEMENTS, BY NAME.
--
-- REVOKE ... FROM PUBLIC DOES NOT SECURE A NEW FUNCTION ON SUPABASE (CLAUDE.md, learned on
-- 2026-09-17 when a SECURITY DEFINER function that ADDS WALLET BALANCE came back callable by anon
-- despite exactly that revoke). Supabase ships ALTER DEFAULT PRIVILEGES that land EXPLICIT grants
-- to anon and authenticated at CREATE time, and a revoke from PUBLIC does not touch an explicit
-- grant to a named role. Only the crons call this, so only service_role gets it back.
REVOKE ALL ON FUNCTION public.claim_vendor_rate(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_vendor_rate(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_vendor_rate(text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_vendor_rate(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.claim_vendor_rate(text, integer, integer) IS
  'Reserve p_calls against the TRAILING 60 SECONDS for p_vendor, all or nothing. TRUE when granted. Serialised per vendor by pg_advisory_xact_lock, which covers the count and the write together. Called only by the two crons through lib/trace/vendorRateBudget.ts, from executeRoute''s canSpend hook, one call at a time (spec 5.3).';
