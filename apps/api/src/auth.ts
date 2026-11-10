import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, lt } from '@salura/db/orm';
import { DEFAULT_ACCOUNTS, first, sessions, users, type Db, type UserRole } from '@salura/db';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export const SESSION_COOKIE = 'salura_session';
export const SESSION_DAYS = 7;
export const MIN_PASSWORD_LENGTH = 8;

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Spent on unknown usernames too, so response time does not reveal which accounts exist. */
const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Checks the password and opens a session. Returns the cookie token, or null on wrong credentials. */
export async function login(db: Db, username: string, password: string, now: Date): Promise<{ token: string; user: SessionUser; expiresAt: Date } | null> {
  const user = await first(db.select().from(users).where(eq(users.username, username.trim().toLowerCase())));
  const ok = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH));
  if (!user || !ok || user.disabled) return null;
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ id: tokenId(token), userId: user.id, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
  return { token, user: publicUser(user), expiresAt };
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, tokenId(token)));
}

export async function sessionUser(db: Db, token: string | undefined, now: Date): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const row = await first(
    db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, tokenId(token)), gt(sessions.expiresAt, now.toISOString()))),
  );
  if (!row || row.user.disabled) return null;
  return publicUser(row.user);
}

export async function pruneSessions(db: Db, now: Date): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now.toISOString()));
}

function publicUser(u: typeof users.$inferSelect): SessionUser {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
}

/** Creates or replaces an account's password. */
export async function upsertUser(db: Db, input: { username: string; displayName: string; role: UserRole; password: string }): Promise<void> {
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('Username: 3–32 characters, letters, digits, dot, dash or underscore');
  const passwordHash = await hashPassword(input.password);
  await db
    .insert(users)
    .values({ username, displayName: input.displayName, role: input.role, passwordHash })
    .onConflictDoUpdate({ target: users.username, set: { displayName: input.displayName, role: input.role, passwordHash, disabled: false } });
  // A new password signs the account out everywhere.
  const user = await first(db.select({ id: users.id }).from(users).where(eq(users.username, username)));
  if (user) await db.delete(sessions).where(eq(sessions.userId, user.id));
}

/**
 * Creates the default accounts (admin, tamu) that do not exist yet, from ADMIN_PASSWORD and
 * VIEWER_PASSWORD. Existing accounts are left alone, so a password changed later is never reset.
 * Returns generated passwords (local runs without a configured one) so the caller can print them.
 */
export async function ensureAccounts(db: Db, env: NodeJS.ProcessEnv, opts: { generateMissing: boolean }): Promise<{ username: string; password: string }[]> {
  const generated: { username: string; password: string }[] = [];
  for (const account of DEFAULT_ACCOUNTS) {
    const exists = await first(db.select({ id: users.id }).from(users).where(eq(users.username, account.username)));
    if (exists) continue;
    let password = env[account.passwordEnv]?.trim() ?? '';
    if (password.length < MIN_PASSWORD_LENGTH) {
      if (!opts.generateMissing) continue;
      password = randomBytes(9).toString('base64url');
      generated.push({ username: account.username, password });
    }
    await upsertUser(db, { username: account.username, displayName: account.displayName, role: account.role, password });
  }
  return generated;
}
