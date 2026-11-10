import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Ban, Boxes, ClipboardCheck, MessagesSquare, PackageX, SearchCheck, ShieldCheck, Timer, Wallet } from 'lucide-react';
import { motion } from 'motion/react';
import { Link, useNavigate } from 'react-router';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { CapsuleChart } from '../components/charts/capsule-chart.tsx';
import { ProactiveCard } from '../components/dashboard/proactive-card.tsx';
import { Gauge } from '../components/charts/gauge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { APPROVAL_LABEL, Chip, StatusChip } from '../components/ui/chip.tsx';
import { CountUp } from '../components/ui/count-up.tsx';
import { Avatar, EmptyState, ErrorCallout, Skeleton } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { KpiCard } from '../components/ui/kpi-card.tsx';
import { api } from '../lib/api.ts';
import { duration, percent, relative, rupiah, rupiahShort, seconds } from '../lib/format.ts';
import { hover, pageGroup } from '../lib/motion.ts';
import type { DashboardData } from '../lib/types.ts';

export function DashboardPage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/api/dashboard') });
  const m = data?.metrics;

  return (
    <Page>
      <PageHeader
        title="Ringkasan"
        subtitle="Pesanan yang ditangani agen, kesalahan yang dicegah, dan hal yang menunggu keputusan Anda."
        actions={
          <>
            <Button icon={MessagesSquare} onClick={() => navigate('/percakapan')}>
              Coba pesan sebagai warung
            </Button>
            <Button variant="outline" onClick={() => navigate('/persetujuan')}>
              Buka persetujuan
            </Button>
          </>
        }
      />
      {error && (
        <div className="mb-4">
          <ErrorCallout message={(error as Error).message} onRetry={() => void refetch()} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          highlighted
          title="Pesanan ditangani"
          value={m?.ordersHandled ?? null}
          loading={isLoading}
          to="/pesanan"
          footer={m ? `${m.straightThrough} di antaranya tanpa sentuhan admin` : ' '}
        />
        <KpiCard
          title="Lolos otomatis"
          value={m?.straightThroughRate === null || !m ? null : Math.round(m.straightThroughRate * 100)}
          format={(n) => `${Math.round(n)}%`}
          loading={isLoading}
          to="/pesanan"
          footer="Pesanan selesai tanpa diedit atau disetujui manual"
        />
        <KpiCard title="Perlu persetujuan" value={m?.pendingApprovals ?? null} loading={isLoading} to="/persetujuan" footer="Ditahan agen, menunggu keputusan Anda" />
        <KpiCard
          title="Piutang jatuh tempo"
          value={m?.overdue.amount ?? null}
          format={rupiahShort}
          loading={isLoading}
          to="/penagihan"
          footer={m ? `${m.overdue.invoices} tagihan dari ${m.overdue.customers} pelanggan` : ' '}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card title="Pesanan 7 hari terakhir" className="lg:col-span-5">
          {m ? <CapsuleChart data={m.ordersPerDay} label="Jumlah pesanan per hari" /> : <Skeleton className="h-[220px]" />}
        </Card>

        <Card title="Perlu tindakan" className="lg:col-span-3">
          {isLoading ? (
            <Skeleton className="h-40" />
          ) : data?.oldestPendingApproval ? (
            <div className="flex flex-1 flex-col">
              <p className="text-h2 font-semibold text-primary">{data.oldestPendingApproval.customerName ?? 'Nomor tidak dikenal'}</p>
              <p className="mt-1 text-small text-ink-3">
                {APPROVAL_LABEL[data.oldestPendingApproval.type]} · {relative(data.oldestPendingApproval.requestedAt)}
              </p>
              <p className="mt-3 line-clamp-3 text-body text-ink-2">{data.oldestPendingApproval.reason}</p>
              <Button className="mt-auto w-full" icon={ClipboardCheck} onClick={() => navigate(`/persetujuan?id=${data.oldestPendingApproval!.id}`)}>
                Tinjau sekarang
              </Button>
            </div>
          ) : (
            <EmptyState icon={ShieldCheck} title="Semua beres">
              Tidak ada pesanan yang ditahan.
            </EmptyState>
          )}
        </Card>

        <Card
          title="Pesanan terbaru"
          className="lg:col-span-4"
          action={
            <Link to="/pesanan" className="inline-flex h-10 items-center gap-1 rounded-pill border border-border px-3 text-small font-medium text-ink hover:bg-surface-muted lg:h-8">
              Semua <Icon icon={ArrowRight} size={16} />
            </Link>
          }
        >
          {isLoading ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : data?.recentOrders.length ? (
            <ul className="-mx-2 flex flex-col">
              {data.recentOrders.slice(0, 5).map((o) => (
                <motion.li key={o.orderId} whileHover={{ x: 2 }} transition={hover}>
                  <Link to={`/pesanan?id=${o.orderId}`} className="flex items-center gap-3 rounded-inner px-2 py-2.5 hover:bg-surface-muted">
                    <Avatar name={o.customer.name} size={36} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-label font-semibold text-ink">{o.customer.name}</p>
                      <p className="tabular truncate text-small text-ink-3">
                        #{o.orderId} · {o.lines.length} barang · {rupiah(o.subtotal)}
                      </p>
                    </div>
                    <StatusChip status={o.status} />
                  </Link>
                </motion.li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Boxes} title="Belum ada pesanan" action={<Button size="sm" variant="ghost" onClick={() => navigate('/percakapan')}>Kirim pesanan pertama</Button>}>
              Pesanan dari chat akan muncul di sini.
            </EmptyState>
          )}
        </Card>

        <Card title="Kesalahan yang dicegah" className="lg:col-span-5">
          {m ? (
            <ul className="flex flex-col gap-1">
              <PreventedRow icon={PackageX} tone="danger" label="Stok habis atau kurang" detail="Agen menawarkan pengganti, bukan menjanjikan barang" count={m.errorsCaught.outOfStock} />
              <PreventedRow icon={Wallet} tone="warning" label="Melewati limit kredit" detail="Dipecah atau ditahan untuk persetujuan" count={m.errorsCaught.overCredit} />
              <PreventedRow icon={SearchCheck} tone="info" label="Nama barang ambigu" detail="Ditanyakan atau dicocokkan dengan riwayat" count={m.errorsCaught.ambiguous} />
              <PreventedRow icon={Ban} tone="neutral" label="Aksi ditolak aturan bisnis" detail="Misal konfirmasi sebelum pelanggan setuju" count={m.errorsCaught.blockedActions} />
            </ul>
          ) : (
            <Skeleton className="h-56" />
          )}
        </Card>

        <Card title="Keandalan agen" className="lg:col-span-3">
          {data?.evaluation ? (
            <Gauge
              segments={[
                { value: data.evaluation.passK, color: 'var(--primary)' },
                { value: Math.max(0, (data.evaluation.accuracy ?? data.evaluation.passK) - data.evaluation.passK), color: 'var(--chart-2)' },
              ]}
              centerValue={percent(data.evaluation.passK)}
              centerLabel={`lolos ${data.evaluation.k}× berturut`}
              legend={[
                { label: `pass^${data.evaluation.k}`, swatch: 'bg-primary' },
                { label: 'Akurasi item', swatch: 'bg-chart-2' },
                { label: 'Gagal', swatch: 'hatch border border-border' },
              ]}
            />
          ) : isLoading ? (
            <Skeleton className="h-48" />
          ) : (
            <EmptyState icon={ShieldCheck} title="Belum diuji" action={<Button size="sm" variant="ghost" onClick={() => navigate('/evaluasi')}>Lihat evaluasi</Button>}>
              Jalankan evaluasi untuk mengukur akurasi.
            </EmptyState>
          )}
        </Card>

        <motion.section variants={pageGroup} custom={2} className="relative flex flex-col overflow-hidden rounded-card p-6 text-white lg:col-span-4" style={{ background: 'var(--gradient-feature)' }}>
          <TimeSavedPattern />
          <div className="relative flex items-center gap-2 text-primary-on-strong">
            <Icon icon={Timer} size={20} weight="semibold" />
            <h2 className="text-h2 font-semibold text-white">Waktu dihemat</h2>
          </div>
          <p className="relative mt-4 text-display font-semibold">{m ? <CountUp value={m.minutesSaved} format={duration} /> : '–'}</p>
          <p className="relative mt-1 text-small text-primary-on-strong">
            {m ? `Perkiraan: pesanan terkonfirmasi × ${m.manualMinutesPerOrder} menit input manual per pesanan` : ' '}
          </p>
          <dl className="relative mt-auto grid grid-cols-2 gap-3 pt-6">
            <div className="rounded-inner bg-white/10 p-3">
              <dt className="text-small text-primary-on-strong">Rata-rata respons</dt>
              <dd className="tabular text-h3 font-semibold">{m?.avgRunSeconds ? seconds(m.avgRunSeconds) : '–'}</dd>
            </div>
            <div className="rounded-inner bg-white/10 p-3">
              <dt className="text-small text-primary-on-strong">Biaya AI per pesanan</dt>
              <dd className="tabular text-h3 font-semibold">{m?.costPerOrderUsd !== null && m?.costPerOrderUsd !== undefined ? `$${m.costPerOrderUsd.toFixed(4)}` : '–'}</dd>
            </div>
          </dl>
        </motion.section>

        <ProactiveCard />
      </div>
    </Page>
  );
}

function PreventedRow({ icon, tone, label, detail, count }: { icon: typeof Ban; tone: 'danger' | 'warning' | 'info' | 'neutral'; label: string; detail: string; count: number }) {
  const tile = { danger: 'bg-danger-bg text-danger-fg', warning: 'bg-warning-bg text-warning-fg', info: 'bg-info-bg text-info-fg', neutral: 'bg-surface-muted text-ink-2' }[tone];
  return (
    <li className="flex items-center gap-3 rounded-inner py-2.5">
      <span className={`grid size-9 shrink-0 place-items-center rounded-full ${tile}`}>
        <Icon icon={icon} size={20} weight="semibold" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-label font-semibold text-ink">{label}</p>
        <p className="truncate text-small text-ink-3">{detail}</p>
      </div>
      <Chip tone={tone}>
        <CountUp value={count} /> kali
      </Chip>
    </li>
  );
}

/** Subtle line pattern on the feature card (DESIGN.md: 6% opacity, no glow). */
function TimeSavedPattern() {
  return (
    <svg className="pointer-events-none absolute -right-10 -bottom-10 h-64 w-64 text-white opacity-[0.06]" viewBox="0 0 200 200" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <circle key={i} cx="200" cy="200" r={30 + i * 20} fill="none" stroke="currentColor" strokeWidth="6" />
      ))}
    </svg>
  );
}
