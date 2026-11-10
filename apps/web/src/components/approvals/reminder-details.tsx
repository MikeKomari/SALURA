import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { date } from '../../lib/format.ts';
import type { Approval, OverdueInvoice } from '../../lib/types.ts';
import { Icon } from '../ui/icon.tsx';
import { customerName, reminderFacts, TONE_LABEL } from './copy.ts';

/** Invoice facts plus the exact WhatsApp text the agent wants to send. */
export function ReminderDetails({ approval, pending }: { approval: Approval; pending: boolean }) {
  const r = reminderFacts(approval);
  // The approval only carries the invoice id; the open-invoice list adds due date and history.
  const { data } = useQuery({
    queryKey: ['overdue', 'approval-lookup'],
    queryFn: () => api.get<{ invoices: OverdueInvoice[] }>('/api/collections/overdue'),
    enabled: r.invoiceId !== null,
  });
  const inv = data?.invoices.find((i) => i.invoiceId === r.invoiceId);
  const tone = r.tone ? (TONE_LABEL[r.tone] ?? r.tone) : null;
  const preferred = inv ? (TONE_LABEL[inv.preferredTone] ?? inv.preferredTone) : null;

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Fact label="Tagihan" value={r.number ?? inv?.number ?? '–'} sub={inv ? `Jatuh tempo ${date(inv.dueAt)}` : undefined} />
        <Fact label="Sisa tagihan" value={r.amount ?? '–'} big />
        <Fact label="Terlambat" value={r.daysOverdue !== null ? `${r.daysOverdue} hari` : inv ? `${inv.daysOverdue} hari` : '–'} big tone="warning" />
        <Fact
          label="Nada pesan"
          value={tone ?? '–'}
          sub={
            inv
              ? `${inv.remindersSent ? `Sudah ${inv.remindersSent} kali diingatkan` : 'Belum pernah diingatkan'}${preferred ? ` · nada pilihan pelanggan: ${preferred.toLowerCase()}` : ''}`
              : undefined
          }
        />
      </dl>

      <section aria-labelledby={`preview-${approval.id}`}>
        <h3 id={`preview-${approval.id}`} className="text-h3 font-semibold text-ink">
          {pending ? 'Pesan yang akan dikirim' : 'Pesan pengingat'}
        </h3>
        <p className="mt-1 text-small text-ink-3">Kata-katanya dari templat yang sudah disetujui distributor; agen hanya memilih nada dan waktunya.</p>
        <div className="mt-3 flex justify-end rounded-inner bg-canvas p-4">
          <div className="max-w-[440px] rounded-inner rounded-br-[4px] bg-surface-muted px-4 py-3">
            <p className="text-small font-semibold text-ink">
              SALURA <span className="font-normal text-ink-3">ke {customerName(approval)}</span>
            </p>
            <p className="mt-1 text-body break-words whitespace-pre-line text-ink">{r.text || 'Teks pengingat tidak tersedia.'}</p>
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

function Fact({ label, value, sub, big, tone }: { label: string; value: string; sub?: string; big?: boolean; tone?: 'warning' }) {
  return (
    <div className={`rounded-inner p-4 ${tone === 'warning' ? 'bg-warning-bg' : 'bg-surface-muted'}`}>
      <dt className={`text-small font-medium ${tone === 'warning' ? 'text-warning-fg' : 'text-ink-2'}`}>{label}</dt>
      <dd className={`tabular mt-1 font-semibold ${big ? 'text-h1' : 'text-h2'} ${tone === 'warning' ? 'text-warning-fg' : 'text-ink'}`}>{value}</dd>
      {sub && <dd className={`text-small ${tone === 'warning' ? 'text-warning-fg' : 'text-ink-3'}`}>{sub}</dd>}
    </div>
  );
}
