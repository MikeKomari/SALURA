import { and, desc, eq, inArray } from '@salura/db/orm';
import { customers, first, invoices, orderItems, orders, products, type Q } from '@salura/db';
import { daysBetween } from './money.ts';

export type Customer = typeof customers.$inferSelect;

export function findCustomerByWa(db: Q, waId: string): Promise<Customer | undefined> {
  return first(db.select().from(customers).where(eq(customers.waId, waId)).limit(1));
}

export interface CreditStatus {
  creditLimit: number;
  unpaid: number;
  available: number;
  overdueAmount: number;
  oldestOverdueDays: number;
}

export async function creditStatus(db: Q, customerId: number, now: Date): Promise<CreditStatus> {
  const customer = await first(db.select().from(customers).where(eq(customers.id, customerId)));
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  const open = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.status, 'open')))
    .orderBy(invoices.id);
  return summarizeCredit(customer.creditLimit, open, now);
}

/** creditStatus for many customers in two queries (list screens). Unknown ids are left out. */
export async function creditStatuses(db: Q, customerIds: number[], now: Date): Promise<Map<number, CreditStatus>> {
  const ids = [...new Set(customerIds)];
  if (!ids.length) return new Map();
  const rows = await db.select({ id: customers.id, creditLimit: customers.creditLimit }).from(customers).where(inArray(customers.id, ids));
  const open = await db
    .select()
    .from(invoices)
    .where(and(inArray(invoices.customerId, ids), eq(invoices.status, 'open')))
    .orderBy(invoices.id);
  return new Map(rows.map((c) => [c.id, summarizeCredit(c.creditLimit, open.filter((inv) => inv.customerId === c.id), now)]));
}

function summarizeCredit(creditLimit: number, open: (typeof invoices.$inferSelect)[], now: Date): CreditStatus {
  let unpaid = 0;
  let overdueAmount = 0;
  let oldestOverdueDays = 0;
  for (const inv of open) {
    const outstanding = inv.amount - inv.paidAmount;
    unpaid += outstanding;
    const overdueDays = daysBetween(inv.dueAt, now);
    if (overdueDays > 0) {
      overdueAmount += outstanding;
      oldestOverdueDays = Math.max(oldestOverdueDays, overdueDays);
    }
  }
  return { creditLimit, unpaid, available: creditLimit - unpaid, overdueAmount, oldestOverdueDays };
}

export interface UsualLine {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  unit: string;
  timesOrdered: number;
}

/**
 * "Yang biasa": lines that appear in at least two of the customer's last three confirmed orders,
 * with the quantity and unit from the most recent one. Orders from a guest's test chat never count.
 */
export async function usualOrder(db: Q, customerId: number): Promise<UsualLine[]> {
  const recent = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.status, 'confirmed'), eq(orders.guest, false)))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(3);
  if (!recent.length) return [];

  const items = await db
    .select({ orderId: orderItems.orderId, productId: orderItems.productId, qty: orderItems.qty, unit: orderItems.unit, sku: products.sku, name: products.name })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, recent.map((r) => r.id)))
    .orderBy(orderItems.id);

  const minTimes = recent.length === 1 ? 1 : 2;
  const byProduct = new Map<number, UsualLine>();
  // `recent` is newest first, so the first time we see a product is its latest quantity.
  for (const { id } of recent) {
    for (const it of items.filter((i) => i.orderId === id)) {
      const existing = byProduct.get(it.productId);
      if (existing) existing.timesOrdered++;
      else byProduct.set(it.productId, { productId: it.productId, sku: it.sku, name: it.name, qty: it.qty, unit: it.unit, timesOrdered: 1 });
    }
  }
  return [...byProduct.values()].filter((l) => l.timesOrdered >= minTimes);
}

/** The customer's latest orders; a guest's test chat also sees its own (`guest`), the customer's runs never do. */
export async function recentOrders(db: Q, customerId: number, guest = false, limit = 3) {
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.customerId, customerId), inArray(orders.status, ['confirmed', 'awaiting_approval']), guest ? undefined : eq(orders.guest, false)))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit);
  return Promise.all(
    rows.map(async (o) => ({
      orderId: o.id,
      date: o.createdAt.slice(0, 10),
      status: o.status,
      subtotal: o.subtotal,
      lines: (
        await db
          .select({ name: products.name, qty: orderItems.qty, unit: orderItems.unit })
          .from(orderItems)
          .innerJoin(products, eq(products.id, orderItems.productId))
          .where(eq(orderItems.orderId, o.id))
          .orderBy(orderItems.id)
      ).map((l) => `${l.qty} ${l.unit} ${l.name}`),
    })),
  );
}

export async function openInvoices(db: Q, customerId: number, now: Date) {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.status, 'open')))
    .orderBy(invoices.id);
  return rows.map((inv) => ({
      invoiceId: inv.id,
      number: inv.number,
      outstanding: inv.amount - inv.paidAmount,
      dueAt: inv.dueAt.slice(0, 10),
      daysOverdue: Math.max(0, daysBetween(inv.dueAt, now)),
      promiseToPayAt: inv.promiseToPayAt,
    }));
}
