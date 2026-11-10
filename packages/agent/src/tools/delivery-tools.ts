import { eq } from '@salura/db/orm';
import { z } from 'zod';
import { deliveryChecks } from '@salura/db';
import { loadMedia } from '../media.ts';
import { compareDelivery, draftStaffQuery, getCheck, proposeInvoiceAdjustment } from '../domain/delivery.ts';
import { rupiah } from '../domain/money.ts';
import { getOrder } from '../domain/orders.ts';
import { escalateToHuman, searchCatalogTool } from './order-tools.ts';
import { defineTool, ToolUsageError, type ToolContext, type ToolDef } from './types.ts';

const checkId = z.number().int().positive();

async function ownCheck(ctx: ToolContext, id: number) {
  if (ctx.deliveryCheckId === undefined) throw new ToolUsageError('no_check', 'No delivery check is open in this run; call report_delivery_problem first');
  if (ctx.deliveryCheckId !== id) throw new ToolUsageError('wrong_check', `This run works on delivery check ${ctx.deliveryCheckId}, not ${id}`);
  return getCheck(ctx.db, id);
}

export const readDeliveryDocument = defineTool({
  name: 'read_delivery_document',
  description:
    'Read the photographed surat jalan (delivery note) or nota (invoice) of this check: document number on the first line, then one line per item with quantity, unit and prices if shown. Also returns the order the document should match.',
  sideEffect: 'read',
  schema: z.object({ check_id: checkId }),
  async run(ctx, { check_id }) {
    const check = await ownCheck(ctx, check_id);
    let text = check.documentText;
    if (text === null) {
      const file = await loadMedia(ctx.db, check.mediaId);
      if (!file) throw new Error('The document photo is missing');
      text = (await ctx.vision.read(file, 'delivery_document')).text;
      await ctx.db.update(deliveryChecks).set({ documentText: text }).where(eq(deliveryChecks.id, check.id));
    }
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      await ctx.db.update(deliveryChecks).set({ status: 'unreadable' }).where(eq(deliveryChecks.id, check.id));
      return { lines: [], note: 'No delivery document could be read from this photo. Escalate so a person checks it.' };
    }
    return { kind: check.kind, lines, unreadableLines: lines.filter((l) => l.includes('[?]')).length, order: await getOrder(ctx.db, check.orderId) };
  },
  summarize: (_a, r) => (r.lines.length ? `Terbaca ${r.lines.length} baris dari dokumen` : 'Dokumen tidak terbaca'),
});

export const compareDeliveryTool = defineTool({
  name: 'compare_delivery',
  description:
    'Compare the document against the order and its invoice. Pass every item line from the document mapped to a product (use search_catalog for the names) with the quantity actually written as delivered (after any correction such as "5 → 4"). Include unit_price only if the document shows one. Returns per-product status (ok, short, missing, over, not_ordered), price mismatches, the value of undelivered goods and how much the invoice overcharges.',
  sideEffect: 'write',
  schema: z.object({
    check_id: checkId,
    document_number: z.string().optional(),
    lines: z
      .array(
        z.object({
          product_id: z.number().int().positive(),
          qty: z.number().nonnegative(),
          unit: z.string(),
          unit_price: z.number().int().positive().optional(),
          raw_text: z.string().optional(),
        }),
      )
      .max(60),
  }),
  async run(ctx, args) {
    await ownCheck(ctx, args.check_id);
    return compareDelivery(ctx.db, {
      checkId: args.check_id,
      documentNumber: args.document_number,
      lines: args.lines.map((l) => ({ productId: l.product_id, qty: l.qty, unit: l.unit, unitPrice: l.unit_price, rawText: l.raw_text })),
    });
  },
  summarize: (_a, r) =>
    r.matches
      ? 'Dokumen cocok dengan pesanan dan tagihan'
      : `${r.lines.filter((l: any) => l.status !== 'ok' || l.priceMismatch).length} baris berbeda${r.overbilled ? ` · tagihan kelebihan ${rupiah(r.overbilled)}` : ''}`,
});

export const draftStaffQueryTool = defineTool({
  name: 'draft_staff_query',
  description:
    'Write a short WhatsApp question in Bahasa Indonesia to the warehouse (stock picked or still in the warehouse?) or the driver (unloaded, damaged, returned?) about the mismatched items. It is sent when the owner approves.',
  sideEffect: 'external',
  queuesApproval: true,
  schema: z.object({
    check_id: checkId,
    recipient: z.enum(['warehouse', 'driver']),
    message: z.string().min(10).max(800).describe('Polite, specific: order number, customer, each item with ordered vs delivered quantity, and what you need them to confirm'),
  }),
  async run(ctx, args) {
    await ownCheck(ctx, args.check_id);
    return draftStaffQuery(ctx.db, { checkId: args.check_id, recipient: args.recipient, message: args.message, now: ctx.now(), runId: ctx.runId });
  },
  summarize: (_a, r) => `Pertanyaan untuk ${r.recipient} menunggu persetujuan`,
});

export const proposeInvoiceAdjustmentTool = defineTool({
  name: 'propose_invoice_adjustment',
  description:
    "When the invoice charges for goods that were not delivered, propose lowering it by that amount (computed by the system) so the customer is not billed or reminded for them. Applied when the owner approves.",
  sideEffect: 'write',
  queuesApproval: true,
  schema: z.object({ check_id: checkId, reason: z.string().min(5).describe('One sentence in Bahasa Indonesia for the owner') }),
  async run(ctx, args) {
    await ownCheck(ctx, args.check_id);
    return proposeInvoiceAdjustment(ctx.db, { checkId: args.check_id, reason: args.reason, now: ctx.now(), runId: ctx.runId });
  },
  summarize: (_a, r) => `Usul ${r.invoiceNumber}: ${rupiah(r.invoiceFrom)} → ${rupiah(r.invoiceTo)}`,
});

export const DELIVERY_TOOLS: ToolDef[] = [readDeliveryDocument, searchCatalogTool, compareDeliveryTool, draftStaffQueryTool, proposeInvoiceAdjustmentTool, escalateToHuman] as ToolDef[];
