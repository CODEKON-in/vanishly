import { getRedis, K } from './redis.js';

/**
 * Fixed-window counter. Fails open on Redis trouble: rate limiting must never
 * be the reason a legitimate upload breaks.
 */
export async function rateLimit(action, ip, max, windowSeconds) {
  try {
    const redis = getRedis();
    const key = K.rate(action, ip);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    return { allowed: count <= max, count };
  } catch {
    return { allowed: true, count: 0 };
  }
}
