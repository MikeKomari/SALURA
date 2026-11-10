import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { ease } from '../../lib/motion.ts';
import type { AgentRun, AuditEntry } from '../../lib/types.ts';
import { AgentTrace, RunHeader } from '../trace/agent-trace.tsx';
import { ErrorCallout, Skeleton } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';

export interface RunTrace {
  run: AgentRun;
  steps: AuditEntry[];
}

export function useRunTrace(runId: string | null) {
  return useQuery({
    queryKey: ['run-trace', runId],
    queryFn: () => api.get<RunTrace>(`/api/runs/${runId}/trace`),
    enabled: Boolean(runId),
  });
}

/** One agent run as a collapsible block: header (status, steps, time, cost) and its timeline. */
export function RunTraceBlock({ trace, defaultOpen = false }: { trace: RunTrace; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-inner bg-surface-muted/60 p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full cursor-pointer items-start justify-between gap-3 text-left">
        <div className="min-w-0 flex-1">
          <RunHeader run={trace.run} />
          <p className="mt-1 truncate text-small text-ink-2">{trace.run.goal}</p>
        </div>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.15, ease }} className="grid size-8 shrink-0 place-items-center rounded-full text-primary">
          <Icon icon={ChevronDown} size={20} weight="semibold" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease }} className="overflow-hidden">
            <div className="pt-4">
              {trace.steps.length ? <AgentTrace entries={trace.steps} running={trace.run.status === 'running'} /> : <p className="text-small text-ink-3">Belum ada langkah yang tercatat.</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Loads a run by id and renders it; used where only `approval.runId` is known. */
export function RunTraceById({ runId, defaultOpen }: { runId: string; defaultOpen?: boolean }) {
  const { data, isLoading, error, refetch } = useRunTrace(runId);
  if (isLoading) return <Skeleton className="h-20" />;
  if (error || !data) return <ErrorCallout message={error ? (error as Error).message : 'Jejak agen tidak ditemukan.'} onRetry={() => void refetch()} />;
  return <RunTraceBlock trace={data} defaultOpen={defaultOpen} />;
}
