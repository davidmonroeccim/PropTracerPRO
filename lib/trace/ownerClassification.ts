/**
 * Does this owner name look like a business entity rather than a person?
 *
 * RELOCATED 2026-09-17, VERBATIM, from lib/ai-research/client.ts, which was
 * deleted with the AI Search engine (Brave + Claude). The function itself has
 * nothing to do with search: it is a pure string test that two surviving
 * callers depend on to pick a ROUTE.
 *
 *   app/api/v1/trace/bulk/route.ts  person rows -> Tracerfy bulk CSV,
 *                                   entity rows -> FastAppend business trace
 *   lib/suite/mcp-tools.ts          the same split behind isEntityRecord()
 *
 * The word list and the substring test are unchanged from the original. Any
 * edit here re-routes live traffic and re-prices the MCP wallet gate, so treat
 * a change to it as a billing change, not a cleanup.
 *
 * THERE IS A SECOND CLASSIFIER. `classifyOwnerName()` in
 * lib/routing/ownerRoute.ts answers a related but different question for the
 * tier 2 router: it returns 'individual' | 'entity' | 'unknown' and can say it
 * does not know, which this one cannot. Merging the two is deliberately NOT
 * this phase's work: they have different return types, different callers and
 * different failure modes, and a merge would move money on the bulk path while
 * the tier 2 path is still being built. Leave both until someone can change
 * them together with tests on both sides.
 */
export function isLikelyBusiness(name: string): boolean {
  const businessIndicators = ['llc', 'inc', 'corp', 'trust', 'ltd', 'lp', 'company', 'group', 'holdings', 'properties', 'investments', 'management', 'enterprises', 'associates', 'partners', 'foundation', 'capital', 'realty', 'development', 'construction', 'apartments', 'real estate', 'cre', 'rentals', 'housing', 'ventures', 'equity', 'asset', 'land', 'homes', 'estate', 'residences', 'suites', 'plaza', 'commercial', 'retail', 'industrial', 'office', 'hotel', 'hospitality', 'storage', 'units'];
  return businessIndicators.some((ind) => name.toLowerCase().includes(ind));
}
