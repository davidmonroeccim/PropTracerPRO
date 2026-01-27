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

export function PushToCrmButton({
  traceId,
  jobId,
  variant = 'outline',
  size = 'sm',
  label = 'Add to CRM',
}: PushToCrmButtonProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const handlePush = async () => {
    setStatus('loading');
    setMessage(null);

    try {
      const response = await fetch('/api/integrations/highlevel/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(traceId ? { trace_id: traceId } : { job_id: jobId }),
      });

      const data = await response.json();

      if (!response.ok) {
        setStatus('error');
        setMessage(data.error);
        return;
      }

      setStatus('success');
      if (data.pushed !== undefined) {
        setMessage(`${data.pushed} contact${data.pushed !== 1 ? 's' : ''} pushed`);
      } else {
        setMessage(data.action === 'updated' ? 'Contact updated' : 'Contact created');
      }
    } catch {
      setStatus('error');
      setMessage('Failed to connect');
    }
  };

  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-green-600">
        <Check className="h-4 w-4" />
        {message}
      </span>
    );
  }

  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-red-600 max-w-[200px]">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span className="truncate">{message}</span>
      </span>
    );
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handlePush}
      disabled={status === 'loading'}
    >
      <Upload className="h-4 w-4 mr-1" />
      {status === 'loading' ? 'Pushing...' : label}
    </Button>
  );
}
