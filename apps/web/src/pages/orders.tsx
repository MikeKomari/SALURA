import { useQuery } from '@tanstack/react-query';
import { CircleQuestionMark, MessagesSquare, PackageSearch, Search, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { CHANNEL_LABEL, OrderDetail } from '../components/pages/order-detail.tsx';
import { SlideOver } from '../components/pages/slide-over.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Chip, StatusChip } from '../components/ui/chip.tsx';
import { Avatar, EmptyState, ErrorCallout, Skeleton } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { api } from '../lib/api.ts';
import { date, relative, rupiah, time } from '../lib/format.ts';
import { ease, hover, pageGroup } from '../lib/motion.ts';
import type { Order, OrderStatus } from '../lib/types.ts';

type OrderRow = Order & {
  customer: { name: string; waId: string };
  channel: string;
  createdAt: string;
  updatedAt: string;
};

const FILTERS: {
  key: string;
  label: string;
  statuses: OrderStatus[] | null;
}[] = [
  { key: 'semua', label: 'Semua', statuses: null },
  {
    key: 'menunggu',
    label: 'Menunggu pelanggan',
    statuses: ['draft', 'awaiting_customer'],
  },
  {
    key: 'persetujuan',
    label: 'Perlu persetujuan',
    statuses: ['awaiting_approval'],
  },
  { key: 'dikonfirmasi', label: 'Dikonfirmasi', statuses: ['confirmed'] },
  {
    key: 'ditolak',
    label: 'Ditolak/Dibatalkan',
    statuses: ['rejected', 'cancelled'],
  },
];

const rowMotion = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease } },
  exit: { opacity: 0, transition: { duration: 0.15, ease } },
};

/** "2 dus Indomie Mi Goreng, 1 dus Aqua … +2 lainnya" */
function itemsSummary(o: OrderRow) {
  if (!o.lines.length) return 'Belum ada barang';
  const shown = o.lines.slice(0, 2).map((l) => `${l.qty} ${l.unit} ${l.name.replace(/\s\d+(g|ml|kg|L)\b.*$/i, '')}`);
  return o.lines.length > 2 ? `${shown.join(', ')} +${o.lines.length - 2} lainnya` : shown.join(', ');
}

function matches(o: OrderRow, q: string) {
  const needle = q.trim().toLowerCase().replace(/^#/, '');
  if (!needle) return true;
  return String(o.orderId) === needle || o.customer.name.toLowerCase().includes(needle) || o.lines.some((l) => l.name.toLowerCase().includes(needle));
}

export function OrdersPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const filterKey = FILTERS.some((f) => f.key === params.get('status')) ? params.get('status')! : 'semua';
  const openId = Number(params.get('id')) || null;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['orders', 'list'],
    queryFn: () => api.get<{ orders: OrderRow[] }>('/api/orders'),
  });
  const all = data?.orders ?? [];
  const searched = useMemo(() => all.filter((o) => matches(o, q)), [all, q]);
  const filter = FILTERS.find((f) => f.key === filterKey)!;
  const shown = filter.statuses ? searched.filter((o) => filter.statuses!.includes(o.status)) : searched;

  const update = useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const closeDetail = useCallback(() => update({ id: null }), [update]);
  const open = (id: number) => update({ id: String(id) });

  return (
    <Page>
      <PageHeader
        title="Pesanan"
        subtitle="Semua pesanan yang disusun agen dari chat warung, beserta statusnya."
        actions={
          <Button icon={MessagesSquare} onClick={() => navigate('/percakapan')}>
            Coba pesan sebagai warung
          </Button>
        }
      />

      <motion.div variants={pageGroup} custom={1} className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="group" aria-label="Saring menurut status" className="scrollbar-thin -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
          {FILTERS.map((f) => {
            const count = f.statuses ? searched.filter((o) => f.statuses!.includes(o.status)).length : searched.length;
            const active = f.key === filterKey;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={active}
                onClick={() => update({ status: f.key === 'semua' ? null : f.key })}
                className={`inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-pill px-4 text-label font-medium transition-colors duration-150 ${
                  active ? 'bg-primary text-white' : 'bg-surface text-ink-2 hover:bg-surface-muted hover:text-ink'
                }`}
              >
                {f.label}
                <span className={`tabular grid h-6 min-w-6 place-items-center rounded-pill px-1.5 text-meta font-semibold ${active ? 'bg-white/20 text-white' : 'bg-surface-muted text-ink-2'}`}>
                  {isLoading ? '–' : count}
                </span>
              </button>
            );
          })}
        </div>
        <form role="search" className="relative flex w-full items-center lg:max-w-xs" onSubmit={(e) => e.preventDefault()}>
          <span className="pointer-events-none absolute left-4 text-ink-3">
            <Icon icon={Search} size={20} />
          </span>
          <input
            value={q}
            onChange={(e) => update({ q: e.target.value || null })}
            aria-label="Cari nama warung atau nomor pesanan"
            placeholder="Nama warung atau nomor"
            className="h-11 w-full rounded-pill bg-surface pr-12 pl-12 text-body text-ink placeholder:text-ink-3"
          />
          {q && (
            <button
              type="button"
              aria-label="Hapus pencarian"
              title="Hapus pencarian"
              onClick={() => update({ q: null })}
              className="absolute right-1 grid size-10 cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-surface-muted hover:text-ink"
            >
              <Icon icon={X} size={16} />
            </button>
          )}
        </form>
      </motion.div>

      {error && (
        <div className="mb-4">
          <ErrorCallout message={(error as Error).message} onRetry={() => void refetch()} />
        </div>
      )}

      <Card className="p-0 sm:p-2">
        {isLoading ? (
          <div className="flex flex-col gap-3 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : !all.length && !error ? (
          <EmptyState
            icon={MessagesSquare}
            title="Belum ada pesanan dari agen"
            action={
              <div className="flex flex-wrap justify-center gap-3">
                <Button icon={MessagesSquare} onClick={() => navigate('/percakapan')}>
                  Kirim pesanan lewat chat
                </Button>
                <Button variant="ghost" icon={CircleQuestionMark} onClick={() => navigate('/bantuan')}>
                  Lihat contoh pesan
                </Button>
              </div>
            }
          >
            Pilih salah satu warung di Percakapan, ketik pesanan seperti di WhatsApp, lalu pesanan yang disusun agen muncul di sini.
          </EmptyState>
        ) : !shown.length ? (
          <EmptyState
            icon={PackageSearch}
            title="Tidak ada pesanan yang cocok"
            action={
              <Button size="sm" variant="ghost" onClick={() => update({ q: null, status: null })}>
                Tampilkan semua pesanan
              </Button>
            }
          >
            {q ? `Tidak ada pesanan untuk “${q}” dengan status ini.` : 'Belum ada pesanan dengan status ini.'}
          </EmptyState>
        ) : (
          <>
            <OrdersTable orders={shown} onOpen={open} />
            <OrdersCards orders={shown} onOpen={open} />
          </>
        )}
      </Card>

      <SlideOver open={openId !== null} onClose={closeDetail} title={openId ? `Pesanan #${openId}` : ''} subtitle={all.find((o) => o.orderId === openId)?.customer.name}>
        {openId !== null && <OrderDetail id={openId} />}
      </SlideOver>
    </Page>
  );
}

function OrdersTable({ orders, onOpen }: { orders: OrderRow[]; onOpen: (id: number) => void }) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full text-left">
        <thead>
          <tr className="text-small text-ink-3">
            <th className="px-4 py-3 font-medium">Warung</th>
            <th className="px-4 py-3 font-medium">Barang</th>
            <th className="px-4 py-3 text-right font-medium">Total</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="hidden px-4 py-3 font-medium xl:table-cell">Saluran</th>
            <th className="px-4 py-3 text-right font-medium">Waktu</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {orders.map((o) => (
              <motion.tr
                key={o.orderId}
                layout="position"
                {...rowMotion}
                whileHover={{ y: -2, transition: hover }}
                tabIndex={0}
                aria-label={`Buka pesanan #${o.orderId} dari ${o.customer.name}`}
                onClick={() => onOpen(o.orderId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(o.orderId);
                  }
                }}
                className="cursor-pointer rounded-inner transition-colors duration-150 hover:bg-surface-muted"
              >
                <td className="rounded-l-inner px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={o.customer.name} size={36} />
                    <div className="min-w-0">
                      <p className="truncate text-label font-semibold text-ink">{o.customer.name}</p>
                      <p className="tabular text-small text-ink-3">#{o.orderId}</p>
                    </div>
                  </div>
                </td>
                <td className="max-w-[240px] px-4 py-3">
                  <p className="truncate text-body text-ink-2">{itemsSummary(o)}</p>
                </td>
                <td className="tabular px-4 py-3 text-right text-body font-semibold whitespace-nowrap text-ink">{rupiah(o.subtotal)}</td>
                <td className="px-4 py-3">
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusChip status={o.status} />
                    {o.guest && <Chip tone="info">Chat uji tamu</Chip>}
                  </span>
                </td>
                <td className="hidden px-4 py-3 xl:table-cell">
                  <Chip>{CHANNEL_LABEL[o.channel] ?? o.channel}</Chip>
                </td>
                <td className="tabular rounded-r-inner px-4 py-3 text-right text-small whitespace-nowrap text-ink-3" title={`${date(o.createdAt)} ${time(o.createdAt)}`}>
                  {relative(o.createdAt)}
                </td>
              </motion.tr>
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  );
}

function OrdersCards({ orders, onOpen }: { orders: OrderRow[]; onOpen: (id: number) => void }) {
  return (
    <ul className="flex flex-col gap-1 p-2 md:hidden">
      <AnimatePresence initial={false}>
        {orders.map((o) => (
          <motion.li key={o.orderId} layout="position" {...rowMotion}>
            <motion.button
              type="button"
              whileHover={{ y: -2 }}
              transition={hover}
              onClick={() => onOpen(o.orderId)}
              className="flex w-full cursor-pointer flex-col gap-2 rounded-inner p-3 text-left hover:bg-surface-muted"
            >
              <span className="flex w-full items-center gap-3">
                <Avatar name={o.customer.name} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label font-semibold text-ink">{o.customer.name}</span>
                  <span className="tabular block text-small text-ink-3">
                    #{o.orderId} · {CHANNEL_LABEL[o.channel] ?? o.channel} · {relative(o.createdAt)}
                  </span>
                </span>
              </span>
              <span className="line-clamp-2 text-body text-ink-2">{itemsSummary(o)}</span>
              <span className="flex w-full items-center justify-between gap-3">
                <span className="flex flex-wrap items-center gap-2">
                  <StatusChip status={o.status} />
                  {o.guest && <Chip tone="info">Chat uji tamu</Chip>}
                </span>
                <span className="tabular text-h3 font-semibold text-ink">{rupiah(o.subtotal)}</span>
              </span>
            </motion.button>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}
