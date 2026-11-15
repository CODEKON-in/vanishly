/**
 * Email delivery provider (Resend HTTPS API).
 * Kept behind a single module so the provider can be swapped without touching
 * any auth or notification handler. Never logs an email address or OTP code.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export async function sendEmail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Vanishly <Auth@vanishly.app>';
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured.');
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [String(to)],
      subject: String(subject),
      text: String(text),
      ...(html ? { html: String(html) } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`Mail provider responded with status ${res.status}.`);
  }
  return { sent: true };
}

export async function sendOtpEmail({ to, code }) {
  const subject = `${code} is your Vanishly sign-in code`;
  const text = [
    `Your Vanishly verification code is: ${code}`,
    '',
    'This code expires in 10 minutes. If you did not request it, you can ignore this email.',
  ].join('\n');

  const html = [
    '<div style="font-family:sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#1D1530;background:#FFF6EA;border:2px solid #1D1530;border-radius:16px;">',
    '<h2 style="margin:0 0 12px;font-size:20px;">Your Vanishly sign-in code</h2>',
    '<p style="margin:0 0 16px;font-size:15px;color:#554A6B;">Enter this 6-digit code to sign in. It expires in 10 minutes.</p>',
    `<div style="font-family:monospace;font-size:28px;font-weight:700;letter-spacing:6px;padding:14px 18px;background:#FFD23F;border:2px solid #1D1530;border-radius:12px;text-align:center;">${code}</div>`,
    '<p style="margin:16px 0 0;font-size:12px;color:#6E6385;">If you did not request this email, you can safely ignore it.</p>',
    '</div>',
  ].join('');

  return sendEmail({ to, subject, text, html });
}
