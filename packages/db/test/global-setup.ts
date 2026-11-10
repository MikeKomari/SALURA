import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { buildSeededImage, SEED_TIME } from './seed-image.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    /** A migrated database seeded at SEED_TIME, as a PGlite data-dir dump on disk. */
    seededImagePath: string;
  }
}

/** Builds the seeded database image once for the whole run, instead of once per test file. */
export default async function setup(project: TestProject) {
  const dir = await mkdtemp(join(tmpdir(), 'salura-pg-'));
  const path = join(dir, 'seeded.tar');
  await writeFile(path, Buffer.from(await (await buildSeededImage(SEED_TIME)).arrayBuffer()));
  project.provide('seededImagePath', path);
  return () => rm(dir, { recursive: true, force: true });
}
