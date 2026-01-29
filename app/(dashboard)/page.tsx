import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Search, FileUp, ArrowRight, Download } from 'lucide-react';
import { PushToCrmButton } from '@/components/trace/PushToCrmButton';
import { PRICING, getChargePerTrace } from '@/lib/constants';
import type { TraceHistory, TraceJob } from '@/types';

async function getUsageStats(userId: string) {
  const supabase = await createClient();

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Get traces today
  const { count: tracesToday } = await supabase
    .from('trace_history')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', startOfToday.toISOString());

  // Get traces this month
  const { count: tracesThisMonth } = await supabase
    .from('trace_history')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', startOfMonth.toISOString());

  // Get successful traces this month
  const { count: successfulThisMonth } = await supabase
    .from('trace_history')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_successful', true)
    .gte('created_at', startOfMonth.toISOString());

  // Get total spend this month from actual trace charges
  const { data: chargeData } = await supabase
    .from('trace_history')
    .select('charge')
    .eq('user_id', userId)
    .gte('created_at', startOfMonth.toISOString())
    .gt('charge', 0);

  const spendThisMonth = chargeData?.reduce((sum, row) => sum + (row.charge || 0), 0) || 0;

  return {
    tracesToday: tracesToday || 0,
    tracesThisMonth: tracesThisMonth || 0,
    successfulThisMonth: successfulThisMonth || 0,
    spendThisMonth,
  };
}

type RecentEntry =
  | { type: 'single'; date: string; data: TraceHistory }
  | { type: 'bulk'; date: string; data: TraceJob };

async function getRecentJobs(userId: string) {
  const supabase = await createClient();

  const { data } = await supabase
    .from('trace_jobs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  return (data || []) as TraceJob[];
}

async function getRecentSingleTraces(userId: string, bulkTracerfyJobIds: string[]) {
  const supabase = await createClient();

  let query = supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (bulkTracerfyJobIds.length > 0) {
    query = query.not('tracerfy_job_id', 'in', `(${bulkTracerfyJobIds.join(',')})`);
  }

  const { data } = await query;
  return (data || []) as TraceHistory[];
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  const [stats, recentJobs, profileResult] = await Promise.all([
    getUsageStats(user.id),
    getRecentJobs(user.id),
    supabase.from('user_profiles').select('subscription_tier, is_acquisition_pro_member').eq('id', user.id).single(),
  ]);

  const userProfile = profileResult.data;
  const perTrace = userProfile
    ? getChargePerTrace(userProfile.subscription_tier, userProfile.is_acquisition_pro_member)
    : PRICING.CHARGE_PER_SUCCESS_WALLET;

  const bulkTracerfyJobIds = recentJobs
    .map(j => j.tracerfy_job_id)
    .filter((id): id is string => id !== null);

  const recentSingles = await getRecentSingleTraces(user.id, bulkTracerfyJobIds);

  const recentEntries: RecentEntry[] = [
    ...recentSingles.map(t => ({ type: 'single' as const, date: t.created_at, data: t })),
    ...recentJobs.map(j => ({ type: 'bulk' as const, date: j.created_at, data: j })),
  ]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 7);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500">Welcome back. Here&apos;s your skip tracing overview.</p>
      </div>

      {/* Quick Actions */}
      <div className="grid gap-4 md:grid-cols-2">
        <Link href="/trace/single">
          <Card className="hover:bg-gray-50 transition-colors cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Single Trace</CardTitle>
              <Search className="h-4 w-4 text-gray-500" />
            </CardHeader>
            <CardContent>
              <p className="text-xs text-gray-500">
                Look up owner contact info for a single property
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/trace/bulk">
          <Card className="hover:bg-gray-50 transition-colors cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Bulk Upload</CardTitle>
              <FileUp className="h-4 w-4 text-gray-500" />
            </CardHeader>
            <CardContent>
              <p className="text-xs text-gray-500">
                Upload a CSV file with multiple properties
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Traces Today</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.tracesToday}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">This Month</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.tracesThisMonth}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Successful</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.successfulThisMonth}</div>
            <p className="text-xs text-gray-500">
              {stats.tracesThisMonth > 0
                ? `${Math.round((stats.successfulThisMonth / stats.tracesThisMonth) * 100)}% success rate`
                : 'No traces yet'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Spend This Month</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(stats.spendThisMonth)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Traces */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Recent Traces</CardTitle>
              <CardDescription>Your latest traces and bulk uploads</CardDescription>
            </div>
            <Link href="/history">
              <Button variant="ghost" size="sm">
                View All
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {recentEntries.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              No traces yet. Start by looking up a property!
            </p>
          ) : (
            <div className="space-y-4">
              {recentEntries.map((entry) => {
                if (entry.type === 'single') {
                  const trace = entry.data;
                  return (
                    <div
                      key={`trace-${trace.id}`}
                      className="flex items-center justify-between border-b border-gray-100 pb-4 last:border-0 last:pb-0"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {trace.normalized_address}
                        </p>
                        <p className="text-xs text-gray-500">
                          {trace.city}, {trace.state} {trace.zip}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                            trace.status === 'success'
                              ? 'bg-green-100 text-green-700'
                              : trace.status === 'cached'
                              ? 'bg-blue-100 text-blue-700'
                              : trace.status === 'no_match'
                              ? 'bg-yellow-100 text-yellow-700'
                              : 'bg-gray-100 text-gray-700'
                          }`}
                        >
                          {trace.status === 'success'
                            ? `${trace.phone_count} phones, ${trace.email_count} emails`
                            : trace.status === 'cached'
                            ? 'Cached'
                            : trace.status === 'no_match'
                            ? 'No Match'
                            : trace.status}
                        </span>
                        {trace.is_successful && (
                          <PushToCrmButton traceId={trace.id} size="sm" />
                        )}
                      </div>
                    </div>
                  );
                }

                // Bulk job entry
                const job = entry.data;
                const bulkCharge = job.records_matched * perTrace;

                return (
                  <div
                    key={`job-${job.id}`}
                    className="flex items-center justify-between border-b border-gray-100 pb-4 last:border-0 last:pb-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        <Badge className="bg-purple-100 text-purple-700 mr-2">Bulk</Badge>
                        {job.file_name || 'Bulk Upload'}
                      </p>
                      <p className="text-xs text-gray-500">
                        {job.total_records} total, {job.records_submitted} submitted
                        {job.status === 'completed' && (
                          <> &middot; {job.records_matched} matched &middot; {formatCurrency(bulkCharge)}</>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                          job.status === 'completed'
                            ? 'bg-green-100 text-green-700'
                            : job.status === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {job.status === 'completed'
                          ? 'Completed'
                          : job.status === 'failed'
                          ? 'Failed'
                          : 'Processing'}
                      </span>
                      {job.status === 'completed' && (
                        <div className="flex items-center gap-2">
                          <a
                            href={`/api/trace/bulk/download?job_id=${job.id}`}
                            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
                          >
                            <Download className="h-4 w-4" />
                            CSV
                          </a>
                          <PushToCrmButton jobId={job.id} label="CRM" size="sm" />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
