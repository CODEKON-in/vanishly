import { wrap, methodGuard, ok, query } from './_lib/http.js';
import { isValidId } from './_lib/crypto.js';
import { loadLive } from './_lib/doc.js';

/**
 * Read-only. Deliberately returns the SAME shape for "expired", "deleted" and
 * "never existed" so the response cannot be used to probe which ids are real.
 * Reading meta never starts the timer.
 */
export default wrap(async (req, res) => {
  if (!methodGuard(req, res, 'GET')) return;

  const { id } = query(req);
  if (!isValidId(id)) return ok(res, { status: 'expired' });

  const { state, doc } = await loadLive(id);
  if (state !== 'live') return ok(res, { status: 'expired' });

  if (doc.status === 'uploading') {
    // Upload never finished — treat as not available.
    return ok(res, { status: 'expired' });
  }

  if (doc.status === 'open') {
    const singleUse = doc.maxOpens === 1;
    if (singleUse) return ok(res, { status: 'expired' });
    return ok(res, {
      status: 'open',
      passwordRequired: Boolean(doc.passwordHash),
      pages: doc.pages,
      watermark: doc.watermark || '',
      expirySeconds: doc.expirySeconds,
      expiresAt: doc.expiresAt,
    });
  }

  ok(res, {
    status: 'ready',
    passwordRequired: Boolean(doc.passwordHash),
    pages: doc.pages,
    watermark: doc.watermark || '',
    expirySeconds: doc.expirySeconds,
    maxLifetimeAt: doc.maxLifetimeAt,
  });
});
