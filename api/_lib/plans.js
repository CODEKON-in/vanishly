import { getRedis, K, DAILY_COUNTER_TTL } from './redis.js';
import { sha256, verifyUserSession } from './crypto.js';
import { clientIp, send } from './http.js';

export const SESSION_COOKIE = 'vp_session';

/**
 * Single source of truth for every plan limit, capability, and price in Vanishly.
 * The server resolves the caller's plan on every request — never trust a plan
 * sent by the client.
 */
export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthlyInr: 0,
    priceYearlyInr: 0,
    maxPages: 10,
    maxTotalBytes: 5 * 1024 * 1024,          // 5 MB
    maxPageBytes: 1.5 * 1024 * 1024,         // 1.5 MB per rasterised JPEG page
    expiryChoices: [120, 300],               // 2 min, 5 min
    minExpirySeconds: 120,
    maxExpirySeconds: 300,
    defaultExpiry: 300,
    lifetimeChoices: [3600],                 // 1 hour if never opened
    maxLifetimeSeconds: 3600,
    defaultLifetime: 3600,
    linksPerDay: 3,
    password: false,
    watermark: false,
    multiOpen: false,
    maxOpensChoices: [1],
    defaultMaxOpens: 1,
    seenNotification: false,
    seenEmail: false,
    viewReport: 'none',                      // 'none' | 'basic' | 'full'
    remoteKill: false,
    vanishStyles: ['default'],
    vanishCustomColor: false,
    qrCode: false,
    perRecipientLinks: false,
    maxRecipients: 0,
    perPageTimers: false,
    replyBeforeVanish: false,
    customBranding: false,
    crossDeviceHistory: false,
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthlyInr: 49,
    priceYearlyInr: 399,
    studentMonthlyInr: 29,
    studentVerificationEnabled: false,       // flag reserved; verification flow not active yet
    maxPages: 50,
    maxTotalBytes: 25 * 1024 * 1024,         // 25 MB
    maxPageBytes: 1.5 * 1024 * 1024,
    expiryChoices: [30, 60, 120, 180, 300, 600, 900, 1800, 3600], // 30s – 1 hr
    minExpirySeconds: 30,
    maxExpirySeconds: 3600,
    defaultExpiry: 300,
    lifetimeChoices: [3600, 21600, 86400],   // up to 24 hours
    maxLifetimeSeconds: 86400,
    defaultLifetime: 3600,
    linksPerDay: 50,
    password: true,
    watermark: true,
    multiOpen: true,
    maxOpensChoices: [1, 0],                 // 1 = once, 0 = unlimited within timer
    defaultMaxOpens: 1,
    seenNotification: true,
    seenEmail: false,
    viewReport: 'basic',
    remoteKill: true,
    vanishStyles: ['default', 'ember', 'mist', 'shatter'], // 4 styles
    vanishCustomColor: false,
    qrCode: true,
    perRecipientLinks: true,
    maxRecipients: 3,
    perPageTimers: false,
    replyBeforeVanish: false,
    customBranding: false,
    crossDeviceHistory: true,
  },

  ultra: {
    id: 'ultra',
    name: 'Ultra',
    priceMonthlyInr: 149,
    priceYearlyInr: 1199,
    maxPages: 200,
    maxTotalBytes: 100 * 1024 * 1024,        // 100 MB
    maxPageBytes: 1.5 * 1024 * 1024,
    expiryChoices: [10, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 21600, 43200, 86400], // 10s – 24 hr
    minExpirySeconds: 10,
    maxExpirySeconds: 86400,
    defaultExpiry: 300,
    lifetimeChoices: [3600, 21600, 86400, 259200, 604800], // up to 7 days
    maxLifetimeSeconds: 604800,
    defaultLifetime: 3600,
    linksPerDay: Infinity,                   // unlimited
    password: true,
    watermark: true,
    multiOpen: true,
    maxOpensChoices: [1, 0],
    defaultMaxOpens: 1,
    seenNotification: true,
    seenEmail: true,
    viewReport: 'full',
    remoteKill: true,
    vanishStyles: ['default', 'ember', 'mist', 'shatter', 'vortex', 'glitch'],
    vanishCustomColor: true,
    qrCode: true,
    perRecipientLinks: true,
    maxRecipients: Infinity,                 // unlimited
    perPageTimers: true,
    replyBeforeVanish: true,
    customBranding: true,
    crossDeviceHistory: true,
  },
};

export const CREDIT_PACK = {
  id: 'credits_20',
  priceInr: 19,
  credits: 20,
  validMonths: 6,
  validMs: 180 * 24 * 60 * 60 * 1000,
  unlocksPlan: 'pro',
};

/** All valid expiry choices across any paid tier, used to detect tier violations vs garbage numbers. */
export const ALL_PAID_EXPIRY_CHOICES = new Set([
  ...PLANS.pro.expiryChoices,
  ...PLANS.ultra.expiryChoices,
]);

/** All valid lifetime choices across any paid tier. */
export const ALL_PAID_LIFETIME_CHOICES = new Set([
  ...PLANS.pro.lifetimeChoices,
  ...PLANS.ultra.lifetimeChoices,
]);

/** JSON-safe representation of a plan's limits & capabilities for client responses. */
export function serializePlan(planKey) {
  const p = PLANS[planKey] || PLANS.free;
  return {
    id: p.id,
    name: p.name,
    maxPages: p.maxPages,
    maxTotalBytes: p.maxTotalBytes,
    maxPageBytes: p.maxPageBytes,
    expiryChoices: p.expiryChoices,
    minExpirySeconds: p.minExpirySeconds,
    maxExpirySeconds: p.maxExpirySeconds,
    defaultExpiry: p.defaultExpiry,
    lifetimeChoices: p.lifetimeChoices,
    maxLifetimeSeconds: p.maxLifetimeSeconds,
    defaultLifetime: p.defaultLifetime,
    linksPerDay: Number.isFinite(p.linksPerDay) ? p.linksPerDay : null,
    unlimitedLinksPerDay: !Number.isFinite(p.linksPerDay),
    password: p.password,
    watermark: p.watermark,
    multiOpen: p.multiOpen,
    maxOpensChoices: p.maxOpensChoices,
    defaultMaxOpens: p.defaultMaxOpens,
    seenNotification: p.seenNotification,
    seenEmail: p.seenEmail,
    viewReport: p.viewReport,
    remoteKill: p.remoteKill,
    vanishStyles: p.vanishStyles,
    vanishCustomColor: p.vanishCustomColor,
    qrCode: p.qrCode,
    perRecipientLinks: p.perRecipientLinks,
    maxRecipients: Number.isFinite(p.maxRecipients) ? p.maxRecipients : null,
    perPageTimers: p.perPageTimers,
    replyBeforeVanish: p.replyBeforeVanish,
    customBranding: p.customBranding,
    crossDeviceHistory: p.crossDeviceHistory,
  };
}

/** Parse cookies from a Node IncomingMessage. */
export function parseCookies(req) {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string' || !header.length) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function readJsonRecord(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

/**
 * Compute a user's effective subscription plan and credit status at `now`.
 * Never deletes user data when a subscription lapses — simply resolves to 'free'.
 */
export function effectiveUserPlan(user, now = Date.now()) {
  if (!user) {
    return { basePlan: 'free', effectivePlan: 'free', usingCredit: false, creditsLeft: 0 };
  }
  let basePlan = user.plan === 'pro' || user.plan === 'ultra' ? user.plan : 'free';
  if (basePlan !== 'free' && user.planPeriodEnd && now >= Number(user.planPeriodEnd)) {
    basePlan = 'free';
  }

  let creditsLeft = Number.isInteger(user.credits) && user.credits > 0 ? user.credits : 0;
  if (creditsLeft > 0 && user.creditsExpiresAt && now >= Number(user.creditsExpiresAt)) {
    creditsLeft = 0;
  }

  if (basePlan === 'free' && creditsLeft > 0) {
    return {
      basePlan: 'free',
      effectivePlan: CREDIT_PACK.unlocksPlan,
      usingCredit: true,
      creditsLeft,
    };
  }

  return {
    basePlan,
    effectivePlan: basePlan,
    usingCredit: false,
    creditsLeft,
  };
}

/**
 * Resolve the authenticated user (if any) and the server-enforced plan for `req`.
 * Anonymous or invalid-session requests always resolve to `PLANS.free`.
 */
export async function resolvePlanContext(req, now = Date.now()) {
  const ipHash = sha256(clientIp(req));
  const cookies = parseCookies(req);
  const rawToken = cookies[SESSION_COOKIE];

  if (rawToken) {
    const verified = verifyUserSession(rawToken);
    if (verified) {
      const redis = getRedis();
      const sess = readJsonRecord(await redis.get(K.session(sha256(verified.sid))));
      if (sess && sess.uid === verified.uid && (!sess.expiresAt || now < sess.expiresAt)) {
        const user = readJsonRecord(await redis.get(K.user(sess.emailHash)));
        if (user && user.id === verified.uid) {
          const status = effectiveUserPlan(user, now);
          const planKey = status.effectivePlan;
          return {
            user,
            session: sess,
            basePlanKey: status.basePlan,
            planKey,
            plan: PLANS[planKey] || PLANS.free,
            usingCredit: status.usingCredit,
            creditsLeft: status.creditsLeft,
            actor: `u:${user.id}`,
          };
        }
      }
    }
  }

  return {
    user: null,
    session: null,
    basePlanKey: 'free',
    planKey: 'free',
    plan: PLANS.free,
    usingCredit: false,
    creditsLeft: 0,
    actor: `ip:${ipHash}`,
  };
}

export function utcDateKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Atomically increment and check the caller's daily link counter.
 * Keyed by user id (or hashed IP for anonymous users) + UTC YYYY-MM-DD, with a
 * 48-hour TTL so it expires on its own.
 */
export async function checkAndIncrementDailyLinks(actor, plan, now = Date.now()) {
  if (!Number.isFinite(plan.linksPerDay)) {
    return { allowed: true, count: 0, limit: null };
  }
  const redis = getRedis();
  const key = K.daily(actor, utcDateKey(now));
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, DAILY_COUNTER_TTL);
  }
  return {
    allowed: count <= plan.linksPerDay,
    count,
    limit: plan.linksPerDay,
  };
}

/**
 * Standardised 403 response for any plan limit or capability violation.
 */
export function planLimitError(res, limit, planKey, message, extra = {}) {
  send(res, 403, {
    error: 'plan_limit',
    limit,
    plan: planKey,
    message,
    upgradeUrl: '/pricing',
    ...extra,
  });
}
