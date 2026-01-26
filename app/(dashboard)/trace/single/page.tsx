'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TraceResultCard } from '@/components/trace/TraceResultCard';
import { US_STATES } from '@/lib/constants';
import type { TraceResult } from '@/types';

export default function SingleTracePage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    success: boolean;
    is_cached: boolean;
    trace_id: string;
    result: TraceResult | null;
    charge: number;
  } | null>(null);

  // Form state
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [ownerName, setOwnerName] = useState('');

  const abortRef = useRef(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    abortRef.current = false;

    try {
      // Submit the trace
      const response = await fetch('/api/trace/single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          city,
          state,
          zip,
          owner_name: ownerName || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to trace property');
        setLoading(false);
        return;
      }

      // Cached result - show immediately
      if (data.is_cached || data.result) {
        setResult(data);
        setLoading(false);
        return;
      }

      // Processing - poll for results
      if (data.status === 'processing' && data.trace_id) {
        const traceId = data.trace_id;
        let attempts = 0;
        const maxAttempts = 20; // ~65 seconds total

        while (attempts < maxAttempts && !abortRef.current) {
          // Wait 5s before first poll (Tracerfy needs processing time), then 3s
          await new Promise((resolve) => setTimeout(resolve, attempts === 0 ? 5000 : 3000));
          attempts++;

          const statusResponse = await fetch(
            `/api/trace/status?trace_id=${traceId}`
          );
          const statusData = await statusResponse.json();

          if (!statusData.success) {
            setError(statusData.error || 'Failed to check trace status');
            setLoading(false);
            return;
          }

          // Still processing
          if (statusData.status === 'processing') {
            continue;
          }

          // Results ready (success or no_match)
          setResult({
            success: true,
            is_cached: statusData.is_cached || false,
            trace_id: statusData.trace_id,
            result: statusData.result,
            charge: statusData.charge || 0,
          });
          setLoading(false);
          return;
        }

        // Timed out
        setError('Trace is taking longer than expected. Check History for results.');
        setLoading(false);
        return;
      }

      // Unexpected response
      setResult(data);
    } catch {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    abortRef.current = true;
    setAddress('');
    setCity('');
    setState('');
    setZip('');
    setOwnerName('');
    setResult(null);
    setError(null);
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Single Property Trace</h1>
        <p className="text-gray-500">Look up owner contact information for a property</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Search Form */}
        <Card>
          <CardHeader>
            <CardTitle>Property Details</CardTitle>
            <CardDescription>
              Enter the property address to find owner contact information
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="address">Street Address *</Label>
                <Input
                  id="address"
                  placeholder="123 Main Street"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="city">City *</Label>
                  <Input
                    id="city"
                    placeholder="San Antonio"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State *</Label>
                  <select
                    id="state"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    required
                  >
                    <option value="">Select state</option>
                    {US_STATES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="zip">ZIP Code *</Label>
                  <Input
                    id="zip"
                    placeholder="78201"
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                    maxLength={10}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="owner">Owner Name *</Label>
                  <Input
                    id="owner"
                    placeholder="John Smith"
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    required
                  />
                  <p className="text-xs text-gray-500">Required for skip trace lookup</p>
                </div>
              </div>

              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}

              <div className="flex gap-3">
                <Button type="submit" disabled={loading} className="flex-1">
                  {loading ? 'Searching...' : 'Search Property'}
                </Button>
                <Button type="button" variant="outline" onClick={handleClear}>
                  Clear
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Results */}
        <div>
          {result ? (
            <TraceResultCard
              result={result.result}
              isCached={result.is_cached}
              charge={result.charge}
              address={`${address}, ${city}, ${state} ${zip}`}
            />
          ) : loading ? (
            <Card className="h-full flex items-center justify-center">
              <CardContent className="text-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-4" />
                <p className="text-gray-700 font-medium">Searching...</p>
                <p className="text-gray-500 text-sm mt-1">This may take 10-30 seconds</p>
              </CardContent>
            </Card>
          ) : (
            <Card className="h-full flex items-center justify-center">
              <CardContent className="text-center py-12">
                <p className="text-gray-500">
                  Enter a property address to see owner contact information
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
