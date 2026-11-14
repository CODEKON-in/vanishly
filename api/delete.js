import { wrap, methodGuard, readJson, fail, ok, clientIp } from './_lib/http.js';
import { isValidId, tokenMatchesHash } from './_lib/crypto.js';
import { readDoc, destroyDoc } from './_lib/doc.js';
import { rateLimit } from './_lib/ratelimit.js';

/**
 * Owner-initiated "Delete now", also used to clean up a failed upload so a
 * partial document never leaves orphan blobs behind.
 */
export default wrap(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;

  const limit = await rateLimit('delete', clientIp(req), 120, 600);
  if (!limit.allowed) return fail(res, 429, 'rate_limited', 'Too many requests.');

  const { id, ownerToken, uploadToken } = await readJson(req);
  if (!isValidId(id)) return fail(res, 400, 'bad_request', 'Invalid id.');

  const doc = await readDoc(id);
  if (!doc) {
    // Already gone (or never existed) — still sweep any orphaned blob records.
    await destroyDoc(id, { tombstone: false });
    return ok(res, { deleted: true });
  }

  const byOwner = tokenMatchesHash(ownerToken, doc.ownerTokenHash);
  const byUploader = tokenMatchesHash(uploadToken, doc.uploadTokenHash);
  if (!byOwner && !byUploader) return fail(res, 403, 'forbidden', 'Invalid token.');

  const removed = await destroyDoc(id);
  ok(res, { deleted: true, blobsRemoved: removed });
});
