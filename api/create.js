import { wrap, methodGuard, readJson, fail, send, clientIp } from './_lib/http.js';
import { getRedis, K } from './_lib/redis.js';
import { randomId, randomToken, sha256, hashPassword, isValidId } from './_lib/crypto.js';
import { writeDoc } from './_lib/doc.js';
import { rateLimit } from './_lib/ratelimit.js';
import { LIMITS } from './_lib/limits.js';
import {
  resolvePlanContext,
  checkAndIncrementDailyLinks,
  planLimitError,
  ALL_PAID_EXPIRY_CHOICES,
  ALL_PAID_LIFETIME_CHOICES,
} from './_lib/plans.js';
import { isStaffRole, ROLES } from './_lib/rbac.js';
import { getAppSettings } from './_lib/telemetry.js';

function pickChoice(value, choices, fallback) {
  const n = Number(value);
  return choices.includes(n) ? n : fallback;
}

export default wrap(async (req, res) => {
  if (!methodGuard(req, res, 'POST')) return;

  const ip = clientIp(req);
  const limit = await rateLimit('create', ip, 120, 3600);
  if (!limit.allowed) {
    return fail(res, 429, 'rate_limited', 'Too many uploads from this network. Try again later.');
  }

  const body = await readJson(req);
  const now = Date.now();

  // The SERVER resolves the plan from the authenticated session (or defaults to 'free').
  // Any `plan` field sent by the client is ignored.
  const { user, session, role, planKey, plan, actor, usingCredit } = await resolvePlanContext(req, now);

  const settings = await getAppSettings();
  if ((settings.maintenanceMode && !isStaffRole(role)) || (!settings.uploadsEnabled && role !== ROLES.OWNER)) {
    return fail(res, 503, 'maintenance', settings.announcement || 'Uploads are temporarily paused for maintenance.');
  }

  const pages = Number(body.pages);
  if (!Number.isInteger(pages) || pages < 1) {
    return fail(res, 400, 'bad_request', 'Page count is missing or invalid.');
  }
  if (pages > plan.maxPages) {
    return planLimitError(
      res,
      'pages',
      planKey,
      `This PDF has ${pages} pages. Your ${plan.name} plan allows up to ${plan.maxPages} pages.`,
      { max: plan.maxPages },
    );
  }

  if (body.expirySeconds !== undefined && body.expirySeconds !== null) {
    const reqExp = Number(body.expirySeconds);
    if (!plan.expiryChoices.includes(reqExp) && ALL_PAID_EXPIRY_CHOICES.has(reqExp)) {
      return planLimitError(
        res,
        'expiry',
        planKey,
        `That vanish timer is not available on the ${plan.name} plan.`,
      );
    }
  }
  const expirySeconds = pickChoice(body.expirySeconds, plan.expiryChoices, plan.defaultExpiry);

  if (body.maxLifetimeSeconds !== undefined && body.maxLifetimeSeconds !== null) {
    const reqLife = Number(body.maxLifetimeSeconds);
    if (!plan.lifetimeChoices.includes(reqLife) && ALL_PAID_LIFETIME_CHOICES.has(reqLife)) {
      return planLimitError(
        res,
        'lifetime',
        planKey,
        `That unread lifetime is not available on the ${plan.name} plan.`,
      );
    }
  }
  const lifetimeSeconds = pickChoice(body.maxLifetimeSeconds, plan.lifetimeChoices, plan.defaultLifetime);

  if (body.maxOpens !== undefined && body.maxOpens !== null) {
    const reqOpens = Number(body.maxOpens);
    if (reqOpens === 0 && !plan.multiOpen) {
      return planLimitError(
        res,
        'multi_open',
        planKey,
        'Multi-open links require the Pro or Ultra plan.',
      );
    }
  }
  const maxOpens = pickChoice(body.maxOpens, plan.maxOpensChoices, plan.defaultMaxOpens);

  let watermark = '';
  if (typeof body.watermark === 'string' && body.watermark.trim()) {
    if (!plan.watermark) {
      return planLimitError(
        res,
        'watermark',
        planKey,
        'Custom watermarks require the Pro or Ultra plan.',
      );
    }
    watermark = body.watermark.trim().slice(0, LIMITS.MAX_WATERMARK_CHARS);
  }

  let passwordHash = null;
  let salt = null;
  if (body.password !== undefined && body.password !== null && body.password !== '') {
    if (!plan.password) {
      return planLimitError(
        res,
        'password',
        planKey,
        'Password protection requires the Pro or Ultra plan.',
      );
    }
    const pw = String(body.password);
    if (pw.length < LIMITS.MIN_PASSWORD_CHARS || pw.length > LIMITS.MAX_PASSWORD_CHARS) {
      return fail(res, 400, 'bad_password', `Password must be ${LIMITS.MIN_PASSWORD_CHARS}-${LIMITS.MAX_PASSWORD_CHARS} characters.`);
    }
    const hashed = await hashPassword(pw);
    passwordHash = hashed.hash;
    salt = hashed.salt;
  }

  // Daily link cap is checked only after payload validation succeeds so rejected
  // requests do not burn a user's daily allowance.
  const daily = await checkAndIncrementDailyLinks(actor, plan, now);
  if (!daily.allowed) {
    return planLimitError(
      res,
      'links_per_day',
      planKey,
      `You have used all ${plan.linksPerDay} links for today on the ${plan.name} plan.`,
      { max: plan.linksPerDay },
    );
  }

  const id = randomId(9);
  if (!isValidId(id)) return fail(res, 500, 'server_error', 'Could not mint an id.');

  const redis = getRedis();

  // If this link was unlocked by a ₹19 credit pack, consume 1 credit now.
  if (usingCredit && user && session?.emailHash) {
    user.credits = Math.max(0, Number(user.credits || 0) - 1);
    await redis.set(K.user(session.emailHash), JSON.stringify(user));
  }

  const uploadToken = randomToken(32);
  const ownerToken = randomToken(32);
  const maxLifetimeAt = now + lifetimeSeconds * 1000;
  const docName = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';

  const doc = {
    v: 1,
    id,
    plan: planKey,
    uid: user?.id || null,
    name: docName,
    status: 'uploading',
    createdAt: now,
    maxLifetimeAt,
    expirySeconds,
    openedAt: null,
    expiresAt: null,
    pages,
    uploaded: 0,
    totalBytes: 0,
    maxTotalBytes: plan.maxTotalBytes,
    maxPageBytes: plan.maxPageBytes,
    blobUrls: [],
    watermark,
    maxOpens,
    opens: 0,
    passwordHash,
    salt,
    uploadTokenHash: sha256(uploadToken),
    ownerTokenHash: sha256(ownerToken),
  };

  await writeDoc(id, doc, lifetimeSeconds);
  await redis.zadd(K.index, { score: maxLifetimeAt, member: id });

  if (user && plan.crossDeviceHistory) {
    const summary = JSON.stringify({
      id,
      ownerToken,
      name: docName || 'Document',
      pages,
      expirySeconds,
      createdAt: now,
    });
    await redis.zadd(K.userLinks(user.id), { score: now, member: summary });
  }

  send(res, 201, {
    id,
    uploadToken,
    ownerToken,
    plan: planKey,
    pages,
    expirySeconds,
    maxLifetimeAt,
    maxOpens,
    passwordRequired: Boolean(passwordHash),
    limits: {
      maxPageBytes: plan.maxPageBytes,
      maxTotalBytes: plan.maxTotalBytes,
      maxPages: plan.maxPages,
    },
  });
});
