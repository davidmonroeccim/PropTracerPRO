'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Copy, Check, RefreshCw, Eye, EyeOff, ExternalLink } from 'lucide-react';
import type { UserProfile } from '@/types';

export default function ApiKeysPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);

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
        setWebhookUrl(data.webhook_url || '');
      }
    }
    setLoading(false);
  };

  const hasApiAccess = profile?.subscription_tier === 'pro' || profile?.is_acquisition_pro_member;

  const generateApiKey = async () => {
    if (!profile) return;

    setGenerating(true);

    try {
      const response = await fetch('/api/user/generate-api-key', {
        method: 'POST',
      });

      const data = await response.json();

      if (data.apiKey) {
        setProfile({ ...profile, api_key: data.apiKey, api_key_created_at: new Date().toISOString() });
        setShowKey(true);
      }
    } catch (error) {
      console.error('Failed to generate API key:', error);
    }

    setGenerating(false);
  };

  const copyApiKey = async () => {
    if (profile?.api_key) {
      await navigator.clipboard.writeText(profile.api_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
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
      setProfile({ ...profile, webhook_url: webhookUrl });
    }

    setSavingWebhook(false);
  };

  if (loading) {
    return <div className="text-center py-12">Loading...</div>;
  }

  if (!profile) {
    return <div className="text-center py-12">Profile not found</div>;
  }

  if (!hasApiAccess) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">API Keys</h1>
          <p className="text-gray-500">Access the PropTracerPRO API</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>API Access Required</CardTitle>
            <CardDescription>
              API access is available for Pro subscribers and AcquisitionPRO members.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-gray-600">
                Upgrade to Pro ($97/month) to get full API access, including:
              </p>
              <ul className="list-disc list-inside text-gray-600 space-y-1">
                <li>REST API for single and bulk traces</li>
                <li>Webhook notifications</li>
                <li>Rate limit: 100 requests/minute, 10,000 records/day</li>
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
        <h1 className="text-2xl font-bold text-gray-900">API Keys</h1>
        <p className="text-gray-500">Manage your API access</p>
      </div>

      {/* API Key */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>API Key</CardTitle>
              <CardDescription>Use this key to authenticate API requests</CardDescription>
            </div>
            {profile.is_acquisition_pro_member && (
              <Badge className="bg-green-100 text-green-800">
                AcquisitionPRO Member Benefit
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {profile.api_key ? (
            <>
              <div className="space-y-2">
                <Label>Your API Key</Label>
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Input
                      type={showKey ? 'text' : 'password'}
                      value={profile.api_key}
                      readOnly
                      className="pr-10 font-mono"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1"
                      onClick={() => setShowKey(!showKey)}
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <Button variant="outline" onClick={copyApiKey}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-gray-500">
                  Created: {new Date(profile.api_key_created_at!).toLocaleDateString()}
                </p>
              </div>
              <Button variant="outline" onClick={generateApiKey} disabled={generating}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {generating ? 'Regenerating...' : 'Regenerate Key'}
              </Button>
              <p className="text-xs text-yellow-600">
                Warning: Regenerating will invalidate your current key.
              </p>
            </>
          ) : (
            <Button onClick={generateApiKey} disabled={generating}>
              {generating ? 'Generating...' : 'Generate API Key'}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Webhook Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Webhook URL</CardTitle>
          <CardDescription>
            Receive trace results when single or bulk traces complete
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="webhook-url">Webhook URL</Label>
            <Input
              id="webhook-url"
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-app.com/webhook"
            />
          </div>
          <Button onClick={saveWebhookUrl} disabled={savingWebhook}>
            {savingWebhook ? 'Saving...' : 'Save Webhook URL'}
          </Button>
        </CardContent>
      </Card>

      {/* API Documentation */}
      <Card>
        <CardHeader>
          <CardTitle>API Documentation</CardTitle>
          <CardDescription>Quick reference for API endpoints</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 text-sm">
            <div>
              <h4 className="font-semibold">Authentication</h4>
              <code className="block bg-gray-100 p-2 rounded mt-1">
                Authorization: Bearer YOUR_API_KEY
              </code>
            </div>

            <div>
              <h4 className="font-semibold">Single Trace</h4>
              <code className="block bg-gray-100 p-2 rounded mt-1">
                POST /api/v1/trace/single
              </code>
            </div>

            <div>
              <h4 className="font-semibold">Bulk Trace</h4>
              <code className="block bg-gray-100 p-2 rounded mt-1">
                POST /api/v1/trace/bulk
              </code>
            </div>

            <div>
              <h4 className="font-semibold">Rate Limits</h4>
              <p className="text-gray-600">100 requests/minute, 10,000 records/day</p>
            </div>

            <div className="pt-4 border-t">
              <Link href="/settings/api-keys/docs">
                <Button variant="outline" className="w-full">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  View Full API Documentation
                </Button>
              </Link>
              <p className="text-xs text-gray-500 mt-2 text-center">
                Includes integration examples for HighLevel, Make, and n8n
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
