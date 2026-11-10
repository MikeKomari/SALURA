import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api.ts';
import type { Approval } from '../../lib/types.ts';
import { useAdmin } from '../admin-gate.tsx';
import { useToast } from '../ui/toast.tsx';
import { errorText, successText } from './copy.ts';

export type EditedLine = { productId: number; qty: number; unit: string };

export type Decision =
  | { action: 'approve'; editedLines?: EditedLine[]; note?: string }
  | { action: 'reject'; note: string };

export type DecisionKind = 'approve' | 'edit' | 'reject';

export const PENDING_KEY = ['approvals', 'pending'] as const;

/**
 * Approve or reject one held action. Needs an admin account; removes the row from the
 * pending list as soon as the server agrees (so it animates out), then refreshes everything it touches.
 */
export function useDecision() {
  const qc = useQueryClient();
  const toast = useToast();
  const { requireAdmin, signOut } = useAdmin();

  const mutation = useMutation({
    mutationFn: ({ approval, decision: { action, ...body } }: { approval: Approval; decision: Decision; kind: DecisionKind }) =>
      api.post<{ approval: Approval }>(`/api/approvals/${approval.id}/${action}`, body),
    onSuccess: (_res, { approval, decision }) => {
      qc.setQueryData<{ approvals: Approval[] }>(PENDING_KEY, (old) => old && { approvals: old.approvals.filter((a) => a.id !== approval.id) });
      toast({ tone: 'success', text: successText(approval, decision.action, decision.action === 'approve' && Boolean(decision.editedLines?.length)) });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) signOut();
      toast({ tone: 'error', text: errorText(err) });
    },
    onSettled: (_res, _err, { approval }) => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      if (approval.type === 'reminder') qc.invalidateQueries({ queryKey: ['overdue'] });
      if (approval.type === 'payment' || approval.type === 'invoice_adjustment') qc.invalidateQueries({ queryKey: ['overpaid'] });
      if (approval.runId) qc.invalidateQueries({ queryKey: ['run-trace', approval.runId] });
    },
  });

  /** Resolves true when the decision was saved; false when cancelled or refused. */
  const decide = async (approval: Approval, decision: Decision, kind: DecisionKind = decision.action): Promise<boolean> => {
    if (!(await requireAdmin())) return false;
    try {
      await mutation.mutateAsync({ approval, decision, kind });
      return true;
    } catch {
      return false;
    }
  };

  const busy = mutation.isPending ? { id: mutation.variables.approval.id, kind: mutation.variables.kind } : null;
  return { decide, busy };
}
