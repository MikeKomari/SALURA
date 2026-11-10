import { eq } from '@salura/db/orm';
import { describe, expect, it } from 'vitest';
import { approvals, first, invoices, payments, type Db } from '@salura/db';
import { allocate, decidePaymentApproval, overpayments, recentPayments, recordPaymentClaim } from '../src/domain/payments.ts';
import { recordPromiseToPay } from '../src/domain/reminders.ts';
import { customerByWa, freshDb, makeService, PAK_RASYID, storeMedia, T0 } from './helpers.ts';

const at = (s: number) => new Date(T0.getTime() + s * 1000);
// Pak Rasyid's open invoices in the seed: INV-00007 Rp776.200 (due 30 Sep) and INV-00008 Rp504.000 (due 16 Oct).
const OLD = { number: 'INV-00007', amount: 776_200 };
const NEWER = { number: 'INV-00008', amount: 504_000 };

const invoiceByNumber = async (db: Db, number: string) => (await first(db.select().from(invoices).where(eq(invoices.number, number))))!;

function inv(id: number, number: string, amount: number, dueAt: string, paidAmount = 0) {
  return { id, number, amount, paidAmount, dueAt, customerId: 1, orderId: id, issuedAt: dueAt, status: 'open' as const, promiseToPayAt: null, overpaymentSettledAt: null };
}

describe('payment allocation', () => {
  const open = [inv(2, 'INV-2', 300, '2026-10-10'), inv(1, 'INV-1', 500, '2026-10-01', 100), inv(3, 'INV-3', 200, '2026-10-20')];

  it('pays the oldest due invoice first, counting what is already paid', () => {
    expect(allocate(open, 600)).toEqual({
      allocations: [
        { invoiceId: 1, number: 'INV-1', amount: 400 },
        { invoiceId: 2, number: 'INV-2', amount: 200 },
      ],
      unallocated: 0,
    });
  });

  it('pays invoices the customer named first, and keeps the overpayment unallocated', () => {
    expect(allocate(open, 1_000, ['inv-3 '])).toEqual({
      allocations: [
        { invoiceId: 3, number: 'INV-3', amount: 200 },
        { invoiceId: 1, number: 'INV-1', amount: 400 },
        { invoiceId: 2, number: 'INV-2', amount: 300 },
      ],
      unallocated: 100,
    });
  });
});

describe('payment claims', () => {
  it('records a claim for the owner to check without marking anything paid', async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    const r = await recordPaymentClaim(db, { customerId: rasyid.id, amount: 1_000_000, paidOn: '2026-10-20', bank: 'BCA', reference: 'TRF-1', now: at(1) });
    expect(r.allocations).toEqual([
      expect.objectContaining({ number: OLD.number, amount: OLD.amount }),
      expect.objectContaining({ number: NEWER.number, amount: 1_000_000 - OLD.amount }),
    ]);
    expect(r).toMatchObject({ unallocated: 0, outstandingBefore: OLD.amount + NEWER.amount, outstandingAfter: OLD.amount + NEWER.amount - 1_000_000 });
    const approval = (await first(db.select().from(approvals).where(eq(approvals.id, r.approvalId))))!;
    expect(approval).toMatchObject({ type: 'payment', status: 'pending', customerId: rasyid.id });
    expect(approval.reason).toContain('Cek mutasi rekening');
    expect((await invoiceByNumber(db, OLD.number)).status).toBe('open');
    expect((await recentPayments(db, at(2))).map((p) => [p.amount, p.status, p.customer.waId])).toEqual([[1_000_000, 'pending', PAK_RASYID]]);
  });

  it('allocates to the invoices the customer named', async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    const r = await recordPaymentClaim(db, { customerId: rasyid.id, amount: 600_000, invoiceNumbers: ['inv-00008'], now: at(1) });
    expect(r.allocations.map((a) => [a.number, a.amount])).toEqual([
      [NEWER.number, NEWER.amount],
      [OLD.number, 600_000 - NEWER.amount],
    ]);
    await expect(recordPaymentClaim(db, { customerId: rasyid.id, amount: 5_000, invoiceNumbers: ['INV-00003'], now: at(2) })).rejects.toThrow(/Not an open invoice/);
  });

  it('refuses a payment already waiting, by reference or by amount and date', async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    await recordPaymentClaim(db, { customerId: rasyid.id, amount: 500_000, paidOn: '2026-10-20', reference: 'REF-9', now: at(1) });
    await expect(recordPaymentClaim(db, { customerId: rasyid.id, amount: 1_000, reference: 'REF-9', now: at(2) })).rejects.toMatchObject({ code: 'duplicate_payment' });
    await expect(recordPaymentClaim(db, { customerId: rasyid.id, amount: 500_000, paidOn: '2026-10-20', now: at(3) })).rejects.toMatchObject({ code: 'duplicate_payment' });
    // Same amount on another day is a different transfer.
    await expect(recordPaymentClaim(db, { customerId: rasyid.id, amount: 500_000, paidOn: '2026-10-19', now: at(4) })).resolves.toMatchObject({ amount: 500_000 });
  });

  it('rejects amounts and dates that cannot be right', async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    await expect(recordPaymentClaim(db, { customerId: rasyid.id, amount: 1.5, now: at(1) })).rejects.toMatchObject({ code: 'invalid_amount' });
    await expect(recordPaymentClaim(db, { customerId: rasyid.id, amount: 1_000, paidOn: '2026-10-25', now: at(1) })).rejects.toMatchObject({ code: 'date_in_future' });
  });

  it('approval marks the invoices paid and clears a promise to pay on the settled one', async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    const old = await invoiceByNumber(db, OLD.number);
    const newer = await invoiceByNumber(db, NEWER.number);
    await recordPromiseToPay(db, { invoiceId: old.id, customerId: rasyid.id, date: '2026-10-24', now: at(1) });
    await recordPromiseToPay(db, { invoiceId: newer.id, customerId: rasyid.id, date: '2026-10-24', now: at(1) });
    const r = await recordPaymentClaim(db, { customerId: rasyid.id, amount: 1_000_000, now: at(2) });

    const sent = (await decidePaymentApproval(db, { approvalId: r.approvalId, decision: 'approve', decidedBy: 'Pak Budi', now: at(3) }))!;
    expect(sent.waId).toBe(PAK_RASYID);
    expect(sent.text).toContain('Pembayaran Rp1.000.000 sudah kami terima untuk INV-00007, INV-00008');
    expect(sent.text).toContain(`Sisa tagihan Rp${(OLD.amount + NEWER.amount - 1_000_000).toLocaleString('id-ID')}`);

    expect(await invoiceByNumber(db, OLD.number)).toMatchObject({ status: 'paid', paidAmount: OLD.amount, promiseToPayAt: null });
    // Partly paid: still open, and the promise still stands for the rest.
    const partly = await invoiceByNumber(db, NEWER.number);
    expect(partly).toMatchObject({ status: 'open', paidAmount: 1_000_000 - OLD.amount });
    expect(partly.promiseToPayAt).not.toBeNull();
    expect((await first(db.select().from(payments).where(eq(payments.id, r.paymentId))))?.status).toBe('approved');
    expect((await first(db.select().from(approvals).where(eq(approvals.id, r.approvalId))))).toMatchObject({ status: 'approved', decidedBy: 'Pak Budi' });

    // Deciding twice is refused.
    await expect(decidePaymentApproval(db, { approvalId: r.approvalId, decision: 'approve', decidedBy: 'Pak Budi', now: at(4) })).rejects.toMatchObject({ code: 'approval_not_pending' });
  });

  it('never pays an invoice beyond its amount: a transfer larger than the open invoices is listed as an overpayment', async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    const r = await recordPaymentClaim(db, { customerId: rasyid.id, amount: OLD.amount + NEWER.amount + 50_000, reference: 'TRF-9', now: at(1) });
    expect(r.unallocated).toBe(50_000);
    const sent = (await decidePaymentApproval(db, { approvalId: r.approvalId, decision: 'approve', decidedBy: 'Pak Budi', now: at(2) }))!;
    expect(sent.text).toContain('Ada lebih bayar Rp50.000');
    expect(await invoiceByNumber(db, OLD.number)).toMatchObject({ status: 'paid', paidAmount: OLD.amount });
    expect(await invoiceByNumber(db, NEWER.number)).toMatchObject({ status: 'paid', paidAmount: NEWER.amount });
    expect(await overpayments(db)).toEqual([expect.objectContaining({ source: 'payment', id: r.paymentId, reference: 'TRF-9', amount: 50_000 })]);
  });

  it('rejection tells the customer and marks the payment rejected, changing no invoice', async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    const r = await recordPaymentClaim(db, { customerId: rasyid.id, amount: 300_000, now: at(1) });
    const sent = (await decidePaymentApproval(db, { approvalId: r.approvalId, decision: 'reject', decidedBy: 'Pak Budi', note: 'tidak ada di mutasi', now: at(2) }))!;
    expect(sent.text).toContain('belum bisa kami cocokkan');
    expect(sent.text).toContain('tidak ada di mutasi');
    expect((await first(db.select().from(payments).where(eq(payments.id, r.paymentId))))?.status).toBe('rejected');
    expect((await first(db.select().from(approvals).where(eq(approvals.id, r.approvalId))))?.status).toBe('rejected');
    expect((await invoiceByNumber(db, OLD.number)).paidAmount).toBe(0);
  });

  it('records a payment whose invoices were settled meanwhile as an overpayment, without paying any invoice twice', async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    const r = await recordPaymentClaim(db, { customerId: rasyid.id, amount: 300_000, reference: 'TRF-5', now: at(1) });
    await db.update(invoices).set({ status: 'paid', paidAmount: OLD.amount }).where(eq(invoices.number, OLD.number));
    await db.update(invoices).set({ status: 'paid', paidAmount: NEWER.amount }).where(eq(invoices.number, NEWER.number));
    const sent = (await decidePaymentApproval(db, { approvalId: r.approvalId, decision: 'approve', decidedBy: 'Pak Budi', now: at(2) }))!;
    expect(sent.text).toContain('Ada lebih bayar Rp300.000');
    expect((await first(db.select().from(payments).where(eq(payments.id, r.paymentId))))).toMatchObject({ status: 'approved', allocations: [] });
    expect((await invoiceByNumber(db, OLD.number)).paidAmount).toBe(OLD.amount);
    expect(await overpayments(db)).toEqual([expect.objectContaining({ source: 'payment', id: r.paymentId, amount: 300_000 })]);
  });
});

describe('payment through the order agent', () => {
  it('reads a transfer receipt, records it for checking, and thanks the customer once the owner approves', async () => {
    const db = await freshDb();
    const receipt = await storeMedia(db, 'image/jpeg', 'TYPE: payment_proof\nJumlah: Rp1.000.000\nTanggal: 20/10/2026\nBank: BCA\nReferensi: 8812345');
    const photoId = (messages: { content: string }[]) => Number(/message_id=(\d+)/.exec(JSON.stringify(messages))![1]);
    const { service, sent } = makeService(db, [
      ({ messages }) => ({ call: [{ name: 'read_order_image', args: { message_id: photoId(messages) } }] }),
      ({ messages, lastToolResults }) => {
        const r = (lastToolResults[0] as any).result;
        expect(r.type).toBe('payment_proof');
        expect(r.lines).toEqual(['Jumlah: Rp1.000.000', 'Tanggal: 20/10/2026', 'Bank: BCA', 'Referensi: 8812345']);
        return { call: [{ name: 'record_payment', args: { amount: 1_000_000, paid_on: '2026-10-20', bank: 'BCA', reference: '8812345', message_id: photoId(messages) } }] };
      },
      ({ lastToolResults }) => {
        const r = (lastToolResults[0] as any).result;
        expect(r.allocations.map((a: any) => a.number)).toEqual([OLD.number, NEWER.number]);
        return { say: 'Terima kasih Pak Abdul, bukti transfernya sudah kami terima dan sedang dicek admin ya.' };
      },
    ]);
    const r = await service.handleInbound({ waId: PAK_RASYID, channel: 'web', kind: 'image', mediaId: receipt, text: 'sudah transfer ya' });
    expect(r.status).toBe('completed');

    const payment = (await first(db.select().from(payments)))!;
    expect(payment).toMatchObject({ amount: 1_000_000, status: 'pending', bank: 'BCA', reference: '8812345', runId: r.runId });
    expect(payment.messageId).toBe(r.messageId);
    // The agent never marks anything paid.
    expect((await invoiceByNumber(db, OLD.number)).status).toBe('open');

    const approval = (await first(db.select().from(approvals).where(eq(approvals.type, 'payment'))))!;
    await service.decideApproval({ approvalId: approval.id, decision: 'approve', decidedBy: 'Pak Budi' });
    expect((await invoiceByNumber(db, OLD.number)).status).toBe('paid');
    expect(sent.at(-1)).toMatchObject({ waId: PAK_RASYID });
    expect(sent.at(-1)?.text).toContain('Pembayaran Rp1.000.000 sudah kami terima');
  });
});
