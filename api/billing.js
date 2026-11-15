import { wrap, methodGuard, readRawBody, readJson, fail, ok, send, clientIp, query } from './_lib/http.js';
import { getRedis, K } from './_lib/redis.js';
import { sha256 } from './_lib/crypto.js';
import { rateLimit } from './_lib/ratelimit.js';
import { CREDIT_PACK, resolvePlanContext } from './_lib/plans.js';
import { readUserById, writeUser } from './_lib/auth.js';
import {
  createSubscription,
  createCreditPackLink,
  cancelRazorpaySubscription,
  verifyWebhookSignature,
} from './_lib/razorpay.js';

const WEBHOOK_IDEMPOTENCY_TTL = 30 * 86400; // 30 days

function resolveAction(req) {
  const q = query(req);
  if (typeof q.action === 'string' && q.action) return q.action;
  const path = String(req.url || '').split('?')[0];
  return path.replace(/^\/api\/billing\/?/, '').trim();
}

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'vanishly-delta.vercel.app').split(',')[0].trim();
  return `${proto}://${host}`;
}

async function handleCheckout(req, res) {
  if (!methodGuard(req, res, 'POST')) return;

  const ip = clientIp(req);
  const rl = await rateLimit('billing_checkout', ip, 20, 600);
  if (!rl.allowed) return fail(res, 429, 'rate_limited', 'Too many checkout requests. Try again shortly.');

  const ctx = await resolvePlanContext(req);
  if (!ctx.user) {
    return fail(res, 401, 'unauthorized', 'Sign in first to purchase a plan or credit pack.');
  }

  const body = await readJson(req);
  const plan = String(body.plan || '').toLowerCase();
  const period = String(body.period || 'monthly').toLowerCase();

  let checkout = null;
  if (plan === 'credits') {
    const callbackUrl = `${originOf(req)}/account?paid=1`;
    checkout = await createCreditPackLink({ uid: ctx.user.id, callbackUrl });
  } else if ((plan === 'pro' || plan === 'ultra') && (period === 'monthly' || period === 'yearly')) {
    checkout = await createSubscription({ plan, period, uid: ctx.user.id });
  } else {
    return fail(res, 400, 'bad_request', 'Choose a valid plan (pro, ultra, or credits) and period (monthly or yearly).');
  }

  if (req.headers['x-checkout-mode'] === 'json') {
    return ok(res, { ok: true, id: checkout.id, url: checkout.shortUrl });
  }

  send(res, 302, { ok: true, id: checkout.id, url: checkout.shortUrl }, { Location: checkout.shortUrl });
}

async function handleWebhook(req, res) {
  if (!methodGuard(req, res, 'POST')) return;

  const ip = clientIp(req);
  const rl = await rateLimit('billing_webhook', ip, 120, 600);
  if (!rl.allowed) return fail(res, 429, 'rate_limited', 'Too many requests.');

  // CRITICAL: Verify signature against the raw request bytes BEFORE parsing JSON.
  const rawBuf = await readRawBody(req, 256 * 1024);
  const sig = req.headers['x-razorpay-signature'];
  if (!verifyWebhookSignature(rawBuf, sig)) {
    return fail(res, 401, 'invalid_signature', 'Webhook signature verification failed.');
  }

  let payload = null;
  try {
    payload = JSON.parse(rawBuf.toString('utf8'));
  } catch {
    return fail(res, 400, 'bad_request', 'Malformed webhook JSON.');
  }

  const eventId = String(
    req.headers['x-razorpay-event-id'] || payload.id || sha256(rawBuf.toString('utf8')),
  ).slice(0, 128);

  const redis = getRedis();
  const claimed = await redis.set(K.webhookEvent(eventId), '1', {
    nx: true,
    ex: WEBHOOK_IDEMPOTENCY_TTL,
  });

  if (claimed !== 'OK' && claimed !== true) {
    return ok(res, { ok: true, duplicate: true });
  }

  const event = String(payload.event || '');
  const now = Date.now();

  if (event === 'subscription.activated' || event === 'subscription.charged') {
    const sub = payload.payload?.subscription?.entity || {};
    const uid = sub.notes?.uid;
    const plan = sub.notes?.plan;
    const period = sub.notes?.period === 'yearly' ? 'yearly' : 'monthly';
    if (uid && (plan === 'pro' || plan === 'ultra')) {
      const record = await readUserById(uid);
      if (record) {
        const { user, emailHash } = record;
        const fallbackDays = period === 'yearly' ? 365 : 31;
        const periodEndMs = sub.current_end
          ? Number(sub.current_end) * 1000
          : now + fallbackDays * 86400 * 1000;
        user.plan = plan;
        user.planPeriodEnd = periodEndMs;
        user.cancelAtPeriodEnd = false;
        user.rzSubId = sub.id || user.rzSubId || null;
        await writeUser(emailHash, user);
      }
    }
  } else if (event === 'subscription.cancelled') {
    const sub = payload.payload?.subscription?.entity || {};
    const uid = sub.notes?.uid;
    if (uid) {
      const record = await readUserById(uid);
      if (record) {
        const { user, emailHash } = record;
        user.cancelAtPeriodEnd = true;
        if (sub.current_end) {
          user.planPeriodEnd = Math.max(user.planPeriodEnd || 0, Number(sub.current_end) * 1000);
        }
        if (sub.ended_at && Number(sub.ended_at) * 1000 <= now) {
          user.planPeriodEnd = Number(sub.ended_at) * 1000;
        }
        await writeUser(emailHash, user);
      }
    }
  } else if (event === 'subscription.halted') {
    const sub = payload.payload?.subscription?.entity || {};
    const uid = sub.notes?.uid;
    if (uid) {
      const record = await readUserById(uid);
      if (record) {
        const { user, emailHash } = record;
        user.planPeriodEnd = Math.min(user.planPeriodEnd || now, now);
        user.cancelAtPeriodEnd = true;
        await writeUser(emailHash, user);
      }
    }
  } else if (event === 'payment_link.paid') {
    const plink = payload.payload?.payment_link?.entity || {};
    const uid = plink.notes?.uid;
    if (uid) {
      const record = await readUserById(uid);
      if (record) {
        const { user, emailHash } = record;
        const activeCredits = Number.isInteger(user.credits)
          && user.credits > 0
          && (!user.creditsExpiresAt || now < Number(user.creditsExpiresAt))
          ? user.credits
          : 0;
        user.credits = activeCredits + CREDIT_PACK.credits;
        user.creditsExpiresAt = Math.max(Number(user.creditsExpiresAt || 0), now + CREDIT_PACK.validMs);
        await writeUser(emailHash, user);
      }
    }
  }

  ok(res, { ok: true, event });
}

async function handleCancel(req, res) {
  if (!methodGuard(req, res, 'POST')) return;

  const ip = clientIp(req);
  const rl = await rateLimit('billing_cancel', ip, 15, 600);
  if (!rl.allowed) return fail(res, 429, 'rate_limited', 'Too many requests.');

  const ctx = await resolvePlanContext(req);
  if (!ctx.user || !ctx.session?.emailHash) {
    return fail(res, 401, 'unauthorized', 'Sign in to manage your subscription.');
  }

  if (ctx.basePlanKey === 'free' || !ctx.user.rzSubId) {
    return fail(res, 400, 'no_subscription', 'No active subscription to cancel.');
  }

  await cancelRazorpaySubscription(ctx.user.rzSubId);
  ctx.user.cancelAtPeriodEnd = true;
  await writeUser(ctx.session.emailHash, ctx.user);

  ok(res, {
    ok: true,
    cancelAtPeriodEnd: true,
    plan: ctx.basePlanKey,
    planPeriodEnd: ctx.user.planPeriodEnd,
  });
}

export default wrap(async (req, res) => {
  const action = resolveAction(req);
  if (action === 'checkout') return handleCheckout(req, res);
  if (action === 'webhook') return handleWebhook(req, res);
  if (action === 'cancel') return handleCancel(req, res);
  return fail(res, 404, 'not_found', 'Unknown billing endpoint.');
});
