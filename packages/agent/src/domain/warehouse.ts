import { and, asc, eq, inArray, isNull, sql } from '@salura/db/orm';
import { customers, DELIVERY_DAYS, orderItems, orders, products, productUnits, stock, type Db, type Q } from '@salura/db';

const WIB_OFFSET_MS = 7 * 3_600_000;
/** Policy (pengiriman.md): confirmed before 15:00 WIB → the area's next delivery day, later → the one after. */
const CUTOFF_HOUR_WIB = 15;

/** Delivery date (YYYY-MM-DD, Jakarta) for an order confirmed at `confirmedAt` to `area`. */
export function deliveryDate(area: string, confirmedAt: Date): string | null {
  const days = DELIVERY_DAYS[area];
  if (!days?.length) return null;
  const local = new Date(confirmedAt.getTime() + WIB_OFFSET_MS);
  let skip = local.getUTCHours() >= CUTOFF_HOUR_WIB ? 1 : 0;
  for (let i = 1; i <= 14; i++) {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i));
    if (!days.includes(d.getUTCDay())) continue;
    if (skip-- > 0) continue;
    return d.toISOString().slice(0, 10);
  }
  return null;
}

export interface PickLine {
  productId: number;
  sku: string;
  name: string;
  /** Total in base units, and the same amount written in the largest units ("3 dus + 4 pcs"). */
  baseQty: number;
  quantity: string;
  orders: number;
}

export interface PickBatch {
  date: string | null;
  area: string;
  orders: {
    orderId: number;
    customer: string;
    address: string;
    confirmedAt: string | null;
    subtotal: number;
    deliveryNote: string | null;
    lines: { name: string; qty: number; unit: string }[];
  }[];
  lines: PickLine[];
}

/**
 * Confirmed orders that have not left the warehouse, grouped by delivery date and area, with the
 * quantities to pick per product. Read-only: the agent's orders become the warehouse's work list.
 * Orders approved from a guest's test chat are never picked: they reserved nothing.
 */
export async function pickingList(db: Q): Promise<PickBatch[]> {
  const rows = await db
    .select({ order: orders, customer: { name: customers.name, area: customers.area, address: customers.address } })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.status, 'confirmed'), eq(orders.guest, false), isNull(orders.shippedAt)))
    .orderBy(asc(orders.confirmedAt), asc(orders.id));
  if (!rows.length) return [];

  const ids = rows.map((r) => r.order.id);
  const items = await db
    .select({ orderId: orderItems.orderId, productId: orderItems.productId, qty: orderItems.qty, unit: orderItems.unit, sku: products.sku, name: products.name, baseUnit: products.baseUnit })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, ids))
    .orderBy(asc(orderItems.id));
  const productIds = [...new Set(items.map((i) => i.productId))];
  const units = await db.select().from(productUnits).where(inArray(productUnits.productId, productIds));
  const factor = (productId: number, unit: string) => units.find((u) => u.productId === productId && u.unit === unit)?.factor ?? 1;

  const batches = new Map<string, PickBatch>();
  for (const r of rows) {
    const date = r.order.confirmedAt ? deliveryDate(r.customer.area, new Date(r.order.confirmedAt)) : null;
    const key = `${date ?? '9999'}|${r.customer.area}`;
    let batch = batches.get(key);
    if (!batch) batches.set(key, (batch = { date, area: r.customer.area, orders: [], lines: [] }));
    const own = items.filter((i) => i.orderId === r.order.id);
    batch.orders.push({
      orderId: r.order.id,
      customer: r.customer.name,
      address: r.customer.address,
      confirmedAt: r.order.confirmedAt,
      subtotal: r.order.subtotal,
      deliveryNote: r.order.deliveryNote,
      lines: own.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit })),
    });
    for (const i of own) {
      let line = batch.lines.find((l) => l.productId === i.productId);
      if (!line) batch.lines.push((line = { productId: i.productId, sku: i.sku, name: i.name, baseQty: 0, quantity: '', orders: 0 }));
      line.baseQty += i.qty * factor(i.productId, i.unit);
      line.orders++;
    }
  }

  for (const batch of batches.values()) {
    for (const line of batch.lines) {
      const baseUnit = items.find((i) => i.productId === line.productId)!.baseUnit;
      line.quantity = inLargestUnits(line.baseQty, baseUnit, units.filter((u) => u.productId === line.productId));
    }
    batch.lines.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...batches.values()].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.area.localeCompare(b.area));
}

/** 130 pcs with dus = 40 → "3 dus + 10 pcs". */
function inLargestUnits(baseQty: number, baseUnit: string, units: { unit: string; factor: number }[]): string {
  const parts: string[] = [];
  let left = baseQty;
  for (const u of [...units].filter((x) => x.factor > 1).sort((a, b) => b.factor - a.factor)) {
    const n = Math.floor(left / u.factor);
    if (n > 0) parts.push(`${n} ${u.unit}`);
    left -= n * u.factor;
  }
  if (left > 0 || !parts.length) parts.push(`${left} ${baseUnit}`);
  return parts.join(' + ');
}

/**
 * Marks orders as loaded for delivery. Only real confirmed orders still in the warehouse change. The goods
 * leave the building: their quantities come off both the stock on hand and the reservation made at
 * confirmation, so a later stock count (import) matches what is really on the shelves.
 */
export async function markShipped(db: Db, orderIds: number[], now: Date): Promise<number[]> {
  if (!orderIds.length) return [];
  return db.transaction(async (tx) => {
    const done = await tx
      .update(orders)
      .set({ shippedAt: now.toISOString() })
      .where(and(inArray(orders.id, orderIds), eq(orders.status, 'confirmed'), eq(orders.guest, false), isNull(orders.shippedAt)))
      .returning({ id: orders.id });
    const ids = done.map((d) => d.id);
    if (!ids.length) return [];
    const items = await tx.select().from(orderItems).where(inArray(orderItems.orderId, ids));
    const units = await tx.select().from(productUnits).where(inArray(productUnits.productId, [...new Set(items.map((i) => i.productId))]));
    const baseByProduct = new Map<number, number>();
    for (const i of items) {
      const factor = units.find((u) => u.productId === i.productId && u.unit === i.unit)?.factor ?? 1;
      baseByProduct.set(i.productId, (baseByProduct.get(i.productId) ?? 0) + i.qty * factor);
    }
    for (const [productId, base] of baseByProduct) {
      await tx
        .update(stock)
        .set({ onHand: sql`greatest(0, ${stock.onHand} - ${base})`, reserved: sql`greatest(0, ${stock.reserved} - ${base})` })
        .where(eq(stock.productId, productId));
    }
    return ids;
  });
}
