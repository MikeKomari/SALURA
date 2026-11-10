import { and, desc, eq } from '@salura/db/orm';
import { approvals, customers, first, invoices, reminders, type Db, type Q } from '@salura/db';
import { DomainError, getPolicy } from './orders.ts';
import { daysBetween, rupiah, shortDate } from './money.ts';

export type Tone = 'friendly' | 'neutral' | 'firm';

/** Furthest promise-to-pay date the agent may record on its own. */
const MAX_PROMISE_DAYS = 30;
/** Don't remind the same invoice more often than this. */
const MIN_DAYS_BETWEEN_REMINDERS = 3;

export interface OverdueInvoice {
  invoiceId: number;
  number: string;
  customerId: number;
  customerName: string;
  ownerName: string;
  honorific: string;
  preferredTone: string;
  outstanding: number;
  dueAt: string;
  daysOverdue: number;
  promiseToPayAt: string | null;
  lastReminderDaysAgo: number | null;
  remindersSent: number;
}

export async function overdueInvoices(db: Q, now: Date): Promise<OverdueInvoice[]> {
  const rows = await db
    .select({ inv: invoices, c: customers })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(invoices.status, 'open'))
    .orderBy(invoices.id);
  const all = await db.select().from(reminders).orderBy(desc(reminders.sentAt), desc(reminders.id));
  return rows
    .map(({ inv, c }) => {
      const sent = all.filter((r) => r.invoiceId === inv.id && r.status === 'sent');
      const pending = all.find((r) => r.invoiceId === inv.id && r.status === 'pending_approval');
      const last = pending?.createdAt ?? sent[0]?.sentAt ?? null;
      return {
        invoiceId: inv.id,
        number: inv.number,
        customerId: c.id,
        customerName: c.name,
        ownerName: c.ownerName,
        honorific: c.honorific,
        preferredTone: c.reminderTone,
        outstanding: inv.amount - inv.paidAmount,
        dueAt: inv.dueAt.slice(0, 10),
        daysOverdue: daysBetween(inv.dueAt, now),
        promiseToPayAt: inv.promiseToPayAt,
        lastReminderDaysAgo: last ? daysBetween(last, now) : null,
        remindersSent: sent.length,
      };
    })
    .filter((r) => r.daysOverdue > 0)
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}

/** Approved reminder templates. The agent chooses the tone; it never writes the wording. */
export function reminderText(tone: Tone, v: { ownerName: string; honorific: string; number: string; outstanding: number; dueAt: string; daysOverdue: number }): string {
  const name = `${v.honorific} ${v.ownerName.split(' ')[0]}`;
  const amount = rupiah(v.outstanding);
  const due = shortDate(v.dueAt);
  switch (tone) {
    case 'friendly':
      return `Halo ${name} 🙏 Mau mengingatkan tagihan ${v.number} sebesar ${amount} sudah lewat ${v.daysOverdue} hari dari jatuh tempo (${due}). Kalau sudah transfer, abaikan pesan ini ya. Terima kasih banyak!`;
    case 'neutral':
      return `Permisi ${name}, tagihan ${v.number} sebesar ${amount} telah melewati jatuh tempo ${v.daysOverdue} hari (${due}). Mohon informasikan rencana pembayarannya. Terima kasih.`;
    case 'firm':
      return `${name}, tagihan ${v.number} sebesar ${amount} sudah terlambat ${v.daysOverdue} hari sejak ${due}. Mohon pelunasan paling lambat 3 hari ke depan agar pengiriman berikutnya tidak tertahan. Terima kasih.`;
  }
}

export type DraftReminderResult =
  | { outcome: 'sent'; reminderId: number; text: string; waId: string }
  | { outcome: 'awaiting_approval'; reminderId: number; approvalId: number; text: string };

export function draftReminder(db: Db, input: { invoiceId: number; tone: Tone; reason: string; now: Date; runId?: string }): Promise<DraftReminderResult> {
  return db.transaction(async (tx): Promise<DraftReminderResult> => {
    // Lock the invoice: two runs must not both remind it.
    await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, input.invoiceId)).for('update');
    const inv = (await overdueInvoices(tx, input.now)).find((i) => i.invoiceId === input.invoiceId);
    if (!inv) throw new DomainError('not_overdue', `Invoice ${input.invoiceId} is not open and overdue`);
    if (inv.lastReminderDaysAgo !== null && inv.lastReminderDaysAgo < MIN_DAYS_BETWEEN_REMINDERS) {
      throw new DomainError('too_soon', `Invoice ${inv.number} was reminded ${inv.lastReminderDaysAgo} day(s) ago; minimum gap is ${MIN_DAYS_BETWEEN_REMINDERS} days`);
    }
    if (inv.promiseToPayAt && new Date(inv.promiseToPayAt) >= input.now) {
      throw new DomainError('promise_pending', `Customer promised to pay ${inv.number} by ${inv.promiseToPayAt.slice(0, 10)}; do not remind before then`);
    }
    const customer = (await first(tx.select().from(customers).where(eq(customers.id, inv.customerId))))!;
    const text = reminderText(input.tone, inv);
    const policy = await getPolicy(tx, 'send_reminder');
    const nowIso = input.now.toISOString();

    if (policy.mode === 'auto') {
      const [sent] = await tx
        .insert(reminders)
        .values({ invoiceId: inv.invoiceId, customerId: inv.customerId, tone: input.tone, text, status: 'sent', runId: input.runId ?? null, createdAt: nowIso, sentAt: nowIso })
        .returning({ id: reminders.id });
      return { outcome: 'sent', reminderId: sent!.id, text, waId: customer.waId };
    }
    const [reminder] = await tx
      .insert(reminders)
      .values({ invoiceId: inv.invoiceId, customerId: inv.customerId, tone: input.tone, text, status: 'pending_approval', runId: input.runId ?? null, createdAt: nowIso })
      .returning({ id: reminders.id });
    const reminderId = reminder!.id;
    const [approval] = await tx
      .insert(approvals)
      .values({
        type: 'reminder',
        customerId: inv.customerId,
        reason: `Tagihan ${inv.number} sebesar ${rupiah(inv.outstanding)} terlambat ${inv.daysOverdue} hari. ${input.reason}`,
        payload: { reminderId, invoiceId: inv.invoiceId, number: inv.number, outstanding: inv.outstanding, daysOverdue: inv.daysOverdue, tone: input.tone, text },
        runId: input.runId ?? null,
        requestedAt: nowIso,
      })
      .returning({ id: approvals.id });
    return { outcome: 'awaiting_approval', reminderId, approvalId: approval!.id, text };
  });
}

export function decideReminderApproval(
  db: Db,
  input: { approvalId: number; decision: 'approve' | 'reject'; decidedBy: string; note?: string; now: Date },
): Promise<{ waId: string; text: string } | null> {
  return db.transaction(async (tx) => {
    const approval = await first(tx.select().from(approvals).where(eq(approvals.id, input.approvalId)).for('update'));
    if (!approval || approval.status !== 'pending' || approval.type !== 'reminder') {
      throw new DomainError('approval_not_pending', `Approval ${input.approvalId} is not a pending reminder`);
    }
    const reminderId = Number((approval.payload as { reminderId?: number } | null)?.reminderId);
    const reminder = await first(tx.select().from(reminders).where(eq(reminders.id, reminderId)));
    if (!reminder) throw new DomainError('reminder_not_found', `Reminder ${reminderId} not found`);
    if (input.decision === 'approve') {
      // The invoice may have been paid or promised since the reminder was drafted.
      const inv = await first(tx.select().from(invoices).where(eq(invoices.id, reminder.invoiceId)));
      if (!inv || inv.status !== 'open') throw new DomainError('reminder_stale', 'Tagihan ini sudah lunas; pengingat tidak perlu dikirim. Pilih "Jangan kirim".');
      if (inv.promiseToPayAt && new Date(inv.promiseToPayAt) >= input.now) {
        throw new DomainError('reminder_stale', `Pelanggan sudah janji bayar sampai ${inv.promiseToPayAt.slice(0, 10)}; jangan kirim pengingat sebelum tanggal itu.`);
      }
    }
    const nowIso = input.now.toISOString();
    await tx
      .update(approvals)
      .set({ status: input.decision === 'approve' ? 'approved' : 'rejected', decidedBy: input.decidedBy, decidedAt: nowIso, decisionNote: input.note ?? null })
      .where(eq(approvals.id, approval.id));
    if (input.decision === 'reject') {
      await tx.update(reminders).set({ status: 'rejected' }).where(eq(reminders.id, reminder.id));
      return null;
    }
    await tx.update(reminders).set({ status: 'sent', sentAt: nowIso }).where(eq(reminders.id, reminder.id));
    const customer = (await first(tx.select().from(customers).where(eq(customers.id, reminder.customerId))))!;
    return { waId: customer.waId, text: reminder.text };
  });
}

/** `dryRun` checks the date the same way but saves nothing (a guest account's test chat). */
export async function recordPromiseToPay(db: Db, input: { invoiceId: number; customerId: number; date: string; now: Date; dryRun?: boolean }) {
  const inv = await first(db.select().from(invoices).where(eq(invoices.id, input.invoiceId)));
  if (!inv || inv.customerId !== input.customerId || inv.status !== 'open') {
    throw new DomainError('invoice_not_found', `Open invoice ${input.invoiceId} not found for this customer`);
  }
  const promised = new Date(`${input.date}T23:59:59+07:00`);
  if (Number.isNaN(promised.getTime())) throw new DomainError('invalid_date', `"${input.date}" is not a valid YYYY-MM-DD date`);
  if (promised < input.now) throw new DomainError('date_in_past', `${input.date} is in the past`);
  // A promise far in the future would silence collections for that long; the owner decides those.
  if (promised.getTime() - input.now.getTime() > MAX_PROMISE_DAYS * 86_400_000) {
    throw new DomainError('promise_too_far', `Promises more than ${MAX_PROMISE_DAYS} days ahead are not recorded automatically; tell the customer the owner will confirm, and escalate`);
  }
  if (!input.dryRun) await db.update(invoices).set({ promiseToPayAt: promised.toISOString() }).where(eq(invoices.id, inv.id));
  return { invoiceId: inv.id, number: inv.number, promiseToPayAt: input.date };
}
