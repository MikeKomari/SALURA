import { eq, inArray } from '@salura/db/orm';
import { orderItems, orders, products, productUnits, stock, type Db } from '@salura/db';
import type { OrderView } from '@salura/agent';

// Batched reads for the list screens (Pesanan, Persetujuan). They return exactly what getOrder and
// lineAvailability return for one order, in a fixed number of queries instead of a few per row.

type OrderRow = typeof orders.$inferSelect;

/** getOrder for many order rows: one query for all their lines. */
export async function orderViews(db: Db, rows: OrderRow[]): Promise<Map<number, OrderView>> {
  const ids = rows.map((o) => o.id);
  if (!ids.length) return new Map();
  const lines = await db
    .select({
      orderId: orderItems.orderId,
      productId: orderItems.productId,
      sku: products.sku,
      name: products.name,
      qty: orderItems.qty,
      unit: orderItems.unit,
      unitPrice: orderItems.unitPrice,
      lineTotal: orderItems.lineTotal,
      rawText: orderItems.rawText,
      substitutedFromProductId: orderItems.substitutedFromProductId,
    })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, ids))
    .orderBy(orderItems.id);
  const byOrder = new Map<number, OrderView['lines']>(ids.map((id) => [id, []]));
  for (const { orderId, ...line } of lines) byOrder.get(orderId)!.push(line);
  return new Map(
    rows.map((o) => [
      o.id,
      {
        orderId: o.id,
        customerId: o.customerId,
        status: o.status,
        lines: byOrder.get(o.id)!,
        subtotal: o.subtotal,
        deliveryNote: o.deliveryNote,
        splitFromOrderId: o.splitFromOrderId,
      },
    ]),
  );
}

/** getOrder for many ids; missing orders are left out. */
export async function orderViewsById(db: Db, ids: number[]): Promise<Map<number, OrderView>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  return orderViews(db, await db.select().from(orders).where(inArray(orders.id, unique)));
}

/** lineAvailability for many orders: units, stock and products of every line in three queries. */
export async function lineAvailabilities(db: Db, views: OrderView[]) {
  const productIds = [...new Set(views.flatMap((o) => o.lines.map((l) => l.productId)))];
  const out = new Map<number, { productId: number; unit: string; available: string; enough: boolean }[]>();
  if (!productIds.length) {
    for (const o of views) out.set(o.orderId, []);
    return out;
  }
  const units = await db.select().from(productUnits).where(inArray(productUnits.productId, productIds));
  const stocks = await db.select().from(stock).where(inArray(stock.productId, productIds));
  const baseUnits = await db.select({ id: products.id, baseUnit: products.baseUnit }).from(products).where(inArray(products.id, productIds));
  const factor = (productId: number, unit: string) => units.find((u) => u.productId === productId && u.unit === unit)?.factor ?? 1;
  const available = new Map(stocks.map((s) => [s.productId, Math.max(0, s.onHand - s.reserved)]));
  const baseUnit = new Map(baseUnits.map((p) => [p.id, p.baseUnit]));
  // Same wording as describeQty: "2 dus", "2 dus + 3 pcs" or "13 pcs".
  const describe = (productId: number, baseQty: number, unit: string) => {
    const f = factor(productId, unit);
    if (f > 1) {
      const whole = Math.floor(baseQty / f);
      const rest = baseQty % f;
      return rest ? `${whole} ${unit} + ${rest} ${baseUnit.get(productId)}` : `${whole} ${unit}`;
    }
    return `${baseQty} ${baseUnit.get(productId)}`;
  };
  for (const o of views) {
    const need = new Map<number, number>();
    for (const l of o.lines) need.set(l.productId, (need.get(l.productId) ?? 0) + l.qty * factor(l.productId, l.unit));
    out.set(
      o.orderId,
      o.lines.map((l) => {
        const left = available.get(l.productId) ?? 0;
        return { productId: l.productId, unit: l.unit, available: describe(l.productId, left, l.unit), enough: left >= need.get(l.productId)! };
      }),
    );
  }
  return out;
}
