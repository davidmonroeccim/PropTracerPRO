import { HIGHLEVEL } from '@/lib/constants';
import type { TraceResult } from '@/types';

const API_KEY = process.env.HIGHLEVEL_API_KEY;
const LOCATION_ID = process.env.HIGHLEVEL_LOCATION_ID;
const MEMBER_TAG = process.env.HIGHLEVEL_MEMBER_TAG || 'sp3-owner';

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
}): Promise<{ success: boolean; contactId?: string; action?: 'created' | 'updated'; error?: string }> {
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

      if (searchRes.ok) {
        const searchData: SearchResponse = await searchRes.json();
        if (searchData.contacts?.length > 0) {
          existingContactId = searchData.contacts[0].id;
        }
      }
    } catch (err) {
      console.error('HighLevel contact search error:', err);
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
    tags: ['proptracerpro'],
  };

  try {
    if (existingContactId) {
      // Update existing contact
      const updateRes = await fetch(`${HIGHLEVEL.BASE_URL}/contacts/${existingContactId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(contactData),
      });

      if (!updateRes.ok) {
        const errText = await updateRes.text();
        console.error('HighLevel update contact error:', errText);
        return { success: false, error: 'Failed to update contact' };
      }

      return { success: true, contactId: existingContactId, action: 'updated' };
    } else {
      // Create new contact
      const createRes = await fetch(`${HIGHLEVEL.BASE_URL}/contacts/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ locationId, ...contactData }),
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        console.error('HighLevel create contact error:', errText);
        return { success: false, error: 'Failed to create contact' };
      }

      const createData = await createRes.json();
      return { success: true, contactId: createData.contact?.id, action: 'created' };
    }
  } catch (error) {
    console.error('HighLevel push error:', error);
    return { success: false, error: 'Service unavailable' };
  }
}
