import { and, desc, eq, isNotNull } from '@salura/db/orm';
import { z } from 'zod';
import { deliveryChecks, first, messages, orders } from '@salura/db';
import { createCheck } from '../domain/delivery.ts';
import { rupiah } from '../domain/money.ts';
import { getOrder } from '../domain/orders.ts';
import { recordPaymentClaim } from '../domain/payments.ts';
import { parsePhotoText } from '../vision.ts';
import { defineTool, requireCustomer, ToolUsageError } from './types.ts';

// After-sales tools of the order agent: a customer reporting a payment or a delivery problem.

const id = z.number().int().positive();

export const recordPayment = defineTool({
  name: 'record_payment',
  description:
    "Record a payment the customer reports (usually a transfer receipt photo read with read_order_image). The system proposes which open invoices it pays, oldest due first, and queues it for the owner, who checks the bank account before anything is marked paid. Pass the amount as a whole number of rupiah exactly as on the receipt.",
  sideEffect: 'write',
  queuesApproval: true,
  schema: z.object({
    amount: z.number().int().positive().describe('Whole rupiah, e.g. 1250000 for "Rp1.250.000"'),
    paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Transfer date YYYY-MM-DD, if shown'),
    bank: z.string().max(60).optional(),
    reference: z.string().max(80).optional(),
    sender_name: z.string().max(80).optional(),
    invoice_numbers: z.array(z.string().max(20)).max(10).optional().describe('Only invoices the customer named, e.g. ["INV-00003"]'),
    message_id: id.optional().describe('The photo of the receipt, when there is one'),
  }),
  async run(ctx, args) {
    const c = requireCustomer(ctx);
    if (args.message_id !== undefined && !ctx.allowedMessageIds.has(args.message_id)) {
      throw new ToolUsageError('unknown_message', `Message ${args.message_id} is not in this conversation`);
    }
    return recordPaymentClaim(ctx.db, {
      customerId: c.id,
      amount: args.amount,
      paidOn: args.paid_on,
      bank: args.bank,
      reference: args.reference,
      senderName: args.sender_name,
      invoiceNumbers: args.invoice_numbers,
      messageId: args.message_id,
      now: ctx.now(),
      runId: ctx.runId,
      guest: Boolean(ctx.guest),
    });
  },
  summarize: (_a, r) =>
    `Bukti bayar ${rupiah(r.amount)} dicatat untuk ${r.allocations.map((a: any) => a.number).join(', ')} · menunggu cek pemilik (#${r.approvalId})`,
});

export const reportDeliveryProblem = defineTool({
  name: 'report_delivery_problem',
  description:
    "The customer says a delivery was wrong (barang kurang, salah kirim, tagihan tidak sesuai) and sent a photo of the surat jalan or nota. Opens a delivery check for that photo against their order (the latest delivered one unless order_id is given). Then call read_delivery_document, search_catalog, compare_delivery and, for differences, draft_staff_query and propose_invoice_adjustment with the returned check_id.",
  sideEffect: 'write',
  schema: z.object({
    message_id: id.describe('The photo of the surat jalan or nota'),
    order_id: id.optional().describe('Only when the customer or the document names the order'),
  }),
  async run(ctx, args) {
    const c = requireCustomer(ctx);
    if (!ctx.allowedMessageIds.has(args.message_id)) throw new ToolUsageError('unknown_message', `Message ${args.message_id} is not in this conversation`);
    const msg = await first(ctx.db.select().from(messages).where(eq(messages.id, args.message_id)));
    if (!msg || msg.kind !== 'image' || !msg.mediaId) throw new ToolUsageError('not_image', `Message ${args.message_id} is not a photo`);
    if (ctx.deliveryCheckId !== undefined) throw new ToolUsageError('check_open', `Delivery check ${ctx.deliveryCheckId} is already open in this run; continue with it`);

    let orderId = args.order_id;
    if (orderId !== undefined) {
      const o = await first(ctx.db.select().from(orders).where(eq(orders.id, orderId)));
      // An order approved in a guest's test chat was never delivered, so it is never checked.
      if (!o || o.customerId !== c.id || o.guest) throw new ToolUsageError('order_not_found', `Order ${orderId} is not an order of this customer`);
    } else {
      const latest = await first(
        ctx.db
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.customerId, c.id), eq(orders.status, 'confirmed'), eq(orders.guest, false), isNotNull(orders.shippedAt)))
          .orderBy(desc(orders.shippedAt), desc(orders.id))
          .limit(1),
      );
      if (!latest) throw new ToolUsageError('no_delivery_order', 'This customer has no delivered order to check; escalate to a person');
      orderId = latest.id;
    }

    // A photo already read in the chat is not read again: its lines become the document text.
    const read = msg.transcript ? parsePhotoText(msg.transcript) : null;
    const text = read?.lines.join('\n') ?? null;
    const kind = /\b(nota|faktur|invoice|inv-)/i.test(text ?? '') ? 'nota' : 'surat_jalan';
    const check = await createCheck(ctx.db, { orderId, kind, source: ctx.guest ? 'guest' : 'chat', mediaId: msg.mediaId, now: ctx.now() });
    await ctx.db.update(deliveryChecks).set({ runId: ctx.runId, documentText: text }).where(eq(deliveryChecks.id, check.id));
    // From here on the delivery tools in this run work on this check only.
    ctx.deliveryCheckId = check.id;
    return { checkId: check.id, kind, order: await getOrder(ctx.db, orderId) };
  },
  summarize: (_a, r) => `Cek pengiriman #${r.checkId} dibuka untuk pesanan #${r.order.orderId} (${r.kind === 'nota' ? 'nota' : 'surat jalan'} dari chat)`,
});
