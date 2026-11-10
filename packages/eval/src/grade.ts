import { and, desc, eq, inArray } from '@salura/db/orm';
import { approvals, auditLog, customers, deliveryChecks, first, invoices, orderItems, orders, payments, products, type Db } from '@salura/db';
import type { EvalCase } from './cases.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface Grade {
  pass: boolean;
  /** Null when the case has no expected lines. */
  linesExact: boolean | null;
  checks: Check[];
}

const PROCESSED = ['confirmed', 'awaiting_approval'] as const;

/** Grades one run of a case by inspecting the database the agent wrote to, not the agent's text. */
export async function grade(db: Db, c: EvalCase, replies: string[]): Promise<Grade> {
  const checks: Check[] = [];
  const customer = await first(db.select().from(customers).where(eq(customers.waId, c.waId)));
  const agentOrders = customer
    ? await db.select().from(orders).where(and(eq(orders.customerId, customer.id), eq(orders.historic, false))).orderBy(orders.id)
    : [];
  const processed = agentOrders.filter((o) => (PROCESSED as readonly string[]).includes(o.status));
  let linesExact: boolean | null = null;

  if (c.expect.lines) {
    const actual = processed.length ? await linesOf(db, processed.map((o) => o.id)) : [];
    const expected = normalizeLines(c.expect.lines);
    linesExact = sameLines(actual, expected);
    checks.push({ name: 'order lines', ok: linesExact, detail: linesExact ? undefined : `expected ${fmt(expected)}, got ${fmt(actual) || 'nothing processed'}` });
  }

  if (c.expect.statuses) {
    const allowed = c.expect.statuses as string[];
    const relevant = processed.length ? processed : agentOrders;
    const ok = relevant.length > 0 && relevant.every((o) => allowed.includes(o.status));
    checks.push({ name: 'order status', ok, detail: ok ? undefined : `allowed ${allowed.join('/')}, got ${relevant.map((o) => o.status).join(', ') || 'no order'}` });
  }

  if (c.expect.noProcessedOrder) {
    checks.push({ name: 'nothing processed', ok: processed.length === 0, detail: processed.length ? `${processed.length} order(s) processed` : undefined });
  }

  if (c.expect.asksClarification) {
    const asked = (replies[0] ?? '').includes('?');
    checks.push({ name: 'asks one clarifying question', ok: asked && processed.length === 0, detail: asked ? undefined : `reply: ${replies[0]}` });
    const questionCount = ((replies[0] ?? '').match(/\?/g) ?? []).length;
    checks.push({ name: 'exactly one question', ok: questionCount === 1, detail: `${questionCount} question marks` });
  }

  if (c.expect.replyMentions) {
    const reply = (replies[c.expect.replyMentions.turn] ?? '').toLowerCase();
    const missing = c.expect.replyMentions.words.filter((w) => !reply.includes(w.toLowerCase()));
    checks.push({ name: 'reply mentions', ok: missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')}` : undefined });
  }

  if (c.expect.escalated) {
    const n = (await db.select().from(approvals).where(eq(approvals.type, 'escalation'))).length;
    checks.push({ name: 'escalated to a human', ok: n > 0 });
  }

  if (c.expect.promiseToPay && customer) {
    const promised = (await db.select().from(invoices).where(eq(invoices.customerId, customer.id))).some((i) => i.promiseToPayAt);
    checks.push({ name: 'promise to pay recorded', ok: promised });
  }

  if (c.expect.deliveryNote) {
    const ok = processed.some((o) => (o.deliveryNote ?? '').trim().length > 0);
    checks.push({ name: 'delivery note kept', ok });
  }

  if (c.expect.offered || c.expect.notOffered) {
    // An offer is either sent (a proactive draft) or queued for the owner (a reorder approval).
    const sentTo = await db.select({ waId: customers.waId }).from(orders).innerJoin(customers, eq(customers.id, orders.customerId)).where(eq(orders.channel, 'proactive'));
    const queuedFor = await db.select({ waId: customers.waId }).from(approvals).innerJoin(customers, eq(customers.id, approvals.customerId)).where(eq(approvals.type, 'reorder'));
    const offeredTo = new Set([...sentTo, ...queuedFor].map((r) => r.waId));
    const missing = (c.expect.offered ?? []).filter((w) => !offeredTo.has(w));
    const wrong = (c.expect.notOffered ?? []).filter((w) => offeredTo.has(w));
    checks.push({ name: 'offered the due customers', ok: missing.length === 0, detail: missing.length ? `not offered: ${missing.join(', ')}` : undefined });
    checks.push({ name: 'skipped everyone else', ok: wrong.length === 0, detail: wrong.length ? `offered wrongly: ${wrong.join(', ')}` : undefined });
  }

  if (c.expect.deliveryStatus) {
    const check = await first(db.select().from(deliveryChecks).orderBy(desc(deliveryChecks.id)).limit(1));
    checks.push({ name: 'delivery verdict', ok: check?.status === c.expect.deliveryStatus, detail: `expected ${c.expect.deliveryStatus}, got ${check?.status ?? 'no check'}` });
  }
  if (c.expect.queued || c.expect.notQueued) {
    const types = new Set((await db.select({ type: approvals.type }).from(approvals)).map((a) => a.type));
    const missing = (c.expect.queued ?? []).filter((t) => !types.has(t));
    const extra = (c.expect.notQueued ?? []).filter((t) => types.has(t));
    checks.push({ name: 'follow-ups queued', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : undefined });
    checks.push({ name: 'no false alarm', ok: extra.length === 0, detail: extra.length ? `queued wrongly: ${extra.join(', ')}` : undefined });
  }

  if (c.expect.citesPolicy) {
    const sources = (await db.select().from(auditLog).where(and(eq(auditLog.type, 'tool_result'), eq(auditLog.tool, 'search_policies'))))
      .flatMap((r) => ((r.data as any)?.hits ?? []).map((h: any) => String(h.source)));
    const ok = sources.some((s) => s.startsWith(c.expect.citesPolicy!));
    checks.push({ name: 'grounded in policy', ok, detail: ok ? undefined : `retrieved ${sources.join(', ') || 'nothing'}` });
  }

  if (c.expect.payment) {
    const rows = customer ? await db.select().from(payments).where(eq(payments.customerId, customer.id)) : [];
    const want = c.expect.payment;
    const ok = rows.length === 1 && rows[0]!.amount === want.amount && rows[0]!.status === 'pending' && (!want.invoices || want.invoices.every((n) => rows[0]!.allocations.some((a) => a.number === n)));
    checks.push({ name: 'payment recorded for checking', ok, detail: ok ? undefined : `expected ${want.amount}${want.invoices ? ` for ${want.invoices.join(', ')}` : ''}, got ${rows.map((r) => `${r.amount} → ${r.allocations.map((a) => a.number).join('+')}`).join('; ') || 'nothing'}` });
    const paid = customer ? (await db.select().from(invoices).where(eq(invoices.customerId, customer.id))).filter((i) => i.paidAmount > 0 && i.status === 'open').length : 0;
    checks.push({ name: 'nothing marked paid by the agent', ok: paid === 0 });
  }
  if (c.expect.noPayment) {
    const rows = customer ? await db.select().from(payments).where(eq(payments.customerId, customer.id)) : [];
    checks.push({ name: 'no payment recorded', ok: rows.length === 0, detail: rows.length ? `${rows.length} recorded` : undefined });
  }

  return { pass: checks.every((ch) => ch.ok), linesExact, checks };
}

type Line = [string, number, string];

async function linesOf(db: Db, orderIds: number[]): Promise<Line[]> {
  const rows = await db
    .select({ sku: products.sku, qty: orderItems.qty, unit: orderItems.unit })
    .from(orderItems)
    .innerJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, orderIds));
  return normalizeLines(rows.map((r) => [r.sku, r.qty, r.unit]));
}

/** Merges split-order fragments of the same product and unit, then sorts. */
function normalizeLines(lines: Line[]): Line[] {
  const merged = new Map<string, Line>();
  for (const [sku, qty, unit] of lines) {
    const key = `${sku}|${unit}`;
    const prev = merged.get(key);
    merged.set(key, [sku, (prev?.[1] ?? 0) + qty, unit]);
  }
  return [...merged.values()].sort((a, b) => a[0].localeCompare(b[0]));
}

function sameLines(a: Line[], b: Line[]): boolean {
  return a.length === b.length && a.every((l, i) => l[0] === b[i]![0] && l[1] === b[i]![1] && l[2] === b[i]![2]);
}

function fmt(lines: Line[]): string {
  return lines.map(([s, q, u]) => `${q} ${u} ${s}`).join(', ');
}
