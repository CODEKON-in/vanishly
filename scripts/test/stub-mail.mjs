// In-memory stand-in for api/_lib/mail.js, used by selftest and devserver.
export const outbox = new Map(); // email -> { to, code, subject, text, sentAt }
export const sentEmails = [];

export async function sendEmail({ to, subject, text, html }) {
  const entry = { to: String(to).toLowerCase(), subject, text, html, sentAt: Date.now() };
  sentEmails.push(entry);
  outbox.set(entry.to, entry);
  return { sent: true };
}

export async function sendOtpEmail({ to, code }) {
  const clean = String(to).toLowerCase();
  const entry = {
    to: clean,
    code: String(code),
    subject: `${code} is your Vanishly sign-in code`,
    text: `Your Vanishly verification code is: ${code}`,
    sentAt: Date.now(),
  };
  sentEmails.push(entry);
  outbox.set(clean, entry);
  return { sent: true };
}

