import { createClient } from '@/lib/supabase/server';
import { normalizeAddress, createAddressHash } from './address-normalizer';
import { DEDUPE, STALE_PROCESSING } from '@/lib/constants';
import { CACHE_HIT_FILTER } from '@/lib/trace/billedRows';
import type { AddressInput, DedupeResult, TraceHistory } from '@/types';

/**
 * Checks for duplicate addresses against user's trace history.
 * Returns new records to process and cached results for duplicates.
 *
 * NEEDS NO TIER 2 CHANGE, checked 2026-09-17. Unlike checkSingleDuplicate this
 * path never narrowed to `is_successful = true`: any row inside the dedup
 * window (bar a stale `processing` one) counts as a duplicate. A tier 2 row
 * carrying a property record but no contacts is therefore already a cache hit
 * here, and already free. The bias runs the other way -- a plain failed row
 * also blocks resubmission -- which is pre-existing behaviour, costs the
 * customer nothing, and is not this phase's to change.
 */
export async function checkDuplicates(
  userId: string,
  records: AddressInput[]
): Promise<DedupeResult> {
  const supabase = await createClient();

  // Calculate cutoff date for deduplication window
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DEDUPE.WINDOW_DAYS);

  // Create hashes for all input records
  const recordsWithHashes = records.map((record) => ({
    ...record,
    normalizedAddress: normalizeAddress(record.address, record.city, record.state),
    hash: createAddressHash(
      normalizeAddress(record.address, record.city, record.state)
    ),
  }));

  const allHashes = recordsWithHashes.map((r) => r.hash);

  // Query existing traces within the deduplication window
  // Batch the .in() query to avoid exceeding PostgREST URL length limits
  const HASH_BATCH_SIZE = 100;
  let existingTraces: TraceHistory[] = [];

  for (let i = 0; i < allHashes.length; i += HASH_BATCH_SIZE) {
    const batch = allHashes.slice(i, i + HASH_BATCH_SIZE);
    const { data, error } = await supabase
      .from('trace_history')
      .select('*')
      .eq('user_id', userId)
      .in('address_hash', batch)
      .gte('created_at', cutoffDate.toISOString());

    if (error) {
      throw new Error(`Failed to check duplicates: ${error.message}`);
    }
    if (data) {
      existingTraces = existingTraces.concat(data as TraceHistory[]);
    }
  }

  // Exclude stale processing records — they should not block new submissions
  const staleCutoff = new Date();
  staleCutoff.setMinutes(staleCutoff.getMinutes() - STALE_PROCESSING.STALE_MINUTES);

  const validTraces = (existingTraces || []).filter((t: TraceHistory) => {
    if (t.status === 'processing' && new Date(t.created_at) < staleCutoff) {
      return false; // Stale processing — don't count as duplicate
    }
    return true;
  });

  const existingHashes = new Set(
    validTraces.map((t: TraceHistory) => t.address_hash)
  );

  // Separate new records from duplicates
  const newRecords: AddressInput[] = [];
  const duplicates: AddressInput[] = [];

  for (const record of recordsWithHashes) {
    if (existingHashes.has(record.hash)) {
      duplicates.push(record);
    } else {
      newRecords.push(record);
    }
  }

  return {
    newRecords,
    duplicates,
    cachedResults: existingTraces,
  };
}

/**
 * Checks if a single address is a duplicate.
 * Returns the cached result if found, null otherwise.
 */
export async function checkSingleDuplicate(
  userId: string,
  address: string,
  city: string,
  state: string
): Promise<TraceHistory | null> {
  const supabase = await createClient();

  const normalizedAddress = normalizeAddress(address, city, state);
  const hash = createAddressHash(normalizedAddress);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DEDUPE.WINDOW_DAYS);

  // A row is a cache hit when the customer already owns what it holds:
  //   is_successful = true       -> contacts were delivered (tier 1)
  //   property_record IS NOT NULL -> the 86-field property record was bought (tier 2)
  //
  // The second arm is not optional. Tier 2 bills per record SUBMITTED, so a row
  // can carry a charge with is_successful = false: the property record was paid
  // for and the contact step, a separate call, returned nothing. Narrowing to
  // is_successful = true made that row invisible here, and an invisible row is
  // one the customer is billed for a SECOND time for data they already own --
  // the opposite of the rule that a result served from the database is free.
  //
  // Everything else still re-traces: a plain failure carries neither marker.
  // And this is a no-op against every row written before tier 2, because
  // property_record is NULL on all of them.
  const { data, error } = await supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    .eq('address_hash', hash)
    .or(CACHE_HIT_FILTER)
    .gte('created_at', cutoffDate.toISOString())
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = no rows returned, which is expected
    throw new Error(`Failed to check duplicate: ${error.message}`);
  }

  return data as TraceHistory | null;
}

/**
 * Removes duplicates within a batch of records.
 * Returns unique records only.
 */
export function removeBatchDuplicates(records: AddressInput[]): {
  unique: AddressInput[];
  internalDuplicates: number;
} {
  const seen = new Set<string>();
  const unique: AddressInput[] = [];
  let internalDuplicates = 0;

  for (const record of records) {
    const hash = createAddressHash(
      normalizeAddress(record.address, record.city, record.state)
    );

    if (!seen.has(hash)) {
      seen.add(hash);
      unique.push(record);
    } else {
      internalDuplicates++;
    }
  }

  return { unique, internalDuplicates };
}
