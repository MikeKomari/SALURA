const idr = new Intl.NumberFormat('id-ID');

/** 1234500 → "Rp1.234.500" */
export function rupiah(amount: number): string {
  return `Rp${idr.format(Math.round(amount))}`;
}

const DAY_MS = 86_400_000;

export function daysBetween(fromIso: string, to: Date): number {
  return Math.floor((to.getTime() - new Date(fromIso).getTime()) / DAY_MS);
}

/** "2026-10-21T…" → "21 Okt 2026" */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' });
}
