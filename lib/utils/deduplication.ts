import { createClient } from '@/lib/supabase/server';
import { normalizeAddress, createAddressHash } from './address-normalizer';
import { DEDUPE } from '@/lib/constants';
import type { AddressInput, DedupeResult, TraceHistory } from '@/types';

/**
 * Checks for duplicate addresses against user's trace history.
 * Returns new records to process and cached results for duplicates.
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
    normalizedAddress: normalizeAddress(
      record.address,
      record.city,
      record.state,
      record.zip
    ),
    hash: createAddressHash(
      normalizeAddress(record.address, record.city, record.state, record.zip)
    ),
  }));

  const allHashes = recordsWithHashes.map((r) => r.hash);

  // Query existing traces within the deduplication window
  const { data: existingTraces, error } = await supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    .in('address_hash', allHashes)
    .gte('created_at', cutoffDate.toISOString());

  if (error) {
    throw new Error(`Failed to check duplicates: ${error.message}`);
  }

  const existingHashes = new Set(
    existingTraces?.map((t: TraceHistory) => t.address_hash) || []
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
    cachedResults: (existingTraces as TraceHistory[]) || [],
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
  state: string,
  zip: string
): Promise<TraceHistory | null> {
  const supabase = await createClient();

  const normalizedAddress = normalizeAddress(address, city, state, zip);
  const hash = createAddressHash(normalizedAddress);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DEDUPE.WINDOW_DAYS);

  // Only return successful traces as cached results
  // Failed traces should be retried
  const { data, error } = await supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    .eq('address_hash', hash)
    .eq('is_successful', true)
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
      normalizeAddress(record.address, record.city, record.state, record.zip)
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
