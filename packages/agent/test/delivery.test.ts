import { eq } from '@salura/db/orm';
import { describe, expect, it } from 'vitest';
import { approvals, deliveryChecks, first, invoices, orders, stock, type Db } from '@salura/db';
import { compareDelivery, createCheck, decideInvoiceAdjustment, proposeInvoiceAdjustment } from '../src/domain/delivery.ts';
import { overpayments, settleOverpayment } from '../src/domain/payments.ts';
import { sampleFile } from '../src/assets.ts';
import { DELIVERY_SAMPLES, sampleOrderId, storeSample } from '../src/samples.ts';
import { freshDb, makeService, productId, storeMedia, T0 } from './helpers.ts';

const at = (s: number) => new Date(T0.getTime() + s * 1000);
const MAKMUR = DELIVERY_SAMPLES.find((s) => s.id === 'nota-toko-makmur-jaya')!;
const SARI = DELIVERY_SAMPLES.find((s) => s.id === 'surat-jalan-bu-sari')!;

/** A photo with no stored transcript: the domain functions never read it. */
const anyPhoto = (db: Db) => storeMedia(db, 'image/jpeg');

describe('delivery comparison', () => {
  it('finds each sample order in the seed', async () => {
    const db = await freshDb();
    expect(await sampleOrderId(db, MAKMUR)).toBeTypeOf('number');
    expect(await sampleOrderId(db, SARI)).toBeTypeOf('number');
  });

  it('flags a short delivery, values it at the order price and finds the overbilled amount', async () => {
    const db = await freshDb();
    const orderId = (await sampleOrderId(db, MAKMUR))!;
    const check = await createCheck(db, { orderId, kind: 'nota', source: 'console', mediaId: await anyPhoto(db), now: at(1) });
    const r = await compareDelivery(db, {
      checkId: check.id,
      documentNumber: 'FK-2026-0988',
      lines: [
        { productId: await productId(db, 'BRS-SR-25'), qty: 10, unit: 'karung', unitPrice: 338_100 },
        { productId: await productId(db, 'FLM-2L'), qty: 3, unit: 'dus', unitPrice: 220_500 },
        { productId: await productId(db, 'TPG-SGB-1KG'), qty: 4, unit: 'dus', unitPrice: 152_900 },
      ],
    });
    expect(r.matches).toBe(false);
    const beras = r.lines.find((l) => l.name.startsWith('Beras'))!;
    expect(beras).toMatchObject({ status: 'short', ordered: '12 karung', delivered: '10 karung', shortfallValue: 676_200, priceMismatch: null });
    expect(r.overbilled).toBe(676_200);
    expect((await first(db.select().from(deliveryChecks).where(eq(deliveryChecks.id, check.id))))?.status).toBe('mismatch');
  });

  it('reports a price on the nota that differs from the order', async () => {
    const db = await freshDb();
    const orderId = (await sampleOrderId(db, MAKMUR))!;
    const check = await createCheck(db, { orderId, kind: 'nota', source: 'console', mediaId: await anyPhoto(db), now: at(1) });
    const r = await compareDelivery(db, {
      checkId: check.id,
      lines: [
        { productId: await productId(db, 'BRS-SR-25'), qty: 12, unit: 'karung', unitPrice: 345_000 },
        { productId: await productId(db, 'FLM-2L'), qty: 3, unit: 'dus' },
        { productId: await productId(db, 'TPG-SGB-1KG'), qty: 4, unit: 'dus' },
      ],
    });
    expect(r.lines.find((l) => l.name.startsWith('Beras'))?.priceMismatch).toEqual({ unit: 'karung', ordered: 338_100, onDocument: 345_000 });
    expect(r.overbilled).toBe(0);
  });

  it('only checks shipped (confirmed) orders', async () => {
    const db = await freshDb();
    await expect(createCheck(db, { orderId: 9999, kind: 'nota', source: 'console', mediaId: await anyPhoto(db), now: at(1) })).rejects.toThrow(/not found/);
    // Confirmed but still in the warehouse: a correction now would release stock that loading takes off again.
    const orderId = (await sampleOrderId(db, MAKMUR))!;
    await db.update(orders).set({ shippedAt: null }).where(eq(orders.id, orderId));
    await expect(createCheck(db, { orderId, kind: 'nota', source: 'console', mediaId: await anyPhoto(db), now: at(1) })).rejects.toMatchObject({ code: 'not_shipped' });
  });

  it('applies an approved invoice correction and puts the undelivered goods back on the shelf', async () => {
    const db = await freshDb();
    const orderId = (await sampleOrderId(db, MAKMUR))!;
    const invoice = (await first(db.select().from(invoices).where(eq(invoices.orderId, orderId))))!;
    const check = await createCheck(db, { orderId, kind: 'nota', source: 'console', mediaId: await anyPhoto(db), now: at(1) });
    await compareDelivery(db, {
      checkId: check.id,
      lines: [
        { productId: await productId(db, 'BRS-SR-25'), qty: 10, unit: 'karung' },
        { productId: await productId(db, 'FLM-2L'), qty: 3, unit: 'dus' },
        { productId: await productId(db, 'TPG-SGB-1KG'), qty: 4, unit: 'dus' },
      ],
    });
    await db.update(stock).set({ reserved: 5 }).where(eq(stock.productId, await productId(db, 'BRS-SR-25')));
    const before = await first(db.select().from(stock).where(eq(stock.productId, await productId(db, 'BRS-SR-25'))));
    const p = await proposeInvoiceAdjustment(db, { checkId: check.id, reason: 'Beras kurang 2 karung', now: at(2) });
    expect(p).toMatchObject({ invoiceFrom: invoice.amount, invoiceTo: invoice.amount - 676_200 });
    await expect(proposeInvoiceAdjustment(db, { checkId: check.id, reason: 'lagi', now: at(3) })).rejects.toThrow(/already waiting/);

    const sent = (await decideInvoiceAdjustment(db, { approvalId: p.approvalId, decision: 'approve', decidedBy: 'Pak Budi', now: at(4) }))!;
    expect(sent.text).toContain(invoice.number);
    expect((await first(db.select().from(invoices).where(eq(invoices.id, invoice.id))))?.amount).toBe(invoice.amount - 676_200);
    // The order had already left the warehouse, so the 2 karung that never arrived are back on the shelf.
    const after = await first(db.select().from(stock).where(eq(stock.productId, await productId(db, 'BRS-SR-25'))));
    expect(after?.reserved).toBe(5);
    expect(after?.onHand).toBe(before!.onHand + 2);
  });

  it('flags a correction that takes a partly paid invoice below what was paid, and records the overpayment', async () => {
    const db = await freshDb();
    const orderId = (await sampleOrderId(db, MAKMUR))!;
    const invoice = (await first(db.select().from(invoices).where(eq(invoices.orderId, orderId))))!;
    const paid = invoice.amount - 100_000;
    await db.update(invoices).set({ paidAmount: paid, promiseToPayAt: at(100).toISOString() }).where(eq(invoices.id, invoice.id));
    const check = await createCheck(db, { orderId, kind: 'nota', source: 'console', mediaId: await anyPhoto(db), now: at(1) });
    await compareDelivery(db, {
      checkId: check.id,
      lines: [
        { productId: await productId(db, 'BRS-SR-25'), qty: 10, unit: 'karung' },
        { productId: await productId(db, 'FLM-2L'), qty: 3, unit: 'dus' },
        { productId: await productId(db, 'TPG-SGB-1KG'), qty: 4, unit: 'dus' },
      ],
    });
    const overpaid = paid - (invoice.amount - 676_200);
    const p = await proposeInvoiceAdjustment(db, { checkId: check.id, reason: 'Beras kurang 2 karung', now: at(2) });
    expect(p).toMatchObject({ invoiceTo: invoice.amount - 676_200, overpaid });
    // The owner sees the overpayment before deciding.
    const approval = (await first(db.select().from(approvals).where(eq(approvals.id, p.approvalId))))!;
    expect(approval.payload).toMatchObject({ paidAmount: paid, overpaid });
    expect(approval.reason).toContain(`lebih bayar Rp${overpaid.toLocaleString('id-ID')}`);

    const sent = (await decideInvoiceAdjustment(db, { approvalId: p.approvalId, decision: 'approve', decidedBy: 'Pak Budi', now: at(3) }))!;
    expect(sent.text).toContain(`lebih Rp${overpaid.toLocaleString('id-ID')}`);
    // Settled by the correction: closed, no promise left, and paid stays what the customer really paid.
    expect(await first(db.select().from(invoices).where(eq(invoices.id, invoice.id)))).toMatchObject({ amount: invoice.amount - 676_200, paidAmount: paid, status: 'paid', promiseToPayAt: null });
    expect(await overpayments(db)).toEqual([expect.objectContaining({ source: 'invoice_correction', id: invoice.id, reference: invoice.number, amount: overpaid })]);

    // Once the owner has refunded or offset it, it leaves the list, and cannot be settled twice.
    await settleOverpayment(db, { source: 'invoice_correction', id: invoice.id, now: at(4) });
    expect(await overpayments(db)).toEqual([]);
    await expect(settleOverpayment(db, { source: 'invoice_correction', id: invoice.id, now: at(5) })).rejects.toMatchObject({ code: 'overpayment_not_found' });
  });

  it('records no overpayment when the corrected invoice is still above what was paid', async () => {
    const db = await freshDb();
    const orderId = (await sampleOrderId(db, MAKMUR))!;
    const invoice = (await first(db.select().from(invoices).where(eq(invoices.orderId, orderId))))!;
    await db.update(invoices).set({ paidAmount: 100_000 }).where(eq(invoices.id, invoice.id));
    const check = await createCheck(db, { orderId, kind: 'nota', source: 'console', mediaId: await anyPhoto(db), now: at(1) });
    await compareDelivery(db, { checkId: check.id, lines: [{ productId: await productId(db, 'BRS-SR-25'), qty: 10, unit: 'karung' }, { productId: await productId(db, 'FLM-2L'), qty: 3, unit: 'dus' }, { productId: await productId(db, 'TPG-SGB-1KG'), qty: 4, unit: 'dus' }] });
    const p = await proposeInvoiceAdjustment(db, { checkId: check.id, reason: 'Beras kurang 2 karung', now: at(2) });
    expect(p.overpaid).toBe(0);
    await decideInvoiceAdjustment(db, { approvalId: p.approvalId, decision: 'approve', decidedBy: 'Pak Budi', now: at(3) });
    expect((await first(db.select().from(invoices).where(eq(invoices.id, invoice.id))))?.status).toBe('open');
    expect(await overpayments(db)).toEqual([]);
  });
});

describe('delivery check agent run', () => {
  it('reads the sample nota, compares it, and queues a warehouse query plus an invoice correction', async () => {
    const db = await freshDb();
    const orderId = (await sampleOrderId(db, MAKMUR))!;
    const { service, sent } = makeService(db, [
      ({ messages }) => ({ call: [{ name: 'read_delivery_document', args: { check_id: Number(/#(\d+)/.exec(messages[0]!.content)![1]) } }] }),
      ({ lastToolResults }) => {
        const r = (lastToolResults[0] as any).result;
        expect(r.lines[1]).toContain('12 → 10 karung');
        return { call: [{ name: 'search_catalog', args: { queries: ['Beras Setra Ramos 25kg', 'Filma Minyak Goreng 2L', 'Segitiga Biru 1kg'] } }] };
      },
      ({ messages, lastToolResults }) => {
        const [beras, filma, tepung] = (lastToolResults[0] as any).result.results.map((x: any) => x.candidates[0].productId);
        const checkId = Number(/#(\d+)/.exec(messages[0]!.content)![1]);
        return {
          call: [
            {
              name: 'compare_delivery',
              args: {
                check_id: checkId,
                document_number: 'FK-2026-0988',
                lines: [
                  { product_id: beras, qty: 10, unit: 'karung', unit_price: 338_100 },
                  { product_id: filma, qty: 3, unit: 'dus', unit_price: 220_500 },
                  { product_id: tepung, qty: 4, unit: 'dus', unit_price: 152_900 },
                ],
              },
            },
          ],
        };
      },
      ({ messages, lastToolResults }) => {
        expect((lastToolResults[0] as any).result.overbilled).toBe(676_200);
        const checkId = Number(/#(\d+)/.exec(messages[0]!.content)![1]);
        return {
          call: [
            { name: 'draft_staff_query', args: { check_id: checkId, recipient: 'warehouse', message: 'Pak Dedi, pesanan Toko Makmur Jaya: beras dipesan 12 karung, di nota tercatat 10. Apakah 2 karung masih di gudang?' } },
            { name: 'propose_invoice_adjustment', args: { check_id: checkId, reason: 'Beras hanya terkirim 10 dari 12 karung.' } },
          ],
        };
      },
      { say: 'Beras kurang 2 karung. Pertanyaan ke gudang dan penyesuaian tagihan menunggu persetujuan.' },
    ]);
    const { check, run } = await service.runDeliveryCheck({ orderId, kind: 'nota', mediaId: await storeSample(db, MAKMUR), source: 'console' });
    expect(run.status).toBe('completed');
    expect(check.status).toBe('mismatch');
    const queued = (await db.select().from(approvals).where(eq(approvals.orderId, orderId))).map((a) => a.type).sort();
    expect(queued).toEqual(['delivery_query', 'invoice_adjustment']);

    // Owner sends the warehouse question: it goes to the warehouse contact.
    const query = (await first(db.select().from(approvals).where(eq(approvals.type, 'delivery_query'))))!;
    await service.decideApproval({ approvalId: query.id, decision: 'approve', decidedBy: 'Pak Budi' });
    expect(sent.at(-1)?.waId).toBe('6281234509001');
  });

  it('refuses tools aimed at a different check', async () => {
    const db = await freshDb();
    const orderId = (await sampleOrderId(db, SARI))!;
    const { service } = makeService(db, [
      { call: [{ name: 'read_delivery_document', args: { check_id: 999 } }] },
      ({ lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ ok: false, error: { code: 'wrong_check' } });
        return { say: 'Selesai.' };
      },
    ]);
    const { check } = await service.runDeliveryCheck({ orderId, kind: 'surat_jalan', mediaId: await storeSample(db, SARI), source: 'console' });
    expect(check.status).toBe('failed');
  });
});

describe('delivery problem reported in the chat', () => {
  it('opens a check from the customer photo, compares it and queues an invoice correction', async () => {
    const db = await freshDb();
    const orderId = (await sampleOrderId(db, SARI))!;
    const transcript = sampleFile(`${SARI.file}.txt`).toString('utf8');
    const photo = await storeMedia(db, 'image/jpeg', `TYPE: delivery_document\n${transcript}`);
    const [indomie, aqua, kopi, bimoli] = await Promise.all(['IDM-GRG-85', 'AQA-600', 'KPA-SMX-25', 'BML-2L'].map((sku) => productId(db, sku)));
    const photoId = (messages: { content: string }[]) => Number(/message_id=(\d+)/.exec(JSON.stringify(messages))![1]);
    let checkId = 0;
    const { service, model } = makeService(db, [
      // A delivery tool before a check is open is refused.
      { call: [{ name: 'read_delivery_document', args: { check_id: 1 } }] },
      ({ messages, lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ ok: false, error: { code: 'no_check' } });
        return { call: [{ name: 'read_order_image', args: { message_id: photoId(messages) } }] };
      },
      ({ messages, lastToolResults }) => {
        const r = (lastToolResults[0] as any).result;
        expect(r.type).toBe('delivery_document');
        expect(r.lines[0]).toBe('No: SJ-2026-1017 · 16/10/2026');
        return { call: [{ name: 'report_delivery_problem', args: { message_id: photoId(messages) } }] };
      },
      ({ lastToolResults }) => {
        const r = (lastToolResults[0] as any).result;
        // Without an order_id it is the customer's latest delivered order: the one on the sample.
        expect(r.order.orderId).toBe(orderId);
        expect(r.kind).toBe('surat_jalan');
        checkId = r.checkId;
        return { call: [{ name: 'read_delivery_document', args: { check_id: checkId } }] };
      },
      ({ lastToolResults }) => {
        const r = (lastToolResults[0] as any).result;
        // The text already read in the chat is reused, without its TYPE header.
        expect(r.lines).toEqual(transcript.split('\n').map((l) => l.trim()).filter(Boolean));
        return {
          call: [
            {
              name: 'compare_delivery',
              args: {
                check_id: checkId,
                document_number: 'SJ-2026-1017',
                lines: [
                  { product_id: indomie, qty: 2, unit: 'dus' },
                  { product_id: aqua, qty: 1, unit: 'dus' },
                  { product_id: kopi, qty: 4, unit: 'renceng' },
                  { product_id: bimoli, qty: 6, unit: 'pcs' },
                ],
              },
            },
          ],
        };
      },
      ({ lastToolResults }) => {
        const r = (lastToolResults[0] as any).result;
        expect(r.matches).toBe(false);
        expect(r.lines.find((l: any) => l.status !== 'ok')).toMatchObject({ status: 'short', ordered: '5 renceng', delivered: '4 renceng' });
        expect(r.overbilled).toBeGreaterThan(0);
        return { call: [{ name: 'propose_invoice_adjustment', args: { check_id: checkId, reason: 'Kapal Api hanya terkirim 4 dari 5 renceng.' } }] };
      },
      { say: 'Mohon maaf Bu Sari, Kapal Api kurang 1 renceng. Tagihannya kami ajukan untuk disesuaikan, nanti dikabari lagi ya.' },
    ]);

    const r = await service.handleInbound({ waId: '6281234500001', channel: 'web', kind: 'image', mediaId: photo, text: 'kapal api nya kurang 1 renceng' });
    expect(r.status).toBe('completed');
    expect(model.remaining).toBe(0);

    const check = (await first(db.select().from(deliveryChecks).where(eq(deliveryChecks.id, checkId))))!;
    expect(check).toMatchObject({ orderId, source: 'chat', status: 'mismatch', mediaId: photo, runId: r.runId });
    const queued = await db.select().from(approvals).where(eq(approvals.orderId, orderId));
    expect(queued.map((a) => [a.type, a.status])).toEqual([['invoice_adjustment', 'pending']]);
  });

  it('refuses to open a check for a message that is not a photo', async () => {
    const db = await freshDb();
    const { service } = makeService(db, [
      ({ messages }) => {
        expect(messages.at(-1)?.content).toBe('barang kurang');
        return { call: [{ name: 'report_delivery_problem', args: { message_id: 999_999 } }] };
      },
      ({ lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ ok: false, error: { code: 'unknown_message' } });
        return { say: 'Boleh kirim foto surat jalannya, Bu?' };
      },
    ]);
    await service.handleInbound({ waId: '6281234500001', channel: 'web', kind: 'text', text: 'barang kurang' });
    expect(await db.select().from(deliveryChecks)).toEqual([]);
  });
});
