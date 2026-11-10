import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, inArray } from '@salura/db/orm';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import {
  AUTONOMY_ACTIONS,
  AUTONOMY_MODES,
  ORDER_STATUSES,
  agentRuns,
  approvals,
  auditLog,
  autonomyPolicies,
  customers,
  evalReports,
  first,
  invoices,
  messages,
  orders,
  users,
  type Db,
} from '@salura/db';
import {
  applyStatementMatches,
  Audit,
  BANK_STATEMENT_SAMPLE,
  bankStatementSample,
  CHAT_SAMPLES,
  chatSamplePhoto,
  creditStatus,
  creditStatuses,
  DELIVERY_SAMPLES,
  deliveryOverview,
  DomainError,
  getCheck,
  getOrder,
  loadMedia,
  markShipped,
  matchStatement,
  mediaExt,
  overdueInvoices,
  overpayments,
  settleOverpayment,
  pickingList,
  recentNudges,
  recentPayments,
  reorderCandidates,
  rupiah,
  CANCEL_REASON_CODES,
  sampleOrderId,
  samplePhoto,
  saveMedia,
  ServiceBusyError,
  storeChatSample,
  storeSample,
  usualOrder,
  OutboxReader,
  type AgentEvent,
  type EventBus,
  type GuestSession,
  type SaluraService,
} from '@salura/agent';
import { login, logout, SESSION_COOKIE, SESSION_DAYS, sessionUser, type SessionUser } from './auth.ts';
import { parseOpenWAWebhook, type ChannelRouter } from './channels.ts';
import { parseBankStatement } from './bank-statement.ts';
import { resetDemo, type Maintenance } from './demo-reset.ts';
import { applyImport, DATASETS, exportCsv, fetchSheet, ImportError, previewImport } from './importer.ts';
import { dashboardMetrics, recentAgentOrders } from './metrics.ts';
import { lineAvailabilities, orderViews, orderViewsById } from './listing.ts';
import { RateLimiter } from './rate-limit.ts';

export interface AppDeps {
  db: Db;
  bus: EventBus;
  service: SaluraService;
  channels: ChannelRouter;
  clock: () => Date;
  manualMinutesPerOrder: number;
  corsOrigins: string[];
  /** Lazy housekeeping (stale runs, idle demo reset, pruning); run on requests and by the cron. */
  maintenance?: Maintenance;
  /** Shared secret Vercel Cron sends as "Authorization: Bearer …". Cron routes fail closed without it. */
  cronSecret?: string;
  /** Mark the session cookie Secure (behind HTTPS). */
  secureCookies?: boolean;
  /** Keeps work alive after the response is sent (Vercel's waitUntil); defaults to fire and forget. */
  background?: (work: Promise<unknown>) => void;
  /** Built ops console (apps/web/dist). Served from the same origin when the folder exists. */
  webDist?: string | null;
  /** Behind a reverse proxy you control: take the client IP from it instead of the socket. */
  trustProxy?: boolean;
  /** Optional header the proxy sets with the real client IP (e.g. x-real-ip on Vercel, fly-client-ip). */
  clientIpHeader?: string;
  /** Live stream tuning: how often the outbox is polled, and how long one stream lasts before the browser reconnects. */
  ssePollMs?: number;
  /** Slowest poll while nothing happens (default 3 s). */
  sseIdlePollMs?: number;
  sseMaxMs?: number;
}

type Env = { Variables: { user: SessionUser } };

/** Vercel rejects request bodies above 4.5 MB. Voice notes may use that; photos are shrunk by the console well below 2 MB. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** WhatsApp ids are digits only; this also stops arbitrary strings becoming conversations. */
const WA_ID = /^\d{8,15}$/;
const MAX_SSE_PER_IP = 10;
/** A live stream keeps its fastest poll this long after the last event (agent steps are seconds apart). */
const SSE_ACTIVE_MS = 15_000;
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me']);

export function createApp(deps: AppDeps) {
  const { db, bus, service, clock } = deps;
  const app = new Hono<Env>();
  const chatLimiter = new RateLimiter(db, 'chat', { windowMs: 10 * 60_000, max: 40 });
  const ipLimiter = new RateLimiter(db, 'ip', { windowMs: 10 * 60_000, max: 80 });
  const newNumberLimiter = new RateLimiter(db, 'new-number', { windowMs: 60 * 60_000, max: 5 });
  const loginFailures = new RateLimiter(db, 'login-fail', { windowMs: 10 * 60_000, max: 10 });
  const webhookLimiter = new RateLimiter(db, 'webhook', { windowMs: 60_000, max: 120 });
  const webhookSeen = new RateLimiter(db, 'webhook-id', { windowMs: 24 * 3_600_000, max: 1 });
  // Uploads are stored in the database: at most 30 files an hour per client (at most about 60 MB).
  const uploadLimiter = new RateLimiter(db, 'upload', { windowMs: 60 * 60_000, max: 30 });
  // Approvals a guest account's test chats may queue per hour, so testers cannot flood the owner's queue.
  const guestApprovals = new RateLimiter(db, 'guest-approval', { windowMs: 60 * 60_000, max: 10 });
  // Matching a statement reads every open invoice and customer: at most 60 checks or saves an hour per client.
  const bankLimiter = new RateLimiter(db, 'bank-statement', { windowMs: 60 * 60_000, max: 60 });
  const sseByIp = new Map<string, number>();
  const background = deps.background ?? ((work) => void work.catch((err) => console.error('background task failed', err)));

  const clientIp = (c: Context): string => {
    if (deps.trustProxy) {
      // A platform header (e.g. x-real-ip on Vercel) is set by the proxy itself.
      const platform = deps.clientIpHeader ? c.req.header(deps.clientIpHeader)?.trim() : undefined;
      if (platform) return platform;
      // Proxies append to X-Forwarded-For, so the left-most entry is whatever the client sent;
      // the right-most is the address our own proxy saw.
      const hops = c.req.header('x-forwarded-for')?.split(',').map((h) => h.trim()).filter(Boolean);
      if (hops?.length) return hops.at(-1)!;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'local'; // in-process requests (tests) have no socket
    }
  };
  const tooMany = (c: Context, message = 'Terlalu banyak permintaan. Coba lagi beberapa menit lagi.') =>
    c.json({ error: { code: 'rate_limited', message } }, 429);

  // CORS first, so even early rejections (413, 400) carry the headers a cross-origin console needs.
  // Only when the console is hosted on another origin; the same-origin console needs no CORS at all.
  if (deps.corsOrigins.length) app.use('*', cors({ origin: deps.corsOrigins, credentials: true, allowHeaders: ['content-type'] }));

  // Request bodies are capped before anything is parsed or buffered.
  app.use('/api/*', bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 256 * 1024, onError: (c) => c.json({ error: { code: 'too_large', message: 'Ukuran file maksimal 4 MB.' } }, 413) }));
  app.use('/webhooks/*', bodyLimit({ maxSize: Math.ceil(MAX_UPLOAD_BYTES * 1.4), onError: (c) => c.json({ error: { code: 'too_large', message: 'Request is too large' } }, 413) }));
  app.use('/api/conversations/:waId/*', async (c, next) => {
    if (!WA_ID.test(c.req.param('waId') ?? '')) return c.json({ error: { code: 'invalid_wa_id', message: 'Nomor WhatsApp harus 8 sampai 15 angka.' } }, 400);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, 409);
    if (err instanceof ImportError) return c.json({ error: { code: 'import_invalid', message: err.message } }, 400);
    if (err instanceof z.ZodError) return c.json({ error: { code: 'invalid_request', message: 'Permintaan tidak valid', details: err.issues } }, 400);
    if (err instanceof HTTPException) return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
    if (err instanceof ServiceBusyError) return c.json({ error: { code: 'busy', message: 'SALURA sedang melayani banyak pesan. Coba kirim lagi sebentar lagi.' } }, 503);
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Terjadi kesalahan di server. Coba lagi.' } }, 500);
  });

  // Cross-site requests never change anything: a browser always sends Origin on POST/PUT/DELETE,
  // and the session cookie is SameSite=Lax on top of this.
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !c.req.path.startsWith('/webhooks/')) {
      const origin = c.req.header('origin');
      if (origin && !sameOrigin(origin, c.req.url, c.req.header('x-forwarded-host')) && !deps.corsOrigins.includes(origin)) {
        return c.json({ error: { code: 'bad_origin', message: 'Permintaan dari situs lain ditolak.' } }, 403);
      }
    }
    await next();
  });

  // Every console route and file needs a logged-in account. Fails closed.
  const requireUser = async (c: Context<Env>, next: Next) => {
    const user = await sessionUser(db, getCookie(c, SESSION_COOKIE), clock());
    if (!user) return c.json({ error: { code: 'unauthorized', message: 'Silakan masuk terlebih dahulu.' } }, 401);
    c.set('user', user);
    if (deps.maintenance) background(deps.maintenance.maybeRun());
    await next();
  };
  app.use('/api/*', async (c, next) => (PUBLIC_API.has(c.req.path) || c.req.path.startsWith('/api/cron/') ? next() : requireUser(c, next)));
  app.use('/media/*', requireUser);

  /** Actions that change data or speak for the distributor: admins only. */
  const admin = async (c: Context<Env>, next: Next) => {
    if (c.get('user').role !== 'admin') return c.json({ error: { code: 'forbidden', message: 'Hanya admin yang bisa melakukan ini. Akun tamu hanya bisa melihat dan mencoba chat.' } }, 403);
    await next();
  };

  app.get('/health', (c) => c.json({ ok: true, time: clock().toISOString() }));

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------
  app.post('/api/auth/login', async (c) => {
    const body = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) }).parse(await c.req.json());
    const ip = clientIp(c);
    // Checked before the password, so a correct guess after the limit is refused too.
    if (await loginFailures.blocked(ip)) return tooMany(c, 'Terlalu banyak percobaan masuk. Coba lagi 10 menit lagi.');
    const session = await login(db, body.username, body.password, clock());
    if (!session) {
      // Only failures count, so a working login is never throttled; guessing passwords is.
      if (!(await loginFailures.allow(ip))) return tooMany(c, 'Terlalu banyak percobaan masuk. Coba lagi 10 menit lagi.');
      return c.json({ error: { code: 'bad_credentials', message: 'Nama pengguna atau kata sandi salah.' } }, 401);
    }
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: deps.secureCookies ?? false,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_DAYS * 86_400,
    });
    return c.json({ user: session.user });
  });

  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await logout(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/auth/me', async (c) => {
    const user = await sessionUser(db, getCookie(c, SESSION_COOKIE), clock());
    return c.json({ user });
  });

  app.get('/api/users', admin, async (c) => {
    const rows = await db.select({ username: users.username, displayName: users.displayName, role: users.role, disabled: users.disabled }).from(users).orderBy(asc(users.id));
    return c.json({ users: rows });
  });

  // ---------------------------------------------------------------------------
  // Live events (agent trace, new messages, approvals) over Server-Sent Events.
  // Streamed from the `events` outbox, so the browser sees runs served by any instance.
  // ---------------------------------------------------------------------------
  app.get('/api/events', async (c) => {
    const ip = clientIp(c);
    if ((sseByIp.get(ip) ?? 0) >= MAX_SSE_PER_IP) return tooMany(c, 'Terlalu banyak koneksi langsung.');
    // The browser sends Last-Event-ID on its own reconnects; the console passes it in the query
    // when it opens a fresh stream (after the tab was hidden), since EventSource cannot set the header.
    const { reader, resumed } = await OutboxReader.open(db, c.req.header('last-event-id') ?? c.req.query('lastEventId'));
    // Polls every pollMs while events flow, then slows to idlePollMs; an event emitted on this
    // instance wakes the stream at once. Each stream ends well inside Vercel's maxDuration (300 s).
    const pollMs = deps.ssePollMs ?? 700;
    const idlePollMs = deps.sseIdlePollMs ?? Math.max(pollMs, 3_000);
    const until = Date.now() + (deps.sseMaxMs ?? 240_000);
    sseByIp.set(ip, (sseByIp.get(ip) ?? 0) + 1);
    return streamSSE(c, async (stream) => {
      let activeUntil = Date.now() + SSE_ACTIVE_MS;
      let wake = () => {};
      const unsubscribe = bus.subscribe(() => {
        activeUntil = Date.now() + SSE_ACTIVE_MS;
        wake();
      });
      stream.onAbort(() => wake());
      try {
        // The browser reconnects 1 s after the stream ends and resumes from the last id it saw.
        let sentToken = reader.token;
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ resumed }), id: sentToken, retry: 1000 });
        let lastWrite = Date.now();
        let delay = pollMs;
        while (!stream.aborted && Date.now() < until) {
          const rows = await reader.poll(db);
          for (const row of rows) {
            if (stream.aborted) break;
            reader.delivered(row.id);
            sentToken = reader.token;
            await stream.writeSSE({ event: 'agent', data: JSON.stringify(publicEvent(row.payload as unknown as AgentEvent)), id: sentToken });
            lastWrite = Date.now();
          }
          if (stream.aborted) break;
          if (rows.length === 200) continue;
          if (rows.length) activeUntil = Date.now() + SSE_ACTIVE_MS;
          delay = reader.waiting || Date.now() < activeUntil ? pollMs : Math.min(Math.round(delay * 1.5), idlePollMs);
          // A ping keeps proxies from closing an idle stream, and hands the browser the new resume
          // token when an awaited id was given up on.
          if (reader.token !== sentToken || Date.now() - lastWrite > 20_000) {
            sentToken = reader.token;
            await stream.writeSSE({ event: 'ping', data: '{}', id: sentToken });
            lastWrite = Date.now();
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(delay, Math.max(0, until - Date.now())));
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = () => {};
        }
      } finally {
        unsubscribe();
        const left = (sseByIp.get(ip) ?? 1) - 1;
        if (left > 0) sseByIp.set(ip, left);
        else sseByIp.delete(ip);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Web chat (the judge-testable channel)
  // ---------------------------------------------------------------------------
  app.get('/api/conversations', async (c) => {
    const rows = await db.select().from(customers).orderBy(asc(customers.id));
    // The newest message of every conversation in one query.
    const latest = rows.length
      ? await db
          .selectDistinctOn([messages.waId])
          .from(messages)
          .where(inArray(messages.waId, rows.map((r) => r.waId)))
          .orderBy(messages.waId, desc(messages.id))
      : [];
    const lastByWa = new Map(latest.map((m) => [m.waId, m]));
    const list = rows.map((cust) => {
      const last = lastByWa.get(cust.waId);
      return {
        waId: cust.waId,
        customerId: cust.id,
        name: cust.name,
        ownerName: cust.ownerName,
        honorific: cust.honorific,
        area: cust.area,
        tier: cust.tier,
        lastMessage: last ? { text: last.text ?? last.transcript ?? `[${last.kind}]`, direction: last.direction, at: last.createdAt, kind: last.kind } : null,
      };
    });
    list.sort((a, b) => (b.lastMessage?.at ?? '').localeCompare(a.lastMessage?.at ?? ''));
    return c.json({ conversations: list });
  });

  app.get('/api/conversations/:waId/messages', async (c) => {
    const rows = await db.select().from(messages).where(eq(messages.waId, c.req.param('waId'))).orderBy(asc(messages.id));
    return c.json({ messages: rows.map(publicMessage) });
  });

  app.get('/api/conversations/:waId/profile', async (c) => {
    const cust = await first(db.select().from(customers).where(eq(customers.waId, c.req.param('waId'))));
    if (!cust) return c.json({ error: { code: 'not_found', message: 'Pelanggan tidak dikenal' } }, 404);
    const lastOrder = await first(db.select().from(orders).where(and(eq(orders.customerId, cust.id), eq(orders.guest, false))).orderBy(desc(orders.createdAt)).limit(1));
    return c.json({
      customer: cust,
      credit: await creditStatus(db, cust.id, clock()),
      usualOrder: await usualOrder(db, cust.id),
      lastOrderAt: lastOrder?.createdAt ?? null,
    });
  });

  app.get('/api/conversations/:waId/trace', async (c) => {
    const runs = (await db.select().from(agentRuns).where(eq(agentRuns.waId, c.req.param('waId'))).orderBy(desc(agentRuns.startedAt)).limit(10)).reverse();
    return c.json({ runs: await Promise.all(runs.map(async (r) => ({ run: r, steps: await traceFor(r.id) }))) });
  });

  const knownConversation = async (waId: string) =>
    Boolean((await first(db.select({ id: customers.id }).from(customers).where(eq(customers.waId, waId)))) ?? (await first(db.select({ id: messages.id }).from(messages).where(eq(messages.waId, waId)).limit(1))));
  /** A guest account typing as a warung: nothing changes stock or invoices until an admin approves. */
  // The allowance is per account and device, so judges sharing the one guest account do not use up each other's.
  const guestSession = (c: Context<Env>): GuestSession | undefined => {
    const user = c.get('user');
    if (user.role === 'admin') return undefined;
    const key = `${user.id}|${clientIp(c)}`;
    return {
      // Counted and checked in one statement, so two runs at once cannot both take the last approval.
      reserveApproval: async () => {
        if (await guestApprovals.allow(key)) return true;
        await guestApprovals.release(key, 1);
        return false;
      },
      adjustApprovals: async (n) => void (n > 0 ? await guestApprovals.add(key, n) : await guestApprovals.release(key, -n)),
    };
  };

  // Sample photos a warung would send (transfer receipt, surat jalan), stored with their transcript so
  // the payment and delivery-complaint flows work even without a vision provider.
  app.get('/api/chat-samples', (c) =>
    c.json({ samples: CHAT_SAMPLES.map((s) => ({ id: s.id, label: s.label, waId: s.customerWaId, caption: s.caption, imageUrl: `/api/chat-samples/${s.id}.jpg` })) }),
  );
  app.get('/api/chat-samples/:file', (c) => {
    const sample = CHAT_SAMPLES.find((s) => `${s.id}.jpg` === c.req.param('file'));
    if (!sample) return c.notFound();
    return c.body(new Uint8Array(chatSamplePhoto(sample)), 200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  });
  app.post('/api/conversations/:waId/sample', async (c) => {
    const waId = c.req.param('waId');
    const ip = clientIp(c);
    if (!(await ipLimiter.allow(ip)) || !(await chatLimiter.allow(`${ip}|${waId}`))) return tooMany(c, 'Terlalu banyak pesan. Coba lagi beberapa menit lagi.');
    const body = z.object({ sample: z.string(), text: z.string().trim().max(2000).optional() }).parse(await c.req.json());
    const sample = CHAT_SAMPLES.find((s) => s.id === body.sample);
    if (!sample) return c.json({ error: { code: 'not_found', message: 'Contoh foto tidak dikenal' } }, 404);
    if (sample.customerWaId !== waId) return c.json({ error: { code: 'wrong_customer', message: 'Contoh ini milik warung lain' } }, 400);
    const mediaId = await storeChatSample(db, sample);
    return c.json(await service.handleInbound({ waId, channel: 'web', kind: 'image', text: body.text || sample.caption, mediaId, guest: guestSession(c) }));
  });

  app.post('/api/conversations/:waId/messages', async (c) => {
    const waId = c.req.param('waId');
    const ip = clientIp(c);
    if (!(await ipLimiter.allow(ip)) || !(await chatLimiter.allow(`${ip}|${waId}`))) return tooMany(c, 'Terlalu banyak pesan. Coba lagi beberapa menit lagi.');
    if (!(await knownConversation(waId)) && !(await newNumberLimiter.allow(ip))) return tooMany(c, 'Terlalu banyak nomor baru dari perangkat ini. Pakai salah satu warung yang sudah ada.');
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.startsWith('multipart/form-data')) {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) return c.json({ error: { code: 'invalid_request', message: 'file is required' } }, 400);
      if (!mediaExt(file.type)) return c.json({ error: { code: 'unsupported_media', message: 'Hanya audio (webm, ogg, mp3, m4a, wav) dan foto (jpg, png, webp).' } }, 415);
      const kind = file.type.startsWith('audio/') ? 'voice' : 'image';
      if (file.size > (kind === 'image' ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES)) {
        return c.json({ error: { code: 'too_large', message: kind === 'image' ? 'Foto maksimal 2 MB.' : 'Pesan suara maksimal 4 MB.' } }, 413);
      }
      if (!(await uploadLimiter.allow(ip))) return tooMany(c, 'Terlalu banyak file dikirim. Coba lagi satu jam lagi.');
      const mediaId = await saveMedia(db, { data: Buffer.from(await file.arrayBuffer()), mime: file.type });
      const caption = typeof form.text === 'string' && form.text.trim() ? form.text.trim().slice(0, 2000) : undefined;
      return c.json(await service.handleInbound({ waId, channel: 'web', kind, text: caption, mediaId, guest: guestSession(c) }));
    }
    const body = z.object({ text: z.string().trim().min(1).max(2000) }).parse(await c.req.json());
    return c.json(await service.handleInbound({ waId, channel: 'web', kind: 'text', text: body.text, guest: guestSession(c) }));
  });

  // An admin answers the customer directly, e.g. after an escalation.
  app.post('/api/conversations/:waId/admin-reply', admin, async (c) => {
    const waId = c.req.param('waId')!;
    const body = z.object({ text: z.string().trim().min(1).max(2000) }).parse(await c.req.json());
    if (!(await knownConversation(waId))) return c.json({ error: { code: 'not_found', message: 'Percakapan tidak dikenal' } }, 404);
    const message = await service.sendToCustomer({ waId, text: body.text, runId: null, actor: 'human', sentBy: c.get('user').displayName });
    return c.json({ message: publicMessage(message) });
  });

  app.get('/media/:name', async (c) => {
    const name = c.req.param('name');
    if (!/^[\w-]+\.\w+$/.test(name)) return c.notFound();
    const file = await loadMedia(db, name);
    if (!file) return c.notFound();
    return c.body(new Uint8Array(file.data), 200, {
      'content-type': file.mime,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    });
  });

  // ---------------------------------------------------------------------------
  // Orders, approvals, traces
  // ---------------------------------------------------------------------------
  app.get('/api/orders', async (c) => {
    const status = c.req.query('status');
    const statuses = status ? z.array(z.enum(ORDER_STATUSES)).parse(status.split(',')) : null;
    const rows = await db
      .select({ order: orders, customer: { name: customers.name, waId: customers.waId } })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(eq(orders.historic, false), statuses ? inArray(orders.status, statuses) : undefined))
      .orderBy(desc(orders.id))
      .limit(200);
    const views = await orderViews(db, rows.map((r) => r.order));
    return c.json({
      // Orders from a guest's test chat are listed with `guest` so the console marks them; nothing real counts them.
      orders: rows.map((r) => ({ ...views.get(r.order.id)!, customer: r.customer, channel: r.order.channel, createdAt: r.order.createdAt, updatedAt: r.order.updatedAt, shippedAt: r.order.shippedAt, guest: r.order.guest })),
    });
  });

  app.get('/api/orders/:id', async (c) => {
    const id = idParam(c.req.param('id')) ?? 0;
    const order = id ? await getOrder(db, id) : undefined;
    if (!order) return c.json({ error: { code: 'not_found', message: 'Pesanan tidak ditemukan' } }, 404);
    const raw = (await first(db.select().from(orders).where(eq(orders.id, id))))!;
    const customer = (await first(db.select().from(customers).where(eq(customers.id, order.customerId))))!;
    const relatedApprovals = await db.select().from(approvals).where(eq(approvals.orderId, id)).orderBy(asc(approvals.id));
    return c.json({
      order: {
        ...order,
        channel: raw.channel,
        createdAt: raw.createdAt,
        confirmedAt: raw.confirmedAt,
        shippedAt: raw.shippedAt,
        humanEdited: raw.humanEdited,
        guest: raw.guest,
        cancelledAt: raw.cancelledAt,
        cancelledBy: raw.cancelledBy,
        cancelReason: raw.cancelReason,
      },
      customer,
      approvals: relatedApprovals,
    });
  });

  // --- Corrections: the admin's repair for an order the agent should not have confirmed ----------

  /** What the "Ada yang salah" dialog shows: whether it can still be withdrawn, and the draft notice. */
  app.get('/api/orders/:id/correction', admin, async (c) => {
    const id = idParam(c.req.param('id')) ?? 0;
    const correction = await service.orderCorrection(id).catch((err) => {
      if (err instanceof DomainError && err.code === 'order_not_found') return null;
      throw err;
    });
    if (!correction) return c.json({ error: { code: 'not_found', message: 'Pesanan tidak ditemukan' } }, 404);
    return c.json({
      canCancel: correction.blocked === null,
      blocked: correction.blocked,
      invoiceNumber: correction.invoiceNumber,
      message: correction.message,
      subtotal: correction.order.subtotal,
      customer: { name: correction.customer.name, waId: correction.customer.waId },
    });
  });

  app.post('/api/orders/:id/cancel', admin, async (c) => {
    const body = z
      .object({
        reasonCode: z.enum(CANCEL_REASON_CODES as [string, ...string[]]),
        note: z.string().trim().max(500).optional(),
        /** The notice the admin approved, which they may have edited; blank falls back to the draft. */
        message: z.string().trim().max(2000).optional(),
      })
      .parse(await c.req.json());
    const result = await service.cancelConfirmedOrder({ orderId: idParam(c.req.param('id')) ?? 0, cancelledBy: c.get('user').displayName, ...body });
    return c.json(result);
  });

  app.post('/api/orders/:id/restore', admin, async (c) => {
    const body = z.object({ notify: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await service.restoreCancelledOrder({ orderId: idParam(c.req.param('id')) ?? 0, restoredBy: c.get('user').displayName, ...body }));
  });

  app.get('/api/approvals', async (c) => {
    const status = z.enum(['pending', 'approved', 'rejected', 'all']).parse(c.req.query('status') ?? 'pending');
    const rows = await db
      .select({ approval: approvals, customer: { id: customers.id, name: customers.name, waId: customers.waId, tier: customers.tier }, guest: agentRuns.guest })
      .from(approvals)
      .leftJoin(customers, eq(customers.id, approvals.customerId))
      .leftJoin(agentRuns, eq(agentRuns.id, approvals.runId))
      .where(status === 'all' ? undefined : eq(approvals.status, status))
      .orderBy(status === 'pending' ? asc(approvals.requestedAt) : desc(approvals.requestedAt), asc(approvals.id))
      .limit(200);
    const now = clock();
    const views = await orderViewsById(db, rows.flatMap((r) => (r.approval.orderId ? [r.approval.orderId] : [])));
    // Held orders do not reserve stock; the owner sees what is left before approving.
    const showsStock = (r: (typeof rows)[number]) => r.approval.status === 'pending' && (r.approval.type === 'order' || r.approval.type === 'credit_override');
    const stockFor = await lineAvailabilities(db, rows.flatMap((r) => (showsStock(r) && views.has(r.approval.orderId!) ? [views.get(r.approval.orderId!)!] : [])));
    const credit = await creditStatuses(db, rows.flatMap((r) => (r.customer ? [r.customer.id] : [])), now);
    // A pending invoice correction shows the overpayment as it would be now (a payment may have come in since).
    const adjusting = rows.flatMap((r) => (r.approval.status === 'pending' && r.approval.type === 'invoice_adjustment' ? [Number((r.approval.payload as { invoiceId?: number }).invoiceId)] : []));
    const paidNow = new Map((adjusting.length ? await db.select({ id: invoices.id, paidAmount: invoices.paidAmount }).from(invoices).where(inArray(invoices.id, adjusting)) : []).map((i) => [i.id, i.paidAmount]));
    const livePayload = (a: (typeof rows)[number]['approval']) => {
      const p = a.payload as { invoiceId?: number; to?: number } | null;
      const paid = a.status === 'pending' && a.type === 'invoice_adjustment' && p?.invoiceId !== undefined ? paidNow.get(p.invoiceId) : undefined;
      return paid === undefined || p?.to === undefined ? a.payload : { ...p, paidAmount: paid, overpaid: Math.max(0, paid - p.to) };
    };
    return c.json({
      approvals: rows.map((r) => {
        const order = r.approval.orderId ? (views.get(r.approval.orderId) ?? null) : null;
        return {
          ...r.approval,
          payload: livePayload(r.approval),
          guest: r.guest ?? false,
          customer: r.customer,
          order,
          stock: order && showsStock(r) ? stockFor.get(order.orderId)! : null,
          credit: r.customer ? credit.get(r.customer.id)! : null,
        };
      }),
    });
  });

  const decisionBody = z.object({
    note: z.string().trim().max(500).optional(),
    editedLines: z.array(z.object({ productId: z.number().int().positive(), qty: z.number().int().positive(), unit: z.string() })).optional(),
  });
  app.post('/api/approvals/:id/approve', admin, async (c) => {
    const body = decisionBody.parse(await c.req.json().catch(() => ({})));
    return c.json({ approval: await service.decideApproval({ approvalId: idParam(c.req.param('id')) ?? 0, decision: 'approve', decidedBy: c.get('user').displayName, ...body }) });
  });
  app.post('/api/approvals/:id/reject', admin, async (c) => {
    const body = z.object({ note: z.string().trim().min(3).max(500) }).parse(await c.req.json());
    return c.json({ approval: await service.decideApproval({ approvalId: idParam(c.req.param('id')) ?? 0, decision: 'reject', decidedBy: c.get('user').displayName, note: body.note }) });
  });

  app.get('/api/runs', async (c) => c.json({ runs: await db.select().from(agentRuns).orderBy(desc(agentRuns.startedAt)).limit(50) }));
  app.get('/api/runs/:id/trace', async (c) => {
    const run = await first(db.select().from(agentRuns).where(eq(agentRuns.id, c.req.param('id'))));
    if (!run) return c.json({ error: { code: 'not_found', message: 'Run tidak ditemukan' } }, 404);
    return c.json({ run, steps: await traceFor(run.id) });
  });

  // ---------------------------------------------------------------------------
  // Dashboard, collections, payments, deliveries, warehouse
  // ---------------------------------------------------------------------------
  app.get('/api/dashboard', async (c) => {
    const oldestPending = await first(
      db
        .select({ approval: approvals, customer: { name: customers.name } })
        .from(approvals)
        .leftJoin(customers, eq(customers.id, approvals.customerId))
        .where(eq(approvals.status, 'pending'))
        .orderBy(asc(approvals.requestedAt))
        .limit(1),
    );
    const recent = await recentAgentOrders(db);
    const views = await orderViews(db, recent.map((r) => r.order));
    return c.json({
      metrics: await dashboardMetrics(db, clock(), deps.manualMinutesPerOrder),
      recentOrders: recent.map((r) => ({ ...views.get(r.order.id)!, customer: r.customer, updatedAt: r.order.updatedAt })),
      oldestPendingApproval: oldestPending ? { ...oldestPending.approval, customerName: oldestPending.customer?.name ?? null } : null,
      evaluation: summarizeEval(await latestEval()),
    });
  });

  app.get('/api/collections/overdue', async (c) => c.json({ invoices: await overdueInvoices(db, clock()) }));
  app.post('/api/collections/run', admin, async (c) => c.json(await service.runCollections('schedule')));
  app.get('/api/payments', async (c) => c.json({ payments: await recentPayments(db, clock()) }));
  app.get('/api/collections/overpaid', async (c) => c.json({ overpayments: await overpayments(db) }));
  app.post('/api/collections/overpaid/:source/:id/settle', admin, async (c) => {
    const source = z.enum(['invoice_correction', 'payment']).parse(c.req.param('source'));
    const id = idParam(c.req.param('id')) ?? 0;
    await settleOverpayment(db, { source, id, now: clock() });
    await new Audit(db, bus, clock, null).log({ actor: 'human', type: 'approval', summary: `${c.get('user').displayName} menandai lebih bayar ${source === 'payment' ? `pembayaran #${id}` : `tagihan #${id}`} sudah dikembalikan atau dipotong`, data: { source, id } });
    return c.json({ overpayments: await overpayments(db) });
  });

  // Delivery checks: a photographed surat jalan or nota compared with its order and invoice.
  app.get('/api/deliveries', async (c) =>
    c.json({
      orders: await deliveryOverview(db, clock()),
      samples: await Promise.all(
        DELIVERY_SAMPLES.map(async (s) => ({ id: s.id, title: s.title, kind: s.kind, orderId: await sampleOrderId(db, s), imageUrl: `/api/deliveries/samples/${s.id}.jpg` })),
      ),
    }),
  );
  app.get('/api/deliveries/samples/:file', (c) => {
    const sample = DELIVERY_SAMPLES.find((s) => `${s.id}.jpg` === c.req.param('file'));
    if (!sample) return c.notFound();
    return c.body(new Uint8Array(samplePhoto(sample)), 200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  });
  app.get('/api/deliveries/checks/:id', async (c) => {
    const check = await getCheck(db, idParam(c.req.param('id')) ?? 0);
    const { mediaId, ...rest } = check;
    return c.json({ check: { ...rest, imageUrl: `/media/${mediaId}` }, steps: check.runId ? await traceFor(check.runId) : [] });
  });
  app.post('/api/deliveries/:orderId/check', admin, async (c) => {
    const orderId = idParam(c.req.param('orderId')) ?? 0;
    let mediaId: string;
    let kind: 'surat_jalan' | 'nota';
    if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) return c.json({ error: { code: 'invalid_request', message: 'file is required' } }, 400);
      if (!mediaExt(file.type) || !file.type.startsWith('image/')) return c.json({ error: { code: 'unsupported_media', message: 'Unggah foto dokumen (JPG, PNG atau WebP).' } }, 415);
      if (file.size > MAX_IMAGE_BYTES) return c.json({ error: { code: 'too_large', message: 'Foto maksimal 2 MB.' } }, 413);
      if (!(await uploadLimiter.allow(clientIp(c)))) return tooMany(c, 'Terlalu banyak file dikirim. Coba lagi satu jam lagi.');
      kind = z.enum(['surat_jalan', 'nota']).parse(form.kind ?? 'surat_jalan');
      mediaId = await saveMedia(db, { data: Buffer.from(await file.arrayBuffer()), mime: file.type });
    } else {
      const body = z.object({ sample: z.string() }).parse(await c.req.json());
      const sample = DELIVERY_SAMPLES.find((s) => s.id === body.sample);
      if (!sample) return c.json({ error: { code: 'not_found', message: 'Contoh dokumen tidak dikenal' } }, 404);
      if ((await sampleOrderId(db, sample)) !== orderId) return c.json({ error: { code: 'wrong_order', message: 'Contoh ini milik pesanan lain' } }, 400);
      kind = sample.kind;
      // The bundled transcript travels with the copy, so the demo works without a vision provider.
      mediaId = await storeSample(db, sample);
    }
    const { check, run } = await service.runDeliveryCheck({ orderId, kind, mediaId, source: 'console' });
    const { mediaId: _hidden, ...publicCheck } = check;
    return c.json({ check: publicCheck, run });
  });

  // Warehouse: what to pick for each delivery run, and marking orders as loaded.
  app.get('/api/warehouse/picking', async (c) => c.json({ batches: await pickingList(db) }));
  app.post('/api/warehouse/ship', admin, async (c) => {
    const body = z.object({ orderIds: z.array(z.number().int().positive()).min(1).max(200) }).parse(await c.req.json());
    const shipped = await markShipped(db, body.orderIds, clock());
    if (shipped.length) {
      await new Audit(db, bus, clock, null).log({ actor: 'human', type: 'data_change', summary: `${c.get('user').displayName} menandai ${shipped.length} pesanan sudah dimuat: #${shipped.join(', #')}`, data: { orderIds: shipped } });
      for (const orderId of shipped) await bus.emit({ type: 'order', orderId });
    }
    return c.json({ shipped });
  });

  app.get('/api/proactive/candidates', async (c) => c.json({ candidates: await reorderCandidates(db, clock()), recent: await recentNudges(db, clock()) }));
  app.post('/api/proactive/run', admin, async (c) => c.json(await service.runProactive('schedule')));

  app.get('/api/eval/latest', async (c) => c.json({ report: await latestEval() }));

  // ---------------------------------------------------------------------------
  // Spreadsheet import (catalogue, units, prices, stock, customers)
  // ---------------------------------------------------------------------------
  const dataset = (c: Context) => z.enum(DATASETS).parse(c.req.param('dataset'));
  const importText = async (c: Context): Promise<string> => {
    if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
      const file = (await c.req.parseBody()).file;
      if (!(file instanceof File)) throw new ImportError('Pilih file CSV.');
      return file.text();
    }
    const body = z.object({ csv: z.string().max(2 * 1024 * 1024).optional(), sheetUrl: z.string().url().max(500).optional() }).parse(await c.req.json());
    if (body.csv) return body.csv;
    if (body.sheetUrl) return fetchSheet(body.sheetUrl);
    throw new ImportError('Kirim file CSV atau tautan Google Sheets.');
  };
  app.get('/api/import/:dataset/template', async (c) => {
    const name = dataset(c);
    // The customer list holds phone numbers, addresses and credit limits: admins only.
    if (name === 'pelanggan' && c.get('user').role !== 'admin') return c.json({ error: { code: 'forbidden', message: 'Data pelanggan hanya bisa diunduh admin.' } }, 403);
    return c.body(await exportCsv(db, name), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="salura-${name}.csv"` });
  });
  app.post('/api/import/:dataset/preview', admin, async (c) => c.json({ preview: await previewImport(db, dataset(c), await importText(c)) }));
  app.post('/api/import/:dataset/apply', admin, async (c) => {
    const name = dataset(c);
    const preview = await applyImport(db, name, await importText(c));
    if (preview.errors.length) return c.json({ error: { code: 'import_invalid', message: `${preview.errors.length} baris belum valid; tidak ada yang disimpan.` }, preview }, 400);
    await new Audit(db, bus, clock, null).log({
      actor: 'human',
      type: 'data_change',
      summary: `${c.get('user').displayName} mengimpor ${name}: ${preview.inserts} baru, ${preview.updates} diperbarui`,
      data: { dataset: name, rows: preview.rows, inserts: preview.inserts, updates: preview.updates },
    });
    await bus.emit({ type: 'reset' }); // every screen refetches: catalogue, prices or customers changed
    return c.json({ preview });
  });

  // ---------------------------------------------------------------------------
  // Bank statement (mutasi rekening): match money in with invoices and reported payments
  // ---------------------------------------------------------------------------
  const selectionsSchema = z.array(z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), candidateId: z.string().max(40).nullable() })).max(2000);
  /** The statement as an uploaded CSV file (with `selections` as a JSON field), `{csv}`, or `{sample: true}` for the bundled one. */
  const statementInput = async (c: Context): Promise<{ text: string; selections: unknown }> => {
    if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
      const form = await c.req.parseBody();
      if (!(form.file instanceof File)) throw new ImportError('Pilih file CSV mutasi rekening.');
      let selections: unknown;
      try {
        selections = typeof form.selections === 'string' ? JSON.parse(form.selections) : undefined;
      } catch {
        throw new ImportError('Pilihan pencocokan tidak terbaca.');
      }
      return { text: await form.file.text(), selections };
    }
    const body = z.object({ csv: z.string().max(2 * 1024 * 1024).optional(), sample: z.boolean().optional(), selections: z.unknown().optional() }).parse(await c.req.json());
    if (body.sample) return { text: bankStatementSample(), selections: body.selections };
    if (body.csv) return { text: body.csv, selections: body.selections };
    throw new ImportError('Kirim file CSV mutasi rekening.');
  };
  app.get('/api/bank-statement/sample', (c) =>
    c.body(bankStatementSample(), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${BANK_STATEMENT_SAMPLE}"` }),
  );
  app.post('/api/bank-statement/preview', admin, async (c) => {
    if (!(await bankLimiter.allow(clientIp(c)))) return tooMany(c, 'Terlalu sering memeriksa mutasi. Coba lagi satu jam lagi.');
    const { lines, ...parsed } = parseBankStatement((await statementInput(c)).text, clock());
    return c.json({ preview: { ...parsed, lines: await matchStatement(db, lines) } });
  });
  app.post('/api/bank-statement/apply', admin, async (c) => {
    if (!(await bankLimiter.allow(clientIp(c)))) return tooMany(c, 'Terlalu sering menyimpan mutasi. Coba lagi satu jam lagi.');
    const input = await statementInput(c);
    const selections = selectionsSchema.parse(input.selections ?? []);
    const user = c.get('user').displayName;
    const { applied, messages } = await applyStatementMatches(db, { lines: parseBankStatement(input.text, clock()).lines, selections, decidedBy: user, now: clock() });
    const count = (outcome: (typeof applied)[number]['outcome']) => applied.filter((a) => a.outcome === outcome).length;
    const paid = applied.filter((a) => a.outcome === 'payment_recorded' || a.outcome === 'chat_payment_approved');
    if (applied.some((a) => a.outcome !== 'already_recorded')) {
      await new Audit(db, bus, clock, null).log({
        actor: 'human',
        type: 'approval',
        summary: `${user} mencocokkan mutasi rekening: ${paid.length} pembayaran dicatat (${rupiah(paid.reduce((s, a) => s + a.amount, 0))}), ${count('linked')} sudah tercatat sebelumnya, ${count('ignored')} diabaikan`,
        data: { lines: applied.map(({ row, postedOn, amount, outcome, customer, paymentId, approvalId }) => ({ row, postedOn, amount, outcome, customerId: customer?.id ?? null, paymentId, approvalId })) },
      });
    }
    for (const a of applied) if (a.approvalId !== null) await bus.emit({ type: 'approval', approvalId: a.approvalId });
    // Already committed: a thank-you that fails to send must not make the owner think nothing was saved.
    for (const m of messages) {
      await service.sendToCustomer({ waId: m.waId, text: m.text, runId: null, actor: 'human' }).catch((err) => console.error('bank statement thank-you failed', err));
    }
    return c.json({ applied });
  });

  // ---------------------------------------------------------------------------
  // Settings and demo control
  // ---------------------------------------------------------------------------
  app.get('/api/settings/autonomy', async (c) => c.json({ policies: await db.select().from(autonomyPolicies) }));
  app.put('/api/settings/autonomy/:action', admin, async (c) => {
    const action = z.enum(AUTONOMY_ACTIONS).parse(c.req.param('action'));
    const body = z.object({ mode: z.enum(AUTONOMY_MODES), maxAutoAmount: z.number().int().positive().nullable().optional() }).parse(await c.req.json());
    await db
      .update(autonomyPolicies)
      .set({ mode: body.mode, ...(body.maxAutoAmount !== undefined ? { maxAutoAmount: body.maxAutoAmount } : {}) })
      .where(eq(autonomyPolicies.action, action));
    await new Audit(db, bus, clock, null).log({ actor: 'human', type: 'data_change', summary: `${c.get('user').displayName} mengubah otonomi ${action} menjadi ${body.mode}`, data: { action, ...body } });
    return c.json({ policies: await db.select().from(autonomyPolicies) });
  });

  app.get('/api/channels/status', async (c) => c.json({ web: { status: 'connected' }, whatsapp: await deps.channels.sessionStatus() }));

  app.post('/api/admin/reset', admin, async (c) => {
    await resetDemo(db, bus, clock());
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Scheduled jobs (Vercel Cron calls these with "Authorization: Bearer $CRON_SECRET")
  // ---------------------------------------------------------------------------
  app.get('/api/cron/:job', async (c) => {
    const secret = deps.cronSecret;
    if (!secret || c.req.header('authorization') !== `Bearer ${secret}`) return c.json({ error: { code: 'unauthorized', message: 'Cron secret required' } }, 401);
    const job = z.enum(['proactive', 'collections', 'maintenance']).parse(c.req.param('job'));
    const maintenance = deps.maintenance ? await deps.maintenance.run() : null;
    if (job === 'maintenance') return c.json({ maintenance });
    const result = job === 'proactive' ? await service.runProactive('schedule') : await service.runCollections('schedule');
    return c.json({ job, runId: result.runId, status: result.status, maintenance });
  });

  // ---------------------------------------------------------------------------
  // WhatsApp (OpenWA) webhook
  // ---------------------------------------------------------------------------
  app.post('/webhooks/openwa', async (c) => {
    // Not configured → the route does not exist. Configured → signed requests only (fails closed).
    if (!deps.channels.whatsappEnabled) return c.notFound();
    if (!(await webhookLimiter.allow(clientIp(c)))) return tooMany(c);
    const raw = await c.req.text();
    const signature = c.req.header('x-openwa-signature') ?? c.req.header('x-webhook-signature') ?? c.req.header('x-signature');
    if (!deps.channels.verifySignature(raw, signature)) return c.json({ error: { code: 'bad_signature', message: 'Invalid signature' } }, 401);
    let body: unknown;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return c.json({ error: { code: 'invalid_json', message: 'Body is not JSON' } }, 400);
    }
    const parsed = parseOpenWAWebhook(body);
    if (!parsed) return c.json({ ignored: true });
    // Redelivered webhooks must not run the agent twice for one customer message.
    if (parsed.id && !(await webhookSeen.allow(parsed.id))) return c.json({ duplicate: true });
    let mediaId: string | undefined;
    if (parsed.media) {
      const data = Buffer.from(parsed.media.base64, 'base64');
      if (!mediaExt(parsed.media.mimetype)) return c.json({ ignored: true, reason: 'unsupported_media' });
      if (data.length > MAX_UPLOAD_BYTES) return c.json({ error: { code: 'too_large', message: 'Media is larger than 4 MB' } }, 413);
      try {
        mediaId = await saveMedia(db, { data, mime: parsed.media.mimetype });
      } catch (err) {
        // Not taken in after all: the provider's retry must not be answered as a duplicate.
        if (parsed.id) await webhookSeen.forget(parsed.id).catch(() => undefined);
        throw err;
      }
    }
    // Acknowledge immediately; the reply goes out through the outbox when the agent finishes. WhatsApp
    // will not resend, so a message the agent cannot take is stored and handed to an admin instead.
    background(service.acceptInbound({ waId: parsed.waId, channel: 'whatsapp', kind: parsed.kind, text: parsed.text, mediaId }));
    return c.json({ accepted: true });
  });

  // Single-page ops console (local server and Docker; on Vercel the CDN serves it).
  const webIndex = deps.webDist ? join(deps.webDist, 'index.html') : null;
  if (deps.webDist && webIndex && existsSync(webIndex)) {
    const isConsoleRoute = (path: string) => !/^\/(api|media|webhooks|health)(\/|$)/.test(path);
    // Paths with a file extension are assets: a missing one is a 404, never the HTML page.
    const isPageRoute = (path: string) => isConsoleRoute(path) && !/\.[a-z0-9]+$/i.test(path);
    const assets = serveStatic({ root: deps.webDist });
    app.use('*', async (c, next) => {
      if (!isConsoleRoute(c.req.path)) return next();
      const found = await assets(c, next);
      // A file was served (otherwise serveStatic passed the request on). Hashed build assets never
      // change; everything else is checked on every load.
      if (found instanceof Response) {
        found.headers.set('cache-control', c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
        return found;
      }
    });
    // Read per request so a rebuilt console is picked up without restarting the API.
    app.get('*', (c) => (isPageRoute(c.req.path) ? c.html(readFileSync(webIndex, 'utf8'), 200, { 'cache-control': 'no-cache' }) : c.notFound()));
  }

  function traceFor(runId: string) {
    return db.select().from(auditLog).where(eq(auditLog.runId, runId)).orderBy(asc(auditLog.id));
  }

  async function latestEval() {
    return (await first(db.select().from(evalReports).orderBy(desc(evalReports.id)).limit(1)))?.report ?? null;
  }

  return app;
}

/** The page that sent the request is this site (directly, or through a proxy such as Vite's dev server). */
/** A route id that Postgres can take (serial, 32-bit); anything else is treated as "not found" (0). */
function idParam(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

function sameOrigin(origin: string, url: string, forwardedHost?: string): boolean {
  try {
    const host = new URL(origin).host;
    return host === new URL(url).host || (forwardedHost !== undefined && host === forwardedHost.split(',')[0]!.trim());
  } catch {
    return false;
  }
}

function publicMessage(m: typeof messages.$inferSelect) {
  const { mediaId, ...rest } = m;
  return { ...rest, mediaUrl: mediaId ? `/media/${mediaId}` : null };
}

/** Events as the browser sees them: stored file ids become URLs. */
function publicEvent(event: AgentEvent) {
  return event.type === 'message' ? { ...event, message: publicMessage(event.message) } : event;
}

function summarizeEval(report: any) {
  if (!report) return null;
  return { ranAt: report.ranAt, cases: report.summary?.cases, accuracy: report.summary?.itemAccuracy, passK: report.summary?.passK, k: report.summary?.k };
}
