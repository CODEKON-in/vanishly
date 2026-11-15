// In-memory stand-in for api/_lib/razorpay.js network calls, while keeping real HMAC webhook verification.
import { createHmac } from 'node:crypto';
import { safeEqual } from '../../api/_lib/crypto.js';

export const createdCheckouts = [];
export const cancelledSubscriptions = [];
let seq = 0;

export function getRazorpayPlanId(plan, period) {
  return `plan_stub_${plan}_${period}`;
}

export async function createSubscription({ plan, period, uid }) {
  seq += 1;
  const id = `sub_stub_${seq}`;
  const shortUrl = `https://rzp.io/i/${id}`;
  createdCheckouts.push({ type: 'subscription', id, shortUrl, plan, period, uid });
  return { id, shortUrl };
}

export async function createCreditPackLink({ uid, callbackUrl }) {
  seq += 1;
  const id = `plink_stub_${seq}`;
  const shortUrl = `https://rzp.io/i/${id}`;
  createdCheckouts.push({ type: 'payment_link', id, shortUrl, uid, callbackUrl });
  return { id, shortUrl };
}

export async function cancelRazorpaySubscription(rzSubId) {
  cancelledSubscriptions.push(rzSubId);
  return { cancelled: true };
}

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
