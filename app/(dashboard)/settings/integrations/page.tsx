'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Eye, EyeOff, Copy, Check, ExternalLink, ChevronDown, ChevronUp, HelpCircle } from 'lucide-react';
import type { UserProfile } from '@/types';

const WEBHOOK_PAYLOAD_EXAMPLE = `{
  "event": "trace.completed",
  "trace_id": "uuid",
  "status": "success",
  "address": "123 MAIN ST",
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
  "charge": 0.07,
  "timestamp": "2026-01-27T15:30:00Z"
}`;

export default function IntegrationsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // HighLevel state
  const [hlApiKey, setHlApiKey] = useState('');
  const [hlLocationId, setHlLocationId] = useState('');
  const [showHlKey, setShowHlKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ connected: boolean; error?: string } | null>(null);
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

  const isHlConnected = !!(profile?.highlevel_api_key && profile?.highlevel_location_id);

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
      setTestResult({ connected: false, error: 'Network error' });
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
      if (data.success) {
        setProfile({
          ...profile,
          highlevel_api_key: hlApiKey,
          highlevel_location_id: hlLocationId,
        });
        setTestResult(null);
      }
    } catch (error) {
      console.error('Failed to save HighLevel credentials:', error);
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
                Automatically create or update contacts in your HighLevel CRM when traces complete.
              </CardDescription>
            </div>
            {isHlConnected ? (
              <Badge className="bg-green-100 text-green-800">Connected</Badge>
            ) : (
              <Badge variant="secondary">Not Connected</Badge>
            )}
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

          {testResult && (
            <div className={`text-sm p-3 rounded ${testResult.connected ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {testResult.connected ? 'Connection successful!' : `Connection failed: ${testResult.error}`}
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
                    <li>Go to <strong>Settings → Business Profile</strong></li>
                    <li>Scroll down to the <strong>API Key</strong> field</li>
                    <li>Copy the key and paste it above</li>
                  </ol>
                </div>

                <div>
                  <h4 className="font-semibold text-gray-800">GHL v2 (API Keys Page)</h4>
                  <ol className="list-decimal list-inside mt-1 space-y-1">
                    <li>Log in to your HighLevel sub-account</li>
                    <li>Go to <strong>Settings → Company → API Keys</strong></li>
                    <li>Click <strong>Create API Key</strong></li>
                    <li>Give it a name (e.g. &quot;PropTracerPRO&quot;) and enable the <strong>contacts</strong> scope</li>
                    <li>Copy the generated key and paste it above</li>
                  </ol>
                </div>

                <div>
                  <h4 className="font-semibold text-gray-800">Finding Your Location ID</h4>
                  <ul className="list-disc list-inside mt-1 space-y-1">
                    <li><strong>Option A:</strong> Go to <strong>Settings → Business Profile</strong> and look for <strong>Location ID</strong></li>
                    <li><strong>Option B:</strong> Look at your browser URL — it follows the pattern <code className="bg-gray-200 px-1 rounded text-xs">app.gohighlevel.com/location/<strong>LOCATION_ID</strong>/...</code></li>
                  </ul>
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-gray-500">
            Successful traces will automatically create or update contacts in your HighLevel CRM.
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
              <pre className="mt-2 bg-gray-50 p-4 rounded text-xs overflow-x-auto border">
                {WEBHOOK_PAYLOAD_EXAMPLE}
              </pre>
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
