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
    }
    setLoading(false);
  };

  const handleSubscribe = async () => {
    setCheckoutLoading('pro');

    const priceId = process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO;
    const tier = 'pro';

    try {
      const response = await fetch('/api/stripe/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, tier }),
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

      {/* Wallet Balance (for wallet tier, not AcquisitionPRO members) */}
      {profile.subscription_tier === 'wallet' && !profile.is_acquisition_pro_member && (
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
              <Badge variant={profile.wallet_auto_rebill_enabled ? 'default' : 'outline'}>
                {profile.wallet_auto_rebill_enabled ? 'Auto-rebill ON' : 'Auto-rebill OFF'}
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
