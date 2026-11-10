import { and, eq } from '@salura/db/orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { approvals, autonomyPolicies, conversationLocks, messages } from '@salura/db';
import { ScriptedModel, type ScriptStep } from '../src/llm/scripted.ts';
import type { ModelClient } from '../src/llm/types.ts';
import { BU_SARI, freshDb, makeService, MAKMUR_JAYA, steppingClock } from './helpers.ts';

const YANTI = '6281234500007';
const DIMAS = '6281234500006';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A scripted model that takes `delayMs` per step and logs when each step starts and ends. */
function slowModel(label: string, steps: ScriptStep[], delayMs: number, log: string[]) {
  const inner = new ScriptedModel(steps);
  const model: ModelClient & { seen: ScriptedModel['seen'] } = {
    name: 'slow-scripted',
    seen: inner.seen,
    async complete(req) {
      log.push(`${label}:start`);
      await sleep(delayMs);
      const r = await inner.complete(req);
      log.push(`${label}:end`);
      return r;
    },
  };
  return model;
}

describe('conversation lease across instances', () => {
  it('answers two messages from one customer one after the other, even on two service instances', async () => {
    const db = await freshDb();
    const clock = steppingClock();
    const log: string[] = [];
    // Two server instances sharing one database, each with its own in-process queue.
    const a = makeService(db, [], clock);
    const b = makeService(db, [], clock);
    (a.service as any).deps.model = slowModel('A', [{ say: 'Balasan pertama.' }], 300, log);
    const modelB = slowModel('B', [{ say: 'Balasan kedua.' }], 50, log);
    (b.service as any).deps.model = modelB;

    const first = a.service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'pesan satu' });
    while (!log.includes('A:start')) await sleep(5);
    // Instance B has no local queue entry, but sees A's lease in the database.
    expect(await b.service.conversationBusy(BU_SARI)).toBe(true);
    const second = b.service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'pesan dua' });

    const [ra, rb] = await Promise.all([first, second]);
    expect([ra.reply, rb.reply]).toEqual(['Balasan pertama.', 'Balasan kedua.']);
    expect(log).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
    // B's run started after A's reply was stored, so it saw the whole conversation in order.
    expect(modelB.seen[0]!.messages.filter((m) => m.role !== 'system').map((m) => m.content)).toEqual(['pesan satu', 'Balasan pertama.', 'pesan dua']);
    // The lease is released when the run ends.
    expect(await db.select().from(conversationLocks)).toEqual([]);
    expect(await b.service.conversationBusy(BU_SARI)).toBe(false);
  });

  it('takes over a lease left behind by a crashed instance once it expires', async () => {
    const db = await freshDb();
    await db.insert(conversationLocks).values({ waId: BU_SARI, holder: 'crashed-instance', expiresAt: Date.now() - 1 });
    const { service } = makeService(db, [{ say: 'Halo Bu.' }]);
    expect(await service.conversationBusy(BU_SARI)).toBe(false);
    const started = Date.now();
    const r = await service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'halo' });
    expect(r.reply).toBe('Halo Bu.');
    // No waiting for the dead holder.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not hold a run slot while a message waits for another instance to finish the conversation', async () => {
    const db = await freshDb();
    await db.insert(conversationLocks).values({ waId: BU_SARI, holder: 'other-instance', expiresAt: Date.now() + 60_000 });
    const { service } = makeService(db, [{ say: 'Balasan.' }, { say: 'Balasan.' }]);
    (service as any).deps.maxConcurrentRuns = 1;
    const waiting = service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'halo' });
    await sleep(50);
    // The only run slot is free, so another customer is answered while Bu Sari's message waits.
    expect((await service.handleInbound({ waId: MAKMUR_JAYA, channel: 'web', kind: 'text', text: 'halo' })).reply).toBe('Balasan.');
    await db.delete(conversationLocks).where(eq(conversationLocks.waId, BU_SARI));
    expect((await waiting).reply).toBe('Balasan.');
  });

  it('refuses, storing nothing, when its lease was taken over while it waited for a run slot', async () => {
    const db = await freshDb();
    const { service } = makeService(db, [{ say: 'Satu.' }]);
    (service as any).deps.maxConcurrentRuns = 1;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = (service as any).processInbound.bind(service);
    (service as any).processInbound = async (m: any) => {
      if (m.waId === MAKMUR_JAYA) await gate;
      return original(m);
    };
    const first = service.handleInbound({ waId: MAKMUR_JAYA, channel: 'web', kind: 'text', text: 'satu' });
    const second = service.handleInbound({ waId: BU_SARI, channel: 'web', kind: 'text', text: 'pesan yang menunggu' });
    while (!(await db.select().from(conversationLocks).where(eq(conversationLocks.waId, BU_SARI))).length) await sleep(5);
    // Bu Sari's lease expired while she waited, and another instance took the conversation.
    await db.update(conversationLocks).set({ holder: 'other-instance' }).where(eq(conversationLocks.waId, BU_SARI));
    release();
    expect((await first).reply).toBe('Satu.');
    await expect(second).rejects.toThrow('busy');
    expect(await db.select().from(messages).where(and(eq(messages.waId, BU_SARI), eq(messages.text, 'pesan yang menunggu')))).toEqual([]);
    // The other instance's lease is left alone.
    expect((await db.select().from(conversationLocks).where(eq(conversationLocks.waId, BU_SARI)))[0]?.holder).toBe('other-instance');
  });

  it('stores a WhatsApp message it is too busy to answer and hands it to an admin', async () => {
    const db = await freshDb();
    const { service } = makeService(db, []);
    Object.assign((service as any).deps, { maxConcurrentRuns: 1, maxWaitingRuns: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (service as any).processInbound = async () => {
      await gate;
      return { messageId: 0, runId: 'x', status: 'completed', reply: '' };
    };
    const busy = service.handleInbound({ waId: MAKMUR_JAYA, channel: 'web', kind: 'text', text: 'satu' });
    await sleep(20);
    await service.acceptInbound({ waId: BU_SARI, channel: 'whatsapp', kind: 'text', text: 'pesan 5 dus indomie' });
    release();
    await busy;
    const stored = await db.select().from(messages).where(and(eq(messages.waId, BU_SARI), eq(messages.text, 'pesan 5 dus indomie')));
    expect(stored).toEqual([expect.objectContaining({ direction: 'in', channel: 'whatsapp', runId: null })]);
    const [escalation] = await db.select().from(approvals).where(eq(approvals.type, 'escalation'));
    expect(escalation).toMatchObject({ status: 'pending', payload: { waId: BU_SARI, messageId: stored[0]!.id } });
    expect(escalation!.reason).toContain('belum menjawabnya');
  });

  it('stores a WhatsApp message before it waits for anything, and hands it to an admin when the run fails', async () => {
    const db = await freshDb();
    const { service } = makeService(db, [{ say: 'Siap Bu.' }]);
    // Answered normally: the run takes the stored row over, nothing is stored twice.
    await service.acceptInbound({ waId: BU_SARI, channel: 'whatsapp', kind: 'text', text: 'halo' });
    const answered = await db.select().from(messages).where(and(eq(messages.waId, BU_SARI), eq(messages.direction, 'in'), eq(messages.text, 'halo')));
    expect(answered).toEqual([expect.objectContaining({ channel: 'whatsapp', runId: expect.any(String) })]);

    // The conversation lease cannot even be taken (a database error before the run starts).
    (service as any).withLease = async () => {
      throw new Error('connection reset');
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => void vi.restoreAllMocks());
    await service.acceptInbound({ waId: BU_SARI, channel: 'whatsapp', kind: 'text', text: 'pesan 3 dus aqua' });
    const stored = await db.select().from(messages).where(eq(messages.text, 'pesan 3 dus aqua'));
    expect(stored).toEqual([expect.objectContaining({ direction: 'in', channel: 'whatsapp', runId: null })]);
    const [escalation] = await db.select().from(approvals).where(eq(approvals.type, 'escalation'));
    expect(escalation).toMatchObject({ status: 'pending', payload: { waId: BU_SARI, messageId: stored[0]!.id } });
    expect(escalation!.reason).toContain('connection reset');
  });

  it('renews a held lease while the work runs, but only up to a ceiling', async () => {
    const db = await freshDb();
    const a = makeService(db, []);
    const b = makeService(db, []);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const held = (a.service as any).withLease(BU_SARI, () => gate);
      while (!(await db.select().from(conversationLocks)).length) await sleep(5);
      const expiry = async () => (await db.select().from(conversationLocks))[0]!.expiresAt;
      const firstExpiry = await expiry();
      // Past the 150 s a lease lasts, the holder has kept renewing it.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(50_000);
        while ((await expiry()) === firstExpiry + 50_000 * i) await sleep(5);
      }
      expect(await expiry()).toBe(firstExpiry + 200_000);
      expect(await b.service.conversationBusy(BU_SARI)).toBe(true);
      // After the ceiling (wait budget, run deadline and slack: 250 s) it stops, and the lease lapses.
      await vi.advanceTimersByTimeAsync(200_000);
      await sleep(50);
      expect(await expiry()).toBe(firstExpiry + 200_000);
      expect(await b.service.conversationBusy(BU_SARI)).toBe(false);
      release();
      await held;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the proactive run away from a customer another instance is answering', async () => {
    const db = await freshDb();
    await db.update(autonomyPolicies).set({ mode: 'auto' }).where(eq(autonomyPolicies.action, 'send_reorder_nudge'));
    await db.insert(conversationLocks).values({ waId: YANTI, holder: 'other-instance', expiresAt: Date.now() + 60_000 });
    const { service, sent } = makeService(db, [
      { call: [{ name: 'get_reorder_candidates', args: {} }] },
      ({ lastToolResults }) => ({
        call: (lastToolResults[0] as any).result.candidates
          .filter((c: any) => !c.skipReason)
          .map((c: any) => ({ name: 'send_reorder_nudge', args: { customer_id: c.customerId, reason: 'Jadwal biasanya' } })),
      }),
      ({ lastToolResults }) => {
        expect(lastToolResults.some((r: any) => r.ok === false && r.error.code === 'customer_busy')).toBe(true);
        return { say: 'Bu Yanti dilewati karena sedang chat.' };
      },
    ]);
    await service.runProactive('eval');
    expect(sent.map((m) => m.waId)).toEqual([DIMAS]);
  });
});
