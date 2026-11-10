import { eq } from '@salura/db/orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { customers, first, productPrices, products, productSynonyms, productUnits, stock, type Db } from '@salura/db';
import { closeSeededDb, seededDb } from '../../../packages/db/test/template.ts';
import { applyImport, DATASETS, exportCsv, ImportError, parseCsv, previewImport, sheetsCsvUrl } from '../src/importer.ts';

const T0 = new Date('2026-10-21T03:00:00Z');

async function freshDb() {
  const db = await seededDb(T0.getTime());
  onTestFinished(() => closeSeededDb(db));
  return db;
}

const productBySku = async (db: Db, sku: string) => (await first(db.select().from(products).where(eq(products.sku, sku))))!;
const stockOf = async (db: Db, sku: string) => (await first(db.select().from(stock).where(eq(stock.productId, (await productBySku(db, sku)).id))))!;

describe('CSV parsing', () => {
  it('detects the semicolons Indonesian Excel writes and handles quoted fields', () => {
    const csv = '﻿nama;harga;catatan\r\n"Indomie; Goreng";"Rp1.250";"kata ""murah"""\r\n\r\nAqua;5000;"dua\nbaris"\n';
    expect(parseCsv(csv)).toEqual([
      ['nama', 'harga', 'catatan'],
      ['Indomie; Goreng', 'Rp1.250', 'kata "murah"'],
      ['Aqua', '5000', 'dua\nbaris'],
    ]);
  });

  it('reads commas and tabs too, and keeps empty cells', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('import preview', () => {
  it('reports every invalid row with its spreadsheet row number', async () => {
    const db = await freshDb();
    const aqua = await productBySku(db, 'AQA-600');
    const priceA = async () => (await db.select().from(productPrices).where(eq(productPrices.productId, aqua.id))).find((p) => p.tier === 'A' && p.unit === 'dus')!.unitPrice;
    const before = await priceA();
    const csv = ['sku,tier,satuan,harga', 'AQA-600,A,dus,80000', 'AQA-600,D,dus,80000', 'NOPE-1,A,dus,1000', 'AQA-600,B,karung,1000', 'AQA-600,C,dus,abc', 'aqa-600,a,DUS,81000'].join('\n');
    const preview = await previewImport(db, 'harga', csv);
    expect(preview).toMatchObject({ dataset: 'harga', rows: 6 });
    expect(preview.errors).toEqual([
      { row: 3, message: expect.stringContaining('Tier "D"') },
      { row: 4, message: expect.stringContaining('NOPE-1 belum ada') },
      { row: 5, message: expect.stringContaining('belum punya satuan "karung"') },
      { row: 6, message: expect.stringContaining('Harga "abc"') },
      { row: 7, message: 'Baris ganda untuk AQA-600 A dus' },
    ]);
    // A preview writes nothing.
    expect(before).not.toBe(80_000);
    expect(await priceA()).toBe(before);
  });

  it('matches columns by header name, in any order, and names a missing one', async () => {
    const db = await freshDb();
    expect(await previewImport(db, 'stok', 'Jumlah,Kode\n10,AQA-600')).toMatchObject({ rows: 1, updates: 1, errors: [] });
    await expect(previewImport(db, 'stok', 'sku,gudang\nAQA-600,1')).rejects.toThrow(/Kolom "stok" tidak ada/);
    await expect(previewImport(db, 'stok', 'sku,stok\n')).rejects.toThrow(ImportError);
  });
});

describe('import apply', () => {
  it('writes nothing when any row is invalid, and everything in one go when all are valid', async () => {
    const db = await freshDb();
    const before = (await stockOf(db, 'AQA-600')).onHand;
    const bad = await applyImport(db, 'stok', 'sku,stok\nAQA-600,5000\nGLK-1KG,-1\n');
    expect(bad.errors).toEqual([{ row: 3, message: expect.stringContaining('Stok "-1"') }]);
    expect((await stockOf(db, 'AQA-600')).onHand).toBe(before);

    const ok = await applyImport(db, 'stok', 'sku;stok\nAQA-600;5.000\nGLK-1KG;1200\n');
    expect(ok).toMatchObject({ rows: 2, updates: 2, errors: [] });
    expect((await stockOf(db, 'AQA-600')).onHand).toBe(5_000);
    expect((await stockOf(db, 'GLK-1KG')).onHand).toBe(1_200);
  });

  it('never lets stock drop below what confirmed orders have reserved', async () => {
    const db = await freshDb();
    const aqua = await productBySku(db, 'AQA-600');
    await db.update(stock).set({ reserved: 48 }).where(eq(stock.productId, aqua.id));
    const r = await applyImport(db, 'stok', 'sku,stok\nAQA-600,24\n');
    expect(r.errors).toEqual([{ row: 2, message: expect.stringContaining('lebih kecil dari yang sudah dipesan pelanggan (48 pcs)') }]);
    expect((await applyImport(db, 'stok', 'sku,stok\nAQA-600,48\n')).errors).toEqual([]);
    // The reservation itself is untouched.
    expect(await stockOf(db, 'AQA-600')).toMatchObject({ onHand: 48, reserved: 48 });
  });

  it('adds a new product with its units, prices and the names customers use', async () => {
    const db = await freshDb();
    const produk = await applyImport(db, 'produk', 'sku,nama,merek,kategori,satuan_dasar,alias\nTEH-PCK-25,Teh Pucuk Harum 350ml,Mayora,Minuman,pcs,teh pucuk|pucuk\n');
    expect(produk).toMatchObject({ inserts: 1, updates: 0, errors: [] });
    const teh = await productBySku(db, 'TEH-PCK-25');
    expect(teh).toMatchObject({ name: 'Teh Pucuk Harum 350ml', category: 'minuman', baseUnit: 'pcs', active: true });
    expect((await db.select().from(productSynonyms).where(eq(productSynonyms.productId, teh.id))).map((s) => s.alias).sort()).toEqual(['pucuk', 'teh pucuk', 'teh pucuk harum 350ml']);
    expect(await stockOf(db, 'TEH-PCK-25')).toMatchObject({ onHand: 0, reserved: 0 });

    expect((await applyImport(db, 'satuan', 'sku,satuan,isi\nTEH-PCK-25,dus,24\nTEH-PCK-25,pcs,2\n')).errors).toEqual([{ row: 3, message: 'Satuan dasar pcs selalu berisi 1' }]);
    expect((await applyImport(db, 'satuan', 'sku,satuan,isi\nTEH-PCK-25,dus,24\n')).errors).toEqual([]);
    expect((await db.select().from(productUnits).where(eq(productUnits.productId, teh.id))).map((u) => [u.unit, u.factor]).sort()).toEqual([
      ['dus', 24],
      ['pcs', 1],
    ]);
    expect((await applyImport(db, 'harga', 'sku,tier,satuan,harga\nTEH-PCK-25,C,dus,"Rp85.000"\n')).errors).toEqual([]);
    expect(await first(db.select().from(productPrices).where(eq(productPrices.productId, teh.id)))).toMatchObject({ tier: 'C', unit: 'dus', unitPrice: 85_000 });

    // The base unit cannot change once stock is counted in it.
    expect((await previewImport(db, 'produk', 'sku,nama,merek,kategori,satuan_dasar\nTEH-PCK-25,Teh Pucuk,Mayora,minuman,dus\n')).errors).toEqual([
      { row: 2, message: expect.stringContaining('tidak bisa diubah dari pcs ke dus') },
    ]);
  });

  it('normalises WhatsApp numbers and updates an existing customer by number', async () => {
    const db = await freshDb();
    const header = 'nama_toko,nama_pemilik,sapaan,no_wa,tier,limit_kredit,tempo_hari,area,alamat,nada_pengingat';
    const r = await applyImport(db, 'pelanggan', `${header}\nWarung Baru,Siti Aminah,Bu,0812-3450-0099,c,2.000.000,7,Tambun,Jl. Baru 1,tegas\nWarung Bu Sari,Sari Wulandari,Bu,6281234500001,C,6000000,14,Bekasi Timur,Jl. Melati No. 12,ramah\n`);
    expect(r).toMatchObject({ inserts: 1, updates: 1, errors: [] });
    expect(await first(db.select().from(customers).where(eq(customers.waId, '6281234500099')))).toMatchObject({ name: 'Warung Baru', tier: 'C', creditLimit: 2_000_000, reminderTone: 'firm' });
    expect((await first(db.select().from(customers).where(eq(customers.waId, '6281234500001'))))?.creditLimit).toBe(6_000_000);
    expect((await previewImport(db, 'pelanggan', `${header}\nX,Y,Pak,12,A,1,7,Setu,Jl,galak\n`)).errors.map((e) => e.message)).toEqual([
      expect.stringContaining('Nomor WhatsApp "12"'),
      expect.stringContaining('Nada pengingat "galak"'),
    ]);
  });
});

describe('export', () => {
  it.each(DATASETS)('exports %s as a template that imports back unchanged', async (dataset) => {
    const db = await freshDb();
    const csv = await exportCsv(db, dataset);
    const rows = parseCsv(csv).length - 1;
    expect(rows).toBeGreaterThan(0);
    const preview = await previewImport(db, dataset, csv);
    expect(preview).toMatchObject({ rows, inserts: 0, updates: rows, errors: [] });
    await applyImport(db, dataset, csv);
    expect(await exportCsv(db, dataset)).toBe(csv);
  });
});

describe('Google Sheets links', () => {
  it('turns a sharing link into its CSV export URL and refuses other hosts', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    expect(sheetsCsvUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=42`)).toBe(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=42`);
    expect(sheetsCsvUrl(`https://docs.google.com/spreadsheets/d/${id}/edit`)).toBe(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=0`);
    expect(() => sheetsCsvUrl(`https://evil.example/spreadsheets/d/${id}/edit`)).toThrow(ImportError);
    expect(() => sheetsCsvUrl(`http://docs.google.com/spreadsheets/d/${id}/edit`)).toThrow(ImportError);
    expect(() => sheetsCsvUrl('not a url')).toThrow(ImportError);
  });
});
