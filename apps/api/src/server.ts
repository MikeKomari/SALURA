import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { loadAgentEnv } from '@salura/agent';
import { createApp } from './app.ts';
import { bootstrap, repoRoot } from './bootstrap.ts';
import { startAgentSchedules } from './schedule.ts';

// Long-running server: local development, Docker, a VPS. (Vercel uses vercel.ts instead.)
const env = process.env;
process.on('unhandledRejection', (err) => console.error('Unhandled rejection (kept running):', err));

const { deps, service, maintenance } = await bootstrap(env, { serverless: false });
const app = createApp({ ...deps, webDist: resolve(repoRoot, env.WEB_DIST || 'apps/web/dist') });

// AGENT_SCHEDULE=off disables the daily autonomous runs (COLLECTIONS_SCHEDULE is the older name).
if ((env.AGENT_SCHEDULE ?? env.COLLECTIONS_SCHEDULE) !== 'off') startAgentSchedules(service, () => new Date());
// Housekeeping every minute: stale runs, idle demo reset, pruning.
setInterval(() => void maintenance.maybeRun(), 60_000).unref();
void maintenance.maybeRun();

const agentEnv = loadAgentEnv(env);
const port = Number(env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`SALURA API on http://localhost:${port} · model ${agentEnv.LLM_MODEL} (${agentEnv.LLM_TOOL_MODE}) · WhatsApp ${deps.channels.whatsappEnabled ? 'on' : 'off'}`);
});
