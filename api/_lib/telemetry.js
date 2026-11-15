import { getRedis, K, METRICS_TTL } from './redis.js';

export const DEFAULT_APP_SETTINGS = {
  maintenanceMode: false,
  uploadsEnabled: true,
  signupsEnabled: true,
  announcement: '',
  updatedAt: null,
  updatedBy: null,
};

function utcYmd(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

/**
 * Strip query strings, tokens, and email addresses from any log text so
 * sensitive values never enter error or security logs.
 */
export function sanitizeLogText(input, maxLen = 220) {
  if (!input) return '';
  return String(input)
    .replace(/\?[^\s"']+/g, '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\b/g, '[redacted-token]')
    .slice(0, maxLen);
}

export function normalizeRoute(rawUrl) {
  const path = String(rawUrl || '/').split('?')[0].trim() || '/';
  if (path.startsWith('/api/auth')) return '/api/auth';
  if (path.startsWith('/api/billing')) return '/api/billing';
  if (path.startsWith('/api/admin')) return '/api/admin';
  return path.slice(0, 64);
}

export async function recordApiMetric(rawUrl, method, statusCode, durationMs, now = Date.now()) {
  try {
    const redis = getRedis();
    const ymd = utcYmd(now);
    const key = K.apiMetrics(ymd);
    const route = normalizeRoute(rawUrl);
    const status = Number(statusCode) || 200;
    const statusBucket = status >= 500 ? '5xx' : status >= 400 ? '4xx' : '2xx';
    const ms = Math.max(0, Math.round(Number(durationMs) || 0));

    const total = await redis.hincrby(key, 'total|count', 1);
    if (total === 1) {
      await redis.expire(key, METRICS_TTL);
    }
    await Promise.all([
      redis.hincrby(key, `total|${statusBucket}`, 1),
      redis.hincrby(key, 'total|ms', ms),
      redis.hincrby(key, `route|${route}|count`, 1),
      redis.hincrby(key, `route|${route}|${statusBucket}`, 1),
      redis.hincrby(key, `route|${route}|ms`, ms),
    ]);
  } catch { /* telemetry must never break a request */ }
}

async function readSingleDayMetrics(redis, ymd) {
  const raw = (await redis.hgetall(K.apiMetrics(ymd))) || {};
  const totalCount = Number(raw['total|count'] || 0);
  const total2xx = Number(raw['total|2xx'] || 0);
  const total3xx = Number(raw['total|3xx'] || 0);
  const total4xx = Number(raw['total|4xx'] || 0);
  const total5xx = Number(raw['total|5xx'] || 0);
  const totalMs = Number(raw['total|ms'] || 0);

  const routeMap = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('route|')) continue;
    const parts = k.split('|');
    if (parts.length !== 3) continue;
    const [, route, metric] = parts;
    const entry = routeMap.get(route) || { route, count: 0, s2xx: 0, s4xx: 0, s5xx: 0, totalMs: 0 };
    const num = Number(v || 0);
    if (metric === 'count') entry.count = num;
    else if (metric === '2xx') entry.s2xx = num;
    else if (metric === '4xx') entry.s4xx = num;
    else if (metric === '5xx') entry.s5xx = num;
    else if (metric === 'ms') entry.totalMs = num;
    routeMap.set(route, entry);
  }

  const routes = [...routeMap.values()]
    .map((r) => ({
      route: r.route,
      requests: r.count,
      count: r.count,
      errors: r.s4xx + r.s5xx,
      s2xx: r.s2xx,
      s4xx: r.s4xx,
      s5xx: r.s5xx,
      avgLatencyMs: r.count > 0 ? Math.round((r.totalMs / r.count) * 10) / 10 : 0,
      avgMs: r.count > 0 ? Math.round((r.totalMs / r.count) * 10) / 10 : 0,
    }))
    .sort((a, b) => b.requests - a.requests);

  return {
    date: ymd,
    dateUtc: ymd,
    totalRequests: totalCount,
    status2xx: total2xx,
    status3xx: total3xx,
    status4xx: total4xx,
    status5xx: total5xx,
    s2xx: total2xx,
    s4xx: total4xx,
    s5xx: total5xx,
    avgLatencyMs: totalCount > 0 ? Math.round((totalMs / totalCount) * 10) / 10 : 0,
    routes,
  };
}

export async function readApiMetrics(now = Date.now()) {
  try {
    const redis = getRedis();
    const todayYmd = utcYmd(now);
    const yestYmd = utcYmd(now - 86400 * 1000);
    const [today, yesterday] = await Promise.all([
      readSingleDayMetrics(redis, todayYmd),
      readSingleDayMetrics(redis, yestYmd),
    ]);
    return {
      ...today,
      today,
      yesterday,
    };
  } catch {
    const empty = {
      date: utcYmd(now),
      dateUtc: utcYmd(now),
      totalRequests: 0,
      status2xx: 0,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
      s2xx: 0,
      s4xx: 0,
      s5xx: 0,
      avgLatencyMs: 0,
      routes: [],
    };
    return { ...empty, today: empty, yesterday: empty };
  }
}

export async function readLogList(key, limit = 50) {
  try {
    const redis = getRedis();
    const raw = await redis.lrange(key, 0, Math.max(0, limit - 1));
    if (!Array.isArray(raw)) return [];
    return raw.map(parseJson).filter(Boolean);
  } catch {
    return [];
  }
}

export async function recordErrorLog({ route, method, status = 500, code = 'server_error', message = '' }) {
  try {
    const redis = getRedis();
    const entry = {
      ts: Date.now(),
      route: normalizeRoute(route),
      method: String(method || 'POST').slice(0, 10),
      status: Number(status) || 500,
      code: String(code || 'server_error').slice(0, 48),
      message: sanitizeLogText(message),
    };
    await redis.lpush(K.errorLogs, JSON.stringify(entry));
    await redis.ltrim(K.errorLogs, 0, 99);
  } catch { /* ignore */ }
}

export async function readErrorLogs(limit = 50) {
  try {
    const redis = getRedis();
    const raw = await redis.lrange(K.errorLogs, 0, Math.max(0, limit - 1));
    if (!Array.isArray(raw)) return [];
    return raw.map(parseJson).filter(Boolean);
  } catch {
    return [];
  }
}

export async function recordSecurityAlert({ type, route, actor = 'anon', detail = '' }) {
  try {
    const redis = getRedis();
    const entry = {
      ts: Date.now(),
      type: String(type || 'security_event').slice(0, 48),
      route: normalizeRoute(route),
      actor: String(actor || 'anon').slice(0, 16),
      detail: sanitizeLogText(detail),
    };
    await redis.lpush(K.securityLogs, JSON.stringify(entry));
    await redis.ltrim(K.securityLogs, 0, 99);
  } catch { /* ignore */ }
}

export async function readSecurityLogs(limit = 50) {
  try {
    const redis = getRedis();
    const raw = await redis.lrange(K.securityLogs, 0, Math.max(0, limit - 1));
    if (!Array.isArray(raw)) return [];
    return raw.map(parseJson).filter(Boolean);
  } catch {
    return [];
  }
}

export async function recordDevAudit({ actorEmail, actorRole, action, target = '', detail = '' }) {
  try {
    const redis = getRedis();
    const actor = String(actorEmail || 'unknown').slice(0, 120);
    const role = String(actorRole || 'developer').slice(0, 24);
    const entry = {
      ts: Date.now(),
      actor,
      role,
      actorEmail: actor,
      actorRole: role,
      action: String(action || 'action').slice(0, 64),
      target: String(target || '').slice(0, 120),
      detail: sanitizeLogText(detail),
    };
    await redis.lpush(K.devAuditLogs, JSON.stringify(entry));
    await redis.ltrim(K.devAuditLogs, 0, 199);
  } catch { /* ignore */ }
}

export async function readDevAuditLogs(limit = 60) {
  try {
    const redis = getRedis();
    const raw = await redis.lrange(K.devAuditLogs, 0, Math.max(0, limit - 1));
    if (!Array.isArray(raw)) return [];
    return raw.map(parseJson).filter(Boolean);
  } catch {
    return [];
  }
}

export async function trackActiveUser(uid, now = Date.now()) {
  if (!uid) return;
  try {
    const redis = getRedis();
    const key = K.activeUsers(utcYmd(now));
    const added = await redis.sadd(key, String(uid));
    if (added === 1) {
      await redis.expire(key, METRICS_TTL);
    }
  } catch { /* ignore */ }
}

export async function countActiveUsers(now = Date.now()) {
  try {
    const redis = getRedis();
    return Number((await redis.scard(K.activeUsers(utcYmd(now)))) || 0);
  } catch {
    return 0;
  }
}

export async function getAppSettings() {
  try {
    const redis = getRedis();
    const stored = parseJson(await redis.get(K.appSettings));
    if (!stored || typeof stored !== 'object') {
      return { ...DEFAULT_APP_SETTINGS };
    }
    return {
      maintenanceMode: Boolean(stored.maintenanceMode),
      uploadsEnabled: stored.uploadsEnabled === undefined ? true : Boolean(stored.uploadsEnabled),
      signupsEnabled: stored.signupsEnabled === undefined ? true : Boolean(stored.signupsEnabled),
      announcement: typeof stored.announcement === 'string' ? stored.announcement.slice(0, 240) : '',
      updatedAt: stored.updatedAt || null,
      updatedBy: stored.updatedBy || null,
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export async function saveAppSettings(patch, actorEmail, now = Date.now()) {
  const current = await getAppSettings();
  const next = {
    maintenanceMode: patch.maintenanceMode !== undefined ? Boolean(patch.maintenanceMode) : current.maintenanceMode,
    uploadsEnabled: patch.uploadsEnabled !== undefined ? Boolean(patch.uploadsEnabled) : current.uploadsEnabled,
    signupsEnabled: patch.signupsEnabled !== undefined ? Boolean(patch.signupsEnabled) : current.signupsEnabled,
    announcement: patch.announcement !== undefined ? String(patch.announcement || '').trim().slice(0, 240) : current.announcement,
    updatedAt: now,
    updatedBy: actorEmail || current.updatedBy || null,
  };
  const redis = getRedis();
  await redis.set(K.appSettings, JSON.stringify(next));
  return next;
}
