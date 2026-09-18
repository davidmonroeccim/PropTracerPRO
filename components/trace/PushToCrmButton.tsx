'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Check, AlertCircle, Upload } from 'lucide-react';

interface PushToCrmButtonProps {
  traceId?: string;
  jobId?: string;
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'default' | 'sm';
  label?: string;
}

/** What the customer is told once the push has run. */
export interface PushOutcome {
  status: 'success' | 'error';
  message: string;
}

/**
 * Run the push and read the OUTCOME the server reported.
 *
 * This used to be inline in the click handler and it branched on `response.ok`,
 * then on `data.pushed`, then on `data.action`. It never read `data.success`,
 * so a dead API key (which came back as `{success:false}` at HTTP 200) rendered
 * a green check saying "Contact created" for a contact that was never created.
 * The route no longer sends a failure at 200, but the body is still what
 * decides here: a transport code cannot tell you whether the CRM took the
 * contact, and a partial bulk job is a 207, which IS ok.
 *
 * Extracted from the component because this repo has no DOM test environment,
 * so a handler that keeps this decision inside itself cannot be tested at all.
 */
export async function requestPush(body: {
  trace_id?: string;
  job_id?: string;
}): Promise<PushOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/integrations/highlevel/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      status: 'error',
      message: 'Could not reach the server. Check your connection and try again.',
    };
  }

  const data: Record<string, unknown> | null = await response
    .json()
    .catch(() => null);

  // Only a positive claim of success is a success. An absent `success` is not
  // a success: we do not know what happened, so we do not tell the customer
  // their contact is in the CRM (repo rule 7).
  if (!response.ok || data?.success !== true) {
    const error = data?.error;
    return {
      status: 'error',
      message: typeof error === 'string' && error ? error : 'The push to HighLevel failed.',
    };
  }

  if (typeof data.pushed === 'number') {
    return {
      status: 'success',
      message: `${data.pushed} contact${data.pushed !== 1 ? 's' : ''} pushed`,
    };
  }

  return {
    status: 'success',
    message: data.action === 'updated' ? 'Contact updated' : 'Contact created',
  };
}

/**
 * The result line. The message is now a full sentence naming the remediation
 * rather than a two word status, so it carries a title attribute: the span is
 * width-capped to keep table rows from reflowing and the tail would otherwise
 * be unreadable.
 */
export function PushOutcomeMessage({ outcome }: { outcome: PushOutcome }) {
  if (outcome.status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-green-600">
        <Check className="h-4 w-4" />
        {outcome.message}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 text-sm text-red-600 max-w-[320px]"
      title={outcome.message}
    >
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span className="truncate">{outcome.message}</span>
    </span>
  );
}

export function PushToCrmButton({
  traceId,
  jobId,
  variant = 'outline',
  size = 'sm',
  label = 'Add to CRM',
}: PushToCrmButtonProps) {
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<PushOutcome | null>(null);

  const handlePush = async () => {
    setLoading(true);
    setOutcome(await requestPush(traceId ? { trace_id: traceId } : { job_id: jobId }));
    setLoading(false);
  };

  if (outcome) return <PushOutcomeMessage outcome={outcome} />;

  return (
    <Button variant={variant} size={size} onClick={handlePush} disabled={loading}>
      <Upload className="h-4 w-4 mr-1" />
      {loading ? 'Pushing...' : label}
    </Button>
  );
}
