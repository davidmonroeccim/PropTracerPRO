import { TRACERFY, FASTAPPEND } from '@/lib/constants';
import type { TracerfyResult } from '@/types';
// Type-only, erased at compile: the contact-vendor contract is declared where
// it is consumed (executeRoute injects these), so there is one definition of
// "what a contact vendor returns" rather than one per module.
import type {
  ContactResult,
  EntityTraceRequest,
  PersonTraceRequest,
} from '@/lib/routing/executeRoute';

const API_KEY = process.env.TRACERFY_API_KEY;
const BASE_URL = process.env.TRACERFY_API_URL || TRACERFY.BASE_URL;

// Why this exists: getJobStatus() used to coerce every non-success Tracerfy
// response (503, 429, malformed JSON) into `{ success: true, pending: true }`.
// That masked real upstream failures as "still patiently waiting" and left
// callers (Lead-Gen Agent, dashboard) polling 'processing' indefinitely.
// errorReason lets callers tell "Tracerfy is genuinely working" apart from
// "Tracerfy is broken" without changing the polling contract.
export type TracerfyErrorReason =
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'malformed_response'
  | 'network_error'
  | 'auth_error';

interface TracerfySubmitResponse {
  message: string;
  queue_id: number;
  job_id?: string; // legacy support
  status: string;
  created_at: string;
}

/**
 * Submit a single address for skip tracing.
 * Tracerfy requires CSV file upload with column mapping parameters.
 * The API is batch-oriented, so we include a padding row to ensure 2+ rows.
 * Mail fields must be populated (use property address as fallback).
 */
export async function submitSingleTrace(data: {
  address: string;
  city: string;
  state: string;
  zip: string;
  owner_name?: string;
}): Promise<{ success: boolean; jobId?: string; error?: string }> {
  if (!API_KEY) {
    return { success: false, error: 'Tracerfy API key not configured' };
  }

  try {
    // Parse owner name into first and last
    const nameParts = (data.owner_name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // Escape CSV values (handle commas and quotes in addresses)
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;

    // Create CSV content matching Tracerfy's expected format (no zip column).
    // Mail fields filled with property address (required by Tracerfy).
    // Includes a padding row because Tracerfy's batch API ignores single-row uploads.
    const csvContent = [
      'address,city,state,first_name,last_name,mail_address,mail_city,mail_state',
      `${esc(data.address)},${esc(data.city)},${esc(data.state)},${esc(firstName)},${esc(lastName)},${esc(data.address)},${esc(data.city)},${esc(data.state)}`,
      `"0 Padding Row","${data.city}","${data.state}","X","X","0 Padding Row","${data.city}","${data.state}"`,
    ].join('\n');

    const formData = new FormData();
    const blob = new Blob([csvContent], { type: 'text/csv' });
    formData.append('csv_file', blob, 'trace.csv');

    // Column mapping parameters (matching working Tracerfy notebook - no zip_column)
    formData.append('address_column', 'address');
    formData.append('city_column', 'city');
    formData.append('state_column', 'state');
    formData.append('first_name_column', 'first_name');
    formData.append('last_name_column', 'last_name');
    formData.append('mail_address_column', 'mail_address');
    formData.append('mail_city_column', 'mail_city');
    formData.append('mail_state_column', 'mail_state');

    const response = await fetch(`${BASE_URL}trace/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Tracerfy submit error:', errorText);

      if (response.status === 429) {
        return { success: false, error: 'Rate limit exceeded. Please wait a moment before trying again.' };
      }

      return { success: false, error: 'Failed to submit trace request' };
    }

    const result: TracerfySubmitResponse = await response.json();
    return { success: true, jobId: result.queue_id?.toString() || result.job_id };
  } catch (error) {
    console.error('Tracerfy submit error:', error);
    return { success: false, error: 'Tracerfy service unavailable' };
  }
}

/**
 * Submit a business name for skip tracing via FastAppend's business-trace API.
 * This is a separate service from Tracerfy (same parent company) with its own
 * base URL, auth token, and result format (CSV download instead of inline JSON).
 */
const FASTAPPEND_API_KEY = process.env.FASTAPPEND_API_KEY;

export async function submitBusinessTrace(data: {
  business_name: string;
  state: string;
}): Promise<{ success: boolean; jobId?: string; error?: string }> {
  if (!FASTAPPEND_API_KEY) {
    return { success: false, error: 'FastAppend API key not configured' };
  }

  try {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;

    const csvContent = [
      'business_name,state',
      `${esc(data.business_name)},${esc(data.state)}`,
      `"X Padding Row","${data.state}"`,
    ].join('\n');

    const formData = new FormData();
    const blob = new Blob([csvContent], { type: 'text/csv' });
    formData.append('csv_file', blob, 'business-trace.csv');

    formData.append('business_name_column', 'business_name');
    formData.append('state_column', 'state');

    const response = await fetch(`${FASTAPPEND.BASE_URL}business-trace/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FASTAPPEND_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('FastAppend business trace submit error:', errorText);

      if (response.status === 429) {
        return { success: false, error: 'Rate limit exceeded. Please wait a moment before trying again.' };
      }
      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `FastAppend auth failed (${response.status})` };
      }

      return { success: false, error: `Failed to submit business trace (${response.status})` };
    }

    const result = await response.json();
    return { success: true, jobId: result.queue_id?.toString() };
  } catch (error) {
    console.error('FastAppend business trace submit error:', error);
    return { success: false, error: 'FastAppend service unavailable' };
  }
}

/**
 * Poll FastAppend business trace job status.
 * Different from Tracerfy: uses /v1/api/business-trace/{id}/ and returns
 * a download_url for CSV results instead of inline JSON.
 */
export async function getBusinessTraceStatus(
  jobId: string
): Promise<{ success: boolean; pending?: boolean; downloadUrl?: string; error?: string }> {
  if (!FASTAPPEND_API_KEY) {
    return { success: false, error: 'FastAppend API key not configured' };
  }

  try {
    const response = await fetch(`${FASTAPPEND.BASE_URL}business-trace/${jobId}/`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${FASTAPPEND_API_KEY}`,
      },
    });

    if (!response.ok) {
      return { success: false, error: `Failed to get business trace status (${response.status})` };
    }

    const data = await response.json();

    if (data.pending === true) {
      return { success: true, pending: true };
    }

    return { success: true, pending: false, downloadUrl: data.download_url || '' };
  } catch (error) {
    console.error('FastAppend business trace status error:', error);
    return { success: false, error: 'FastAppend service unavailable' };
  }
}

/**
 * Download and parse FastAppend business trace CSV results.
 * Returns parsed owner contact info from the first non-padding row.
 */
export async function downloadBusinessTraceResults(downloadUrl: string): Promise<{
  owner_name: string | null;
  phones: Array<{ number: string; type: string }>;
  emails: string[];
  address: string | null;
} | null> {
  if (!downloadUrl) return null;

  try {
    const response = await fetch(downloadUrl);
    if (!response.ok) return null;

    const csvText = await response.text();
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return null;

    // Parse CSV header and data rows
    const headers = parseCSVLine(lines[0]);
    const col = (row: string[], name: string) => {
      const idx = headers.findIndex((h) => h.toLowerCase().trim() === name.toLowerCase());
      return idx >= 0 ? row[idx]?.trim() || '' : '';
    };

    // Find first non-padding row with actual data
    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVLine(lines[i]);
      const companyName = col(row, 'Company Name');
      if (companyName === 'X Padding Row') continue;

      const firstName = col(row, 'First Name');
      const lastName = col(row, 'Last Name');
      const ownerName = [firstName, lastName].filter(Boolean).join(' ') || null;

      const phones: Array<{ number: string; type: string }> = [];
      const primaryPhone = col(row, 'Primary Phone');
      const primaryPhoneType = col(row, 'Primary Phone Type') || 'mobile';
      if (primaryPhone) {
        phones.push({ number: primaryPhone, type: primaryPhoneType.toLowerCase() });
      }

      for (let m = 1; m <= 5; m++) {
        const num = col(row, `Mobile-${m}`);
        if (num && !phones.some((p) => p.number === num)) {
          phones.push({ number: num, type: 'mobile' });
        }
      }

      for (let l = 1; l <= 3; l++) {
        const num = col(row, `Landline-${l}`);
        if (num && !phones.some((p) => p.number === num)) {
          phones.push({ number: num, type: 'landline' });
        }
      }

      const emails: string[] = [];
      for (let e = 1; e <= 5; e++) {
        const email = col(row, `Email-${e}`);
        if (email) emails.push(email);
      }

      const mailParts = [col(row, 'Mail Address'), col(row, 'Mail City'), col(row, 'Mail State')].filter(Boolean);
      const address = mailParts.length > 0 ? mailParts.join(', ') : null;

      // Only return if there's actual data (not an empty match)
      if (ownerName || phones.length > 0 || emails.length > 0) {
        return { owner_name: ownerName, phones, emails, address };
      }

      // Row exists but all fields empty — no match
      return null;
    }

    return null;
  } catch (error) {
    console.error('FastAppend download/parse error:', error);
    return null;
  }
}

/** Simple CSV line parser handling quoted fields with commas */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/* ==================================================================== *
 * SYNCHRONOUS CONTACT LOOKUPS — the vendor callables Full Property Trace
 * injects into executeRoute().
 *
 * Both endpoints answer in ONE request: JSON in, JSON out, no CSV, no queue,
 * no polling, no download URL. That is what makes a whole tier 2 request
 * synchronous, which is what lets the charge fire in the same request as the
 * spend.
 *
 *   POST app.fastappend.com/v1/api/business-trace/lookup/   1 credit  $0.10/hit
 *   POST tracerfy.com/v1/api/trace/lookup/                  5 credits $0.10/hit
 *   POST tracerfy.com/v1/api/trace/parcel/lookup/           5 credits $0.10/hit
 *
 * Misses are free on all three. The Tracerfy pair share the 500/min counter
 * with the dossier (see lib/tracerfy/dossier.ts).
 *
 * These do NOT replace submitBusinessTrace/getBusinessTraceStatus/
 * downloadBusinessTraceResults above, which are the ASYNC batch path and are
 * left exactly as they are. app/api/cron/sweep-business-traces still polls and
 * downloads through them to finalize the FastAppend jobs the removed AI Search
 * engine queued, and customers still poll /api/v1/research/status for those
 * jobs. Nothing submits a NEW async job since 2026-09-17, because
 * lookupBusinessTrace answers on the same request.
 *
 * THREE TRAPS, each measured on the 2026-09-16 saved payloads, not assumed:
 *
 * 1. A MISS CARRIES AN `error` STRING. FastAppend answers a no-match with
 *    `{ error: "Company not found: X (OH)", hit: false, credits_deducted: 0 }`.
 *    Treating a present `error` as a failure would turn every legitimate miss
 *    into an unbillable "vendor down" — and under tier 2 a miss IS billed.
 *    `hit` is the answer; only the transport decides success.
 * 2. A REGISTERED AGENT IS NOT A PRINCIPAL, BUT THE FLAG ALONE DOES NOT SAY SO.
 *    `associated_people[]` carries `role` and `is_registered_agent`, and PTP
 *    has historically read neither: that is how five contacts literally named
 *    "Secretary of State" reached customers. But `role` is a COMMA-SEPARATED
 *    LIST, and on 1 of the 5 saved hits the only person returned is
 *    `"REGISTERED AGENT,MANAGER"` with the flag true — a real manager who also
 *    serves as the agent. Dropping everyone the flag marks would have thrown
 *    away the contact on 20% of the hits we paid for. Only a person whose
 *    ONLY role is registered agent is excluded.
 * 3. DO NOT FILTER ON `property_owner`. It returned FALSE for the verified
 *    owner of record on an absentee-owned parcel — the owner does not live in
 *    his own rental. Match on the NAME we asked for instead.
 *
 * House pattern: never throws, returns a result object on every path, no
 * retries (a retry here silently doubles a real charge). Env is read at CALL
 * time rather than captured at module load, the same deliberate deviation
 * lib/tracerfy/dossier.ts documents: the module-level capture above freezes
 * the key at import and leaves the missing-key branch untestable.
 * ==================================================================== */

/** The shape every contact-lookup failure returns. Not a miss: a miss is success + hit:false. */
const contactFailure = (error: string): ContactResult => ({
  success: false,
  hit: false,
  contacts: null,
  error,
});

const MISSED: ContactResult = { success: true, hit: false, contacts: null };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Map an HTTP status onto the same error vocabulary the dossier client uses. */
function transportError(label: string, status: number): string {
  if (status === 429) return 'Rate limit exceeded. Please wait a moment before trying again.';
  if (status === 503) return `${label} service unavailable (503)`;
  if (status === 401 || status === 403) return `${label} auth failed (${status})`;
  return `${label} lookup failed (${status})`;
}

/** `{ street, city, state, zip }` as one line. Null when the vendor sent nothing. */
function flattenMailing(v: unknown): string | null {
  if (!isObj(v)) return null;
  const parts = [text(v.street) || text(v.address), text(v.city), text(v.state), text(v.zip)].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function readPhones(v: unknown): Array<{ number: string; type: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ number: string; type: string }> = [];
  for (const raw of v) {
    if (!isObj(raw)) continue;
    const number = text(raw.number);
    if (!number || out.some((p) => p.number === number)) continue;
    out.push({ number, type: text(raw.type).toLowerCase() || 'unknown' });
  }
  return out.slice(0, TRACERFY.MAX_PHONES);
}

function readEmails(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    const email = isObj(raw) ? text(raw.email) : text(raw);
    if (email && !out.includes(email)) out.push(email);
  }
  return out.slice(0, TRACERFY.MAX_EMAILS);
}

const fullName = (p: Record<string, unknown>): string =>
  text(p.full_name) || [text(p.first_name), text(p.last_name)].filter(Boolean).join(' ');

/** Lower rank first; a person with no rank sorts last rather than first. */
const rankOf = (p: Record<string, unknown>): number =>
  typeof p.rank === 'number' ? p.rank : Number.MAX_SAFE_INTEGER;

/** `"REGISTERED AGENT,MANAGER"` -> `['REGISTERED AGENT', 'MANAGER']`. */
const roleTokens = (p: Record<string, unknown>): string[] =>
  text(p.role)
    .toUpperCase()
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

/**
 * True only when this person is a service of process and NOTHING else.
 * See trap 2: a "REGISTERED AGENT,MANAGER" is a manager, and on the saved
 * payloads that is sometimes the only human the vendor returns.
 */
const isAgentOnly = (p: Record<string, unknown>): boolean =>
  p.is_registered_agent === true &&
  roleTokens(p).filter((r) => r !== 'REGISTERED AGENT').length === 0;

/** Someone who is only an agent-plus-something sorts behind someone who is not an agent at all. */
const byPrincipalThenRank = (
  a: Record<string, unknown>,
  b: Record<string, unknown>
): number =>
  Number(a.is_registered_agent === true) - Number(b.is_registered_agent === true) ||
  rankOf(a) - rankOf(b);

/**
 * Parse a FastAppend business-trace/lookup/ body. Pure, so it is testable
 * without a network and without spending a credit.
 */
export function parseBusinessTraceResponse(body: unknown): ContactResult {
  if (!isObj(body)) return contactFailure('Malformed business trace response');
  // Read `hit` and not `error`: see trap 1 above.
  if (typeof body.hit !== 'boolean') return contactFailure('Business trace response missing hit flag');
  if (!body.hit) return MISSED;

  const people = Array.isArray(body.associated_people) ? body.associated_people.filter(isObj) : [];
  // Trap 2. Drop the people who are ONLY a service of process; order what is
  // left so a plain principal always beats a principal who doubles as the agent.
  const principals = people.filter((p) => !isAgentOnly(p)).sort(byPrincipalThenRank);
  const principal = principals[0];

  if (principal) {
    return {
      success: true,
      hit: true,
      contacts: {
        ownerName: fullName(principal) || null,
        phones: readPhones(principal.phones),
        emails: readEmails(principal.emails),
        mailingAddress: flattenMailing(principal.mailing_address) ?? flattenMailing(body.mailing_address),
      },
    };
  }

  // No principal: either the vendor returned only registered agents, or the
  // record carries no people at all. The company-level block is still real and
  // still bought, so it is returned -- but with no person's name attached to
  // it, because naming a registered agent as the owner is the defect above.
  const phones = readPhones(body.phones);
  const emails = readEmails(body.emails);
  if (!phones.length && !emails.length) {
    return { success: true, hit: true, contacts: null };
  }
  return {
    success: true,
    hit: true,
    contacts: {
      ownerName: null,
      phones,
      emails,
      mailingAddress: flattenMailing(body.mailing_address),
    },
  };
}

/**
 * FastAppend business trace, SYNCHRONOUS. 1 credit ($0.10) on a hit, free on a
 * miss, 500/min.
 *
 * Keyed on company name plus STATE OF REGISTRATION, which is not necessarily
 * the property state: the caller decides which state to send (planRoute warns
 * when it is falling back to the property state).
 */
export async function lookupBusinessTrace(req: EntityTraceRequest): Promise<ContactResult> {
  const apiKey = process.env.FASTAPPEND_API_KEY;
  if (!apiKey) return contactFailure('FastAppend API key not configured');
  if (!text(req.company_name) || !text(req.state)) {
    return contactFailure('Business trace requires a company name and a state');
  }

  try {
    const response = await fetch(`${FASTAPPEND.BASE_URL}business-trace/lookup/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ company_name: req.company_name, state: req.state }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('FastAppend business trace lookup error:', response.status, errorText);
      return contactFailure(transportError('FastAppend', response.status));
    }

    return parseBusinessTraceResponse(await response.json());
  } catch (error) {
    console.error('FastAppend business trace lookup error:', error);
    return contactFailure('FastAppend service unavailable');
  }
}

/**
 * Parse a Tracerfy trace/lookup/ or trace/parcel/lookup/ body. One parser: the
 * two endpoints return the same envelope, `{ hit, persons_count, persons[],
 * credits_deducted }`, and differ only in the request keys echoed back.
 *
 * `want` is the name we asked for, used to pick among several persons at one
 * address. It is a NAME match, never `property_owner` -- see trap 3.
 */
export function parsePersonTraceResponse(
  body: unknown,
  want?: { first_name?: string; last_name?: string }
): ContactResult {
  // The research harness saw an array wrapper on this endpoint once; unwrap it
  // rather than failing a request the customer has been charged for.
  const one = Array.isArray(body) ? body[0] : body;
  if (!isObj(one)) return contactFailure('Malformed person trace response');
  if (typeof one.hit !== 'boolean') return contactFailure('Person trace response missing hit flag');
  if (!one.hit) return MISSED;

  const persons = Array.isArray(one.persons) ? one.persons.filter(isObj) : [];
  if (!persons.length) return { success: true, hit: true, contacts: null };

  const wantedLast = text(want?.last_name).toLowerCase();
  const wantedFirst = text(want?.first_name).toLowerCase();
  const named = wantedLast
    ? persons.find(
        (p) =>
          text(p.last_name).toLowerCase() === wantedLast &&
          (!wantedFirst || text(p.first_name).toLowerCase().startsWith(wantedFirst.charAt(0)))
      )
    : undefined;
  // No name to match on (the APN-keyed form sends none), or no person carries
  // it: take the vendor's own first record rather than discarding a paid hit.
  const person = named ?? persons[0];

  return {
    success: true,
    hit: true,
    contacts: {
      ownerName: fullName(person) || null,
      phones: readPhones(person.phones),
      emails: readEmails(person.emails),
      mailingAddress: flattenMailing(person.mailing_address),
    },
  };
}

/**
 * Tracerfy person lookup, SYNCHRONOUS. 5 credits ($0.10) on a hit, free on a
 * miss, and on the 500/min counter SHARED with the dossier.
 *
 * Two endpoints behind one callable, chosen by the key the caller has:
 *   parcel_id + county  ->  trace/parcel/lookup/   (APN-keyed fallback)
 *   otherwise           ->  trace/lookup/          (address + name)
 *
 * The address form always sends `find_owner: false` plus the name. Measured:
 * `find_owner: true` MISSED on an absentee-owned parcel where the named lookup
 * hit, so the named form is the one worth spending on whenever a name exists.
 */
export async function lookupPersonTrace(req: PersonTraceRequest): Promise<ContactResult> {
  const apiKey = process.env.TRACERFY_API_KEY;
  if (!apiKey) return contactFailure('Tracerfy API key not configured');

  const baseUrl = process.env.TRACERFY_API_URL || TRACERFY.BASE_URL;
  const byParcel = Boolean(text(req.parcel_id) && text(req.county));

  let path: string;
  let payload: Record<string, unknown>;

  if (byParcel) {
    if (!text(req.state)) return contactFailure('Parcel lookup requires a state');
    path = 'trace/parcel/lookup/';
    payload = { parcel_id: req.parcel_id, county: req.county, state: req.state };
  } else {
    if (!text(req.first_name) && !text(req.last_name)) {
      // find_owner:false with no name cannot match anything, and find_owner:true
      // is the form that missed. Refuse before spending rather than posting a
      // body that can only fail.
      return contactFailure('Person trace requires a first or last name');
    }
    if (!text(req.address) || !text(req.city) || !text(req.state)) {
      return contactFailure('Person trace requires address, city and state');
    }
    path = 'trace/lookup/';
    payload = {
      address: req.address,
      city: req.city,
      state: req.state,
      ...(text(req.zip) ? { zip: req.zip } : {}),
      find_owner: false,
      first_name: req.first_name,
      last_name: req.last_name,
    };
  }

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Tracerfy person lookup error:', response.status, errorText);
      return contactFailure(transportError('Tracerfy', response.status));
    }

    return parsePersonTraceResponse(await response.json(), {
      first_name: req.first_name,
      last_name: req.last_name,
    });
  } catch (error) {
    console.error('Tracerfy person lookup error:', error);
    return contactFailure('Tracerfy service unavailable');
  }
}

/**
 * Submit a batch of addresses for skip tracing.
 */
export async function submitBulkTrace(
  csvContent: string
): Promise<{ success: boolean; jobId?: string; error?: string }> {
  if (!API_KEY) {
    return { success: false, error: 'Tracerfy API key not configured' };
  }

  try {
    const formData = new FormData();
    const blob = new Blob([csvContent], { type: 'text/csv' });
    formData.append('csv_file', blob, 'bulk-trace.csv');

    // Column mapping parameters (no zip_column - matches Tracerfy's expected format)
    formData.append('address_column', 'address');
    formData.append('city_column', 'city');
    formData.append('state_column', 'state');
    formData.append('first_name_column', 'first_name');
    formData.append('last_name_column', 'last_name');
    formData.append('mail_address_column', 'mail_address');
    formData.append('mail_city_column', 'mail_city');
    formData.append('mail_state_column', 'mail_state');

    const response = await fetch(`${BASE_URL}trace/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Tracerfy bulk submit error:', errorText);
      return { success: false, error: 'Failed to submit bulk trace request' };
    }

    const result: TracerfySubmitResponse = await response.json();
    return { success: true, jobId: result.queue_id?.toString() || result.job_id };
  } catch (error) {
    console.error('Tracerfy bulk submit error:', error);
    return { success: false, error: 'Tracerfy service unavailable' };
  }
}

/**
 * Get the status and results of a trace job.
 * Polls /queue/{id} directly - returns { pending: true } object while processing,
 * or an array of results when complete.
 */
export async function getJobStatus(
  jobId: string
): Promise<{
  success: boolean;
  pending?: boolean;
  results?: TracerfyResult[];
  rawData?: unknown;
  error?: string;
  // Set when the underlying response was unhealthy. Callers can use this to
  // distinguish "Tracerfy is genuinely still working" (no errorReason) from
  // "we kept polling through 503s / rate limits / garbage responses"
  // (errorReason set). See TracerfyErrorReason at top of file.
  errorReason?: TracerfyErrorReason;
}> {
  if (!API_KEY) {
    return { success: false, error: 'Tracerfy API key not configured' };
  }

  try {
    const response = await fetch(`${BASE_URL}queue/${jobId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        // Rate limited - still pending, but tag the reason so the caller can
        // stall-detect after the row has been in this state too long.
        return { success: true, pending: true, errorReason: 'rate_limited' };
      }
      if (response.status === 503) {
        return { success: true, pending: true, errorReason: 'upstream_unavailable' };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          error: `Tracerfy auth failed (${response.status})`,
          errorReason: 'auth_error',
        };
      }
      return { success: false, error: 'Failed to get job results' };
    }

    const data = await response.json();

    // Results ready - Tracerfy returns an array when complete
    if (Array.isArray(data)) {
      return { success: true, pending: false, results: data as TracerfyResult[], rawData: data };
    }

    // Still pending - Tracerfy returns an object with pending: true
    if (data && data.pending === true) {
      return { success: true, pending: true, rawData: data };
    }

    // Unknown response format - tag it so callers can stall-detect instead of
    // polling forever on garbage responses.
    console.error('Unexpected Tracerfy response format:', JSON.stringify(data));
    return { success: true, pending: true, rawData: data, errorReason: 'malformed_response' };
  } catch (error) {
    console.error('Tracerfy job status error:', error);
    return {
      success: false,
      error: 'Tracerfy service unavailable',
      errorReason: 'network_error',
    };
  }
}

/**
 * List all jobs for the account.
 */
export async function listJobs(): Promise<{
  success: boolean;
  jobs?: Array<{ job_id: string; status: string; created_at: string }>;
  error?: string;
}> {
  if (!API_KEY) {
    return { success: false, error: 'Tracerfy API key not configured' };
  }

  try {
    const response = await fetch(`${BASE_URL}queues/`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
    });

    if (!response.ok) {
      return { success: false, error: 'Failed to list jobs' };
    }

    const jobs = await response.json();
    return { success: true, jobs };
  } catch (error) {
    console.error('Tracerfy list jobs error:', error);
    return { success: false, error: 'Tracerfy service unavailable' };
  }
}

/**
 * Get account analytics and credit balance.
 */
export async function getAnalytics(): Promise<{
  success: boolean;
  data?: {
    credits_remaining: number;
    credits_used: number;
    total_jobs: number;
    total_records: number;
  };
  error?: string;
}> {
  if (!API_KEY) {
    return { success: false, error: 'Tracerfy API key not configured' };
  }

  try {
    const response = await fetch(`${BASE_URL}analytics/`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
    });

    if (!response.ok) {
      return { success: false, error: 'Failed to get analytics' };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    console.error('Tracerfy analytics error:', error);
    return { success: false, error: 'Tracerfy service unavailable' };
  }
}

/**
 * Parse Tracerfy flat result into our internal TraceResult format.
 * Tracerfy returns flat fields: primary_phone, mobile_1-5, landline_1-3, email_1-5, etc.
 */
export function parseTracerfyResult(result: TracerfyResult) {
  // Build owner name from first_name + last_name
  const firstName = result.first_name?.trim() || '';
  const lastName = result.last_name?.trim() || '';
  const ownerName = [firstName, lastName].filter(Boolean).join(' ') || null;

  // Collect phones from flat fields
  const phones: Array<{ number: string; type: 'mobile' | 'landline' | 'voip' | 'unknown' }> = [];

  // Primary phone
  if (result.primary_phone) {
    phones.push({ number: result.primary_phone, type: 'mobile' });
  }

  // Mobile phones 1-5
  const mobileFields = [result.mobile_1, result.mobile_2, result.mobile_3, result.mobile_4, result.mobile_5];
  for (const num of mobileFields) {
    if (num && !phones.some((p) => p.number === num)) {
      phones.push({ number: num, type: 'mobile' });
    }
  }

  // Landline phones 1-3
  const landlineFields = [result.landline_1, result.landline_2, result.landline_3];
  for (const num of landlineFields) {
    if (num && !phones.some((p) => p.number === num)) {
      phones.push({ number: num, type: 'landline' });
    }
  }

  // Collect emails from flat fields
  const emails: string[] = [];
  const emailFields = [result.email_1, result.email_2, result.email_3, result.email_4, result.email_5];
  for (const email of emailFields) {
    if (email) {
      emails.push(email);
    }
  }

  return {
    owner_name: ownerName,
    owner_name_2: null,
    phones: phones.slice(0, TRACERFY.MAX_PHONES),
    emails: emails.slice(0, TRACERFY.MAX_EMAILS),
    mailing_address: result.mail_address || null,
    mailing_city: result.mail_city || null,
    mailing_state: result.mail_state || null,
    mailing_zip: null,
    match_confidence: phones.length > 0 || emails.length > 0 ? 80 : 0,
  };
}
