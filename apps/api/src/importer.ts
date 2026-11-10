import { asc, eq, inArray } from '@salura/db/orm';
import { customers, productPrices, products, productSynonyms, productUnits, stock, type Db, type Q } from '@salura/db';

// Spreadsheet import (BRD BR-8): the distributor keeps its catalogue, prices, stock and customers in
// Excel or Google Sheets. Each dataset is one sheet; columns are matched by header name, so the
// order of columns does not matter. Every row is validated before anything is written.

export const DATASETS = ['produk', 'satuan', 'harga', 'stok', 'pelanggan'] as const;
export type Dataset = (typeof DATASETS)[number];

const MAX_ROWS = 2000;
const MAX_BYTES = 2 * 1024 * 1024;

interface Column {
  key: string;
  /** Header names accepted for this column (lowercase). The first is used in templates. */
  names: string[];
  required: boolean;
}

const COLUMNS: Record<Dataset, Column[]> = {
  produk: [
    { key: 'sku', names: ['sku', 'kode'], required: true },
    { key: 'name', names: ['nama', 'name', 'nama_produk'], required: true },
    { key: 'brand', names: ['merek', 'brand', 'merk'], required: true },
    { key: 'category', names: ['kategori', 'category'], required: true },
    { key: 'baseUnit', names: ['satuan_dasar', 'base_unit', 'satuan'], required: true },
    { key: 'aliases', names: ['alias', 'aliases', 'sebutan'], required: false },
    { key: 'active', names: ['aktif', 'active'], required: false },
  ],
  satuan: [
    { key: 'sku', names: ['sku', 'kode'], required: true },
    { key: 'unit', names: ['satuan', 'unit'], required: true },
    { key: 'factor', names: ['isi', 'factor', 'isi_satuan_dasar'], required: true },
  ],
  harga: [
    { key: 'sku', names: ['sku', 'kode'], required: true },
    { key: 'tier', names: ['tier', 'golongan'], required: true },
    { key: 'unit', names: ['satuan', 'unit'], required: true },
    { key: 'price', names: ['harga', 'price', 'harga_satuan'], required: true },
  ],
  stok: [
    { key: 'sku', names: ['sku', 'kode'], required: true },
    { key: 'onHand', names: ['stok', 'stock', 'on_hand', 'jumlah'], required: true },
  ],
  pelanggan: [
    { key: 'name', names: ['nama_toko', 'toko', 'name'], required: true },
    { key: 'ownerName', names: ['nama_pemilik', 'pemilik', 'owner_name'], required: true },
    { key: 'honorific', names: ['sapaan', 'honorific'], required: false },
    { key: 'waId', names: ['no_wa', 'whatsapp', 'wa', 'wa_id', 'telepon'], required: true },
    { key: 'tier', names: ['tier', 'golongan'], required: true },
    { key: 'creditLimit', names: ['limit_kredit', 'credit_limit', 'plafon'], required: true },
    { key: 'paymentTermDays', names: ['tempo_hari', 'tempo', 'payment_term_days'], required: true },
    { key: 'area', names: ['area', 'wilayah'], required: true },
    { key: 'address', names: ['alamat', 'address'], required: true },
    { key: 'reminderTone', names: ['nada_pengingat', 'reminder_tone', 'nada'], required: false },
  ],
};

const TIERS = new Set(['A', 'B', 'C']);
const TONES: Record<string, 'friendly' | 'neutral' | 'firm'> = { friendly: 'friendly', ramah: 'friendly', neutral: 'neutral', netral: 'neutral', firm: 'firm', tegas: 'firm' };

export class ImportError extends Error {}

export interface RowError {
  row: number;
  message: string;
}

export interface ImportPreview {
  dataset: Dataset;
  rows: number;
  inserts: number;
  updates: number;
  errors: RowError[];
  /** First rows as they will be written, for the confirmation screen. */
  sample: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 CSV with quoted fields. The delimiter (comma, semicolon from Indonesian Excel, tab) is detected from the header unless given. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const headerLine = src.slice(0, src.indexOf('\n') === -1 ? undefined : src.indexOf('\n'));
  const counts = [',', ';', '\t'].map((d) => [d, headerLine.split(d).length] as const).sort((a, b) => b[1] - a[1]);
  const delim = delimiter ?? counts[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Largest value a money or count column holds (Postgres integer). */
const MAX_INT = 2_147_483_647;

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // A text cell starting with = + - @ would run as a formula when the export is opened in Excel.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** "Rp1.250.000", "1,250,000", "1250000" → 1250000. Decimals are not allowed. */
function parseWhole(raw: string): number | null {
  const s = raw.replace(/rp\.?/i, '').replace(/[\s.,]/g, '');
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Google Sheets link → its CSV export URL. Only docs.google.com links are fetched. */
export function sheetsCsvUrl(link: string): string {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new ImportError('Tautan Google Sheets tidak valid.');
  }
  const id = /^\/spreadsheets\/d\/([\w-]{20,})/.exec(url.pathname)?.[1];
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || !id) throw new ImportError('Pakai tautan Google Sheets (https://docs.google.com/spreadsheets/d/…).');
  const gid = url.searchParams.get('gid') ?? /gid=(\d+)/.exec(url.hash)?.[1] ?? '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

/** Downloads a sheet shared as "anyone with the link can view". */
export async function fetchSheet(link: string): Promise<string> {
  const res = await fetch(sheetsCsvUrl(link), { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new ImportError('Sheet terlalu besar (maksimal 2 MB).');
  const finalHost = new URL(res.url).hostname;
  if (!/(^|\.)(google\.com|googleusercontent\.com)$/.test(finalHost)) throw new ImportError('Google Sheets mengalihkan ke alamat yang tidak dikenal.');
  if (!res.ok) throw new ImportError(`Google Sheets menolak (${res.status}). Pastikan sheet dibagikan: "Siapa saja yang memiliki link dapat melihat".`);
  if (!(res.headers.get('content-type') ?? '').includes('text/csv')) throw new ImportError('Sheet tidak bisa diunduh sebagai CSV. Pastikan sheet dibagikan untuk siapa saja yang memiliki link.');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new ImportError('Sheet terlalu besar (maksimal 2 MB).');
  return text;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Parsed = { row: number; values: Record<string, string> };

function readRows(dataset: Dataset, text: string): Parsed[] {
  if (text.length > MAX_BYTES) throw new ImportError('File terlalu besar (maksimal 2 MB).');
  const table = parseCsv(text);
  if (table.length < 2) throw new ImportError('File kosong: perlu baris judul kolom dan minimal satu baris data.');
  if (table.length - 1 > MAX_ROWS) throw new ImportError(`Maksimal ${MAX_ROWS} baris per impor.`);
  const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const columns = COLUMNS[dataset];
  const index = new Map<string, number>();
  for (const col of columns) {
    const i = header.findIndex((h) => col.names.includes(h));
    if (i >= 0) index.set(col.key, i);
    else if (col.required) throw new ImportError(`Kolom "${col.names[0]}" tidak ada. Kolom yang dibutuhkan: ${columns.filter((c) => c.required).map((c) => c.names[0]).join(', ')}.`);
  }
  return table.slice(1).map((cells, i) => ({
    row: i + 2,
    values: Object.fromEntries([...index].map(([key, at]) => [key, (cells[at] ?? '').trim()])),
  }));
}

interface Plan {
  preview: ImportPreview;
  apply: (tx: Q) => Promise<void>;
}

async function skuMap(db: Q, skus: string[]) {
  if (!skus.length) return new Map<string, typeof products.$inferSelect>();
  const rows = await db.select().from(products).where(inArray(products.sku, [...new Set(skus)]));
  return new Map(rows.map((p) => [p.sku, p]));
}

async function plan(db: Q, dataset: Dataset, text: string): Promise<Plan> {
  const rows = readRows(dataset, text);
  const errors: RowError[] = [];
  const err = (row: number, message: string) => errors.push({ row, message });
  const seen = new Set<string>();
  const dup = (row: number, key: string) => {
    if (seen.has(key)) {
      err(row, `Baris ganda untuk ${key}`);
      return true;
    }
    seen.add(key);
    return false;
  };

  if (dataset === 'produk') {
    const existing = await skuMap(db, rows.map((r) => r.values.sku!.toUpperCase()));
    const out: { sku: string; name: string; brand: string; category: string; baseUnit: string; active: boolean; aliases: string[] }[] = [];
    for (const { row, values: v } of rows) {
      const sku = v.sku!.toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(sku)) err(row, `SKU "${v.sku}" tidak valid (huruf, angka, tanda minus)`);
      else if (dup(row, sku)) continue;
      if (!v.name) err(row, 'Nama produk kosong');
      const baseUnit = v.baseUnit!.toLowerCase();
      if (!/^[a-z]{2,15}$/.test(baseUnit)) err(row, `Satuan dasar "${v.baseUnit}" tidak valid`);
      const prev = existing.get(sku);
      if (prev && prev.baseUnit !== baseUnit) err(row, `Satuan dasar ${sku} tidak bisa diubah dari ${prev.baseUnit} ke ${baseUnit} (stok dihitung dalam satuan dasar)`);
      const active = v.active ? !/^(0|tidak|no|false|n)$/i.test(v.active) : true;
      const aliases = (v.aliases ?? '').split(/[|;]/).map((a) => a.trim().toLowerCase()).filter(Boolean).slice(0, 20);
      out.push({ sku, name: v.name!, brand: v.brand!, category: v.category!.toLowerCase(), baseUnit, active, aliases });
    }
    const updates = out.filter((p) => existing.has(p.sku)).length;
    return {
      preview: { dataset, rows: rows.length, inserts: out.length - updates, updates, errors, sample: out.slice(0, 8) },
      apply: async (tx) => {
        for (const p of out) {
          const [row] = await tx
            .insert(products)
            .values({ sku: p.sku, name: p.name, brand: p.brand, category: p.category, baseUnit: p.baseUnit, active: p.active })
            .onConflictDoUpdate({ target: products.sku, set: { name: p.name, brand: p.brand, category: p.category, active: p.active } })
            .returning({ id: products.id });
          const id = row!.id;
          await tx.insert(productUnits).values({ productId: id, unit: p.baseUnit, factor: 1 }).onConflictDoNothing();
          await tx.insert(stock).values({ productId: id, onHand: 0, reserved: 0 }).onConflictDoNothing();
          // The names customers use: the product name plus the listed aliases.
          await tx.delete(productSynonyms).where(eq(productSynonyms.productId, id));
          await tx.insert(productSynonyms).values([...new Set([p.name.toLowerCase(), ...p.aliases])].map((alias) => ({ productId: id, alias })));
        }
      },
    };
  }

  if (dataset === 'satuan') {
    const bySku = await skuMap(db, rows.map((r) => r.values.sku!.toUpperCase()));
    const out: { productId: number; sku: string; unit: string; factor: number }[] = [];
    for (const { row, values: v } of rows) {
      const sku = v.sku!.toUpperCase();
      const product = bySku.get(sku);
      const unit = v.unit!.toLowerCase();
      const factor = parseWhole(v.factor!);
      if (!product) err(row, `SKU ${sku} belum ada; impor produknya dulu`);
      if (!/^[a-z]{2,15}$/.test(unit)) err(row, `Satuan "${v.unit}" tidak valid`);
      if (factor === null || factor < 1 || factor > 10_000) err(row, `Isi "${v.factor}" harus angka bulat 1 sampai 10000`);
      if (product && unit === product.baseUnit && factor !== 1) err(row, `Satuan dasar ${unit} selalu berisi 1`);
      if (!product || factor === null || dup(row, `${sku} ${unit}`)) continue;
      out.push({ productId: product.id, sku, unit, factor });
    }
    const existing = out.length ? await db.select().from(productUnits).where(inArray(productUnits.productId, out.map((o) => o.productId))) : [];
    const updates = out.filter((o) => existing.some((e) => e.productId === o.productId && e.unit === o.unit)).length;
    return {
      preview: { dataset, rows: rows.length, inserts: out.length - updates, updates, errors, sample: out.slice(0, 8) },
      apply: async (tx) => {
        for (const o of out) {
          await tx.insert(productUnits).values({ productId: o.productId, unit: o.unit, factor: o.factor }).onConflictDoUpdate({ target: [productUnits.productId, productUnits.unit], set: { factor: o.factor } });
        }
      },
    };
  }

  if (dataset === 'harga') {
    const bySku = await skuMap(db, rows.map((r) => r.values.sku!.toUpperCase()));
    const ids = [...bySku.values()].map((p) => p.id);
    const unitRows = ids.length ? await db.select().from(productUnits).where(inArray(productUnits.productId, ids)) : [];
    const out: { productId: number; sku: string; tier: string; unit: string; unitPrice: number }[] = [];
    for (const { row, values: v } of rows) {
      const sku = v.sku!.toUpperCase();
      const product = bySku.get(sku);
      const tier = v.tier!.toUpperCase();
      const unit = v.unit!.toLowerCase();
      const price = parseWhole(v.price!);
      if (!product) err(row, `SKU ${sku} belum ada; impor produknya dulu`);
      if (!TIERS.has(tier)) err(row, `Tier "${v.tier}" harus A, B atau C`);
      if (product && !unitRows.some((u) => u.productId === product.id && u.unit === unit)) err(row, `${sku} belum punya satuan "${unit}"; impor satuannya dulu`);
      if (price === null || price <= 0 || price > 100_000_000) err(row, `Harga "${v.price}" tidak valid`);
      if (!product || price === null || dup(row, `${sku} ${tier} ${unit}`)) continue;
      out.push({ productId: product.id, sku, tier, unit, unitPrice: price });
    }
    const existing = ids.length ? await db.select().from(productPrices).where(inArray(productPrices.productId, ids)) : [];
    const updates = out.filter((o) => existing.some((e) => e.productId === o.productId && e.tier === o.tier && e.unit === o.unit)).length;
    return {
      preview: { dataset, rows: rows.length, inserts: out.length - updates, updates, errors, sample: out.slice(0, 8) },
      apply: async (tx) => {
        for (const o of out) {
          await tx
            .insert(productPrices)
            .values({ productId: o.productId, tier: o.tier, unit: o.unit, unitPrice: o.unitPrice })
            .onConflictDoUpdate({ target: [productPrices.productId, productPrices.tier, productPrices.unit], set: { unitPrice: o.unitPrice } });
        }
      },
    };
  }

  if (dataset === 'stok') {
    const bySku = await skuMap(db, rows.map((r) => r.values.sku!.toUpperCase()));
    const ids = [...bySku.values()].map((p) => p.id);
    const current = ids.length ? await db.select().from(stock).where(inArray(stock.productId, ids)) : [];
    const out: { productId: number; sku: string; onHand: number; reserved: number }[] = [];
    for (const { row, values: v } of rows) {
      const sku = v.sku!.toUpperCase();
      const product = bySku.get(sku);
      const onHand = parseWhole(v.onHand!);
      if (!product) err(row, `SKU ${sku} belum ada; impor produknya dulu`);
      if (onHand === null || onHand < 0 || onHand > 10_000_000) err(row, `Stok "${v.onHand}" harus angka bulat ≥ 0 (dalam satuan dasar)`);
      if (!product || onHand === null || dup(row, sku)) continue;
      const reserved = current.find((s) => s.productId === product.id)?.reserved ?? 0;
      // Stock already promised to confirmed orders cannot disappear by an import.
      if (onHand >= 0 && onHand < reserved) err(row, `Stok ${sku} (${onHand}) lebih kecil dari yang sudah dipesan pelanggan (${reserved} ${product.baseUnit})`);
      out.push({ productId: product.id, sku, onHand, reserved });
    }
    return {
      preview: { dataset, rows: rows.length, inserts: 0, updates: out.length, errors, sample: out.slice(0, 8) },
      apply: async (tx) => {
        for (const o of out) {
          await tx.insert(stock).values({ productId: o.productId, onHand: o.onHand, reserved: 0 }).onConflictDoUpdate({ target: stock.productId, set: { onHand: o.onHand } });
        }
      },
    };
  }

  // pelanggan
  const waIds = rows.map((r) => r.values.waId!.replace(/\D/g, '').replace(/^0/, '62'));
  const existing = waIds.length ? await db.select({ waId: customers.waId }).from(customers).where(inArray(customers.waId, waIds)) : [];
  const out: (typeof customers.$inferInsert)[] = [];
  rows.forEach(({ row, values: v }, i) => {
    const waId = waIds[i]!;
    const tier = v.tier!.toUpperCase();
    const creditLimit = parseWhole(v.creditLimit!);
    const term = parseWhole(v.paymentTermDays!);
    const tone = TONES[(v.reminderTone || 'friendly').toLowerCase()];
    if (!/^\d{8,15}$/.test(waId)) err(row, `Nomor WhatsApp "${v.waId}" tidak valid`);
    else if (dup(row, waId)) return;
    if (!v.name || !v.ownerName) err(row, 'Nama toko dan nama pemilik wajib diisi');
    if (!TIERS.has(tier)) err(row, `Tier "${v.tier}" harus A, B atau C`);
    if (creditLimit === null || creditLimit < 0 || creditLimit > MAX_INT) err(row, `Limit kredit "${v.creditLimit}" tidak valid`);
    if (term === null || term < 0 || term > 120) err(row, `Tempo "${v.paymentTermDays}" harus 0 sampai 120 hari`);
    if (!tone) err(row, `Nada pengingat "${v.reminderTone}" harus ramah, netral atau tegas`);
    out.push({
      name: v.name!,
      ownerName: v.ownerName!,
      honorific: v.honorific || 'Bapak/Ibu',
      waId,
      tier,
      creditLimit: creditLimit ?? 0,
      paymentTermDays: term ?? 0,
      area: v.area!,
      address: v.address!,
      reminderTone: tone ?? 'friendly',
    });
  });
  const updates = out.filter((o) => existing.some((e) => e.waId === o.waId)).length;
  return {
    preview: { dataset, rows: rows.length, inserts: out.length - updates, updates, errors, sample: out.slice(0, 8) },
    apply: async (tx) => {
      for (const c of out) {
        const { waId: _key, ...fields } = c;
        await tx.insert(customers).values(c).onConflictDoUpdate({ target: customers.waId, set: fields });
      }
    },
  };
}

/** Validates without writing anything. */
export async function previewImport(db: Db, dataset: Dataset, text: string): Promise<ImportPreview> {
  return (await plan(db, dataset, text)).preview;
}

/** Validates and writes everything in one transaction; nothing is written when any row is invalid. */
export async function applyImport(db: Db, dataset: Dataset, text: string): Promise<ImportPreview> {
  return db.transaction(async (tx) => {
    const { preview, apply } = await plan(tx, dataset, text);
    if (preview.errors.length) return preview;
    await apply(tx);
    return preview;
  });
}

/** The current data as CSV: a template with the right headers that can be edited and imported back. */
export async function exportCsv(db: Db, dataset: Dataset): Promise<string> {
  const header = COLUMNS[dataset].map((c) => c.names[0]!);
  if (dataset === 'produk') {
    const rows = await db.select().from(products).orderBy(asc(products.id));
    const syn = await db.select().from(productSynonyms).orderBy(asc(productSynonyms.id));
    return toCsv(header, rows.map((p) => [p.sku, p.name, p.brand, p.category, p.baseUnit, syn.filter((s) => s.productId === p.id && s.alias !== p.name.toLowerCase()).map((s) => s.alias).join('|'), p.active ? 'ya' : 'tidak']));
  }
  if (dataset === 'satuan') {
    const rows = await db.select({ sku: products.sku, unit: productUnits.unit, factor: productUnits.factor }).from(productUnits).innerJoin(products, eq(products.id, productUnits.productId)).orderBy(asc(products.id), asc(productUnits.factor));
    return toCsv(header, rows.map((r) => [r.sku, r.unit, r.factor]));
  }
  if (dataset === 'harga') {
    const rows = await db
      .select({ sku: products.sku, tier: productPrices.tier, unit: productPrices.unit, price: productPrices.unitPrice })
      .from(productPrices)
      .innerJoin(products, eq(products.id, productPrices.productId))
      .orderBy(asc(products.id), asc(productPrices.tier), asc(productPrices.unit));
    return toCsv(header, rows.map((r) => [r.sku, r.tier, r.unit, r.price]));
  }
  if (dataset === 'stok') {
    const rows = await db.select({ sku: products.sku, onHand: stock.onHand }).from(stock).innerJoin(products, eq(products.id, stock.productId)).orderBy(asc(products.id));
    return toCsv(header, rows.map((r) => [r.sku, r.onHand]));
  }
  const rows = await db.select().from(customers).orderBy(asc(customers.id));
  const toneId = { friendly: 'ramah', neutral: 'netral', firm: 'tegas' } as Record<string, string>;
  return toCsv(header, rows.map((c) => [c.name, c.ownerName, c.honorific, c.waId, c.tier, c.creditLimit, c.paymentTermDays, c.area, c.address, toneId[c.reminderTone] ?? c.reminderTone]));
}
