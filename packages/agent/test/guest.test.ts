import { and, eq } from '@salura/db/orm';
import { describe, expect, it } from 'vitest';
import { agentRuns, approvals, deliveryChecks, first, invoices, messages, orders, payments, stock } from '@salura/db';
import type { ScriptStep } from '../src/llm/scripted.ts';
import { sampleFile } from '../src/assets.ts';
import { applyStatementMatches, matchStatement, type StatementLine } from '../src/domain/bank-matching.ts';
import { recentOrders, usualOrder } from '../src/domain/customers.ts';
import { compareDelivery, createCheck, deliveryOverview, proposeInvoiceAdjustment } from '../src/domain/delivery.ts';
import { rupiah } from '../src/domain/money.ts';
import { splitOrder } from '../src/domain/orders.ts';
import { overpayments, recordPaymentClaim } from '../src/domain/payments.ts';
import { reorderCandidates } from '../src/domain/reorder.ts';
import { markShipped, pickingList } from '../src/domain/warehouse.ts';
import { DELIVERY_SAMPLES, sampleOrderId } from '../src/samples.ts';
import { BU_SARI, customerByWa, freshDb, makeService, PAK_RASYID, productId, storeMedia, T0 } from './helpers.ts';

/** A guest session that allows `allowance` approvals and counts the ones actually queued. */
function guestSession(allowance = 10) {
  let queued = 0;
  return {
    queued: () => queued,
    session: {
      reserveApproval: async () => {
        if (queued >= allowance) return false;
        queued++;
        return true;
      },
      adjustApprovals: async (n: number) => void (queued += n),
    },
  };
}

const draftUsual: ScriptStep = ({ lastToolResults }) => ({
  call: [{ name: 'draft_order', args: { lines: (lastToolResults[0] as any).result.usualOrder.map((l: any) => ({ product_id: l.productId, qty: l.qty, unit: l.unit })) } }],
});
const summarizeDraft: ScriptStep = ({ lastToolResults }) => ({ say: `Siap Bu Sari, total ${rupiah((lastToolResults[0] as any).result.order.subtotal)}. Balas YA untuk proses ya.` });
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const photoId = (messages: { content: string }[]) => Number(/message_id=(\d+)/.exec(JSON.stringify(messages))![1]);
const invoiceByNumber = async (db: Awaited<ReturnType<typeof freshDb>>, number: string) => (await first(db.select().from(invoices).where(eq(invoices.number, number))))!;

describe('guest (viewer) chats', () => {
  it('holds an order for an admin even when the owner lets the agent confirm on its own, and approving it changes nothing real', async () => {
    const db = await freshDb();
    const reservedBefore = (await db.select().from(stock)).map((s) => s.reserved);
    const invoicesBefore = (await db.select().from(invoices)).length;
    const { service, sent } = makeService(db, [
      { call: [{ name: 'get_customer_profile', args: {} }] },
      draftUsual,
      summarizeDraft,
      { call: [{ name: 'get_customer_profile', args: {} }] },
      ({ lastToolResults }) => ({ call: [{ name: 'confirm_order', args: { order_id: (lastToolResults[0] as any).result.openDraft.orderId } }] }),
      ({ lastToolResults }) => {
        expect((lastToolResults[0] as any).result.outcome).toBe('awaiting_approval');
        return { say: 'Pesanan menunggu konfirmasi admin ya Bu.' };
      },
    ]);
    const guest = guestSession();
    await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'kirim yang biasa ya', guest: guest.session });
    await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'ya', guest: guest.session });

    const order = (await first(db.select().from(orders).where(eq(orders.historic, false))))!;
    expect(order).toMatchObject({ status: 'awaiting_approval', guest: true });
    const approval = (await first(db.select().from(approvals).where(eq(approvals.orderId, order.id))))!;
    expect(approval).toMatchObject({ type: 'order', status: 'pending' });
    expect(approval.reason).toContain('akun tamu');
    // Nothing reserved or invoiced until an admin decides; one approval counted against the allowance.
    expect((await db.select().from(stock)).map((s) => s.reserved)).toEqual(reservedBefore);
    expect(await db.select().from(invoices)).toHaveLength(invoicesBefore);
    expect(guest.queued()).toBe(1);
    expect((await first(db.select().from(agentRuns).where(eq(agentRuns.id, approval.runId!))))?.guest).toBe(true);

    const sari = await customerByWa(db, BU_SARI);
    const usualBefore = await usualOrder(db, sari.id);
    const rhythmBefore = (await reorderCandidates(db, at(100))).find((c) => c.customerId === sari.id);

    await service.decideApproval({ approvalId: approval.id, decision: 'approve', decidedBy: 'Pak Budi' });
    // Approved on paper only: the order reads as confirmed but stays a guest order, with no
    // reservation, no invoice, and no place in the warehouse, delivery, reorder or history views.
    expect(await first(db.select().from(orders).where(eq(orders.id, order.id)))).toMatchObject({ status: 'confirmed', guest: true, shippedAt: null });
    expect((await db.select().from(stock)).map((s) => s.reserved)).toEqual(reservedBefore);
    expect(await db.select().from(invoices)).toHaveLength(invoicesBefore);
    expect((await pickingList(db)).flatMap((b) => b.orders.map((o) => o.orderId))).not.toContain(order.id);
    expect(await markShipped(db, [order.id], at(100))).toEqual([]);
    expect((await deliveryOverview(db, at(100))).map((o) => o.orderId)).not.toContain(order.id);
    expect((await recentOrders(db, sari.id)).map((o) => o.orderId)).not.toContain(order.id);
    expect((await recentOrders(db, sari.id, true)).map((o) => o.orderId)).toContain(order.id);
    expect(await usualOrder(db, sari.id)).toEqual(usualBefore);
    expect((await reorderCandidates(db, at(100))).find((c) => c.customerId === sari.id)).toEqual(rhythmBefore);
    // The approval is answered in the guest's chat, not on the customer's own channel, and says it was a test.
    expect(sent.at(-1)).toMatchObject({ waId: BU_SARI, channel: 'web' });
    expect(sent.at(-1)?.text).toContain('Chat uji tamu');
    const last = (await db.select().from(messages).where(eq(messages.waId, BU_SARI))).at(-1)!;
    expect(last).toMatchObject({ direction: 'out', guest: true });
  });

  it("keeps a guest away from the customer's own draft, reorder offers and conversation", async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    const guest = guestSession();
    let realId = 0;
    const { service, model } = makeService(db, [
      // The customer (an admin typing as them) drafts their usual order and is shown the total.
      { call: [{ name: 'get_customer_profile', args: {} }] },
      draftUsual,
      ({ lastToolResults }) => {
        realId = (lastToolResults[0] as any).result.order.orderId;
        return summarizeDraft({ lastToolResults } as any);
      },
      // A guest says "ya" and tries to confirm or cancel that draft.
      { call: [{ name: 'get_customer_profile', args: {} }] },
      ({ lastToolResults }) => {
        expect((lastToolResults[0] as any).result.openDraft).toBeNull();
        return { call: [{ name: 'confirm_order', args: { order_id: realId } }, { name: 'cancel_order', args: { order_id: realId } }] };
      },
      ({ lastToolResults }) => {
        expect(lastToolResults.map((r: any) => r.error?.code)).toEqual(['order_not_found', 'order_not_found']);
        return { say: 'Maaf, pesanan itu tidak ada.' };
      },
      // The guest drafts an order of its own.
      { call: [{ name: 'draft_order', args: { lines: [{ product_id: 1, qty: 1, unit: 'dus' }] } }] },
      ({ lastToolResults }) => {
        expect((lastToolResults[0] as any).result.order.orderId).not.toBe(realId);
        return summarizeDraft({ lastToolResults } as any);
      },
      // The customer's next run sees only their own conversation and draft.
      ({ messages: seen }) => {
        expect(seen.map((m) => m.content).join('\n')).not.toMatch(/tambah satu|ya proses saja/);
        return { call: [{ name: 'get_customer_profile', args: {} }] };
      },
      ({ lastToolResults }) => {
        expect((lastToolResults[0] as any).result.openDraft.orderId).toBe(realId);
        return { say: 'Pesanan Ibu masih menunggu jawaban YA.' };
      },
    ]);
    await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'kirim yang biasa' });
    const realBefore = (await first(db.select().from(orders).where(eq(orders.id, realId))))!;
    const [offer] = await db
      .insert(approvals)
      .values({ type: 'reorder', customerId: sari.id, reason: 'Jadwal belanja', payload: {}, requestedAt: at(1).toISOString() })
      .returning();

    await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'ya proses saja', guest: guest.session });
    await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'tambah satu dus', guest: guest.session });
    await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'gimana pesanan saya?' });
    expect(model.remaining).toBe(0);

    // The customer's draft keeps its lines and the moment their summary was shown.
    expect(realBefore.summarySentAt).not.toBeNull();
    expect(await first(db.select().from(orders).where(eq(orders.id, realId)))).toMatchObject({ status: 'awaiting_customer', subtotal: realBefore.subtotal, summarySentAt: realBefore.summarySentAt, guest: false });
    expect((await first(db.select().from(approvals).where(eq(approvals.id, offer!.id))))?.status).toBe('pending');
    // Refusals queue nothing, so they cost the guest nothing.
    expect(guest.queued()).toBe(0);
    const guestMessages = await db.select().from(messages).where(and(eq(messages.waId, BU_SARI), eq(messages.guest, true)));
    expect(guestMessages.map((m) => m.direction)).toEqual(['in', 'out', 'in', 'out']);
  });

  it('checks a promise-to-pay date but does not save it', async () => {
    const db = await freshDb();
    const invoice = (await first(db.select().from(invoices).where(eq(invoices.number, 'INV-00007'))))!;
    const { service } = makeService(db, [
      { call: [{ name: 'record_promise_to_pay', args: { invoice_id: invoice.id, date: '2026-10-24' } }] },
      ({ lastToolResults }) => {
        expect((lastToolResults[0] as any).result).toMatchObject({ number: 'INV-00007', promiseToPayAt: '2026-10-24', saved: false });
        return { say: 'Baik Pak, tanggalnya kami sampaikan ke admin.' };
      },
    ]);
    const guest = guestSession();
    await service.handleInbound({ waId: PAK_RASYID, channel: 'web', kind: 'text', text: 'saya transfer hari Sabtu', guest: guest.session });
    expect((await first(db.select().from(invoices).where(eq(invoices.id, invoice.id))))?.promiseToPayAt).toBeNull();
    expect(guest.queued()).toBe(0);
  });

  it('queues nothing once the guest has used up its approvals for the hour', async () => {
    const db = await freshDb();
    const { service } = makeService(db, [
      { call: [{ name: 'escalate_to_human', args: { reason: 'Pelanggan minta bicara dengan admin' } }] },
      ({ lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ ok: false, error: { code: 'guest_limit' } });
        return { say: 'Mohon maaf Bu, coba lagi nanti ya.' };
      },
    ]);
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'mau bicara sama admin', guest: guestSession(0).session });
    expect(r.status).toBe('completed');
    expect(await db.select().from(approvals)).toEqual([]);
  });

  it('holds a guest order whole instead of splitting it into two approvals', async () => {
    const db = await freshDb();
    const sari = await customerByWa(db, BU_SARI);
    await expect(splitOrder(db, { orderId: 1, customerId: sari.id, now: at(1), guest: true })).rejects.toMatchObject({ code: 'guest_no_split' });
  });

  it("never lets a guest's payment claim block the customer's own, or its delivery check stand for the order", async () => {
    const db = await freshDb();
    const rasyid = await customerByWa(db, PAK_RASYID);
    await recordPaymentClaim(db, { customerId: rasyid.id, amount: 500_000, reference: 'TRF-77', now: at(1), guest: true });
    const real = await recordPaymentClaim(db, { customerId: rasyid.id, amount: 500_000, reference: 'TRF-77', now: at(2) });
    expect((await first(db.select().from(payments).where(eq(payments.id, real.paymentId))))?.guest).toBe(false);

    const orderId = (await sampleOrderId(db, DELIVERY_SAMPLES[0]!))!;
    await createCheck(db, { orderId, kind: 'nota', source: 'guest', mediaId: await storeMedia(db, 'image/jpeg'), now: at(3) });
    const row = (await deliveryOverview(db, at(4))).find((o) => o.orderId === orderId)!;
    expect(row).toMatchObject({ latestCheck: null, checks: 0 });
  });

  it("recovers a cut-off guest run without escalating, and keeps the customer's channel", async () => {
    const db = await freshDb();
    const { service, sent } = makeService(db, []);
    await db.insert(messages).values({ waId: BU_SARI, direction: 'in', channel: 'whatsapp', kind: 'text', text: 'halo', createdAt: at(1).toISOString() });
    await db.insert(agentRuns).values({ id: 'guest-run', trigger: 'message', goal: 'x', waId: BU_SARI, status: 'running', guest: true, startedAt: at(-600).toISOString() });
    await db.insert(messages).values({ waId: BU_SARI, direction: 'in', channel: 'web', kind: 'text', text: 'tes', runId: 'guest-run', guest: true, createdAt: at(2).toISOString() });

    expect(await service.recoverInterruptedRuns(0)).toBe(1);
    expect(await db.select().from(approvals)).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ channel: 'web' });
    // The guest typing on the web does not move the customer's own replies off WhatsApp.
    await service.sendToCustomer({ waId: BU_SARI, text: 'Pesanan sudah dikirim.', runId: null, actor: 'human' });
    expect(sent.at(-1)).toMatchObject({ channel: 'whatsapp' });
  });
  it("records a guest's transfer receipt through the tools, keeps it out of bank matching, and approves it on paper only", async () => {
    const db = await freshDb();
    // Pak Rasyid owes INV-00007 Rp776.200 and INV-00008 Rp504.000.
    const receipt = await storeMedia(db, 'image/jpeg', 'TYPE: payment_proof\nJumlah: Rp776.200\nTanggal: 20/10/2026\nBank: BCA\nReferensi: TRF-UJI-01');
    const { service, sent } = makeService(db, [
      ({ messages }) => ({ call: [{ name: 'record_payment', args: { amount: 776_200, paid_on: '2026-10-20', bank: 'BCA', reference: 'TRF-UJI-01', message_id: photoId(messages) } }] }),
      { say: 'Terima kasih Pak, bukti transfernya sedang dicek admin.' },
    ]);
    const guest = guestSession();
    await service.handleInbound({ waId: PAK_RASYID, channel: 'web', kind: 'image', mediaId: receipt, text: 'sudah transfer', guest: guest.session });
    const claim = (await first(db.select().from(payments)))!;
    expect(claim).toMatchObject({ status: 'pending', guest: true, reference: 'TRF-UJI-01' });
    expect(guest.queued()).toBe(1);

    // The real transfer on the statement is matched to the invoices, never to the test claim.
    const lines: StatementLine[] = [{ row: 1, postedOn: '2026-10-20', description: 'TRF DARI 0812-3450-0003', amount: 776_200 }];
    const [before] = await matchStatement(db, lines);
    expect(before!.candidates.map((c) => c.kind)).toEqual(['invoices']);

    const approval = (await first(db.select().from(approvals).where(eq(approvals.type, 'payment'))))!;
    await service.decideApproval({ approvalId: approval.id, decision: 'approve', decidedBy: 'Pak Budi' });
    expect(await first(db.select().from(payments).where(eq(payments.id, claim.id)))).toMatchObject({ status: 'approved', guest: true });
    expect(await invoiceByNumber(db, 'INV-00007')).toMatchObject({ status: 'open', paidAmount: 0 });
    expect(await overpayments(db)).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ waId: PAK_RASYID, channel: 'web' });
    expect(sent.at(-1)?.text).toContain('Chat uji tamu');
    const [after] = await matchStatement(db, lines);
    expect(after!.candidates.map((c) => c.kind)).toEqual(['invoices']);

    // A test approval is not money received: the customer's own claim for that transfer still goes through.
    const rasyid = await customerByWa(db, PAK_RASYID);
    await expect(recordPaymentClaim(db, { customerId: rasyid.id, amount: 776_200, paidOn: '2026-10-20', reference: 'TRF-UJI-01', now: at(10) })).resolves.toMatchObject({ amount: 776_200 });
  });

  it('refuses a guest claim for a transfer already confirmed from the bank statement', async () => {
    const db = await freshDb();
    const now = new Date(T0.getTime() + 7 * 86_400_000);
    const lines: StatementLine[] = [{ row: 1, postedOn: '2026-10-25', description: 'TRSF E-BANKING CR SARI WULANDARI', amount: 624_100 }];
    const [l] = await matchStatement(db, lines);
    await applyStatementMatches(db, { lines, selections: [{ hash: l!.hash, candidateId: l!.candidates[0]!.id }], decidedBy: 'Pak Budi', now });
    const sari = await customerByWa(db, BU_SARI);
    await expect(recordPaymentClaim(db, { customerId: sari.id, amount: 624_100, paidOn: '2026-10-25', reference: 'UJI-REF', now, guest: true })).rejects.toMatchObject({ code: 'duplicate_payment' });
  });

  it("opens a guest's delivery check through the tools, never blocks the real correction, and messages no staff", async () => {
    const db = await freshDb();
    const sample = DELIVERY_SAMPLES.find((s) => s.id === 'surat-jalan-bu-sari')!;
    const orderId = (await sampleOrderId(db, sample))!;
    const invoice = (await first(db.select().from(invoices).where(eq(invoices.orderId, orderId))))!;
    const photo = await storeMedia(db, 'image/jpeg', `TYPE: delivery_document\n${sampleFile(`${sample.file}.txt`).toString('utf8')}`);
    const [indomie, aqua, kopi, bimoli] = (await Promise.all(['IDM-GRG-85', 'AQA-600', 'KPA-SMX-25', 'BML-2L'].map((sku) => productId(db, sku)))) as [number, number, number, number];
    const delivered = [
      { productId: indomie, qty: 2, unit: 'dus' },
      { productId: aqua, qty: 1, unit: 'dus' },
      { productId: kopi, qty: 4, unit: 'renceng' },
      { productId: bimoli, qty: 6, unit: 'pcs' },
    ];
    let checkId = 0;
    const { service, sent, model } = makeService(db, [
      ({ messages }) => ({ call: [{ name: 'report_delivery_problem', args: { message_id: photoId(messages) } }] }),
      ({ lastToolResults }) => {
        checkId = (lastToolResults[0] as any).result.checkId;
        return { call: [{ name: 'compare_delivery', args: { check_id: checkId, lines: delivered.map((l) => ({ product_id: l.productId, qty: l.qty, unit: l.unit })) } }] };
      },
      () => ({
        call: [
          { name: 'propose_invoice_adjustment', args: { check_id: checkId, reason: 'Kapal Api hanya terkirim 4 dari 5 renceng.' } },
          { name: 'draft_staff_query', args: { check_id: checkId, recipient: 'warehouse', message: 'Pesanan Bu Sari: Kapal Api dikirim 4 renceng dari 5, masih di gudang?' } },
        ],
      }),
      { say: 'Mohon maaf Bu, kekurangannya sudah kami ajukan ke admin.' },
    ]);
    const guest = guestSession();
    await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'image', mediaId: photo, text: 'kapal api kurang', guest: guest.session });
    expect(model.remaining).toBe(0);
    expect(await first(db.select().from(deliveryChecks).where(eq(deliveryChecks.id, checkId)))).toMatchObject({ orderId, source: 'guest', status: 'mismatch' });
    const queued = await db.select().from(approvals).where(eq(approvals.orderId, orderId)).orderBy(approvals.id);
    expect(queued.map((a) => [a.type, a.status])).toEqual([
      ['invoice_adjustment', 'pending'],
      ['delivery_query', 'pending'],
    ]);
    expect(guest.queued()).toBe(2);

    // The owner's own check of the same delivery is not blocked by the guest's pending correction.
    const real = await createCheck(db, { orderId, kind: 'surat_jalan', source: 'console', mediaId: photo, now: at(100) });
    await compareDelivery(db, { checkId: real.id, lines: delivered });
    const proposal = await proposeInvoiceAdjustment(db, { checkId: real.id, reason: 'Kapal Api kurang 1 renceng', now: at(101) });

    const stockBefore = await db.select().from(stock).orderBy(stock.productId);
    const sentBefore = sent.length;
    await service.decideApproval({ approvalId: queued[0]!.id, decision: 'approve', decidedBy: 'Pak Budi' });
    // On paper only: the invoice and stock stay, and the answer goes to the guest's chat.
    expect((await first(db.select().from(invoices).where(eq(invoices.id, invoice.id))))?.amount).toBe(invoice.amount);
    expect(await db.select().from(stock).orderBy(stock.productId)).toEqual(stockBefore);
    expect(sent.at(-1)).toMatchObject({ waId: BU_SARI, channel: 'web' });
    expect(sent.at(-1)?.text).toContain('Chat uji tamu');
    // The staff question is approved but never sent to the warehouse.
    await service.decideApproval({ approvalId: queued[1]!.id, decision: 'approve', decidedBy: 'Pak Budi' });
    expect(sent).toHaveLength(sentBefore + 1);
    expect((await first(db.select().from(approvals).where(eq(approvals.id, queued[1]!.id))))?.status).toBe('approved');

    // The owner's correction still applies.
    await service.decideApproval({ approvalId: proposal.approvalId, decision: 'approve', decidedBy: 'Pak Budi' });
    expect((await first(db.select().from(invoices).where(eq(invoices.id, invoice.id))))?.amount).toBe(proposal.invoiceTo);
  });
});
