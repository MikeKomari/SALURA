import { and, asc, desc, eq, gte, isNull } from '@salura/db/orm';
import { approvals, customers, first, orders, type Db, type Q } from '@salura/db';
import { creditStatus, usualOrder, type UsualLine } from './customers.ts';
import { daysBetween, rupiah } from './money.ts';
import { activeDraft, availableBase, DomainError, draftOrder, getOrder, getPolicy, OVERDUE_HOLD_DAYS, priceFor, unitFactor, type OrderView } from './orders.ts';

/** Don't offer the same customer a reorder more often than this. */
const MIN_DAYS_BETWEEN_NUDGES = 7;
/** A customer is due once this share of their usual ordering interval has passed. */
const DUE_AT = 0.9;
export const PROACTIVE_CHANNEL = 'proactive';

export interface ReorderCandidate {
  customerId: number;
  name: string;
  ownerName: string;
  honorific: string;
  waId: string;
  ordersCounted: number;
  avgIntervalDays: number;
  daysSinceLastOrder: number;
  due: boolean;
  /** Why the agent must not nudge this customer now; null when it may. */
  skipReason: string | null;
  usualOrder: UsualLine[];
}

/** The usual order priced from today's price list, without lines that are out of stock. */
export interface OfferPreview {
  lines: { productId: number; name: string; qty: number; unit: string; unitPrice: number; lineTotal: number }[];
  subtotal: number;
  droppedOutOfStock: string[];
}

export async function priceOffer(db: Q, customer: { id: number; tier: string }, usual: UsualLine[]): Promise<OfferPreview> {
  const lines: OfferPreview['lines'] = [];
  const dropped: string[] = [];
  for (const l of usual) {
    const unitPrice = await priceFor(db, l.productId, customer.tier, l.unit);
    const factor = await unitFactor(db, l.productId, l.unit);
    if (unitPrice === undefined || factor === undefined || (await availableBase(db, l.productId)) < l.qty * factor) {
      dropped.push(l.name);
      continue;
    }
    lines.push({ productId: l.productId, name: l.name, qty: l.qty, unit: l.unit, unitPrice, lineTotal: unitPrice * l.qty });
  }
  return { lines, subtotal: lines.reduce((s, l) => s + l.lineTotal, 0), droppedOutOfStock: dropped };
}

/** Customers with a regular ordering rhythm, and whether today is the day to offer their usual order. */
export async function reorderCandidates(db: Q, now: Date): Promise<ReorderCandidate[]> {
  const out: ReorderCandidate[] = [];
  for (const c of await db.select().from(customers).orderBy(asc(customers.id))) {
    // A split leaves two confirmed orders on one day; only the original counts toward the rhythm.
    // A guest's test order says nothing about when the customer buys.
    const confirmed = await db
      .select({ createdAt: orders.createdAt })
      .from(orders)
      .where(and(eq(orders.customerId, c.id), eq(orders.status, 'confirmed'), eq(orders.guest, false), isNull(orders.splitFromOrderId)))
      .orderBy(asc(orders.createdAt), asc(orders.id));
    if (confirmed.length < 2) continue;

    const firstAt = new Date(confirmed[0]!.createdAt).getTime();
    const last = confirmed.at(-1)!.createdAt;
    const avgIntervalDays = Math.round((new Date(last).getTime() - firstAt) / 86_400_000 / (confirmed.length - 1));
    if (avgIntervalDays < 1) continue;
    const daysSinceLastOrder = daysBetween(last, now);
    const due = daysSinceLastOrder >= Math.round(avgIntervalDays * DUE_AT);
    const usual = await usualOrder(db, c.id);

    let skipReason: string | null = null;
    const credit = await creditStatus(db, c.id, now);
    const lastNudge = await lastNudgeAt(db, c.id);
    const pendingOffer = await first(
      db
        .select({ id: approvals.id })
        .from(approvals)
        .where(and(eq(approvals.customerId, c.id), eq(approvals.type, 'reorder'), eq(approvals.status, 'pending')))
        .limit(1),
    );
    const offer = usual.length ? await priceOffer(db, c, usual) : null;
    if (!usual.length) skipReason = 'Tidak ada pola pesanan tetap';
    else if (pendingOffer) skipReason = 'Tawaran sebelumnya masih menunggu persetujuan pemilik';
    else if (await activeDraft(db, c.id)) skipReason = 'Sudah ada draf pesanan yang menunggu pelanggan';
    else if (credit.oldestOverdueDays > OVERDUE_HOLD_DAYS) skipReason = `Ada tagihan terlambat ${credit.oldestOverdueDays} hari; tagih dulu, jangan tawarkan pesanan baru`;
    else if (lastNudge && daysBetween(lastNudge, now) < MIN_DAYS_BETWEEN_NUDGES) skipReason = `Sudah ditawari ${daysBetween(lastNudge, now)} hari lalu`;
    else if (!due) skipReason = `Belum waktunya: biasanya tiap ${avgIntervalDays} hari, terakhir pesan ${daysSinceLastOrder} hari lalu`;
    else if (offer && !offer.lines.length) skipReason = 'Semua barang pesanan biasanya sedang habis';
    else if (offer && offer.subtotal > credit.available) {
      skipReason = `Sisa limit kredit ${rupiah(Math.max(0, credit.available))} tidak cukup untuk pesanan biasanya ${rupiah(offer.subtotal)}`;
    }

    out.push({
      customerId: c.id,
      name: c.name,
      ownerName: c.ownerName,
      honorific: c.honorific,
      waId: c.waId,
      ordersCounted: confirmed.length,
      avgIntervalDays,
      daysSinceLastOrder,
      due,
      skipReason,
      usualOrder: usual,
    });
  }
  return out;
}

/** Last time this customer was offered a reorder: an offer sent, or one queued (approved or not). */
async function lastNudgeAt(db: Q, customerId: number): Promise<string | null> {
  const sent = (
    await first(
      db
        .select({ at: orders.createdAt })
        .from(orders)
        .where(and(eq(orders.customerId, customerId), eq(orders.channel, PROACTIVE_CHANNEL)))
        .orderBy(desc(orders.createdAt))
        .limit(1),
    )
  )?.at;
  const queued = (
    await first(
      db
        .select({ at: approvals.requestedAt })
        .from(approvals)
        .where(and(eq(approvals.customerId, customerId), eq(approvals.type, 'reorder')))
        .orderBy(desc(approvals.requestedAt))
        .limit(1),
    )
  )?.at;
  return [sent, queued].filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
}

/** Approved wording: the agent decides who to nudge, never what the message promises. */
export function reorderText(
  c: { honorific: string; ownerName: string; avgIntervalDays: number; daysSinceLastOrder: number },
  offer: { lines: { qty: number; unit: string; name: string; lineTotal: number }[]; subtotal: number },
): string {
  const lines = offer.lines.map((l) => `• ${l.qty} ${l.unit} ${l.name} – ${rupiah(l.lineTotal)}`).join('\n');
  return [
    `Halo ${c.honorific} ${c.ownerName.split(' ')[0]}, ini SALURA dari CV Sumber Rejeki 🙏`,
    `Biasanya ${c.honorific} pesan tiap ±${c.avgIntervalDays} hari, terakhir ${c.daysSinceLastOrder} hari lalu. Mau kami siapkan pesanan seperti biasa?`,
    lines,
    `Total ${rupiah(offer.subtotal)}. Balas YA untuk diproses, atau kabari kalau ada yang mau diubah.`,
  ].join('\n');
}

/**
 * Creates the offer's draft at the moment it is sent, so the customer's consent can only refer to
 * the order in the message they received. Returns null when the offer can no longer be made.
 */
async function draftOfferNow(db: Db, input: { customerId: number; lines: { productId: number; qty: number; unit: string }[]; now: Date }): Promise<{ order: OrderView } | null> {
  const customer = (await first(db.select().from(customers).where(eq(customers.id, input.customerId))))!;
  if (await activeDraft(db, customer.id)) return null; // the customer is already ordering something else
  const available = [];
  for (const l of input.lines) if ((await availableBase(db, l.productId)) >= l.qty * ((await unitFactor(db, l.productId, l.unit)) ?? 1)) available.push(l);
  if (!available.length) return null;
  const { order } = await draftOrder(db, { customerId: customer.id, channel: PROACTIVE_CHANNEL, lines: available.map((l) => ({ ...l, rawText: 'pesanan biasa' })), now: input.now });
  await db.update(orders).set({ summarySentAt: input.now.toISOString() }).where(eq(orders.id, order.orderId));
  return { order: (await getOrder(db, order.orderId))! };
}

export type NudgeResult =
  | { outcome: 'sent'; orderId: number; text: string; waId: string; droppedOutOfStock: string[] }
  | { outcome: 'awaiting_approval'; approvalId: number; text: string; droppedOutOfStock: string[] };

/**
 * Offers a due customer their usual order. In auto mode the draft is created and the message sent
 * now. Otherwise only a proposal is queued: no order exists until the owner approves the send.
 * Runs in one transaction holding the customer's row lock, so no other request can interleave with it.
 */
export function sendReorderNudge(db: Db, input: { customerId: number; reason: string; now: Date; runId?: string }): Promise<NudgeResult> {
  return db.transaction(async (tx): Promise<NudgeResult> => {
    await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).for('update');
    const candidate = (await reorderCandidates(tx, input.now)).find((c) => c.customerId === input.customerId);
    if (!candidate) throw new DomainError('no_pattern', 'This customer has no regular ordering pattern to base an offer on');
    if (candidate.skipReason) throw new DomainError('not_due', candidate.skipReason);
    const customer = (await first(tx.select().from(customers).where(eq(customers.id, candidate.customerId))))!;
    const preview = await priceOffer(tx, customer, candidate.usualOrder);
    if (!preview.lines.length) throw new DomainError('all_out_of_stock', 'Every item of the usual order is out of stock; do not send an offer');

    if ((await getPolicy(tx, 'send_reorder_nudge')).mode === 'auto') {
      const made = await draftOfferNow(tx, { customerId: customer.id, lines: preview.lines, now: input.now });
      if (!made) throw new DomainError('reorder_stale', 'The offer could not be prepared (open draft or no stock)');
      return { outcome: 'sent', orderId: made.order.orderId, text: reorderText(candidate, made.order), waId: candidate.waId, droppedOutOfStock: preview.droppedOutOfStock };
    }

    const text = reorderText(candidate, preview);
    const [row] = await tx
      .insert(approvals)
    .values({
      type: 'reorder',
      customerId: candidate.customerId,
      orderId: null,
      reason: `Biasanya pesan tiap ${candidate.avgIntervalDays} hari, terakhir ${candidate.daysSinceLastOrder} hari lalu. ${input.reason}`,
      payload: {
        text,
        preview,
        avgIntervalDays: candidate.avgIntervalDays,
        daysSinceLastOrder: candidate.daysSinceLastOrder,
        droppedOutOfStock: preview.droppedOutOfStock,
      },
      runId: input.runId ?? null,
      requestedAt: input.now.toISOString(),
    })
    .returning({ id: approvals.id });
    return { outcome: 'awaiting_approval', approvalId: row!.id, text, droppedOutOfStock: preview.droppedOutOfStock };
  });
}

/**
 * Owner's decision on a queued offer. Approve creates the draft and returns the message to send,
 * rebuilt from the order actually drafted (prices or stock may have changed since it was queued).
 * Refused when the customer has since started their own order or nothing is in stock any more.
 */
export function decideReorderApproval(
  db: Db,
  input: { approvalId: number; decision: 'approve' | 'reject'; decidedBy: string; note?: string; now: Date },
): Promise<{ waId: string; text: string; orderId: number } | null> {
  // One transaction: a refused send (stale offer) rolls the decision back as if it never happened.
  return db.transaction(async (tx) => {
    const approval = await first(tx.select().from(approvals).where(eq(approvals.id, input.approvalId)).for('update'));
    if (!approval || approval.status !== 'pending' || approval.type !== 'reorder') {
      throw new DomainError('approval_not_pending', `Approval ${input.approvalId} is not a pending reorder offer`);
    }
    const nowIso = input.now.toISOString();
    const decide = (status: 'approved' | 'rejected', orderId: number | null = null) =>
      tx.update(approvals).set({ status, orderId, decidedBy: input.decidedBy, decidedAt: nowIso, decisionNote: input.note ?? null }).where(eq(approvals.id, approval.id));

    if (input.decision === 'reject') {
      await decide('rejected');
      return null;
    }

    const payload = (approval.payload ?? {}) as { preview?: OfferPreview; avgIntervalDays?: number; daysSinceLastOrder?: number };
    const [customer] = await tx.select().from(customers).where(eq(customers.id, approval.customerId)).for('update');
    if (await activeDraft(tx, customer!.id)) {
      throw new DomainError('reorder_stale', 'Pelanggan sedang punya pesanan terbuka, jadi tawaran ini tidak dikirim. Pilih "Jangan kirim".');
    }
    // Mark the decision first: drafting below auto-withdraws pending offers for this customer.
    await decide('approved');
    const made = await draftOfferNow(tx, { customerId: customer!.id, lines: payload.preview?.lines ?? [], now: input.now });
    if (!made) throw new DomainError('reorder_stale', 'Semua barang dalam tawaran ini sudah habis. Pilih "Jangan kirim".');
    await tx.update(approvals).set({ orderId: made.order.orderId }).where(eq(approvals.id, approval.id));
    const daysSinceLastOrder = (payload.daysSinceLastOrder ?? 0) + Math.max(0, daysBetween(approval.requestedAt, input.now));
    const text = reorderText({ honorific: customer!.honorific, ownerName: customer!.ownerName, avgIntervalDays: payload.avgIntervalDays ?? 0, daysSinceLastOrder }, made.order);
    return { waId: customer!.waId, text, orderId: made.order.orderId };
  });
}

/** Offers sent in the last `days`, for the dashboard. */
export async function recentNudges(db: Q, now: Date, days = 14) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = await db
    .select({ orderId: orders.id, status: orders.status, createdAt: orders.createdAt, customerName: customers.name })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.channel, PROACTIVE_CHANNEL), gte(orders.createdAt, since)))
    .orderBy(desc(orders.createdAt), desc(orders.id));
  return Promise.all(rows.map(async (o) => ({ ...o, order: await getOrder(db, o.orderId) })));
}
