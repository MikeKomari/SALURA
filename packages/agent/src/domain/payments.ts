import { and, desc, eq, gt, isNull, or, sql } from '@salura/db/orm';
import { approvals, customers, first, invoices, payments, type Db, type Q } from '@salura/db';
import { daysBetween, rupiah } from './money.ts';
import { DomainError, GUEST_APPROVAL_NOTE } from './orders.ts';

/** Largest single payment the agent will record (a typo guard, not a business limit). */
const MAX_PAYMENT = 1_000_000_000;

/** What the bank statement importer writes as `payments.bank` for transfers it confirmed. */
export const BANK_STATEMENT = 'Mutasi rekening';

export interface Allocation {
  invoiceId: number;
  number: string;
  amount: number;
}

/**
 * Splits a payment over the customer's open invoices: the ones the customer named first, then the
 * oldest due. Whatever is left over stays unallocated for the owner to decide.
 */
export function allocate(open: (typeof invoices.$inferSelect)[], amount: number, preferred: string[] = []): { allocations: Allocation[]; unallocated: number } {
  const wanted = new Set(preferred.map((n) => n.trim().toUpperCase()));
  const ordered = [...open].sort((a, b) => Number(wanted.has(b.number)) - Number(wanted.has(a.number)) || a.dueAt.localeCompare(b.dueAt) || a.id - b.id);
  const allocations: Allocation[] = [];
  let left = amount;
  for (const inv of ordered) {
    if (left <= 0) break;
    const outstanding = inv.amount - inv.paidAmount;
    if (outstanding <= 0) continue;
    const part = Math.min(outstanding, left);
    allocations.push({ invoiceId: inv.id, number: inv.number, amount: part });
    left -= part;
  }
  return { allocations, unallocated: left };
}

function openInvoicesOf(db: Q, customerId: number) {
  return db
    .select()
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.status, 'open')))
    .orderBy(invoices.dueAt, invoices.id);
}

/**
 * The customer says they paid (usually with a transfer screenshot). Records the claim and queues it
 * for the owner, who checks the bank statement before anything is marked paid. Never automatic.
 */
export async function recordPaymentClaim(
  db: Db,
  input: {
    customerId: number;
    amount: number;
    paidOn?: string | null;
    bank?: string | null;
    reference?: string | null;
    senderName?: string | null;
    invoiceNumbers?: string[];
    messageId?: number | null;
    now: Date;
    runId?: string;
    /** Reported in a guest account's test chat: kept apart from the customer's own claims. */
    guest?: boolean;
  },
) {
  if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > MAX_PAYMENT) {
    throw new DomainError('invalid_amount', `Payment amount must be a whole number of rupiah between 1 and ${MAX_PAYMENT}`);
  }
  if (input.paidOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw new DomainError('invalid_date', `"${input.paidOn}" is not a YYYY-MM-DD date`);
  if (input.paidOn && new Date(`${input.paidOn}T00:00:00+07:00`) > input.now) throw new DomainError('date_in_future', 'The transfer date is in the future');

  return db.transaction(async (tx) => {
    await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).for('update');
    // Money really received (approved outside a guest's test chat) blocks a second claim from either
    // side. A claim still waiting for the owner blocks only claims from the same side, so a guest's
    // test claim never blocks the customer's real one, nor the other way round.
    const earlier = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.customerId, input.customerId),
          or(and(eq(payments.status, 'approved'), eq(payments.guest, false)), and(eq(payments.status, 'pending'), eq(payments.guest, input.guest ?? false))),
        ),
      );
    const reference = input.reference?.trim() || null;
    // The same transfer reference is one payment, also after the owner approved it; while still
    // pending, the same amount and date is treated as a resend too. A transfer already confirmed
    // from the bank statement has no reference, so there the same amount and date counts.
    const duplicate = earlier.find(
      (p) =>
        (reference && p.reference === reference) ||
        (p.status === 'pending' && p.amount === input.amount && (p.paidOn ?? null) === (input.paidOn ?? null)) ||
        (p.status === 'approved' && p.bank === BANK_STATEMENT && !!input.paidOn && p.amount === input.amount && p.paidOn === input.paidOn),
    );
    if (duplicate) {
      throw new DomainError(
        'duplicate_payment',
        duplicate.status === 'approved'
          ? `This transfer (${duplicate.reference ? `reference ${duplicate.reference}` : `${rupiah(duplicate.amount)} on ${duplicate.paidOn}, from the bank statement`}) was already recorded and approved as payment #${duplicate.id}`
          : `This payment (${rupiah(input.amount)}) is already waiting for the owner to check (payment #${duplicate.id})`,
      );
    }

    const open = await openInvoicesOf(tx, input.customerId);
    if (!open.length) throw new DomainError('no_open_invoices', 'This customer has no open invoices; escalate so a person checks what the transfer was for');
    const known = new Set(open.map((i) => i.number));
    const unknown = (input.invoiceNumbers ?? []).filter((n) => !known.has(n.trim().toUpperCase()));
    if (unknown.length) throw new DomainError('invoice_not_found', `Not an open invoice of this customer: ${unknown.join(', ')}`);

    const { allocations, unallocated } = allocate(open, input.amount, input.invoiceNumbers);
    const nowIso = input.now.toISOString();
    const [payment] = await tx
      .insert(payments)
      .values({
        customerId: input.customerId,
        messageId: input.messageId ?? null,
        amount: input.amount,
        paidOn: input.paidOn ?? null,
        bank: input.bank?.trim() || null,
        reference,
        senderName: input.senderName?.trim() || null,
        allocations,
        runId: input.runId ?? null,
        guest: input.guest ?? false,
        createdAt: nowIso,
      })
      .returning();
    const paysText = allocations.map((a) => `${a.number} ${rupiah(a.amount)}`).join(', ');
    const [approval] = await tx
      .insert(approvals)
      .values({
        type: 'payment',
        customerId: input.customerId,
        reason: `Pelanggan mengirim bukti transfer ${rupiah(input.amount)}${input.paidOn ? ` tanggal ${input.paidOn}` : ''}${input.bank ? ` (${input.bank})` : ''}. Usulan pelunasan: ${paysText}${unallocated > 0 ? `; lebih bayar ${rupiah(unallocated)}` : ''}. Cek mutasi rekening dulu sebelum menyetujui.`,
        payload: { paymentId: payment!.id, amount: input.amount, allocations, unallocated, messageId: input.messageId ?? null },
        runId: input.runId ?? null,
        requestedAt: nowIso,
      })
      .returning({ id: approvals.id });
    const outstanding = open.reduce((s, i) => s + i.amount - i.paidAmount, 0);
    return { paymentId: payment!.id, approvalId: approval!.id, amount: input.amount, allocations, unallocated, outstandingBefore: outstanding, outstandingAfter: Math.max(0, outstanding - input.amount) };
  });
}

/**
 * Applies money that has arrived to the customer's open invoices as they are now: the preferred
 * ones first, then the oldest due. No invoice is paid beyond its amount; the rest stays unallocated
 * (listed as an overpayment).
 */
export async function settle(tx: Q, customerId: number, amount: number, preferred: string[]) {
  const open = await openInvoicesOf(tx, customerId).for('update');
  const { allocations, unallocated } = allocate(open, amount, preferred);
  for (const a of allocations) {
    const inv = open.find((i) => i.id === a.invoiceId)!;
    const paidAmount = inv.paidAmount + a.amount;
    await tx
      .update(invoices)
      .set({ paidAmount, status: paidAmount >= inv.amount ? 'paid' : 'open', promiseToPayAt: paidAmount >= inv.amount ? null : inv.promiseToPayAt })
      .where(eq(invoices.id, inv.id));
  }
  return { allocations, unallocated };
}

/** The thank-you message for a confirmed payment, with what is still open. */
async function thanks(tx: Q, customer: typeof customers.$inferSelect, amount: number, allocations: Allocation[], unallocated: number) {
  const name = `${customer.honorific} ${customer.ownerName.split(' ')[0]}`;
  const remaining = (await openInvoicesOf(tx, customer.id)).reduce((s, i) => s + i.amount - i.paidAmount, 0);
  const paid = allocations.map((a) => a.number).join(', ');
  return `Terima kasih ${name} 🙏 Pembayaran ${rupiah(amount)} sudah kami terima${paid ? ` untuk ${paid}` : ''}.${remaining > 0 ? ` Sisa tagihan ${rupiah(remaining)}.` : ' Semua tagihan sudah lunas.'}${unallocated > 0 ? ` Ada lebih bayar ${rupiah(unallocated)}, admin kami akan menghubungi.` : ''}`;
}

/**
 * Owner's decision on a reported payment. Approve marks the invoices paid (re-allocated against the
 * invoices as they are now, in case one was settled meanwhile) and thanks the customer.
 */
export function decidePaymentApproval(
  db: Db,
  input: { approvalId: number; decision: 'approve' | 'reject'; decidedBy: string; note?: string; now: Date },
): Promise<{ waId: string; text: string } | null> {
  return db.transaction((tx) => decidePayment(tx, input));
}

/**
 * The decision inside a caller's transaction. The owner approves only money seen on the bank
 * statement, so it is recorded even when every invoice was settled meanwhile: it all becomes an
 * overpayment, listed for the owner to refund.
 */
export async function decidePayment(
  tx: Q,
  input: { approvalId: number; decision: 'approve' | 'reject'; decidedBy: string; note?: string; now: Date },
): Promise<{ waId: string; text: string }> {
  const approval = await first(tx.select().from(approvals).where(eq(approvals.id, input.approvalId)).for('update'));
  if (!approval || approval.status !== 'pending' || approval.type !== 'payment') {
    throw new DomainError('approval_not_pending', `Approval ${input.approvalId} is not a pending payment`);
  }
  const paymentId = Number((approval.payload as { paymentId?: number } | null)?.paymentId);
  const payment = await first(tx.select().from(payments).where(eq(payments.id, paymentId)).for('update'));
  if (!payment || payment.status !== 'pending') throw new DomainError('payment_not_found', `Payment ${paymentId} is not pending`);
  const customer = (await first(tx.select().from(customers).where(eq(customers.id, payment.customerId))))!;
  const nowIso = input.now.toISOString();
  const name = `${customer.honorific} ${customer.ownerName.split(' ')[0]}`;

  const decide = (status: 'approved' | 'rejected') =>
    tx.update(approvals).set({ status, decidedBy: input.decidedBy, decidedAt: nowIso, decisionNote: input.note ?? null }).where(eq(approvals.id, approval.id));

  if (input.decision === 'reject') {
    await decide('rejected');
    await tx.update(payments).set({ status: 'rejected', decidedAt: nowIso }).where(eq(payments.id, payment.id));
    return {
      waId: customer.waId,
      text: `Mohon maaf ${name}, transfer ${rupiah(payment.amount)} belum bisa kami cocokkan dengan rekening kami${input.note ? `: ${input.note}` : ''}. Admin kami akan menghubungi untuk mengecek bersama 🙏`,
    };
  }
  // A claim from a guest's test chat is approved on paper only: no invoice is settled.
  if (payment.guest) {
    await tx.update(payments).set({ status: 'approved', decidedAt: nowIso }).where(eq(payments.id, payment.id));
    await decide('approved');
    return { waId: customer.waId, text: `Terima kasih ${name} 🙏 Pembayaran ${rupiah(payment.amount)} sudah dicek admin. ${GUEST_APPROVAL_NOTE}` };
  }

  const { allocations, unallocated } = await settle(tx, payment.customerId, payment.amount, payment.allocations.map((a) => a.number));
  await tx.update(payments).set({ status: 'approved', allocations, decidedAt: nowIso }).where(eq(payments.id, payment.id));
  await decide('approved');
  return { waId: customer.waId, text: await thanks(tx, customer, payment.amount, allocations, unallocated) };
}

/**
 * A transfer the owner found on the bank statement and matched to a customer: recorded as an
 * approved payment (with an approved approval, so it shows in the decision history) and applied to
 * the open invoices the same way an approved chat payment is.
 */
export async function recordBankPayment(
  tx: Q,
  input: { customerId: number; amount: number; postedOn: string; description: string; preferred: string[]; decidedBy: string; now: Date },
) {
  const customer = await first(tx.select().from(customers).where(eq(customers.id, input.customerId)).for('update'));
  if (!customer) throw new DomainError('customer_not_found', `Customer ${input.customerId} not found`);
  const { allocations, unallocated } = await settle(tx, customer.id, input.amount, input.preferred);
  const nowIso = input.now.toISOString();
  const [payment] = await tx
    .insert(payments)
    .values({ customerId: customer.id, amount: input.amount, paidOn: input.postedOn, bank: BANK_STATEMENT, allocations, status: 'approved', createdAt: nowIso, decidedAt: nowIso })
    .returning({ id: payments.id });
  const paysText = allocations.map((a) => `${a.number} ${rupiah(a.amount)}`).join(', ');
  const [approval] = await tx
    .insert(approvals)
    .values({
      type: 'payment',
      status: 'approved',
      customerId: customer.id,
      reason: `Transfer ${rupiah(input.amount)} tanggal ${input.postedOn} ada di mutasi rekening ("${input.description}"). ${paysText ? `Dicatat untuk ${paysText}` : 'Tidak ada tagihan terbuka'}${unallocated > 0 ? `; lebih bayar ${rupiah(unallocated)}` : ''}.`,
      payload: { paymentId: payment!.id, amount: input.amount, allocations, unallocated, source: 'bank_statement' },
      requestedAt: nowIso,
      decidedBy: input.decidedBy,
      decidedAt: nowIso,
      decisionNote: 'Dicocokkan dari mutasi rekening',
    })
    .returning({ id: approvals.id });
  return {
    paymentId: payment!.id,
    approvalId: approval!.id,
    allocations,
    unallocated,
    message: { waId: customer.waId, text: await thanks(tx, customer, input.amount, allocations, unallocated) },
  };
}

/** Reported payments, newest first, for the Penagihan screen (claims from a guest's test chat carry `guest`). */
export async function recentPayments(db: Q, now: Date, days = 30) {
  const rows = await db
    .select({ payment: payments, customer: { id: customers.id, name: customers.name, waId: customers.waId } })
    .from(payments)
    .innerJoin(customers, eq(customers.id, payments.customerId))
    .orderBy(desc(payments.id))
    .limit(100);
  return rows.filter((r) => daysBetween(r.payment.createdAt, now) <= days).map((r) => ({ ...r.payment, customer: r.customer }));
}

/** What a payment paid beyond the invoices it settled (SQL, so the list never has to load every payment). */
const paymentSurplus = sql<number>`${payments.amount} - (select coalesce(sum((a->>'amount')::int), 0) from jsonb_array_elements(${payments.allocations}) a)`;

/**
 * Money customers paid beyond what they owe, for the owner to refund or set against the next bill:
 * invoices corrected below what was already paid, and approved transfers larger than the open
 * invoices they settled. Derived from the records themselves; listed until the owner marks it settled.
 */
export async function overpayments(db: Q) {
  const customer = { id: customers.id, name: customers.name, waId: customers.waId };
  const corrected = await db
    .select({ invoice: invoices, customer })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(gt(invoices.paidAmount, invoices.amount), isNull(invoices.overpaymentSettledAt)))
    .orderBy(desc(invoices.id));
  const approved = await db
    .select({ payment: payments, customer, surplus: paymentSurplus })
    .from(payments)
    .innerJoin(customers, eq(customers.id, payments.customerId))
    .where(and(eq(payments.status, 'approved'), eq(payments.guest, false), isNull(payments.overpaymentSettledAt), gt(paymentSurplus, 0)))
    .orderBy(desc(payments.id));
  return [
    ...corrected.map((r) => ({ source: 'invoice_correction' as const, id: r.invoice.id, reference: r.invoice.number, amount: r.invoice.paidAmount - r.invoice.amount, customer: r.customer })),
    ...approved.map((r) => ({ source: 'payment' as const, id: r.payment.id, reference: r.payment.reference ?? `Transfer ${rupiah(r.payment.amount)}`, amount: Number(r.surplus), customer: r.customer })),
  ];
}

/** The owner refunded the overpayment or set it against a later bill: it leaves the list. */
export async function settleOverpayment(db: Q, input: { source: 'invoice_correction' | 'payment'; id: number; now: Date }) {
  const at = input.now.toISOString();
  const settled =
    input.source === 'invoice_correction'
      ? await db
          .update(invoices)
          .set({ overpaymentSettledAt: at })
          .where(and(eq(invoices.id, input.id), gt(invoices.paidAmount, invoices.amount), isNull(invoices.overpaymentSettledAt)))
          .returning({ id: invoices.id })
      : await db
          .update(payments)
          .set({ overpaymentSettledAt: at })
          .where(and(eq(payments.id, input.id), eq(payments.status, 'approved'), eq(payments.guest, false), isNull(payments.overpaymentSettledAt), gt(paymentSurplus, 0)))
          .returning({ id: payments.id });
  if (!settled.length) throw new DomainError('overpayment_not_found', 'Lebih bayar ini tidak ada atau sudah diselesaikan.');
}
