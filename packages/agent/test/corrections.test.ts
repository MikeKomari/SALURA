import { and, eq } from '@salura/db/orm';
import { describe, expect, it } from 'vitest';
import { approvals, first, invoices, messages, orders, payments, stock, type Db } from '@salura/db';
import { cancelConfirmedOrder, confirmOrder, draftOrder, orderCorrection, restoreCancelledOrder } from '../src/domain/orders.ts';
import { BU_SARI, customerByWa, customerSays, freshDb, makeService, productId, T0 } from './helpers.ts';

const later = (s: number) => new Date(T0.getTime() + s * 1000);

/** A confirmed order for Bu Sari: 2 dus Aqua 600, stock reserved and an invoice raised. */
async function confirmedOrder(db: Db, qty = 2) {
  const sari = await customerByWa(db, BU_SARI);
  const aqua = await productId(db, 'AQA-600');
  const { order } = await draftOrder(db, { customerId: sari.id, channel: 'web', now: later(1), lines: [{ productId: aqua, qty, unit: 'dus' }] });
  await customerSays(db, BU_SARI, 'ya', later(2));
  const result = await confirmOrder(db, { orderId: order.orderId, customerId: sari.id, now: later(3) });
  expect(result.outcome).toBe('confirmed');
  return { sari, aqua, orderId: order.orderId };
}

const reservedFor = async (db: Db, productId: number) => (await first(db.select({ reserved: stock.reserved }).from(stock).where(eq(stock.productId, productId))))!.reserved;

describe('pulling back an order the agent should not have confirmed', () => {
  it('releases the reserved stock, withdraws the invoice and records who corrected it', async () => {
    const db = await freshDb();
    const { aqua, orderId } = await confirmedOrder(db);
    const reservedAfterConfirm = await reservedFor(db, aqua);
    expect(reservedAfterConfirm).toBeGreaterThan(0);
    expect(await first(db.select().from(invoices).where(eq(invoices.orderId, orderId)))).toBeDefined();

    const result = await cancelConfirmedOrder(db, { orderId, cancelledBy: 'Pak Budi (Pemilik)', reasonCode: 'wrong_qty', note: 'minta 1 dus', now: later(10) });

    expect(result.order.status).toBe('cancelled');
    expect(result.releasedInvoice).toMatch(/^INV-/);
    expect(await reservedFor(db, aqua)).toBe(0);
    expect(await first(db.select().from(invoices).where(eq(invoices.orderId, orderId)))).toBeUndefined();
    const raw = (await first(db.select().from(orders).where(eq(orders.id, orderId))))!;
    expect(raw.cancelledBy).toBe('Pak Budi (Pemilik)');
    expect(raw.cancelReason).toBe('Jumlahnya salah: minta 1 dus');
    expect(raw.cancelledAt).toBe(later(10).toISOString());
  });

  it('writes a notice that names the order and says the customer owes nothing', async () => {
    const db = await freshDb();
    const { orderId } = await confirmedOrder(db);
    const { message } = await orderCorrection(db, orderId);
    expect(message).toContain(`#${orderId}`);
    expect(message).toContain('tidak perlu membayar');
    expect(message).toContain('Bu Sari');
  });

  it('refuses an order the warehouse has already loaded, and says where to go instead', async () => {
    const db = await freshDb();
    const { orderId } = await confirmedOrder(db);
    await db.update(orders).set({ shippedAt: later(5).toISOString() }).where(eq(orders.id, orderId));

    const correction = await orderCorrection(db, orderId);
    expect(correction.blocked).toMatchObject({ code: 'shipped' });
    expect(correction.blocked?.message).toContain('Pengiriman');
    await expect(cancelConfirmedOrder(db, { orderId, cancelledBy: 'admin', reasonCode: 'wrong_qty', now: later(6) })).rejects.toThrow(/dimuat/);
  });

  it('refuses when money has already been received against the invoice', async () => {
    const db = await freshDb();
    const { orderId } = await confirmedOrder(db);
    await db.update(invoices).set({ paidAmount: 50_000 }).where(eq(invoices.orderId, orderId));

    const correction = await orderCorrection(db, orderId);
    expect(correction.blocked).toMatchObject({ code: 'invoice_paid' });
    expect(correction.blocked?.message).toContain('Penagihan');
    await expect(cancelConfirmedOrder(db, { orderId, cancelledBy: 'admin', reasonCode: 'wrong_qty', now: later(6) })).rejects.toThrow(/sudah dibayar/);
  });

  it('refuses while a transfer the customer reported is still waiting to be checked', async () => {
    const db = await freshDb();
    const { sari, orderId } = await confirmedOrder(db);
    const invoice = (await first(db.select().from(invoices).where(eq(invoices.orderId, orderId))))!;
    await db.insert(payments).values({
      customerId: sari.id,
      amount: invoice.amount,
      allocations: [{ invoiceId: invoice.id, number: invoice.number, amount: invoice.amount }],
      status: 'pending',
      createdAt: later(4).toISOString(),
    });

    expect((await orderCorrection(db, orderId)).blocked).toMatchObject({ code: 'payment_pending' });
  });

  it('sends the queue, not this dialog, when the order is still waiting for a decision', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const { order } = await draftOrder(db, {
      customerId: sari.id,
      channel: 'web',
      now: later(1),
      lines: [{ productId: await productId(db, 'BRS-SR-25'), qty: 35, unit: 'karung' }],
    });
    await customerSays(db, BU_SARI, 'ya', later(2));
    await confirmOrder(db, { orderId: order.orderId, customerId: sari.id, now: later(3) }).catch(() => {});
    await db.update(orders).set({ status: 'awaiting_approval' }).where(eq(orders.id, order.orderId));

    const correction = await orderCorrection(db, order.orderId);
    expect(correction.blocked).toMatchObject({ code: 'not_confirmed' });
    expect(correction.blocked?.message).toContain('Persetujuan');
  });
});

describe('undoing the cancellation', () => {
  it('puts the stock and a fresh invoice back and tells the customer to ignore it', async () => {
    const db = await freshDb();
    const { aqua, orderId } = await confirmedOrder(db);
    await cancelConfirmedOrder(db, { orderId, cancelledBy: 'Pak Budi (Pemilik)', reasonCode: 'other', now: later(10) });
    expect(await reservedFor(db, aqua)).toBe(0);

    const restored = await restoreCancelledOrder(db, { orderId, restoredBy: 'Pak Budi (Pemilik)', now: later(20) });

    expect(restored.order.status).toBe('confirmed');
    expect(restored.customerMessage).toContain('tetap kami proses');
    expect(await reservedFor(db, aqua)).toBeGreaterThan(0);
    expect(await first(db.select().from(invoices).where(eq(invoices.orderId, orderId)))).toBeDefined();
    const raw = (await first(db.select().from(orders).where(eq(orders.id, orderId))))!;
    expect(raw.cancelledBy).toBeNull();
    expect(raw.cancelReason).toBeNull();
  });

  it('refuses to restore an order a person never cancelled', async () => {
    const db = await freshDb();
    const { orderId } = await confirmedOrder(db);
    await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, orderId));
    await expect(restoreCancelledOrder(db, { orderId, restoredBy: 'admin', now: later(20) })).rejects.toThrow(/dibatalkan admin/);
  });

  it('fails cleanly when another order has taken the stock meanwhile', async () => {
    const db = await freshDb();
    const { aqua, orderId } = await confirmedOrder(db);
    await cancelConfirmedOrder(db, { orderId, cancelledBy: 'admin', reasonCode: 'other', now: later(10) });
    // Everything on hand is reserved elsewhere before the undo is pressed.
    const onHand = (await first(db.select({ onHand: stock.onHand }).from(stock).where(eq(stock.productId, aqua))))!.onHand;
    await db.update(stock).set({ reserved: onHand }).where(eq(stock.productId, aqua));

    await expect(restoreCancelledOrder(db, { orderId, restoredBy: 'admin', now: later(20) })).rejects.toThrow(/no longer has enough stock/);
    expect((await first(db.select().from(orders).where(eq(orders.id, orderId))))!.status).toBe('cancelled');
  });
});

describe('the correction through the service, as the console calls it', () => {
  it('tells the customer under the admin name and leaves an audit entry', async () => {
    const db = await freshDb();
    const { orderId } = await confirmedOrder(db);
    const { service, sent } = makeService(db, []);

    const result = await service.cancelConfirmedOrder({ orderId, cancelledBy: 'Pak Budi (Pemilik)', reasonCode: 'wrong_product', note: 'bukan Aqua' });

    expect(result.order.status).toBe('cancelled');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.waId).toBe(BU_SARI);
    expect(sent[0]!.text).toContain(`#${orderId}`);
    const outbound = await first(db.select().from(messages).where(and(eq(messages.waId, BU_SARI), eq(messages.direction, 'out'))));
    expect(outbound?.text).toBe(result.customerMessage);
  });

  it('sends the wording the admin typed when they edited the draft', async () => {
    const db = await freshDb();
    const { orderId } = await confirmedOrder(db);
    const { service, sent } = makeService(db, []);

    await service.cancelConfirmedOrder({ orderId, cancelledBy: 'admin', reasonCode: 'other', message: 'Bu Sari, pesanan tadi saya batalkan dulu ya, besok saya telpon.' });

    expect(sent[0]!.text).toBe('Bu Sari, pesanan tadi saya batalkan dulu ya, besok saya telpon.');
  });

  it('no longer counts the order as handled straight through, and queues nothing', async () => {
    const db = await freshDb();
    const { orderId } = await confirmedOrder(db);
    const { service } = makeService(db, []);
    await service.cancelConfirmedOrder({ orderId, cancelledBy: 'admin', reasonCode: 'not_an_order' });

    expect((await first(db.select().from(orders).where(eq(orders.id, orderId))))!.status).toBe('cancelled');
    expect(await first(db.select().from(approvals).where(eq(approvals.orderId, orderId)))).toBeUndefined();
  });
});
