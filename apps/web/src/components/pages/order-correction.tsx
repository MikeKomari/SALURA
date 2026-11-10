import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.ts';
import { rupiah } from '../../lib/format.ts';
import { useAuth } from '../admin-gate.tsx';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Icon } from '../ui/icon.tsx';
import { Skeleton } from '../ui/feedback.tsx';
import { useToast } from '../ui/toast.tsx';

/**
 * The repair path for an order the agent should not have confirmed. One button with a plain name,
 * a reason picked from a list rather than typed, and the message to the customer shown before it
 * goes out — the admin approves words, never composes them (DESIGN.md §2).
 */

interface Correction {
  canCancel: boolean;
  blocked: { code: string; message: string } | null;
  invoiceNumber: string | null;
  message: string;
  subtotal: number;
  customer: { name: string; waId: string };
}

/** Plain words for what went wrong, in the order an owner is likely to need them. */
const REASONS = [
  { code: 'wrong_qty', label: 'Jumlahnya salah' },
  { code: 'wrong_product', label: 'Barangnya salah' },
  { code: 'not_an_order', label: 'Ini bukan pesanan' },
  { code: 'wrong_price', label: 'Harganya salah' },
  { code: 'customer_cancelled', label: 'Pelanggan membatalkan' },
  { code: 'other', label: 'Alasan lain' },
] as const;

export function WrongOrderButton({ orderId, onChanged }: { orderId: number; onChanged?: () => void }) {
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  if (!isAdmin) return null;
  return (
    <>
      <Button variant="outline" icon={TriangleAlert} onClick={() => setOpen(true)}>
        Ada yang salah
      </Button>
      <CorrectionDialog orderId={orderId} open={open} onClose={() => setOpen(false)} onChanged={onChanged} />
    </>
  );
}

function CorrectionDialog({ orderId, open, onClose, onChanged }: { orderId: number; open: boolean; onClose: () => void; onChanged?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['orders', 'correction', orderId],
    queryFn: () => api.get<Correction>(`/api/orders/${orderId}/correction`),
    enabled: open,
    staleTime: 0,
  });

  useEffect(() => {
    if (open) {
      setReason(null);
      setNote('');
    }
  }, [open, orderId]);
  // The draft arrives with the correction; the admin may edit it before it is sent.
  useEffect(() => {
    if (data?.message) setMessage(data.message);
  }, [data?.message]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    onChanged?.();
  };

  const restore = useMutation({
    mutationFn: () => api.post<{ order: { orderId: number } }>(`/api/orders/${orderId}/restore`, {}),
    onSuccess: () => {
      refresh();
      toast({ tone: 'success', text: `Pesanan #${orderId} dipulihkan. Pelanggan sudah diberi tahu untuk mengabaikan pembatalan tadi.` });
    },
    onError: (err: Error) => toast({ tone: 'error', text: err.message }),
  });

  const cancel = useMutation({
    mutationFn: () => api.post<{ releasedInvoice: string | null }>(`/api/orders/${orderId}/cancel`, { reasonCode: reason, note: note.trim() || undefined, message: message.trim() || undefined }),
    onSuccess: (res) => {
      refresh();
      onClose();
      toast({
        tone: 'success',
        text: `Pesanan #${orderId} dibatalkan, stok dilepas${res.releasedInvoice ? ` dan tagihan ${res.releasedInvoice} ditarik` : ''}. ${data?.customer.name ?? 'Pelanggan'} sudah diberi tahu.`,
        action: { label: 'Batalkan tindakan ini', onClick: () => restore.mutate() },
      });
    },
    onError: (err: Error) => toast({ tone: 'error', text: err.message }),
  });

  const ready = Boolean(reason) && message.trim().length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Ada yang salah dengan pesanan #${orderId}?`}
      actions={
        data?.canCancel ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Tutup
            </Button>
            <Button icon={Ban} variant="danger" loading={cancel.isPending} disabled={!ready} onClick={() => cancel.mutate()}>
              Batalkan pesanan
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Mengerti</Button>
        )
      }
    >
      {isLoading && <Skeleton className="h-40" />}
      {error && <p className="text-body text-danger-fg">{(error as Error).message}</p>}

      {data && !data.canCancel && data.blocked && (
        <div className="flex items-start gap-3 rounded-inner bg-warning-bg p-4 text-warning-fg">
          <span className="mt-0.5">
            <Icon icon={TriangleAlert} size={20} />
          </span>
          <p className="text-body">{data.blocked.message}</p>
        </div>
      )}

      {data?.canCancel && (
        <div className="flex flex-col gap-5">
          <fieldset>
            <legend className="mb-2 text-label font-semibold text-ink">Apa yang salah?</legend>
            <div className="flex flex-col gap-2">
              {REASONS.map((r) => (
                <label
                  key={r.code}
                  className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-inner px-3 py-2 text-body ${reason === r.code ? 'bg-primary-soft text-ink' : 'bg-surface-muted text-ink hover:bg-primary-soft/60'}`}
                >
                  <input type="radio" name="cancel-reason" value={r.code} checked={reason === r.code} onChange={() => setReason(r.code)} className="size-5 accent-primary" />
                  {r.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex flex-col gap-1.5">
            <span className="text-label font-medium text-ink">Catatan (boleh dikosongkan)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
              placeholder="Misalnya: Bu Sari minta 6 bungkus, bukan 10"
              className="h-11 rounded-input border border-transparent bg-surface-muted px-4 text-body text-ink placeholder:text-ink-3"
            />
          </label>

          <div className="rounded-inner bg-surface-muted p-4">
            <p className="text-label font-semibold text-ink">Yang akan terjadi</p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-body text-ink-2">
              <li>Pesanan ditandai dibatalkan, jadi tidak masuk daftar ambil barang di gudang.</li>
              <li>Stok yang sudah dipesan untuk pesanan ini dilepas kembali.</li>
              <li>{data.invoiceNumber ? `Tagihan ${data.invoiceNumber} sebesar ${rupiah(data.subtotal)} ditarik kembali.` : 'Tidak ada tagihan yang perlu ditarik.'}</li>
              <li>Pesan di bawah dikirim ke {data.customer.name} atas nama Anda.</li>
            </ul>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-label font-medium text-ink">Pesan ke pelanggan</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={6}
              maxLength={2000}
              className="rounded-input border border-transparent bg-surface-muted p-4 text-body text-ink"
            />
            <span className="text-small text-ink-3">Sudah kami tuliskan. Ubah kalau perlu, lalu tekan “Batalkan pesanan”.</span>
          </label>
        </div>
      )}
    </Dialog>
  );
}

/** The trail on a corrected order: who repaired it, when, why, and the way back. */
export function CorrectionTrail({
  order,
  onChanged,
}: {
  order: { orderId: number; status: string; cancelledAt?: string | null; cancelledBy?: string | null; cancelReason?: string | null };
  onChanged?: () => void;
}) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const restore = useMutation({
    mutationFn: () => api.post(`/api/orders/${order.orderId}/restore`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      onChanged?.();
      toast({ tone: 'success', text: `Pesanan #${order.orderId} dipulihkan. Pelanggan sudah diberi tahu untuk mengabaikan pembatalan tadi.` });
    },
    onError: (err: Error) => toast({ tone: 'error', text: err.message }),
  });

  if (!order.cancelledBy) return null;
  return (
    <div className="mt-4 rounded-inner bg-danger-bg p-4">
      <p className="text-label font-semibold text-danger-fg">Diperbaiki oleh orang</p>
      <p className="mt-1 text-body text-ink">
        Dibatalkan oleh {order.cancelledBy}
        {order.cancelledAt ? `, ${new Date(order.cancelledAt).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
        {order.cancelReason ? `. Alasan: ${order.cancelReason}` : ''}
      </p>
      <p className="mt-1 text-small text-ink-2">Stok sudah dilepas, tagihannya ditarik, dan pelanggan sudah diberi tahu.</p>
      {isAdmin && (
        <Button variant="outline" icon={Check} className="mt-3" loading={restore.isPending} onClick={() => restore.mutate()}>
          Pulihkan pesanan ini
        </Button>
      )}
    </div>
  );
}
