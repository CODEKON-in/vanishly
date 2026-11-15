import { wrap, methodGuard, readJson, fail, ok, clientIp } from './_lib/http.js';
import { getRedis, K } from './_lib/redis.js';
import { isValidId, verifyPassword, randomToken, signSession, sha256 } from './_lib/crypto.js';
import { loadLive, destroyDoc, writeDoc } from './_lib/doc.js';
import { rateLimit } from './_lib/ratelimit.js';
import { isBot } from './_lib/bots.js';
import { LIMITS } from './_lib/limits.js';
import { recordSecurityAlert } from './_lib/telemetry.js';

/**
 * Claiming the first open has to be atomic: two recipients tapping "Open" at
 * the same moment must not both get through a single-use link, and the expiry
 * deadline must be decided exactly once.
 *
 * `SET <claim> <deadline> NX EX <ttl>` is a single Redis command, so exactly
 * one request can win it. The winner writes the deadline into the document
 * record; everyone else reads the deadline back out of the claim key, which is
 * the authoritative value. The document record is only ever a cache of it.
 */
async function claimOpen(redis, id, doc, now) {
  const wanted = Math.min(now + doc.expirySeconds * 1000, doc.maxLifetimeAt);
  const ttl = Math.max(1, Math.ceil((wanted - now) / 1000));

  const claimed = await redis.set(K.openClaim(id), String(wanted), { nx: true, ex: ttl });

  if (claimed === 'OK' || claimed === true) {
    doc.openedAt = now;
    doc.status = 'open';
    doc.expiresAt = wanted;
    doc.opens = 1;
    await writeDoc(id, doc, ttl);
    return { first: true, expiresAt: wanted };
  }

  const existing = Number(await redis.get(K.openClaim(id)));
  if (!Number.isFinite(existing) || existing <= now) return { expired: true };
  return { first: false, expiresAt: existing };
}

export default wrap(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;

  // Link-preview fetchers must never consume a one-shot link.
  if (isBot(req)) return fail(res, 403, 'bot', 'Automated preview requests cannot open documents.');

  const ip = clientIp(req);
  const limit = await rateLimit('open', ip, 60, 600);
  if (!limit.allowed) return fail(res, 429, 'rate_limited', 'Too many attempts. Try again later.');

  const body = await readJson(req);
  const id = body.id;
  if (!isValidId(id)) return fail(res, 410, 'gone', 'This link has expired.');

  const redis = getRedis();

  if (await redis.get(K.pwLock(id))) {
    return fail(res, 423, 'locked', 'Too many wrong passwords. This link is locked for 10 minutes.');
  }

  const { state, doc } = await loadLive(id);
  if (state !== 'live' || doc.status === 'uploading') {
    return fail(res, 410, 'gone', 'This link has expired.');
  }

  // Single-use links are spent the moment they are first opened.
  if (doc.maxOpens === 1 && doc.openedAt) {
    await destroyDoc(id);
    return fail(res, 410, 'gone', 'This link has expired.');
  }

  if (doc.passwordHash) {
    const supplied = body.password;
    const good = typeof supplied === 'string' && supplied.length <= LIMITS.MAX_PASSWORD_CHARS
      ? await verifyPassword(supplied, doc.salt, doc.passwordHash)
      : false;
    if (!good) {
      const attempts = await redis.incr(K.pwFail(id));
      if (attempts === 1) await redis.expire(K.pwFail(id), LIMITS.PW_LOCK_SECONDS);
      if (attempts >= LIMITS.PW_MAX_ATTEMPTS) {
        await redis.set(K.pwLock(id), '1', { ex: LIMITS.PW_LOCK_SECONDS });
        await redis.del(K.pwFail(id));
        await recordSecurityAlert({
          type: 'doc_pw_lockout',
          route: '/api/open',
          actor: sha256(ip),
          detail: `Document ${id} locked after ${LIMITS.PW_MAX_ATTEMPTS} failed password attempts`,
        });
        return fail(res, 423, 'locked', 'Too many wrong passwords. This link is locked for 10 minutes.');
      }
      return fail(res, 401, 'bad_password', `Wrong password. ${LIMITS.PW_MAX_ATTEMPTS - attempts} attempts left.`);
    }
    await redis.del(K.pwFail(id));
  }

  const now = Date.now();
  const claim = await claimOpen(redis, id, doc, now);

  if (claim.expired) {
    await destroyDoc(id);
    return fail(res, 410, 'gone', 'This link has expired.');
  }

  // Lost the race on a single-use link: the other viewer has it.
  if (!claim.first && doc.maxOpens === 1) {
    return fail(res, 410, 'gone', 'This link has expired.');
  }

  const sid = randomToken(9);
  const token = signSession({ id, sid, expiresAt: claim.expiresAt });

  ok(res, {
    token,
    sid,
    expiresAt: claim.expiresAt,
    serverNow: Date.now(),
    pages: doc.pages,
    watermark: doc.watermark || '',
    expirySeconds: doc.expirySeconds,
  });
});
