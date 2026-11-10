import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Download, FileSearch, Landmark, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useAuth } from '../admin-gate.tsx';
import { errorText } from '../approvals/copy.ts';
import { Button } from '../ui/button.tsx';
import { Card } from '../ui/card.tsx';
import { Chip, type Tone } from '../ui/chip.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { ErrorCallout } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { useToast } from '../ui/toast.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { date, rupiah } from '../../lib/format.ts';
import type { BankApplied, BankLine, BankMatchCandidate, BankPreview } from '../../lib/types.ts';

type Source = { kind: 'file'; file: File } | { kind: 'sample' };
/** Per line: a candidate id, "skip" (decide later) or "ignore" (not a customer payment). */
type Choices = Record<string, string>;

const STATUS: Record<BankLine['status'], { label: string; tone: Tone }> = {
  confident: { label: 'Yakin cocok', tone: 'success' },
  review: { label: 'Perlu dicek', tone: 'warning' },
  none: { label: 'Tidak ada yang cocok', tone: 'neutral' },
  recorded: { label: 'Sudah dicatat', tone: 'info' },
};

const KIND: Record<BankMatchCandidate['kind'], string> = {
  chat_payment: 'Bukti transfer di chat',
  recorded_payment: 'Sudah dicatat lunas',
  invoices: 'Tagihan terbuka',
};

function body(source: Source, selections?: { hash: string; candidateId: string | null }[]) {
  if (source.kind === 'sample') return { sample: true, selections };
  const form = new FormData();
  form.append('file', source.file);
  if (selections) form.append('selections', JSON.stringify(selections));
  return form;
}

/** Confident lines start on their best match; everything else waits for the owner. */
function defaults(lines: BankLine[]): Choices {
  return Object.fromEntries(lines.filter((l) => l.status !== 'recorded').map((l) => [l.hash, l.status === 'confident' ? l.candidates[0]!.id : 'skip']));
}

/** Invoices that two chosen lines would both pay: only the first would get them, so saving is refused. */
function sharedInvoices(lines: BankLine[], choices: Choices): string[] {
  const rows = new Map<string, number[]>();
  for (const l of lines) {
    const c = l.candidates.find((c) => c.id === choices[l.hash]);
    if (!c || c.kind === 'recorded_payment') continue;
    for (const a of c.allocations) rows.set(a.number, [...(rows.get(a.number) ?? []), l.row]);
  }
  return [...rows].filter(([, r]) => r.length > 1).map(([number, r]) => `Baris ${r.join(' dan ')} sama-sama melunasi ${number}.`);
}

/** Upload the bank statement, review the proposed matches, record the confirmed ones. */
export function BankStatementCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { requireAdmin, isAdmin } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [preview, setPreview] = useState<BankPreview | null>(null);
  const [choices, setChoices] = useState<Choices>({});
  const [confirming, setConfirming] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileId = useId();

  const check = useMutation({
    mutationFn: (s: Source) => api.post<{ preview: BankPreview }>('/api/bank-statement/preview', body(s)),
    onSuccess: (r, s) => {
      setSource(s);
      setPreview(r.preview);
      setChoices(defaults(r.preview.lines));
    },
  });
  const selections = preview
    ? preview.lines.filter((l) => l.status !== 'recorded' && choices[l.hash] && choices[l.hash] !== 'skip').map((l) => ({ hash: l.hash, candidateId: choices[l.hash] === 'ignore' ? null : choices[l.hash]! }))
    : [];
  const picked = preview
    ? selections.map((sel) => {
        const line = preview.lines.find((l) => l.hash === sel.hash)!;
        return { line, candidate: line.candidates.find((c) => c.id === sel.candidateId) };
      })
    : [];
  const paying = picked.filter((p) => p.candidate && p.candidate.kind !== 'recorded_payment');
  const linked = picked.filter((p) => p.candidate?.kind === 'recorded_payment').length;
  const ignored = picked.length - paying.length - linked;
  const conflicts = preview ? sharedInvoices(preview.lines, choices) : [];
  const apply = useMutation({
    mutationFn: (s: Source) => api.post<{ applied: BankApplied[] }>('/api/bank-statement/apply', body(s, selections)),
    onSettled: () => setConfirming(false),
    onSuccess: (r, s) => {
      const paid = r.applied.filter((a) => a.outcome === 'payment_recorded' || a.outcome === 'chat_payment_approved');
      const ignored = r.applied.filter((a) => a.outcome === 'ignored').length;
      const parts = [`${paid.length} pembayaran dicatat (${rupiah(paid.reduce((sum, a) => sum + a.amount, 0))})`];
      if (r.applied.some((a) => a.outcome === 'linked')) parts.push(`${r.applied.filter((a) => a.outcome === 'linked').length} ditandai sudah tercatat`);
      if (ignored) parts.push(`${ignored} diabaikan`);
      toast({ tone: 'success', text: `Mutasi disimpan: ${parts.join(', ')}.` });
      for (const key of ['payments', 'overdue', 'overpaid', 'approvals', 'dashboard']) qc.invalidateQueries({ queryKey: [key] });
      check.mutate(s);
    },
    onError: (err, s) => {
      toast({ tone: 'error', text: `Tidak tersimpan: ${errorText(err)}` });
      // The proposals changed meanwhile (a chat claim arrived, someone else decided): show the current ones.
      if (err instanceof ApiError && (err.code === 'match_stale' || err.code === 'approval_not_pending')) check.mutate(s);
    },
  });

  const run = async (s: Source) => {
    if (await requireAdmin()) check.mutate(s);
  };

  return (
    <Card title="Mutasi bank">
      <p className="-mt-2 mb-4 text-body text-ink-2">
        Unggah mutasi rekening dari internet banking (CSV KlikBCA, Livin&apos; Mandiri atau BRI). SALURA mencocokkan setiap uang masuk dengan tagihan terbuka dan bukti transfer di chat, lengkap dengan alasannya. Tagihan baru berubah setelah Anda konfirmasi.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
          <label htmlFor={fileId} className="text-label font-medium text-ink">
            File mutasi (CSV)
          </label>
          <input
            ref={fileInput}
            id={fileId}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="h-11 w-full min-w-0 cursor-pointer rounded-input bg-surface-muted px-2 py-2 text-body text-ink file:mr-3 file:h-7 file:cursor-pointer file:rounded-pill file:border-0 file:bg-surface file:px-3 file:text-small file:font-medium file:text-ink"
          />
        </div>
        <Button variant="outline" icon={FileSearch} loading={check.isPending && check.variables?.kind === 'file'} disabled={!file} onClick={() => file && void run({ kind: 'file', file })}>
          Periksa mutasi
        </Button>
        <Button variant="ghost" icon={Landmark} loading={check.isPending && check.variables?.kind === 'sample'} onClick={() => void run({ kind: 'sample' })}>
          Pakai contoh mutasi
        </Button>
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-3">
        <a href="/api/bank-statement/sample" download className="inline-flex min-h-11 items-center gap-1.5 font-medium text-primary underline-offset-2 hover:underline lg:min-h-0">
          <Icon icon={Download} size={16} />
          Unduh contoh CSV
        </a>
        <span>Contoh mutasi BCA untuk data demo: lima uang masuk, satu di antaranya perlu dicek.</span>
      </p>
      {!isAdmin && <p className="mt-2 text-small text-ink-3">Mencocokkan mutasi butuh akun admin.</p>}

      {check.error && (
        <div className="mt-5">
          <ErrorCallout message={errorText(check.error)} />
        </div>
      )}

      {preview && source && (
        <section className="mt-6 flex flex-col gap-4" aria-live="polite">
          <Summary preview={preview} />
          {preview.errors.length > 0 && (
            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
              {preview.errors.slice(0, 50).map((e) => (
                <li key={e.row} className="flex flex-wrap items-center gap-3 rounded-inner px-3 py-2 text-body hover:bg-surface-muted">
                  <Chip tone="danger">Baris {e.row}</Chip>
                  <span className="min-w-0 text-ink">{e.message}; dilewati.</span>
                </li>
              ))}
              {preview.errorCount > 50 && <li className="px-3 py-2 text-small text-ink-3">dan {preview.errorCount - 50} baris lain yang tidak terbaca.</li>}
            </ul>
          )}
          {preview.lines.length === 0 ? (
            <p className="rounded-inner bg-surface-muted p-4 text-body text-ink-2">Tidak ada uang masuk di file ini.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {preview.lines.map((l) => (
                <LineItem key={l.hash} line={l} choice={choices[l.hash]} onChoose={(v) => setChoices((c) => ({ ...c, [l.hash]: v }))} />
              ))}
            </ul>
          )}
          {conflicts.length > 0 && (
            <div className="flex gap-2 rounded-inner bg-warning-bg p-3 text-small text-warning-fg" role="alert">
              <Icon icon={TriangleAlert} size={16} className="mt-0.5 shrink-0" />
              <p className="min-w-0">{conflicts.join(' ')} Hanya baris pertama yang bisa memakainya. Simpan salah satu dulu, lalu periksa ulang mutasinya untuk baris yang lain.</p>
            </div>
          )}
          {preview.lines.some((l) => l.status !== 'recorded') && (
            <div className="flex flex-wrap items-center gap-3">
              <Button icon={CircleCheck} loading={apply.isPending} disabled={!selections.length || conflicts.length > 0 || check.isPending} onClick={async () => (await requireAdmin()) && setConfirming(true)}>
                {selections.length ? `Simpan ${selections.length} pilihan` : 'Pilih yang mau disimpan'}
              </Button>
              <p className="min-w-0 flex-1 basis-64 text-small text-ink-3">
                Disimpan dalam satu transaksi. Pelanggan yang pembayarannya dicatat menerima ucapan terima kasih. Baris yang sudah disimpan tidak dicatat dua kali walau file diunggah lagi.
              </p>
            </div>
          )}
        </section>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Simpan pilihan mutasi?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Batal
            </Button>
            <Button icon={CircleCheck} loading={apply.isPending} onClick={() => source && apply.mutate(source)}>
              Ya, simpan
            </Button>
          </>
        }
      >
        <ul className="tabular flex list-disc flex-col gap-1 pl-5">
          {paying.length > 0 && (
            <li>
              {paying.length} pembayaran dicatat, total {rupiah(paying.reduce((sum, p) => sum + p.line.amount, 0))}; tagihannya langsung berubah.
            </li>
          )}
          {linked > 0 && <li>{linked} pembayaran yang sudah lunas ditandai cocok dengan mutasi.</li>}
          {ignored > 0 && <li>{ignored} baris disimpan sebagai bukan pembayaran pelanggan.</li>}
          {paying.length > 0 && <li>{paying.length} pelanggan menerima ucapan terima kasih lewat WhatsApp.</li>}
        </ul>
        <p className="mt-3">Pembayaran yang sudah dicatat tidak bisa dibatalkan dari layar ini.</p>
      </Dialog>
    </Card>
  );
}

function Summary({ preview: p }: { preview: BankPreview }) {
  const count = (s: BankLine['status']) => p.lines.filter((l) => l.status === s).length;
  const skipped = [p.debitRows ? `${p.debitRows} transaksi keluar` : '', p.pendingRows ? `${p.pendingRows} transaksi belum diproses bank` : ''].filter(Boolean).join(' dan ');
  return (
    <div className="flex flex-col gap-2">
      <p className="text-label font-semibold text-ink">
        {p.lines.length} uang masuk, total {rupiah(p.lines.reduce((s, l) => s + l.amount, 0))}
      </p>
      <div className="flex flex-wrap gap-2">
        {(['confident', 'review', 'none', 'recorded'] as const).map((s) =>
          count(s) ? (
            <Chip key={s} tone={STATUS[s].tone}>
              {STATUS[s].label}: {count(s)}
            </Chip>
          ) : null,
        )}
      </div>
      {skipped && <p className="text-small text-ink-3">{skipped} dilewati; hanya uang masuk yang dicocokkan.</p>}
      {p.warnings.map((w) => (
        <p key={w} className="flex gap-2 rounded-inner bg-warning-bg p-3 text-small text-warning-fg">
          <Icon icon={TriangleAlert} size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{w}</span>
        </p>
      ))}
    </div>
  );
}

function LineItem({ line: l, choice, onChoose }: { line: BankLine; choice: string | undefined; onChoose: (v: string) => void }) {
  const s = STATUS[l.status];
  return (
    <li className="rounded-inner bg-surface-muted p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="tabular text-h3 font-semibold text-ink">{rupiah(l.amount)}</p>
          <p className="tabular text-small text-ink-3">
            {date(`${l.postedOn}T12:00:00+07:00`)} · baris {l.row}
          </p>
        </div>
        <Chip tone={s.tone}>{s.label}</Chip>
      </div>
      <p className="mt-2 font-mono text-small [overflow-wrap:anywhere] text-ink-2">{l.description}</p>

      {l.recorded ? (
        <p className="mt-3 text-small text-ink-2">
          {l.recorded.status === 'matched'
            ? `Dicocokkan ${date(l.recorded.at)} oleh ${l.recorded.decidedBy}${l.recorded.customerName ? ` dengan pembayaran ${l.recorded.customerName}` : ''}.`
            : `Diabaikan ${date(l.recorded.at)} oleh ${l.recorded.decidedBy}: bukan pembayaran pelanggan.`}
        </p>
      ) : (
        <fieldset className="mt-3 flex flex-col gap-2">
          <legend className="sr-only">Pilihan untuk uang masuk {rupiah(l.amount)}</legend>
          {l.candidates.map((c) => (
            <Option key={c.id} name={l.hash} value={c.id} checked={choice === c.id} onChoose={onChoose}>
              <CandidateText candidate={c} />
            </Option>
          ))}
          <Option name={l.hash} value="skip" checked={choice === 'skip'} onChoose={onChoose}>
            <span className="text-label font-medium text-ink">Putuskan nanti</span>
            <span className="block text-small text-ink-3">Tidak disimpan; baris ini muncul lagi saat mutasi diunggah berikutnya.</span>
          </Option>
          <Option name={l.hash} value="ignore" checked={choice === 'ignore'} onChoose={onChoose}>
            <span className="text-label font-medium text-ink">Bukan pembayaran pelanggan</span>
            <span className="block text-small text-ink-3">Disimpan sebagai diabaikan dan tidak diusulkan lagi.</span>
          </Option>
        </fieldset>
      )}
    </li>
  );
}

function Option({ name, value, checked, onChoose, children }: { name: string; value: string; checked: boolean; onChoose: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-inner p-3 transition-colors duration-150 ${checked ? 'bg-primary-soft' : 'bg-surface hover:bg-primary-soft/50'}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChoose(value)} className="mt-0.5 size-5 shrink-0 cursor-pointer accent-primary" />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

function CandidateText({ candidate: c }: { candidate: BankMatchCandidate }) {
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-label font-semibold text-ink">{c.customer.name}</span>
        <Chip tone="neutral">{KIND[c.kind]}</Chip>
        <span className="tabular text-small text-ink-3">skor {c.score} dari 100</span>
      </span>
      {c.allocations.length > 0 && (
        <span className="tabular mt-1 block text-small text-ink">
          {c.kind === 'recorded_payment' ? 'Sudah melunasi' : 'Melunasi'} {c.allocations.map((a) => `${a.number} ${rupiah(a.amount)}`).join(', ')}
        </span>
      )}
      <ul className="mt-2 flex flex-col gap-1">
        {c.reasons.map((r) => (
          <li key={r} className="flex gap-2 text-small text-ink-2">
            <Icon icon={CircleCheck} size={16} className="mt-0.5 shrink-0 text-primary" />
            <span className="min-w-0">{r}</span>
          </li>
        ))}
        {c.notes.map((n) => (
          <li key={n} className="flex gap-2 text-small text-warning-fg">
            <Icon icon={TriangleAlert} size={16} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{n}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
