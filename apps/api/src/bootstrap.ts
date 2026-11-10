import { resolve } from 'node:path';
import { count } from '@salura/db/orm';
import { openDb, products, seed, type Db } from '@salura/db';
import { EventBus, SaluraService, loadAgentEnv, modelFromEnv, pricingFromEnv, sttFromEnv, visionFromEnv } from '@salura/agent';
import { ensureAccounts } from './auth.ts';
import { ChannelRouter } from './channels.ts';
import { Maintenance } from './demo-reset.ts';
import type { AppDeps } from './app.ts';

export const repoRoot = resolve(import.meta.dirname, '../../..');

/** DATABASE_URL, or a local embedded database under ./data when it is not set. */
export function databaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) return resolve(repoRoot, 'data/pglite');
  return /^postgres(ql)?:\/\//.test(url) || url === 'memory://' ? url : resolve(repoRoot, url);
}

export interface Bootstrap {
  db: Db;
  deps: Omit<AppDeps, 'webDist' | 'background'>;
  service: SaluraService;
  maintenance: Maintenance;
}

/**
 * Everything the API needs, shared by the long-running server (server.ts) and the Vercel
 * function (vercel.ts). `serverless`: no migrations at start-up (run `pnpm db:migrate` before
 * deploying), a small connection pool, and no generated passwords.
 */
export async function bootstrap(env: NodeJS.ProcessEnv, opts: { serverless: boolean }): Promise<Bootstrap> {
  const agentEnv = loadAgentEnv(env);
  const production = env.NODE_ENV === 'production' || opts.serverless;
  const db = await openDb(databaseUrl(env), { migrate: !opts.serverless, maxConnections: 5 });

  if (!opts.serverless) {
    const [row] = await db.select({ n: count() }).from(products);
    if (!row?.n) {
      await seed(db);
      console.log('Empty database: loaded demo data');
    }
  }
  const generated = await ensureAccounts(db, env, { generateMissing: !production });
  for (const g of generated) console.warn(`Created account "${g.username}" with password: ${g.password}   (set ADMIN_PASSWORD / VIEWER_PASSWORD to choose them)`);

  const clock = () => new Date();
  const bus = new EventBus(db);
  const channels = new ChannelRouter(
    env.OPENWA_API_KEY && env.OPENWA_SESSION_ID
      ? { baseUrl: env.OPENWA_BASE_URL ?? 'http://localhost:2785/api', apiKey: env.OPENWA_API_KEY, sessionId: env.OPENWA_SESSION_ID, webhookSecret: env.OPENWA_WEBHOOK_SECRET ?? '' }
      : null,
  );
  if (channels.whatsappEnabled && !env.OPENWA_WEBHOOK_SECRET) {
    console.warn('OPENWA_WEBHOOK_SECRET is not set: every WhatsApp webhook will be rejected. Set the same secret in OpenWA and here.');
  }

  const service = new SaluraService({
    db,
    bus,
    model: modelFromEnv(agentEnv),
    stt: sttFromEnv(agentEnv),
    vision: visionFromEnv(agentEnv),
    clock,
    pricing: pricingFromEnv(agentEnv),
    outbox: channels,
  });
  const maintenance = new Maintenance({ db, bus, service, clock, idleResetMinutes: Number(env.DEMO_RESET_IDLE_MINUTES ?? 0) });
  const cronSecret = env.CRON_SECRET?.trim();
  if (production && !cronSecret) console.warn('CRON_SECRET is not set: the daily agent runs (Vercel Cron) are refused.');

  return {
    db,
    service,
    maintenance,
    deps: {
      db,
      bus,
      service,
      channels,
      clock,
      maintenance,
      cronSecret: cronSecret || undefined,
      secureCookies: production,
      manualMinutesPerOrder: Number(env.MANUAL_MINUTES_PER_ORDER ?? 6),
      corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      trustProxy: opts.serverless || env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
      clientIpHeader: env.CLIENT_IP_HEADER?.trim().toLowerCase() || (opts.serverless ? 'x-real-ip' : undefined),
    },
  };
}
