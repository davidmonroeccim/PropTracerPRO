// FastAppend contact credit helper
//
// FastAppend's business-trace path can produce real owner contacts (phones +
// emails for an LLC's principal) that PropTracerPRO has effectively delivered
// to the user. When that happens, the row should be credited as a successful
// trace -- even when the downstream Tracerfy person-skip-trace returns no
// match (which is common: many LLC principals aren't in Tracerfy's commercial
// database, but FastAppend already found them).
//
// Without this, rows ended up marked is_successful=false / charge=0 even
// though the user got the contacts they paid AI research for.

import type { AIResearchResult, TraceResult } from '@/types';

// ---- resolveOwnerContact ----------------------------------------------------
//
// SINGLE SOURCE OF TRUTH for "who is the human behind this owner?" (same
// convention as isEntityRecord for the person/entity split).
//
// Why this exists: a per-record payload carries FOUR keys named some variant of
// "owner name", at three nesting levels, meaning two different things --
// `input_owner_name` and `research.owner_name` are the ENTITY asked about, while
// `trace_result.owner_name` and `business_trace_contacts.owner_name` are the
// PERSON resolved behind it. Consumers mapping a column called "owner name"
// matched the company (which they already had) and discarded the person. In the
// 2026-08-13 Dallas run that dropped all 45 resolved people -- their personal
// emails landed in the sheet while their names did not. This gives the person
// exactly one self-describing name so the payload no longer needs to be
// explained to be used.
//
// Precedence is the chain that previously lived inline in the bulk entity cron
// (now app/api/cron/sweep-entity-traces/route.ts), most authoritative first:
//   1. business_trace_contacts.owner_name -- FastAppend's commercial DB
//   2. trace_result.owner_name            -- the delivered skip-trace result
//   3. individual_behind_business         -- the principal behind the entity, which
//      on a row written since 2026-09-17 is also FastAppend's, and on an older row
//      is the removed AI Search engine's
//   4. owner_name, ONLY when owner_type is 'individual'
// A company name is NEVER a contact person: an entity with no resolved human
// returns null, never a fallback to the LLC. No fabricated values.

export type OwnerContactSource = 'fastappend' | 'person_trace' | 'ai_research';

export type ResolvedOwnerContact = {
  owner_contact_name: string | null;
  owner_contact_source: OwnerContactSource | null;
};

/** Treat empty/whitespace-only names as absent so a blank never reads as a contact. */
function cleanName(v: string | null | undefined): string | null {
  const t = (v || '').trim();
  return t.length > 0 ? t : null;
}

/** The vendor a row RECORDED, mapped onto the label. The Tracerfy lanes are person skip
 *  traces, so `person_trace` is the honest existing word for them and the union does not need
 *  to grow. An unrecognised value maps to null and the inferred chain stands: a vendor name
 *  this build does not know is not grounds for inventing a label. */
function labelForVendor(vendor: string | null | undefined): OwnerContactSource | null {
  if (vendor === 'fastappend') return 'fastappend';
  if (vendor === 'tracerfy') return 'person_trace';
  return null;
}

/**
 * THE SOURCE IS READ WHEN IT WAS RECORDED, AND ONLY INFERRED WHEN IT WAS NOT.
 *
 * The chain below infers the vendor from WHICH FIELD the contacts landed in, and that
 * inference is structurally wrong on tier 2. A tier 2 FastAppend hit puts its contacts in
 * `trace_result` (where tier 1 already puts them) and never writes `ai_research`, so rung 1
 * cannot fire, rung 2 always does, and every such row was reported as `person_trace`.
 * Measured on trace 5ec0cf47-6844-4514-9029-53a0b6f34cd0: owner of record
 * "Estates Ave Properties Llc", classified entity, routed FASTAPPEND_ENTITY, labelled
 * person_trace. No reordering fixes it, because both vendors land in the same field.
 *
 * `trace_history.contact_vendor` (migration 20260921) records the lane that was actually
 * asked, so the label now reads a fact. NAME RESOLUTION IS UNCHANGED: the chain still decides
 * WHO the contact is, and the recorded vendor only decides what we call the source. A recorded
 * vendor is not a contact, so a row that reached nobody still returns nulls.
 *
 * The fallback is not legacy debt to clear. 3,836 of 3,838 rows predate the column and came
 * from Tracerfy normal search or AI Search with FastAppend. They keep the label they have
 * always carried rather than acquiring one derived from nothing.
 */
export function resolveOwnerContact(row: {
  trace_result: TraceResult | null | undefined;
  ai_research: AIResearchResult | null | undefined;
  contact_vendor?: string | null;
}): ResolvedOwnerContact {
  const research = row.ai_research;
  const recorded = labelForVendor(row.contact_vendor);
  const resolved = (name: string, inferred: OwnerContactSource): ResolvedOwnerContact => ({
    owner_contact_name: name,
    owner_contact_source: recorded ?? inferred,
  });

  const fastAppend = cleanName(research?.business_trace_contacts?.owner_name);
  if (fastAppend) return resolved(fastAppend, 'fastappend');

  const traced = cleanName(row.trace_result?.owner_name);
  if (traced) return resolved(traced, 'person_trace');

  const individual = cleanName(research?.individual_behind_business);
  if (individual) return resolved(individual, 'ai_research');

  // Last resort, and only when the owner is itself a person -- this guard is what
  // keeps an LLC out of the contact-person field.
  if (research?.owner_type === 'individual') {
    const self = cleanName(research.owner_name);
    if (self) return resolved(self, 'ai_research');
  }

  return { owner_contact_name: null, owner_contact_source: null };
}

export type TraceCreditFromFastAppend = {
  trace_result: TraceResult;
  phone_count: number;
  email_count: number;
};

// If business_trace_contacts has at least one phone or email, return a
// TraceResult-shaped record (so the row's stored trace_result is consistent
// regardless of which provider the contacts came from). Returns null if
// FastAppend had no usable contacts.
export function traceCreditFromFastAppend(
  research: AIResearchResult | null | undefined
): TraceCreditFromFastAppend | null {
  const contacts = research?.business_trace_contacts;
  if (!contacts) return null;

  const phones = contacts.phones || [];
  const emails = contacts.emails || [];
  if (phones.length === 0 && emails.length === 0) return null;

  // Map FastAppend phone-types ('mobile' | 'landline' | 'voip' | string) onto
  // our internal TraceResult.PhoneResult union; anything outside the union
  // becomes 'unknown' so downstream consumers don't have to defensive-cast.
  const normalizedPhones: TraceResult['phones'] = phones.map((p) => {
    const t = (p.type || '').toLowerCase();
    const type: TraceResult['phones'][number]['type'] =
      t === 'mobile' || t === 'landline' || t === 'voip' ? t : 'unknown';
    return { number: p.number, type };
  });

  const trace_result: TraceResult = {
    owner_name: contacts.owner_name || null,
    owner_name_2: null,
    phones: normalizedPhones,
    emails: [...emails],
    mailing_address: contacts.address || null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    match_confidence: 80,
  };

  return {
    trace_result,
    phone_count: normalizedPhones.length,
    email_count: emails.length,
  };
}
