import { describe, expect, it } from "vitest";
import { assertPtpAccess, ctx, ok, err, PTP_MCP_CAVEAT } from "@/lib/suite/mcp-shared";
import { PRICING } from "@/lib/constants";

describe("assertPtpAccess", () => {
  it("passes when prop-tracer-pro is present", () => {
    expect(() => assertPtpAccess(["waldo", "prop-tracer-pro"])).not.toThrow();
  });
  // MUTATION FENCE: deleting the throw in assertPtpAccess turns this red.
  it("throws when prop-tracer-pro is absent", () => {
    expect(() => assertPtpAccess(["waldo"])).toThrow(/does not include PropTracerPRO/);
  });
  it("throws on empty scopes", () => {
    expect(() => assertPtpAccess([])).toThrow();
  });
});

describe("ctx", () => {
  it("extracts userId and products", () => {
    expect(ctx({ authInfo: { scopes: ["prop-tracer-pro"], extra: { userId: "u1" } } })).toEqual({
      userId: "u1",
      products: ["prop-tracer-pro"],
    });
  });
  it("throws when unauthenticated", () => {
    expect(() => ctx({})).toThrow(/Not authenticated/);
  });
});

describe("ok/err", () => {
  it("ok appends the caveat", () => {
    const out = ok({ a: 1 });
    expect(out.content[0].text).toContain('"a": 1');
    expect(out.content[0].text).toContain(PTP_MCP_CAVEAT);
  });
  it("err marks isError and does not leak stack", () => {
    const out = err(new Error("boom"));
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("boom");
    expect(out.content[0].text).not.toMatch(/\n\s+at /);
  });
});

/**
 * THE CAVEAT IS A MONEY PROMISE, AND IT IS APPENDED TO EVERY MCP RESPONSE.
 *
 * Claude reads this out to a user before spending their wallet, so a sentence
 * that is true of one billing model and false of the other is quoted as fact at
 * the exact moment it costs money.
 *
 * It said a record with no owner name "is not traced on this surface yet, so it
 * comes back skipped with a reason and costs nothing". Phase 5c-3A routed those
 * records straight onto the tier 2 queue, where they are charged per record
 * submitted. From that commit until this one, the caveat quoted "costs nothing"
 * immediately before billing for exactly those records.
 */
describe("the caveat quotes both billing models", () => {
  it("names the tier 1 model as per successful trace, with both plan rates", () => {
    expect(PTP_MCP_CAVEAT).toContain("charged per successful trace");
    expect(PTP_MCP_CAVEAT).toContain(`$${PRICING.CHARGE_PER_SUCCESS.toFixed(2)}`);
    expect(PTP_MCP_CAVEAT).toContain(`$${PRICING.CHARGE_PER_SUCCESS_WALLET.toFixed(2)}`);
  });

  it("names the tier 2 model as per record sent, with both plan rates", () => {
    // MUTATION: delete either tier 2 rate and this goes red. Quoting only the
    // tier 1 rates is how a caller is shown a per-success price and then billed
    // a per-record one.
    expect(PTP_MCP_CAVEAT).toContain("charged for every record you send");
    expect(PTP_MCP_CAVEAT).toContain(`$${PRICING.TIER2_PER_RECORD_SUBMITTED_PRO.toFixed(2)}`);
    expect(PTP_MCP_CAVEAT).toContain(`$${PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET.toFixed(2)}`);
  });

  it("never says a record with no owner name is free or skipped", () => {
    // The three claims that went false in 5c-3A, each pinned so it cannot come
    // back by a well-meaning simplification.
    expect(PTP_MCP_CAVEAT).not.toContain("costs nothing");
    expect(PTP_MCP_CAVEAT).not.toContain("comes back skipped");
    expect(PTP_MCP_CAVEAT).not.toContain("not traced on this surface");
  });

  it("keeps the free-on-a-miss promise attached to tier 1 and nothing else", () => {
    // It is still true, and it is still worth saying: it is the promise that
    // makes a tier 1 batch safe to run. What it may not do is sit as a bare
    // sentence that reads as covering the whole product.
    expect(PTP_MCP_CAVEAT).toMatch(/owner of record[\s\S]*finds nothing is free/);
    expect(PTP_MCP_CAVEAT).not.toMatch(/finds nothing is free[\s\S]*owner of record and/);
  });

  it("says the tier 2 records cost the same whether or not anything is found", () => {
    expect(PTP_MCP_CAVEAT).toContain("whether or not contacts come back");
  });

  it("carries no em-dash, en-dash, asterisk or emoji", () => {
    expect(PTP_MCP_CAVEAT).not.toMatch(/[—–*]/);
    expect(PTP_MCP_CAVEAT).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("never claims anyone was notified and never asks for funds", () => {
    expect(PTP_MCP_CAVEAT).not.toMatch(/notified|alerted|our team/i);
    expect(PTP_MCP_CAVEAT).not.toMatch(/add funds/i);
  });
});
