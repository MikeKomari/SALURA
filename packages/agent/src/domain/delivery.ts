import { and, desc, eq, gte, inArray, ne, sql } from '@salura/db/orm';
import { approvals, customers, deliveryChecks, first, invoices, orders, products, staff, stock, type Db, type Q, type StaffRole } from '@salura/db';
import { canonicalUnit } from './catalog.ts';
import { rupiah } from './money.ts';
import { describeQty, DomainError, getOrder, GUEST_APPROVAL_NOTE, unitFactor, type OrderView } from './orders.ts';

export type LineStatus = 'ok' | 'short' | 'missing' | 'over' | 'not_ordered';

export interface ComparedLine {
  productId: number;
  name: string;
  status: LineStatus;
  ordered: string;
  delivered: string;
  /** Base units delivered minus ordered (negative = short). */
  differenceBase: number;
  /** Value of what was ordered but not delivered, at the order's prices. */
  shortfallValue: number;
  /** Price on the document per unit, when it differs from the order's price. */
  priceMismatch: { unit: string; ordered: number; onDocument: number } | null;
  rawText: string | null;
}

export interface DeliveryComparison {
  orderId: number;
  documentNumber: string | null;
  lines: ComparedLine[];
  orderedValue: number;
  deliveredValue: number;
  invoiceId: number | null;
  invoiceNumber: string | null;
  invoiceAmount: number | null;
  /** Amount on the invoice for goods that were not delivered. */
  overbilled: number;
  matches: boolean;
}

export interface DocumentLine {
  productId: number;
  qty: number;
  unit: string;
  unitPrice?: number;
  rawText?: string;
}

export async function getCheck(db: Q, checkId: number) {
  const check = await first(db.select().from(deliveryChecks).where(eq(deliveryChecks.id, checkId)));
  if (!check) throw new DomainError('check_not_found', `Delivery check ${checkId} not found`);
  return check;
}

export async function createCheck(db: Db, input: { orderId: number; kind: 'surat_jalan' | 'nota'; source: 'console' | 'chat' | 'guest'; mediaId: string; now: Date }) {
  const order = await first(db.select().from(orders).where(eq(orders.id, input.orderId)));
  if (!order) throw new DomainError('order_not_found', `Order ${input.orderId} not found`);
  if (order.status !== 'confirmed') throw new DomainError('invalid_status', `Order ${order.id} is ${order.status}; only confirmed (shipped) orders can be checked against a delivery document`);
  // Before loading, the goods are only reserved: a correction then would release stock that
  // shipping takes off again, so the check waits until the order has left the warehouse.
  if (!order.shippedAt) throw new DomainError('not_shipped', `Order ${order.id} has not left the warehouse yet; a delivery document can be checked once it is marked as loaded`);
  const [row] = await db
    .insert(deliveryChecks)
    .values({ orderId: order.id, kind: input.kind, source: input.source, mediaId: input.mediaId, createdAt: input.now.toISOString() })
    .returning();
  return row!;
}

/**
 * Compares what the document says was delivered (or billed) against the order and its invoice.
 * Deterministic: the model only supplies which product each document line is; every quantity,
 * price and verdict here is computed from the database.
 */
export async function compareDelivery(db: Db, input: { checkId: number; lines: DocumentLine[]; documentNumber?: string | null }): Promise<DeliveryComparison> {
  const check = await getCheck(db, input.checkId);
  const order = (await getOrder(db, check.orderId))!;
  const invoice = await first(db.select().from(invoices).where(eq(invoices.orderId, order.orderId)).orderBy(invoices.id));

  const errors: string[] = [];
  const delivered = new Map<number, { base: number; lines: DocumentLine[] }>();
  for (const raw of input.lines) {
    const unit = canonicalUnit(raw.unit);
    const factor = await unitFactor(db, raw.productId, unit);
    if (factor === undefined) {
      errors.push(`product_id ${raw.productId}: unit "${raw.unit}" is not valid for this product`);
      continue;
    }
    if (!Number.isFinite(raw.qty) || raw.qty < 0 || raw.qty > 10_000) {
      errors.push(`product_id ${raw.productId}: quantity ${raw.qty} is not valid`);
      continue;
    }
    const entry = delivered.get(raw.productId) ?? { base: 0, lines: [] };
    entry.base += raw.qty * factor;
    entry.lines.push({ ...raw, unit });
    delivered.set(raw.productId, entry);
  }
  if (errors.length) throw new DomainError('invalid_lines', 'Some document lines are invalid; fix them and call again', errors);

  const ordered = new Map<number, { base: number; line: OrderView['lines'][number]; pricePerBase: number }>();
  for (const l of order.lines) {
    const factor = (await unitFactor(db, l.productId, l.unit)) ?? 1;
    const prev = ordered.get(l.productId);
    ordered.set(l.productId, { base: (prev?.base ?? 0) + l.qty * factor, line: prev?.line ?? l, pricePerBase: l.unitPrice / factor });
  }

  const productIds = [...new Set([...ordered.keys(), ...delivered.keys()])];
  const names = new Map((await db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, productIds.length ? productIds : [-1]))).map((p) => [p.id, p.name]));
  const lines: ComparedLine[] = [];
  for (const productId of productIds) {
    const o = ordered.get(productId);
    const d = delivered.get(productId);
    const orderedBase = o?.base ?? 0;
    const deliveredBase = d?.base ?? 0;
    const unit = o?.line.unit ?? d?.lines[0]?.unit ?? 'pcs';
    const status: LineStatus = !o ? 'not_ordered' : deliveredBase === 0 ? 'missing' : deliveredBase < orderedBase ? 'short' : deliveredBase > orderedBase ? 'over' : 'ok';
    let priceMismatch: ComparedLine['priceMismatch'] = null;
    for (const dl of d?.lines ?? []) {
      if (dl.unitPrice === undefined || !o) continue;
      const orderedPrice = Math.round(o.pricePerBase * ((await unitFactor(db, productId, dl.unit)) ?? 1));
      if (Math.abs(dl.unitPrice - orderedPrice) >= 1) priceMismatch = { unit: dl.unit, ordered: orderedPrice, onDocument: dl.unitPrice };
    }
    lines.push({
      productId,
      name: names.get(productId) ?? `Produk ${productId}`,
      status,
      ordered: o ? await describeQty(db, productId, orderedBase, unit) : '–',
      delivered: await describeQty(db, productId, deliveredBase, unit),
      differenceBase: deliveredBase - orderedBase,
      shortfallValue: o && deliveredBase < orderedBase ? Math.round((orderedBase - deliveredBase) * o.pricePerBase) : 0,
      priceMismatch,
      rawText: d?.lines.map((l) => l.rawText).filter(Boolean).join(' / ') || null,
    });
  }

  const deliveredValue = Math.round([...ordered.entries()].reduce((s, [id, o]) => s + Math.min(o.base, delivered.get(id)?.base ?? 0) * o.pricePerBase, 0));
  const invoiceAmount = invoice ? invoice.amount : null;
  const comparison: DeliveryComparison = {
    orderId: order.orderId,
    documentNumber: input.documentNumber?.trim() || null,
    lines,
    orderedValue: order.subtotal,
    deliveredValue,
    invoiceId: invoice?.id ?? null,
    invoiceNumber: invoice?.number ?? null,
    invoiceAmount,
    overbilled: invoiceAmount !== null ? Math.max(0, invoiceAmount - deliveredValue) : 0,
    matches: lines.every((l) => l.status === 'ok' && !l.priceMismatch),
  };
  await db
    .update(deliveryChecks)
    .set({ status: comparison.matches ? 'match' : 'mismatch', result: comparison as unknown as Record<string, unknown> })
    .where(eq(deliveryChecks.id, check.id));
  return comparison;
}

async function comparisonOf(db: Q, checkId: number): Promise<DeliveryComparison> {
  const check = await getCheck(db, checkId);
  if (check.status !== 'mismatch' || !check.result) throw new DomainError('no_mismatch', 'Run compare_delivery first; only a check with a mismatch can be followed up');
  return check.result as unknown as DeliveryComparison;
}

function mismatchSummary(c: DeliveryComparison): string {
  return c.lines
    .filter((l) => l.status !== 'ok' || l.priceMismatch)
    .map((l) => {
      const what = { short: 'kurang', missing: 'tidak ada', over: 'lebih', not_ordered: 'tidak dipesan', ok: 'harga beda' }[l.status];
      return `${l.name}: dipesan ${l.ordered}, di dokumen ${l.delivered} (${what})`;
    })
    .join('; ');
}

/** Queues a question to the warehouse or the driver about a mismatch; sent when the owner approves. */
export async function draftStaffQuery(db: Db, input: { checkId: number; recipient: StaffRole; message: string; now: Date; runId?: string }) {
  const comparison = await comparisonOf(db, input.checkId);
  const person = await first(db.select().from(staff).where(eq(staff.role, input.recipient)).orderBy(staff.id));
  if (!person) throw new DomainError('no_staff', `No ${input.recipient} contact is configured`);
  const order = (await first(db.select().from(orders).where(eq(orders.id, comparison.orderId))))!;
  const [row] = await db
    .insert(approvals)
    .values({
      type: 'delivery_query',
      customerId: order.customerId,
      orderId: order.id,
      reason: `Selisih pengiriman pesanan #${order.id}: ${mismatchSummary(comparison)}`,
      payload: { checkId: input.checkId, recipient: input.recipient, staffName: person.name, waId: person.waId, text: input.message.trim() },
      runId: input.runId ?? null,
      requestedAt: input.now.toISOString(),
    })
    .returning({ id: approvals.id });
  return { approvalId: row!.id, recipient: person.name };
}

/**
 * Proposes lowering the invoice by the value of goods not delivered, so the customer is never
 * chased for them. The amount is computed, never chosen by the model. Applied when the owner approves.
 */
export function proposeInvoiceAdjustment(db: Db, input: { checkId: number; reason: string; now: Date; runId?: string }) {
  return db.transaction(async (tx) => {
    const comparison = await comparisonOf(tx, input.checkId);
    if (!comparison.invoiceId || comparison.overbilled <= 0) throw new DomainError('nothing_to_adjust', 'The invoice does not charge for anything undelivered');
    // Locked so two runs cannot both propose a correction for the same invoice.
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, comparison.invoiceId)).for('update');
    // A proposal from a guest's test chat never blocks the customer's real one, nor the other way round.
    const guest = (await getCheck(tx, input.checkId)).source === 'guest';
    const pending = await first(
      tx
        .select({ id: approvals.id })
        .from(approvals)
        .innerJoin(deliveryChecks, eq(deliveryChecks.id, sql`(${approvals.payload} ->> 'checkId')::int`))
        .where(
          and(
            eq(approvals.type, 'invoice_adjustment'),
            eq(approvals.status, 'pending'),
            eq(approvals.orderId, comparison.orderId),
            guest ? eq(deliveryChecks.source, 'guest') : ne(deliveryChecks.source, 'guest'),
          ),
        )
        .limit(1),
    );
    if (pending) throw new DomainError('already_proposed', `An adjustment for invoice ${invoice!.number} is already waiting for approval`);
    // A comparison made before an earlier correction was applied would correct the invoice twice.
    if (comparison.invoiceAmount !== invoice!.amount) throw new DomainError('comparison_stale', `Invoice ${invoice!.number} changed since this comparison; run compare_delivery again`);
    return insertAdjustment(tx, input, comparison, invoice!);
  });
}

async function insertAdjustment(
  tx: Q,
  input: { checkId: number; reason: string; now: Date; runId?: string },
  comparison: DeliveryComparison,
  invoice: typeof invoices.$inferSelect,
) {
  const credit = Math.min(comparison.overbilled, invoice.amount);
  // An invoice already (partly) paid can end up below what the customer paid: they are then owed money.
  const overpaid = Math.max(0, invoice.paidAmount - (invoice.amount - credit));
  const [row] = await tx
    .insert(approvals)
    .values({
      type: 'invoice_adjustment',
      customerId: invoice.customerId,
      orderId: comparison.orderId,
      reason: `${invoice.number} menagih ${rupiah(credit)} untuk barang yang tidak terkirim. ${input.reason}${
        overpaid ? ` Pelanggan sudah membayar ${rupiah(invoice.paidAmount)}, jadi setelah koreksi ada lebih bayar ${rupiah(overpaid)} yang perlu dikembalikan atau dipotong dari tagihan berikutnya.` : ''
      }`,
      payload: {
        checkId: input.checkId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        from: invoice.amount,
        to: invoice.amount - credit,
        credit,
        paidAmount: invoice.paidAmount,
        overpaid,
        lines: comparison.lines.filter((l) => l.shortfallValue > 0).map((l) => ({ productId: l.productId, name: l.name, ordered: l.ordered, delivered: l.delivered, differenceBase: l.differenceBase, value: l.shortfallValue })),
      },
      runId: input.runId ?? null,
      requestedAt: input.now.toISOString(),
    })
    .returning({ id: approvals.id });
  return { approvalId: row!.id, invoiceNumber: invoice.number, invoiceFrom: invoice.amount, invoiceTo: invoice.amount - credit, credit, overpaid };
}

/** Owner's decision on a staff query: approve returns the message to send to that staff member. */
export function decideDeliveryQuery(db: Db, input: { approvalId: number; decision: 'approve' | 'reject'; decidedBy: string; note?: string; now: Date }) {
  return db.transaction(async (tx) => {
    const approval = await first(tx.select().from(approvals).where(eq(approvals.id, input.approvalId)).for('update'));
    if (!approval || approval.status !== 'pending' || approval.type !== 'delivery_query') throw new DomainError('approval_not_pending', `Approval ${input.approvalId} is not a pending staff query`);
    await tx
      .update(approvals)
      .set({ status: input.decision === 'approve' ? 'approved' : 'rejected', decidedBy: input.decidedBy, decidedAt: input.now.toISOString(), decisionNote: input.note ?? null })
      .where(eq(approvals.id, approval.id));
    if (input.decision === 'reject') return null;
    const p = approval.payload as { checkId: number; waId: string; text: string };
    // A question drafted in a guest's test chat is approved on paper only: staff are never messaged.
    if ((await getCheck(tx, p.checkId)).source === 'guest') return null;
    return { waId: p.waId, text: p.text };
  });
}

/**
 * Applies an approved invoice correction: lowers the invoice, releases the stock reserved for goods
 * that never left, and returns the message telling the customer their bill changed. A correction
 * below what was already paid closes the invoice with paidAmount above amount: that difference is
 * the customer's overpayment, listed on the Penagihan screen until the owner settles it.
 */
export function decideInvoiceAdjustment(db: Db, input: { approvalId: number; decision: 'approve' | 'reject'; decidedBy: string; note?: string; now: Date }) {
  return db.transaction(async (tx) => {
    const approval = await first(tx.select().from(approvals).where(eq(approvals.id, input.approvalId)).for('update'));
    if (!approval || approval.status !== 'pending' || approval.type !== 'invoice_adjustment') throw new DomainError('approval_not_pending', `Approval ${input.approvalId} is not a pending invoice adjustment`);
    const p = approval.payload as { checkId: number; invoiceId: number; credit: number; from: number; lines: { productId: number; differenceBase: number }[] };
    const invoice = await first(tx.select().from(invoices).where(eq(invoices.id, p.invoiceId)).for('update'));
    // A correction proposed from a guest's test chat is approved on paper only: the invoice and stock stay.
    const guest = (await getCheck(tx, p.checkId)).source === 'guest';
    let overpaid = 0;
    if (input.decision === 'approve' && !guest) {
      if (!invoice || invoice.amount !== p.from) throw new DomainError('adjustment_stale', 'Tagihan ini sudah berubah sejak penyesuaian diusulkan. Pilih "Tolak" lalu cek ulang surat jalannya.');
      const amount = invoice.amount - p.credit;
      const settled = invoice.paidAmount >= amount;
      // Measured now, not when proposed: a payment may have been approved in between.
      overpaid = Math.max(0, invoice.paidAmount - amount);
      await tx
        .update(invoices)
        .set({ amount, status: settled ? 'paid' : 'open', promiseToPayAt: settled ? null : invoice.promiseToPayAt })
        .where(eq(invoices.id, invoice.id));
      // Goods that never reached the customer: if the order already left the warehouse (its stock
      // was taken off on loading), they are back on the shelf; otherwise they were only reserved.
      const [order] = approval.orderId ? await tx.select({ shippedAt: orders.shippedAt }).from(orders).where(eq(orders.id, approval.orderId)) : [];
      for (const l of [...p.lines].sort((a, b) => a.productId - b.productId)) {
        const short = Math.max(0, -l.differenceBase);
        if (short <= 0) continue;
        await tx
          .update(stock)
          .set(order?.shippedAt && approval.orderId ? { onHand: sql`${stock.onHand} + ${short}` } : { reserved: sql`greatest(0, ${stock.reserved} - ${short})` })
          .where(eq(stock.productId, l.productId));
      }
    }
    await tx
      .update(approvals)
      .set({ status: input.decision === 'approve' ? 'approved' : 'rejected', decidedBy: input.decidedBy, decidedAt: input.now.toISOString(), decisionNote: input.note ?? null })
      .where(eq(approvals.id, approval.id));
    if (input.decision === 'reject' || !invoice) return null;
    const customer = (await first(tx.select().from(customers).where(eq(customers.id, invoice.customerId))))!;
    if (guest) {
      return {
        waId: customer.waId,
        text: `${customer.honorific} ${customer.ownerName.split(' ')[0]}, tagihan ${invoice.number} kami sesuaikan dari ${rupiah(p.from)} menjadi ${rupiah(p.from - p.credit)} karena ada barang yang kurang terkirim. ${GUEST_APPROVAL_NOTE}`,
      };
    }
    const text = `${customer.honorific} ${customer.ownerName.split(' ')[0]}, tagihan ${invoice.number} kami sesuaikan dari ${rupiah(invoice.amount)} menjadi ${rupiah(invoice.amount - p.credit)} karena ada barang yang kurang terkirim.${
      overpaid ? ` Pembayaran ${rupiah(invoice.paidAmount)} yang sudah kami terima jadi lebih ${rupiah(overpaid)}; admin kami akan menghubungi untuk mengembalikannya atau memotongnya dari tagihan berikutnya.` : ''
    } Mohon maaf atas ketidaknyamanannya 🙏`;
    return { waId: customer.waId, text };
  });
}

/** Recently shipped orders with their latest delivery check, for the Pengiriman screen. */
export async function deliveryOverview(db: Q, now: Date, days = 21) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = await db
    .select({ order: orders, customer: { id: customers.id, name: customers.name, waId: customers.waId, area: customers.area } })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.status, 'confirmed'), eq(orders.guest, false), gte(orders.createdAt, since)))
    .orderBy(desc(orders.createdAt), desc(orders.id));
  return Promise.all(
    rows.map(async (r) => {
      const checks = await db.select().from(deliveryChecks).where(eq(deliveryChecks.orderId, r.order.id)).orderBy(desc(deliveryChecks.id));
      // Checks opened from a guest account's test chat never stand for the order's delivery status.
      const real = checks.filter((ch) => ch.source !== 'guest');
      return { ...(await getOrder(db, r.order.id))!, customer: r.customer, createdAt: r.order.createdAt, shippedAt: r.order.shippedAt, latestCheck: real[0] ?? null, checks: real.length };
    }),
  );
}
