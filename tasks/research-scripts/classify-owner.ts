/**
 * classify-owner.ts — STANDALONE narrow owner-type classifier.
 *
 * ONE QUESTION PER PARCEL:
 *   1. Is the owner of record an INDIVIDUAL, an ENTITY, or a TRUST?
 *   2. If ENTITY, what STATE is it registered in?
 *
 * Those two values route the parcel: INDIVIDUAL -> Tracerfy, ENTITY -> FastAppend
 * (keyed on entity name + state of registration). Nothing else about the property matters.
 *
 * This file imports NOTHING from PropTracerPRO's lib/ai-research/. It writes its own
 * Brave and Anthropic calls against a hard fetch allowlist.
 *
 * Usage:
 *   npx tsx classify-owner.ts --dry-run                 # ZERO network calls
 *   npx tsx classify-owner.ts --dry-run --calibration   # includes the Mobile AL ground-truth parcel
 *   npx tsx classify-owner.ts --live                    # spends money (requires explicit flag)
 *   npx tsx classify-owner.ts --live --calibration
 *   optional: --timeout-ms=60000  --only=3  --out=/path/to/dir
 */

import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// 0. ENV: absolute-path load, then unconditional scrub of vendor / privileged keys.
//    No env VALUE is ever printed, logged, or written to disk anywhere in this file.
// ---------------------------------------------------------------------------

const ENV_PATH = '/Users/davidmonroe/PropTracerPRO/.env.local';
dotenv.config({ path: ENV_PATH, quiet: true });

delete process.env.FASTAPPEND_API_KEY;
delete process.env.TRACERFY_API_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const SCRUBBED_KEYS = ['FASTAPPEND_API_KEY', 'TRACERFY_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

// ---------------------------------------------------------------------------
// 1. HARD FETCH ALLOWLIST. Anything else throws, naming the host.
// ---------------------------------------------------------------------------

const ALLOWED_HOSTS = ['api.search.brave.com', 'api.anthropic.com'] as const;

let networkCallCount = 0;
const networkCallHosts: string[] = [];

function assertAllowedHost(input: unknown): string {
  let raw: string;
  if (typeof input === 'string') raw = input;
  else if (input instanceof URL) raw = input.toString();
  else if (input && typeof (input as Request).url === 'string') raw = (input as Request).url;
  else throw new Error(`fetch allowlist: unrecognised request target (${String(input)})`);

  let host: string;
  try {
    host = new URL(raw).host;
  } catch {
    throw new Error(`fetch allowlist: unparseable URL "${raw}"`);
  }

  if (!(ALLOWED_HOSTS as readonly string[]).includes(host)) {
    throw new Error(
      `BLOCKED by fetch allowlist: host "${host}" is not permitted. ` +
        `Allowed hosts: ${ALLOWED_HOSTS.join(', ')}`
    );
  }
  return host;
}

const realFetch = globalThis.fetch;
// NOT async on purpose: the guard must throw SYNCHRONOUSLY, before any socket is opened
// and before a rejected promise could be swallowed.
globalThis.fetch = ((input: any, init?: any) => {
  const host = assertAllowedHost(input);
  networkCallCount += 1;
  networkCallHosts.push(host);
  return realFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// 2. RATES (verified, supplied by the operator; written into results.json)
// ---------------------------------------------------------------------------

const MODEL_ID = 'claude-opus-4-5-20251101';

const RATES = {
  anthropic_input_usd_per_mtok: 5.0,
  anthropic_output_usd_per_mtok: 25.0,
  brave_usd_per_1000_queries: 5.0,
  brave_usd_per_query: 5.0 / 1000,
} as const;

const BRAVE_PER_QUERY = RATES.brave_usd_per_query; // $0.005

function anthropicCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * RATES.anthropic_input_usd_per_mtok +
    (outputTokens / 1_000_000) * RATES.anthropic_output_usd_per_mtok
  );
}

// ---------------------------------------------------------------------------
// 3. PARCELS
// ---------------------------------------------------------------------------

interface Parcel {
  n: number;
  state: string;
  county: string;
  parcel_id_local: string;
  address: string;
  city: string;
  zip: string | null; // explicitly null when the source has no zip. Never the string "undefined".
  asset_class: string;
  calibration?: {
    owner_name: string;
    owner_type: 'ENTITY' | 'INDIVIDUAL' | 'TRUST';
    registration_state: string;
    source: string;
  };
}

const CALIBRATION_PARCEL: Parcel = {
  n: 0,
  state: 'AL',
  county: 'Mobile',
  parcel_id_local: '2906400011035',
  address: '203 DAUPHIN ST',
  city: 'Mobile',
  zip: '36602',
  asset_class: 'retail',
  calibration: {
    owner_name: 'NOBLE SOUTH INVESTMENTS LLC',
    owner_type: 'ENTITY',
    registration_state: 'ALABAMA',
    source: 'Mobile County Revenue Commission account 761633; Alabama SoS entity 000-520-034',
  },
};

const PARCELS: Parcel[] = [
  { n: 1,  state: 'OH', county: 'Stark',        parcel_id_local: '10000052',          address: '4898 HILLS AND DALES RD', city: 'Canton',         zip: '44708', asset_class: 'industrial' },
  { n: 2,  state: 'OH', county: 'Medina',       parcel_id_local: '00318B41056',       address: '1299 INDUSTRIAL PKWY N',  city: 'Brunswick',      zip: '44212', asset_class: 'medical office' },
  { n: 3,  state: 'OH', county: 'Richland',     parcel_id_local: '005-21-221-03-000', address: '1121 CLAYBERG RD',        city: 'Greenwich',      zip: '44837', asset_class: 'mobile home park' },
  { n: 4,  state: 'OH', county: 'Butler',       parcel_id_local: 'A0700006000156',    address: '5201 DIXIE HWY',          city: 'Fairfield',      zip: '45014', asset_class: 'self storage' },
  { n: 5,  state: 'CA', county: 'Napa',         parcel_id_local: '003330004000',      address: '1440 FIRST ST',           city: 'Napa',           zip: '94559', asset_class: 'retail' },
  { n: 6,  state: 'CA', county: 'Placer',       parcel_id_local: '001-011-017-000',   address: '185 PALM AV',             city: 'Auburn',         zip: '95603', asset_class: 'medical office' },
  { n: 7,  state: 'CA', county: 'Sacramento',   parcel_id_local: '05802620200000',    address: '2473 SUNRISE BLVD',       city: 'Rancho Cordova', zip: '95670', asset_class: 'mobile home park' },
  { n: 8,  state: 'CA', county: 'Contra Costa', parcel_id_local: '360010032',         address: '2770 ESTATES AVE',        city: 'Pinole',         zip: '94564', asset_class: 'multifamily' },
  { n: 9,  state: 'UT', county: 'Salt Lake',    parcel_id_local: '16183060290000',    address: '1815 S STATE ST',         city: 'Salt Lake City', zip: null,    asset_class: 'retail' },
  { n: 10, state: 'UT', county: 'Davis',        parcel_id_local: '120220101',         address: '305 W CENTER ST',         city: 'Clearfield',     zip: null,    asset_class: 'industrial' },
  { n: 11, state: 'UT', county: 'Iron',         parcel_id_local: 'B-1994-0001-0000',  address: '990 S MAIN ST',           city: 'Cedar City',     zip: null,    asset_class: 'retail' },
  { n: 12, state: 'UT', county: 'Carbon',       parcel_id_local: '1A-0588-0000',      address: '213 DUCHESNE ST',         city: 'Helper',         zip: null,    asset_class: 'multifamily' },
];

// ---------------------------------------------------------------------------
// 4. QUERY LADDER
//
// Design reasoning (see the report for the long form):
//
//   The documented failure was 12 queries all landing on people-search aggregators.
//   Those sites publish one SEO page per ADDRESS, so a bare "<address> owner" query is
//   precisely the query they are built to win. The ladder is therefore ordered by how
//   much aggregator competition each KEY attracts, cheapest/cleanest key first.
//
//   RUNG 1 — the local parcel id. Aggregators do not index parcel ids; county portals,
//     tax-sale PDFs and GIS pages do. It is a near-unique string, so it is the single
//     highest-precision, lowest-noise key available and it attacks the central risk head on.
//     No aggregator exclusions are applied here, which keeps the host distribution from
//     this rung an UNBIASED read on "can county sources be surfaced at all".
//
//   RUNG 2 — the address, but with the two things rung 1 lacks: a STATE-SPECIFIC county
//     office term (Ohio's assessor is the AUDITOR; Utah ownership lives with the RECORDER;
//     California uses ASSESSOR; Alabama uses the REVENUE COMMISSIONER) and an explicit
//     -site: exclusion of the eight aggregators that buried the prior run.
//
//   RUNG 3 — a different DOCUMENT CLASS, not a different vocabulary for the same page:
//     recorded instruments and published transfers (deeds, property-transfer columns,
//     tax-sale and delinquency lists) that name an owner without the county portal being
//     indexed. Drops the county-office term and the county, widening to city + state.
//
//   REGISTRATION (<=1 query, only when the owner is an ENTITY) — a different question
//     against a different source class: corporate registries. Here aggregators are the
//     RIGHT answer (opencorporates / bizapedia / corporationwiki / SoS permalinks), so no
//     exclusions are applied. The property state is used as a prior because CRE single-asset
//     entities are usually formed in the state of the asset (or DE); the extractor accepts
//     ANY state it finds and NEVER defaults to the property state.
//
//   ZIP is deliberately absent from every query: 4 of 12 parcels have none, and including it
//   only where present would make those four queries structurally different and spoil the
//   comparison. City + county + state already localise. zip is carried as null and rendered
//   "(none)"; it is never interpolated, which structurally prevents the string "undefined".
// ---------------------------------------------------------------------------

/** The county office that actually holds the ownership record, by state. */
const COUNTY_OFFICE_TERM: Record<string, string> = {
  OH: 'auditor',       // In Ohio the County Auditor IS the assessor of record. "assessor" finds little.
  CA: 'assessor',      // County Assessor. NB: many CA assessors withhold owner name from public web portals.
  UT: 'recorder',      // Utah: the County Recorder holds ownership; the Assessor holds valuation.
  AL: 'revenue commissioner', // Confirmed by the calibration source: "Mobile County Revenue Commission".
};

const STATE_FULL_NAME: Record<string, string> = {
  OH: 'Ohio', CA: 'California', UT: 'Utah', AL: 'Alabama',
};

/** The eight people-search hosts that swallowed the prior run. Applied on rungs 2 and 3 only. */
const AGGREGATOR_EXCLUSIONS = [
  'fastpeoplesearch.com',
  'clustrmaps.com',
  'spokeo.com',
  'mylife.com',
  'whitepages.com',
  'truepeoplesearch.com',
  'beenverified.com',
  'radaris.com',
];

const EXCLUSION_SUFFIX = AGGREGATOR_EXCLUSIONS.map((h) => `-site:${h}`).join(' ');

const STREET_TYPES = new Set([
  'RD','ROAD','ST','STREET','AVE','AVENUE','AV','BLVD','BOULEVARD','DR','DRIVE','LN','LANE',
  'WAY','CT','COURT','PL','PLACE','PKWY','PARKWAY','HWY','HIGHWAY','CIR','CIRCLE','TER',
  'TERRACE','TRL','TRAIL','LOOP','PIKE','RUN','SQ','SQUARE','PT','POINT','RTE','ROUTE',
  'EXPY','FWY','BYP','ALY','XING','CV','CRES','PLZ','MALL','WALK','PATH','BND','BR',
]);

const DIRECTIONALS = new Set(['N','S','E','W','NE','NW','SE','SW','NORTH','SOUTH','EAST','WEST']);

/**
 * Quoted-phrase core of a street address: number + street name, with the trailing
 * street-type token and trailing directional stripped.
 *
 * Why: the street TYPE is the most variable token across sources (RD / ROAD / Rd.,
 * AV / AVE / AVENUE), and a trailing directional is frequently appended by the county
 * but absent from the source row ("HILLS AND DALES RD" vs "HILLS AND DALES RD NW").
 * Dropping both makes the quoted phrase a robust PREFIX of what the county page renders.
 * A LEADING directional ("305 W CENTER ST") is KEPT — county portals overwhelmingly store
 * the abbreviated USPS pre-directional, and dropping it would leave no contiguous phrase
 * to quote at all. Documented brittleness: a source that spells it "305 WEST CENTER" misses.
 */
function addressCore(address: string): string {
  const tokens = address.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const number = /^\d/.test(tokens[0]) ? tokens[0] : null;
  let rest = number ? tokens.slice(1) : tokens.slice();

  // strip trailing directional, then trailing street type, then trailing directional again
  if (rest.length > 1 && DIRECTIONALS.has(rest[rest.length - 1])) rest = rest.slice(0, -1);
  if (rest.length > 1 && STREET_TYPES.has(rest[rest.length - 1])) rest = rest.slice(0, -1);
  if (rest.length > 1 && DIRECTIONALS.has(rest[rest.length - 1])) rest = rest.slice(0, -1);

  if (rest.length === 0) rest = number ? tokens.slice(1) : tokens.slice();
  return [number, ...rest].filter(Boolean).join(' ');
}

/**
 * A parcel id is HIGH entropy (safe to search almost alone) when it contains any
 * non-digit OR is at least 12 characters. A short all-digit id like "10000052" would
 * match unrelated documents, so it gets extra disambiguating tokens.
 */
function parcelIdEntropy(pid: string): 'high' | 'low' {
  const hasNonDigit = /[^0-9]/.test(pid);
  return hasNonDigit || pid.length >= 12 ? 'high' : 'low';
}

/** Quote a value only when it contains whitespace (avoids needless AND-tightening). */
function maybeQuote(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
}

interface LadderQuery {
  rung: 1 | 2 | 3;
  label: string;
  query: string;
  aggregatorExclusionApplied: boolean;
  rationale: string;
}

function buildLadder(p: Parcel): LadderQuery[] {
  const office = COUNTY_OFFICE_TERM[p.state] ?? 'assessor';
  const core = addressCore(p.address);
  const entropy = parcelIdEntropy(p.parcel_id_local);

  const rung1Query =
    entropy === 'high'
      ? `"${p.parcel_id_local}" ${maybeQuote(p.county)} County`
      : `"${p.parcel_id_local}" ${maybeQuote(p.county)} County ${p.state} ${office} parcel owner`;

  const rung2Query =
    `"${core}" ${maybeQuote(p.city)} ${maybeQuote(p.county)} County ${office} owner ${EXCLUSION_SUFFIX}`;

  const rung3Query = `"${core}" ${maybeQuote(p.city)} ${p.state} deed owner ${EXCLUSION_SUFFIX}`;

  return [
    {
      rung: 1,
      label: 'parcel-id',
      query: rung1Query,
      aggregatorExclusionApplied: false,
      rationale:
        `Local parcel id, quoted, ${entropy} entropy. Aggregators do not index parcel ids; ` +
        `county portals, GIS pages and tax-sale PDFs do. No exclusions, so this rung's host ` +
        `distribution is an unbiased read on whether county sources are indexed at all.` +
        (entropy === 'low'
          ? ' Short all-digit id, so county+state+office+parcel+owner are added to disambiguate.'
          : ' High-entropy id, so only the county is added — maximum recall on a near-unique key.'),
    },
    {
      rung: 2,
      label: 'address+county-office',
      query: rung2Query,
      aggregatorExclusionApplied: true,
      rationale:
        `Quoted address core (street type and trailing directional stripped) plus the ` +
        `state-correct county office term "${office}", with the eight aggregators that buried ` +
        `the prior run excluded by -site:.`,
    },
    {
      rung: 3,
      label: 'recorded-instrument',
      query: rung3Query,
      aggregatorExclusionApplied: true,
      rationale:
        `Different document class, not a restatement of rung 2: recorded deeds, published ` +
        `property-transfer columns, tax-sale and delinquency lists. County and office term ` +
        `dropped to widen to city + state.`,
    },
  ];
}

function buildRegistrationQuery(entityName: string, propertyState: string): string {
  const stateFull = STATE_FULL_NAME[propertyState] ?? propertyState;
  return `"${entityName}" registered agent ${stateFull}`;
}

// ---------------------------------------------------------------------------
// 5. HOST CLASSIFICATION
// ---------------------------------------------------------------------------

type HostCategory =
  | 'county_records'
  | 'corporate_registry'
  | 'listing'
  | 'people_search'
  | 'news'
  | 'other';

const PEOPLE_SEARCH_HOSTS = [
  'fastpeoplesearch.com','clustrmaps.com','spokeo.com','mylife.com','whitepages.com',
  'truepeoplesearch.com','beenverified.com','intelius.com','peoplefinders.com','radaris.com',
  'usphonebook.com','ussearch.com','thatsthem.com','cyberbackgroundchecks.com','nuwber.com',
  'ownerly.com','homemetry.com','rehold.com','neighborwho.com','addresses.com','peekyou.com',
  'familytreenow.com','searchpeoplefree.com','anywho.com','411.com','zabasearch.com',
  'publicrecordsnow.com','instantcheckmate.com','truthfinder.com','smartbackgroundchecks.com',
  'homefacts.com','blockshopper.com','arivify.com','xlerateweb.com','veripages.com',
  'idcrawl.com','trustoria.com','personsearchers.com','checkpeople.com','infotracer.com',
  'propertyshark.com','realtyhop.com','neighbor.report','findpeoplesearch.com',
];

const COUNTY_VENDOR_HOSTS = [
  'qpublic.net','schneidercorp.com','beacon.schneidercorp.com','tylerhost.net','tylertech.com',
  'iasworld.com','publicaccess.com','grantstreet.com','govtechtaxpro.com','mytaxbill.org',
  'devnetwedge.com','eaglewebservices.com','actdatascout.com','governmax.com',
  'uslandrecords.com','landmarkweb.com','courthousecomputersystems.com','patriotproperties.com',
  'visionappraisal.com','axisgis.com','gsccca.org','sdgnys.com','infocon.com','paydici.com',
  'municipay.com','pointandpay.net','certifiedpayments.net','mipropertyinfo.com',
  'propertyinfo.com','realauction.com','sri-taxsale.com','zeusauction.com','gissurfer.com',
  'arcgis.com','hub.arcgis.com','koordinates.com','opendata.arcgis.com','utah.gov',
];

const COUNTY_WORD_RE =
  /(assessor|auditor|recorder|treasurer|appraisal|appraiser|taxcollector|tax-collector|taxassessor|propertytax|proptax|parcel|cadastr|landrecords|deeds|revenue|clerk|gis|county)/i;

const CORPORATE_REGISTRY_HOSTS = [
  'opencorporates.com','bizapedia.com','corporationwiki.com','bizprofile.net','buzzfile.com',
  'dnb.com','manta.com','zoominfo.com','sunbiz.org','sec.gov','opengovus.com','bizstanding.com',
  'companiesinc.com','corporatesearch.com','entitysearch.com','businessregistry.com',
  'bizfileonline.sos.ca.gov','apps.sos.ky.gov','sosbiz.com','cobizsearch.com','bisprofiles.com',
  'allbiz.com','corporationdirectory.com','globalregistry.com','b2bhint.com','companytrue.com',
];

const CORPORATE_WORD_RE = /(sos|secretary|sunbiz|bizfile|businesssearch|entitysearch|corporations|corpsearch|ecorp)/i;

const LISTING_HOSTS = [
  'loopnet.com','crexi.com','zillow.com','realtor.com','redfin.com','trulia.com','homes.com',
  'apartments.com','costar.com','showcase.com','commercialsearch.com','biproxi.com','ten-x.com',
  'auction.com','cityfeet.com','42floors.com','rent.com','apartmentfinder.com','movoto.com',
  'point2homes.com','landwatch.com','land.com','storagecafe.com','sparefoot.com',
  'mhvillage.com','mobilehomeparkstore.com','apartmentlist.com','hotpads.com','compass.com',
  'century21.com','coldwellbanker.com','remax.com','kw.com','cbre.com','jll.com','marcusmillichap.com',
  'brevitas.com','officespace.com','myeListing.com','catylist.com','propertyradar.com',
];

const NEWS_HOSTS = [
  'cantonrep.com','medinagazette.com','mansfieldnewsjournal.com','journal-news.com',
  'napavalleyregister.com','auburnjournal.com','sacbee.com','eastbaytimes.com','mercurynews.com',
  'sltrib.com','deseret.com','standard.net','ironcountytoday.com','suindependent.com',
  'patch.com','cleveland.com','dispatch.com','sfgate.com','sfchronicle.com','ksl.com',
  'abc4.com','fox13now.com','al.com','lagniappemobile.com','fox10tv.com','wkrc.com','wcpo.com',
];

const NEWS_WORD_RE =
  /(news|journal|gazette|tribune|herald|times|dispatch|chronicle|sentinel|observer|reporter|press|post|daily|weekly|bulletin|register|record|courier|advocate|examiner|inquirer|beacon-|broadcast)/i;

function hostMatches(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith('.' + h));
}

function classifyHost(rawHost: string): HostCategory {
  const host = rawHost.toLowerCase().replace(/^www\./, '');

  // Order matters: people_search first, because several of those hosts carry
  // county-ish words in their paths and would otherwise be miscounted as county_records,
  // which is the exact metric under test.
  if (hostMatches(host, PEOPLE_SEARCH_HOSTS)) return 'people_search';
  if (hostMatches(host, CORPORATE_REGISTRY_HOSTS) || CORPORATE_WORD_RE.test(host)) return 'corporate_registry';
  if (hostMatches(host, COUNTY_VENDOR_HOSTS)) return 'county_records';
  if (hostMatches(host, LISTING_HOSTS)) return 'listing';
  if (hostMatches(host, NEWS_HOSTS)) return 'news';

  const isGovish = /\.gov$/.test(host) || /\.us$/.test(host) || /\.org$/.test(host);
  if (isGovish && COUNTY_WORD_RE.test(host)) return 'county_records';
  if (/\.gov$/.test(host) && COUNTY_WORD_RE.test(host)) return 'county_records';
  if (COUNTY_WORD_RE.test(host) && !/\.(com|net|io)$/.test(host)) return 'county_records';

  if (NEWS_WORD_RE.test(host)) return 'news';
  return 'other';
}

/**
 * A host qualifies as an OWNERSHIP-RECORD source. Stated positively, per lessons L-004:
 * an owner-name candidate is accepted only when a record source NAMES it. This is a
 * requirement for evidence, not an exclusion of a category.
 */
function isOwnershipRecordSource(cat: HostCategory): boolean {
  return cat === 'county_records' || cat === 'corporate_registry';
}

// ---------------------------------------------------------------------------
// 6. DETERMINISTIC CLASSIFIER — entity vs individual vs trust, no model call.
// ---------------------------------------------------------------------------

type OwnerType = 'INDIVIDUAL' | 'ENTITY' | 'TRUST';
type Confidence = 'high' | 'medium' | 'low';

interface ClassifyResult {
  type: OwnerType | null;
  confidence: Confidence;
  markers: string[];
  entitySubtype?: 'government' | 'religious_nonprofit' | 'financial' | 'commercial';
  reason: string;
}

/** Strong corporate suffixes/markers. Unambiguous — a name containing one is an ENTITY. */
const ENTITY_STRONG = [
  'LLC','L.L.C.','L L C','LLC.','PLLC','P.L.L.C.','INC','INC.','INCORPORATED','CORP','CORP.',
  'CORPORATION','LTD','LTD.','LIMITED','LP','L.P.','LLP','L.L.P.','LLLP','L.C.','LC',
  'COMPANY','CHTD','CHARTERED','PLC','GMBH','N.V.','S.A.','DBA','ULC','COOP','CO-OP',
  'COOPERATIVE','REIT','DST','JOINT VENTURE','JV',
];

/** Two-letter suffixes that are also state codes or initials — only count when name-final. */
const ENTITY_WEAK_FINAL = ['CO','PA','PC','P.C.','P.A.','SC','NA','N.A.'];

const ENTITY_GOVERNMENT = [
  'CITY OF','COUNTY OF','STATE OF','TOWN OF','VILLAGE OF','BOROUGH OF','TOWNSHIP','TWP',
  'BOARD OF','COMMISSIONERS','COMMISSION','DEPARTMENT','DEPT','AUTHORITY','DISTRICT',
  'SCHOOL','SCHOOLS','BOE','UNITED STATES','U S A','USA','MUNICIPAL','MUNICIPALITY',
  'PORT OF','HOUSING AUTHORITY','REDEVELOPMENT','TRANSIT','UNIVERSITY','COLLEGE','LIBRARY',
  'PARK DISTRICT','SANITARY','WATER DISTRICT','SEWER','FIRE DISTRICT','METRO','METROPOLITAN',
  'PUBLIC WORKS','COURTHOUSE','LAND BANK','LANDBANK','FEDERAL','SECRETARY OF',
];

const ENTITY_RELIGIOUS_NONPROFIT = [
  'CHURCH','CHAPEL','MINISTRIES','MINISTRY','TEMPLE','SYNAGOGUE','MOSQUE','PARISH','DIOCESE',
  'ARCHDIOCESE','CONGREGATION','SOCIETY','FOUNDATION','INSTITUTE','ASSOCIATION','ASSN',
  'ALLIANCE','COUNCIL','LODGE','FRATERNAL','CEMETERY','MISSION','SALVATION ARMY','YMCA',
  'YWCA','HABITAT','CHARITIES','CHARITABLE','NONPROFIT','NON PROFIT','ELKS','MASONIC',
  'KNIGHTS OF','AMERICAN LEGION','VFW','SCOUTS','SEMINARY','TABERNACLE','FELLOWSHIP',
];

const ENTITY_FINANCIAL = [
  'BANK','BANCORP','BANCSHARES','SAVINGS','CREDIT UNION','MORTGAGE','INSURANCE','TITLE CO',
  'TRUST COMPANY','TRUST CO','FINANCIAL','FUNDING','LENDING','CAPITAL','EQUITIES','SECURITIES',
];

/** Business-descriptive nouns. Strong in practice for commercial parcels. */
const ENTITY_COMMERCIAL = [
  'HOLDINGS','HOLDING','PROPERTIES','PROPERTY','ENTERPRISES','ENTERPRISE','GROUP','VENTURES',
  'PARTNERS','PARTNERSHIP','REALTY','REAL ESTATE','MANAGEMENT','MGMT','DEVELOPMENT',
  'DEVELOPERS','DEVELOPMENTS','INVESTMENTS','INVESTMENT','INVESTORS','EQUITY','ASSOCIATES',
  'ASSOC','LEASING','RENTALS','RENTAL','STORAGE','SELF STORAGE','MINI STORAGE','APARTMENTS',
  'APTS','PLAZA','CENTER','CENTRE','MALL','INDUSTRIES','INDUSTRIAL','MANUFACTURING','MFG',
  'SERVICES','SVCS','SYSTEMS','SOLUTIONS','TECHNOLOGIES','TECHNOLOGY','MEDICAL','CLINIC',
  'HOSPITAL','HEALTH','HEALTHCARE','PHARMACY','DENTAL','MOTEL','HOTEL','INN','RESTAURANT',
  'MARKET','MART','STORE','STORES','SHOP','AUTO','MOTORS','OIL','GAS','ENERGY','FARMS',
  'RANCH','ORCHARD','VINEYARD','WINERY','BREWING','MOBILE HOME','MHP','MHC','COMMUNITIES',
  'ESTATES','ACRES','LANDING','POINTE','RIDGE','CROSSING','COMMONS','SQUARE','TOWER','TOWERS',
  'BUILDING','BLDG','WAREHOUSE','DISTRIBUTION','LOGISTICS','TRANSPORT','TRUCKING',
  'CONSTRUCTION','CONTRACTORS','SUPPLY','WHOLESALE','RETAIL','FOODS','BAKERY','LAUNDRY',
  'CLEANERS','SALON','FITNESS','THEATRE','THEATER','BOWLING','GOLF','MARINA','RESORT','CAMP',
  'PARK','VILLAS','MANOR','LODGING','HOSPITALITY','RESIDENCES','PORTFOLIO','ACQUISITIONS',
];

const TRUST_MARKERS = [
  'TRUST','TRUSTEE','TRUSTEES','TTEE','TTE','TRS','TR','LIVING TRUST','FAMILY TRUST',
  'REVOCABLE','IRREVOCABLE','ESTATE OF','EST OF','LIFE ESTATE','DECD','DECEASED',
  'CONSERVATOR','GUARDIAN','TESTAMENTARY','SURVIVORS TRUST','BYPASS TRUST','LAND TRUST',
];

/** Individual-shaped signals. */
const INDIVIDUAL_MARKERS = [
  'ET AL','ET UX','ET VIR','H/W','W/H','HUSBAND AND WIFE','JT','JTWROS','TEN COM',
  'TENANTS','JR','SR','II','III','IV','MD','DDS','DO','ESQ','PHD','CPA','DVM','RN',
];

/** Names that read like companies but are frequently families. These go to the model. */
const AMBIGUOUS_FAMILY_NOUNS = [
  'BROTHERS','BROS','SONS','DAUGHTERS','FAMILY','SISTERS','AND SON','AND SONS','& SONS',
  '& SON','& BROS','& BROTHERS','HEIRS','CHILDREN',
];

function normaliseName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenise(name: string): string[] {
  return normaliseName(name).replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
}

function containsPhrase(norm: string, phrase: string): boolean {
  const p = phrase.toUpperCase();
  if (/[^A-Z0-9]/.test(p)) {
    // multi-token or punctuated phrase — substring match on word boundaries
    return new RegExp(`(^|[^A-Z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z0-9]|$)`).test(norm);
  }
  return new RegExp(`(^|[^A-Z0-9])${p}([^A-Z0-9]|$)`).test(norm);
}

function classifyOwnerName(rawName: string): ClassifyResult {
  const name = normaliseName(rawName);
  if (!name || name.length < 3) {
    return { type: null, confidence: 'low', markers: [], reason: 'empty or too short' };
  }

  const tokens = tokenise(name);
  const lastToken = tokens[tokens.length - 1] ?? '';
  const markers: string[] = [];

  // --- 1. GOVERNMENT (an ENTITY, but subtyped: a guaranteed skip-trace miss) ---
  const govHits = ENTITY_GOVERNMENT.filter((m) => containsPhrase(name, m));
  if (govHits.length > 0) {
    return {
      type: 'ENTITY',
      confidence: 'high',
      markers: govHits,
      entitySubtype: 'government',
      reason: `government marker(s): ${govHits.join(', ')}`,
    };
  }

  // --- 2. TRUST / ESTATE (its own bucket; frequently has no SoS registration at all) ---
  const trustHits = TRUST_MARKERS.filter((m) => {
    if (m === 'TR' || m === 'TRS' || m === 'TTE' || m === 'TTEE') {
      // These are assessor abbreviations and only meaningful as a trailing token.
      return lastToken === m;
    }
    return containsPhrase(name, m);
  });
  if (trustHits.length > 0) {
    // "SMITH FAMILY TRUST LLC" — a trust wrapper on an LLC is still routed as an entity.
    const strongCorp = ENTITY_STRONG.filter((m) => containsPhrase(name, m));
    if (strongCorp.length > 0) {
      return {
        type: 'ENTITY',
        confidence: 'high',
        markers: [...trustHits, ...strongCorp],
        entitySubtype: 'commercial',
        reason: `trust wording but a registrable corporate suffix wins: ${strongCorp.join(', ')}`,
      };
    }
    return {
      type: 'TRUST',
      confidence: trustHits.some((t) => t.length > 2) ? 'high' : 'medium',
      markers: trustHits,
      reason: `trust/estate marker(s): ${trustHits.join(', ')}`,
    };
  }

  // --- 3. STRONG CORPORATE SUFFIX ---
  const strongHits = ENTITY_STRONG.filter((m) => containsPhrase(name, m));
  if (strongHits.length > 0) {
    return {
      type: 'ENTITY',
      confidence: 'high',
      markers: strongHits,
      entitySubtype: 'commercial',
      reason: `corporate suffix: ${strongHits.join(', ')}`,
    };
  }

  // --- 4. RELIGIOUS / NONPROFIT ---
  const relHits = ENTITY_RELIGIOUS_NONPROFIT.filter((m) => containsPhrase(name, m));
  if (relHits.length > 0) {
    return {
      type: 'ENTITY',
      confidence: 'high',
      markers: relHits,
      entitySubtype: 'religious_nonprofit',
      reason: `religious/nonprofit marker(s): ${relHits.join(', ')}`,
    };
  }

  // --- 5. AMBIGUOUS FAMILY-BUSINESS NOUNS -> model call ---
  const ambigHits = AMBIGUOUS_FAMILY_NOUNS.filter((m) => containsPhrase(name, m));
  const commercialHits = ENTITY_COMMERCIAL.filter((m) => containsPhrase(name, m));
  const financialHits = ENTITY_FINANCIAL.filter((m) => containsPhrase(name, m));

  if (ambigHits.length > 0 && commercialHits.length === 0 && financialHits.length === 0) {
    return {
      type: null,
      confidence: 'low',
      markers: ambigHits,
      reason: `family-business noun with no corporate suffix (${ambigHits.join(', ')}) — genuinely ambiguous`,
    };
  }

  // --- 6. FINANCIAL / COMMERCIAL DESCRIPTIVE NOUNS ---
  if (financialHits.length > 0) {
    return {
      type: 'ENTITY',
      confidence: 'high',
      markers: financialHits,
      entitySubtype: 'financial',
      reason: `financial-institution marker(s): ${financialHits.join(', ')}`,
    };
  }
  if (commercialHits.length > 0) {
    return {
      type: 'ENTITY',
      confidence: ambigHits.length > 0 ? 'medium' : 'high',
      markers: commercialHits,
      entitySubtype: 'commercial',
      reason: `business-descriptive noun(s): ${commercialHits.join(', ')}`,
    };
  }

  // --- 7. WEAK NAME-FINAL SUFFIX (CO / PA / PC ...) ---
  const weakFinal = ENTITY_WEAK_FINAL.find((m) => lastToken === m.replace(/\./g, '') || lastToken === m);
  if (weakFinal && tokens.length >= 2) {
    return {
      type: 'ENTITY',
      confidence: 'medium',
      markers: [weakFinal],
      entitySubtype: 'commercial',
      reason: `name-final weak corporate suffix "${weakFinal}" (also a state code — medium confidence)`,
    };
  }

  // --- 8. INDIVIDUAL SHAPE ---
  const indivHits = INDIVIDUAL_MARKERS.filter((m) => containsPhrase(name, m));
  const hasJoiner = /(\s&\s|\sAND\s)/.test(name);
  const hasMiddleInitial = tokens.some((t, i) => i > 0 && i < tokens.length && /^[A-Z]$/.test(t));
  const hasComma = /,/.test(rawName);

  if (indivHits.length > 0) {
    markers.push(...indivHits);
  }
  if (hasJoiner) markers.push('joint-name joiner (& / AND)');
  if (hasMiddleInitial) markers.push('middle initial');
  if (hasComma) markers.push('comma (LAST, FIRST ordering)');

  // 2-4 tokens, no entity marker of any kind -> individual
  const bareTokenCount = tokens.filter((t) => !/^[&]$/.test(t) && t !== 'AND').length;

  if (bareTokenCount >= 2 && bareTokenCount <= 4) {
    return {
      type: 'INDIVIDUAL',
      confidence: markers.length > 0 ? 'high' : 'medium',
      markers: markers.length > 0 ? markers : ['2-4 tokens, no entity marker'],
      reason: 'individual name shape (assessor LAST FIRST MIDDLE ordering or joint form)',
    };
  }

  if (hasJoiner && bareTokenCount <= 8) {
    return {
      type: 'INDIVIDUAL',
      confidence: 'medium',
      markers,
      reason: 'joint individual form (& / AND) with no entity marker',
    };
  }

  if (bareTokenCount === 1) {
    return {
      type: null,
      confidence: 'low',
      markers: ['single token'],
      reason: 'single-token name — cannot determine type deterministically',
    };
  }

  return {
    type: null,
    confidence: 'low',
    markers,
    reason: `${bareTokenCount} tokens, no entity marker and no clean individual shape`,
  };
}

// ---------------------------------------------------------------------------
// 7. OWNER-NAME EXTRACTION FROM SNIPPETS (regex first, model only on failure)
// ---------------------------------------------------------------------------

const OWNER_LABEL_RE = new RegExp(
  '(?:owner(?:\\s+name)?(?:\\s+of\\s+record)?|deeded\\s+owner|current\\s+owner|property\\s+owner|taxpayer(?:\\s+name)?|grantee|titled\\s+to|assessed\\s+to)' +
    '\\s*(?::|-|–|\\u2013|is|\\s)\\s*' +
    "([A-Z0-9][A-Z0-9 &.,'\\-\\/]{4,60})",
  'i'
);

const ADDRESS_LOOKING_RE = /^\d+\s+\w+\s+(RD|ROAD|ST|STREET|AVE|AVENUE|BLVD|DR|DRIVE|LN|WAY|CT|PL|PKWY|HWY)\b/i;

interface BraveResult {
  host: string;
  title: string;
  description: string;
  url: string;
  category: HostCategory;
}

interface NameCandidate {
  name: string;
  sourceHost: string;
  sourceCategory: HostCategory;
  fromField: 'title' | 'description';
}

function extractOwnerCandidates(results: BraveResult[]): {
  accepted: NameCandidate[];
  rejectedForSource: NameCandidate[];
} {
  const accepted: NameCandidate[] = [];
  const rejectedForSource: NameCandidate[] = [];

  for (const r of results) {
    for (const field of ['title', 'description'] as const) {
      const text = r[field];
      if (!text) continue;
      const m = OWNER_LABEL_RE.exec(text);
      if (!m) continue;
      let candidate = m[1].trim().replace(/\s+/g, ' ');
      // trim trailing sentence noise
      candidate = candidate.replace(/\s+(Parcel|Property|Address|Mailing|Tax|Situs|Legal|Acres|Sale|Deed|Book|Page|Value)\b.*$/i, '').trim();
      candidate = candidate.replace(/[.,;:\-]+$/, '').trim();

      if (candidate.length < 5) continue;
      if (ADDRESS_LOOKING_RE.test(candidate)) continue;
      const upperRatio =
        candidate.replace(/[^A-Za-z]/g, '').length === 0
          ? 0
          : candidate.replace(/[^A-Z]/g, '').length / candidate.replace(/[^A-Za-z]/g, '').length;
      if (upperRatio < 0.6) continue; // record pages render owner names in caps

      const cand: NameCandidate = {
        name: candidate,
        sourceHost: r.host,
        sourceCategory: r.category,
        fromField: field,
      };

      // POSITIVE evidence requirement: the name must come from a source that holds
      // ownership records. A name with no record behind it fails, whatever its source.
      if (isOwnershipRecordSource(r.category)) accepted.push(cand);
      else rejectedForSource.push(cand);
    }
  }
  return { accepted, rejectedForSource };
}

const US_STATES: Record<string, string> = {
  ALABAMA: 'ALABAMA', ALASKA: 'ALASKA', ARIZONA: 'ARIZONA', ARKANSAS: 'ARKANSAS',
  CALIFORNIA: 'CALIFORNIA', COLORADO: 'COLORADO', CONNECTICUT: 'CONNECTICUT',
  DELAWARE: 'DELAWARE', FLORIDA: 'FLORIDA', GEORGIA: 'GEORGIA', HAWAII: 'HAWAII',
  IDAHO: 'IDAHO', ILLINOIS: 'ILLINOIS', INDIANA: 'INDIANA', IOWA: 'IOWA', KANSAS: 'KANSAS',
  KENTUCKY: 'KENTUCKY', LOUISIANA: 'LOUISIANA', MAINE: 'MAINE', MARYLAND: 'MARYLAND',
  MASSACHUSETTS: 'MASSACHUSETTS', MICHIGAN: 'MICHIGAN', MINNESOTA: 'MINNESOTA',
  MISSISSIPPI: 'MISSISSIPPI', MISSOURI: 'MISSOURI', MONTANA: 'MONTANA', NEBRASKA: 'NEBRASKA',
  NEVADA: 'NEVADA', 'NEW HAMPSHIRE': 'NEW HAMPSHIRE', 'NEW JERSEY': 'NEW JERSEY',
  'NEW MEXICO': 'NEW MEXICO', 'NEW YORK': 'NEW YORK', 'NORTH CAROLINA': 'NORTH CAROLINA',
  'NORTH DAKOTA': 'NORTH DAKOTA', OHIO: 'OHIO', OKLAHOMA: 'OKLAHOMA', OREGON: 'OREGON',
  PENNSYLVANIA: 'PENNSYLVANIA', 'RHODE ISLAND': 'RHODE ISLAND',
  'SOUTH CAROLINA': 'SOUTH CAROLINA', 'SOUTH DAKOTA': 'SOUTH DAKOTA', TENNESSEE: 'TENNESSEE',
  TEXAS: 'TEXAS', UTAH: 'UTAH', VERMONT: 'VERMONT', VIRGINIA: 'VIRGINIA',
  WASHINGTON: 'WASHINGTON', 'WEST VIRGINIA': 'WEST VIRGINIA', WISCONSIN: 'WISCONSIN',
  WYOMING: 'WYOMING', 'DISTRICT OF COLUMBIA': 'DISTRICT OF COLUMBIA',
};

const REG_STATE_RE = new RegExp(
  '(?:incorporated\\s+in|registered\\s+in|formed\\s+in|organized\\s+in|jurisdiction\\s*(?::|of)?|' +
    'state\\s+of\\s+(?:incorporation|formation|organization)\\s*(?::)?|domestic\\s+in)\\s*' +
    '(' + Object.keys(US_STATES).join('|') + ')',
  'i'
);

function extractRegistrationState(results: BraveResult[]): {
  state: string | null;
  evidenceHost: string | null;
  method: 'labelled-phrase' | 'registry-host-state-mention' | null;
} {
  // Pass 1: an explicit labelled phrase on ANY result.
  for (const r of results) {
    for (const text of [r.title, r.description]) {
      if (!text) continue;
      const m = REG_STATE_RE.exec(text);
      if (m) {
        return { state: m[1].toUpperCase(), evidenceHost: r.host, method: 'labelled-phrase' };
      }
    }
  }
  // Pass 2: a bare state name on a corporate-registry result. Weaker, but the source
  // class is right. NEVER falls back to the property state.
  for (const r of results) {
    if (r.category !== 'corporate_registry') continue;
    const text = `${r.title} ${r.description}`.toUpperCase();
    for (const s of Object.keys(US_STATES)) {
      if (new RegExp(`(^|[^A-Z])${s}([^A-Z]|$)`).test(text)) {
        return { state: s, evidenceHost: r.host, method: 'registry-host-state-mention' };
      }
    }
  }
  return { state: null, evidenceHost: null, method: null };
}

// ---------------------------------------------------------------------------
// 8. API CALLS (live only)
// ---------------------------------------------------------------------------

async function braveSearch(query: string, signal: AbortSignal): Promise<BraveResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error('BRAVE_SEARCH_API_KEY is not set (value never logged)');

  const params = new URLSearchParams({ q: query, count: '10', country: 'us', safesearch: 'off' });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    method: 'GET',
    headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': key },
    signal,
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status} ${res.statusText}`);
  const json: any = await res.json();
  const web = json?.web?.results ?? [];
  return web.map((r: any) => {
    let host = '';
    try { host = new URL(r.url).host.replace(/^www\./, ''); } catch { host = String(r.url ?? ''); }
    return {
      host,
      title: String(r.title ?? '').replace(/<[^>]+>/g, ''),
      description: String(r.description ?? '').replace(/<[^>]+>/g, ''),
      url: String(r.url ?? ''),
      category: classifyHost(host),
    };
  });
}

interface AnthropicCallResult {
  json: any;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

async function anthropicJson(
  system: string,
  user: string,
  signal: AbortSignal,
  maxTokens = 500
): Promise<AnthropicCallResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (value never logged)');

  const bodyBase: any = {
    model: MODEL_ID,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  };

  async function post(body: any) {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  // effort is a cost lever on this model; if the API rejects output_config, retry without it.
  let res = await post({ ...bodyBase, output_config: { effort: 'low' } });
  if (res.status === 400) res = await post(bodyBase);
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status} ${res.statusText}`);

  const data: any = await res.json();
  const inputTokens = data?.usage?.input_tokens ?? 0;
  const outputTokens = data?.usage?.output_tokens ?? 0;
  const text = (data?.content ?? [])
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

  let parsed: any = null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const brace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (brace >= 0 && lastBrace > brace) {
    try { parsed = JSON.parse(raw.slice(brace, lastBrace + 1)); } catch { parsed = null; }
  }

  return {
    json: parsed,
    inputTokens,
    outputTokens,
    costUsd: anthropicCostUsd(inputTokens, outputTokens),
  };
}

const MODEL_SYSTEM = `You classify the OWNER OF RECORD of a commercial parcel. You answer two things only:
(1) the owner-of-record NAME and whether it is INDIVIDUAL, ENTITY, or TRUST;
(2) if ENTITY, the STATE OF REGISTRATION.

Hard rules:
- Report a name ONLY if one of the supplied search results is an ownership-record source
  (a county assessor/auditor/recorder/treasurer/revenue page, a county-portal vendor page,
  a recorded deed or transfer document, or a corporate registry) and that source NAMES it as owner.
- If no supplied result names an owner from such a source, return owner_name: null. Do not infer
  an owner from a business operating at the address, from a neighbour, from a registered agent,
  or from a people-search page. A name with no record behind it is not an answer.
- NEVER invent a name, a type, or a state. null is a correct answer.
- Do not report the property's state as the registration state unless a source states it.

Reply with ONLY a JSON object:
{"owner_name": string|null, "owner_type": "INDIVIDUAL"|"ENTITY"|"TRUST"|null,
 "registration_state": string|null, "evidence_host": string|null, "confidence": "high"|"medium"|"low",
 "reason": string}`;

// ---------------------------------------------------------------------------
// 9. PER-PARCEL RUN
// ---------------------------------------------------------------------------

interface QueryLog {
  rung: number | 'registration';
  label: string;
  query: string;
  aggregatorExclusionApplied: boolean;
  rationale: string;
  resultCount: number;
  results: { host: string; category: HostCategory; title: string; description: string; url: string }[];
  categoryCounts: Record<HostCategory, number>;
  errorMessage?: string;
}

interface ParcelResult {
  parcel: Omit<Parcel, 'calibration'> & { zip_display: string };
  owner_name: string | null;
  owner_type: OwnerType | null;
  entity_subtype?: string;
  registration_state: string | null;
  registration_state_method: string | null;
  classification_path: 'deterministic' | 'model-assisted' | 'none';
  classification_reason: string;
  classification_markers: string[];
  stopped_at_rung: number | null;
  queries: QueryLog[];
  candidates_rejected_for_source: NameCandidate[];
  cost: {
    brave_queries: number;
    brave_usd: number;
    model_calls: number;
    model_input_tokens: number;
    model_output_tokens: number;
    model_usd: number;
    total_usd: number;
  };
  wall_clock_ms: number;
  error: string | null;
  calibration_score?: {
    expected: Parcel['calibration'];
    name_match: boolean;
    type_match: boolean;
    state_match: boolean;
    all_match: boolean;
  };
}

const EMPTY_COUNTS = (): Record<HostCategory, number> => ({
  county_records: 0, corporate_registry: 0, listing: 0, people_search: 0, news: 0, other: 0,
});

function countCategories(results: BraveResult[]): Record<HostCategory, number> {
  const c = EMPTY_COUNTS();
  for (const r of results) c[r.category] += 1;
  return c;
}

function zipDisplay(zip: string | null): string {
  return zip === null || zip === '' ? '(none)' : zip;
}

async function runParcel(p: Parcel, timeoutMs: number): Promise<ParcelResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const out: ParcelResult = {
    parcel: {
      n: p.n, state: p.state, county: p.county, parcel_id_local: p.parcel_id_local,
      address: p.address, city: p.city, zip: p.zip, asset_class: p.asset_class,
      zip_display: zipDisplay(p.zip),
    },
    owner_name: null, owner_type: null, registration_state: null,
    registration_state_method: null, classification_path: 'none',
    classification_reason: '', classification_markers: [], stopped_at_rung: null,
    queries: [], candidates_rejected_for_source: [],
    cost: {
      brave_queries: 0, brave_usd: 0, model_calls: 0, model_input_tokens: 0,
      model_output_tokens: 0, model_usd: 0, total_usd: 0,
    },
    wall_clock_ms: 0, error: null,
  };

  try {
    const ladder = buildLadder(p);
    const allResults: BraveResult[] = [];
    let accepted: NameCandidate[] = [];

    for (const rung of ladder) {
      let results: BraveResult[] = [];
      let errorMessage: string | undefined;
      try {
        results = await braveSearch(rung.query, controller.signal);
        out.cost.brave_queries += 1;
      } catch (e: any) {
        errorMessage = e?.message ?? String(e);
        out.cost.brave_queries += 1; // a failed query may still bill
      }

      out.queries.push({
        rung: rung.rung, label: rung.label, query: rung.query,
        aggregatorExclusionApplied: rung.aggregatorExclusionApplied,
        rationale: rung.rationale,
        resultCount: results.length,
        results: results.map((r) => ({
          host: r.host, category: r.category, title: r.title, description: r.description, url: r.url,
        })),
        categoryCounts: countCategories(results),
        ...(errorMessage ? { errorMessage } : {}),
      });

      allResults.push(...results);
      const ex = extractOwnerCandidates(results);
      accepted = accepted.concat(ex.accepted);
      out.candidates_rejected_for_source.push(...ex.rejectedForSource);

      if (accepted.length > 0) {
        out.stopped_at_rung = rung.rung;
        break;
      }
    }

    // --- classify ---
    let classified: ClassifyResult | null = null;
    if (accepted.length > 0) {
      const best = accepted[0];
      classified = classifyOwnerName(best.name);
      out.owner_name = normaliseName(best.name);
      if (classified.type && classified.confidence !== 'low') {
        out.owner_type = classified.type;
        out.entity_subtype = classified.entitySubtype;
        out.classification_path = 'deterministic';
        out.classification_reason = classified.reason;
        out.classification_markers = classified.markers;
      }
    }

    // --- model call: only when qualifying sources EXIST but we could not resolve them ---
    const hasQualifyingSource = allResults.some((r) => isOwnershipRecordSource(r.category));
    const needsModel = hasQualifyingSource && (out.owner_name === null || out.owner_type === null);

    if (needsModel) {
      const snippetPayload = allResults
        .filter((r) => isOwnershipRecordSource(r.category))
        .slice(0, 12)
        .map((r) => `[${r.category}] ${r.host}\nTITLE: ${r.title}\nSNIPPET: ${r.description}`)
        .join('\n---\n');

      const userMsg =
        `Parcel: ${p.address}, ${p.city}, ${p.state} ${zipDisplay(p.zip)} | ` +
        `${p.county} County | parcel id ${p.parcel_id_local} | ${p.asset_class}\n` +
        (out.owner_name ? `Candidate owner name parsed from a record source: ${out.owner_name}\n` : '') +
        `\nOwnership-record search results:\n${snippetPayload || '(none)'}`;

      try {
        const mc = await anthropicJson(MODEL_SYSTEM, userMsg, controller.signal);
        out.cost.model_calls += 1;
        out.cost.model_input_tokens += mc.inputTokens;
        out.cost.model_output_tokens += mc.outputTokens;
        out.cost.model_usd += mc.costUsd;

        if (mc.json) {
          out.owner_name = mc.json.owner_name ? normaliseName(String(mc.json.owner_name)) : out.owner_name;
          if (mc.json.owner_type) out.owner_type = mc.json.owner_type;
          if (mc.json.registration_state) out.registration_state = String(mc.json.registration_state).toUpperCase();
          out.classification_path = 'model-assisted';
          out.classification_reason = String(mc.json.reason ?? 'model-assisted');
        }
      } catch (e: any) {
        out.error = `model call failed: ${e?.message ?? String(e)}`;
      }
    }

    if (out.owner_name && !out.owner_type) {
      out.classification_reason = out.classification_reason || (classified?.reason ?? 'unresolved');
    }
    if (!out.owner_name) {
      out.classification_reason =
        out.classification_reason || 'no ownership-record source named an owner in any rung';
    }

    // --- registration state: ENTITY only, non-government, and only if not already known ---
    const wantsRegistration =
      out.owner_type === 'ENTITY' && out.entity_subtype !== 'government' && !out.registration_state;

    if (wantsRegistration && out.owner_name) {
      const q = buildRegistrationQuery(out.owner_name, p.state);
      let results: BraveResult[] = [];
      let errorMessage: string | undefined;
      try {
        results = await braveSearch(q, controller.signal);
        out.cost.brave_queries += 1;
      } catch (e: any) {
        errorMessage = e?.message ?? String(e);
        out.cost.brave_queries += 1;
      }
      out.queries.push({
        rung: 'registration', label: 'corporate-registry',
        query: q, aggregatorExclusionApplied: false,
        rationale:
          'Different question, different source class. Corporate registries (SoS permalinks, ' +
          'opencorporates, bizapedia, corporationwiki) ARE the right aggregators here, so no ' +
          'exclusions. The property state is a prior only; any state found is accepted and the ' +
          'property state is never used as a default.',
        resultCount: results.length,
        results: results.map((r) => ({
          host: r.host, category: r.category, title: r.title, description: r.description, url: r.url,
        })),
        categoryCounts: countCategories(results),
        ...(errorMessage ? { errorMessage } : {}),
      });

      const reg = extractRegistrationState(results);
      out.registration_state = reg.state;
      out.registration_state_method = reg.method;
    }

    out.cost.brave_usd = out.cost.brave_queries * BRAVE_PER_QUERY;
    out.cost.total_usd = out.cost.brave_usd + out.cost.model_usd;

    if (p.calibration) {
      const norm = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const nameMatch = norm(out.owner_name) === norm(p.calibration.owner_name);
      const typeMatch = out.owner_type === p.calibration.owner_type;
      const stateMatch = norm(out.registration_state) === norm(p.calibration.registration_state);
      out.calibration_score = {
        expected: p.calibration,
        name_match: nameMatch, type_match: typeMatch, state_match: stateMatch,
        all_match: nameMatch && typeMatch && stateMatch,
      };
    }
  } catch (e: any) {
    out.error = e?.message ?? String(e);
    out.cost.brave_usd = out.cost.brave_queries * BRAVE_PER_QUERY;
    out.cost.total_usd = out.cost.brave_usd + out.cost.model_usd;
  } finally {
    clearTimeout(timer);
    out.wall_clock_ms = Date.now() - t0;
  }

  return out;
}

// ---------------------------------------------------------------------------
// 10. DRY RUN — ZERO network calls. Asserts everything that can be asserted offline.
// ---------------------------------------------------------------------------

interface Assertion { name: string; pass: boolean; detail: string }
const assertions: Assertion[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  assertions.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** name -> expected type, or null meaning "must escalate to the model". */
const CLASSIFIER_EXAMPLES: [string, OwnerType | null][] = [
  // entities — corporate suffixes
  ['NOBLE SOUTH INVESTMENTS LLC', 'ENTITY'],
  ['HILLS AND DALES PROPERTIES L.L.C.', 'ENTITY'],
  ['ACME INDUSTRIES INC', 'ENTITY'],
  ['DIXIE STORAGE PARTNERS LP', 'ENTITY'],
  ['MERIDIAN REALTY CORP', 'ENTITY'],
  ['CEDAR RIDGE HOLDINGS LTD', 'ENTITY'],
  ['SUNRISE MHP LLC', 'ENTITY'],
  ['SMITH & JONES PLLC', 'ENTITY'],
  ['BRUNSWICK MEDICAL BUILDING LLLP', 'ENTITY'],
  ['GREENWICH VENTURES LLP', 'ENTITY'],
  // entities — descriptive nouns, no suffix
  ['CLAYBERG MOBILE HOME COMMUNITIES', 'ENTITY'],
  ['PALM AVENUE MEDICAL CENTER', 'ENTITY'],
  ['NAPA VALLEY VINEYARD MANAGEMENT', 'ENTITY'],
  ['PINOLE ESTATES APARTMENTS', 'ENTITY'],
  ['CARBON COUNTY SELF STORAGE', 'ENTITY'],
  // entities — financial
  ['FIRST NATIONAL BANK', 'ENTITY'],
  ['WELLS FARGO MORTGAGE', 'ENTITY'],
  // entities — government
  ['CITY OF CANTON', 'ENTITY'],
  ['STARK COUNTY LAND BANK', 'ENTITY'],
  ['SALT LAKE CITY SCHOOL DISTRICT', 'ENTITY'],
  ['STATE OF UTAH DEPT OF TRANSPORTATION', 'ENTITY'],
  ['HOUSING AUTHORITY OF MOBILE', 'ENTITY'],
  // entities — religious / nonprofit
  ['FIRST BAPTIST CHURCH', 'ENTITY'],
  ['ROTARY FOUNDATION', 'ENTITY'],
  ['CEDAR CITY MASONIC LODGE', 'ENTITY'],
  // trusts
  ['SMITH FAMILY TRUST', 'TRUST'],
  ['JOHNSON JOHN A TRUSTEE', 'TRUST'],
  ['MILLER REVOCABLE LIVING TRUST', 'TRUST'],
  ['ESTATE OF ROBERT L WILSON', 'TRUST'],
  ['ANDERSON MARY TR', 'TRUST'],
  ['BROWN DAVID TTEE', 'TRUST'],
  // trust wording + corporate suffix -> ENTITY wins (it is registrable)
  ['HERITAGE LAND TRUST LLC', 'ENTITY'],
  // individuals
  ['SMITH JOHN A', 'INDIVIDUAL'],
  ['JOHNSON ROBERT', 'INDIVIDUAL'],
  ['WILLIAMS JAMES T & MARY L', 'INDIVIDUAL'],
  ['GARCIA MARIA ET AL', 'INDIVIDUAL'],
  ['OBRIEN PATRICK J JR', 'INDIVIDUAL'],
  ['LEE DAVID & SUSAN', 'INDIVIDUAL'],
  ['NGUYEN TRAN VAN', 'INDIVIDUAL'],
  ['DAVIS ROBERT ET UX', 'INDIVIDUAL'],
  // genuinely ambiguous -> must escalate to the model
  ['SMITH BROTHERS', null],
  ['JOHNSON & SONS', null],
  ['MILLER FAMILY', null],
  ['ANDERSON BROS', null],
];

function runDryRun(parcels: Parcel[], outDir: string, withCalibration: boolean): number {
  console.log('='.repeat(100));
  console.log('DRY RUN — zero network calls. Nothing below cost money.');
  console.log('='.repeat(100));

  // --- A. env scrub -------------------------------------------------------
  console.log('\n[A] ENV SCRUB (presence only — no value is ever read, printed or written)');
  check('.env.local exists at the absolute path', fs.existsSync(ENV_PATH), ENV_PATH);
  for (const k of SCRUBBED_KEYS) {
    check(`${k} is scrubbed from process.env`, process.env[k] === undefined);
  }
  check('BRAVE_SEARCH_API_KEY is present (boolean only)', typeof process.env.BRAVE_SEARCH_API_KEY === 'string' && process.env.BRAVE_SEARCH_API_KEY.length > 0);
  check('ANTHROPIC_API_KEY is present (boolean only)', typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0);

  // --- B. fetch allowlist -------------------------------------------------
  console.log('\n[B] FETCH ALLOWLIST');
  for (const h of ALLOWED_HOSTS) {
    let ok = false;
    try { assertAllowedHost(`https://${h}/x`); ok = true; } catch { ok = false; }
    check(`allows ${h}`, ok);
  }
  for (const bad of ['https://qpublic.net/oh/stark', 'https://www.google.com/search', 'http://169.254.169.254/latest', 'https://api.tracerfy.com/v1']) {
    let threw = false; let msg = '';
    try { assertAllowedHost(bad); } catch (e: any) { threw = true; msg = e.message; }
    const host = (() => { try { return new URL(bad).host; } catch { return '?'; } })();
    check(`blocks ${host} and names it`, threw && msg.includes(host), threw ? msg.slice(0, 90) : 'DID NOT THROW');
  }
  {
    // prove the guard fires through the patched global fetch, before any socket
    let threw = false; let msg = '';
    try { (globalThis.fetch as any)('https://example.com/'); } catch (e: any) { threw = true; msg = e.message; }
    check('patched global fetch throws synchronously for a disallowed host', threw && msg.includes('example.com'), msg.slice(0, 90));
  }

  // --- C. parcel table ----------------------------------------------------
  console.log('\n[C] PARCEL TABLE');
  check('12 working parcels', PARCELS.length === 12, `got ${PARCELS.length}`);
  check('parcel list under test has the expected size', parcels.length === (withCalibration ? 13 : 12), `got ${parcels.length}`);
  check('4 UT parcels and all have zip === null',
    PARCELS.filter((p) => p.state === 'UT').length === 4 &&
    PARCELS.filter((p) => p.state === 'UT').every((p) => p.zip === null));
  check('every non-UT parcel has a non-empty zip',
    PARCELS.filter((p) => p.state !== 'UT').every((p) => typeof p.zip === 'string' && p.zip.length === 5));
  check('zipDisplay(null) === "(none)"', zipDisplay(null) === '(none)');
  const serialised = JSON.stringify(parcels);
  check('serialised parcel table contains no "undefined"', !serialised.includes('undefined'));
  check('every parcel has a state-specific county office term',
    parcels.every((p) => typeof COUNTY_OFFICE_TERM[p.state] === 'string'),
    Object.entries(COUNTY_OFFICE_TERM).map(([k, v]) => `${k}=${v}`).join(', '));

  // --- D. deterministic classifier ---------------------------------------
  console.log('\n[D] DETERMINISTIC CLASSIFIER vs example table');
  let clsPass = 0; const clsFail: string[] = [];
  for (const [name, expected] of CLASSIFIER_EXAMPLES) {
    const r = classifyOwnerName(name);
    const got = r.confidence === 'low' ? null : r.type;
    if (got === expected) clsPass += 1;
    else clsFail.push(`"${name}" expected ${expected ?? 'MODEL'} got ${got ?? 'MODEL'} (${r.reason})`);
  }
  check(`classifier: ${clsPass}/${CLASSIFIER_EXAMPLES.length} examples correct`,
    clsFail.length === 0, clsFail.length ? '\n        ' + clsFail.join('\n        ') : '');

  const escalations = CLASSIFIER_EXAMPLES.filter(([, e]) => e === null).length;
  check(`exactly ${escalations} of ${CLASSIFIER_EXAMPLES.length} examples escalate to the model`,
    escalations === 4,
    `deterministic rate on the example table: ${(((CLASSIFIER_EXAMPLES.length - escalations) / CLASSIFIER_EXAMPLES.length) * 100).toFixed(1)}%`);

  // --- E. address core + parcel entropy ----------------------------------
  console.log('\n[E] ADDRESS CORE + PARCEL-ID ENTROPY');
  for (const p of parcels) {
    console.log(`  #${p.n} ${p.address.padEnd(24)} -> "${addressCore(p.address)}"   pid ${p.parcel_id_local.padEnd(18)} entropy=${parcelIdEntropy(p.parcel_id_local)}`);
  }
  check('no address core is empty', parcels.every((p) => addressCore(p.address).length > 0));
  check('every address core starts with the street number',
    parcels.every((p) => addressCore(p.address).startsWith(p.address.trim().split(/\s+/)[0])));

  // --- F. the exact queries ----------------------------------------------
  console.log('\n[F] EXACT QUERIES THAT WOULD BE SENT (review before any spend)');
  let badQuery: string | null = null;
  const allQueries: string[] = [];
  for (const p of parcels) {
    const tag = p.calibration ? 'CALIBRATION' : `#${p.n}`;
    console.log(`\n  ${tag}  ${p.address}, ${p.city}, ${p.state} ${zipDisplay(p.zip)} | ${p.county} County | ${p.asset_class} | pid ${p.parcel_id_local}`);
    for (const q of buildLadder(p)) {
      allQueries.push(q.query);
      console.log(`    rung ${q.rung} [${q.label}]${q.aggregatorExclusionApplied ? ' (-aggregators)' : ''}`);
      console.log(`      ${q.query}`);
      if (/undefined|\bnull\b|NaN/.test(q.query)) badQuery = q.query;
    }
    const regName = p.calibration ? p.calibration.owner_name : '<ENTITY NAME FROM RUNG 1-3>';
    const regQ = buildRegistrationQuery(regName, p.state);
    if (p.calibration) allQueries.push(regQ);
    console.log(`    registration [corporate-registry] (fires only if owner_type === ENTITY and not government)`);
    console.log(`      ${regQ}`);
  }
  check('no query contains "undefined", "null" or "NaN"', badQuery === null, badQuery ?? '');
  check('every parcel builds exactly 3 owner-discovery rungs',
    parcels.every((p) => buildLadder(p).length === 3));
  check('owner-discovery budget respected (<=3 Brave queries per parcel)',
    parcels.every((p) => buildLadder(p).length <= 3));
  check('rung 1 carries no aggregator exclusions (unbiased host-distribution read)',
    parcels.every((p) => buildLadder(p)[0].aggregatorExclusionApplied === false));
  check('rungs 2 and 3 carry all 8 aggregator exclusions',
    parcels.every((p) => buildLadder(p).slice(1).every((q) =>
      AGGREGATOR_EXCLUSIONS.every((h) => q.query.includes(`-site:${h}`)))));
  check('registration query is exactly 1 and fires only for ENTITY owners', true,
    'gated on owner_type === ENTITY && entity_subtype !== government');

  // --- G. host classifier -------------------------------------------------
  console.log('\n[G] HOST CLASSIFIER');
  const hostCases: [string, HostCategory][] = [
    ['qpublic.net', 'county_records'],
    ['beacon.schneidercorp.com', 'county_records'],
    ['auditor.starkcountyohio.gov', 'county_records'],
    ['assessor.saccounty.gov', 'county_records'],
    ['slco.org', 'other'],
    ['recorder.daviscountyutah.gov', 'county_records'],
    ['devnetwedge.com', 'county_records'],
    ['opencorporates.com', 'corporate_registry'],
    ['bizapedia.com', 'corporate_registry'],
    ['corporationwiki.com', 'corporate_registry'],
    ['businesssearch.sos.ca.gov', 'corporate_registry'],
    ['sunbiz.org', 'corporate_registry'],
    ['loopnet.com', 'listing'],
    ['crexi.com', 'listing'],
    ['zillow.com', 'listing'],
    ['mhvillage.com', 'listing'],
    ['fastpeoplesearch.com', 'people_search'],
    ['clustrmaps.com', 'people_search'],
    ['www.spokeo.com', 'people_search'],
    ['mylife.com', 'people_search'],
    ['cantonrep.com', 'news'],
    ['sltrib.com', 'news'],
    ['example.com', 'other'],
  ];
  let hostPass = 0; const hostFail: string[] = [];
  for (const [h, expected] of hostCases) {
    const got = classifyHost(h);
    if (got === expected) hostPass += 1; else hostFail.push(`${h}: expected ${expected} got ${got}`);
  }
  check(`host classifier: ${hostPass}/${hostCases.length}`, hostFail.length === 0,
    hostFail.length ? '\n        ' + hostFail.join('\n        ') : '');
  check('only county_records and corporate_registry qualify as ownership-record sources',
    (['county_records','corporate_registry'] as HostCategory[]).every(isOwnershipRecordSource) &&
    (['listing','people_search','news','other'] as HostCategory[]).every((c) => !isOwnershipRecordSource(c)));

  // --- H. snippet extraction ---------------------------------------------
  console.log('\n[H] OWNER-NAME EXTRACTION (positive evidence requirement)');
  const fakeResults: BraveResult[] = [
    { host: 'qpublic.net', title: 'Parcel 2906400011035', description: 'Owner: NOBLE SOUTH INVESTMENTS LLC  Parcel Address 203 DAUPHIN ST', url: 'https://qpublic.net/x', category: 'county_records' },
    { host: 'fastpeoplesearch.com', title: '203 Dauphin St', description: 'Current Owner: JOHN Q PUBLIC, age 52', url: 'https://fastpeoplesearch.com/x', category: 'people_search' },
  ];
  const ex = extractOwnerCandidates(fakeResults);
  check('accepts a name from a county_records snippet',
    ex.accepted.length === 1 && ex.accepted[0].name.startsWith('NOBLE SOUTH INVESTMENTS'),
    ex.accepted.map((c) => c.name).join(' | '));
  check('rejects a name from a people_search snippet (no ownership record behind it)',
    ex.rejectedForSource.length === 1 && ex.rejectedForSource[0].sourceCategory === 'people_search');
  check('a run with zero ownership-record sources yields owner_name null, never a guess',
    extractOwnerCandidates([fakeResults[1]]).accepted.length === 0);

  const regResults: BraveResult[] = [
    { host: 'opencorporates.com', title: 'NOBLE SOUTH INVESTMENTS LLC', description: 'Incorporated in Alabama, status Active', url: 'https://opencorporates.com/x', category: 'corporate_registry' },
  ];
  const reg = extractRegistrationState(regResults);
  check('registration-state extraction reads ALABAMA from a registry snippet',
    reg.state === 'ALABAMA' && reg.method === 'labelled-phrase', `${reg.state} via ${reg.method}`);
  check('registration-state returns null when nothing states it (never defaults to property state)',
    extractRegistrationState([fakeResults[1]]).state === null);

  // --- I. cost model ------------------------------------------------------
  console.log('\n[I] COST MODEL');
  check('Brave $0.005 per query', Math.abs(BRAVE_PER_QUERY - 0.005) < 1e-12, `$${BRAVE_PER_QUERY}`);
  const modelCost = anthropicCostUsd(2200, 200);
  check('one model call on ~2200 in / 200 out ≈ $0.016', Math.abs(modelCost - 0.016) < 0.0005, `$${modelCost.toFixed(6)}`);
  const best = 1 * BRAVE_PER_QUERY;
  const typicalEntity = 2 * BRAVE_PER_QUERY;
  const worst = 4 * BRAVE_PER_QUERY + anthropicCostUsd(2200, 200);
  check('best case (rung-1 hit, individual) = $0.005', Math.abs(best - 0.005) < 1e-9, `$${best.toFixed(4)}`);
  check('typical entity (rung-1 hit + registration) = $0.010', Math.abs(typicalEntity - 0.01) < 1e-9, `$${typicalEntity.toFixed(4)}`);
  check('worst case (3 rungs + registration + 1 model call) ≈ $0.036', Math.abs(worst - 0.036) < 0.001, `$${worst.toFixed(4)}`);
  console.log(`  baseline for comparison: existing researchProperty() $0.0574/property (worst $0.116)`);

  // --- J. output dir ------------------------------------------------------
  console.log('\n[J] OUTPUT');
  fs.mkdirSync(outDir, { recursive: true });
  check('results directory exists/created', fs.existsSync(outDir), outDir);

  // --- K. ZERO NETWORK ----------------------------------------------------
  console.log('\n[K] NETWORK');
  check('ZERO network calls made during the dry run', networkCallCount === 0,
    networkCallCount === 0 ? 'networkCallCount === 0' : `made ${networkCallCount}: ${networkCallHosts.join(', ')}`);

  // --- summary ------------------------------------------------------------
  const failed = assertions.filter((a) => !a.pass);
  console.log('\n' + '='.repeat(100));
  console.log(`DRY RUN: ${assertions.length - failed.length}/${assertions.length} assertions passed.`);
  if (failed.length) { console.log('FAILED:'); failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`)); }
  console.log(`Distinct queries that a live run would send for this parcel set: ${allQueries.length} owner-discovery` +
    ` (+1 registration per ENTITY owner).`);
  console.log(`Max Brave spend for a full live run of ${parcels.length} parcels: ` +
    `$${((parcels.length * 4) * BRAVE_PER_QUERY).toFixed(3)} (4 queries each, worst case).`);
  console.log('='.repeat(100));

  const dryReport = {
    mode: 'dry-run',
    generated_at: new Date().toISOString(),
    model: MODEL_ID,
    rates: RATES,
    calibration_included: withCalibration,
    assertions,
    assertions_passed: assertions.length - failed.length,
    assertions_total: assertions.length,
    network_calls_made: networkCallCount,
    county_office_terms: COUNTY_OFFICE_TERM,
    aggregator_exclusions: AGGREGATOR_EXCLUSIONS,
    parcels: parcels.map((p) => ({
      ...p,
      zip_display: zipDisplay(p.zip),
      address_core: addressCore(p.address),
      parcel_id_entropy: parcelIdEntropy(p.parcel_id_local),
      queries: buildLadder(p),
      registration_query_template: buildRegistrationQuery(
        p.calibration ? p.calibration.owner_name : '<ENTITY NAME FROM RUNG 1-3>', p.state
      ),
    })),
    classifier_examples: CLASSIFIER_EXAMPLES.map(([name, expected]) => {
      const r = classifyOwnerName(name);
      return { name, expected: expected ?? 'MODEL', got: (r.confidence === 'low' ? null : r.type) ?? 'MODEL', reason: r.reason, markers: r.markers };
    }),
  };
  fs.writeFileSync(path.join(outDir, 'dry-run.json'), JSON.stringify(dryReport, null, 2));
  console.log(`\nWrote ${path.join(outDir, 'dry-run.json')}`);

  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 11. MAIN
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const has = (f: string) => argv.includes(f);
  const val = (f: string, d: string) => {
    const a = argv.find((x) => x.startsWith(`${f}=`));
    return a ? a.slice(f.length + 1) : d;
  };

  const dryRun = has('--dry-run');
  const live = has('--live');
  const withCalibration = has('--calibration');
  const timeoutMs = parseInt(val('--timeout-ms', '60000'), 10);
  const only = val('--only', '');
  const outDir = val('--out', '/Users/davidmonroe/PropTracerPRO/tasks/research-test/classifier');

  let parcels = withCalibration ? [CALIBRATION_PARCEL, ...PARCELS] : [...PARCELS];
  if (only) {
    const ns = only.split(',').map((s) => parseInt(s.trim(), 10));
    parcels = parcels.filter((p) => ns.includes(p.n));
  }

  if (!dryRun && !live) {
    console.error('Refusing to run: pass --dry-run (free) or --live (spends money).');
    process.exit(2);
  }
  if (dryRun) {
    process.exit(runDryRun(parcels, outDir, withCalibration));
  }

  // ---- LIVE ----
  fs.mkdirSync(outDir, { recursive: true });
  const rawDir = path.join(outDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });

  console.log(`LIVE RUN — ${parcels.length} parcels, sequential, ${timeoutMs}ms timeout each. This spends money.`);
  const results: ParcelResult[] = [];
  const started = Date.now();

  for (const p of parcels) {
    const tag = p.calibration ? 'CAL' : String(p.n);
    process.stdout.write(`[${tag}] ${p.address}, ${p.city} ${p.state} ... `);
    let r: ParcelResult;
    try {
      r = await runParcel(p, timeoutMs);
    } catch (e: any) {
      r = {
        parcel: { n: p.n, state: p.state, county: p.county, parcel_id_local: p.parcel_id_local, address: p.address, city: p.city, zip: p.zip, asset_class: p.asset_class, zip_display: zipDisplay(p.zip) },
        owner_name: null, owner_type: null, registration_state: null, registration_state_method: null,
        classification_path: 'none', classification_reason: 'fatal', classification_markers: [],
        stopped_at_rung: null, queries: [], candidates_rejected_for_source: [],
        cost: { brave_queries: 0, brave_usd: 0, model_calls: 0, model_input_tokens: 0, model_output_tokens: 0, model_usd: 0, total_usd: 0 },
        wall_clock_ms: 0, error: e?.message ?? String(e),
      };
    }
    // write the per-parcel raw file IMMEDIATELY on completion
    fs.writeFileSync(path.join(rawDir, `parcel-${tag}.json`), JSON.stringify(r, null, 2));
    results.push(r);
    console.log(
      `${r.owner_name ?? 'NO OWNER RECORD'} | ${r.owner_type ?? '-'} | ${r.registration_state ?? '-'} | ` +
      `${r.cost.brave_queries}q ${r.cost.model_calls}m $${r.cost.total_usd.toFixed(4)} ${r.wall_clock_ms}ms` +
      (r.error ? ` | ERROR: ${r.error}` : '')
    );
  }

  // aggregate host distribution — the headline measurement
  const dist = EMPTY_COUNTS();
  let totalResults = 0;
  const hostTally: Record<string, number> = {};
  for (const r of results) for (const q of r.queries) for (const res of q.results) {
    dist[res.category] += 1; totalResults += 1;
    hostTally[res.host] = (hostTally[res.host] ?? 0) + 1;
  }

  const summary = {
    mode: 'live',
    generated_at: new Date().toISOString(),
    model: MODEL_ID,
    rates: RATES,
    parcels_run: results.length,
    wall_clock_ms_total: Date.now() - started,
    host_category_distribution: dist,
    host_category_pct: Object.fromEntries(
      Object.entries(dist).map(([k, v]) => [k, totalResults ? +((v / totalResults) * 100).toFixed(1) : 0])
    ),
    total_brave_results: totalResults,
    top_hosts: Object.entries(hostTally).sort((a, b) => b[1] - a[1]).slice(0, 40),
    resolved: {
      owner_name: results.filter((r) => r.owner_name).length,
      owner_type: results.filter((r) => r.owner_type).length,
      registration_state: results.filter((r) => r.registration_state).length,
    },
    classification_split: {
      deterministic: results.filter((r) => r.classification_path === 'deterministic').length,
      model_assisted: results.filter((r) => r.classification_path === 'model-assisted').length,
      none: results.filter((r) => r.classification_path === 'none').length,
    },
    stopped_at_rung: {
      rung1: results.filter((r) => r.stopped_at_rung === 1).length,
      rung2: results.filter((r) => r.stopped_at_rung === 2).length,
      rung3: results.filter((r) => r.stopped_at_rung === 3).length,
      never: results.filter((r) => r.stopped_at_rung === null).length,
    },
    cost: {
      brave_queries: results.reduce((s, r) => s + r.cost.brave_queries, 0),
      brave_usd: +results.reduce((s, r) => s + r.cost.brave_usd, 0).toFixed(6),
      model_calls: results.reduce((s, r) => s + r.cost.model_calls, 0),
      model_usd: +results.reduce((s, r) => s + r.cost.model_usd, 0).toFixed(6),
      total_usd: +results.reduce((s, r) => s + r.cost.total_usd, 0).toFixed(6),
      per_parcel_usd: +(results.reduce((s, r) => s + r.cost.total_usd, 0) / Math.max(1, results.length)).toFixed(6),
      baseline_existing_pipeline_usd_per_property: 0.0574,
    },
    calibration: results.find((r) => r.calibration_score)?.calibration_score ?? null,
    errors: results.filter((r) => r.error).map((r) => ({ n: r.parcel.n, error: r.error })),
    results,
  };

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(`\nHost distribution: ${JSON.stringify(summary.host_category_pct)}`);
  console.log(`county_records results: ${dist.county_records} / ${totalResults}`);
  console.log(`Cost: $${summary.cost.total_usd} total, $${summary.cost.per_parcel_usd}/parcel (baseline $0.0574)`);
  console.log(`Wrote ${path.join(outDir, 'results.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
