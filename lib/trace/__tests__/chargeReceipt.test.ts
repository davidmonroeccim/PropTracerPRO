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
 * BOTH RECEIPT COLUMNS, NOT JUST THE MONEY. `charge` and `tier` are one
 * receipt and both rules are one-way, so the fence covers both. It inspected
 * `charge` alone until 2026-09-17 and the omission has a body count: the same
 * tier-tautology was found by a reviewer at THREE separate settle sites,
 * because flattening a folded `tier` to a literal 1 killed no test anywhere.
 *
 * HOW TO SATISfy IT. Three forms are safe, and only three:
 *
 *  1. FOLD (`foldBillingWrite`), which accumulates the charge and never
 *     downgrades the tier. The default for any write with the row in hand.
 *  2. GUARD (`excludeBilledRows`), for a BLANKET update that reads no row and
 *     therefore has nothing to fold into. The guard is pushed into the database,
 *     so the statement cannot match a row that has collected anything and there
 *     is no read-then-write race. This is STRICTLY STRONGER than folding, which
 *     is why it counts.
 *  3. LEDGER (`collectedChargeFor`), where the value written IS money already
 *     recorded in wallet_transactions and folding it onto the row would
 *     double-count that same debit. Only this form needs ALLOWED_RAW_WRITES,
 *     and it is available to `charge` ONLY -- the ledger records money, not the
 *     billing model, so nothing can ever write `tier` from it.
 *
 * Adding an ALLOWED_RAW_WRITES entry is meant to be a decision, not a formality.
 *
 * A FOLD IS PROVED, NEVER PATTERN-MATCHED. The old test for form 1 was
 * `/charge:\s*\w*[Bb]illing\.charge/`, which asked what the identifier was
 * CALLED and never what it was bound to: renaming any local to `billing` bought
 * a file its way out of the fence with the suite still green. foldedBindings()
 * now derives the answer from the file's own assignments, per column.
 *
 * A GUARD IS NOT A LICENCE TO PUT DELIVERY FACTS BEHIND IT. `excludeBilledRows`
 * protects `charge` and `tier`. `status`, `is_successful`, `trace_result` and
 * the counts are delivery facts, and withholding those from a paid row strands
 * it -- see the two-statement split in bulk/status and settleBulkJob, and the
 * tests that pin it. Money behind the guard, delivery in front of it.
 */

const ROOTS = ["app", "lib"];

/**
 * Sites that write `charge` raw, each with the reason it is safe TODAY.
 *
 * NO ENTRY HERE MAY BE JUSTIFIED BY "TIER 1 ONLY" EVER AGAIN. That reason was
 * a bet that no row reaching these files would carry a tier 2 receipt, and
 * phase 5b paid it off: the four entries this list held on 2026-09-17 were the
 * four files that erased receipts the moment bulk tier 2 landed. Two of them
 * now fold and are gone from this list. The two that remain earn it on a
 * different ground entirely -- they do not write an amount they computed, they
 * write an amount they READ BACK OUT OF THE LEDGER, and folding a ledger
 * reading onto a row that may already carry it would count one debit twice.
 *
 * The bar for a new entry: explain why folding would be WRONG, not why
 * clobbering happens to be harmless today.
 */
const ALLOWED_RAW_WRITES: Record<string, string> = {
  "app/api/cron/sweep-entity-traces/route.ts":
    "ONE remaining raw write: the FastAppend-credit arm resolves the amount from wallet_transactions via collectedChargeFor() before writing, so the value IS the ledger. Folding would add the ledger reading to a row that may already carry it and count one debit twice. Its two miss paths now fold.",
  "lib/trace/settleBulkJob.ts":
    "TWO remaining raw writes, both the same ledger-probe pattern as the entity cron: collectedChargeFor() answers with money that has already moved, so folding it onto the row would double-count that same debit. Its miss path, its shared-bulk match and its blanket leftover sweep all fold or are guarded now.",
  "app/api/cron/sweep-business-traces/route.ts":
    "ONE raw write, and it EARNED this entry on 2026-09-17 by gaining the collectedChargeFor probe its two twins already had. Once a site asks the ledger, the ledger total is authoritative and folding its answer onto the row's own column counts the same debit twice. `tier` is still taken from foldBillingWrite, because the ledger does not know the billing model.",
  "app/api/cron/sweep-property-traces/route.ts":
    "ONE raw write, the same ledger-probe pattern as its three twins, and it survived a narrowing on 2026-09-18 rather than being taken on trust. collectedChargesFor() answers TWICE off one read: `inWindow`, bounded to the bulk job the row is currently enqueued for, decides whether to deduct, and `total` is what gets written. Splitting them is the F2 fix -- an unbounded decision answered with a PREVIOUS submit's debit on a reused row, skipped the deduct, and bought the dossier again for nothing. The value written is still the ledger's own net, so folding it onto the row's column would count one debit twice; the row's column and the ledger are the same money. `tier` comes from foldBillingWrite because the ledger records money, not the billing model, and this is the one queue where a flat literal would be a tier 2 DOWNGRADE.",
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

/**
 * The byte ranges covered by an `excludeBilledRows( ... )` call.
 *
 * A charge write inside one of these is narrowed IN THE DATABASE so it can
 * never match a row that has collected anything, which is why it does not also
 * need to fold. Comments are stripped before this runs, so prose mentioning the
 * helper cannot manufacture a range.
 */
function guardedRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const marker = /excludeBilledRows\(/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    ranges.push([match.index, i]);
  }
  return ranges;
}

/** The two monotonic receipt columns this fence guards. */
type ReceiptColumn = "charge" | "tier";

/** Which identifiers in a file carry a folded value, PER COLUMN. */
type FoldedBindings = Record<ReceiptColumn, Set<string>>;

/**
 * The identifiers in this file whose `column` really is a foldBillingWrite
 * result.
 *
 * WHY THE FENCE HAS TO KNOW THIS, AND THE HOLE IT CLOSES. Until 2026-09-17 the
 * fold test was `/charge:\s*\w*[Bb]illing\.charge/` -- a check on the SHAPE of
 * the identifier, never on what it was bound to. Any name ending in "billing"
 * or "Billing" satisfied it. Proven, not theorised: rename a local holding a
 * bare computed amount to `billing`, delete that file's ALLOWED_RAW_WRITES
 * entry, and the whole suite stays green while the file clobbers receipts. A
 * fence that can be satisfied by choosing a variable name is not a fence.
 *
 * PER COLUMN, AND THAT IS NOT FUSSINESS. sweep-business-traces holds
 *
 *     collected = { charge, tier: foldBillingWrite(historyRow, {...}).tier }
 *
 * where the two halves have DIFFERENT provenance: `tier` comes from the fold,
 * `charge` is the LEDGER's answer, written raw on purpose and exempted for it.
 * A binding set that is not column-aware has to call that identifier either
 * wholly folded -- which silently retires a live exemption as "stale" and drops
 * the file out of the fence -- or wholly raw, which would demand an exemption
 * for a `tier` that genuinely folds. Both are wrong about half the object.
 */
function foldedBindings(source: string, column: ReceiptColumn): Set<string> {
  const names = new Set<string>();

  // FORM 1: the whole result. `const billing = foldBillingWrite(row, {...})`.
  // Every column read off this name is folded.
  const direct =
    /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]*)?=\s*(?:await\s+)?foldBillingWrite\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = direct.exec(source)) !== null) names.add(match[1]);

  // FORM 2: ONE column of it, carried in an object literal alongside values
  // that are not folded at all. Brace-matched rather than regex-bounded,
  // because the fold's own argument object nests inside this one and a
  // non-greedy `}` would stop at the wrong brace.
  const literal = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]*)?=\s*\{/g;
  const foldedProperty = new RegExp(
    `(^|,)\\s*${column}\\s*:\\s*(?:foldBillingWrite\\s*\\(|([A-Za-z_$][\\w$]*)\\s*\\.)`
  );
  while ((match = literal.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    const property = foldedProperty.exec(source.slice(start, i - 1));
    // Either the call inline, or a member read off a name FORM 1 already
    // proved. Anything else leaves the identifier out of this set.
    if (property && (property[2] === undefined || names.has(property[2]))) {
      names.add(match[1]);
    }
  }
  return names;
}

interface ChargePayload {
  payload: string;
  /** True when this update sits inside an excludeBilledRows(...) call. */
  guarded: boolean;
  /** Identifiers in the SAME FILE that hold a folded value, per column. */
  folds: FoldedBindings;
}

/** Every `.from('trace_history').update({...})` payload in a file. */
function updatePayloads(rawSource: string): ChargePayload[] {
  // Stripped ONCE, and every offset below is into the stripped text, so the
  // payload scan and the guard scan cannot disagree about where anything is.
  const source = stripComments(rawSource);
  const ranges = guardedRanges(source);
  const folds: FoldedBindings = {
    charge: foldedBindings(source, "charge"),
    tier: foldedBindings(source, "tier"),
  };
  const payloads: ChargePayload[] = [];
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
    payloads.push({
      payload: source.slice(start, i - 1),
      guarded: ranges.some(([open, close]) => match!.index > open && match!.index < close),
      folds,
    });
  }
  return payloads;
}

/**
 * The column at a PROPERTY position only. For `charge` that excludes
 * `ai_research_charge` (a different column with no ambiguity) and the VALUE
 * half of `ai_research_charge: charge,`, which a looser boundary reads as a
 * write.
 */
function writesColumn(payload: string, column: ReceiptColumn): boolean {
  return new RegExp(`(^|,)\\s*${column}\\s*[:,]`).test(stripComments(payload));
}

const writesCharge = (payload: string) => writesColumn(payload, "charge");

/**
 * True when `column` is written from a foldBillingWrite result.
 *
 * TWO FORMS, AND BOTH ARE PROVED RATHER THAN PATTERN-MATCHED:
 *
 *   tier: foldBillingWrite(row, {...}).tier   -- the call, inline, right here
 *   charge: billing.charge                    -- a name PROVEN bound to a fold
 *                                                by foldedBindings() above
 *
 * The second is the one that used to be taken on trust. `folds` is derived from
 * the file's own assignments, so a local can no longer buy its way past this
 * fence by being called `billing`.
 */
function isFoldedColumn(
  payload: string,
  column: ReceiptColumn,
  folds: FoldedBindings
): boolean {
  const source = stripComments(payload);
  const write = new RegExp(`(^|,)\\s*${column}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*(\\(|\\.)`, "g");
  let match: RegExpExecArray | null;
  while ((match = write.exec(source)) !== null) {
    const [, , identifier, next] = match;
    // The inline call: `foldBillingWrite(...).tier`.
    if (identifier === "foldBillingWrite" && next === "(") return true;
    // A member read off a name this file PROVES folded for this column.
    if (next === "." && folds[column].has(identifier)) return true;
  }
  return false;
}

interface ChargeSite extends ChargePayload {
  file: string;
}

function chargeWriteSites(): ChargeSite[] {
  const sites: ChargeSite[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      for (const entry of updatePayloads(readFileSync(file, "utf8"))) {
        if (writesCharge(entry.payload)) sites.push({ file, ...entry });
      }
    }
  }
  return sites;
}

/** Folded or narrowed-in-the-database: the two forms that need no exemption. */
const isSafeWithoutExemption = (site: ChargeSite) =>
  isFoldedColumn(site.payload, "charge", site.folds) || site.guarded;

describe("trace_history.charge is a receipt, not a scratch field", () => {
  it("finds charge writes at all, so a broken scanner cannot pass vacuously", () => {
    // The canary. If the regex or the traversal breaks, every assertion below
    // passes over an empty list and reports green while checking nothing.
    expect(chargeWriteSites().length).toBeGreaterThanOrEqual(10);
  });

  it("finds the excludeBilledRows guards, so the new form cannot pass vacuously", () => {
    // The second canary. `guarded` is now a way to PASS, so a broken paren scan
    // would be a silent weakening rather than a failure. Both blanket sites
    // must be seen as guarded, and at least one unguarded charge write must
    // still exist, or the scanner is calling everything safe.
    const sites = chargeWriteSites();
    expect(sites.filter((s) => s.guarded).length).toBeGreaterThanOrEqual(2);
    expect(sites.filter((s) => !s.guarded).length).toBeGreaterThan(0);
  });

  it("writes every charge folded or guarded, or from a file that justifies writing it raw", () => {
    const offenders = chargeWriteSites()
      .filter((site) => !isSafeWithoutExemption(site) && !ALLOWED_RAW_WRITES[site.file])
      .map(({ file }) => file);

    // A new charge site, or an existing one that stopped folding. Fold it with
    // foldBillingWrite, or narrow it with excludeBilledRows, or resolve it from
    // the ledger first and add the file to ALLOWED_RAW_WRITES with the reason it
    // cannot clobber a receipt.
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("keeps every exemption justified, and none of them stale", () => {
    const rawWriters = new Set(
      chargeWriteSites()
        .filter((site) => !isSafeWithoutExemption(site))
        .map(({ file }) => file)
    );

    for (const [file, reason] of Object.entries(ALLOWED_RAW_WRITES)) {
      // An exemption for a file that no longer writes charge raw is dead weight
      // that will later be read as permission. Delete it.
      expect(rawWriters.has(file), `stale exemption: ${file}`).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  /* ---------------------------------------------------------------- *
   * AND `tier`, WHICH IS THE OTHER HALF OF THE SAME RECEIPT.
   *
   * The fence inspected `charge` alone until 2026-09-17, and that omission has
   * a body count: the tier-tautology class was found and fixed at THREE
   * separate settle sites, each time by a reviewer rather than by a test,
   * because flattening a folded `tier` to a literal 1 killed no test anywhere.
   * Every fixture in the suite carried tier 1 or no tier, where the fold's
   * answer and the literal are the same number.
   *
   * A flat tier is not cosmetic. isCacheHitRow's third arm is
   * `tier = 2 AND charge > 0`, so writing 1 over a 2 stops a billed tier 2 row
   * being served from the database and the customer re-buys what they already
   * own -- and it does it silently, because the row stays non-zero and never
   * trips the 23503 lockout that makes the charge half of this loud.
   *
   * WHY THIS NEEDS NO EXEMPTION LIST OF ITS OWN. Measured before it was
   * written: every `tier` write in a trace_history update payload is already
   * folded or already guarded, with ONE that reaches the fold through an
   * object literal (`collected.tier` in sweep-business-traces) -- which is why
   * foldedBindings tracks bindings per column rather than per name. There is
   * nothing left over to excuse, so there is nothing to excuse it with. The
   * moment that stops being true, this test says so.
   * ---------------------------------------------------------------- */
  it("finds tier writes at all, so a broken scanner cannot pass vacuously", () => {
    const sites = chargeWriteSites();
    expect(sites.filter((s) => writesColumn(s.payload, "tier")).length).toBeGreaterThanOrEqual(5);
  });

  it("writes every tier folded or guarded, with no exemption available", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        for (const site of updatePayloads(readFileSync(file, "utf8"))) {
          if (!writesColumn(site.payload, "tier")) continue;
          if (isFoldedColumn(site.payload, "tier", site.folds) || site.guarded) continue;
          offenders.push(file);
        }
      }
    }
    // A new tier write, or an existing one that stopped folding. Fold it with
    // foldBillingWrite, or narrow the statement with excludeBilledRows. Unlike
    // `charge` there is no third form: the ledger records money, not the
    // billing model, so nothing can ever write this column from it.
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("keeps DELIVERY facts out of every excludeBilledRows guard", () => {
    // STATUS IS NOT A RECEIPT, and this is the fence for it. The guard exists to
    // protect `charge` and `tier`. Put `status` or `is_successful` behind it and
    // a billed row is skipped by the sweep, keeps status='processing' inside a
    // job that has been marked completed, and is later claimed by
    // sweep-stale-traces -- which settles it against another property's contacts
    // from the shared Tracerfy batch and bills the customer a second time.
    //
    // Every blanket sweep is therefore TWO statements: money behind the guard,
    // delivery in front of it.
    const delivery = ["status", "is_successful", "trace_result", "phone_count", "email_count"];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        for (const { payload, guarded } of updatePayloads(readFileSync(file, "utf8"))) {
          if (!guarded) continue;
          for (const column of delivery) {
            expect(
              new RegExp(`(^|,)\\s*${column}\\s*[:,]`).test(payload),
              `delivery column \`${column}\` behind an excludeBilledRows guard in ${file}`
            ).toBe(false);
          }
        }
      }
    }
  });

  it("folds the settles that reach reused rows", () => {
    // These are the paths a row can travel twice: both single-trace tier 2
    // persists, both status-route settles, and the three sweeps that re-settle
    // a row long after it was first written. They are the ones the lockout was
    // found on, so they are pinned by name rather than left to the general
    // rule -- a file that drops off ALLOWED_RAW_WRITES must not be free to
    // quietly stop folding later.
    const mustFold = [
      "app/api/trace/single/route.ts",
      "app/api/v1/trace/single/route.ts",
      "app/api/trace/status/route.ts",
      "app/api/v1/trace/status/route.ts",
      "app/api/cron/sweep-stale-traces/route.ts",
      "app/api/trace/bulk/status/route.ts",
      "lib/trace/singleTier1.ts",
    ];
    for (const file of mustFold) {
      const sites = updatePayloads(readFileSync(file, "utf8"))
        .map((entry) => ({ file, ...entry }))
        .filter((site) => writesCharge(site.payload));
      expect(sites.length, `no charge write found in ${file}`).toBeGreaterThan(0);
      for (const site of sites) {
        expect(
          isSafeWithoutExemption(site),
          `charge write in ${file} is neither folded nor guarded`
        ).toBe(true);
      }
    }
  });
});
