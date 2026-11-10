import { and, asc, eq } from '@salura/db/orm';
import { describe, expect, it } from 'vitest';
import { agentRuns, approvals, auditLog, first, orders } from '@salura/db';
import { parseHermesToolCalls, splitThinking } from '../src/llm/openai-compatible.ts';
import type { ScriptStep } from '../src/llm/scripted.ts';
import { amountsNotFromTools } from '../src/orchestrator.ts';
import { rupiah } from '../src/domain/money.ts';
import { BU_SARI, customerRepliesUnprompted, freshDb, makeService, MAKMUR_JAYA, productId, storeMedia, T0 } from './helpers.ts';

/** Script step that drafts the customer's usual order from the profile the previous step returned. */
const draftUsual: ScriptStep = ({ lastToolResults }) => {
  const profile = (lastToolResults[0] as any).result;
  return {
    thought: 'Customer asked for the usual order; using usualOrder from the profile.',
    call: [{ name: 'draft_order', args: { lines: profile.usualOrder.map((l: any) => ({ product_id: l.productId, qty: l.qty, unit: l.unit, raw_text: 'yang biasa' })) } }],
  };
};

const summarizeDraft: ScriptStep = ({ lastToolResults }) => {
  const draft = (lastToolResults[0] as any).result;
  return { say: `Siap Bu Sari, total ${rupiah(draft.order.subtotal)}. Balas YA untuk proses ya.` };
};

describe('order agent run', () => {
  it('takes "yang biasa" from draft to confirmed across two customer messages', async () => {
    const db = await freshDb();
    const { service, sent, model } = makeService(db, [
      { call: [{ name: 'get_customer_profile', args: {} }] },
      draftUsual,
      summarizeDraft,
      { call: [{ name: 'get_customer_profile', args: {} }] },
      ({ lastToolResults }) => ({ call: [{ name: 'confirm_order', args: { order_id: (lastToolResults[0] as any).result.openDraft.orderId } }] }),
      { say: 'Pesanan sudah diproses, terima kasih Bu Sari!' },
    ]);

    const firstTurn = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'kirim yang biasa ya' });
    expect(firstTurn.status).toBe('completed');
    expect(firstTurn.reply).toMatch(/Balas YA/);

    const second = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'ya' });
    expect(second.status).toBe('completed');
    expect(model.remaining).toBe(0);

    const order = (await first(db.select().from(orders).where(eq(orders.historic, false))))!;
    expect(order.status).toBe('confirmed');
    expect(sent.map((m) => m.text)).toEqual([firstTurn.reply, second.reply]);

    const trace = await db.select().from(auditLog).where(eq(auditLog.runId, firstTurn.runId)).orderBy(asc(auditLog.id));
    expect(trace.map((t) => t.type)).toEqual(['message_in', 'tool_call', 'tool_result', 'thought', 'tool_call', 'tool_result', 'message_out']);

    const run = (await first(db.select().from(agentRuns).where(eq(agentRuns.id, second.runId))))!;
    expect(run).toMatchObject({ status: 'completed', steps: 3, inputTokens: 300, outputTokens: 60 });
    expect(run.costUsd).toBeCloseTo((300 * 1 + 60 * 2) / 1e6);
  });

  it('blocks a reply that quotes an amount no tool returned, and lets the model correct it', async () => {
    const db = await freshDb();
    const { service } = makeService(db, [
      { call: [{ name: 'get_customer_profile', args: {} }] },
      { say: 'Total pesanan Ibu Rp999.000 ya.' },
      ({ messages }) => {
        expect(messages.at(-1)?.content).toContain('did not come from any tool result');
        return { say: 'Mohon maaf Bu, boleh disebutkan barang yang mau dipesan?' };
      },
    ]);
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'berapa totalnya?' });
    expect(r.reply).toBe('Mohon maaf Bu, boleh disebutkan barang yang mau dipesan?');
    const validation = await db.select().from(auditLog).where(eq(auditLog.type, 'validation')).orderBy(asc(auditLog.id));
    expect(validation[0]?.summary).toMatch(/Rp999\.000/);
  });

  it('returns business-rule refusals to the model instead of failing the run', async () => {
    const db = await freshDb();
    const aqua = await productId(db, 'AQA-600');
    const { service } = makeService(db, [
      { call: [{ name: 'draft_order', args: { lines: [{ product_id: aqua, qty: 1, unit: 'dus' }] } }] },
      ({ lastToolResults }) => ({ call: [{ name: 'confirm_order', args: { order_id: (lastToolResults[0] as any).result.order.orderId } }] }),
      ({ lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ ok: false, error: { code: 'needs_customer_confirmation' } });
        return { say: 'Sudah saya catat, mohon dicek dulu ringkasannya ya Bu.' };
      },
    ]);
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: '1 dus aqua tanggung langsung proses' });
    expect(r.status).toBe('completed');
    expect((await first(db.select().from(orders).where(eq(orders.historic, false))))?.status).toBe('awaiting_customer');
  });

  it('escalates after a tool fails twice, and still answers the customer', async () => {
    const db = await freshDb();
    // No stored transcript and no STT provider → transcription fails.
    const audio = await storeMedia(db, 'audio/ogg', null, Buffer.from('not really audio'));
    const transcribe = ({ messages }: any): ScriptStep => {
      const id = Number(/message_id=(\d+)/.exec(messages.at(-1).content)?.[1] ?? /message_id=(\d+)/.exec(JSON.stringify(messages))?.[1]);
      return { call: [{ name: 'transcribe_audio', args: { message_id: id } }] };
    };
    const { service } = makeService(db, [transcribe, transcribe]);
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'voice', mediaId: audio });
    expect(r.status).toBe('escalated');
    expect(r.reply).toContain('Admin kami');
    const esc = await db.select().from(approvals).where(eq(approvals.type, 'escalation'));
    expect(esc[0]?.reason).toMatch(/transcribe_audio gagal 2 kali/);
  });

  it('transcribes a voice note from its stored transcript', async () => {
    const db = await freshDb();
    const audio = await storeMedia(db, 'audio/ogg', 'bu sari mau pesen indomi goreng dua dus');
    const { service } = makeService(db, [
      ({ messages }) => ({ call: [{ name: 'transcribe_audio', args: { message_id: Number(/message_id=(\d+)/.exec(JSON.stringify(messages))![1]) } }] }),
      ({ lastToolResults }) => {
        expect((lastToolResults[0] as any).result.transcript).toContain('indomi goreng');
        return { say: 'Baik Bu, saya cek dulu ya.' };
      },
    ]);
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'voice', mediaId: audio });
    expect(r.status).toBe('completed');
  });

  it('reads a photographed order list and stores the text for later turns', async () => {
    const db = await freshDb();
    const photo = await storeMedia(db, 'image/jpeg', '- aqua tanggung 2 dus\n- kapal api 5 renceng\n[?] 10 bks');
    const photoId = ({ messages }: any) => Number(/message_id=(\d+)/.exec(JSON.stringify(messages))![1]);
    const { service, model } = makeService(db, [
      (ctx) => ({ call: [{ name: 'read_order_image', args: { message_id: photoId(ctx) } }] }),
      ({ lastToolResults }) => {
        const r = (lastToolResults[0] as any).result;
        // No TYPE header: an order list, as before photo types existed.
        expect(r.type).toBe('order_list');
        expect(r.lines).toEqual(['aqua tanggung 2 dus', 'kapal api 5 renceng', '[?] 10 bks']);
        expect(r.unreadableLines).toBe(1);
        return { call: [{ name: 'search_catalog', args: { queries: ['aqua tanggung', 'kapal api'] } }] };
      },
      { say: 'Baik Bu, yang 10 bungkus itu barang apa ya?' },
      { say: 'Siap Bu.' },
    ]);
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'image', mediaId: photo });
    expect(r.status).toBe('completed');

    await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'gulaku' });
    const history = model.seen.at(-1)!.messages.map((m) => m.content).join('\n');
    expect(history).toContain('Text read from the photo:\naqua tanggung 2 dus');

    const trace = (await first(db.select().from(auditLog).where(and(eq(auditLog.runId, r.runId), eq(auditLog.tool, 'read_order_image'), eq(auditLog.type, 'tool_result')))))!;
    expect(trace.summary).toMatch(/^Daftar pesanan: 3 baris terbaca/);
  });

  it('refuses to read a message that is not a photo', async () => {
    const db = await freshDb();
    const earlier = await customerRepliesUnprompted(db, BU_SARI, 'halo', T0);
    const { service } = makeService(db, [
      () => ({ call: [{ name: 'read_order_image', args: { message_id: earlier.id } }] }),
      ({ lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ ok: false, error: { code: 'not_image' } });
        return { say: 'Baik Bu.' };
      },
    ]);
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'halo' });
    expect(r.status).toBe('completed');
  });

  it('does not let numbers the customer wrote back a quoted amount', async () => {
    const db = await freshDb();
    const photo = await storeMedia(db, 'image/jpeg', 'aqua 2 dus Rp50.000');
    const { service } = makeService(db, [
      ({ messages }) => ({ call: [{ name: 'read_order_image', args: { message_id: Number(/message_id=(\d+)/.exec(JSON.stringify(messages))![1]) } }] }),
      { say: 'Total Rp50.000 ya Bu.' },
      { say: 'Saya cek harganya dulu ya Bu.' },
    ]);
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'image', mediaId: photo });
    expect(r.reply).toBe('Saya cek harganya dulu ya Bu.');
  });

  it('records a human approval of a split order and notifies the customer', async () => {
    const db = await freshDb();
    const beras = await productId(db, 'BRS-SR-25');
    const { service, sent } = makeService(db, [
      { call: [{ name: 'draft_order', args: { lines: [{ product_id: beras, qty: 10, unit: 'karung' }] } }] },
      ({ lastToolResults }) => ({ say: `Mohon konfirmasi ya Pak. Total Rp${(lastToolResults[0] as any).result.order.subtotal.toLocaleString('id-ID')}. Balas YA.` }),
      { call: [{ name: 'get_customer_profile', args: {} }] },
      ({ lastToolResults }) => ({ call: [{ name: 'confirm_order', args: { order_id: (lastToolResults[0] as any).result.openDraft.orderId } }] }),
      ({ lastToolResults }) => {
        const r = (lastToolResults[0] as any).result;
        expect(r.outcome).toBe('blocked_over_credit');
        return { call: [{ name: 'split_order', args: { order_id: r.order.orderId } }] };
      },
      { say: 'Sebagian sudah kami proses, sisanya menunggu persetujuan ya Pak.' },
    ]);
    await service.handleInbound({ waId: MAKMUR_JAYA, channel: 'web', kind: 'text', text: 'beras SR 10 karung' });
    await service.handleInbound({ waId: MAKMUR_JAYA, channel: 'web', kind: 'text', text: 'ya' });

    const pending = (await first(db.select().from(approvals).where(eq(approvals.status, 'pending'))))!;
    expect(pending.type).toBe('credit_override');
    await service.decideApproval({ approvalId: pending.id, decision: 'approve', decidedBy: 'Pak Budi' });
    expect(sent.at(-1)?.text).toMatch(/sudah disetujui/);
    expect((await first(db.select().from(orders).where(eq(orders.id, pending.orderId!))))?.status).toBe('confirmed');
  });
});

describe('Hermes tool-call parsing', () => {
  it('extracts tool calls and keeps surrounding text as reasoning', () => {
    const parsed = parseHermesToolCalls(
      'Cek profil dulu.\n<tool_call>\n{"name": "get_customer_profile", "arguments": {}}\n</tool_call>\n<tool_call>{"name":"search_catalog","arguments":{"queries":["indomi"]}}',
    );
    expect(parsed.content).toBe('Cek profil dulu.');
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['get_customer_profile', 'search_catalog']);
    expect(parsed.toolCalls[1]?.arguments).toEqual({ queries: ['indomi'] });
  });

  it('marks malformed JSON so the runtime can report it', () => {
    const parsed = parseHermesToolCalls('<tool_call>{"name": "x", </tool_call>');
    expect(parsed.toolCalls[0]?.arguments).toBeUndefined();
  });

  it('separates <think> blocks from the reply', () => {
    expect(splitThinking('<think>plan</think>Halo Bu')).toEqual({ text: 'Halo Bu', thought: 'plan' });
  });
});

describe('price guard', () => {
  it('flags only rupiah amounts that never appeared in tool results', () => {
    const known = new Set([118_000, 81_600]);
    expect(amountsNotFromTools('Indomie Rp118.000, Aqua Rp 81.600, ongkir Rp500', known)).toEqual([]);
    expect(amountsNotFromTools('Total Rp199.600', known)).toEqual([199_600]);
  });

  it('catches WhatsApp shorthand and amounts written without Rp', () => {
    const known = new Set([118_000, 2_028_600]);
    expect(amountsNotFromTools('totalnya 245rb ya Bu', known)).toEqual([245_000]);
    expect(amountsNotFromTools('jadi 199.600 saja', known)).toEqual([199_600]);
    expect(amountsNotFromTools('Rp1,5 jt', known)).toEqual([1_500_000]);
    // Rounded shorthand of a real figure is fine.
    expect(amountsNotFromTools('kira-kira Rp2,03 jt, Indomie 118rb', known)).toEqual([]);
  });
});

describe('service robustness', () => {
  it('rejects to the caller (not the process) when a run throws, and keeps serving', async () => {
    const db = await freshDb();
    const { service } = makeService(db, [{ say: 'ok' }]);
    const original = (service as any).processInbound.bind(service);
    let calls = 0;
    (service as any).processInbound = (m: any) => (++calls === 1 ? Promise.reject(new Error('db down')) : original(m));
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    await expect(service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'a' })).rejects.toThrow('db down');
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'b' });
    await new Promise((res) => setTimeout(res, 20));
    process.off('unhandledRejection', onUnhandled);
    expect(r.reply).toBe('ok');
    expect(unhandled).toEqual([]);
  });

  it('never runs more agent loops at once than the cap', async () => {
    const db = await freshDb();
    const { service } = makeService(db, []);
    (service as any).deps.maxConcurrentRuns = 2;
    let running = 0;
    let peak = 0;
    (service as any).processInbound = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((res) => setTimeout(res, 15));
      running--;
      return { messageId: 0, runId: 'x', status: 'completed', reply: '' };
    };
    await Promise.all(['6281', '6282', '6283', '6284', '6285'].map((waId) => service.handleInbound({ waId, channel: 'web', kind: 'text', text: 'x' })));
    expect(peak).toBe(2);
  });
});

describe('restart recovery', () => {
  it('closes runs cut off by a restart, escalates them and answers the customer', async () => {
    const db = await freshDb();
    const minutesBeforeT0 = (m: number) => new Date(T0.getTime() - m * 60_000).toISOString();
    await db.insert(agentRuns).values([
      { id: 'cut-off', trigger: 'message', goal: 'x', waId: BU_SARI, status: 'running', startedAt: minutesBeforeT0(10) },
      // Started a moment ago, possibly on another instance: still within its deadline, left alone.
      { id: 'in-flight', trigger: 'message', goal: 'x', waId: MAKMUR_JAYA, status: 'running', startedAt: minutesBeforeT0(1) },
    ]);
    const { service, sent } = makeService(db, []);
    expect(await service.recoverInterruptedRuns()).toBe(1);
    expect((await first(db.select().from(agentRuns).where(eq(agentRuns.id, 'cut-off'))))?.status).toBe('failed');
    expect((await first(db.select().from(agentRuns).where(eq(agentRuns.id, 'in-flight'))))?.status).toBe('running');
    expect((await first(db.select().from(approvals).where(eq(approvals.runId, 'cut-off'))))?.type).toBe('escalation');
    expect(sent.map((m) => m.waId)).toEqual([BU_SARI]);
    expect(sent[0]?.text).toContain('Admin kami');
    // A second sweep finds nothing left to recover.
    expect(await service.recoverInterruptedRuns()).toBe(0);
    expect(await service.recoverInterruptedRuns(0)).toBe(1);
  });
});

describe('run deadline', () => {
  it('escalates with the fallback reply when the model is too slow', async () => {
    const db = await freshDb();
    const { service } = makeService(db, []);
    (service as any).deps.runDeadlineMs = 50;
    (service as any).deps.model = { name: 'slow', complete: () => new Promise((res) => setTimeout(() => res({ content: 'late', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }), 500)) };
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'halo' });
    expect(r.status).toBe('failed');
    expect(r.reply).toContain('Admin kami');
  });
});

describe('Hermes parser edge cases', () => {
  it('keeps two calls separate when the first is missing its closing tag', () => {
    const parsed = parseHermesToolCalls('<tool_call>{"name":"a","arguments":{}}\n<tool_call>{"name":"b","arguments":{"x":1}}</tool_call>');
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['a', 'b']);
    expect(parsed.toolCalls[1]?.arguments).toEqual({ x: 1 });
  });

  it('drops tool responses the model invented', () => {
    const parsed = parseHermesToolCalls('Sebentar <tool_response>{"fake":true}</tool_response> ya Bu');
    expect(parsed.content).toBe('Sebentar  ya Bu');
    expect(parsed.toolCalls).toEqual([]);
  });
});

describe('summary delivery', () => {
  it('does not count a clarifying question without the total as showing the order', async () => {
    const db = await freshDb();
    const aqua = await productId(db, 'AQA-600');
    const { service } = makeService(db, [
      { call: [{ name: 'draft_order', args: { lines: [{ product_id: aqua, qty: 1, unit: 'dus' }] } }] },
      { say: 'Indomie-nya yang goreng atau soto, Bu?' },
      { call: [{ name: 'get_customer_profile', args: {} }] },
      ({ lastToolResults }) => ({ call: [{ name: 'confirm_order', args: { order_id: (lastToolResults[0] as any).result.openDraft.orderId } }] }),
      ({ lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ ok: false, error: { code: 'needs_customer_confirmation' } });
        return { say: 'Baik Bu, ini ringkasannya dulu ya.' };
      },
    ]);
    await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'aqua tanggung 1 dus sama indomie 1 dus' });
    await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'goreng' });
  });
});

describe('run wait list', () => {
  it('refuses with ServiceBusyError once the wait list is full, without storing the message', async () => {
    const db = await freshDb();
    const { service } = makeService(db, []);
    Object.assign((service as any).deps, { maxConcurrentRuns: 1, maxWaitingRuns: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (service as any).processInbound = async () => {
      await gate;
      return { messageId: 0, runId: 'x', status: 'completed', reply: '' };
    };
    const first = service.handleInbound({ waId: '6281000000001', channel: 'web', kind: 'text', text: 'a' });
    const second = service.handleInbound({ waId: '6281000000002', channel: 'web', kind: 'text', text: 'b' });
    await new Promise((r) => setTimeout(r, 5));
    await expect(service.handleInbound({ waId: '6281000000003', channel: 'web', kind: 'text', text: 'c' })).rejects.toThrow('busy');
    release();
    await Promise.all([first, second]);
  });
});

describe('price guard precision', () => {
  it('ignores quantities with units and keeps shorthand tight', () => {
    const known = new Set([1_450_000, 81_600]);
    expect(amountsNotFromTools('stok tinggal 1.200 pcs, Aqua Rp81.600', known)).toEqual([]);
    expect(amountsNotFromTools('totalnya sekitar 1 jt', known)).toEqual([1_000_000]);
    expect(amountsNotFromTools('totalnya Rp1,45 jt', known)).toEqual([]);
  });
});
