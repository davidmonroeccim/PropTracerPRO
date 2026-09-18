import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { HighLevelConnectionState } from '@/lib/highlevel/connectionState';

/**
 * The three states of a HighLevel connection, on screen.
 *
 * "Not Connected" and "Not working" are deliberately separate badges. One means
 * nobody has set it up and the other means it IS set up and HighLevel refused
 * it, and those need different things from the user. Collapsing them back into
 * a boolean is the bug this phase exists to fix.
 *
 * `data-hl-status` carries the classification so the render can be asserted on
 * the state rather than on a substring: "Not Connected" contains "Connected".
 */

export function HighLevelStatusBadge({ state }: { state: HighLevelConnectionState }) {
  if (state.status === 'connected') {
    return (
      <Badge data-hl-status="connected" className="bg-green-100 text-green-800">
        Connected
      </Badge>
    );
  }

  if (state.status === 'invalid') {
    return (
      <Badge data-hl-status="invalid" className="bg-red-100 text-red-800">
        <AlertTriangle className="h-3 w-3" />
        Not working
      </Badge>
    );
  }

  return (
    <Badge data-hl-status="not_connected" variant="secondary">
      Not Connected
    </Badge>
  );
}

/** The sentence telling the user what to actually do about it. */
export function HighLevelInvalidNotice({ state }: { state: HighLevelConnectionState }) {
  if (state.status !== 'invalid') return null;

  return (
    <div
      data-hl-invalid-reason={state.reason}
      className="text-sm p-3 rounded bg-red-50 text-red-700"
    >
      {state.remediation}
    </div>
  );
}
