import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { waitUntil } from '@vercel/functions';
import { createApp } from './app.ts';
import { bootstrap } from './bootstrap.ts';

// Vercel Function entry (see scripts/build-vercel.mjs). One instance serves many requests
// (Fluid compute), so the database pool and the app are created once, on the first request.

let listener: Promise<ReturnType<typeof getRequestListener>> | null = null;

function init() {
  listener ??= bootstrap(process.env, { serverless: true })
    .then(({ deps }) => getRequestListener(createApp({ ...deps, background: waitUntil }).fetch))
    .catch((err) => {
      listener = null; // try again on the next request instead of staying broken
      throw err;
    });
  return listener;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // Routes rewrite every API path to this function with the original path in ?__p (see the build).
  const url = new URL(req.url ?? '/', 'http://localhost');
  const original = url.searchParams.get('__p');
  if (original !== null) {
    url.searchParams.delete('__p');
    req.url = `/${original.replace(/^\/+/, '')}${url.search}`;
  }
  try {
    const listen = await init();
    await listen(req, res);
  } catch (err) {
    console.error('SALURA failed to start', err);
    if (!res.headersSent) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'starting', message: 'Server belum siap. Coba lagi sebentar lagi.' } }));
    }
  }
}
