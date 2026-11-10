import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessagesSquare, PackageCheck, Printer, Warehouse } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../components/admin-gate.tsx';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Chip } from '../components/ui/chip.tsx';
import { EmptyState, ErrorCallout, Skeleton } from '../components/ui/feedback.tsx';
import { useToast } from '../components/ui/toast.tsx';
import { api } from '../lib/api.ts';
import { rupiah, time } from '../lib/format.ts';
import type { PickBatch } from '../lib/types.ts';

function runDay(date: string | null): string {
  if (!date) return 'Jadwal belum diatur';
  return new Date(`${date}T12:00:00+07:00`).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Jakarta' });
}

export function WarehousePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { requireAdmin } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['warehouse'], queryFn: () => api.get<{ batches: PickBatch[] }>('/api/warehouse/picking') });
  const batches = data?.batches ?? [];

  useEffect(() => {
    document.title = 'Gudang · SALURA';
  }, []);

  const ship = useMutation({
    mutationFn: (orderIds: number[]) => api.post<{ shipped: number[] }>('/api/warehouse/ship', { orderIds }),
    onSuccess: (r) => {
      toast({ tone: 'success', text: `${r.shipped.length} pesanan ditandai sudah dimuat. Dokumen pengirimannya bisa dicek di halaman Pengiriman.` });
      qc.invalidateQueries({ queryKey: ['warehouse'] });
      qc.invalidateQueries({ queryKey: ['deliveries'] });
    },
    onError: (err) => toast({ tone: 'error', text: `Belum tersimpan: ${(err as Error).message}` }),
  });

  const orders = batches.reduce((s, b) => s + b.orders.length, 0);

  return (
    <Page>
      <PageHeader
        title="Gudang"
        subtitle="Barang yang perlu disiapkan untuk setiap jadwal kirim. Pesanan yang dikonfirmasi agen langsung masuk ke daftar ini."
        actions={
          batches.length > 0 && (
            <Button variant="outline" icon={Printer} onClick={() => window.print()} className="print:hidden">
              Cetak daftar ambil barang
            </Button>
          )
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorCallout message={(error as Error).message} onRetry={() => void refetch()} />
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-48" />
        </div>
      ) : !batches.length ? (
        <Card>
          <EmptyState
            icon={Warehouse}
            title="Belum ada barang yang perlu disiapkan"
            action={
              <Button icon={MessagesSquare} onClick={() => navigate('/percakapan')}>
                Coba pesan lewat chat
              </Button>
            }
          >
            Pesanan yang dikonfirmasi di Percakapan atau disetujui di Persetujuan akan muncul di sini, dikelompokkan per hari kirim dan area.
          </EmptyState>
        </Card>
      ) : (
        <>
          <p className="mb-4 text-body text-ink-2 print:hidden">
            {orders} pesanan menunggu dimuat. Jadwal kirim mengikuti aturan area: pesanan yang dikonfirmasi sebelum pukul 15.00 WIB ikut jadwal area berikutnya.
          </p>
          <div className="flex flex-col gap-4">
            {batches.map((b) => (
              <Batch key={`${b.date}-${b.area}`} batch={b} busy={ship.isPending && ship.variables?.join() === b.orders.map((o) => o.orderId).join()} onShip={async () => (await requireAdmin()) && ship.mutate(b.orders.map((o) => o.orderId))} />
            ))}
          </div>
        </>
      )}
    </Page>
  );
}

function Batch({ batch: b, busy, onShip }: { batch: PickBatch; busy: boolean; onShip: () => void }) {
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {runDay(b.date)} · {b.area}
        </span>
      }
      action={<Chip>{b.orders.length} pesanan</Chip>}
      className="break-inside-avoid"
    >
      <div className="grid gap-6 lg:grid-cols-12">
        <section className="lg:col-span-7" aria-label="Daftar ambil barang">
          <h3 className="mb-2 text-h3 font-semibold text-ink">Ambil dari rak</h3>
          <table className="w-full text-left">
            <thead>
              <tr className="text-small text-ink-3">
                <th className="py-2 pr-3 font-medium">Barang</th>
                <th className="py-2 pr-3 text-right font-medium">Jumlah</th>
                <th className="py-2 text-right font-medium">Untuk</th>
              </tr>
            </thead>
            <tbody>
              {b.lines.map((l) => (
                <tr key={l.productId} className="border-t border-border">
                  <td className="py-2.5 pr-3">
                    <p className="text-body text-ink">{l.name}</p>
                    <p className="tabular text-meta text-ink-3">{l.sku}</p>
                  </td>
                  <td className="tabular py-2.5 pr-3 text-right text-body font-semibold whitespace-nowrap text-ink">{l.quantity}</td>
                  <td className="tabular py-2.5 text-right text-small whitespace-nowrap text-ink-2">{l.orders} pesanan</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="lg:col-span-5" aria-label="Pesanan dalam pengiriman ini">
          <h3 className="mb-2 text-h3 font-semibold text-ink">Per toko</h3>
          <ul className="flex flex-col gap-3">
            {b.orders.map((o) => (
              <li key={o.orderId} className="rounded-inner bg-surface-muted p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-label font-semibold text-ink">{o.customer}</p>
                  <p className="tabular text-small text-ink-3">#{o.orderId}</p>
                </div>
                <p className="text-small text-ink-2">{o.address}</p>
                <p className="mt-1 text-small text-ink">{o.lines.map((l) => `${l.qty} ${l.unit} ${l.name}`).join(' · ')}</p>
                <p className="tabular mt-1 text-meta text-ink-3">
                  {rupiah(o.subtotal)}
                  {o.confirmedAt ? ` · dikonfirmasi ${time(o.confirmedAt)}` : ''}
                  {o.deliveryNote ? ` · catatan: ${o.deliveryNote}` : ''}
                </p>
              </li>
            ))}
          </ul>
          <Button icon={PackageCheck} loading={busy} onClick={onShip} className="mt-4 w-full print:hidden">
            Tandai semua sudah dimuat
          </Button>
        </section>
      </div>
    </Card>
  );
}
