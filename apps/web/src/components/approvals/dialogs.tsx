import { Ban, Check, Minus, Plus, Trash, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useState } from 'react';
import { rupiah } from '../../lib/format.ts';
import { ease } from '../../lib/motion.ts';
import type { Approval, OrderLine } from '../../lib/types.ts';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Icon } from '../ui/icon.tsx';
import type { EditedLine } from './use-decision.ts';

const MAX_QTY = 1000;

interface Draft extends OrderLine {
  qtyText: string;
}

/** "Ubah lalu setujui": adjust quantities or drop lines; the server reprices and confirms. */
export function EditOrderDialog({
  open,
  approval,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  approval: Approval;
  busy: boolean;
  onClose: () => void;
  onSubmit: (lines: EditedLine[]) => void;
}) {
  const original = approval.order?.lines ?? [];
  const [lines, setLines] = useState<Draft[]>([]);
  useEffect(() => {
    if (open) setLines(original.map((l) => ({ ...l, qtyText: String(l.qty) })));
    // Reset only when the dialog opens, not when a live refresh replaces the order object.
  }, [open]);

  const qtyOf = (l: Draft) => Number.parseInt(l.qtyText, 10);
  const valid = (l: Draft) => Number.isInteger(qtyOf(l)) && qtyOf(l) >= 1 && qtyOf(l) <= MAX_QTY;
  const allValid = lines.length > 0 && lines.every(valid);
  const changed = lines.length !== original.length || lines.some((l, i) => qtyOf(l) !== original[i]?.qty || l.productId !== original[i]?.productId);
  const total = lines.reduce((s, l) => s + (valid(l) ? qtyOf(l) * l.unitPrice : 0), 0);

  const setQty = (i: number, qtyText: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, qtyText } : l)));
  const step = (i: number, d: number) =>
    setLines((ls) =>
      ls.map((l, j) => {
        if (j !== i) return l;
        const q = Number.isInteger(qtyOf(l)) ? qtyOf(l) : 1;
        return { ...l, qtyText: String(Math.max(1, Math.min(MAX_QTY, q + d))) };
      }),
    );
  const remove = (i: number) => setLines((ls) => ls.filter((_, j) => j !== i));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Ubah pesanan #${approval.orderId ?? ''}`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button
            icon={Check}
            loading={busy}
            disabled={!allValid || !changed}
            onClick={() => onSubmit(lines.map((l) => ({ productId: l.productId, qty: qtyOf(l), unit: l.unit })))}
          >
            Setujui dengan perubahan
          </Button>
        </>
      }
    >
      <p className="mb-4">Ubah jumlah atau hapus barang. Harga dihitung ulang oleh sistem, lalu pelanggan diberi kabar bahwa ada penyesuaian.</p>
      <ul className="scrollbar-thin -mx-1 flex max-h-[50dvh] flex-col gap-2 overflow-y-auto px-1 py-1">
        <AnimatePresence initial={false}>
          {lines.map((l, i) => (
            <motion.li
              key={`${l.productId}-${l.unit}`}
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, height: 0, transition: { duration: 0.22, ease } }}
              className="overflow-hidden"
            >
              <LineEditor
                line={l}
                invalid={!valid(l)}
                canRemove={lines.length > 1}
                onText={(t) => setQty(i, t)}
                onStep={(d) => step(i, d)}
                onRemove={() => remove(i)}
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {lines.length === 1 && <p className="mt-2 text-small text-ink-3">Pesanan harus berisi minimal satu barang. Untuk membatalkan semuanya, pakai "Tolak".</p>}
      <div className="mt-4 flex items-baseline justify-between gap-3 border-t border-border pt-4">
        <span className="text-label font-medium text-ink">Perkiraan total baru</span>
        <span className="tabular text-h2 font-semibold text-ink">{rupiah(total)}</span>
      </div>
      {approval.order && total !== approval.order.subtotal && (
        <p className="tabular mt-1 text-right text-small text-ink-3">Sebelumnya {rupiah(approval.order.subtotal)}</p>
      )}
    </Dialog>
  );
}

function LineEditor({
  line,
  invalid,
  canRemove,
  onText,
  onStep,
  onRemove,
}: {
  line: Draft;
  invalid: boolean;
  canRemove: boolean;
  onText: (t: string) => void;
  onStep: (d: number) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const q = Number.parseInt(line.qtyText, 10);
  const stepBtn = 'grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-ink hover:bg-surface disabled:cursor-not-allowed disabled:text-ink-3';
  return (
    <div className="rounded-inner bg-surface-muted p-3">
      <label htmlFor={id} className="block text-label font-semibold text-ink">
        {line.name}
        <span className="block text-small font-normal text-ink-3">
          per {line.unit} · {rupiah(line.unitPrice)}
        </span>
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <button type="button" className={stepBtn} aria-label={`Kurangi ${line.name}`} onClick={() => onStep(-1)} disabled={Number.isInteger(q) && q <= 1}>
            <Icon icon={Minus} size={20} weight="semibold" />
          </button>
          <input
            id={id}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_QTY}
            step={1}
            value={line.qtyText}
            onChange={(e) => onText(e.target.value)}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${id}-err` : undefined}
            className={`tabular h-11 w-20 rounded-input bg-surface px-2 text-center text-h3 font-semibold text-ink [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none ${
              invalid ? 'border border-danger-fg' : 'border border-border'
            }`}
          />
          <button type="button" className={stepBtn} aria-label={`Tambah ${line.name}`} onClick={() => onStep(1)} disabled={Number.isInteger(q) && q >= MAX_QTY}>
            <Icon icon={Plus} size={20} weight="semibold" />
          </button>
          <span className="ml-1 text-label text-ink-2">{line.unit}</span>
        </div>
        <span className="tabular ml-auto text-label font-semibold text-ink">{invalid ? '–' : rupiah(q * line.unitPrice)}</span>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Hapus ${line.name}`}
          title={canRemove ? `Hapus ${line.name}` : 'Minimal satu barang'}
          className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-danger-fg hover:bg-danger-bg disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:bg-transparent"
        >
          <Icon icon={Trash} size={20} />
        </button>
      </div>
      {invalid && (
        <p id={`${id}-err`} className="mt-2 flex items-center gap-1.5 text-small text-danger-fg">
          <Icon icon={TriangleAlert} size={16} weight="semibold" />
          Isi jumlah 1 sampai {MAX_QTY}.
        </p>
      )}
    </div>
  );
}

const REJECT_COPY: Record<Approval['type'], { title: string; confirm: string; hint: (a: Approval) => string; quick: string[] }> = {
  order: {
    title: 'Tolak pesanan',
    confirm: 'Tolak pesanan',
    hint: (a) => `Pelanggan akan menerima: "Mohon maaf, pesanan #${a.orderId} belum bisa kami proses: [alasan Anda]."`,
    quick: ['Stok gudang belum siap untuk jumlah ini', 'Jumlahnya perlu dikonfirmasi ulang lewat telepon', 'Pengiriman ke area ini sedang penuh'],
  },
  credit_override: {
    title: 'Tolak pesanan',
    confirm: 'Tolak pesanan',
    hint: (a) => `Pelanggan akan menerima: "Mohon maaf, pesanan #${a.orderId} belum bisa kami proses: [alasan Anda]."`,
    quick: ['Mohon lunasi tagihan yang terlambat dulu', 'Limit kredit belum bisa dinaikkan', 'Bisa diproses dengan pembayaran tunai'],
  },
  reminder: {
    title: 'Jangan kirim pengingat',
    confirm: 'Jangan kirim',
    hint: () => 'Pengingat tidak dikirim. Alasan hanya dicatat di riwayat, tidak dikirim ke pelanggan.',
    quick: ['Pelanggan sudah janji bayar lewat telepon', 'Sudah transfer, menunggu dicek', 'Pelanggan lama, saya hubungi sendiri'],
  },
  escalation: {
    title: 'Abaikan permintaan',
    confirm: 'Abaikan',
    hint: () => 'Tidak ada pesan yang dikirim ke pelanggan. Alasan hanya dicatat di riwayat.',
    quick: ['Bukan pelanggan kita', 'Pesan salah kirim', 'Sudah ditangani lewat telepon'],
  },
  reorder: {
    title: 'Jangan kirim tawaran',
    confirm: 'Jangan kirim',
    hint: () => 'Tawaran tidak dikirim dan draf pesanannya dibatalkan. Alasan hanya dicatat di riwayat.',
    quick: ['Toko sedang tutup', 'Saya hubungi sendiri lewat telepon', 'Stok pelanggan masih banyak'],
  },
  delivery_query: {
    title: 'Jangan kirim pertanyaan',
    confirm: 'Jangan kirim',
    hint: () => 'Pertanyaan tidak dikirim ke gudang atau sopir. Alasan hanya dicatat di riwayat.',
    quick: ['Sudah saya tanyakan langsung', 'Selisih sudah jelas', 'Dokumen salah dibaca'],
  },
  invoice_adjustment: {
    title: 'Tolak koreksi tagihan',
    confirm: 'Tolak koreksi',
    hint: () => 'Tagihan tetap seperti semula. Alasan hanya dicatat di riwayat.',
    quick: ['Barang kurang sudah dikirim susulan', 'Dokumen salah dibaca', 'Selisih masih dicek'],
  },
  payment: {
    title: 'Tolak pembayaran',
    confirm: 'Tolak pembayaran',
    hint: () => 'Pelanggan akan menerima: "Mohon maaf, transfer ini belum bisa kami cocokkan dengan rekening kami: [alasan Anda]." Tagihan tetap terbuka.',
    quick: ['Dana belum masuk ke rekening', 'Nominal di rekening berbeda', 'Rekening tujuan bukan milik kami'],
  },
};

/** Every rejection needs a reason (at least 3 characters); quick picks save typing. */
export function RejectDialog({ open, approval, busy, onClose, onSubmit }: { open: boolean; approval: Approval; busy: boolean; onClose: () => void; onSubmit: (note: string) => void }) {
  const copy = REJECT_COPY[approval.type];
  const id = useId();
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setNote('');
      setTouched(false);
    }
  }, [open]);
  const tooShort = note.trim().length < 3;
  const showError = touched && tooShort;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!tooShort) onSubmit(note.trim());
  };

  return (
    <Dialog open={open} onClose={onClose} title={copy.title}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor={id} className="text-label font-medium text-ink">
          Alasan
        </label>
        <textarea
          id={id}
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={showError}
          aria-describedby={`${id}-help`}
          placeholder="Tulis alasan singkat"
          className={`min-h-24 resize-y rounded-input bg-surface-muted px-4 py-3 text-body text-ink placeholder:text-ink-3 ${showError ? 'border border-danger-fg' : 'border border-transparent'}`}
        />
        <p id={`${id}-help`} className={`flex items-start gap-1.5 text-small ${showError ? 'text-danger-fg' : 'text-ink-3'}`}>
          {showError && <Icon icon={TriangleAlert} size={16} weight="semibold" className="mt-0.5 shrink-0" />}
          {showError ? 'Tulis alasan minimal 3 huruf.' : copy.hint(approval)}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Alasan cepat">
          {copy.quick.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => {
                setNote(q);
                setTouched(false);
              }}
              aria-pressed={note === q}
              className={`min-h-10 cursor-pointer rounded-pill border px-3 py-1.5 text-left text-small font-medium transition-colors duration-150 ${
                note === q ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-ink hover:bg-surface-muted'
              }`}
            >
              {q}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button type="submit" variant="danger" icon={Ban} loading={busy}>
            {copy.confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
