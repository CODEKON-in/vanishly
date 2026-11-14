import { wrap, fail, ok } from './_lib/http.js';
import { getRedis, K } from './_lib/redis.js';
import { readDoc, destroyDoc, isExpiredDoc } from './_lib/doc.js';

const BATCH = 400;

/**
 * Daily cron safety net. Expiry is enforced lazily on every request, so this
 * only mops up documents nobody came back to: Redis TTL removed the record but
 * the page images in Blob storage would otherwise linger.
 */
export default wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const fromVercelCron = req.headers['x-vercel-cron'] === '1';

  if (secret) {
    if (auth !== `Bearer ${secret}`) return fail(res, 401, 'unauthorized', 'Unauthorized.');
  } else if (!fromVercelCron) {
    return fail(res, 401, 'unauthorized', 'Set CRON_SECRET to call this endpoint manually.');
  }

  const redis = getRedis();
  const now = Date.now();

  // Oldest-first by hard deadline; a doc whose record is gone is also swept.
  const ids = await redis.zrange(K.index, 0, BATCH - 1);
  const checked = Array.isArray(ids) ? ids : [];

  let destroyed = 0;
  let blobs = 0;

  for (const id of checked) {
    const doc = await readDoc(id);
    if (!doc) {
      blobs += await destroyDoc(id, { tombstone: false });
      destroyed += 1;
      continue;
    }
    if (isExpiredDoc(doc, now)) {
      blobs += await destroyDoc(id);
      destroyed += 1;
    }
  }

  ok(res, { checked: checked.length, destroyed, blobsRemoved: blobs, at: new Date(now).toISOString() });
});
