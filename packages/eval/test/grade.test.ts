import { describe, expect, it } from 'vitest';
import { ScriptedModel } from '@salura/agent';
import { CASES, type EvalCase } from '../src/cases.ts';
import { runCase } from '../src/run.ts';

const s01 = CASES.find((c) => c.id === 's01')!;
const a01 = CASES.find((c) => c.id === 'a01')!;

describe('eval grading', () => {
  it('passes a run that processes exactly the expected lines', async () => {
    const model = new ScriptedModel([
      { call: [{ name: 'search_catalog', args: { queries: ['aqua tanggung', 'kapal api mix'] } }] },
      ({ lastToolResults }) => {
        const [aqua, kopi] = (lastToolResults[0] as any).result.results.map((r: any) => r.candidates[0].productId);
        return { call: [{ name: 'draft_order', args: { lines: [{ product_id: aqua, qty: 2, unit: 'dus' }, { product_id: kopi, qty: 5, unit: 'renceng' }] } }] };
      },
      ({ lastToolResults }) => ({ say: `Ringkasan pesanan. Total Rp${(lastToolResults[0] as any).result.order.subtotal.toLocaleString('id-ID')}. Balas YA.` }),
      { call: [{ name: 'get_customer_profile', args: {} }] },
      ({ lastToolResults }) => ({ call: [{ name: 'confirm_order', args: { order_id: (lastToolResults[0] as any).result.openDraft.orderId } }] }),
      { say: 'Sudah diproses.' },
    ]);
    const r = await runCase(s01, 0, model, null);
    expect(r.grade.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'order lines', ok: true })]));
    expect(r.grade.pass).toBe(true);
  });

  it('fails a run that guessed a product instead of asking', async () => {
    const model = new ScriptedModel([
      { call: [{ name: 'draft_order', args: { lines: [{ product_id: 8, qty: 1, unit: 'dus' }] } }] },
      { say: 'Sudah saya catat Sunco 1 dus.' },
    ]);
    const r = await runCase(a01, 0, model, null);
    expect(r.grade.pass).toBe(false);
    expect(r.grade.checks.find((c) => c.name === 'asks one clarifying question')?.ok).toBe(false);
  });
});

describe('proactive eval grading', () => {
  it('passes when exactly the due customers are offered', async () => {
    const pr01 = CASES.find((c) => c.id === 'pr01')!;
    const model = new ScriptedModel([
      { call: [{ name: 'get_reorder_candidates', args: {} }] },
      ({ lastToolResults }) => ({
        call: (lastToolResults[0] as any).result.candidates
          .filter((c: any) => !c.skipReason)
          .map((c: any) => ({ name: 'send_reorder_nudge', args: { customer_id: c.customerId, reason: 'Sudah lewat jadwal biasanya' } })),
      }),
      { say: 'Dua warung ditawari.' },
    ]);
    const r = await runCase(pr01, 0, model, null);
    expect(r.grade.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('fails when the agent offers a customer it should have skipped', async () => {
    const pr01 = CASES.find((c) => c.id === 'pr01')!;
    const model = new ScriptedModel([
      { call: [{ name: 'get_reorder_candidates', args: {} }] },
      // Rasyid is skipped by the rules, so the tool refuses; the grade still requires Yanti and Dimas.
      { call: [{ name: 'send_reorder_nudge', args: { customer_id: 3, reason: 'Coba tawarkan' } }] },
      { say: 'Selesai.' },
    ]);
    const r = await runCase(pr01, 0, model, null);
    expect(r.grade.pass).toBe(false);
    expect(r.grade.checks.find((c) => c.name === 'offered the due customers')?.ok).toBe(false);
  });
});

describe('delivery eval grading', () => {
  it('passes the matching surat jalan with no follow-ups queued', async () => {
    const d03 = CASES.find((c) => c.id === 'd03')!;
    const checkIdFrom = (messages: any[]) => Number(/#(\d+)/.exec(messages[0].content)![1]);
    const model = new ScriptedModel([
      ({ messages }) => ({ call: [{ name: 'read_delivery_document', args: { check_id: checkIdFrom(messages) } }] }),
      { call: [{ name: 'search_catalog', args: { queries: ['Beras Setra Ramos 25kg', 'Gulaku Gula Pasir 1kg'] } }] },
      ({ messages, lastToolResults }) => {
        const [beras, gula] = (lastToolResults[0] as any).result.results.map((r: any) => r.candidates[0].productId);
        return { call: [{ name: 'compare_delivery', args: { check_id: checkIdFrom(messages), lines: [{ product_id: beras, qty: 10, unit: 'karung' }, { product_id: gula, qty: 3, unit: 'dus' }] } }] };
      },
      { say: 'Surat jalan SJ-2026-1031 sesuai dengan pesanan.' },
    ]);
    const r = await runCase(d03, 0, model, null);
    expect(r.grade.checks.filter((c) => !c.ok)).toEqual([]);
  });
});

describe('payment eval grading', () => {
  const receipt: EvalCase = {
    id: 'test-payment',
    category: 'payment',
    waId: '6281234500003',
    turns: [{ image: 'TYPE: payment_proof\nJumlah: Rp1.000.000\nTanggal: 20/10/2026\nBank: BCA' }],
    expect: { payment: { amount: 1_000_000, invoices: ['INV-00007', 'INV-00008'] }, noProcessedOrder: true },
  };
  const photoId = (messages: any[]) => Number(/message_id=(\d+)/.exec(JSON.stringify(messages))![1]);

  it('passes when the receipt is recorded for the owner to check', async () => {
    const model = new ScriptedModel([
      ({ messages }) => ({ call: [{ name: 'read_order_image', args: { message_id: photoId(messages) } }] }),
      ({ messages }) => ({ call: [{ name: 'record_payment', args: { amount: 1_000_000, paid_on: '2026-10-20', bank: 'BCA', message_id: photoId(messages) } }] }),
      { say: 'Terima kasih Pak, bukti transfernya kami teruskan ke admin untuk dicek.' },
    ]);
    const r = await runCase(receipt, 0, model, null);
    expect(r.grade.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.grade.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['payment recorded for checking', 'nothing marked paid by the agent']));
  });

  it('fails when the agent only answers, and when it records a payment it should not', async () => {
    const answerOnly = await runCase(receipt, 0, new ScriptedModel([{ say: 'Terima kasih Pak.' }]), null);
    expect(answerOnly.grade.checks.find((c) => c.name === 'payment recorded for checking')).toMatchObject({ ok: false, detail: expect.stringContaining('nothing') });

    const question: EvalCase = { id: 'test-no-payment', category: 'payment', waId: '6281234500003', turns: ['nanti saya transfer ya'], expect: { noPayment: true } };
    const r = await runCase(question, 0, new ScriptedModel([{ call: [{ name: 'record_payment', args: { amount: 500_000 } }] }, { say: 'Baik Pak.' }]), null);
    expect(r.grade.pass).toBe(false);
    expect(r.grade.checks.find((c) => c.name === 'no payment recorded')).toMatchObject({ ok: false, detail: '1 recorded' });
  });
});
