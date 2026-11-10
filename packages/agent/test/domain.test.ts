import { eq } from '@salura/db/orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvals, first, invoices, stock, type Db } from '@salura/db';
import { searchCatalog } from '../src/domain/catalog.ts';
import { creditStatus, usualOrder } from '../src/domain/customers.ts';
import { confirmOrder, decideOrderApproval, DomainError, draftOrder, splitOrder } from '../src/domain/orders.ts';
import { decideReminderApproval, draftReminder, overdueInvoices } from '../src/domain/reminders.ts';
import { BU_SARI, closeSharedDb, customerByWa, customerRepliesUnprompted, customerSays, freshDb, MAKMUR_JAYA, PAK_RASYID, productId, sharedDb, SINAR_PAGI, T0 } from './helpers.ts';

const later = (s: number) => new Date(T0.getTime() + s * 1000);

describe('catalog matching', () => {
  let db: Db;
  beforeAll(async () => {
    db = await sharedDb();
  });
  afterAll(() => closeSharedDb(db));
  const top = (q: string, customerId?: number) => searchCatalog(db, q, customerId);

  it.each([
    ['indomi goreng', 'IDM-GRG-85'],
    ['aqua tanggung', 'AQA-600'],
    ['susu bendera', 'FFL-SKM-370'],
    ['pepsoden', 'PPD-190'],
    ['sambel abc', 'ABC-SBL-335'],
    ['beras SR', 'BRS-SR-25'],
    ['kapal api mix', 'KPA-SMX-25'],
  ])('matches "%s" to %s', async (q, sku) => {
    const r = await top(q);
    expect(r.candidates[0]?.sku).toBe(sku);
    expect(r.ambiguous).toBe(false);
  });

  it('flags a generic phrase as ambiguous and uses purchase history as a hint', async () => {
    const sari = await customerByWa(db, BU_SARI);
    const r = await top('minyak 2 liter', sari.id);
    expect(r.ambiguous).toBe(true);
    expect(r.candidates.map((c) => c.sku)).toEqual(expect.arrayContaining(['BML-2L', 'SNC-2L', 'FLM-2L']));
    expect(r.historyHint?.productId).toBe(await productId(db, 'BML-2L'));
  });

  it('gives no hint when the customer has no history with the candidates', async () => {
    const r = await top('minyak 2 liter');
    expect(r.ambiguous).toBe(true);
    expect(r.historyHint).toBeUndefined();
  });
});

describe('usual order', () => {
  it('keeps items in at least two of the last three orders, with the latest quantity', async () => {
    const db = await freshDb();
    const lines = await usualOrder(db, (await customerByWa(db, BU_SARI)).id);
    expect(lines.map((l) => [l.sku, l.qty, l.unit]).sort()).toEqual(
      [
        ['AQA-600', 1, 'dus'],
        ['GLK-1KG', 10, 'pcs'],
        ['IDM-GRG-85', 2, 'dus'],
        ['KPA-SMX-25', 5, 'renceng'],
      ].sort(),
    );
  });
});

describe('drafting and confirming', () => {
  it('prices every line from the price list for the customer tier', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const { order, issues } = await draftOrder(db, {
      customerId: sari.id,
      channel: 'web',
      now: later(1),
      lines: [{ productId: await productId(db, 'AQA-600'), qty: 2, unit: 'dos' }],
    });
    expect(order.lines[0]).toMatchObject({ unit: 'dus', unitPrice: 81_600, lineTotal: 163_200 });
    expect(issues).toEqual([]);
  });

  it('rejects units a product is not sold in', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    await expect(
      draftOrder(db, { customerId: sari.id, channel: 'web', now: later(1), lines: [{ productId: await productId(db, 'BRS-SR-25'), qty: 1, unit: 'dus' }] }),
    ).rejects.toThrow(DomainError);
  });

  it('reports out-of-stock lines with approved substitutes', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const { issues } = await draftOrder(db, {
      customerId: sari.id,
      channel: 'web',
      now: later(1),
      lines: [
        { productId: await productId(db, 'BML-2L'), qty: 6, unit: 'pcs' },
        { productId: await productId(db, 'IDM-GRG-85'), qty: 3, unit: 'dus' },
      ],
    });
    const oos = issues.filter((i) => i.type === 'out_of_stock');
    expect(oos).toHaveLength(2);
    expect(oos[0]).toMatchObject({ name: 'Bimoli Minyak Goreng 2L Pouch', available: '0 pcs' });
    expect(oos[0]!.type === 'out_of_stock' && oos[0]!.substitutes[0]?.name).toBe('Sunco Minyak Goreng 2L Pouch');
    expect(oos[1]).toMatchObject({ requested: '3 dus', available: '2 dus' });
  });

  it('will not confirm until the customer replies after the summary', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const { order } = await draftOrder(db, { customerId: sari.id, channel: 'web', now: later(1), lines: [{ productId: await productId(db, 'AQA-600'), qty: 1, unit: 'dus' }] });
    await expect(confirmOrder(db, { orderId: order.orderId, customerId: sari.id, now: later(2) })).rejects.toThrow(/has not replied/);

    await customerSays(db, BU_SARI, 'ya', later(3));
    const result = await confirmOrder(db, { orderId: order.orderId, customerId: sari.id, now: later(4) });
    expect(result.outcome).toBe('confirmed');
    const aqua = (await first(db.select().from(stock).where(eq(stock.productId, await productId(db, 'AQA-600')))))!;
    expect(aqua.reserved).toBe(24);
    const invoice = await first(db.select().from(invoices).where(eq(invoices.orderId, order.orderId)));
    expect(invoice?.amount).toBe(81_600);
    // Numbered after its own id, so numbers never collide with the seeded ones.
    expect(invoice?.number).toBe(`INV-${String(invoice!.id).padStart(5, '0')}`);
  });

  it('does not treat a reply as consent when the customer was never shown the summary', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    // The run drafted the order but failed before sending the summary; the customer writes again.
    const { order } = await draftOrder(db, { customerId: sari.id, channel: 'web', now: later(1), lines: [{ productId: await productId(db, 'AQA-600'), qty: 1, unit: 'dus' }] });
    await customerRepliesUnprompted(db, BU_SARI, 'halo? jadi gimana?', later(2));
    await expect(confirmOrder(db, { orderId: order.orderId, customerId: sari.id, now: later(3) })).rejects.toThrow(/has not replied/);
  });

  it('refuses to confirm when a line has gone out of stock', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const { order } = await draftOrder(db, { customerId: sari.id, channel: 'web', now: later(1), lines: [{ productId: await productId(db, 'BML-2L'), qty: 1, unit: 'pcs' }] });
    await customerSays(db, BU_SARI, 'ya', later(2));
    await expect(confirmOrder(db, { orderId: order.orderId, customerId: sari.id, now: later(3) })).rejects.toThrow(/out-of-stock/);
  });

  it('holds orders above the auto-confirm limit for approval', async () => {
    const db = await freshDb();
    const agus = await customerByWa(db, SINAR_PAGI);
    const { order } = await draftOrder(db, { customerId: agus.id, channel: 'web', now: later(1), lines: [{ productId: await productId(db, 'BRS-SR-25'), qty: 35, unit: 'karung' }] });
    await customerSays(db, SINAR_PAGI, 'ok proses', later(2));
    const r = await confirmOrder(db, { orderId: order.orderId, customerId: agus.id, now: later(3) });
    expect(r.outcome).toBe('awaiting_approval');
  });
});

describe('credit limit', () => {
  it('blocks an over-limit order, then splits it into a confirmed part and a held part', async () => {
    const db = await freshDb();
    const hendra = await customerByWa(db, MAKMUR_JAYA);
    const credit = await creditStatus(db, hendra.id, T0);
    expect(credit.available).toBeGreaterThan(0);

    const { order, issues } = await draftOrder(db, {
      customerId: hendra.id,
      channel: 'web',
      now: later(1),
      lines: [
        { productId: await productId(db, 'GRB-1KG'), qty: 2, unit: 'dus' },
        { productId: await productId(db, 'BRS-SR-25'), qty: 10, unit: 'karung' },
      ],
    });
    expect(issues.some((i) => i.type === 'over_credit')).toBe(true);
    await customerSays(db, MAKMUR_JAYA, 'ya kirim', later(2));

    const blocked = await confirmOrder(db, { orderId: order.orderId, customerId: hendra.id, now: later(3) });
    expect(blocked.outcome).toBe('blocked_over_credit');

    const split = await splitOrder(db, { orderId: order.orderId, customerId: hendra.id, now: later(4) });
    expect(split.confirmedPart.outcome).toBe('confirmed');
    expect(split.confirmedPart.order.subtotal).toBeLessThanOrEqual(credit.available);
    expect(split.confirmedPart.order.subtotal + split.heldOrder.subtotal).toBe(order.subtotal);
    expect(split.heldOrder.status).toBe('awaiting_approval');

    const { order: approved, customerMessage } = await decideOrderApproval(db, { approvalId: split.approvalId, decision: 'approve', decidedBy: 'Pak Budi', now: later(5) });
    expect(approved.status).toBe('confirmed');
    expect(customerMessage).toContain(`#${approved.orderId}`);
  });
});

describe('reminders', () => {
  it('lists overdue invoices and queues a templated reminder for approval', async () => {
    const db = await freshDb();
    const overdue = await overdueInvoices(db, T0);
    const rasyid = overdue.find((i) => i.customerName === 'Warung Madura Pak Rasyid' && i.daysOverdue === 21);
    expect(rasyid).toBeDefined();

    const r = await draftReminder(db, { invoiceId: rasyid!.invoiceId, tone: 'firm', reason: 'Three weeks late', now: later(1) });
    expect(r.outcome).toBe('awaiting_approval');
    expect(r.text).toContain('Pak Abdul');
    expect(r.text).toContain('21 hari');

    await expect(draftReminder(db, { invoiceId: rasyid!.invoiceId, tone: 'firm', reason: 'again', now: later(2) })).rejects.toThrow(/minimum gap/);

    const approval = (await first(db.select().from(approvals).where(eq(approvals.type, 'reminder'))))!;
    const sent = await decideReminderApproval(db, { approvalId: approval.id, decision: 'approve', decidedBy: 'Pak Budi', now: later(3) });
    expect(sent?.waId).toBe(PAK_RASYID);
  });
});
