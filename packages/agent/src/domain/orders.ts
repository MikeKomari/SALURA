import { and, desc, eq, gt, gte, inArray, lte, sql } from '@salura/db/orm';
import {
  approvals,
  autonomyPolicies,
  customers,
  first,
  invoices,
  messages,
  orderItems,
  orders,
  payments,
  productPrices,
  products,
  productSubstitutes,
  productUnits,
  stock,
  type AutonomyAction,
  type Db,
  type OrderStatus,
  type Q,
} from '@salura/db';
import { creditStatus, type Customer } from './customers.ts';
import { canonicalUnit } from './catalog.ts';
import { rupiah } from './money.ts';

/** A rule the agent tried to break, or a request that cannot be carried out. Returned to the model as a tool error. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export interface LineInput {
  productId: number;
  qty: number;
  unit: string;
  rawText?: string;
  matchConfidence?: number;
  substitutedFromProductId?: number;
}

export interface OrderLineView {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
  rawText: string | null;
  substitutedFromProductId: number | null;
}

export interface OrderView {
  orderId: number;
  customerId: number;
  status: OrderStatus;
  lines: OrderLineView[];
  subtotal: number;
  deliveryNote: string | null;
  splitFromOrderId: number | null;
}

export type OrderIssue =
  | {
      type: 'out_of_stock';
      productId: number;
      name: string;
      requested: string;
      available: string;
      substitutes: { productId: number; name: string; available: string; unitPrice: number | null; unit: string }[];
    }
  | { type: 'over_credit'; availableCredit: number; subtotal: number; shortfall: number }
  | { type: 'low_confidence'; productId: number; name: string; rawText: string | null; confidence: number };

const ACTIVE_DRAFT: OrderStatus[] = ['draft', 'awaiting_customer'];
const LOW_CONFIDENCE = 0.75;
/** Added to the answer when the owner approves something from a guest's test chat: nothing real changed. */
export const GUEST_APPROVAL_NOTE = '(Chat uji tamu: persetujuan ini hanya simulasi, stok, gudang dan tagihan tidak berubah.)';
/** Policy (pembayaran.md): new orders are held when an invoice is more than this many days overdue. */
export const OVERDUE_HOLD_DAYS = 14;
const MAX_QTY = 1000;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPolicy(db: Q, action: AutonomyAction) {
  const p = await first(db.select().from(autonomyPolicies).where(eq(autonomyPolicies.action, action)));
  return p ?? { action, mode: 'approve' as const, maxAutoAmount: null };
}

/** The owner's policy, or "approve" whatever it says for orders placed in a guest account's test chat. */
function policyFor(db: Q, action: AutonomyAction, guest?: boolean) {
  return guest ? { action, mode: 'approve' as const, maxAutoAmount: null } : getPolicy(db, action);
}

export async function unitFactor(db: Q, productId: number, unit: string): Promise<number | undefined> {
  const row = await first(
    db
      .select({ factor: productUnits.factor })
      .from(productUnits)
      .where(and(eq(productUnits.productId, productId), eq(productUnits.unit, unit))),
  );
  return row?.factor;
}

export async function priceFor(db: Q, productId: number, tier: string, unit: string): Promise<number | undefined> {
  const row = await first(
    db
      .select({ p: productPrices.unitPrice })
      .from(productPrices)
      .where(and(eq(productPrices.productId, productId), eq(productPrices.tier, tier), eq(productPrices.unit, unit))),
  );
  return row?.p;
}

/** Base units not yet promised to another order. */
export async function availableBase(db: Q, productId: number): Promise<number> {
  const s = await first(db.select().from(stock).where(eq(stock.productId, productId)));
  return s ? Math.max(0, s.onHand - s.reserved) : 0;
}

/** "2 dus" or "13 pcs": how much of a product is available, in the unit the customer asked for when it fits. */
export async function describeQty(db: Q, productId: number, baseQty: number, preferredUnit: string): Promise<string> {
  const product = (await first(db.select().from(products).where(eq(products.id, productId))))!;
  const factor = (await unitFactor(db, productId, preferredUnit)) ?? 1;
  if (factor > 1) {
    const whole = Math.floor(baseQty / factor);
    const rest = baseQty % factor;
    return rest ? `${whole} ${preferredUnit} + ${rest} ${product.baseUnit}` : `${whole} ${preferredUnit}`;
  }
  return `${baseQty} ${product.baseUnit}`;
}

export async function getOrder(db: Q, orderId: number): Promise<OrderView | undefined> {
  const o = await first(db.select().from(orders).where(eq(orders.id, orderId)));
  if (!o) return undefined;
  const lines = await db
    .select({
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
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.id);
  return {
    orderId: o.id,
    customerId: o.customerId,
    status: o.status,
    lines,
    subtotal: o.subtotal,
    deliveryNote: o.deliveryNote,
    splitFromOrderId: o.splitFromOrderId,
  };
}

/** Stock right now for each line of an order that has not reserved it yet (e.g. held for approval). */
export async function lineAvailability(db: Q, order: OrderView): Promise<{ productId: number; unit: string; available: string; enough: boolean }[]> {
  const needByProduct = new Map<number, number>();
  for (const l of order.lines) needByProduct.set(l.productId, (needByProduct.get(l.productId) ?? 0) + l.qty * ((await unitFactor(db, l.productId, l.unit)) ?? 1));
  const out = [];
  for (const l of order.lines) {
    const available = await availableBase(db, l.productId);
    out.push({ productId: l.productId, unit: l.unit, available: await describeQty(db, l.productId, available, l.unit), enough: available >= needByProduct.get(l.productId)! });
  }
  return out;
}

/** The customer's open draft; a guest account's test chat has drafts of its own (`guest`). */
export async function activeDraft(db: Q, customerId: number, guest = false): Promise<OrderView | undefined> {
  const o = await first(
    db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.customerId, customerId), inArray(orders.status, ACTIVE_DRAFT), eq(orders.guest, guest)))
      .orderBy(desc(orders.id))
      .limit(1),
  );
  return o ? getOrder(db, o.id) : undefined;
}

/**
 * Loads the order and locks its row until the transaction ends, so two decisions cannot interleave.
 * A guest's test chat sees only its own orders, and the customer's own runs never see those.
 */
async function loadOwnedOrder(db: Q, orderId: number, customerId: number, guest = false) {
  const o = await first(db.select().from(orders).where(eq(orders.id, orderId)).for('update'));
  if (!o || o.customerId !== customerId || o.guest !== guest) throw new DomainError('order_not_found', `Order ${orderId} not found for this customer`);
  return o;
}

async function getCustomer(db: Q, customerId: number): Promise<Customer> {
  const c = await first(db.select().from(customers).where(eq(customers.id, customerId)));
  if (!c) throw new DomainError('customer_not_found', `Customer ${customerId} not found`);
  return c;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface PricedLine extends LineInput {
  unitPrice: number;
  factor: number;
  lineTotal: number;
}

/** Checks product, unit and quantity, and prices every line from the price list. Never trusts prices from the model. */
async function priceLines(db: Q, tier: string, lines: LineInput[]): Promise<PricedLine[]> {
  if (!lines.length) throw new DomainError('empty_order', 'An order needs at least one line');
  const errors: string[] = [];
  const merged = new Map<string, PricedLine>();

  for (const raw of lines) {
    const unit = canonicalUnit(raw.unit);
    const product = await first(db.select().from(products).where(eq(products.id, raw.productId)));
    if (!product || !product.active) {
      errors.push(`product_id ${raw.productId} does not exist`);
      continue;
    }
    if (!Number.isInteger(raw.qty) || raw.qty <= 0 || raw.qty > MAX_QTY) {
      errors.push(`${product.name}: quantity must be a whole number between 1 and ${MAX_QTY} (got ${raw.qty})`);
      continue;
    }
    const factor = await unitFactor(db, product.id, unit);
    if (factor === undefined) {
      const allowed = (await db.select({ unit: productUnits.unit }).from(productUnits).where(eq(productUnits.productId, product.id)).orderBy(productUnits.factor)).map((u) => u.unit);
      errors.push(`${product.name} is not sold per "${raw.unit}". Allowed units: ${allowed.join(', ')}`);
      continue;
    }
    const unitPrice = await priceFor(db, product.id, tier, unit);
    if (unitPrice === undefined) {
      errors.push(`${product.name}: no price for tier ${tier} per ${unit}`);
      continue;
    }
    const key = `${product.id}|${unit}`;
    const existing = merged.get(key);
    if (existing) {
      existing.qty += raw.qty;
      existing.lineTotal = existing.qty * unitPrice;
    } else {
      merged.set(key, { ...raw, unit, unitPrice, factor, lineTotal: raw.qty * unitPrice });
    }
  }
  if (errors.length) throw new DomainError('invalid_lines', 'Some lines are invalid; fix them and call again', errors);
  return [...merged.values()];
}

async function stockIssues(db: Q, tier: string, lines: Pick<PricedLine, 'productId' | 'qty' | 'unit' | 'factor'>[]): Promise<OrderIssue[]> {
  const needByProduct = new Map<number, { base: number; unit: string }>();
  for (const l of lines) {
    const prev = needByProduct.get(l.productId);
    needByProduct.set(l.productId, { base: (prev?.base ?? 0) + l.qty * l.factor, unit: prev?.unit ?? l.unit });
  }
  const issues: OrderIssue[] = [];
  for (const [productId, need] of needByProduct) {
    const available = await availableBase(db, productId);
    if (available >= need.base) continue;
    const product = (await first(db.select().from(products).where(eq(products.id, productId))))!;
    const subRows = await db
      .select({ id: products.id, name: products.name, baseUnit: products.baseUnit })
      .from(productSubstitutes)
      .innerJoin(products, eq(products.id, productSubstitutes.substituteId))
      .where(eq(productSubstitutes.productId, productId))
      .orderBy(productSubstitutes.rank);
    const subs = [];
    for (const s of subRows) {
      const unit = (await unitFactor(db, s.id, need.unit)) !== undefined ? need.unit : s.baseUnit;
      subs.push({ productId: s.id, name: s.name, available: await describeQty(db, s.id, await availableBase(db, s.id), unit), unitPrice: (await priceFor(db, s.id, tier, unit)) ?? null, unit });
    }
    issues.push({
      type: 'out_of_stock',
      productId,
      name: product.name,
      requested: await describeQty(db, productId, need.base, need.unit),
      available: await describeQty(db, productId, available, need.unit),
      substitutes: subs,
    });
  }
  return issues;
}

/**
 * Consent guard: the customer must have been sent the current version of the order (a run that
 * finished normally, or an approved offer) and must have replied after that.
 */
async function assertCustomerReplied(db: Q, customer: Customer, order: { updatedAt: string; summarySentAt: string | null; guest: boolean }) {
  const shown = order.summarySentAt !== null && order.summarySentAt >= order.updatedAt;
  // Only a reply from the same side counts: a guest typing "ya" never confirms the customer's order.
  const reply = shown
    ? await first(
        db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.waId, customer.waId), eq(messages.direction, 'in'), eq(messages.guest, order.guest), gt(messages.createdAt, order.summarySentAt!)))
          .limit(1),
      )
    : undefined;
  if (!reply) {
    throw new DomainError(
      'needs_customer_confirmation',
      'The customer has not replied since this order was last drafted. Send them the order summary and wait for their confirmation.',
    );
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Records that the customer's open draft (or the guest's, in a guest chat), as it is now, has been delivered. */
export async function markSummarySent(db: Q, customerId: number, at: string, guest = false): Promise<void> {
  await db
    .update(orders)
    .set({ summarySentAt: at })
    .where(and(eq(orders.customerId, customerId), inArray(orders.status, ACTIVE_DRAFT), eq(orders.guest, guest), lte(orders.updatedAt, at)));
}

export interface DraftResult {
  order: OrderView;
  issues: OrderIssue[];
  replacedPreviousDraft: boolean;
}

/** Creates the customer's draft order, or replaces the lines of their open draft. */
export async function draftOrder(
  db: Db,
  input: { customerId: number; channel: string; lines: LineInput[]; deliveryNote?: string | null; now: Date; guest?: boolean },
): Promise<DraftResult> {
  const guest = input.guest ?? false;
  const customer = await getCustomer(db, input.customerId);
  const priced = await priceLines(db, customer.tier, input.lines);
  const subtotal = priced.reduce((s, l) => s + l.lineTotal, 0);
  const nowIso = input.now.toISOString();

  const { orderId, replaced } = await db.transaction(async (tx) => {
    // Lock the customer row: two messages from one customer must not both create a draft.
    await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, customer.id)).for('update');
    const existing = await activeDraft(tx, customer.id, guest);
    let orderId: number;
    if (existing) {
      orderId = existing.orderId;
      await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await tx
        .update(orders)
        .set({ status: 'awaiting_customer', subtotal, deliveryNote: input.deliveryNote ?? existing.deliveryNote, updatedAt: nowIso })
        .where(eq(orders.id, orderId));
    } else {
      const [row] = await tx
        .insert(orders)
        .values({ customerId: customer.id, status: 'awaiting_customer', channel: input.channel, subtotal, deliveryNote: input.deliveryNote ?? null, guest, createdAt: nowIso, updatedAt: nowIso })
        .returning({ id: orders.id });
      orderId = row!.id;
    }
    await tx.insert(orderItems).values(
      priced.map((l) => ({
        orderId,
        productId: l.productId,
        qty: l.qty,
        unit: l.unit,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        rawText: l.rawText ?? null,
        matchConfidence: l.matchConfidence ?? null,
        substitutedFromProductId: l.substitutedFromProductId ?? null,
      })),
    );
    return { orderId, replaced: Boolean(existing) };
  });

  // A queued reorder offer is stale once the customer orders on their own; withdraw it. A guest's
  // test order says nothing about what the customer wants.
  if (!guest) {
    await db
      .update(approvals)
      .set({ status: 'rejected', decidedBy: 'Sistem', decidedAt: nowIso, decisionNote: 'Ditarik otomatis: pelanggan memesan sendiri sebelum tawaran dikirim' })
      .where(and(eq(approvals.customerId, customer.id), eq(approvals.type, 'reorder'), eq(approvals.status, 'pending')));
  }

  const issues: OrderIssue[] = await stockIssues(db, customer.tier, priced);
  const credit = await creditStatus(db, customer.id, input.now);
  if (subtotal > credit.available) {
    issues.push({ type: 'over_credit', availableCredit: credit.available, subtotal, shortfall: subtotal - credit.available });
  }
  for (const l of priced) {
    if (l.matchConfidence !== undefined && l.matchConfidence < LOW_CONFIDENCE) {
      const name = (await first(db.select().from(products).where(eq(products.id, l.productId))))!.name;
      issues.push({ type: 'low_confidence', productId: l.productId, name, rawText: l.rawText ?? null, confidence: l.matchConfidence });
    }
  }
  return { order: (await getOrder(db, orderId))!, issues, replacedPreviousDraft: replaced };
}

/** Inserts an invoice numbered after its own id (INV-00019 for id 19), so concurrent orders never collide. */
export async function insertInvoice(tx: Q, values: Omit<typeof invoices.$inferInsert, 'number'>) {
  const [row] = await tx.insert(invoices).values({ ...values, number: `PENDING-${crypto.randomUUID()}` }).returning({ id: invoices.id });
  const number = `INV-${String(row!.id).padStart(5, '0')}`;
  await tx.update(invoices).set({ number }).where(eq(invoices.id, row!.id));
  return { id: row!.id, number };
}

/** Reserves stock, marks the order confirmed and raises the invoice. Caller has done every check. */
async function finalize(tx: Q, orderId: number, now: Date) {
  const order = (await getOrder(tx, orderId))!;
  const customer = await getCustomer(tx, order.customerId);
  // Rows are locked in product order, so two orders with the same products can never deadlock.
  for (const l of [...order.lines].sort((a, b) => a.productId - b.productId)) {
    const factor = (await unitFactor(tx, l.productId, l.unit)) ?? 1;
    const base = l.qty * factor;
    // Check and reserve in one statement: a concurrent order can never take the same units.
    const reserved = await tx
      .update(stock)
      .set({ reserved: sql`${stock.reserved} + ${base}` })
      .where(and(eq(stock.productId, l.productId), gte(sql`${stock.onHand} - ${stock.reserved}`, base)))
      .returning({ productId: stock.productId });
    if (!reserved.length) {
      throw new DomainError('out_of_stock', `${l.name} no longer has enough stock (${await describeQty(tx, l.productId, await availableBase(tx, l.productId), l.unit)} left)`);
    }
  }
  const nowIso = now.toISOString();
  await tx.update(orders).set({ status: 'confirmed', confirmedAt: nowIso, updatedAt: nowIso }).where(eq(orders.id, orderId));
  await insertInvoice(tx, {
    customerId: customer.id,
    orderId,
    amount: order.subtotal,
    issuedAt: nowIso,
    dueAt: new Date(now.getTime() + customer.paymentTermDays * 86_400_000).toISOString(),
  });
}

async function holdForApproval(
  tx: Q,
  input: { orderId: number; customerId: number; type: 'order' | 'credit_override'; reason: string; runId?: string; payload?: Record<string, unknown>; now: Date },
): Promise<number> {
  await tx.update(orders).set({ status: 'awaiting_approval', updatedAt: input.now.toISOString() }).where(eq(orders.id, input.orderId));
  const [row] = await tx
    .insert(approvals)
    .values({ type: input.type, orderId: input.orderId, customerId: input.customerId, reason: input.reason, runId: input.runId ?? null, payload: input.payload ?? null, requestedAt: input.now.toISOString() })
    .returning({ id: approvals.id });
  return row!.id;
}

export type ConfirmResult =
  | { outcome: 'confirmed'; order: OrderView }
  | { outcome: 'awaiting_approval'; order: OrderView; approvalId: number; reason: string }
  | { outcome: 'blocked_over_credit'; order: OrderView; availableCredit: number; shortfall: number; canSplit: boolean };

/** Applies the confirm_order autonomy policy to an order whose credit and stock checks have passed. */
async function confirmWithinCredit(tx: Q, order: OrderView, now: Date, runId?: string, guest?: boolean): Promise<ConfirmResult> {
  const policy = await policyFor(tx, 'confirm_order', guest);
  const overAutoLimit = policy.maxAutoAmount !== null && order.subtotal > policy.maxAutoAmount;
  if (policy.mode === 'auto' && !overAutoLimit) {
    await finalize(tx, order.orderId, now);
    return { outcome: 'confirmed', order: (await getOrder(tx, order.orderId))! };
  }
  const reason = guest
    ? 'Pesanan dari chat uji akun tamu. Disetujui pun hanya simulasi: stok tidak dipesan, tagihan tidak dibuat dan pesanan tidak masuk gudang.'
    : overAutoLimit
      ? `Total pesanan ${rupiah(order.subtotal)} melebihi batas konfirmasi otomatis ${rupiah(policy.maxAutoAmount!)}.`
      : 'Pengaturan otonomi saat ini mewajibkan admin mengonfirmasi setiap pesanan.';
  const approvalId = await holdForApproval(tx, { orderId: order.orderId, customerId: order.customerId, type: 'order', reason, runId, now });
  return { outcome: 'awaiting_approval', order: (await getOrder(tx, order.orderId))!, approvalId, reason };
}

async function withFactors(tx: Q, order: OrderView) {
  const out = [];
  for (const l of order.lines) out.push({ ...l, factor: (await unitFactor(tx, l.productId, l.unit)) ?? 1 });
  return out;
}

export function confirmOrder(db: Db, input: { orderId: number; customerId: number; now: Date; runId?: string; guest?: boolean }): Promise<ConfirmResult> {
  return db.transaction(async (tx): Promise<ConfirmResult> => {
    const raw = await loadOwnedOrder(tx, input.orderId, input.customerId, input.guest);
    if (!ACTIVE_DRAFT.includes(raw.status)) throw new DomainError('invalid_status', `Order ${raw.id} is ${raw.status}, not a draft`);
    const customer = await getCustomer(tx, raw.customerId);
    await assertCustomerReplied(tx, customer, raw);

    const order = (await getOrder(tx, raw.id))!;
    const stockProblems = await stockIssues(tx, customer.tier, await withFactors(tx, order));
    if (stockProblems.length) throw new DomainError('out_of_stock', 'Resolve out-of-stock lines before confirming', stockProblems);

    const credit = await creditStatus(tx, customer.id, input.now);
    const overCredit = await policyFor(tx, 'over_credit_order', input.guest);
    if (credit.oldestOverdueDays > OVERDUE_HOLD_DAYS && overCredit.mode !== 'auto') {
      const reason = `Pelanggan punya tagihan terlambat ${rupiah(credit.overdueAmount)}, yang terlama ${credit.oldestOverdueDays} hari. Aturan distributor: pesanan ditahan bila ada tagihan terlambat lebih dari ${OVERDUE_HOLD_DAYS} hari.`;
      const approvalId = await holdForApproval(tx, {
        orderId: order.orderId,
        customerId: customer.id,
        type: 'credit_override',
        reason,
        runId: input.runId,
        payload: { creditLimit: credit.creditLimit, unpaid: credit.unpaid, overdueAmount: credit.overdueAmount, oldestOverdueDays: credit.oldestOverdueDays },
        now: input.now,
      });
      return { outcome: 'awaiting_approval', order: (await getOrder(tx, order.orderId))!, approvalId, reason };
    }
    if (order.subtotal > credit.available) {
      if (overCredit.mode !== 'auto') {
        return {
          outcome: 'blocked_over_credit',
          order,
          availableCredit: credit.available,
          shortfall: order.subtotal - credit.available,
          canSplit: credit.available > Math.min(...order.lines.map((l) => l.unitPrice)),
        };
      }
    }
    return confirmWithinCredit(tx, order, input.now, input.runId, input.guest);
  });
}

export interface SplitResult {
  confirmedPart: ConfirmResult;
  heldOrder: OrderView;
  approvalId: number;
}

/**
 * Over-limit order: confirms the part that fits the customer's available credit
 * and holds the rest as a new order waiting for the owner's approval.
 */
export function splitOrder(db: Db, input: { orderId: number; customerId: number; now: Date; runId?: string; guest?: boolean }): Promise<SplitResult> {
  // A split queues two approvals; a guest's test order is held whole as one.
  if (input.guest) return Promise.reject(new DomainError('guest_no_split', 'In a guest test chat the whole order waits for the owner: call request_approval instead of split_order'));
  return db.transaction(async (tx) => {
    const raw = await loadOwnedOrder(tx, input.orderId, input.customerId);
    if (!ACTIVE_DRAFT.includes(raw.status)) throw new DomainError('invalid_status', `Order ${raw.id} is ${raw.status}, not a draft`);
    const customer = await getCustomer(tx, raw.customerId);
    await assertCustomerReplied(tx, customer, raw);
    const order = (await getOrder(tx, raw.id))!;
    const credit = await creditStatus(tx, customer.id, input.now);
    if (credit.oldestOverdueDays > OVERDUE_HOLD_DAYS && (await getPolicy(tx, 'over_credit_order')).mode !== 'auto') {
      // Splitting would confirm part of the order despite the overdue hold.
      throw new DomainError('overdue_hold', `Customer has an invoice ${credit.oldestOverdueDays} days overdue; call confirm_order, which holds the whole order for the owner`);
    }
    if (order.subtotal <= credit.available) throw new DomainError('not_over_credit', 'Order fits the credit limit; call confirm_order instead');

    let budget = credit.available;
    const keep: OrderLineView[] = [];
    const hold: OrderLineView[] = [];
    for (const l of order.lines) {
      const fit = Math.max(0, Math.min(l.qty, Math.floor(budget / l.unitPrice)));
      if (fit > 0) {
        keep.push({ ...l, qty: fit, lineTotal: fit * l.unitPrice });
        budget -= fit * l.unitPrice;
      }
      if (fit < l.qty) hold.push({ ...l, qty: l.qty - fit, lineTotal: (l.qty - fit) * l.unitPrice });
    }
    if (!keep.length) throw new DomainError('cannot_split', `Available credit ${rupiah(credit.available)} does not cover even one unit; hold the whole order with request_approval`);

    const nowIso = input.now.toISOString();
    const writeLines = async (orderId: number, lines: OrderLineView[]) => {
      await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await tx.insert(orderItems).values(
        lines.map((l) => ({ orderId, productId: l.productId, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, lineTotal: l.lineTotal, rawText: l.rawText, substitutedFromProductId: l.substitutedFromProductId })),
      );
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      await tx.update(orders).set({ subtotal, updatedAt: nowIso }).where(eq(orders.id, orderId));
    };

    await writeLines(order.orderId, keep);
    const [heldRow] = await tx
      .insert(orders)
      .values({ customerId: customer.id, status: 'awaiting_approval', channel: raw.channel, deliveryNote: raw.deliveryNote, splitFromOrderId: order.orderId, createdAt: nowIso, updatedAt: nowIso })
      .returning({ id: orders.id });
    const heldId = heldRow!.id;
    await writeLines(heldId, hold);
    const heldOrder = (await getOrder(tx, heldId))!;

    const confirmedPart = await confirmWithinCredit(tx, (await getOrder(tx, order.orderId))!, input.now, input.runId);
    const approvalId = await holdForApproval(tx, {
      orderId: heldId,
      customerId: customer.id,
      type: 'credit_override',
      reason: `Sisa dari pesanan #${order.orderId}. Bagian yang muat di limit sudah diproses; sisa ${rupiah(heldOrder.subtotal)} melebihi kredit yang tersedia (limit ${rupiah(credit.creditLimit)}, belum dibayar ${rupiah(credit.unpaid)}).`,
      runId: input.runId,
      payload: { creditLimit: credit.creditLimit, unpaid: credit.unpaid, overdueAmount: credit.overdueAmount },
      now: input.now,
    });
    return { confirmedPart, heldOrder, approvalId };
  });
}

/** Holds the whole order for a person to decide (e.g. over credit and the agent judged a split unhelpful). */
export function requestOrderApproval(db: Db, input: { orderId: number; customerId: number; reason: string; now: Date; runId?: string; guest?: boolean }) {
  return db.transaction(async (tx) => {
    const raw = await loadOwnedOrder(tx, input.orderId, input.customerId, input.guest);
    if (!ACTIVE_DRAFT.includes(raw.status)) throw new DomainError('invalid_status', `Order ${raw.id} is ${raw.status}, not a draft`);
    const customer = await getCustomer(tx, raw.customerId);
    await assertCustomerReplied(tx, customer, raw);
    const credit = await creditStatus(tx, customer.id, input.now);
    const type = raw.subtotal > credit.available || credit.oldestOverdueDays > OVERDUE_HOLD_DAYS ? 'credit_override' : 'order';
    const approvalId = await holdForApproval(tx, {
      orderId: raw.id,
      customerId: customer.id,
      type,
      reason: input.reason,
      runId: input.runId,
      payload: { creditLimit: credit.creditLimit, unpaid: credit.unpaid, overdueAmount: credit.overdueAmount, oldestOverdueDays: credit.oldestOverdueDays },
      now: input.now,
    });
    return { approvalId, type, order: (await getOrder(tx, raw.id))! };
  });
}

export function cancelOrder(db: Db, input: { orderId: number; customerId: number; now: Date; guest?: boolean }): Promise<OrderView> {
  return db.transaction(async (tx) => {
    const raw = await loadOwnedOrder(tx, input.orderId, input.customerId, input.guest);
    if (!ACTIVE_DRAFT.includes(raw.status)) throw new DomainError('invalid_status', `Order ${raw.id} is ${raw.status} and can no longer be cancelled by the agent`);
    await tx.update(orders).set({ status: 'cancelled', updatedAt: input.now.toISOString() }).where(eq(orders.id, raw.id));
    return (await getOrder(tx, raw.id))!;
  });
}

// ---------------------------------------------------------------------------
// Human decisions
// ---------------------------------------------------------------------------

export function decideOrderApproval(
  db: Db,
  input: {
    approvalId: number;
    decision: 'approve' | 'reject';
    decidedBy: string;
    note?: string;
    editedLines?: { productId: number; qty: number; unit: string }[];
    now: Date;
  },
): Promise<{ order: OrderView; customerMessage: string }> {
  return db.transaction(async (tx) => {
    const approval = await first(tx.select().from(approvals).where(eq(approvals.id, input.approvalId)).for('update'));
    if (!approval || approval.status !== 'pending') throw new DomainError('approval_not_pending', `Approval ${input.approvalId} is not pending`);
    if (!approval.orderId || (approval.type !== 'order' && approval.type !== 'credit_override')) {
      throw new DomainError('wrong_approval_type', `Approval ${approval.id} is not an order approval`);
    }
    const held = await first(tx.select({ status: orders.status, guest: orders.guest }).from(orders).where(eq(orders.id, approval.orderId)).for('update'));
    if (held?.status !== 'awaiting_approval') throw new DomainError('invalid_status', `Order ${approval.orderId} is ${held?.status ?? 'missing'}, not waiting for approval`);
    const customer = await getCustomer(tx, approval.customerId);
    const nowIso = input.now.toISOString();

    if (input.decision === 'approve' && input.editedLines?.length) {
      const priced = await priceLines(tx, customer.tier, input.editedLines);
      await tx.delete(orderItems).where(eq(orderItems.orderId, approval.orderId));
      await tx
        .insert(orderItems)
        .values(priced.map((l) => ({ orderId: approval.orderId!, productId: l.productId, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, lineTotal: l.lineTotal })));
      await tx
        .update(orders)
        .set({ subtotal: priced.reduce((s, l) => s + l.lineTotal, 0), humanEdited: true, updatedAt: nowIso })
        .where(eq(orders.id, approval.orderId));
    }

    // A guest's test order is approved on paper only: no stock reserved, no invoice, never picked.
    if (input.decision === 'approve' && held.guest) await tx.update(orders).set({ status: 'confirmed', confirmedAt: nowIso, updatedAt: nowIso }).where(eq(orders.id, approval.orderId));
    else if (input.decision === 'approve') await finalize(tx, approval.orderId, input.now);
    else await tx.update(orders).set({ status: 'rejected', updatedAt: nowIso }).where(eq(orders.id, approval.orderId));

    await tx
      .update(approvals)
      .set({ status: input.decision === 'approve' ? 'approved' : 'rejected', decidedBy: input.decidedBy, decidedAt: nowIso, decisionNote: input.note ?? null })
      .where(eq(approvals.id, approval.id));

    const order = (await getOrder(tx, approval.orderId))!;
    const customerMessage =
      input.decision === 'approve'
        ? `Kabar baik, ${customer.honorific} ${customer.ownerName.split(' ')[0]}. Pesanan #${order.orderId} sudah disetujui dan diproses. Total ${rupiah(order.subtotal)}${
            input.editedLines?.length ? ' (ada penyesuaian dari admin kami)' : ''
          }. Terima kasih 🙏${held.guest ? ` ${GUEST_APPROVAL_NOTE}` : ''}`
        : `Mohon maaf, pesanan #${order.orderId} belum bisa kami proses${input.note ? `: ${input.note}` : ''}. Admin kami akan segera menghubungi ${customer.honorific} ${customer.ownerName.split(' ')[0]}.`;
    return { order, customerMessage };
  });
}

// ---------------------------------------------------------------------------
// Corrections: pulling back an order a person judges wrong after it was confirmed
// ---------------------------------------------------------------------------

/**
 * Why a confirmed order cannot simply be pulled back. Each reason names the screen that handles
 * that case instead, so the admin is never left at a dead end.
 */
export type CorrectionBlock = { code: string; message: string };

const CANCEL_REASONS: Record<string, string> = {
  wrong_qty: 'Jumlahnya salah',
  wrong_product: 'Barangnya salah',
  not_an_order: 'Ini bukan pesanan',
  wrong_price: 'Harganya salah',
  customer_cancelled: 'Pelanggan membatalkan',
  other: 'Alasan lain',
};
export const CANCEL_REASON_CODES = Object.keys(CANCEL_REASONS);

export function cancelReasonLabel(code: string | null, note?: string | null): string | null {
  if (!code) return note ?? null;
  const label = CANCEL_REASONS[code] ?? code;
  return note ? `${label}: ${note}` : label;
}

/** The invoice raised when the order was confirmed, if it is still there. */
async function invoiceForOrder(db: Q, orderId: number) {
  return first(db.select().from(invoices).where(eq(invoices.orderId, orderId)));
}

/**
 * Checks whether a confirmed order can still be withdrawn, and drafts the message the customer
 * would get. Read-only: the dialog calls this to show the admin exactly what will happen.
 */
export async function orderCorrection(
  db: Q,
  orderId: number,
): Promise<{ order: OrderView; customer: Customer; blocked: CorrectionBlock | null; invoiceNumber: string | null; message: string }> {
  const raw = await first(db.select().from(orders).where(eq(orders.id, orderId)));
  if (!raw) throw new DomainError('order_not_found', `Order ${orderId} not found`);
  const order = (await getOrder(db, orderId))!;
  const customer = await getCustomer(db, raw.customerId);
  const invoice = raw.guest ? null : await invoiceForOrder(db, orderId);

  const blocked = await (async (): Promise<CorrectionBlock | null> => {
    if (raw.status !== 'confirmed') {
      return {
        code: 'not_confirmed',
        message:
          raw.status === 'awaiting_approval'
            ? 'Pesanan ini masih menunggu keputusan Anda. Perbaiki lewat halaman Persetujuan: di sana bisa diubah dulu, lalu disetujui atau ditolak.'
            : `Pesanan ini berstatus ${raw.status === 'cancelled' ? 'dibatalkan' : raw.status === 'rejected' ? 'ditolak' : 'belum dikonfirmasi'}, jadi tidak ada yang perlu ditarik kembali.`,
      };
    }
    if (raw.shippedAt) {
      return {
        code: 'shipped',
        message: 'Barang sudah dimuat untuk dikirim, jadi pesanan tidak bisa ditarik kembali di sini. Catat selisihnya lewat halaman Pengiriman supaya tagihannya dikoreksi.',
      };
    }
    if (invoice && invoice.paidAmount > 0) {
      return {
        code: 'invoice_paid',
        message: `Tagihan ${invoice.number} sudah dibayar ${rupiah(invoice.paidAmount)}. Uang yang sudah masuk harus diselesaikan dulu di halaman Penagihan sebelum pesanan ditarik kembali.`,
      };
    }
    if (invoice) {
      const claim = await first(
        db
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.customerId, customer.id), eq(payments.status, 'pending'), sql`${payments.allocations} @> ${JSON.stringify([{ invoiceId: invoice.id }])}::jsonb`)),
      );
      if (claim) {
        return {
          code: 'payment_pending',
          message: `Ada bukti transfer dari pelanggan yang menunggu dicek untuk tagihan ${invoice.number}. Putuskan pembayaran itu dulu di halaman Penagihan.`,
        };
      }
    }
    const openApproval = await first(
      db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.orderId, orderId), eq(approvals.status, 'pending'))),
    );
    if (openApproval) {
      return { code: 'approval_pending', message: 'Masih ada permintaan persetujuan terbuka untuk pesanan ini. Selesaikan dulu di halaman Persetujuan.' };
    }
    return null;
  })();

  const name = `${customer.honorific} ${customer.ownerName.split(' ')[0]}`;
  const message =
    `Mohon maaf ${name}, pesanan #${order.orderId} (${rupiah(order.subtotal)}) kami batalkan dulu karena ada yang perlu kami betulkan di catatan kami. ` +
    `Barangnya belum kami kirim dan tagihannya kami tarik kembali, jadi ${name} tidak perlu membayar apa pun untuk pesanan ini. ` +
    `Kalau masih dibutuhkan, balas pesan ini ya, kami buatkan ulang dengan benar. Terima kasih 🙏`;

  return { order, customer, blocked, invoiceNumber: invoice?.number ?? null, message };
}

/**
 * Withdraws an order that was already confirmed: releases the stock it reserved, removes the
 * invoice it raised and records who corrected it and why. Refuses whenever `orderCorrection`
 * reports a block, so a shipped or part-paid order can never be silently unwound.
 */
export function cancelConfirmedOrder(
  db: Db,
  input: { orderId: number; cancelledBy: string; reasonCode: string; note?: string; now: Date },
): Promise<{ order: OrderView; customerMessage: string; releasedInvoice: string | null }> {
  return db.transaction(async (tx) => {
    const raw = await first(tx.select().from(orders).where(eq(orders.id, input.orderId)).for('update'));
    if (!raw) throw new DomainError('order_not_found', `Order ${input.orderId} not found`);
    const correction = await orderCorrection(tx, input.orderId);
    if (correction.blocked) throw new DomainError(correction.blocked.code, correction.blocked.message);

    // A guest's test order reserved nothing and raised no invoice, so only the status changes.
    if (!raw.guest) {
      for (const l of [...correction.order.lines].sort((a, b) => a.productId - b.productId)) {
        const factor = (await unitFactor(tx, l.productId, l.unit)) ?? 1;
        // greatest(...) keeps the release safe even if the reservation was already undone elsewhere.
        await tx
          .update(stock)
          .set({ reserved: sql`greatest(0, ${stock.reserved} - ${l.qty * factor})` })
          .where(eq(stock.productId, l.productId));
      }
      await tx.delete(invoices).where(eq(invoices.orderId, input.orderId));
    }

    const nowIso = input.now.toISOString();
    await tx
      .update(orders)
      .set({ status: 'cancelled', cancelledAt: nowIso, cancelledBy: input.cancelledBy, cancelReason: cancelReasonLabel(input.reasonCode, input.note), updatedAt: nowIso })
      .where(eq(orders.id, input.orderId));

    return { order: (await getOrder(tx, input.orderId))!, customerMessage: correction.message, releasedInvoice: correction.invoiceNumber };
  });
}

/**
 * Undo for the cancellation above, behind the "Batalkan tindakan ini" toast. Re-reserves the stock
 * and raises a fresh invoice, so it fails cleanly when another order has taken the stock meanwhile.
 */
export function restoreCancelledOrder(db: Db, input: { orderId: number; restoredBy: string; now: Date }): Promise<{ order: OrderView; customerMessage: string }> {
  return db.transaction(async (tx) => {
    const raw = await first(tx.select().from(orders).where(eq(orders.id, input.orderId)).for('update'));
    if (!raw) throw new DomainError('order_not_found', `Order ${input.orderId} not found`);
    if (raw.status !== 'cancelled' || !raw.cancelledBy) {
      throw new DomainError('not_cancelled_by_admin', 'Hanya pesanan yang baru saja dibatalkan admin yang bisa dipulihkan.');
    }
    const customer = await getCustomer(tx, raw.customerId);
    const nowIso = input.now.toISOString();
    if (raw.guest) await tx.update(orders).set({ status: 'confirmed', confirmedAt: nowIso, updatedAt: nowIso }).where(eq(orders.id, raw.id));
    else await finalize(tx, raw.id, input.now);
    await tx.update(orders).set({ cancelledAt: null, cancelledBy: null, cancelReason: null, updatedAt: nowIso }).where(eq(orders.id, raw.id));

    const order = (await getOrder(tx, raw.id))!;
    const name = `${customer.honorific} ${customer.ownerName.split(' ')[0]}`;
    return {
      order,
      customerMessage: `Mohon maaf atas kebingungannya ${name}. Pesanan #${order.orderId} (${rupiah(order.subtotal)}) tetap kami proses ya, jadi pembatalan tadi diabaikan saja. Terima kasih 🙏`,
    };
  });
}
