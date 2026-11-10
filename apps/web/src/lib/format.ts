const idr = new Intl.NumberFormat('id-ID');

export const rupiah = (n: number) => `Rp${idr.format(Math.round(n))}`;
export const number = (n: number) => idr.format(n);
export const percent = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);

/** Short rupiah for KPI tiles: Rp11,8 jt */
export function rupiahShort(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `Rp${(n / 1_000_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} M`;
  if (Math.abs(n) >= 1_000_000) return `Rp${(n / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
  if (Math.abs(n) >= 1_000) return `Rp${(n / 1_000).toLocaleString('id-ID', { maximumFractionDigits: 0 })} rb`;
  return rupiah(n);
}

const tz = 'Asia/Jakarta';
export const time = (iso: string) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: tz });
export const date = (iso: string) => new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
export const dayShort = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('id-ID', { weekday: 'short', timeZone: tz }).slice(0, 3);

export function relative(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86_400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86_400)} hari lalu`;
}

export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} j ${m} m` : `${m} m`;
}

export function initials(name: string): string {
  return name
    .replace(/^(warung|toko|minimarket|agen)\s+/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/** 1.25 → "1,3 dtk" (Indonesian decimal comma). */
export const seconds = (s: number) => `${s.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} dtk`;
