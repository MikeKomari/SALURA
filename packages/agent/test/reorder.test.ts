import { and, eq } from '@salura/db/orm';
import { describe, expect, it } from 'vitest';
import { approvals, autonomyPolicies, customers, first, orders, stock, type Db } from '@salura/db';
import { activeDraft, confirmOrder, draftOrder, markSummarySent } from '../src/domain/orders.ts';
import { decideReorderApproval, reorderCandidates, sendReorderNudge } from '../src/domain/reorder.ts';
import { customerByWa, customerRepliesUnprompted, customerSays, freshDb, makeService, productId, T0 } from './helpers.ts';

const YANTI = '6281234500007';
const DIMAS = '6281234500006';
const SARI = '6281234500001';
const RASYID = '6281234500003';
const at = (s: number) => new Date(T0.getTime() + s * 1000);

async function pendingOffer(db: Db, customerId: number) {
  return (await first(db.select().from(approvals).where(and(eq(approvals.type, 'reorder'), eq(approvals.customerId, customerId)))))!;
}

describe('reorder candidates', () => {
  it('finds customers past their usual rhythm and explains every skip', async () => {
    const db = await freshDb();
    const byWa = new Map((await reorderCandidates(db, T0)).map((c) => [c.waId, c]));
    expect(byWa.get(YANTI)).toMatchObject({ avgIntervalDays: 14, daysSinceLastOrder: 18, skipReason: null });
    expect(byWa.get(DIMAS)).toMatchObject({ avgIntervalDays: 14, daysSinceLastOrder: 13, skipReason: null });
    expect(byWa.get(SARI)?.skipReason).toMatch(/Belum waktunya/);
    expect(byWa.get(RASYID)?.skipReason).toMatch(/tagihan terlambat 21 hari/);
  });

  it('skips a customer whose usual order no longer fits their credit', async () => {
    const db = await freshDb();
    await db.update(customers).set({ creditLimit: 500_000 }).where(eq(customers.waId, DIMAS));
    const dimas = (await reorderCandidates(db, T0)).find((c) => c.waId === DIMAS)!;
    expect(dimas.skipReason).toMatch(/Sisa limit kredit/);
  });
});

describe('reorder offers', () => {
  it('queues only a proposal: no order exists until the owner sends it', async () => {
    const db = await freshDb();
    const yanti = await customerByWa(db, YANTI);
    const r = await sendReorderNudge(db, { customerId: yanti.id, reason: 'Sudah lewat 4 hari dari jadwal biasanya', now: at(1) });
    expect(r.outcome).toBe('awaiting_approval');
    expect(r.text).toContain('Bu Yanti');
    expect(await activeDraft(db, yanti.id)).toBeUndefined();
    // A second offer is refused while the first waits.
    await expect(sendReorderNudge(db, { customerId: yanti.id, reason: 'lagi', now: at(2) })).rejects.toThrow(/menunggu persetujuan/);
  });

  it('scenario A: an unsent offer cannot be confirmed by an unrelated "ok"', async () => {
    const db = await freshDb();
    const yanti = await customerByWa(db, YANTI);
    await sendReorderNudge(db, { customerId: yanti.id, reason: 'Jadwal biasanya', now: at(1) });
    // An unrelated conversation finishes and stamps "summary sent" on any open draft…
    await markSummarySent(db, yanti.id, at(2).toISOString());
    await customerRepliesUnprompted(db, YANTI, 'ok', at(3));
    // …but there is no draft to confirm: the offer only exists as a proposal.
    expect(await activeDraft(db, yanti.id)).toBeUndefined();
  });

  it('scenario B: the customer orders on their own, so the queued offer is withdrawn, never sent', async () => {
    const db = await freshDb();
    const yanti = await customerByWa(db, YANTI);
    await sendReorderNudge(db, { customerId: yanti.id, reason: 'Jadwal biasanya', now: at(1) });
    const own = await draftOrder(db, { customerId: yanti.id, channel: 'web', now: at(2), lines: [{ productId: await productId(db, 'IDM-GRG-85'), qty: 1, unit: 'dus' }] });
    expect(await pendingOffer(db, yanti.id)).toMatchObject({ status: 'rejected', decidedBy: 'Sistem' });
    await expect(decideReorderApproval(db, { approvalId: (await pendingOffer(db, yanti.id)).id, decision: 'approve', decidedBy: 'Pak Budi', now: at(3) })).rejects.toThrow(/not a pending/);
    expect((await first(db.select().from(orders).where(eq(orders.id, own.order.orderId))))?.status).toBe('awaiting_customer');
  });

  it('approving sends a message built from the order actually drafted, and YA confirms that order', async () => {
    const db = await freshDb();
    const yanti = await customerByWa(db, YANTI);
    await sendReorderNudge(db, { customerId: yanti.id, reason: 'Jadwal biasanya', now: at(1) });
    const sent = (await decideReorderApproval(db, { approvalId: (await pendingOffer(db, yanti.id)).id, decision: 'approve', decidedBy: 'Pak Budi', now: at(2) }))!;
    expect(sent.waId).toBe(YANTI);
    const draft = (await activeDraft(db, yanti.id))!;
    expect(draft.orderId).toBe(sent.orderId);
    expect(sent.text).toContain(`Total Rp${draft.subtotal.toLocaleString('id-ID')}`);
    await customerRepliesUnprompted(db, YANTI, 'ya', at(3));
    expect((await confirmOrder(db, { orderId: sent.orderId, customerId: yanti.id, now: at(4) })).outcome).toBe('confirmed');
  });

  it('refuses to send a stale offer instead of reporting a send that never happened', async () => {
    const db = await freshDb();
    const yanti = await customerByWa(db, YANTI);
    await sendReorderNudge(db, { customerId: yanti.id, reason: 'Jadwal biasanya', now: at(1) });
    // Every item sells out before the owner approves.
    for (const sku of ['BRS-SR-5', 'BML-1L', 'GRB-1KG', 'IML-SKM-370']) await db.update(stock).set({ onHand: 0 }).where(eq(stock.productId, await productId(db, sku)));
    const offer = await pendingOffer(db, yanti.id);
    await expect(decideReorderApproval(db, { approvalId: offer.id, decision: 'approve', decidedBy: 'Pak Budi', now: at(2) })).rejects.toThrow(/sudah habis/);
    expect((await pendingOffer(db, yanti.id)).status).toBe('pending');
    expect(await activeDraft(db, yanti.id)).toBeUndefined();
  });

  it('rejecting an offer leaves nothing behind', async () => {
    const db = await freshDb();
    const yanti = await customerByWa(db, YANTI);
    await sendReorderNudge(db, { customerId: yanti.id, reason: 'Jadwal biasanya', now: at(1) });
    expect(await decideReorderApproval(db, { approvalId: (await pendingOffer(db, yanti.id)).id, decision: 'reject', decidedBy: 'Pak Budi', note: 'Toko tutup', now: at(2) })).toBeNull();
    expect(await activeDraft(db, yanti.id)).toBeUndefined();
  });

  it('leaves out-of-stock items out of the offer, and creates nothing when everything is out', async () => {
    const db = await freshDb();
    // Dimas usually buys 1 dus Indomie Goreng; another customer takes the last 2 dus.
    const sari = await customerByWa(db, SARI);
    const d = await draftOrder(db, { customerId: sari.id, channel: 'web', now: at(1), lines: [{ productId: await productId(db, 'IDM-GRG-85'), qty: 2, unit: 'dus' }] });
    await customerSays(db, SARI, 'ya', at(2));
    await confirmOrder(db, { orderId: d.order.orderId, customerId: sari.id, now: at(3) });
    const r = await sendReorderNudge(db, { customerId: (await customerByWa(db, DIMAS)).id, reason: 'Jadwal biasanya', now: at(4) });
    expect(r.droppedOutOfStock).toEqual(['Indomie Mi Goreng 85g']);
    expect(r.text).not.toContain('Indomie');
  });

  it('counts a split order once when measuring the rhythm', async () => {
    const db = await freshDb();
    const dimas = await customerByWa(db, DIMAS);
    const before = (await reorderCandidates(db, T0)).find((c) => c.waId === DIMAS)!;
    // A split today adds a confirmed order and its remainder; only the original counts.
    const original = await draftOrder(db, { customerId: dimas.id, channel: 'web', now: at(1), lines: [{ productId: await productId(db, 'AQA-600'), qty: 1, unit: 'dus' }] });
    await customerSays(db, DIMAS, 'ya', at(2));
    await confirmOrder(db, { orderId: original.order.orderId, customerId: dimas.id, now: at(3) });
    await db.insert(orders).values({ customerId: dimas.id, status: 'confirmed', channel: 'web', splitFromOrderId: original.order.orderId, createdAt: at(4).toISOString(), updatedAt: at(4).toISOString() });
    const after = (await reorderCandidates(db, at(5))).find((c) => c.waId === DIMAS)!;
    expect(after.ordersCounted).toBe(before.ordersCounted + 1);
  });

  it('runs end to end through the proactive agent and sends directly in auto mode', async () => {
    const db = await freshDb();
    await db.update(autonomyPolicies).set({ mode: 'auto' }).where(eq(autonomyPolicies.action, 'send_reorder_nudge'));
    const { service, sent } = makeService(db, [
      { call: [{ name: 'get_reorder_candidates', args: {} }] },
      ({ lastToolResults }) => ({
        call: (lastToolResults[0] as any).result.candidates
          .filter((c: any) => !c.skipReason)
          .map((c: any) => ({ name: 'send_reorder_nudge', args: { customer_id: c.customerId, reason: 'Sudah waktunya pesan lagi' } })),
      }),
      { say: 'Ringkasan: 2 pelanggan ditawari.' },
    ]);
    const run = await service.runProactive('eval');
    expect(run.status).toBe('completed');
    expect(sent.map((m) => m.waId).sort()).toEqual([DIMAS, YANTI].sort());
    // Sent offers are real drafts the customers can now answer.
    expect((await activeDraft(db, (await customerByWa(db, YANTI)).id))?.status).toBe('awaiting_customer');
  });
});

describe('proactive run vs live conversations', () => {
  it('skips a customer the agent is talking to at that moment', async () => {
    const db = await freshDb();
    await db.update(autonomyPolicies).set({ mode: 'auto' }).where(eq(autonomyPolicies.action, 'send_reorder_nudge'));
    const { service, sent } = makeService(db, [
      { call: [{ name: 'get_reorder_candidates', args: {} }] },
      ({ lastToolResults }) => ({
        call: (lastToolResults[0] as any).result.candidates
          .filter((c: any) => !c.skipReason)
          .map((c: any) => ({ name: 'send_reorder_nudge', args: { customer_id: c.customerId, reason: 'Jadwal biasanya' } })),
      }),
      ({ lastToolResults }) => {
        expect(lastToolResults.some((r: any) => r.ok === false && r.error.code === 'customer_busy')).toBe(true);
        return { say: 'Bu Yanti dilewati karena sedang chat.' };
      },
    ]);
    // Yanti's message is being handled (her queue entry exists) while the scheduled run starts.
    (service as any).queues.set(YANTI, new Promise(() => {}));
    await service.runProactive('eval');
    expect(sent.map((m) => m.waId)).toEqual([DIMAS]);
  });
});
