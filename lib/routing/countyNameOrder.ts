/**
 * The order a COUNTY stores owner names in, measured per county.
 *
 * SPEC D18: "Name order is fixed ... using the order each county's own data shows (a county that
 * stores 'SMITH JOHN T' stores its two-word names LAST FIRST too). Phase 0 measures the order per
 * county." SPEC D22 amends it: single traces keep today's handling; the order applies where the
 * COUNTY IS KNOWN (David, 2026-09-28: "Wherever the county is known").
 *
 * WHY A MAP AND NOT A DEFAULT. 52 of the 57 counties measured store LAST FIRST, which is a strong
 * pattern and is NOT a licence to default 1,854 counties from 57. An absent county means NOT
 * MEASURED, and an unmeasured county keeps today's behaviour rather than inheriting a guess. Adding
 * a county is a measurement job, not a code change: count, per county, the individual-looking owner
 * names matching "SMITH JOHN T" against "JOHN T SMITH".
 *
 * THIS ONLY DECIDES A NAME CARRYING NO OTHER SIGNAL. An explicit "LAST, FIRST" comma, a surname
 * repeated across multi-owner parts, and a trailing middle initial all resolve the order on their
 * own and are checked first. The county rule exists for the residue: a bare two-token name like
 * "GRAY WAYNE", which is character-for-character the shape of "Gerald Pentland".
 *
 * NEVER APPLIED TO A DOSSIER NAME. lib/routing/executeRoute.ts builds those from Tracerfy's
 * STRUCTURED first_name/last_name, so they are natural by construction; contactParcelFor forces it.
 */
export type NameOrder = 'natural' | 'assessor'

/** key: "<2-letter state>|<BARE COUNTY NAME, UPPERCASE>" -> [order, provenance] */
const COUNTY_NAME_ORDER: Readonly<Record<string, readonly [NameOrder, string]>> = {
  'AK|ANCHORAGE': ['assessor', 'phase0 2026-09-21'],
  'AL|JEFFERSON': ['assessor', 'phase0 2026-09-21'],
  'AR|BENTON': ['assessor', 'phase0 2026-09-21'],
  'AR|GREENE': ['assessor', 'measured 2026-09-28: 2,234 LFM vs 68 FML'],
  'AR|PULASKI': ['assessor', 'phase0 2026-09-21'],
  'AZ|PINAL': ['assessor', 'phase0 2026-09-21'],
  'CA|SANTA CRUZ': ['assessor', 'phase0 2026-09-21'],
  'CA|VENTURA': ['assessor', 'phase0 2026-09-21'],
  'CO|ADAMS': ['assessor', 'phase0 2026-09-21'],
  'CO|ARAPAHOE': ['assessor', 'phase0 2026-09-21'],
  'CT|NEW HAVEN': ['assessor', 'phase0 2026-09-21'],
  'DE|KENT': ['assessor', 'phase0 2026-09-21'],
  'DE|NEW CASTLE': ['assessor', 'phase0 2026-09-21'],
  'HI|HONOLULU': ['assessor', 'phase0 2026-09-21'],
  'ID|KOOTENAI': ['assessor', 'phase0 2026-09-21'],
  'ID|TWIN FALLS': ['assessor', 'phase0 2026-09-21'],
  'IL|KANE': ['assessor', 'phase0 2026-09-21'],
  'IL|LAKE': ['assessor', 'phase0 2026-09-21'],
  'KY|JEFFERSON': ['assessor', 'phase0 2026-09-21'],
  'LA|EAST BATON ROUGE': ['assessor', 'phase0 2026-09-21'],
  'LA|JEFFERSON': ['assessor', 'phase0 2026-09-21'],
  'MA|ESSEX': ['assessor', 'phase0 2026-09-21'],
  'MA|WORCESTER': ['assessor', 'phase0 2026-09-21'],
  'MI|KENT': ['assessor', 'phase0 2026-09-21'],
  'MN|DAKOTA': ['assessor', 'phase0 2026-09-21'],
  'MN|RAMSEY': ['natural', 'phase0 2026-09-21'],
  'MO|JACKSON': ['assessor', 'phase0 2026-09-21'],
  'MS|WASHINGTON': ['assessor', 'phase0 2026-09-21'],
  'NC|BUNCOMBE': ['assessor', 'measured 2026-09-28: 14,721 LFM vs 205 FML'],
  'NC|FORSYTH': ['assessor', 'phase0 2026-09-21'],
  'ND|GRAND FORKS': ['assessor', 'phase0 2026-09-21'],
  'ND|WARD': ['assessor', 'measured 2026-09-28: 29,621 explicit "LAST, FIRST" comma forms'],
  'NM|BERNALILLO': ['assessor', 'phase0 2026-09-21'],
  'NM|DOÑA ANA': ['assessor', 'phase0 2026-09-21'],
  'NV|WASHOE': ['assessor', 'phase0 2026-09-21'],
  'NY|BROOME': ['assessor', 'phase0 2026-09-21'],
  'NY|MONROE': ['assessor', 'phase0 2026-09-21'],
  'NY|ONONDAGA': ['assessor', 'phase0 2026-09-21'],
  'OH|MUSKINGUM': ['assessor', 'phase0 2026-09-21'],
  'OH|SUMMIT': ['assessor', 'phase0 2026-09-21'],
  'OK|OKLAHOMA': ['assessor', 'phase0 2026-09-21'],
  'OK|TULSA': ['assessor', 'phase0 2026-09-21'],
  'OR|CLACKAMAS': ['assessor', 'phase0 2026-09-21'],
  'OR|WASHINGTON': ['assessor', 'phase0 2026-09-21'],
  'SC|CHARLESTON': ['assessor', 'phase0 2026-09-21'],
  'SC|GREENVILLE': ['assessor', 'phase0 2026-09-21'],
  'TN|HAMILTON': ['assessor', 'phase0 2026-09-21'],
  'TN|HICKMAN': ['assessor', 'measured 2026-09-28: 3,918 LFM vs 117 FML'],
  'TN|SHELBY': ['assessor', 'phase0 2026-09-21'],
  'TX|CAMERON': ['assessor', 'phase0 2026-09-21'],
  'TX|HIDALGO': ['assessor', 'phase0 2026-09-21'],
  'VA|CHESTERFIELD': ['assessor', 'phase0 2026-09-21'],
  'VA|VIRGINIA BEACH': ['assessor', 'phase0 2026-09-21'],
  'VT|RUTLAND': ['assessor', 'phase0 2026-09-21'],
  'WI|DANE': ['natural', 'phase0 2026-09-21'],
  'WI|MILWAUKEE': ['natural', 'phase0 2026-09-21'],
  'WV|BERKELEY': ['assessor', 'phase0 2026-09-21'],
  'WV|KANAWHA': ['assessor', 'phase0 2026-09-21'],
  'WV|MONONGALIA': ['assessor', 'measured 2026-09-28: 9,488 LFM vs 109 FML'],
}

/** The measured order for a county, or null when it has not been measured. */
export function countyNameOrder(state?: string | null, county?: string | null): NameOrder | null {
  const st = (state ?? '').trim().toUpperCase()
  const ct = (county ?? '').trim().toUpperCase().replace(/\s+(COUNTY|PARISH|MUNICIPALITY|CITY)$/, '')
  if (st.length !== 2 || !ct) return null
  return COUNTY_NAME_ORDER[`${st}|${ct}`]?.[0] ?? null
}

/** Counties measured so far, for reporting coverage honestly. */
export const MEASURED_COUNTY_COUNT = Object.keys(COUNTY_NAME_ORDER).length
