import crypto from 'crypto';

/**
 * Normalizes an address for consistent deduplication.
 * Removes apartment/unit/suite numbers and standardizes format.
 */
export function normalizeAddress(
  address: string,
  city: string,
  state: string,
  zip: string
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
  // Only use first 5 digits of ZIP
  const cleanZip = zip.replace(/\D/g, '').substring(0, 5);

  return `${cleanAddress}|${cleanCity}|${cleanState}|${cleanZip}`;
}

/**
 * Creates a SHA256 hash of the normalized address for database storage.
 */
export function createAddressHash(normalizedAddress: string): string {
  return crypto.createHash('sha256').update(normalizedAddress).digest('hex');
}

/**
 * Validates that an address has the minimum required fields.
 */
export function validateAddressInput(
  address: string,
  city: string,
  state: string,
  zip: string
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
  if (!zip || !/^\d{5}(-\d{4})?$/.test(zip.trim())) {
    return { valid: false, error: 'ZIP code must be 5 or 9 digits' };
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
