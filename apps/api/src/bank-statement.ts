import type { StatementLine } from '@salura/agent';
import { ImportError, parseCsv, type RowError } from './importer.ts';

// Bank statement (mutasi rekening) CSV as internet banking exports it: KlikBCA (account details
// above the table, "Jumlah" with CR/DB next to it, dd/mm dates, a balance summary below), Livin'
// Mandiri and BRI (separate debit and credit columns), or any sheet with a date, a description and
// a credit or amount column. Only money coming in (credit) is kept: that is what customers paid.

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 2000;
/** Largest single transfer read from a statement (a typo guard, as for payments from the chat). */
const MAX_AMOUNT = 1_000_000_000;
/** The column header is looked for in this many rows from the top (BCA puts account details first). */
const HEADER_SCAN_ROWS = 30;
/** Unreadable rows listed in full; the rest are only counted. */
const MAX_ERRORS = 200;

/** Header names per column, lowercase, after normalizeHeader. */
const COLUMN_NAMES = {
  date: ['tanggal', 'tanggal transaksi', 'tgl', 'tgl transaksi', 'tgl tran', 'tanggal mutasi', 'tanggal posting', 'date', 'transaction date', 'trx date', 'posting date', 'post date'],
  description: ['keterangan', 'keterangan transaksi', 'deskripsi', 'uraian', 'uraian transaksi', 'desk tran', 'berita', 'description', 'transaction description', 'remark', 'remarks', 'detail transaksi'],
  credit: ['kredit', 'mutasi kredit', 'uang masuk', 'dana masuk', 'masuk', 'credit', 'credit amount', 'cr'],
  debit: ['debit', 'debet', 'mutasi debet', 'mutasi debit', 'uang keluar', 'dana keluar', 'keluar', 'debit amount', 'db'],
  amount: ['jumlah', 'jumlah transaksi', 'nominal', 'mutasi', 'nilai', 'amount', 'transaction amount'],
  direction: ['db/cr', 'cr/db', 'd/k', 'k/d', 'dk', 'kd', 'd/c', 'c/d', 'dc', 'cd', 'dr/cr', 'cr/dr', 'db/kr', 'kr/db', 'debit/kredit', 'kredit/debit', 'debit/credit', 'credit/debit', 'mutasi type', 'tipe mutasi', 'jenis mutasi', 'tipe', 'jenis', 'type'],
} as const;

/** A whole cell that only says which way the money went. */
const DIRECTION_CELL = /^(CR|KR|K|C|KREDIT|CREDIT|DB|DR|D|DEBIT|DEBET)$/i;

/** Rows below the table: opening and closing balance, totals. */
const SUMMARY_ROW = /^(saldo|mutasi|total|jumlah|sub ?total|opening|closing|ending|beginning|starting)\b/i;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, agt: 8, ags: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };

export interface ParsedStatement {
  /** Credit lines; `row` is the position among the statement's transaction rows (1 = first). */
  lines: StatementLine[];
  /** Rows that look like transactions but could not be read; they are left out. The first 200 are listed. */
  errors: RowError[];
  /** How many rows could not be read in all. */
  errorCount: number;
  /** Money going out, skipped. */
  debitRows: number;
  /** Not booked by the bank yet (BCA "PEND"), skipped until they appear with a date. */
  pendingRows: number;
  /** What the owner should check before saving, e.g. a date order that could not be told from the file. */
  warnings: string[];
}

const normalizeHeader = (h: string) =>
  clean(h)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[_.:'"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Letters stuck to digits ("624,100.00CR", "Rp624.100") get a space, so markers read as words. */
const spaced = (s: string) => s.replace(/(\d)([a-z])/gi, '$1 $2').replace(/([a-z])(\d)/gi, '$1 $2');

/** Excel text markers some banks add: a leading apostrophe ('20/10) or a ="…" formula wrapper. */
function clean(cell: string): string {
  const s = cell.trim();
  const formula = /^="(.*)"$/.exec(s);
  return (formula ? formula[1]! : s).replace(/^'/, '').trim();
}

/** The delimiter that splits the widest row near the top: the account details above the table have fewer columns. */
function detectDelimiter(text: string): string {
  const top = text.split(/\r?\n/, HEADER_SCAN_ROWS);
  const widest = (d: string) => Math.max(...top.map((l) => l.split(d).length));
  return [',', ';', '\t'].map((d) => [d, widest(d)] as const).sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * "1.250.000,00", "1,250,000.00", "Rp 624.100,-", "624,100.00 CR", "(10.000)" → signed whole rupiah
 * (sen are dropped, never rounded up). The last separator is the decimal one when both appear; a lone
 * separator followed by exactly three digits groups thousands (1.250 = 1250). Returns null when the
 * cell is not a number.
 */
export function parseAmount(raw: string): number | null {
  let s = spaced(clean(raw))
    .replace(/\b(CR|DB|DR|KR|K|D|C|KREDIT|DEBIT|DEBET|CREDIT)\b/gi, '')
    .replace(/RP\.?|IDR/gi, '')
    .replace(/\s/g, '')
    // ",-" closes a whole rupiah amount ("Rp 624.100,-"); it is not a minus sign.
    .replace(/[.,]-+$/, '');
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/^[-+]/.test(s) || /[-+]$/.test(s)) {
    if (s.startsWith('-') || s.endsWith('-')) sign = -1;
    s = s.replace(/^[-+]|[-+]$/g, '');
  }
  if (!/^\d[\d.,]*$/.test(s)) return null;
  let whole = s;
  let fraction = '';
  const dec = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (s.includes('.') && s.includes(',')) {
    whole = s.slice(0, dec);
    fraction = s.slice(dec + 1);
  } else if (dec >= 0) {
    const parts = s.split(s[dec]!);
    if (parts.length === 2 && parts[1]!.length !== 3) {
      whole = parts[0]!;
      fraction = parts[1]!;
    }
  }
  // Thousands groups are one separator, three digits each: 1.250.000 yes, 1.2.3 no.
  if (/[.,]/.test(whole) && !/^\d{1,3}([.,])\d{3}(\1\d{3})*$/.test(whole)) return null;
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) return null;
  const value = Number(whole) + (fraction ? Number(fraction.padEnd(2, '0')) / 100 : 0);
  return Number.isFinite(value) ? sign * Math.floor(value) : null;
}

/** "CR", "K", "Kredit" → credit; "DB", "D", "Debet" → debit; anything else → null. */
function direction(raw: string | undefined): 'credit' | 'debit' | null {
  const s = spaced(clean(raw ?? '')).toUpperCase();
  if (/\b(CR|KR|K|C|KREDIT|CREDIT)\b/.test(s)) return 'credit';
  if (/\b(DB|DR|D|DEBIT|DEBET)\b/.test(s)) return 'debit';
  return null;
}

const NUMERIC_DATE = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}|\d{2}))?(?!\d)/;

/**
 * Day or month first, decided once for the whole file: a first part above 12 means dd/mm, a second
 * part above 12 means mm/dd, and both in one file is refused. Indonesian exports are dd/mm, so that is
 * the default; when no date settles it and the month does not look like the part that stays the same,
 * the owner is asked to check the dates.
 */
function dateOrder(dateCells: string[]): { monthFirst: boolean; warning: string | null } {
  let dayFirst = false;
  let monthFirst = false;
  let ambiguous = false;
  const firsts = new Set<number>();
  const seconds = new Set<number>();
  for (const cell of dateCells) {
    const x = NUMERIC_DATE.exec(clean(cell));
    if (!x) continue;
    const [a, b] = [Number(x[1]), Number(x[2])];
    if (a > 12) dayFirst = true;
    if (b > 12) monthFirst = true;
    if (a <= 12 && b <= 12 && a !== b) ambiguous = true;
    firsts.add(a);
    seconds.add(b);
  }
  if (dayFirst && monthFirst) throw new ImportError('Urutan tanggal di file ini campur: ada yang hari/bulan dan ada yang bulan/hari. Periksa kolom tanggalnya.');
  if (monthFirst) return { monthFirst, warning: null };
  if (!dayFirst && ambiguous && seconds.size >= firsts.size) {
    return { monthFirst, warning: 'Tanggal dibaca sebagai hari/bulan, tapi urutannya tidak bisa dipastikan dari file ini. Periksa tanggal setiap baris sebelum menyimpan.' };
  }
  return { monthFirst, warning: null };
}

/**
 * In an amount file without a recognised direction header, the column whose every value is a marker
 * (CR/DB, K/D, C/D): KlikBCA puts CR/DB in an unnamed column after "Jumlah", other exports name it
 * in ways not listed above.
 */
function directionColumn(rows: string[][], col: Columns): number | undefined {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const others = Array.from({ length: width }, (_, i) => i).filter((i) => i !== col.date && i !== col.amount && !col.description.includes(i));
  const order = [...others.filter((i) => i === col.amount! + 1), ...others.filter((i) => i !== col.amount! + 1)];
  return order.find((i) => {
    const values = rows.map((r) => r[i] ?? '').filter(Boolean);
    return values.length > 0 && values.every((v) => DIRECTION_CELL.test(v));
  });
}

/** dd/mm/yyyy, dd-mm-yy, dd/mm (year from the statement period), yyyy-mm-dd, "25 Okt 2026" → YYYY-MM-DD; mm/dd with `monthFirst`. */
export function parseStatementDate(raw: string, base: { year: number; month: number }, monthFirst = false): string | null {
  const s = clean(raw);
  let y: number | null = null;
  let m: number;
  let d: number;
  let x: RegExpExecArray | null;
  if ((x = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(s))) [y, m, d] = [Number(x[1]), Number(x[2]), Number(x[3])];
  else if ((x = NUMERIC_DATE.exec(s))) {
    [d, m] = monthFirst ? [Number(x[2]), Number(x[1])] : [Number(x[1]), Number(x[2])];
    if (x[3]) y = x[3].length === 2 ? 2000 + Number(x[3]) : Number(x[3]);
  } else if ((x = /^(\d{1,2})[\s-]+([a-z]{3})[a-z]*\.?(?:[\s-]+(\d{4}|\d{2}))?(?![a-z\d])/i.exec(s))) {
    const month = MONTHS[x[2]!.toLowerCase()];
    if (!month) return null;
    [d, m] = [Number(x[1]), month];
    if (x[3]) y = x[3].length === 2 ? 2000 + Number(x[3]) : Number(x[3]);
  } else return null;
  // No year (KlikBCA writes dd/mm): the statement period's year, or the year before for later months.
  if (y === null) y = m > base.month ? base.year - 1 : base.year;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.getUTCDate() !== d || t.getUTCMonth() + 1 !== m ? null : iso;
}

interface Columns {
  date: number;
  description: number[];
  credit?: number;
  debit?: number;
  amount?: number;
  direction?: number;
}

function findColumns(header: string[]): Columns | null {
  const names = header.map(normalizeHeader);
  const at = (key: keyof typeof COLUMN_NAMES) => {
    const i = names.findIndex((n) => (COLUMN_NAMES[key] as readonly string[]).includes(n));
    return i >= 0 ? i : undefined;
  };
  const date = at('date');
  const description = names.flatMap((n, i) => ((COLUMN_NAMES.description as readonly string[]).includes(n) ? [i] : []));
  const credit = at('credit');
  const amount = at('amount');
  if (date === undefined || !description.length || (credit === undefined && amount === undefined)) return null;
  return { date, description, credit, debit: at('debit'), amount, direction: at('direction') };
}

/** Reads a statement export. Throws ImportError when the file is not one; unreadable rows are listed, not fatal. */
export function parseBankStatement(text: string, now: Date): ParsedStatement {
  if (text.length > MAX_BYTES) throw new ImportError('File terlalu besar (maksimal 2 MB).');
  const table = parseCsv(text.replace(/^﻿/, ''), detectDelimiter(text.replace(/^﻿/, '')));
  const headerAt = table.slice(0, HEADER_SCAN_ROWS).findIndex((row) => findColumns(row) !== null);
  if (headerAt < 0) {
    throw new ImportError('Kolom mutasi tidak dikenali. Dibutuhkan kolom tanggal, keterangan, dan kredit (atau jumlah dengan tanda CR/DB). Unduh mutasi dari internet banking sebagai CSV.');
  }
  const col = findColumns(table[headerAt]!)!;
  // Transaction rows: blank rows and the balance summary below the table are left out.
  const rows = table
    .slice(headerAt + 1)
    .map((cells, i) => ({ cells: cells.map(clean), row: i + 1 }))
    .filter(({ cells }) => {
      const firstCell = cells.find((c) => c !== '') ?? '';
      return firstCell !== '' && !SUMMARY_ROW.test(firstCell);
    });
  const amountOnly = col.credit === undefined;
  if (amountOnly && col.direction === undefined) col.direction = directionColumn(rows.map((r) => r.cells), col);
  const order = dateOrder(rows.map((r) => r.cells[col.date] ?? ''));

  // The period printed above the table ("Periode : 20/10/2026 - 27/10/2026") gives dd/mm dates their year.
  const today = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10); // WIB
  const periodEnd = [...table.slice(0, headerAt).flat().join(' ').matchAll(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/g)].at(-1);
  const base = periodEnd
    ? { year: Number(periodEnd[3]), month: Number(order.monthFirst ? periodEnd[1] : periodEnd[2]) }
    : { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };

  const lines: StatementLine[] = [];
  const errors: RowError[] = [];
  let errorCount = 0;
  const fail = (row: number, message: string) => {
    if (++errorCount <= MAX_ERRORS) errors.push({ row, message });
  };
  let debitRows = 0;
  let pendingRows = 0;
  /** Whether any row says which way its money went; without that, debits cannot be told from credits. */
  let directed = false;
  for (const { cells, row } of rows) {
    const dateCell = cells[col.date] ?? '';
    if (/^pend/i.test(dateCell)) {
      pendingRows++;
      continue;
    }

    let amount: number | null;
    if (!amountOnly) {
      const raw = cells[col.credit!] ?? '';
      // Mandiri and BRI write "-" in the credit cell of a debit row.
      amount = raw && !/^-+$/.test(raw) ? parseAmount(raw) : 0;
      if (amount === null || amount < 0) {
        fail(row, amount === null ? `Nominal kredit "${raw}" tidak terbaca` : `Nominal kredit "${raw}" negatif`);
        continue;
      }
      if (amount === 0) {
        debitRows++;
        continue;
      }
    } else {
      const raw = cells[col.amount!] ?? '';
      const value = parseAmount(raw);
      if (value === null) {
        fail(row, `Nominal "${raw}" tidak terbaca`);
        continue;
      }
      const marker = direction(raw) ?? (col.direction !== undefined ? direction(cells[col.direction]) : null);
      if (marker !== null || value < 0) directed = true;
      if ((marker ?? (value > 0 ? 'credit' : 'debit')) === 'debit' || value === 0) {
        debitRows++;
        continue;
      }
      amount = Math.abs(value);
    }

    const postedOn = parseStatementDate(dateCell, base, order.monthFirst);
    if (!postedOn) {
      fail(row, `Tanggal "${dateCell}" tidak terbaca`);
      continue;
    }
    if (postedOn > today) {
      fail(row, `Tanggal ${postedOn} belum terjadi`);
      continue;
    }
    if (amount > MAX_AMOUNT) {
      fail(row, `Nominal ${amount} terlalu besar untuk satu transfer`);
      continue;
    }
    const description = col.description
      .map((c) => cells[c] ?? '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 300);
    lines.push({ row, postedOn, description: description || '(tanpa keterangan)', amount });
    if (lines.length > MAX_LINES) throw new ImportError(`Maksimal ${MAX_LINES} transaksi masuk per unggahan. Unduh mutasi untuk periode yang lebih pendek.`);
  }
  // A single amount column with no CR/DB anywhere and no negative value: reading every row as money in
  // would record supplier payments and fees as customer payments.
  if (amountOnly && !directed && lines.length) {
    throw new ImportError('Tidak ada tanda CR/DB atau nilai negatif di kolom jumlah, jadi uang masuk dan keluar tidak bisa dibedakan. Unduh mutasi yang punya kolom kredit atau tanda CR/DB.');
  }
  return { lines, errors, errorCount, debitRows, pendingRows, warnings: order.warning ? [order.warning] : [] };
}
