import { TRACERFY } from '@/lib/constants';
import type { TracerfyJobResponse, TracerfyResult } from '@/types';

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
 */
export async function getJobStatus(
  jobId: string
): Promise<{ success: boolean; data?: TracerfyJobResponse; error?: string }> {
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

    const data: TracerfyJobResponse = await response.json();
    return { success: true, data };
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
 * Parse Tracerfy result into our internal format.
 */
export function parseTracerfyResult(result: TracerfyResult) {
  return {
    owner_name: result.owner_name || null,
    owner_name_2: null,
    phones: (result.phones || []).slice(0, TRACERFY.MAX_PHONES).map((p) => ({
      number: p.number,
      type: (p.type?.toLowerCase() || 'unknown') as 'mobile' | 'landline' | 'voip' | 'unknown',
    })),
    emails: (result.emails || []).slice(0, TRACERFY.MAX_EMAILS),
    mailing_address: result.mailing_address || null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    match_confidence: result.phones?.length || result.emails?.length ? 80 : 0,
  };
}
