import { randomInt } from 'node:crypto';
import { getRedis, K } from './redis.js';
import {
  randomId,
  randomToken,
  sha256,
  safeEqual,
  signUserSession,
  verifyUserSession,
} from './crypto.js';
import {
  SESSION_COOKIE,
  parseCookies,
  effectiveUserPlan,
  serializePlan,
  resolvePlanContext,
} from './plans.js';
import {
  resolveUserRoleAndPermissions,
  isConfiguredOwnerEmail,
  ROLES,
} from './rbac.js';

export const OTP_TTL_SECONDS = 600;               // 10 minutes
export const OTP_MAX_ATTEMPTS = 5;
export const SESSION_TTL_SECONDS = 30 * 86400;    // 30 days

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  const clean = raw.trim().toLowerCase();
  if (clean.length < 5 || clean.length > 254) return '';
  if (!EMAIL_RE.test(clean)) return '';
  return clean;
}

export function generateOtpCode() {
  return String(randomInt(0, 1000000)).padStart(6, '0');
}

export function hashOtp(code, salt) {
  return sha256(`otp:${salt}:${code}`);
}

export function buildSessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildLogoutCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

export async function readUserByEmailHash(emailHash) {
  if (!emailHash) return null;
  const redis = getRedis();
  return parseJson(await redis.get(K.user(emailHash)));
}

export async function readUserById(uid) {
  if (!uid) return null;
  const redis = getRedis();
  const emailHash = await redis.get(K.userById(uid));
  if (!emailHash || typeof emailHash !== 'string') return null;
  const user = await readUserByEmailHash(emailHash);
  return user ? { user, emailHash } : null;
}

export async function writeUser(emailHash, user) {
  const redis = getRedis();
  const { role, permissions } = resolveUserRoleAndPermissions(user);
  user.role = role;
  user.permissions = role === ROLES.DEVELOPER ? permissions : [];
  await redis.set(K.user(emailHash), JSON.stringify(user));
  if (user.id) {
    await redis.set(K.userById(user.id), emailHash);
  }
  await redis.zadd(K.usersIndex, {
    score: Number(user.createdAt) || Date.now(),
    member: emailHash,
  });
}

export async function findOrCreateUser(email, now = Date.now()) {
  const clean = normalizeEmail(email);
  const emailHash = sha256(clean);
  let user = await readUserByEmailHash(emailHash);
  if (!user) {
    user = {
      id: `usr_${randomId(9)}`,
      email: clean,
      createdAt: now,
      role: isConfiguredOwnerEmail(clean) ? ROLES.OWNER : ROLES.USER,
      permissions: [],
      plan: 'free',
      planPeriodEnd: null,
      cancelAtPeriodEnd: false,
      rzSubId: null,
      credits: 0,
      creditsExpiresAt: null,
      studentEligible: false,
    };
    await writeUser(emailHash, user);
  } else {
    const resolved = resolveUserRoleAndPermissions(user);
    if (user.role !== resolved.role) {
      user.role = resolved.role;
    }
    await writeUser(emailHash, user);
  }
  return { user, emailHash };
}

export async function createAuthSession(user, emailHash, now = Date.now()) {
  const redis = getRedis();
  const sid = randomToken(24);
  const sidHash = sha256(sid);
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;
  const sessionRecord = {
    id: sid,
    uid: user.id,
    emailHash,
    createdAt: now,
    expiresAt,
  };
  await redis.set(K.session(sidHash), JSON.stringify(sessionRecord), { ex: SESSION_TTL_SECONDS });
  if (user.id) {
    await redis.sadd(K.userSessions(user.id), sidHash);
  }
  const token = signUserSession({ uid: user.id, sid, expiresAt });
  return { token, sid, expiresAt };
}

export async function revokeAllUserSessions(uid) {
  if (!uid) return 0;
  const redis = getRedis();
  const setKey = K.userSessions(uid);
  const sidHashes = await redis.smembers(setKey);
  let count = 0;
  if (Array.isArray(sidHashes)) {
    for (const h of sidHashes) {
      await redis.del(K.session(h));
      count++;
    }
  }
  await redis.del(setKey);
  return count;
}

export async function revokeRequestSession(req) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return false;
  const verified = verifyUserSession(raw);
  if (!verified) return false;
  const redis = getRedis();
  const sidHash = sha256(verified.sid);
  await redis.del(K.session(sidHash));
  if (verified.uid) {
    await redis.srem(K.userSessions(verified.uid), sidHash);
  }
  return true;
}

export async function storeOtp(emailHash, code, now = Date.now()) {
  const redis = getRedis();
  const salt = randomToken(16);
  const hash = hashOtp(code, salt);
  const record = {
    salt,
    hash,
    attempts: 0,
    createdAt: now,
    expiresAt: now + OTP_TTL_SECONDS * 1000,
  };
  await redis.set(K.otp(emailHash), JSON.stringify(record), { ex: OTP_TTL_SECONDS });
}

/**
 * Verify a 6-digit OTP against Redis.
 * Returns { status: 'ok' | 'invalid' | 'locked' }.
 */
export async function checkOtp(emailHash, suppliedCode, now = Date.now()) {
  const redis = getRedis();
  const key = K.otp(emailHash);
  const otp = parseJson(await redis.get(key));
  if (!otp || (otp.expiresAt && now >= otp.expiresAt)) {
    return { status: 'invalid' };
  }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await redis.del(key);
    return { status: 'locked' };
  }

  const expected = otp.hash;
  const actual = hashOtp(String(suppliedCode), otp.salt);
  if (!safeEqual(actual, expected)) {
    otp.attempts = Number(otp.attempts || 0) + 1;
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await redis.del(key);
      return { status: 'locked' };
    }
    const remainingSec = otp.expiresAt
      ? Math.max(1, Math.ceil((otp.expiresAt - now) / 1000))
      : OTP_TTL_SECONDS;
    await redis.set(key, JSON.stringify(otp), { ex: remainingSec });
    return { status: 'invalid', attemptsLeft: OTP_MAX_ATTEMPTS - otp.attempts };
  }

  await redis.del(key);
  return { status: 'ok' };
}

export async function loadUserLinks(uid, limit = 30) {
  const redis = getRedis();
  const rawList = await redis.zrange(K.userLinks(uid), 0, -1);
  if (!Array.isArray(rawList) || !rawList.length) return [];
  const parsed = [];
  for (const item of rawList) {
    const obj = parseJson(item);
    if (obj && obj.id) parsed.push(obj);
  }
  parsed.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return parsed.slice(0, limit);
}

export async function buildMePayload(req, now = Date.now()) {
  const ctx = await resolvePlanContext(req, now);
  if (!ctx.user) {
    return {
      authenticated: false,
      email: null,
      role: ROLES.USER,
      permissions: [],
      plan: 'free',
      basePlan: 'free',
      usingCredit: false,
      planPeriodEnd: null,
      cancelAtPeriodEnd: false,
      credits: 0,
      creditsExpiresAt: null,
      limits: serializePlan('free'),
      links: [],
    };
  }

  const status = effectiveUserPlan(ctx.user, now);
  const planKey = status.effectivePlan;
  const limits = serializePlan(planKey);
  const links = limits.crossDeviceHistory ? await loadUserLinks(ctx.user.id) : [];

  return {
    authenticated: true,
    email: ctx.user.email,
    role: ctx.role,
    permissions: ctx.permissions,
    plan: planKey,
    basePlan: status.basePlan,
    usingCredit: status.usingCredit,
    planPeriodEnd: ctx.user.planPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(ctx.user.cancelAtPeriodEnd),
    credits: status.creditsLeft,
    creditsExpiresAt: ctx.user.creditsExpiresAt || null,
    studentEligible: Boolean(ctx.user.studentEligible),
    limits,
    links,
  };
}

