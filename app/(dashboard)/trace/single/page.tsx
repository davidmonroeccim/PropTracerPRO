'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TraceResultCard } from '@/components/trace/TraceResultCard';
import { AIResearchCard } from '@/components/trace/AIResearchCard';
import { US_STATES } from '@/lib/constants';
import type { TraceResult, AIResearchResult } from '@/types';
import { Search, Trash2 } from 'lucide-react';

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
  const [debugInfo, setDebugInfo] = useState<string | null>(null);

  // AI Research state
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchResult, setResearchResult] = useState<AIResearchResult | null>(null);
  const [researchCharge, setResearchCharge] = useState(0);
  const [researchError, setResearchError] = useState<string | null>(null);

  // Form state
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [ownerName, setOwnerName] = useState('');

  // Skip-cache refs: set to true after clearing, consumed on next request.
  // Using refs (not state) so the value is immediately available without waiting for re-render.
  const skipResearchCacheRef = useRef(false);
  const skipTraceCacheRef = useRef(false);

  const abortRef = useRef(false);

  const handleAISearch = async () => {
    if (!address || !city || !state || !zip) {
      setResearchError('Please fill in the address fields first');
      return;
    }

    setResearchLoading(true);
    setResearchError(null);
    setResearchResult(null);

    try {
      const shouldSkipCache = skipResearchCacheRef.current;
      skipResearchCacheRef.current = false;

      const response = await fetch('/api/research/single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          city,
          state,
          zip,
          owner_name: ownerName || undefined,
          skip_cache: shouldSkipCache || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setResearchError(data.error || 'AI research failed');
        setResearchLoading(false);
        return;
      }

      setResearchResult(data.research);
      setResearchCharge(data.charge || 0);

      // Auto-populate owner name if found and field is empty
      if (data.research?.owner_name && !ownerName) {
        // Use the individual behind business if available, otherwise owner name
        const bestName = data.research.individual_behind_business || data.research.owner_name;
        setOwnerName(bestName);
      }
    } catch {
      setResearchError('Failed to connect to server');
    } finally {
      setResearchLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    setDebugInfo(null);
    abortRef.current = false;

    try {
      // Submit the trace
      const shouldSkipCache = skipTraceCacheRef.current;
      skipTraceCacheRef.current = false;

      const response = await fetch('/api/trace/single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          city,
          state,
          zip,
          owner_name: ownerName || undefined,
          skip_cache: shouldSkipCache || undefined,
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
          if (statusData._debug) {
            setDebugInfo(JSON.stringify(statusData._debug, null, 2));
          }
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

  const [clearingCache, setClearingCache] = useState(false);
  const [clearingResearchCache, setClearingResearchCache] = useState(false);

  const clearCacheFromDB = async (type: 'ai_research' | 'trace' | 'all') => {
    if (!address || !city || !state || !zip) return;
    try {
      await fetch('/api/cache/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, city, state, zip, type }),
      });
    } catch {
      // Silent — cache clear is best-effort
    }
  };

  const handleClear = async () => {
    if ((result || researchResult) && address && city && state && zip) {
      const confirmed = window.confirm(
        'This will permanently delete the cached results for this address from the database. Future searches will run fresh.\n\nContinue?'
      );
      if (!confirmed) return;

      setClearingCache(true);
      await clearCacheFromDB('all');
      setClearingCache(false);
      skipResearchCacheRef.current = true;
      skipTraceCacheRef.current = true;
    }

    abortRef.current = true;
    setAddress('');
    setCity('');
    setState('');
    setZip('');
    setOwnerName('');
    setResult(null);
    setError(null);
    setDebugInfo(null);
    setLoading(false);
    setResearchResult(null);
    setResearchCharge(0);
    setResearchError(null);
    setResearchLoading(false);
  };

  const handleClearResearch = async () => {
    const confirmed = window.confirm(
      'This will permanently delete the cached AI research for this address from the database. The next AI Search will run fresh.\n\nContinue?'
    );
    if (!confirmed) return;

    setClearingResearchCache(true);
    await clearCacheFromDB('ai_research');
    setClearingResearchCache(false);
    skipResearchCacheRef.current = true;
    setResearchResult(null);
    setResearchCharge(0);
    setResearchError(null);
    setOwnerName('');
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
                  <div className="flex gap-2">
                    <Input
                      id="owner"
                      placeholder="John Smith"
                      value={ownerName}
                      onChange={(e) => setOwnerName(e.target.value)}
                      required
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleAISearch}
                      disabled={researchLoading || !address || !city || !state || !zip}
                      className="shrink-0 h-10 px-3"
                      title="AI Search - Find owner name ($0.15)"
                    >
                      {researchLoading ? (
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600" />
                      ) : (
                        <>
                          <Search className="h-4 w-4 mr-1" />
                          AI Search
                        </>
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-gray-500">
                    Required for skip trace. Use AI Search ($0.15 per name found) to find the owner, or type manually.
                  </p>
                </div>
              </div>

              {researchError && (
                <p className="text-sm text-red-600">{researchError}</p>
              )}

              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}

              <div className="flex gap-3">
                <Button type="submit" disabled={loading} className="flex-1">
                  {loading ? 'Searching...' : 'Search Property'}
                </Button>
                <Button type="button" variant="outline" onClick={handleClear} disabled={clearingCache}>
                  {clearingCache ? 'Clearing...' : 'Clear'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Results */}
        <div className="space-y-4">
          {/* AI Research Card */}
          {researchResult && (
            <div className="space-y-2">
              <AIResearchCard research={researchResult} charge={researchCharge} />
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearResearch}
                disabled={clearingResearchCache}
                className="w-full text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
              >
                {clearingResearchCache ? (
                  'Clearing...'
                ) : (
                  <>
                    <Trash2 className="h-4 w-4 mr-1" />
                    Clear AI Research Cache
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Trace Result Card */}
          {result ? (
            <TraceResultCard
              result={result.result}
              isCached={result.is_cached}
              charge={result.charge}
              address={`${address}, ${city}, ${state} ${zip}`}
              traceId={result.trace_id}
            />
          ) : loading ? (
            <Card className="flex items-center justify-center">
              <CardContent className="text-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-4" />
                <p className="text-gray-700 font-medium">Searching...</p>
                <p className="text-gray-500 text-sm mt-1">This may take 10-30 seconds</p>
              </CardContent>
            </Card>
          ) : !researchResult ? (
            <Card className="flex items-center justify-center">
              <CardContent className="text-center py-12">
                <p className="text-gray-500">
                  Enter a property address to see owner contact information
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {debugInfo && (
        <details className="mt-4">
          <summary className="text-xs text-gray-400 cursor-pointer">Debug Info</summary>
          <pre className="mt-2 p-3 bg-gray-100 rounded text-xs overflow-auto max-h-48">{debugInfo}</pre>
        </details>
      )}
    </div>
  );
}
