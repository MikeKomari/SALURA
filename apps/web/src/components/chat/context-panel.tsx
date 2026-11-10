import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ChevronDown, Clock, CreditCard, Footprints, MapPin, ReceiptText, ShoppingBasket, UserX, Wallet, X, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { date, relative, rupiah } from '../../lib/format.ts';
import { ease, fast } from '../../lib/motion.ts';
import type { Profile } from '../../lib/types.ts';
import { AgentTrace, RunHeader } from '../trace/agent-trace.tsx';
import { IconButton } from '../ui/button.tsx';
import { Chip } from '../ui/chip.tsx';
import { Avatar, EmptyState, ErrorCallout, Skeleton } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { formatWa } from './chat-format.ts';
import type { TraceRun } from './use-chat.ts';

export type ContextTab = 'customer' | 'trace';

interface PanelProps {
  waId: string;
  tab: ContextTab;
  onTab: (t: ContextTab) => void;
  runs: TraceRun[];
  running: boolean;
  traceLoading: boolean;
  traceError: Error | null;
  onRetryTrace: () => void;
  /** Run to reveal in the trace tab; the nonce makes repeated clicks scroll again. */
  focus: { runId: string | null; nonce: number } | null;
  onClose?: () => void;
  className?: string;
}

const TABS: { id: ContextTab; label: string }[] = [
  { id: 'customer', label: 'Pelanggan' },
  { id: 'trace', label: 'Jejak agen' },
];

export function ContextPanel({ waId, tab, onTab, runs, running, traceLoading, traceError, onRetryTrace, focus, onClose, className = '' }: PanelProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const idBase = `ctx-${onClose ? 'over' : 'col'}`;

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    onTab(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <section aria-label="Info pelanggan dan jejak agen" className={`min-h-0 flex-col rounded-card bg-surface ${className}`}>
      <header className="flex items-center gap-2 p-4 pb-3">
        <div role="tablist" aria-label="Panel konteks" className="flex flex-1 gap-1 rounded-pill bg-surface-muted p-1">
          {TABS.map((t, i) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                ref={(el) => void (tabRefs.current[i] = el)}
                type="button"
                role="tab"
                id={`${idBase}-tab-${t.id}`}
                aria-selected={active}
                aria-controls={`${idBase}-panel`}
                tabIndex={active ? 0 : -1}
                onClick={() => onTab(t.id)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className={`inline-flex h-10 flex-1 cursor-pointer items-center justify-center gap-2 rounded-pill px-3 text-label font-medium transition-colors duration-150 ${
                  active ? 'bg-primary text-white' : 'text-ink-2 hover:text-ink'
                }`}
              >
                {t.label}
                {t.id === 'trace' && running && <LiveBadge onPrimary={active} />}
              </button>
            );
          })}
        </div>
        {onClose && <IconButton icon={X} label="Tutup panel" onClick={onClose} />}
      </header>
      <div id={`${idBase}-panel`} role="tabpanel" aria-labelledby={`${idBase}-tab-${tab}`} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {tab === 'customer' ? (
          <CustomerTab waId={waId} />
        ) : (
          <TraceTab runs={runs} loading={traceLoading} error={traceError} onRetry={onRetryTrace} focus={focus} />
        )}
      </div>
    </section>
  );
}

function LiveBadge({ onPrimary }: { onPrimary: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-meta font-semibold ${onPrimary ? 'bg-white text-primary' : 'bg-info-bg text-info-fg'}`}>
      <motion.span className="size-1.5 rounded-full bg-current" animate={{ opacity: [1, 0.4, 1] }} transition={{ repeat: Infinity, duration: 1.2 }} aria-hidden="true" />
      Bekerja
    </span>
  );
}

// ---------------------------------------------------------------------------
// Pelanggan
// ---------------------------------------------------------------------------

function CustomerTab({ waId }: { waId: string }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['profile', waId],
    queryFn: () => api.get<Profile>(`/api/conversations/${encodeURIComponent(waId)}/profile`),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 1,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 pt-2" aria-busy="true">
        <Skeleton className="h-16" />
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12" />
        ))}
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState icon={UserX} title="Nomor belum terdaftar">
        {formatWa(waId)} tidak ada di daftar pelanggan, jadi tidak ada limit kredit atau riwayat pesanan. Agen tidak memproses pesanan dari nomor ini dan akan mengalihkannya ke admin.
      </EmptyState>
    );
  }
  if (error || !data) return <ErrorCallout message={(error as Error | null)?.message ?? 'Profil pelanggan tidak bisa dimuat.'} onRetry={() => void refetch()} />;

  const { customer, credit, usualOrder, lastOrderAt } = data;
  const used = customer.creditLimit > 0 ? Math.min(1, credit.unpaid / customer.creditLimit) : 0;

  return (
    <div className="flex flex-col gap-5 pt-2">
      <div className="flex items-start gap-3">
        <Avatar name={customer.name} size={48} />
        <div className="min-w-0 flex-1">
          <p className="text-h3 font-semibold text-ink">{customer.name}</p>
          <p className="text-small text-ink-2">
            {customer.honorific} {customer.ownerName}
          </p>
          <p className="tabular text-small text-ink-3">{formatWa(customer.waId)}</p>
        </div>
        <Chip tone="success">Kelas {customer.tier}</Chip>
      </div>
      <p className="flex items-start gap-2 text-small text-ink-2">
        <span className="mt-0.5 text-ink-3">
          <Icon icon={MapPin} size={16} />
        </span>
        {customer.address}
      </p>

      <div>
        <div className="flex items-baseline justify-between">
          <p className="text-label font-medium text-ink-2">Kredit tersedia</p>
          <p className="tabular text-h2 font-semibold text-ink">{rupiah(credit.available)}</p>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-pill bg-surface-muted" aria-hidden="true">
          <div className={`h-full rounded-pill ${used > 0.85 ? 'bg-danger-fg' : 'bg-primary'}`} style={{ width: `${Math.round(used * 100)}%` }} />
        </div>
        <p className="mt-1 text-small text-ink-3">{Math.round(used * 100)}% limit sudah terpakai</p>
      </div>

      <dl className="flex flex-col gap-1">
        <Detail icon={CreditCard} label="Limit kredit" value={rupiah(credit.creditLimit)} />
        <Detail icon={ReceiptText} label="Belum dibayar" value={rupiah(credit.unpaid)} />
        <Detail icon={Wallet} label="Tersedia" value={rupiah(credit.available)} />
        <Detail
          icon={CalendarClock}
          label="Jatuh tempo terlama"
          value={credit.oldestOverdueDays > 0 ? `${credit.oldestOverdueDays} hari lewat · ${rupiah(credit.overdueAmount)}` : 'Tidak ada yang lewat'}
          tone={credit.oldestOverdueDays > 0 ? 'danger' : undefined}
          hint={`Tempo bayar ${customer.paymentTermDays} hari`}
        />
        <Detail icon={Clock} label="Terakhir pesan" value={lastOrderAt ? date(lastOrderAt) : 'Belum pernah'} hint={lastOrderAt ? relative(lastOrderAt) : undefined} />
      </dl>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-h3 font-semibold text-ink">
          <Icon icon={ShoppingBasket} size={20} weight="semibold" />
          Pesanan biasa
        </h3>
        {usualOrder.length ? (
          <ul className="flex flex-col gap-1">
            {usualOrder.map((u) => (
              <li key={`${u.productId}-${u.unit}`} className="flex items-baseline justify-between gap-3 rounded-inner py-1.5">
                <span className="min-w-0 text-body text-ink">{u.name}</span>
                <span className="tabular shrink-0 text-small text-ink-2">
                  {u.qty} {u.unit} · {u.timesOrdered}×
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-ink-2">Belum ada pola pesanan.</p>
        )}
        <p className="mt-2 text-small text-ink-3">Agen memakai daftar ini saat pelanggan menulis "seperti biasa".</p>
      </div>
    </div>
  );
}

function Detail({ icon, label, value, hint, tone }: { icon: LucideIcon; label: string; value: string; hint?: string; tone?: 'danger' }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className={`grid size-9 shrink-0 place-items-center rounded-full ${tone === 'danger' ? 'bg-danger-bg text-danger-fg' : 'bg-surface-muted text-ink-2'}`}>
        <Icon icon={icon} size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-small text-ink-3">{label}</dt>
        <dd className={`tabular text-label font-semibold ${tone === 'danger' ? 'text-danger-fg' : 'text-ink'}`}>{value}</dd>
        {hint && <dd className="text-meta text-ink-3">{hint}</dd>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jejak agen
// ---------------------------------------------------------------------------

function TraceTab({ runs, loading, error, onRetry, focus }: { runs: TraceRun[]; loading: boolean; error: Error | null; onRetry: () => void; focus: PanelProps['focus'] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Newest run is at the bottom; scroll the panel itself so the page does not jump.
    const panel = end.current?.closest('[role="tabpanel"]');
    if (!focus?.runId && panel) panel.scrollTop = panel.scrollHeight;
  }, [focus, runs.length]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3 pt-2" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );
  }
  if (error) return <ErrorCallout message={error.message} onRetry={onRetry} />;
  if (!runs.length) {
    return (
      <EmptyState icon={Footprints} title="Belum ada jejak">
        Kirim pesan sebagai pelanggan. Setiap langkah agen (cek stok, cek kredit, susun pesanan) tampil di sini saat terjadi.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-small text-ink-3">{runs.length} putaran terakhir, yang terbaru di bawah.</p>
      {runs.map((r, i) => (
        <RunBlock key={r.run.id} item={r} defaultOpen={i === runs.length - 1} focused={focus?.runId === r.run.id ? focus.nonce : null} />
      ))}
      <div ref={end} />
    </div>
  );
}

function RunBlock({ item, defaultOpen, focused }: { item: TraceRun; defaultOpen: boolean; focused: number | null }) {
  const running = item.run.status === 'running';
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  const expanded = open || running;

  useEffect(() => {
    if (focused === null) return;
    setOpen(true);
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [focused]);

  return (
    <div ref={ref} className={`rounded-inner p-3 ${focused !== null ? 'bg-primary-soft' : 'bg-canvas'}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={expanded} className="flex w-full cursor-pointer items-start gap-2 rounded-inner text-left">
        <span className="min-w-0 flex-1">
          <RunHeader run={item.run} />
          <span className="mt-1 block truncate text-small text-ink-2">{firstMessage(item) ?? item.run.goal}</span>
        </span>
        <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={fast} className="mt-1 grid text-ink-3">
          <Icon icon={ChevronDown} size={20} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease }} className="overflow-hidden">
            <div className="pt-4">
              <AgentTrace entries={item.steps} running={running} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function firstMessage(item: TraceRun): string | null {
  const m = item.steps.find((s) => s.type === 'message_in');
  return m ? `“${m.summary}”` : null;
}

/** Context panel as a slide-over below the three-column width. */
export function ContextSlideOver({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-40 min-[1440px]:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.18 } }}>
          <div className="absolute inset-0 bg-ink/30" onClick={onClose} aria-hidden="true" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Info pelanggan dan jejak agen"
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1, transition: { duration: 0.25, ease } }}
            exit={{ x: 16, opacity: 0, transition: { duration: 0.18, ease } }}
            className="absolute top-3 right-3 bottom-3 flex w-[min(420px,calc(100vw-24px))] shadow-pop"
            ref={(el) => {
              if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
            }}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
