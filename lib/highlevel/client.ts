import { HIGHLEVEL } from '@/lib/constants';
import type { TraceResult } from '@/types';

const API_KEY = process.env.HIGHLEVEL_API_KEY;
const LOCATION_ID = process.env.HIGHLEVEL_LOCATION_ID;
const MEMBER_TAG = process.env.HIGHLEVEL_MEMBER_TAG || 'sp3-owner';

/**
 * The tag put on contacts PTP creates in the customer's CRM. Sent on CREATE
 * only. Never send it on an update: HighLevel's PUT overwrites the whole tag
 * array, so it would delete the customer's own tags. See the update branch.
 */
const CONTACT_TAG = 'proptracerpro';

interface HighLevelContact {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  tags?: string[];
}

interface SearchResponse {
  contacts: HighLevelContact[];
}

/**
 * Verifies if a user is an AcquisitionPRO member by checking HighLevel CRM.
 * Looks for a contact with matching email that has the sp3-owner tag.
 */
export async function verifyAcquisitionProMember(
  userEmail: string
): Promise<{ verified: boolean; message?: string }> {
  if (!API_KEY || !LOCATION_ID) {
    console.error('HighLevel credentials not configured');
    return {
      verified: false,
      message: 'Member verification is not configured. Please contact support.',
    };
  }

  try {
    // Search for contact by email using the contacts list endpoint with query filter
    const searchUrl = `${HIGHLEVEL.BASE_URL}/contacts/?locationId=${LOCATION_ID}&query=${encodeURIComponent(userEmail)}`;

    const response = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Version: HIGHLEVEL.API_VERSION,
      },
    });

    if (!response.ok) {
      console.error('HighLevel API error:', response.status, await response.text());
      return {
        verified: false,
        message: 'Unable to verify membership. Please try again later.',
      };
    }

    const data: SearchResponse = await response.json();

    if (!data.contacts || data.contacts.length === 0) {
      return {
        verified: false,
        message: 'No AcquisitionPRO membership found for this email address.',
      };
    }

    // Check if any contact has the sp3-owner tag
    for (const contact of data.contacts) {
      if (contact.tags?.includes(MEMBER_TAG)) {
        return { verified: true };
      }
    }

    return {
      verified: false,
      message: 'Your email is not associated with an active AcquisitionPRO® membership.',
    };
  } catch (error) {
    console.error('HighLevel verification error:', error);
    return {
      verified: false,
      message: 'Verification service temporarily unavailable.',
    };
  }
}

/**
 * Creates a contact in HighLevel CRM.
 */
export async function createHighLevelContact(data: {
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  source?: string;
  tags?: string[];
  customFields?: Array<{ key: string; value: string }>;
}): Promise<{ success: boolean; contactId?: string; error?: string }> {
  if (!API_KEY || !LOCATION_ID) {
    return { success: false, error: 'HighLevel not configured' };
  }

  try {
    const response = await fetch(`${HIGHLEVEL.BASE_URL}/contacts/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Version: HIGHLEVEL.API_VERSION,
      },
      body: JSON.stringify({
        locationId: LOCATION_ID,
        ...data,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('HighLevel create contact error:', errorText);
      return { success: false, error: 'Failed to create contact' };
    }

    const result = await response.json();
    return { success: true, contactId: result.contact?.id };
  } catch (error) {
    console.error('HighLevel create contact error:', error);
    return { success: false, error: 'Service unavailable' };
  }
}

/** Which of three things a failed push means is broken. See classifyStatus. */
export type HighLevelFailureKind = 'credential' | 'record' | 'transient';

/**
 * WHICH credential problem it is. The status cannot tell you: a missing scope
 * and a revoked token are BOTH 401 in HighLevel, and only the body's `message`
 * separates them. `unknown` is a first-class answer, not a fallback bucket.
 */
export type HighLevelCredentialReason = 'token' | 'scope' | 'location' | 'unknown';

export type HighLevelPushResult =
  | { success: true; contactId?: string; action: 'created' | 'updated' }
  | {
      success: false;
      kind: 'credential';
      reason: HighLevelCredentialReason;
      status: number;
      error: string;
    }
  | { success: false; kind: 'record'; status: number; error: string }
  | { success: false; kind: 'transient'; status?: number; error: string };

/**
 * THE CLASSIFICATION GATE. All three kinds are `success: false` and the next
 * reader will want to merge them into one boolean. Do not. They differ in who
 * has to act, and that is the only thing the caller can key handling on:
 *
 *   credential  401, 403        the stored key is dead for EVERY future push,
 *                               not just this one. The account owner has to
 *                               reconnect. No retry will ever help.
 *   transient   429, any >= 500 nothing is broken. A retry is the right answer,
 *               network throw   and telling the user to fix their key is a lie.
 *   record      everything else this one payload was refused. The credential is
 *               (400, 404, 422) fine and every other record will still push.
 *
 * Collapsing them sends "your API key is dead" and "this one address was
 * malformed" down the same pipe, which is the defect this type exists to stop.
 */
function classifyStatus(status: number): HighLevelFailureKind {
  if (status === 401 || status === 403) return 'credential';
  if (status === 429 || status >= 500) return 'transient';
  return 'record';
}

/**
 * Pull HighLevel's `message` out of an error body. The body may not be JSON at
 * all (a proxy's HTML error page, an empty string), and `message` is sometimes
 * an array of strings. Anything we cannot read is null, never a guess.
 */
function errorMessageOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return null;
    const message = (parsed as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) {
      const parts = message.filter((p): p is string => typeof p === 'string');
      return parts.length > 0 ? parts.join(' ') : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * WHY THIS IS NOT DERIVED FROM THE STATUS. A token missing the contacts.write
 * scope returns 401, exactly like a revoked token, and PTP's own setup copy
 * tells users to grant "contacts" while contacts.readonly and contacts.write
 * are SEPARATE scopes. So a read-only token is a likely real-world shape: it
 * passes Test Connection (a GET) and fails every push (a PUT or POST). Telling
 * that user to re-paste their token sends them down the wrong path.
 *
 * Matching is positive-only and best-effort. The scope wording below comes from
 * a developer-forum report rather than HighLevel staff or the official docs, so
 * if they reword it the correct behaviour is to degrade to `unknown` and show a
 * generic credential failure. Mislabelling an unrecognised 401 as a revoked
 * token would be inventing a result (repo rule 7).
 */
function credentialReasonOf(status: number, body: string): HighLevelCredentialReason {
  const message = errorMessageOf(body)?.toLowerCase();
  if (!message) return 'unknown';

  if (status === 403 && message.includes('access to this location')) return 'location';
  if (status === 401 && message.includes('scope')) return 'scope';
  if (
    status === 401 &&
    (message.includes('invalid jwt') ||
      message.includes('invalid token') ||
      message.includes('jwt expired'))
  ) {
    return 'token';
  }
  return 'unknown';
}

/** What the customer reads. Each sentence names the remediation for its reason. */
const CREDENTIAL_MESSAGE: Record<HighLevelCredentialReason, string> = {
  token: 'HighLevel rejected your API key. Reconnect HighLevel in Settings.',
  scope:
    'Your HighLevel token is missing the contacts.write permission. Reconnect it with that scope granted.',
  location:
    'Your HighLevel token does not have access to that location. Check the location ID in Settings.',
  unknown: 'HighLevel refused the credential. Check your HighLevel connection in Settings.',
};

const RECORD_MESSAGE = 'HighLevel would not accept this contact.';
/** Covers 429, every 5xx and a thrown network error: in all three HighLevel is simply not taking it. */
const TRANSIENT_MESSAGE = 'HighLevel is not accepting pushes right now. Try again shortly.';

/** Any classified refusal, whatever call produced it. */
export type HighLevelPushFailure = Extract<HighLevelPushResult, { success: false }>;

/** Turn a non-ok response into a classified failure, and log the status while we have it. */
async function failureFrom(stage: string, response: Response): Promise<HighLevelPushFailure> {
  const body = await response.text();
  const status = response.status;
  const kind = classifyStatus(status);

  let failure: HighLevelPushFailure;
  if (kind === 'credential') {
    const reason = credentialReasonOf(status, body);
    failure = { success: false, kind, reason, status, error: CREDENTIAL_MESSAGE[reason] };
  } else if (kind === 'record') {
    failure = { success: false, kind, status, error: RECORD_MESSAGE };
  } else {
    failure = { success: false, kind, status, error: TRANSIENT_MESSAGE };
  }

  // The status is the whole point. Before this, a 401, a 422 and a 429 all
  // logged the identical string 'Failed to create contact'.
  console.error(`HighLevel ${stage} failed:`, { ...failure, body });
  return failure;
}

/** A thrown fetch is always transient: we never reached HighLevel, so nothing is known to be broken. */
function networkFailure(stage: string, cause: unknown): HighLevelPushFailure {
  console.error(`HighLevel ${stage} failed:`, { kind: 'transient', cause });
  return { success: false, kind: 'transient', error: TRANSIENT_MESSAGE };
}

/** A credential check: it worked, or the same classified refusal a push returns. */
export type HighLevelValidation = { success: true } | HighLevelPushFailure;

/**
 * Asks HighLevel whether a credential works, by reading one contact.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT, because the difference decides what
 * the caller is allowed to do with the answer. This is a READ. Every product
 * call PTP makes is a WRITE, and `contacts.readonly` and `contacts.write` are
 * SEPARATE HighLevel scopes
 * (https://marketplace.gohighlevel.com/docs/Authorization/Scopes/). So:
 *
 *   success          the token reaches this location and can read contacts.
 *                    It does NOT prove a write will be accepted.
 *   reason token     the token itself was rejected. That holds for every verb.
 *   reason location  the token cannot reach this location. Every verb again.
 *   reason scope     only that the READ scope is missing. A token with
 *                    contacts.write and not contacts.readonly lands here and
 *                    pushes perfectly. Refusing on this would block a working
 *                    credential.
 *   transient/record HighLevel did not give us an answer we can generalise
 *                    from. Assert nothing.
 *
 * Callers must key on the reason, never on "the check failed".
 */
export async function validateHighLevelCredential(params: {
  apiKey: string;
  locationId: string;
}): Promise<HighLevelValidation> {
  const { apiKey, locationId } = params;

  try {
    const url = `${HIGHLEVEL.BASE_URL}/contacts/?locationId=${encodeURIComponent(locationId)}&limit=1`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: HIGHLEVEL.API_VERSION,
      },
    });

    if (!response.ok) return failureFrom('credential check', response);

    return { success: true };
  } catch (error) {
    return networkFailure('credential check', error);
  }
}

/**
 * Pushes a trace result to the user's HighLevel CRM as a contact.
 * Searches for an existing contact by phone/email first; updates if found, creates if not.
 * Uses the user's own API key and location ID (not env vars).
 */
export async function pushTraceToHighLevel(params: {
  apiKey: string;
  locationId: string;
  traceResult: TraceResult;
  propertyAddress?: string;
  propertyCity?: string;
  propertyState?: string;
  propertyZip?: string;
}): Promise<HighLevelPushResult> {
  const { apiKey, locationId, traceResult } = params;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Version: HIGHLEVEL.API_VERSION,
  };

  // Parse owner name into first/last
  const nameParts = (traceResult.owner_name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const phone = traceResult.phones?.[0]?.number || '';
  const email = traceResult.emails?.[0] || '';

  // Search for existing contact by phone or email
  let existingContactId: string | null = null;
  const searchQuery = phone || email;

  if (searchQuery) {
    try {
      const searchUrl = `${HIGHLEVEL.BASE_URL}/contacts/?locationId=${locationId}&query=${encodeURIComponent(searchQuery)}`;
      const searchRes = await fetch(searchUrl, { method: 'GET', headers });

      // A REFUSED SEARCH STOPS THE PUSH. It must not fall through to create.
      // This test used to have no else, so a 401 here left existingContactId
      // null and the code created a SECOND copy of a contact the customer
      // already had. A refused search means we do not know whether the contact
      // exists, and creating on unknown state is inventing a result.
      if (!searchRes.ok) return failureFrom('contact search', searchRes);

      const searchData: SearchResponse = await searchRes.json();
      if (searchData.contacts?.length > 0) {
        existingContactId = searchData.contacts[0].id;
      }
    } catch (err) {
      return networkFailure('contact search', err);
    }
  }

  const contactData = {
    firstName,
    lastName,
    phone: phone || undefined,
    email: email || undefined,
    address1: traceResult.mailing_address || params.propertyAddress || undefined,
    city: traceResult.mailing_city || params.propertyCity || undefined,
    state: traceResult.mailing_state || params.propertyState || undefined,
    postalCode: traceResult.mailing_zip || params.propertyZip || undefined,
  };

  try {
    if (existingContactId) {
      // NO `tags` ON UPDATE, AND THIS IS NOT AN OVERSIGHT.
      //
      // HighLevel's Update Contact endpoint says, verbatim: "This field will
      // overwrite all current tags associated with the contact."
      // https://marketplace.gohighlevel.com/docs/ghl/contacts/update-contact/
      //
      // This function used to send `tags: ['proptracerpro']` on every update,
      // which deleted every other tag the customer had on that contact. In
      // HighLevel tags drive workflows, so it was also silently breaking their
      // automation, on a push that reported success. Tags stay on CREATE below,
      // where there is no existing array to overwrite.
      //
      // Re-tagging an existing contact needs the additive
      // POST /contacts/:contactId/tags endpoint, which HighLevel's own update
      // doc points to for exactly this. It is deliberately NOT used yet: that
      // endpoint's additivity is implied by its name and response shape rather
      // than stated in the docs, and swapping verified destruction for
      // unverified behaviour is not a fix. Verify it against a real account
      // first. Until then an existing contact keeps the tags it already has.
      const updateRes = await fetch(`${HIGHLEVEL.BASE_URL}/contacts/${existingContactId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(contactData),
      });

      if (!updateRes.ok) return failureFrom('update contact', updateRes);

      return { success: true, contactId: existingContactId, action: 'updated' };
    } else {
      // Create new contact. `tags` is safe HERE and only here: a contact being
      // created has no existing tag array for it to overwrite. See the note on
      // the update branch above for why it must never be sent on a PUT.
      const createRes = await fetch(`${HIGHLEVEL.BASE_URL}/contacts/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ locationId, ...contactData, tags: [CONTACT_TAG] }),
      });

      if (!createRes.ok) return failureFrom('create contact', createRes);

      const createData = await createRes.json();
      return { success: true, contactId: createData.contact?.id, action: 'created' };
    }
  } catch (error) {
    return networkFailure(existingContactId ? 'update contact' : 'create contact', error);
  }
}
