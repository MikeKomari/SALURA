import { sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import * as s from '../schema.ts';
import { AUTONOMY_DEFAULTS, CUSTOMERS, PRODUCTS, STAFF, SUBSTITUTES, TIER_DISCOUNT } from './data.ts';

const DAY_MS = 86_400_000;

export function isoDaysAgo(days: number, from = Date.now()): string {
  return new Date(from - days * DAY_MS).toISOString();
}

function roundTo100(n: number): number {
  return Math.round(n / 100) * 100;
}

/**
 * Tables holding the synthetic distributor and everything the agent did with it. Accounts,
 * sessions, rate limits, eval reports and the live event stream survive a demo reset.
 */
const DEMO_TABLES = [
  'delivery_checks',
  'bank_statement_lines',
  'payments',
  'staff',
  'audit_log',
  'agent_runs',
  'conversation_state',
  'conversation_locks',
  'messages',
  'media',
  'reminders',
  'approvals',
  'autonomy_policies',
  'invoices',
  'order_items',
  'orders',
  'customers',
  'stock',
  'product_substitutes',
  'product_synonyms',
  'product_prices',
  'product_units',
  'products',
  'settings',
];

/** Deletes every demo row and restarts the id sequences. Used for the one-click demo reset. */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${DEMO_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`));
}

/** Loads the synthetic distributor. Dates are relative to `now` so the demo never goes stale. */
export async function seed(db: Db, now = Date.now()): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(s.products)
      .values(PRODUCTS.map((p) => ({ sku: p.sku, name: p.name, brand: p.brand, category: p.category, baseUnit: p.baseUnit })))
      .returning({ id: s.products.id, sku: s.products.sku });
    const productIds = new Map(inserted.map((r) => [r.sku, r.id]));
    const priceOf = new Map<string, number>();

    const units: (typeof s.productUnits.$inferInsert)[] = [];
    const prices: (typeof s.productPrices.$inferInsert)[] = [];
    const stockRows: (typeof s.stock.$inferInsert)[] = [];
    const synonyms: (typeof s.productSynonyms.$inferInsert)[] = [];
    for (const p of PRODUCTS) {
      const id = productIds.get(p.sku)!;
      for (const [unit, factor] of Object.entries({ [p.baseUnit]: 1, ...p.units })) {
        units.push({ productId: id, unit, factor });
        for (const [tier, discount] of Object.entries(TIER_DISCOUNT)) {
          const unitPrice = roundTo100(p.basePrice * factor * discount);
          prices.push({ productId: id, tier, unit, unitPrice });
          priceOf.set(`${p.sku}|${tier}|${unit}`, unitPrice);
        }
      }
      stockRows.push({ productId: id, onHand: p.stock, reserved: 0 });
      for (const alias of new Set([p.name.toLowerCase(), ...p.aliases])) synonyms.push({ productId: id, alias });
    }
    await tx.insert(s.productUnits).values(units);
    await tx.insert(s.productPrices).values(prices);
    await tx.insert(s.stock).values(stockRows);
    await tx.insert(s.productSynonyms).values(synonyms);
    await tx.insert(s.productSubstitutes).values(
      SUBSTITUTES.flatMap(([sku, subs]) => subs.map((sub, i) => ({ productId: productIds.get(sku)!, substituteId: productIds.get(sub)!, rank: i + 1 }))),
    );

    const customerRows = await tx
      .insert(s.customers)
      .values(CUSTOMERS.map(({ history: _history, ...fields }) => fields))
      .returning({ id: s.customers.id, waId: s.customers.waId });
    const customerIds = new Map(customerRows.map((r) => [r.waId, r.id]));

    // Same order as the original seed: customer by customer, oldest order first.
    const orderRows = CUSTOMERS.flatMap((c) =>
      [...c.history]
        .sort((a, b) => b.daysAgo - a.daysAgo)
        .map((h) => {
          const createdAt = isoDaysAgo(h.daysAgo, now);
          const lines = h.lines.map(([sku, qty, unit]) => {
            const unitPrice = priceOf.get(`${sku}|${c.tier}|${unit}`);
            if (unitPrice === undefined) throw new Error(`No price for ${sku} ${c.tier} ${unit}`);
            return { productId: productIds.get(sku)!, qty, unit, unitPrice, lineTotal: unitPrice * qty };
          });
          return { c, h, createdAt, lines, subtotal: lines.reduce((sum, l) => sum + l.lineTotal, 0) };
        }),
    );
    const orderIds = await tx
      .insert(s.orders)
      .values(
        orderRows.map((o) => ({
          customerId: customerIds.get(o.c.waId)!,
          status: 'confirmed' as const,
          channel: 'whatsapp',
          subtotal: o.subtotal,
          historic: true,
          createdAt: o.createdAt,
          updatedAt: o.createdAt,
          confirmedAt: o.createdAt,
          // Past orders have left the warehouse; only new ones appear on the picking list.
          shippedAt: o.createdAt,
        })),
      )
      .returning({ id: s.orders.id });
    await tx.insert(s.orderItems).values(orderRows.flatMap((o, i) => o.lines.map((l) => ({ orderId: orderIds[i]!.id, ...l }))));
    await tx.insert(s.invoices).values(
      orderRows.map((o, i) => ({
        number: `INV-${String(i + 1).padStart(5, '0')}`,
        customerId: customerIds.get(o.c.waId)!,
        orderId: orderIds[i]!.id,
        amount: o.subtotal,
        paidAmount: o.h.paid ? o.subtotal : 0,
        issuedAt: o.createdAt,
        dueAt: isoDaysAgo(o.h.daysAgo - o.c.paymentTermDays, now),
        status: o.h.paid ? ('paid' as const) : ('open' as const),
      })),
    );

    await tx.insert(s.autonomyPolicies).values(AUTONOMY_DEFAULTS.map((p) => ({ ...p })));
    await tx.insert(s.staff).values(STAFF.map((p) => ({ ...p })));
  });
}
