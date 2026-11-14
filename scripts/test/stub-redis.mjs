// In-memory stand-in for @upstash/redis covering exactly the commands the app
// uses. Semantics mirror Redis: TTLs, SET NX, INCR, list and sorted-set ops.
export const store = new Map(); // key -> { v, exp (ms) | null }

function now() { return Date.now(); }

function live(key) {
  const rec = store.get(key);
  if (!rec) return null;
  if (rec.exp !== null && rec.exp <= now()) { store.delete(key); return null; }
  return rec;
}

export class Redis {
  constructor() {}

  async get(key) {
    const rec = live(key);
    if (!rec) return null;
    if (typeof rec.v === 'string') {
      // Upstash transparently deserialises JSON payloads; mimic that.
      try { return JSON.parse(rec.v); } catch { return rec.v; }
    }
    return rec.v;
  }

  async set(key, value, opts = {}) {
    const existing = live(key);
    if (opts.nx && existing) return null;
    if (opts.xx && !existing) return null;
    const exp = opts.ex ? now() + opts.ex * 1000 : null;
    store.set(key, { v: value, exp });
    return 'OK';
  }

  async del(...keys) {
    let n = 0;
    for (const k of keys.flat()) if (store.delete(k)) n += 1;
    return n;
  }

  async incr(key) {
    const rec = live(key);
    const next = Number(rec?.v ?? 0) + 1;
    store.set(key, { v: String(next), exp: rec?.exp ?? null });
    return next;
  }

  async expire(key, seconds) {
    const rec = live(key);
    if (!rec) return 0;
    rec.exp = now() + seconds * 1000;
    return 1;
  }

  async rpush(key, ...values) {
    const rec = live(key);
    const list = Array.isArray(rec?.v) ? rec.v : [];
    list.push(...values.flat());
    store.set(key, { v: list, exp: rec?.exp ?? null });
    return list.length;
  }

  async lrange(key, start, stop) {
    const rec = live(key);
    const list = Array.isArray(rec?.v) ? rec.v : [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end);
  }

  async zadd(key, ...entries) {
    const rec = live(key);
    const set = rec?.v instanceof Map ? rec.v : new Map();
    for (const e of entries.flat()) set.set(e.member, e.score);
    store.set(key, { v: set, exp: rec?.exp ?? null });
    return 1;
  }

  async zrem(key, ...members) {
    const rec = live(key);
    if (!(rec?.v instanceof Map)) return 0;
    let n = 0;
    for (const m of members.flat()) if (rec.v.delete(m)) n += 1;
    return n;
  }

  async zrange(key, start, stop) {
    const rec = live(key);
    if (!(rec?.v instanceof Map)) return [];
    const sorted = [...rec.v.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
    return sorted.slice(start, end);
  }
}
