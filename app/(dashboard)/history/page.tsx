import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { format } from 'date-fns';
import { Download } from 'lucide-react';
import { PushToCrmButton } from '@/components/trace/PushToCrmButton';
import type { TraceHistory, TraceJob } from '@/types';
import { PRICING } from '@/lib/constants';

type HistoryEntry =
  | { type: 'single'; date: string; data: TraceHistory }
  | { type: 'bulk'; date: string; data: TraceJob };

async function getSingleTraces(userId: string, bulkTracerfyJobIds: string[]) {
  const supabase = await createClient();

  let query = supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (bulkTracerfyJobIds.length > 0) {
    // Exclude rows that belong to bulk jobs so the 100-row limit
    // only counts actual single traces
    query = query.not('tracerfy_job_id', 'in', `(${bulkTracerfyJobIds.join(',')})`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Failed to fetch trace history:', error);
    return [];
  }

  return data as TraceHistory[];
}

async function getTraceJobs(userId: string) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('trace_jobs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('Failed to fetch trace jobs:', error);
    return [];
  }

  return data as TraceJob[];
}

export default async function HistoryPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  // Fetch jobs first so we can exclude their trace_history rows from the single-trace query.
  // Without this, the 100-row limit on trace_history would be consumed by bulk rows,
  // hiding older single traces.
  const jobs = await getTraceJobs(user.id);
  const bulkTracerfyJobIds = jobs
    .map(j => j.tracerfy_job_id)
    .filter((id): id is string => id !== null);

  const singleTraces = await getSingleTraces(user.id, bulkTracerfyJobIds);

  // Merge into unified sorted list
  const entries: HistoryEntry[] = [
    ...singleTraces.map(t => ({ type: 'single' as const, date: t.created_at, data: t })),
    ...jobs.map(j => ({ type: 'bulk' as const, date: j.created_at, data: j })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'success':
        return <Badge className="bg-green-100 text-green-700">Success</Badge>;
      case 'cached':
        return <Badge className="bg-blue-100 text-blue-700">Cached</Badge>;
      case 'no_match':
        return <Badge className="bg-yellow-100 text-yellow-700">No Match</Badge>;
      case 'error':
      case 'failed':
        return <Badge variant="destructive">Error</Badge>;
      case 'processing':
        return <Badge variant="outline">Processing</Badge>;
      case 'completed':
        return <Badge className="bg-green-100 text-green-700">Completed</Badge>;
      case 'pending':
        return <Badge variant="outline">Pending</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Trace History</h1>
        <p className="text-gray-500">View all your past property traces</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Traces</CardTitle>
          <CardDescription>
            Your recent traces and bulk uploads.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p className="text-center text-gray-500 py-8">
              No traces yet. Start by looking up a property!
            </p>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden xl:table-cell">Results</TableHead>
                  <TableHead className="hidden xl:table-cell text-right">Charge</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => {
                  if (entry.type === 'single') {
                    const trace = entry.data;
                    return (
                      <TableRow key={`trace-${trace.id}`}>
                        <TableCell className="xl:whitespace-nowrap">
                          {format(new Date(trace.created_at), 'MMM d, yyyy h:mm a')}
                        </TableCell>
                        <TableCell>
                          <div>
                            <p className="font-medium">{trace.normalized_address}</p>
                            <p className="text-sm text-gray-500">
                              {trace.city}, {trace.state} {trace.zip}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>{getStatusBadge(trace.status)}</TableCell>
                        <TableCell className="hidden xl:table-cell">
                          {trace.is_successful ? (
                            <div className="text-sm">
                              <span className="text-green-600">{trace.phone_count} phones</span>
                              {', '}
                              <span className="text-blue-600">{trace.email_count} emails</span>
                            </div>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden xl:table-cell text-right">
                          {trace.charge > 0 ? (
                            formatCurrency(trace.charge)
                          ) : (
                            <span className="text-gray-400">Free</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {trace.is_successful && (
                            <PushToCrmButton traceId={trace.id} />
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  }

                  // Bulk job row
                  const job = entry.data;
                  const bulkCharge = job.records_matched * PRICING.CHARGE_PER_SUCCESS;

                  return (
                    <TableRow key={`job-${job.id}`}>
                      <TableCell className="xl:whitespace-nowrap">
                        {format(new Date(job.created_at), 'MMM d, yyyy h:mm a')}
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="font-medium">
                            <Badge className="bg-purple-100 text-purple-700 mr-2">Bulk</Badge>
                            {job.file_name || 'Bulk Upload'}
                          </p>
                          <p className="text-sm text-gray-500">
                            {job.total_records} total, {job.records_submitted} submitted
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>{getStatusBadge(job.status)}</TableCell>
                      <TableCell className="hidden xl:table-cell">
                        {job.status === 'completed' ? (
                          <div className="text-sm">
                            <span className="text-green-600">
                              {job.records_matched} of {job.records_submitted} matched
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell text-right">
                        {bulkCharge > 0 ? (
                          formatCurrency(bulkCharge)
                        ) : (
                          <span className="text-gray-400">Free</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {job.status === 'completed' && (
                          <div className="flex items-center gap-2">
                            <a
                              href={`/api/trace/bulk/download?job_id=${job.id}`}
                              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
                            >
                              <Download className="h-4 w-4" />
                              CSV
                            </a>
                            <PushToCrmButton jobId={job.id} label="CRM" />
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
