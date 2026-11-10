import { eq } from '@salura/db/orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { bankStatementLines, first, invoices, messages, payments, type Db } from '@salura/db';
import { bankStatementSample, EventBus, SaluraService, ScriptedModel, SidecarStt, SidecarVision } from '@salura/agent';
import { closeSeededDb, seededDb } from '../../../packages/db/test/template.ts';
import { createApp } from '../src/app.ts';
import { upsertUser } from '../src/auth.ts';
import { parseAmount, parseBankStatement, parseStatementDate } from '../src/bank-statement.ts';
import { ChannelRouter } from '../src/channels.ts';
import { ImportError } from '../src/importer.ts';

const NOW = new Date('2026-10-28T03:00:00Z');

describe('bank statement CSV', () => {
  it('reads the KlikBCA export: account details on top, CR/DB beside the amount, dd/mm dates, balances below', () => {
    const parsed = parseBankStatement(bankStatementSample(), NOW);
    expect(parsed).toMatchObject({ errors: [], debitRows: 2, pendingRows: 0 });
    expect(parsed.lines.map((l) => [l.row, l.postedOn, l.amount])).toEqual([
      [2, '2026-10-22', 1_007_900],
      [3, '2026-10-24', 1_280_200],
      [4, '2026-10-25', 624_100],
      [5, '2026-10-26', 504_000],
      [7, '2026-10-27', 1_500_000],
    ]);
    expect(parsed.lines[2]!.description).toBe('TRSF E-BANKING CR 2510/FTSCY/WS95051 624100.00 SARI WULANDARI');
  });

  it('reads separate debit and credit columns, Indonesian numbers and semicolons (Livin Mandiri)', () => {
    const csv = [
      'Tanggal;Keterangan;Keterangan;Debit;Kredit;Saldo',
      '25/10/2026;Transfer masuk;DARI SARI WULANDARI;0,00;624.100,00;10.624.100,00',
      '26/10/2026;Biaya admin;;12.500,00;0,00;10.611.600,00',
      '26/10/2026;Setoran;ABDUL RASYID;;1.280.200,00;11.891.800,00',
    ].join('\n');
    const parsed = parseBankStatement(csv, NOW);
    expect(parsed.debitRows).toBe(1);
    expect(parsed.lines).toEqual([
      { row: 1, postedOn: '2026-10-25', description: 'Transfer masuk DARI SARI WULANDARI', amount: 624_100 },
      { row: 3, postedOn: '2026-10-26', description: 'Setoran ABDUL RASYID', amount: 1_280_200 },
    ]);
  });

  it('reads the BRI column names and ISO dates', () => {
    const csv = ['TGL_TRAN,DESK_TRAN,MUTASI_DEBET,MUTASI_KREDIT,SALDO_AKHIR_MUTASI', '2026-10-25 09:14:52,NBMB SARI WULANDARI TO CV SUMBER REJEKI,0.00,624100.00,5624100.00', '2026-10-25 10:00:00,TARIK TUNAI,50000.00,0.00,5574100.00'].join('\n');
    expect(parseBankStatement(csv, NOW)).toMatchObject({ debitRows: 1, lines: [{ postedOn: '2026-10-25', amount: 624_100, description: 'NBMB SARI WULANDARI TO CV SUMBER REJEKI' }] });
  });

  it('takes the direction from a type column or the sign, and lists rows it cannot read', () => {
    const csv = [
      'Date,Description,Amount,D/K',
      '25-Okt-2026,="SARI WULANDARI",624100,K',
      '25-Okt-2026,PEMBELIAN,624100,D',
      '26 Oct 2026,REFUND,-15000,',
      'PEND,TRANSFER BELUM DIPROSES,50000,K',
      'kemarin,TRANSFER,50000,K',
      '26/10/2026,TRANSFER,lima puluh,K',
      '30/10/2026,TRANSFER,50000,K',
    ].join('\n');
    const parsed = parseBankStatement(csv, NOW);
    expect(parsed.lines).toEqual([{ row: 1, postedOn: '2026-10-25', description: 'SARI WULANDARI', amount: 624_100 }]);
    expect(parsed).toMatchObject({ debitRows: 2, pendingRows: 1 });
    expect(parsed.errors).toEqual([
      { row: 5, message: 'Tanggal "kemarin" tidak terbaca' },
      { row: 6, message: 'Nominal "lima puluh" tidak terbaca' },
      { row: 7, message: 'Tanggal 2026-10-30 belum terjadi' },
    ]);
  });

  it('refuses a file without the columns it needs', () => {
    expect(() => parseBankStatement('nama,harga\nIndomie,3000', NOW)).toThrow(ImportError);
  });

  it('parses Indonesian and English number formats', () => {
    expect(['1.250.000,00', '1,250,000.00', 'Rp 1.250.000', '1250000', '1.250.000', '624,100.00 CR', '1250000.5', '1.000.000,99'].map(parseAmount)).toEqual([
      1_250_000, 1_250_000, 1_250_000, 1_250_000, 1_250_000, 624_100, 1_250_000, 1_000_000,
    ]);
    expect(['1.250', '1,250', '(10.000)', '-10.000', '10.000-', 'abc', '1.2.3,4,5'].map(parseAmount)).toEqual([1_250, 1_250, -10_000, -10_000, -10_000, null, null]);
    // ",-" closes a whole rupiah amount; a marker can stick to the digits.
    expect(['Rp 624.100,-', 'Rp624.100,-', '624.100,--', '1,000,000.00CR', '1.000.000,00DB'].map(parseAmount)).toEqual([624_100, 624_100, 624_100, 1_000_000, 1_000_000]);
  });

  it('keeps "Rp 624.100,-" as money in and treats "-" as an empty credit cell', () => {
    const csv = ['Tanggal,Keterangan,Debit,Kredit', '25/10/2026,SARI,-,"Rp 624.100,-"', '25/10/2026,BIAYA ADM,"Rp 10.000,-",-', '26/10/2026,KOREKSI,,-5.000'].join('\n');
    const parsed = parseBankStatement(csv, NOW);
    expect(parsed.lines).toEqual([{ row: 1, postedOn: '2026-10-25', description: 'SARI', amount: 624_100 }]);
    expect(parsed).toMatchObject({ debitRows: 1, errors: [{ row: 3, message: 'Nominal kredit "-5.000" negatif' }], errorCount: 1 });
  });

  it.each(['D/C', 'DR/CR', 'Dr/Cr', 'CR/DR', 'Debit/Credit', 'C/D', 'Mutasi Type'])('reads the direction column headed "%s"', (header) => {
    const csv = [`Date,Description,Amount,${header}`, '25/10/2026,SARI WULANDARI,624100,C', '25/10/2026,PT SUMBER PANGAN,624100,D', '26/10/2026,BIAYA,10000,DR', '26/10/2026,TRF DIMAS,504000,CR'].join('\n');
    const parsed = parseBankStatement(csv, NOW);
    expect(parsed.lines.map((l) => [l.description, l.amount])).toEqual([
      ['SARI WULANDARI', 624_100],
      ['TRF DIMAS', 504_000],
    ]);
    expect(parsed.debitRows).toBe(2);
  });

  it('finds a direction column by its values when the header is unknown', () => {
    const csv = ['Date,Description,Amount,Arah', '25/10/2026,SARI WULANDARI,624100,K', '25/10/2026,PT SUMBER PANGAN,624100,D'].join('\n');
    expect(parseBankStatement(csv, NOW)).toMatchObject({ debitRows: 1, lines: [{ description: 'SARI WULANDARI', amount: 624_100 }] });
  });

  it('refuses an amount column with no CR/DB and no negative value, instead of reading every row as money in', () => {
    const csv = ['Date,Description,Amount,Catatan', '25/10/2026,SARI WULANDARI,624100,bayar', '25/10/2026,PT SUMBER PANGAN,624100,beli stok'].join('\n');
    expect(() => parseBankStatement(csv, NOW)).toThrow(/uang masuk dan keluar tidak bisa dibedakan/);
    // Negative values are enough to tell them apart.
    const signed = ['Date,Description,Amount', '25/10/2026,SARI WULANDARI,624100', '25/10/2026,PT SUMBER PANGAN,-624100'].join('\n');
    expect(parseBankStatement(signed, NOW)).toMatchObject({ debitRows: 1, lines: [{ description: 'SARI WULANDARI' }] });
  });

  it('decides day or month first from the whole file', () => {
    const file = (...dates: string[]) => ['Tanggal,Keterangan,Kredit', ...dates.map((d, i) => `${d},TRF ${i},50000`)].join('\n');
    // 10/25 can only be month first, so 10/05 in the same file is 5 October.
    expect(parseBankStatement(file('10/05/2026', '10/25/2026'), NOW)).toMatchObject({ warnings: [], lines: [{ postedOn: '2026-10-05' }, { postedOn: '2026-10-25' }] });
    expect(parseBankStatement(file('10/05/2026', '25/10/2026'), NOW)).toMatchObject({ warnings: [], lines: [{ postedOn: '2026-05-10' }, { postedOn: '2026-10-25' }] });
    expect(() => parseBankStatement(file('25/10/2026', '10/26/2026'), NOW)).toThrow(/Urutan tanggal/);
    // Early in the month a dd/mm file keeps its month the same: read as dd/mm without a warning.
    expect(parseBankStatement(file('05/10/2026', '06/10/2026', '07/10/2026'), NOW)).toMatchObject({ warnings: [], lines: [{ postedOn: '2026-10-05' }, { postedOn: '2026-10-06' }, { postedOn: '2026-10-07' }] });
    // Nothing settles it and the second part changes: still dd/mm, but the owner is told to check.
    const unsure = parseBankStatement(file('10/05/2026', '10/06/2026'), NOW);
    expect(unsure.lines.map((l) => l.postedOn)).toEqual(['2026-05-10', '2026-06-10']);
    expect(unsure.warnings).toEqual([expect.stringContaining('tidak bisa dipastikan')]);
  });

  it('lists the first 200 unreadable rows and counts the rest', () => {
    const csv = ['Tanggal,Keterangan,Kredit', ...Array.from({ length: 250 }, () => '25/10/2026,TRF,abc')].join('\n');
    const parsed = parseBankStatement(csv, NOW);
    expect(parsed.errors).toHaveLength(200);
    expect(parsed.errorCount).toBe(250);
  });

  it('parses day-first dates and gives dates without a year the statement period year', () => {
    const base = { year: 2027, month: 1 };
    expect(['05/01', '28/12', '25/10/2026', '25-10-26', '2026-10-25', '25 Agu 2026', '3 Mei', '31/02/2026', '13/13/2026'].map((d) => parseStatementDate(d, base))).toEqual([
      '2027-01-05',
      '2026-12-28',
      '2026-10-25',
      '2026-10-25',
      '2026-10-25',
      '2026-08-25',
      '2026-05-03',
      null,
      null,
    ]);
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const PASSWORDS = { admin: 'admin-pass-123', tamu: 'tamu-pass-123' } as const;
const WITH_ACCOUNTS = {
  key: 'accounts',
  init: async (db: Db) => {
    await upsertUser(db, { username: 'admin', displayName: 'Pak Budi', role: 'admin', password: PASSWORDS.admin });
    await upsertUser(db, { username: 'tamu', displayName: 'Tamu', role: 'viewer', password: PASSWORDS.tamu });
  },
};

async function setup() {
  const db = await seededDb(Date.parse('2026-10-21T03:00:00Z'), WITH_ACCOUNTS);
  onTestFinished(() => closeSeededDb(db));
  let t = NOW.getTime();
  const clock = () => new Date((t += 1000));
  const bus = new EventBus(db);
  const channels = new ChannelRouter(null);
  const service = new SaluraService({ db, bus, model: new ScriptedModel([]), stt: new SidecarStt(), vision: new SidecarVision(), clock, pricing: null, outbox: channels });
  const app = createApp({ db, bus, service, channels, clock, manualMinutesPerOrder: 6, corsOrigins: [], webDist: null });
  const cookies: Record<string, string> = {};
  const request = async (path: string, init: RequestInit = {}, as: keyof typeof PASSWORDS | null = 'admin') => {
    const headers = new Headers(init.headers);
    if (as) {
      if (!cookies[as]) {
        const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: as, password: PASSWORDS[as] }) });
        cookies[as] = res.headers.get('set-cookie')!.split(';')[0]!;
      }
      headers.set('cookie', cookies[as]);
    }
    const res = await app.request(path, { ...init, headers });
    return { status: res.status, body: (await res.json()) as any };
  };
  const post = (path: string, body: unknown, as: keyof typeof PASSWORDS | null = 'admin') => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, as);
  return { db, app, request, post };
}

type Line = { hash: string; row: number; status: string; amount: number; candidates: { id: string; customer: { name: string } }[] };

describe('bank statement API', () => {
  it('is for admins only', async () => {
    const { app, post, request } = await setup();
    expect((await post('/api/bank-statement/preview', { sample: true }, 'tamu')).status).toBe(403);
    expect((await post('/api/bank-statement/apply', { sample: true, selections: [] }, 'tamu')).status).toBe(403);
    expect((await post('/api/bank-statement/preview', { sample: true }, null)).status).toBe(401);
    // The sample itself is synthetic and can be downloaded by anyone signed in.
    const res = await app.request('/api/bank-statement/sample');
    expect(res.status).toBe(401);
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tamu', password: PASSWORDS.tamu }) });
    const sample = await app.request('/api/bank-statement/sample', { headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! } });
    expect(sample.headers.get('content-type')).toContain('text/csv');
    expect(await sample.text()).toContain('SARI WULANDARI');
    expect((await request('/api/bank-statement/preview', { method: 'POST', body: new FormData() })).body.error.code).toBe('import_invalid');
  });

  it('previews the sample, applies the chosen matches in one go and skips them on the next upload', async () => {
    const { db, post } = await setup();
    const preview = await post('/api/bank-statement/preview', { sample: true });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ debitRows: 2, pendingRows: 0, errors: [] });
    const lines = preview.body.preview.lines as Line[];
    expect(lines.map((l) => [l.amount, l.status, l.candidates[0]?.customer.name ?? null])).toEqual([
      [1_007_900, 'confident', 'Toko Berkah'],
      [1_280_200, 'confident', 'Warung Madura Pak Rasyid'],
      [624_100, 'confident', 'Warung Bu Sari'],
      [504_000, 'review', 'Warung Madura Pak Rasyid'],
      [1_500_000, 'none', null],
    ]);

    // The owner takes the confident ones, decides the ambiguous line is Mas Dimas paying a bit more, and sets the refund aside.
    const dimas = lines[3]!.candidates.find((c) => c.customer.name === 'Warung Kopi Mas Dimas')!;
    const selections = [...lines.slice(0, 3).map((l) => ({ hash: l.hash, candidateId: l.candidates[0]!.id })), { hash: lines[3]!.hash, candidateId: dimas.id }, { hash: lines[4]!.hash, candidateId: null }];
    const applied = await post('/api/bank-statement/apply', { sample: true, selections });
    expect(applied.status).toBe(200);
    expect(applied.body.applied.map((a: { outcome: string }) => a.outcome)).toEqual(['payment_recorded', 'payment_recorded', 'payment_recorded', 'payment_recorded', 'ignored']);
    const open = await db.select().from(invoices).where(eq(invoices.status, 'open')).orderBy(invoices.number);
    expect(open.map((i) => i.number)).toEqual(['INV-00005', 'INV-00006', 'INV-00012', 'INV-00017', 'INV-00018']);
    const inv3 = (await first(db.select().from(invoices).where(eq(invoices.number, 'INV-00003'))))!;
    expect(inv3).toMatchObject({ status: 'paid', paidAmount: 624_100 });

    const thanks = await db.select().from(messages).where(eq(messages.direction, 'out'));
    expect(thanks.map((m) => m.waId).sort()).toEqual(['6281234500001', '6281234500003', '6281234500004', '6281234500006']);
    expect(thanks.find((m) => m.waId === '6281234500006')!.text).toContain('Ada lebih bayar Rp45.500');

    const again = await post('/api/bank-statement/preview', { sample: true });
    expect((again.body.preview.lines as Line[]).map((l) => l.status)).toEqual(['recorded', 'recorded', 'recorded', 'recorded', 'recorded']);
    const twice = await post('/api/bank-statement/apply', { sample: true, selections });
    expect(twice.body.applied.map((a: { outcome: string }) => a.outcome)).toEqual(Array(5).fill('already_recorded'));
    expect(await db.select().from(payments)).toHaveLength(4);
    expect(await db.select().from(bankStatementLines)).toHaveLength(5);
  });

  it('accepts an uploaded file and lists the overpayment', async () => {
    const { request } = await setup();
    const csv = 'Tanggal,Keterangan,Kredit\n26/10/2026,TRSF DIMAS PRASETYO,504.000\n';
    const form = new FormData();
    form.append('file', new File([csv], 'mutasi.csv', { type: 'text/csv' }));
    const preview = await request('/api/bank-statement/preview', { method: 'POST', body: form });
    const [line] = preview.body.preview.lines as Line[];
    expect(line).toMatchObject({ status: 'review', amount: 504_000 });

    const apply = new FormData();
    apply.append('file', new File([csv], 'mutasi.csv', { type: 'text/csv' }));
    apply.append('selections', JSON.stringify([{ hash: line!.hash, candidateId: line!.candidates.find((c) => c.customer.name === 'Warung Kopi Mas Dimas')!.id }]));
    expect((await request('/api/bank-statement/apply', { method: 'POST', body: apply })).status).toBe(200);
    const overpaid = await request('/api/collections/overpaid');
    expect(overpaid.body.overpayments).toEqual([expect.objectContaining({ source: 'payment', amount: 45_500, reference: 'Transfer Rp504.000' })]);

    const bad = new FormData();
    bad.append('file', new File([csv], 'mutasi.csv', { type: 'text/csv' }));
    bad.append('selections', JSON.stringify([{ hash: 'not-a-hash', candidateId: null }]));
    expect((await request('/api/bank-statement/apply', { method: 'POST', body: bad })).status).toBe(400);
  });
});
