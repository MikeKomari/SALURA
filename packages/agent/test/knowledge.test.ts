import { describe, expect, it } from 'vitest';
import { PolicyIndex } from '../src/knowledge.ts';
import { confirmOrder, draftOrder, splitOrder } from '../src/domain/orders.ts';
import { customerByWa, customerSays, freshDb, PAK_RASYID, productId, T0 } from './helpers.ts';

const index = new PolicyIndex();
/** The agent reads the top 3 hits, so the right section must be among the first two. */
const top2 = (q: string) => index.search(q).slice(0, 2).map((h) => h.source);

describe('policy retrieval', () => {
  it('chunks every document by section', async () => {
    expect(index.chunks.length).toBeGreaterThanOrEqual(15);
    expect(index.chunks.every((c) => c.text.length > 20)).toBe(true);
  });

  it.each([
    ['kalau ke cikarang dikirimnya hari apa aja ya?', 'pengiriman#jadwal-pengiriman-per-area'],
    ['pesan sore jam 4 masih bisa dikirim besok?', 'pengiriman#batas-waktu-pesanan'],
    ['boleh ambil sendiri ke gudang?', 'pengiriman#ambil-sendiri-di-gudang'],
    ['bayarnya bisa pake qris?', 'pembayaran#cara-membayar'],
    ['indomie penyok bisa retur?', 'retur#barang-yang-bisa-diretur'],
    ['bisa minta diskon harga?', 'pembayaran#harga-dan-potongan'],
  ])('"%s" → %s', (q, source) => {
    expect(top2(q)).toContain(source);
  });

  it('returns nothing for unrelated questions', async () => {
    expect(index.search('siapa presiden indonesia')).toEqual([]);
  });
});

describe('overdue hold', () => {
  it('holds new orders from a customer with an invoice more than 14 days overdue', async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    const at = (s: number) => new Date(T0.getTime() + s * 1000);
    const { order } = await draftOrder(db, { customerId: rasyid.id, channel: 'web', now: at(1), lines: [{ productId: await productId(db, 'LMN-600'), qty: 1, unit: 'dus' }] });
    await customerSays(db, PAK_RASYID, 'ya', at(2));
    const r = await confirmOrder(db, { orderId: order.orderId, customerId: rasyid.id, now: at(3) });
    expect(r.outcome).toBe('awaiting_approval');
    expect(r.outcome === 'awaiting_approval' && r.reason).toMatch(/terlama 21 hari/);
  });

  it('refuses to split an order around the overdue hold', async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    const at = (s: number) => new Date(T0.getTime() + s * 1000);
    // About Rp3,3 jt against roughly Rp2,7 jt of available credit.
    const { order } = await draftOrder(db, { customerId: rasyid.id, channel: 'web', now: at(1), lines: [{ productId: await productId(db, 'BRS-SR-25'), qty: 10, unit: 'karung' }] });
    await customerSays(db, PAK_RASYID, 'kalau lewat limit dipecah aja', at(2));
    await expect(splitOrder(db, { orderId: order.orderId, customerId: rasyid.id, now: at(3) })).rejects.toThrow(/overdue/);
  });
});
