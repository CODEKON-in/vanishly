/**
 * Local mock server: serves /public and routes /api/* to the real handlers,
 * backed by in-memory stand-ins for Upstash Redis and Vercel Blob.
 *
 * Run with:  npm run dev:mock     then open http://localhost:3000
 *
 * Use this to click through the whole flow with no accounts and no cloud
 * services. State lives in memory, so restarting clears every link.
 * For the real thing, use `vercel dev`.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SECRET ||= 'local-mock-secret-value-not-for-production';
process.env.KV_REST_API_URL ||= 'https://redis.mock';
process.env.KV_REST_API_TOKEN ||= 'mock';
process.env.BLOB_READ_WRITE_TOKEN ||= 'mock';
process.env.CRON_SECRET ||= 'mock-cron-secret';
process.env.RAZORPAY_WEBHOOK_SECRET ||= 'mock-razorpay-webhook-secret';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pub = join(root, 'public');
const PORT = Number(process.env.PORT || 3000);

const { store: blobStore } = await import('./stub-blob.mjs');

const authHandler = (await import('../../api/auth.js')).default;
const billingHandler = (await import('../../api/billing.js')).default;

const routes = {
  '/api/create': (await import('../../api/create.js')).default,
  '/api/upload-page': (await import('../../api/upload-page.js')).default,
  '/api/finalize': (await import('../../api/finalize.js')).default,
  '/api/meta': (await import('../../api/meta.js')).default,
  '/api/open': (await import('../../api/open.js')).default,
  '/api/page': (await import('../../api/page.js')).default,
  '/api/expire': (await import('../../api/expire.js')).default,
  '/api/delete': (await import('../../api/delete.js')).default,
  '/api/cleanup': (await import('../../api/cleanup.js')).default,
  '/api/auth': authHandler,
  '/api/auth/request-code': authHandler,
  '/api/auth/verify': authHandler,
  '/api/auth/logout': authHandler,
  '/api/auth/me': authHandler,
  '/api/billing': billingHandler,
  '/api/billing/checkout': billingHandler,
  '/api/billing/webhook': billingHandler,
  '/api/billing/cancel': billingHandler,
};

// /api/page fetches blob URLs server-side; serve them from the in-memory store.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const rec = blobStore.get(String(url));
  if (rec) {
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return rec.buf.buffer.slice(rec.buf.byteOffset, rec.buf.byteOffset + rec.buf.length);
      },
    };
  }
  return realFetch(url, init);
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

// Same security headers vercel.json applies in production.
const CSP = "default-src 'self'; script-src 'self'; worker-src 'self' blob:; "
  + "style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; "
  + "media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; "
  + "form-action 'none'; frame-ancestors 'none'";

function secure(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
}

async function serveFile(res, path, status = 200) {
  const body = await readFile(path);
  res.statusCode = status;
  secure(res);
  res.setHeader('Content-Type', MIME[extname(path)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path.startsWith('/api/')) {
      const handler = routes[path];
      if (!handler) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'not_found' }));
      }
      req.query = Object.fromEntries(url.searchParams.entries());
      secure(res);
      return await handler(req, res);
    }

    // /v/:id -> viewer.html (the rewrite vercel.json performs in production)
    if (/^\/v\/[^/]+$/.test(path)) return await serveFile(res, join(pub, 'viewer.html'));

    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
    const target = join(pub, rel);
    if (!target.startsWith(pub)) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }

    try {
      const info = await stat(target);
      if (info.isDirectory()) return await serveFile(res, join(target, 'index.html'));
      return await serveFile(res, target);
    } catch {
      if (!extname(target)) {
        try {
          await stat(`${target}.html`);
          return await serveFile(res, `${target}.html`);
        } catch { /* fall through */ }
      }
      return await serveFile(res, join(pub, '404.html'), 404);
    }
  } catch (err) {
    console.error('[devserver]', err?.message || err);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end('Server error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n  Vanishly mock server  ->  http://localhost:${PORT}`);
  console.log('  In-memory Redis + Blob. State is lost on restart.');
  console.log('  Cron:  curl -H "Authorization: Bearer mock-cron-secret" http://localhost:' + PORT + '/api/cleanup\n');
});
