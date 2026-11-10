import { resolve } from 'node:path';

/**
 * DATABASE_URL (Postgres) or, when unset, a local embedded database under ./data.
 * Relative paths are taken from the repository root, as the API resolves them.
 */
export function databaseUrl(env = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (url) return /^postgres(ql)?:\/\//.test(url) || url === 'memory://' ? url : resolve(import.meta.dirname, '../../../..', url);
  return resolve(import.meta.dirname, '../../../..', 'data/pglite');
}
