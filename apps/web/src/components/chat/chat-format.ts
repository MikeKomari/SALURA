import { date, time } from '../../lib/format.ts';

const tz = 'Asia/Jakarta';
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });

export function sameDay(a: string, b: string): boolean {
  return dayKey(a) === dayKey(b);
}

/** List timestamps: "10.15" today, "16 Okt" before that. */
export function shortWhen(iso: string, now = new Date().toISOString()): string {
  if (sameDay(iso, now)) return time(iso);
  return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: tz });
}

/** Day separator in the thread. */
export function dayLabel(iso: string, now = new Date()): string {
  if (sameDay(iso, now.toISOString())) return 'Hari ini';
  if (sameDay(iso, new Date(now.getTime() - 86_400_000).toISOString())) return 'Kemarin';
  return date(iso);
}

/** 6289912345678 → +62 899-1234-5678 */
export function formatWa(waId: string): string {
  if (!/^62\d{8,13}$/.test(waId)) return waId;
  const rest = waId.slice(2);
  return `+62 ${rest.slice(0, 3)}-${rest.slice(3, 7)}-${rest.slice(7)}`;
}

export function randomUnregisteredWa(): string {
  return `62899${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}
