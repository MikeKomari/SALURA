import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { eq } from '@salura/db/orm';
import { closeDb, openDb, users } from '@salura/db';
import { MIN_PASSWORD_LENGTH, upsertUser } from '../auth.ts';
import { databaseUrl } from '../bootstrap.ts';

// Console accounts.
//   pnpm user add juri admin "Juri GTNIC"      password from USER_PASSWORD, or a generated one is printed
//   pnpm user password admin                   new password for an existing account (signs it out everywhere)
//   pnpm user disable tamu | pnpm user list

const args = process.argv.slice(2).filter((a) => a !== '--');
const { positionals } = parseArgs({ args, allowPositionals: true });
const [command, username, ...rest] = positionals;

const db = await openDb(databaseUrl(process.env), { maxConnections: 1 });
const password = () => {
  const given = process.env.USER_PASSWORD?.trim();
  if (given && given.length < MIN_PASSWORD_LENGTH) throw new Error(`USER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  return { value: given || randomBytes(9).toString('base64url'), generated: !given };
};

try {
  if (command === 'list') {
    for (const u of await db.select().from(users).orderBy(users.id)) console.log(`${u.username.padEnd(16)} ${u.role.padEnd(7)} ${u.disabled ? 'disabled' : 'active  '} ${u.displayName}`);
  } else if (command === 'add' && username) {
    const role = rest[0] === 'viewer' ? 'viewer' : rest[0] === 'admin' ? 'admin' : null;
    if (!role) throw new Error('Role must be admin or viewer');
    const p = password();
    await upsertUser(db, { username, role, displayName: rest[1] ?? username, password: p.value });
    console.log(`Account ${username} (${role}) saved.${p.generated ? ` Password: ${p.value}` : ''}`);
  } else if (command === 'password' && username) {
    const [u] = await db.select().from(users).where(eq(users.username, username.toLowerCase()));
    if (!u) throw new Error(`No account ${username}`);
    const p = password();
    await upsertUser(db, { username: u.username, role: u.role, displayName: u.displayName, password: p.value });
    console.log(`Password changed for ${u.username}.${p.generated ? ` New password: ${p.value}` : ''}`);
  } else if (command === 'disable' && username) {
    const done = await db.update(users).set({ disabled: true }).where(eq(users.username, username.toLowerCase())).returning({ id: users.id });
    console.log(done.length ? `${username} disabled.` : `No account ${username}`);
  } else {
    console.log('Usage: pnpm user add <username> <admin|viewer> ["Display name"] | password <username> | disable <username> | list');
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
