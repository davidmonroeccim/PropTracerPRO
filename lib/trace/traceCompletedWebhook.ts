/**
 * The `trace.completed` webhook for a trace that completes INLINE: every Tier 2 trace, and since
 * Tier 1 Phase 1 every single Tier 1 trace.
 *
 * WHY THIS EXISTS. Both tiers now finish INSIDE the submit request and neither reaches a
 * poll route, so every single trace fires `trace.completed` from HERE. The two poll
 * routes (app/api/trace/status, app/api/v1/trace/status) still fire their own copy, but
 * only for rows that were already in flight when Tier 1 Phase 1 shipped; no new trace
 * arrives there. Without this function a customer with a webhook configured would
 * silently stop receiving events. Silently is the problem: a webhook that stops firing
 * looks exactly like a customer with no traces.
 *
 * THE PAYLOAD is the poll route's, key for key, plus three the poll route never sent:
 * `property_record`, `tier`, `owner_type`. All three are present on every trace, so the
 * shape a consumer parses does not change with the tier: `property_record` is null on a
 * Tier 1 trace, and `tier` and `owner_type` are real on both. A webhook is a JSON POST to
 * the customer's own URL, so extra keys need no pre-declaration anywhere -- that
 * constraint belongs to the HighLevel CRM push (phase 4b), not here.
 *
 * `property_record` CARRIES 65 OF THE VENDOR'S 86 KEYS. The 21 blocked ones are
 * withheld from every egress, this one most of all: it lands in the customer's own
 * system by definition. Storage is untouched and stays at 86. The single list and the
 * filter live in lib/trace/publicPropertyRecord.ts.
 *
 * WHEN IT FIRES, and this is a billing rule wearing a webhook's clothes:
 *
 *   EVERY completed tier 2, INCLUDING A BILLED MISS. Tier 2 bills per record
 *   SUBMITTED, so "the county has no parcel at this address" is a paid-for answer
 *   and is precisely the case a customer most needs told about. It matches the poll
 *   route's existing rule, which sends for all completed traces and not only
 *   successful ones.
 *
 *   NEVER on a vendor failure. A vendor failure charges nothing, persists nothing
 *   billable and returns 502, so there is no completion to report. The poll route's
 *   stall-error branch fires nothing either. The call sites enforce this structurally:
 *   the failure branch returns before reaching this function.
 *
 * FIRE AND FORGET. A webhook failure must never fail the request or the charge: the
 * money has already moved and the record is already persisted by the time this runs.
 * Nothing awaits it and every rejection is swallowed into console.error.
 */
import type { TraceResult } from '@/types';
import { toPublicPropertyRecord } from './publicPropertyRecord';

export interface TraceCompletedWebhookInput {
  /** `user_profiles.webhook_url`. Absent or empty means the customer configured none. */
  webhookUrl?: string | null;
  traceId: string;
  /** 'success' when contacts were delivered, 'no_match' otherwise. A no_match may be billed. */
  status: 'success' | 'no_match';
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  result: TraceResult | null;
  /** What the wallet ACTUALLY collected, never what was attempted. */
  charge: number;
  /**
   * The vendor's RAW property object, by reference. Null on a billed miss.
   *
   * Raw is what this function wants: it applies toPublicPropertyRecord() itself,
   * so a caller never has to remember to, and cannot forget.
   */
  propertyRecord: unknown;
  ownerType?: string | null;
  /** 1 for a supplied-owner trace, 2 for a Full Property Trace. */
  tier: 1 | 2;
  /** Tier 1 only (spec 7.1). Null on a Full Property Trace. */
  foundBy?: string | null;
  outcomeCode?: string | null;
  skipReason?: string | null;
}

/**
 * POST `trace.completed` to the customer's webhook, if they have one.
 *
 * Returns immediately. The only reason it returns the promise at all is so a test can
 * await the dispatch; no caller may await it in production, and none does.
 */
export function dispatchTraceCompleted(input: TraceCompletedWebhookInput): void {
  const url = input.webhookUrl?.trim();
  if (!url) return;

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'trace.completed',
      trace_id: input.traceId,
      status: input.status,
      address: input.address ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      zip: input.zip ?? null,
      result: input.result,
      // Shape parity with the two poll routes, which send `research` on every
      // trace.completed. The AI Search engine was removed on 2026-09-17 and tier 2
      // never had one, so the honest value is null -- not an omission, which would
      // make the key disappear from the JSON and change the shape a consumer parses.
      research: null,
      charge: input.charge,
      // The three keys the poll route never sent. Present on every trace, whatever its tier.
      //
      // FILTERED HERE, AT THE ONE DOOR. This payload lands in the customer's own
      // system by definition, which is the case the whole rule was written for: a
      // wrong `estimated_value` sitting in their CRM looks authoritative and
      // outlives any caveat we could put on a screen. Both call sites hand this
      // function the RAW record, on purpose -- the same variable they persist --
      // so there is exactly one place to get this wrong and it is this line.
      // 65 keys of the vendor's 86. See lib/trace/publicPropertyRecord.ts.
      property_record: toPublicPropertyRecord(input.propertyRecord),
      tier: input.tier,
      owner_type: input.ownerType ?? null,
      // Tier 1 (spec 7.2). Always present, null on a Full Property Trace, so the shape a
      // consumer parses does not change with the tier.
      found_by: input.foundBy ?? null,
      outcome_code: input.outcomeCode ?? null,
      skip_reason: input.skipReason ?? null,
      timestamp: new Date().toISOString(),
    }),
  }).catch((err) => console.error('Webhook dispatch error:', err));
}
