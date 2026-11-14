import { Redis } from '@upstash/redis';

let client = null;

/**
 * The Vercel Marketplace Upstash integration injects either
 * KV_REST_API_URL / KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * depending on which version of the integration you install. Accept both.
 */
export function getRedis() {
  if (client) return client;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Redis is not configured (missing KV_REST_API_URL / KV_REST_API_TOKEN).');
  }
  client = new Redis({ url, token });
  return client;
}

export const K = {
  doc: (id) => `vp:doc:${id}`,
  blobs: (id) => `vp:blobs:${id}`,
  tomb: (id) => `vp:tomb:${id}`,
  openClaim: (id) => `vp:open:${id}`,
  pwFail: (id) => `vp:pwfail:${id}`,
  pwLock: (id) => `vp:pwlock:${id}`,
  rate: (action, ip) => `vp:rl:${action}:${ip}`,
  index: 'vp:index',
};

export const TOMBSTONE_TTL = 60 * 60 * 24; // 24h — lets expired links show the expired page
export const BLOB_RECORD_GRACE = 60 * 60 * 24 * 7; // blob list outlives the doc so cleanup can still find orphans
