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

      {/* Endpoints */}
      <Card>
        <CardHeader>
          <CardTitle>API Endpoints</CardTitle>
          <CardDescription>Available endpoints for skip tracing</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Single Trace */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-mono">POST</span>
              <code className="text-sm font-semibold">/trace/single</code>
            </div>
            <p className="text-gray-600 text-sm">Trace a single property address</p>

            <h5 className="font-medium text-sm">Request Body:</h5>
            <CodeBlock
              code={`{
  "address": "123 Main Street",
  "city": "Austin",
  "state": "TX",
  "zip": "78701",
  "ownerName": "John Smith"  // optional, improves accuracy
}`}
              section="single-request"
            />

            <h5 className="font-medium text-sm">Response:</h5>
            <CodeBlock
              code={`{
  "success": true,
  "cached": false,
  "charge": 0.07,
  "result": {
    "owner_name": "John Smith",
    "owner_name_2": null,
    "phones": [
      { "number": "5125551234", "type": "mobile" },
      { "number": "5125555678", "type": "landline" }
    ],
    "emails": ["john.smith@email.com"],
    "mailing_address": "456 Oak Ave",
    "mailing_city": "Austin",
    "mailing_state": "TX",
    "mailing_zip": "78702",
    "match_confidence": 95
  }
}`}
              section="single-response"
            />
          </div>

          <hr />

          {/* Bulk Trace */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-mono">POST</span>
              <code className="text-sm font-semibold">/trace/bulk</code>
            </div>
            <p className="text-gray-600 text-sm">Submit multiple addresses for batch processing</p>

            <h5 className="font-medium text-sm">Request Body:</h5>
            <CodeBlock
              code={`{
  "records": [
    {
      "address": "123 Main Street",
      "city": "Austin",
      "state": "TX",
      "zip": "78701"
    },
    {
      "address": "456 Oak Avenue",
      "city": "Houston",
      "state": "TX",
      "zip": "77001"
    }
  ],
  "webhookUrl": "https://your-app.com/webhook"  // optional
}`}
              section="bulk-request"
            />

            <h5 className="font-medium text-sm">Response:</h5>
            <CodeBlock
              code={`{
  "success": true,
  "jobId": "job_abc123",
  "totalRecords": 100,
  "duplicatesRemoved": 5,
  "recordsToProcess": 95,
  "estimatedCost": 6.65,
  "status": "processing"
}`}
              section="bulk-response"
            />
          </div>

          <hr />

          {/* Get Job Status */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs font-mono">GET</span>
              <code className="text-sm font-semibold">/trace/jobs/:jobId</code>
            </div>
            <p className="text-gray-600 text-sm">Check the status of a bulk trace job</p>

            <h5 className="font-medium text-sm">Response:</h5>
            <CodeBlock
              code={`{
  "jobId": "job_abc123",
  "status": "completed",
  "totalRecords": 95,
  "recordsMatched": 82,
  "recordsNoMatch": 13,
  "totalCharge": 5.74,
  "resultsUrl": "/api/v1/trace/jobs/job_abc123/results",
  "completedAt": "2024-12-23T14:30:00Z"
}`}
              section="job-status"
            />
          </div>
        </CardContent>
      </Card>

      {/* Rate Limits */}
      <Card>
        <CardHeader>
          <CardTitle>Rate Limits</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="bg-gray-50 p-4 rounded-lg">
              <p className="font-medium">Requests per minute</p>
              <p className="text-2xl font-bold text-blue-600">100</p>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg">
              <p className="font-medium">Records per day</p>
              <p className="text-2xl font-bold text-blue-600">10,000</p>
            </div>
          </div>
          <p className="text-gray-500 text-sm mt-4">
            Exceeding rate limits returns a <code className="bg-gray-100 px-1 rounded">429 Too Many Requests</code> response.
          </p>
        </CardContent>
      </Card>

      {/* Integration Examples */}
      <Card>
        <CardHeader>
          <CardTitle>Integration Examples</CardTitle>
          <CardDescription>Copy-paste examples for popular platforms</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="highlevel" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="highlevel">HighLevel</TabsTrigger>
              <TabsTrigger value="make">Make</TabsTrigger>
              <TabsTrigger value="n8n">n8n</TabsTrigger>
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
                  <li><code>result.phones[0].number</code> → Phone field</li>
                  <li><code>result.emails[0]</code> → Email field</li>
                  <li><code>result.mailing_address</code> → Mailing Address</li>
                  <li><code>result.mailing_city</code> → Mailing City</li>
                  <li><code>result.mailing_state</code> → Mailing State</li>
                  <li><code>result.mailing_zip</code> → Mailing Zip</li>
                </ul>
              </div>
            </TabsContent>

            <TabsContent value="make" className="space-y-4 mt-4">
              <h4 className="font-semibold">Make (Integromat) Integration</h4>
              <p className="text-gray-600 text-sm">
                Create a scenario with the HTTP module to trace properties.
              </p>

              <div className="space-y-2">
                <p className="font-medium text-sm">HTTP Module Configuration</p>
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
  "zip": "{{1.zip}}"
}

Parse response: Yes`}
                  section="make"
                />
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-800 text-sm">
                  <strong>Tip:</strong> Use a Router after the HTTP module to handle success/error responses separately.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="n8n" className="space-y-4 mt-4">
              <h4 className="font-semibold">n8n Integration</h4>
              <p className="text-gray-600 text-sm">
                Use the HTTP Request node to integrate with PropTracerPRO.
              </p>

              <div className="space-y-2">
                <p className="font-medium text-sm">HTTP Request Node Configuration</p>
                <CodeBlock
                  code={`{
  "nodes": [
    {
      "name": "PropTracerPRO Trace",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "method": "POST",
        "url": "https://proptracerpro.vercel.app/api/v1/trace/single",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Authorization",
              "value": "Bearer ptp_your_api_key"
            }
          ]
        },
        "sendBody": true,
        "bodyParameters": {
          "parameters": [
            { "name": "address", "value": "={{ $json.address }}" },
            { "name": "city", "value": "={{ $json.city }}" },
            { "name": "state", "value": "={{ $json.state }}" },
            { "name": "zip", "value": "={{ $json.zip }}" }
          ]
        },
        "options": {}
      }
    }
  ]
}`}
                  section="n8n"
                />
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-800 text-sm">
                  <strong>Tip:</strong> Store your API key in n8n Credentials as &quot;Header Auth&quot; for better security.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="curl" className="space-y-4 mt-4">
              <h4 className="font-semibold">cURL Example</h4>
              <p className="text-gray-600 text-sm">
                Test the API directly from your terminal.
              </p>

              <CodeBlock
                code={`curl -X POST https://proptracerpro.vercel.app/api/v1/trace/single \\
  -H "Authorization: Bearer ptp_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "address": "123 Main Street",
    "city": "Austin",
    "state": "TX",
    "zip": "78701"
  }'`}
                section="curl"
              />
            </TabsContent>
          </Tabs>
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
            Configure your webhook URL in Settings → Integrations or Settings → API Keys.
            PropTracerPRO will POST to your URL when traces complete.
          </p>

          <h5 className="font-medium text-sm">Single Trace Completion:</h5>
          <CodeBlock
            code={`{
  "event": "trace.completed",
  "trace_id": "uuid",
  "status": "success",
  "address": "123 MAIN ST",
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
  "charge": 0.07,
  "timestamp": "2026-01-27T15:30:00Z"
}`}
            section="webhook-single"
          />

          <h5 className="font-medium text-sm">Bulk Job Completion:</h5>
          <CodeBlock
            code={`{
  "event": "bulk_job.completed",
  "job_id": "uuid",
  "records_submitted": 100,
  "records_matched": 86,
  "total_charge": 6.02,
  "results": [
    {
      "address": "123 MAIN ST",
      "city": "DALLAS",
      "state": "TX",
      "result": {
        "owner_name": "John Smith",
        "phones": [{ "number": "5551234567", "type": "mobile" }],
        "emails": ["john@example.com"],
        "mailing_address": "456 OAK AVE",
        "mailing_city": "DALLAS",
        "mailing_state": "TX",
        "mailing_zip": "75202",
        "match_confidence": 95
      }
    }
  ],
  "timestamp": "2026-01-27T15:30:00Z"
}`}
            section="webhook-bulk"
          />

          <div className="bg-gray-50 border rounded-lg p-4">
            <p className="text-gray-700 text-sm">
              Webhooks are sent as <code className="bg-gray-200 px-1 rounded">POST</code> requests
              with <code className="bg-gray-200 px-1 rounded">Content-Type: application/json</code>.
              Delivery is fire-and-forget — failures are logged but not retried.
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
                  <td className="py-2">Insufficient wallet balance</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">429</td>
                  <td className="py-2 pr-4">Too Many Requests</td>
                  <td className="py-2">Rate limit exceeded</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-mono">500</td>
                  <td className="py-2 pr-4">Server Error</td>
                  <td className="py-2">Internal server error</td>
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
