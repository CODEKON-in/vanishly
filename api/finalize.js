import { wrap, methodGuard, readJson, fail, ok } from './_lib/http.js';
import { isValidId, tokenMatchesHash } from './_lib/crypto.js';
import { loadLive, writeDoc, ttlFor } from './_lib/doc.js';

export default wrap(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;

  const { id, uploadToken } = await readJson(req);
  if (!isValidId(id)) return fail(res, 400, 'bad_request', 'Invalid id.');

  const { state, doc } = await loadLive(id);
  if (state !== 'live') return fail(res, 410, 'gone', 'This upload session has expired.');
  if (!tokenMatchesHash(uploadToken, doc.uploadTokenHash)) {
    return fail(res, 403, 'forbidden', 'Invalid upload token.');
  }
  if (doc.status === 'ready' || doc.status === 'open') {
    return ok(res, { status: doc.status, pages: doc.pages });
  }

  const present = doc.blobUrls.filter(Boolean).length;
  if (present !== doc.pages) {
    return fail(res, 409, 'incomplete', `Only ${present} of ${doc.pages} pages were uploaded.`);
  }

  doc.status = 'ready';
  doc.uploadTokenHash = null; // one-shot: the upload token is dead from here on
  await writeDoc(id, doc, ttlFor(doc));

  ok(res, { status: 'ready', pages: doc.pages, maxLifetimeAt: doc.maxLifetimeAt });
});
