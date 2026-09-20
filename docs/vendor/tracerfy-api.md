<!-- Tracerfy API documentation, the vendor's own export.
     Source: https://tracerfy.com/skip-tracing-api-documentation/download.md
     Fetched: 2026-09-20. 167,950 bytes, 5,166 lines.

     SAVED HERE because it had been fetched twice into session scratchpads (2026-09-16 and
     2026-09-20) and lost both times. tasks/SESSION-HANDOFF-2026-09-16.md:907-910 predicted
     exactly that and said to re-fetch. This is the copy that stops the third re-fetch.

     The 2026-09-16 and 2026-09-20 exports were diffed: 170 changed lines, all anchor renames
     (#lead-builder-* to #property-search-*) plus one example date. No substantive change.

     The section that matters for the dossier is POST Property Lookup,
     /v1/api/property-search/lookup/, 10 credits per hit. -->

# Tracerfy API Documentation

API reference for Tracerfy skip tracing, property data, DNC screening, phone verification, reverse append, and business trace services.

**Base URL:** `https://tracerfy.com`

**Authentication:** All endpoints require a Bearer token in the `Authorization` header.

---

## Table of Contents

- [Authentication, Errors & Rate Limits](#errors-auth)
- [Sandbox / Testing Environment](#sandbox)
- [Response Metadata](#response-metadata)
- [Fetch all Queues](#queues)
- [Fetch Single Queue](#queue)
- [Analytics](#analytics)
- [Batch Trace](#trace)
- [Instant Trace Lookup (Synchronous)](#instant-trace)
- [Enhanced Trace Lookup (Synchronous)](#enhanced-trace)
- [Phone Verification Lookup (Synchronous)](#phone-verification)
- [APN Batch Trace](#apn-batch)
- [APN Instant Lookup (Synchronous)](#apn-lookup)
- [Trace Webhooks](#trace-webhooks)
- [DNC API Versions (v1 vs v2)](#dnc-versions)
- [Start DNC Scrub](#dnc-scrub)
- [DNC Scrub from Trace](#dnc-scrub-from-queue)
- [DNC Instant Lookup (Synchronous)](#dnc-lookup)
- [Start DNC Scrub (v2)](#dnc-scrub-v2)
- [DNC Scrub from Trace (v2)](#dnc-scrub-from-queue-v2)
- [DNC Instant Lookup (v2, Synchronous)](#dnc-lookup-v2)
- [Fetch all DNC Queues](#dnc-queue)
- [DNC Webhooks](#dnc-webhooks)
- [List Filters](#property-search-filters)
- [Preview Lead List](#property-search-preview)
- [Execute Lead Build](#property-search-execute)
- [Check Build Status](#property-search-status)
- [Lead List Rows (JSON)](#property-search-rows)
- [Property Lookup (Synchronous)](#property-search-lookup)
- [Address Autocomplete](#property-search-autocomplete)
- [APN Autocomplete](#property-search-apn-autocomplete)
- [Lead Builder Webhooks](#property-search-webhooks)
- [AI Assist (TraceAI)](#property-search-ai-assist)
- [Filter Reference](#property-search-filter-reference)
- [Propensity Scores](#property-search-propensity)
- [Saved Templates — List & Create](#property-search-templates)
- [Template — Get, Update & Delete](#property-search-templates-detail)
- [Create a Monitor](#property-monitors-create)
- [List & Get Monitors](#property-monitors-list)
- [Pause, Resume & Delete](#property-monitors-lifecycle)
- [Monitor Delivery History (Runs)](#property-monitors-runs)
- [Connect via AI Assistants (MCP)](#mcp)
- [Reverse Append APIs — Phone, Email & Name Lookup](#fastappend-reverse-append)
- [Business Trace API — Business & LLC Owner Lookup](#fastappend-business-trace)

---

## REF Authentication, Errors & Rate Limits

`REF Applies to every /v1/api/ endpoint`

Every endpoint requires a Bearer token in the `Authorization` header: `Authorization: Bearer <YOUR_TOKEN>`. Requests without a valid token get a **401**.

**Status codes you may receive:**

- `200 OK` — success (synchronous endpoints).
- `202 Accepted` — async job accepted and queued (e.g. Lead Builder execute).
- `400 Bad Request` — malformed body, missing/invalid parameter, or a column named in your request is not present in the uploaded data.
- `401 Unauthorized` — missing, malformed, or invalid/expired Bearer token.
- `402 Payment Required` — insufficient credits for the requested work.
- `403 Forbidden` — account suspended (unpaid invoices or API access disabled), or you tried to access a resource that belongs to another account.
- `404 Not Found` — the resource ID does not exist (or is not yours — unknown and cross-account IDs both return 404 to prevent ID enumeration).
- `405 Method Not Allowed` — wrong HTTP method for the route.
- `409 Conflict` — the resource is not ready yet (e.g. reading rows of a lead list that is still processing).
- `429 Too Many Requests` — a rate limit was exceeded. Back off and retry; the response body includes how many requests were counted in the window.
- `500 Internal Server Error` — an unexpected error. Retry; if it persists, contact support.
- `502` / `503` — the request couldn't be completed right away due to a temporary service delay. This usually resolves on its own. If it persists, contact support.
**Rate limits (per account):**

- **Batch Trace** & **APN Batch Trace** — 10 submissions per 5 minutes.
- **Instant Trace**, **Enhanced Trace**, **Phone Verification**, **APN Instant Lookup** & **Property Lookup** — 500 lookups per minute (shared counter).
- **DNC Scrub** — 10 scrubs per 5 minutes.
- **DNC Instant Lookup** — 30 lookups per minute.
- **Fetch all Queues** — 1 request per 20 seconds.
- **Lead Builder Preview** — 500 previews per hour.
- **Lead Builder Execute** — 10 lists per hour and 50 per day.
- **Address Autocomplete** — 30 requests per minute.
The insufficient-credits (402) and suspended-account (403) message wording varies slightly per endpoint, but the shape and status code are the same everywhere. Representative bodies are below.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Error Responses

**401 Unauthorized — missing or invalid token**

```json
{
  "detail": "Authentication credentials were not provided."
}
```

**400 Bad Request — field validation (detail is a field→messages map)**

```json
{
  "address": [
    "This field is required."
  ],
  "state": [
    "This field is required."
  ]
}
```

**402 Payment Required — insufficient credits**

```json
// When the account cannot use monthly billing
{
  "error": "Insufficient credits. Instant trace requires 5 credits per lookup. You have 0 credits."
}

// When credits are short and no payment method is on file
{
  "error": "Insufficient credits. Instant trace requires 5 credits per lookup. Please add credits or a payment method."
}
```

**403 Forbidden — account suspended**

```json
// Unpaid invoices
{
  "error": "Your account has been temporarily suspended due to unpaid invoices. Please contact support@tracerfy.com to resolve outstanding payments."
}

// API access disabled for this account
{
  "error": "api_disabled",
  "detail": "Your API access has been suspended. Please contact support at support@tracerfy.com.",
  "status": 403
}
```

**404 Not Found — unknown or cross-account resource ID**

```json
{
  "error": "No Queue Found with ID 123"
}
```

**429 Too Many Requests — rate limited**

```json
// Most endpoints — includes the count seen in the window
{
  "status": 429,
  "error": "Rate limit exceeded. Max 500 lookups per minute.",
  "lookups_in_window": 500
}

// Fetch all Queues (20-second throttle)
{
  "error": "Rate limit exceeded. Retry in intervals of 20 seconds.",
  "retry_in": "3 seconds"
}
```

---

## REF Sandbox / Testing Environment

`REF https://mock.tracerfy.com/v1/api/`

Before you spend a single credit, build and test your integration against the **free hosted sandbox** at `https://mock.tracerfy.com`. It mirrors this *exact* API — same paths, methods, field names, and response shapes — but returns realistic **fake** data. Nothing is charged and no credits are consumed.

**Going live is a one-line change:** develop against `https://mock.tracerfy.com/v1/api/`, then swap the host to `https://tracerfy.com/v1/api/` and use your real token. Nothing else about your code changes.

- **Auth:** any non-empty Bearer token authenticates — no real key needed. (The reserved value `INVALID_TOKEN` always returns `401` so you can test your unauthorized path.)
- **Deterministic:** the same request always returns the same data (it's seeded from your inputs), so your test assertions stay stable. Only `meta.request_id` and `meta.timestamp` vary between calls.
- **Full coverage:** every endpoint in these docs — batch & instant trace, parcel/APN, DNC, property search, saved templates, and property monitors.
- **Interactive docs:** browse and try every endpoint at `https://mock.tracerfy.com/docs`.
**Magic values — force a specific scenario on demand.** Anything you send that isn't a magic value flows through to a normal deterministic fake response. The values below instead trigger a fixed outcome, so you can exercise every branch of your client without hunting for real data that happens to hit or miss:

- **Numeric path IDs** — use an HTTP status code as any `{id}` to reproduce that scenario: `404` not found, `403` cross-account, `409` still processing, `0` a pending job. e.g. `GET /v1/api/property-monitors/404/` → `404`.
- **String sentinels** — embed a keyword in the primary string field (`address`, `phone`, a monitor `name`, a strategy value, or a CSV `*_column`): `NO_CREDITS`→402, `SUSPENDED`→403, `RATE_LIMIT`→429, `SERVER_ERROR`→500, `UNAVAILABLE`→503, `MISSING_COLUMN`→400 (CSV), `NO_MATCH`→200 empty, `MULTI`→200 multiple results, `CAP_REACHED`→400 (monitor cap). The literal address `999 Nowhere Blvd` behaves as a miss.
**The sandbox is for development only** — it returns fabricated data, so never point production traffic at it.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <ANY_NON_EMPTY_TOKEN>` |

### Example Request

```bash
# Test against the sandbox — any token works, nothing is billed
curl -X POST 'https://mock.tracerfy.com/v1/api/trace/lookup/' \
  -H 'Authorization: Bearer sandbox_test_token' \
  -H 'Content-Type: application/json' \
  -d '{"address":"123 Main St","city":"Austin","state":"TX","zip":"78701"}'

# Force a scenario with a magic value (402 insufficient credits)
curl -X POST 'https://mock.tracerfy.com/v1/api/trace/lookup/' \
  -H 'Authorization: Bearer sandbox_test_token' \
  -H 'Content-Type: application/json' \
  -d '{"address":"NO_CREDITS","city":"Austin","state":"TX"}'

# Ready for real data? Change the host and use your real token
curl -X POST 'https://tracerfy.com/v1/api/trace/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"address":"123 Main St","city":"Austin","state":"TX","zip":"78701"}'
```

### Example Response (200 OK)

```json
// POST /v1/api/trace/lookup/ on the sandbox — the exact body the first curl above
// returns. Deterministic: the same request always returns this data (only meta varies).
{
  "address": "123 Main St",
  "city": "Austin",
  "state": "TX",
  "zip": "78701",
  "find_owner": true,
  "hit": true,
  "persons_count": 1,
  "credits_deducted": 5,
  "persons": [
    {
      "first_name": "Sandra",
      "last_name": "Dean",
      "full_name": "Sandra Dean",
      "dob": "1958-12",
      "age": "67",
      "deceased": true,
      "property_owner": true,
      "litigator": false,
      "mailing_address": {
        "street": "469 Amy Pines Suite 707",
        "city": "Christinebury",
        "state": "CT",
        "zip": "50627"
      },
      "phones": [
        {
          "number": "5088697674",
          "type": "Mobile",
          "dnc": false,
          "tcpa": false,
          "carrier": "COMCAST PHONE LLC",
          "rank": 1
        },
        {
          "number": "6478388352",
          "type": "Landline",
          "dnc": true,
          "tcpa": false,
          "carrier": "US CELLULAR",
          "rank": 2
        }
      ],
      "emails": [
        {
          "email": "mreeves@hotmail.com",
          "rank": 1
        }
      ]
    }
  ],
  "meta": {
    "request_id": "req_b0e2ba54941820e3009e83c0cd14dda6",
    "timestamp": "2026-07-20T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**Magic value NO_CREDITS → 402 (deterministic)**

```json
{
  "error": "Insufficient credits. Lead Builder lookup requires 10 credits per hit. You have 2 credits."
}
```

**Reserved token INVALID_TOKEN → 401**

```json
{
  "detail": "Authentication credentials were not provided."
}
```

---

## REF Response Metadata

`REF Applies to every /v1/api/ endpoint`

Every response carries an `X-Request-Id` response header — a unique id Tracerfy assigns to that request. Use it to correlate a specific response with your own application logs and retries, and quote it when contacting support. The id is always assigned server-side; any `X-Request-Id` you send on the request is ignored.

In addition, every response whose body is a JSON **object** includes a `meta` block:

- `request_id` — the same value as the `X-Request-Id` header.
- `timestamp` — when the response was generated (ISO 8601, UTC).
- `api_version` — the response-schema version that served the request.
`meta` is additive — new fields may be added over time, so treat unknown keys as optional and ignore them. Endpoints that return a top-level JSON **array** (e.g. [Fetch all Queues](#queues) and [Fetch Single Queue](#queue)) keep their bare-array body and do **not** include a `meta` block — read the `X-Request-Id` header for those. The AI-assist endpoint (`/v1/api/property-search/ai-assist/`) also returns no `meta` block (it still carries the `X-Request-Id` header).

### Headers

| Name | Value |
|------|-------|
| `X-Request-Id` | `req_1a2b3c… (present on every response)` |

### Error Responses

**meta block (present on every object response)**

```json
// Example: the Analytics response, with the meta block appended
{
  "total_queues": 12,
  "properties_traced": 18350,
  "queues_pending": 2,
  "queues_completed": 10,
  "balance": 940,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

---

## GET Fetch all Queues

`GET /v1/api/queues/`

Returns the authenticated user's queues as a JSON array, ordered by most recent first. Each queue represents a trace job created via API or the app. While a queue is pending, `rows_uploaded` and `credits_deducted` are hidden; when complete, `download_url` is populated with a CSV link.

Up to **100 queues per page**. Pass `?page=N` to walk back through history. Pagination metadata is in the response headers — `X-Total-Count` for the total, and `Link` for navigation:

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `page` | query | `integer` | No | Page number to return. Default: 1. 100 queues per page. |

### Example Request

```bash
# Default — page 1, latest 100 queues
curl -i -X GET 'https://tracerfy.com/v1/api/queues/' -H 'Authorization: Bearer <YOUR_TOKEN>'

# Walk back through history
curl -i -X GET 'https://tracerfy.com/v1/api/queues/?page=2' -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
[
  {
    "id": 124,
    "created_at": "2025-01-02T09:30:00Z",
    "pending": true,
    "download_url": null,
    "rows_uploaded": 1800,
    "credits_deducted": 0,
    "queue_type": "api",
    "trace_type": "normal",
    "credits_per_lead": 1
  },
  {
    "id": 123,
    "created_at": "2025-01-01T12:00:00Z",
    "pending": false,
    "download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/9a584124-77c2-4612-b8e9-f9efe6fbdc3d.csv",
    "rows_uploaded": 2500,
    "credits_deducted": 2500,
    "queue_type": "api",
    "trace_type": "normal",
    "credits_per_lead": 1
  }
]
```

---

## GET Fetch Single Queue

`GET /v1/api/queue/:id`

Returns the property records associated with a queue's posted addresses. Object-level permission enforced: only the queue owner can access. Null contact fields are normalized to empty strings in the response. 

**One record per input row that produced a match.** Input rows where no person was found at the address don't appear in this response — there's no record to return. For the full row-aligned view (every input row alongside whatever was found, including misses), use the CSV at `download_url` on the queue object — that file contains all rows you submitted, with empty contact columns for rows that didn't match.

**Response varies based on trace_type:**
• **Normal Trace** (trace_type='normal'): Returns basic property contact data (phones and emails)
• **Advanced Trace** (trace_type='advanced'): Finds the property owner and returns their contact data (name, phones, emails and mailing address)
• **Enhanced Trace** (trace_type='enhanced'): Targets the supplied person by name and address, returning enhanced contact context such as linked addresses and possible relatives when available

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `:id` | path | `integer` | Yes | Queue ID |

### Example Request

```bash
curl -X GET 'https://tracerfy.com/v1/api/queue/123' -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
// Normal Trace Response (trace_type='normal')
[
  {
    "address": "123 Main St",
    "city": "Austin",
    "state": "TX",
    "mail_address": "PO Box 111",
    "mail_city": "Austin",
    "mail_state": "TX",
    "first_name": "Jane",
    "last_name": "Doe",
    "primary_phone": "5125550100",
    "primary_phone_type": "Mobile",
    "email_1": "jane@example.com",
    "email_2": "",
    "email_3": "",
    "email_4": "",
    "email_5": "",
    "mobile_1": "5125550100",
    "mobile_2": "",
    "mobile_3": "",
    "mobile_4": "",
    "mobile_5": "",
    "landline_1": "",
    "landline_2": "",
    "landline_3": ""
  }
]
```

### Error Responses

**404 — No queue with that ID**

```json
{
  "error": "No Queue Found with ID 123"
}
```

**403 — Queue belongs to another account**

```json
{
  "error": "You do not have permission to access this queue."
}
```

---

## GET Analytics

`GET /v1/api/analytics/`

Aggregated summary for your account: total_queues, properties_traced (sum of posted addresses per queue), queues_pending, queues_completed, and current credit balance.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Example Request

```bash
curl -X GET 'https://tracerfy.com/v1/api/analytics/' -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
{
  "total_queues": 12,
  "properties_traced": 18350,
  "queues_pending": 2,
  "queues_completed": 10,
  "balance": 940,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

---

## POST Batch Trace

`POST /v1/api/trace/`

Asynchronous batch endpoint for processing multiple addresses at once via CSV or JSON. Specify trace_type='normal' (1 credit/lead), 'advanced' (2 credits/lead), or 'enhanced' (15 credits/lead). Enhanced batch traces require first and last name columns and target each supplied person at the associated address. Cleans and de-duplicates rows, then enqueues processing in the background. If credits are insufficient the request is rejected. Returns a queue_id immediately along with `estimated_wait_seconds` (estimated processing time in seconds); results are delivered via download_url when complete. For single-address instant lookups, use the [Instant Trace Lookup](#instant-trace) endpoint instead.

⚠️ API Usage Policy: Do not abuse API POST calls. Accounts found to be abusing the API will be put on hold. Maximum rate limit is 10 POST trace requests per 5-minute window. Please use the API responsibly and in accordance with our [Terms of Service - API Rate Limits & Abuse Policy](/terms-of-service#api-rate-limits).

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `multipart/form-data or application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `address_column` | body | `string` | Yes | Column for property address |
| `city_column` | body | `string` | Yes | Column for property city |
| `state_column` | body | `string` | Yes | Column for property state |
| `zip_column` | body | `string` | No | Property ZIP. Optional but recommended. |
| `first_name_column` | body | `string` | No | Person first-name column. Required for normal, custom, and enhanced traces. Not used by advanced owner lookup. |
| `last_name_column` | body | `string` | No | Person last-name column. Required for normal, custom, and enhanced traces. Not used by advanced owner lookup. |
| `mail_address_column` | body | `string` | No | Mailing address column. Required for normal traces; optional for advanced/enhanced traces. |
| `mail_city_column` | body | `string` | No | Mailing city column. Required for normal traces; optional for advanced/enhanced traces. |
| `mail_state_column` | body | `string` | No | Mailing state column. Required for normal traces; optional for advanced/enhanced traces. |
| `mailing_zip_column` | body | `string` | No | Mailing ZIP column. Optional. |
| `trace_type` | body | `string` | No | Trace type: 'normal' (1 credit/lead), 'advanced' (2 credits/lead), or 'enhanced' (15 credits/lead). Defaults to 'normal'. Advanced discovers the owner from an address; Enhanced requires first and last name columns. |
| `csv_file` | form-data | `file` | Yes | CSV file of records |
| `json_data` | body | `string` | No | Raw JSON array of records (alternative to csv_file) |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/trace/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -F 'csv_file=@/path/to/records.csv' \
  -F 'address_column=address' \
  -F 'city_column=city' \
  -F 'state_column=state' \
  -F 'zip_column=zip' \
  -F 'first_name_column=first_name' \
  -F 'last_name_column=last_name' \
  -F 'mail_address_column=mail_address' \
  -F 'mail_city_column=mail_city' \
  -F 'mail_state_column=mail_state' \
  -F 'mailing_zip_column=mailing_zip' \
  -F 'trace_type=normal'
```

### Example Response (200)

```json
{
  "message": "Queue created",
  "queue_id": 456,
  "status": "pending",
  "created_at": "2025-01-02T10:15:00Z",
  "rows_uploaded": 100,
  "trace_type": "normal",
  "credits_per_lead": 1,
  "estimated_wait_seconds": 30,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Column not found in your data**

```json
{
  "error": "Error in cleansing the data, please check the data and try again",
  "details": "'address' Not found in the data or not a valid column name"
}
```

**400 — No usable rows**

```json
{
  "error": "No valid rows found after data cleaning. Please check your data and try again."
}
```

**503 — Enhanced trace temporarily unavailable**

```json
{
  "error": "Enhanced trace is temporarily unavailable. Please contact support to enable enhanced bulk traces."
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits for normal trace. You need 40 more credits to complete this request. Please add credits to your account or add a payment method for monthly billing."
}
```

---

## POST Instant Trace Lookup (Synchronous)

`POST /v1/api/trace/lookup/`

Synchronous skip trace for one address object or an array of up to 15 address objects. Returns responses immediately as JSON — no queue and no CSV. Ideal for one-off lookups or integrating skip trace data into your own UI at scale.

**Array requests:** wrap up to 15 of the same objects in a JSON array. Results stay in input order, each item is validated and billed independently, and the response returns `results` plus aggregate `credits_deducted`.

**5 credits per hit, 0 credits on miss.** Rate limited to 500 lookup items per minute per account; every object in an array counts as one item.

**Two lookup modes:**
• **find_owner: true** (default) — send only address/city/state, returns the property owner(s) and their contact info
• **find_owner: false** — include first_name + last_name to search for a specific person at the address

**Response includes per person:** name, age, DOB, deceased flag, property owner flag, litigator flag, mailing address, all phones (with DNC + TCPA litigator status, carrier, type, rank), and all emails.

**⚠️ Compliance:** Phones returning `litigator: true` or `dnc: true` should not be called for telemarketing or cold outreach without documented prior express written consent. TCPA violations can carry penalties. You are solely responsible for compliance with TCPA, FDCPA, and DNC regulations. These flags are informational, not legal advice.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `address` | body | `string` | Yes | Property street address |
| `city` | body | `string` | Yes | Property city |
| `state` | body | `string` | Yes | Property state (2-letter abbreviation) |
| `zip` | body | `string` | No | Property ZIP code. Optional but **strongly recommended** — without it, results may match a different property at a similar address in the same city. |
| `find_owner` | body | `boolean` | No | `true` (default) — find property owner, no name needed. `false` — find a specific person at the address, requires first_name + last_name. |
| `first_name` | body | `string` | No | Person's first name. **Required when find_owner is false.** |
| `last_name` | body | `string` | No | Person's last name. **Required when find_owner is false.** |

### Example Request

```bash
# Owner lookup (find property owner)
curl -X POST 'https://tracerfy.com/v1/api/trace/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"address": "123 Main St", "city": "Austin", "state": "TX", "zip": "78701", "find_owner": true}'

# Person lookup (find specific person at address)
curl -X POST 'https://tracerfy.com/v1/api/trace/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"address": "123 Main St", "city": "Austin", "state": "TX", "zip": "78701", "find_owner": false, "first_name": "Jane", "last_name": "Doe"}'

# Array lookup (up to 15 objects)
curl -X POST 'https://tracerfy.com/v1/api/trace/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '[{"address":"123 Main St","city":"Austin","state":"TX","zip":"78701"},{"address":"456 Oak Ave","city":"Dallas","state":"TX","zip":"75201"}]'
```

### Example Response (200)

```json
// Owner lookup hit (find_owner: true) — 5 credits deducted
{
  "address": "123 Main St",
  "city": "Austin",
  "state": "TX",
  "zip": "78701",
  "find_owner": true,
  "hit": true,
  "persons_count": 1,
  "credits_deducted": 5,
  "persons": [
    {
      "first_name": "Jane",
      "last_name": "Doe",
      "full_name": "Jane Doe",
      "dob": "1985-03",
      "age": "41",
      "deceased": false,
      "property_owner": true,
      "litigator": false,
      "mailing_address": {
        "street": "PO Box 111",
        "city": "Austin",
        "state": "TX",
        "zip": "78702"
      },
      "phones": [
        {
          "number": "5125550100",
          "type": "Mobile",
          "dnc": false,
          "tcpa": false,
          "carrier": "T-MOBILE USA INC.",
          "rank": 1
        },
        {
          "number": "5125550200",
          "type": "Landline",
          "dnc": true,
          "tcpa": false,
          "carrier": "AT&T TEXAS",
          "rank": 2
        }
      ],
      "emails": [
        {
          "email": "jane.doe@example.com",
          "rank": 1
        }
      ]
    }
  ],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// Person lookup hit (find_owner: false) — 5 credits deducted
{
  "address": "123 Main St",
  "city": "Austin",
  "state": "TX",
  "zip": "78701",
  "find_owner": false,
  "hit": true,
  "persons_count": 1,
  "credits_deducted": 5,
  "persons": [
    {
      "first_name": "John",
      "last_name": "Smith",
      "full_name": "John Smith",
      "dob": "1978-11",
      "age": "47",
      "deceased": false,
      "property_owner": false,
      "litigator": false,
      "mailing_address": {
        "street": "456 Oak Ave",
        "city": "Dallas",
        "state": "TX",
        "zip": "75201"
      },
      "phones": [
        {
          "number": "2145550300",
          "type": "Mobile",
          "dnc": false,
          "tcpa": false,
          "carrier": "VERIZON WIRELESS",
          "rank": 1
        }
      ],
      "emails": [
        {
          "email": "john.smith@example.com",
          "rank": 1
        }
      ]
    }
  ],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// Miss — no results found, 0 credits deducted
{
  "address": "999 Nowhere Blvd",
  "city": "Austin",
  "state": "TX",
  "zip": "78701",
  "find_owner": true,
  "hit": false,
  "persons_count": 0,
  "credits_deducted": 0,
  "persons": [],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Missing fields / name required for person lookup**

```json
{
  "first_name": [
    "first_name and last_name are required when find_owner is false."
  ]
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. Instant trace requires 5 credits per lookup. You have 0 credits."
}
```

**503 — Skip trace service temporarily unavailable**

```json
{
  "error": "Skip trace service temporarily unavailable. Please try again."
}
```

---

## POST Enhanced Trace Lookup (Synchronous)

`POST /v1/api/trace/enhanced/lookup/`

Find a property owner and enhanced contact data from one address, or target a specific person you already know. Send one object or an array of up to 15 objects.

**Array requests:** results stay in input order, each item is validated and billed independently, and the response returns `results` plus aggregate `credits_deducted`.

**Two search modes:**
• **Owner search:** set `find_owner: true` and enter the property address. No name is needed.
• **Specific-person search:** set `find_owner: false` or omit it, then enter first name, last name, and the associated address.

**15 credits per hit, 0 credits on miss.** Rate limited to 500 lookup items per minute per account through the shared instant-lookup counter; every object in an array counts as one item.

**Response includes:** available phones, emails, mailing address, linked/historical addresses, age data, and up to 2 relatives or associated people.

**Use this when:** you need more owner or person context than a standard trace provides.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `find_owner` | body | `boolean` | No | Set `true` for an address-only owner search. Set `false` or omit it for a specific-person search. |
| `first_name` | body | `string` | No | Required only for a specific-person search; ignored when `find_owner` is true. |
| `last_name` | body | `string` | No | Required only for a specific-person search; ignored when `find_owner` is true. |
| `address` | body | `string` | Yes | Property or associated street address. |
| `city` | body | `string` | Yes | City associated with the address. |
| `state` | body | `string` | Yes | State associated with the address (2-letter abbreviation). |
| `zip` | body | `string` | No | Associated ZIP code. Optional but recommended. |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/trace/enhanced/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"find_owner": true, "address": "123 Main St", "city": "Austin", "state": "TX", "zip": "78701"}'

# Array lookup (up to 15 objects)
curl -X POST 'https://tracerfy.com/v1/api/trace/enhanced/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '[{"find_owner":true,"address":"123 Main St","city":"Austin","state":"TX"},{"find_owner":true,"address":"456 Oak Ave","city":"Dallas","state":"TX"}]'
```

### Example Response (200)

```json
{
  "address": "123 Main St",
  "city": "Austin",
  "state": "TX",
  "zip": "78701",
  "find_owner": true,
  "hit": true,
  "persons_count": 1,
  "relatives_count": 2,
  "credits_deducted": 15,
  "persons": [
    {
      "first_name": "Jane",
      "last_name": "Doe",
      "full_name": "Jane Doe",
      "dob": "1985-03",
      "age": "41",
      "deceased": false,
      "property_owner": true,
      "litigator": false,
      "mailing_address": {
        "street": "PO Box 111",
        "city": "Austin",
        "state": "TX",
        "zip": "78702"
      },
      "phones": [
        {
          "number": "5125550100",
          "type": "Mobile",
          "dnc": false,
          "tcpa": false,
          "carrier": "T-MOBILE USA INC.",
          "rank": 1
        }
      ],
      "emails": [
        {
          "email": "jane.doe@example.com",
          "rank": 1
        }
      ],
      "address_history": [
        {
          "street": "PO Box 111",
          "city": "Austin",
          "state": "TX",
          "zip": "78702",
          "property_mailing_address": true,
          "rank": 1
        },
        {
          "street": "456 Oak Ave",
          "city": "Dallas",
          "state": "TX",
          "zip": "75201",
          "property_mailing_address": false,
          "rank": 2
        }
      ],
      "relatives": [
        {
          "first_name": "John",
          "middle_name": "",
          "last_name": "Doe",
          "full_name": "John Doe",
          "age": 69,
          "dob": "1957-04",
          "deceased": false,
          "phones": [
            {
              "number": "5125550200",
              "rank": 1
            }
          ],
          "emails": [
            {
              "email": "john.doe@example.com",
              "rank": 1
            }
          ],
          "rank": 1
        },
        {
          "first_name": "Mary",
          "middle_name": "A",
          "last_name": "Doe",
          "full_name": "Mary A Doe",
          "age": 64,
          "dob": "1962-09",
          "deceased": false,
          "phones": [],
          "emails": [],
          "rank": 2
        }
      ]
    }
  ],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Person name required in named mode**

```json
{
  "first_name": [
    "This field is required."
  ],
  "last_name": [
    "This field is required."
  ]
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. Enhanced trace requires 15 credits per hit. You have 0 credits."
}
```

**503 — Enhanced trace temporarily unavailable**

```json
{
  "error": "Enhanced trace is temporarily unavailable. Please contact support to enable enhanced lookups."
}
```

---

## POST Phone Verification Lookup (Synchronous)

`POST /v1/api/phone/verify/`

Synchronous phone intelligence endpoint. Send one phone object or an array of up to 15 phone objects and get back line type, carrier, last-seen date, returned DNC/TCPA flags, returned state DNC codes, contactability, and light associated-person context.

**Array requests:** results stay in input order, each item is validated and billed independently, and the response returns `results` plus aggregate `credits_deducted`.

**5 credits per hit, 0 credits on miss.** Rate limited to 500 lookup items per minute per account through the shared instant-lookup counter; every object in an array counts as one item.

**Different from reverse phone append:** this endpoint is not meant to return every person, address, email, and phone connected to the number. It verifies the searched phone itself and returns compact CRM-safe status fields.

**state_dnc:** returned as an array of state codes, for example `["TX"]`. An empty array means no provider-returned state DNC flag was found; it is not a full legal clearance across every state registry.

**contactable:** true only when the returned suppression fields are not flagged. It is not legal advice and does not create consent.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `phone` | body | `string` | Yes | 10-digit US phone number. Formatting is stripped automatically, including dashes, spaces, parentheses, and a leading country code 1. |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/phone/verify/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"phone": "(512) 555-0100"}'

# Array lookup (up to 15 objects)
curl -X POST 'https://tracerfy.com/v1/api/phone/verify/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '[{"phone":"5125550100"},{"phone":"5125550101"}]'
```

### Example Response (200)

```json
// Hit — 5 credits deducted
{
  "phone": "5125550100",
  "hit": true,
  "line_type": "Mobile",
  "carrier": "T-MOBILE USA INC.",
  "last_seen": "2026-07-01",
  "dnc": false,
  "tcpa": false,
  "state_dnc": [],
  "contactable": true,
  "associated_persons_count": 1,
  "associated_persons": [
    {
      "first_name": "Jane",
      "last_name": "Doe",
      "full_name": "Jane Doe",
      "age": "41",
      "city": "Austin",
      "state": "TX"
    }
  ],
  "credits_deducted": 5,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// Hit with returned suppression flags (determined based on dnc flags) — 5 credits deducted
{
  "phone": "5125550100",
  "hit": true,
  "line_type": "Mobile",
  "carrier": "T-MOBILE USA INC.",
  "last_seen": "2026-07-01",
  "dnc": true,
  "tcpa": false,
  "state_dnc": [
    "TX"
  ],
  "contactable": false,
  "associated_persons_count": 1,
  "associated_persons": [
    {
      "first_name": "Jane",
      "last_name": "Doe",
      "full_name": "Jane Doe",
      "age": "41",
      "city": "Austin",
      "state": "TX"
    }
  ],
  "credits_deducted": 5,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// Miss — 0 credits deducted
{
  "phone": "5125559999",
  "hit": false,
  "line_type": "",
  "carrier": "",
  "last_seen": "",
  "dnc": false,
  "tcpa": false,
  "state_dnc": [],
  "contactable": false,
  "associated_persons_count": 0,
  "associated_persons": [],
  "credits_deducted": 0,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Invalid phone**

```json
{
  "phone": [
    "Enter a valid 10-digit US phone number."
  ]
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. Phone verification requires 5 credits per hit. You have 0 credits."
}
```

**503 — Phone verification temporarily unavailable**

```json
{
  "error": "Phone verification is temporarily unavailable. Please contact support to enable phone verification."
}
```

---

## POST APN Batch Trace

`POST /v1/api/trace/parcel/`

Submit a batch of parcel IDs (APNs) for skip tracing. Each parcel is looked up to find the property owner's contact information — name, mailing address, phones with DNC + TCPA litigator flags and carrier, and emails.

**5 credits per hit, 0 on miss.** Rows with no match still appear in the CSV with empty contact columns.

Results are delivered asynchronously via a CSV download URL. Poll the queue endpoint `GET /v1/api/trace/parcel/queue/:id` for status, or set a webhook URL in your account to get notified on completion.

**APN format:** the `#` prefix is optional and will be stripped automatically. Parcel IDs are formatted internally to match the standard APN format for each county.

**Rate limit:** 10 batch submissions per 5 minutes.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `multipart/form-data` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `csv_file` | form-data | `file` | Yes | CSV file with parcel ID, county, and state columns. |
| `parcel_id_column` | body | `string` | Yes | Name of the column containing parcel IDs. |
| `county_column` | body | `string` | Yes | Name of the column containing county names. |
| `state_column` | body | `string` | Yes | Name of the column containing state abbreviations (e.g. FL, TX). |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/trace/parcel/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -F 'csv_file=@parcels.csv' \
  -F 'parcel_id_column=parcel_id' \
  -F 'county_column=county' \
  -F 'state_column=state'
```

### Example Response (200)

```json
{
  "message": "Parcel trace started",
  "parcel_queue_id": 42,
  "created_at": "2026-04-07T12:00:00Z",
  "status": "pending",
  "rows_uploaded": 500,
  "credits_per_parcel": 5,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Column not found in your data**

```json
{
  "error": "Column \"parcel_id\" not found in data. Available: ['apn', 'county', 'state']"
}
```

**400 — No usable parcel IDs**

```json
{
  "error": "No valid parcel IDs found after cleaning."
}
```

**403 — Account suspended (unpaid invoices)**

```json
{
  "error": "Your account has been temporarily suspended due to unpaid invoices. Please contact support@tracerfy.com to resolve outstanding payments."
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. Parcel trace requires 5 credits per hit (worst case 2500 credits for 500 parcels). You have 0 credits."
}
```

---

## POST APN Instant Lookup (Synchronous)

`POST /v1/api/trace/parcel/lookup/`

Synchronous parcel skip trace for one parcel object or an array of up to 15 parcel objects. Returns owner contact info immediately as JSON — no queue, no CSV, no polling.

**Array requests:** results stay in input order, each item is validated and billed independently, and the response returns `results` plus aggregate `credits_deducted`.

**5 credits per hit, 0 on miss.**

The response includes every field the batch CSV delivers: owner name, property address, mailing address, all phones with DNC + TCPA litigator flags and carrier, emails, plus `property_owner`, `deceased`, `litigator`, and `age`.

**APN format:** the `#` prefix is optional.

**Rate limit:** 500 lookup items per minute per account; every object in an array counts as one item.

**⚠️ Compliance:** Phones returning `litigator: true` or `dnc: true` should not be called for telemarketing or cold outreach without documented prior express written consent. TCPA violations can carry penalties. You are solely responsible for compliance with TCPA, FDCPA, and DNC regulations. These flags are informational, not legal advice.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `parcel_id` | body | `string` | Yes | The parcel ID (APN). The '#' prefix is optional and will be stripped automatically. |
| `county` | body | `string` | Yes | County name (e.g. 'Palm Beach'). |
| `state` | body | `string` | Yes | State abbreviation (e.g. 'FL'). |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/trace/parcel/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"parcel_id": "#00424109000007550", "county": "Palm Beach", "state": "FL"}'

# Array lookup (up to 15 objects)
curl -X POST 'https://tracerfy.com/v1/api/trace/parcel/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '[{"parcel_id":"00424109000007550","county":"Palm Beach","state":"FL"},{"parcel_id":"00424109000007560","county":"Palm Beach","state":"FL"}]'
```

### Example Response (200)

```json
// Hit — 5 credits deducted
{
  "parcel_id": "#00424109000007550",
  "county": "Palm Beach",
  "state": "FL",
  "hit": true,
  "persons_count": 1,
  "credits_deducted": 5,
  "persons": [
    {
      "first_name": "John",
      "last_name": "Smith",
      "full_name": "John Smith",
      "dob": "1975-03",
      "age": 51,
      "deceased": false,
      "property_owner": true,
      "litigator": false,
      "mailing_address": {
        "street": "456 Oak Ave",
        "city": "West Palm Beach",
        "state": "FL",
        "zip": "33401"
      },
      "phones": [
        {
          "number": "5615550100",
          "type": "Mobile",
          "dnc": false,
          "tcpa": false,
          "carrier": "T-MOBILE USA INC.",
          "rank": 1
        },
        {
          "number": "5615550200",
          "type": "Landline",
          "dnc": true,
          "tcpa": false,
          "carrier": "BELLSOUTH TELECOMM INC",
          "rank": 2
        }
      ],
      "emails": [
        {
          "email": "jsmith@example.com",
          "rank": 1
        },
        {
          "email": "john.smith@example.net",
          "rank": 2
        }
      ]
    }
  ],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// Miss — 0 credits
{
  "parcel_id": "#00404033000001190",
  "county": "Palm Beach",
  "state": "FL",
  "hit": false,
  "persons_count": 0,
  "credits_deducted": 0,
  "persons": [],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Missing parcel_id / county / state**

```json
{
  "parcel_id": [
    "This field is required."
  ]
}
```

**403 — Account suspended (unpaid invoices)**

```json
{
  "error": "Your account has been temporarily suspended due to unpaid invoices. Please contact support@tracerfy.com to resolve outstanding payments."
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. Parcel trace requires 5 credits per lookup. You have 0 credits."
}
```

**503 — Skip trace service temporarily unavailable**

```json
{
  "error": "Skip trace service temporarily unavailable. Please try again."
}
```

---

## POST Trace Webhooks

`POST Account.webhook_url`

When a batch skip trace queue completes, Tracerfy POSTs the result to the webhook URL configured in your account profile. This is per-user and dynamic; no registration endpoint is required.

Three payload shapes can arrive at this endpoint, depending on which trace finished:
• **Normal skip trace** — distinguished by `trace_type: "normal"` and `credits_per_lead: 1`.
• **Advanced skip trace** — distinguished by `trace_type: "advanced"` and `credits_per_lead: 2`.
• **APN / parcel trace** — distinguished by `type: "parcel_trace"` and the `parcel_queue_id` field. Different shape (no `trace_type`); uses `credits_per_parcel` instead.

Enhanced batch trace webhooks follow the same skip-trace queue shape; only the `trace_type` string and `credits_per_lead` value differ.

### Headers

| Name | Value |
|------|-------|
| `Content-Type` | `application/json` |

### Example Request

```bash
Tracerfy sends one of the JSON shapes below to your Account.webhook_url when a trace completes.
```

### Example Response (200)

```json
// Normal skip trace completed — 1 credit per hit
{
  "id": 365,
  "created_at": "2025-07-13T18:55:02.962332Z",
  "pending": false,
  "download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/9a584124-77c2-4612-b8e9-f9efe6fbdc3d.csv",
  "rows_uploaded": 12,
  "credits_deducted": 12,
  "queue_type": "api",
  "trace_type": "normal",
  "credits_per_lead": 1
}

// Advanced skip trace completed — 2 credits per hit
{
  "id": 366,
  "created_at": "2025-07-13T19:02:18.114402Z",
  "pending": false,
  "download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/2b7e9a44-3812-4ae1-8c0f-1d7e92a4f111.csv",
  "rows_uploaded": 12,
  "credits_deducted": 24,
  "queue_type": "api",
  "trace_type": "advanced",
  "credits_per_lead": 2
}

// APN / parcel trace completed — 5 credits per hit, different payload shape
{
  "type": "parcel_trace",
  "event": "parcel_trace.completed",
  "parcel_queue_id": 42,
  "status": "completed",
  "download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/parcel-trace-42.csv",
  "rows_uploaded": 500,
  "rows_hit": 423,
  "credits_deducted": 2115,
  "credits_per_parcel": 5
}
```

---

## REF DNC API Versions (v1 vs v2)

`REF /v1/api/dnc/ · /v2/api/dnc/`

Both versions are current and supported; **v2 is recommended for new integrations**. Only the DNC endpoints have a v2 — everything else stays on `/v1/api/`. Migrating is a URL change: `/v1/api/dnc/scrub/` → `/v2/api/dnc/scrub/`.

**Unchanged:** authentication, request parameters, pricing, rate limits, webhooks, queue lifecycle, and the two-CSV output.

**v2 adds**
• `state_dnc_list` — *which* state registries matched, not just that one did. Array in JSON, comma-separated in the CSV. State registries currently covered: CO, FL, IN, LA, MA, MO, PA, TN, TX, WY — this list can grow, and any state returned is reflected in `state_dnc_list` whether or not it appears here. Federal DNC and litigator checks are nationwide.
• Faster batch scrubs — the whole list goes upstream in one request.

**v2 removes**
• `dma` — marketing-preference suppression, not a DNC or TCPA signal. Never affected `is_clean`.
• `phone_type` — DNC data carries no line type, and v2 does not infer one.

**Result CSV** — v2 replaces `dma` with `state_dnc_list` and drops `phone_type`. Remaining columns keep their names and `Y`/`N` encoding.
• v1: `phone, label, national_dnc, state_dnc, dma, litigator, phone_type, is_clean`
• v2: `phone, label, national_dnc, state_dnc, state_dnc_list, litigator, is_clean`

`GET /dnc/queue/:id` is the same endpoint on both versions.

### Example Request

```bash
# v1 — unchanged, still supported
curl -X POST 'https://tracerfy.com/v1/api/dnc/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"phone": "4805551234"}'

# v2 — same request, one character different in the URL
curl -X POST 'https://tracerfy.com/v2/api/dnc/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"phone": "4805551234"}'

# Array lookup (up to 15 objects)
curl -X POST 'https://tracerfy.com/v2/api/dnc/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '[{"phone":"4805551234"},{"phone":"4805559876"}]'
```

### Example Response (200)

```json
// v1 response
{
  "phone": "4805551234",
  "hit": true,
  "national_dnc": true,
  "state_dnc": true,
  "dma": false,
  "litigator": false,
  "phone_type": "Mobile",
  "is_clean": false,
  "credits_deducted": 5
}

// v2 response — same number
{
  "phone": "4805551234",
  "hit": true,
  "national_dnc": true,
  "state_dnc": true,
  "state_dnc_list": [
    "FL"
  ],
  "litigator": false,
  "is_clean": false,
  "credits_deducted": 5
}
```

---

## POST Start DNC Scrub

`POST /v1/api/dnc/scrub/`

Submit a phone list for DNC (Do Not Call) scrubbing. Upload a CSV with one or more phone columns, or pass a JSON array of phone numbers directly. Each phone is checked against Federal DNC, State DNC, DMA, and TCPA Litigator databases. 1 credit per phone checked.

**A v2 of this endpoint is available** at [POST /v2/api/dnc/scrub/](/skip-tracing-api-documentation/#dnc-scrub-v2) and is recommended for new integrations. Same parameters, same price; see [DNC API Versions](/skip-tracing-api-documentation/#dnc-versions).

**Input options (pick one):**
• **CSV with single column**: csv_file + phone_column (string)
• **CSV with multiple columns**: csv_file + phone_columns (array) — phones are merged & deduplicated
• **JSON phone list**: phones array via application/json

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `multipart/form-data or application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `csv_file` | form-data | `file` | Yes | CSV file containing phone numbers. Required for Options 1 & 2. Do not send with phones. |
| `phone_column` | body | `string` | Yes | Single column name containing phone numbers (Option 1). Internally normalized to phone_columns. Mutually exclusive with phone_columns. |
| `phone_columns` | body | `array[string]` | Yes | List of column names containing phone numbers (Option 2). Phones are merged & deduplicated. When multiple columns are used, labels are prefixed with the column name, e.g. '(Phone_1) John Doe'. Mutually exclusive with phone_column. |
| `label_column` | body | `string` | No | Single column to label each phone (e.g., name). Internally normalized to label_columns. Mutually exclusive with label_columns. |
| `label_columns` | body | `array[string]` | No | List of columns to combine as a label for each phone (e.g., ["address", "city", "state"]). Values are joined with commas. When using multiple phone_columns, labels are also prefixed with the column name. |
| `phones` | body | `array[string]` | Yes | Direct list of phone numbers via JSON body (Option 3). Do not send with csv_file. |

### Example Request

```bash
# Option 1: CSV with a single phone column
curl -X POST 'https://tracerfy.com/v1/api/dnc/scrub/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -F 'csv_file=@/path/to/phones.csv' \
  -F 'phone_column=Phone' \
  -F 'label_column=Name'

# Option 1b: CSV with multiple label columns
curl -X POST 'https://tracerfy.com/v1/api/dnc/scrub/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -F 'csv_file=@/path/to/phones.csv' \
  -F 'phone_column=Phone' \
  -F 'label_columns=["Address", "City", "State"]'

# Option 2: CSV with multiple phone columns
curl -X POST 'https://tracerfy.com/v1/api/dnc/scrub/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -F 'csv_file=@/path/to/phones.csv' \
  -F 'phone_columns=["Phone_1", "Phone_2"]' \
  -F 'label_column=Name'

# Option 3: JSON phone list (no CSV)
curl -X POST 'https://tracerfy.com/v1/api/dnc/scrub/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"phones": ["5125550100", "5125550101", "5125550102"]}'
```

### Example Response (200)

```json
{
  "message": "DNC scrub started",
  "dnc_queue_id": 5,
  "created_at": "2025-01-15T09:30:00Z",
  "status": "pending",
  "phones_to_check": 150,
  "credits_per_phone": 1,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Phone column not found in your CSV**

```json
{
  "error": "Column \"Phone\" not found in CSV"
}
```

**400 — No usable phone numbers**

```json
{
  "error": "No valid phone numbers found"
}
```

**403 — Account suspended (unpaid invoices)**

```json
{
  "error": "Account suspended due to unpaid invoices."
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. You need 150 credits for DNC scrubbing. You have 0."
}
```

---

## POST DNC Scrub from Trace

`POST /v1/api/dnc/scrub-from-queue/`

Extract phone numbers from a completed trace queue from your skip tracing results and submit them for DNC scrubbing. Optionally specify which phone columns to include. Phones are deduplicated across all selected columns. 1 credit per phone checked.

**A v2 of this endpoint is available** at [POST /v2/api/dnc/scrub-from-queue/](/skip-tracing-api-documentation/#dnc-scrub-from-queue-v2). Same parameters, same price; see [DNC API Versions](/skip-tracing-api-documentation/#dnc-versions).

**Valid phone_columns:** primary_phone, mobile_1, mobile_2, mobile_3, mobile_4, mobile_5, landline_1, landline_2, landline_3
If phone_columns is omitted, all 9 phone fields are included by default.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `queue_id` | body | `integer` | Yes | ID of a completed trace queue to extract phones from. |
| `phone_columns` | body | `array[string]` | No | List of phone field names to include. Defaults to all 9 phone fields. |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/dnc/scrub-from-queue/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"queue_id": 37360, "phone_columns": ["primary_phone", "mobile_1", "mobile_2"]}'
```

### Example Response (200)

```json
{
  "message": "DNC scrub started",
  "dnc_queue_id": 8,
  "created_at": "2025-01-15T10:00:00Z",
  "source_queue_id": 37360,
  "status": "pending",
  "phones_to_check": 23,
  "phone_columns_used": [
    "primary_phone",
    "mobile_1",
    "mobile_2"
  ],
  "credits_per_phone": 1,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**404 — Source trace queue not found**

```json
{
  "error": "No trace queue found with ID 37360"
}
```

**400 — Source trace still processing**

```json
{
  "error": "This trace is still processing. Please wait until it completes."
}
```

**400 — No phones in the selected columns**

```json
{
  "error": "No phone numbers found in this trace for the selected columns."
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. You need 23 credits for DNC scrubbing. You have 0."
}
```

---

## POST DNC Instant Lookup (Synchronous)

`POST /v1/api/dnc/lookup/`

Synchronous DNC check. Send one phone object or an array of up to 15 phone objects and get back Federal DNC, State DNC, DMA, and TCPA Litigator flags immediately. No queue, no CSV, no waiting.

**Array requests:** results stay in input order, each item is validated and billed independently, and the response returns `results` plus aggregate `credits_deducted`. Each phone counts toward the lookup rate limit.

**5 credits per lookup.** Rate limited to 30 RPM per user.

**A v2 of this endpoint is available** at [POST /v2/api/dnc/lookup/](#dnc-lookup-v2), which names the matched state registries but drops `dma` and `phone_type`. v2 has its own 120-item-per-minute limit. See [DNC API Versions](#dnc-versions).

**Use this when:** you need to check a single number before dialing or as part of a real-time CRM workflow. For bulk scrubbing (100+ phones), use [POST /v1/api/dnc/scrub/](#dnc-scrub) instead — it self-paces and isn't subject to this 30 RPM limit.

**Response fields:**
- `national_dnc` — on the Federal Do Not Call Registry
- `state_dnc` — on a State DNC list
- `dma` — on the Direct Marketing Association list
- `litigator` — known TCPA litigator
- `phone_type` — Mobile or Landline
- `is_clean` — true only if no flags are set

**⚠️ Compliance:** Phones returning `litigator: true` or `national_dnc: true` should not be called for telemarketing or cold outreach without documented prior express written consent. TCPA violations can carry penalties. You are solely responsible for compliance with TCPA, FDCPA, and DNC regulations. These flags are informational, not legal advice.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `phone` | body | `string` | Yes | 10-digit US phone number. Formatting is stripped automatically (dashes, spaces, parentheses, leading 1). |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/dnc/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"phone": "4805551234"}'

# Array lookup (up to 15 objects)
curl -X POST 'https://tracerfy.com/v1/api/dnc/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '[{"phone":"4805551234"},{"phone":"4805559876"}]'
```

### Example Response (200)

```json
// Flagged — not clean
{
  "phone": "4805551234",
  "hit": true,
  "national_dnc": true,
  "state_dnc": false,
  "dma": false,
  "litigator": false,
  "phone_type": "Mobile",
  "is_clean": false,
  "credits_deducted": 5,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// Clean — safe to proceed
{
  "phone": "6025559876",
  "hit": true,
  "national_dnc": false,
  "state_dnc": false,
  "dma": false,
  "litigator": false,
  "phone_type": "Landline",
  "is_clean": true,
  "credits_deducted": 5,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Missing or invalid phone**

```json
// No phone in body
{
  "error": "Missing 'phone' field."
}

// Not a 10-digit US number
{
  "error": "Invalid phone number. Must be a 10-digit US number."
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. DNC lookup requires 5 credits. You have 0 credits."
}
```

**429 — Rate limit (30/min)**

```json
{
  "status": 429,
  "error": "DNC lookup limit exceeded. Max 30 lookups per 1 minute(s). For higher volume, use the batch scrub endpoint, which respects upstream rate limits automatically.",
  "lookups_in_window": 30,
  "retry_after_seconds": 60
}
```

**503 — DNC lookup not configured on this server**

```json
{
  "error": "DNC lookup service is not configured."
}
```

**502 — Upstream temporarily unavailable**

```json
{
  "error": "DNC lookup service temporarily unavailable. Please try again."
}
```

---

## POST Start DNC Scrub (v2)

`POST /v2/api/dnc/scrub/`

Submit a phone list for DNC (Do Not Call) scrubbing. Upload a CSV with one or more phone columns, or pass a JSON array of phone numbers directly. Each phone is checked against the Federal DNC registry, state DNC registries, and known TCPA litigator records. 1 credit per phone checked.

See [DNC API Versions](#dnc-versions) for the result fields.

**Input options (pick one):**
• **CSV with single column**: csv_file + phone_column (string)
• **CSV with multiple columns**: csv_file + phone_columns (array) — phones are merged & deduplicated
• **JSON phone list**: phones array via application/json

**Result CSV columns:** `phone, label, national_dnc, state_dnc, state_dnc_list, litigator, is_clean`.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `multipart/form-data or application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `csv_file` | form-data | `file` | Yes | CSV file containing phone numbers. Required for Options 1 & 2. Do not send with phones. |
| `phone_column` | body | `string` | Yes | Single column name containing phone numbers (Option 1). Internally normalized to phone_columns. Mutually exclusive with phone_columns. |
| `phone_columns` | body | `array[string]` | Yes | List of column names containing phone numbers (Option 2). Phones are merged & deduplicated. When multiple columns are used, labels are prefixed with the column name, e.g. '(Phone_1) John Doe'. Mutually exclusive with phone_column. |
| `label_column` | body | `string` | No | Single column to label each phone (e.g., name). Internally normalized to label_columns. Mutually exclusive with label_columns. |
| `label_columns` | body | `array[string]` | No | List of columns to combine as a label for each phone (e.g., ["address", "city", "state"]). Values are joined with commas. When using multiple phone_columns, labels are also prefixed with the column name. |
| `phones` | body | `array[string]` | Yes | Direct list of phone numbers via JSON body (Option 3). Do not send with csv_file. |

### Example Request

```bash
# CSV with a single phone column
curl -X POST 'https://tracerfy.com/v2/api/dnc/scrub/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -F 'csv_file=@/path/to/phones.csv' \
  -F 'phone_column=Phone' \
  -F 'label_column=Name'

# JSON phone list (no CSV)
curl -X POST 'https://tracerfy.com/v2/api/dnc/scrub/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"phones": ["5125550100", "5125550101", "5125550102"]}'
```

### Example Response (200)

```json
{
  "message": "DNC scrub started",
  "dnc_queue_id": 5,
  "created_at": "2025-01-15T09:30:00Z",
  "status": "pending",
  "phones_to_check": 150,
  "credits_per_phone": 1,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Phone column not found in your CSV**

```json
{
  "error": "Column \"Phone\" not found in CSV"
}
```

**400 — No usable phone numbers**

```json
{
  "error": "No valid phone numbers found"
}
```

**403 — Account suspended (unpaid invoices)**

```json
{
  "error": "Account suspended due to unpaid invoices."
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. You need 150 credits for DNC scrubbing. You have 0."
}
```

---

## POST DNC Scrub from Trace (v2)

`POST /v2/api/dnc/scrub-from-queue/`

Extract phone numbers from a completed trace queue and submit them for DNC scrubbing. Optionally specify which phone columns to include. Phones are deduplicated across all selected columns. 1 credit per phone checked.

**Valid phone_columns:** primary_phone, mobile_1, mobile_2, mobile_3, mobile_4, mobile_5, landline_1, landline_2, landline_3
If phone_columns is omitted, all 9 phone fields are included by default.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `queue_id` | body | `integer` | Yes | ID of a completed trace queue to extract phones from. |
| `phone_columns` | body | `array[string]` | No | List of phone field names to include. Defaults to all 9 phone fields. |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v2/api/dnc/scrub-from-queue/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"queue_id": 37360, "phone_columns": ["primary_phone", "mobile_1", "mobile_2"]}'
```

### Example Response (200)

```json
{
  "message": "DNC scrub started",
  "dnc_queue_id": 8,
  "created_at": "2025-01-15T10:00:00Z",
  "source_queue_id": 37360,
  "status": "pending",
  "phones_to_check": 23,
  "phone_columns_used": [
    "primary_phone",
    "mobile_1",
    "mobile_2"
  ],
  "credits_per_phone": 1,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**404 — Source trace queue not found**

```json
{
  "error": "No trace queue found with ID 37360"
}
```

**400 — Source trace still processing**

```json
{
  "error": "This trace is still processing. Please wait until it completes."
}
```

**400 — No phones in the selected columns**

```json
{
  "error": "No phone numbers found in this trace for the selected columns."
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. You need 23 credits for DNC scrubbing. You have 0."
}
```

---

## POST DNC Instant Lookup (v2, Synchronous)

`POST /v2/api/dnc/lookup/`

Synchronous DNC check. Send one phone object or an array of up to 15 phone objects and get Federal DNC, state DNC, and TCPA litigator flags back immediately. No queue, no CSV, no waiting.

**Array requests:** results stay in input order, each item is validated and billed independently, and the response returns `results` plus aggregate `credits_deducted`. Each phone counts toward the lookup rate limit.

**5 credits per lookup.** Rate limited to 120 lookup items per minute per account.

**Use this when:** you need to check a single number before dialing or as part of a real-time CRM workflow. For bulk scrubbing (100+ phones), use [POST /v2/api/dnc/scrub/](#dnc-scrub-v2) instead — it isn't subject to the synchronous 120-item-per-minute limit.

**Response fields:**
- `national_dnc` — on the Federal Do Not Call Registry
- `state_dnc` — on at least one state DNC registry
- `state_dnc_list` — array of the state codes matched, e.g. `["FL", "TX"]`; empty when `state_dnc` is false
- `litigator` — known TCPA litigator
- `is_clean` — true only if no flags are set

**Not returned by v2:** `dma` and `phone_type`. See [DNC API Versions](#dnc-versions).

**⚠️ Compliance:** Phones returning `litigator: true` or `national_dnc: true` should not be called for telemarketing or cold outreach without documented prior express written consent. TCPA violations can carry penalties. You are solely responsible for compliance with TCPA, FDCPA, and DNC regulations. These flags are informational, not legal advice.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `phone` | body | `string` | Yes | 10-digit US phone number. Formatting is stripped automatically (dashes, spaces, parentheses, leading 1). |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v2/api/dnc/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"phone": "4805551234"}'
```

### Example Response (200)

```json
// Flagged — not clean
{
  "phone": "4805551234",
  "hit": true,
  "national_dnc": true,
  "state_dnc": true,
  "state_dnc_list": [
    "FL"
  ],
  "litigator": false,
  "is_clean": false,
  "credits_deducted": 5,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// Clean — safe to proceed
{
  "phone": "6025559876",
  "hit": true,
  "national_dnc": false,
  "state_dnc": false,
  "state_dnc_list": [],
  "litigator": false,
  "is_clean": true,
  "credits_deducted": 5,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Missing or invalid phone**

```json
// No phone in body
{
  "error": "Missing 'phone' field."
}

// Not a 10-digit US number
{
  "error": "Invalid phone number. Must be a 10-digit US number."
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. DNC lookup requires 5 credits. You have 0 credits."
}
```

**429 — Rate limit (30/min)**

```json
{
  "status": 429,
  "error": "DNC lookup limit exceeded. Max 120 lookups per 1 minute(s). For higher volume, use the batch scrub endpoint, which respects upstream rate limits automatically.",
  "lookups_in_window": 30,
  "retry_after_seconds": 60
}
```

**503 — DNC lookup not configured on this server**

```json
{
  "error": "DNC lookup service is not configured."
}
```

**502 — Upstream temporarily unavailable**

```json
{
  "error": "DNC lookup service temporarily unavailable. Please try again."
}
```

---

## GET Fetch all DNC Queues

`GET /v1/api/dnc/queue/:id`

Retrieve the status and results of a DNC scrub job. When complete, two download URLs are provided: download_url (all phones including ones with DNC flags) and clean_download_url (only phones with no DNC flags).

This endpoint is version-independent — `/v1/api/dnc/queue/:id` and `/v2/api/dnc/queue/:id` are the same endpoint and return the same JSON for any queue you own. The **CSV columns depend on which version created the scrub**:
• v1: `phone, label, national_dnc, state_dnc, dma, litigator, phone_type, is_clean`
• v2: `phone, label, national_dnc, state_dnc, state_dnc_list, litigator, is_clean`

**Note:** While the queue is still pending, the fields `phones_checked`, `phones_clean`, and `credits_deducted` are omitted from the response. They appear once the scrub completes.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `:id` | path | `integer` | Yes | DNC Queue ID |

### Example Request

```bash
curl -X GET 'https://tracerfy.com/v1/api/dnc/queue/5' -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
{
  "id": 5,
  "created_at": "2025-01-15T09:30:00Z",
  "pending": false,
  "download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/full-results.csv",
  "clean_download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/clean-results.csv",
  "rows_uploaded": 150,
  "phones_checked": 150,
  "phones_clean": 112,
  "credits_deducted": 150,
  "source_type": "upload",
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**404 — No DNC queue with that ID**

```json
{
  "error": "No DNC queue found with ID 5"
}
```

**403 — DNC queue belongs to another account**

```json
{
  "error": "Permission denied"
}
```

---

## POST DNC Webhooks

`POST Account.webhook_url`

When a DNC scrub completes, Tracerfy POSTs the result to the webhook URL configured in your account profile. The payload includes a `type: "dnc_scrub"` field to distinguish it from trace webhooks, plus DNC-specific fields like clean_download_url, phones_checked, and phones_clean.

### Headers

| Name | Value |
|------|-------|
| `Content-Type` | `application/json` |

### Example Request

```bash
Tracerfy sends this JSON to your Account.webhook_url when a DNC scrub completes.
```

### Example Response (200)

```json
{
  "id": 5,
  "type": "dnc_scrub",
  "created_at": "2025-01-15T09:30:00Z",
  "pending": false,
  "download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/full-results.csv",
  "clean_download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/clean-results.csv",
  "rows_uploaded": 150,
  "phones_checked": 150,
  "phones_clean": 112,
  "credits_deducted": 150,
  "source_type": "upload"
}
```

---

## GET List Filters

`GET /v1/api/property-search/filters/`

Returns every Lead Builder preset strategy with its human-readable label, description, and the exact filters the preset applies. Use this to enumerate available filters at runtime instead of hard-coding the list in your client. Response is static enough to cache locally for ~1 hour.

For each strategy, `default_filters` shows the filters that the preset lays down — anything you send in `filter_overrides` on `/preview/` or `/execute/` will merge on top. This lets you see exactly what `'tired_landlord'` does before you use it.

For the complete list of individual filter keys you can use in `filter_overrides`, see the [Filter Reference](#property-search-filter-reference) below.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Example Request

```bash
curl 'https://tracerfy.com/v1/api/property-search/filters/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
{
  "strategies": [
    {
      "key": "pre_foreclosure_motivated",
      "label": "Pre-Foreclosure",
      "description": "Active pre-foreclosure filings in the last 6 months.",
      "default_filters": {
        "pre_foreclosure": true,
        "search_range": "6_MONTH"
      }
    },
    {
      "key": "probate_inherited",
      "label": "Inherited",
      "description": "Inherited properties with high-intent sellers.",
      "default_filters": {
        "inherited": true
      }
    },
    {
      "key": "vacant",
      "label": "Vacant Homes",
      "description": "Vacant properties with no one residing at the address.",
      "default_filters": {
        "vacant": true
      }
    },
    {
      "key": "high_equity_absentee",
      "label": "High Equity Absentee",
      "description": "Absentee owners with the high-equity flag and strong seller motivation.",
      "default_filters": {
        "absentee_owner": true,
        "high_equity": true
      }
    },
    {
      "key": "tired_landlord",
      "label": "Tired Landlord",
      "description": "Absentee owners who have held 7+ years and own 2+ properties.",
      "default_filters": {
        "absentee_owner": true,
        "years_owned_min": 7,
        "properties_owned_min": 2
      }
    },
    {
      "key": "reo_bank_owned",
      "label": "REO / Bank-Owned",
      "description": "Bank-owned (REO) properties and post-foreclosure distressed inventory.",
      "default_filters": {
        "reo": true
      }
    },
    {
      "key": "cash_buyer_investor",
      "label": "Cash Buyer",
      "description": "Recent cash buyers for wholesaling disposition lists.",
      "default_filters": {
        "cash_buyer": true
      }
    },
    {
      "key": "free_and_clear",
      "label": "Free & Clear",
      "description": "Properties owned outright with no active mortgage.",
      "default_filters": {
        "free_clear": true
      }
    },
    {
      "key": "auction_property",
      "label": "Auction Properties",
      "description": "Properties scheduled for auction with distressed seller potential.",
      "default_filters": {
        "auction": true
      }
    },
    {
      "key": "judgment_lien",
      "label": "Judgment / Lien",
      "description": "Properties whose owners have court judgments and financial distress.",
      "default_filters": {
        "judgment": true
      }
    },
    {
      "key": "owner_deceased",
      "label": "Owner Deceased",
      "description": "Properties with a deceased owner of record and potential estate sales.",
      "default_filters": {
        "death": true
      }
    },
    {
      "key": "active_flipper",
      "label": "Active Flipper",
      "description": "Investors who bought 2+ properties in the last 12 months.",
      "default_filters": {
        "investor_buyer": true,
        "portfolio_purchased_last12_min": 2
      }
    },
    {
      "key": "zombie_property",
      "label": "Zombie Property",
      "description": "Vacant homes with an active pre-foreclosure filing, possibly abandoned mid-foreclosure.",
      "default_filters": {
        "vacant": true,
        "pre_foreclosure": true
      }
    },
    {
      "key": "tax_delinquent",
      "label": "Tax Delinquent",
      "description": "Owners who fell behind on property taxes within the last 3 years.",
      "default_filters": {
        "tax_delinquent_year_min": 2023,
        "tax_delinquent_year_max": 2026
      }
    },
    {
      "key": "low_equity",
      "label": "Low Equity",
      "description": "Properties with roughly 30% equity or less for refinance and short-sale outreach.",
      "default_filters": {
        "ltv_min": 70
      }
    },
    {
      "key": "vacant_land",
      "label": "Vacant Land",
      "description": "Undeveloped land parcels for land flipping and infill development.",
      "default_filters": {
        "property_type": "LAND"
      }
    },
    {
      "key": "expired_mls",
      "label": "Expired MLS Listings",
      "description": "Properties that were listed for sale but failed to sell, indicating possible seller motivation.",
      "default_filters": {
        "mls_cancelled": true
      }
    },
    {
      "key": "failed_listing",
      "label": "Failed Listing",
      "description": "Listings that came off the market without selling and may be ready to relist.",
      "default_filters": {
        "mls_failed": true
      }
    },
    {
      "key": "recent_homeowner",
      "label": "Recent Homeowner",
      "description": "Bought in the last 6 months for home improvement, refinance, and warranty outreach.",
      "default_filters": {
        "last_sale_date_min": "2026-03-24",
        "absentee_owner": false
      }
    },
    {
      "key": "long_term_owner_listing_opportunity",
      "label": "Long-Term Owner",
      "description": "Owner-occupied for 10+ years with potential listing leads.",
      "default_filters": {
        "years_owned_min": 10,
        "absentee_owner": false
      }
    },
    {
      "key": "high_equity_refi_candidate",
      "label": "High Equity Refi",
      "description": "Owner-occupied with the high-equity flag for refinance outreach.",
      "default_filters": {
        "absentee_owner": false,
        "high_equity": true
      }
    },
    {
      "key": "solar_owner_occupied_high_value",
      "label": "Solar (Owner-Occupied, High Value)",
      "description": "SFRs built before 2015, owner-occupied, high equity, $300k+ value.",
      "default_filters": {
        "property_type": "SFR",
        "absentee_owner": false,
        "value_min": 300000,
        "year_built_max": 2015,
        "high_equity": true
      }
    },
    {
      "key": "roofing_older_home_high_equity",
      "label": "Roofing (Older Home, High Equity)",
      "description": "SFRs built before 2005, owner-occupied, high equity.",
      "default_filters": {
        "property_type": "SFR",
        "year_built_max": 2005,
        "high_equity": true,
        "absentee_owner": false
      }
    },
    {
      "key": "hvac_older_home_owner_occupied",
      "label": "HVAC (Older Home, Owner-Occupied)",
      "description": "SFRs built before 2000, owner-occupied. Aging HVAC replacement market.",
      "default_filters": {
        "property_type": "SFR",
        "year_built_max": 2000,
        "absentee_owner": false
      }
    },
    {
      "key": "custom",
      "label": "Custom",
      "description": "A blank slate for configuring every filter manually or through an AI prompt.",
      "default_filters": {}
    }
  ],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

---

## POST Preview Lead List

`POST /v1/api/property-search/preview/`

Preview a lead list before charging. Returns the total match count, the capped count (the lower of total_matches and your requested_count), and the maximum credit cost. **Preview calls do not charge credits.**

Use this to iterate on filters and geography before committing — safe to call repeatedly. Rate limited to 500 calls per hour per account.

**About `max_credit_cost`:** 5 credits per row in the delivered CSV. The value is the ceiling — if fewer properties match than `requested_count`, `capped_count` drops and the charge drops with it.

**Filters:** see [List Filters](#property-search-filters) for preset strategies, or use `'custom'` and supply individual filters via `filter_overrides`. Full key reference at [Filter Reference](#property-search-filter-reference).

**Geography modes:** `zips`, `city`, `counties`, `states`, `radius`. See the shape examples under the `geography` param below.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `strategy` | body | `string` | No | Strategy key from [/filters/](#property-search-filters). Defaults to 'custom'. Supports comma-separated multi-select (e.g. 'pre_foreclosure_motivated,probate_inherited,vacant') to combine multiple lead types with OR logic. |
| `geography` | body | `object` | Yes | Geography dict with a required `mode` field. Shapes: • `{"mode": "zips", "zip_codes": ["85001","85004"]}` • `{"mode": "city", "cities": ["Phoenix"], "states": ["AZ"]}` • `{"mode": "counties", "counties": ["Maricopa"], "states": ["AZ"]}` • `{"mode": "states", "states": ["AZ","TX"]}` • `{"mode": "radius", "latitude": 33.45, "longitude": -112.07, "radius": 5}` (miles) |
| `filter_overrides` | body | `object` | No | Filters merged on top of the strategy defaults. See [Filter Reference](#property-search-filter-reference) for every accepted key. |
| `requested_count` | body | `integer` | Yes | Maximum rows you'd pay for. 1-25000. `capped_count` in the response = min(total_matches, requested_count). |
| `include_pins` | body | `boolean` | No | When true, the response also includes up to 500 {latitude, longitude} pins for map rendering. Defaults to false for API callers who don't need them. |
| `dedupe_from_history` | body | `boolean` | No | When true, the response returns the post-dedupe count: properties this account has already received from past `/execute/` calls with the **same** filter set are subtracted. The response gains three extra fields: `dedupe_from_history` (echoes the flag), `excluded_from_history` (how many propertyIds would be skipped), and `available_after_dedupe` (the new effective pool size). Defaults to false. Same-filter matching is hash-based and ignores click order of multi-strategy slugs and geography lists. |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/property-search/preview/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "strategy": "high_equity_absentee",
    "geography": {"mode": "city", "cities": ["Phoenix"], "states": ["AZ"]},
    "filter_overrides": {"year_built_max": 2015},
    "requested_count": 500,
    "dedupe_from_history": false
  }'
```

### Example Response (200)

```json
{
  "count": 2340,
  "capped_count": 500,
  "requested_count": 500,
  "max_credit_cost": 2500,
  "max_credit_cost_usd": 50.0,
  "strategy": "high_equity_absentee",
  "strategy_label": "High Equity Absentee",
  "filters_applied": {
    "absentee_owner": true,
    "high_equity": true,
    "state": "AZ",
    "city": "Phoenix"
  },
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**Preview with dedupe_from_history=true**

```json
{
  "count": 2340,
  "capped_count": 500,
  "requested_count": 500,
  "max_credit_cost": 2500,
  "max_credit_cost_usd": 50.0,
  "strategy": "high_equity_absentee",
  "strategy_label": "High Equity Absentee",
  "filters_applied": {
    "absentee_owner": true,
    "high_equity": true,
    "state": "AZ",
    "city": "Phoenix"
  },
  "dedupe_from_history": true,
  "excluded_from_history": 1200,
  "available_after_dedupe": 1140
}
```

**400 — Unknown strategy**

```json
{
  "strategy": [
    "Unknown strategy 'not_a_real_strategy'. Valid options: call GET /v1/api/property-search/filters/"
  ]
}
```

**400 — Disallowed filter key**

```json
{
  "filter_overrides": [
    "Disallowed filter keys: ['not_a_key']. See ALLOWED_FILTER_KEYS."
  ]
}
```

**429 — Preview rate limit (500/hr)**

```json
{
  "status": 429,
  "error": "Lead Builder preview rate limit exceeded. Max 500 previews per hour.",
  "previews_in_window": 500
}
```

**503 — Upstream temporarily unavailable**

```json
{
  "error": "Lead preview service temporarily unavailable. Please try again."
}
```

---

## POST Execute Lead Build

`POST /v1/api/property-search/execute/`

Create a lead list and dispatch the build task. This is the charged path — 5 credits per *delivered* row. Rate limited to 10 executes per hour, 50 per day, per user.

Returns a 202 with the new `id` and a `poll_url`. The build runs asynchronously and typically takes 1-5 minutes depending on `requested_count`. Poll [the status endpoint](#property-search-status) until completion, or configure your [account webhook](#property-search-webhooks) to get notified automatically.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `strategy` | body | `string` | No | Same as /preview/. Defaults to 'custom'. |
| `geography` | body | `object` | Yes | Same shape as /preview/. |
| `filter_overrides` | body | `object` | No | Same shape as /preview/. |
| `requested_count` | body | `integer` | Yes | 1-25000. Billed at 5 credits per delivered row, capped here. |
| `name` | body | `string` | No | Optional label shown in /lead-lists/ and the status response. |
| `dedupe_from_history` | body | `boolean` | No | When true, the build excludes any propertyId your account has previously received from a past `/execute/` call that used the **same filter set** (strategy + geography + filter_overrides). Useful for re-runs when you only want fresh leads. The match is hash-based — multi-strategy slug order and geography list order are normalized. To keep upstream cost bounded, the build fetches up to **5×** `requested_count` properties before truncating; if your filter pool is mostly exhausted, the final list may come in under your requested count (`actual_count < requested_count`) and you are only billed for delivered rows. Defaults to false (no exclusion). |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/property-search/execute/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "strategy": "high_equity_absentee",
    "geography": {"mode": "city", "cities": ["Phoenix"], "states": ["AZ"]},
    "filter_overrides": {"year_built_max": 2015},
    "requested_count": 500,
    "name": "Phoenix Q2 Prospects",
    "dedupe_from_history": false
  }'
```

### Example Response (202)

```json
{
  "id": 42,
  "status": "pending",
  "progress_stage": "",
  "created_at": "2026-04-11T18:23:00Z",
  "requested_count": 500,
  "max_credit_cost": 2500,
  "poll_url": "/v1/api/lead-builder/42/",
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Validation error**

```json
{
  "requested_count": [
    "Ensure this value is less than or equal to 25000."
  ]
}
```

**400 — No matches (widen your filters)**

```json
{
  "error": "No properties match this filter set. Widen your filters and try again.",
  "matches": 0
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. This lead list requires up to 2500 credits (5 per row × 500 rows). You have 100 credits.",
  "matches": 2340,
  "capped": 500
}
```

**403 — Account suspended (unpaid invoices)**

```json
{
  "error": "Your account has been temporarily suspended due to unpaid invoices. Please contact support@tracerfy.com to resolve outstanding payments."
}
```

---

## GET Check Build Status

`GET /v1/api/property-search/<id>/`

Poll a lead list for completion status. Returns the current stage, progress percent, and the CSV `download_url` once the build finishes.

**Stages:** `fetching_properties` → `skip_tracing` → `generating_csv` → *(empty when complete)*.

Ownership is enforced — you can only poll lead lists your account created. Unknown IDs return 404 (same as cross-user access attempts, to prevent ID enumeration).

**Polling cadence:** poll every 2-5 seconds and back off as the stage advances, or skip polling entirely by configuring your [account webhook](#property-search-webhooks).

**The CSV:** `download_url` is a time-limited signed URL (valid ~1 hour).

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `id` | path | `integer` | Yes | The LeadList id returned from the execute endpoint. |

### Example Request

```bash
curl 'https://tracerfy.com/v1/api/property-search/42/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
// Complete — download_url ready
{
  "id": 42,
  "name": "Phoenix Q2 Prospects",
  "strategy": "high_equity_absentee",
  "strategy_label": "High Equity Absentee",
  "source": "api",
  "status": "complete",
  "progress_stage": "",
  "progress_percent": 100,
  "requested_count": 500,
  "actual_count": 487,
  "credits_deducted": 2435,
  "download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/lead_list_42_a1b2c3d4.csv",
  "error_message": "",
  "created_at": "2026-04-11T18:23:00Z",
  "completed_at": "2026-04-11T18:37:42Z",
  "poll_url": "/v1/api/lead-builder/42/",
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// Pending — still building
{
  "id": 42,
  "name": "Phoenix Q2 Prospects",
  "strategy": "high_equity_absentee",
  "strategy_label": "High Equity Absentee",
  "source": "api",
  "status": "pending",
  "progress_stage": "skip_tracing",
  "progress_percent": 47,
  "requested_count": 500,
  "actual_count": null,
  "credits_deducted": 0,
  "download_url": "",
  "error_message": "",
  "created_at": "2026-04-11T18:23:00Z",
  "completed_at": null,
  "poll_url": "/v1/api/lead-builder/42/",
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**404 — Unknown or cross-account lead list ID**

```json
{
  "error": "Lead list not found."
}
```

---

## GET Lead List Rows (JSON)

`GET /v1/api/property-search/<id>/rows/`

Paginated JSON access to the rows in a completed lead list. Same data as the CSV download, delivered as a JSON array — no file parsing needed.

**Use this when:** you want to consume lead data programmatically without downloading and parsing a CSV. Perfect for CRM integrations, webhooks, or piping rows directly into your application.

**No extra charge:** the data was already paid for on [/execute/](#property-search-execute). This endpoint is a free read.

**Pagination — all rows are reachable.** The `500` is a *page-size* limit (most rows per response), **not** a cap on how many rows you can retrieve. `per_page` defaults to 100 (max 500); there's no upper bound on `page` — increment it to pull the whole list, and read `total_rows` / `total_pages` to know when you've reached the end. Returns 409 if the list is still processing.

**Note:** the seven property-signal columns added in v1.1 (`foreclosure`, `tax_delinquent_year`, `tax_lien`, `quit_claim`, `mls_sold`, `mls_failed`, `area_median_income`) are fully populated in the CSV download; this JSON endpoint currently returns them as empty strings for schema compatibility. `foreclosure` and auction statuses are verified against current filing records before delivery, so stale historical cases are not reported as active.

**Propensity scores included on every row.** Each row carries 5 independent propensity scores so the same lead can be qualified for sell, refi, roof, HVAC, and solar use cases at the same time. See the [Propensity Scores](#property-search-propensity) section below for the full schema, score ranges, and how to filter on them.

**⚠️ Compliance:** Phones returning `litigator: true` or `dnc: true` should not be called for telemarketing or cold outreach without documented prior express written consent. TCPA violations can carry penalties. You are solely responsible for compliance with TCPA, FDCPA, and DNC regulations. These flags are informational, not legal advice.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `id` | path | `integer` | Yes | The LeadList id from /execute/. |
| `page` | query | `integer` | No | Page number (default 1). No upper bound — page through every row. |
| `per_page` | query | `integer` | No | Rows per page (response size — not a cap on total rows). 1-500, default 100. |

### Example Request

```bash
curl 'https://tracerfy.com/v1/api/property-search/42/rows/?page=1&per_page=100' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
{
  "lead_list_id": 42,
  "total_rows": 500,
  "page": 1,
  "per_page": 100,
  "total_pages": 5,
  "rows": [
    {
      "address": "742 Evergreen Terrace",
      "city": "Phoenix",
      "state": "AZ",
      "zip_code": "85032",
      "county": "Maricopa",
      "latitude": 33.6359,
      "longitude": -112.0531,
      "apn": "123-45-6789",
      "subdivision": "Paradise Park",
      "property_type": "SFR",
      "property_use": "Single Family Residence",
      "land_use": "Residential",
      "year_built": 1985,
      "beds": 4,
      "baths": 2.5,
      "units_count": 1,
      "stories": 1,
      "building_size_sqft": 2140,
      "lot_size_sqft": 8712,
      "has_ac": true,
      "has_garage": true,
      "has_pool": false,
      "has_basement": false,
      "has_deck": true,
      "roof_material": "Composition Shingle",
      "roof_construction": "Gable",
      "price_per_sqft": 227,
      "estimated_value": 485000,
      "estimated_equity": 298000,
      "equity_percent": 61.4,
      "assessed_value": 362000,
      "area_median_income": "",
      "last_sale_date": "2009-04-15",
      "last_sale_price": 187000,
      "years_owned": 16,
      "prior_sale_date": "2001-08-22",
      "prior_sale_price": 142000,
      "open_mortgage_balance": 134500,
      "lender_name": "Wells Fargo",
      "estimated_mortgage_payment": 987,
      "total_properties_owned": 2,
      "total_portfolio_value": 910000,
      "cash_buyer": false,
      "corporate_owned": false,
      "document_type": "Warranty Deed",
      "quit_claim": "",
      "recording_date": "2009-04-17",
      "flood_zone": false,
      "owner_1_first_name": "JANE",
      "owner_1_last_name": "DOE",
      "owner_2_first_name": "",
      "owner_2_last_name": "",
      "owner_1_age": "72",
      "owner_2_age": "",
      "mail_address": "742 Evergreen Terrace",
      "mail_city": "Phoenix",
      "mail_state": "AZ",
      "mail_zip": "85032",
      "primary_phone": "4805551234",
      "primary_phone_type": "Mobile",
      "primary_phone_carrier": "T-Mobile",
      "primary_phone_dnc": false,
      "primary_phone_tcpa": false,
      "mobile_1": "4805559876",
      "mobile_1_dnc": true,
      "mobile_1_tcpa": false,
      "mobile_2": "",
      "mobile_2_dnc": false,
      "mobile_2_tcpa": false,
      "mobile_3": "",
      "mobile_3_dnc": false,
      "mobile_3_tcpa": false,
      "landline_1": "4805551234",
      "landline_1_dnc": false,
      "landline_1_tcpa": false,
      "landline_2": "",
      "landline_2_dnc": false,
      "landline_2_tcpa": false,
      "email_1": "jane.doe@example.com",
      "email_2": "",
      "email_3": "",
      "litigator": false,
      "has_contact": true,
      "contact_clean": true,
      "absentee_owner": false,
      "owner_occupied": true,
      "vacant": false,
      "free_clear": false,
      "high_equity": true,
      "pre_foreclosure": false,
      "foreclosure": "",
      "tax_delinquent": false,
      "tax_delinquent_year": "",
      "tax_lien": "",
      "inherited": false,
      "death": false,
      "judgment": false,
      "hoa": true,
      "category": "high_equity_refi_candidate",
      "mls_active": false,
      "mls_pending": false,
      "mls_cancelled": false,
      "mls_sold": "",
      "mls_failed": "",
      "mls_days_on_market": null,
      "mls_listing_price": null,
      "adjustable_rate": false,
      "investor_buyer": false,
      "sell_propensity_score": 24,
      "sell_propensity_category": "Low",
      "sell_propensity_factors": [
        {
          "name": "owner_occupied",
          "points": 8,
          "reason": "Owner-occupied — primary residence"
        },
        {
          "name": "years_owned",
          "points": 7,
          "reason": "Owned 16 years — moderate equity accumulation"
        }
      ],
      "refi_propensity_score": 33,
      "refi_propensity_category": "Low",
      "refi_propensity_factors": [
        {
          "name": "high_equity",
          "points": 15,
          "reason": "High equity — strong candidate for cash-out refi"
        },
        {
          "name": "owner_occupied",
          "points": 8,
          "reason": "Owner-occupied — primary residence refinance more likely"
        },
        {
          "name": "years_owned",
          "points": 10,
          "reason": "Owned 16 years — likely has equity to tap"
        }
      ],
      "roof_renovate_propensity_score": 47,
      "roof_renovate_propensity_category": "Medium",
      "roof_renovate_propensity_factors": [
        {
          "name": "owner_occupied",
          "points": 15,
          "reason": "Owner-occupied — decision-maker present"
        },
        {
          "name": "high_equity",
          "points": 12,
          "reason": "High equity — affordability for $20K+ project"
        },
        {
          "name": "older_home",
          "points": 12,
          "reason": "Built 1985 — typical roof end-of-life window"
        }
      ],
      "hvac_renovate_propensity_score": 52,
      "hvac_renovate_propensity_category": "Medium",
      "hvac_renovate_propensity_factors": [
        {
          "name": "owner_occupied",
          "points": 18,
          "reason": "Owner-occupied — decision-maker present"
        },
        {
          "name": "older_home",
          "points": 14,
          "reason": "Built 1985 — HVAC typically replaced every 15-20 years"
        },
        {
          "name": "high_equity",
          "points": 12,
          "reason": "High equity — affordability for system upgrade"
        }
      ],
      "solar_renovate_propensity_score": 71,
      "solar_renovate_propensity_category": "High",
      "solar_renovate_propensity_factors": [
        {
          "name": "owner_occupied",
          "points": 20,
          "reason": "Owner-occupied — decision-maker for long-term install"
        },
        {
          "name": "high_equity",
          "points": 18,
          "reason": "High equity — financing or cash-out available for install"
        },
        {
          "name": "high_value_property",
          "points": 18,
          "reason": "Property value $485K — high-value home, typically sunny region"
        }
      ]
    },
    {
      "address": "1200 Oak Blvd",
      "city": "Phoenix",
      "state": "AZ",
      "zip_code": "85018",
      "county": "Maricopa",
      "latitude": 33.4892,
      "longitude": -111.9874,
      "apn": "987-65-4321",
      "subdivision": "Arcadia Heights",
      "property_type": "SFR",
      "property_use": "Single Family Residence",
      "land_use": "Residential",
      "year_built": 1972,
      "beds": 3,
      "baths": 2.0,
      "units_count": 1,
      "stories": 1,
      "building_size_sqft": 1680,
      "lot_size_sqft": 6200,
      "has_ac": true,
      "has_garage": true,
      "has_pool": true,
      "has_basement": false,
      "has_deck": false,
      "roof_material": "Tile/Clay",
      "roof_construction": "Hip",
      "price_per_sqft": 235,
      "estimated_value": 395000,
      "estimated_equity": 395000,
      "equity_percent": 100.0,
      "assessed_value": 288000,
      "area_median_income": "",
      "last_sale_date": "1998-11-03",
      "last_sale_price": 95000,
      "years_owned": 27,
      "prior_sale_date": null,
      "prior_sale_price": null,
      "open_mortgage_balance": 0,
      "lender_name": "",
      "estimated_mortgage_payment": 0,
      "total_properties_owned": 1,
      "total_portfolio_value": 395000,
      "cash_buyer": false,
      "corporate_owned": false,
      "document_type": "Warranty Deed",
      "quit_claim": "",
      "recording_date": "1998-11-05",
      "flood_zone": false,
      "owner_1_first_name": "ROBERT",
      "owner_1_last_name": "SMITH",
      "owner_2_first_name": "LINDA",
      "owner_2_last_name": "SMITH",
      "owner_1_age": "68",
      "owner_2_age": "65",
      "mail_address": "PO Box 4412",
      "mail_city": "Scottsdale",
      "mail_state": "AZ",
      "mail_zip": "85261",
      "primary_phone": "6025559900",
      "primary_phone_type": "Landline",
      "primary_phone_carrier": "CenturyLink",
      "primary_phone_dnc": false,
      "primary_phone_tcpa": false,
      "mobile_1": "",
      "mobile_1_dnc": false,
      "mobile_1_tcpa": false,
      "mobile_2": "",
      "mobile_2_dnc": false,
      "mobile_2_tcpa": false,
      "mobile_3": "",
      "mobile_3_dnc": false,
      "mobile_3_tcpa": false,
      "landline_1": "6025559900",
      "landline_1_dnc": false,
      "landline_1_tcpa": false,
      "landline_2": "",
      "landline_2_dnc": false,
      "landline_2_tcpa": false,
      "email_1": "rsmith72@example.com",
      "email_2": "",
      "email_3": "",
      "litigator": false,
      "has_contact": true,
      "contact_clean": true,
      "absentee_owner": true,
      "owner_occupied": false,
      "vacant": false,
      "free_clear": true,
      "high_equity": true,
      "pre_foreclosure": false,
      "foreclosure": "",
      "tax_delinquent": false,
      "tax_delinquent_year": "",
      "tax_lien": "",
      "inherited": false,
      "death": false,
      "judgment": false,
      "hoa": false,
      "category": "high_equity_absentee,free_and_clear",
      "mls_active": false,
      "mls_pending": false,
      "mls_cancelled": false,
      "mls_sold": "",
      "mls_failed": "",
      "mls_days_on_market": null,
      "mls_listing_price": null,
      "adjustable_rate": false,
      "investor_buyer": true,
      "sell_propensity_score": 47,
      "sell_propensity_category": "Medium",
      "sell_propensity_factors": [
        {
          "name": "years_owned",
          "points": 12,
          "reason": "Owned 27 years — long tenure, high equity accumulation"
        },
        {
          "name": "absentee_owner",
          "points": 8,
          "reason": "Absentee owner — less attached to property"
        },
        {
          "name": "free_clear",
          "points": 4,
          "reason": "Free and clear — no mortgage friction at sale"
        },
        {
          "name": "aging_property",
          "points": 4,
          "reason": "Built 1972 — significant deferred-maintenance burden"
        }
      ],
      "refi_propensity_score": 18,
      "refi_propensity_category": "Low",
      "refi_propensity_factors": [
        {
          "name": "free_clear",
          "points": 6,
          "reason": "Free and clear — could take on a new mortgage product"
        }
      ],
      "roof_renovate_propensity_score": 18,
      "roof_renovate_propensity_category": "Low",
      "roof_renovate_propensity_factors": [
        {
          "name": "high_equity",
          "points": 12,
          "reason": "High equity — affordability for $20K+ project"
        },
        {
          "name": "absentee_penalty",
          "points": -10,
          "reason": "Absentee owner — investors defer discretionary projects"
        }
      ],
      "hvac_renovate_propensity_score": 22,
      "hvac_renovate_propensity_category": "Low",
      "hvac_renovate_propensity_factors": [
        {
          "name": "high_equity",
          "points": 12,
          "reason": "High equity — affordability for system upgrade"
        },
        {
          "name": "absentee_penalty",
          "points": -10,
          "reason": "Absentee owner — landlords delay HVAC replacement"
        }
      ],
      "solar_renovate_propensity_score": 8,
      "solar_renovate_propensity_category": "Low",
      "solar_renovate_propensity_factors": [
        {
          "name": "absentee_penalty",
          "points": -25,
          "reason": "Absentee owner — solar installs require resident decision-maker"
        }
      ]
    },
    "... 98 more rows in this page"
  ],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**409 — Lead list still processing**

```json
{
  "error": "Lead list is still processing. Poll the status endpoint until complete.",
  "status": "pending"
}
```

**404 — Unknown or cross-account lead list ID**

```json
{
  "error": "Lead list not found."
}
```

---

## POST Property Lookup (Synchronous)

`POST /v1/api/property-search/lookup/`

Synchronous single-address version of [/execute/](#property-search-execute) — one address in, one address out. Use this when you already have a specific address and want the complete data (property attributes, owner, full skip trace) in a single API call.

**Two lookup modes (mutually exclusive):**
• **Address** — send `address` + `city` + `state` (+ optional `zip_code`).
• **APN** — send `apn` + `county` + `state` to enrich a normalized parcel number (e.g. one returned by [APN Autocomplete](#property-search-apn-autocomplete)). An APN is only unique within a county, so `county` + `state` are required to resolve the right parcel. The response shape is identical to address mode.
Sending both `address` and `apn` in the same request is a `400`.

**Billing — 10 credits per property hit:**
• Property found + skip trace hit → 10 credits, full phones/emails + all compliance flags
• Property found + skip trace miss → 10 credits, full property data, empty `contacts` block
• Property NOT found → 0 credits, `hit: false`

Priced at 2× the [/v1/api/trace/lookup/](#instant-trace) endpoint (5 credits) because this lookup returns the full property dossier (50+ Attributes) *in addition to* skip-trace contacts. If you only need phones and emails for an address (no property attributes), use instant trace instead — same skip-trace data, half the cost.

**ZIP code:** optional but *strongly recommended* — without it, common street names can match the wrong property in a large city.

**Rate limit:** 500 requests per minute.

**⚠️ Compliance:** Phones returning `litigator: true` or `dnc: true` should not be called for telemarketing or cold outreach without documented prior express written consent. TCPA violations can carry penalties. You are solely responsible for compliance with TCPA, FDCPA, and DNC regulations. These flags are informational, not legal advice.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `address` | body | `string` | No | Address mode: property street address. Example: "4521 E Monte Cristo Ave". Required in address mode; omit in APN mode. |
| `city` | body | `string` | No | Address mode: property city. Required in address mode. |
| `zip_code` | body | `string` | No | Address mode: property ZIP. Optional but strongly recommended for accuracy. |
| `apn` | body | `string` | No | APN mode: Assessor's Parcel Number. The leading '#' is optional. Required in APN mode; mutually exclusive with address. |
| `county` | body | `string` | No | APN mode: county the parcel is in. Required in APN mode (an APN is only unique within a county). |
| `state` | body | `string` | Yes | Property state (2-letter code). Required in BOTH modes. |

### Example Request

```bash
# Address mode
curl -X POST 'https://tracerfy.com/v1/api/property-search/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "address": "4521 E Monte Cristo Ave",
    "city": "Phoenix",
    "state": "AZ",
    "zip_code": "85032"
  }'

# APN mode (enrich a normalized parcel number)
curl -X POST 'https://tracerfy.com/v1/api/property-search/lookup/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "apn": "123-45-6789",
    "county": "Maricopa",
    "state": "AZ"
  }'
```

### Example Response (200)

```json
// Hit — 10 credits deducted
{
  "hit": true,
  "credits_deducted": 10,
  "skip_trace_hit": true,
  "property": {
    "address": "4521 E Monte Cristo Ave",
    "city": "Phoenix",
    "state": "AZ",
    "zip_code": "85032",
    "county": "Maricopa",
    "latitude": 33.6,
    "longitude": -112.0,
    "apn": "123-45-6789",
    "subdivision": "Paradise Park",
    "property_type": "SFR",
    "property_use": "Single Family",
    "land_use": "Residential",
    "year_built": 1978,
    "beds": 4,
    "baths": 2.5,
    "units_count": 1,
    "stories": 1,
    "building_size_sqft": 2140,
    "lot_size_sqft": 8712,
    "has_ac": true,
    "has_garage": true,
    "has_pool": false,
    "has_basement": false,
    "has_deck": true,
    "estimated_value": 485000,
    "estimated_equity": 298000,
    "equity_percent": 61.4,
    "assessed_value": 362000,
    "area_median_income": 82500,
    "last_sale_date": "2009-04-15",
    "last_sale_price": 187000,
    "years_owned": 17,
    "prior_sale_date": "2001-08-22",
    "prior_sale_price": 142000,
    "open_mortgage_balance": 134500,
    "lender_name": "Wells Fargo",
    "estimated_mortgage_payment": 987,
    "total_properties_owned": 2,
    "total_portfolio_value": 910000,
    "cash_buyer": false,
    "corporate_owned": false,
    "roof_material": "Composition Shingle",
    "roof_construction": "Gable",
    "flood_zone": false,
    "document_type": "Warranty Deed",
    "quit_claim": false,
    "recording_date": "2009-04-17",
    "price_per_sqft": 227,
    "absentee_owner": false,
    "owner_occupied": true,
    "vacant": false,
    "free_clear": false,
    "high_equity": true,
    "pre_foreclosure": false,
    "foreclosure": false,
    "tax_delinquent": false,
    "tax_delinquent_year": null,
    "tax_lien": false,
    "inherited": false,
    "death": false,
    "judgment": false,
    "hoa": true,
    "category": "high_equity_refi_candidate",
    "mls_active": false,
    "mls_pending": false,
    "mls_cancelled": false,
    "mls_sold": false,
    "mls_failed": false,
    "mls_days_on_market": null,
    "mls_listing_price": null,
    "adjustable_rate": false,
    "investor_buyer": false,
    "sell_propensity_score": 24,
    "sell_propensity_category": "Low",
    "sell_propensity_factors": [
      {
        "name": "owner_occupied",
        "points": 8,
        "reason": "Owner-occupied — primary residence"
      },
      {
        "name": "years_owned",
        "points": 10,
        "reason": "Owned 17 years — significant equity likely"
      }
    ],
    "refi_propensity_score": 33,
    "refi_propensity_category": "Low",
    "refi_propensity_factors": [
      {
        "name": "high_equity",
        "points": 15,
        "reason": "High equity — strong candidate for cash-out refi"
      },
      {
        "name": "owner_occupied",
        "points": 8,
        "reason": "Owner-occupied — primary residence refinance more likely"
      },
      {
        "name": "years_owned",
        "points": 10,
        "reason": "Owned 17 years — likely has equity to tap"
      }
    ],
    "roof_renovate_propensity_score": 49,
    "roof_renovate_propensity_category": "Medium",
    "roof_renovate_propensity_factors": [
      {
        "name": "owner_occupied",
        "points": 15,
        "reason": "Owner-occupied — decision-maker present"
      },
      {
        "name": "high_equity",
        "points": 12,
        "reason": "High equity — affordability for $20K+ project"
      },
      {
        "name": "older_home",
        "points": 14,
        "reason": "Built 1978 — typical roof end-of-life window"
      }
    ],
    "hvac_renovate_propensity_score": 54,
    "hvac_renovate_propensity_category": "Medium",
    "hvac_renovate_propensity_factors": [
      {
        "name": "owner_occupied",
        "points": 18,
        "reason": "Owner-occupied — decision-maker present"
      },
      {
        "name": "older_home",
        "points": 16,
        "reason": "Built 1978 — HVAC typically replaced every 15-20 years"
      },
      {
        "name": "high_equity",
        "points": 12,
        "reason": "High equity — affordability for system upgrade"
      }
    ],
    "solar_renovate_propensity_score": 73,
    "solar_renovate_propensity_category": "High",
    "solar_renovate_propensity_factors": [
      {
        "name": "owner_occupied",
        "points": 20,
        "reason": "Owner-occupied — decision-maker for long-term install"
      },
      {
        "name": "high_equity",
        "points": 18,
        "reason": "High equity — financing or cash-out available for install"
      },
      {
        "name": "high_value_property",
        "points": 18,
        "reason": "Property value $485K — high-value home, sunny region"
      }
    ]
  },
  "owners": [
    {
      "first_name": "JANET",
      "last_name": "MORRIS",
      "age": "76"
    },
    {
      "first_name": "ROBERT",
      "last_name": "MORRIS",
      "age": "74"
    }
  ],
  "mailing_address": {
    "address": "4521 E Monte Cristo Ave",
    "city": "Phoenix",
    "state": "AZ",
    "zip": "85032"
  },
  "contacts": {
    "phones": [
      {
        "number": "4805551234",
        "type": "Mobile",
        "dnc": false,
        "tcpa": false,
        "carrier": "T-Mobile",
        "rank": 1
      },
      {
        "number": "4805559876",
        "type": "Mobile",
        "dnc": true,
        "tcpa": false,
        "carrier": "AT&T",
        "rank": 2
      },
      {
        "number": "4805550100",
        "type": "Landline",
        "dnc": false,
        "tcpa": false,
        "carrier": "CenturyLink",
        "rank": 3
      }
    ],
    "emails": [
      {
        "email": "janet.morris@example.com",
        "rank": 1
      }
    ],
    "litigator": false,
    "has_contact": true,
    "contact_clean": false
  },
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// Miss — address not found, 0 credits
{
  "hit": false,
  "credits_deducted": 0,
  "address": "999 Nowhere Blvd",
  "city": "Austin",
  "state": "TX",
  "zip_code": "78701",
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. Lead Builder lookup requires 10 credits per hit. You have 2 credits."
}
```

**403 — Account suspended (unpaid invoices)**

```json
{
  "error": "Your account has been temporarily suspended due to unpaid invoices. Please contact support@tracerfy.com to resolve outstanding payments."
}
```

**503 — Upstream temporarily unavailable**

```json
{
  "error": "Lookup service temporarily unavailable. Please try again."
}
```

**429 — Rate limit (500/min)**

```json
{
  "status": 429,
  "error": "Rate limit exceeded. Max 500 lookups per minute.",
  "lookups_in_window": 500
}
```

---

## POST Address Autocomplete

`POST /v1/api/property-search/autocomplete/`

Resolve a free-text address string to canonical property records. Use this **before** calling [/lookup/](#property-search-lookup) to validate that an address exists in our database — and to get back the canonical city/zip values our lookup endpoint expects.

**FREE — zero credits charged.** This is a pre-flight validation tool. Use it as much as needed before paying for a full lookup.

**When to use it**



- **Before /lookup/ on messy data:** CRM exports, hand-typed lists, web form submissions — any address you're not 100% sure about. Run it through autocomplete first; only pay for /lookup/ on resolved addresses.
- **Neighborhood-vs-USPS city:** Customers often type neighborhood names ("Williamsburg", "Park Slope", "Highland Park") that USPS canonicalizes to a different city label ("Long Island City", "Brooklyn", "Los Angeles"). Our /lookup/ endpoint requires the canonical city; this endpoint tells you what it is.
- **Typo / suffix variation:** "123 Main" vs "123 Main St" vs "123 Main Street" — autocomplete normalizes all to the canonical form.
- **Address verification at scale:** validating thousands of addresses without burning credits.

**Rate limit**

30 requests per minute per account. If you exceed this you'll get a **429 Too Many Requests** with an `Autocomplete rate limit exceeded` message — back off and retry. The throttle is purely a fair-use guard so individual accounts can't monopolize the underlying address-resolution capacity.
**What you get back**

An array of up to 10 best-match property records. Each record contains:



- **Display** — `title` (the full one-line label, e.g. `"742 Evergreen Terrace, Brooklyn, NY, 11211"`).
- **Canonical address parts** — `street_address`, `house`, `street`, `city`, `state`, `zip`, `county`. The `address` field is the full formatted display string (e.g. `"742 Evergreen Terrace, Brooklyn, NY, 11211"`) — do not re-pass it as `address` on /lookup/.
- **Geographic identifiers** — `state_fips`, `county_fips`, `fips` (combined 5-digit code), and `apn` (Assessor's Parcel Number). These are public US-government identifiers, useful for cross-referencing county records.
- **Geometry** — `latitude`, `longitude`, and `location` (WKT `POINT` format) for mapping.
If no matches, `results` is an empty array.

**Picking a result programmatically**

Every result is a property address, so `results[0]` is the best match. Pass `street_address` as `address`, and `city`, `state`, `zip` as-is to [/lookup/](#property-search-lookup):


```
# Pseudocode
match = resp["results"][0] if resp["results"] else None
if match:
    POST /v1/api/property-search/lookup/ {
        "address":  match["street_address"],   # NOT match["address"]
        "city":     match["city"],
        "state":    match["state"],
        "zip_code": match["zip"],
    }
```

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `search` | body | `string` | Yes | The address string to resolve. Minimum 2 characters. Whitespace and casing don't matter — the resolver handles both. |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/property-search/autocomplete/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"search": "742 Evergreen Terr Williamsburg NY"}'
```

### Example Response (200)

```json
{
  "query": "742 Evergreen Terr, Williamsburg NY",
  "credits_deducted": 0,
  "results": [
    {
      "title": "742 Evergreen Terrace, Brooklyn, NY, 11211",
      "address": "742 Evergreen Terrace, Brooklyn, NY, 11211",
      "street_address": "742 Evergreen Terrace",
      "house": "742",
      "street": "Evergreen Terrace",
      "city": "Brooklyn",
      "state": "NY",
      "zip": "11211",
      "county": "Kings County",
      "state_fips": "36",
      "county_fips": "047",
      "fips": "36047",
      "apn": "03145-0042",
      "latitude": 40.7081,
      "longitude": -73.9571,
      "location": "POINT (-73.9571 40.7081)"
    }
  ],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Missing search field**

```json
{
  "error": "Missing 'search' field. Pass {\"search\": \"<address text>\"} in the request body."
}
```

**429 — Autocomplete rate limit (30/min)**

```json
{
  "status": 429,
  "error": "Autocomplete rate limit exceeded. Max 30 requests per minute."
}
```

**503 — Upstream temporarily unavailable**

```json
{
  "error": "Address resolution service temporarily unavailable. Please try again."
}
```

---

## POST APN Autocomplete

`POST /v1/api/property-search/apn-autocomplete/`

Resolve a full or partial **Assessor's Parcel Number (APN)** to candidate parcels. **APNs are only unique within a single county.** Each county assessor numbers its parcels independently, so the very same APN value can — and often does — belong to completely different properties in other counties or states. Because of that the endpoint returns *every* matching parcel, each tagged with its `county`, `state`, and `zip` (when available) so you can pick the right one — see the two same-APN matches (Florida and Texas) in the example response below.

**FREE — zero credits charged.** A pre-flight resolver, like [Address Autocomplete](#property-search-autocomplete) but keyed on APN.

**When to use it**



- **APN typeahead:** power a parcel-search box where the user types an APN and picks the correct parcel from the returned matches.
- **Disambiguate a raw APN:** turn an APN pulled from a county record into a confirmed `county` / `state` / `zip`, which you can then use to scope a [property search](#property-search-preview).

**APN format:** the leading `#` is optional and is stripped automatically; other formatting (dashes, spaces) is passed through as-is.

**Rate limit**

30 requests per minute per account. Exceeding it returns **429 Too Many Requests** — back off and retry. The throttle is a fair-use guard so no single account monopolizes the parcel-resolution capacity.
**What you get back**

An array of up to 10 best-match parcels. Each record contains:



- **Parcel** — `apn` (Assessor's Parcel Number).
- **Location** — `county`, `state`, and `zip` (present when known). Use the most specific available to scope a search: ZIP if present, otherwise county + state.
- **Geographic identifiers** — `state_fips`, `county_fips`, and `fips` (combined 5-digit code). These are public US-government identifiers, useful for cross-referencing county records.
- **Geometry** — `latitude`, `longitude` for mapping.
If no matches, `results` is an empty array.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `search` | body | `string` | Yes | The APN to resolve. Minimum 2 characters. A leading '#' is optional and stripped automatically. |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/property-search/apn-autocomplete/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"search": "00424109000007550"}'
```

### Example Response (200)

```json
{
  "query": "00424109000007550",
  "credits_deducted": 0,
  "results": [
    {
      "apn": "00424109000007550",
      "county": "Palm Beach County",
      "state": "FL",
      "zip": "33401",
      "state_fips": "12",
      "county_fips": "099",
      "fips": "12099",
      "latitude": 26.7153,
      "longitude": -80.0534
    },
    {
      "apn": "00424109000007550",
      "county": "Harris County",
      "state": "TX",
      "zip": "77002",
      "state_fips": "48",
      "county_fips": "201",
      "fips": "48201",
      "latitude": 29.7604,
      "longitude": -95.3698
    }
  ],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Missing search field**

```json
{
  "error": "Missing 'search' field. Pass {\"search\": \"<apn>\"} in the request body."
}
```

**429 — Autocomplete rate limit (30/min)**

```json
{
  "status": 429,
  "error": "Autocomplete rate limit exceeded. Max 30 requests per minute."
}
```

**503 — Upstream temporarily unavailable**

```json
{
  "error": "Parcel resolution service temporarily unavailable. Please try again."
}
```

---

## POST Lead Builder Webhooks

`POST Account.webhook_url`

When a Lead Builder list completes, Tracerfy POSTs the result to the `webhook_url` configured on your account — the same account-level URL used for skip trace and DNC webhooks. This eliminates the need to poll [/status/](#property-search-status) — your server gets notified the moment the CSV is ready.

**How to use:** set your `webhook_url` in your account settings. When any lead list finishes (success or failure), Tracerfy sends a POST with the payload below. Your endpoint should return 2xx within 10 seconds.

**Retry:** Tracerfy does not retry failed webhook deliveries. If your server is down when the webhook fires, use [/status/](#property-search-status) as a fallback to check completion.

### Headers

| Name | Value |
|------|-------|
| `Content-Type` | `application/json` |

### Example Request

```bash
Tracerfy sends this JSON to your Account.webhook_url when a lead list completes.
```

### Example Response (200)

```json
{
  "id": 42,
  "type": "lead_list",
  "name": "Phoenix Q2 Prospects",
  "strategy": "high_equity_absentee",
  "source": "api",
  "created_at": "2026-04-11T18:23:00Z",
  "completed_at": "2026-04-11T18:37:42Z",
  "pending": false,
  "download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/lead_list_a1b2c3d4.csv",
  "requested_count": 500,
  "actual_count": 487,
  "credits_deducted": 2435
}
```

---

## POST AI Assist (TraceAI)

`POST /v1/api/property-search/ai-assist/`

Translate a plain-English description of your ideal customer into a structured `strategy` + `geography` + `filter_overrides` spec you can pipe straight into `/preview/` or `/execute/`. This is the fastest way to build a lead list from code — one call to describe, one call to run.

**Billing:** 1 credit per successful response. Failed calls (503) are not charged.

**When the AI isn't sure:** if your prompt is ambiguous ('Springfield', 'LA'), the response will include `needs_clarification: true`, a `clarifying_question`, and a `conversation_id`. To reply, pass the same `conversation_id` along with the user's answer in a new call — the AI loads the full conversation history and picks up where it left off.

**Conceptual questions** like "what is a tired landlord" return `needs_clarification: true` with the explanation in `rationale.summary` — don't run a search on those, ask the user where they want to target first.

**Neighborhood-level targeting:** say "plumbing leads in South Side Chicago" or "downtown Nashville probate" and TraceAI will pick the ZIP codes that cover the area from its general knowledge. No need to hand-roll ZIP lists.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `prompt` | body | `string` | Yes | Plain-English description of the target audience. 5-2000 characters. Example: 'plumbing leads in South Side Chicago' or 'absentee owners with 50%+ equity in Tampa built before 1990'. |
| `conversation_id` | body | `uuid` | No | UUID from a previous response. Pass this to continue a clarification thread — the AI loads all prior turns automatically. |

### Example Request

```bash
curl -X POST 'https://tracerfy.com/v1/api/property-search/ai-assist/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "plumbing leads in South Side Chicago"}'
```

### Example Response (200)

```json
// Successful — filters applied, ready to pipe into /preview/ or /execute/
{
  "strategy": "custom",
  "strategy_label": "Custom",
  "geography": {
    "mode": "zips",
    "zip_codes": [
      "60609",
      "60615",
      "60617",
      "60619",
      "60620",
      "60621"
    ]
  },
  "filter_overrides": {
    "property_type": "SFR",
    "year_built_max": 2000,
    "absentee_owner": false
  },
  "rationale": {
    "summary": "Owner-occupied single-family homes in the South Side Chicago ZIP codes built before 2000 — older plumbing systems are common in this age range.",
    "steps": [],
    "assumptions": [],
    "warnings": [
      "Applied Year Built ≤ 2000. To include rentals, remove the absentee-owner filter."
    ]
  },
  "confidence": 0.88,
  "needs_clarification": false,
  "clarifying_question": null,
  "conversation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "credits_deducted": 1,
  "meta": {
    "model": "traceai-1-20260321",
    "provider": "tracerfy",
    "prompt_version": "v1",
    "input_tokens": 0,
    "output_tokens": 0,
    "latency_ms": 842,
    "cached": false
  }
}

// Clarification needed — AI needs more info before it can search
{
  "strategy": "custom",
  "strategy_label": "Custom",
  "geography": {
    "mode": "city",
    "cities": [
      "(pending)"
    ]
  },
  "filter_overrides": {},
  "rationale": {
    "summary": "I can help find leads in Austin, but I need to know what kind. Investors, distressed sellers, homeowners for a service, or something else?",
    "steps": [],
    "assumptions": [],
    "warnings": []
  },
  "confidence": 0.3,
  "needs_clarification": true,
  "clarifying_question": "What kind of leads are you looking for? Are you targeting investors, distressed sellers, or homeowners for a specific service?",
  "conversation_id": "f9e8d7c6-b5a4-3210-fedc-ba9876543210",
  "credits_deducted": 1
}
```

### Error Responses

**400 — Missing / too-long prompt or bad conversation_id**

```json
// Empty prompt
{
  "error": "Missing 'prompt' field."
}

// Over 2000 characters
{
  "error": "Prompt too long (max 2000 characters)."
}

// conversation_id is not a UUID
{
  "error": "Invalid conversation_id — must be a UUID."
}
```

**402 — Insufficient credits**

```json
{
  "error": "Insufficient credits. You need at least 1 credit(s) to use AI assist. Your balance is 0 credits."
}
```

**502 — AI provider error (not charged)**

```json
{
  "error": "AI assist failed: upstream model error"
}
```

**503 — AI assist not configured on this server**

```json
{
  "error": "AI assist is not configured on this server.",
  "code": "ai_not_configured"
}
```

**500 — Unexpected error**

```json
{
  "error": "AI assist hit an unexpected error. Please try again.",
  "code": "ai_unexpected"
}
```

---

## REF Filter Reference

`REF Accepted keys for filter_overrides`

Every key accepted in `filter_overrides`, grouped for readability. Unknown keys are rejected with a 400, as are invalid values for keys that accept a fixed set (see `property_type` and `search_range` below).GroupKeysProperty`property_type` (string — one of `"SFR"`, `"MFR"`, `"LAND"`, `"CONDO"`, `"MOBILE"` (mobile/manufactured homes), or `"COMMERCIAL"`; any other value is rejected with a 400), `property_types` (array of those same values — 2 or more are combined into an OR query, e.g. `["SFR", "CONDO"]`), `beds_min`, `beds_max`, `baths_min`, `baths_max`, `units_min`, `units_max`, `building_size_min`, `building_size_max`, `lot_size_min`, `lot_size_max`, `year_built_min`, `year_built_max`, `stories_min`, `stories_max`, `rooms_min`, `rooms_max`, `pool`, `garage`, `basement`, `deck`, `mfh_2to4`, `mfh_5plus`Value & Equity`value_min`, `value_max`, `assessed_value_min`, `assessed_value_max`, `estimated_equity`, `estimated_equity_min`, `estimated_equity_max`, `equity`, `equity_operator`, `high_equity`, `free_clear`, `ltv_min`, `ltv_max`Ownership`absentee_owner` (boolean — `true` when the owner's mailing address differs from the property), `owner_occupied` (boolean — opposite of `absentee_owner`; `owner_occupied: true` is translated to `absentee_owner: false` before the upstream query, and the preview response echoes it back as `absentee_owner` in `filters_applied`. Sending both keys in the same request is rejected with a 400), `in_state_owner`, `out_of_state_owner`, `individual_owned`, `trust_owned`, `corporate_owned`, `cash_buyer`, `investor_buyer`, `private_lender`, `properties_owned_min`, `properties_owned_max`, `years_owned_min`, `years_owned_max`Portfolio signals`portfolio_value_min/max`, `portfolio_equity_min/max`, `portfolio_mortgage_balance_min/max`, `portfolio_purchased_last6_min/max`, `portfolio_purchased_last12_min/max`Distress`vacant`, `pre_foreclosure`, `pre_foreclosure_date_min`, `pre_foreclosure_date_max`, `foreclosure` (boolean — active foreclosure, further along than `pre_foreclosure`), `auction`, `reo`, `notice_type`, `tax_lien` (boolean — a tax lien is recorded against the property), `tax_delinquent_year_min`, `tax_delinquent_year_max` (int, year — window in which the owner became tax delinquent), `quit_claim` (boolean — last transfer recorded via quitclaim deed), `search_range` — pair this with `pre_foreclosure`, `auction`, or `reo` to restrict results to filings within the last N months. Without it, those filters return every historical match. Accepted values: `"1_MONTH"`, `"3_MONTH"`, `"6_MONTH"`.MLS`mls_active`, `mls_pending`, `mls_cancelled`, `mls_sold`, `mls_failed` (boolean — listing came off the market without selling), `mls_days_on_market_min`, `mls_days_on_market_max`, `mls_listing_price_min`Mortgage`mortgage_min`, `mortgage_max`, `adjustable_rate`, `assumable`, `loan_type_code_first`, `open_mortgages_min`, `open_mortgages_max`Sale history`last_sale_date_min`, `last_sale_date_max`, `last_sale_price_min`, `last_sale_price_max`, `last_sale_arms_length`Mailing address`mail_city`, `mail_state`, `mail_zip`, `mail_county`Environment`flood_zone`, `flood_zone_type`Area demographics`area_median_income_min`, `area_median_income_max` (number — median household income of the property's surrounding area). Accepted values: 1,000–99,999 — area income data ranges up to $99,999, so values outside that range are rejected with a 400. Use ONE bound per request — sending both in the same request is rejected with a 400.

---

## REF Propensity Scores

`REF Five scores included on every lead row`

Every row returned by [/rows/](#property-search-rows), [/lookup/](#property-search-lookup), and the CSV export carries five independent propensity scores. Each score quantifies how strongly the property's signals match a specific use case — selling, refinancing, roof replacement, HVAC replacement, or solar installation. The same property can score High in one and Low in another, so a single lead list can serve multiple downstream campaigns.

**Score range and interpretation**

Each score is an integer from `0` to `100`. The category column rolls the score up into one of three tiers using these thresholds:

Score rangeCategoryWhat it means**70–100****High**Multiple strong signals are present. Prioritize these leads first.**40–69****Medium**Some positive signals. Worth contacting but expect lower conversion than High.**0–39****Low**Few or weak signals for this use case. Skip unless you have other intent data.
**Recommended action thresholds**



- **Score ≥ 70 (High):** include in primary outreach. These are your best leads for the corresponding use case.
- **Score 50–69:** include in secondary outreach if your list is small, or as a backup pool when High leads run out.
- **Score 40–49:** typically skip unless you have additional context (local market knowledge, prior contact history, etc.).
- **Score < 40:** exclude from outreach for this use case. The lead may still be valuable for a different vertical with a higher score.

**Filtering by score in your code**

The score is a plain integer column, so post-filtering is straightforward in Excel, pandas, SQL, or any CRM:


```
# pandas
df_high_solar = df[df['solar_renovate_propensity_score'] >= 70]

# SQL
SELECT * FROM rows WHERE refi_propensity_score >= 50 ORDER BY refi_propensity_score DESC;

# Excel filter
AutoFilter on 'roof_renovate_propensity_category' = 'High'
```

**Score field schema**

Each of the 5 propensity verticals exposes 3 fields on every row:

VerticalUse caseScore fieldCategory fieldFactors field**Sell**Wholesalers, real estate investors`sell_propensity_score``sell_propensity_category``sell_propensity_factors`**Refinance**Mortgage brokers, lenders`refi_propensity_score``refi_propensity_category``refi_propensity_factors`**Roof renovate**Roofing contractors`roof_renovate_propensity_score``roof_renovate_propensity_category``roof_renovate_propensity_factors`**HVAC renovate**HVAC contractors`hvac_renovate_propensity_score``hvac_renovate_propensity_category``hvac_renovate_propensity_factors`**Solar renovate**Solar installers`solar_renovate_propensity_score``solar_renovate_propensity_category``solar_renovate_propensity_factors`
**The factors array — explainability**

Each `*_factors` field is a JSON array of `{name, points, reason}` objects describing exactly which signals fired and how much each contributed to the score. Use this to explain to your end-customer why a lead was prioritized, or to debug why a lead scored higher or lower than expected.

**Important notes**



- **Scores are deterministic snapshots** computed at the time the lead list was built. They are not refreshed automatically.
- **Same property, different verticals.** A property can score High for solar (owner-occupied, high-equity, sunny region) and Low for sell (no distress signals). This is expected and intentional — the scores measure different things.
- **The scores are signal-density indicators, not predictions.** A score of 80 means the lead matches more of the relevant signals than a lead at 40, not that it has an 80% probability of conversion. Use them to prioritize, not as a forecast.
- **Realistic precision target: 65–75%.** Of leads scored High, expect 65–75% to actually be receptive — better than random selection, but not a guarantee.

---

## GET · POST Saved Templates — List & Create

`GET · POST /v1/api/property-search/templates/`

A **template** is a saved, reusable lead-list configuration — a strategy, geography, and optional filter overrides you can re-run on demand or attach a [Monitor](#property-monitors-create) to. Templates are free to create and store; you're only billed when you actually build a list from one via [/execute/](#property-search-execute) (pass the template's `id` as `template_id`) or when a Monitor delivers.

**GET** returns your active templates. **POST** creates one. Templates are owner-scoped — you only ever see your own.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `name` | body | `string` | Yes | Label for the template (max 120 chars). |
| `strategy` | body | `string` | Yes | A preset key (or comma-separated keys) from [GET /filters/](#property-search-filters), or 'custom'. |
| `geography` | body | `object` | Yes | Same shape as [/execute/](#property-search-execute) — e.g. `{"mode": "city", "cities": ["Phoenix"], "states": ["AZ"]}`. |
| `filter_overrides` | body | `object` | No | Optional filters merged on top of the strategy. Validated against the same whitelist as /execute/. |

### Example Request

```bash
# Create a template
curl -X POST 'https://tracerfy.com/v1/api/property-search/templates/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Phoenix High-Equity Absentee",
    "strategy": "high_equity_absentee",
    "geography": {"mode": "city", "cities": ["Phoenix"], "states": ["AZ"]},
    "filter_overrides": {"year_built_max": 2015}
  }'

# List your templates
curl 'https://tracerfy.com/v1/api/property-search/templates/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (201)

```json
// POST — 201 Created
{
  "id": 7,
  "name": "Phoenix High-Equity Absentee",
  "strategy": "high_equity_absentee",
  "geography": {
    "mode": "city",
    "cities": [
      "Phoenix"
    ],
    "states": [
      "AZ"
    ]
  },
  "filter_overrides": {
    "year_built_max": 2015
  },
  "created_at": "2026-07-15T14:02:00Z",
  "updated_at": "2026-07-15T14:02:00Z",
  "last_run_at": null,
  "run_count": 0,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// GET — 200 (list)
{
  "templates": [
    {
      "id": 7,
      "name": "Phoenix High-Equity Absentee",
      "strategy": "high_equity_absentee",
      "geography": {
        "mode": "city",
        "cities": [
          "Phoenix"
        ],
        "states": [
          "AZ"
        ]
      },
      "filter_overrides": {
        "year_built_max": 2015
      },
      "created_at": "2026-07-15T14:02:00Z",
      "updated_at": "2026-07-15T14:02:00Z",
      "last_run_at": null,
      "run_count": 0
    }
  ],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**400 — Unknown strategy**

```json
{
  "strategy": [
    "Unknown strategy 'nope'. Valid options: call GET /v1/api/property-search/filters/"
  ]
}
```

---

## GET · PATCH · DELETE Template — Get, Update & Delete

`GET · PATCH · DELETE /v1/api/property-search/templates/<id>/`

Read, rename/retune, or remove a single saved template.

**GET** returns the template. **PATCH** updates any of `name`, `strategy`, `geography`, or `filter_overrides` (partial — send only the fields you're changing). **DELETE** soft-deletes it (returns `204`); it disappears from the list and future GETs return 404.

Editing or deleting a template **does not** affect any Monitor already created from it — Monitors snapshot their criteria at creation time. Cross-account IDs return 404.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `id` | path | `integer` | Yes | The template id. |
| `name` | body | `string` | No | (PATCH) New label. |
| `strategy` | body | `string` | No | (PATCH) New strategy key(s). |
| `geography` | body | `object` | No | (PATCH) New geography object. |
| `filter_overrides` | body | `object` | No | (PATCH) New overrides. |

### Example Request

```bash
# Rename
curl -X PATCH 'https://tracerfy.com/v1/api/property-search/templates/7/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"name": "Phoenix — Q3 Absentee"}'

# Delete (soft)
curl -X DELETE 'https://tracerfy.com/v1/api/property-search/templates/7/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
{
  "id": 7,
  "name": "Phoenix — Q3 Absentee",
  "strategy": "high_equity_absentee",
  "geography": {
    "mode": "city",
    "cities": [
      "Phoenix"
    ],
    "states": [
      "AZ"
    ]
  },
  "filter_overrides": {
    "year_built_max": 2015
  },
  "created_at": "2026-07-15T14:02:00Z",
  "updated_at": "2026-07-19T16:10:00Z",
  "last_run_at": null,
  "run_count": 0,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**204 — Deleted (no body)**

```json

```

**404 — Unknown or cross-account template**

```json
{
  "error": "Template not found."
}
```

---

## POST Create a Monitor

`POST /v1/api/property-monitors/`

A **Monitor** turns a lead-list configuration into a recurring, self-running subscription. On each scheduled run — **daily or weekly**, your choice — it computes the **delta** — matching properties in our property database that it hasn't delivered to you before — skip traces only those new ones, and delivers them as a CSV + [webhook](#property-monitors-create). If nothing new matched that run, nothing is delivered and nothing is charged.

**Billing: 25 credits per new delivered lead — you only pay when new matching properties are found.** A day with zero new matches costs zero.

**Two ways to create** (send exactly one form):

- **From a saved template:** pass `template_id`. The template's strategy + geography + overrides are snapshotted onto the Monitor at creation, so later editing or deleting the template never changes what the Monitor delivers.
- **Inline:** pass `strategy` + `geography` (+ optional `filter_overrides`), exactly like [/execute/](#property-search-execute).
Sending both forms, or neither, returns `400`. Up to **5 active monitors** per account (higher limits for enterprise/reseller accounts on request).

**Market size limit:** a monitor can track up to **5,000 matching properties**. If your strategy + geography matches more than that, creation returns `400` — narrow it (a tighter area, an equity band, a price range, or a property type).

**First run:** on creation we snapshot everything that already matches as your baseline — those existing properties are *not* delivered or charged. From then on you only receive properties that become new matches *after* you subscribed (a saved-search “new since” alert).

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |
| `Content-Type` | `application/json` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `template_id` | body | `integer` | No | Clone criteria from one of your saved templates. Mutually exclusive with the inline fields below. |
| `strategy` | body | `string` | No | Inline form: preset key(s) from [GET /filters/](#property-search-filters). Required when not using template_id. |
| `geography` | body | `object` | No | Inline form: same shape as /execute/. Required when not using template_id. |
| `filter_overrides` | body | `object` | No | Inline form: optional filters merged on top of the strategy. |
| `name` | body | `string` | No | Optional label. Defaults to the template's name when created from a template. |
| `frequency` | body | `string` | No | How often the monitor runs: `daily` or `weekly`. Defaults to `daily`. |
| `max_rows_per_run` | body | `integer` | No | Cap on new leads delivered per run. Default 500, max 25000. |
| `email_delivery` | body | `boolean` | No | Email you each delivery's CSV. Defaults to true (independent of your account email preference). |

### Example Request

```bash
# Inline form
curl -X POST 'https://tracerfy.com/v1/api/property-monitors/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "strategy": "high_equity_absentee",
    "geography": {"mode": "city", "cities": ["Phoenix"], "states": ["AZ"]},
    "filter_overrides": {"year_built_max": 2015},
    "name": "Phoenix High-Equity Absentee",
    "frequency": "weekly",
    "max_rows_per_run": 500,
    "email_delivery": true
  }'

# From a saved template (mutually exclusive with the inline fields)
curl -X POST 'https://tracerfy.com/v1/api/property-monitors/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"template_id": 7, "max_rows_per_run": 500}'
```

### Example Response (201)

```json
{
  "id": 12,
  "name": "Phoenix High-Equity Absentee",
  "strategy": "high_equity_absentee",
  "strategy_label": "High Equity Absentee",
  "geography": {
    "mode": "city",
    "cities": [
      "Phoenix"
    ],
    "states": [
      "AZ"
    ]
  },
  "geography_label": "Phoenix, AZ",
  "frequency": "daily",
  "max_rows_per_run": 500,
  "email_delivery": true,
  "credits_per_row": 25,
  "baseline_count": 1284,
  "baseline_ready": true,
  "status": "active",
  "last_run_at": null,
  "next_run_at": "2026-07-20T11:30:00Z",
  "error_message": "",
  "consecutive_failures": 0,
  "created_at": "2026-07-19T16:00:00Z",
  "last_delivery_count": null,
  "source": "api",
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Webhook Delivery

When a Monitor delivers, Tracerfy POSTs to your account [webhook_url](#property-search-webhooks) with a `lead_list` payload carrying `monitor_id` / `monitor_name` — non-null only for monitor deliveries, so you can tell them apart from one-shot lists and route them. The payload hands you both URLs directly: `download_url` for the CSV, and `rows_url` to pull structured rows as JSON — no second call to figure out where to pull. Example payload:


```
{
  "id": 8123,
  "type": "lead_list",
  "name": "Monitor: Phoenix High-Equity Absentee — Jul 20, 2026",
  "strategy": "high_equity_absentee",
  "monitor_id": 12,
  "monitor_name": "Phoenix High-Equity Absentee",
  "created_at": "2026-07-20T11:31:02Z",
  "completed_at": "2026-07-20T11:34:18Z",
  "pending": false,
  "download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/monitor_phoenix-high-equity-absentee_2026-07-20_a1b2c3d4.csv",
  "rows_url": "/v1/api/property-search/8123/rows/",
  "requested_count": 500,
  "actual_count": 37,
  "credits_deducted": 925
}
```

### Error Responses

**400 — Both forms supplied**

```json
{
  "non_field_errors": [
    "Provide EITHER template_id OR inline strategy+geography, not both."
  ]
}
```

**400 — Neither form supplied**

```json
{
  "non_field_errors": [
    "Provide either template_id or inline strategy+geography."
  ]
}
```

**400 — Active monitor cap reached**

```json
{
  "error": "You already have 5 active monitors (the maximum). Pause or delete one before creating another."
}
```

**403 — Account suspended (unpaid invoices)**

```json
{
  "error": "Your account has been temporarily suspended due to unpaid invoices. Please contact support@tracerfy.com to resolve outstanding payments."
}
```

**404 — template_id not found (or not yours)**

```json
{
  "error": "Template not found."
}
```

---

## GET List & Get Monitors

`GET /v1/api/property-monitors/`

**GET /monitors/** lists your monitors. **GET /monitors/<id>/** returns a single monitor with its schedule (`last_run_at`, `next_run_at`), lifecycle `status` (`active` / `paused` / `error`), resolved `credits_per_row`, and `last_delivery_count`. Owner-scoped; unknown or cross-account IDs return 404.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `id` | path | `integer` | No | Omit for the list; include for a single monitor. |

### Example Request

```bash
# List
curl 'https://tracerfy.com/v1/api/property-monitors/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'

# Detail
curl 'https://tracerfy.com/v1/api/property-monitors/12/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
// GET /monitors/ — 200 (list)
{
  "monitors": [
    {
      "id": 12,
      "name": "Phoenix High-Equity Absentee",
      "strategy": "high_equity_absentee",
      "strategy_label": "High Equity Absentee",
      "geography": {
        "mode": "city",
        "cities": [
          "Phoenix"
        ],
        "states": [
          "AZ"
        ]
      },
      "geography_label": "Phoenix, AZ",
      "frequency": "daily",
      "max_rows_per_run": 500,
      "email_delivery": true,
      "credits_per_row": 25,
      "baseline_count": 1284,
      "baseline_ready": true,
      "status": "active",
      "last_run_at": null,
      "next_run_at": "2026-07-20T11:30:00Z",
      "error_message": "",
      "consecutive_failures": 0,
      "created_at": "2026-07-19T16:00:00Z",
      "last_delivery_count": null,
      "source": "api"
    }
  ],
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}

// GET /monitors/12/ — 200 (detail)
{
  "id": 12,
  "name": "Phoenix High-Equity Absentee",
  "strategy": "high_equity_absentee",
  "strategy_label": "High Equity Absentee",
  "geography": {
    "mode": "city",
    "cities": [
      "Phoenix"
    ],
    "states": [
      "AZ"
    ]
  },
  "geography_label": "Phoenix, AZ",
  "frequency": "daily",
  "max_rows_per_run": 500,
  "email_delivery": true,
  "credits_per_row": 25,
  "baseline_count": 1284,
  "baseline_ready": true,
  "status": "active",
  "last_run_at": null,
  "next_run_at": "2026-07-20T11:30:00Z",
  "error_message": "",
  "consecutive_failures": 0,
  "created_at": "2026-07-19T16:00:00Z",
  "last_delivery_count": null,
  "source": "api",
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**404 — Unknown or cross-account monitor**

```json
{
  "error": "Monitor not found."
}
```

---

## POST · DELETE Pause, Resume & Delete

`POST · DELETE /v1/api/property-monitors/<id>/…`

Control a monitor's lifecycle:

- **POST /monitors/<id>/pause/** — pause the monitor. It stops running until you resume it, and keeps its history.
- **POST /monitors/<id>/resume/** — resume a paused monitor. It starts running again on its schedule.
- **DELETE /monitors/<id>/** — delete the monitor. It stops running and is removed from your account; the lead lists and CSVs it already delivered stay available. Returns `204`.
All three are owner-scoped; unknown or cross-account IDs return 404.

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `id` | path | `integer` | Yes | The monitor id. |

### Example Request

```bash
# Pause
curl -X POST 'https://tracerfy.com/v1/api/property-monitors/12/pause/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'

# Resume
curl -X POST 'https://tracerfy.com/v1/api/property-monitors/12/resume/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'

# Delete
curl -X DELETE 'https://tracerfy.com/v1/api/property-monitors/12/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
{
  "id": 12,
  "name": "Phoenix High-Equity Absentee",
  "strategy": "high_equity_absentee",
  "strategy_label": "High Equity Absentee",
  "geography": {
    "mode": "city",
    "cities": [
      "Phoenix"
    ],
    "states": [
      "AZ"
    ]
  },
  "geography_label": "Phoenix, AZ",
  "frequency": "daily",
  "max_rows_per_run": 500,
  "email_delivery": true,
  "credits_per_row": 25,
  "baseline_count": 1284,
  "baseline_ready": true,
  "status": "paused",
  "last_run_at": null,
  "next_run_at": "2026-07-20T11:30:00Z",
  "error_message": "",
  "consecutive_failures": 0,
  "created_at": "2026-07-19T16:00:00Z",
  "last_delivery_count": null,
  "source": "api",
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**204 — Deleted (no body)**

```json

```

**404 — Unknown or cross-account monitor**

```json
{
  "error": "Monitor not found."
}
```

---

## GET Monitor Delivery History (Runs)

`GET /v1/api/property-monitors/<id>/runs/`

Returns the lead lists a monitor has delivered, **newest first**. Each run is a normal Lead Builder list — poll or download it exactly like an /execute/ result. Every run carries a `rows_url` (pull structured rows as JSON) and a `download_url` (CSV) directly — you never have to build those URLs yourself. 

**Paginated — full history is always reachable.** The `500` is a *page-size* limit (the most runs a single response returns) — **not** a cap on how much history you can retrieve. There's no upper bound on `page`: every delivery a monitor has ever made stays retrievable. `per_page` defaults to 100 (max 500); increment `page` to walk older runs, and read `total_runs` / `total_pages` to know when you've reached the end. Newest first. Runs in progress show `status: "pending"` with an empty `download_url` (their `rows_url` returns `409` until the run finishes).

### Headers

| Name | Value |
|------|-------|
| `Authorization` | `Bearer <YOUR_TOKEN>` |

### Parameters

| Name | In | Type | Required | Description |
|------|-----|------|----------|-------------|
| `id` | path | `integer` | Yes | The monitor id. |
| `page` | query | `integer` | No | 1-based page number (newest first). Defaults to 1. |
| `per_page` | query | `integer` | No | Runs per *page* (response size — not a cap on total history). Defaults to 100, max 500. |

### Example Request

```bash
curl 'https://tracerfy.com/v1/api/property-monitors/12/runs/' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

### Example Response (200)

```json
{
  "runs": [
    {
      "id": 8123,
      "name": "Monitor: Phoenix High-Equity Absentee — Jul 20, 2026",
      "strategy": "high_equity_absentee",
      "strategy_label": "High Equity Absentee",
      "status": "complete",
      "created_at": "2026-07-20T11:31:02Z",
      "completed_at": "2026-07-20T11:34:18Z",
      "requested_count": 500,
      "actual_count": 37,
      "credits_deducted": 925,
      "monitor_id": 12,
      "monitor_name": "Phoenix High-Equity Absentee",
      "download_url": "https://tracerfy.nyc3.cdn.digitaloceanspaces.com/tracerfy/monitor_phoenix-high-equity-absentee_2026-07-20_a1b2c3d4.csv",
      "rows_url": "/v1/api/property-search/8123/rows/"
    }
  ],
  "total_runs": 128,
  "page": 1,
  "per_page": 100,
  "total_pages": 2,
  "meta": {
    "request_id": "req_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "timestamp": "2026-07-16T18:22:05Z",
    "api_version": "2026-03-21"
  }
}
```

### Error Responses

**404 — Unknown or cross-account monitor**

```json
{
  "error": "Monitor not found."
}
```

---

## REF Connect via AI Assistants (MCP)

`REF Model Context Protocol connector`

Connect Tracerfy to your AI assistant (e.g. Claude) via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) and run skip traces, DNC checks, and lead lists in plain English. Same billing as the API: **pay per hit**; misses cost nothing.

Generate a personal connector link in your profile under **Connect via MCP** (`https://mcp.tracerfy.com/u/<token>/mcp`) — the token in the URL authenticates as you, so keep it private. Connect it one of these ways:

- **Custom connector:** in your AI assistant's connector settings, add a custom connector and paste the link as the server URL — most MCP-capable assistants support this.
- **MCP config file** (MCP-compatible apps & IDEs): use the JSON below.
- **Programmatic API**: pass the connector in your request's `mcp_servers` — full example below (shown for the Claude API).
**Example prompts:**

- "Skip trace 123 Main St, Phoenix AZ and check the number against Do-Not-Call."
- "How many vacant, high-equity homes are in Dallas?"
- "Build me a list of 500 absentee owners in Miami-Dade."
- "What's my Tracerfy credit balance?"
**Available tools:**

- `start_trace_queue` — bulk normal, advanced, or enhanced trace queue from rows
- `trace_lookup` / `enhanced_trace_lookup` / `parcel_lookup` — standard owner contacts by address, enhanced owner or specific-person context, or parcel (APN) lookup
- `phone_verification` — phone carrier, line type, last-seen, DNC/TCPA flags, and compact associated-person context
- `dnc_check` — Do-Not-Call / TCPA compliance for a phone
- `lead_lookup` — full property + owner dossier for an address
- `preview_lead_list` (free) & `execute_lead_list` — size and build lead lists
- `get_lead_list_status` / `get_lead_list_rows` — track and fetch results
- `list_strategies`, `check_balance` — presets/filters and your credits (free)

### Example Request

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: mcp-client-2025-11-20" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Skip trace 123 Main St, Phoenix AZ and check the phone against Do-Not-Call."}
    ],
    "mcp_servers": [
      {
        "type": "url",
        "url": "https://mcp.tracerfy.com/u/&lt;token&gt;/mcp",
        "name": "tracerfy"
      }
    ],
    "tools": [
      {
        "type": "mcp_toolset",
        "mcp_server_name": "tracerfy"
      }
    ]
  }'
```

### Error Responses

**TypeScript (Anthropic SDK)**

```json
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const message = await client.beta.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Skip trace 123 Main St, Phoenix AZ and check the phone against Do-Not-Call." },
  ],
  mcp_servers: [
    { type: "url", url: "https://mcp.tracerfy.com/u/<token>/mcp", name: "tracerfy" },
  ],
  tools: [
    { type: "mcp_toolset", mcp_server_name: "tracerfy" },
  ],
  betas: ["mcp-client-2025-11-20"],
});

console.log(message.content);
```

**MCP config file (Claude Desktop & MCP-compatible clients)**

```json
{
  "mcpServers": {
    "tracerfy": {
      "url": "https://mcp.tracerfy.com/u/<token>/mcp"
    }
  }
}
```

---

## REF Reverse Append APIs — Phone, Email & Name Lookup

`REF https://app.fastappend.com/v1/api/ — FastAppend`

Start with a phone number, email address, or a person's name and location to find associated contact and address information. FastAppend supports both instant API lookups and bulk CSV workflows.

**Available reverse append APIs**

- `POST /v1/api/reverse-phone-append/lookup/` — look up a person from a phone number
- `POST /v1/api/reverse-email-append/lookup/` — look up a person from an email address
- `POST /v1/api/reverse-name-append/lookup/` — look up a person by name and location
- Bulk phone, email, and name append workflows are also available.
**FastAppend uses a separate account, API key, and credit balance.** To access these APIs, [create a FastAppend account](https://app.fastappend.com/auth/signup/), then purchase credits in the FastAppend portal. See the [complete FastAppend API documentation](https://app.fastappend.com/api-docs/) for authentication, request fields, examples, and responses.

---

## REF Business Trace API — Business & LLC Owner Lookup

`REF https://app.fastappend.com/v1/api/ — FastAppend`

Start with a business name and state to find business addresses and the people associated with that company, including available role and contact information. FastAppend supports an instant lookup API and a bulk CSV workflow.

**Available Business Trace APIs**

- `POST /v1/api/business-trace/lookup/` — look up one business synchronously
- `POST /v1/api/business-trace/` — submit a bulk Business Trace job
**FastAppend uses a separate account, API key, and credit balance.** To access these APIs, [create a FastAppend account](https://app.fastappend.com/auth/signup/), then purchase credits in the FastAppend portal. See the [complete FastAppend API documentation](https://app.fastappend.com/api-docs/) for authentication, request fields, examples, and responses.

---
