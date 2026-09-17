import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCKED_PROPERTY_RECORD_KEYS } from '@/lib/trace/publicPropertyRecord';
import { dispatchTraceCompleted } from '@/lib/trace/traceCompletedWebhook';
import entityHitAddress from '@/lib/tracerfy/__tests__/fixtures/entity-hit-address.json';

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
