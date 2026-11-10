import { CalendarClock, Clock, PackageX } from 'lucide-react';
import { rupiah } from '../../lib/format.ts';
import type { Approval } from '../../lib/types.ts';
import { Icon } from '../ui/icon.tsx';
import { customerName } from './copy.ts';

/** A proactive reorder offer: the customer's rhythm, the prepared order, and the exact message. */
export function ReorderDetails({ approval, pending }: { approval: Approval; pending: boolean }) {
  const p = approval.payload ?? {};
  const interval = typeof p.avgIntervalDays === 'number' ? p.avgIntervalDays : null;
  const since = typeof p.daysSinceLastOrder === 'number' ? p.daysSinceLastOrder : null;
  const dropped = Array.isArray(p.droppedOutOfStock) ? (p.droppedOutOfStock as string[]) : [];
  const text = typeof p.text === 'string' ? p.text : '';
  // Before sending, the offer is only a priced proposal; after sending it is a real order.
  const preview = p.preview as { lines: { productId: number; name: string; qty: number; unit: string; lineTotal: number }[]; subtotal: number } | undefined;
  const order = approval.order ?? preview ?? null;

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Fact label="Biasanya pesan tiap" value={interval !== null ? `${interval} hari` : '–'} />
        <Fact label="Terakhir pesan" value={since !== null ? `${since} hari lalu` : '–'} tone={interval !== null && since !== null && since > interval ? 'warning' : undefined} />
        <Fact label="Total tawaran" value={order ? rupiah(order.subtotal) : '–'} />
      </dl>

      {order && (
        <section aria-labelledby={`reorder-lines-${approval.id}`}>
          <h3 id={`reorder-lines-${approval.id}`} className="flex items-center gap-2 text-h3 font-semibold text-ink">
            <Icon icon={CalendarClock} size={20} />
            Pesanan biasa yang disiapkan
          </h3>
          <ul className="mt-2 divide-y divide-border">
            {order.lines.map((l) => (
              <li key={`${l.productId}-${l.unit}`} className="tabular flex items-baseline justify-between gap-4 py-2.5 text-body">
                <span className="min-w-0">
                  <span className="font-semibold">
                    {l.qty} {l.unit}
                  </span>{' '}
                  {l.name}
                </span>
                <span className="shrink-0 text-ink-2">{rupiah(l.lineTotal)}</span>
              </li>
            ))}
          </ul>
          {dropped.length > 0 && (
            <p className="mt-2 flex items-start gap-2 rounded-inner bg-danger-bg px-3 py-2 text-small text-danger-fg">
              <Icon icon={PackageX} size={16} weight="semibold" className="mt-0.5 shrink-0" />
              Tidak ditawarkan karena stok habis: {dropped.join(', ')}.
            </p>
          )}
        </section>
      )}

      <section aria-labelledby={`reorder-preview-${approval.id}`}>
        <h3 id={`reorder-preview-${approval.id}`} className="text-h3 font-semibold text-ink">
          {pending ? 'Pesan yang akan dikirim' : 'Pesan tawaran'}
        </h3>
        <p className="mt-1 text-small text-ink-3">Kata-katanya dari templat; harga dari daftar harga. Pesanan baru diproses setelah pelanggan membalas YA.</p>
        <div className="mt-3 flex justify-end rounded-inner bg-canvas p-4">
          <div className="max-w-[440px] rounded-inner rounded-br-[4px] bg-surface-muted px-4 py-3">
            <p className="text-small font-semibold text-ink">
              SALURA <span className="font-normal text-ink-3">ke {customerName(approval)}</span>
            </p>
            <p className="mt-1 text-body break-words whitespace-pre-line text-ink">{text || 'Teks tawaran tidak tersedia.'}</p>
            {pending && (
              <p className="mt-2 flex items-center justify-end gap-1 text-meta text-ink-3">
                <Icon icon={Clock} size={16} />
                Belum dikirim, menunggu persetujuan
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return (
    <div className={`rounded-inner p-4 ${tone === 'warning' ? 'bg-warning-bg' : 'bg-surface-muted'}`}>
      <dt className={`text-small font-medium ${tone === 'warning' ? 'text-warning-fg' : 'text-ink-2'}`}>{label}</dt>
      <dd className={`tabular mt-1 text-h2 font-semibold ${tone === 'warning' ? 'text-warning-fg' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}
