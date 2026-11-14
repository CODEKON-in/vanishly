import {
  randomBytes,
  createHmac,
  timingSafeEqual,
  scrypt as _scrypt,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

export function randomId(bytes = 9) {
  // 9 bytes -> 12 url-safe base64 chars, no padding
  return randomBytes(bytes).toString('base64url');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('base64url');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) {
    // still burn a comparison so length is the only signal
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Compare an opaque token against a stored sha256 hash, in constant time. */
export function tokenMatchesHash(token, hash) {
  if (!token || !hash) return false;
  return safeEqual(sha256(token), hash);
}

const SCRYPT_KEYLEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const derived = await scrypt(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return { salt, hash: derived.toString('base64url') };
}

export async function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const derived = await scrypt(String(password ?? ''), salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return safeEqual(derived.toString('base64url'), hash);
}

function secret() {
  const s = process.env.SECRET;
  if (!s || s.length < 16) {
    throw new Error('SECRET env var is missing or too short (need >= 16 chars).');
  }
  return s;
}

/**
 * Viewer session token: id + session id + absolute expiry, HMAC-signed.
 * Format: <id>.<sid>.<expMs>.<sig>
 */
export function signSession({ id, sid, expiresAt }) {
  const payload = `${id}.${sid}.${expiresAt}`;
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token, id, { allowExpired = false } = {}) {
  if (typeof token !== 'string' || token.length > 400) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [tid, sid, expRaw, sig] = parts;
  if (tid !== id) return null;
  const expected = createHmac('sha256', secret()).update(`${tid}.${sid}.${expRaw}`).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  const expiresAt = Number(expRaw);
  if (!Number.isFinite(expiresAt)) return null;
  if (!allowExpired && Date.now() >= expiresAt) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sid)) return null;
  return { id: tid, sid, expiresAt };
}

export function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{12}$/.test(id);
}
