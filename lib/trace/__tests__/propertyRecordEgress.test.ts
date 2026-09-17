import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_PROPERTY_RECORD_KEYS,
  DOSSIER_EXPORT_KEYS,
  toPublicPropertyRecord,
} from '@/lib/trace/publicPropertyRecord';
import { buildExportCsv, DOSSIER_COLUMN_PREFIX, EXPORT_COLUMNS } from '@/lib/trace/exportCsv';
import { dispatchTraceCompleted } from '@/lib/trace/traceCompletedWebhook';
import entityHitAddress from '@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json';
import type { TraceHistory } from '@/types';

/**
 * THE FENCE AROUND EVERY DOOR A PROPERTY RECORD LEAVES THROUGH.
 *
 * The per-route tests in app/api/**\/__tests__ assert the four API surfaces
 * individually, by calling them. This file asserts the thing those tests cannot:
 * that there is no FIFTH surface. A new egress added next month is caught by the
 * scan below rather than shipping a wrong `estimated_value` into a customer's
 * CRM and being noticed by nobody, which is the failure mode the whole decision
 * exists to prevent.
 *
 * HOW THE SCAN WORKS. Every committed .ts/.tsx under app/, lib/ and components/
 * is read, and every place that writes a `property_record` / `propertyRecord`
 * key into an object is classified:
 *
 *   null                            fine, an absence
 *   toPublicPropertyRecord(...)     fine, filtered
 *   anything else                   RAW, and must be named in RAW_SITES below
 *                                   with a reason and an exact count
 *
 * Type members (`propertyRecord: unknown;`) are declarations, not emissions, and
 * are told apart by their terminating semicolon.
 *
 * The allowlist carries COUNTS, not just file names. Adding a second raw
 * emission to a file that legitimately has one — the exact way this leaks —
 * fails the test instead of inheriting its neighbour's permission.
 */

const ROOT = process.cwd();
const SCANNED_DIRS = ['app', 'lib', 'components'];

/**
 * The only places a RAW, unfiltered property record may appear in a key.
 * Keyed by path, then by the exact source text, then the number of times it may
 * occur. Every entry is a deliberate decision with a reason.
 */
const RAW_SITES: Record<string, Record<string, { count: number; why: string }>> = {
  'app/api/v1/trace/single/route.ts': {
    'property_record: execution.property,': {
      count: 1,
      why: 'THE PERSIST. Storage stays raw: all 86 keys, verbatim. Filtering here would destroy the product.',
    },
    'propertyRecord: execution.property,': {
      count: 1,
      why: 'The webhook ARGUMENT. dispatchTraceCompleted filters at the single door where the payload is built, so both call sites hand it the raw record.',
    },
  },
  'app/api/trace/single/route.ts': {
    'property_record: execution.property,': {
      count: 1,
      why: 'THE PERSIST. Storage stays raw: all 86 keys, verbatim.',
    },
    'propertyRecord: execution.property,': {
      count: 1,
      why: 'The webhook ARGUMENT, filtered inside dispatchTraceCompleted.',
    },
  },
  'app/(dashboard)/trace/single/page.tsx': {
    'property_record: statusData.property_record ?? null,': {
      count: 1,
      why: 'BROWSER STATE, not an egress. statusData is the response of /api/trace/status, which is filtered before it reaches the network.',
    },
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

interface Emission {
  file: string;
  text: string;
}

/** Every `property_record:` / `propertyRecord:` value written into an object. */
function emissions(): Emission[] {
  const found: Emission[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, 'utf8');
      const pattern = /(?<![\w.])(property_record|propertyRecord)\s*:[^\n]*/g;
      for (const match of source.matchAll(pattern)) {
        const text = match[0].trim();
        // A type member ends in a semicolon. It declares a shape; it emits nothing.
        if (text.endsWith(';')) continue;
        found.push({ file: relative(ROOT, file).split(sep).join('/'), text });
      }
    }
  }
  return found;
}

describe('every property record that leaves PTP goes through the one filter', () => {
  it('finds the egress sites at all, so a broken scan cannot pass silently', () => {
    // A regex that matches nothing would make every assertion below vacuously
    // true. This is the canary for that.
    const all = emissions();
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(new Set(all.map((e) => e.file)).size).toBeGreaterThanOrEqual(5);
  });

  it('wraps every emission in toPublicPropertyRecord, or names it as raw with a reason', () => {
    const unexplained: string[] = [];
    const rawCounts = new Map<string, number>();

    for (const { file, text } of emissions()) {
      const value = text.slice(text.indexOf(':') + 1).trim();
      if (value === 'null,' || value === 'null') continue;
      if (value.includes('toPublicPropertyRecord(')) continue;

      const allowed = RAW_SITES[file]?.[text];
      if (!allowed) {
        unexplained.push(`${file}\n      ${text}`);
        continue;
      }
      const key = `${file}::${text}`;
      rawCounts.set(key, (rawCounts.get(key) ?? 0) + 1);
    }

    expect(
      unexplained,
      `Unfiltered property record. Wrap it in toPublicPropertyRecord(), or add it to RAW_SITES with a reason:\n      ${unexplained.join('\n      ')}`
    ).toEqual([]);

    // Exact counts, both directions: a second raw emission in a file that is
    // allowed one is the leak this is built to catch, and an allowlist entry
    // that no longer matches anything is dead permission waiting to be reused.
    for (const [file, sites] of Object.entries(RAW_SITES)) {
      for (const [text, { count }] of Object.entries(sites)) {
        expect(rawCounts.get(`${file}::${text}`) ?? 0, `${file} :: ${text}`).toBe(count);
      }
    }
  });
});

/**
 * THE FIFTH SURFACE, AND THE ONE SHAPE THE SCAN ABOVE CANNOT SEE.
 *
 * The scan finds a leak by matching the literal token `property_record:` in an
 * object literal. A CSV builder reads `row.property_record` and writes SIXTY-FIVE
 * SEPARATE COLUMNS, producing no such token anywhere. It is invisible to the
 * regex, and widening the regex would not fix it: there is no text to match.
 *
 * So the export gets a fence of its own, built on the one canonical list. Each
 * assertion catches a DIFFERENT way a blocked field reaches a customer, and one
 * that could not catch anything was rewritten rather than kept for the look of it:
 *
 *   1. no blocked key is IN the list
 *   2. the list is exactly the 65 a customer is entitled to
 *   3. no key in the committed fixture is missing from it (see the test for what
 *      this does NOT do)
 *   4. the header the list produces names none of them
 *   5. and a blocked VALUE carrying a unique sentinel does not reach the file,
 *      which bites on the builder widening its selection rather than on the list
 */
describe('the CSV export column set', () => {
  const FIXTURE = (entityHitAddress as { response: { property: Record<string, unknown> } })
    .response.property;

  it('names none of the 21 blocked keys', () => {
    // MUTATION: paste `estimated_value` into DOSSIER_EXPORT_KEYS and this goes red.
    const listed = new Set<string>(DOSSIER_EXPORT_KEYS);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(listed.has(key), `${key} would become a column in a customer's spreadsheet`).toBe(
        false
      );
    }
  });

  it('is exactly the 65 a customer is entitled to, with no duplicates', () => {
    expect(DOSSIER_EXPORT_KEYS).toHaveLength(65);
    expect(new Set<string>(DOSSIER_EXPORT_KEYS).size).toBe(65);
  });

  it('carries every public key in the committed fixture', () => {
    // THE DRIFT TEST, AND AN HONEST ACCOUNT OF WHAT IT DOES NOT DO.
    //
    // `toPublicPropertyRecord` is a DENYLIST, so a key the vendor adds tomorrow
    // reaches the payload surfaces by default. The export cannot work that way:
    // a column set that moves under a customer breaks their importer.
    //
    // WHAT THIS CATCHES is a key being dropped from `DOSSIER_EXPORT_KEYS` while
    // the fixture still has it, and a key added to the FIXTURE without a column.
    //
    // WHAT IT DOES NOT CATCH, and an earlier comment here wrongly claimed it
    // did: a live vendor addition. The fixture is a committed file. Tracerfy
    // adding an 87th key changes nothing in this repo, the suite stays green,
    // and the new key is silently dropped from the CSV until a human re-records
    // the fixture. This test fires on the RE-RECORD, not on the addition.
    //
    // It is still worth having -- re-recording a fixture is the normal way a new
    // vendor key enters this repo, and this is what makes that moment loud -- it
    // just is not the live tripwire the comment used to promise.
    const publicKeys = Object.keys(toPublicPropertyRecord(FIXTURE)!);
    const listed = new Set<string>(DOSSIER_EXPORT_KEYS);
    const missing = publicKeys.filter((key) => !listed.has(key));

    expect(
      missing,
      `The vendor sends these and the CSV drops them. Add them to DOSSIER_EXPORT_KEYS (or block them) deliberately:\n      ${missing.join('\n      ')}`
    ).toEqual([]);
  });

  it('produces a file carrying none of them, from a real 86-key dossier', () => {
    // The list being clean is not the same claim as the FILE being clean. This
    // builds the actual CSV from the actual vendor payload and reads the header
    // a customer would open.
    const csv = buildExportCsv([
      { property_record: FIXTURE, charge: 0.4, status: 'success' } as unknown as TraceHistory,
    ]);
    const header = csv.split('\n')[0].split(',');

    expect(header).toEqual([...EXPORT_COLUMNS]);
    expect(header).toHaveLength(103);
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      const column = `${DOSSIER_COLUMN_PREFIX}${key}`;
      expect(header, `${key} is a column in the customer's spreadsheet`).not.toContain(column);
      expect(header, `${key} is a column in the customer's spreadsheet`).not.toContain(key);
    }
  });

  it('drops a blocked VALUE even when the vendor fills it with something unique', () => {
    // THE VALUE HALF, REBUILT SO IT CAN ACTUALLY FAIL.
    //
    // It used to assert `csv` did not contain 'propensity' or 'large home'. That
    // could not fail under any single change: values are selected only through
    // `DOSSIER_EXPORT_KEYS`, which assertion 1 already pins, so the two claims
    // were restatements of each other. A test that cannot go red is worse than
    // no test, because it reads like coverage.
    //
    // This version puts a UNIQUE sentinel in every blocked key and runs the real
    // builder. It bites on a different mutation from assertion 1: widening how
    // the builder SELECTS values, rather than what the list contains. Replacing
    // the `DOSSIER_EXPORT_KEYS.map(...)` in toExportValues with anything that
    // walks the record's own keys leaks the sentinel and this goes red, while
    // the column list stays untouched and assertion 1 stays green.
    const SENTINEL = 'BLOCKED-VALUE-SENTINEL';
    const record: Record<string, unknown> = { ...FIXTURE };
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      record[key] = `${SENTINEL}-${key}`;
    }

    const csv = buildExportCsv([
      { property_record: record, charge: 0.4, status: 'success' } as unknown as TraceHistory,
    ]);

    expect(csv, 'a blocked value reached the customer spreadsheet').not.toContain(SENTINEL);
  });
});

/**
 * The webhook is the egress that lands in a customer's own system BY
 * DEFINITION, which is the whole reason the API response is filtered too. It is
 * tested here rather than in a route test because the filter lives in the
 * dispatch module: one door, one filter, and both submit routes hand it the raw
 * record.
 */
describe('the trace.completed webhook payload', () => {
  const FIXTURE = (entityHitAddress as { response: { property: Record<string, unknown> } })
    .response.property;

  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeEach(() => {
    posts.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown, init: unknown) => {
      posts.push({
        url: String(url),
        body: JSON.parse(String((init as { body?: unknown })?.body ?? '{}')),
      });
      return new Response('{}', { status: 200 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function dispatch(propertyRecord: unknown) {
    dispatchTraceCompleted({
      webhookUrl: 'https://customer.example.invalid/hook',
      traceId: 'trace-1',
      status: 'success',
      address: '123 MAIN ST',
      city: 'AUSTIN',
      state: 'TX',
      zip: '78701',
      result: null,
      charge: 0.4,
      propertyRecord,
      ownerType: 'entity',
    });
    return posts[0].body;
  }

  it('carries none of the 21 blocked keys', () => {
    // MUTATION: drop toPublicPropertyRecord from the payload and this goes red.
    const record = dispatch(FIXTURE).property_record as Record<string, unknown>;
    for (const key of BLOCKED_PROPERTY_RECORD_KEYS) {
      expect(record, `${key} reached the customer's own system`).not.toHaveProperty(key);
    }
  });

  it('carries the 65 a customer is entitled to', () => {
    const record = dispatch(FIXTURE).property_record as Record<string, unknown>;
    expect(Object.keys(record)).toHaveLength(65);
    expect(record.assessed_value).toBe(FIXTURE.assessed_value);
    expect(record).toHaveProperty('price_per_sqft');
  });

  it('does not mutate the record the route is about to persist', () => {
    // Both routes persist the raw record and pass THE SAME VARIABLE here.
    const record: Record<string, unknown> = { ...FIXTURE };
    dispatch(record);
    expect(Object.keys(record)).toHaveLength(86);
    expect(record.estimated_value).toBe(FIXTURE.estimated_value);
  });

  it('still reports a billed miss as null rather than an empty record', () => {
    expect(dispatch(null).property_record).toBeNull();
  });
});
