/** The Phase 0 spend guard. A call runs only if its WORST-CASE cost still fits under the cap. */
export function affordable(spentDollars: number, nextWorstCase: number, capDollars: number): boolean {
  return spentDollars + nextWorstCase <= capDollars + 1e-9
}
