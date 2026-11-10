import { eq, inArray } from '@salura/db/orm';
import { z } from 'zod';
import { approvals, first, messages, products } from '@salura/db';
import { searchCatalog } from '../domain/catalog.ts';
import { creditStatus, openInvoices, recentOrders, usualOrder } from '../domain/customers.ts';
import { rupiah } from '../domain/money.ts';
import {
  activeDraft,
  availableBase,
  cancelOrder,
  confirmOrder,
  describeQty,
  draftOrder,
  requestOrderApproval,
  splitOrder,
} from '../domain/orders.ts';
import { recordPromiseToPay } from '../domain/reminders.ts';
import { PolicyIndex } from '../knowledge.ts';
import { loadMedia } from '../media.ts';
import { parsePhotoText } from '../vision.ts';
import { defineTool, requireCustomer, ToolUsageError } from './types.ts';

const id = z.number().int().positive();

export const getCustomerProfile = defineTool({
  name: 'get_customer_profile',
  description:
    "Who is messaging: store name, price tier, credit limit, unpaid balance, their usual order ('yang biasa'), recent orders, open invoices and any open draft order. Call this first in every conversation turn.",
  sideEffect: 'read',
  schema: z.object({}),
  async run(ctx) {
    const c = requireCustomer(ctx);
    const now = ctx.now();
    return {
      customer: { id: c.id, store: c.name, owner: c.ownerName, tier: c.tier, area: c.area, paymentTermDays: c.paymentTermDays },
      credit: await creditStatus(ctx.db, c.id, now),
      usualOrder: await usualOrder(ctx.db, c.id),
      recentOrders: await recentOrders(ctx.db, c.id, Boolean(ctx.guest)),
      openInvoices: await openInvoices(ctx.db, c.id, now),
      openDraft: (await activeDraft(ctx.db, c.id, Boolean(ctx.guest))) ?? null,
    };
  },
  summarize: (_a, r) =>
    `${r.customer.store} (tier ${r.customer.tier}) · sisa kredit ${rupiah(r.credit.available)} · pesanan biasa ${r.usualOrder.length} item${r.openDraft ? ` · draf terbuka #${r.openDraft.orderId}` : ''}`,
});

export const searchCatalogTool = defineTool({
  name: 'search_catalog',
  description:
    'Match the free-text product names the customer wrote to catalog products. Pass every product phrase at once. Each result has candidates with a confidence score, the units the product is sold in, how often this customer bought it, `ambiguous`, and sometimes a `historyHint` naming the product this customer usually means.',
  sideEffect: 'read',
  schema: z.object({ queries: z.array(z.string().min(1)).min(1).max(20).describe('Product phrases exactly as the customer wrote them, without quantities') }),
  async run(ctx, { queries }) {
    const results = [];
    for (const q of queries) results.push(await searchCatalog(ctx.db, q, ctx.customer?.id));
    return { results };
  },
  summarize: (a, r) => {
    const ambiguous = r.results.filter((x: any) => x.ambiguous).length;
    return `${a.queries.length} frasa dicocokkan${ambiguous ? `, ${ambiguous} ambigu` : ''}`;
  },
});

export const checkStock = defineTool({
  name: 'check_stock',
  description: 'Current available stock (on hand minus already reserved) for products.',
  sideEffect: 'read',
  schema: z.object({ product_ids: z.array(id).min(1).max(30) }),
  async run(ctx, { product_ids }) {
    const rows = await ctx.db.select().from(products).where(inArray(products.id, product_ids)).orderBy(products.id);
    const stock = [];
    for (const p of rows) {
      const base = await availableBase(ctx.db, p.id);
      stock.push({ productId: p.id, name: p.name, available: await describeQty(ctx.db, p.id, base, 'dus'), availableBaseUnits: base, baseUnit: p.baseUnit });
    }
    return { stock };
  },
  summarize: (_a, r) => `Stok tersedia: ${r.stock.map((s: any) => `${s.name} ${s.available}`).join(' · ')}`,
});

export const checkCredit = defineTool({
  name: 'check_credit',
  description: "Whether an amount fits the customer's remaining credit (limit minus unpaid invoices).",
  sideEffect: 'read',
  schema: z.object({ amount: z.number().int().nonnegative() }),
  async run(ctx, { amount }) {
    const c = requireCustomer(ctx);
    const credit = await creditStatus(ctx.db, c.id, ctx.now());
    // The checked amount is the model's own input, so it is not returned as a money field (price guard).
    return { ...credit, checkedAmount: amount, fits: amount <= credit.available, shortfall: Math.max(0, amount - credit.available) };
  },
  summarize: (_a, r) => (r.fits ? `Muat di limit kredit (sisa ${rupiah(r.available)})` : `Melebihi limit kredit sebesar ${rupiah(r.shortfall)}`),
});

export const draftOrderTool = defineTool({
  name: 'draft_order',
  description:
    "Create the customer's draft order, or replace all lines of their open draft. Prices come from the price list automatically; never pass prices. Returns the priced order plus issues: out_of_stock (with approved substitutes), over_credit, low_confidence. Always pass the full list of lines the order should contain.",
  sideEffect: 'write',
  schema: z.object({
    lines: z
      .array(
        z.object({
          product_id: id,
          qty: z.number().int().positive(),
          unit: z.string().describe('One of the units listed for the product, e.g. dus, pcs, renceng, karung, pak'),
          raw_text: z.string().optional().describe('What the customer wrote for this line'),
          match_confidence: z.number().min(0).max(1).optional(),
          substituted_from_product_id: id.optional().describe('Set when the customer agreed to this product as a substitute'),
        }),
      )
      .min(1)
      .max(40),
    delivery_note: z.string().optional(),
  }),
  run(ctx, args) {
    const c = requireCustomer(ctx);
    return draftOrder(ctx.db, {
      customerId: c.id,
      channel: ctx.channel,
      now: ctx.now(),
      guest: Boolean(ctx.guest),
      deliveryNote: args.delivery_note ?? null,
      lines: args.lines.map((l) => ({
        productId: l.product_id,
        qty: l.qty,
        unit: l.unit,
        rawText: l.raw_text,
        matchConfidence: l.match_confidence,
        substitutedFromProductId: l.substituted_from_product_id,
      })),
    });
  },
  summarize: (_a, r) =>
    `Draf #${r.order.orderId}: ${r.order.lines.length} baris, ${rupiah(r.order.subtotal)}${r.issues.length ? ` · masalah: ${r.issues.map((i: any) => i.type).join(', ')}` : ''}`,
});

export const confirmOrderTool = defineTool({
  name: 'confirm_order',
  description:
    'Confirm a draft after the customer has explicitly agreed to the summary you sent. The system re-checks stock and credit and applies the owner\'s autonomy policy. Outcomes: confirmed, awaiting_approval, or blocked_over_credit (then choose split_order or request_approval).',
  sideEffect: 'write',
  queuesApproval: true,
  schema: z.object({ order_id: id }),
  run(ctx, { order_id }) {
    const c = requireCustomer(ctx);
    return confirmOrder(ctx.db, { orderId: order_id, customerId: c.id, now: ctx.now(), runId: ctx.runId, guest: Boolean(ctx.guest) });
  },
  summarize: (_a, r) =>
    r.outcome === 'blocked_over_credit'
      ? `Tertahan: melebihi limit kredit ${rupiah(r.shortfall)} (bisa dipecah: ${r.canSplit ? 'ya' : 'tidak'})`
      : `${r.outcome === 'confirmed' ? 'Dikonfirmasi' : 'Menunggu persetujuan pemilik'} · ${rupiah(r.order.subtotal)}`,
});

export const splitOrderTool = defineTool({
  name: 'split_order',
  description:
    'For an order blocked as over credit: confirm the lines that fit the available credit now and hold the remainder as a separate order for the owner to approve.',
  sideEffect: 'write',
  queuesApproval: true,
  schema: z.object({ order_id: id }),
  run(ctx, { order_id }) {
    const c = requireCustomer(ctx);
    return splitOrder(ctx.db, { orderId: order_id, customerId: c.id, now: ctx.now(), runId: ctx.runId, guest: Boolean(ctx.guest) });
  },
  summarize: (_a, r) =>
    `Dipecah: ${rupiah(r.confirmedPart.order.subtotal)} diproses sekarang (${r.confirmedPart.outcome}), ${rupiah(r.heldOrder.subtotal)} ditahan untuk persetujuan #${r.approvalId}`,
});

export const requestApprovalTool = defineTool({
  name: 'request_approval',
  description: 'Hold the whole order for the distributor owner to approve, with a clear reason. Use when splitting does not make sense.',
  sideEffect: 'write',
  queuesApproval: true,
  schema: z.object({ order_id: id, reason: z.string().min(5).describe('Shown to the distributor owner: one plain sentence in Bahasa Indonesia') }),
  run(ctx, { order_id, reason }) {
    const c = requireCustomer(ctx);
    return requestOrderApproval(ctx.db, { orderId: order_id, customerId: c.id, reason, now: ctx.now(), runId: ctx.runId, guest: Boolean(ctx.guest) });
  },
  summarize: (_a, r) => `Pesanan #${r.order.orderId} ditahan untuk persetujuan #${r.approvalId} (${r.type})`,
});

export const cancelOrderTool = defineTool({
  name: 'cancel_order',
  description: 'Cancel the customer\'s open draft when they say they no longer want it.',
  sideEffect: 'write',
  schema: z.object({ order_id: id }),
  run(ctx, { order_id }) {
    const c = requireCustomer(ctx);
    return cancelOrder(ctx.db, { orderId: order_id, customerId: c.id, now: ctx.now(), guest: Boolean(ctx.guest) });
  },
  summarize: (_a, r) => `Pesanan #${r.orderId} dibatalkan`,
});

export const recordPromiseToPayTool = defineTool({
  name: 'record_promise_to_pay',
  description: 'Record the date the customer says they will pay an open invoice (e.g. "saya transfer hari Jumat").',
  sideEffect: 'write',
  schema: z.object({ invoice_id: id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD') }),
  async run(ctx, { invoice_id, date }) {
    const c = requireCustomer(ctx);
    const promise = await recordPromiseToPay(ctx.db, { invoiceId: invoice_id, customerId: c.id, date, now: ctx.now(), dryRun: Boolean(ctx.guest) });
    if (!ctx.guest) return promise;
    return { ...promise, saved: false, note: 'Guest test chat: the date is valid but was not saved. Thank the customer and say the admin will note it.' };
  },
  summarize: (_a, r) => (r.saved === false ? `Janji bayar ${r.number} ${r.promiseToPayAt} tidak disimpan (chat uji akun tamu)` : `Janji bayar ${r.number} dicatat: ${r.promiseToPayAt}`),
});

export const escalateToHuman = defineTool({
  name: 'escalate_to_human',
  description:
    'Hand the conversation to the order desk with a clear reason: complaints, returns, unknown numbers, requests outside ordering and payments, or anything you cannot resolve safely.',
  sideEffect: 'write',
  queuesApproval: true,
  schema: z.object({ reason: z.string().min(5).describe('Shown to the order desk: one plain sentence in Bahasa Indonesia') }),
  async run(ctx, { reason }) {
    const draft = ctx.customer ? await activeDraft(ctx.db, ctx.customer.id, Boolean(ctx.guest)) : undefined;
    const [row] = await ctx.db
      .insert(approvals)
      .values({
        type: 'escalation',
        customerId: ctx.customer?.id ?? 0,
        orderId: draft?.orderId ?? null,
        reason,
        payload: { waId: ctx.waId },
        runId: ctx.runId,
        requestedAt: ctx.now().toISOString(),
      })
      .returning({ id: approvals.id });
    return { escalationId: row!.id };
  },
  summarize: (a, r) => `Diteruskan ke admin (eskalasi #${r.escalationId}): ${a.reason}`,
});

export const transcribeAudio = defineTool({
  name: 'transcribe_audio',
  description: 'Transcribe an Indonesian voice note from this conversation to text.',
  sideEffect: 'read',
  schema: z.object({ message_id: id }),
  async run(ctx, { message_id }) {
    if (!ctx.allowedMessageIds.has(message_id)) throw new ToolUsageError('unknown_message', `Message ${message_id} is not in this conversation`);
    const msg = await first(ctx.db.select().from(messages).where(eq(messages.id, message_id)));
    if (!msg || msg.kind !== 'voice' || !msg.mediaId) throw new ToolUsageError('not_voice', `Message ${message_id} is not a voice note`);
    if (msg.transcript) return { messageId: message_id, transcript: msg.transcript, cached: true };
    const file = await loadMedia(ctx.db, msg.mediaId);
    if (!file) throw new Error('The voice note file is missing');
    const { text } = await ctx.stt.transcribe(file);
    await ctx.db.update(messages).set({ transcript: text }).where(eq(messages.id, message_id));
    return { messageId: message_id, transcript: text, provider: ctx.stt.name };
  },
  summarize: (_a, r) => `"${r.transcript}"`,
});

export const readOrderImage = defineTool({
  name: 'read_order_image',
  description:
    'Read a photo from this conversation. Returns `type` (order_list, payment_proof, delivery_document or other) and its lines as written; unreadable words are marked [?]. An order list is handled exactly like a typed order; a payment_proof goes to record_payment; a delivery_document with a complaint goes to report_delivery_problem.',
  sideEffect: 'read',
  schema: z.object({ message_id: id }),
  async run(ctx, { message_id }) {
    if (!ctx.allowedMessageIds.has(message_id)) throw new ToolUsageError('unknown_message', `Message ${message_id} is not in this conversation`);
    const msg = await first(ctx.db.select().from(messages).where(eq(messages.id, message_id)));
    if (!msg || msg.kind !== 'image' || !msg.mediaId) throw new ToolUsageError('not_image', `Message ${message_id} is not a photo`);
    if (msg.transcript) return { messageId: message_id, ...parsePhotoText(msg.transcript), cached: true, ...PHOTO_NEXT_STEP };
    const file = await loadMedia(ctx.db, msg.mediaId);
    if (!file) throw new Error('The photo file is missing');
    const { text } = await ctx.vision.read(file, 'chat_photo');
    const { type, lines } = parsePhotoText(text);
    if (!lines.length) {
      return { messageId: message_id, type, lines, provider: ctx.vision.name, note: 'Nothing could be read from this photo. Ask the customer to type it or send a clearer photo.' };
    }
    // Stored with its type, so later turns (and the cache above) know what the photo was.
    await ctx.db.update(messages).set({ transcript: type === 'order_list' ? lines.join('\n') : [`TYPE: ${type}`, ...lines].join('\n') }).where(eq(messages.id, message_id));
    return { messageId: message_id, type, lines, unreadableLines: lines.filter((l) => l.includes('[?]')).length, provider: ctx.vision.name, ...PHOTO_NEXT_STEP };
  },
  summarize: (_a, r) =>
    r.lines.length ? `${PHOTO_LABEL[r.type as keyof typeof PHOTO_LABEL] ?? 'Foto'}: ${r.lines.length} baris terbaca · ${r.lines.join(' · ')}` : 'Tidak ada yang terbaca di foto',
});

const PHOTO_LABEL = { order_list: 'Daftar pesanan', payment_proof: 'Bukti transfer', delivery_document: 'Dokumen pengiriman', other: 'Foto lain' };
const PHOTO_NEXT_STEP = {
  howToHandle: 'order_list → like a typed order. payment_proof → record_payment. delivery_document with a complaint → report_delivery_problem. other → ask what they need.',
};

let policyIndex: PolicyIndex | null = null;

export const searchPolicies = defineTool({
  name: 'search_policies',
  description:
    "Search the distributor's own policy documents (delivery schedule per area, order cut-off, returns and complaints, payment and credit rules, service hours, substitutions). Returns the best matching sections with a `source` id. Answer policy questions only from these sections and mention the source in your reasoning.",
  sideEffect: 'read',
  schema: z.object({ query: z.string().min(2).describe('The question in the customer\'s words, e.g. "kapan dikirim ke cikarang"') }),
  run(_ctx, { query }) {
    policyIndex ??= new PolicyIndex();
    const hits = policyIndex.search(query);
    return { hits: hits.map((h) => ({ source: h.source, document: h.document, section: h.section, text: h.text, score: h.score })), found: hits.length > 0 };
  },
  summarize: (_a, r) => (r.found ? `Ditemukan ${r.hits.map((h: any) => h.source).join(', ')}` : 'Tidak ada kebijakan yang cocok'),
});
