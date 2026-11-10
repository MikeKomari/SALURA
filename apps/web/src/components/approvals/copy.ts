import { Banknote, BellRing, CalendarClock, FileMinus, Headset, Package, Truck, Wallet, type LucideIcon } from 'lucide-react';
import { ApiError } from '../../lib/api.ts';
import { rupiah } from '../../lib/format.ts';
import type { Approval, ApprovalType } from '../../lib/types.ts';
import { APPROVAL_LABEL, type Tone } from '../ui/chip.tsx';


export const TYPE_META: Record<ApprovalType, { label: string; icon: LucideIcon; tone: Tone }> = {
  order: { label: APPROVAL_LABEL.order, icon: Package, tone: 'warning' },
  credit_override: { label: APPROVAL_LABEL.credit_override, icon: Wallet, tone: 'danger' },
  reminder: { label: APPROVAL_LABEL.reminder, icon: BellRing, tone: 'info' },
  escalation: { label: APPROVAL_LABEL.escalation, icon: Headset, tone: 'info' },
  reorder: { label: APPROVAL_LABEL.reorder, icon: CalendarClock, tone: 'success' },
  delivery_query: { label: APPROVAL_LABEL.delivery_query, icon: Truck, tone: 'warning' },
  invoice_adjustment: { label: APPROVAL_LABEL.invoice_adjustment, icon: FileMinus, tone: 'danger' },
  payment: { label: APPROVAL_LABEL.payment, icon: Banknote, tone: 'success' },
};

export const TONE_LABEL: Record<string, string> = { friendly: 'Ramah', neutral: 'Netral', firm: 'Tegas' };

/** Hold reasons are written in Bahasa by the backend; only a run failure carries a technical detail to separate. */
export function reasonText(a: Approval): { text: string; detail?: string } {
  const r = a.reason.trim();
  const failed = r.match(/^Run agen gagal\. ([\s\S]*)$/);
  if (failed) return { text: 'Agen tidak bisa menyelesaikan percakapan ini karena gangguan sistem, jadi pelanggan diserahkan ke Anda.', detail: failed[1] };
  return { text: r };
}

export function customerName(a: Approval): string {
  return a.customer?.name ?? 'Nomor tidak dikenal';
}

export function approvalWaId(a: Approval): string | null {
  const fromPayload = a.payload?.waId;
  return a.customer?.waId ?? (typeof fromPayload === 'string' ? fromPayload : null);
}

export interface ReminderFacts {
  invoiceId: number | null;
  number: string | null;
  amount: string | null;
  daysOverdue: number | null;
  tone: string | null;
  text: string;
}

export function reminderFacts(a: Approval): ReminderFacts {
  const p = a.payload ?? {};
  return {
    invoiceId: typeof p.invoiceId === 'number' ? p.invoiceId : null,
    number: typeof p.number === 'string' ? p.number : null,
    amount: typeof p.outstanding === 'number' ? rupiah(p.outstanding) : null,
    daysOverdue: typeof p.daysOverdue === 'number' ? p.daysOverdue : null,
    tone: typeof p.tone === 'string' ? p.tone : null,
    text: typeof p.text === 'string' ? p.text : '',
  };
}

/** The money figure shown on a list row: the order total, or the overdue amount for a reminder. */
export function approvalAmount(a: Approval): string | null {
  if (a.type === 'invoice_adjustment') return typeof a.payload?.credit === 'number' ? `−${rupiah(a.payload.credit)}` : null;
  if (a.type === 'delivery_query') return null;
  if (a.type === 'payment') return typeof a.payload?.amount === 'number' ? rupiah(a.payload.amount) : null;
  if (a.type === 'reminder') return reminderFacts(a).amount;
  if (a.order) return rupiah(a.order.subtotal);
  const preview = a.payload?.preview as { subtotal?: number } | undefined;
  if (a.type === 'reorder' && typeof preview?.subtotal === 'number') return rupiah(preview.subtotal);
  return null;
}

export function successText(a: Approval, decision: 'approve' | 'reject', edited: boolean): string {
  const name = customerName(a);
  switch (a.type) {
    case 'order':
    case 'credit_override': {
      const ref = a.orderId ? `Pesanan #${a.orderId}` : 'Pesanan';
      if (decision === 'reject') return `${ref} ditolak, pelanggan sudah diberi kabar.`;
      return `${ref} disetujui${edited ? ' dengan perubahan' : ''}, pelanggan sudah diberi kabar.`;
    }
    case 'reminder':
      return decision === 'approve' ? `Pengingat untuk ${name} sudah dikirim.` : `Pengingat untuk ${name} tidak dikirim.`;
    case 'escalation':
      return decision === 'approve' ? `Percakapan dengan ${name} ditandai selesai.` : `Permintaan dari ${name} diabaikan.`;
    case 'reorder':
      return decision === 'approve' ? `Tawaran pesan ulang untuk ${name} sudah dikirim.` : `Tawaran untuk ${name} dibatalkan.`;
    case 'delivery_query': {
      const who = String(a.payload?.staffName ?? 'staf');
      return decision === 'approve' ? `Pertanyaan sudah dikirim ke ${who}.` : `Pertanyaan ke ${who} tidak dikirim.`;
    }
    case 'invoice_adjustment':
      return decision === 'approve' ? `Tagihan ${String(a.payload?.invoiceNumber ?? '')} sudah dikoreksi; ${name} sudah diberi kabar.` : 'Koreksi tagihan dibatalkan.';
    case 'payment':
      return decision === 'approve' ? `Pembayaran ${name} dicatat lunas sesuai usulan; pelanggan sudah diberi kabar.` : `Pembayaran ${name} ditolak; pelanggan sudah diberi kabar.`;
  }
}

/** Server errors arrive in English with a code; the owner gets a plain sentence with a next step. */
export function errorText(err: unknown): string {
  if (!(err instanceof ApiError)) return (err as Error)?.message || 'Terjadi kesalahan. Coba lagi.';
  switch (err.code) {
    case 'network':
      return err.message;
    case 'unauthorized':
      return 'Sesi Anda sudah berakhir. Silakan masuk lagi, lalu ulangi.';
    case 'forbidden':
      return err.message;
    // Bank statement and import errors are already written for the owner.
    case 'match_stale':
    case 'match_conflict':
    case 'line_not_found':
    case 'import_invalid':
      return err.message;
    case 'approval_not_pending':
      return 'Permintaan ini sudah diputuskan sebelumnya. Daftar sudah diperbarui.';
    case 'out_of_stock': {
      const m = err.message.match(/^(.+) no longer has enough stock \((.+) left\)$/);
      return m
        ? `Stok ${m[1]} tidak cukup lagi (sisa ${m[2]}). Kurangi jumlahnya lewat "Ubah lalu setujui".`
        : 'Stok tidak cukup untuk pesanan ini. Kurangi jumlahnya lewat "Ubah lalu setujui".';
    }
    case 'invalid_lines':
    case 'empty_order':
      return 'Ada baris pesanan yang tidak valid. Periksa jumlah dan satuannya, lalu coba lagi.';
    case 'invalid_request':
      return 'Data yang dikirim belum lengkap. Periksa isian lalu coba lagi.';
    case 'rate_limited':
      return err.message;
    default:
      if (err.status === 404) return 'Fitur ini belum tersedia di server. Coba lagi nanti.';
      if (err.status >= 500) return 'Server sedang bermasalah. Coba lagi sebentar lagi.';
      return `Tindakan gagal: ${err.message}`;
  }
}
