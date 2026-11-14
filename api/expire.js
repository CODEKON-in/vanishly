import { wrap, methodGuard, readJson, ok, clientIp } from './_lib/http.js';
import { isValidId, verifySession, tokenMatchesHash } from './_lib/crypto.js';
import { readDoc, destroyDoc } from './_lib/doc.js';
import { rateLimit } from './_lib/ratelimit.js';

/**
 * Called by the viewer when its countdown hits zero (and on unload). The token
 * is accepted even once expired — that is exactly when this fires — but its
 * signature must still be valid, so a stranger cannot destroy someone's link.
 * Always answers 200 so the viewer never leaks whether the id existed.
 */
export default wrap(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;

  await rateLimit('expire', clientIp(req), 120, 600);

  const body = await readJson(req);
  const { id, token, ownerToken } = body;
  if (!isValidId(id)) return ok(res, { ok: true });

  const session = token ? verifySession(token, id, { allowExpired: true }) : null;
  let authorized = Boolean(session);

  if (!authorized && ownerToken) {
    const doc = await readDoc(id);
    authorized = Boolean(doc) && tokenMatchesHash(ownerToken, doc.ownerTokenHash);
  }

  if (authorized) await destroyDoc(id);

  ok(res, { ok: true });
});
