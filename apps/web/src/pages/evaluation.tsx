import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, FlaskConical, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Fragment, useState } from 'react';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { CodeBlock } from '../components/pages/code-block.tsx';
import { Card } from '../components/ui/card.tsx';
import { Chip } from '../components/ui/chip.tsx';
import { EmptyState, ErrorCallout, Skeleton } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { KpiCard } from '../components/ui/kpi-card.tsx';
import { api } from '../lib/api.ts';
import { date, percent, time } from '../lib/format.ts';
import { ease, pageGroup } from '../lib/motion.ts';
import type { EvalReport } from '../lib/types.ts';

type EvalCase = EvalReport['cases'][number];

const CATEGORY_LABEL: Record<string, string> = {
  simple: 'Pesanan jelas',
  slang: 'Bahasa gaul dan salah ketik',
  usual: '“Yang biasa”',
  ambiguous: 'Nama barang ambigu',
  out_of_stock: 'Stok habis',
  over_credit: 'Limit kredit dan tagihan',
  payment: 'Pembayaran',
  policy: 'Pertanyaan kebijakan',
  escalation: 'Dialihkan ke admin',
  voice: 'Pesan suara',
  photo: 'Foto daftar belanja',
  cancel: 'Pembatalan',
  proactive: 'Tawaran pesan ulang',
  delivery: 'Cek surat jalan / nota',
};

const pct = (n: number) => `${Math.round(n)}%`;
const seconds = (n: number) => `${n.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} dtk`;

export function EvaluationPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['eval'],
    queryFn: () => api.get<{ report: EvalReport | null }>('/api/eval/latest'),
  });
  const report = data?.report ?? null;
  const k = report?.k ?? 5;

  return (
    <Page>
      <PageHeader
        title="Evaluasi"
        subtitle={
          report
            ? `${report.summary.cases} kasus uji × ${k} percobaan · model ${report.model} · dijalankan ${date(report.ranAt)} pukul ${time(report.ranAt)}`
            : 'Uji agen dengan percakapan warung yang sama, berulang kali, lalu ukur hasilnya.'
        }
      />

      <motion.p variants={pageGroup} custom={1} className="mb-4 max-w-3xl rounded-inner bg-info-bg px-4 py-3 text-body text-info-fg">
        <strong className="font-semibold">pass^{k}</strong> artinya satu kasus baru dihitung lolos bila berhasil di semua {k} kali percobaan berulang, jadi angka ini mengukur konsistensi agen, bukan
        keberuntungan sekali jalan.
      </motion.p>

      {error && (
        <div className="mb-4">
          <ErrorCallout message={(error as Error).message} onRetry={() => void refetch()} />
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-40 rounded-card" />
          ))}
        </div>
      ) : !report ? (
        !error && <NoReport />
      ) : (
        <ReportView report={report} />
      )}
    </Page>
  );
}

function NoReport() {
  return (
    <Card>
      <EmptyState icon={FlaskConical} title="Belum ada hasil evaluasi">
        Jalankan evaluasi dari folder proyek. Hasilnya tersimpan di packages/eval/results/latest.json dan langsung tampil di sini. Perlu LLM_API_KEY di berkas .env.
      </EmptyState>
      <div className="mx-auto flex w-full max-w-md flex-col gap-3 pb-6">
        <div>
          <p className="mb-1.5 text-label font-medium text-ink">Semua kasus, 5 percobaan per kasus (bawaan)</p>
          <CodeBlock code="pnpm eval" />
        </div>
        <div>
          <p className="mb-1.5 text-label font-medium text-ink">Atur jumlah percobaan sendiri</p>
          <CodeBlock code="pnpm eval --k 5" />
        </div>
      </div>
    </Card>
  );
}

function ReportView({ report }: { report: EvalReport }) {
  const s = report.summary;
  const categories = Object.entries(s.byCategory).sort((a, b) => b[1].cases - a[1].cases);
  const failing = report.cases.filter((c) => !c.passAllK).length;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard title="Akurasi item" value={s.itemAccuracy === null ? null : s.itemAccuracy * 100} format={pct} to="#kasus" footer="Barang dan jumlah persis sesuai pesanan" />
        <KpiCard highlighted title={`pass^${report.k}`} value={s.passK * 100} format={pct} to="#kasus" footer={`Kasus yang lolos di semua ${report.k} percobaan`} />
        <KpiCard title="Tingkat lolos" value={s.passRate * 100} format={pct} to="#kasus" footer="Rata-rata semua percobaan" />
        <KpiCard title="Detik per giliran" value={s.avgSecondsPerTurn} format={seconds} to="#kasus" footer="Waktu agen membalas satu pesan" />
        <KpiCard
          title="Biaya per kasus"
          value={s.avgCostPerCaseUsd}
          format={(n) => `$${n.toFixed(4)}`}
          to="#kasus"
          footer={s.avgCostPerCaseUsd === null ? 'Harga model belum diatur' : 'Biaya model AI untuk satu percakapan'}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card title="Per kategori" className="lg:col-span-5">
          <ul className="flex flex-col gap-4">
            {categories.map(([cat, c], i) => (
              <li key={cat}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-label font-semibold text-ink">{CATEGORY_LABEL[cat] ?? cat}</p>
                  <p className="tabular text-small whitespace-nowrap text-ink-2">
                    {Math.round(c.passK * c.cases)}/{c.cases} kasus · {percent(c.passK)}
                  </p>
                </div>
                <div
                  className="hatch mt-1.5 h-3 overflow-hidden rounded-pill border border-border"
                  role="img"
                  aria-label={`${CATEGORY_LABEL[cat] ?? cat}: pass^${report.k} ${percent(c.passK)}, tingkat lolos ${percent(c.passRate)}`}
                >
                  <motion.div
                    className="h-full origin-left rounded-pill bg-primary"
                    style={{ width: `${c.passK * 100}%` }}
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: 0.4, ease, delay: i * 0.04 }}
                  />
                </div>
                <p className="tabular mt-1 text-meta text-ink-3">Tingkat lolos per percobaan {percent(c.passRate)}</p>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Kasus uji" className="lg:col-span-7" action={<Chip tone={failing ? 'warning' : 'success'}>{failing ? `${failing} kasus belum konsisten` : 'Semua konsisten'}</Chip>}>
          <div id="kasus" className="-mx-2 scroll-mt-4 overflow-x-auto">
            <CaseTable cases={report.cases} k={report.k} />
          </div>
        </Card>
      </div>
    </>
  );
}

function CaseTable({ cases, k }: { cases: EvalCase[]; k: number }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <table className="w-full text-left">
      <thead>
        <tr className="text-small text-ink-3">
          <th className="px-2 py-2 font-medium">Kasus</th>
          <th className="px-2 py-2 font-medium">Kategori</th>
          <th className="px-2 py-2 text-right font-medium">Pesan</th>
          <th className="px-2 py-2 font-medium">Hasil {k} percobaan</th>
          <th className="px-2 py-2">
            <span className="sr-only">Detail</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {cases.map((c) => {
          const expanded = open === c.id;
          return (
            <Fragment key={c.id}>
              <tr className="border-t border-border align-middle">
                <td className="px-2 py-2.5">
                  <p className="tabular text-label font-semibold text-ink">{c.id}</p>
                  <p className="max-w-[260px] truncate text-small text-ink-3" title={c.turns[0]}>
                    “{c.turns[0]}”
                  </p>
                </td>
                <td className="px-2 py-2.5 text-small text-ink-2">{CATEGORY_LABEL[c.category] ?? c.category}</td>
                <td className="tabular px-2 py-2.5 text-right text-body text-ink">{c.turns.length}</td>
                <td className="px-2 py-2.5">
                  <RunDots c={c} />
                </td>
                <td className="px-2 py-2.5 text-right">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`Detail kasus ${c.id}`}
                    title="Detail"
                    onClick={() => setOpen(expanded ? null : c.id)}
                    className="grid size-10 cursor-pointer place-items-center rounded-full text-primary hover:bg-primary-soft"
                  >
                    <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.15, ease }} className="grid">
                      <Icon icon={ChevronDown} size={20} weight="semibold" />
                    </motion.span>
                  </button>
                </td>
              </tr>
              <tr>
                <td colSpan={5} className="p-0">
                  <AnimatePresence initial={false}>
                    {expanded && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2, ease }}
                        className="overflow-hidden"
                      >
                        <CaseDetail c={c} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function RunDots({ c }: { c: EvalCase }) {
  return (
    <div className="flex items-center gap-2">
      <ul className="flex gap-1" aria-label={`${c.passes} dari ${c.attempts} percobaan lolos`}>
        {c.runs.map((r) => (
          <li
            key={r.attempt}
            title={`Percobaan ${r.attempt + 1}: ${r.grade.pass ? 'lolos' : 'gagal'}`}
            className={`grid size-6 place-items-center rounded-full ${r.grade.pass ? 'bg-primary text-white' : 'bg-danger-bg text-danger-fg'}`}
          >
            {r.grade.pass ? <Check size={14} strokeWidth={2.5} aria-hidden="true" /> : <X size={14} strokeWidth={2.5} aria-hidden="true" />}
          </li>
        ))}
      </ul>
      <span className="tabular text-small whitespace-nowrap text-ink-2">
        {c.passes}/{c.attempts}
      </span>
    </div>
  );
}

function CaseDetail({ c }: { c: EvalCase }) {
  const failed = c.runs.filter((r) => !r.grade.pass);
  return (
    <div className="mb-3 rounded-inner bg-surface-muted p-4">
      <p className="text-small font-semibold text-ink-2">Pesan pelanggan</p>
      <ol className="mt-1 flex flex-col gap-1">
        {c.turns.map((t, i) => (
          <li key={i} className="text-body text-ink">
            <span className="tabular mr-2 text-small text-ink-3">{i + 1}.</span>“{t}”
          </li>
        ))}
      </ol>
      {failed.length ? (
        <div className="mt-4 flex flex-col gap-3">
          {failed.map((r) => (
            <div key={r.attempt}>
              <p className="text-small font-semibold text-danger-fg">Percobaan {r.attempt + 1} gagal di:</p>
              <ul className="mt-1 flex flex-col gap-1">
                {r.grade.checks
                  .filter((ch) => !ch.ok)
                  .map((ch, i) => (
                    <li key={i} className="text-small text-ink-2">
                      <span className="font-mono text-[14px] text-ink">{ch.name}</span>
                      {ch.detail ? ` · ${ch.detail}` : ''}
                    </li>
                  ))}
              </ul>
              {r.replies.length > 0 && <p className="mt-1 line-clamp-3 text-small text-ink-3 italic">Balasan terakhir agen: “{r.replies[r.replies.length - 1]}”</p>}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-small text-primary">Lolos di semua percobaan. Semua pemeriksaan terpenuhi.</p>
      )}
    </div>
  );
}
