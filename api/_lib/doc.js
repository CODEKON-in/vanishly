import { del as blobDel } from '@vercel/blob';
import { getRedis, K, TOMBSTONE_TTL, BLOB_RECORD_GRACE } from './redis.js';

/** Fetch the raw doc record, or null if it no longer exists. */
export async function readDoc(id) {
  const redis = getRedis();
  const raw = await redis.get(K.doc(id));
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw; // Upstash may already have deserialised it
}

export async function writeDoc(id, doc, ttlSeconds) {
  const redis = getRedis();
  const ttl = Math.max(1, Math.ceil(ttlSeconds));
  await redis.set(K.doc(id), JSON.stringify(doc), { ex: ttl });
}

/** Remember a blob URL even if the doc record expires by TTL, so cleanup can still delete it. */
export async function recordBlob(id, url, hardExpiryMs) {
  const redis = getRedis();
  await redis.rpush(K.blobs(id), url);
  await redis.expire(K.blobs(id), Math.ceil((hardExpiryMs - Date.now()) / 1000) + BLOB_RECORD_GRACE);
  await redis.zadd(K.index, { score: hardExpiryMs, member: id });
}

async function listBlobs(id) {
  const redis = getRedis();
  try {
    const urls = await redis.lrange(K.blobs(id), 0, -1);
    return Array.isArray(urls) ? urls.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Physically delete every page image, then every trace of the document.
 * Safe to call repeatedly — blob deletion of an already-deleted blob is a no-op.
 */
export async function destroyDoc(id, { tombstone = true } = {}) {
  const redis = getRedis();
  const urls = await listBlobs(id);
  if (urls.length) {
    try {
      await blobDel(urls);
    } catch (err) {
      console.error('[vanishly] blob delete failed for', id, err?.message || '');
    }
  }
  await Promise.all([
    redis.del(K.doc(id)),
    redis.del(K.blobs(id)),
    redis.del(K.openClaim(id)),
    redis.del(K.pwFail(id)),
    redis.del(K.pwLock(id)),
    redis.zrem(K.index, id),
  ]);
  if (tombstone) {
    await redis.set(K.tomb(id), '1', { ex: TOMBSTONE_TTL });
  }
  return urls.length;
}

export function isExpiredDoc(doc, now = Date.now()) {
  if (!doc) return true;
  if (doc.maxLifetimeAt && now >= doc.maxLifetimeAt) return true;
  if (doc.expiresAt && now >= doc.expiresAt) return true;
  return false;
}

/**
 * The single lazy-expiry gate every request goes through. If the doc is past
 * either deadline, the request that noticed deletes the files there and then.
 * Returns { state: 'missing' | 'expired' | 'live', doc }.
 */
export async function loadLive(id) {
  const doc = await readDoc(id);
  if (!doc) return { state: 'missing', doc: null };
  if (isExpiredDoc(doc)) {
    await destroyDoc(id);
    return { state: 'expired', doc: null };
  }
  return { state: 'live', doc };
}

/** Seconds of Redis TTL a live doc should currently have. */
export function ttlFor(doc, now = Date.now()) {
  const deadline = doc.expiresAt
    ? Math.min(doc.expiresAt, doc.maxLifetimeAt)
    : doc.maxLifetimeAt;
  return Math.max(1, Math.ceil((deadline - now) / 1000));
}
