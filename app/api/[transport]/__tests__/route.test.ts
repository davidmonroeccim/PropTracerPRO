import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Dormant kill-switch fence for the MCP transport route: GET/POST must 404
// BEFORE any mcp-handler/auth machinery runs whenever SUITE_MCP_ENABLED is not
// exactly "true" (unset, "false", or anything else). The env gate short-circuits
// ahead of withMcpAuth/createMcpHandler, so no mcp-handler mocking is needed.

describe("/api/[transport] dormant gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("GET 404s when SUITE_MCP_ENABLED is unset", async () => {
    vi.stubEnv("SUITE_MCP_ENABLED", undefined as unknown as string);
    delete process.env.SUITE_MCP_ENABLED;
    const { GET } = await import("@/app/api/[transport]/route");
    const res = await GET(new Request("https://proptracerpro.com/api/mcp"));
    expect(res.status).toBe(404);
  });

  it("GET 404s when SUITE_MCP_ENABLED=false", async () => {
    vi.stubEnv("SUITE_MCP_ENABLED", "false");
    const { GET } = await import("@/app/api/[transport]/route");
    const res = await GET(new Request("https://proptracerpro.com/api/mcp"));
    expect(res.status).toBe(404);
  });

  it("POST 404s when SUITE_MCP_ENABLED is not \"true\"", async () => {
    vi.stubEnv("SUITE_MCP_ENABLED", "false");
    const { POST } = await import("@/app/api/[transport]/route");
    const res = await POST(new Request("https://proptracerpro.com/api/mcp", { method: "POST" }));
    expect(res.status).toBe(404);
  });
});

/**
 * THE TOOL DESCRIPTIONS ARE THE OTHER MONEY PROMISE.
 *
 * Claude reads these to decide what to tell a user BEFORE calling a tool that
 * spends their wallet. They are declared inside createMcpHandler and are not
 * exported, so this reads the source, which is also what the bulk page's tests
 * do for the same reason.
 *
 * WHAT WENT WRONG, so it is clear what these hold. Every description was written
 * when this surface billed one model: tier 1, charged per successful trace, free
 * on a miss. Phase 5c-3A routed blank-owner records onto the tier 2 queue, which
 * is charged per RECORD SUBMITTED. The descriptions went on quoting only the
 * tier 1 rates, telling the caller the skipped records "cost nothing", and
 * telling bulk_status that a skip_reason means nothing was charged. All three
 * were false for the tier 2 rows, and all three were quoted at the moment the
 * money moved.
 */
describe("the MCP tool descriptions quote both billing models", () => {
  const SOURCE = readFileSync(fileURLToPath(new URL("../route.ts", import.meta.url)), "utf8");

  /**
   * The copy a caller can actually be shown: comment lines dropped, whitespace
   * collapsed.
   *
   * ALL THREE STEPS ARE LOAD BEARING and each fixed a real false result on this
   * file's first runs. The comments QUOTE the old false sentences to record why
   * they went, so a raw scan finds "costs nothing" in the very paragraph
   * explaining that it was removed. The descriptions are template literals
   * joined with `+` wherever a line ran long, so a sentence that spans a join
   * has backticks and a plus sign sitting in the middle of it. And the line
   * breaks themselves are wherever the formatter put them, which is not a fact
   * about the copy. Structural assertions stay on SOURCE, where the exact text
   * is the point.
   */
  const COPY = SOURCE.split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n")
    .replace(/`\s*\+\s*`/g, "")
    .replace(/"\s*\+\s*"/g, "")
    .replace(/\s+/g, " ");

  it("has a tier 2 rate constant, read from PRICING rather than typed", () => {
    // MUTATION: hardcode either figure and this goes red. A stale number here
    // buys a wrong promise with real money, and note that
    // TIER2_PER_RECORD_SUBMITTED_PRO shares its digits with
    // CHARGE_PER_SUCCESS_WALLET while meaning something completely different.
    expect(SOURCE).toContain("const TIER_2_RATES");
    expect(SOURCE).toContain("PRICING.TIER2_PER_RECORD_SUBMITTED_PRO.toFixed(2)");
    expect(SOURCE).toContain("PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET.toFixed(2)");
  });

  it("quotes the tier 2 rates on both tools that can reach a tier 2 record", () => {
    // skip_trace_quote prices the batch and skip_trace_bulk spends on it. A
    // caller shown only TIER_1_RATES is quoted per SUCCESS and billed per
    // RECORD.
    expect(SOURCE.match(/\$\{TIER_2_RATES\}/g) ?? []).toHaveLength(2);
    expect(SOURCE.match(/\$\{TIER_1_RATES\}/g) ?? []).toHaveLength(2);
  });

  it("never calls a record with no owner name skipped, free or untraced", () => {
    expect(COPY).not.toContain("costs nothing");
    expect(COPY).not.toContain("skipped for having no owner name");
    expect(COPY).not.toContain("is not traced on this surface yet");
  });

  it("tells the caller which records are billed on a miss", () => {
    expect(COPY).toContain("charged for every record you send");
    expect(COPY).toContain("costs the same whether or not contacts come back");
  });

  it("stops bulk_status claiming a skip_reason means nothing was charged", () => {
    // THE CLAIM THAT BECAME LIVE IN THIS DISPATCH. Wiring rowSkipReason() into
    // the MCP payload means a property_trace_no_reach row now arrives carrying a
    // skip_reason, and the description told the model that such a row was never
    // asked about and never charged. It was charged in full.
    // MUTATION: restore "which means no vendor was ever asked and nothing was
    // charged for it" and this goes red.
    expect(SOURCE).not.toContain("no vendor was ever asked and nothing was charged");
  });

  it("tells the model the reason sentence itself says which rows were charged", () => {
    // Four of the five reasons are free rows and one is billed, so the
    // description cannot state a blanket money fact either. It points at the
    // sentence, which is the only thing that knows.
    expect(SOURCE).toContain("says why that row has no contacts");
  });

  it("documents the paging so a caller knows when rows are missing", () => {
    expect(SOURCE).toContain("results_returned");
    expect(SOURCE).toContain("results_total");
  });

  it("carries no em-dash, en-dash or emoji in anything a caller is shown", () => {
    expect(SOURCE).not.toMatch(/[—–]/);
    expect(SOURCE).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
