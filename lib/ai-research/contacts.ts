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
// Precedence is the chain that previously lived inline in
// app/api/cron/sweep-bulk-research/route.ts, most authoritative first:
//   1. business_trace_contacts.owner_name -- FastAppend's commercial DB
//   2. trace_result.owner_name            -- the delivered skip-trace result
//   3. individual_behind_business         -- AI research (LLM + web)
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

export function resolveOwnerContact(row: {
  trace_result: TraceResult | null | undefined;
  ai_research: AIResearchResult | null | undefined;
}): ResolvedOwnerContact {
  const research = row.ai_research;

  const fastAppend = cleanName(research?.business_trace_contacts?.owner_name);
  if (fastAppend) return { owner_contact_name: fastAppend, owner_contact_source: 'fastappend' };

  const traced = cleanName(row.trace_result?.owner_name);
  if (traced) return { owner_contact_name: traced, owner_contact_source: 'person_trace' };

  const individual = cleanName(research?.individual_behind_business);
  if (individual) return { owner_contact_name: individual, owner_contact_source: 'ai_research' };

  // Last resort, and only when the owner is itself a person -- this guard is what
  // keeps an LLC out of the contact-person field.
  if (research?.owner_type === 'individual') {
    const self = cleanName(research.owner_name);
    if (self) return { owner_contact_name: self, owner_contact_source: 'ai_research' };
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
