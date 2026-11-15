import { wrap, methodGuard, readJson, fail, ok, send, clientIp, query } from './_lib/http.js';
import { sha256 } from './_lib/crypto.js';
import { rateLimit } from './_lib/ratelimit.js';
import { sendOtpEmail } from './_lib/mail.js';
import { serializePlan, effectiveUserPlan } from './_lib/plans.js';
import {
  normalizeEmail,
  generateOtpCode,
  storeOtp,
  checkOtp,
  findOrCreateUser,
  createAuthSession,
  revokeRequestSession,
  buildSessionCookie,
  buildLogoutCookie,
  buildMePayload,
} from './_lib/auth.js';

function resolveAction(req) {
  const q = query(req);
  if (typeof q.action === 'string' && q.action) return q.action;
  const path = String(req.url || '').split('?')[0];
  return path.replace(/^\/api\/auth\/?/, '').trim();
}

const UNIFORM_CODE_RESPONSE = {
  ok: true,
  message: 'If that address can receive mail, a 6-digit code is on its way.',
};

async function handleRequestCode(req, res) {
  if (!methodGuard(req, res, 'POST')) return;

  const ip = clientIp(req);
  const ipLimit = await rateLimit('auth_code_ip', ip, 12, 600);
  if (!ipLimit.allowed) {
    return fail(res, 429, 'rate_limited', 'Too many sign-in attempts. Please wait a few minutes.');
  }

  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!email) {
    return fail(res, 400, 'bad_email', 'Enter a valid email address.');
  }

  const emailHash = sha256(email);
  const emailLimit = await rateLimit('auth_code_em', emailHash, 5, 600);
  if (!emailLimit.allowed) {
    return fail(res, 429, 'rate_limited', 'Too many codes requested for this address. Wait 10 minutes and try again.');
  }

  const code = generateOtpCode();
  await storeOtp(emailHash, code);

  try {
    await sendOtpEmail({ to: email, code });
  } catch {
    // Never leak email delivery details or log the address/OTP.
    return fail(res, 502, 'mail_error', 'Could not send the verification email right now. Please try again.');
  }

  // Always return the exact same 200 payload whether or not an account exists.
  ok(res, UNIFORM_CODE_RESPONSE);
}

async function handleVerify(req, res) {
  if (!methodGuard(req, res, 'POST')) return;

  const ip = clientIp(req);
  const ipLimit = await rateLimit('auth_verify_ip', ip, 25, 600);
  if (!ipLimit.allowed) {
    return fail(res, 429, 'rate_limited', 'Too many verification attempts. Try again later.');
  }

  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.trim() : '';

  if (!email || !/^\d{6}$/.test(code)) {
    return fail(res, 400, 'bad_request', 'Enter your email and the 6-digit code.');
  }

  const emailHash = sha256(email);
  const result = await checkOtp(emailHash, code);

  if (result.status === 'locked') {
    return fail(res, 429, 'too_many_attempts', 'Too many wrong codes. Request a new code to continue.');
  }
  if (result.status !== 'ok') {
    return fail(res, 401, 'invalid_code', 'Invalid or expired verification code.');
  }

  const now = Date.now();
  const { user } = await findOrCreateUser(email, now);
  const session = await createAuthSession(user, emailHash, now);
  const status = effectiveUserPlan(user, now);

  send(
    res,
    200,
    {
      ok: true,
      email: user.email,
      plan: status.effectivePlan,
      basePlan: status.basePlan,
      credits: status.creditsLeft,
      limits: serializePlan(status.effectivePlan),
    },
    { 'Set-Cookie': buildSessionCookie(session.token) },
  );
}

async function handleLogout(req, res) {
  if (!methodGuard(req, res, 'POST')) return;
  await revokeRequestSession(req);
  send(res, 200, { ok: true }, { 'Set-Cookie': buildLogoutCookie() });
}

async function handleMe(req, res) {
  if (!methodGuard(req, res, 'GET')) return;
  const payload = await buildMePayload(req);
  ok(res, payload);
}

export default wrap(async (req, res) => {
  const action = resolveAction(req);
  if (action === 'request-code') return handleRequestCode(req, res);
  if (action === 'verify') return handleVerify(req, res);
  if (action === 'logout') return handleLogout(req, res);
  if (action === 'me') return handleMe(req, res);
  return fail(res, 404, 'not_found', 'Unknown auth endpoint.');
});
