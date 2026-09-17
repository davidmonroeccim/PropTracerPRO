import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * RECEIPT INVARIANT: a write of `trace_history.charge` may not silently replace
 * what a row already collected.
 *
 * WHY THIS EXISTS. Review 2026-09-17 found a path with no error in it at all:
 * trace an address with no owner (tier 2 collects $0.25, the county has no
 * parcel), then trace it again WITH an owner name. The second call is tier 1,
 * and the settle wrote `charge: 0, tier: 1` flat over the reused row. The
 * receipt vanished while the wallet_transactions row still pointed at it, so
 * excludeBilledRows read the row as unbilled, the next submit tried to delete
 * it, Postgres raised a foreign key violation, and that address returned 500
 * forever. `charge` is a RECEIPT, not a scratch field.
 *
 * A source-level fence on purpose, matching tierLedger.test.ts. These writes are
 * spread across two status routes, three cron sweeps, two bulk settles and both
 * tier 2 persists, and several of those files have no test harness of their own.
 * A new charge site added anywhere turns this red the moment it is written,
 * which is the only thing that stops the invariant rotting.
 *
 * HOW TO SATISfy IT. Either fold (`foldBillingWrite`, which accumulates the
 * charge and never downgrades the tier), or resolve the amount from the ledger
 * BEFORE writing (`collectedChargeFor`, where folding would double-count what is
 * already on the row), or add the site to ALLOWED_RAW_WRITES with a reason.
 * Adding an entry is meant to be a decision, not a formality.
 */

const ROOTS = ["app", "lib"];

/**
 * Sites that write `charge` raw, each with the reason it is safe TODAY.
 *
 * Every entry whose reason is "tier 1 only" is a phase 5 liability, not a
 * permanent exemption: bulk tier 2 is what puts a real receipt on these rows,
 * and on that day a flat `charge: 0` starts erasing money that moved. Phase 5
 * should work this list rather than rediscovering it.
 */
const ALLOWED_RAW_WRITES: Record<string, string> = {
  "app/api/cron/sweep-entity-traces/route.ts":
    "Resolves the amount from the ledger via collectedChargeFor() before writing, so folding would double-count. Its two `charge: 0` writes are tier-1-only miss paths where nothing was collected. PHASE 5 LIABILITY.",
  "lib/trace/settleBulkJob.ts":
    "Same ledger-probe pattern as the entity cron. Its two `charge: 0` writes are tier-1-only miss paths. PHASE 5 LIABILITY.",
  "app/api/trace/bulk/status/route.ts":
    "Dashboard bulk settle. Bulk is tier 1 only today, so no row reaching it carries a tier 2 receipt. PHASE 5 LIABILITY.",
  "app/api/cron/sweep-business-traces/route.ts":
    "Settles business_trace_jobs rows, which are tier 1 entity rows. PHASE 5 LIABILITY.",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Every `.from('trace_history').update({...})` payload in a file. */
function updatePayloads(source: string): string[] {
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
 * `charge` at a PROPERTY position only. Excludes `ai_research_charge` (a
 * different column with no ambiguity) and the VALUE half of
 * `ai_research_charge: charge,`, which a looser boundary reads as a write.
 */
function writesCharge(payload: string): boolean {
  return /(^|,)\s*charge\s*[:,]/.test(stripComments(payload));
}

/** The write takes its value from foldBillingWrite's result. */
function isFolded(payload: string): boolean {
  return /(^|,)\s*charge\s*:\s*\w*[Bb]illing\.charge/.test(stripComments(payload));
}

function chargeWriteSites(): Array<{ file: string; payload: string }> {
  const sites: Array<{ file: string; payload: string }> = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const payload of updatePayloads(source)) {
        if (writesCharge(payload)) sites.push({ file, payload });
      }
    }
  }
  return sites;
}

describe("trace_history.charge is a receipt, not a scratch field", () => {
  it("finds charge writes at all, so a broken scanner cannot pass vacuously", () => {
    // The canary. If the regex or the traversal breaks, every assertion below
    // passes over an empty list and reports green while checking nothing.
    expect(chargeWriteSites().length).toBeGreaterThanOrEqual(10);
  });

  it("writes every charge folded, or from a file that justifies writing it raw", () => {
    const offenders = chargeWriteSites()
      .filter(({ file, payload }) => !isFolded(payload) && !ALLOWED_RAW_WRITES[file])
      .map(({ file }) => file);

    // A new charge site, or an existing one that stopped folding. Fold it with
    // foldBillingWrite, or resolve it from the ledger first, or add the file to
    // ALLOWED_RAW_WRITES with the reason it cannot clobber a receipt.
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("keeps every exemption justified, and none of them stale", () => {
    const rawWriters = new Set(
      chargeWriteSites()
        .filter(({ payload }) => !isFolded(payload))
        .map(({ file }) => file)
    );

    for (const [file, reason] of Object.entries(ALLOWED_RAW_WRITES)) {
      // An exemption for a file that no longer writes charge raw is dead weight
      // that will later be read as permission. Delete it.
      expect(rawWriters.has(file), `stale exemption: ${file}`).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("folds the settles that reach reused rows", () => {
    // These four are the paths a row can travel twice: both single-trace tier 2
    // persists and both status-route settles. They are the ones the lockout was
    // found on, so they are pinned by name rather than left to the general rule.
    const mustFold = [
      "app/api/trace/single/route.ts",
      "app/api/v1/trace/single/route.ts",
      "app/api/trace/status/route.ts",
      "app/api/v1/trace/status/route.ts",
      "app/api/cron/sweep-stale-traces/route.ts",
    ];
    for (const file of mustFold) {
      const payloads = updatePayloads(readFileSync(file, "utf8")).filter(writesCharge);
      expect(payloads.length, `no charge write found in ${file}`).toBeGreaterThan(0);
      for (const payload of payloads) {
        expect(isFolded(payload), `unfolded charge write in ${file}`).toBe(true);
      }
    }
  });
});
