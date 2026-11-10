import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ClipboardCheck, MessagesSquare, Repeat, Truck, UserCheck } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../../lib/api.ts';
import { date, rupiah, time } from '../../lib/format.ts';
import type { Approval, AuditEntry, Order } from '../../lib/types.ts';
import { APPROVAL_LABEL, Chip, StatusChip, type Tone } from '../ui/chip.tsx';
import { EmptyState, ErrorCallout, Skeleton } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { CorrectionTrail, WrongOrderButton } from './order-correction.tsx';
import { RunTraceBlock, RunTraceById, type RunTrace } from './run-trace.tsx';
import { PanelSection } from './slide-over.tsx';

export const CHANNEL_LABEL: Record<string, string> = {
  web: 'Chat web',
  whatsapp: 'WhatsApp',
  eval: 'Evaluasi',
  system: 'Sistem',
};

type RawApproval = Omit<Approval, 'customer' | 'order' | 'credit'>;

interface OrderDetailData {
  order: Order & {
    channel: string;
    createdAt: string;
    confirmedAt: string | null;
    humanEdited: boolean;
    cancelledAt: string | null;
    cancelledBy: string | null;
    cancelReason: string | null;
  };
  customer: {
    id: number;
    name: string;
    waId: string;
    ownerName: string;
    honorific: string;
    tier: string;
  };
  approvals: RawApproval[];
}

const DECISION: Record<RawApproval['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Menunggu keputusan', tone: 'warning' },
  approved: { label: 'Disetujui', tone: 'success' },
  rejected: { label: 'Ditolak', tone: 'danger' },
};

export function useOrderDetail(id: number | null) {
  return useQuery({
    queryKey: ['orders', 'detail', id],
    queryFn: () => api.get<OrderDetailData>(`/api/orders/${id}`),
    enabled: id !== null,
  });
}

export function OrderDetail({ id }: { id: number }) {
  const { data, isLoading, error, refetch } = useOrderDetail(id);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (error || !data) return <ErrorCallout message={error ? (error as Error).message : 'Pesanan tidak ditemukan.'} onRetry={() => void refetch()} />;

  const { order, customer, approvals } = data;
  const runIds = [...new Set(approvals.map((a) => a.runId).filter((r): r is string => Boolean(r)))];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={order.status} />
        <Chip>{CHANNEL_LABEL[order.channel] ?? order.channel}</Chip>
        {order.humanEdited && <Chip tone="info">Diubah admin</Chip>}
        {order.splitFromOrderId && <Chip tone="info">Sisa dari pesanan #{order.splitFromOrderId}</Chip>}
        {order.guest && <Chip tone="info">Chat uji tamu</Chip>}
      </div>
      {order.guest && (
        <p className="mt-3 text-small text-ink-2">Pesanan dari chat uji akun tamu. Disetujui pun tidak memesan stok, tidak masuk gudang dan tidak ditagihkan.</p>
      )}
      <p className="tabular mt-3 text-small text-ink-3">
        Dibuat {date(order.createdAt)} pukul {time(order.createdAt)}
        {order.confirmedAt ? ` · dikonfirmasi ${date(order.confirmedAt)} pukul ${time(order.confirmedAt)}` : ''}
      </p>

      <CorrectionTrail order={order} onChanged={() => void refetch()} />

      {order.status === 'confirmed' && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <WrongOrderButton orderId={order.orderId} onChanged={() => void refetch()} />
          <span className="text-small text-ink-3">Agen salah membaca pesanan ini? Tarik kembali dan beri tahu pelanggan.</span>
        </div>
      )}

      <PanelSection title="Barang">
        {order.lines.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-small text-ink-3">
                  <th className="pb-2 font-medium">Barang</th>
                  <th className="pb-2 text-right font-medium">Jumlah</th>
                  <th className="pb-2 text-right font-medium">Subtotal</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {order.lines.map((l, i) => (
                  <tr key={`${l.productId}-${i}`} className="border-t border-border align-top">
                    <td className="py-2.5 pr-3">
                      <p className="text-body text-ink">{l.name}</p>
                      <p className="text-small text-ink-3">
                        {rupiah(l.unitPrice)} per {l.unit}
                        {l.rawText ? ` · ditulis “${l.rawText}”` : ''}
                      </p>
                      {l.substitutedFromProductId !== null && (
                        <Chip tone="info" icon={Repeat} className="mt-1.5">
                          Barang pengganti
                        </Chip>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-body whitespace-nowrap text-ink">
                      {l.qty} {l.unit}
                    </td>
                    <td className="py-2.5 text-right text-body whitespace-nowrap text-ink">{rupiah(l.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td colSpan={2} className="pt-3 text-label font-semibold text-ink">
                    Total
                  </td>
                  <td className="tabular pt-3 text-right text-h3 font-semibold text-ink">{rupiah(order.subtotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="text-body text-ink-3">Belum ada barang di pesanan ini.</p>
        )}
      </PanelSection>

      <PanelSection title="Catatan pengiriman">
        <div className="flex items-start gap-3 rounded-inner bg-surface-muted p-3">
          <span className="text-ink-2">
            <Icon icon={Truck} size={20} />
          </span>
          <p className="text-body text-ink">{order.deliveryNote ?? 'Tidak ada catatan. Dikirim sesuai jadwal area.'}</p>
        </div>
      </PanelSection>

      {approvals.length > 0 && (
        <PanelSection title="Persetujuan">
          <ul className="flex flex-col gap-3">
            {approvals.map((a) => (
              <li key={a.id} className="rounded-inner bg-surface-muted/60 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="neutral">{APPROVAL_LABEL[a.type]}</Chip>
                  <Chip tone={DECISION[a.status].tone}>{DECISION[a.status].label}</Chip>
                  <span className="tabular text-meta text-ink-3">
                    Diminta {date(a.requestedAt)} {time(a.requestedAt)}
                  </span>
                </div>
                <div className="mt-3 rounded-inner bg-warning-bg px-3 py-2 text-warning-fg">
                  <p className="text-small font-semibold">Alasan agen menahan</p>
                  <p className="text-body">{a.reason}</p>
                </div>
                {a.status === 'pending' ? (
                  <Link to={`/persetujuan?id=${a.id}`} className="mt-3 inline-flex h-10 items-center gap-1.5 rounded-pill text-label font-medium text-primary hover:underline">
                    <Icon icon={ClipboardCheck} size={20} /> Tinjau di Persetujuan
                  </Link>
                ) : (
                  <p className="mt-3 flex items-start gap-2 text-body text-ink-2">
                    <span className="mt-0.5 text-ink-3">
                      <Icon icon={UserCheck} size={20} />
                    </span>
                    <span>
                      {a.status === 'approved' ? 'Disetujui' : 'Ditolak'} oleh {a.decidedBy ?? 'admin'}
                      {a.decidedAt ? `, ${date(a.decidedAt)} ${time(a.decidedAt)}` : ''}
                      {a.decisionNote ? `. Catatan: “${a.decisionNote}”` : ''}
                    </span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </PanelSection>
      )}

      <PanelSection title="Percakapan">
        <Link to={`/percakapan/${customer.waId}`} className="flex items-center gap-3 rounded-inner bg-surface-muted p-3 transition-colors hover:bg-primary-soft">
          <span className="grid size-9 place-items-center rounded-full bg-surface text-primary">
            <Icon icon={MessagesSquare} size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-label font-semibold text-ink">{customer.name}</span>
            <span className="block text-small text-ink-3">
              {customer.honorific} {customer.ownerName} · lihat chat lengkapnya
            </span>
          </span>
          <Icon icon={ArrowRight} size={20} className="text-primary" />
        </Link>
      </PanelSection>

      <PanelSection title="Jejak agen">
        {runIds.length ? (
          <div className="flex flex-col gap-3">
            {runIds.map((r, i) => (
              <RunTraceById key={r} runId={r} defaultOpen={i === runIds.length - 1} />
            ))}
          </div>
        ) : (
          <ConversationRuns waId={customer.waId} orderId={order.orderId} />
        )}
      </PanelSection>
    </div>
  );
}

/** Mentions this order in a tool call or result, e.g. {"orderId":42} or {"order_id":42}. */
function mentionsOrder(steps: AuditEntry[], orderId: number) {
  const re = new RegExp(`"order_?[iI]d":${orderId}(?![0-9])`);
  return steps.some((s) => s.data !== null && re.test(JSON.stringify(s.data)));
}

/** Without an approval we find the runs through the customer's recent conversation trace. */
function ConversationRuns({ waId, orderId }: { waId: string; orderId: number }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['trace', waId, 'runs'],
    queryFn: () => api.get<{ runs: RunTrace[] }>(`/api/conversations/${waId}/trace`),
  });
  if (isLoading) return <Skeleton className="h-20" />;
  if (error) return <ErrorCallout message={(error as Error).message} onRetry={() => void refetch()} />;
  const runs = (data?.runs ?? []).filter((r) => mentionsOrder(r.steps, orderId));
  if (!runs.length) {
    return <EmptyState title="Jejak tidak ditemukan">Pesanan ini tidak muncul di 10 proses agen terakhir untuk pelanggan ini. Buka tab Jejak agen di percakapannya.</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-3">
      {runs.map((r, i) => (
        <RunTraceBlock key={r.run.id} trace={r} defaultOpen={i === runs.length - 1} />
      ))}
    </div>
  );
}
