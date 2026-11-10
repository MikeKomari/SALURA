import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CircleCheck, Play, SkipForward } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../lib/api.ts';
import { ease } from '../../lib/motion.ts';
import { useAdmin } from '../admin-gate.tsx';
import { RunTraceById } from '../pages/run-trace.tsx';
import { Button } from '../ui/button.tsx';
import { Card } from '../ui/card.tsx';
import { Chip } from '../ui/chip.tsx';
import { Avatar, ErrorCallout, Skeleton } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { useToast } from '../ui/toast.tsx';

interface Candidate {
  customerId: number;
  name: string;
  waId: string;
  avgIntervalDays: number;
  daysSinceLastOrder: number;
  skipReason: string | null;
  usualOrder: { name: string; qty: number; unit: string }[];
}

interface RunResult {
  runId: string;
  status: 'completed' | 'escalated' | 'failed';
  reply: string;
}

/** The proactive reorder agent: who is due today, who is skipped and why, and a manual run. */
export function ProactiveCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { requireAdmin } = useAdmin();
  const [result, setResult] = useState<RunResult | null>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['proactive'],
    queryFn: () => api.get<{ candidates: Candidate[] }>('/api/proactive/candidates'),
  });

  const run = useMutation({
    mutationFn: () => api.post<RunResult>('/api/proactive/run'),
    onSuccess: (r) => {
      setResult(r);
      toast(r.status === 'completed' ? { tone: 'success', text: 'Agen selesai mengecek jadwal belanja warung.' } : { tone: 'error', text: 'Agen tidak bisa menyelesaikan pengecekan. Lihat jejaknya.' });
      for (const key of ['proactive', 'approvals', 'dashboard', 'orders', 'conversations']) qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => toast({ tone: 'error', text: (e as Error).message }),
  });

  const candidates = data?.candidates ?? [];
  const ready = candidates.filter((c) => !c.skipReason);
  const skipped = candidates.filter((c) => c.skipReason);

  return (
    <Card
      title="Pesan ulang otomatis"
      className="lg:col-span-12"
      action={
        <Button
          icon={Play}
          loading={run.isPending}
          onClick={async () => {
            if (await requireAdmin()) run.mutate();
          }}
        >
          Jalankan sekarang
        </Button>
      }
    >
      <p className="-mt-2 mb-4 max-w-3xl text-body text-ink-2">
        Setiap pukul 08.00 agen mencari warung yang sudah lewat jadwal belanja biasanya, lalu menawarkan pesanan biasanya. Warung dengan tagihan terlambat atau draf yang masih terbuka dilewati.
      </p>
      {error && <ErrorCallout message={(error as Error).message} onRetry={() => void refetch()} />}
      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <section aria-labelledby="proactive-ready">
            <h3 id="proactive-ready" className="mb-2 flex items-center gap-2 text-label font-semibold text-ink">
              <Icon icon={CalendarClock} size={20} className="text-primary" />
              Siap ditawari hari ini <Chip tone="success">{ready.length}</Chip>
            </h3>
            {ready.length ? (
              <ul className="flex flex-col gap-1">
                {ready.map((c) => (
                  <li key={c.customerId}>
                    <Link to={`/percakapan/${c.waId}`} className="flex items-center gap-3 rounded-inner px-2 py-2 hover:bg-surface-muted">
                      <Avatar name={c.name} size={36} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-label font-semibold text-ink">{c.name}</p>
                        <p className="truncate text-small text-ink-3">
                          Biasanya tiap {c.avgIntervalDays} hari · terakhir {c.daysSinceLastOrder} hari lalu · {c.usualOrder.length} barang
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 rounded-inner bg-surface-muted px-3 py-3 text-body text-ink-2">
                <Icon icon={CircleCheck} size={20} className="text-primary" />
                Tidak ada warung yang perlu ditawari sekarang.
              </p>
            )}
          </section>
          <section aria-labelledby="proactive-skipped">
            <h3 id="proactive-skipped" className="mb-2 flex items-center gap-2 text-label font-semibold text-ink">
              <Icon icon={SkipForward} size={20} className="text-ink-3" />
              Dilewati, dengan alasan <Chip>{skipped.length}</Chip>
            </h3>
            <ul className="flex flex-col gap-2">
              {skipped.map((c) => (
                <li key={c.customerId} className="rounded-inner px-2 py-1.5">
                  <p className="text-label font-semibold text-ink">{c.name}</p>
                  <p className="text-small text-ink-3">{c.skipReason}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
      <AnimatePresence initial={false}>
        {result && (
          <motion.section
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease } }}
            exit={{ opacity: 0 }}
            className="mt-6 flex flex-col gap-3 border-t border-border pt-5"
            aria-label="Hasil pengecekan terakhir"
          >
            <h3 className="text-h3 font-semibold text-ink">Laporan agen</h3>
            <p className="rounded-inner bg-surface-muted px-4 py-3 text-body whitespace-pre-line text-ink">{result.reply}</p>
            <p className="text-small text-ink-3">
              Tawaran yang perlu persetujuan ada di <Link to="/persetujuan" className="font-medium text-primary hover:underline">Persetujuan</Link>.
            </p>
            <RunTraceById runId={result.runId} />
          </motion.section>
        )}
      </AnimatePresence>
    </Card>
  );
}
