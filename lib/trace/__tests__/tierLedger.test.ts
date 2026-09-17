import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * LEDGER INVARIANT: every write of `trace_history.charge` also writes `tier`.
 *
 * `charge` alone cannot say which billing model produced a row.
 * PRICING.CHARGE_PER_SUCCESS_WALLET (tier 1 Pay-As-You-Go, per SUCCESS, free on
 * a miss) and PRICING.TIER2_PER_RECORD_SUBMITTED_PRO (tier 2 Pro, per RECORD
 * SUBMITTED, billed on a miss) are BOTH 0.25. lib/constants.ts:34-36 already
 * warns the digits collide. A $0.25 row with no `tier` is unattributable, and
 * every refund, dispute and revenue split computed from it is a guess.
 *
 * This is a source-level fence rather than a behavioural one on purpose: the
 * charge sites are spread across two status routes, two cron sweeps and the
 * bulk settle helper, two of which have no test harness of their own. A new
 * charge site added anywhere without a `tier` turns this red the moment it is
 * written, which is the only way to keep the invariant from rotting.
 *
 * Scope note: `ai_research_charge` is deliberately NOT covered. It is a
 * separate column whose values do not collide with anything, so it carries no
 * ambiguity for `tier` to resolve.
 */

const ROOTS = ["app", "lib"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Extracts the object literal of every `.from('trace_history').update({...})`. */
function traceHistoryUpdatePayloads(source: string): string[] {
  const payloads: string[] = [];
  const marker = /\.from\(['"]trace_history['"]\)\s*\.update\(\{/g;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    payloads.push(source.slice(start, i - 1));
  }
  return payloads;
}

/**
 * True when the payload assigns the `charge` column, in either `charge: x` or
 * shorthand `charge,` form.
 *
 * The key must sit at a PROPERTY position — start of the literal, or just after
 * a comma. That excludes `ai_research_charge` / `total_charge` (different
 * columns, no ambiguity) and, importantly, the VALUE half of
 * `ai_research_charge: charge,` which a looser boundary reads as a charge write.
 */
/**
 * Comments sit between the comma and the next key, and `\s*` does not cross
 * them. A `tier:` documented with a leading comment is still a `tier:`.
 */
function stripComments(payload: string): string {
  return payload.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function writesCharge(payload: string): boolean {
  return /(?:^|[{,])\s*charge\s*[:,]/.test(stripComments(payload));
}

function writesTier(payload: string): boolean {
  return /(?:^|[{,])\s*tier\s*:/.test(stripComments(payload));
}

describe("trace_history.charge is never written without tier", () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r));

  const offenders: Array<{ file: string; payload: string }> = [];
  let chargeSites = 0;

  for (const file of files) {
    for (const payload of traceHistoryUpdatePayloads(readFileSync(file, "utf8"))) {
      if (!writesCharge(payload)) continue;
      chargeSites++;
      if (!writesTier(payload)) offenders.push({ file, payload: payload.trim() });
    }
  }

  it("finds the charge write sites at all (guards the scanner itself)", () => {
    // If a refactor changes how these updates are written, the scanner would
    // silently find nothing and pass. Pin a floor.
    expect(chargeSites).toBeGreaterThanOrEqual(8);
  });

  it("stamps tier on every one of them", () => {
    expect(
      offenders.map((o) => `${o.file}: ${o.payload.replace(/\s+/g, " ").slice(0, 120)}`)
    ).toEqual([]);
  });

  it("the scanner actually detects a missing tier (mutation self-check)", () => {
    // Proves the two assertions above can fail, rather than passing vacuously.
    const withoutTier = `
      status: 'success',
      cost: PRICING.COST_PER_RECORD,
      charge,
    `;
    expect(writesCharge(withoutTier)).toBe(true);
    expect(writesTier(withoutTier)).toBe(false);

    // And that it does not confuse ai_research_charge for charge, in either
    // the key position or the value position.
    const researchOnly = `
      ai_research_status: 'found',
      ai_research_charge: 0,
    `;
    expect(writesCharge(researchOnly)).toBe(false);
    expect(writesCharge(`ai_research_status: 'found', ai_research_charge: charge,`)).toBe(false);
  });
});
