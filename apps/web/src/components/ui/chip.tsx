import type { LucideIcon } from 'lucide-react';
import type { OrderStatus } from '../../lib/types.ts';
import { Icon } from './icon.tsx';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const tones: Record<Tone, string> = {
  success: 'bg-primary-soft text-primary',
  warning: 'bg-warning-bg text-warning-fg',
  danger: 'bg-danger-bg text-danger-fg',
  info: 'bg-info-bg text-info-fg',
  neutral: 'bg-surface-muted text-ink-2',
};

export function Chip({ tone = 'neutral', icon, children, className = '' }: { tone?: Tone; icon?: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-small font-medium whitespace-nowrap ${tones[tone]} ${className}`}>
      {icon && <Icon icon={icon} size={16} weight="semibold" />}
      {children}
    </span>
  );
}

const STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draf', tone: 'neutral' },
  awaiting_customer: { label: 'Menunggu pelanggan', tone: 'warning' },
  awaiting_approval: { label: 'Perlu persetujuan', tone: 'warning' },
  confirmed: { label: 'Dikonfirmasi', tone: 'success' },
  rejected: { label: 'Ditolak', tone: 'danger' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
};

export function StatusChip({ status }: { status: OrderStatus }) {
  const s = STATUS[status];
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export const APPROVAL_LABEL = {
  order: 'Pesanan besar',
  credit_override: 'Kredit',
  reminder: 'Pengingat bayar',
  escalation: 'Dialihkan ke admin',
  reorder: 'Tawaran pesan ulang',
  delivery_query: 'Tanya gudang/sopir',
  invoice_adjustment: 'Koreksi tagihan',
  payment: 'Konfirmasi pembayaran',
} as const;
