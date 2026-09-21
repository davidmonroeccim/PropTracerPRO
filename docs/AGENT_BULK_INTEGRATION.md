# AI Agent Integration Guide: Bulk Import

This guide explains how an AI agent should call the PropTracerPRO bulk trace API when it has a
list of properties to enrich: how the server splits the batch, what each kind of row costs, and
how the resolved contacts come back.

If you have already integrated the single-trace flow in `AGENT_INTEGRATION.md`, the per-record
output here is close to the same shape, wrapped in a batch envelope with async completion.

One thing to settle before you build anything. Bulk needs the owner of record. A row that arrives
without one is accepted and skipped, not traced, and you are told why. Read the three buckets
below.

## TL;DR

1. Submit up to 10,000 properties in one call to `POST /api/v1/trace/bulk`.
2. The response returns a `jobId` right away, plus counts telling you how each row was routed.
3. You have to wait. Bulk jobs finalize asynchronously. Either listen for a `bulk_job.completed`
   webhook, or poll `GET /api/v1/trace/bulk/status?job_id=<id>` every 30 to 60 seconds until
   `status` is no longer `processing`.
4. Every row comes back with `owner_contact_name`, the human resolved behind whatever you sent,
   plus phones and emails when they were found.
5. A row you sent with no owner name comes back with a `skip_reason` and a charge of zero.

## How the server splits your batch

Every record you submit lands in one of three buckets, decided server-side from `owner_name`.

Person rows. `owner_name` is set and looks like a human, such as "John Smith" or "Mary Rodriguez
Jr". These go straight into the Tracerfy person skip trace as one batch. Fast path: they are all
submitted in the same request that created the job.

Entity rows. `owner_name` is set and looks like a company, an LLC or a trust, such as "Extra
Space Storage LLC" or "Shell Pointe Trust". These are queued for a background business trace,
which looks up the human decision maker behind the entity and then, if it gets a name and no
contacts with it, runs a person trace on that name. Slower path: the worker takes 5 rows a
minute, so a batch with 300 company rows in it is about an hour of queue before the last one is
even attempted.

Blank-owner rows. No `owner_name` at all. These have no route. The file is still accepted and the
row is still returned to you, but it is skipped rather than traced, it carries a plain-language
reason, and nothing is charged for it. It is never reported as a bare `no_match`, because a
`no_match` would tell you we looked and found nobody when we never looked at all. Send the row
again with the owner of record and it will run.

You do not have to classify rows yourself. Submit them together and the server does the split.

## Cost model

| | Pro and AcquisitionPRO | Pay-as-you-go |
|---|---|---|
| Per successful trace | $0.15 | $0.25 |

Bulk charges per successful trace. A row that comes back with no phone and no email is free. A
skipped blank-owner row is free. That is the whole cost model for this endpoint: one rate, one
condition.

Entity rows are charged exactly the same way as person rows. Resolving the human behind an LLC
does not cost extra. Owner type decides which vendor runs the lookup, never the price.

`estimatedCost` on the submit response is the worst case: every traceable row matching, at your
plan's per-successful-trace rate. Skipped rows are left out of it because they can never be
charged. Your actual bill after completion is normally lower. Your wallet has to cover that worst
case at submit time or the job is refused with a 402.

## 1. Submit a bulk job: `POST /api/v1/trace/bulk`

```bash
curl -X POST https://proptracerpro.vercel.app/api/v1/trace/bulk \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
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

Record fields:

| Field | Required | Notes |
|---|---|---|
| `address` | yes | Street address only, no city, state or zip |
| `city` | yes | |
| `state` | yes | Two-letter abbreviation |
| `zip` | no | 5 or 9 digits when supplied. Optional since 2026-09-04: it is not sent to the trace vendors and is not part of the dedup key. A malformed zip is still rejected, an absent one is fine |
| `owner_name` | no in the schema, but send it | The owner of record, person or entity. A row without one is skipped, not traced |
| `mailing_address` | no | Override if different from the property address |

Body fields:

| Field | Required | Notes |
|---|---|---|
| `records` | yes | Array, maximum 10,000 records per call |
| `webhookUrl` | no | Per-job override for your configured webhook URL |

Response:

```json
{
  "success": true,
  "jobId": "7b3e9a4c-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
  "totalRecords": 3,
  "duplicatesRemoved": 0,
  "recordsToProcess": 3,
  "recordsDirectTrace": 1,
  "recordsPendingResearch": 1,
  "recordsSkipped": 1,
  "skippedReason": "No owner name came in for this address, so there was nothing to trace and you were not charged. Send it again with the owner of record and we will run it.",
  "estimatedCost": 0.30,
  "status": "processing",
  "message": "Poll /api/v1/trace/bulk/status?job_id=7b3e9a4c-... for results. 1 entity-owned records are queued for a business trace. 1 records arrived with no owner name and were skipped. No owner name came in for this address, so there was nothing to trace and you were not charged. Send it again with the owner of record and we will run it."
}
```

What the counts mean:

- `jobId`, the handle you poll or correlate webhooks against.
- `recordsDirectTrace`, person rows submitted straight to the person skip trace.
- `recordsPendingResearch`, entity rows queued for the background business trace. The field keeps
  its old name so existing integrations do not break. It counts entity rows.
- `recordsSkipped`, rows accepted with no owner name and not traced. Zero on a clean batch.
- `skippedReason`, the sentence explaining those rows. Only present when `recordsSkipped` is
  above zero.
- `duplicatesRemoved`, rows dropped because you traced them in the last 90 days or they appeared
  more than once in your batch.
- `status`, always `processing`, even when nothing is queued. Bulk jobs never finalize
  synchronously. The submit response is an acknowledgment, not a result.

If every record was a duplicate there is no job at all, and the response comes back with
`jobId: null`, `status: "completed"` and nothing to poll.

```python
response = requests.post(
    "https://proptracerpro.vercel.app/api/v1/trace/bulk",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={"records": records},
).json()

job_id = response["jobId"]
if job_id is None:
    # Every record was a duplicate inside the 90-day window. No job to poll.
    return []

if response.get("recordsSkipped"):
    # Rows with no owner name. Nothing was charged for them. Fix them at your end
    # and resubmit with the owner of record.
    log.warning("%s rows skipped: %s", response["recordsSkipped"], response["skippedReason"])

save_bulk_job(job_id, record_count=len(records))
results = wait_for_bulk_completion(job_id)
```

## 2. Retrieve results: `GET /api/v1/trace/bulk/status?job_id=<id>`

Poll until `status` is no longer `processing`. Polling is free.

```bash
curl "https://proptracerpro.vercel.app/api/v1/trace/bulk/status?job_id=7b3e9a4c-1d2f-4a5b-8c9d-0e1f2a3b4c5d" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Still working:

```json
{
  "success": true,
  "status": "processing",
  "job_id": "7b3e9a4c-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
  "records_submitted": 3,
  "records_pending_research": 1,
  "records_pending_trace": 1,
  "tracerfy_state": "pending",
  "age_minutes": 4
}
```

`records_pending_research` counts entity rows whose business trace has not settled. Same naming
note as above: the field kept its name, it counts entity rows. `records_pending_trace` counts
rows the trace vendor has not returned yet. The job stays `processing` while either is non-zero.
Skipped rows never hold a job open, because they are already finished when they are created.

Finished:

```json
{
  "success": true,
  "status": "completed",
  "job_id": "7b3e9a4c-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
  "records_submitted": 3,
  "records_matched": 2,
  "total_charge": 0.30,
  "error_message": null,
  "results": [
    {
      "address": "123 MAIN ST|RALEIGH|NC",
      "city": "RALEIGH",
      "state": "NC",
      "zip": "27601",
      "status": "success",
      "input_owner_name": "John Smith",
      "owner_contact_name": "John Smith",
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
      "skip_reason": null,
      "charge": 0.15,
      "ai_research_charge": 0,
      "business_trace_pending": false,
      "business_trace_job_id": null
    },
    {
      "address": "500 COMMERCE BLVD|CHARLOTTE|NC",
      "city": "CHARLOTTE",
      "state": "NC",
      "zip": "28202",
      "status": "success",
      "input_owner_name": "Acme Holdings LLC",
      "owner_contact_name": "Jane Rodriguez",
      "result": {
        "owner_name": "Jane Rodriguez",
        "phones": [{ "number": "7045551122", "type": "mobile" }],
        "emails": ["jane@acmeholdings.com"],
        "address": "789 Oak St, Charlotte, NC"
      },
      "research": {
        "owner_name": "Acme Holdings LLC",
        "owner_type": "business",
        "business_name": "Acme Holdings LLC",
        "individual_behind_business": "Jane Rodriguez",
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
      "skip_reason": null,
      "charge": 0.15,
      "ai_research_charge": 0,
      "business_trace_pending": false,
      "business_trace_job_id": null
    },
    {
      "address": "160 MINE LAKE CT|RALEIGH|NC",
      "city": "RALEIGH",
      "state": "NC",
      "zip": "27615",
      "status": "no_match",
      "input_owner_name": null,
      "owner_contact_name": null,
      "result": null,
      "research": null,
      "contacts": null,
      "skip_reason": "No owner name came in for this address, so there was nothing to trace and you were not charged. Send it again with the owner of record and we will run it.",
      "charge": 0,
      "ai_research_charge": 0,
      "business_trace_pending": false,
      "business_trace_job_id": null
    }
  ]
}
```

Per-record fields:

| Field | Meaning |
|---|---|
| `address` | Pipe-delimited normalized address key, `STREET\|CITY\|STATE`. The zip is not part of it |
| `city`, `state`, `zip` | Parsed components |
| `status` | `success`, `no_match` or `error` |
| `input_owner_name` | What you sent in, if anything. The company or the person you asked about |
| `owner_contact_name` | The human resolved behind it. This is the point of the trace. `null` when no human was resolved, never the company name |
| `result` | The skip-trace output with phones and emails, or `null` |
| `research` | The stored record for the row, when it has one. `null` otherwise. Do not depend on it |
| `contacts` | Top-level alias for `research.business_trace_contacts` |
| `skip_reason` | Why this row came back empty without being traced. `null` on every row a vendor was actually asked about |
| `charge` | What was actually billed for this row. `0` on a miss and `0` on a skip |
| `ai_research_charge` | Legacy field, always `0`. It is kept so existing parsers do not break. There is no separate research fee |
| `business_trace_pending` | `true` while a deferred business trace job is still open for this row |
| `business_trace_job_id` | The id to poll for that deferred job |

### Read `skip_reason` before you read `status`

A skipped row settles to `status: "no_match"` so the job can finish, but that is not what
happened to it. `skip_reason` is the field that tells you the truth, and it is the one to check
first on any row that came back empty. If it is set, no vendor was ever asked and nothing was
charged. Report the reason rather than calling it a no match.

There are two reasons you can see there, and they are different things to you. A blank owner name
is something you can fix by resending the row with the owner of record. An exhausted business
trace is our side failing to reach the vendor. Both are free.

### Where to find the contacts on an entity row

1. `owner_contact_name` with `phones` and `emails` on `result`. That is the normal case.
2. If `business_trace_pending` is `false` and `contacts` is `null`, the business lookup finished
   and found nothing for that entity.
3. If `business_trace_pending` is `true`, store `business_trace_job_id` and poll
   `GET /api/v1/research/status?job_id=<id>` for it, or wait for a `business_trace.completed`
   webhook. See `AGENT_INTEGRATION.md`.

### Status values

- `processing`, still running. Keep polling.
- `completed`, every record has finalized and `results` is the full per-record array.
- `failed`, the batch submission itself failed for every record. Partial failures show up as
  per-record `status: "error"` inside `results` instead.

## Recommended polling strategy

Poll every 30 to 60 seconds. A batch that is mostly person rows settles as fast as the trace
vendor returns. A company-heavy batch takes longer, because those rows run on a background worker
that takes 5 rows a minute rather than inside your request.

```python
import time

def wait_for_bulk_completion(job_id: str, max_wait_minutes: int = 60):
    start = time.time()
    poll_interval = 30  # seconds
    while time.time() - start < max_wait_minutes * 60:
        r = requests.get(
            f"https://proptracerpro.vercel.app/api/v1/trace/bulk/status?job_id={job_id}",
            headers={"Authorization": f"Bearer {API_KEY}"},
        ).json()

        if r["status"] == "processing":
            print(f"  waiting: {r.get('records_pending_research', 0)} entity rows, "
                  f"{r.get('records_pending_trace', 0)} in trace")
            time.sleep(poll_interval)
            continue

        if r["status"] == "completed":
            return r["results"]

        if r["status"] == "failed":
            raise RuntimeError(f"Bulk job failed: {r.get('error_message')}")

    raise TimeoutError(f"Bulk job {job_id} did not finish within {max_wait_minutes} min")
```

If a background worker is killed mid-run by a timeout or a deploy restart, its row is reverted to
queued within five minutes and retried on the next tick, so the job finalizes on a later poll.
You do not need your own "assume failure after N minutes" fallback.

## Webhook-driven processing instead of polling

Configure a webhook URL in Settings, then Integrations, or pass `webhookUrl` per job on the
submit. You get a `bulk_job.completed` event when the job finishes.

```json
{
  "event": "bulk_job.completed",
  "job_id": "7b3e9a4c-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
  "records_submitted": 3,
  "records_matched": 2,
  "total_charge": 0.30,
  "results": [ "the same per-record array as the status endpoint response" ],
  "timestamp": "2026-09-17T18:42:00.000Z"
}
```

A record whose deferred business trace was still open when the job finished carries
`business_trace_pending: true`. Those settle separately and fire their own
`business_trace.completed` event, documented in `AGENT_INTEGRATION.md`. Store the mapping of
`(job_id, address, business_trace_job_id)` when the bulk webhook arrives so you can attach late
contacts to the right record.

Many agents use both channels: wait for the webhook, and poll the status endpoint as a fallback
if nothing arrives within a few minutes. Delivery is fire and forget, so a failed POST is not
retried.

## Deduplication

PropTracerPRO deduplicates every bulk submission against your own 90-day trace history. Records
matching a prior successful trace are filtered out of the new job and counted in
`duplicatesRemoved` on the submit response. Matching is on a normalized address key of street,
city and state, with unit and suite numbers stripped, so "123 Main St Apt 4" and "123 Main
Street" dedupe together.

The bulk endpoint does not expose a `skipCache` parameter. To re-trace a property after a known
ownership change, send it through `POST /api/v1/trace/single` instead.

## Downloaded CSV

When you export a job's results from the web app, a `skip_reason` column is added to the CSV
whenever at least one row in that job has one. A job with nothing skipped exports the base
columns unchanged, so the column never shows up empty.

## Common mistakes to avoid

- Submitting rows with no owner name and expecting them traced. They are accepted, skipped and
  returned with a reason, and nothing is charged. Bulk needs the owner of record.
- Reading `status: "no_match"` without checking `skip_reason`. Those are two different outcomes
  and only one of them means we looked.
- Treating the submit response as final. Bulk jobs never finalize synchronously.
- Mapping a column called "owner name" and stopping there. `input_owner_name` is the company you
  asked about. `owner_contact_name` is the person we found. Mapping the first and discarding the
  second is how a run of resolved people ends up as a sheet of LLC names.
- Looking for `phones` and `emails` at the top level of `research`. They live under
  `research.business_trace_contacts`, or at the top-level `contacts` alias.
- Pre-classifying records client-side. The server's split is tighter than string matching. Submit
  everything and let it happen server-side.
- Resubmitting records that are still processing. Wait for the first job to finish.
- Polling faster than every 10 seconds. It adds load and nothing finishes sooner.

## Quick reference

| Action | Request |
|---|---|
| Submit a bulk job | `POST /api/v1/trace/bulk` |
| Poll bulk status | `GET /api/v1/trace/bulk/status?job_id=<id>` |
| Single trace | `POST /api/v1/trace/single`, see `AGENT_INTEGRATION.md` |
| Poll a single trace | `GET /api/v1/trace/status?trace_id=<id>` |
| Poll a deferred business trace | `GET /api/v1/research/status?job_id=<business_trace_job_id>` |

All endpoints authenticate with `Authorization: Bearer YOUR_API_KEY`.
