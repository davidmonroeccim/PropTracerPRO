import { HIGHLEVEL } from '@/lib/constants';

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
