import { PackageX, Replace } from 'lucide-react';
import { number, rupiah } from '../../lib/format.ts';
import type { Approval, Credit, Order } from '../../lib/types.ts';
import { Chip } from '../ui/chip.tsx';

export function OrderLinesTable({ order, stock }: { order: Order; stock?: Approval['stock'] }) {
  return (
    <div className="scrollbar-thin -mx-2 overflow-x-auto px-2">
      <table className="w-full border-separate sm:min-w-[440px] border-spacing-0 text-left">
        <caption className="sr-only">Barang dalam pesanan #{order.orderId}</caption>
        <thead>
          <tr className="text-small text-ink-3">
            <th scope="col" className="pr-3 pb-2 font-medium">Jumlah</th>
            <th scope="col" className="pr-3 pb-2 font-medium">Barang</th>
            <th scope="col" className="hidden pr-3 pb-2 text-right font-medium sm:table-cell">Harga satuan</th>
            <th scope="col" className="pb-2 text-right font-medium">Subtotal</th>
          </tr>
        </thead>
        <tbody className="text-body text-ink">
          {order.lines.map((l, i) => (
            <tr key={`${l.productId}-${l.unit}-${i}`} className="align-top">
              <td className="tabular border-t border-border py-3 pr-3 font-semibold whitespace-nowrap">
                {number(l.qty)} {l.unit}
              </td>
              <td className="border-t border-border py-3 pr-3">
                <p>{l.name}</p>
                {stock?.[i] && !stock[i]!.enough && (
                  <p className="mt-1">
                    <Chip tone="danger" icon={PackageX}>
                      Stok tinggal {stock[i]!.available}
                    </Chip>
                  </p>
                )}
                {(l.substitutedFromProductId !== null || l.rawText) && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {l.substitutedFromProductId !== null && (
                      <Chip tone="info" icon={Replace}>
                        Pengganti
                      </Chip>
                    )}
                    {l.rawText && <span className="text-small text-ink-3">Ditulis pelanggan: “{l.rawText}”</span>}
                  </div>
                )}
              </td>
              <td className="tabular hidden border-t border-border py-3 pr-3 text-right whitespace-nowrap text-ink-2 sm:table-cell">{rupiah(l.unitPrice)}</td>
              <td className="tabular border-t border-border py-3 text-right font-medium whitespace-nowrap">{rupiah(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2} className="border-t-2 border-border pt-3 pr-3 text-right text-label font-semibold text-ink">
              Total
            </th>
            <td className="hidden border-t-2 border-border sm:table-cell" />
            <td className="tabular border-t-2 border-border pt-3 text-right text-h2 font-semibold whitespace-nowrap text-ink">{rupiah(order.subtotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Credit position in big numbers, plus what happens to it if the owner approves. */
export function CreditFacts({ credit, orderTotal }: { credit: Credit; orderTotal: number | null }) {
  const after = orderTotal === null ? null : credit.available - orderTotal;
  return (
    <div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat label="Limit kredit" value={rupiah(credit.creditLimit)} />
        <Stat label="Belum dibayar" value={rupiah(credit.unpaid)} />
        <Stat label="Kredit tersedia" value={rupiah(credit.available)} tone={credit.available <= 0 ? 'danger' : undefined} />
        <Stat
          label="Tagihan terlambat"
          value={rupiah(credit.overdueAmount)}
          sub={credit.overdueAmount > 0 ? `paling lama ${credit.oldestOverdueDays} hari` : 'tidak ada'}
          tone={credit.overdueAmount > 0 ? 'warning' : undefined}
        />
      </dl>
      {after !== null && (
        <p className={`mt-3 text-body ${after < 0 ? 'text-danger-fg' : 'text-ink-2'}`}>
          {after < 0 ? (
            <>
              Jika disetujui, pelanggan melewati limit sebesar <strong className="tabular font-semibold">{rupiah(-after)}</strong>.
            </>
          ) : (
            <>
              Jika disetujui, sisa kredit pelanggan menjadi <strong className="tabular font-semibold text-ink">{rupiah(after)}</strong>.
            </>
          )}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warning' | 'danger' }) {
  const box = tone === 'danger' ? 'bg-danger-bg' : tone === 'warning' ? 'bg-warning-bg' : 'bg-surface-muted';
  const ink = tone === 'danger' ? 'text-danger-fg' : tone === 'warning' ? 'text-warning-fg' : 'text-ink';
  return (
    <div className={`rounded-inner p-4 ${box}`}>
      <dt className={`text-small font-medium ${tone ? ink : 'text-ink-2'}`}>{label}</dt>
      <dd className={`tabular mt-1 text-h1 font-semibold ${ink}`}>{value}</dd>
      {sub && <dd className={`text-small ${tone ? ink : 'text-ink-3'}`}>{sub}</dd>}
    </div>
  );
}
