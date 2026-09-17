'use client';

import { useState, useRef, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TraceResultCard } from '@/components/trace/TraceResultCard';
import { PropertyRecordCard } from '@/components/trace/PropertyRecordCard';
import { FullTraceDisclosure } from '@/components/trace/FullTraceDisclosure';
import { US_STATES } from '@/lib/constants';
import type { EntitlementProfile } from '@/lib/suite/entitlements';
import type { TraceResult } from '@/types';

/**
 * Everything the trace routes actually return, which is more than this page
 * used to keep.
 *
 * The old shape named five keys, so `property_record` -- the thing a tier 2
 * customer paid for -- was dropped on the floor by the state setter on every
 * path: the inline tier 2 response, both cached branches, and the poll. The
 * warnings were dropped with it, including the one that says the wallet did not
 * cover the record.
 *
 * Declared here rather than imported: `types/index.ts` belongs to another
 * workstream this phase. `property_record` is deliberately `unknown`, because it
 * is the raw 86-key vendor dossier and PropertyRecordCard validates it at the
 * point of use.
 */
interface TraceResponse {
  success: boolean;
  is_cached?: boolean;
  status?: string;
  trace_id: string;
  tier?: number | null;
  result: TraceResult | null;
  property_record?: unknown;
  owner_name?: string | null;
  owner_type?: string | null;
  needs_manual_review?: boolean;
  warnings?: string[];
  charge: number;
}

export default function SingleTracePage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TraceResponse | null>(null);
  const [debugInfo, setDebugInfo] = useState<string | null>(null);

  // Form state
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [ownerName, setOwnerName] = useState('');

  /**
   * The opt-in: the caller has the owner name and wants the county property
   * record anyway. It is the second of the two triggers the route bills tier 2
   * on, so FullTraceDisclosure below is handed the same value.
   */
  const [wantsPropertyRecord, setWantsPropertyRecord] = useState(false);
  const hasOwnerName = Boolean(ownerName.trim());

  /**
   * ONE value for "this search pulls the property record", used by the
   * checkbox, by the request body and by the disclosure.
   *
   * The checkbox used to render `wantsPropertyRecord || !hasOwnerName` while
   * the body sent `wantsPropertyRecord` alone, so with the owner name blank the
   * control showed a tick beside a flag that went out false. The tier came out
   * right anyway, because the route reaches the same answer from the blank
   * owner name on its own, but a control that displays one thing and submits
   * another is a control nobody can trust. Derive it once and there is nothing
   * left to diverge.
   */
  const willPullPropertyRecord = wantsPropertyRecord || !hasOwnerName;

  /**
   * The caller's own profile, for the Full Property Trace rate.
   *
   * Null until it arrives, and the disclosure shows no figure while it is null:
   * a wrong price is worse than no price. Same three columns and the same
   * client-side load the bulk page already uses for its tier 1 rate; the rate
   * itself is derived inside FullTraceDisclosure from chargePerRecord(), which
   * is what the route bills with.
   */
  const [profile, setProfile] = useState<EntitlementProfile | null>(null);

  useEffect(() => {
    const loadProfile = async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from('user_profiles')
        .select('subscription_tier, is_acquisition_pro_member, gateway_products')
        .eq('id', user.id)
        .single();
      if (data) setProfile(data);
    };
    loadProfile();
  }, []);

  // Skip trace cache ref: set to true after clearing, consumed on next Search Property.
  const skipTraceCacheRef = useRef(false);

  const abortRef = useRef(false);

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
          // Sent whenever the box shows a tick, which is what the user is
          // looking at when they click Search. A blank owner name would route to
          // tier 2 on the route's own predicate regardless, so this changes no
          // price; it just stops the flag contradicting the checkbox.
          full_property_trace: willPullPropertyRecord || undefined,
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
            tier: statusData.tier ?? null,
            result: statusData.result,
            property_record: statusData.property_record ?? null,
            owner_type: statusData.owner_type ?? null,
            needs_manual_review: statusData.needs_manual_review ?? false,
            warnings: statusData.warnings ?? [],
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

  const clearCacheFromDB = async (type: 'trace' | 'all') => {
    if (!address || !city || !state || !zip) return;
    try {
      await fetch('/api/cache/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, city, state, zip, type }),
      });
    } catch {
      // Silent, cache clear is best-effort
    }
  };

  const handleClear = async () => {
    if (result && address && city && state && zip) {
      // What this actually does. excludeBilledRows() in lib/trace/billedRows.ts
      // keeps a DELETE off any row the customer has paid for, and the cache
      // serves that row back on the next search, so the old wording promising a
      // permanent delete and a fresh search was false for exactly the rows that
      // cost money. It is good news rather than a caveat: a paid record is the
      // customer's, and they do not get billed for it twice.
      const confirmed = window.confirm(
        'This clears the free cached result for this address, so the next search runs fresh.\n\nAnything you have already paid for is kept. A property record you bought, or a trace your wallet was charged for, stays in your history and comes back on the next search at no extra charge.\n\nContinue?'
      );
      if (!confirmed) return;

      setClearingCache(true);
      await clearCacheFromDB('all');
      setClearingCache(false);
      skipTraceCacheRef.current = true;
    }

    abortRef.current = true;
    setAddress('');
    setCity('');
    setState('');
    setZip('');
    setOwnerName('');
    setWantsPropertyRecord(false);
    setResult(null);
    setError(null);
    setDebugInfo(null);
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
                  <Label htmlFor="owner">Owner Name</Label>
                  {/*
                    NOT `required`. A blank owner name is a supported submit: it
                    is what routes the request to Full Property Trace, which the
                    API bills per record submitted. The browser used to refuse
                    that submit outright, so the tier the API charges for could
                    not be reached from this page at all. It is reachable now,
                    which is exactly why FullTraceDisclosure below is not
                    optional -- the price has to be on screen before the click.
                  */}
                  <Input
                    id="owner"
                    placeholder="John Smith"
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                  />
                  <p className="text-xs text-gray-500">
                    Leave this blank and we find the owner of record for you.
                  </p>
                </div>
              </div>

              {/*
                The opt-in. Amber, like the disclosure, because ticking it moves
                the request to the tier that bills per record submitted. It is
                ticked and locked when the owner name is blank: that request is
                already a Full Property Trace on the route's own predicate, and a
                box the user could untick would be telling them otherwise. The
                tick is willPullPropertyRecord, the same value the submit sends,
                so what is on screen is what goes out.
              */}
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <label htmlFor="full-property-trace" className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    id="full-property-trace"
                    data-testid="full-property-trace-toggle"
                    checked={willPullPropertyRecord}
                    disabled={!hasOwnerName}
                    onChange={(e) => setWantsPropertyRecord(e.target.checked)}
                    className="mt-1"
                  />
                  <span className="text-sm">
                    <span className="font-medium text-amber-900">Pull the full property record</span>
                    <span className="block text-amber-800 mt-1">
                      {hasOwnerName
                        ? 'You already have the owner name. Check this box to buy the county property record for this address as well.'
                        : 'Included on this search. With no owner name we buy the county property record to find the owner of record.'}
                    </span>
                  </span>
                </label>
              </div>

              <FullTraceDisclosure
                ownerName={ownerName}
                profile={profile}
                fullPropertyTrace={willPullPropertyRecord}
              />

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
          {/* Contacts first, then the county record the tier 2 charge bought. */}
          {result ? (
            <>
              <TraceResultCard
                result={result.result}
                isCached={result.is_cached ?? false}
                charge={result.charge}
                address={`${address}, ${city}, ${state} ${zip}`}
                traceId={result.trace_id}
              />

              {(result.warnings?.length || result.needs_manual_review) && (
                <div
                  role="note"
                  className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-1"
                >
                  {result.warnings?.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                  {result.needs_manual_review && (
                    <p>
                      We could not confirm a contact person behind this owner, so it is worth a
                      look by hand.
                    </p>
                  )}
                </div>
              )}

              <PropertyRecordCard record={result.property_record} />

              {/* The same 103-column file the bulk job produces, for one row.
                  Without it this page is read-only: the contacts and the county
                  dossier are on screen and the only way into the customer's own
                  system is retyping them. Same navigation pattern as the bulk
                  download button, so the browser saves the attachment. */}
              <div className="flex">
                <Button
                  variant="outline"
                  onClick={() => {
                    window.location.href = `/api/trace/single/download?trace_id=${result.trace_id}`;
                  }}
                >
                  Download CSV
                </Button>
              </div>
            </>
          ) : loading ? (
            <Card className="flex items-center justify-center">
              <CardContent className="text-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-4" />
                <p className="text-gray-700 font-medium">Searching...</p>
                <p className="text-gray-500 text-sm mt-1">This may take 10-30 seconds</p>
              </CardContent>
            </Card>
          ) : (
            <Card className="flex items-center justify-center">
              <CardContent className="text-center py-12">
                <p className="text-gray-500">
                  Enter a property address to see owner contact information
                </p>
              </CardContent>
            </Card>
          )}
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
