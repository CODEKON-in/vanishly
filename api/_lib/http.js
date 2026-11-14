export const MAX_BODY_BYTES = 2 * 1024 * 1024; // hard stop well under Vercel's 4.5 MB request limit

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (body === null || body === undefined) {
    res.end();
    return;
  }
  if (Buffer.isBuffer(body)) {
    res.end(body);
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function ok(res, body = { ok: true }) {
  send(res, 200, body);
}

export function fail(res, status, code, message) {
  send(res, status, { error: code, message: message || code });
}

export function methodGuard(req, res, ...allowed) {
  if (allowed.includes(req.method)) return true;
  send(res, 405, { error: 'method_not_allowed' }, { Allow: allowed.join(', ') });
  return false;
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

export function query(req) {
  // Vercel populates req.query, but keep a fallback for plain node / vercel dev edge cases.
  if (req.query && typeof req.query === 'object') return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

/** Read the raw request body with a hard byte cap. Throws { tooLarge: true } past the cap. */
export async function readRawBody(req, limit = MAX_BODY_BYTES) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > limit) throw Object.assign(new Error('too_large'), { tooLarge: true });
    return req.body;
  }
  if (typeof req.body === 'string') {
    const asBuf = Buffer.from(req.body, 'binary');
    if (asBuf.length > limit) throw Object.assign(new Error('too_large'), { tooLarge: true });
    return asBuf;
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > limit) {
    throw Object.assign(new Error('too_large'), { tooLarge: true });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      req.destroy();
      throw Object.assign(new Error('too_large'), { tooLarge: true });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 64 * 1024) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRawBody(req, limit);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('bad_json'), { badJson: true });
  }
}

/** JPEG magic bytes: FF D8 FF ... and FF D9 at the end (tolerating trailing padding). */
export function looksLikeJpeg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 125) return false;
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return false;
  const tail = buf.subarray(Math.max(0, buf.length - 32));
  return tail.includes(Buffer.from([0xff, 0xd9]));
}

export function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err?.tooLarge) return fail(res, 413, 'too_large', 'Request body is too large.');
      if (err?.badJson) return fail(res, 400, 'bad_request', 'Malformed JSON body.');
      // Never log tokens, passwords or file bytes — message only.
      console.error('[vanishly] handler error:', err?.message || 'unknown');
      if (!res.writableEnded) fail(res, 500, 'server_error', 'Something went wrong.');
    }
  };
}
