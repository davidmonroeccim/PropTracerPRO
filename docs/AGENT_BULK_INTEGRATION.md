# AI Agent Integration Guide — Bulk Import with AI Research + Business Trace Recovery

This guide explains how an AI agent should call the PropTracerPRO bulk trace API
when processing many properties at once — including how the server automatically
detects entity-owned properties (LLCs, trusts, businesses), runs AI research on
them before tracing, and delivers the resolved decision-maker contacts back to
your agent.

If you've already integrated the single-trace flow (`/api/v1/research/single`),
the bulk flow uses the same per-record output shape — just wrapped in a batch
envelope with async completion.

## TL;DR

1. Submit up to 10,000 properties in one call to `POST /api/v1/trace/bulk`.
2. Response returns a `jobId` immediately, plus counts telling you how many
   records went straight to tracing vs. how many are queued for AI research.
3. **You must wait** — bulk jobs finalize asynchronously. Either listen for a
   `bulk_job.completed` webhook, or poll `GET /api/v1/trace/bulk/status?job_id=<id>`
   every 30–60 seconds until `status !== "processing"`.
4. Each per-record result in the response includes both the Tracerfy person-trace
   output (phones/emails) **and** the AI research output (decision-maker
   contacts for LLC-owned properties) — same shape as `/api/v1/research/single`.
5. For records whose FastAppend business trace exceeded the 45 s fast-path
   window, a follow-up `business_trace.completed` webhook fires per record when
   the slow-path resolves (same mechanism as the single-trace flow).

## Why the server-side split exists

Every record you submit is one of two kinds:

- **Person-named record** — `owner_name` is set and looks like a human ("John
  Smith", "Mary Rodriguez Jr"). Goes straight to Tracerfy's person skip trace.
  Fast path — finishes in seconds to a minute.
- **Entity record** — `owner_name` is empty, OR `owner_name` looks like a
  business entity ("Extra Space Storage LLC", "Shell Pointe Trust", "XYZ
  Properties"). These need AI research first: Brave searches → Claude
  extraction → Secretary of State entity chain resolution → FastAppend business
  trace → then a person skip trace on the discovered decision-maker. Slow path
  — typically 30 s to a few minutes per record, sometimes longer if FastAppend
  is backlogged.

**You do not have to classify records yourself.** Submit them all together. The
server runs entity detection, splits the batch internally, fast-paths the person
records, and queues the entity records for background AI research. You get
everything back in the same `bulk_job.completed` webhook.

## The two endpoints you need

### 1. Submit bulk job — `POST /api/v1/trace/bulk`

```bash
curl -X POST https://proptracerpro.vercel.app/api/v1/trace/bulk \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {
        "address": "160 Mine Lake Ct Ste 200",
        "city": "Raleigh",
        "state": "NC",
        "zip": "27615"
      },
      {
        "address": "123 Main St",
        "city": "Raleigh",
        "state": "NC",
        "zip": "27601",
        "owner_name": "John Smith"
      },
      {
        "address": "500 Commerce Blvd",
        "city": "Charlotte",
        "state": "NC",
        "zip": "28202",
        "owner_name": "Acme Holdings LLC"
      }
    ],
    "webhookUrl": "https://your-agent.example.com/hooks/ptp"
  }'
```

**Record fields (per record):**

| Field            | Required | Notes                                                          |
|------------------|----------|----------------------------------------------------------------|
| `address`        | yes      | Street address only (no city/state/zip)                        |
| `city`           | yes      |                                                                |
| `state`          | yes      | Two-letter abbreviation                                        |
| `zip`            | yes      | 5 digits                                                       |
| `owner_name`     | no       | Person or entity name. Leave blank to let AI research discover |
| `mailing_address`| no       | Override if different from property address                    |

**Body fields:**

| Field        | Required | Notes                                                          |
|--------------|----------|----------------------------------------------------------------|
| `records`    | yes      | Array, max 10,000 records per call                             |
| `webhookUrl` | no       | Per-job override for your configured webhook URL               |

**Response:**

```json
{
  "success": true,
  "jobId": "7b3e9a4c-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
  "totalRecords": 3,
  "duplicatesRemoved": 0,
  "recordsToProcess": 3,
  "recordsDirectTrace": 1,
  "recordsPendingResearch": 2,
  "estimatedCost": 1.03,
  "status": "processing",
  "message": "Poll /api/v1/trace/bulk/status?job_id=7b3e9a4c-... for results. 2 entity-owned records queued for AI research."
}
```

**Key fields in the response:**

- `jobId` — the bulk job handle you poll or correlate webhooks against
- `recordsDirectTrace` — how many records are on the fast path (person names
  detected, submitted to Tracerfy immediately)
- `recordsPendingResearch` — how many records are on the slow path (queued for
  AI research before tracing)
- `duplicatesRemoved` — records removed because they were traced within the
  last 90 days or appeared multiple times in your batch
- `estimatedCost` — worst-case total: `$0.07-0.11 per trace × records +
  $0.15 per AI research × entity records`. You're only charged when a record
  resolves successfully — failed traces and failed research are free.
- `status: "processing"` — always returned even if nothing is queued for
  research. Bulk jobs never finalize synchronously; the response is the
  submission acknowledgment.

**Agent logic:**

```python
response = requests.post(
    "https://proptracerpro.vercel.app/api/v1/trace/bulk",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={"records": records}
).json()

job_id = response["jobId"]
if job_id is None:
    # All records were duplicates within the 90-day window. No job to poll.
    return []

# Persist job_id somewhere durable so you can correlate webhook events later.
save_bulk_job(job_id, record_count=len(records))

# Either wait for the webhook or poll. See section 2.
results = wait_for_bulk_completion(job_id)
```

### 2. Retrieve results — `GET /api/v1/trace/bulk/status?job_id=<id>`

Poll this endpoint until `status !== "processing"`. Polling is free.

```bash
curl "https://proptracerpro.vercel.app/api/v1/trace/bulk/status?job_id=7b3e9a4c-1d2f-4a5b-8c9d-0e1f2a3b4c5d" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response while still processing:**

```json
{
  "success": true,
  "status": "processing",
  "job_id": "7b3e9a4c-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
  "records_submitted": 3,
  "records_pending_research": 1,
  "records_pending_trace": 2
}
```

- `records_pending_research` — rows where AI research is still running (or
  queued behind the cron worker)
- `records_pending_trace` — rows where Tracerfy has not yet returned a result

A bulk job is "processing" while **either** of those counters is non-zero.

**Response when completed:**

```json
{
  "success": true,
  "status": "completed",
  "job_id": "7b3e9a4c-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
  "records_submitted": 3,
  "records_matched": 2,
  "total_charge": 0.37,
  "results": [
    {
      "address": "123 MAIN ST|RALEIGH|NC|27601",
      "city": "RALEIGH",
      "state": "NC",
      "zip": "27601",
      "status": "success",
      "input_owner_name": "John Smith",
      "result": {
        "owner_name": "John Smith",
        "phones": [
          { "number": "9195551234", "type": "mobile" },
          { "number": "9195556789", "type": "landline" }
        ],
        "emails": ["john@example.com"],
        "address": "123 Main St, Raleigh, NC"
      },
      "research": null,
      "contacts": null,
      "charge": 0.11,
      "ai_research_charge": 0,
      "business_trace_pending": false,
      "business_trace_job_id": null
    },
    {
      "address": "500 COMMERCE BLVD|CHARLOTTE|NC|28202",
      "city": "CHARLOTTE",
      "state": "NC",
      "zip": "28202",
      "status": "success",
      "input_owner_name": "Acme Holdings LLC",
      "result": {
        "owner_name": "Jane Rodriguez",
        "phones": [
          { "number": "7045551122", "type": "mobile" }
        ],
        "emails": ["jane@acmeholdings.com"],
        "address": "789 Oak St, Charlotte, NC"
      },
      "research": {
        "owner_name": "Jane Rodriguez",
        "owner_type": "individual",
        "business_name": "Acme Holdings LLC",
        "individual_behind_business": "Jane Rodriguez",
        "decision_makers": ["Jane Rodriguez"],
        "confidence": 75,
        "business_trace_status": "Found: Jane Rodriguez (1 phone, 1 email)",
        "business_trace_contacts": {
          "owner_name": "Jane Rodriguez",
          "phones": [{ "number": "7045551122", "type": "mobile" }],
          "emails": ["jane@acmeholdings.com"],
          "address": "789 Oak St, Charlotte, NC"
        }
      },
      "contacts": {
        "owner_name": "Jane Rodriguez",
        "phones": [{ "number": "7045551122", "type": "mobile" }],
        "emails": ["jane@acmeholdings.com"],
        "address": "789 Oak St, Charlotte, NC"
      },
      "charge": 0.11,
      "ai_research_charge": 0.15,
      "business_trace_pending": false,
      "business_trace_job_id": null
    },
    {
      "address": "160 MINE LAKE CT|RALEIGH|NC|27615",
      "city": "RALEIGH",
      "state": "NC",
      "zip": "27615",
      "status": "no_match",
      "input_owner_name": null,
      "result": null,
      "research": {
        "owner_name": "Extra Space Storage",
        "owner_type": "business",
        "business_name": "Extra Space Storage",
        "business_trace_status": "Pending async recovery (queue 48291)",
        "confidence": 45
      },
      "contacts": null,
      "charge": 0,
      "ai_research_charge": 0.15,
      "business_trace_pending": true,
      "business_trace_job_id": "3f9c7e12-8a4d-4b9a-9c3f-2d1e4f5a9af2"
    }
  ]
}
```

**Per-record result fields:**

| Field                    | Meaning                                                                 |
|--------------------------|-------------------------------------------------------------------------|
| `address`                | Pipe-delimited normalized address key (`STREET\|CITY\|STATE\|ZIP`)      |
| `city`, `state`, `zip`   | Parsed components                                                       |
| `status`                 | `success`, `no_match`, or `error`                                       |
| `input_owner_name`       | What you sent in (if anything)                                          |
| `result`                 | Tracerfy person-skip-trace output, or `null` if no person was traced    |
| `research`               | Full AI research object, or `null` for person-only records              |
| `contacts`               | Top-level alias for `research.business_trace_contacts` (FastAppend data)|
| `charge`                 | Trace charge actually billed (`$0.07–0.11`, or `0` on no match)         |
| `ai_research_charge`     | Research charge actually billed (`$0.15` per record with owner found)   |
| `business_trace_pending` | `true` if FastAppend business trace is still async-resolving            |
| `business_trace_job_id`  | Job id to correlate with a later `business_trace.completed` webhook     |

**Where to find the contacts for a business-owned record:**

1. If `business_trace_pending` is `false` and `contacts` is non-null →
   FastAppend resolved inline; use `contacts.phones` and `contacts.emails`.
2. If `business_trace_pending` is `false` and `contacts` is null → FastAppend
   returned no match for that business. The AI research may still have a
   `decision_makers` array worth inspecting.
3. If `business_trace_pending` is `true` → you'll receive a separate
   `business_trace.completed` webhook later. Store `business_trace_job_id` now
   so you can correlate the incoming webhook to this record.

**Status values:**

- `processing` — Bulk job is still running. Keep polling.
- `completed` — All records have finalized. `results[]` is the full per-record
  array.
- `failed` — Only returned in rare cases where the Tracerfy submission itself
  failed for all records in the batch. Partial failures show up as per-record
  `status: "error"` inside the `results[]` array instead.

## Recommended polling strategy

Poll `/api/v1/trace/bulk/status` every **30–60 seconds**. Bulk jobs with
significant AI research load can take 5–30 minutes to finish, depending on the
proportion of entity-owned records and FastAppend queue depth.

```python
import time

def wait_for_bulk_completion(job_id: str, max_wait_minutes: int = 60):
    start = time.time()
    poll_interval = 30  # seconds
    while time.time() - start < max_wait_minutes * 60:
        r = requests.get(
            f"https://proptracerpro.vercel.app/api/v1/trace/bulk/status?job_id={job_id}",
            headers={"Authorization": f"Bearer {API_KEY}"}
        ).json()

        if r["status"] == "processing":
            print(f"  waiting: {r.get('records_pending_research', 0)} in research, "
                  f"{r.get('records_pending_trace', 0)} in trace")
            time.sleep(poll_interval)
            continue

        if r["status"] == "completed":
            return r["results"]

        if r["status"] == "failed":
            raise RuntimeError(f"Bulk job failed: {r.get('error_message')}")

    raise TimeoutError(f"Bulk job {job_id} did not finish within {max_wait_minutes} min")
```

## Alternative — webhook-driven processing

If your agent has a webhook endpoint (configured in **Settings → Integrations →
Webhook URL**, or passed per-job via `webhookUrl` on the submit), you'll
receive a `bulk_job.completed` event when each bulk job finishes, plus
follow-up `business_trace.completed` events for records whose FastAppend took
longer than the 45-second inline window.

**`bulk_job.completed` webhook payload:**

```json
{
  "event": "bulk_job.completed",
  "job_id": "7b3e9a4c-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
  "records_submitted": 3,
  "records_matched": 2,
  "total_charge": 0.37,
  "results": [ /* same per-record array as the status endpoint response */ ],
  "timestamp": "2026-04-11T18:42:00.000Z"
}
```

**`business_trace.completed` webhook payload (fires later, per record):**

```json
{
  "event": "business_trace.completed",
  "business_trace_job_id": "3f9c7e12-8a4d-4b9a-9c3f-2d1e4f5a9af2",
  "status": "completed",
  "business_name": "Extra Space Storage",
  "address": "160 MINE LAKE CT",
  "city": "RALEIGH",
  "state": "NC",
  "zip": "27615",
  "contacts": {
    "owner_name": "Joseph Margolis",
    "phones": [
      { "number": "9196249818", "type": "mobile" },
      { "number": "9198448365", "type": "landline" }
    ],
    "emails": ["jmargolis@extraspace.com"],
    "address": "2605 Scribe Ct, Raleigh, NC"
  },
  "research": { /* merged AI research */ },
  "timestamp": "2026-04-11T19:05:00.000Z"
}
```

Correlate each `business_trace.completed` event back to the originating bulk
record via `business_trace_job_id` — the same id that appeared on the
`bulk_job.completed` payload's per-record entry. Your agent should store the
mapping `(bulk_job_id, address, business_trace_job_id)` when the
`bulk_job.completed` webhook arrives so it can attach the late contacts to the
right record.

### Webhook + polling hybrid

Many agents use both:

1. **Primary:** wait for the `bulk_job.completed` webhook (efficient,
   real-time).
2. **Fallback:** if no webhook arrives within N minutes, poll
   `/api/v1/trace/bulk/status` to make sure you didn't miss it.
3. **Slow-path rollup:** after `bulk_job.completed`, wait up to an hour for
   any lingering `business_trace.completed` events. Any that don't arrive
   within 24 hours are considered not-resolvable (PTP marks them as errored
   internally).

## Deduplication

PropTracerPRO deduplicates every bulk submission against your own 90-day trace
history. Records that match a prior successful trace are silently filtered out
of the new job — you'll see them in `duplicatesRemoved` on the submit response.
Dedupe matching is on a normalized address key (street + city + state + zip,
with unit/suite numbers stripped), so `"123 Main St Apt 4"` and `"123 Main
Street"` dedupe together.

If you want to bypass the dedup window (for example, to re-trace a property
after a known ownership change), submit that record via
`/api/v1/research/single` with `skipCache: true` instead. The bulk endpoint
does not currently expose a `skipCache` parameter.

## Cost model

- **Trace charge:** `$0.07` per successful trace for Pro-tier accounts,
  `$0.11` per successful trace for Pay-As-You-Go. No charge on `no_match` or
  `error`.
- **AI research charge:** `$0.15` per record where research found an owner
  name. No charge when research comes back empty.
- **Both charges are independent** — an entity-owned record can incur up to
  `$0.26` total (research + trace) if it resolves successfully end-to-end.

The `estimatedCost` field in the submit response assumes every record will
match, so your actual bill after completion is typically lower.

## Common mistakes to avoid

- **Treating the initial submit response as final.** Bulk jobs never finalize
  synchronously. Always poll or listen for the webhook. The submit response
  only tells you the job was accepted.
- **Ignoring `business_trace_pending` at the per-record level.** A bulk job can
  be `status: "completed"` while individual entity records are still waiting
  on slow-path FastAppend recovery. Check each record's
  `business_trace_pending` flag and be ready to receive follow-up
  `business_trace.completed` webhooks for up to an hour after the bulk job
  finishes.
- **Looking for `phones[]` / `emails[]` at the top level of `research`.** On
  business-owned records, they live under `research.business_trace_contacts`
  (or, for convenience, at the top-level `contacts` field alongside
  `research`). The core `research` schema only carries ownership and
  confidence, not contact data.
- **Pre-classifying records client-side.** Don't. The server runs a tighter
  entity-detection heuristic than simple string matching, including treating
  empty `owner_name` as implicitly entity-pending. Just submit everything and
  let the split happen server-side.
- **Re-submitting records that are still processing.** They'll be filtered by
  dedup if they succeeded, but if they're actively running in another job,
  you may get stale `no_match` rows back because the cached processing state
  blocks the new submission. Wait for the first job to finish.
- **Polling too fast.** Intervals under 10 seconds add load without speeding
  up results — the Tracerfy batch and the AI research worker run on their
  own cadence and won't finish faster because you ask more often.

## Comparison with `/api/v1/research/single`

| Feature                       | `/api/v1/research/single`            | `/api/v1/trace/bulk`               |
|-------------------------------|--------------------------------------|------------------------------------|
| Records per call              | 1                                    | Up to 10,000                       |
| Returns contacts inline?      | Yes, if FastAppend finishes in 45 s  | No — always async                  |
| Entity detection              | Automatic                            | Automatic                          |
| AI research                   | Automatic (synchronous per call)     | Automatic (background cron)        |
| FastAppend slow-path recovery | Yes                                  | Yes                                |
| Response shape                | `{ research, contacts, ... }`        | `{ jobId, ... }` → poll for results|
| Dedup against 90-day history  | Yes (skippable via `skipCache`)      | Yes (not skippable)                |
| Use when                      | Agent needs a single lookup          | Agent is enriching a list of leads |

## Quick reference

| Action              | Request                                                                 |
|---------------------|-------------------------------------------------------------------------|
| Submit a bulk job   | `POST /api/v1/trace/bulk`                                               |
| Poll status         | `GET /api/v1/trace/bulk/status?job_id=<id>`                             |
| Single trace        | `POST /api/v1/research/single` (see `AGENT_INTEGRATION.md`)             |
| Single trace status | `GET /api/v1/research/status?job_id=<business_trace_job_id>`            |

All endpoints authenticate via `Authorization: Bearer <YOUR_API_KEY>`.
