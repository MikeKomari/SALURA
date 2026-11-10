import { eq } from '@salura/db/orm';
import { describe, expect, it } from 'vitest';
import { first, orders, type Db } from '@salura/db';
import { confirmOrder, draftOrder } from '../src/domain/orders.ts';
import { deliveryDate, markShipped, pickingList } from '../src/domain/warehouse.ts';
import { BU_SARI, customerByWa, customerSays, freshDb, productId, T0 } from './helpers.ts';

const DIMAS = '6281234500006';
const YANTI = '6281234500007';
const at = (s: number) => new Date(T0.getTime() + s * 1000);
/** A moment in Jakarta time (UTC+7). */
const wib = (local: string) => new Date(`${local}+07:00`);

describe('delivery date', () => {
  // 21 Oct 2026 is a Wednesday. Bekasi Timur gets deliveries Mon/Wed/Fri, Cikarang Wed/Sat.
  it.each([
    ['Bekasi Timur', '2026-10-21T10:00:00', '2026-10-23'],
    ['Bekasi Timur', '2026-10-21T14:59:59', '2026-10-23'],
    // From 15:00 WIB the order misses the next run and goes on the one after.
    ['Bekasi Timur', '2026-10-21T15:00:00', '2026-10-26'],
    ['Bekasi Timur', '2026-10-23T09:00:00', '2026-10-26'],
    ['Cikarang', '2026-10-21T08:00:00', '2026-10-24'],
    ['Cikarang', '2026-10-21T16:30:00', '2026-10-28'],
    ['Cikarang', '2026-10-24T16:30:00', '2026-10-31'],
  ])('%s, confirmed %s WIB → %s', (area, local, expected) => {
    expect(deliveryDate(area, wib(local))).toBe(expected);
  });

  it('uses the Jakarta date and hour, not UTC', () => {
    // 18:00 UTC on Wednesday is 01:00 WIB on Thursday: before the cut-off, so Friday's run.
    expect(deliveryDate('Bekasi Timur', new Date('2026-10-21T18:00:00Z'))).toBe('2026-10-23');
    // 07:30 UTC is 14:30 WIB, still before the cut-off.
    expect(deliveryDate('Bekasi Timur', new Date('2026-10-21T07:30:00Z'))).toBe('2026-10-23');
  });

  it('has no date for an area without a delivery schedule', () => {
    expect(deliveryDate('Bogor', T0)).toBeNull();
  });
});

async function confirmedOrder(db: Db, waId: string, lines: [string, number, string][], s: number) {
  const customer = await customerByWa(db, waId);
  const { order } = await draftOrder(db, {
    customerId: customer.id,
    channel: 'web',
    now: at(s),
    lines: await Promise.all(lines.map(async ([sku, qty, unit]) => ({ productId: await productId(db, sku), qty, unit }))),
  });
  await customerSays(db, waId, 'ya', at(s + 1));
  const r = await confirmOrder(db, { orderId: order.orderId, customerId: customer.id, now: at(s + 2) });
  expect(r.outcome).toBe('confirmed');
  return order.orderId;
}

describe('picking list', () => {
  it('groups confirmed orders still in the warehouse by delivery run, totalled in the largest units', async () => {
    const db = await freshDb();
    // Seeded historic orders have all left the warehouse.
    expect(await pickingList(db)).toEqual([]);

    const sari = await confirmedOrder(db, BU_SARI, [['AQA-600', 1, 'dus'], ['KPA-SMX-25', 2, 'renceng']], 10);
    const dimas = await confirmedOrder(db, DIMAS, [['AQA-600', 30, 'pcs']], 20);
    const yanti = await confirmedOrder(db, YANTI, [['AQA-600', 1, 'dus']], 30);
    // A draft the customer has not confirmed is not picked.
    const sariId = (await customerByWa(db, BU_SARI)).id;
    await draftOrder(db, { customerId: sariId, channel: 'web', now: at(40), lines: [{ productId: await productId(db, 'GLK-1KG'), qty: 1, unit: 'pcs' }] });

    const batches = await pickingList(db);
    // Confirmed Wednesday 10:00 WIB: Bekasi Timur on Friday, Cibitung on Saturday.
    expect(batches.map((b) => [b.date, b.area, b.orders.map((o) => o.orderId)])).toEqual([
      ['2026-10-23', 'Bekasi Timur', [sari, dimas]],
      ['2026-10-24', 'Cibitung', [yanti]],
    ]);
    const timur = batches[0]!;
    expect(timur.lines.find((l) => l.sku === 'AQA-600')).toMatchObject({ baseQty: 24 + 30, quantity: '2 dus + 6 pcs', orders: 2 });
    expect(timur.lines.find((l) => l.sku === 'KPA-SMX-25')).toMatchObject({ orders: 1 });
    expect(timur.orders[0]).toMatchObject({ customer: 'Warung Bu Sari', lines: [expect.objectContaining({ qty: 1, unit: 'dus' }), expect.objectContaining({ qty: 2, unit: 'renceng' })] });
    expect(batches[1]!.lines).toEqual([expect.objectContaining({ sku: 'AQA-600', baseQty: 24, quantity: '1 dus' })]);
  });

  it('marks only confirmed orders that are still in the warehouse as shipped', async () => {
    const db = await freshDb();
    const sari = await confirmedOrder(db, BU_SARI, [['AQA-600', 1, 'dus']], 10);
    const { order: draft } = await draftOrder(db, { customerId: (await customerByWa(db, DIMAS)).id, channel: 'web', now: at(20), lines: [{ productId: await productId(db, 'AQA-600'), qty: 1, unit: 'dus' }] });
    const historic = (await first(db.select().from(orders).where(eq(orders.historic, true))))!;

    expect(await markShipped(db, [sari, draft.orderId, historic.id, 999_999], at(30))).toEqual([sari]);
    expect((await first(db.select().from(orders).where(eq(orders.id, sari))))?.shippedAt).toBe(at(30).toISOString());
    expect((await first(db.select().from(orders).where(eq(orders.id, draft.orderId))))?.shippedAt).toBeNull();
    // Already shipped: not changed again.
    expect(await markShipped(db, [sari], at(40))).toEqual([]);
    expect((await first(db.select().from(orders).where(eq(orders.id, sari))))?.shippedAt).toBe(at(30).toISOString());
    expect(await markShipped(db, [], at(50))).toEqual([]);
    expect(await pickingList(db)).toEqual([]);
  });
});
