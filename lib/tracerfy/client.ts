import { TRACERFY, FASTAPPEND } from '@/lib/constants';
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
): Promise<{ success: boolean; pending?: boolean; results?: TracerfyResult[]; rawData?: unknown; error?: string }> {
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
      if (response.status === 503 || response.status === 429) {
        // Rate limited - treat as still pending
        return { success: true, pending: true };
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

    // Unknown response format - log it and treat as pending rather than empty
    console.error('Unexpected Tracerfy response format:', JSON.stringify(data));
    return { success: true, pending: true, rawData: data };
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
