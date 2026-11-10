import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, CircleCheck, ClipboardCheck, Clock, Play, Send, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useAdmin } from '../components/admin-gate.tsx';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { BankStatementCard } from '../components/collections/bank-statement.tsx';
import { RunTraceBlock, useRunTrace } from '../components/pages/run-trace.tsx';
import { PanelSection, SlideOver } from '../components/pages/slide-over.tsx';
import { AgentTrace } from '../components/trace/agent-trace.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Chip, type Tone } from '../components/ui/chip.tsx';
import { Avatar, EmptyState, ErrorCallout, Skeleton } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { KpiCard } from '../components/ui/kpi-card.tsx';
import { useToast } from '../components/ui/toast.tsx';
import { api } from '../lib/api.ts';
import { date, rupiah, rupiahShort } from '../lib/format.ts';
import { useLiveEvent } from '../lib/live.ts';
import { ease, hover } from '../lib/motion.ts';
import type { AuditEntry, LiveEvent, OverdueInvoice, Overpayment, Payment } from '../lib/types.ts';

interface RunResult {
  runId: string;
  status: 'completed' | 'escalated' | 'failed';
  reply: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

const TONE_LABEL: Record<string, string> = {
  friendly: 'Ramah',
  neutral: 'Netral',
  firm: 'Tegas',
};

function lateTone(days: number): Tone {
  if (days > 14) return 'danger';
  if (days >= 7) return 'warning';
  return 'info';
}

function lastReminder(inv: OverdueInvoice) {
  if (inv.lastReminderDaysAgo === null) return 'Belum pernah';
  const when = inv.lastReminderDaysAgo === 0 ? 'Hari ini' : `${inv.lastReminderDaysAgo} hari lalu`;
  return inv.remindersSent > 1 ? `${when} · ${inv.remindersSent}× terkirim` : when;
}

/** Counts what the run did with each invoice, read from its own audit steps. */
function outcomes(steps: AuditEntry[]) {
  const reminders = steps.filter((s) => s.tool === 'draft_reminder');
  const outcome = (s: AuditEntry) => (s.data as { outcome?: string } | null)?.outcome;
  return {
    sent: reminders.filter((s) => s.type === 'tool_result' && outcome(s) === 'sent').length,
    queued: reminders.filter((s) => s.type === 'tool_result' && outcome(s) === 'awaiting_approval').length,
    skipped: reminders.filter((s) => s.type === 'validation' || s.type === 'error').length,
  };
}

export function CollectionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { requireAdmin } = useAdmin();
  const location = useLocation();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['overdue'],
    queryFn: () => api.get<{ invoices: OverdueInvoice[] }>('/api/collections/overdue'),
  });
  const invoices = data?.invoices ?? [];

  const [panel, setPanel] = useState(false);
  const [live, setLive] = useState<AuditEntry[]>([]);
  const liveRun = useRef<string | null>(null);

  const run = useMutation({
    mutationFn: () => api.post<RunResult>('/api/collections/run'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['overdue'] });
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      if (r.status === 'failed')
        toast({
          tone: 'error',
          text: 'Agen penagihan tidak selesai. Lihat jejaknya untuk penyebabnya.',
        });
      else toast({ tone: 'success', text: 'Pengecekan tagihan selesai.' });
    },
    onError: (err) => toast({ tone: 'error', text: (err as Error).message }),
  });

  // Follow the collections run live while the request is still open (it can take 10–30 seconds).
  const pending = run.isPending;
  const onLive = useCallback(
    (e: LiveEvent) => {
      if (!pending) return;
      if (e.type === 'run' && e.run.trigger === 'schedule' && e.run.waId === null && !liveRun.current) liveRun.current = e.run.id;
      if (e.type === 'audit' && e.entry.runId && e.entry.runId === liveRun.current) setLive((l) => [...l, e.entry]);
    },
    [pending],
  );
  useLiveEvent(onLive);

  const start = async () => {
    if (!(await requireAdmin())) return;
    liveRun.current = null;
    setLive([]);
    setPanel(true);
    run.mutate();
  };

  useEffect(() => {
    if (location.hash === '#daftar-tagihan' || location.hash === '#mutasi-bank') document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash]);

  const total = invoices.reduce((s, i) => s + i.outstanding, 0);
  const customers = new Set(invoices.map((i) => i.customerId)).size;
  const promised = invoices.filter((i) => i.promiseToPayAt).length;
  const severe = invoices.filter((i) => i.daysOverdue > 14).length;

  return (
    <Page>
      <PageHeader
        title="Penagihan"
        subtitle="Tagihan yang lewat jatuh tempo. Agen memilih nada pengingat dari template yang sudah disetujui."
        actions={
          <>
            <Button icon={Play} loading={run.isPending} onClick={() => void start()}>
              {run.isPending ? 'Agen sedang bekerja…' : 'Jalankan agen penagihan'}
            </Button>
            {run.data && !run.isPending && (
              <Button variant="outline" onClick={() => setPanel(true)}>
                Lihat hasil terakhir
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorCallout message={(error as Error).message} onRetry={() => void refetch()} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard highlighted title="Total jatuh tempo" value={data ? total : null} format={rupiahShort} loading={isLoading} to="/penagihan#daftar-tagihan" footer="Sisa tagihan yang belum dibayar" />
        <KpiCard title="Tagihan terlambat" value={data ? invoices.length : null} loading={isLoading} to="/penagihan#daftar-tagihan" footer={data ? `${severe} di antaranya lewat 14 hari` : ' '} />
        <KpiCard title="Pelanggan" value={data ? customers : null} loading={isLoading} to="/percakapan" footer="Warung dengan tagihan terlambat" />
        <KpiCard title="Janji bayar" value={data ? promised : null} loading={isLoading} to="/penagihan#daftar-tagihan" footer="Tidak diingatkan sebelum tanggal janjinya" />
      </div>

      <div id="daftar-tagihan" className="mt-4 scroll-mt-4">
        <Card title="Daftar tagihan">
          {isLoading ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : !invoices.length ? (
            <EmptyState icon={CircleCheck} title="Tidak ada tagihan terlambat">
              Semua tagihan masih dalam tempo. Tagihan yang lewat jatuh tempo akan muncul di sini.
            </EmptyState>
          ) : (
            <>
              <InvoiceTable invoices={invoices} />
              <InvoiceCards invoices={invoices} />
            </>
          )}
        </Card>
      </div>

      <div id="mutasi-bank" className="mt-4 scroll-mt-4">
        <BankStatementCard />
      </div>

      <OverpaymentsCard />

      <div className="mt-4">
        <PaymentsCard />
      </div>

      <SlideOver
        open={panel}
        onClose={() => setPanel(false)}
        title="Hasil agen penagihan"
        subtitle={run.isPending ? 'Agen sedang memeriksa setiap tagihan…' : 'Satu kali jalan: periksa tagihan, pilih nada, kirim atau minta persetujuan.'}
        footer={
          <Button variant="ghost" onClick={() => setPanel(false)}>
            Tutup
          </Button>
        }
      >
        <RunPanel pending={run.isPending} live={live} result={run.data ?? null} error={run.error as Error | null} />
      </SlideOver>
    </Page>
  );
}

function RunPanel({ pending, live, result, error }: { pending: boolean; live: AuditEntry[]; result: RunResult | null; error: Error | null }) {
  const trace = useRunTrace(pending ? null : (result?.runId ?? null));

  if (error) return <ErrorCallout message={error.message} />;
  if (pending) {
    return <PanelSection title="Jejak agen (langsung)">{live.length ? <AgentTrace entries={live} running /> : <p className="text-body text-ink-2">Menunggu langkah pertama agen…</p>}</PanelSection>;
  }
  if (!result) return null;

  const counts = trace.data ? outcomes(trace.data.steps) : null;
  return (
    <div>
      {result.status === 'failed' && (
        <div role="alert" className="mb-4 flex items-start gap-3 rounded-inner bg-danger-bg px-4 py-3 text-danger-fg">
          <Icon icon={TriangleAlert} size={20} weight="semibold" />
          <p className="text-body">Agen tidak menyelesaikan pengecekan. Tidak ada pengingat yang terkirim di luar yang tercatat di jejak. Penyebabnya ada di langkah terakhir.</p>
        </div>
      )}

      {!(result.status === 'failed' && counts && counts.sent + counts.queued + counts.skipped === 0) && (
        <PanelSection title="Ringkasan">
          {counts ? (
            <dl className="grid grid-cols-3 gap-3">
              <Stat icon={Send} label="Terkirim" value={counts.sent} />
              <Stat icon={ClipboardCheck} label="Menunggu persetujuan" value={counts.queued} />
              <Stat icon={Clock} label="Dilewati" value={counts.skipped} />
            </dl>
          ) : (
            <Skeleton className="h-20" />
          )}
          {counts && counts.queued > 0 && (
            <p className="mt-3 text-body text-ink-2">
              Pengingat yang perlu persetujuan menunggu di{' '}
              <Link to="/persetujuan" className="font-medium text-primary underline-offset-2 hover:underline">
                halaman Persetujuan
              </Link>
              . Pengingat baru dikirim ke pelanggan setelah Anda setujui.
            </p>
          )}
        </PanelSection>
      )}

      <PanelSection title="Laporan agen untuk pemilik">
        <p className="rounded-inner bg-surface-muted p-4 text-body whitespace-pre-line text-ink">{result.reply}</p>
      </PanelSection>

      <PanelSection title="Jejak agen">
        {trace.isLoading ? (
          <Skeleton className="h-24" />
        ) : trace.error || !trace.data ? (
          <ErrorCallout message={trace.error ? (trace.error as Error).message : 'Jejak agen tidak ditemukan.'} onRetry={() => void trace.refetch()} />
        ) : (
          <RunTraceBlock trace={trace.data} defaultOpen />
        )}
      </PanelSection>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: typeof Send; label: string; value: number }) {
  return (
    <div className="rounded-inner bg-surface-muted p-3">
      <dt className="flex items-center gap-1.5 text-small text-ink-2">
        <Icon icon={icon} size={16} />
        {label}
      </dt>
      <dd className="tabular mt-1 text-h1 font-semibold text-ink">{value}</dd>
    </div>
  );
}

const rowMotion = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease } },
  exit: { opacity: 0, transition: { duration: 0.15, ease } },
};

function InvoiceTable({ invoices }: { invoices: OverdueInvoice[] }) {
  return (
    <div className="-mx-2 hidden overflow-x-auto md:block">
      <table className="w-full text-left">
        <thead>
          <tr className="text-small text-ink-3">
            <th className="px-3 py-2 font-medium">Tagihan</th>
            <th className="px-3 py-2 font-medium">Warung</th>
            <th className="px-3 py-2 text-right font-medium">Sisa tagihan</th>
            <th className="px-3 py-2 font-medium">Terlambat</th>
            <th className="px-3 py-2 font-medium">Pengingat terakhir</th>
            <th className="px-3 py-2 font-medium">Janji bayar</th>
            <th className="px-3 py-2 font-medium">Nada pilihan</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {invoices.map((inv) => (
              <motion.tr key={inv.invoiceId} layout="position" {...rowMotion} className="transition-colors duration-150 hover:bg-surface-muted">
                <td className="tabular rounded-l-inner px-3 py-3 text-body whitespace-nowrap text-ink">
                  {inv.number}
                  <span className="block text-meta text-ink-3">Jatuh tempo {date(inv.dueAt)}</span>
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={inv.customerName} size={36} />
                    <div className="min-w-0">
                      <p className="truncate text-label font-semibold text-ink">{inv.customerName}</p>
                      <p className="truncate text-small text-ink-3">{inv.ownerName}</p>
                    </div>
                  </div>
                </td>
                <td className="tabular px-3 py-3 text-right text-body font-semibold whitespace-nowrap text-ink">{rupiah(inv.outstanding)}</td>
                <td className="px-3 py-3">
                  <Chip tone={lateTone(inv.daysOverdue)}>{inv.daysOverdue} hari</Chip>
                </td>
                <td className="tabular px-3 py-3 text-small whitespace-nowrap text-ink-2">{lastReminder(inv)}</td>
                <td className="tabular px-3 py-3 text-small whitespace-nowrap text-ink-2">{inv.promiseToPayAt ? date(inv.promiseToPayAt) : '–'}</td>
                <td className="rounded-r-inner px-3 py-3 text-small text-ink-2">{TONE_LABEL[inv.preferredTone] ?? inv.preferredTone}</td>
              </motion.tr>
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  );
}

function InvoiceCards({ invoices }: { invoices: OverdueInvoice[] }) {
  return (
    <ul className="-mx-2 flex flex-col gap-1 md:hidden">
      {invoices.map((inv) => (
        <motion.li key={inv.invoiceId} whileHover={{ y: -2 }} transition={hover} className="flex flex-col gap-2 rounded-inner p-3 hover:bg-surface-muted">
          <div className="flex items-center gap-3">
            <Avatar name={inv.customerName} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-label font-semibold text-ink">{inv.customerName}</p>
              <p className="tabular text-small text-ink-3">{inv.number}</p>
            </div>
            <Chip tone={lateTone(inv.daysOverdue)}>{inv.daysOverdue} hari</Chip>
          </div>
          <p className="tabular text-h3 font-semibold text-ink">{rupiah(inv.outstanding)}</p>
          <p className="text-small text-ink-2">
            Pengingat terakhir: {lastReminder(inv)} · Janji bayar: {inv.promiseToPayAt ? date(inv.promiseToPayAt) : '–'} · Nada: {TONE_LABEL[inv.preferredTone] ?? inv.preferredTone}
          </p>
        </motion.li>
      ))}
    </ul>
  );
}

/** Customers who paid more than they owe. Shown only when there is something for the owner to settle. */
function OverpaymentsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { requireAdmin } = useAdmin();
  const { data } = useQuery({ queryKey: ['overpaid'], queryFn: () => api.get<{ overpayments: Overpayment[] }>('/api/collections/overpaid') });
  const settle = useMutation({
    mutationFn: (o: Overpayment) => api.post<{ overpayments: Overpayment[] }>(`/api/collections/overpaid/${o.source}/${o.id}/settle`),
    onSuccess: (res) => {
      qc.setQueryData(['overpaid'], res);
      toast({ tone: 'success', text: 'Lebih bayar ditandai selesai.' });
    },
    onError: (err) => toast({ tone: 'error', text: (err as Error).message }),
  });
  const rows = data?.overpayments ?? [];
  if (!rows.length) return null;
  return (
    <div className="mt-4">
      <Card title="Lebih bayar">
        <p className="-mt-2 mb-4 text-body text-ink-2">
          Uang pelanggan yang melebihi tagihannya: tagihan yang dikoreksi setelah dibayar, atau transfer yang lebih besar dari tagihan terbuka. Kembalikan atau potong dari tagihan berikutnya, lalu tandai selesai.
        </p>
        <ul className="-mx-2 flex flex-col gap-1">
          {rows.map((o) => (
            <li key={`${o.source}-${o.id}`} className="flex flex-wrap items-center gap-3 rounded-inner p-3 hover:bg-surface-muted">
              <Avatar name={o.customer.name} size={36} />
              <div className="min-w-[180px] flex-1">
                <p className="text-label font-semibold text-ink">{o.customer.name}</p>
                <p className="tabular text-small text-ink-3">{o.reference}</p>
              </div>
              <p className="tabular text-body font-semibold text-ink">{rupiah(o.amount)}</p>
              <Chip tone="warning">{o.source === 'invoice_correction' ? 'Koreksi tagihan' : 'Transfer berlebih'}</Chip>
              <Button
                variant="outline"
                size="sm"
                loading={settle.isPending && settle.variables === o}
                onClick={async () => {
                  if (await requireAdmin()) settle.mutate(o);
                }}
              >
                Sudah dikembalikan
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

const PAYMENT_STATUS: Record<Payment['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Menunggu cek rekening', tone: 'warning' },
  approved: { label: 'Dicatat lunas', tone: 'success' },
  rejected: { label: 'Ditolak', tone: 'danger' },
};

/** Transfers customers reported in the chat. The agent proposes; the owner confirms against the bank. */
function PaymentsCard() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['payments'], queryFn: () => api.get<{ payments: Payment[] }>('/api/payments') });
  const payments = data?.payments ?? [];
  return (
    <Card title="Pembayaran dari pelanggan">
      <p className="-mt-2 mb-4 text-body text-ink-2">
        Bukti transfer yang dikirim lewat chat. Agen mencatat nominal dan mengusulkan tagihan yang dilunasi; tagihan baru berubah setelah Anda cek mutasi rekening dan menyetujuinya.
      </p>
      {error ? (
        <ErrorCallout message={(error as Error).message} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <Skeleton className="h-24" />
      ) : !payments.length ? (
        <EmptyState icon={Banknote} title="Belum ada pembayaran yang dilaporkan">
          Coba di Percakapan: kirim foto bukti transfer sebagai warung, misalnya Warung Bu Sari.
        </EmptyState>
      ) : (
        <ul className="-mx-2 flex flex-col gap-1">
          {payments.map((p) => {
            const s = PAYMENT_STATUS[p.status];
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-inner p-3 hover:bg-surface-muted">
                <Avatar name={p.customer.name} size={36} />
                <div className="min-w-[180px] flex-1">
                  <p className="text-label font-semibold text-ink">{p.customer.name}</p>
                  <p className="tabular text-small text-ink-3">
                    {p.allocations.map((a) => a.number).join(', ')}
                    {p.paidOn ? ` · transfer ${date(p.paidOn)}` : ''}
                    {p.bank ? ` · ${p.bank}` : ''}
                  </p>
                </div>
                <p className="tabular text-body font-semibold text-ink">{rupiah(p.amount)}</p>
                {p.guest && <Chip tone="info">Chat uji tamu</Chip>}
                <Chip tone={s.tone}>{p.guest && p.status === 'approved' ? 'Disetujui, tagihan tetap' : s.label}</Chip>
                {p.status === 'pending' && (
                  <Link to="/persetujuan" className="text-small font-medium text-primary underline-offset-2 hover:underline">
                    Cek dan setujui
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
