import { useQuery } from '@tanstack/react-query';
import { Settings, ShieldCheck } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ApprovalDetail, ApprovalDetailSkeleton } from '../components/approvals/approval-detail.tsx';
import { ApprovalList, ApprovalListSkeleton } from '../components/approvals/approval-list.tsx';
import { customerName, errorText, TYPE_META } from '../components/approvals/copy.ts';
import { PENDING_KEY } from '../components/approvals/use-decision.ts';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { EmptyState, ErrorCallout } from '../components/ui/feedback.tsx';
import { Segmented } from '../components/ui/field.tsx';
import { useToast } from '../components/ui/toast.tsx';
import { api } from '../lib/api.ts';
import { ease, pageGroup } from '../lib/motion.ts';
import type { Approval } from '../lib/types.ts';

type Tab = 'pending' | 'history';

export function ApprovalsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('pending');
  // Below 1024px the list and the detail share one column; this says which one is showing.
  const [detailOpen, setDetailOpen] = useState(() => params.has('id'));
  const now = useNow();

  const pendingQ = useQuery({ queryKey: PENDING_KEY, queryFn: () => api.get<{ approvals: Approval[] }>('/api/approvals?status=pending') });
  const historyQ = useQuery({
    queryKey: ['approvals', 'history'],
    queryFn: () => api.get<{ approvals: Approval[] }>('/api/approvals?status=all'),
    enabled: tab === 'history',
    select: (d) =>
      d.approvals.filter((a) => a.status !== 'pending').sort((x, y) => (y.decidedAt ?? y.requestedAt).localeCompare(x.decidedAt ?? x.requestedAt)),
  });

  const pending = useMemo(() => pendingQ.data?.approvals ?? [], [pendingQ.data]);
  const active = tab === 'pending' ? pendingQ : historyQ;
  const items = useMemo(() => (tab === 'pending' ? pending : (historyQ.data ?? [])), [tab, pending, historyQ.data]);

  const idParam = Number(params.get('id'));
  const selected = items.find((a) => a.id === idParam) ?? null;
  const lastIndex = useRef(0);

  const select = (id: number, open = false) => {
    setParams((p) => {
      p.set('id', String(id));
      return p;
    }, { replace: true });
    if (open) {
      setDetailOpen(true);
      window.scrollTo({ top: 0 });
    }
  };

  // Keep a row selected: when the selected one is decided and leaves the list, the next one takes its place.
  useEffect(() => {
    if (!items.length) return;
    if (selected) {
      lastIndex.current = items.indexOf(selected);
      return;
    }
    const next = items[Math.min(lastIndex.current, items.length - 1)];
    if (next) select(next.id);
    // `select` is recreated every render; items and selected are the only inputs that matter here.
  }, [items, selected]);

  // A new hold arriving while the owner is on this page gets a toast (DESIGN.md §11).
  const seen = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!pendingQ.data) return;
    const ids = new Set(pendingQ.data.approvals.map((a) => a.id));
    if (seen.current) {
      const fresh = pendingQ.data.approvals.filter((a) => !seen.current!.has(a.id));
      if (fresh.length === 1) toast({ tone: 'success', text: `Permintaan baru dari ${customerName(fresh[0]!)}: ${TYPE_META[fresh[0]!.type].label.toLowerCase()}.` });
      else if (fresh.length > 1) toast({ tone: 'success', text: `${fresh.length} permintaan baru menunggu keputusan Anda.` });
    }
    seen.current = ids;
  }, [pendingQ.data, toast]);

  const switchTab = (t: Tab) => {
    setTab(t);
    lastIndex.current = 0;
    setDetailOpen(false);
    setParams((p) => {
      p.delete('id');
      return p;
    }, { replace: true });
  };

  const count = pendingQ.data ? ` (${pending.length})` : '';
  const showEmptyPending = tab === 'pending' && pendingQ.isSuccess && pending.length === 0;

  return (
    <Page>
      <PageHeader
        title="Persetujuan"
        subtitle="Tindakan yang sengaja ditahan agen karena butuh keputusan Anda. Setiap item disertai alasan dan jejak kerjanya."
        actions={
          <Button variant="outline" icon={Settings} onClick={() => navigate('/pengaturan')}>
            Atur batas otonomi
          </Button>
        }
      />

      <motion.div variants={pageGroup} custom={1} className={`mb-4 ${detailOpen ? 'hidden lg:block' : ''}`}>
        <Segmented<Tab>
          label="Tampilan persetujuan"
          value={tab}
          onChange={switchTab}
          options={[
            { value: 'pending', label: `Menunggu${count}` },
            { value: 'history', label: 'Riwayat' },
          ]}
        />
      </motion.div>

      {active.error ? (
        <ErrorCallout message={errorText(active.error)} onRetry={() => void active.refetch()} />
      ) : showEmptyPending ? (
        <motion.section variants={pageGroup} custom={2} className="rounded-card bg-surface p-6">
          <EmptyState
            icon={ShieldCheck}
            title="Tidak ada yang menunggu."
            action={
              <Button variant="ghost" size="sm" onClick={() => switchTab('history')}>
                Lihat riwayat keputusan
              </Button>
            }
          >
            Agen menangani semuanya sendiri.
          </EmptyState>
        </motion.section>
      ) : tab === 'history' && historyQ.isSuccess && items.length === 0 ? (
        <section className="rounded-card bg-surface p-6">
          <EmptyState icon={ShieldCheck} title="Belum ada keputusan">
            Persetujuan dan penolakan Anda akan tercatat di sini.
          </EmptyState>
        </section>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
          <motion.section
            variants={pageGroup}
            custom={2}
            aria-label={tab === 'pending' ? 'Menunggu keputusan' : 'Riwayat'}
            className={`scrollbar-thin rounded-card bg-surface p-3 lg:sticky lg:top-3 lg:max-h-[calc(100dvh-24px)] lg:overflow-y-auto ${detailOpen ? 'hidden lg:block' : ''}`}
          >
            {active.isLoading ? (
              <ApprovalListSkeleton />
            ) : (
              <ApprovalList items={items} selectedId={selected?.id ?? null} onSelect={(id) => select(id, window.matchMedia('(max-width: 1023px)').matches)} mode={tab} now={now} />
            )}
          </motion.section>

          <motion.section variants={pageGroup} custom={2} className={`min-w-0 rounded-card bg-surface p-6 ${detailOpen ? '' : 'hidden lg:block'}`}>
            {active.isLoading || !selected ? (
              <ApprovalDetailSkeleton />
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={selected.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease } }}
                  exit={{ opacity: 0, transition: { duration: 0.18, ease } }}
                >
                  <ApprovalDetail approval={selected} now={now} onBack={() => setDetailOpen(false)} />
                </motion.div>
              </AnimatePresence>
            )}
          </motion.section>
        </div>
      )}
    </Page>
  );
}

/** Ticks once a minute so "5 menit lalu" stays true while the page is open. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
