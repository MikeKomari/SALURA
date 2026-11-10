import { eq } from '@salura/db/orm';
import { describe, expect, it } from 'vitest';
import { approvals, bankStatementLines, first, invoices, payments, type Db } from '@salura/db';
import { applyStatementMatches, lineHashes, matchStatement, type StatementLine } from '../src/domain/bank-matching.ts';
import { decidePaymentApproval, overpayments, recordPaymentClaim } from '../src/domain/payments.ts';
import { customerByWa, freshDb, T0 } from './helpers.ts';

// Open invoices in the seed: Bu Sari INV-00003 Rp624.100; Pak Rasyid INV-00007 Rp776.200 + INV-00008
// Rp504.000; Toko Berkah (Lina Marlina) INV-00010 Rp1.007.900; Mas Dimas INV-00014 Rp458.500.
const BU_SARI = '6281234500001';
const now = new Date(T0.getTime() + 7 * 86_400_000);
const line = (row: number, amount: number, description: string, postedOn = '2026-10-25'): StatementLine => ({ row, postedOn, description, amount });
const invoice = async (db: Db, number: string) => (await first(db.select().from(invoices).where(eq(invoices.number, number))))!;
const apply = (db: Db, lines: StatementLine[], selections: { hash: string; candidateId: string | null }[]) => applyStatementMatches(db, { lines, selections, decidedBy: 'Pak Budi', now });

describe('bank statement matching rules', () => {
  it('is confident when the amount equals one open invoice and the owner name is in the description', async () => {
    const db = await freshDb();
    const [l] = await matchStatement(db, [line(1, 624_100, 'TRSF E-BANKING CR 2510/FTSCY/WS95051 624100.00 SARI WULANDARI')]);
    expect(l).toMatchObject({ status: 'confident', recorded: null });
    expect(l!.candidates).toHaveLength(1);
    expect(l!.candidates[0]).toMatchObject({ kind: 'invoices', score: 75, customer: { waId: BU_SARI }, allocations: [{ number: 'INV-00003', amount: 624_100 }], unallocated: 0 });
    expect(l!.candidates[0]!.reasons).toEqual(['Nominal sama persis dengan sisa INV-00003 (Rp624.100)', 'Nama pemilik Sari Wulandari ada di keterangan']);
  });

  it('reads invoice numbers written in the description', async () => {
    const db = await freshDb();
    const [l] = await matchStatement(db, [line(1, 1_007_900, 'TRSF E-BANKING CR LINA MARLINA BYR inv 10')]);
    expect(l!.status).toBe('confident');
    expect(l!.candidates[0]).toMatchObject({ score: 100, customer: { name: 'Toko Berkah' } });
    expect(l!.candidates[0]!.reasons[0]).toBe('Nomor tagihan INV-00010 disebut di keterangan');
  });

  it('finds several open invoices of one customer that add up to the amount', async () => {
    const db = await freshDb();
    const [l] = await matchStatement(db, [line(1, 1_280_200, 'SETORAN TUNAI ABDUL RASYID')]);
    expect(l!.status).toBe('confident');
    expect(l!.candidates[0]!.reasons[0]).toBe('Nominal sama dengan jumlah 2 tagihan: INV-00007 Rp776.200 + INV-00008 Rp504.000');
    expect(l!.candidates[0]!.allocations.map((a) => [a.number, a.amount])).toEqual([
      ['INV-00007', 776_200],
      ['INV-00008', 504_000],
    ]);
  });

  it('recognises the customer WhatsApp number in the description', async () => {
    const db = await freshDb();
    const [l] = await matchStatement(db, [line(1, 776_200, 'TRF DARI 0812-3450-0003')]);
    expect(l!.candidates[0]).toMatchObject({ score: 75, customer: { name: 'Warung Madura Pak Rasyid' } });
    expect(l!.candidates[0]!.reasons).toContain('Nomor WhatsApp Warung Madura Pak Rasyid ada di keterangan');
  });

  it('asks for a review when the name and the amount point at different customers', async () => {
    const db = await freshDb();
    const [l] = await matchStatement(db, [line(1, 504_000, 'TRSF E-BANKING CR 2610/FTSCY/WS95066 504000.00 DIMAS PRASETYO')]);
    expect(l!.status).toBe('review');
    expect(l!.candidates.map((c) => [c.customer.name, c.score])).toEqual([
      ['Warung Madura Pak Rasyid', 45],
      ['Warung Kopi Mas Dimas', 30],
    ]);
    const dimas = l!.candidates[1]!;
    expect(dimas.unallocated).toBe(504_000 - 458_500);
    expect(dimas.notes).toEqual(['Lebih besar dari semua tagihan terbuka (Rp458.500): lebih bayar Rp45.500 masuk daftar Lebih bayar']);
  });

  it('proposes nothing for money that is not from a customer, and shows a partial payment for review', async () => {
    const db = await freshDb();
    const [unrelated, partial, amountOnly] = await matchStatement(db, [
      line(1, 1_500_000, 'TRSF E-BANKING CR 2710/FTSCY/WS95090 1500000.00 PT CAHAYA LOGISTIK REFUND'),
      line(2, 300_000, 'SETORAN TUNAI ABDUL RASYID'),
      line(3, 458_500, 'SETORAN TUNAI'),
    ]);
    expect(unrelated).toMatchObject({ status: 'none', candidates: [] });
    expect(partial!.status).toBe('review');
    expect(partial!.candidates[0]!.notes).toContain('Nominal tidak sama dengan tagihan mana pun: dicatat sebagai bayar sebagian, sisa tagihan Rp980.200');
    // An exact amount alone is a lead, not proof.
    expect(amountOnly).toMatchObject({ status: 'review', candidates: [{ score: 45, customer: { name: 'Warung Kopi Mas Dimas' } }] });
  });

  it('gives identical lines different hashes, and the same file the same hashes again', () => {
    const lines = [line(1, 50_000, 'SETORAN TUNAI'), line(2, 50_000, 'setoran  tunai'), line(3, 50_000, 'SETORAN TUNAI', '2026-10-26')];
    const hashes = lineHashes(lines);
    expect(new Set(hashes).size).toBe(3);
    expect(lineHashes(lines)).toEqual(hashes);
  });
});

describe('payments reported in the chat', () => {
  it('links a statement line to the pending chat payment instead of recording it twice', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const claim = await recordPaymentClaim(db, { customerId: sari.id, amount: 624_100, paidOn: '2026-10-25', reference: '2510MT0091447', now });
    const lines = [line(1, 624_100, 'TRSF E-BANKING CR 2510/FTSCY/WS95051 624100.00 SARI WULANDARI')];
    const [l] = await matchStatement(db, lines);
    expect(l!.status).toBe('confident');
    expect(l!.candidates).toEqual([expect.objectContaining({ id: `chat:${claim.paymentId}`, kind: 'chat_payment', score: 90, approvalId: claim.approvalId })]);
    expect(l!.candidates[0]!.reasons).toContain('Tanggal transfer sama');

    const { applied, messages } = await apply(db, lines, [{ hash: l!.hash, candidateId: l!.candidates[0]!.id }]);
    expect(applied).toEqual([expect.objectContaining({ outcome: 'chat_payment_approved', paymentId: claim.paymentId, approvalId: claim.approvalId, unallocated: 0 })]);
    expect(messages).toEqual([{ waId: BU_SARI, text: expect.stringContaining('Pembayaran Rp624.100 sudah kami terima untuk INV-00003') }]);
    expect((await invoice(db, 'INV-00003')).status).toBe('paid');
    expect(await db.select().from(payments)).toEqual([expect.objectContaining({ id: claim.paymentId, status: 'approved' })]);
    const approval = (await first(db.select().from(approvals).where(eq(approvals.id, claim.approvalId))))!;
    expect(approval).toMatchObject({ status: 'approved', decidedBy: 'Pak Budi', decisionNote: expect.stringContaining('Cocok dengan mutasi rekening 2026-10-25') });
  });

  it('only marks the line when the owner already approved that payment by hand', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const claim = await recordPaymentClaim(db, { customerId: sari.id, amount: 624_100, paidOn: '2026-10-24', now });
    await decidePaymentApproval(db, { approvalId: claim.approvalId, decision: 'approve', decidedBy: 'Pak Budi', now });
    const lines = [line(1, 624_100, 'TRSF E-BANKING CR SARI WULANDARI')];
    const [l] = await matchStatement(db, lines);
    expect(l!.candidates).toEqual([expect.objectContaining({ id: `paid:${claim.paymentId}`, kind: 'recorded_payment', score: 70 })]);
    const { applied, messages } = await apply(db, lines, [{ hash: l!.hash, candidateId: `paid:${claim.paymentId}` }]);
    expect(applied[0]).toMatchObject({ outcome: 'linked', paymentId: claim.paymentId });
    expect(messages).toEqual([]);
    expect(await db.select().from(payments)).toHaveLength(1);
    expect((await invoice(db, 'INV-00003')).paidAmount).toBe(624_100);
  });

  it('refuses a chat receipt for a transfer already confirmed from the statement', async () => {
    const db = await freshDb();
    const lines = [line(1, 624_100, 'TRSF E-BANKING CR SARI WULANDARI')];
    const [l] = await matchStatement(db, lines);
    await apply(db, lines, [{ hash: l!.hash, candidateId: l!.candidates[0]!.id }]);
    const sari = await customerByWa(db, BU_SARI);
    await expect(recordPaymentClaim(db, { customerId: sari.id, amount: 624_100, paidOn: '2026-10-25', reference: 'NEW-REF', now })).rejects.toMatchObject({ code: 'duplicate_payment' });
  });
});

describe('applying matches', () => {
  it('records an approved payment, caps it at what is owed and lists the rest as an overpayment', async () => {
    const db = await freshDb();
    const lines = [line(1, 1_280_200, 'SETORAN TUNAI ABDUL RASYID', '2026-10-24'), line(2, 504_000, 'TRSF E-BANKING CR 504000.00 DIMAS PRASETYO', '2026-10-26')];
    const preview = await matchStatement(db, lines);
    const dimas = preview[1]!.candidates.find((c) => c.customer.name === 'Warung Kopi Mas Dimas')!;
    const { applied, messages } = await apply(db, lines, [
      { hash: preview[0]!.hash, candidateId: preview[0]!.candidates[0]!.id },
      { hash: preview[1]!.hash, candidateId: dimas.id },
    ]);
    expect(applied.map((a) => [a.outcome, a.customer?.name, a.unallocated])).toEqual([
      ['payment_recorded', 'Warung Madura Pak Rasyid', 0],
      ['payment_recorded', 'Warung Kopi Mas Dimas', 45_500],
    ]);
    for (const n of ['INV-00007', 'INV-00008', 'INV-00014']) expect((await invoice(db, n)).status).toBe('paid');
    const rows = await db.select().from(payments).orderBy(payments.id);
    expect(rows.map((p) => [p.amount, p.status, p.bank, p.paidOn])).toEqual([
      [1_280_200, 'approved', 'Mutasi rekening', '2026-10-24'],
      [504_000, 'approved', 'Mutasi rekening', '2026-10-26'],
    ]);
    const decided = await db.select().from(approvals).where(eq(approvals.type, 'payment'));
    expect(decided.map((a) => [a.status, a.decidedBy, a.payload?.source])).toEqual([
      ['approved', 'Pak Budi', 'bank_statement'],
      ['approved', 'Pak Budi', 'bank_statement'],
    ]);
    expect(await overpayments(db)).toEqual([expect.objectContaining({ source: 'payment', amount: 45_500, customer: expect.objectContaining({ name: 'Warung Kopi Mas Dimas' }) })]);
    expect(messages[1]!.text).toContain('Ada lebih bayar Rp45.500');
    expect((await db.select().from(bankStatementLines)).map((b) => [b.status, b.paymentId])).toEqual([
      ['matched', rows[0]!.id],
      ['matched', rows[1]!.id],
    ]);
  });

  it('skips lines recorded in an earlier upload, also when the same file is applied again', async () => {
    const db = await freshDb();
    const lines = [line(1, 624_100, 'TRSF E-BANKING CR SARI WULANDARI'), line(2, 1_500_000, 'PT CAHAYA LOGISTIK REFUND')];
    const first = await matchStatement(db, lines);
    const selections = [
      { hash: first[0]!.hash, candidateId: first[0]!.candidates[0]!.id },
      { hash: first[1]!.hash, candidateId: null },
    ];
    expect((await apply(db, lines, selections)).applied.map((a) => a.outcome)).toEqual(['payment_recorded', 'ignored']);

    const again = await matchStatement(db, lines);
    expect(again.map((l) => [l.status, l.recorded?.status, l.recorded?.customerName ?? null])).toEqual([
      ['recorded', 'matched', 'Warung Bu Sari'],
      ['recorded', 'ignored', null],
    ]);
    const second = await apply(db, lines, selections);
    expect(second.applied.map((a) => a.outcome)).toEqual(['already_recorded', 'already_recorded']);
    expect(second.messages).toEqual([]);
    expect(await db.select().from(payments)).toHaveLength(1);
    expect(await db.select().from(bankStatementLines)).toHaveLength(2);
  });

  it('applies nothing when one choice is no longer proposed or two lines claim the same chat payment', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const claim = await recordPaymentClaim(db, { customerId: sari.id, amount: 624_100, now: T0 });
    const lines = [line(1, 1_280_200, 'SETORAN TUNAI ABDUL RASYID'), line(2, 624_100, 'SARI WULANDARI'), line(3, 624_100, 'SARI WULANDARI', '2026-10-26')];
    const [rasyid, a, b] = await matchStatement(db, lines);
    const good = { hash: rasyid!.hash, candidateId: rasyid!.candidates[0]!.id };
    await expect(apply(db, lines, [good, { hash: a!.hash, candidateId: 'inv:999' }])).rejects.toMatchObject({ code: 'match_stale' });
    await expect(
      apply(db, lines, [good, { hash: a!.hash, candidateId: `chat:${claim.paymentId}` }, { hash: b!.hash, candidateId: `chat:${claim.paymentId}` }]),
    ).rejects.toMatchObject({ code: 'match_conflict', message: expect.stringContaining('Baris 2 dan baris 3') });
    await expect(apply(db, lines, [{ hash: 'f'.repeat(64), candidateId: null }])).rejects.toMatchObject({ code: 'line_not_found' });
    expect(await db.select().from(bankStatementLines)).toEqual([]);
    expect((await invoice(db, 'INV-00007')).paidAmount).toBe(0);
  });
});

describe('one batch, and lines already recorded elsewhere', () => {
  it('refuses two lines of one batch that pay the same invoice, instead of turning the second into an overpayment', async () => {
    const db = await freshDb();
    // Line 2 is Mas Dimas, but its amount equals Pak Rasyid's INV-00008, which line 1 already pays.
    const lines = [line(1, 1_280_200, 'SETORAN TUNAI ABDUL RASYID', '2026-10-24'), line(2, 504_000, 'TRSF E-BANKING CR 504000.00 DIMAS PRASETYO', '2026-10-26')];
    const [rasyid, dimas] = await matchStatement(db, lines);
    expect(dimas!.candidates[0]).toMatchObject({ id: rasyid!.candidates[0]!.id, allocations: [{ number: 'INV-00008', amount: 504_000 }] });
    await expect(
      apply(db, lines, [
        { hash: rasyid!.hash, candidateId: rasyid!.candidates[0]!.id },
        { hash: dimas!.hash, candidateId: dimas!.candidates[0]!.id },
      ]),
    ).rejects.toMatchObject({ code: 'match_conflict', message: expect.stringContaining('Baris 1 dan baris 2 sama-sama melunasi INV-00008') });
    expect(await db.select().from(payments)).toEqual([]);
    expect(await db.select().from(bankStatementLines)).toEqual([]);
    expect((await invoice(db, 'INV-00007')).paidAmount).toBe(0);
  });

  it('applies two lines of one customer that pay different invoices', async () => {
    const db = await freshDb();
    const lines = [line(1, 776_200, 'SETORAN TUNAI ABDUL RASYID', '2026-10-24'), line(2, 504_000, 'SETORAN TUNAI ABDUL RASYID', '2026-10-26')];
    const preview = await matchStatement(db, lines);
    const { applied } = await apply(
      db,
      lines,
      preview.map((l) => ({ hash: l.hash, candidateId: l.candidates[0]!.id })),
    );
    expect(applied.map((a) => [a.outcome, a.allocations.map((x) => x.number), a.unallocated])).toEqual([
      ['payment_recorded', ['INV-00007'], 0],
      ['payment_recorded', ['INV-00008'], 0],
    ]);
  });

  it('refuses to record invoices when a chat claim of that amount is pending by the time the line is applied', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const lines = [line(1, 624_100, 'TRSF E-BANKING CR SARI WULANDARI')];
    const [l] = await matchStatement(db, lines);
    // A claim the proposals did not see: it was committed after they were read.
    await db.insert(payments).values({ customerId: sari.id, amount: 624_100, allocations: [], createdAt: now.toISOString() });
    await expect(apply(db, lines, [{ hash: l!.hash, candidateId: `inv:${sari.id}` }])).rejects.toMatchObject({ code: 'match_stale', message: expect.stringContaining('baru saja mengirim bukti transfer Rp624.100') });
    expect((await invoice(db, 'INV-00003')).paidAmount).toBe(0);
  });

  it('warns when the same transfer was already matched from another export with other wording', async () => {
    const db = await freshDb();
    const klik = [line(1, 624_100, 'TRSF E-BANKING CR 2510/FTSCY/WS95051 624100.00 SARI WULANDARI', '2026-10-25')];
    const [first] = await matchStatement(db, klik);
    await apply(db, klik, [{ hash: first!.hash, candidateId: first!.candidates[0]!.id }]);
    // Her next order is billed the same amount, so the transfer would match it exactly.
    const sari = await customerByWa(db, BU_SARI);
    await db.insert(invoices).values({ number: 'INV-00099', customerId: sari.id, amount: 624_100, issuedAt: '2026-10-26T03:00:00.000Z', dueAt: '2026-11-09T03:00:00.000Z' });

    // The same transfer in another export (other description, booked a day later), and a new one a week later.
    const [twin, later] = await matchStatement(db, [line(1, 624_100, 'BI-FAST CR SARI WULANDARI 0000', '2026-10-26'), line(2, 624_100, 'BI-FAST CR SARI WULANDARI 0000', '2026-11-02')]);
    expect(twin!.status).toBe('review');
    expect(twin!.candidates[0]!.notes[0]).toMatch(/^Mungkin sudah dicatat: mutasi 2026-10-25 Rp624\.100 dari Warung Bu Sari sudah dicocokkan oleh Pak Budi/);
    expect(later).toMatchObject({ status: 'confident', candidates: [{ allocations: [{ number: 'INV-00099' }], notes: [] }] });
  });

  it('records a new identical line of an overlapping period and skips the old ones, without a duplicate warning', async () => {
    const db = await freshDb();
    const deposit = line(1, 300_000, 'SETORAN TUNAI SARI WULANDARI', '2026-10-24');
    const [old] = await matchStatement(db, [deposit]);
    await apply(db, [deposit], [{ hash: old!.hash, candidateId: old!.candidates[0]!.id }]);

    // The next export covers the same day again and has a second identical deposit.
    const next = [deposit, { ...deposit, row: 2 }, line(3, 50_000, 'BIAYA ADM', '2026-10-26')];
    const [again, second] = await matchStatement(db, next);
    expect(again).toMatchObject({ hash: old!.hash, status: 'recorded' });
    expect(second!.hash).not.toBe(old!.hash);
    expect(second!.candidates[0]).toMatchObject({ id: old!.candidates[0]!.id, allocations: [{ number: 'INV-00003', amount: 300_000 }], notes: [expect.stringContaining('bayar sebagian')] });
    const { applied } = await apply(db, next, [
      { hash: again!.hash, candidateId: old!.candidates[0]!.id },
      { hash: second!.hash, candidateId: second!.candidates[0]!.id },
    ]);
    expect(applied.map((a) => a.outcome)).toEqual(['already_recorded', 'payment_recorded']);
    expect((await invoice(db, 'INV-00003')).paidAmount).toBe(600_000);
  });

  it('shows the overpayment of a payment approved by hand', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const claim = await recordPaymentClaim(db, { customerId: sari.id, amount: 700_000, paidOn: '2026-10-25', now });
    await decidePaymentApproval(db, { approvalId: claim.approvalId, decision: 'approve', decidedBy: 'Pak Budi', now });
    const [l] = await matchStatement(db, [line(1, 700_000, 'TRSF E-BANKING CR SARI WULANDARI')]);
    expect(l!.candidates[0]).toMatchObject({ kind: 'recorded_payment', unallocated: 75_900 });
  });
});
