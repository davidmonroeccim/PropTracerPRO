import { TRACERFY } from '@/lib/constants';
import type { TracerfyResult } from '@/types';

const API_KEY = process.env.TRACERFY_API_KEY;
const BASE_URL = process.env.TRACERFY_API_URL || TRACERFY.BASE_URL;

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

    // Create CSV content with required columns
    // Tracerfy expects: address, city, state, zip, first_name, last_name, mail_address, mail_city, mail_state
    const csvContent = [
      'address,city,state,zip,first_name,last_name,mail_address,mail_city,mail_state',
      `"${data.address}","${data.city}","${data.state}","${data.zip}","${firstName}","${lastName}","","",""`,
    ].join('\n');

    const formData = new FormData();
    const blob = new Blob([csvContent], { type: 'text/csv' });
    formData.append('csv_file', blob, 'trace.csv');

    // Required column mapping parameters
    formData.append('address_column', 'address');
    formData.append('city_column', 'city');
    formData.append('state_column', 'state');
    formData.append('zip_column', 'zip');
    formData.append('first_name_column', 'first_name');
    formData.append('last_name_column', 'last_name');
    formData.append('mail_address_column', 'mail_address');
    formData.append('mail_city_column', 'mail_city');
    formData.append('mail_state_column', 'mail_state');

    const url = `${BASE_URL}trace/`;
    console.log('Tracerfy request URL:', url);
    console.log('Tracerfy API key present:', !!API_KEY);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
      body: formData,
    });

    console.log('Tracerfy response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Tracerfy submit error:', errorText);

      // Handle rate limiting specifically
      if (response.status === 429) {
        return { success: false, error: 'Rate limit exceeded. Please wait a moment before trying again.' };
      }

      return { success: false, error: 'Failed to submit trace request' };
    }

    const result: TracerfySubmitResponse = await response.json();
    console.log('Tracerfy submit result:', JSON.stringify(result));
    return { success: true, jobId: result.queue_id?.toString() || result.job_id };
  } catch (error) {
    console.error('Tracerfy submit error:', error);
    return { success: false, error: 'Tracerfy service unavailable' };
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

    // Required column mapping parameters - assumes CSV has these column headers
    formData.append('address_column', 'address');
    formData.append('city_column', 'city');
    formData.append('state_column', 'state');
    formData.append('zip_column', 'zip');
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
 * Tracerfy returns a JSON array when results are ready,
 * or an object with pending:true while still processing.
 */
export async function getJobStatus(
  jobId: string
): Promise<{ success: boolean; pending?: boolean; results?: TracerfyResult[]; error?: string }> {
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
      const errorText = await response.text();
      console.error('Tracerfy job status error:', errorText);
      return { success: false, error: 'Failed to get job status' };
    }

    const data = await response.json();
    console.log('Tracerfy queue response type:', Array.isArray(data) ? 'array' : 'object');
    console.log('Tracerfy queue response:', JSON.stringify(data).substring(0, 500));

    // When results are ready, Tracerfy returns a JSON array of results
    if (Array.isArray(data)) {
      return { success: true, pending: false, results: data as TracerfyResult[] };
    }

    // When still processing, returns an object with pending field
    if (data.pending === true) {
      return { success: true, pending: true };
    }

    // If pending is false but response is an object (has download_url), treat as complete with no inline results
    if (data.pending === false && data.download_url) {
      console.log('Tracerfy download URL:', data.download_url);
      return { success: true, pending: false, results: [] };
    }

    // Unknown format - log and treat as pending
    console.log('Tracerfy unknown response format:', JSON.stringify(data));
    return { success: true, pending: true };
  } catch (error) {
    console.error('Tracerfy job status error:', error);
    return { success: false, error: 'Tracerfy service unavailable' };
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
