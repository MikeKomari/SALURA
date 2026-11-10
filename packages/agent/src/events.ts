import { EventEmitter } from 'node:events';
import { gt, asc, desc, inArray, lt, max, min, or, sql } from '@salura/db/orm';
import { events, type agentRuns, type auditLog, type Db, type messages } from '@salura/db';

export type AgentEvent =
  | { type: 'audit'; entry: typeof auditLog.$inferSelect }
  | { type: 'message'; message: typeof messages.$inferSelect }
  | { type: 'run'; run: typeof agentRuns.$inferSelect }
  | { type: 'approval'; approvalId: number }
  | { type: 'order'; orderId: number }
  | { type: 'reset' };

/**
 * Pub/sub for the live agent trace and console updates. Every event goes to in-process listeners
 * and, when a database is attached, into the `events` outbox, which the SSE endpoint streams from.
 * The outbox is what makes the live trace work when the run and the browser's stream are served
 * by different server instances (Vercel).
 */
export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(100);

  constructor(private readonly db: Db | null = null) {}

  async emit(event: AgentEvent): Promise<void> {
    if (this.db) {
      try {
        await this.db.insert(events).values({ payload: event as unknown as Record<string, unknown> });
      } catch (err) {
        // The live view is best effort; an agent run never fails because of it.
        console.error('event outbox write failed', (err as Error).message);
      }
    }
    // After the outbox write: a stream on this instance woken by the event finds the row.
    this.emitter.emit('event', event);
  }

  /** In-process listeners (tests, the local server). */
  listenerCount(): number {
    return this.emitter.listenerCount('event');
  }

  subscribe(fn: (event: AgentEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}

/** Events after `cursor`, plus the `missing` ids below it that have appeared since, oldest first. */
export async function eventsSince(db: Db, cursor: number, limit = 200, missing: number[] = []) {
  const where = missing.length ? or(gt(events.id, cursor), inArray(events.id, missing)) : gt(events.id, cursor);
  return db.select().from(events).where(where).orderBy(asc(events.id)).limit(limit);
}

/** How long an id skipped below the cursor is waited for before it is taken as never coming (rolled back). */
const GAP_WAIT_MS = 10_000;
/** At most this many skipped ids are tracked; more would only come from a burst of parallel writers. */
const MAX_GAPS = 64;
/** Ids are Postgres `serial` (int4); anything larger in a token is not one of ours. */
const MAX_ID = 2_147_483_647;

/**
 * Where one live stream is in the outbox. Serial ids are taken before commit, so a reader can see
 * id 11 while id 10 is still uncommitted; a plain "id > cursor" would then skip 10 forever. The
 * reader keeps the ids it skipped and asks for them again until they show up or GAP_WAIT_MS passes.
 *
 * `token` goes out as the SSE event id. It holds the cursor and the ids still awaited
 * ("12" or "12,10"), so a browser that reconnects with Last-Event-ID loses nothing and gets nothing twice.
 */
export class OutboxReader {
  private readonly gaps = new Map<number, number>();

  constructor(
    private cursor: number,
    missing: Iterable<number> = [],
    now = Date.now(),
  ) {
    // An awaited id equal to the cursor is one handed out but not seen yet (see open).
    for (const id of missing) if (id <= cursor) this.gaps.set(id, now);
    this.trimGaps();
  }

  /**
   * Resumes from a token, or starts at the newest event (watching for ids still in flight just below it).
   * A token the outbox has moved past (the events after it were pruned, or the database is not the
   * one it came from) starts fresh with resumed: false, so the browser refetches everything.
   */
  static async open(db: Db, token: string | undefined, now = Date.now()): Promise<{ reader: OutboxReader; resumed: boolean }> {
    const [bounds] = await db
      .select({
        oldest: min(events.id),
        newest: max(events.id),
        // The last id handed out, committed or not (null before the first insert).
        issued: sql<number | null>`pg_sequence_last_value(pg_get_serial_sequence('events', 'id')::regclass)`.mapWith(Number),
      })
      .from(events);
    const oldest = bounds?.oldest ?? null;
    const issued = bounds?.issued ?? 0;
    const parsed = OutboxReader.parse(token);
    if (parsed) {
      const cursor = parsed[0]!;
      const lost = cursor > issued || (issued > cursor && (oldest === null || oldest > cursor + 1));
      if (!lost) return { reader: new OutboxReader(cursor, parsed.slice(1), now), resumed: true };
    }
    // Empty (new, or everything pruned): start after the last id handed out, which may still be in flight.
    if (bounds?.newest == null) return { reader: new OutboxReader(issued, issued ? [issued] : [], now), resumed: false };
    const recent = (await db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(MAX_GAPS)).map((r) => r.id);
    const cursor = recent[0] ?? 0;
    const seen = new Set(recent);
    const missing = [];
    for (let id = (recent.at(-1) ?? cursor) + 1; id < cursor; id++) if (!seen.has(id)) missing.push(id);
    return { reader: new OutboxReader(cursor, missing, now), resumed: false };
  }

  /** "12,10" → [12, 10]; null for anything that is not a list of event ids. */
  static parse(token: string | undefined): number[] | null {
    if (!token || token.length > 1_000 || !/^(0|[1-9]\d{0,9})(,(0|[1-9]\d{0,9}))*$/.test(token)) return null;
    const ids = token.split(',').map(Number);
    return ids.every((id) => id <= MAX_ID) ? ids : null;
  }

  get token(): string {
    return [this.cursor, ...this.gaps.keys()].join(',');
  }

  /** True while a skipped id may still arrive (the stream should keep polling briskly). */
  get waiting(): boolean {
    return this.gaps.size > 0;
  }

  /** The next events to stream, oldest first. Call `delivered` for each one that was sent. */
  async poll(db: Db, now = Date.now(), limit = 200) {
    for (const [id, since] of this.gaps) if (now - since > GAP_WAIT_MS) this.gaps.delete(id);
    return eventsSince(db, this.cursor, limit, [...this.gaps.keys()]);
  }

  delivered(id: number, now = Date.now()): void {
    if (id > this.cursor) {
      for (let skipped = Math.max(this.cursor + 1, id - MAX_GAPS); skipped < id; skipped++) this.gaps.set(skipped, now);
      this.cursor = id;
      this.trimGaps();
    } else {
      this.gaps.delete(id);
    }
  }

  /** Keeps the newest MAX_GAPS skipped ids. */
  private trimGaps() {
    if (this.gaps.size <= MAX_GAPS) return;
    for (const id of [...this.gaps.keys()].sort((a, b) => a - b).slice(0, this.gaps.size - MAX_GAPS)) this.gaps.delete(id);
  }
}

/** Drops outbox rows older than `maxAgeMs`; a browser that was away longer just reloads. */
export async function pruneEvents(db: Db, now: Date, maxAgeMs = 2 * 3_600_000) {
  await db.delete(events).where(lt(events.ts, new Date(now.getTime() - maxAgeMs).toISOString()));
}
