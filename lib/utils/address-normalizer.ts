import crypto from 'crypto';

/**
 * Normalizes an address for consistent deduplication.
 * Removes apartment/unit/suite numbers and standardizes format.
 *
 * The key is STREET|CITY|STATE. ZIP was removed from it on 2026-09-04 and the `zip`
 * parameter was deleted rather than ignored, so no caller can believe it still matters.
 *
 * Why: ZIP was never a discriminator we could trust. Measured against live trace_history
 * (3,632 rows) before the change, 15 groups carried the same street/city/state under two
 * different ZIPs -- 3661 AIRPORT BLVD MOBILE AL as both 36608 and 36609, 1850 MAGWOOD DR
 * CHARLESTON SC as both 29414 and 29403. Those are one property charged twice, not two
 * properties. Including ZIP made the key MORE permissive, not more precise.
 *
 * Accepted cost, deliberately: two genuinely different properties sharing a street name and
 * city across a ZIP boundary now collide, and the second is treated as a duplicate. That
 * fails toward not charging the customer twice, which is the safe direction.
 */
export function normalizeAddress(
  address: string,
  city: string,
  state: string
): string {
  // Remove apartment/unit/suite numbers for better matching
  const cleanAddress = address
    .toUpperCase()
    .trim()
    // Remove apt, unit, suite, # followed by alphanumeric
    .replace(/\b(APT|APARTMENT|UNIT|STE|SUITE|#)\s*[A-Z0-9-]+/gi, '')
    // Remove common abbreviations and normalize
    .replace(/\bSTREET\b/gi, 'ST')
    .replace(/\bAVENUE\b/gi, 'AVE')
    .replace(/\bBOULEVARD\b/gi, 'BLVD')
    .replace(/\bDRIVE\b/gi, 'DR')
    .replace(/\bLANE\b/gi, 'LN')
    .replace(/\bCOURT\b/gi, 'CT')
    .replace(/\bCIRCLE\b/gi, 'CIR')
    .replace(/\bPLACE\b/gi, 'PL')
    .replace(/\bROAD\b/gi, 'RD')
    .replace(/\bPARKWAY\b/gi, 'PKWY')
    .replace(/\bHIGHWAY\b/gi, 'HWY')
    .replace(/\bNORTH\b/gi, 'N')
    .replace(/\bSOUTH\b/gi, 'S')
    .replace(/\bEAST\b/gi, 'E')
    .replace(/\bWEST\b/gi, 'W')
    // Remove special characters except spaces
    .replace(/[^\w\s]/g, '')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();

  const cleanCity = city.toUpperCase().trim();
  const cleanState = state.toUpperCase().trim();

  return `${cleanAddress}|${cleanCity}|${cleanState}`;
}

/**
 * Creates a SHA256 hash of the normalized address for database storage.
 */
export function createAddressHash(normalizedAddress: string): string {
  return crypto.createHash('sha256').update(normalizedAddress).digest('hex');
}

/**
 * Validates that an address has the minimum required fields.
 *
 * ZIP is OPTIONAL as of 2026-09-04. It is validated when supplied and never demanded.
 *
 * Why it stopped being required: it never reached either vendor. The Tracerfy person CSV
 * has no zip column (lib/tracerfy/client.ts:54) and the FastAppend entity path submits
 * business_name + state only. ZIP was rejecting records at the door for a field nothing
 * downstream reads. Its cost was concrete -- skipTraceBulk fails the ENTIRE batch if one
 * record is invalid, and the property-registry can supply a city for 804 counties while
 * supplying a ZIP for only 766, so 241 counties covering 16,062,225 parcels were untraceable.
 *
 * Present-and-malformed is still an error. Absent is a fact about the source; wrong is a
 * caller bug, and letting it through would quietly make the stored ZIP untrustworthy.
 */
export function validateAddressInput(
  address: string,
  city: string,
  state: string,
  zip?: string
): { valid: boolean; error?: string } {
  if (!address || address.trim().length < 3) {
    return { valid: false, error: 'Address is required and must be at least 3 characters' };
  }
  if (!city || city.trim().length < 2) {
    return { valid: false, error: 'City is required' };
  }
  if (!state || state.trim().length !== 2) {
    return { valid: false, error: 'State must be a 2-letter abbreviation' };
  }
  if (zip !== undefined && zip.trim() !== '' && !/^\d{5}(-\d{4})?$/.test(zip.trim())) {
    return { valid: false, error: 'ZIP code must be 5 or 9 digits when supplied' };
  }
  return { valid: true };
}

/**
 * Formats an address for display.
 */
export function formatAddress(
  address: string,
  city: string,
  state: string,
  zip: string
): string {
  return `${address}, ${city}, ${state} ${zip}`;
}
