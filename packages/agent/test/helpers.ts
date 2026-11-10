import { eq } from '@salura/db/orm';
import { onTestFinished } from 'vitest';
import { customers, first, messages, products, type Db } from '@salura/db';
import { closeSeededDb, seededDb } from '../../db/test/template.ts';
import { EventBus } from '../src/events.ts';
import { ScriptedModel, type ScriptStep } from '../src/llm/scripted.ts';
import { saveMedia } from '../src/media.ts';
import { SaluraService } from '../src/service.ts';
import { SidecarStt } from '../src/stt.ts';
import { SidecarVision } from '../src/vision.ts';
import { markSummarySent } from '../src/domain/orders.ts';

export const T0 = new Date('2026-10-21T03:00:00.000Z');

/** A clock that moves forward one second every time it is read, so event order is unambiguous. */
export function steppingClock(start = T0) {
  let t = start.getTime();
  return () => new Date((t += 1000));
}

/** A seeded database of its own for the current test, closed when the test finishes. */
export async function freshDb(): Promise<Db> {
  const db = await seededDb(T0.getTime());
  onTestFinished(() => closeSeededDb(db));
  return db;
}

/** A seeded database shared by a describe block (beforeAll); close it with closeSharedDb in afterAll. */
export const sharedDb = () => seededDb(T0.getTime());
export const closeSharedDb = closeSeededDb;

export async function productId(db: Db, sku: string): Promise<number> {
  return (await first(db.select().from(products).where(eq(products.sku, sku))))!.id;
}

export async function customerByWa(db: Db, waId: string) {
  return (await first(db.select().from(customers).where(eq(customers.waId, waId))))!;
}

/** Marks the customer's open draft as delivered (what a completed agent run does) half a second before `now`. */
export async function summaryShown(db: Db, waId: string, now: Date) {
  const c = await first(db.select().from(customers).where(eq(customers.waId, waId)));
  if (c) await markSummarySent(db, c.id, new Date(now.getTime() - 500).toISOString());
}

/** The customer reads the agent's summary of their open draft, then replies at `now`. */
export async function customerSays(db: Db, waId: string, text: string, now: Date) {
  await summaryShown(db, waId, now);
  return customerRepliesUnprompted(db, waId, text, now);
}

/** An inbound message with no summary delivered first (e.g. after a failed run). */
export async function customerRepliesUnprompted(db: Db, waId: string, text: string, now: Date) {
  return (await db.insert(messages).values({ waId, direction: 'in', channel: 'web', kind: 'text', text, createdAt: now.toISOString() }).returning())[0]!;
}

/** A stored photo or voice note; `sidecarText` stands in for the vision or speech provider. */
export function storeMedia(db: Db, mime: string, sidecarText: string | null = null, data = Buffer.from('x')) {
  return saveMedia(db, { data, mime, sidecarText });
}

export function makeService(db: Db, steps: ScriptStep[], clock = steppingClock()) {
  const sent: { waId: string; channel: string; text: string }[] = [];
  const model = new ScriptedModel(steps);
  const bus = new EventBus();
  const service = new SaluraService({
    db,
    bus,
    model,
    stt: new SidecarStt(),
    vision: new SidecarVision(),
    clock,
    pricing: { inputPerM: 1, outputPerM: 2 },
    outbox: { send: async (m) => void sent.push(m) },
  });
  return { service, model, sent, bus, clock };
}

export const BU_SARI = '6281234500001';
export const MAKMUR_JAYA = '6281234500002';
export const PAK_RASYID = '6281234500003';
export const SINAR_PAGI = '6281234500005';
