'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SUBSCRIPTION_TIERS, PRICING, getChargePerTrace } from '@/lib/constants';
import type { UserProfile } from '@/types';

export default function BillingPage() {
  const searchParams = useSearchParams();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [topUpAmount, setTopUpAmount] = useState('25');
  const [autoRefillEnabled, setAutoRefillEnabled] = useState(false);
  const [autoRefillThreshold, setAutoRefillThreshold] = useState('5');
  const [autoRefillAmount, setAutoRefillAmount] = useState(25);
  const [savingAutoRefill, setSavingAutoRefill] = useState(false);
  const [autoRefillMessage, setAutoRefillMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const success = searchParams.get('success');
  const canceled = searchParams.get('canceled');

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

      setProfile(data);
      if (data) {
        setAutoRefillEnabled(data.wallet_auto_rebill_enabled);
        setAutoRefillThreshold(String(data.wallet_low_balance_threshold));
        setAutoRefillAmount(data.wallet_auto_rebill_amount);
      }
    }
    setLoading(false);
  };

  const handleSubscribe = async () => {
    setCheckoutLoading('pro');

    try {
      const response = await fetch('/api/stripe/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'pro' }),
      });

      const data = await response.json();

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (error) {
      console.error('Checkout error:', error);
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handleTopUp = async () => {
    const amount = parseFloat(topUpAmount);
    if (isNaN(amount) || amount < PRICING.WALLET_MIN_REBILL_AMOUNT) {
      alert(`Minimum top-up amount is $${PRICING.WALLET_MIN_REBILL_AMOUNT}`);
      return;
    }

    setCheckoutLoading('topup');

    try {
      const response = await fetch('/api/stripe/wallet-topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });

      const data = await response.json();

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (error) {
      console.error('Top-up error:', error);
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handleSaveAutoRefill = async () => {
    if (!profile) return;
    const threshold = parseFloat(autoRefillThreshold);
    if (isNaN(threshold) || threshold < PRICING.WALLET_MIN_BALANCE_THRESHOLD) {
      setAutoRefillMessage({ type: 'error', text: `Minimum threshold is $${PRICING.WALLET_MIN_BALANCE_THRESHOLD}` });
      return;
    }

    setSavingAutoRefill(true);
    setAutoRefillMessage(null);

    const supabase = createClient();
    const { error } = await supabase
      .from('user_profiles')
      .update({
        wallet_auto_rebill_enabled: autoRefillEnabled,
        wallet_low_balance_threshold: threshold,
        wallet_auto_rebill_amount: autoRefillAmount,
      })
      .eq('id', profile.id);

    if (error) {
      setAutoRefillMessage({ type: 'error', text: 'Failed to save auto-refill settings' });
    } else {
      setAutoRefillMessage({ type: 'success', text: 'Auto-refill settings saved' });
      setProfile({
        ...profile,
        wallet_auto_rebill_enabled: autoRefillEnabled,
        wallet_low_balance_threshold: threshold,
        wallet_auto_rebill_amount: autoRefillAmount,
      });
    }
    setSavingAutoRefill(false);
  };

  const handleManageBilling = async () => {
    try {
      const response = await fetch('/api/stripe/create-portal', {
        method: 'POST',
      });

      const data = await response.json();

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (error) {
      console.error('Portal error:', error);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  if (loading) {
    return <div className="text-center py-12">Loading...</div>;
  }

  if (!profile) {
    return <div className="text-center py-12">Profile not found</div>;
  }

  const currentTier = SUBSCRIPTION_TIERS[profile.subscription_tier as keyof typeof SUBSCRIPTION_TIERS];
  const userPerTrace = getChargePerTrace(profile.subscription_tier, profile.is_acquisition_pro_member);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
        <p className="text-gray-500">Manage your subscription and wallet</p>
      </div>

      {/* Success/Cancel Messages */}
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-green-800">Payment successful! Your account has been updated.</p>
        </div>
      )}
      {canceled && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-yellow-800">Payment was canceled. No changes were made.</p>
        </div>
      )}

      {/* Current Plan */}
      <Card>
        <CardHeader>
          <CardTitle>Current Plan</CardTitle>
          <CardDescription>Your current subscription tier and usage</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold">{currentTier.name}</h3>
                {profile.is_acquisition_pro_member && (
                  <Badge className="bg-green-100 text-green-800">AcquisitionPRO Member</Badge>
                )}
              </div>
              <p className="text-gray-500">{currentTier.description}</p>
              <p className="mt-2">
                <span className="text-2xl font-bold">${currentTier.monthlyFee}</span>
                <span className="text-gray-500">/month</span>
                {' + '}
                <span className="text-gray-500">${userPerTrace.toFixed(2)} per successful trace</span>
              </p>
            </div>
            {profile.stripe_subscription_id && (
              <Button variant="outline" onClick={handleManageBilling}>
                Manage Subscription
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Wallet Balance — all users pay via wallet */}
      {(
        <Card>
          <CardHeader>
            <CardTitle>Wallet Balance</CardTitle>
            <CardDescription>Your current balance for pay-as-you-go traces</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between mb-6">
              <div>
                <p className="text-3xl font-bold">{formatCurrency(profile.wallet_balance)}</p>
                <p className="text-sm text-gray-500">Available balance</p>
              </div>
              <Badge variant={autoRefillEnabled ? 'default' : 'outline'}>
                {autoRefillEnabled ? 'Auto-refill ON' : 'Auto-refill OFF'}
              </Badge>
            </div>

            <div className="border-t pt-4">
              <Label htmlFor="topup-amount">Add Funds</Label>
              <div className="flex gap-2 mt-2">
                <div className="flex-1">
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-gray-500">$</span>
                    <Input
                      id="topup-amount"
                      type="number"
                      min={PRICING.WALLET_MIN_REBILL_AMOUNT}
                      step="5"
                      value={topUpAmount}
                      onChange={(e) => setTopUpAmount(e.target.value)}
                      className="pl-7"
                    />
                  </div>
                </div>
                <Button
                  onClick={handleTopUp}
                  disabled={checkoutLoading === 'topup'}
                >
                  {checkoutLoading === 'topup' ? 'Processing...' : 'Add Funds'}
                </Button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Minimum: ${PRICING.WALLET_MIN_REBILL_AMOUNT}
              </p>
            </div>

            {/* Auto-Refill Settings */}
            <div className="border-t pt-4 mt-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <Label>Auto-Refill</Label>
                  <p className="text-xs text-gray-500">Automatically add funds when your balance is low</p>
                </div>
                <Button
                  variant={autoRefillEnabled ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setAutoRefillEnabled(!autoRefillEnabled)}
                >
                  {autoRefillEnabled ? 'ON' : 'OFF'}
                </Button>
              </div>

              {autoRefillEnabled && (
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="refill-threshold">When balance drops below</Label>
                    <div className="relative mt-1">
                      <span className="absolute left-3 top-2.5 text-gray-500">$</span>
                      <Input
                        id="refill-threshold"
                        type="number"
                        min={PRICING.WALLET_MIN_BALANCE_THRESHOLD}
                        step="1"
                        value={autoRefillThreshold}
                        onChange={(e) => setAutoRefillThreshold(e.target.value)}
                        className="pl-7"
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Minimum: ${PRICING.WALLET_MIN_BALANCE_THRESHOLD}</p>
                  </div>

                  <div>
                    <Label>Auto-refill amount</Label>
                    <div className="flex gap-2 mt-1">
                      {PRICING.WALLET_AUTO_REFILL_AMOUNTS.map((amount) => (
                        <Button
                          key={amount}
                          variant={autoRefillAmount === amount ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setAutoRefillAmount(amount)}
                        >
                          ${amount}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {autoRefillMessage && (
                <p className={`text-sm mt-2 ${autoRefillMessage.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                  {autoRefillMessage.text}
                </p>
              )}

              <Button
                onClick={handleSaveAutoRefill}
                disabled={savingAutoRefill}
                className="mt-4"
              >
                {savingAutoRefill ? 'Saving...' : 'Save Auto-Refill Settings'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Subscription Plans */}
      <Card>
        <CardHeader>
          <CardTitle>Available Plans</CardTitle>
          <CardDescription>Choose the plan that works best for you</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            {/* Pay-As-You-Go */}
            <div className={`border rounded-lg p-4 ${profile.subscription_tier !== 'pro' ? 'border-blue-500 bg-blue-50' : ''}`}>
              <h3 className="font-semibold">Pay-As-You-Go</h3>
              <p className="text-2xl font-bold mt-2">$0<span className="text-sm font-normal">/month</span></p>
              <p className="text-sm text-gray-500 mt-1">+ $0.11 per successful trace</p>
              <ul className="mt-4 space-y-2 text-sm">
                <li>No monthly commitment</li>
                <li>Wallet-based billing</li>
                <li>Full access to skip tracing</li>
              </ul>
              {profile.subscription_tier !== 'pro' && (
                <Badge className="mt-4">Current Plan</Badge>
              )}
            </div>

            {/* Pro */}
            <div className={`border rounded-lg p-4 ${profile.subscription_tier === 'pro' ? 'border-blue-500 bg-blue-50' : 'border-purple-200'}`}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Pro</h3>
                <Badge className="bg-purple-100 text-purple-800">Popular</Badge>
              </div>
              <p className="text-2xl font-bold mt-2">$97<span className="text-sm font-normal">/month</span></p>
              <p className="text-sm text-gray-500 mt-1">+ $0.07 per successful trace</p>
              <ul className="mt-4 space-y-2 text-sm">
                <li className="font-medium text-purple-700">Full API access</li>
                <li>Webhook support</li>
                <li>Integrations</li>
              </ul>
              {profile.subscription_tier === 'pro' ? (
                <Badge className="mt-4">Current Plan</Badge>
              ) : profile.is_acquisition_pro_member ? (
                <p className="mt-4 text-sm text-green-700">
                  You have API access as an AcquisitionPRO member!
                </p>
              ) : (
                <Button
                  className="w-full mt-4"
                  onClick={() => handleSubscribe()}
                  disabled={!!checkoutLoading}
                >
                  {checkoutLoading === 'pro' ? 'Processing...' : 'Subscribe'}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
