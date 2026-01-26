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
import type { TraceHistory } from '@/types';

async function getTraceHistory(userId: string) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('trace_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('Failed to fetch trace history:', error);
    return [];
  }

  return data as TraceHistory[];
}

export default async function HistoryPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  const traces = await getTraceHistory(user.id);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'success':
        return <Badge className="bg-green-100 text-green-700">Success</Badge>;
      case 'cached':
        return <Badge className="bg-blue-100 text-blue-700">Cached</Badge>;
      case 'no_match':
        return <Badge className="bg-yellow-100 text-yellow-700">No Match</Badge>;
      case 'error':
        return <Badge variant="destructive">Error</Badge>;
      case 'processing':
        return <Badge variant="outline">Processing</Badge>;
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
            Showing your last 100 traces. Cached results are free.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {traces.length === 0 ? (
            <p className="text-center text-gray-500 py-8">
              No traces yet. Start by looking up a property!
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Results</TableHead>
                  <TableHead className="text-right">Charge</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {traces.map((trace) => (
                  <TableRow key={trace.id}>
                    <TableCell className="whitespace-nowrap">
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
                    <TableCell>
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
                    <TableCell className="text-right">
                      {trace.charge > 0 ? (
                        formatCurrency(trace.charge)
                      ) : (
                        <span className="text-gray-400">Free</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
