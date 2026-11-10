import { z } from 'zod';
import { rupiah } from '../domain/money.ts';
import { draftReminder, overdueInvoices } from '../domain/reminders.ts';
import { defineTool, type ToolDef } from './types.ts';

export const getOverdueInvoices = defineTool({
  name: 'get_overdue_invoices',
  description:
    "All open invoices past their due date, oldest first, with each customer's preferred tone, days overdue, promise-to-pay date and when they were last reminded.",
  sideEffect: 'read',
  schema: z.object({}),
  async run(ctx) {
    return { invoices: await overdueInvoices(ctx.db, ctx.now()) };
  },
  summarize: (_a, r) =>
    `${r.invoices.length} tagihan lewat jatuh tempo, ${rupiah(r.invoices.reduce((s: number, i: any) => s + i.outstanding, 0))} belum dibayar`,
});

export const draftReminderTool = defineTool({
  name: 'draft_reminder',
  description:
    "Prepare a payment reminder from an approved template in the tone you choose. Depending on the owner's policy it is sent now or queued for approval. Refused if the invoice was reminded in the last 3 days or a promise-to-pay date has not passed.",
  sideEffect: 'external',
  schema: z.object({
    invoice_id: z.number().int().positive(),
    tone: z.enum(['friendly', 'neutral', 'firm']),
    reason: z.string().min(5).describe('Why this tone: one sentence in Bahasa Indonesia, shown to the distributor owner'),
  }),
  async run(ctx, args) {
    const result = await draftReminder(ctx.db, { invoiceId: args.invoice_id, tone: args.tone, reason: args.reason, now: ctx.now(), runId: ctx.runId });
    if (result.outcome === 'sent') {
      if (!ctx.sendMessage) throw new Error('No outbound channel available to send the reminder');
      await ctx.sendMessage(result.waId, result.text);
    }
    return result;
  },
  summarize: (a, r) => `Pengingat nada ${a.tone} → ${r.outcome === 'sent' ? 'terkirim' : 'menunggu persetujuan'}`,
});

export const COLLECTION_TOOLS: ToolDef[] = [getOverdueInvoices, draftReminderTool] as ToolDef[];
