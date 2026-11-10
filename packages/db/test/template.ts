import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { inject } from 'vitest';
import type { Db } from '../src/index.ts';
import * as schema from '../src/schema.ts';
import { buildSeededImage, pgliteOf, SEED_TIME } from './seed-image.ts';

// Tests share migrated and seeded database images: each test loads its own copy (about a second)
// instead of starting Postgres, migrating and seeding (several seconds, far more under load).

type Extra = { key: string; init: (db: Db) => Promise<void> };
const images = new Map<string, Promise<Blob>>();

/** A data-dir dump of a migrated database seeded at `now`, plus whatever `extra` adds. Built once per test file, or taken from global-setup.ts. */
function seededImage(now: number, extra?: Extra): Promise<Blob> {
  const key = `${now}|${extra?.key ?? ''}`;
  let img = images.get(key);
  if (!img) {
    img = (async () => {
      if (!extra) {
        const path = now === SEED_TIME ? inject('seededImagePath') : undefined;
        return path ? new Blob([await readFile(path)]) : buildSeededImage(now);
      }
      const db = await load(await seededImage(now));
      await extra.init(db);
      const image = await pgliteOf(db).dumpDataDir('none');
      await closeSeededDb(db);
      return image;
    })();
    images.set(key, img);
  }
  return img;
}

async function load(image: Blob): Promise<Db> {
  const client = new PGlite({ loadDataDir: image });
  await client.waitReady;
  return drizzle(client, { schema }) as unknown as Db;
}

/** An isolated, migrated and seeded in-memory database. Close it with closeSeededDb. */
export async function seededDb(now: number, extra?: Extra): Promise<Db> {
  return load(await seededImage(now, extra));
}

export async function closeSeededDb(db: Db): Promise<void> {
  const client = pgliteOf(db);
  if (!client.closed) await client.close();
}
