import {
  wrap, methodGuard, readRawBody, fail, ok, clientIp, query, looksLikeJpeg, MAX_BODY_BYTES,
} from './_lib/http.js';
import { isValidId, tokenMatchesHash } from './_lib/crypto.js';
import { loadLive, writeDoc, recordBlob, ttlFor } from './_lib/doc.js';
import { putPage } from './_lib/blob.js';
import { rateLimit } from './_lib/ratelimit.js';
import { LIMITS } from './_lib/limits.js';
import { PLANS, planLimitError } from './_lib/plans.js';

export default wrap(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;

  const q = query(req);
  const id = q.id;
  const n = Number(q.n);
  const token = q.token || req.headers['x-upload-token'];

  if (!isValidId(id)) return fail(res, 400, 'bad_request', 'Invalid id.');
  if (!Number.isInteger(n) || n < 0 || n >= LIMITS.MAX_PAGES) {
    return fail(res, 400, 'bad_request', 'Invalid page index.');
  }

  const limit = await rateLimit('upload', clientIp(req), 600, 3600);
  if (!limit.allowed) return fail(res, 429, 'rate_limited', 'Too many requests. Try again later.');

  const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ctype !== 'image/jpeg') {
    return fail(res, 415, 'bad_type', 'Pages must be uploaded as image/jpeg.');
  }

  const { state, doc } = await loadLive(id);
  if (state !== 'live') return fail(res, 410, 'gone', 'This upload session has expired.');
  if (doc.status !== 'uploading') return fail(res, 409, 'already_finalized', 'This document is already finalized.');
  if (!tokenMatchesHash(token, doc.uploadTokenHash)) return fail(res, 403, 'forbidden', 'Invalid upload token.');
  if (n >= doc.pages) return fail(res, 400, 'bad_request', 'Page index is out of range.');
  if (doc.blobUrls[n]) return fail(res, 409, 'duplicate_page', 'That page was already uploaded.');

  const maxPageBytes = doc.maxPageBytes || LIMITS.MAX_PAGE_BYTES;
  const planKey = doc.plan || 'free';
  const maxTotalBytes = doc.maxTotalBytes || (PLANS[planKey] || PLANS.free).maxTotalBytes;

  const buf = await readRawBody(req, Math.min(MAX_BODY_BYTES, maxPageBytes + 1024));
  if (buf.length > maxPageBytes) {
    return fail(res, 413, 'page_too_large', 'That page image is too large. Re-encode it smaller.');
  }
  if (!looksLikeJpeg(buf)) {
    return fail(res, 400, 'bad_image', 'That upload is not a valid JPEG.');
  }
  if (doc.totalBytes + buf.length > maxTotalBytes) {
    const mb = Math.round(maxTotalBytes / (1024 * 1024));
    return planLimitError(res, 'total_bytes', planKey, `This document exceeds the ${mb} MB total upload limit for your plan.`, { max: maxTotalBytes });
  }

  const url = await putPage(id, n, buf);
  await recordBlob(id, url, doc.maxLifetimeAt);

  // Re-read right before writing: two pages can upload concurrently, and a
  // stale in-memory doc here would silently overwrite the other's blobUrls
  // entry (a lost update). This shrinks that window to near zero.
  const fresh = (await loadLive(id)).doc || doc;
  fresh.blobUrls[n] = url;
  fresh.uploaded = fresh.blobUrls.filter(Boolean).length;
  fresh.totalBytes = (fresh.totalBytes || 0) + buf.length;
  await writeDoc(id, fresh, ttlFor(fresh));

  const result = { uploaded: fresh.uploaded, pages: fresh.pages, totalBytes: fresh.totalBytes };

  ok(res, result);
});
