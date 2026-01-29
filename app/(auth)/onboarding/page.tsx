'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { USE_CASES } from '@/lib/constants';

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = createClient();

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form data
  const [companyName, setCompanyName] = useState('');
  const [isAcquisitionProMember, setIsAcquisitionProMember] = useState<boolean | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<'idle' | 'verifying' | 'verified' | 'failed'>('idle');
  const [primaryUseCase, setPrimaryUseCase] = useState('');

  const verifyMembership = async () => {
    setVerificationStatus('verifying');
    setError(null);

    try {
      const response = await fetch('/api/verify-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();

      if (data.verified) {
        setVerificationStatus('verified');
      } else {
        setVerificationStatus('failed');
        setError(data.message || 'Could not verify membership.');
      }
    } catch {
      setVerificationStatus('failed');
      setError('Failed to verify membership. Please try again.');
    }
  };

  const handleComplete = async () => {
    setLoading(true);
    setError(null);

    try {
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        setError('Session expired. Please log in again.');
        router.push('/login');
        return;
      }

      const updateData: Record<string, unknown> = {
        company_name: companyName || null,
        primary_use_case: primaryUseCase || null,
        onboarding_completed: true,
        is_acquisition_pro_member: verificationStatus === 'verified',
        acquisition_pro_verified_at: verificationStatus === 'verified' ? new Date().toISOString() : null,
      };

      const { error: updateError } = await supabase
        .from('user_profiles')
        .update(updateData)
        .eq('id', user.id);

      if (updateError) {
        setError(updateError.message);
        setLoading(false);
        return;
      }

      window.location.href = '/';
    } catch {
      setError('Failed to save profile. Please try again.');
      setLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Welcome to PropTracerPRO</CardTitle>
        <CardDescription>
          Let&apos;s get your account set up (Step {step} of 3)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="company">Company Name (Optional)</Label>
              <Input
                id="company"
                placeholder="Your Company LLC"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </div>
            <Button className="w-full" onClick={() => setStep(2)}>
              Continue
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Are you an AcquisitionPRO member?</Label>
              <p className="text-sm text-gray-500">
                Members receive free API access as part of their membership.
              </p>
              <div className="flex gap-3 mt-2">
                <Button
                  variant={isAcquisitionProMember === true ? 'default' : 'outline'}
                  onClick={() => setIsAcquisitionProMember(true)}
                  className="flex-1"
                >
                  Yes, I&apos;m a member
                </Button>
                <Button
                  variant={isAcquisitionProMember === false ? 'default' : 'outline'}
                  onClick={() => {
                    setIsAcquisitionProMember(false);
                    setVerificationStatus('idle');
                  }}
                  className="flex-1"
                >
                  No
                </Button>
              </div>
            </div>

            {isAcquisitionProMember === true && (
              <div className="space-y-3">
                <p className="text-sm text-gray-500">
                  We&apos;ll verify your membership using the email address you registered with.
                </p>
                <Button
                  onClick={verifyMembership}
                  disabled={verificationStatus === 'verifying' || verificationStatus === 'verified'}
                  variant={verificationStatus === 'verified' ? 'outline' : 'default'}
                  className="w-full"
                >
                  {verificationStatus === 'verifying' ? 'Verifying...' :
                   verificationStatus === 'verified' ? '✓ Membership Verified' : 'Verify My Membership'}
                </Button>
                {verificationStatus === 'verified' && (
                  <p className="text-sm text-green-600">
                    Membership verified! You&apos;ll receive free API access.
                  </p>
                )}
              </div>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(1)} className="flex-1">
                Back
              </Button>
              <Button
                onClick={() => setStep(3)}
                className="flex-1"
                disabled={isAcquisitionProMember === true && verificationStatus !== 'verified' && verificationStatus !== 'failed'}
              >
                {isAcquisitionProMember === true && verificationStatus === 'failed'
                  ? 'Continue without verification'
                  : 'Continue'}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>What will you primarily use PropTracerPRO for?</Label>
              <div className="grid gap-2 mt-2">
                {USE_CASES.map((useCase) => (
                  <Button
                    key={useCase.value}
                    variant={primaryUseCase === useCase.value ? 'default' : 'outline'}
                    onClick={() => setPrimaryUseCase(useCase.value)}
                    className="w-full justify-start"
                  >
                    {useCase.label}
                  </Button>
                ))}
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(2)} className="flex-1">
                Back
              </Button>
              <Button
                onClick={handleComplete}
                className="flex-1"
                disabled={loading}
              >
                {loading ? 'Saving...' : 'Complete Setup'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
