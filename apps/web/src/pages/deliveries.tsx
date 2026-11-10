import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FileSearch, ImageUp, ScanText, Truck } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAdmin } from '../components/admin-gate.tsx';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { RunTraceById } from '../components/pages/run-trace.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Chip, type Tone } from '../components/ui/chip.tsx';
import { Avatar, EmptyState, ErrorCallout, Skeleton } from '../components/ui/feedback.tsx';
import { Segmented } from '../components/ui/field.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { useToast } from '../components/ui/toast.tsx';
import { api } from '../lib/api.ts';
import { shrinkPhoto } from '../lib/image.ts';
import { date, number, rupiah } from '../lib/format.ts';
import { ease, itemIn } from '../lib/motion.ts';
import type { Order } from '../lib/types.ts';

type CheckStatus = 'pending' | 'match' | 'mismatch' | 'unreadable' | 'failed';
type LineStatus = 'ok' | 'short' | 'missing' | 'over' | 'not_ordered';

interface Check {
  id: number;
  orderId: number;
  kind: 'surat_jalan' | 'nota';
  status: CheckStatus;
  documentText: string | null;
  runId: string | null;
  createdAt: string;
  imageUrl?: string;
  result: {
    documentNumber?: string | null;
    lines?: { productId: number; name: string; status: LineStatus; ordered: string; delivered: string; shortfallValue: number; priceMismatch: { unit: string; ordered: number; onDocument: number } | null }[];
    orderedValue?: number;
    deliveredValue?: number;
    invoiceNumber?: string | null;
    invoiceAmount?: number | null;
    overbilled?: number;
    agentReport?: string;
  } | null;
}

interface ShippedOrder extends Order {
  customer: { id: number; name: string; waId: string; area: string };
  createdAt: string;
  shippedAt: string | null;
  latestCheck: Check | null;
  checks: number;
}

interface Sample {
  id: string;
  title: string;
  kind: 'surat_jalan' | 'nota';
  orderId: number | null;
  imageUrl: string;
}

const CHECK_STATUS: Record<CheckStatus | 'none', { label: string; tone: Tone }> = {
  none: { label: 'Belum dicek', tone: 'neutral' },
  pending: { label: 'Sedang dicek', tone: 'info' },
  match: { label: 'Cocok', tone: 'success' },
  mismatch: { label: 'Ada selisih', tone: 'danger' },
  unreadable: { label: 'Tidak terbaca', tone: 'warning' },
  failed: { label: 'Perlu dicek manual', tone: 'warning' },
};

const LINE_STATUS: Record<LineStatus, { label: string; tone: Tone }> = {
  ok: { label: 'Sesuai', tone: 'success' },
  short: { label: 'Kurang', tone: 'danger' },
  missing: { label: 'Tidak ada', tone: 'danger' },
  over: { label: 'Lebih', tone: 'warning' },
  not_ordered: { label: 'Tidak dipesan', tone: 'warning' },
};

export function DeliveriesPage() {
  const [params, setParams] = useSearchParams();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['deliveries'],
    queryFn: () => api.get<{ orders: ShippedOrder[]; samples: Sample[] }>('/api/deliveries'),
  });
  const orders = data?.orders ?? [];
  const selectedId = Number(params.get('order')) || (orders.find((o) => data?.samples.some((s) => s.orderId === o.orderId))?.orderId ?? orders[0]?.orderId);
  const selected = orders.find((o) => o.orderId === selectedId) ?? null;
  const select = (id: number) => setParams({ order: String(id) }, { replace: true });

  return (
    <Page>
      <PageHeader title="Pengiriman" subtitle="Foto surat jalan atau nota dicocokkan agen dengan pesanan dan tagihannya. Selisih langsung ditindaklanjuti." />
      {error && <ErrorCallout message={(error as Error).message} onRetry={() => void refetch()} />}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
        <Card title="Pesanan terkirim" group={1}>
          {isLoading ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : orders.length ? (
            <ul className="-mx-2 flex flex-col gap-1">
              {orders.map((o) => {
                const s = CHECK_STATUS[o.latestCheck?.status ?? 'none'];
                const hasSample = data?.samples.some((x) => x.orderId === o.orderId);
                const active = o.orderId === selectedId;
                return (
                  <li key={o.orderId}>
                    <button
                      type="button"
                      onClick={() => select(o.orderId)}
                      aria-current={active ? 'true' : undefined}
                      className={`relative flex w-full cursor-pointer items-center gap-3 rounded-inner px-3 py-3 text-left transition-colors duration-150 ${active ? 'bg-primary-soft' : 'hover:bg-surface-muted'}`}
                    >
                      {active && <span className="absolute top-2 bottom-2 left-0 w-1 rounded-r-pill bg-primary" aria-hidden="true" />}
                      <Avatar name={o.customer.name} size={36} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-label font-semibold text-ink">{o.customer.name}</p>
                        <p className="tabular truncate text-small text-ink-3">
                          #{o.orderId} · {date(o.createdAt)} · {rupiah(o.subtotal)}
                        </p>
                        {hasSample && <p className="mt-0.5 text-meta font-medium text-primary">Ada contoh dokumen</p>}
                      </div>
                      <Chip tone={s.tone}>{s.label}</Chip>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={Truck} title="Belum ada pesanan terkirim">
              Pesanan yang sudah dikonfirmasi dalam 3 minggu terakhir muncul di sini.
            </EmptyState>
          )}
        </Card>

        <div className="min-w-0">
          {selected ? (
            <OrderCheck key={selected.orderId} order={selected} sample={data?.samples.find((s) => s.orderId === selected.orderId) ?? null} />
          ) : (
            !isLoading && (
              <Card group={2}>
                <EmptyState icon={FileSearch} title="Pilih pesanan">
                  Pilih pesanan di kiri untuk mencocokkan surat jalan atau notanya.
                </EmptyState>
              </Card>
            )
          )}
        </div>
      </div>
    </Page>
  );
}

function OrderCheck({ order, sample }: { order: ShippedOrder; sample: Sample | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { requireAdmin } = useAdmin();
  const picker = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<'surat_jalan' | 'nota'>(sample?.kind ?? 'surat_jalan');
  const [checkId, setCheckId] = useState<number | null>(order.latestCheck?.id ?? null);
  useEffect(() => setCheckId(order.latestCheck?.id ?? null), [order.latestCheck?.id]);

  const run = useMutation({
    mutationFn: (body: FormData | { sample: string }) => api.post<{ check: Check; run: { status: string; reply: string } }>(`/api/deliveries/${order.orderId}/check`, body),
    onSuccess: ({ check }) => {
      setCheckId(check.id);
      toast(
        check.status === 'match'
          ? { tone: 'success', text: 'Dokumen cocok dengan pesanan dan tagihan.' }
          : check.status === 'mismatch'
            ? { tone: 'success', text: 'Ada selisih. Tindak lanjutnya menunggu di Persetujuan.' }
            : { tone: 'error', text: 'Agen tidak bisa menyelesaikan pengecekan. Lihat jejaknya di bawah.' },
      );
      for (const key of ['deliveries', 'approvals', 'dashboard']) qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => toast({ tone: 'error', text: (e as Error).message }),
  });

  const upload = async (picked: File) => {
    if (!(await requireAdmin())) return;
    const file = await shrinkPhoto(picked);
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('kind', kind);
    run.mutate(form);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card
        group={2}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {order.customer.name}
            <span className="tabular text-body font-normal text-ink-3">
              Pesanan #{order.orderId} · {date(order.createdAt)}
            </span>
          </span>
        }
      >
        <ul className="divide-y divide-border">
          {order.lines.map((l) => (
            <li key={`${l.productId}-${l.unit}`} className="tabular flex items-baseline justify-between gap-4 py-2 text-body">
              <span className="min-w-0">
                <span className="font-semibold">
                  {number(l.qty)} {l.unit}
                </span>{' '}
                {l.name}
              </span>
              <span className="shrink-0 text-ink-2">{rupiah(l.lineTotal)}</span>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-col gap-4 rounded-inner bg-surface-muted p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-label font-semibold text-ink">Cek dokumen pengiriman</p>
            <Segmented
              label="Jenis dokumen"
              value={kind}
              onChange={setKind}
              disabled={run.isPending}
              options={[
                { value: 'surat_jalan', label: 'Surat jalan' },
                { value: 'nota', label: 'Nota / faktur' },
              ]}
            />
          </div>
          {!order.shippedAt && (
            <p className="text-body text-ink-2">
              Pesanan ini belum dimuat ke truk. Dokumen pengirimannya bisa dicek setelah ditandai sudah dimuat di halaman Gudang.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {sample && (
              <Button
                icon={ScanText}
                loading={run.isPending}
                disabled={!order.shippedAt}
                onClick={async () => {
                  if (await requireAdmin()) run.mutate({ sample: sample.id });
                }}
              >
                Pakai contoh dokumen
              </Button>
            )}
            <Button variant={sample ? 'outline' : 'primary'} icon={ImageUp} disabled={run.isPending || !order.shippedAt} onClick={() => picker.current?.click()}>
              Unggah foto
            </Button>
            <input
              ref={picker}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void upload(file);
              }}
            />
          </div>
          {sample && (
            <p className="text-small text-ink-3">
              Contoh: {sample.title}.{' '}
              <a href={sample.imageUrl} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                Lihat fotonya
              </a>
            </p>
          )}
          <AnimatePresence initial={false}>
            {run.isPending && (
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease } }}
                exit={{ opacity: 0 }}
                role="status"
                className="flex items-center gap-2 text-body text-ink-2"
              >
                <motion.span className="size-2.5 rounded-full bg-info-fg" animate={{ opacity: [1, 0.4, 1] }} transition={{ repeat: Infinity, duration: 1.2 }} />
                Agen sedang membaca dokumen dan mencocokkannya. Biasanya 10–30 detik.
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </Card>

      {checkId !== null && <CheckResult checkId={checkId} />}
    </div>
  );
}

function CheckResult({ checkId }: { checkId: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['delivery-check', checkId],
    queryFn: () => api.get<{ check: Check }>(`/api/deliveries/checks/${checkId}`),
  });
  const check = data?.check;
  if (isLoading) return <Skeleton className="h-72" />;
  if (error || !check) return <ErrorCallout message={(error as Error | null)?.message ?? 'Hasil pengecekan tidak ditemukan.'} />;
  const r = check.result ?? {};
  const s = CHECK_STATUS[check.status];

  return (
    <motion.div variants={itemIn} initial="hidden" animate="show">
      <Card
        group={3}
        title={
          <span className="flex flex-wrap items-center gap-3">
            Hasil pengecekan <Chip tone={s.tone}>{s.label}</Chip>
          </span>
        }
        action={
          check.status === 'mismatch' ? (
            <Link to="/persetujuan" className="inline-flex h-8 items-center gap-1 rounded-pill border border-border px-3 text-small font-medium text-ink hover:bg-surface-muted">
              Tindak lanjut di Persetujuan <Icon icon={ArrowRight} size={16} />
            </Link>
          ) : undefined
        }
      >
        <div className="grid grid-cols-1 gap-5 min-[1800px]:grid-cols-[minmax(0,1fr)_220px]">
          <div className="min-w-0">
            {r.lines?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-body">
                  <thead>
                    <tr className="text-small text-ink-3">
                      <th className="pb-2 font-medium">Barang</th>
                      <th className="pb-2 font-medium">Dipesan</th>
                      <th className="pb-2 font-medium">Di dokumen</th>
                      <th className="pb-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.lines.map((l) => (
                      <tr key={l.productId} className="tabular align-top">
                        <td className="border-t border-border py-2.5 pr-3">
                          {l.name}
                          {l.priceMismatch && (
                            <p className="text-small text-warning-fg">
                              Harga di dokumen {rupiah(l.priceMismatch.onDocument)}/{l.priceMismatch.unit}, di pesanan {rupiah(l.priceMismatch.ordered)}
                            </p>
                          )}
                        </td>
                        <td className="border-t border-border py-2.5 pr-3 whitespace-nowrap">{l.ordered}</td>
                        <td className={`border-t border-border py-2.5 pr-3 whitespace-nowrap ${l.status === 'ok' ? '' : 'font-semibold text-danger-fg'}`}>{l.delivered}</td>
                        <td className="border-t border-border py-2.5">
                          <Chip tone={l.priceMismatch && l.status === 'ok' ? 'warning' : LINE_STATUS[l.status].tone}>{l.priceMismatch && l.status === 'ok' ? 'Harga beda' : LINE_STATUS[l.status].label}</Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-body text-ink-2">Belum ada perbandingan baris. Lihat jejak agen di bawah.</p>
            )}

            {r.lines?.length ? (
              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Nilai dipesan" value={r.orderedValue} />
                <Stat label="Nilai terkirim" value={r.deliveredValue} />
                <Stat label={`Tagihan ${r.invoiceNumber ?? ''}`} value={r.invoiceAmount ?? undefined} />
                <Stat label="Kelebihan tagih" value={r.overbilled} danger={(r.overbilled ?? 0) > 0} />
              </dl>
            ) : null}

            {r.agentReport && (
              <div className="mt-4">
                <p className="text-small font-semibold text-ink-3 uppercase">Laporan agen</p>
                <p className="mt-1 rounded-inner bg-surface-muted px-4 py-3 text-body whitespace-pre-line text-ink">{r.agentReport}</p>
              </div>
            )}
          </div>

          {check.imageUrl && (
            <figure className="max-w-sm">
              <a href={check.imageUrl} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-inner outline outline-1 -outline-offset-1 outline-ink/10">
                <img src={check.imageUrl} alt={`Foto ${check.kind === 'nota' ? 'nota' : 'surat jalan'} pesanan #${check.orderId}`} className="h-auto w-full" />
              </a>
              <figcaption className="mt-2 text-small text-ink-3">
                {r.documentNumber ? `No. ${r.documentNumber}` : 'Foto dokumen'} · klik untuk memperbesar
              </figcaption>
            </figure>
          )}
        </div>

        {check.runId && (
          <div className="mt-5">
            <RunTraceById runId={check.runId} />
          </div>
        )}
      </Card>
    </motion.div>
  );
}

function Stat({ label, value, danger }: { label: string; value: number | undefined; danger?: boolean }) {
  return (
    <div className={`rounded-inner p-3 ${danger ? 'bg-danger-bg' : 'bg-surface-muted'}`}>
      <dt className={`text-small ${danger ? 'text-danger-fg' : 'text-ink-2'}`}>{label}</dt>
      <dd className={`tabular text-h3 font-semibold ${danger ? 'text-danger-fg' : 'text-ink'}`}>{value === undefined ? '–' : rupiah(value)}</dd>
    </div>
  );
}
