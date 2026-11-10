import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ListTree } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useState } from 'react';
import { api } from '../../lib/api.ts';
import { ease } from '../../lib/motion.ts';
import type { AgentRun, AuditEntry } from '../../lib/types.ts';
import { AgentTrace, RunHeader } from '../trace/agent-trace.tsx';
import { ErrorCallout, Skeleton } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { errorText } from './copy.ts';

/** Expandable "Jejak agen": the run that produced this hold, step by step, loaded on first open. */
export function AgentTrail({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['run-trace', runId],
    queryFn: () => api.get<{ run: AgentRun; steps: AuditEntry[] }>(`/api/runs/${runId}/trace`),
    enabled: open,
    refetchInterval: (q) => (q.state.data?.run.status === 'running' ? 2000 : false),
  });

  return (
    <section className="rounded-inner bg-surface-muted">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-inner px-4 py-3 text-left"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-info-bg text-info-fg">
          <Icon icon={ListTree} size={20} weight="semibold" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-label font-semibold text-ink">Jejak agen</span>
          <span className="block text-small text-ink-2">Langkah demi langkah: apa yang dicek agen dan kenapa ia menahan ini.</span>
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.15, ease }} className="grid text-ink-2">
          <Icon icon={ChevronDown} size={20} weight="semibold" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto', transition: { duration: 0.25, ease } }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.18, ease } }}
            className="overflow-hidden"
          >
            <div className="mx-2 mb-2 rounded-inner bg-surface p-4">
              {error ? (
                <ErrorCallout message={errorText(error)} onRetry={() => void refetch()} />
              ) : isLoading || !data ? (
                <div className="flex flex-col gap-3" aria-label="Memuat jejak agen">
                  <Skeleton className="h-6 w-1/2" />
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <RunHeader run={data.run} />
                  {data.steps.length ? <AgentTrace entries={data.steps} running={data.run.status === 'running'} /> : <p className="text-body text-ink-2">Jejak untuk proses ini kosong.</p>}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
