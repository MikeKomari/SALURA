import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, lt, lte, or } from '@salura/db/orm';
import { agentRuns, approvals, conversationLocks, customers, deliveryChecks, first, messages, orders, type ApprovalType, type Db } from '@salura/db';
import { Audit } from './audit.ts';
import { findCustomerByWa, type Customer } from './domain/customers.ts';
import { activeDraft, cancelConfirmedOrder, decideOrderApproval, DomainError, markSummarySent, orderCorrection, restoreCancelledOrder } from './domain/orders.ts';
import { rupiah } from './domain/money.ts';
import { decideReminderApproval } from './domain/reminders.ts';
import { decideReorderApproval } from './domain/reorder.ts';
import { createCheck, decideDeliveryQuery, decideInvoiceAdjustment } from './domain/delivery.ts';
import { decidePaymentApproval } from './domain/payments.ts';
import { DELIVERY_TOOLS } from './tools/delivery-tools.ts';
import type { ChatMessage } from './llm/types.ts';
import { DEFAULT_RUN_DEADLINE_MS, runAgent, type AgentDeps, type RunResult } from './orchestrator.ts';
import { collectionsAgentPrompt, deliveryAgentPrompt, orderAgentPrompt, proactiveAgentPrompt } from './prompts.ts';
import { COLLECTION_TOOLS } from './tools/collection-tools.ts';
import { PROACTIVE_TOOLS } from './tools/proactive-tools.ts';
import { ORDER_TOOLS } from './tools/order-agent-tools.ts';
import type { GuestSession } from './tools/types.ts';

/** Delivers a message to the customer on a real channel (web chat, WhatsApp). */
export interface Outbox {
  send(input: { waId: string; channel: string; text: string }): Promise<void>;
  /** Channel for contacts who never wrote in (staff, customers offered a reorder): WhatsApp when it is set up. */
  readonly defaultChannel?: string;
}

export interface InboundMessage {
  waId: string;
  channel: string;
  kind: 'text' | 'voice' | 'image';
  text?: string;
  /** Stored voice note or photo (see media.ts). */
  mediaId?: string;
  /** Typed by a guest account in the console: the run may not change stock or invoices on its own. */
  guest?: GuestSession;
  /** Already stored on arrival (acceptInbound): the run takes this row over instead of storing it again. */
  storedId?: number;
}

export interface InboundResult {
  messageId: number;
  runId: string;
  status: RunResult['status'];
  reply: string;
}

const HISTORY_LIMIT = 12;

/** Every run slot is busy and the wait list is full. */
export class ServiceBusyError extends Error {
  constructor() {
    super('SALURA is busy');
    this.name = 'ServiceBusyError';
  }
}

const APPROVAL_LABEL: Record<ApprovalType, string> = {
  order: 'pesanan',
  credit_override: 'pesanan lewat limit kredit',
  reminder: 'pengingat bayar',
  escalation: 'eskalasi',
  reorder: 'tawaran pesan ulang',
  delivery_query: 'pertanyaan pengiriman',
  invoice_adjustment: 'penyesuaian tagihan',
  payment: 'konfirmasi pembayaran',
};

/** How long a conversation lease lasts: longer than any run (90 s deadline), so a crashed holder frees it. */
const LEASE_MS = 150_000;
/** How long a message waits for the previous one from the same customer to finish. */
const LEASE_WAIT_MS = 100_000;
/** Renewal stops after a wait for a run slot, a run and its outbox: a holder stuck for good then frees the conversation. */
const LEASE_RENEW_SLACK_MS = 60_000;
/** A run still `running` this long after it started was cut off (server restart, killed instance). */
const STALE_RUN_MS = 3 * 60_000;

export class SaluraService {
  /** One agent run at a time per conversation, so replies never interleave (in this process; see withLease across processes). */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: AgentDeps & { outbox: Outbox; maxConcurrentRuns?: number; maxWaitingRuns?: number }) {}

  get db(): Db {
    return this.deps.db;
  }

  handleInbound(msg: InboundMessage): Promise<InboundResult> {
    const prev = this.queues.get(msg.waId) ?? Promise.resolve();
    // Lease first, then a run slot: waiting for another instance to finish this conversation must not
    // keep a slot from other customers. A run holding a slot never waits for a lease, so no deadlock.
    const next = prev
      .catch(() => undefined)
      .then(() =>
        this.withLease(msg.waId, (renew) =>
          this.withRunSlot(async () => {
            await renew();
            return this.processInbound(msg);
          }),
        ),
      );
    this.queues.set(msg.waId, next);
    const cleanup = () => {
      if (this.queues.get(msg.waId) === next) this.queues.delete(msg.waId);
    };
    // Both branches handled: a rejected run must reach the caller, never crash the process.
    next.then(cleanup, cleanup);
    return next;
  }

  /**
   * For a channel that cannot be asked to resend (a WhatsApp webhook that was already acknowledged):
   * the message is stored first, before it waits for anything, so it is never lost even if the
   * instance stops. A message the agent could not answer is handed to an admin.
   */
  async acceptInbound(msg: InboundMessage): Promise<void> {
    const { db, bus, clock } = this.deps;
    const [stored] = await db
      .insert(messages)
      .values({ waId: msg.waId, direction: 'in', channel: msg.channel, kind: msg.kind, text: msg.text ?? null, mediaId: msg.mediaId ?? null, createdAt: clock().toISOString() })
      .returning();
    await bus.emit({ type: 'message', message: stored! });
    try {
      await this.handleInbound({ ...msg, storedId: stored!.id });
    } catch (err) {
      const busy = err instanceof ServiceBusyError;
      if (!busy) console.error('inbound message failed', err);
      // No run took the message over: log its arrival on its own.
      const taken = await first(db.select({ runId: messages.runId }).from(messages).where(eq(messages.id, stored!.id)));
      if (!taken?.runId) {
        await new Audit(db, bus, clock, null).log({ actor: 'customer', type: 'message_in', summary: inboundSummary(msg), data: { messageId: stored!.id, waId: msg.waId, channel: msg.channel, kind: msg.kind } });
      }
      const customer = (await findCustomerByWa(db, msg.waId)) ?? null;
      await db.insert(approvals).values({
        type: 'escalation',
        customerId: customer?.id ?? 0,
        reason: busy
          ? `SALURA sedang penuh saat pesan ${msg.channel} ini masuk, jadi agen belum menjawabnya. Mohon balas langsung.`
          : `Agen gagal memproses pesan ${msg.channel} ini (${(err as Error).message}). Mohon cek dan balas langsung.`,
        payload: { waId: msg.waId, messageId: stored!.id },
        requestedAt: clock().toISOString(),
      });
    }
  }

  /** At most `maxConcurrentRuns` agent runs at once across all conversations; the rest wait their turn. */
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  private async withRunSlot<T>(fn: () => Promise<T>): Promise<T> {
    // A finished run hands its slot straight to the next waiter, so the cap is never exceeded.
    if (this.active >= (this.deps.maxConcurrentRuns ?? 4)) {
      // Refuse before the message is stored, so the sender can safely try again.
      if (this.waiting.length >= (this.deps.maxWaitingRuns ?? 8)) throw new ServiceBusyError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  /**
   * Conversation lease shared by every server instance: on Vercel two messages from one customer can
   * land on different instances, and they must still be answered one after the other.
   */
  private async withLease<T>(waId: string, fn: (renew: () => Promise<void>) => Promise<T>): Promise<T> {
    const { db } = this.deps;
    const holder = randomUUID();
    const waitUntil = Date.now() + LEASE_WAIT_MS;
    for (;;) {
      const now = Date.now();
      const got = await db
        .insert(conversationLocks)
        .values({ waId, holder, expiresAt: now + LEASE_MS })
        .onConflictDoUpdate({ target: conversationLocks.waId, set: { holder, expiresAt: now + LEASE_MS }, setWhere: lt(conversationLocks.expiresAt, now) })
        .returning({ holder: conversationLocks.holder });
      if (got.length) break;
      if (Date.now() >= waitUntil) throw new ServiceBusyError();
      await new Promise((r) => setTimeout(r, 400));
    }
    // Renewing fails only if another instance took the lease over (it expired while this one stalled).
    const renew = async () => {
      const kept = await db
        .update(conversationLocks)
        .set({ expiresAt: Date.now() + LEASE_MS })
        .where(and(eq(conversationLocks.waId, waId), eq(conversationLocks.holder, holder)))
        .returning({ holder: conversationLocks.holder });
      if (!kept.length) throw new ServiceBusyError();
    };
    // Kept alive while held: a long wait for a run slot, or a slow run or outbox, never lets it lapse.
    // Up to a ceiling: work that never finishes must not keep the conversation forever.
    const renewUntil = Date.now() + LEASE_WAIT_MS + (this.deps.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS) + LEASE_RENEW_SLACK_MS;
    const heartbeat = setInterval(() => {
      if (Date.now() >= renewUntil) clearInterval(heartbeat);
      else void renew().catch(() => undefined);
    }, LEASE_MS / 3);
    heartbeat.unref?.();
    try {
      return await fn(renew);
    } finally {
      clearInterval(heartbeat);
      await db.delete(conversationLocks).where(and(eq(conversationLocks.waId, waId), eq(conversationLocks.holder, holder))).catch(() => undefined);
    }
  }

  /** True while any instance is answering this customer. */
  async conversationBusy(waId: string): Promise<boolean> {
    if (this.queues.has(waId)) return true;
    const lock = await first(this.deps.db.select().from(conversationLocks).where(eq(conversationLocks.waId, waId)));
    return Boolean(lock && lock.expiresAt > Date.now());
  }

  private async processInbound(msg: InboundMessage): Promise<InboundResult> {
    const { db, bus, clock } = this.deps;
    const runId = randomUUID();
    const audit = new Audit(db, bus, clock, runId);
    const customer = (await findCustomerByWa(db, msg.waId)) ?? null;
    const guest = Boolean(msg.guest);

    const [stored] =
      msg.storedId !== undefined
        ? await db.update(messages).set({ runId }).where(eq(messages.id, msg.storedId)).returning()
        : await db
            .insert(messages)
            .values({ waId: msg.waId, direction: 'in', channel: msg.channel, kind: msg.kind, text: msg.text ?? null, mediaId: msg.mediaId ?? null, runId, guest, createdAt: clock().toISOString() })
            .returning();
    await bus.emit({ type: 'message', message: stored! });
    await audit.log({
      actor: 'customer',
      type: 'message_in',
      summary: inboundSummary(msg),
      data: { messageId: stored!.id, waId: msg.waId, channel: msg.channel, kind: msg.kind },
    });

    // A guest sees the whole conversation; the customer's own runs never see what a guest typed. Customer
    // messages stored after this one (taken in on arrival while this run waited) are left to their own runs.
    const recent = (
      await db
        .select()
        .from(messages)
        .where(and(eq(messages.waId, msg.waId), or(lte(messages.id, stored!.id), eq(messages.direction, 'out')), guest ? undefined : eq(messages.guest, false)))
        .orderBy(desc(messages.id))
        .limit(HISTORY_LIMIT)
    ).reverse();
    const history: ChatMessage[] = recent.map(toChatMessage);
    const allowedMessageIds = new Set(recent.map((m) => m.id));

    const result = await runAgent(this.deps, {
      runId,
      trigger: 'message',
      goal: `Pesan dari ${customer?.name ?? msg.waId}`,
      waId: msg.waId,
      channel: msg.channel,
      customer,
      systemPrompt: orderAgentPrompt({ now: clock(), customer, openDraft: customer ? ((await activeDraft(db, customer.id, guest)) ?? null) : null }),
      history,
      tools: ORDER_TOOLS,
      allowedMessageIds,
      fallbackReply: fallbackReply(customer),
      guest: msg.guest,
    });

    const sent = await this.sendToCustomer({ waId: msg.waId, channel: msg.channel, text: result.reply, runId: result.runId, actor: 'agent', guest });
    // The customer has seen their order only if a normally finished run sent a reply containing
    // its current total. A fallback reply, or a clarifying question without the total, does not count.
    const draft = customer ? await activeDraft(db, customer.id, guest) : undefined;
    if (result.status === 'completed' && customer && draft && result.reply.includes(rupiah(draft.subtotal))) {
      await markSummarySent(db, customer.id, sent.createdAt, guest);
    }
    return { messageId: stored!.id, runId: result.runId, status: result.status, reply: result.reply };
  }

  /** Persists, logs and delivers an outbound message. Delivery failures are logged, never thrown. */
  async sendToCustomer(input: { waId: string; channel?: string; text: string; runId: string | null; actor: 'agent' | 'human' | 'system'; sentBy?: string; guest?: boolean }) {
    const { db, bus, clock } = this.deps;
    const channel = input.guest ? 'web' : (input.channel ?? (await lastChannel(db, input.waId, this.deps.outbox.defaultChannel ?? 'web')));
    const [row] = await db
      .insert(messages)
      .values({ waId: input.waId, direction: 'out', channel, kind: 'text', text: input.text, runId: input.runId, guest: input.guest ?? false, createdAt: clock().toISOString() })
      .returning();
    await bus.emit({ type: 'message', message: row! });
    const audit = new Audit(db, bus, clock, input.runId);
    await audit.log({ actor: input.actor, type: 'message_out', summary: input.text, data: { messageId: row!.id, channel, ...(input.sentBy ? { sentBy: input.sentBy } : {}) } });
    try {
      await this.deps.outbox.send({ waId: input.waId, channel, text: input.text });
    } catch (err) {
      await audit.log({ actor: 'system', type: 'error', summary: `Pengiriman lewat ${channel} gagal: ${(err as Error).message}` });
    }
    return row!;
  }

  async decideApproval(input: {
    approvalId: number;
    decision: 'approve' | 'reject';
    decidedBy: string;
    note?: string;
    editedLines?: { productId: number; qty: number; unit: string }[];
  }) {
    const { db, bus, clock } = this.deps;
    const approval = await first(db.select().from(approvals).where(eq(approvals.id, input.approvalId)));
    if (!approval) throw new DomainError('approval_not_found', `Approval ${input.approvalId} not found`);
    const audit = new Audit(db, bus, clock, approval.runId);
    const now = clock();
    const customer = await first(db.select().from(customers).where(eq(customers.id, approval.customerId)));
    let sent: { waId: string; text: string } | null = null;

    if (approval.type === 'order' || approval.type === 'credit_override') {
      const { order, customerMessage } = await decideOrderApproval(db, { ...input, now });
      await bus.emit({ type: 'order', orderId: order.orderId });
      if (customer) sent = { waId: customer.waId, text: customerMessage };
    } else if (approval.type === 'reminder') {
      sent = await decideReminderApproval(db, { ...input, now });
    } else if (approval.type === 'delivery_query') {
      sent = await decideDeliveryQuery(db, { ...input, now });
    } else if (approval.type === 'invoice_adjustment') {
      sent = await decideInvoiceAdjustment(db, { ...input, now });
      if (approval.orderId) await bus.emit({ type: 'order', orderId: approval.orderId });
    } else if (approval.type === 'payment') {
      sent = await decidePaymentApproval(db, { ...input, now });
    } else if (approval.type === 'reorder') {
      const offer = await decideReorderApproval(db, { ...input, now });
      if (offer) {
        sent = offer;
        await bus.emit({ type: 'order', orderId: offer.orderId });
      }
    } else {
      // Escalations: only the status changes. Conditional, so a double click decides once.
      const decided = await db
        .update(approvals)
        .set({ status: input.decision === 'approve' ? 'approved' : 'rejected', decidedBy: input.decidedBy, decidedAt: now.toISOString(), decisionNote: input.note ?? null })
        .where(and(eq(approvals.id, approval.id), eq(approvals.status, 'pending')))
        .returning({ id: approvals.id });
      if (!decided.length) throw new DomainError('approval_not_pending', `Approval ${approval.id} is not pending`);
    }

    await audit.log({
      actor: 'human',
      type: 'approval',
      summary: `${input.decidedBy} ${input.decision === 'approve' ? 'menyetujui' : 'menolak'} ${APPROVAL_LABEL[approval.type]} #${approval.id}${input.editedLines?.length ? ' dengan perubahan' : ''}${input.note ? `: ${input.note}` : ''}`,
      data: { approvalId: approval.id, decision: input.decision, editedLines: input.editedLines },
    });
    await bus.emit({ type: 'approval', approvalId: approval.id });
    if (sent) {
      // The answer to a guest's test chat goes back to that chat, never to the customer's WhatsApp.
      // A staff query is the owner's own message to their staff and goes out as usual.
      const run = approval.runId && approval.type !== 'delivery_query' ? await first(db.select({ guest: agentRuns.guest }).from(agentRuns).where(eq(agentRuns.id, approval.runId))) : undefined;
      await this.sendToCustomer({ waId: sent.waId, text: sent.text, runId: approval.runId, actor: 'human', guest: run?.guest ?? false });
    }
    return (await first(db.select().from(approvals).where(eq(approvals.id, approval.id))))!;
  }

  /** What the "Ada yang salah" dialog shows before the admin decides: the block, or the draft notice. */
  orderCorrection(orderId: number) {
    return orderCorrection(this.deps.db, orderId);
  }

  /**
   * The admin's repair for an order the agent should not have confirmed: it is withdrawn, the stock
   * and the invoice go back, and the customer is told in plain words. The notice is the admin's own
   * message, so it is sent as `human` and shows under their name in the chat.
   */
  async cancelConfirmedOrder(input: { orderId: number; cancelledBy: string; reasonCode: string; note?: string; message?: string }) {
    const { db, bus, clock } = this.deps;
    const result = await cancelConfirmedOrder(db, { ...input, now: clock() });
    const customer = await first(db.select({ waId: customers.waId }).from(customers).where(eq(customers.id, result.order.customerId)));
    const guest = !!(await first(db.select({ guest: orders.guest }).from(orders).where(eq(orders.id, input.orderId))))?.guest;
    await new Audit(db, bus, clock, null).log({
      actor: 'human',
      type: 'data_change',
      summary: `${input.cancelledBy} membatalkan pesanan #${input.orderId} yang sudah dikonfirmasi (${result.order.lines.length} barang, ${rupiah(result.order.subtotal)})${
        result.releasedInvoice ? `, tagihan ${result.releasedInvoice} ditarik` : ''
      }: ${input.reasonCode}${input.note ? ` — ${input.note}` : ''}`,
      data: { orderId: input.orderId, reasonCode: input.reasonCode, note: input.note ?? null, releasedInvoice: result.releasedInvoice },
    });
    const text = input.message?.trim() || result.customerMessage;
    if (customer) await this.sendToCustomer({ waId: customer.waId, text, runId: null, actor: 'human', sentBy: input.cancelledBy, guest });
    return { order: result.order, releasedInvoice: result.releasedInvoice, customerMessage: text };
  }

  /** "Batalkan tindakan ini": puts the order back and tells the customer to ignore the cancellation. */
  async restoreCancelledOrder(input: { orderId: number; restoredBy: string; notify?: boolean }) {
    const { db, bus, clock } = this.deps;
    const result = await restoreCancelledOrder(db, { orderId: input.orderId, restoredBy: input.restoredBy, now: clock() });
    const customer = await first(db.select({ waId: customers.waId }).from(customers).where(eq(customers.id, result.order.customerId)));
    const guest = !!(await first(db.select({ guest: orders.guest }).from(orders).where(eq(orders.id, input.orderId))))?.guest;
    await new Audit(db, bus, clock, null).log({
      actor: 'human',
      type: 'data_change',
      summary: `${input.restoredBy} memulihkan pesanan #${input.orderId}: pembatalan tadi dibatalkan, stok dan tagihan kembali.`,
      data: { orderId: input.orderId },
    });
    if (input.notify !== false && customer) {
      await this.sendToCustomer({ waId: customer.waId, text: result.customerMessage, runId: null, actor: 'human', sentBy: input.restoredBy, guest });
    }
    return { order: result.order, customerMessage: result.customerMessage };
  }

  runCollections(trigger: 'schedule' | 'eval' = 'schedule'): Promise<RunResult> {
    const { clock } = this.deps;
    const runId = randomUUID();
    return this.withRunSlot(() => runAgent(this.deps, {
      runId,
      trigger,
      goal: 'Penagihan: pengingat tagihan terlambat',
      waId: null,
      channel: 'system',
      customer: null,
      systemPrompt: collectionsAgentPrompt(clock()),
      history: [{ role: 'user', content: 'Run the collections check for today.' }],
      tools: COLLECTION_TOOLS,
      maxSteps: 16,
      fallbackReply: 'Pengecekan tagihan tidak selesai; lihat jejak agen.',
      sendMessage: async (waId, text) => {
        await this.sendToCustomer({ waId, text, runId, actor: 'agent' });
      },
    }));
  }

  /**
   * Checks a photographed surat jalan or nota against its order and invoice: the agent reads the
   * document and maps its lines; the comparison and any follow-up are deterministic and approved.
   */
  async runDeliveryCheck(input: { orderId: number; kind: 'surat_jalan' | 'nota'; mediaId: string; source: 'console' | 'chat' }) {
    const { db, clock } = this.deps;
    const check = await createCheck(db, { ...input, now: clock() });
    const order = (await first(db.select().from(orders).where(eq(orders.id, input.orderId))))!;
    const customer = (await first(db.select().from(customers).where(eq(customers.id, order.customerId)))) ?? null;
    const runId = randomUUID();
    await db.update(deliveryChecks).set({ runId }).where(eq(deliveryChecks.id, check.id));
    const result = await this.withRunSlot(() =>
      runAgent(this.deps, {
        runId,
        trigger: 'delivery',
        goal: `Cek ${input.kind === 'surat_jalan' ? 'surat jalan' : 'nota'} pesanan #${input.orderId}`,
        waId: null,
        channel: 'system',
        customer,
        systemPrompt: deliveryAgentPrompt({ now: clock(), checkId: check.id, orderId: input.orderId, customerName: customer?.name ?? 'pelanggan', kind: input.kind }),
        history: [{ role: 'user', content: `Check delivery document #${check.id} now.` }],
        tools: DELIVERY_TOOLS,
        maxSteps: 14,
        fallbackReply: 'Pengecekan dokumen tidak selesai; lihat jejak agen.',
        deliveryCheckId: check.id,
      }),
    );
    // A run that never compared anything leaves the check unresolved for a person to look at.
    // The agent's closing report is kept with the result for the Pengiriman screen.
    const current = (await first(db.select().from(deliveryChecks).where(eq(deliveryChecks.id, check.id))))!;
    await db
      .update(deliveryChecks)
      .set({ status: current.status === 'pending' ? 'failed' : current.status, result: { ...(current.result ?? {}), agentReport: result.reply } })
      .where(eq(deliveryChecks.id, check.id));
    return { check: (await first(db.select().from(deliveryChecks).where(eq(deliveryChecks.id, check.id))))!, run: result };
  }

  /** Proactive sales: offers due customers their usual order (DESIGN: autonomy without a prompt). */
  runProactive(trigger: 'schedule' | 'eval' = 'schedule'): Promise<RunResult> {
    const { clock } = this.deps;
    const runId = randomUUID();
    return this.withRunSlot(() => runAgent(this.deps, {
      runId,
      trigger,
      goal: 'Tawaran pesan ulang ke warung yang lewat jadwal',
      waId: null,
      channel: 'system',
      customer: null,
      systemPrompt: proactiveAgentPrompt(clock()),
      history: [{ role: 'user', content: 'Run the proactive reorder check for today.' }],
      tools: PROACTIVE_TOOLS,
      maxSteps: 16,
      fallbackReply: 'Pengecekan tawaran pesan ulang tidak selesai; lihat jejak agen.',
      sendMessage: async (waId, text) => {
        await this.sendToCustomer({ waId, text, runId, actor: 'agent' });
      },
      conversationBusy: (waId) => this.conversationBusy(waId),
    }));
  }

  /**
   * Runs still marked `running` long after their deadline were cut off mid-way (server restart, a
   * killed serverless instance): the customer never got a reply. Close them as failed, hand each
   * conversation to a human, and send the fallback reply. Claimed with one UPDATE, so two
   * instances sweeping at once never handle the same run twice.
   */
  async recoverInterruptedRuns(staleMs = STALE_RUN_MS): Promise<number> {
    const { db, bus, clock } = this.deps;
    const now = clock().toISOString();
    const cutoff = new Date(clock().getTime() - staleMs).toISOString();
    const stuck = await db
      .update(agentRuns)
      .set({ status: 'failed', error: 'Interrupted (server restart or timeout)', endedAt: now })
      .where(and(eq(agentRuns.status, 'running'), lt(agentRuns.startedAt, cutoff)))
      .returning();
    for (const run of stuck) {
      await new Audit(db, bus, clock, run.id).log({
        actor: 'system',
        type: 'error',
        summary: run.guest ? 'Run chat uji akun tamu terputus (server dimulai ulang atau kehabisan waktu).' : 'Run terputus (server dimulai ulang atau kehabisan waktu); percakapan dialihkan ke admin.',
      });
      if (!run.waId) continue;
      const customer = (await findCustomerByWa(db, run.waId)) ?? null;
      // A guest's test chat gets its fallback reply but adds nothing to the owner's queue.
      if (!run.guest) {
        await db
          .insert(approvals)
          .values({ type: 'escalation', customerId: customer?.id ?? 0, reason: 'Run agen terputus sebelum selesai. Pelanggan sudah diberi balasan sementara; mohon dicek.', payload: { waId: run.waId }, runId: run.id, requestedAt: now });
      }
      await this.sendToCustomer({ waId: run.waId, text: fallbackReply(customer), runId: run.id, actor: 'system', guest: run.guest });
    }
    return stuck.length;
  }

  async pendingApprovalCount(): Promise<number> {
    const [row] = await this.deps.db.select({ n: count() }).from(approvals).where(eq(approvals.status, 'pending'));
    return row?.n ?? 0;
  }
}

function inboundSummary(msg: InboundMessage): string {
  return msg.kind === 'text' ? (msg.text ?? '') : `[${msg.kind === 'voice' ? 'Pesan suara' : 'Foto'}]${msg.text ? ` ${msg.text}` : ''}`;
}

function toChatMessage(m: typeof messages.$inferSelect): ChatMessage {
  if (m.direction === 'out') return { role: 'assistant', content: m.text ?? '' };
  if (m.kind === 'voice') {
    const body = m.transcript ? `Transcript: "${m.transcript}"` : 'Not transcribed yet: call transcribe_audio.';
    return { role: 'user', content: `[Voice note, message_id=${m.id}] ${body}${m.text ? `\nCaption: ${m.text}` : ''}` };
  }
  if (m.kind === 'image') {
    const body = m.transcript ? `Text read from the photo:\n${m.transcript}` : 'Not read yet: call read_order_image.';
    return { role: 'user', content: `[Photo, message_id=${m.id}] ${body}${m.text ? `\nCaption: ${m.text}` : ''}` };
  }
  return { role: 'user', content: m.text ?? '' };
}

/** Where the customer last wrote from; a guest typing in the console does not move them off WhatsApp. */
async function lastChannel(db: Db, waId: string, fallback: string): Promise<string> {
  const row = await first(
    db
      .select({ channel: messages.channel })
      .from(messages)
      .where(and(eq(messages.waId, waId), eq(messages.direction, 'in'), eq(messages.guest, false)))
      .orderBy(desc(messages.id))
      .limit(1),
  );
  return row?.channel ?? fallback;
}

function fallbackReply(customer: Customer | null): string {
  const name = customer ? `${customer.honorific} ${customer.ownerName.split(' ')[0]}` : 'Bapak/Ibu';
  return `Terima kasih ${name}, pesannya sudah kami terima. Admin kami akan segera mengecek dan membalas.`;
}
