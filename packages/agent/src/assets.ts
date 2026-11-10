import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Files the agent ships with: policy documents (RAG) and the bundled delivery-document samples.
// Read from disk here; the Vercel build (scripts/build-vercel.mjs) swaps this module for one with
// the files inlined, because a bundled serverless function has no package folder to read from.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Markdown policy documents, sorted by file name. */
export function knowledgeFiles(): { name: string; content: string }[] {
  const dir = join(root, 'knowledge');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }));
}

/** A bundled sample file (photo or its stored transcript). */
export function sampleFile(name: string): Buffer {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`Bad sample name ${name}`);
  return readFileSync(join(root, 'samples', name));
}
