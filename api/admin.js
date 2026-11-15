import { wrap, methodGuard, readJson, fail, ok, clientIp, query } from './_lib/http.js';
import { getRedis, K } from './_lib/redis.js';
import { sha256, isValidId } from './_lib/crypto.js';
import { readDoc, destroyDoc } from './_lib/doc.js';
import { rateLimit } from './_lib/ratelimit.js';
import { resolvePlanContext, effectiveUserPlan } from './_lib/plans.js';
import {
  normalizeEmail,
  readUserByEmailHash,
  findOrCreateUser,
  writeUser,
  revokeAllUserSessions,
} from './_lib/auth.js';
import {
  ROLES,
  PERMISSIONS,
  DEVELOPER_GRANTABLE_PERMISSIONS,
  isConfiguredOwnerEmail,
  resolveUserRoleAndPermissions,
  sanitizeDeveloperPermissions,
  hasPermission,
  isStaffRole,
} from './_lib/rbac.js';
import {
  readApiMetrics,
  readLogList,
  recordSecurityAlert,
  recordDevAudit,
  countActiveUsers,
  getAppSettings,
  saveAppSettings,
} from './_lib/telemetry.js';

function resolveAction(req) {
  const q = query(req);
  if (typeof q.action === 'string' && q.action) return q.action;
  const path = String(req.url || '').split('?')[0];
  return path.replace(/^\/api\/admin\/?/, '').trim();
}

async function requireStaff(req, res, requiredPerm = null) {
  const ctx = await resolvePlanContext(req);
  const ip = clientIp(req);
  const route = String(req.url || '/api/admin').split('?')[0];

  if (!ctx.user) {
    await recordSecurityAlert({
      type: 'unauthenticated_admin_access',
      route,
      actor: sha256(ip),
      detail: 'Unauthenticated request to developer endpoint',
    });
    fail(res, 401, 'unauthorized', 'Sign in with an authorized Owner or Developer account.');
    return null;
  }

  if (!isStaffRole(ctx.role)) {
    await recordSecurityAlert({
      type: 'unauthorized_admin_access',
      route,
      actor: ctx.user.id,
      detail: `User (${ctx.role}) attempted to access developer endpoint`,
    });
    fail(res, 403, 'forbidden', 'Developer or Owner privileges are required to access this resource.');
    return null;
  }

  if (requiredPerm && !hasPermission(ctx, requiredPerm)) {
    await recordSecurityAlert({
      type: 'permission_denied',
      route,
      actor: ctx.user.id,
      detail: `Role ${ctx.role} missing required permission: ${requiredPerm}`,
    });
    fail(res, 403, 'forbidden', `Insufficient permissions: requires "${requiredPerm}".`);
    return null;
  }

  return ctx;
}

function requireConfirm(body, res) {
  if (!body || body.confirm !== 'CONFIRM') {
    fail(res, 400, 'confirmation_required', 'This action requires confirmation. Pass { "confirm": "CONFIRM" }.');
    return false;
  }
  return true;
}

function sanitizeUserSummary(user, now = Date.now()) {
  const { role, permissions } = resolveUserRoleAndPermissions(user);
  const status = effectiveUserPlan(user, now);
  return {
    id: user.id,
    email: user.email,
    role,
    permissions,
    plan: status.effectivePlan,
    basePlan: status.basePlan,
    usingCredit: status.usingCredit,
    credits: status.creditsLeft,
    planPeriodEnd: user.planPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(user.cancelAtPeriodEnd),
    createdAt: user.createdAt || null,
  };
}

function sanitizeDocForInspector(doc) {
  if (!doc) return null;
  return {
    v: doc.v || 1,
    id: doc.id,
    plan: doc.plan || 'free',
    uid: doc.uid || null,
    name: doc.name || '',
    status: doc.status,
    createdAt: doc.createdAt || null,
    maxLifetimeAt: doc.maxLifetimeAt || null,
    expirySeconds: doc.expirySeconds || null,
    openedAt: doc.openedAt || null,
    expiresAt: doc.expiresAt || null,
    pages: doc.pages || 0,
    uploaded: doc.uploaded || 0,
    totalBytes: doc.totalBytes || 0,
    maxTotalBytes: doc.maxTotalBytes || 0,
    blobCount: Array.isArray(doc.blobUrls) ? doc.blobUrls.length : 0,
    hasWatermark: Boolean(doc.watermark),
    maxOpens: doc.maxOpens ?? 1,
    opens: doc.opens || 0,
    hasPassword: Boolean(doc.passwordHash),
  };
}

async function handleOverview(req, res) {
  if (!methodGuard(req, res, 'GET')) return;
  const ctx = await requireStaff(req, res, PERMISSIONS.OVERVIEW_READ);
  if (!ctx) return;

  const redis = getRedis();
  let dbConnected = false;
  let redisLatencyMs = null;
  try {
    const t0 = Date.now();
    const pong = await redis.ping();
    redisLatencyMs = Math.max(0, Date.now() - t0);
    dbConnected = pong === 'PONG' || Boolean(pong);
  } catch {
    dbConnected = false;
  }

  const now = Date.now();
  const [totalUsers, activeUsersToday, trackedDocs, settings, recentErrors, recentSecurity] = await Promise.all([
    redis.zcard(K.usersIndex),
    countActiveUsers(now),
    redis.zcard(K.index),
    getAppSettings(),
    readLogList(K.errorLogs, 5),
    readLogList(K.securityLogs, 5),
  ]);

  const mem = typeof process !== 'undefined' && typeof process.memoryUsage === 'function'
    ? process.memoryUsage()
    : { rss: 0, heapUsed: 0, heapTotal: 0 };

  ok(res, {
    ok: true,
    viewer: {
      id: ctx.user.id,
      email: ctx.user.email,
      role: ctx.role,
      permissions: ctx.permissions,
    },
    counts: {
      totalRegisteredUsers: Number(totalUsers || 0),
      activeUsersToday: Number(activeUsersToday || 0),
      trackedDocuments: Number(trackedDocs || 0),
      recentErrorCount: recentErrors.length,
      recentSecurityCount: recentSecurity.length,
    },
    health: {
      apiStatus: 'operational',
      dbConnected,
      redisLatencyMs,
      uptimeSeconds: typeof process !== 'undefined' && typeof process.uptime === 'function'
        ? Math.floor(process.uptime())
        : 0,
      nodeVersion: typeof process !== 'undefined' ? process.version : 'unknown',
      platform: typeof process !== 'undefined' ? process.platform : 'unknown',
      memory: {
        rssBytes: mem.rss || 0,
        heapUsedBytes: mem.heapUsed || 0,
        heapTotalBytes: mem.heapTotal || 0,
      },
    },
    integrations: {
      upstashRedis: Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
      vercelBlob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      vanishSecret: Boolean(process.env.VANISH_SECRET),
      sessionSecret: Boolean(process.env.SESSION_SECRET || process.env.VANISH_SECRET),
      resendMail: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
      razorpayBilling: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      razorpayWebhook: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
      ownerConfigured: Boolean(process.env.OWNER_EMAIL),
      cronSecret: Boolean(process.env.CRON_SECRET),
    },
    settings,
  });
}

async function handleMetrics(req, res) {
  if (!methodGuard(req, res, 'GET')) return;
  const ctx = await requireStaff(req, res, PERMISSIONS.METRICS_READ);
  if (!ctx) return;

  const metrics = await readApiMetrics();
  const mem = typeof process !== 'undefined' && typeof process.memoryUsage === 'function'
    ? process.memoryUsage()
    : { rss: 0, heapUsed: 0, heapTotal: 0 };

  ok(res, {
    ok: true,
    ...metrics,
    runtime: {
      uptimeSeconds: typeof process !== 'undefined' && typeof process.uptime === 'function'
        ? Math.floor(process.uptime())
        : 0,
      rssBytes: mem.rss || 0,
      heapUsedBytes: mem.heapUsed || 0,
      heapTotalBytes: mem.heapTotal || 0,
    },
  });
}

async function handleLogs(req, res) {
  if (!methodGuard(req, res, 'GET')) return;
  const ctx = await requireStaff(req, res);
  if (!ctx) return;

  const canReadLogs = hasPermission(ctx, PERMISSIONS.LOGS_READ);
  const canReadSecurity = hasPermission(ctx, PERMISSIONS.SECURITY_READ);

  if (!canReadLogs && !canReadSecurity) {
    return fail(res, 403, 'forbidden', 'Insufficient permissions to view logs.');
  }

  const [errorLogs, devAuditLogs, securityLogs] = await Promise.all([
    canReadLogs ? readLogList(K.errorLogs, 50) : Promise.resolve([]),
    canReadLogs ? readLogList(K.devAuditLogs, 50) : Promise.resolve([]),
    canReadSecurity ? readLogList(K.securityLogs, 50) : Promise.resolve([]),
  ]);

  ok(res, {
    ok: true,
    errorLogs,
    devAuditLogs,
    securityLogs,
  });
}

const KEYSPACE_SCHEMA = [
  { pattern: 'vp:doc:<id>', type: 'JSON string (TTL)', description: 'Active PDF metadata (redacted in inspector; expires with document lifetime).' },
  { pattern: 'vp:open:<id>', type: 'String (NX TTL)', description: 'Atomic first-open deadline claim.' },
  { pattern: 'vp:idx', type: 'Sorted Set (ZSET)', description: 'Secondary index of document IDs scored by maxLifetimeAt.' },
  { pattern: 'vp:user:<sha256(email)>', type: 'JSON string', description: 'Registered account record, role, permissions, subscription & credits.' },
  { pattern: 'vp:uid:<uid>', type: 'String', description: 'Reverse index from user ID to emailHash.' },
  { pattern: 'vp:users:idx', type: 'Sorted Set (ZSET)', description: 'Registered account index scored by account creation timestamp.' },
  { pattern: 'vp:sess:<sha256(sid)>', type: 'JSON string (30d TTL)', description: 'Server-side authenticated session record.' },
  { pattern: 'vp:usess:<uid>', type: 'Set', description: 'Active session ID hashes for instant session revocation.' },
  { pattern: 'vp:daily:<actor>:<YYYY-MM-DD>', type: 'Counter (48h TTL)', description: 'Per-day created link counter per user or IP.' },
  { pattern: 'vp:metrics:api:<YYYY-MM-DD>', type: 'Hash (7d TTL)', description: 'Real-time API request, status, error, and latency counters.' },
  { pattern: 'vp:logs:errors / security / dev', type: 'Capped List (max 100)', description: 'Sanitized error, security alert, and developer audit logs.' },
  { pattern: 'vp:settings:app', type: 'JSON string', description: 'Runtime application configuration flags.' },
];

async function handleDatabase(req, res) {
  if (req.method === 'GET') {
    const ctx = await requireStaff(req, res, PERMISSIONS.OVERVIEW_READ);
    if (!ctx) return;

    const redis = getRedis();
    const q = query(req);
    const docId = typeof q.docId === 'string' ? q.docId.trim() : '';

    let inspectedDoc = null;
    if (docId) {
      if (!hasPermission(ctx, PERMISSIONS.DATA_INSPECT)) {
        return fail(res, 403, 'forbidden', `Insufficient permissions: requires "${PERMISSIONS.DATA_INSPECT}".`);
      }
      if (!isValidId(docId)) {
        return fail(res, 400, 'bad_id', 'Invalid document ID format.');
      }
      const rawDoc = await readDoc(docId);
      inspectedDoc = sanitizeDocForInspector(rawDoc);
    }

    const [trackedDocs, registeredUsers, errorLogs, securityLogs, devAuditLogs] = await Promise.all([
      redis.zcard(K.index),
      redis.zcard(K.usersIndex),
      readLogList(K.errorLogs, 100),
      readLogList(K.securityLogs, 100),
      readLogList(K.devAuditLogs, 100),
    ]);

    return ok(res, {
      ok: true,
      schema: KEYSPACE_SCHEMA,
      counts: {
        trackedDocs: Number(trackedDocs || 0),
        registeredUsers: Number(registeredUsers || 0),
        errorLogEntries: errorLogs.length,
        securityLogEntries: securityLogs.length,
        devAuditEntries: devAuditLogs.length,
      },
      inspectedDoc,
    });
  }

  if (req.method === 'POST') {
    const ctx = await requireStaff(req, res, PERMISSIONS.DATA_INSPECT);
    if (!ctx) return;

    const body = await readJson(req);
    if (!requireConfirm(body, res)) return;

    const subAction = String(body.subAction || '');
    const redis = getRedis();
    const now = Date.now();

    if (subAction === 'cleanup_orphans') {
      const due = await redis.zrange(K.index, 0, now + 60 * 1000, { byScore: true });
      const candidates = Array.isArray(due) ? due.slice(0, 100) : [];
      let cleaned = 0;
      for (const id of candidates) {
        const doc = await readDoc(id);
        if (!doc || now >= (doc.maxLifetimeAt || 0) || (doc.expiresAt && now >= doc.expiresAt)) {
          await destroyDoc(id);
          cleaned++;
        }
      }
      await recordDevAudit({
        actorEmail: ctx.user.email,
        actorRole: ctx.role,
        action: 'database.cleanup_orphans',
        target: 'vp:idx',
        detail: `Swept ${cleaned} expired/orphaned documents`,
      });
      return ok(res, { ok: true, cleaned });
    }

    if (subAction === 'destroy_doc') {
      const docId = typeof body.docId === 'string' ? body.docId.trim() : '';
      if (!isValidId(docId)) {
        return fail(res, 400, 'bad_id', 'Provide a valid document ID to destroy.');
      }
      await destroyDoc(docId);
      await recordDevAudit({
        actorEmail: ctx.user.email,
        actorRole: ctx.role,
        action: 'database.destroy_doc',
        target: docId,
        detail: `Force-destroyed document ${docId}`,
      });
      return ok(res, { ok: true, docId });
    }

    return fail(res, 400, 'bad_request', 'Unknown database subAction.');
  }

  return methodGuard(req, res, ['GET', 'POST']);
}

async function handleUsers(req, res) {
  if (req.method === 'GET') {
    const ctx = await requireStaff(req, res, PERMISSIONS.USERS_READ);
    if (!ctx) return;

    const redis = getRedis();
    const emailHashes = await redis.zrange(K.usersIndex, 0, -1);
    const now = Date.now();
    const users = [];

    if (Array.isArray(emailHashes)) {
      for (const h of emailHashes) {
        const u = await readUserByEmailHash(h);
        if (u && u.email) {
          users.push(sanitizeUserSummary(u, now));
        }
      }
    }

    users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return ok(res, {
      ok: true,
      users,
      grantablePermissions: DEVELOPER_GRANTABLE_PERMISSIONS,
    });
  }

  if (req.method === 'POST') {
    const ctx = await requireStaff(req, res);
    if (!ctx) return;

    const body = await readJson(req);
    if (!requireConfirm(body, res)) return;

    const subAction = String(body.subAction || '');
    const email = normalizeEmail(body.email);
    if (!email) {
      return fail(res, 400, 'bad_email', 'Provide a valid user email address.');
    }

    const emailHash = sha256(email);
    const now = Date.now();

    if (subAction === 'set_role') {
      if (!hasPermission(ctx, PERMISSIONS.DEVS_MANAGE) || ctx.role !== ROLES.OWNER) {
        await recordSecurityAlert({
          type: 'privilege_escalation_attempt',
          route: '/api/admin/users',
          actor: ctx.user.id,
          detail: `Non-owner (${ctx.role}) attempted to modify roles/permissions for ${emailHash.slice(0, 10)}`,
        });
        return fail(res, 403, 'forbidden', 'Only the Owner account can manage Developer roles and permissions.');
      }

      if (isConfiguredOwnerEmail(email)) {
        return fail(res, 400, 'cannot_modify_owner', 'The Owner account role and permissions cannot be downgraded or modified.');
      }

      const newRole = String(body.role || '').toLowerCase();
      if (newRole === ROLES.OWNER) {
        return fail(res, 400, 'invalid_role', 'Cannot assign Owner role via API. Only the configured OWNER_EMAIL holds Owner privileges.');
      }
      if (newRole !== ROLES.USER && newRole !== ROLES.DEVELOPER) {
        return fail(res, 400, 'invalid_role', 'Role must be "user" or "developer".');
      }

      const { user } = await findOrCreateUser(email, now);
      user.role = newRole;
      user.permissions = newRole === ROLES.DEVELOPER
        ? sanitizeDeveloperPermissions(body.permissions)
        : [];
      await writeUser(emailHash, user);

      await recordDevAudit({
        actorEmail: ctx.user.email,
        actorRole: ctx.role,
        action: 'users.set_role',
        target: user.id,
        detail: `Set role=${newRole} permissions=[${user.permissions.join(',')}]`,
      });

      return ok(res, { ok: true, user: sanitizeUserSummary(user, now) });
    }

    if (subAction === 'set_plan') {
      if (!hasPermission(ctx, PERMISSIONS.USERS_WRITE)) {
        return fail(res, 403, 'forbidden', `Insufficient permissions: requires "${PERMISSIONS.USERS_WRITE}".`);
      }

      const user = await readUserByEmailHash(emailHash);
      if (!user) {
        return fail(res, 404, 'user_not_found', 'No registered user found with that email.');
      }

      const plan = String(body.plan || user.plan || 'free').toLowerCase();
      if (plan !== 'free' && plan !== 'pro' && plan !== 'ultra') {
        return fail(res, 400, 'bad_plan', 'Plan must be free, pro, or ultra.');
      }

      user.plan = plan;
      if (plan === 'free') {
        user.planPeriodEnd = null;
        user.cancelAtPeriodEnd = false;
      } else if (!user.planPeriodEnd || Number(user.planPeriodEnd) <= now) {
        user.planPeriodEnd = now + 31 * 86400 * 1000;
        user.cancelAtPeriodEnd = false;
      }

      if (body.credits !== undefined && body.credits !== null) {
        const c = Number(body.credits);
        if (Number.isInteger(c) && c >= 0 && c <= 10000) {
          user.credits = c;
          if (c > 0 && !user.creditsExpiresAt) {
            user.creditsExpiresAt = now + 180 * 86400 * 1000;
          }
        }
      }

      await writeUser(emailHash, user);
      await recordDevAudit({
        actorEmail: ctx.user.email,
        actorRole: ctx.role,
        action: 'users.set_plan',
        target: user.id,
        detail: `Updated plan=${user.plan} credits=${user.credits || 0}`,
      });

      return ok(res, { ok: true, user: sanitizeUserSummary(user, now) });
    }

    if (subAction === 'revoke_sessions') {
      if (!hasPermission(ctx, PERMISSIONS.USERS_WRITE)) {
        return fail(res, 403, 'forbidden', `Insufficient permissions: requires "${PERMISSIONS.USERS_WRITE}".`);
      }

      const user = await readUserByEmailHash(emailHash);
      if (!user) {
        return fail(res, 404, 'user_not_found', 'No registered user found with that email.');
      }

      if (resolveUserRoleAndPermissions(user).role === ROLES.OWNER && ctx.role !== ROLES.OWNER) {
        return fail(res, 403, 'forbidden', 'Cannot revoke sessions belonging to the Owner account.');
      }

      const revokedCount = await revokeAllUserSessions(user.id);
      await recordDevAudit({
        actorEmail: ctx.user.email,
        actorRole: ctx.role,
        action: 'users.revoke_sessions',
        target: user.id,
        detail: `Revoked ${revokedCount} active session(s)`,
      });

      return ok(res, { ok: true, revokedCount });
    }

    return fail(res, 400, 'bad_request', 'Unknown user management subAction.');
  }

  return methodGuard(req, res, ['GET', 'POST']);
}

async function handleSettings(req, res) {
  if (req.method === 'GET') {
    const ctx = await requireStaff(req, res, PERMISSIONS.SETTINGS_READ);
    if (!ctx) return;
    const settings = await getAppSettings();
    return ok(res, { ok: true, settings });
  }

  if (req.method === 'POST') {
    const ctx = await requireStaff(req, res, PERMISSIONS.SETTINGS_WRITE);
    if (!ctx) return;

    const body = await readJson(req);
    if (!requireConfirm(body, res)) return;

    const updated = await saveAppSettings({
      maintenanceMode: body.maintenanceMode,
      uploadsEnabled: body.uploadsEnabled,
      signupsEnabled: body.signupsEnabled,
      announcement: body.announcement,
    });

    await recordDevAudit({
      actorEmail: ctx.user.email,
      actorRole: ctx.role,
      action: 'settings.update',
      target: 'vp:settings:app',
      detail: `maintenance=${updated.maintenanceMode} uploads=${updated.uploadsEnabled} signups=${updated.signupsEnabled}`,
    });

    return ok(res, { ok: true, settings: updated });
  }

  return methodGuard(req, res, ['GET', 'POST']);
}

export default wrap(async (req, res) => {
  const ip = clientIp(req);
  const rl = await rateLimit('admin_api', ip, 120, 60);
  if (!rl.allowed) {
    return fail(res, 429, 'rate_limited', 'Too many admin API requests. Slow down.');
  }

  const action = resolveAction(req);
  if (action === 'overview') return handleOverview(req, res);
  if (action === 'metrics') return handleMetrics(req, res);
  if (action === 'logs') return handleLogs(req, res);
  if (action === 'database') return handleDatabase(req, res);
  if (action === 'users') return handleUsers(req, res);
  if (action === 'settings') return handleSettings(req, res);
  return fail(res, 404, 'not_found', 'Unknown admin endpoint.');
});
