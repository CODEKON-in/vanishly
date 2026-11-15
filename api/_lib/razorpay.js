import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto.js';
import { CREDIT_PACK } from './plans.js';

const RAZORPAY_API = 'https://api.razorpay.com/v1';

function authHeader() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error('Razorpay API credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are not configured.');
  }
  const basic = Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');
  return `Basic ${basic}`;
}

export function getRazorpayPlanId(plan, period) {
  if (plan === 'pro' && period === 'monthly') return process.env.RAZORPAY_PLAN_PRO_MONTHLY || '';
  if (plan === 'pro' && period === 'yearly') return process.env.RAZORPAY_PLAN_PRO_YEARLY || '';
  if (plan === 'ultra' && period === 'monthly') return process.env.RAZORPAY_PLAN_ULTRA_MONTHLY || '';
  if (plan === 'ultra' && period === 'yearly') return process.env.RAZORPAY_PLAN_ULTRA_YEARLY || '';
  return '';
}

export async function createSubscription({ plan, period, uid }) {
  const planId = getRazorpayPlanId(plan, period);
  if (!planId) {
    throw new Error(`Razorpay plan ID env var for ${plan} (${period}) is not configured.`);
  }
  const totalCount = period === 'yearly' ? 10 : 120;
  const res = await fetch(`${RAZORPAY_API}/subscriptions`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      plan_id: planId,
      total_count: totalCount,
      quantity: 1,
      customer_notify: 1,
      notes: {
        uid: String(uid),
        plan: String(plan),
        period: String(period),
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Razorpay subscription creation failed (${res.status}).`);
  }
  const data = await res.json();
  return {
    id: data.id,
    shortUrl: data.short_url,
  };
}

export async function createCreditPackLink({ uid, callbackUrl }) {
  const res = await fetch(`${RAZORPAY_API}/payment_links`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: CREDIT_PACK.priceInr * 100, // paise
      currency: 'INR',
      description: 'Vanishly 20-link credit pack (Pro limits for 20 links, valid 6 months)',
      callback_url: callbackUrl,
      callback_method: 'get',
      notes: {
        uid: String(uid),
        pack: CREDIT_PACK.id,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Razorpay payment link creation failed (${res.status}).`);
  }
  const data = await res.json();
  return {
    id: data.id,
    shortUrl: data.short_url,
  };
}

export async function cancelRazorpaySubscription(rzSubId) {
  const res = await fetch(`${RAZORPAY_API}/subscriptions/${encodeURIComponent(rzSubId)}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cancel_at_cycle_end: 1 }),
  });

  if (!res.ok) {
    throw new Error(`Razorpay cancellation failed (${res.status}).`);
  }
  return { cancelled: true };
}

/**
 * Verify Razorpay's X-Razorpay-Signature against the raw request Buffer
 * BEFORE parsing the JSON body.
 */
export function verifyWebhookSignature(rawBuffer, signatureHeader) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || secret.length < 8) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET is not configured.');
  }
  if (!Buffer.isBuffer(rawBuffer) || !rawBuffer.length) return false;
  if (typeof signatureHeader !== 'string' || !signatureHeader.length) return false;
  const expected = createHmac('sha256', secret).update(rawBuffer).digest('hex');
  return safeEqual(signatureHeader.trim().toLowerCase(), expected.toLowerCase());
}

