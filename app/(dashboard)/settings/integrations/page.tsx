'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { effectiveIsPro } from '@/lib/suite/entitlements';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Eye, EyeOff, Copy, Check, ExternalLink, ChevronDown, ChevronUp, HelpCircle } from 'lucide-react';
import {
  HighLevelInvalidNotice,
  HighLevelStatusBadge,
} from '@/components/integrations/HighLevelConnectionStatus';
import { highLevelConnectionState } from '@/lib/highlevel/connectionState';
import type { UserProfile } from '@/types';

/**
 * The real `trace.completed` body, key for key.
 *
 * New single traces of both tiers are sent inline by lib/trace/traceCompletedWebhook.ts, which is
 * the poll payload plus `property_record`, `tier`, `owner_type`, `found_by`, `outcome_code` and
 * `skip_reason`. The two poll routes (app/api/trace/status, app/api/v1/trace/status) and
 * app/api/cron/sweep-stale-traces still send the older shape for rows already in flight before
 * this change. `charge` is always what the wallet actually collected, never a list price, so the
 * number below is an example and not a quote.
 */
const WEBHOOK_PAYLOAD_EXAMPLE = `{
  "event": "trace.completed",
  "trace_id": "uuid",
  "status": "success",
  "address": "123 MAIN ST|DALLAS|TX",
  "city": "DALLAS",
  "state": "TX",
  "zip": "75201",
  "result": {
    "owner_name": "John Smith",
    "phones": [{"number": "5551234567", "type": "mobile"}],
    "emails": ["john@example.com"],
    "mailing_address": "456 OAK AVE",
    "mailing_city": "DALLAS",
    "mailing_state": "TX",
    "mailing_zip": "75202"
  },
  "research": null,
  "charge": 0.25,
  "property_record": { "county": "Dallas", "apn": "00000123456789000" },
  "tier": 2,
  "owner_type": "individual",
  "found_by": null,
  "outcome_code": null,
  "skip_reason": null,
  "timestamp": "2026-09-17T15:30:00Z"
}`;

export default function IntegrationsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // HighLevel state
  const [hlApiKey, setHlApiKey] = useState('');
  const [hlLocationId, setHlLocationId] = useState('');
  const [showHlKey, setShowHlKey] = useState(false);
  const [testing, setTesting] = useState(false);
  /**
   * The outcome of the last thing the user pressed, Test Connection or Save.
   * Three tones, because there are three honest answers: it worked, it did not,
   * and we could not tell. The third one exists so a save we could not verify
   * never renders as a success.
   */
  const [testResult, setTestResult] = useState<{
    connected: boolean;
    error?: string;
    warning?: string;
    message?: string;
  } | null>(null);
  const [savingHl, setSavingHl] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Help toggle
  const [showHlHelp, setShowHlHelp] = useState(false);

  // Webhook state
  const [webhookUrl, setWebhookUrl] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [showPayload, setShowPayload] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      const { data } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      if (data) {
        setProfile(data);
        setHlApiKey(data.highlevel_api_key || '');
        setHlLocationId(data.highlevel_location_id || '');
        setWebhookUrl(data.webhook_url || '');
      }
    }
    setLoading(false);
  };

  /**
   * "Connected" used to be `!!(api_key && location_id)`: two non-empty strings.
   * It now also requires that no push has flagged the credential. The profile
   * is read with `select('*')` above, so `highlevel_invalid_at` and
   * `highlevel_invalid_reason` arrive with it and need no separate query.
   */
  const hlState = highLevelConnectionState(profile);
  const isHlConnected = hlState.status !== 'not_connected';

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const response = await fetch('/api/integrations/highlevel/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          highlevel_api_key: hlApiKey,
          highlevel_location_id: hlLocationId,
        }),
      });

      const data = await response.json();
      setTestResult(data);
    } catch {
      setTestResult({
        connected: false,
        error: 'We could not reach PropTracerPRO to run the test. Check your connection and try again.',
      });
    }

    setTesting(false);
  };

  const saveHighLevel = async () => {
    if (!profile) return;
    setSavingHl(true);

    try {
      const response = await fetch('/api/integrations/highlevel/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          highlevel_api_key: hlApiKey,
          highlevel_location_id: hlLocationId,
        }),
      });

      const data = await response.json();

      // SAVE REPLACES THE LAST OUTCOME, IT DOES NOT ERASE IT. This used to run
      // setTestResult(null), so a red "Invalid API key" from Test Connection
      // vanished the moment Save was pressed and the badge turned green in the
      // same tick. Save now always leaves its own honest answer on screen.
      if (data.success) {
        setProfile({
          ...profile,
          highlevel_api_key: hlApiKey,
          highlevel_location_id: hlLocationId,
          // Only a VERIFIED save clears the flag, and the server has already
          // done it. A save we could not verify leaves it exactly as it was,
          // because the flag still describes the last push that really ran.
          ...(data.connected
            ? {
                highlevel_invalid_at: null,
                highlevel_invalid_status: null,
                highlevel_invalid_reason: null,
              }
            : {}),
        });

        setTestResult(
          data.connected
            ? { connected: true, message: 'Saved. We reached HighLevel with this key and it worked.' }
            : { connected: false, warning: data.warning }
        );
      } else {
        setTestResult({
          connected: false,
          error: data.error || 'We could not save your HighLevel key. Try again in a moment.',
        });
      }
    } catch (error) {
      console.error('Failed to save HighLevel credentials:', error);
      setTestResult({
        connected: false,
        error: 'We could not reach PropTracerPRO to save your key. Check your connection and try again.',
      });
    }

    setSavingHl(false);
  };

  const disconnectHighLevel = async () => {
    if (!profile) return;
    setDisconnecting(true);

    try {
      const response = await fetch('/api/integrations/highlevel/disconnect', {
        method: 'POST',
      });

      const data = await response.json();
      if (data.success) {
        setProfile({
          ...profile,
          highlevel_api_key: null,
          highlevel_location_id: null,
          // Mirrors the route: the diagnosis goes with the credential it
          // described, so a fresh connection does not inherit a stale one.
          highlevel_invalid_at: null,
          highlevel_invalid_status: null,
          highlevel_invalid_reason: null,
        });
        setHlApiKey('');
        setHlLocationId('');
        setTestResult(null);
      }
    } catch (error) {
      console.error('Failed to disconnect HighLevel:', error);
    }

    setDisconnecting(false);
  };

  const saveWebhookUrl = async () => {
    if (!profile) return;
    setSavingWebhook(true);

    const supabase = createClient();
    const { error } = await supabase
      .from('user_profiles')
      .update({ webhook_url: webhookUrl || null })
      .eq('id', profile.id);

    if (!error) {
      setProfile({ ...profile, webhook_url: webhookUrl || null });
    }

    setSavingWebhook(false);
  };

  const copyApiKey = async () => {
    if (profile?.api_key) {
      await navigator.clipboard.writeText(profile.api_key);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  };

  if (loading) {
    return <div className="text-center py-12">Loading...</div>;
  }

  if (!profile) {
    return <div className="text-center py-12">Profile not found</div>;
  }

  const hasProAccess = effectiveIsPro(profile);

  if (!hasProAccess) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
          <p className="text-gray-500">Connect PropTracerPRO to your CRM and automation tools</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Pro Plan Required</CardTitle>
            <CardDescription>
              Integrations are available for Pro subscribers and AcquisitionPRO members.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-gray-600">
                Upgrade to Pro ($97/month) to unlock integrations, including:
              </p>
              <ul className="list-disc list-inside text-gray-600 space-y-1">
                <li>HighLevel CRM, push contacts with one click</li>
                <li>Webhook support for any CRM or automation platform</li>
                <li>Full API access</li>
              </ul>
              <Button onClick={() => window.location.href = '/settings/billing'}>
                Upgrade to Pro
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
        <p className="text-gray-500">Connect PropTracerPRO to your CRM and automation tools</p>
      </div>

      {/* HighLevel CRM */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>HighLevel CRM</CardTitle>
              <CardDescription>
                Create or update contacts in your HighLevel CRM from your trace results.
              </CardDescription>
            </div>
            <HighLevelStatusBadge state={hlState} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="hl-api-key">API Key</Label>
            <div className="relative">
              <Input
                id="hl-api-key"
                type={showHlKey ? 'text' : 'password'}
                value={hlApiKey}
                onChange={(e) => setHlApiKey(e.target.value)}
                placeholder="Enter your HighLevel API key"
                className="pr-10"
              />
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1"
                onClick={() => setShowHlKey(!showHlKey)}
              >
                {showHlKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="hl-location-id">Location ID</Label>
            <Input
              id="hl-location-id"
              type="text"
              value={hlLocationId}
              onChange={(e) => setHlLocationId(e.target.value)}
              placeholder="Enter your HighLevel Location ID"
            />
          </div>

          {/* What the last real push said about this credential, and the fix. */}
          <HighLevelInvalidNotice state={hlState} />

          {testResult && (
            <div
              className={`text-sm p-3 rounded ${
                testResult.connected
                  ? 'bg-green-50 text-green-700'
                  : testResult.warning
                    ? 'bg-amber-50 text-amber-800'
                    : 'bg-red-50 text-red-700'
              }`}
            >
              {testResult.connected
                ? testResult.message || 'We reached HighLevel with this key and it worked.'
                : testResult.warning ||
                  testResult.error ||
                  'Something went wrong talking to HighLevel.'}
            </div>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={testConnection}
              disabled={testing || !hlApiKey || !hlLocationId}
            >
              {testing ? 'Testing...' : 'Test Connection'}
            </Button>

            {isHlConnected ? (
              <>
                <Button onClick={saveHighLevel} disabled={savingHl || !hlApiKey || !hlLocationId}>
                  {savingHl ? 'Saving...' : 'Save'}
                </Button>
                <Button
                  variant="destructive"
                  onClick={disconnectHighLevel}
                  disabled={disconnecting}
                >
                  {disconnecting ? 'Disconnecting...' : 'Disconnect'}
                </Button>
              </>
            ) : (
              <Button onClick={saveHighLevel} disabled={savingHl || !hlApiKey || !hlLocationId}>
                {savingHl ? 'Saving...' : 'Save'}
              </Button>
            )}
          </div>

          {/* GHL Setup Help */}
          <div className="pt-4 border-t">
            <button
              onClick={() => setShowHlHelp(!showHlHelp)}
              className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
            >
              <HelpCircle className="h-4 w-4" />
              {showHlHelp ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              Where do I find my API Key &amp; Location ID?
            </button>
            {showHlHelp && (
              <div className="mt-3 space-y-4 text-sm text-gray-600 bg-gray-50 p-4 rounded border">
                <div>
                  <h4 className="font-semibold text-gray-800">GHL v1 (Legacy API Key)</h4>
                  <ol className="list-decimal list-inside mt-1 space-y-1">
                    <li>Log in to your HighLevel sub-account</li>
                    <li>Go to <strong>Settings, then Business Profile</strong></li>
                    <li>Scroll down to the <strong>API Key</strong> field</li>
                    <li>Copy the key and paste it above</li>
                  </ol>
                </div>

                <div>
                  <h4 className="font-semibold text-gray-800">GHL v2 (Private Integration)</h4>
                  <p className="mt-1 mb-1 text-xs text-gray-500">HighLevel is phasing out legacy API keys. New accounts should use Private Integrations instead.</p>
                  <ol className="list-decimal list-inside mt-1 space-y-1">
                    <li>Log in to your HighLevel sub-account</li>
                    <li>Go to <strong>Settings, then Private Integrations</strong></li>
                    <li>Click <strong>Create new Integration</strong></li>
                    <li>Name it (e.g. &quot;PropTracerPRO&quot;) and tick BOTH <strong>contacts.readonly</strong> and <strong>contacts.write</strong>. They are two separate permissions in HighLevel. Test Connection only reads, so a token with just contacts.readonly passes the test and then fails every push</li>
                    <li>Copy the generated token immediately. <strong>You won&apos;t be able to see it again</strong></li>
                    <li>Paste the token in the API Key field above</li>
                  </ol>
                  <p className="mt-1 text-xs text-gray-500">If you don&apos;t see Private Integrations, enable it under <strong>Settings, then Labs</strong> first.</p>
                  <p className="mt-1 text-xs text-gray-500">Ticked the wrong permissions? You can edit them on an integration you already made, so you do not need to create a new token or paste a new key here.</p>
                </div>

                <div>
                  <h4 className="font-semibold text-gray-800">Finding Your Location ID</h4>
                  <ul className="list-disc list-inside mt-1 space-y-1">
                    <li><strong>Option A:</strong> Go to <strong>Settings, then Business Profile</strong> and look for <strong>Location ID</strong></li>
                    <li><strong>Option B:</strong> Look at your browser URL. It follows the pattern <code className="bg-gray-200 px-1 rounded text-xs">app.gohighlevel.com/location/<strong>LOCATION_ID</strong>/...</code></li>
                  </ul>
                </div>
              </div>
            )}
          </div>

          {/*
            NOTHING PUSHES ON ITS OWN ANY MORE, AND THIS SENTENCE HAS TO KEEP
            SAYING SO. It has been wrong twice already: first as "Successful
            traces will automatically create or update contacts", then as a
            narrower claim that a tier 1 trace pushes itself. Every automatic
            push is gone, because PTP's own push only ever creates Contacts and
            that is the wrong object for an entity owner. Do not widen this
            back without adding a push, and there is no plan to add one.
          */}
          <p className="text-xs text-gray-500">
            Nothing goes to HighLevel on its own. When you want a result in your CRM, press Add to
            CRM on the trace, or Add All to CRM on a finished bulk job, and we create or update
            those contacts. It works the same for a skip trace where you gave us the owner and for
            a Full Property Trace.
          </p>
        </CardContent>
      </Card>

      {/* Webhook & Automation */}
      <Card>
        <CardHeader>
          <CardTitle>Connect Any CRM or Automation Platform</CardTitle>
          <CardDescription>
            PropTracerPRO sends trace results to your webhook URL when traces complete. Works with Kartra, ClickFunnels, RealNex, n8n, Zapier, Make, and any platform that accepts webhooks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Webhook URL */}
          <div className="space-y-2">
            <Label htmlFor="webhook-url">Webhook URL</Label>
            <Input
              id="webhook-url"
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-platform.com/webhook"
            />
          </div>
          <Button onClick={saveWebhookUrl} disabled={savingWebhook}>
            {savingWebhook ? 'Saving...' : 'Save Webhook URL'}
          </Button>

          {/* API Key display */}
          {profile.api_key ? (
            <div className="space-y-2 pt-4 border-t">
              <Label>Your API Key</Label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={profile.api_key}
                  readOnly
                  className="font-mono flex-1"
                />
                <Button variant="outline" onClick={copyApiKey}>
                  {copiedKey ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-gray-500">
                Use this key to authenticate inbound API requests to PropTracerPRO.
              </p>
            </div>
          ) : (
            <div className="pt-4 border-t">
              <p className="text-sm text-gray-600">
                No API key generated yet.{' '}
                <Link href="/settings/api-keys" className="text-blue-600 hover:underline">
                  Generate one
                </Link>{' '}
                to enable inbound API access.
              </p>
            </div>
          )}

          {/* Webhook payload preview */}
          <div className="pt-4 border-t">
            <button
              onClick={() => setShowPayload(!showPayload)}
              className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
            >
              {showPayload ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              Webhook Payload Preview
            </button>
            {showPayload && (
              <>
                <pre className="mt-2 bg-gray-50 p-4 rounded text-xs overflow-x-auto border">
                  {WEBHOOK_PAYLOAD_EXAMPLE}
                </pre>
                <div className="mt-3 space-y-2 text-xs text-gray-600">
                  <p>
                    Every trace sends the same keys. When you gave us the owner of record,{' '}
                    <code className="bg-gray-100 px-1 rounded">tier</code> is 1 and{' '}
                    <code className="bg-gray-100 px-1 rounded">property_record</code> is null.{' '}
                    <code className="bg-gray-100 px-1 rounded">found_by</code> says which key found
                    the owner (address, parcel_id or company_name),{' '}
                    <code className="bg-gray-100 px-1 rounded">outcome_code</code> gives the outcome,
                    and <code className="bg-gray-100 px-1 rounded">skip_reason</code> says in one
                    sentence why nothing was found. On a Full Property Trace,{' '}
                    <code className="bg-gray-100 px-1 rounded">tier</code> is 2 and those three are
                    null.
                  </p>
                  <p>
                    <code className="bg-gray-100 px-1 rounded">charge</code> is what your wallet
                    actually paid for that trace, not a list price. When you give us the owner of
                    record you are charged only if contacts come back, at $0.15 per successful
                    trace on Pro and AcquisitionPRO or $0.25 pay as you go. A Full Property Trace
                    is charged per record submitted, at $0.25 on Pro and AcquisitionPRO or $0.40
                    pay as you go, and that charge stands whether or not contacts come back.
                  </p>
                  <p>
                    This event fires for every finished trace, including one that found no
                    contacts. Nothing is sent, and nothing is charged, when a lookup fails on our
                    side or the system is busy.
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Link to API docs */}
          <div className="pt-4 border-t">
            <Link href="/settings/api-keys/docs">
              <Button variant="outline" className="w-full">
                <ExternalLink className="h-4 w-4 mr-2" />
                View Full API Documentation
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
