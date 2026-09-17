# AI Agent Integration Guide: Single Property Trace

This guide explains how an AI agent (Cowork, n8n, a custom LangChain agent, anything that can
make an HTTP request) should call the PropTracerPRO single-trace API, what each kind of request
costs, and how the results come back.

There is one submit endpoint and it behaves two different ways depending on whether you already
know who owns the property. Read the two tiers below before you write any code, because they
charge differently and they return differently.

## TL;DR

1. Submit one property to `POST /api/v1/trace/single`.
2. If you send `ownerName`, you get a tier 1 trace. The response hands you a `traceId` and you
   poll `GET /api/v1/trace/status?trace_id=<id>` until it settles.
3. If you leave `ownerName` out, you get a Full Property Trace instead, automatically. It runs
   start to finish inside that one request and the finished result comes back in the response.
   No polling.
4. Either way, if you have a webhook URL configured, a `trace.completed` event is posted to it
   when the trace finishes.

## The two tiers, and what each one costs

| | Tier 1 | Tier 2, Full Property Trace |
|---|---|---|
| When it runs | You sent `ownerName` | You sent no `ownerName`, or you asked for it with `fullPropertyTrace: true` |
| What you get | Contacts for the owner you named | The county property record, plus contacts for whoever the county says owns it |
| How you are charged | Per successful trace | Per record submitted |
| Pro and AcquisitionPRO | $0.15 | $0.25 |
| Pay-as-you-go | $0.25 | $0.40 |
| How results arrive | A `traceId` to poll | Inline, in the submit response |

Tier 1 bills only when the trace comes back with a phone or an email. A miss costs nothing.

Tier 2 bills per record submitted, and that is the part to read twice before you send a large
run through it. The charge lands whether or not contacts come back. You can send an address, get
no county parcel and no contacts, and still be charged for it. What you are buying is the lookup
against the county record for that address, not a guaranteed result.

Owner type decides which vendor runs the lookup. An entity goes one way and an individual goes
another. It never changes the price. There is no entity rate, no surcharge and no discount.

## 1. Submit a trace: `POST /api/v1/trace/single`

### Request body

| Field | Required | Notes |
|---|---|---|
| `address` | yes | Street address only, no city, state or zip |
| `city` | yes | |
| `state` | yes | Two-letter abbreviation |
| `zip` | no | 5 or 9 digits when you send one. A malformed zip is rejected, an absent one is fine. On a Full Property Trace the county record often fills it in for you |
| `ownerName` | no | The owner of record. Leaving it out is what triggers a Full Property Trace |
| `fullPropertyTrace` | no | Set `true` when you already have the owner but you want the property record too. `full_property_trace` is accepted as well, so the spelling you use on the web app also works here |

### Tier 1: you supplied the owner

```bash
curl -X POST https://proptracerpro.vercel.app/api/v1/trace/single \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "123 Main Street",
    "city": "Austin",
    "state": "TX",
    "zip": "78701",
    "ownerName": "John Smith"
  }'
```

```json
{
  "success": true,
  "status": "processing",
  "traceId": "uuid",
  "tracerfyJobId": "job_abc123",
  "message": "Trace submitted. Poll /api/v1/trace/status?trace_id=uuid for results."
}
```

Nothing is charged at submit. The charge is settled when you poll and the trace turns out to
have found contacts.

### Tier 2: no owner, so the Full Property Trace runs

```bash
curl -X POST https://proptracerpro.vercel.app/api/v1/trace/single \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "123 Main Street",
    "city": "Austin",
    "state": "TX",
    "zip": "78701"
  }'
```

The response is the finished trace. This request takes longer than a tier 1 submit, because the
county lookup and the contact lookup both happen inside it. Give your HTTP client a timeout of
at least 60 seconds.

```json
{
  "success": true,
  "status": "success",
  "traceId": "uuid",
  "tier": 2,
  "charge": 0.25,
  "result": {
    "owner_name": "John Smith",
    "phones": [{ "number": "5125551234", "type": "mobile" }],
    "emails": ["john.smith@email.com"],
    "mailing_address": "456 Oak Ave",
    "mailing_city": "Austin",
    "mailing_state": "TX",
    "mailing_zip": "78702"
  },
  "propertyRecord": {
    "address": "123 MAIN ST",
    "city": "AUSTIN",
    "state": "TX",
    "zip_code": "78701",
    "county": "Travis",
    "apn": "0204070108",
    "property_type": "Commercial",
    "year_built": 1984,
    "building_size_sqft": 41588,
    "assessed_value": 808640,
    "last_sale_date": "2022-05-13"
  },
  "ownerName": "John Smith",
  "ownerType": "individual",
  "needsManualReview": false,
  "warnings": []
}
```

The `propertyRecord` above is abbreviated. The real one carries over 60 fields. Section 3 lists
what is in it.

`status` is `success` when contacts came back and `no_match` when they did not. A `no_match` on
tier 2 is still charged, and it usually still carries a `propertyRecord`, which is the thing you
paid for. `ownerType` is one of `individual`, `entity`, `trust` or `unknown`. `needsManualReview`
is `true` when the route could not confidently pick a lookup for the owner it found, and
`warnings` carries anything else worth reading.

### The field names differ between these two endpoints, on purpose

The tier 2 submit response is camelCase: `traceId`, `propertyRecord`, `ownerName`, `ownerType`,
`needsManualReview`.

`GET /api/v1/trace/status` is snake_case: `trace_id`, `is_cached`.

That is real and it is per endpoint, not a typo in this document. Write your parser against the
endpoint you are actually calling. Code that assumes one convention across the whole API will
read `undefined` on half of it.

### Cached results are free

PropTracerPRO keeps your own traces for 90 days. If you resubmit an address you already traced,
you get the stored result back and nothing is charged.

```json
{
  "success": true,
  "cached": true,
  "charge": 0,
  "traceId": "uuid",
  "result": { "owner_name": "John Smith", "phones": [], "emails": [] },
  "propertyRecord": { },
  "tier": 2
}
```

A Full Property Trace you already paid for is served back to you free even when it found nothing,
because the answer "the county has no parcel at this address" is the answer you bought. Running
it again would charge you a second time for the same absence.

### Error responses

| Status | Meaning |
|---|---|
| 400 | The address did not validate, or there was no usable lookup key for it. Nothing charged |
| 401 | Missing or invalid API key |
| 402 | Your wallet does not cover this request. The balance is checked against the rate this request will actually charge, so a Full Property Trace is checked against the tier 2 rate |
| 502 | A vendor lookup failed on our side. Nothing charged, nothing stored. Retry it |
| 500 | Server error |

A 502 is the case to retry. It means we could not ask, not that we asked and came back empty.
Nothing is charged for it and no webhook fires.

### Agent logic

```python
response = requests.post(
    "https://proptracerpro.vercel.app/api/v1/trace/single",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={"address": addr, "city": city, "state": state, "zip": zip_code},
    timeout=90,
).json()

if response.get("tier") == 2:
    # Full Property Trace. It is already finished.
    contacts = response.get("result")
    property_record = response.get("propertyRecord")
else:
    # Tier 1. Poll for it.
    contacts = wait_for_trace(response["traceId"])
    property_record = None
```

## 2. Poll a tier 1 trace: `GET /api/v1/trace/status?trace_id=<id>`

Polling is free.

```bash
curl "https://proptracerpro.vercel.app/api/v1/trace/status?trace_id=YOUR_TRACE_ID" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Still working:

```json
{
  "success": true,
  "status": "processing",
  "trace_id": "uuid",
  "tracerfy_state": "pending",
  "age_minutes": 2
}
```

Finished:

```json
{
  "success": true,
  "status": "success",
  "trace_id": "uuid",
  "result": {
    "owner_name": "John Smith",
    "phones": [{ "number": "5125551234", "type": "mobile" }],
    "emails": ["john.smith@email.com"],
    "mailing_address": "456 Oak Ave",
    "mailing_city": "Austin",
    "mailing_state": "TX",
    "mailing_zip": "78702",
    "match_confidence": 95
  },
  "research": null,
  "charge": 0.15,
  "is_cached": false
}
```

Status values are `processing`, `success`, `no_match` and `error`. A `no_match` on tier 1 means we
looked and found no contacts, and it is free. `charge` is what your wallet actually paid, so the
figure above is one account's example and not a rate for everyone. The rates are in the table at
the top of this guide.

`research` is a stored field that carries the business-trace record on rows that have one. It is
`null` on a plain person trace. Do not build a workflow that depends on it being filled in.

```python
import time

def wait_for_trace(trace_id: str, max_wait_minutes: int = 30):
    start = time.time()
    while time.time() - start < max_wait_minutes * 60:
        r = requests.get(
            f"https://proptracerpro.vercel.app/api/v1/trace/status?trace_id={trace_id}",
            headers={"Authorization": f"Bearer {API_KEY}"},
        ).json()
        if r["status"] == "processing":
            time.sleep(15)
            continue
        if r["status"] == "success":
            return r["result"]
        return None  # no_match or error
    return None  # timed out waiting
```

Poll every 10 to 30 seconds. Intervals under 10 seconds add load without making anything finish
sooner, because the trace vendor runs on its own cadence and does not go faster because you ask
more often.

## 3. What is in the property record

A Full Property Trace returns the county record for the parcel, and it carries over 60 fields.
What is in yours depends on what that county publishes. Coverage varies by county and by state,
so treat every field as optional and never assume one is populated.

What you can expect to find, when the county published it:

- Location and identity: address, county, parcel number, subdivision, property type, property
  use, land use, latitude and longitude
- Building and land: year built, stories, units, building size, lot size, beds, baths, roof
  material and construction, and features such as air conditioning, garage, pool, basement, deck
- Valuation: assessed value, area median income
- Sale and transaction history: last sale date and price, sale price per square foot, recording
  date, document type, prior sale date and price
- Listing history: days on market, listing price, and MLS state
- Debt: open mortgage balance, lender, estimated mortgage payment
- Owner and occupancy: years owned, properties owned, portfolio value, and whether the record
  marks the owner absentee, owner-occupied, an investor buyer or a cash buyer
- Recorded status flags, which are carried through when the county records them

One thing to be careful with. `assessed_value` is the county's assessment for tax purposes. It
is not a market value, it is not an appraisal, and it is not an estimate of what the property
would sell for. Do not present it to an end user as any of those.

## 4. Webhooks

Configure a webhook URL in Settings, then Integrations. PropTracerPRO posts to it when a trace
completes, so you do not have to poll.

A tier 2 webhook fires for every completed Full Property Trace, including a charged one that
found no contacts. That is deliberate: a charged miss is exactly the outcome you need told about.
It does not fire when a vendor lookup failed, because nothing completed and nothing was charged.

`trace.completed` from a Full Property Trace:

```json
{
  "event": "trace.completed",
  "trace_id": "uuid",
  "status": "success",
  "address": "123 MAIN ST|AUSTIN|TX",
  "city": "AUSTIN",
  "state": "TX",
  "zip": "78701",
  "result": {
    "owner_name": "John Smith",
    "phones": [{ "number": "5125551234", "type": "mobile" }],
    "emails": ["john.smith@email.com"]
  },
  "research": null,
  "charge": 0.25,
  "property_record": { },
  "tier": 2,
  "owner_type": "individual",
  "timestamp": "2026-09-17T18:42:00.000Z"
}
```

`address` on a webhook is the normalized pipe-delimited key, street, city and state, not the
street line you sent. The separate `city` and `state` keys carry those on their own.

A tier 1 trace sends the same event with the same keys, minus `property_record`, `tier` and
`owner_type`, and with the tier 1 `charge`.

Note that the webhook payload is snake_case, including `property_record` and `owner_type`, while
the tier 2 submit response that describes the same trace is camelCase. Same caution as above:
parse per surface.

Delivery is fire and forget. A failed delivery is logged on our side and not retried, so keep
polling available as a fallback if you cannot afford to miss one.

## 5. Deferred business trace jobs: `GET /api/v1/research/status?job_id=<id>`

This endpoint exists and works, and despite the word in its path it is not a research endpoint.
It polls one deferred FastAppend business trace job by id and returns whatever that job has
settled to.

You reach it when a bulk record comes back carrying `business_trace_pending: true` and a
`business_trace_job_id`. Pass that id here. See `AGENT_BULK_INTEGRATION.md` for where those ids
come from.

Polling is free.

```bash
curl "https://proptracerpro.vercel.app/api/v1/research/status?job_id=3f9c7e12-8a4d-4b9a-9c3f-2d1e4f5a9af2" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

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
    "emails": ["jmargolis@example.com"],
    "address": "2605 Scribe Ct, Raleigh, NC"
  },
  "research": null,
  "error_message": null,
  "created_at": "2026-09-14T18:00:00.000Z",
  "completed_at": "2026-09-14T18:42:00.000Z"
}
```

Status values:

- `pending`, the job has not settled yet. Keep polling.
- `completed`, contacts were found and `contacts` is populated.
- `no_match`, the lookup finished and found no contacts for that business. Not an error.
- `error`, the job failed or timed out.

`contacts` is `null` on anything other than `completed`. `research` carries the stored record for
that address when there is one, and is `null` otherwise.

## Common mistakes to avoid

- Sending a large run with no `ownerName` and expecting misses to be free. They are not. Without
  an owner name every record is a Full Property Trace and every record submitted is charged,
  found or not. If you have the owner of record, send it and pay the cheaper per-success rate.
- Waiting on a `traceId` that will never arrive. A Full Property Trace has already finished by
  the time you get the response. Check `tier` before you start a polling loop.
- Mixing up the field conventions. The tier 2 submit response is camelCase, the status endpoint
  and the webhook are snake_case.
- Treating `no_match` as an error. On tier 1 it means we looked and found no contacts, and you
  were not charged. On tier 2 it means the record was bought and no contacts came with it.
- Reading `assessed_value` as a market value. It is a tax assessment.
- Assuming a property record field is always there. Counties publish different things. A field
  the county did not publish is simply absent.
- Polling faster than every 10 seconds. It adds load and changes nothing.
