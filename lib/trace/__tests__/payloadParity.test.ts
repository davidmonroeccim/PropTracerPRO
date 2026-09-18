import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE TWO PER-RECORD PAYLOADS THAT CLAIM TO BE IDENTICAL, CHECKED INSTEAD OF
 * TRUSTED.
 *
 * `buildPerRecordResult` exists twice: once in app/api/v1/trace/bulk/status for
 * the API-key surface, once in lib/suite/mcp-tools for the gateway. Both carry a
 * comment saying they are line for line the same payload by design and must not
 * diverge. They HAD diverged: `property_record` and `tier` were on the MCP one
 * only, so an API-key caller who paid the tier 2 per-record rate specifically to
 * buy a county property record could not see it on the one surface they poll.
 *
 * Two comments asserting parity is not parity. This compares the key sets.
 *
 * WHY A SOURCE SCAN RATHER THAN CALLING BOTH. Neither function is exported;
 * reaching them means standing up two route handlers with two different auth
 * stacks and two client stubs, to compare a list of keys. The keys are written
 * literally in both files, one per line, so reading them is direct. The
 * per-surface tests already prove the VALUES; this proves the SHAPES match.
 */

const ROOT = process.cwd();

const V1 = 'app/api/v1/trace/bulk/status/route.ts';
const MCP = 'lib/suite/mcp-tools.ts';

/**
 * The keys returned by a file's `buildPerRecordResult`.
 *
 * Read from the `return {` that follows the function declaration, up to the
 * closing brace at the same indentation. Nested object keys are excluded by the
 * indentation match, which is what keeps `contacts` from dragging in whatever it
 * is built from.
 */
function perRecordKeys(path: string): string[] {
  const source = readFileSync(join(ROOT, path), 'utf8');
  const start = source.indexOf('function buildPerRecordResult');
  expect(start, `buildPerRecordResult not found in ${path}`).toBeGreaterThan(-1);

  const body = source.slice(start);
  const returnAt = body.indexOf('return {');
  const end = body.indexOf('\n  };', returnAt);
  expect(end, `could not find the end of the payload in ${path}`).toBeGreaterThan(returnAt);

  const block = body.slice(returnAt, end);
  // `key: value` AND bare `key,` shorthand. Both payloads use shorthand for the
  // keys they destructure (owner_contact_name, owner_contact_source, and
  // `contacts` on v1 only), so a colon-only pattern silently under-counts one
  // side and reports a difference that is an artefact of this regex rather than
  // of the payloads. That happened on the first run of this file.
  return [...block.matchAll(/^\s{4}([a-z_]+)(?::|,\s*$)/gm)].map((m) => m[1]);
}

describe('the v1 and MCP per-record payloads', () => {
  const v1Keys = perRecordKeys(V1);
  const mcpKeys = perRecordKeys(MCP);

  it('parses both payloads at all, so a broken scan cannot pass silently', () => {
    // A regex that matched nothing would make the comparison below vacuously
    // true, which is the way a parity test quietly stops being one.
    expect(v1Keys.length).toBeGreaterThanOrEqual(12);
    expect(mcpKeys.length).toBeGreaterThanOrEqual(12);
  });

  it('carry exactly the same keys', () => {
    // MUTATION: delete property_record or tier from the v1 payload and this goes
    // red, which is the divergence that shipped while both comments claimed
    // parity.
    expect([...v1Keys].sort()).toEqual([...mcpKeys].sort());
  });

  it('both carry the property record, filtered', () => {
    // The tier 2 row is charged per RECORD SUBMITTED to buy this. A surface that
    // bills for it and does not return it is selling an invisible product.
    for (const path of [V1, MCP]) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source, path).toContain('property_record: toPublicPropertyRecord(row.property_record)');
    }
  });

  it('both report an unknown tier as an absence rather than as a number', () => {
    // Null on a row written before migration 20260917. Never 0, which would read
    // as a tier that does not exist, and never a guess.
    for (const path of [V1, MCP]) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source, path).toContain('tier: row.tier ?? null');
    }
  });
});
