import { eq } from '@salura/db/orm';
import { z } from 'zod';
import { customers, first } from '@salura/db';
import { DomainError } from '../domain/orders.ts';
import { reorderCandidates, sendReorderNudge } from '../domain/reorder.ts';
import { defineTool, type ToolDef } from './types.ts';

export const getReorderCandidates = defineTool({
  name: 'get_reorder_candidates',
  description:
    "Customers with a regular ordering rhythm: their usual order, average days between orders, days since the last order, `due`, and `skipReason` (non-null means you must not contact them now: open draft, overdue invoices, recently offered, or not due yet).",
  sideEffect: 'read',
  schema: z.object({}),
  async run(ctx) {
    return { candidates: await reorderCandidates(ctx.db, ctx.now()) };
  },
  summarize: (_a, r) => {
    const ready = r.candidates.filter((c: any) => !c.skipReason).length;
    return `${r.candidates.length} pelanggan berpola tetap, ${ready} siap ditawari`;
  },
});

export const sendReorderNudgeTool = defineTool({
  name: 'send_reorder_nudge',
  description:
    "Offer a due customer their usual order: prepares a priced draft from the price list (out-of-stock items are left out) and an approved message asking them to reply YA. Sent now or queued for the owner's approval, per policy. Refused when the customer has a skipReason.",
  sideEffect: 'external',
  schema: z.object({
    customer_id: z.number().int().positive(),
    reason: z.string().min(5).describe('Why now: one sentence in Bahasa Indonesia, shown to the distributor owner'),
  }),
  async run(ctx, args) {
    const waId = (await first(ctx.db.select({ waId: customers.waId }).from(customers).where(eq(customers.id, args.customer_id))))?.waId;
    if (waId && (await ctx.conversationBusy?.(waId))) {
      throw new DomainError('customer_busy', 'The agent is talking with this customer right now; skip them this time');
    }
    const result = await sendReorderNudge(ctx.db, { customerId: args.customer_id, reason: args.reason, now: ctx.now(), runId: ctx.runId });
    if (result.outcome === 'sent') {
      if (!ctx.sendMessage) throw new Error('No outbound channel available to send the offer');
      await ctx.sendMessage(result.waId, result.text);
    }
    return result;
  },
  summarize: (_a, r) =>
    `${r.outcome === 'sent' ? `Tawaran pesanan #${r.orderId} terkirim` : 'Tawaran menunggu persetujuan pemilik'}${r.droppedOutOfStock.length ? ` (tanpa ${r.droppedOutOfStock.join(', ')}: stok habis)` : ''}`,
});

export const PROACTIVE_TOOLS: ToolDef[] = [getReorderCandidates, sendReorderNudgeTool] as ToolDef[];
