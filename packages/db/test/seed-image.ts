import type { PGlite } from '@electric-sql/pglite';
import { openDb, seed, type Db } from '../src/index.ts';

// No vitest import here: global-setup.ts runs outside the test workers.

/** The seed time of the shared image every test file uses. */
export const SEED_TIME = Date.parse('2026-10-21T03:00:00.000Z');

export function pgliteOf(db: Db): PGlite {
  return (db as unknown as { $client: PGlite }).$client;
}

/** Migrates and seeds a new in-memory database at `now` and dumps its data folder. */
export async function buildSeededImage(now: number): Promise<Blob> {
  const db = await openDb('memory://');
  await seed(db, now);
  const image = await pgliteOf(db).dumpDataDir('none');
  await pgliteOf(db).close();
  return image;
}
