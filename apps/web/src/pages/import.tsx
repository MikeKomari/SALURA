import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Download, FileSearch, Save, TriangleAlert, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../components/admin-gate.tsx';
import { Page, PageHeader } from '../components/layout/app-shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Chip } from '../components/ui/chip.tsx';
import { ErrorCallout } from '../components/ui/feedback.tsx';
import { Field, Segmented } from '../components/ui/field.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { useToast } from '../components/ui/toast.tsx';
import { api } from '../lib/api.ts';
import type { ImportDataset, ImportPreview } from '../lib/types.ts';

const DATASETS: { value: ImportDataset; label: string; what: string; columns: string; example: string }[] = [
  {
    value: 'produk',
    label: 'Produk',
    what: 'Daftar barang dan nama-nama yang biasa dipakai pelanggan. Impor ini dulu sebelum satuan, harga dan stok.',
    columns: 'sku, nama, merek, kategori, satuan_dasar, alias (pisahkan dengan |), aktif',
    example: 'IDM-GRG-85, Indomie Mi Goreng 85g, Indomie, mi instan, pcs, indomie goreng|indomi goreng, ya',
  },
  {
    value: 'satuan',
    label: 'Satuan',
    what: 'Isi setiap satuan jual dalam satuan dasar, misalnya 1 dus = 40 pcs.',
    columns: 'sku, satuan, isi',
    example: 'IDM-GRG-85, dus, 40',
  },
  {
    value: 'harga',
    label: 'Harga',
    what: 'Harga per tier pelanggan (A, B, C) dan per satuan. Agen hanya memakai harga dari daftar ini.',
    columns: 'sku, tier, satuan, harga',
    example: 'IDM-GRG-85, C, dus, 122000',
  },
  {
    value: 'stok',
    label: 'Stok',
    what: 'Stok di gudang dalam satuan dasar. Barang yang sudah dipesan pelanggan tetap tercatat.',
    columns: 'sku, stok',
    example: 'IDM-GRG-85, 80',
  },
  {
    value: 'pelanggan',
    label: 'Pelanggan',
    what: 'Warung dan toko beserta tier harga, limit kredit, tempo dan nada pengingat.',
    columns: 'nama_toko, nama_pemilik, sapaan, no_wa, tier, limit_kredit, tempo_hari, area, alamat, nada_pengingat',
    example: 'Warung Bu Sari, Sari Wulandari, Bu, 6281234500001, C, 5000000, 14, Bekasi Timur, Jl. Melati No. 12, ramah',
  },
];

type Source = { kind: 'file'; file: File } | { kind: 'sheet'; url: string };

function body(source: Source): FormData | { sheetUrl: string } {
  if (source.kind === 'sheet') return { sheetUrl: source.url.trim() };
  const form = new FormData();
  form.append('file', source.file);
  return form;
}

export function ImportPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { requireAdmin, isAdmin } = useAuth();
  const [dataset, setDataset] = useState<ImportDataset>('produk');
  const [mode, setMode] = useState<'file' | 'sheet'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const info = DATASETS.find((d) => d.value === dataset)!;

  useEffect(() => {
    document.title = 'Impor data · SALURA';
  }, []);
  useEffect(() => setPreview(null), [dataset, mode, file, url]);

  const source: Source | null = mode === 'file' ? (file ? { kind: 'file', file } : null) : url.trim() ? { kind: 'sheet', url } : null;

  const check = useMutation({
    mutationFn: (s: Source) => api.post<{ preview: ImportPreview }>(`/api/import/${dataset}/preview`, body(s)),
    onSuccess: (r) => setPreview(r.preview),
  });
  const apply = useMutation({
    mutationFn: (s: Source) => api.post<{ preview: ImportPreview }>(`/api/import/${dataset}/apply`, body(s)),
    onSuccess: (r) => {
      toast({ tone: 'success', text: `${info.label}: ${r.preview.inserts} baris baru dan ${r.preview.updates} diperbarui. Agen langsung memakai data ini.` });
      setPreview(null);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      qc.invalidateQueries();
    },
    onError: (err) => toast({ tone: 'error', text: `Tidak tersimpan: ${(err as Error).message}` }),
  });

  return (
    <Page>
      <PageHeader title="Impor data" subtitle="Pakai data yang sudah Anda punya di Excel atau Google Sheets: produk, satuan, harga, stok dan pelanggan." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card title="1. Pilih data" className="lg:col-span-6">
          <Segmented label="Jenis data" value={dataset} options={DATASETS.map((d) => ({ value: d.value, label: d.label }))} onChange={setDataset} />
          <p className="mt-4 text-body text-ink-2">{info.what}</p>
          <dl className="mt-4 flex flex-col gap-3">
            <div>
              <dt className="text-small font-medium text-ink-2">Kolom</dt>
              <dd className="mt-1 rounded-inner bg-surface-muted px-3 py-2 font-mono text-small break-words text-ink">{info.columns}</dd>
            </div>
            <div>
              <dt className="text-small font-medium text-ink-2">Contoh baris</dt>
              <dd className="mt-1 rounded-inner bg-surface-muted px-3 py-2 font-mono text-small break-words text-ink">{info.example}</dd>
            </div>
          </dl>
          <a
            href={`/api/import/${dataset}/template`}
            download
            className="mt-5 inline-flex h-11 w-fit items-center gap-2 rounded-pill border border-primary px-5 text-label font-medium text-primary transition-colors duration-150 hover:bg-primary-soft"
          >
            <Icon icon={Download} size={16} weight="semibold" />
            Unduh data {info.label.toLowerCase()} sekarang (CSV)
          </a>
          <p className="mt-2 text-small text-ink-3">File ini sekaligus contoh format: ubah di Excel, simpan sebagai CSV, lalu impor kembali.</p>
        </Card>

        <Card title="2. Unggah dan periksa" className="lg:col-span-6">
          <Segmented
            label="Sumber"
            value={mode}
            options={[
              { value: 'file', label: 'File CSV' },
              { value: 'sheet', label: 'Google Sheets' },
            ]}
            onChange={setMode}
          />
          <div className="mt-5">
            {mode === 'file' ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={fileId} className="text-label font-medium text-ink">
                  File CSV (koma atau titik koma)
                </label>
                <input
                  ref={fileInput}
                  id={fileId}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="h-11 cursor-pointer rounded-input bg-surface-muted px-2 py-2 text-body text-ink file:mr-3 file:h-7 file:cursor-pointer file:rounded-pill file:border-0 file:bg-surface file:px-3 file:text-small file:font-medium file:text-ink"
                />
              </div>
            ) : (
              <Field
                label="Tautan Google Sheets"
                inputMode="url"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                hint='Bagikan sheet dengan "Siapa saja yang memiliki link dapat melihat". Tab yang dibuka di tautan itulah yang diimpor.'
              />
            )}
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <Button variant="outline" icon={FileSearch} loading={check.isPending} disabled={!source} onClick={async () => source && (await requireAdmin()) && check.mutate(source)}>
              Periksa dulu
            </Button>
            <Button
              icon={Save}
              loading={apply.isPending}
              disabled={!source || !preview || preview.errors.length > 0}
              onClick={async () => source && (await requireAdmin()) && apply.mutate(source)}
            >
              {preview && !preview.errors.length ? `Simpan ${preview.rows} baris` : 'Simpan'}
            </Button>
          </div>
          {!isAdmin && <p className="mt-3 text-small text-ink-3">Mengimpor data butuh akun admin. Akun tamu tetap bisa mengunduh data.</p>}

          {check.error && (
            <div className="mt-5">
              <ErrorCallout message={(check.error as Error).message} />
            </div>
          )}
          {preview && <PreviewResult preview={preview} />}
        </Card>
      </div>
    </Page>
  );
}

function PreviewResult({ preview: p }: { preview: ImportPreview }) {
  const ok = p.errors.length === 0;
  const columns = p.sample.length ? Object.keys(p.sample[0]!).filter((k) => k !== 'productId') : [];
  return (
    <section className="mt-6 flex flex-col gap-4" aria-live="polite">
      <div className={`flex gap-3 rounded-inner p-4 ${ok ? 'bg-primary-soft text-primary' : 'bg-danger-bg text-danger-fg'}`}>
        <Icon icon={ok ? CircleCheck : TriangleAlert} size={24} weight="semibold" className="mt-0.5 shrink-0" />
        <div>
          <p className="text-label font-semibold">{ok ? 'Semua baris valid' : `${p.errors.length} baris perlu diperbaiki`}</p>
          <p className="mt-1 text-body text-ink">
            {p.rows} baris dibaca: {p.inserts} baru, {p.updates} diperbarui.{ok ? ' Tekan Simpan untuk memakainya.' : ' Belum ada yang disimpan.'}
          </p>
        </div>
      </div>

      {!ok && (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {p.errors.slice(0, 100).map((e, i) => (
            <li key={i} className="flex gap-3 rounded-inner px-3 py-2 text-body hover:bg-surface-muted">
              <Chip tone="danger">Baris {e.row}</Chip>
              <span className="min-w-0 text-ink">{e.message}</span>
            </li>
          ))}
        </ul>
      )}

      {ok && p.sample.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-2 text-small text-ink-3">Contoh {p.sample.length} baris pertama seperti yang akan disimpan:</p>
          <table className="w-full text-left">
            <thead>
              <tr className="text-small text-ink-3">
                {columns.map((c) => (
                  <th key={c} className="px-2 py-1.5 font-medium whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.sample.map((row, i) => (
                <tr key={i} className="border-t border-border">
                  {columns.map((c) => (
                    <td key={c} className="tabular px-2 py-1.5 text-small whitespace-nowrap text-ink">
                      {Array.isArray(row[c]) ? (row[c] as unknown[]).join(' | ') : String(row[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="flex items-center gap-2 text-small text-ink-3">
        <Icon icon={Upload} size={16} />
        Impor disimpan sekaligus dalam satu transaksi: kalau ada satu baris salah, tidak ada yang berubah.
      </p>
    </section>
  );
}
