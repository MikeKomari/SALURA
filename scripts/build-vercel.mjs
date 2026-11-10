// Builds the Vercel deployment with the Build Output API (https://vercel.com/docs/build-output-api):
//   .vercel/output/static            the ops console (Vite build), served by Vercel's CDN
//   .vercel/output/functions/api.func  the whole API as one Node function (Hono, bundled by esbuild)
//   .vercel/output/config.json       routes (API paths → function, everything else → the console) and crons
//
// Run with `pnpm build:vercel` (Vercel runs it as the build command; see vercel.json).

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.vercel/output');
const fn = join(out, 'functions/api.func');

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

// 1. The console.
execSync('pnpm --filter @salura/web build', { cwd: root, stdio: 'inherit' });
cpSync(join(root, 'apps/web/dist'), join(out, 'static'), { recursive: true });

// 2. The API. A bundled function has no package folders to read files from, so the agent's assets
//    (policy documents for RAG, sample photos, the sample bank statement) are inlined in place of packages/agent/src/assets.ts.
const agentDir = join(root, 'packages/agent');
const knowledge = readdirSync(join(agentDir, 'knowledge'))
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((name) => ({ name, content: readFileSync(join(agentDir, 'knowledge', name), 'utf8') }));
const samples = Object.fromEntries(readdirSync(join(agentDir, 'samples')).filter((f) => /\.(jpg|txt|csv)$/.test(f)).map((f) => [f, readFileSync(join(agentDir, 'samples', f)).toString('base64')]));
const inlineAssets = {
  name: 'inline-agent-assets',
  setup(b) {
    b.onLoad({ filter: /packages[\\/]agent[\\/]src[\\/]assets\.ts$/ }, () => ({
      loader: 'js',
      contents: `
const KNOWLEDGE = ${JSON.stringify(knowledge)};
const SAMPLES = ${JSON.stringify(samples)};
export function knowledgeFiles() { return KNOWLEDGE.map((f) => ({ ...f })); }
export function sampleFile(name) {
  const data = SAMPLES[name];
  if (data === undefined) throw new Error('Unknown sample ' + name);
  return Buffer.from(data, 'base64');
}`,
    }));
  },
};

await build({
  entryPoints: [join(root, 'apps/api/src/vercel.ts')],
  outfile: join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  // The embedded database (PGlite) is for local runs and tests; production always has DATABASE_URL.
  external: ['@electric-sql/pglite', 'drizzle-orm/pglite', 'drizzle-orm/pglite/migrator'],
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __salura_require } from 'node:module'; const require = __salura_require(import.meta.url);" },
  plugins: [inlineAssets],
  logLevel: 'info',
});
writeFileSync(join(fn, 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(
  join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      shouldAddSourcemapSupport: true,
      // An agent run may take up to 90 s; the live event stream reconnects every 4 minutes.
      maxDuration: 300,
      // Next to Supabase in Singapore: every query is a round trip.
      regions: [process.env.VERCEL_FUNCTION_REGION || 'sin1'],
    },
    null,
    2,
  ),
);

// 3. Routing and the daily agent runs (times in UTC: 01:00 = 08:00 WIB, 02:00 = 09:00 WIB).
const config = {
  version: 3,
  routes: [
    { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
    { src: '^/((?:api|media|webhooks|health)(?:/.*)?)$', dest: '/api?__p=$1' },
    { handle: 'filesystem' },
    { src: '^/(.*)$', dest: '/index.html', headers: { 'cache-control': 'no-cache' } },
  ],
  crons: [
    { path: '/api/cron/proactive', schedule: '0 1 * * *' },
    { path: '/api/cron/collections', schedule: '0 2 * * *' },
  ],
};
writeFileSync(join(out, 'config.json'), JSON.stringify(config, null, 2));
console.log(`\nVercel output written to ${out}`);
