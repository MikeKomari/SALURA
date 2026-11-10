import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, desc, eq, gt, ne, sql } from '@salura/db/orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentRuns, approvals, auditLog, customers, evalReports, events, first, messages, orderItems, orders, productUnits, products, invoices, rateLimits, users, type Db, type OrderStatus } from '@salura/db';
import { creditStatus, EventBus, getOrder, lineAvailability, recordPaymentClaim, SaluraService, saveMedia, ScriptedModel, SidecarStt, SidecarVision, type ScriptStep } from '@salura/agent';
import { closeSeededDb, seededDb } from '../../../packages/db/test/template.ts';
import { createApp } from '../src/app.ts';
import { upsertUser } from '../src/auth.ts';
import { ChannelRouter, parseOpenWAWebhook } from '../src/channels.ts';
import { Maintenance, resetDemo } from '../src/demo-reset.ts';

const BU_SARI = '6281234500001';
const MAKMUR_JAYA = '6281234500002';
const PAK_RASYID = '6281234500003';
const T0 = new Date('2026-10-21T03:00:00Z');
const PASSWORDS = { admin: 'admin-pass-123', tamu: 'tamu-pass-123' } as const;
type Account = keyof typeof PASSWORDS;

/** The seeded demo plus the two console accounts (admin, and the read-only "tamu"). */
const WITH_ACCOUNTS = {
  key: 'accounts',
  init: async (db: Db) => {
    await upsertUser(db, { username: 'admin', displayName: 'Pak Budi', role: 'admin', password: PASSWORDS.admin });
    await upsertUser(db, { username: 'tamu', displayName: 'Tamu', role: 'viewer', password: PASSWORDS.tamu });
  },
};

interface SetupOptions {
  webDist?: string | null;
  cronSecret?: string;
  maintenance?: boolean;
  sseMaxMs?: number;
  /** Another app instance on the same database (closed by whoever opened it). */
  db?: Db;
  channels?: ChannelRouter;
  background?: (work: Promise<unknown>) => void;
}

async function setup(steps: ScriptStep[] = [], opts: SetupOptions = {}) {
  const db = opts.db ?? (await seededDb(T0.getTime(), WITH_ACCOUNTS));
  if (!opts.db) onTestFinished(() => closeSeededDb(db));
  let t = T0.getTime();
  const clock = () => new Date((t += 1000));
  const advance = (ms: number) => void (t += ms);
  const bus = new EventBus(db);
  const channels = opts.channels ?? new ChannelRouter(null);
  const service = new SaluraService({ db, bus, model: new ScriptedModel(steps), stt: new SidecarStt(), vision: new SidecarVision(), clock, pricing: null, outbox: channels });
  const maintenance = opts.maintenance ? new Maintenance({ db, bus, service, clock, idleResetMinutes: 0 }) : undefined;
  const app = createApp({
    db,
    bus,
    service,
    channels,
    clock,
    manualMinutesPerOrder: 6,
    corsOrigins: [],
    webDist: opts.webDist ?? null,
    cronSecret: opts.cronSecret,
    maintenance,
    ssePollMs: 20,
    sseMaxMs: opts.sseMaxMs ?? 3_000,
    background: opts.background,
  });

  const login = (username: string, password: string, headers: Record<string, string> = {}) =>
    app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ username, password }) });
  const cookies: Partial<Record<Account, string>> = {};
  const cookie = async (who: Account) => {
    if (!cookies[who]) {
      const res = await login(who, PASSWORDS[who]);
      expect(res.status).toBe(200);
      cookies[who] = res.headers.get('set-cookie')!.split(';')[0]!;
    }
    return cookies[who]!;
  };
  /** A request signed in as `as` (admin by default), or anonymous with null. */
  const request = async (path: string, init: RequestInit = {}, as: Account | null = 'admin') => {
    const headers = new Headers(init.headers);
    if (as) headers.set('cookie', await cookie(as));
    return app.request(path, { ...init, headers });
  };
  const json = async (path: string, init?: RequestInit, as?: Account | null) => {
    const r = await request(path, init, as);
    return { status: r.status, body: (await r.json()) as any };
  };
  const post = (path: string, body: unknown, as: Account | null = 'admin', headers: Record<string, string> = {}) =>
    json(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, as);
  return { app, db, bus, service, clock, advance, login, cookie, request, json, post };
}

describe('API', () => {
  it('lists conversations and runs the agent on a web chat message', async () => {
    const { json, post } = await setup([{ call: [{ name: 'get_customer_profile', args: {} }] }, { say: 'Halo Bu Sari, mau pesan apa hari ini?' }]);
    const list = await json('/api/conversations', undefined, 'tamu');
    expect(list.body.conversations).toHaveLength(8);

    // A guest account may try the chat.
    const res = await post(`/api/conversations/${BU_SARI}/messages`, { text: 'halo' }, 'tamu');
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Halo Bu Sari, mau pesan apa hari ini?');

    const msgs = await json(`/api/conversations/${BU_SARI}/messages`);
    expect(msgs.body.messages.map((m: any) => m.direction)).toEqual(['in', 'out']);

    const trace = await json(`/api/conversations/${BU_SARI}/trace`);
    expect(trace.body.runs[0].steps.map((s: any) => s.type)).toEqual(['message_in', 'tool_call', 'tool_result', 'message_out']);
  });

  it('lets only an admin decide approvals, and applies the decision', async () => {
    const { json, post } = await setup([
      { call: [{ name: 'draft_order', args: { lines: [{ product_id: 12, qty: 10, unit: 'karung' }] } }] },
      ({ lastToolResults }) => ({ say: `Mohon dicek ya Pak. Total Rp${(lastToolResults[0] as any).result.order.subtotal.toLocaleString('id-ID')}. Balas YA.` }),
      { call: [{ name: 'get_customer_profile', args: {} }] },
      ({ lastToolResults }) => ({ call: [{ name: 'request_approval', args: { order_id: (lastToolResults[0] as any).result.openDraft.orderId, reason: 'Over credit, customer has overdue invoices' } }] }),
      { say: 'Pesanan menunggu persetujuan pemilik ya Pak.' },
    ]);
    await post(`/api/conversations/${MAKMUR_JAYA}/messages`, { text: 'beras sr 10 karung' });
    await post(`/api/conversations/${MAKMUR_JAYA}/messages`, { text: 'ya' });

    const pending = await json('/api/approvals', undefined, 'tamu');
    expect(pending.body.approvals).toHaveLength(1);
    const approval = pending.body.approvals[0];
    expect(approval.type).toBe('credit_override');
    expect(approval.order.lines[0].qty).toBe(10);

    expect((await post(`/api/approvals/${approval.id}/approve`, {}, null)).status).toBe(401);
    const forbidden = await post(`/api/approvals/${approval.id}/approve`, {}, 'tamu');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('forbidden');

    const ok = await post(`/api/approvals/${approval.id}/approve`, {});
    expect(ok.body.approval).toMatchObject({ status: 'approved', decidedBy: 'Pak Budi' });

    const again = await post(`/api/approvals/${approval.id}/approve`, {});
    expect(again.status).toBe(409);

    const dash = await json('/api/dashboard');
    expect(dash.body.metrics).toMatchObject({ ordersHandled: 1, straightThrough: 0, pendingApprovals: 0, minutesSaved: 6 });
    expect(dash.body.metrics.errorsCaught.overCredit).toBe(1);
  });

  it('validates input and returns readable errors', async () => {
    const { post } = await setup();
    const res = await post(`/api/conversations/${BU_SARI}/messages`, { text: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('resets the demo data (admin only)', async () => {
    const { post, json } = await setup([{ say: 'Halo' }]);
    await post(`/api/conversations/${BU_SARI}/messages`, { text: 'halo' });
    expect((await post('/api/admin/reset', {}, 'tamu')).status).toBe(403);
    expect((await post('/api/admin/reset', {})).body.ok).toBe(true);
    expect((await json(`/api/conversations/${BU_SARI}/messages`)).body.messages).toHaveLength(0);
  });
});

describe('admin reply', () => {
  it('lets an admin answer a customer directly', async () => {
    const { post, json } = await setup();
    expect((await post(`/api/conversations/${BU_SARI}/admin-reply`, { text: 'Halo Bu, saya admin.' }, null)).status).toBe(401);
    expect((await post(`/api/conversations/${BU_SARI}/admin-reply`, { text: 'Halo Bu, saya admin.' }, 'tamu')).status).toBe(403);

    const res = await post(`/api/conversations/${BU_SARI}/admin-reply`, { text: 'Halo Bu, saya admin.' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ waId: BU_SARI, direction: 'out', kind: 'text', text: 'Halo Bu, saya admin.', runId: null, mediaUrl: null });
    expect(res.body.message.mediaId).toBeUndefined();

    const msgs = await json(`/api/conversations/${BU_SARI}/messages`);
    expect(msgs.body.messages.map((m: any) => m.text)).toEqual(['Halo Bu, saya admin.']);
  });

  it('rejects empty text and unknown conversations', async () => {
    const { post } = await setup();
    expect((await post(`/api/conversations/${BU_SARI}/admin-reply`, { text: ' ' })).status).toBe(400);
    expect((await post('/api/conversations/6280000000000/admin-reply', { text: 'halo' })).status).toBe(404);
  });
});

describe('accounts', () => {
  it('requires a session for every console route and stored file', async () => {
    const { db, request, json } = await setup();
    const photo = await saveMedia(db, { data: Buffer.from('jpeg-bytes'), mime: 'image/jpeg' });
    for (const path of ['/api/conversations', '/api/approvals', '/api/dashboard', '/api/payments', '/api/warehouse/picking', `/media/${photo}`]) {
      expect((await request(path, {}, null)).status, path).toBe(401);
    }
    // A made-up or oversized session token is no session at all.
    for (const token of ['garbage', 'x'.repeat(500)]) expect((await request('/api/conversations', { headers: { cookie: `salura_session=${token}` } }, null)).status).toBe(401);
    expect((await json('/api/auth/me', undefined, null)).body).toEqual({ user: null });
    expect((await json('/api/auth/me', undefined, 'tamu')).body.user).toMatchObject({ username: 'tamu', role: 'viewer' });

    const file = await request(`/media/${photo}`, {}, 'tamu');
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('jpeg-bytes');
    expect((await request('/media/00000000-0000-0000-0000-000000000000.jpg', {}, 'tamu')).status).toBe(404);
  });

  it('logs in with an HttpOnly cookie and logs out', async () => {
    const { login, app } = await setup();
    const bad = await login('admin', 'wrong-password');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();

    // Usernames are not case sensitive.
    const res = await login(' Admin ', PASSWORDS.admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: expect.objectContaining({ username: 'admin', displayName: 'Pak Budi', role: 'admin' }) });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^salura_session=[\w-]{20,};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const cookie = setCookie.split(';')[0]!;

    expect((await app.request('/api/conversations', { headers: { cookie } })).status).toBe(200);
    expect((await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } })).status).toBe(200);
    expect((await app.request('/api/conversations', { headers: { cookie } })).status).toBe(401);
  });

  it('ends a session after seven days', async () => {
    const { request, advance } = await setup();
    expect((await request('/api/conversations')).status).toBe(200);
    advance(6 * 86_400_000);
    expect((await request('/api/conversations')).status).toBe(200);
    advance(86_400_000 + 60_000);
    expect((await request('/api/conversations')).status).toBe(401);
  });

  it('keeps viewers to reading and chatting', async () => {
    const { json, post, request } = await setup();
    expect((await json('/api/users', undefined, 'tamu')).status).toBe(403);
    const users = await json('/api/users');
    expect(users.body.users.map((u: any) => [u.username, u.role])).toEqual([
      ['admin', 'admin'],
      ['tamu', 'viewer'],
    ]);
    expect(JSON.stringify(users.body)).not.toContain('scrypt');
    for (const [path, body] of [
      ['/api/collections/run', {}],
      ['/api/proactive/run', {}],
      ['/api/warehouse/ship', { orderIds: [1] }],
      ['/api/import/stok/preview', { csv: 'sku,stok\nAQA-600,10' }],
      ['/api/deliveries/1/check', { sample: 'nota-toko-makmur-jaya' }],
    ] as const) {
      expect((await post(path, body, 'tamu')).status, path).toBe(403);
    }
    const put = await request('/api/settings/autonomy/send_reorder_nudge', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'auto' }) }, 'tamu');
    expect(put.status).toBe(403);
  });

  it("caps the approvals a guest's test chats can queue, and leaves admins' chats uncounted", async () => {
    const escalate: ScriptStep = { call: [{ name: 'escalate_to_human', args: { reason: 'Pelanggan minta bicara dengan admin' } }] };
    const { db, post, json } = await setup([
      escalate,
      { say: 'Admin kami akan menghubungi.' },
      escalate,
      { say: 'Admin kami akan menghubungi.' },
      escalate,
      ({ lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ ok: false, error: { code: 'guest_limit' } });
        return { say: 'Mohon maaf, coba lagi nanti ya.' };
      },
    ]);
    const tamu = (await first(db.select().from(users).where(eq(users.username, 'tamu'))))!;
    // Per account and device: in-process test requests come from "local".
    const allowance = eq(rateLimits.key, `guest-approval:${tamu.id}|local`);
    await post(`/api/conversations/${BU_SARI}/messages`, { text: 'mau bicara sama admin' });
    expect(await db.select().from(rateLimits).where(allowance)).toEqual([]);
    await post(`/api/conversations/${BU_SARI}/messages`, { text: 'mau bicara sama admin' }, 'tamu');
    expect((await first(db.select().from(rateLimits).where(allowance)))?.count).toBe(1);
    // The owner sees which approvals came from a guest's test chat.
    expect((await json('/api/approvals')).body.approvals.map((a: any) => a.guest)).toEqual([false, true]);

    await db.update(rateLimits).set({ count: 10 }).where(allowance);
    expect((await post(`/api/conversations/${BU_SARI}/messages`, { text: 'mau bicara sama admin' }, 'tamu')).status).toBe(200);
    expect(await db.select().from(approvals).where(eq(approvals.type, 'escalation'))).toHaveLength(2);
  });

  it('throttles repeated failed logins, even when the password is finally right', async () => {
    const { login } = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await login('admin', `wrong-${i}`)).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    expect((await login('admin', PASSWORDS.admin)).status).toBe(429);
  });

  it('refuses changes sent from another site', async () => {
    const { login, post } = await setup();
    const res = await login('admin', PASSWORDS.admin, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_origin' } });
    expect((await post('/api/admin/reset', {}, 'admin', { origin: 'https://evil.example' })).status).toBe(403);
    // The console's own origin is fine.
    expect((await login('admin', PASSWORDS.admin, { origin: 'http://localhost' })).status).toBe(200);
  });
});

describe('web console', () => {
  it('serves the built console and falls back to index.html for client routes only', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'salura-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
    const { app, request } = await setup([], { webDist: dist });

    const root = await app.request('/');
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('id="root"');

    const deep = await app.request('/approvals/12');
    expect(deep.headers.get('content-type')).toMatch(/text\/html/);

    const asset = await app.request('/assets/app-abc.js');
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    expect((await app.request('/api/nope')).status).toBe(401);
    expect((await request('/api/nope')).status).toBe(404);
    expect(await (await app.request('/health')).json()).toMatchObject({ ok: true });

    // A stale or missing asset must 404, not return the HTML page under a .js URL.
    expect((await app.request('/assets/app-old.js')).status).toBe(404);

    // A rebuilt index.html is served without restarting.
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root" data-build="2"></div>');
    expect(await (await app.request('/pesanan')).text()).toContain('data-build="2"');
  });
});

describe('OpenWA webhook parsing', () => {
  it('reads a text message and ignores groups and own messages', () => {
    expect(parseOpenWAWebhook({ event: 'message.received', data: { from: '6281234500001@c.us', body: 'indomie 2 dus', type: 'chat' } })).toEqual({
      waId: '6281234500001',
      kind: 'text',
      text: 'indomie 2 dus',
    });
    expect(parseOpenWAWebhook({ event: 'message.received', data: { from: '123@g.us', body: 'hi' } })).toBeNull();
    expect(parseOpenWAWebhook({ event: 'message.received', data: { from: '1@c.us', body: 'hi', fromMe: true } })).toBeNull();
    expect(parseOpenWAWebhook({ event: 'session.status', data: {} })).toBeNull();
  });

  it('reads a voice note with inline media', () => {
    expect(parseOpenWAWebhook({ event: 'message.received', data: { from: '6281234500001@c.us', type: 'ptt', media: { data: 'AAA=', mimetype: 'audio/ogg; codecs=opus' } } })).toMatchObject({
      kind: 'voice',
      media: { base64: 'AAA=', mimetype: 'audio/ogg; codecs=opus' },
    });
  });
});

describe('public surface hardening', () => {
  it('rejects conversation ids that are not phone numbers', async () => {
    const { request, post } = await setup();
    expect((await request('/api/conversations/../../etc/messages', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await post('/api/conversations/abc/messages', { text: 'x' })).status).toBe(400);
  });

  it('limits how many new numbers one client can open', async () => {
    const { post } = await setup(Array.from({ length: 12 }, () => ({ say: 'Halo' })));
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post(`/api/conversations/628990000000${i}/messages`, { text: 'halo' })).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });

  it('refuses uploads whose type is not an allowed audio or image format', async () => {
    const { request } = await setup();
    const form = new FormData();
    form.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
    const res = await request('/api/conversations/6281234500001/messages', { method: 'POST', body: form });
    expect(res.status).toBe(415);
  });

  it('stores an uploaded photo in the database and serves it to signed-in users', async () => {
    const { request, json } = await setup([{ say: 'Fotonya sudah kami terima ya Bu.' }]);
    const form = new FormData();
    form.append('file', new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'nota.jpg');
    form.append('text', 'ini notanya');
    expect((await request(`/api/conversations/${BU_SARI}/messages`, { method: 'POST', body: form })).status).toBe(200);
    const [inbound] = (await json(`/api/conversations/${BU_SARI}/messages`)).body.messages;
    expect(inbound).toMatchObject({ kind: 'image', text: 'ini notanya', mediaUrl: expect.stringMatching(/^\/media\/[\w-]+\.jpg$/) });
    expect(inbound.mediaId).toBeUndefined();
    const file = await request(inbound.mediaUrl, {}, 'tamu');
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('hides the WhatsApp webhook when WhatsApp is not configured', async () => {
    const { app } = await setup();
    expect((await app.request('/webhooks/openwa', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});

describe('WhatsApp webhook', () => {
  it('answers a redelivery normally when the first delivery could not store its photo', async () => {
    const secret = 'rahasia-webhook';
    const work: Promise<unknown>[] = [];
    // Port 9 refuses connections at once, so the reply to WhatsApp fails fast and is only logged.
    const channels = new ChannelRouter({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', sessionId: 's', webhookSecret: secret });
    const { app, db } = await setup([{ say: 'Fotonya sudah kami terima, Bu.' }], { channels, background: (w) => void work.push(w) });
    const body = JSON.stringify({ event: 'message.received', data: { id: 'wamid-1', from: `${BU_SARI}@c.us`, type: 'image', caption: 'nota', media: { data: 'AAA=', mimetype: 'image/jpeg' } } });
    const deliver = () => app.request('/webhooks/openwa', { method: 'POST', headers: { 'x-openwa-signature': createHmac('sha256', secret).update(body).digest('hex') }, body });

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => void vi.restoreAllMocks());
    await db.execute(sql`alter table media rename to media_gone`);
    expect((await deliver()).status).toBe(500);
    expect(await db.select().from(rateLimits).where(eq(rateLimits.key, 'webhook-id:wamid-1'))).toEqual([]);
    await db.execute(sql`alter table media_gone rename to media`);

    expect(await (await deliver()).json()).toEqual({ accepted: true });
    await Promise.all(work);
    expect(await (await deliver()).json()).toEqual({ duplicate: true });
    expect(await db.select().from(messages).where(and(eq(messages.waId, BU_SARI), eq(messages.text, 'nota')))).toEqual([expect.objectContaining({ kind: 'image', channel: 'whatsapp' })]);
  });
});

describe('ChannelRouter', () => {
  it('rejects every webhook when no secret is configured', () => {
    const router = new ChannelRouter({ baseUrl: 'http://x', apiKey: 'k', sessionId: 's', webhookSecret: '' });
    expect(router.verifySignature('{}', 'anything')).toBe(false);
  });
});

describe('idle demo reset', () => {
  it('resets only after the demo was used and then left idle', async () => {
    const { post, db } = await setup([{ say: 'Halo' }]);
    const bus = new EventBus();
    const at = (min: number) => new Date(T0.getTime() + min * 60_000);
    expect(await resetDemo(db, bus, at(120), 60)).toBe(false); // untouched seed data
    await post('/api/conversations/6281234500001/messages', { text: 'halo' });
    expect(await resetDemo(db, bus, at(10), 60)).toBe(false); // still in use
    expect(await resetDemo(db, bus, at(120), 60)).toBe(true);
    expect(await resetDemo(db, bus, at(240), 60)).toBe(false); // nothing to reset again
    // Accounts survive a reset; the demo data is back.
    expect((await db.select().from(customers)).length).toBe(8);
    expect((await post('/api/conversations/6281234500001/messages', { text: 'halo lagi' }, 'tamu')).status).not.toBe(401);
  });

  it('lets two resets at once seed the demo only once', async () => {
    const { db } = await setup();
    const bus = new EventBus();
    await Promise.all([resetDemo(db, bus, T0), resetDemo(db, bus, T0)]);
    expect((await db.select().from(customers)).length).toBe(8);
  });
});

/** Reads Server-Sent Events from a fetch-style response. */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    reader,
    async next(timeoutMs = 3_000): Promise<{ event: string; data: any; id: string | null } | null> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const field = (name: string) => block.split('\n').find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? null;
          return { event: field('event') ?? 'message', data: JSON.parse(field('data') ?? 'null'), id: field('id') };
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('no SSE event in time');
        const chunk = await Promise.race([reader.read(), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), left))]);
        if (chunk === 'timeout') throw new Error('no SSE event in time');
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

describe('live events', () => {
  it('streams events written by one instance to a browser connected to another', async () => {
    const one = await setup([{ say: 'Halo Bu Sari.' }]);
    const two = await setup([], { db: one.db });
    const res = await two.request('/api/events', {}, 'tamu');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const sse = sseReader(res);
    const ready = (await sse.next())!;
    expect(ready).toMatchObject({ event: 'ready', data: { resumed: false } });

    await one.post(`/api/conversations/${BU_SARI}/messages`, { text: 'halo' }, 'tamu');
    const seen: any[] = [];
    // The run ends with the reply: a message event, then its audit entry.
    while (!seen.some((e) => e.data.type === 'audit' && e.data.entry.type === 'message_out')) seen.push((await sse.next())!);
    await sse.reader.cancel();

    expect(seen.every((e) => e.event === 'agent')).toBe(true);
    const ids = seen.map((e) => Number(e.id.split(',')[0]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBeGreaterThan(Number(ready.id!.split(',')[0]));
    const inbound = seen.find((e) => e.data.type === 'message' && e.data.message.direction === 'in')!;
    // Stored file ids never reach the browser; it gets URLs.
    expect(inbound.data.message).toMatchObject({ text: 'halo', mediaUrl: null });
    expect(inbound.data.message.mediaId).toBeUndefined();
    expect(seen.some((e) => e.data.type === 'message' && e.data.message.text === 'Halo Bu Sari.')).toBe(true);
    expect(seen.some((e) => e.data.type === 'run')).toBe(true);
  });

  it('resumes after the last event the browser saw, and ends the stream after sseMaxMs', async () => {
    const { request, bus, db } = await setup([], { sseMaxMs: 400 });
    for (const orderId of [1, 2, 3]) await bus.emit({ type: 'order', orderId });
    const rows = await db.select().from(events).orderBy(events.id);
    expect(rows).toHaveLength(3);

    const started = Date.now();
    const sse = sseReader(await request('/api/events', { headers: { 'last-event-id': String(rows[0]!.id) } }));
    expect(await sse.next()).toMatchObject({ event: 'ready', data: { resumed: true }, id: String(rows[0]!.id) });
    expect(await sse.next()).toMatchObject({ event: 'agent', data: { type: 'order', orderId: 2 }, id: String(rows[1]!.id) });
    expect(await sse.next()).toMatchObject({ event: 'agent', data: { type: 'order', orderId: 3 }, id: String(rows[2]!.id) });
    // The browser reconnects with Last-Event-ID; the server never holds a stream open for long.
    expect(await sse.next()).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('streams an event whose write commits after a later one, and resumes from ?lastEventId', async () => {
    const { request, bus, db } = await setup([], { sseMaxMs: 1_500 });
    const sse = sseReader(await request('/api/events'));
    expect((await sse.next())?.event).toBe('ready');

    // The id is taken but the row is not visible yet, as while its transaction is still open.
    const [late] = await db.insert(events).values({ payload: { type: 'order', orderId: 1 } }).returning();
    await db.delete(events).where(eq(events.id, late!.id));
    await bus.emit({ type: 'order', orderId: 2 });
    const second = (await sse.next())!;
    expect(second).toMatchObject({ data: { orderId: 2 } });
    expect(second.id).toBe(`${late!.id + 1},${late!.id}`);

    await db.insert(events).values({ id: late!.id, payload: { type: 'order', orderId: 1 } });
    const first = (await sse.next())!;
    expect(first).toMatchObject({ data: { orderId: 1 }, id: String(late!.id + 1) });
    await sse.reader.cancel();

    // A tab that was hidden opens a new EventSource, which cannot send Last-Event-ID itself.
    const resumed = sseReader(await request(`/api/events?lastEventId=${encodeURIComponent(second.id!)}`));
    expect(await resumed.next()).toMatchObject({ event: 'ready', data: { resumed: true } });
    expect(await resumed.next()).toMatchObject({ event: 'agent', data: { orderId: 1 } });
    await resumed.reader.cancel();
  });

  it('caps live streams per client and frees the slot when one disconnects', async () => {
    const { request } = await setup();
    const open = await Promise.all(Array.from({ length: 10 }, async () => sseReader(await request('/api/events'))));
    for (const s of open) expect((await s.next())?.event).toBe('ready');
    expect((await request('/api/events')).status).toBe(429);
    await open[0]!.reader.cancel();
    await new Promise((r) => setTimeout(r, 150));
    const again = await request('/api/events');
    expect(again.status).toBe(200);
    await again.body!.cancel();
    await Promise.all(open.slice(1).map((s) => s.reader.cancel()));
  });

  it('refuses a new message with 503 when every run slot and the wait list are full', async () => {
    const { post } = await setup();
    const { ServiceBusyError } = await import('@salura/agent');
    const spy = vi.spyOn(SaluraService.prototype, 'handleInbound').mockRejectedValueOnce(new ServiceBusyError());
    const res = await post('/api/conversations/6281234500001/messages', { text: 'halo' });
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('busy');
  });
});

describe('scheduled jobs', () => {
  it('runs cron jobs only with the shared secret', async () => {
    const { app } = await setup([{ say: 'Tidak ada warung yang perlu ditawari hari ini.' }], { cronSecret: 'cron-s3cret', maintenance: true });
    const cron = (job: string, auth?: string) => app.request(`/api/cron/${job}`, { headers: auth ? { authorization: auth } : {} });
    expect((await cron('maintenance')).status).toBe(401);
    expect((await cron('maintenance', 'Bearer wrong')).status).toBe(401);
    expect((await cron('maintenance', 'cron-s3cret')).status).toBe(401);

    const maintenance = await cron('maintenance', 'Bearer cron-s3cret');
    expect(maintenance.status).toBe(200);
    expect(await maintenance.json()).toEqual({ maintenance: { recovered: 0, reset: false } });

    const proactive = await cron('proactive', 'Bearer cron-s3cret');
    expect(await proactive.json()).toMatchObject({ job: 'proactive', status: 'completed' });
    expect((await cron('unknown', 'Bearer cron-s3cret')).status).toBe(400);
  });

  it('fails closed when no cron secret is configured', async () => {
    const { app } = await setup();
    expect((await app.request('/api/cron/maintenance', { headers: { authorization: 'Bearer ' } })).status).toBe(401);
    expect((await app.request('/api/cron/maintenance', { headers: { authorization: 'Bearer undefined' } })).status).toBe(401);
  });
});

describe('operations screens', () => {
  it('lists reported payments', async () => {
    const { db, json, clock } = await setup();
    const rasyid = (await first(db.select().from(customers).where(eq(customers.waId, PAK_RASYID))))!;
    await recordPaymentClaim(db, { customerId: rasyid.id, amount: 500_000, now: clock() });
    const res = await json('/api/payments', undefined, 'tamu');
    expect(res.body.payments).toEqual([expect.objectContaining({ amount: 500_000, status: 'pending', customer: expect.objectContaining({ waId: PAK_RASYID }) })]);
    // A pending claim is not an overpayment yet; neither is anything in the seed.
    expect((await json('/api/collections/overpaid', undefined, 'tamu')).body).toEqual({ overpayments: [] });
  });

  it('lets an admin mark an overpayment as refunded or offset', async () => {
    const { db, json, post } = await setup();
    const [inv] = await db.update(invoices).set({ paidAmount: 800_000, status: 'paid' }).where(eq(invoices.number, 'INV-00007')).returning();
    const listed = await json('/api/collections/overpaid', undefined, 'tamu');
    expect(listed.body.overpayments).toEqual([expect.objectContaining({ source: 'invoice_correction', id: inv!.id, amount: 800_000 - inv!.amount })]);
    expect((await post(`/api/collections/overpaid/invoice_correction/${inv!.id}/settle`, {}, 'tamu')).status).toBe(403);
    const settled = await post(`/api/collections/overpaid/invoice_correction/${inv!.id}/settle`, {});
    expect(settled).toMatchObject({ status: 200, body: { overpayments: [] } });
    expect((await post(`/api/collections/overpaid/invoice_correction/${inv!.id}/settle`, {})).status).toBe(409);
  });

  it('shows the picking list and lets an admin mark orders as loaded', async () => {
    const { db, json, post, clock } = await setup();
    const sari = (await first(db.select().from(customers).where(eq(customers.waId, BU_SARI))))!;
    const aqua = (await first(db.select().from(products).where(eq(products.sku, 'AQA-600'))))!;
    const now = clock().toISOString();
    const [order] = await db
      .insert(orders)
      .values({ customerId: sari.id, status: 'confirmed', channel: 'web', subtotal: 81_600, createdAt: now, updatedAt: now, confirmedAt: now })
      .returning();
    await db.insert(orderItems).values({ orderId: order!.id, productId: aqua.id, qty: 1, unit: 'dus', unitPrice: 81_600, lineTotal: 81_600 });

    const picking = await json('/api/warehouse/picking', undefined, 'tamu');
    expect(picking.body.batches).toEqual([expect.objectContaining({ date: '2026-10-23', area: 'Bekasi Timur', orders: [expect.objectContaining({ orderId: order!.id })] })]);

    expect((await post('/api/warehouse/ship', { orderIds: [order!.id] }, 'tamu')).status).toBe(403);
    expect((await post('/api/warehouse/ship', { orderIds: [] })).status).toBe(400);
    expect((await post('/api/warehouse/ship', { orderIds: [order!.id] })).body).toEqual({ shipped: [order!.id] });
    expect((await post('/api/warehouse/ship', { orderIds: [order!.id] })).body).toEqual({ shipped: [] });
    expect((await json('/api/warehouse/picking')).body.batches).toEqual([]);
    expect((await json(`/api/orders/${order!.id}`)).body.order.shippedAt).not.toBeNull();
  });

  it('keeps orders, runs and payments from a guest test chat out of every real view, and marks them where they are listed', async () => {
    const { db, json, clock } = await setup();
    const sari = (await first(db.select().from(customers).where(eq(customers.waId, BU_SARI))))!;
    const aqua = (await first(db.select().from(products).where(eq(products.sku, 'AQA-600'))))!;
    const before = (await json('/api/dashboard')).body;
    const profileBefore = (await json(`/api/conversations/${BU_SARI}/profile`)).body;
    // What a guest chat leaves behind once the owner approved its order (on paper only) and its run ended.
    const now = clock().toISOString();
    const [order] = await db
      .insert(orders)
      .values({ customerId: sari.id, status: 'confirmed', channel: 'web', subtotal: 81_600, guest: true, createdAt: now, updatedAt: now, confirmedAt: now })
      .returning();
    await db.insert(orderItems).values({ orderId: order!.id, productId: aqua.id, qty: 1, unit: 'dus', unitPrice: 81_600, lineTotal: 81_600 });
    await db.insert(agentRuns).values({ id: 'guest-run', trigger: 'message', goal: 'g', waId: BU_SARI, status: 'completed', guest: true, costUsd: 0.5, startedAt: now, endedAt: now });
    await db.insert(auditLog).values({ runId: 'guest-run', actor: 'system', type: 'validation', summary: 'ditolak' });
    await recordPaymentClaim(db, { customerId: sari.id, amount: 100_000, now: clock(), guest: true });

    const after = (await json('/api/dashboard')).body;
    expect(after.metrics).toEqual(before.metrics);
    expect(after.recentOrders.map((o: any) => o.orderId)).not.toContain(order!.id);
    expect((await json('/api/warehouse/picking')).body.batches).toEqual([]);
    expect((await json(`/api/conversations/${BU_SARI}/profile`)).body.lastOrderAt).toBe(profileBefore.lastOrderAt);
    // Listed where people look for them, marked as a test.
    expect((await json('/api/orders')).body.orders.find((o: any) => o.orderId === order!.id)).toMatchObject({ status: 'confirmed', guest: true });
    expect((await json(`/api/orders/${order!.id}`)).body.order.guest).toBe(true);
    expect((await json('/api/payments')).body.payments).toEqual([expect.objectContaining({ amount: 100_000, guest: true })]);
  });

  it('reads the latest evaluation report from the database', async () => {
    const { db, json } = await setup();
    expect((await json('/api/eval/latest')).body).toEqual({ report: null });
    const report = { ranAt: '2026-10-20T00:00:00.000Z', model: 'm', summary: { cases: 30, itemAccuracy: 0.93, passK: 0.8, k: 3 } };
    await db.insert(evalReports).values({ ranAt: report.ranAt, report });
    expect((await json('/api/eval/latest')).body).toEqual({ report });
    expect((await json('/api/dashboard')).body.evaluation).toEqual({ ranAt: report.ranAt, cases: 30, accuracy: 0.93, passK: 0.8, k: 3 });
  });

  /** Orders in every listed state, with approvals of several kinds (one pointing at a missing order). */
  async function listingFixture(db: Db) {
    const byWa = async (waId: string) => (await first(db.select().from(customers).where(eq(customers.waId, waId))))!;
    const [sari, makmur, rasyid] = [await byWa(BU_SARI), await byWa(MAKMUR_JAYA), await byWa(PAK_RASYID)];
    const packed = (await first(db.select().from(productUnits).where(gt(productUnits.factor, 1))))!;
    const loose = (await first(db.select().from(products).where(ne(products.id, packed.productId))))!;
    const day = (d: number) => new Date(T0.getTime() - d * 86_400_000).toISOString();
    const order = async (customerId: number, status: OrderStatus, extra: Partial<typeof orders.$inferInsert> = {}) => {
      const [o] = await db.insert(orders).values({ customerId, status, channel: 'web', subtotal: 50_000, createdAt: day(1), updatedAt: day(1), ...extra }).returning();
      await db.insert(orderItems).values([
        { orderId: o!.id, productId: packed.productId, qty: 2, unit: packed.unit, unitPrice: 20_000, lineTotal: 40_000, rawText: 'dua' },
        { orderId: o!.id, productId: loose.id, qty: 5, unit: loose.baseUnit, unitPrice: 2_000, lineTotal: 10_000 },
        { orderId: o!.id, productId: packed.productId, qty: 3, unit: packed.unit, unitPrice: 0, lineTotal: 0 },
      ]);
      return o!;
    };
    const straight = await order(sari.id, 'confirmed', { createdAt: day(0) });
    const edited = await order(makmur.id, 'confirmed', { humanEdited: true, createdAt: day(2) });
    const held = await order(makmur.id, 'awaiting_approval');
    const refused = await order(rasyid.id, 'rejected', { createdAt: day(9) });
    await order(sari.id, 'draft');
    await order(sari.id, 'confirmed', { historic: true });
    await db.insert(approvals).values([
      { type: 'order', orderId: held.id, customerId: makmur.id, reason: 'besar', requestedAt: day(1) },
      { type: 'credit_override', status: 'rejected', orderId: refused.id, customerId: rasyid.id, reason: 'kredit', requestedAt: day(3) },
      { type: 'reminder', customerId: rasyid.id, reason: 'tagihan', requestedAt: day(2) },
      { type: 'order', orderId: 999_999, customerId: sari.id, reason: 'hilang', requestedAt: day(4) },
    ]);
    return { straight, edited, held, refused };
  }

  it('lists orders and approvals with their lines, stock and credit (batched, same shapes as per-row reads)', async () => {
    const { db, json, clock } = await setup();
    await listingFixture(db);

    const list = (await json('/api/orders')).body.orders;
    const rows = await db.select().from(orders).where(eq(orders.historic, false)).orderBy(desc(orders.id));
    expect(list.map((o: any) => o.orderId)).toEqual(rows.map((r) => r.id));
    for (const [i, row] of rows.entries()) {
      const c = (await first(db.select().from(customers).where(eq(customers.id, row.customerId))))!;
      expect(list[i]).toEqual({ ...(await getOrder(db, row.id)), customer: { name: c.name, waId: c.waId }, channel: row.channel, createdAt: row.createdAt, updatedAt: row.updatedAt, shippedAt: row.shippedAt });
    }
    expect((await json('/api/orders?status=awaiting_approval,rejected')).body.orders.map((o: any) => o.status)).toEqual(['rejected', 'awaiting_approval']);

    const now = clock();
    const all = (await json('/api/approvals?status=all')).body.approvals;
    expect(all.map((a: any) => a.reason)).toEqual(['besar', 'tagihan', 'kredit', 'hilang']);
    for (const a of all) {
      const order = a.orderId ? ((await getOrder(db, a.orderId)) ?? null) : null;
      const c = (await first(db.select().from(customers).where(eq(customers.id, a.customerId))))!;
      expect(a.order).toEqual(order);
      expect(a.customer).toEqual({ id: c.id, name: c.name, waId: c.waId, tier: c.tier });
      expect(a.stock).toEqual(a.status === 'pending' && order && (a.type === 'order' || a.type === 'credit_override') ? await lineAvailability(db, order) : null);
      expect(a.credit).toEqual(await creditStatus(db, c.id, now));
    }
    expect(all[0].stock).toHaveLength(3);
    expect(all[3].order).toBeNull();
    expect((await json('/api/approvals')).body.approvals.map((a: any) => a.reason)).toEqual(['hilang', 'tagihan', 'besar']);
  });

  it('lists conversations with the newest message of each, as the per-customer reads did', async () => {
    const { db, json } = await setup();
    const at = (s: number) => new Date(T0.getTime() + s * 1000).toISOString();
    await db.insert(messages).values([
      { waId: BU_SARI, direction: 'in', channel: 'web', kind: 'text', text: 'halo', createdAt: at(1) },
      { waId: BU_SARI, direction: 'out', channel: 'web', kind: 'text', text: 'Halo Bu Sari', createdAt: at(2) },
      { waId: MAKMUR_JAYA, direction: 'in', channel: 'web', kind: 'voice', transcript: 'beras dua karung', createdAt: at(5) },
      { waId: PAK_RASYID, direction: 'in', channel: 'web', kind: 'text', text: 'cek', createdAt: at(3) },
      { waId: PAK_RASYID, direction: 'in', channel: 'web', kind: 'image', createdAt: at(4) },
      { waId: '6280000000000', direction: 'in', channel: 'web', kind: 'text', text: 'nomor lain', createdAt: at(9) },
    ]);

    const list = (await json('/api/conversations', undefined, 'tamu')).body.conversations;
    const expected = [];
    for (const cust of await db.select().from(customers).orderBy(customers.id)) {
      const last = await first(db.select().from(messages).where(eq(messages.waId, cust.waId)).orderBy(desc(messages.id)).limit(1));
      expected.push({
        waId: cust.waId,
        customerId: cust.id,
        name: cust.name,
        ownerName: cust.ownerName,
        honorific: cust.honorific,
        area: cust.area,
        tier: cust.tier,
        lastMessage: last ? { text: last.text ?? last.transcript ?? `[${last.kind}]`, direction: last.direction, at: last.createdAt, kind: last.kind } : null,
      });
    }
    expected.sort((a, b) => (b.lastMessage?.at ?? '').localeCompare(a.lastMessage?.at ?? ''));
    expect(list).toEqual(expected);
    expect(list.slice(0, 3).map((c: any) => [c.waId, c.lastMessage.text])).toEqual([
      [MAKMUR_JAYA, 'beras dua karung'],
      [PAK_RASYID, '[image]'],
      [BU_SARI, 'Halo Bu Sari'],
    ]);
    expect(list.slice(3).every((c: any) => c.lastMessage === null)).toBe(true);
  });

  it('computes the dashboard from orders, audit entries and runs', async () => {
    const { db, json } = await setup();
    const before = (await json('/api/dashboard')).body.metrics;
    const { straight } = await listingFixture(db);
    await db.insert(auditLog).values([
      { actor: 'agent', type: 'tool_result', tool: 'draft_order', summary: 's', data: { issues: [{ type: 'out_of_stock' }, { type: 'over_credit' }, { type: 'low_confidence' }, { type: 'out_of_stock' }] } },
      { actor: 'agent', type: 'tool_result', tool: 'draft_order', summary: 's', data: null },
      { actor: 'agent', type: 'tool_result', tool: 'draft_order', summary: 's', data: { order: {} } },
      { actor: 'agent', type: 'tool_result', tool: 'search_catalog', summary: 's', data: { results: [{ ambiguous: true }, { ambiguous: false }, { ambiguous: true }, {}] } },
      { actor: 'agent', type: 'tool_result', tool: 'search_catalog', summary: 's', data: {} },
      { actor: 'agent', type: 'tool_result', tool: 'get_customer_profile', summary: 's', data: { issues: [{ type: 'out_of_stock' }] } },
      { actor: 'agent', type: 'tool_call', tool: 'draft_order', summary: 's', data: { issues: [{ type: 'over_credit' }] } },
      { actor: 'system', type: 'validation', summary: 's' },
      { actor: 'system', type: 'validation', summary: 's' },
    ]);
    const run = (id: string, extra: Partial<typeof agentRuns.$inferInsert>) =>
      ({ id, trigger: 'message', goal: 'g', status: 'completed', startedAt: '2026-10-20T01:00:00.000Z', ...extra }) as typeof agentRuns.$inferInsert;
    await db.insert(agentRuns).values([
      run('r1', { costUsd: 0.012, endedAt: '2026-10-20T01:00:04.500Z' }),
      run('r2', { costUsd: null, endedAt: '2026-10-20T01:00:01.500Z' }),
      run('r3', { costUsd: 0.003, endedAt: '2026-10-20T01:00:03.000Z' }),
      run('r4', { status: 'running', costUsd: 0.5 }),
      run('r5', { trigger: 'schedule', costUsd: 0.5, endedAt: '2026-10-20T01:00:50.000Z' }),
    ]);

    const m = (await json('/api/dashboard')).body.metrics;
    const handled = before.ordersHandled + 4;
    expect(m.ordersHandled).toBe(handled);
    expect(m.straightThrough).toBe(before.straightThrough + 1);
    expect(m.straightThroughRate).toBeCloseTo((before.straightThrough + 1) / handled);
    expect(m.pendingApprovals).toBe(before.pendingApprovals + 3);
    expect(m.minutesSaved).toBe(before.minutesSaved + 2 * 6);
    expect(m.errorsCaught).toEqual({
      total: before.errorsCaught.total + 7,
      outOfStock: before.errorsCaught.outOfStock + 2,
      overCredit: before.errorsCaught.overCredit + 1,
      ambiguous: before.errorsCaught.ambiguous + 2,
      blockedActions: before.errorsCaught.blockedActions + 2,
    });
    expect(before.costPerOrderUsd).toBeNull();
    expect(m.costPerOrderUsd).toBeCloseTo(0.015 / handled);
    expect(m.avgRunSeconds).toBeCloseTo(3);
    const perDay = (date: string) => m.ordersPerDay.find((d: any) => d.date === date)?.count - before.ordersPerDay.find((d: any) => d.date === date)?.count;
    expect(m.ordersPerDay.map((d: any) => d.date)).toEqual(before.ordersPerDay.map((d: any) => d.date));
    // The historic confirmed order counts per day too (it was created yesterday); the draft does not.
    expect([perDay(straight.createdAt.slice(0, 10)), perDay('2026-10-20'), perDay('2026-10-19')]).toEqual([1, 2, 1]);
  });
});

describe('spreadsheet import routes', () => {
  it('previews and applies a CSV, admin only, and serves the template', async () => {
    const { post, request } = await setup();
    const template = await request('/api/import/stok/template', {}, 'tamu');
    expect(template.headers.get('content-type')).toMatch(/text\/csv/);
    expect((await template.text()).split('\r\n')[0]).toBe('sku,stok');

    const csv = 'sku;stok\nAQA-600;999\n';
    const preview = await post('/api/import/stok/preview', { csv });
    expect(preview.body.preview).toMatchObject({ dataset: 'stok', rows: 1, updates: 1, errors: [] });

    const bad = await post('/api/import/stok/apply', { csv: 'sku,stok\nAQA-600,999\nNOPE-1,5\n' });
    expect(bad.status).toBe(400);
    expect(bad.body.preview.errors).toEqual([{ row: 3, message: expect.stringContaining('NOPE-1') }]);

    const ok = await post('/api/import/stok/apply', { csv });
    expect(ok.status).toBe(200);
    const stok = (await (await request('/api/import/stok/template')).text()).split('\r\n');
    expect(stok).toContain('AQA-600,999');

    const form = new FormData();
    form.append('file', new Blob(['sku,stok\nAQA-600,1000\n'], { type: 'text/csv' }), 'stok.csv');
    const viaFile = await request('/api/import/stok/preview', { method: 'POST', body: form });
    expect(((await viaFile.json()) as any).preview).toMatchObject({ rows: 1, errors: [] });

    expect((await post('/api/import/gudang/preview', { csv })).status).toBe(400);
    expect((await post('/api/import/stok/preview', {})).body.error.code).toBe('import_invalid');
    expect((await post('/api/import/stok/preview', { sheetUrl: 'https://example.com/sheet' })).body.error.code).toBe('import_invalid');
  });
});
