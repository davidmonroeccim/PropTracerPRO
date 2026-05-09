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
