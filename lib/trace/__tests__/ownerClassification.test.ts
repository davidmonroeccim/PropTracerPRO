import { describe, expect, it } from "vitest";
import { isLikelyBusiness } from "@/lib/trace/ownerClassification";
import { classifyOwnerName } from "@/lib/routing/ownerRoute";

/**
 * Relocation fence, 2026-09-17.
 *
 * isLikelyBusiness() moved verbatim out of lib/ai-research/client.ts when the AI
 * Search engine was deleted. It is a ROUTING decision, not a search one: two
 * live surfaces use it to pick which vendor a bulk record goes to, and one of
 * them (lib/suite/mcp-tools.ts) also prices the wallet gate from it. A change to
 * the word list silently re-routes and re-prices traffic, so these pin the
 * behaviour that crossed over rather than trusting a diff.
 */
describe("isLikelyBusiness", () => {
  it("calls the obvious entity suffixes businesses", () => {
    for (const name of [
      "Acme Holdings LLC",
      "Smith Family Trust",
      "Riverside Properties Inc",
      "Oak Street Capital LP",
      "Bayou Rentals",
    ]) {
      expect(isLikelyBusiness(name)).toBe(true);
    }
  });

  it("leaves a plain person alone", () => {
    for (const name of ["John Smith", "Maria Delgado", "Wei Chen"]) {
      expect(isLikelyBusiness(name)).toBe(false);
    }
  });

  it("is case-insensitive and matches inside the name", () => {
    expect(isLikelyBusiness("ACME HOLDINGS llc")).toBe(true);
    expect(isLikelyBusiness("Northgate Plaza Partners")).toBe(true);
  });

  it("is a substring test, and that is deliberate", () => {
    // "Cleveland" contains "land" and "Lander" contains "land". The original
    // shipped this way and the routing it feeds tolerates a false entity (the
    // record simply goes to FastAppend first). Pinned so a future "tighten the
    // matcher" change is a conscious re-route, not an accident.
    expect(isLikelyBusiness("Cleveland")).toBe(true);
  });

  it("says nothing about an empty string, which callers handle themselves", () => {
    // Both callers trim and test for emptiness BEFORE asking this. It must not
    // be the thing that decides a blank owner is a business.
    expect(isLikelyBusiness("")).toBe(false);
  });
});

describe("the second classifier is still a separate thing", () => {
  it("classifyOwnerName can say it does not know, and isLikelyBusiness cannot", () => {
    // Merging the two is deliberately not this phase's work. This test is the
    // reminder of why: they answer different questions with different vocabularies,
    // and only one of them has an 'unknown'.
    expect(classifyOwnerName("")).toBe("unknown");
    expect(typeof isLikelyBusiness("")).toBe("boolean");
  });
});
