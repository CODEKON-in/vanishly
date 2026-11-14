import { wrap, methodGuard, readJson, fail, send, clientIp } from './_lib/http.js';
import { getRedis, K } from './_lib/redis.js';
import { randomId, randomToken, sha256, hashPassword, isValidId } from './_lib/crypto.js';
import { writeDoc } from './_lib/doc.js';
import { rateLimit } from './_lib/ratelimit.js';
import { LIMITS } from './_lib/limits.js';

function pickChoice(value, choices, fallback) {
  const n = Number(value);
  return choices.includes(n) ? n : fallback;
}

export default wrap(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;

  const ip = clientIp(req);
  const limit = await rateLimit('create', ip, 20, 3600);
  if (!limit.allowed) {
    return fail(res, 429, 'rate_limited', 'Too many uploads from this network. Try again later.');
  }

  const body = await readJson(req);

  const pages = Number(body.pages);
  if (!Number.isInteger(pages) || pages < 1) {
    return fail(res, 400, 'bad_request', 'Page count is missing or invalid.');
  }
  if (pages > LIMITS.MAX_PAGES) {
    return fail(res, 400, 'too_many_pages', `This document has ${pages} pages. The limit is ${LIMITS.MAX_PAGES}.`);
  }

  const expirySeconds = pickChoice(body.expirySeconds, LIMITS.EXPIRY_CHOICES, LIMITS.DEFAULT_EXPIRY);
  const lifetimeSeconds = pickChoice(body.maxLifetimeSeconds, LIMITS.LIFETIME_CHOICES, LIMITS.DEFAULT_LIFETIME);
  const maxOpens = pickChoice(body.maxOpens, LIMITS.MAX_OPENS_CHOICES, LIMITS.DEFAULT_MAX_OPENS);

  let watermark = '';
  if (typeof body.watermark === 'string' && body.watermark.trim()) {
    watermark = body.watermark.trim().slice(0, LIMITS.MAX_WATERMARK_CHARS);
  }

  let passwordHash = null;
  let salt = null;
  if (body.password !== undefined && body.password !== null && body.password !== '') {
    const pw = String(body.password);
    if (pw.length < LIMITS.MIN_PASSWORD_CHARS || pw.length > LIMITS.MAX_PASSWORD_CHARS) {
      return fail(res, 400, 'bad_password', `Password must be ${LIMITS.MIN_PASSWORD_CHARS}-${LIMITS.MAX_PASSWORD_CHARS} characters.`);
    }
    const hashed = await hashPassword(pw);
    passwordHash = hashed.hash;
    salt = hashed.salt;
  }

  const now = Date.now();
  const id = randomId(9);
  if (!isValidId(id)) return fail(res, 500, 'server_error', 'Could not mint an id.');

  const uploadToken = randomToken(32);
  const ownerToken = randomToken(32);
  const maxLifetimeAt = now + lifetimeSeconds * 1000;

  const doc = {
    v: 1,
    id,
    status: 'uploading',
    createdAt: now,
    maxLifetimeAt,
    expirySeconds,
    openedAt: null,
    expiresAt: null,
    pages,
    uploaded: 0,
    totalBytes: 0,
    blobUrls: [],
    watermark,
    maxOpens,
    opens: 0,
    passwordHash,
    salt,
    uploadTokenHash: sha256(uploadToken),
    ownerTokenHash: sha256(ownerToken),
  };

  await writeDoc(id, doc, lifetimeSeconds);
  await getRedis().zadd(K.index, { score: maxLifetimeAt, member: id });

  send(res, 201, {
    id,
    uploadToken,
    ownerToken,
    pages,
    expirySeconds,
    maxLifetimeAt,
    maxOpens,
    passwordRequired: Boolean(passwordHash),
    limits: {
      maxPageBytes: LIMITS.MAX_PAGE_BYTES,
      maxTotalBytes: LIMITS.MAX_TOTAL_BYTES,
      maxPages: LIMITS.MAX_PAGES,
    },
  });
});
