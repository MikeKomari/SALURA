import { eq } from '@salura/db/orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { rateLimits, sessions, users } from '@salura/db';
import { closeSeededDb, seededDb } from '../../../packages/db/test/template.ts';
import { ensureAccounts, hashPassword, login, pruneSessions, sessionUser, upsertUser, verifyPassword } from '../src/auth.ts';
import { pruneRateLimits, RateLimiter } from '../src/rate-limit.ts';

const T0 = new Date('2026-10-21T03:00:00Z');
const DAY = 86_400_000;
const after = (ms: number) => new Date(T0.getTime() + ms);

async function freshDb() {
  const db = await seededDb(T0.getTime());
  onTestFinished(() => closeSeededDb(db));
  return db;
}

describe('password hashing', () => {
  it('salts every hash and verifies only the right password', async () => {
    const a = await hashPassword('rahasia-123');
    const b = await hashPassword('rahasia-123');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[\w+/=]+\$[\w+/=]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('rahasia-123', a)).toBe(true);
    expect(await verifyPassword('rahasia-124', a)).toBe(false);
  });

  it('rejects stored values that are not scrypt hashes', async () => {
    expect(await verifyPassword('x', 'rahasia-123')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
  });
});

describe('sessions', () => {
  it('lasts seven days', async () => {
    const db = await freshDb();
    await upsertUser(db, { username: 'Budi', displayName: 'Pak Budi', role: 'admin', password: 'rahasia-123' });
    expect(await login(db, 'budi', 'salah-sekali', T0)).toBeNull();
    expect(await login(db, 'nobody', 'rahasia-123', T0)).toBeNull();

    const s = (await login(db, ' BUDI ', 'rahasia-123', T0))!;
    expect(s.expiresAt).toEqual(after(7 * DAY));
    // Only a hash of the token is stored.
    expect((await db.select().from(sessions)).map((r) => r.id)).not.toContain(s.token);
    expect(await sessionUser(db, s.token, after(7 * DAY - 1))).toMatchObject({ username: 'budi', role: 'admin' });
    expect(await sessionUser(db, s.token, after(7 * DAY))).toBeNull();
    expect(await sessionUser(db, undefined, T0)).toBeNull();
    expect(await sessionUser(db, 'x'.repeat(201), T0)).toBeNull();

    await pruneSessions(db, after(8 * DAY));
    expect(await db.select().from(sessions)).toEqual([]);
  });

  it('signs a disabled account out and keeps it out', async () => {
    const db = await freshDb();
    await upsertUser(db, { username: 'tamu', displayName: 'Tamu', role: 'viewer', password: 'rahasia-123' });
    const s = (await login(db, 'tamu', 'rahasia-123', T0))!;
    await db.update(users).set({ disabled: true }).where(eq(users.username, 'tamu'));
    expect(await sessionUser(db, s.token, T0)).toBeNull();
    expect(await login(db, 'tamu', 'rahasia-123', T0)).toBeNull();
  });

  it('signs the account out everywhere when the password changes', async () => {
    const db = await freshDb();
    await upsertUser(db, { username: 'budi', displayName: 'Pak Budi', role: 'admin', password: 'rahasia-123' });
    const s = (await login(db, 'budi', 'rahasia-123', T0))!;
    await upsertUser(db, { username: 'budi', displayName: 'Pak Budi', role: 'admin', password: 'rahasia-baru' });
    expect(await sessionUser(db, s.token, T0)).toBeNull();
    expect(await login(db, 'budi', 'rahasia-123', T0)).toBeNull();
    expect(await login(db, 'budi', 'rahasia-baru', T0)).not.toBeNull();
  });

  it('refuses short passwords and odd usernames', async () => {
    const db = await freshDb();
    await expect(upsertUser(db, { username: 'budi', displayName: 'B', role: 'admin', password: 'pendek' })).rejects.toThrow(/at least 8/);
    await expect(upsertUser(db, { username: 'b u', displayName: 'B', role: 'admin', password: 'rahasia-123' })).rejects.toThrow(/Username/);
  });
});

describe('default accounts', () => {
  it('creates missing accounts from the environment and never resets an existing one', async () => {
    const db = await freshDb();
    expect(await ensureAccounts(db, { ADMIN_PASSWORD: 'admin-rahasia', VIEWER_PASSWORD: 'short' }, { generateMissing: false })).toEqual([]);
    expect((await db.select().from(users)).map((u) => [u.username, u.role])).toEqual([['admin', 'admin']]);

    const generated = await ensureAccounts(db, { ADMIN_PASSWORD: 'admin-diganti' }, { generateMissing: true });
    expect(generated.map((g) => g.username)).toEqual(['tamu']);
    expect(await login(db, 'tamu', generated[0]!.password, T0)).toMatchObject({ user: { role: 'viewer' } });
    // The admin password from the first start still works; the changed variable is ignored.
    expect(await login(db, 'admin', 'admin-rahasia', T0)).not.toBeNull();
    expect(await login(db, 'admin', 'admin-diganti', T0)).toBeNull();
  });
});

describe('rate limiter', () => {
  it('lets only one of two parallel hits take the last slot, and gives back hits nothing used', async () => {
    const db = await freshDb();
    const limiter = new RateLimiter(db, 'guest-approval', { windowMs: 60_000, max: 10 });
    await limiter.add('tamu', 9, 0);
    // Counted and checked in one statement: two guest runs at once cannot both take the tenth approval.
    expect((await Promise.all([limiter.allow('tamu', 10), limiter.allow('tamu', 10)])).sort()).toEqual([false, true]);
    await limiter.release('tamu', 1, 20);
    expect((await db.select().from(rateLimits))[0]?.count).toBe(10);
    // Never below zero, and nothing to give back once the window has ended.
    await limiter.release('tamu', 50, 30);
    expect((await db.select().from(rateLimits))[0]?.count).toBe(0);
    await limiter.add('tamu', 3, 40);
    await limiter.release('tamu', 3, 60_000);
    expect((await db.select().from(rateLimits))[0]?.count).toBe(3);
    await limiter.forget('tamu');
    expect(await db.select().from(rateLimits)).toEqual([]);
  });

  it('counts hits per key in a fixed window shared through the database', async () => {
    const db = await freshDb();
    const limiter = new RateLimiter(db, 'test', { windowMs: 1_000, max: 2 });
    expect(await limiter.allow('ip-1', 0)).toBe(true);
    expect(await limiter.allow('ip-1', 10)).toBe(true);
    expect(await limiter.blocked('ip-1', 20)).toBe(true);
    expect(await limiter.allow('ip-1', 20)).toBe(false);
    expect(await limiter.allow('ip-1', 999)).toBe(false);
    // Other keys, and other limiters with the same key, count separately.
    expect(await limiter.allow('ip-2', 30)).toBe(true);
    expect(await new RateLimiter(db, 'other', { windowMs: 1_000, max: 1 }).allow('ip-1', 30)).toBe(true);
    // A second server instance sees the same counter.
    expect(await new RateLimiter(db, 'test', { windowMs: 1_000, max: 2 }).allow('ip-1', 40)).toBe(false);

    // A new window starts from zero.
    expect(await limiter.blocked('ip-1', 1_000)).toBe(false);
    expect(await limiter.allow('ip-1', 1_000)).toBe(true);
    expect(await limiter.allow('ip-1', 1_500)).toBe(true);
    expect(await limiter.allow('ip-1', 1_999)).toBe(false);

    await pruneRateLimits(db, 1_500);
    expect((await db.select().from(rateLimits)).map((r) => r.key).sort()).toEqual(['test:ip-1']);
  });

  it('never lets concurrent hits slip past the limit', async () => {
    const db = await freshDb();
    const limiter = new RateLimiter(db, 'burst', { windowMs: 60_000, max: 5 });
    const results = await Promise.all(Array.from({ length: 12 }, () => limiter.allow('ip', 100)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
});
