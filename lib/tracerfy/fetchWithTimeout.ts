/**
 * One vendor HTTP call with a ceiling (spec D7).
 *
 * WHY THE BODY IS READ IN HERE. A vendor can send its headers promptly and then stall the body.
 * A timer cleared when fetch() resolves would not cover that, so the text is read inside the same
 * window and the caller parses the string.
 *
 * A call that runs out of time throws VendorTimeoutError, and each client turns that into its own
 * failure shape. A timeout is a vendor FAILURE: free, never a miss, and on a Tier 1 record it ends
 * busy_try_again.
 */
import { VENDOR_TIMEOUT } from '@/lib/constants';

/** What a caller with a request budget may ask of a vendor client. */
export interface VendorCallOptions {
  /** A tighter ceiling than VENDOR_TIMEOUT.CALL_MS. Never a looser one. */
  timeoutMs?: number;
}

export class VendorTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`did not answer within ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'VendorTimeoutError';
  }
}

export interface TimedResponse {
  status: number;
  ok: boolean;
  text: string;
}

/** The ceiling a client applies: the caller's when it is tighter, never looser. */
export function callTimeoutMs(requested?: number): number {
  return typeof requested === 'number' && requested > 0
    ? Math.min(requested, VENDOR_TIMEOUT.CALL_MS)
    : VENDOR_TIMEOUT.CALL_MS;
}

export async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<TimedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  } catch (error) {
    if (controller.signal.aborted) throw new VendorTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
