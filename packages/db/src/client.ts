import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import * as schema from './schema.ts';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = PgTransaction<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
/** Anything queries can run against: the database or an open transaction. */
export type Q = Db | Tx;

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const closers = new WeakMap<object, () => Promise<void>>();

export interface OpenDbOptions {
  /** Apply pending migrations after connecting (default true). The Vercel handler skips this. */
  migrate?: boolean;
  /** Pool size for a Postgres server (default 5). */
  maxConnections?: number;
}

/**
 * Opens the database.
 * - `postgres://…` (Supabase, any Postgres): a pooled connection. Prepared statements are off,
 *   so Supabase's transaction pooler (port 6543) works.
 * - `memory://`: an embedded in-process Postgres (PGlite) for tests and the evaluation.
 * - anything else: a PGlite data folder on disk, for running locally without a server.
 */
export async function openDb(url: string, opts: OpenDbOptions = {}): Promise<Db> {
  const migrate = opts.migrate ?? true;
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
    const options: Parameters<typeof postgres>[1] & { max_pipeline: number } = {
      prepare: false,
      // No deep pipelining: many queued queries on one connection hang behind Supabase's transaction
      // pooler (port 6543) until the statement timeout. 1 still lets sql.begin attach its connection
      // (0 breaks transactions). A real postgres.js option, missing from its type definitions.
      max_pipeline: 1,
      max: opts.maxConnections ?? 5,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: local ? false : 'require',
      onnotice: () => {},
    };
    const client = postgres(url, options);
    const db = drizzle(client, { schema }) as unknown as Db;
    closers.set(db, () => client.end({ timeout: 5 }));
    if (migrate) {
      // postgres.js only allows the migrator's BEGIN on a single-connection client.
      const { migrate: run } = await import('drizzle-orm/postgres-js/migrator');
      const single = postgres(url, { ...options, max: 1 });
      try {
        await run(drizzle(single, { schema }) as never, { migrationsFolder });
      } finally {
        await single.end({ timeout: 5 });
      }
    }
    return db;
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  let client: InstanceType<typeof PGlite>;
  if (url === 'memory://' || url === ':memory:') client = new PGlite();
  else {
    const dir = resolve(url);
    mkdirSync(dirname(dir), { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzle(client, { schema }) as unknown as Db;
  closers.set(db, () => client.close());
  if (migrate) {
    const { migrate: run } = await import('drizzle-orm/pglite/migrator');
    await run(db as never, { migrationsFolder });
  }
  return db;
}

/** Closes the connection pool (or the embedded database). Safe to call twice. */
export async function closeDb(db: Db): Promise<void> {
  const close = closers.get(db);
  closers.delete(db);
  await close?.();
}

/** First row of a query, or undefined (the async replacement for SQLite's `.get()`). */
export async function first<T>(rows: Promise<T[]> | PromiseLike<T[]>): Promise<T | undefined> {
  return (await rows)[0];
}
