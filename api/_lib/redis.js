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
  // Document lifecycle keys
  doc: (id) => `vp:doc:${id}`,
  blobs: (id) => `vp:blobs:${id}`,
  tomb: (id) => `vp:tomb:${id}`,
  openClaim: (id) => `vp:open:${id}`,
  pwFail: (id) => `vp:pwfail:${id}`,
  pwLock: (id) => `vp:pwlock:${id}`,
  rate: (action, ip) => `vp:rl:${action}:${ip}`,
  index: 'vp:index',

  // Accounts, sessions, OTPs, billing & plan limits
  // user(emailHash)     -> JSON { id, email, createdAt, plan, planPeriodEnd, cancelAtPeriodEnd, rzSubId, credits, creditsExpiresAt, studentEligible }
  user: (emailHash) => `vp:user:${emailHash}`,
  // userById(uid)       -> string emailHash (maps opaque user id back to user record)
  userById: (uid) => `vp:uid:${uid}`,
  // session(sidHash)    -> JSON { id, uid, emailHash, createdAt, expiresAt } with ~30d TTL
  session: (sidHash) => `vp:sess:${sidHash}`,
  // otp(emailHash)      -> JSON { salt, hash, attempts, createdAt } with 10m TTL
  otp: (emailHash) => `vp:otp:${emailHash}`,
  // daily(actor, ymd)   -> integer counter for links created on UTC date YYYY-MM-DD (48h TTL)
  //                        actor is `u:<uid>` for signed-in users or `ip:<sha256(ip)>` for anonymous
  daily: (actor, ymd) => `vp:daily:${actor}:${ymd}`,
  // webhookEvent(evtId) -> '1' with 30d TTL for idempotent Razorpay webhook processing
  webhookEvent: (evtId) => `vp:wh:${evtId}`,
  // userLinks(uid)      -> sorted set (score = createdAt ms) of JSON link summaries for paid cross-device history
  userLinks: (uid) => `vp:ulinks:${uid}`,
};

export const TOMBSTONE_TTL = 60 * 60 * 24; // 24h — lets expired links show the expired page
export const BLOB_RECORD_GRACE = 60 * 60 * 24 * 7; // blob list outlives the doc so cleanup can still find orphans
export const DAILY_COUNTER_TTL = 60 * 60 * 48; // 48h — expires automatically after the UTC day ends
