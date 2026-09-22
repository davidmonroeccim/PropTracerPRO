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
 * The shape of a US ZIP, in ONE place.
 *
 * Read by the validator below and by usableZip(), which have to agree: one of them
 * decides whether a caller gets an error and the other decides what we store and
 * send to a vendor, and two copies of this pattern is how those two answers drift.
 */
const ZIP_SHAPE = /^\d{5}(-\d{4})?$/;

/**
 * The five-digit ZIP a row can be STORED and looked up with, or '' when what
 * arrived is not a ZIP at all.
 *
 * WHY A MALFORMED ZIP BECOMES NO ZIP RATHER THAN BEING KEPT. Excel strips the
 * leading zero from a ZIP column on export, so a county file for MA, NJ, CT, RI,
 * NH, ME, VT or PR arrives with '2134' on every row. That row is still perfectly
 * lookupable: `normalizeAddress` excludes the ZIP entirely, so the dedup key is
 * unaffected, and the tier 2 dossier accepts address mode with NO zip and
 * BACKFILLS the property's own zip on a hit (lib/routing/executeRoute.ts).
 *
 * Carrying '2134' through instead would send a zip that CONTRADICTS the street,
 * city and state it travels with, which executeRoute.ts already records as worse
 * than sending none, and tier 2 bills per record submitted -- so a miss we caused
 * with our own mangled input is a miss the customer pays for. It would also block
 * the backfill, because the backfill only fires when the caller had no zip, and
 * leave a number in the `zip` column that is not one.
 *
 * NOT a fallback value and not invented data: '' is this row saying it has no
 * zip, which is the truth, and the dossier is then free to teach us the real one.
 */
export function usableZip(zip?: string | null): string {
  const trimmed = (zip || '').trim();
  return ZIP_SHAPE.test(trimmed) ? trimmed.substring(0, 5) : '';
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
  if (zip !== undefined && zip.trim() !== '' && !ZIP_SHAPE.test(zip.trim())) {
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

/**
 * A parcel id as a duplicate key (spec 6.3): trimmed, upper case, leading "#" removed. Dashes and
 * spaces are KEPT, so two different parcel numbers can never collapse into one. The vendor is sent
 * the id as the caller sent it; this form is for the key only.
 */
export function normalizeParcelId(apn?: string | null): string {
  return (apn ?? '').trim().toUpperCase().replace(/^#+\s*/, '');
}

/**
 * The duplicate key for one record (spec 6.3, D9), in precedence order:
 *   1. a city:                        STREET|CITY|STATE, unchanged, so the 90-day history keeps working
 *   2. no city, a parcel id + county: APN|PARCEL|COUNTY|STATE
 *   3. neither:                       STREET||STATE, today's behaviour. Only a company gets this far
 *                                     (a person needs a key), and it carries today's collision risk,
 *                                     which the spec records rather than solves.
 */
export function traceKeyFor(input: {
  address?: string | null;
  city?: string | null;
  state: string;
  apn?: string | null;
  county?: string | null;
}): string {
  const city = (input.city ?? '').trim();
  if (city) return normalizeAddress(input.address ?? '', city, input.state);
  const parcel = normalizeParcelId(input.apn);
  const county = (input.county ?? '').trim().toUpperCase();
  if (parcel && county) return `APN|${parcel}|${county}|${input.state.trim().toUpperCase()}`;
  return normalizeAddress(input.address ?? '', '', input.state);
}
