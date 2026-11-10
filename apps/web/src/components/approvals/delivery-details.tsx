import { ArrowRight, Clock, TriangleAlert, Truck } from 'lucide-react';
import { Link } from 'react-router';
import { rupiah } from '../../lib/format.ts';
import type { Approval } from '../../lib/types.ts';
import { Icon } from '../ui/icon.tsx';

/** A question to the warehouse or driver about a delivery mismatch, shown as the WhatsApp it will be. */
export function DeliveryQueryDetails({ approval, pending }: { approval: Approval; pending: boolean }) {
  const p = approval.payload ?? {};
  const staffName = String(p.staffName ?? 'staf');
  return (
    <div className="flex flex-col gap-5">
      <p className="flex items-center gap-2 text-body text-ink-2">
        <Icon icon={Truck} size={20} className="text-ink-3" />
        Untuk <span className="font-semibold text-ink">{staffName}</span>
        {approval.orderId && (
          <Link to={`/pengiriman?order=${approval.orderId}`} className="ml-auto inline-flex items-center gap-1 text-small font-medium text-primary hover:underline">
            Lihat pemeriksaan dokumen <Icon icon={ArrowRight} size={16} />
          </Link>
        )}
      </p>
      <div className="flex justify-end rounded-inner bg-canvas p-4">
        <div className="max-w-[440px] rounded-inner rounded-br-[4px] bg-surface-muted px-4 py-3">
          <p className="text-small font-semibold text-ink">
            SALURA <span className="font-normal text-ink-3">ke {staffName}</span>
          </p>
          <p className="mt-1 text-body break-words whitespace-pre-line text-ink">{String(p.text ?? '')}</p>
          {pending && (
            <p className="mt-2 flex items-center justify-end gap-1 text-meta text-ink-3">
              <Icon icon={Clock} size={16} />
              Belum dikirim, menunggu persetujuan
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

interface AdjustmentLine {
  productId: number;
  name: string;
  ordered: string;
  delivered: string;
  value: number;
}

/** Proposed invoice correction: the computed credit per undelivered item and the new total. */
export function InvoiceAdjustmentDetails({ approval }: { approval: Approval }) {
  const p = approval.payload ?? {};
  const lines = (Array.isArray(p.lines) ? p.lines : []) as AdjustmentLine[];
  const from = typeof p.from === 'number' ? p.from : null;
  const to = typeof p.to === 'number' ? p.to : null;
  const overpaid = typeof p.overpaid === 'number' ? p.overpaid : 0;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-inner bg-surface-muted p-4">
          <dt className="text-small font-medium text-ink-2">Tagihan {String(p.invoiceNumber ?? '')}</dt>
          <dd className="tabular mt-1 text-h2 font-semibold text-ink">{from !== null ? rupiah(from) : '–'}</dd>
        </div>
        <div className="rounded-inner bg-danger-bg p-4">
          <dt className="text-small font-medium text-danger-fg">Dikurangi</dt>
          <dd className="tabular mt-1 text-h2 font-semibold text-danger-fg">{typeof p.credit === 'number' ? `−${rupiah(p.credit)}` : '–'}</dd>
        </div>
        <div className="rounded-inner bg-primary-soft p-4">
          <dt className="text-small font-medium text-primary">Menjadi</dt>
          <dd className="tabular mt-1 text-h2 font-semibold text-primary">{to !== null ? rupiah(to) : '–'}</dd>
        </div>
      </dl>
      {overpaid > 0 && (
        <div role="note" className="flex items-start gap-3 rounded-inner bg-warning-bg px-4 py-3 text-warning-fg">
          <Icon icon={TriangleAlert} size={20} weight="semibold" />
          <p className="text-body">
            Tagihan ini sudah dibayar <span className="tabular font-semibold">{rupiah(Number(p.paidAmount ?? 0))}</span>. Setelah koreksi pelanggan lebih bayar{' '}
            <span className="tabular font-semibold">{rupiah(overpaid)}</span>. Tagihan langsung lunas dan kelebihannya tercatat di halaman Penagihan untuk dikembalikan atau dipotong dari tagihan berikutnya.
          </p>
        </div>
      )}
      <section>
        <h3 className="text-h3 font-semibold text-ink">Barang yang tidak terkirim</h3>
        <ul className="mt-2 divide-y divide-border">
          {lines.map((l) => (
            <li key={l.productId} className="tabular flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-body">
              <span className="min-w-0 font-medium text-ink">{l.name}</span>
              <span className="text-small text-ink-2">
                dipesan {l.ordered} · terkirim {l.delivered}
              </span>
              <span className="w-full text-right font-semibold text-danger-fg sm:w-auto">−{rupiah(l.value)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-small text-ink-3">Nilai dihitung dari harga di pesanan, bukan oleh agen. Setelah disetujui, pelanggan diberi kabar dan pengingat bayar memakai jumlah baru.</p>
      </section>
    </div>
  );
}
