import { Image } from 'lucide-react';
import { rupiah } from '../../lib/format.ts';
import type { Approval } from '../../lib/types.ts';
import { Icon } from '../ui/icon.tsx';

interface Allocation {
  invoiceId: number;
  number: string;
  amount: number;
}

/** A payment the customer reported: amount, how the agent proposes to apply it, and anything left over. */
export function PaymentDetails({ approval }: { approval: Approval }) {
  const p = approval.payload ?? {};
  const allocations = (Array.isArray(p.allocations) ? p.allocations : []) as Allocation[];
  const amount = typeof p.amount === 'number' ? p.amount : null;
  const unallocated = typeof p.unallocated === 'number' ? p.unallocated : 0;
  const fromBank = p.source === 'bank_statement';
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-inner bg-surface-muted p-4">
          <dt className="text-small font-medium text-ink-2">{fromBank ? 'Nominal di mutasi rekening' : 'Nominal di bukti transfer'}</dt>
          <dd className="tabular mt-1 text-h2 font-semibold text-ink">{amount !== null ? rupiah(amount) : '–'}</dd>
        </div>
        <div className="rounded-inner bg-surface-muted p-4">
          <dt className="text-small font-medium text-ink-2">Lebih bayar</dt>
          <dd className="tabular mt-1 text-h2 font-semibold text-ink">{rupiah(unallocated)}</dd>
        </div>
      </dl>
      <section>
        <h3 className="mb-2 text-h3 font-semibold text-ink">{fromBank ? 'Pelunasan' : 'Usulan pelunasan'}</h3>
        <p className="mb-3 text-small text-ink-3">
          {fromBank
            ? 'Dicocokkan admin dari mutasi rekening. Tagihan yang cocok didahulukan, lalu yang paling lama jatuh tempo.'
            : 'Tagihan yang paling lama jatuh tempo didahulukan, kecuali pelanggan menyebut nomor tagihannya.'}
        </p>
        <ul className="flex flex-col gap-1">
          {allocations.map((a) => (
            <li key={a.invoiceId} className="flex items-center justify-between gap-3 rounded-inner px-3 py-2 hover:bg-surface-muted">
              <span className="tabular text-body text-ink">{a.number}</span>
              <span className="tabular text-body font-semibold text-ink">{rupiah(a.amount)}</span>
            </li>
          ))}
        </ul>
      </section>
      {typeof p.messageId === 'number' && (
        <p className="flex items-center gap-2 text-small text-ink-2">
          <Icon icon={Image} size={16} />
          Foto bukti transfer ada di percakapan pelanggan.
        </p>
      )}
    </div>
  );
}
