'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, Copy, Check } from 'lucide-react';
import { useState } from 'react';

export default function ApiDocsPage() {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const copyCode = (code: string, section: string) => {
    navigator.clipboard.writeText(code);
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const CodeBlock = ({ code, section }: { code: string; section: string }) => (
    <div className="relative">
      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
        <code>{code}</code>
      </pre>
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-2 right-2 text-gray-400 hover:text-white"
        onClick={() => copyCode(code, section)}
      >
        {copiedSection === section ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Link href="/settings/api-keys">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to API Keys
          </Button>
        </Link>
      </div>

      <div>
        <h1 className="text-3xl font-bold text-gray-900">PropTracerPRO API Documentation</h1>
        <p className="text-gray-500 mt-2">
          Complete guide for integrating PropTracerPRO with your applications
        </p>
      </div>

      {/* Authentication */}
      <Card>
        <CardHeader>
          <CardTitle>Authentication</CardTitle>
          <CardDescription>All API requests require authentication</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-gray-600">
            Include your API key in the <code className="bg-gray-100 px-1 rounded">Authorization</code> header:
          </p>
          <CodeBlock
            code={`Authorization: Bearer ptp_your_api_key_here`}
            section="auth"
          />
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p className="text-yellow-800 text-sm">
              <strong>Security:</strong> Keep your API key secret. Never expose it in client-side code or public repositories.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Base URL */}
      <Card>
        <CardHeader>
          <CardTitle>Base URL</CardTitle>
        </CardHeader>
        <CardContent>
          <CodeBlock
            code={`https://proptracerpro.vercel.app/api/v1`}
            section="base"
          />
        </CardContent>
      </Card>

      {/* Pricing */}
      <Card>
        <CardHeader>
          <CardTitle>What a Trace Costs</CardTitle>
          <CardDescription>Two ways to be charged, and which one you get depends on what you send</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-4">You send</th>
                  <th className="text-left py-2 pr-4">Charged</th>
                  <th className="text-left py-2 pr-4">Pro, AcquisitionPRO and Suite Gateway</th>
                  <th className="text-left py-2">Pay as you go</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-b">
                  <td className="py-2 pr-4">The owner of record</td>
                  <td className="py-2 pr-4">Per successful trace</td>
                  <td className="py-2 pr-4">$0.15</td>
                  <td className="py-2">$0.25</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">No owner, or you ask for the property record</td>
                  <td className="py-2 pr-4">Per record submitted</td>
                  <td className="py-2 pr-4">$0.25</td>
                  <td className="py-2">$0.40</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-gray-600 text-sm">
            When you give us the owner of record, you only pay when the trace comes back with a
            phone or an email. A miss costs you nothing.
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p className="text-amber-900 text-sm">
              A Full Property Trace is charged per record submitted, so the charge stands whether
              or not contacts come back. You can send an address, get no county parcel and no
              contacts, and still be charged for it. What you are buying is the lookup against the
              county record for that address, not a guaranteed result.
            </p>
          </div>
          <p className="text-gray-600 text-sm">
            Whether the owner is a person or a company decides which vendor runs the lookup. It
            never changes the price. There is no entity rate and no surcharge.
          </p>
          <p className="text-gray-600 text-sm">
            Results are kept for 90 days. Resubmitting an address you already traced,
            with the same owner name, returns your stored result and costs nothing.
            A different owner name, or an owner trace that found no contacts, is traced
            again, and you are charged only if contacts come back. Polling any status
            endpoint is free.
          </p>
        </CardContent>
      </Card>

      {/* Endpoints */}
      <Card>
        <CardHeader>
          <CardTitle>API Endpoints</CardTitle>
          <CardDescription>Available endpoints for skip tracing and full property traces</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Single Trace */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-mono">POST</span>
              <code className="text-sm font-semibold">/trace/single</code>
            </div>
            <p className="text-gray-600 text-sm">Trace a single property. Send the owner of record and you get a skip trace on that owner, finished inside the request. Leave it out and you get a Full Property Trace instead, which buys the county record for the property and then traces whoever it says owns it. A record with no city can be sent with its parcel ID and county instead.</p>

            <h5 className="font-medium text-sm">Request Body:</h5>
            <CodeBlock
              code={`{
  "address": "123 Main Street",
  "city": "Austin",
  "state": "TX",
  "zip": "78701",                 // optional
  "ownerName": "John Smith",      // optional. Leaving it out runs a Full Property Trace
  "apn": "0123-456-789",          // optional. The county parcel ID ("parcelId" is accepted too)
  "county": "Travis",             // optional. The county that parcel ID belongs to
  "fullPropertyTrace": false      // optional. Set true to get the property record anyway
}`}
              section="single-request"
            />

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
              <p className="text-blue-800 text-sm">
                <strong>Which one runs.</strong> If <code className="bg-blue-100 px-1 rounded">ownerName</code> is missing or blank, a Full Property Trace runs automatically. If you already have the owner but you want the county record too, send <code className="bg-blue-100 px-1 rounded">fullPropertyTrace: true</code>. The spelling <code className="bg-blue-100 px-1 rounded">full_property_trace</code> is accepted as well.
              </p>
              <p className="text-blue-800 text-sm">
                <strong>What a record needs.</strong> Every record needs a two-letter <code className="bg-blue-100 px-1 rounded">state</code>. A person also needs either a street and city, or the parcel ID with its county. So does a trust or a name we cannot read, unless no first name is left once the trust words are removed (for example &quot;Smith Family Trust&quot;). That one is looked up as a company, by name and state. A company needs only its name and state. A record with none of these comes back <code className="bg-blue-100 px-1 rounded">400</code> with <code className="bg-blue-100 px-1 rounded">outcomeCode: &quot;no_lookup_key&quot;</code> and a <code className="bg-blue-100 px-1 rounded">skipReason</code> that says what to add, and nothing is charged.
              </p>
              <p className="text-blue-800 text-sm">
                Both kinds of trace run start to finish inside the request and return the finished result, so give your HTTP client a timeout of at least 60 seconds. There is nothing to poll.
              </p>
            </div>

            <h5 className="font-medium text-sm">Response when you supplied the owner (already finished):</h5>
            <CodeBlock
              code={`{
  "success": true,
  "status": "success",
  "traceId": "uuid",
  "tier": 1,
  "charge": 0.15,
  "result": {
    "owner_name": "John Smith",
    "phones": [{ "number": "5125551234", "type": "mobile" }],
    "emails": ["john.smith@email.com"],
    "mailing_address": "456 Oak Ave, Austin, TX, 78702"
  },
  "propertyRecord": null,
  "ownerName": "John Smith",
  "ownerType": "individual",
  "needsManualReview": false,
  "foundBy": "address",
  "outcomeCode": "found_by_address",
  "skipReason": null,
  "warnings": []
}`}
              section="single-response"
            />

            <p className="text-gray-600 text-sm">
              You are charged only when at least one phone or email came back. For a person, the person returned must also match the owner name. <code className="bg-gray-100 px-1 rounded">foundBy</code> says which key found the owner: <code className="bg-gray-100 px-1 rounded">address</code>, <code className="bg-gray-100 px-1 rounded">parcel_id</code> or <code className="bg-gray-100 px-1 rounded">company_name</code>. When nothing came back, <code className="bg-gray-100 px-1 rounded">result</code> is <code className="bg-gray-100 px-1 rounded">null</code>, <code className="bg-gray-100 px-1 rounded">charge</code> is <code className="bg-gray-100 px-1 rounded">0</code> and <code className="bg-gray-100 px-1 rounded">skipReason</code> says why in one sentence. <code className="bg-gray-100 px-1 rounded">outcomeCode</code> is one of <code className="bg-gray-100 px-1 rounded">found_by_address</code>, <code className="bg-gray-100 px-1 rounded">found_by_parcel_id</code>, <code className="bg-gray-100 px-1 rounded">found_by_company_name</code>, <code className="bg-gray-100 px-1 rounded">no_match</code>, <code className="bg-gray-100 px-1 rounded">owner_name_not_matched</code>, <code className="bg-gray-100 px-1 rounded">no_lookup_key</code> or <code className="bg-gray-100 px-1 rounded">busy_try_again</code>.
            </p>

            <h5 className="font-medium text-sm">Response when a lookup service was busy (HTTP 503, header Retry-After: 300):</h5>
            <CodeBlock
              code={`{
  "success": false,
  "status": "error",
  "traceId": "uuid",
  "tier": 1,
  "charge": 0,
  "result": null,
  "foundBy": null,
  "outcomeCode": "busy_try_again",
  "skipReason": "The system is busy. Try again in 5 minutes. You were not charged.",
  "error": "The system is busy. Try again in 5 minutes. You were not charged."
}`}
              section="single-response-busy"
            />
            <p className="text-gray-600 text-sm">
              Send the same record again after five minutes. A resend within 24 hours picks up where the busy one stopped, so a lookup that already answered is not bought twice.
            </p>

            <h5 className="font-medium text-sm">Response from a Full Property Trace (already finished):</h5>
            <CodeBlock
              code={`{
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
  "propertyRecord": { /* the county record, over 60 fields */ },
  "ownerName": "John Smith",
  "ownerType": "individual",
  "needsManualReview": false,
  "warnings": []
}`}
              section="single-response-full"
            />

            <p className="text-gray-600 text-sm">
              <code className="bg-gray-100 px-1 rounded">status</code> is <code className="bg-gray-100 px-1 rounded">success</code> when contacts came back and <code className="bg-gray-100 px-1 rounded">no_match</code> when they did not. A <code className="bg-gray-100 px-1 rounded">no_match</code> here is still charged, and it usually still carries the property record, which is the thing you paid for. <code className="bg-gray-100 px-1 rounded">charge</code> is the amount actually taken from your wallet, so read it rather than assuming a rate. <code className="bg-gray-100 px-1 rounded">ownerType</code> is one of <code className="bg-gray-100 px-1 rounded">individual</code>, <code className="bg-gray-100 px-1 rounded">entity</code>, <code className="bg-gray-100 px-1 rounded">trust</code> or <code className="bg-gray-100 px-1 rounded">unknown</code>.
            </p>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-amber-900 text-sm font-semibold mb-1">Field names differ between these two endpoints, on purpose</p>
              <p className="text-amber-800 text-sm">
                The Full Property Trace response is camelCase: <code className="bg-amber-100 px-1 rounded">traceId</code>, <code className="bg-amber-100 px-1 rounded">propertyRecord</code>, <code className="bg-amber-100 px-1 rounded">ownerName</code>, <code className="bg-amber-100 px-1 rounded">ownerType</code>, <code className="bg-amber-100 px-1 rounded">needsManualReview</code>. The status endpoint below is snake_case: <code className="bg-amber-100 px-1 rounded">trace_id</code>, <code className="bg-amber-100 px-1 rounded">is_cached</code>. So are the webhooks. Write your parser against the endpoint you are actually calling. Code that assumes one convention across the whole API will read undefined on half of it.
              </p>
            </div>

            <h5 className="font-medium text-sm">Response from a cached address (free):</h5>
            <CodeBlock
              code={`{
  "success": true,
  "cached": true,
  "charge": 0,
  "traceId": "uuid",
  "result": { "owner_name": "John Smith", "phones": [], "emails": [] },
  "propertyRecord": { /* present if this address was a Full Property Trace */ },
  "tier": 2
}`}
              section="single-response-cached"
            />

            <p className="text-gray-600 text-sm">
              A Full Property Trace you already paid for comes back free even when it found nothing, because the answer that the county has no parcel at that address is the answer you bought. Running it again would charge you twice for the same absence.
            </p>
          </div>

          <hr />

          {/* Trace Status */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs font-mono">GET</span>
              <code className="text-sm font-semibold">/trace/status?trace_id=uuid</code>
            </div>
            <p className="text-gray-600 text-sm">Read a trace back by its id. Every trace now finishes inside its own request, so you only need this for a trace id you already hold, including one sent before this change. Reading is free.</p>

            <h5 className="font-medium text-sm">Response (completed):</h5>
            <CodeBlock
              code={`{
  "success": true,
  "status": "success",
  "trace_id": "uuid",
  "result": {
    "owner_name": "John Smith",
    "phones": [
      { "number": "5125551234", "type": "mobile" }
    ],
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
}`}
              section="status-response"
            />

            <p className="text-gray-600 text-sm">
              Status values are <code className="bg-gray-100 px-1 rounded">processing</code>, <code className="bg-gray-100 px-1 rounded">success</code>, <code className="bg-gray-100 px-1 rounded">no_match</code> and <code className="bg-gray-100 px-1 rounded">error</code>. A <code className="bg-gray-100 px-1 rounded">no_match</code> here means we looked and found no contacts, and it is free. <code className="bg-gray-100 px-1 rounded">charge</code> is what your wallet actually paid, so the figure above is one account&apos;s example and not a rate for everyone. See the pricing table at the top of this page.
            </p>

            <p className="text-gray-600 text-sm">
              <code className="bg-gray-100 px-1 rounded">research</code> is a stored field that carries the business-trace record on rows that have one, and is <code className="bg-gray-100 px-1 rounded">null</code> on a plain person trace. Do not build a workflow that depends on it being filled in.
            </p>

            <h5 className="font-medium text-sm">Response (still processing):</h5>
            <CodeBlock
              code={`{
  "success": true,
  "status": "processing",
  "trace_id": "uuid",
  "tracerfy_state": "pending",
  "age_minutes": 2
}`}
              section="status-processing"
            />

            <p className="text-gray-600 text-sm">
              Poll every 10 to 30 seconds. Intervals under 10 seconds add load without making anything finish sooner.
            </p>
          </div>

          <hr />

          {/* Deferred business trace status */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs font-mono">GET</span>
              <code className="text-sm font-semibold">/research/status?job_id=&#123;id&#125;</code>
            </div>
            <p className="text-gray-600 text-sm">
              Poll one deferred business-trace job by id. Despite the word in the path this is not a research endpoint: it reads a FastAppend business-trace job and reports what that job settled to. You reach it when a bulk record comes back carrying <code className="bg-gray-100 px-1 rounded">business_trace_pending: true</code> and a <code className="bg-gray-100 px-1 rounded">business_trace_job_id</code>. Pass that id here. Polling is free.
            </p>

            <h5 className="font-medium text-sm">Response (still pending):</h5>
            <CodeBlock
              code={`{
  "success": true,
  "job_id": "3f9c...9af2",
  "status": "pending",
  "business_name": "Extra Space Storage",
  "address": "160 MINE LAKE CT STE 200",
  "city": "RALEIGH",
  "state": "NC",
  "zip": "27615",
  "contacts": null,
  "research": null,
  "error_message": null,
  "created_at": "2026-09-14T18:00:00.000Z",
  "completed_at": null
}`}
              section="business-trace-status-pending"
            />

            <h5 className="font-medium text-sm">Response (completed):</h5>
            <CodeBlock
              code={`{
  "success": true,
  "job_id": "3f9c...9af2",
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
}`}
              section="business-trace-status-done"
            />

            <div className="bg-gray-50 border rounded-lg p-4">
              <p className="text-gray-700 text-sm">
                <strong>Status values:</strong> <code className="bg-gray-100 px-1 rounded">pending</code> means keep polling, <code className="bg-gray-100 px-1 rounded">completed</code> means contacts were found and <code className="bg-gray-100 px-1 rounded">contacts</code> is populated, <code className="bg-gray-100 px-1 rounded">no_match</code> means the lookup finished and found nobody for that business, and <code className="bg-gray-100 px-1 rounded">error</code> means it failed or timed out. <code className="bg-gray-100 px-1 rounded">contacts</code> is null on anything other than completed. Treat <code className="bg-gray-100 px-1 rounded">no_match</code> as an answer, not an error.
              </p>
            </div>
          </div>

          <hr />

          {/* Bulk Trace */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-mono">POST</span>
              <code className="text-sm font-semibold">/trace/bulk</code>
            </div>
            <p className="text-gray-600 text-sm">Submit multiple addresses for batch skip tracing. Maximum 10,000 records per request. Bulk needs the owner of record on every row: it does not run Full Property Traces.</p>

            <h5 className="font-medium text-sm">Request Body:</h5>
            <CodeBlock
              code={`{
  "records": [
    {
      "address": "123 Main Street",
      "city": "Austin",
      "state": "TX",
      "zip": "78701",                    // optional
      "owner_name": "John Smith",        // the owner of record. Send it
      "mailing_address": "456 Oak Ave"   // optional, falls back to property address
    },
    {
      "address": "500 Commerce Blvd",
      "city": "Houston",
      "state": "TX",
      "owner_name": "Acme Holdings LLC"
    }
  ],
  "webhookUrl": "https://your-app.com/webhook"  // optional, overrides profile setting
}`}
              section="bulk-request"
            />

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-blue-800 text-sm">
                <strong>Required fields:</strong> <code className="bg-blue-100 px-1 rounded">address</code>, <code className="bg-blue-100 px-1 rounded">city</code>, <code className="bg-blue-100 px-1 rounded">state</code>. Optional: <code className="bg-blue-100 px-1 rounded">zip</code>, <code className="bg-blue-100 px-1 rounded">mailing_address</code>. <code className="bg-blue-100 px-1 rounded">owner_name</code> is optional. A row without one still runs, as a full property trace on a different billing model, which the note below covers.
              </p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-amber-900 text-sm font-semibold mb-1">Rows with no owner name run a full property trace, and they are billed</p>
              <p className="text-amber-800 text-sm">
                They used to be skipped and free. They are not any more. We look up the county property record to find the owner, then go after their contacts, so you do not need to supply the owner yourself. That work is charged for every record you send rather than only when we find contacts, so those rows cost the same whether or not anything comes back. The submit response counts them in <code className="bg-amber-100 px-1 rounded">recordsQueued</code>, which replaced <code className="bg-amber-100 px-1 rounded">recordsSkipped</code> and <code className="bg-amber-100 px-1 rounded">skippedReason</code>. Those two keys are gone rather than zeroed, because this endpoint no longer skips anything: a whole batch is rejected up front if any record is missing the street, city or state.
              </p>
            </div>

            <div className="bg-gray-50 border rounded-lg p-4">
              <p className="text-gray-700 text-sm">
                <strong>Deduplication:</strong> Records are automatically deduplicated within the batch and against your 90-day trace history. Duplicate records are removed before processing and not charged. The response shows how many duplicates were removed. If every record was a duplicate, <code className="bg-gray-100 px-1 rounded">jobId</code> comes back <code className="bg-gray-100 px-1 rounded">null</code> and there is nothing to poll.
              </p>
            </div>

            <h5 className="font-medium text-sm">Response:</h5>
            <CodeBlock
              code={`{
  "success": true,
  "jobId": "uuid",
  "totalRecords": 100,
  "duplicatesRemoved": 5,
  "recordsToProcess": 95,
  "recordsDirectTrace": 80,
  "recordsPendingResearch": 12,
  "recordsQueued": 3,
  "recordsFailed": 0,
  "estimatedCost": 13.80,
  "status": "processing",
  "message": "Poll /api/v1/trace/bulk/status?job_id=uuid for results."
}`}
              section="bulk-response"
            />

            <p className="text-gray-600 text-sm">
              <code className="bg-gray-100 px-1 rounded">recordsDirectTrace</code> is the rows whose owner looks like a person, sent straight to the person skip trace. <code className="bg-gray-100 px-1 rounded">recordsPendingResearch</code> is the rows whose owner looks like a company, queued for a background business trace that finds the human behind it. That field keeps its old name so existing integrations do not break. <code className="bg-gray-100 px-1 rounded">recordsSkipped</code> is the rows that arrived with no owner name.
            </p>

            <p className="text-gray-600 text-sm">
              <code className="bg-gray-100 px-1 rounded">estimatedCost</code> is the worst case: every traceable row matching, at your plan&apos;s per-successful-trace rate. Skipped rows are left out of it because they can never be charged. Your wallet has to cover that worst case at submit time or the job is refused with a 402, and your actual bill after completion is normally lower. Resolving the human behind a company costs the same as tracing a person. There is no separate fee for it.
            </p>
          </div>

          <hr />

          {/* Get Job Status */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs font-mono">GET</span>
              <code className="text-sm font-semibold">/trace/bulk/status?job_id=uuid</code>
            </div>
            <p className="text-gray-600 text-sm">Poll for bulk trace job results. Returns per-record results when all records have been processed. Polling is free.</p>

            <h5 className="font-medium text-sm">Response (completed):</h5>
            <CodeBlock
              code={`{
  "success": true,
  "status": "completed",
  "job_id": "uuid",
  "records_submitted": 95,
  "records_matched": 82,
  "total_charge": 12.30,
  "error_message": null,
  "results": [
    {
      "address": "160 MINE LAKE CT|RALEIGH|NC",
      "city": "RALEIGH",
      "state": "NC",
      "zip": "27615",
      "status": "success",
      "input_owner_name": "Extra Space Storage LLC",   // the COMPANY you asked about
      "owner_contact_name": "Joseph Margolis",         // the PERSON resolved behind it
      "result": {
        "owner_name": "Joseph Margolis",
        "phones": [{ "number": "9196249818", "type": "mobile" }],
        "emails": ["owner@example.com"]
      },
      "research": { /* the stored record for this row, or null */ },
      "contacts": {
        "owner_name": "Joseph Margolis",
        "phones": [ /* ... */ ],
        "emails": [ /* ... */ ]
      },
      "skip_reason": null,
      "charge": 0.15,
      "ai_research_charge": 0,
      "business_trace_pending": false,
      "business_trace_job_id": null
    },
    {
      "address": "123 MAIN ST|AUSTIN|TX",
      "city": "AUSTIN",
      "state": "TX",
      "zip": "78701",
      "status": "no_match",
      "input_owner_name": null,
      "owner_contact_name": null,
      "result": null,
      "research": null,
      "contacts": null,
      "property_record": { "assessed_value": 412000, "year_built": 1974 },
      "tier": 2,
      "skip_reason": "We found the property record for this address and saved it with your results, but we could not reach the service that looks up contacts, so no phone numbers or emails came back for it. You were charged for it, because a full property trace is charged for every record you send rather than only when contacts come back.",
      "charge": 0.40,
      "ai_research_charge": 0,
      "business_trace_pending": false,
      "business_trace_job_id": null
    }
    // ... one entry per submitted record
  ]
}`}
              section="job-status"
            />

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-amber-900 text-sm font-semibold mb-1">Read skip_reason before you read status</p>
              <p className="text-amber-800 text-sm">
                Such a row settles to <code className="bg-amber-100 px-1 rounded">status: &quot;no_match&quot;</code> so the job can finish, but that is not what happened to it. <code className="bg-amber-100 px-1 rounded">skip_reason</code> is the field that tells you the truth, and it is the one to check first on any row that came back empty. Read it out as it stands rather than calling the row a no match. Do not assume it means the row was free: most of these rows were never traced and were not charged, but one of them is a full property trace that was charged and whose contact lookup could not be completed, and the sentence itself says which. It is <code className="bg-amber-100 px-1 rounded">null</code> on every row a vendor was actually asked about and answered for.
              </p>
            </div>

            <p className="text-gray-600 text-sm">
              <code className="bg-gray-100 px-1 rounded">input_owner_name</code> is the company or person you asked about. <code className="bg-gray-100 px-1 rounded">owner_contact_name</code> is the human we resolved behind it, and it is the point of the trace. It comes back <code className="bg-gray-100 px-1 rounded">null</code> when no human was resolved, never the company name. Mapping a column called owner name and stopping at the first one is how a run of resolved people ends up as a sheet of company names.
            </p>

            <p className="text-gray-600 text-sm">
              <code className="bg-gray-100 px-1 rounded">charge</code> is what was actually billed for that row, which is 0 on a miss and 0 on a skip. <code className="bg-gray-100 px-1 rounded">ai_research_charge</code> is a legacy field and is always 0. It is kept so existing parsers do not break. There is no separate research fee.
            </p>

            <h5 className="font-medium text-sm">Response (still processing):</h5>
            <CodeBlock
              code={`{
  "success": true,
  "status": "processing",
  "job_id": "uuid",
  "records_submitted": 95,
  "records_pending_research": 12,
  "records_pending_trace": 41,
  "tracerfy_state": "pending",
  "age_minutes": 4
}`}
              section="job-status-processing"
            />

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-blue-800 text-sm">
                <strong>Polling:</strong> Poll every 30 to 60 seconds. A batch that is mostly person rows settles as fast as the trace vendor returns. A company-heavy batch takes longer, because those rows run on a background worker that takes 5 rows a minute, so 300 company rows is about an hour of queue before the last one is even attempted. <code className="bg-blue-100 px-1 rounded">records_pending_research</code> counts company rows whose business trace has not settled, and <code className="bg-blue-100 px-1 rounded">records_pending_trace</code> counts rows the trace vendor has not returned yet. The job stays in <code className="bg-blue-100 px-1 rounded">processing</code> while either is above zero. You are only charged for successful matches, meaning rows where a phone or an email was found. If you have a webhook URL configured, you&apos;ll also receive a <code className="bg-blue-100 px-1 rounded">bulk_job.completed</code> event when done.
              </p>
              <p className="text-blue-800 text-sm mt-2">
                <strong>Stuck-job auto-recovery:</strong> If a background worker is killed mid-run by a server timeout, an out-of-memory kill or a deploy restart, its row is automatically reverted to <code className="bg-blue-100 px-1 rounded">queued</code> within 5 minutes and retried on the next tick, so the job finalises on a later poll. There is no need to implement your own &quot;assume failure after N minutes&quot; fallback.
              </p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-amber-900 text-sm font-semibold mb-1">Pending business-trace contacts on completed bulks</p>
              <p className="text-amber-800 text-sm">
                A bulk job can finalise as <code className="bg-amber-100 px-1 rounded">completed</code> while individual records still have an open business-trace lookup. Those records carry <code className="bg-amber-100 px-1 rounded">business_trace_pending: true</code> and a <code className="bg-amber-100 px-1 rounded">business_trace_job_id</code>. Retrieve the delayed contacts via <code className="bg-amber-100 px-1 rounded">GET /api/v1/research/status?job_id=&#123;business_trace_job_id&#125;</code> (see the section above) or by listening for a <code className="bg-amber-100 px-1 rounded">business_trace.completed</code> webhook.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Integration Examples */}
      <Card>
        <CardHeader>
          <CardTitle>Integration Examples</CardTitle>
          <CardDescription>Copy-paste examples for popular platforms</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="n8n" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="n8n">n8n</TabsTrigger>
              <TabsTrigger value="make">Make</TabsTrigger>
              <TabsTrigger value="highlevel">HighLevel</TabsTrigger>
              <TabsTrigger value="curl">cURL</TabsTrigger>
            </TabsList>

            <TabsContent value="highlevel" className="space-y-4 mt-4">
              <h4 className="font-semibold">HighLevel Workflow Integration</h4>
              <p className="text-gray-600 text-sm">
                Use HighLevel&apos;s HTTP Request action in workflows to trace properties.
              </p>

              <div className="space-y-2">
                <p className="font-medium text-sm">1. Add HTTP Request Action</p>
                <CodeBlock
                  code={`Method: POST
URL: https://proptracerpro.vercel.app/api/v1/trace/single

Headers:
  Authorization: Bearer ptp_your_api_key
  Content-Type: application/json

Body (JSON):
{
  "address": "{{contact.address1}}",
  "city": "{{contact.city}}",
  "state": "{{contact.state}}",
  "zip": "{{contact.postal_code}}",
  "ownerName": "{{contact.full_name}}"
}`}
                  section="highlevel"
                />
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm">2. Use Response Data</p>
                <p className="text-gray-600 text-sm">
                  Map the response to contact fields:
                </p>
                <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
                  <li><code>result.phones[0].number</code> goes to the Phone field</li>
                  <li><code>result.emails[0]</code> goes to the Email field</li>
                  <li><code>result.mailing_address</code> goes to Mailing Address</li>
                  <li><code>result.mailing_city</code> goes to Mailing City</li>
                  <li><code>result.mailing_state</code> goes to Mailing State</li>
                  <li><code>result.mailing_zip</code> goes to Mailing Zip</li>
                </ul>
              </div>
            </TabsContent>

            <TabsContent value="make" className="space-y-4 mt-4">
              <h4 className="font-semibold">Make (Integromat), automated workflow</h4>
              <p className="text-gray-600 text-sm">
                Create a scenario with HTTP modules for the full automated pipeline.
              </p>

              <div className="space-y-2">
                <p className="font-medium text-sm">Module 1: Submit the trace</p>
                <CodeBlock
                  code={`Module: HTTP - Make a request

URL: https://proptracerpro.vercel.app/api/v1/trace/single
Method: POST

Headers:
  Authorization: Bearer ptp_your_api_key
  Content-Type: application/json

Body type: Raw
Content type: JSON (application/json)

Request content:
{
  "address": "{{1.address}}",
  "city": "{{1.city}}",
  "state": "{{1.state}}",
  "zip": "{{1.zip}}",
  "ownerName": "{{1.owner_name}}"
}

Parse response: Yes
Timeout: 90 seconds

// Drop ownerName to run a Full Property Trace instead. Either way the
// response is the finished result.`}
                  section="make-step1"
                />
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-800 text-sm">
                  <strong>Tip:</strong> Module 1 returns the finished result whichever tier ran, so there is no job to poll. Put a Router after it to handle <code className="bg-blue-100 px-1 rounded">success</code>, <code className="bg-blue-100 px-1 rounded">no_match</code> and <code className="bg-blue-100 px-1 rounded">busy_try_again</code> (run that record again after five minutes). Nothing goes to your CRM on its own, so either send the result on to your CRM from here or press Add to CRM on it in PropTracerPRO.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="n8n" className="space-y-4 mt-4">
              <h4 className="font-semibold">n8n, full automated workflow</h4>
              <p className="text-gray-600 text-sm">
                County records in, owner and contact data out. Send the owner of record when you have it and pay the per-successful-trace rate. Leave it out and a Full Property Trace runs instead, which buys the county record and is charged per record submitted.
              </p>

              <div className="space-y-2">
                <p className="font-medium text-sm">Step 1: Submit the trace</p>
                <CodeBlock
                  code={`// HTTP Request Node, POST
URL: https://proptracerpro.vercel.app/api/v1/trace/single
Headers: Authorization: Bearer ptp_your_api_key
Timeout: 90000 ms

Body (JSON):
{
  "address": "={{ $json.address }}",
  "city": "={{ $json.city }}",
  "state": "={{ $json.state }}",
  "zip": "={{ $json.zip }}",
  "ownerName": "={{ $json.owner_name }}"
}

// Drop ownerName and a Full Property Trace runs instead. Either way
// this same response is the finished result.`}
                  section="n8n-step1"
                />
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm">Step 2: Use the results</p>
                <CodeBlock
                  code={`// From the response:
{{ $json.result.phones[0].number }}   -> Owner phone
{{ $json.result.emails[0] }}          -> Owner email
{{ $json.result.owner_name }}         -> Owner name

// Full Property Trace only, and camelCase on this response:
{{ $json.ownerType }}                 -> individual, entity, trust or unknown
{{ $json.propertyRecord.county }}     -> County on the parcel record
{{ $json.propertyRecord.assessed_value }} -> County tax assessment, not a market value
{{ $json.charge }}                    -> What your wallet actually paid

// Nothing is pushed to HighLevel on its own, whichever tier ran.
// Send the result on from here, or press Add to CRM in PropTracerPRO.
// Webhook fires automatically when a trace completes`}
                  section="n8n-step3"
                />
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-800 text-sm">
                  <strong>Tip:</strong> Store your API key in n8n Credentials as &quot;Header Auth&quot; for better security. You can also use webhooks instead. Configure your webhook URL in Settings.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="curl" className="space-y-4 mt-4">
              <h4 className="font-semibold">cURL Examples</h4>

              <div className="space-y-2">
                <p className="font-medium text-sm">Trace an owner you already have:</p>
                <CodeBlock
                  code={`curl -X POST https://proptracerpro.vercel.app/api/v1/trace/single \\
  -H "Authorization: Bearer ptp_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "address": "123 Main Street",
    "city": "Austin",
    "state": "TX",
    "zip": "78701",
    "ownerName": "John Smith"
  }'`}
                  section="curl-trace"
                />
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm">Read a trace back by id:</p>
                <CodeBlock
                  code={`curl "https://proptracerpro.vercel.app/api/v1/trace/status?trace_id=YOUR_TRACE_ID" \\
  -H "Authorization: Bearer ptp_your_api_key"`}
                  section="curl-status"
                />
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm">Full Property Trace (no owner name, returns the finished result):</p>
                <CodeBlock
                  code={`curl --max-time 90 -X POST https://proptracerpro.vercel.app/api/v1/trace/single \\
  -H "Authorization: Bearer ptp_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "address": "123 Main Street",
    "city": "Austin",
    "state": "TX",
    "zip": "78701"
  }'`}
                  section="curl-full-property-trace"
                />
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm">Full Property Trace when you already have the owner:</p>
                <CodeBlock
                  code={`curl --max-time 90 -X POST https://proptracerpro.vercel.app/api/v1/trace/single \\
  -H "Authorization: Bearer ptp_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "address": "123 Main Street",
    "city": "Austin",
    "state": "TX",
    "zip": "78701",
    "ownerName": "John Smith",
    "fullPropertyTrace": true
  }'`}
                  section="curl-full-property-trace-optin"
                />
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm">Bulk trace (submit batch):</p>
                <CodeBlock
                  code={`curl -X POST https://proptracerpro.vercel.app/api/v1/trace/bulk \\
  -H "Authorization: Bearer ptp_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "records": [
      { "address": "123 Main St", "city": "Austin", "state": "TX", "zip": "78701", "owner_name": "John Smith" },
      { "address": "456 Oak Ave", "city": "Houston", "state": "TX", "owner_name": "Acme Holdings LLC" }
    ]
  }'`}
                  section="curl-bulk"
                />
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm">Poll bulk job status:</p>
                <CodeBlock
                  code={`curl "https://proptracerpro.vercel.app/api/v1/trace/bulk/status?job_id=YOUR_JOB_ID" \\
  -H "Authorization: Bearer ptp_your_api_key"`}
                  section="curl-bulk-status"
                />
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Property Record */}
      <Card>
        <CardHeader>
          <CardTitle>What Is In the Property Record</CardTitle>
          <CardDescription>The county record a Full Property Trace buys for the address</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-gray-600 text-sm">
            The record carries over 60 fields. What is in yours depends on what that county
            publishes. Coverage varies by county and by state, so treat every field as optional and
            never assume one is populated.
          </p>
          <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
            <li>Location and identity: address, county, parcel number, subdivision, property type, property use, land use, latitude and longitude</li>
            <li>Building and land: year built, stories, units, building size, lot size, beds, baths, roof material and construction, and features such as air conditioning, garage, pool, basement and deck</li>
            <li>Valuation: assessed value, area median income</li>
            <li>Sale and transaction history: last sale date and price, sale price per square foot, recording date, document type, prior sale date and price</li>
            <li>Listing history: days on market, listing price, and the MLS state</li>
            <li>Debt: open mortgage balance, lender, estimated mortgage payment</li>
            <li>Owner and occupancy: years owned, properties owned, portfolio value, and whether the record marks the owner absentee, owner-occupied, an investor buyer or a cash buyer</li>
            <li>Recorded status flags, carried through when the county records them</li>
          </ul>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p className="text-amber-900 text-sm">
              <code className="bg-amber-100 px-1 rounded">assessed_value</code> is the county&apos;s
              assessment for tax purposes. It is not a market value, it is not an appraisal, and it
              is not an estimate of what the property would sell for. Do not present it to an end
              user as any of those.
            </p>
          </div>
          <p className="text-gray-600 text-sm">
            A field the county did not publish is simply absent. There is no placeholder, no zero
            standing in for a missing number and no &quot;N/A&quot;.
          </p>
        </CardContent>
      </Card>

      {/* Webhook Events */}
      <Card>
        <CardHeader>
          <CardTitle>Webhook Events</CardTitle>
          <CardDescription>Receive trace results when traces complete</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-gray-600 text-sm">
            Configure your webhook URL in Settings, then Integrations, or in Settings, then API Keys.
            PropTracerPRO POSTs to your URL when traces complete.
          </p>

          <h5 className="font-medium text-sm">trace.completed, from a Full Property Trace:</h5>
          <CodeBlock
            code={`{
  "event": "trace.completed",
  "trace_id": "uuid",
  "status": "success",
  "address": "123 MAIN ST|DALLAS|TX",
  "city": "DALLAS",
  "state": "TX",
  "zip": "75201",
  "result": {
    "owner_name": "John Smith",
    "phones": [{ "number": "5551234567", "type": "mobile" }],
    "emails": ["john@example.com"],
    "mailing_address": "456 OAK AVE",
    "mailing_city": "DALLAS",
    "mailing_state": "TX",
    "mailing_zip": "75202",
    "match_confidence": 95
  },
  "research": null,
  "charge": 0.25,
  "property_record": { /* the county record, over 60 fields */ },
  "tier": 2,
  "owner_type": "individual",
  "found_by": null,
  "outcome_code": null,
  "skip_reason": null,
  "timestamp": "2026-09-17T15:30:00Z"
}`}
            section="webhook-single"
          />
          <div className="bg-gray-50 border rounded-lg p-3 mt-2 space-y-2">
            <p className="text-gray-600 text-sm">
              A trace where you supplied the owner sends the same event with the same keys, fired as soon as it finishes: <code className="bg-gray-200 px-1 rounded">tier</code> is <code className="bg-gray-200 px-1 rounded">1</code>, <code className="bg-gray-200 px-1 rounded">property_record</code> is <code className="bg-gray-200 px-1 rounded">null</code>, and <code className="bg-gray-200 px-1 rounded">found_by</code>, <code className="bg-gray-200 px-1 rounded">outcome_code</code> and <code className="bg-gray-200 px-1 rounded">skip_reason</code> say what happened. Those three are <code className="bg-gray-200 px-1 rounded">null</code> on a Full Property Trace. A busy answer fires no event, because nothing completed.
            </p>
            <p className="text-gray-600 text-sm">
              <code className="bg-gray-200 px-1 rounded">address</code> is the normalized pipe-delimited key of street, city and state, not the street line you sent. The separate <code className="bg-gray-200 px-1 rounded">city</code> and <code className="bg-gray-200 px-1 rounded">state</code> keys carry those on their own. Note that this payload is snake_case while the Full Property Trace response that describes the same trace is camelCase. For a record sent by parcel ID with no city, <code className="bg-gray-200 px-1 rounded">address</code> is the street you sent, or <code className="bg-gray-200 px-1 rounded">null</code>.
            </p>
            <p className="text-gray-600 text-sm">
              <code className="bg-gray-200 px-1 rounded">charge</code> is what your wallet actually paid, so the figure above is one account&apos;s example and not a rate for everyone.
            </p>
            <p className="text-gray-600 text-sm">
              A Full Property Trace fires this event for every completed trace, including one that was charged and found no contacts, because that is the outcome you most need to hear about. It does not fire when a lookup failed on our side, because nothing completed and nothing was charged.
            </p>
            <p className="text-gray-600 text-sm">
              <code className="bg-gray-200 px-1 rounded">research</code> carries the stored record on rows that have one and is <code className="bg-gray-200 px-1 rounded">null</code> otherwise. It is always <code className="bg-gray-200 px-1 rounded">null</code> on a Full Property Trace.
            </p>
          </div>

          <h5 className="font-medium text-sm mt-4">business_trace.completed (deferred):</h5>
          <p className="text-gray-600 text-xs">
            Fired when a deferred business-trace job settles, which can be minutes to hours after the bulk job it belongs to finished. It carries the contacts for the human behind a company-owned property.
          </p>
          <CodeBlock
            code={`{
  "event": "business_trace.completed",
  "business_trace_job_id": "3f9c...9af2",
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
  "timestamp": "2026-09-17T18:42:00.000Z"
}`}
            section="webhook-business-trace"
          />

          <h5 className="font-medium text-sm">bulk_job.completed:</h5>
          <CodeBlock
            code={`{
  "event": "bulk_job.completed",
  "job_id": "uuid",
  "records_submitted": 100,
  "records_matched": 86,
  "total_charge": 12.90,
  "results": [ /* the same per-record array as the bulk status endpoint */ ],
  "timestamp": "2026-09-17T15:30:00Z"
}`}
            section="webhook-bulk"
          />

          <div className="bg-gray-50 border rounded-lg p-4">
            <p className="text-gray-700 text-sm">
              Webhooks are sent as <code className="bg-gray-200 px-1 rounded">POST</code> requests
              with <code className="bg-gray-200 px-1 rounded">Content-Type: application/json</code>.
              Delivery is fire and forget. A failed delivery is logged on our side and not retried, so keep polling available as a fallback if you cannot afford to miss one.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Error Codes */}
      <Card>
        <CardHeader>
          <CardTitle>Error Codes</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-4">Code</th>
                  <th className="text-left py-2 pr-4">Status</th>
                  <th className="text-left py-2">Description</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">400</td>
                  <td className="py-2 pr-4">Bad Request</td>
                  <td className="py-2">Invalid request body or missing required fields</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">401</td>
                  <td className="py-2 pr-4">Unauthorized</td>
                  <td className="py-2">Invalid or missing API key</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">402</td>
                  <td className="py-2 pr-4">Payment Required</td>
                  <td className="py-2">Your wallet does not cover this request. The balance is checked against the rate this request will actually charge, so a Full Property Trace is checked against its own rate</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">404</td>
                  <td className="py-2 pr-4">Not Found</td>
                  <td className="py-2">No trace or job with that id on your account</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">500</td>
                  <td className="py-2 pr-4">Server Error</td>
                  <td className="py-2">Internal server error</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">502</td>
                  <td className="py-2 pr-4">Bad Gateway</td>
                  <td className="py-2">A vendor lookup failed on our side during a Full Property Trace. Nothing was charged and nothing was stored, so retry it. It means we could not ask, not that we asked and came back empty</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-mono">503</td>
                  <td className="py-2 pr-4">Service Unavailable</td>
                  <td className="py-2">A lookup service was busy. Nothing was charged. Send the same record again after 5 minutes; a resend within 24 hours does not buy a lookup that already answered.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Support */}
      <Card>
        <CardHeader>
          <CardTitle>Need Help?</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600">
            For API support, contact us at{' '}
            <a href="mailto:support@proptracerpro.com" className="text-blue-600 hover:underline">
              support@proptracerpro.com
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
