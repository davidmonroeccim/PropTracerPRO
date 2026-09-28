/**
 * Does this owner name look like a business entity rather than a person?
 *
 * RELOCATED 2026-09-17, VERBATIM, from lib/ai-research/client.ts, which was
 * deleted with the AI Search engine (Brave + Claude). The function itself has
 * nothing to do with search: it is a pure string test. The word list and the
 * substring test are unchanged from the original.
 *
 * IT SELECTS NO ROUTE AND IT MOVES NO MONEY. It used to select a route:
 * app/api/v1/trace/bulk/route.ts sent person rows to the Tracerfy bulk CSV and
 * entity rows to FastAppend on this answer. That call is GONE (see the "THERE
 * IS NO PERSON-VERSUS-ENTITY SPLIT ANY MORE" note in that route) -- planRoute()
 * now decides person, company or trust inside the cron, from the whole row
 * rather than from the name.
 *
 * ONE SURVIVING CALLER: isEntityRecord() in lib/suite/mcp-tools.ts. It feeds
 * three things, and not one of them is a route:
 *
 *   worstCaseCost()   the entity branch and the person branch add the SAME
 *                     tier1Rate, so `.total` is INVARIANT under this
 *                     classification -- and `.total` is the only field
 *                     production reads (the quote's worst_case_cost and the
 *                     submit's wallet reserve). `.persons`, `.entities` and
 *                     `.blanks` are read by tests only.
 *   skip_trace_quote  the reported `persons` / `entities` integers.
 *   skip_trace_bulk   the same two integers on the submit payload.
 *
 * So editing the word list moves two reported integer counts on two MCP
 * payloads and nothing else. It is NOT a billing change and it re-routes no
 * live traffic. Phase 4 deletes this function outright, once the rows already
 * in flight under the old split have drained (that route's note again).
 *
 * THERE IS A SECOND CLASSIFIER. `classifyOwnerName()` in
 * lib/routing/ownerRoute.ts answers a related but different question for the
 * tier 2 router: it returns 'individual' | 'entity' | 'unknown' and can say it
 * does not know, which this one cannot. Merging the two is deliberately NOT
 * this phase's work: they have different return types, different callers and
 * different failure modes, and the money risk in a merge is entirely on the
 * classifyOwnerName side -- it picks the vendor route inside planRoute() and
 * executeRoute(), which is where spend is decided -- while that path is still
 * being built. Leave both until someone can change them together with tests on
 * both sides.
 */
export function isLikelyBusiness(name: string): boolean {
  const businessIndicators = ['llc', 'inc', 'corp', 'trust', 'ltd', 'lp', 'company', 'group', 'holdings', 'properties', 'investments', 'management', 'enterprises', 'associates', 'partners', 'foundation', 'capital', 'realty', 'development', 'construction', 'apartments', 'real estate', 'cre', 'rentals', 'housing', 'ventures', 'equity', 'asset', 'land', 'homes', 'estate', 'residences', 'suites', 'plaza', 'commercial', 'retail', 'industrial', 'office', 'hotel', 'hospitality', 'storage', 'units'];
  return businessIndicators.some((ind) => name.toLowerCase().includes(ind));
}
