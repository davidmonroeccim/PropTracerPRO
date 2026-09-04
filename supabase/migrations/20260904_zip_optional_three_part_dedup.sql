-- Re-key the dedup hash from STREET|CITY|STATE|ZIP to STREET|CITY|STATE.
-- 2026-09-04. Companion to the code change in lib/utils/address-normalizer.ts.
--
-- WHY. ZIP was required on every record and never reached either vendor: the Tracerfy person
-- CSV has no zip column (lib/tracerfy/client.ts:54) and the FastAppend entity path submits
-- business_name + state only. Meanwhile it rejected whole batches at the door, because
-- skipTraceBulk fails the entire batch if one record is invalid. The property-registry can
-- supply a city for 804 counties but a ZIP for only 766, so 241 counties covering 16,062,225
-- parcels could not be traced at all for want of a field nothing downstream reads.
--
-- WHY THIS MIGRATION IS REQUIRED, not optional. address_hash is the dedup key. If the code
-- starts emitting 3-part hashes while the table still holds 4-part ones, NOTHING matches
-- history and every previously-traced property is traced and CHARGED again.
--
-- SAFE TO DERIVE IN SQL. Verified against all 3,632 live rows on 2026-09-04:
-- sha256(normalized_address) = address_hash on every row, 0 mismatches. The new values are a
-- pure function of what is already stored, so no JS replay is needed. sha256() is built into
-- Postgres 11+; pgcrypto is not required.
--
-- ⚠️ NOTHING IS DELETED, AND THE FIRST DRAFT OF THIS MIGRATION WAS WRONG TO TRY.
-- trace_history carries UNIQUE(user_id, address_hash), so 15 rows that differ ONLY by ZIP
-- would collide once re-keyed. The obvious fix is to drop the redundant row. That draft was
-- attempted and Postgres refused it:
--
--     ERROR 23503: update or delete on table "trace_history" violates foreign key constraint
--     "wallet_transactions_trace_history_id_fkey" on table "wallet_transactions"
--
-- 7 of those 15 rows are referenced by the BILLING LEDGER. They are not junk, they are
-- receipts. So this migration re-keys ONLY the survivor of each colliding group and leaves the
-- redundant rows byte-identical, still 4-part, still referenced.
--
-- That is safe and self-enforcing, not a compromise: a 4-part string can never hash to the
-- same value as a 3-part one, so the UNIQUE constraint is satisfied by construction. The
-- leftover rows simply stop being reachable by a dedup lookup, which is correct -- the
-- survivor is the row that SHOULD match, and it describes the same property.
--
-- Measured before writing: 15 colliding groups, 30 rows, 15 redundant, $0.28 of charge on the
-- redundant side. Every sampled pair is the SAME property under two ZIPs -- 3661 AIRPORT BLVD
-- MOBILE AL as 36608 and 36609, 1850 MAGWOOD DR CHARLESTON SC as 29414 and 29403 -- which is a
-- duplicate charge the old key failed to catch, not two properties.

begin;

-- 1. Re-key the survivor of each (user_id, 3-part key) group.
--    Survivor policy, in order: a successful trace beats a no_match; then more contacts;
--    then the OLDEST row, which is the one originally charged.
--    Rows with rn > 1 are deliberately left untouched. See the header.
with keyed as (
  select
    id, user_id, is_successful, phone_count, email_count, created_at,
    split_part(normalized_address, '|', 1) || '|' ||
    split_part(normalized_address, '|', 2) || '|' ||
    split_part(normalized_address, '|', 3) as new_norm
  from public.trace_history
  where normalized_address like '%|%|%|%'
),
ranked as (
  select id, new_norm,
         row_number() over (
           partition by user_id, new_norm
           order by is_successful desc nulls last,
                    (coalesce(phone_count,0) + coalesce(email_count,0)) desc,
                    created_at asc
         ) as rn
  from keyed
)
update public.trace_history th
set normalized_address = r.new_norm,
    address_hash       = encode(sha256(convert_to(r.new_norm, 'UTF8')), 'hex')
from ranked r
where r.id = th.id
  and r.rn = 1;

-- 2. business_trace_jobs holds the same pair with NO unique constraint and no FK onto it,
--    so every row re-keys unconditionally. 2 rows live here.
update public.business_trace_jobs
set normalized_address = split_part(normalized_address, '|', 1) || '|' ||
                         split_part(normalized_address, '|', 2) || '|' ||
                         split_part(normalized_address, '|', 3),
    address_hash = encode(
      sha256(convert_to(
        split_part(normalized_address, '|', 1) || '|' ||
        split_part(normalized_address, '|', 2) || '|' ||
        split_part(normalized_address, '|', 3), 'UTF8')), 'hex')
where normalized_address like '%|%|%|%';

-- 3. Assert the outcome inside the transaction. Any violation rolls the whole thing back.
do $$
declare
  hash_mismatch int;
  dup_keys      int;
  survivors_4p  int;
  leftovers     int;
begin
  -- Every row's hash must still match its own string, 3-part or 4-part alike.
  select count(*) into hash_mismatch
    from public.trace_history
   where address_hash <> encode(sha256(convert_to(normalized_address, 'UTF8')), 'hex');
  if hash_mismatch <> 0 then
    raise exception 'ROLLBACK: % rows have a hash that does not match their string', hash_mismatch;
  end if;

  -- The unique key must hold. This is what the 4-part leftovers protect.
  select count(*) into dup_keys from (
    select user_id, address_hash from public.trace_history
    group by 1,2 having count(*) > 1
  ) d;
  if dup_keys <> 0 then
    raise exception 'ROLLBACK: % duplicate (user_id, address_hash) pairs remain', dup_keys;
  end if;

  -- Exactly the intended population is left 4-part: the non-survivors, and nothing else.
  select count(*) into leftovers
    from public.trace_history where normalized_address like '%|%|%|%';
  if leftovers > 15 then
    raise exception 'ROLLBACK: % rows left 4-part, expected at most the 15 known collisions', leftovers;
  end if;

  -- No survivor may still be 4-part: every group must have exactly one 3-part row.
  select count(*) into survivors_4p from (
    select user_id,
           split_part(normalized_address,'|',1)||'|'||
           split_part(normalized_address,'|',2)||'|'||
           split_part(normalized_address,'|',3) as k
    from public.trace_history
    group by 1,2 having count(*) filter (where true) > 0
       and sum(case when normalized_address not like '%|%|%|%' then 1 else 0 end) = 0
  ) s;
  if survivors_4p <> 0 then
    raise exception 'ROLLBACK: % groups have no 3-part survivor', survivors_4p;
  end if;

  raise notice 'OK: % rows left 4-part by design (collision non-survivors), all hashes consistent, unique key intact', leftovers;
end $$;

commit;
