import { count, max, sql } from '@salura/db/orm';
import { auditLog, messages, resetDb, seed, type Db } from '@salura/db';
import { pruneEvents, pruneMedia, type EventBus, type SaluraService } from '@salura/agent';
import { pruneSessions } from './auth.ts';
import { pruneRateLimits } from './rate-limit.ts';

/** Any fixed number; only demo resets take this lock. */
const RESET_LOCK = 7_311_001;

/**
 * Wipes the demo data and loads the synthetic distributor again, in one transaction. A transaction
 * lock makes concurrent resets (two instances, a double click) wait instead of seeding twice.
 * `onlyIfIdleMinutes`: skip unless the demo was used and then left alone that long.
 */
export async function resetDemo(db: Db, bus: EventBus, now: Date, onlyIfIdleMinutes?: number): Promise<boolean> {
  const done = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RESET_LOCK})`);
    if (onlyIfIdleMinutes !== undefined) {
      const [{ n }] = (await tx.select({ n: count() }).from(messages)) as [{ n: number }];
      if (n === 0) return false;
      const [last] = await tx.select({ ts: max(auditLog.ts) }).from(auditLog);
      if (last?.ts && now.getTime() - new Date(last.ts).getTime() < onlyIfIdleMinutes * 60_000) return false;
    }
    await resetDb(tx as unknown as Db);
    await seed(tx as unknown as Db, now.getTime());
    return true;
  });
  if (done) await bus.emit({ type: 'reset' });
  return done;
}

/**
 * Housekeeping that a long-running server would do on timers. Serverless instances have no timers,
 * so it runs lazily: on requests (at most once a minute per instance) and from the daily cron.
 */
export class Maintenance {
  private lastRun = 0;
  private running: Promise<void> | null = null;

  constructor(
    private readonly deps: { db: Db; bus: EventBus; service: SaluraService; clock: () => Date; idleResetMinutes: number },
  ) {}

  /** Runs the sweep if the last one in this instance was over a minute ago. Never throws. */
  maybeRun(): Promise<void> {
    if (this.running || Date.now() - this.lastRun < 60_000) return this.running ?? Promise.resolve();
    this.lastRun = Date.now();
    const sweep = this.run()
      .then(() => undefined, (err) => console.error('maintenance failed', err))
      .finally(() => {
        this.running = null;
      });
    this.running = sweep;
    return sweep;
  }

  async run(): Promise<{ recovered: number; reset: boolean }> {
    const { db, bus, service, clock, idleResetMinutes } = this.deps;
    const now = clock();
    const recovered = await service.recoverInterruptedRuns();
    const reset = idleResetMinutes > 0 ? await resetDemo(db, bus, now, idleResetMinutes) : false;
    if (reset) console.log(`Demo data reset after ${idleResetMinutes} idle minutes`);
    await pruneEvents(db, now);
    await pruneMedia(db, now);
    await pruneSessions(db, now);
    await pruneRateLimits(db, now.getTime());
    return { recovered, reset };
  }
}
