import { eq, lte } from '@salura/db/orm';
import { describe, expect, it } from 'vitest';
import { events, type Db } from '@salura/db';
import { EventBus, OutboxReader } from '../src/events.ts';
import { freshDb } from './helpers.ts';

/**
 * Takes the next outbox id but keeps the row invisible until `commit`: what a reader sees while
 * the transaction that wrote it has not committed yet.
 */
async function inFlight(db: Db, payload: Record<string, unknown>) {
  const [row] = await db.insert(events).values({ payload }).returning();
  await db.delete(events).where(eq(events.id, row!.id));
  return { id: row!.id, commit: () => db.insert(events).values({ id: row!.id, payload }) };
}

const orderIds = (rows: { payload: Record<string, unknown> }[]) => rows.map((r) => r.payload.orderId);

describe('event outbox reader', () => {
  it('delivers an event that commits after a later one, exactly once, also across a resume', async () => {
    const db = await freshDb();
    const bus = new EventBus(db);
    const { reader, resumed } = await OutboxReader.open(db, undefined);
    expect(resumed).toBe(false);

    const late = await inFlight(db, { type: 'order', orderId: 1 });
    await bus.emit({ type: 'order', orderId: 2 });
    const first = await reader.poll(db);
    expect(orderIds(first)).toEqual([2]);
    for (const row of first) reader.delivered(row.id);
    expect(reader.waiting).toBe(true);
    expect(reader.token).toBe(`${first[0]!.id},${late.id}`);

    // A browser that reconnects now (Last-Event-ID = token) still waits for the late event.
    const again = await OutboxReader.open(db, reader.token);
    expect(again.resumed).toBe(true);

    await late.commit();
    await bus.emit({ type: 'order', orderId: 3 });
    for (const r of [reader, again.reader]) {
      const rows = await r.poll(db);
      expect(orderIds(rows)).toEqual([1, 3]);
      for (const row of rows) r.delivered(row.id);
      expect(r.waiting).toBe(false);
      expect(r.token).toBe(String(rows[1]!.id));
      expect(await r.poll(db)).toEqual([]);
    }
  });

  it('gives up on an id that never commits', async () => {
    const db = await freshDb();
    const bus = new EventBus(db);
    const { reader } = await OutboxReader.open(db, undefined, 0);
    await inFlight(db, { type: 'order', orderId: 1 });
    await bus.emit({ type: 'order', orderId: 2 });
    const [row] = await reader.poll(db, 0);
    reader.delivered(row!.id, 0);
    expect(reader.waiting).toBe(true);

    expect(await reader.poll(db, 5_000)).toEqual([]);
    expect(reader.waiting).toBe(true);
    expect(await reader.poll(db, 11_000)).toEqual([]);
    expect(reader.waiting).toBe(false);
    expect(reader.token).toBe(String(row!.id));
  });

  it('starts at the newest event and watches for ids still in flight just below it', async () => {
    const db = await freshDb();
    const bus = new EventBus(db);
    await bus.emit({ type: 'order', orderId: 1 });
    const late = await inFlight(db, { type: 'order', orderId: 2 });
    await bus.emit({ type: 'order', orderId: 3 });

    const { reader } = await OutboxReader.open(db, undefined);
    expect(reader.waiting).toBe(true);
    await late.commit();
    expect(orderIds(await reader.poll(db))).toEqual([2]);
  });

  it('rejects resume tokens that are not lists of event ids', () => {
    expect(OutboxReader.parse('12')).toEqual([12]);
    expect(OutboxReader.parse('0')).toEqual([0]);
    expect(OutboxReader.parse('12,10,11')).toEqual([12, 10, 11]);
    expect(OutboxReader.parse('2147483647')).toEqual([2_147_483_647]);
    const tooLong = Array.from({ length: 300 }, (_, i) => i + 1000).join(',');
    for (const bad of [undefined, '', 'abc', '12,', '-1', '1.5', '1,x', '012', '12,07', '2147483648', '12,2147483648', '99999999999999999999', tooLong]) {
      expect(OutboxReader.parse(bad)).toBeNull();
    }
  });

  it('ignores awaited ids above the cursor in a token', () => {
    expect(new OutboxReader(5, [7, 5, 3]).token).toBe('5,5,3');
  });

  it('starts fresh when the events after a token were pruned, or the token is from another database', async () => {
    const db = await freshDb();
    const bus = new EventBus(db);
    for (const orderId of [1, 2, 3]) await bus.emit({ type: 'order', orderId });
    const rows = await db.select().from(events).orderBy(events.id);
    const token = String(rows[0]!.id);
    expect((await OutboxReader.open(db, token)).resumed).toBe(true);
    expect((await OutboxReader.open(db, String(rows[2]!.id))).resumed).toBe(true);
    expect((await OutboxReader.open(db, String(rows[2]!.id + 50))).resumed).toBe(false);

    // The tab slept past pruning: the events it never saw are gone.
    await db.delete(events).where(lte(events.id, rows[1]!.id));
    const { reader, resumed } = await OutboxReader.open(db, token);
    expect(resumed).toBe(false);
    expect(reader.token).toBe(String(rows[2]!.id));
    expect(await reader.poll(db)).toEqual([]);
  });

  it('starts after the last id handed out when the outbox is empty, without awaiting pruned ids', async () => {
    const db = await freshDb();
    const bus = new EventBus(db);
    for (const orderId of [1, 2, 3]) await bus.emit({ type: 'order', orderId });
    await db.delete(events);
    const { reader, resumed } = await OutboxReader.open(db, undefined, 0);
    expect(resumed).toBe(false);
    await bus.emit({ type: 'order', orderId: 4 });
    const rows = await reader.poll(db, 0);
    expect(orderIds(rows)).toEqual([4]);
    reader.delivered(rows[0]!.id, 0);
    // Only the last id handed out is awaited (it could have been in flight), never the 64 below it.
    expect(reader.token).toBe(`${rows[0]!.id},${rows[0]!.id - 1}`);
    await reader.poll(db, 11_000);
    expect(reader.token).toBe(String(rows[0]!.id));
  });
});
