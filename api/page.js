import { wrap, methodGuard, fail, send, query, clientIp } from './_lib/http.js';
import { isValidId, verifySession } from './_lib/crypto.js';
import { loadLive } from './_lib/doc.js';
import { rateLimit } from './_lib/ratelimit.js';
import { LIMITS } from './_lib/limits.js';

/**
 * Streams one page image after checking the signed session token AND the
 * document's own deadline on every single request.
 */
export default wrap(async (req, res) => {
  if (!methodGuard(req, res, 'GET')) return;

  const q = query(req);
  const id = q.id;
  const n = Number(q.n);
  const token = q.t;

  if (!isValidId(id)) return fail(res, 410, 'gone', 'This link has expired.');
  if (!Number.isInteger(n) || n < 0 || n >= LIMITS.MAX_PAGES) {
    return fail(res, 400, 'bad_request', 'Invalid page index.');
  }

  const limit = await rateLimit('page', clientIp(req), 600, 600);
  if (!limit.allowed) return fail(res, 429, 'rate_limited', 'Too many requests.');

  const session = verifySession(token, id);
  if (!session) return fail(res, 403, 'expired_token', 'This view session has ended.');

  const { state, doc } = await loadLive(id);
  if (state !== 'live' || doc.status !== 'open') {
    return fail(res, 410, 'gone', 'This link has expired.');
  }
  if (n >= doc.pages) return fail(res, 404, 'not_found', 'No such page.');

  const url = doc.blobUrls[n];
  if (!url) return fail(res, 404, 'not_found', 'No such page.');

  const upstream = await fetch(url, { cache: 'no-store' });
  if (!upstream.ok) {
    return fail(res, 410, 'gone', 'This page is no longer available.');
  }
  const bytes = Buffer.from(await upstream.arrayBuffer());

  send(res, 200, bytes, {
    'Content-Type': 'image/jpeg',
    'Content-Length': String(bytes.length),
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
  });
});
