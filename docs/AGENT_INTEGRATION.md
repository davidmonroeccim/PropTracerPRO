# AI Agent Integration Guide — AI Research with Async Business Trace Recovery

This guide explains how an AI agent (Cowork, n8n, custom LangChain agent, etc.) should call the PropTracerPRO AI research API when processing properties owned by businesses, LLCs, or trusts — and how to retrieve the delayed FastAppend contact results that arrive after the initial response.

## TL;DR

1. Submit property to `POST /api/v1/research/single`.
2. If the response has `business_trace_pending: true`, the contacts for the business owner are still being looked up — **you must fetch them separately**.
3. Either listen for a `business_trace.completed` webhook, or poll `GET /api/v1/research/status?job_id=<id>` every 30–60 seconds until `status !== "pending"`.
4. Delayed results typically arrive within 1–60 minutes. Jobs older than 24 hours are marked as errored.

## Why the two-phase flow exists

Properties owned by businesses (LLCs, trusts, storage companies, holding companies, etc.) don't have the owner's personal contact info in public records. PropTracerPRO runs a FastAppend business-trace lookup in the background to find the human decision-maker behind the entity. FastAppend is asynchronous — it sometimes completes in seconds, sometimes takes minutes or hours.

The research endpoint polls FastAppend inline for up to 45 seconds (the fast path). If FastAppend hasn't finished in that window, the endpoint returns the AI research immediately with a pending-job handle, and a background cron sweeper finalizes the business trace later.

Without this flow, your agent would either:
- Wait indefinitely for FastAppend (HTTP requests can't block for hours), or
- Miss the contacts entirely (the current behavior before this change).

## The two endpoints you need

### 1. Submit research — `POST /api/v1/research/single`

```bash
curl -X POST https://proptracerpro.vercel.app/api/v1/research/single \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "160 Mine Lake Ct Ste 200",
    "city": "Raleigh",
    "state": "NC",
    "zip": "27615"
  }'
```

**Response when FastAppend finished inline (fast path — no action needed):**

```json
{
  "success": true,
  "isCached": false,
  "research": {
    "owner_name": "Joseph Margolis",
    "owner_type": "individual",
    "individual_behind_business": "Joseph Margolis",
    "business_name": "Extra Space Storage",
    "decision_makers": ["Joseph Margolis"],
    "confidence": 85
  },
  "charge": 0.15,
  "business_trace_pending": false,
  "business_trace_job_id": null
}
```

**Response when FastAppend is still working (slow path — action required):**

```json
{
  "success": true,
  "isCached": false,
  "research": {
    "owner_name": "Extra Space Storage",
    "owner_type": "business",
    "business_name": "Extra Space Storage",
    "individual_behind_business": null,
    "business_trace_status": "Pending async recovery (queue 48291)",
    "confidence": 45
  },
  "charge": 0,
  "business_trace_pending": true,
  "business_trace_job_id": "3f9c7e12-8a4d-4b9a-9c3f-2d1e4f5a9af2"
}
```

**Agent logic:**

```python
response = requests.post(
    "https://proptracerpro.vercel.app/api/v1/research/single",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={"address": addr, "city": city, "state": state, "zip": zip}
).json()

contacts = None
if response.get("business_trace_pending"):
    # Slow path — delayed results, fetch separately
    job_id = response["business_trace_job_id"]
    contacts = wait_for_business_trace(job_id)  # see step 2
else:
    # Fast path — research already contains everything
    contacts = response["research"]
```

### 2. Retrieve delayed results — `GET /api/v1/research/status?job_id=<id>`

Poll this endpoint until `status !== "pending"`. Polling is free.

```bash
curl "https://proptracerpro.vercel.app/api/v1/research/status?job_id=3f9c7e12-8a4d-4b9a-9c3f-2d1e4f5a9af2" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response while still processing:**

```json
{
  "success": true,
  "job_id": "3f9c7e12-8a4d-4b9a-9c3f-2d1e4f5a9af2",
  "status": "pending",
  "business_name": "Extra Space Storage",
  "contacts": null,
  "research": null
}
```

**Response when completed:**

```json
{
  "success": true,
  "job_id": "3f9c7e12-8a4d-4b9a-9c3f-2d1e4f5a9af2",
  "status": "completed",
  "business_name": "Extra Space Storage",
  "address": "160 MINE LAKE CT STE 200",
  "city": "RALEIGH",
  "state": "NC",
  "zip": "27615",
  "contacts": {
    "owner_name": "Joseph Margolis",
    "phones": [
      { "number": "9196249818", "type": "mobile" },
      { "number": "9198448365", "type": "landline" }
    ],
    "emails": ["rozar1@gateway.net", "krozar@nc.rr.com"],
    "address": "2605 Scribe Ct, Raleigh, NC"
  },
  "research": {
    "owner_name": "Joseph Margolis",
    "business_name": "Extra Space Storage",
    "decision_makers": ["Joseph Margolis"],
    "business_trace_status": "Recovered async: Joseph Margolis (2 phones, 2 emails)"
  },
  "completed_at": "2026-04-09T18:42:00.000Z"
}
```

**Status values:**

- `pending` — FastAppend is still working. Keep polling.
- `completed` — Contacts were found. `contacts` is populated.
- `no_match` — FastAppend finished but didn't find any contacts for this business.
- `error` — Job failed, errored, or timed out (24h+ since submission).

## Recommended polling strategy

Poll `/api/v1/research/status` every **30–60 seconds**. Most delayed jobs finish within 5 minutes, but some take up to an hour. Give up after 24 hours (PTP marks them as errored internally).

```python
import time

def wait_for_business_trace(job_id: str, max_wait_minutes: int = 60) -> dict | None:
    start = time.time()
    poll_interval = 30  # seconds
    while time.time() - start < max_wait_minutes * 60:
        r = requests.get(
            f"https://proptracerpro.vercel.app/api/v1/research/status?job_id={job_id}",
            headers={"Authorization": f"Bearer {API_KEY}"}
        ).json()
        if r["status"] == "pending":
            time.sleep(poll_interval)
            continue
        if r["status"] == "completed":
            return r["contacts"]
        if r["status"] in ("no_match", "error"):
            return None
    return None  # timed out waiting
```

## Alternative — use webhooks instead of polling

If your agent has a webhook endpoint, configure it in **Settings → Integrations → Webhook URL** and you'll automatically receive a `business_trace.completed` event when each delayed job finishes. This is more efficient than polling when processing many properties.

**Webhook payload:**

```json
{
  "event": "business_trace.completed",
  "business_trace_job_id": "3f9c7e12-8a4d-4b9a-9c3f-2d1e4f5a9af2",
  "status": "completed",
  "business_name": "Extra Space Storage",
  "address": "160 MINE LAKE CT STE 200",
  "city": "RALEIGH",
  "state": "NC",
  "zip": "27615",
  "contacts": {
    "owner_name": "Joseph Margolis",
    "phones": [...],
    "emails": [...],
    "address": "2605 Scribe Ct, Raleigh, NC"
  },
  "research": { /* merged AI research */ },
  "timestamp": "2026-04-09T18:42:00.000Z"
}
```

Correlate the webhook to the original submission via `business_trace_job_id` (the same id returned in the initial `/research/single` response). Your agent can store the mapping locally when the pending response arrives.

### Webhook + polling hybrid

Many agents use both:
1. Primary: wait for the webhook (efficient, real-time).
2. Fallback: if no webhook arrives within N minutes, poll the status endpoint to make sure you didn't miss it.

## Bulk processing

When researching many properties (e.g., "find all self storage owners in Mecklenburg County NC"):

1. Submit each property to `/research/single` in parallel (respect rate limits).
2. Collect all `business_trace_job_id` values from responses where `business_trace_pending: true`.
3. Either receive webhooks for each, or poll a batch of job ids concurrently.
4. Merge the delayed contacts back onto the corresponding property records in your downstream system.

## Common mistakes to avoid

- **Ignoring `business_trace_pending`.** If you only read `research.owner_name` and stop there, you'll miss the contacts for every business-owned property.
- **Polling too fast.** Polls under 10 seconds apart add load without speeding up results — FastAppend processes in its own queue and won't finish faster because you ask more often.
- **Treating `status: "no_match"` as an error.** It just means FastAppend didn't find contacts for that specific business. The AI research is still valid.
- **Forgetting cached responses.** When `isCached: true`, there's no pending job — the cached payload is the complete result from a prior lookup within the last 90 days.

## Where to find old results that arrived via email

FastAppend sends completion emails directly to your PropTracerPRO account email when each business trace finishes. Those emails are the legacy notification path — with this async recovery flow, the same data now also flows back into the PTP API and webhook, so your agent gets it programmatically without any email parsing.

Historical results that arrived via email **before** this feature shipped are not backfilled automatically. Re-submit those properties via `/research/single` with `skipCache: true` to re-run them and capture the contacts through the new flow.
