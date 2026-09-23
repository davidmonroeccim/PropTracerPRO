import { PRICING } from "@/lib/constants";
import { PRICE, type PricePlan } from "@/lib/routing/ownerRoute";
import { effectiveIsPro, type EntitlementProfile } from "./entitlements";

/**
 * THERE IS ONE PRICE DERIVATION IN PTP AND IT IS THE THREE FUNCTIONS BELOW.
 *
 * THE MODEL (lessons.md L-030, David's words, 2026-09-23; binding, not to be re-derived). Two
 * buckets, four numbers, and a Suite Gateway grant is in the FIRST bucket:
 *
 *   | | tier 1, per success | tier 2, per record submitted |
 *   | pro, AcquisitionPRO, gateway grant | $0.15 | $0.25 |
 *   | pay-as-you-go                      | $0.25 | $0.40 |
 *
 * ONE PIECE OF WORK MAY NEVER CARRY TWO PRICES. The two cron sweeps settle rows whose siblings
 * were settled by a status route, so a cron on a different derivation from its route bills one
 * batch at two rates, split by owner type — the exact thing L-005 rules out, since owner type
 * selects the VENDOR and never the price.
 *
 * WHAT WAS HERE BEFORE, AND WHY IT IS GONE. PTP used to have TWO derivations. Track A (the
 * signed-in dashboard, the Suite MCP, the crons) was grant-aware, through the functions below.
 * Track B (the /api/v1/* API-key surface) was RAW, through `rawPricePlanFor` /
 * `rawChargePerRecord` in lib/api/pricing.ts and `getChargePerTrace` in lib/constants.ts, and
 * deliberately ignored the gateway snapshot. The two agreed on every profile shape but one: a
 * wallet-tier caller whose only entitlement is a gateway grant, whom Track A priced 'pro' and
 * Track B priced 'wallet'.
 *
 * That divergence was documented as deliberate and was UNREACHABLE: until 2026-09-23 the v1 gate
 * in lib/api/auth.ts refused that caller before any pricing code ran. Fixing the gate made it
 * reachable, so the same customer would have paid the Pro rate on the dashboard and the
 * Pay-As-You-Go rate on the API for the same work. David's named decision, 2026-09-23: "One
 * price: make the API grant-aware." Both raw helpers were removed rather than re-pointed, so
 * there is no second derivation left for a new call site to reach for by accident.
 *
 * The invariant that made the collapse safe is pinned by lib/api/__tests__/pricing.test.ts: every
 * profile shape except gateway-grant-only returns exactly the number it returned before.
 */

/**
 * What goes in `trace_jobs.source` / `trace_history.source`.
 *
 * IT IS A LABEL, AND ONLY A LABEL. It used to be a PRICE DECISION: the crons read it to choose
 * between the two derivations above, and an untagged row (which is every v1 row) meant "price it
 * raw". With one derivation there is nothing left for it to switch, and `isTrackASource` was
 * deleted along with the branches that called it. Do not reintroduce a price that keys off this
 * tag: the price depends on the CALLER's entitlements, never on which surface submitted the work.
 *
 * It stays because app/api/trace/bulk/route.ts still writes it and it says where a row came from.
 */
export const TRACE_SOURCE = {
  /** Suite MCP submissions (lib/suite/mcp-tools.ts). */
  MCP: "mcp",
  /** The signed-in dashboard (app/api/trace/**). */
  WEB: "web",
} as const;

/**
 * Per-successful-trace charge (tier 1), for EVERY surface: the dashboard, the Suite MCP, the
 * /api/v1/* API-key routes and the crons that settle any of their rows.
 *
 * Grant-aware through effectiveIsPro, which is additive: a grant can only LOWER the rate
 * (CHARGE_PER_SUCCESS_WALLET -> CHARGE_PER_SUCCESS) and can never mint money, because the wallet
 * balance gate still 402s at $0.
 */
export function chargePerTrace(profile: EntitlementProfile): number {
  return effectiveIsPro(profile) ? PRICING.CHARGE_PER_SUCCESS : PRICING.CHARGE_PER_SUCCESS_WALLET;
}

/**
 * Which column of the price table this caller pays.
 *
 * planRoute() takes the plan as a REQUIRED argument precisely so that no route
 * can quietly bill the wrong column (see FAILSAFE_PRICE_PLAN in
 * lib/routing/ownerRoute.ts: a default of 'pro' once billed pay-as-you-go
 * customers 40% under rate, silently, because nobody reports being
 * undercharged). This is the one place a PTP profile is turned into that
 * argument.
 *
 * Derived from exactly the same predicate as chargePerTrace() above --
 * effectiveIsPro(), which is additive and grant-aware -- so the two can never
 * disagree about who is a pro. 'pro' and 'acqPro' price identically; they are
 * kept apart only so the route reports which entitlement paid.
 *
 * PricePlan is CLOSED at 'pro' | 'acqPro' | 'wallet' and gets no grant-specific member. A
 * 'gateway' label would have to come from the snapshot, and lib/api/auth.ts skips the entitlement
 * refresh for a caller who is already entitled locally, so on that surface the snapshot can be
 * unboundedly stale. It cannot affect the RATE (pro and acqPro price identically to a grant), but
 * a label read off it would be an arbitrarily old answer. If one is ever genuinely wanted, the
 * short-circuit in lib/api/auth.ts has to go first.
 *
 * A caller with no entitlement gets 'wallet', which is also the dearest column.
 */
export function pricePlanFor(profile: EntitlementProfile): PricePlan {
  if (profile.is_acquisition_pro_member === true) return "acqPro";
  return effectiveIsPro(profile) ? "pro" : "wallet";
}

/**
 * Tier 2 (Full Property Trace) per RECORD SUBMITTED.
 *
 * Not a per-success rate: it is owed whether or not the county has a parcel at
 * that address. Used for the pre-flight balance gate as well as the charge, so
 * a wallet that cannot cover one record is refused before any vendor is asked.
 */
export function chargePerRecord(profile: EntitlementProfile): number {
  return PRICE[pricePlanFor(profile)].tier2PerRecord;
}
