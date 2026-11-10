import { and, eq, gt, lt, sql } from '@salura/db/orm';
import { first, rateLimits, type Db } from '@salura/db';

/**
 * Fixed-window limiter with its counters in the database, so the limit holds across every server
 * instance (Vercel runs many). Enough to keep a public demo from burning the LLM budget.
 */
export class RateLimiter {
  constructor(
    private readonly db: Db,
    private readonly name: string,
    private readonly opts: { windowMs: number; max: number },
  ) {}

  /** Counts one hit for `key` and says whether it is within the limit. */
  async allow(key: string, now = Date.now()): Promise<boolean> {
    return (await this.add(key, 1, now)) <= this.opts.max;
  }

  /** Counts `n` hits for `key` at once (e.g. things already done) and returns the window's total. */
  async add(key: string, n: number, now = Date.now()): Promise<number> {
    const k = `${this.name}:${key}`.slice(0, 200);
    const resetAt = now + this.opts.windowMs;
    const [row] = await this.db
      .insert(rateLimits)
      .values({ key: k, count: n, resetAt })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          count: sql`case when ${rateLimits.resetAt} <= ${now} then ${n} else ${rateLimits.count} + ${n} end`,
          resetAt: sql`case when ${rateLimits.resetAt} <= ${now} then ${resetAt} else ${rateLimits.resetAt} end`,
        },
      })
      .returning({ count: rateLimits.count });
    return row?.count ?? n;
  }

  /** Gives back `n` hits counted in the current window (never below zero). */
  async release(key: string, n: number, now = Date.now()): Promise<void> {
    await this.db
      .update(rateLimits)
      .set({ count: sql`greatest(0, ${rateLimits.count} - ${n})` })
      .where(and(eq(rateLimits.key, `${this.name}:${key}`.slice(0, 200)), gt(rateLimits.resetAt, now)));
  }

  /** Forgets `key`, e.g. a webhook id whose message could not be taken in after all. */
  async forget(key: string): Promise<void> {
    await this.db.delete(rateLimits).where(eq(rateLimits.key, `${this.name}:${key}`.slice(0, 200)));
  }

  /** True while `key` has used up its limit in the current window. Counts nothing. */
  async blocked(key: string, now = Date.now()): Promise<boolean> {
    const row = await first(this.db.select().from(rateLimits).where(eq(rateLimits.key, `${this.name}:${key}`.slice(0, 200))));
    return Boolean(row && row.resetAt > now && row.count >= this.opts.max);
  }
}

export async function pruneRateLimits(db: Db, now = Date.now()): Promise<void> {
  await db.delete(rateLimits).where(lt(rateLimits.resetAt, now));
}
