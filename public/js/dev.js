const $ = (id) => document.getElementById(id);

const el = {
  devRoleBadge: $('dev-role-badge'),
  devLoginCard: $('dev-login-card'),
  devStepEmail: $('dev-step-email'),
  devEmail: $('dev-email'),
  devEmailErr: $('dev-email-err'),
  devSendCode: $('dev-send-code'),
  devStepCode: $('dev-step-code'),
  devCode0: $('dev-code-0'),
  devCode1: $('dev-code-1'),
  devCode2: $('dev-code-2'),
  devCode3: $('dev-code-3'),
  devCode4: $('dev-code-4'),
  devCode5: $('dev-code-5'),
  devCodeHint: $('dev-code-hint'),
  devCodeErr: $('dev-code-err'),
  devBackBtn: $('dev-back-btn'),
  devVerifyBtn: $('dev-verify-btn'),
  devDeniedCard: $('dev-denied-card'),
  deniedEmail: $('denied-email'),
  deniedLogoutBtn: $('denied-logout-btn'),
  devWorkspace: $('dev-workspace'),
  devViewerEmail: $('dev-viewer-email'),
  devViewerRole: $('dev-viewer-role'),
  devPermsSummary: $('dev-perms-summary'),
  devRefreshBtn: $('dev-refresh-btn'),
  devLogoutBtn: $('dev-logout-btn'),
  confirmArmCheck: $('confirm-arm-check'),
  devGlobalMsg: $('dev-global-msg'),
  devGlobalErr: $('dev-global-err'),
  sysHealthPill: $('sys-health-pill'),
  statTotalUsers: $('stat-total-users'),
  statActiveUsers: $('stat-active-users'),
  statTrackedDocs: $('stat-tracked-docs'),
  statDbStatus: $('stat-db-status'),
  statApiStatus: $('stat-api-status'),
  statUptime: $('stat-uptime'),
  integrationGrid: $('integration-grid'),
  errorLogsCount: $('error-logs-count'),
  errorLogsEmpty: $('error-logs-empty'),
  errorLogsList: $('error-logs-list'),
  apiDateLabel: $('api-date-label'),
  apiTotalReq: $('api-total-req'),
  api2xx: $('api-2xx'),
  api4xx: $('api-4xx'),
  api5xx: $('api-5xx'),
  apiRoutesBody: $('api-routes-body'),
  dbCleanupBtn: $('db-cleanup-btn'),
  dbSchemaBody: $('db-schema-body'),
  dbInspectInput: $('db-inspect-input'),
  dbInspectBtn: $('db-inspect-btn'),
  dbDestroyBtn: $('db-destroy-btn'),
  dbInspectOut: $('db-inspect-out'),
  usersCountLabel: $('users-count-label'),
  usersTableBody: $('users-table-body'),
  umEmail: $('um-email'),
  umPlan: $('um-plan'),
  umCredits: $('um-credits'),
  umSavePlanBtn: $('um-save-plan-btn'),
  umRevokeBtn: $('um-revoke-btn'),
  umRoleBox: $('um-role-box'),
  umRole: $('um-role'),
  umPermGrid: $('um-perm-grid'),
  umSaveRoleBtn: $('um-save-role-btn'),
  securityLogsEmpty: $('security-logs-empty'),
  securityLogsList: $('security-logs-list'),
  perfAvgMs: $('perf-avg-ms'),
  perfRss: $('perf-rss'),
  perfHeap: $('perf-heap'),
  perfNodeVer: $('perf-node-ver'),
  perfTodayReq: $('perf-today-req'),
  perfYestReq: $('perf-yest-req'),
  cfgMaintenance: $('cfg-maintenance'),
  cfgUploads: $('cfg-uploads'),
  cfgSignups: $('cfg-signups'),
  cfgAnnouncement: $('cfg-announcement'),
  cfgSaveBtn: $('cfg-save-btn'),
  auditLogsCount: $('audit-logs-count'),
  auditLogsEmpty: $('audit-logs-empty'),
  auditLogsList: $('audit-logs-list'),
};

const codeInputs = [
  el.devCode0,
  el.devCode1,
  el.devCode2,
  el.devCode3,
  el.devCode4,
  el.devCode5,
];

let pendingEmail = '';
let currentViewer = null;
let grantablePerms = [
  'overview:read',
  'logs:read',
  'metrics:read',
  'data:inspect',
  'users:read',
  'users:write',
  'settings:read',
  'settings:write',
  'security:read',
];

const PERM_LABELS = {
  'overview:read': 'System & DB Overview',
  'logs:read': 'View Error & Dev Logs',
  'metrics:read': 'API & Perf Metrics',
  'data:inspect': 'Inspect / Sweep Docs',
  'users:read': 'View Users',
  'users:write': 'Manage Plans & Sessions',
  'settings:read': 'Read App Settings',
  'settings:write': 'Modify App Settings',
  'security:read': 'View Security Audit',
};

function fmtTime(ms) {
  if (!ms) return '\u2014';
  try {
    return new Date(Number(ms)).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '\u2014';
  }
}

function fmtMB(bytes) {
  const n = Number(bytes || 0);
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(sec) {
  const s = Math.max(0, Number(sec || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function showBanner(msg, isError = false) {
  el.devGlobalMsg.hidden = isError;
  el.devGlobalErr.hidden = !isError;
  const target = isError ? el.devGlobalErr : el.devGlobalMsg;
  target.textContent = msg;
}

function clearBanners() {
  el.devGlobalMsg.hidden = true;
  el.devGlobalErr.hidden = true;
}

function getConfirmToken() {
  if (!el.confirmArmCheck.checked) {
    showBanner('Check "Arm destructive / write actions" in the top bar first to confirm this operation.', true);
    return null;
  }
  return 'CONFIRM';
}

async function api(path, { method = 'GET', json } = {}) {
  const init = { method, headers: {}, cache: 'no-store' };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.code = data?.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function renderPermissionCheckboxes(selected = []) {
  el.umPermGrid.textContent = '';
  const selectedSet = new Set(selected);
  for (const perm of grantablePerms) {
    const label = document.createElement('label');
    label.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = perm;
    cb.checked = selectedSet.has(perm);
    cb.dataset.perm = perm;
    const span = document.createElement('span');
    span.textContent = `${PERM_LABELS[perm] || perm} (${perm})`;
    label.append(cb, span);
    el.umPermGrid.append(label);
  }
}

function getSelectedPermissions() {
  const boxes = el.umPermGrid.querySelectorAll('input[type="checkbox"]');
  const out = [];
  for (const b of boxes) {
    if (b.checked && b.value) out.push(b.value);
  }
  return out;
}

function renderOverview(data) {
  if (!data) return;
  const c = data.counts || {};
  const h = data.health || {};

  el.statTotalUsers.textContent = String(c.totalRegisteredUsers ?? 0);
  el.statActiveUsers.textContent = String(c.activeUsersToday ?? 0);
  el.statTrackedDocs.textContent = String(c.trackedDocuments ?? 0);

  if (h.dbConnected) {
    el.statDbStatus.textContent = h.redisLatencyMs !== null
      ? `Connected (${h.redisLatencyMs} ms)`
      : 'Connected';
    el.sysHealthPill.className = 'pill live';
    el.sysHealthPill.textContent = 'Operational';
  } else {
    el.statDbStatus.textContent = 'Disconnected';
    el.sysHealthPill.className = 'pill dead';
    el.sysHealthPill.textContent = 'Degraded';
  }

  el.statApiStatus.textContent = h.apiStatus === 'operational' ? 'Operational' : String(h.apiStatus || 'Unknown');
  el.statUptime.textContent = fmtDuration(h.uptimeSeconds);

  const mem = h.memory || {};
  el.perfRss.textContent = fmtMB(mem.rssBytes);
  el.perfHeap.textContent = `${fmtMB(mem.heapUsedBytes)} / ${fmtMB(mem.heapTotalBytes)}`;
  el.perfNodeVer.textContent = `${h.nodeVersion || 'node'} (${h.platform || ''})`;

  // Integrations
  el.integrationGrid.textContent = '';
  const labels = [
    ['upstashRedis', 'Upstash Redis Store'],
    ['vercelBlob', 'Vercel Private Blob Store'],
    ['vanishSecret', 'HMAC Token Secret'],
    ['sessionSecret', 'Session Signing Secret'],
    ['ownerConfigured', 'Owner Account (OWNER_EMAIL)'],
    ['resendMail', 'Resend Email OTP API'],
    ['razorpayBilling', 'Razorpay Billing Keys'],
    ['razorpayWebhook', 'Razorpay Webhook Secret'],
    ['cronSecret', 'Daily Cleanup Cron Secret'],
  ];

  const integrations = data.integrations || {};
  for (const [key, label] of labels) {
    const item = document.createElement('div');
    item.className = 'dev-int-item';
    const name = document.createElement('span');
    name.textContent = label;
    const badge = document.createElement('span');
    const ok = Boolean(integrations[key]);
    badge.className = ok ? 'pill live' : 'pill waiting';
    badge.textContent = ok ? 'Configured' : 'Env Not Set';
    item.append(name, badge);
    el.integrationGrid.append(item);
  }

  if (data.settings) {
    renderSettings(data.settings);
  }
}

function renderSettings(s) {
  if (!s) return;
  el.cfgMaintenance.checked = Boolean(s.maintenanceMode);
  el.cfgUploads.checked = s.uploadsEnabled !== false;
  el.cfgSignups.checked = s.signupsEnabled !== false;
  el.cfgAnnouncement.value = s.announcement || '';
}

function renderMetrics(data) {
  if (!data) return;
  const t = data.today || {};
  const y = data.yesterday || {};

  el.apiDateLabel.textContent = `UTC ${t.date || ''}`;
  el.apiTotalReq.textContent = String(t.totalRequests ?? 0);
  el.api2xx.textContent = String((t.status2xx || 0) + (t.status3xx || 0));
  el.api4xx.textContent = String(t.status4xx ?? 0);
  el.api5xx.textContent = String(t.status5xx ?? 0);

  el.perfAvgMs.textContent = `${t.avgLatencyMs ?? 0} ms`;
  el.perfTodayReq.textContent = String(t.totalRequests ?? 0);
  el.perfYestReq.textContent = String(y.totalRequests ?? 0);

  el.apiRoutesBody.textContent = '';
  const routes = Array.isArray(t.routes) ? t.routes : [];
  if (!routes.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'tiny';
    td.textContent = 'No API requests recorded yet today.';
    tr.append(td);
    el.apiRoutesBody.append(tr);
    return;
  }

  for (const r of routes) {
    const tr = document.createElement('tr');
    const tdRoute = document.createElement('td');
    tdRoute.className = 'mono-cell';
    tdRoute.textContent = r.route;
    const tdReq = document.createElement('td');
    tdReq.textContent = String(r.requests || 0);
    const tdErr = document.createElement('td');
    tdErr.textContent = String(r.errors || 0);
    const tdLat = document.createElement('td');
    tdLat.textContent = `${r.avgLatencyMs || 0} ms`;
    tr.append(tdRoute, tdReq, tdErr, tdLat);
    el.apiRoutesBody.append(tr);
  }
}

function renderLogs(data) {
  if (!data) return;

  // 1. Error logs
  const errors = Array.isArray(data.errorLogs) ? data.errorLogs : [];
  el.errorLogsCount.textContent = `${errors.length} entries`;
  el.errorLogsList.textContent = '';
  el.errorLogsEmpty.hidden = errors.length > 0;
  for (const entry of errors) {
    const li = document.createElement('li');
    li.className = 'dev-log-item';
    const top = document.createElement('div');
    top.className = 'dev-log-top';
    const badge = document.createElement('span');
    badge.className = 'pill dead';
    badge.textContent = `${entry.status || 500} ${entry.code || 'error'}`;
    const route = document.createElement('span');
    route.className = 'mono-cell';
    route.textContent = entry.route || 'unknown';
    const time = document.createElement('span');
    time.className = 'tiny';
    time.textContent = fmtTime(entry.ts);
    top.append(badge, route, time);

    const msg = document.createElement('div');
    msg.className = 'tiny';
    msg.textContent = entry.message || '';
    li.append(top, msg);
    el.errorLogsList.append(li);
  }

  // 2. Security logs
  const sec = Array.isArray(data.securityLogs) ? data.securityLogs : [];
  el.securityLogsList.textContent = '';
  el.securityLogsEmpty.hidden = sec.length > 0;
  for (const entry of sec) {
    const li = document.createElement('li');
    li.className = 'dev-log-item';
    const top = document.createElement('div');
    top.className = 'dev-log-top';
    const badge = document.createElement('span');
    badge.className = 'pill waiting';
    badge.textContent = entry.type || 'security_alert';
    const route = document.createElement('span');
    route.className = 'mono-cell';
    route.textContent = `${entry.route || ''} \u00b7 actor:${entry.actor || 'anon'}`;
    const time = document.createElement('span');
    time.className = 'tiny';
    time.textContent = fmtTime(entry.ts);
    top.append(badge, route, time);

    const msg = document.createElement('div');
    msg.className = 'tiny';
    msg.textContent = entry.detail || '';
    li.append(top, msg);
    el.securityLogsList.append(li);
  }

  // 3. Developer activity audit logs
  const audits = Array.isArray(data.devAuditLogs) ? data.devAuditLogs : [];
  el.auditLogsCount.textContent = `${audits.length} actions`;
  el.auditLogsList.textContent = '';
  el.auditLogsEmpty.hidden = audits.length > 0;
  for (const entry of audits) {
    const li = document.createElement('li');
    li.className = 'dev-log-item';
    const top = document.createElement('div');
    top.className = 'dev-log-top';
    const badge = document.createElement('span');
    badge.className = 'pill live';
    badge.textContent = entry.action || 'action';
    const actor = document.createElement('span');
    actor.className = 'mono-cell';
    actor.textContent = `${entry.actor || ''} (${entry.role || ''}) \u2192 ${entry.target || ''}`;
    const time = document.createElement('span');
    time.className = 'tiny';
    time.textContent = fmtTime(entry.ts);
    top.append(badge, actor, time);

    const msg = document.createElement('div');
    msg.className = 'tiny';
    msg.textContent = entry.detail || '';
    li.append(top, msg);
    el.auditLogsList.append(li);
  }
}

function renderDatabase(data) {
  if (!data) return;
  el.dbSchemaBody.textContent = '';
  const schema = Array.isArray(data.schema) ? data.schema : [];
  for (const row of schema) {
    const tr = document.createElement('tr');
    const tdKey = document.createElement('td');
    tdKey.className = 'mono-cell';
    tdKey.textContent = row.pattern;
    const tdType = document.createElement('td');
    tdType.textContent = row.type;
    const tdDesc = document.createElement('td');
    tdDesc.className = 'tiny';
    tdDesc.textContent = row.description;
    tr.append(tdKey, tdType, tdDesc);
    el.dbSchemaBody.append(tr);
  }
}

function renderUsers(data) {
  if (!data) return;
  if (Array.isArray(data.grantablePermissions) && data.grantablePermissions.length) {
    grantablePerms = data.grantablePermissions;
  }
  renderPermissionCheckboxes(grantablePerms);

  const users = Array.isArray(data.users) ? data.users : [];
  el.usersCountLabel.textContent = `${users.length} account${users.length === 1 ? '' : 's'}`;
  el.usersTableBody.textContent = '';

  if (!users.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'tiny';
    td.textContent = 'No registered accounts found.';
    tr.append(td);
    el.usersTableBody.append(tr);
    return;
  }

  for (const u of users) {
    const tr = document.createElement('tr');

    const tdEmail = document.createElement('td');
    tdEmail.textContent = u.email;

    const tdRole = document.createElement('td');
    const rBadge = document.createElement('span');
    rBadge.className = `role-pill ${u.role || 'user'}`;
    rBadge.textContent = String(u.role || 'user').toUpperCase();
    tdRole.append(rBadge);

    const tdPlan = document.createElement('td');
    tdPlan.textContent = `${u.plan.toUpperCase()}${u.credits ? ` (${u.credits} cr)` : ''}`;

    const tdCreated = document.createElement('td');
    tdCreated.className = 'tiny';
    tdCreated.textContent = fmtTime(u.createdAt);

    const tdAct = document.createElement('td');
    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'btn sm ghost';
    selectBtn.textContent = 'Select';
    selectBtn.addEventListener('click', () => {
      el.umEmail.value = u.email;
      el.umPlan.value = u.basePlan || 'free';
      el.umCredits.value = String(u.credits || 0);
      if (u.role === 'developer' || u.role === 'user') {
        el.umRole.value = u.role;
      }
      renderPermissionCheckboxes(u.permissions || []);
      el.umEmail.focus();
    });
    tdAct.append(selectBtn);

    tr.append(tdEmail, tdRole, tdPlan, tdCreated, tdAct);
    el.usersTableBody.append(tr);
  }
}

async function loadDashboardData() {
  if (!currentViewer) return;
  const perms = new Set(currentViewer.permissions || []);
  const isOwner = currentViewer.role === 'owner';

  el.umRoleBox.hidden = !isOwner;

  const tasks = [];
  if (isOwner || perms.has('overview:read')) {
    tasks.push(api('/api/admin/overview').then(renderOverview).catch(() => {}));
    tasks.push(api('/api/admin/database').then(renderDatabase).catch(() => {}));
  }
  if (isOwner || perms.has('metrics:read')) {
    tasks.push(api('/api/admin/metrics').then(renderMetrics).catch(() => {}));
  }
  if (isOwner || perms.has('logs:read') || perms.has('security:read')) {
    tasks.push(api('/api/admin/logs').then(renderLogs).catch(() => {}));
  }
  if (isOwner || perms.has('users:read')) {
    tasks.push(api('/api/admin/users').then(renderUsers).catch(() => {}));
  }
  if (isOwner || perms.has('settings:read')) {
    tasks.push(api('/api/admin/settings').then((d) => renderSettings(d?.settings)).catch(() => {}));
  }

  await Promise.all(tasks);
}

async function bootSession() {
  clearBanners();
  try {
    const me = await api('/api/auth/me');
    if (!me?.authenticated) {
      currentViewer = null;
      el.devRoleBadge.hidden = true;
      el.devWorkspace.hidden = true;
      el.devDeniedCard.hidden = true;
      el.devLoginCard.hidden = false;
      return;
    }

    if (me.role !== 'owner' && me.role !== 'developer') {
      currentViewer = null;
      el.devRoleBadge.hidden = true;
      el.devLoginCard.hidden = true;
      el.devWorkspace.hidden = true;
      el.deniedEmail.textContent = me.email || '\u2014';
      el.devDeniedCard.hidden = false;
      return;
    }

    currentViewer = me;
    const roleUpper = me.role.toUpperCase();
    el.devRoleBadge.hidden = false;
    el.devRoleBadge.className = `role-pill ${me.role}`;
    el.devRoleBadge.textContent = roleUpper;

    el.devViewerEmail.textContent = me.email;
    el.devViewerRole.className = `role-pill ${me.role}`;
    el.devViewerRole.textContent = roleUpper;
    el.devPermsSummary.textContent = me.role === 'owner'
      ? 'Full Owner Authority (All Administrative & Developer Permissions)'
      : `Granular Developer Permissions: ${(me.permissions || []).join(', ') || 'none'}`;

    el.devLoginCard.hidden = true;
    el.devDeniedCard.hidden = true;
    el.devWorkspace.hidden = false;

    await loadDashboardData();
  } catch (err) {
    showBanner(err.message || 'Could not initialize Developer Dashboard.', true);
  }
}

// OTP Login Handlers on /dev
function clearOtpBoxes() {
  for (const box of codeInputs) {
    box.value = '';
    box.classList.remove('filled');
  }
}

function getOtpValue() {
  return codeInputs.map((b) => b.value.trim()).join('');
}

async function requestCode() {
  el.devEmailErr.hidden = true;
  const email = el.devEmail.value.trim();
  if (!email || !email.includes('@')) {
    el.devEmailErr.textContent = 'Enter a valid email address.';
    el.devEmailErr.hidden = false;
    return;
  }

  el.devSendCode.disabled = true;
  el.devSendCode.textContent = 'Sending\u2026';
  try {
    await api('/api/auth/request-code', { method: 'POST', json: { email } });
    pendingEmail = email;
    el.devCodeHint.textContent = `Sent to ${email}. Enter or paste the 6-digit code.`;
    el.devStepEmail.hidden = true;
    el.devStepCode.hidden = false;
    clearOtpBoxes();
    codeInputs[0].focus();
  } catch (err) {
    el.devEmailErr.textContent = err.message || 'Could not send verification code.';
    el.devEmailErr.hidden = false;
  } finally {
    el.devSendCode.disabled = false;
    el.devSendCode.textContent = 'Send 6-digit verification code';
  }
}

async function verifyCode() {
  el.devCodeErr.hidden = true;
  const code = getOtpValue();
  if (!/^\d{6}$/.test(code)) {
    el.devCodeErr.textContent = 'Enter all 6 digits of your verification code.';
    el.devCodeErr.hidden = false;
    return;
  }

  el.devVerifyBtn.disabled = true;
  el.devVerifyBtn.textContent = 'Verifying\u2026';
  try {
    await api('/api/auth/verify', { method: 'POST', json: { email: pendingEmail, code } });
    await bootSession();
  } catch (err) {
    el.devCodeErr.textContent = err.message || 'Invalid verification code.';
    el.devCodeErr.hidden = false;
  } finally {
    el.devVerifyBtn.disabled = false;
    el.devVerifyBtn.textContent = 'Verify & open dashboard';
  }
}

async function handleLogout() {
  try {
    await api('/api/auth/logout', { method: 'POST', json: {} });
  } finally {
    await bootSession();
  }
}

// Tool Actions
el.dbInspectBtn.addEventListener('click', async () => {
  clearBanners();
  const docId = el.dbInspectInput.value.trim();
  if (!docId) {
    showBanner('Enter a document ID to inspect.', true);
    return;
  }
  try {
    const res = await api(`/api/admin/database?docId=${encodeURIComponent(docId)}`);
    el.dbInspectOut.hidden = false;
    el.dbInspectOut.textContent = res.inspectedDoc
      ? JSON.stringify(res.inspectedDoc, null, 2)
      : 'Document not found or already vanished.';
  } catch (err) {
    showBanner(err.message, true);
  }
});

el.dbDestroyBtn.addEventListener('click', async () => {
  clearBanners();
  const docId = el.dbInspectInput.value.trim();
  if (!docId) {
    showBanner('Enter a document ID to destroy.', true);
    return;
  }
  const confirm = getConfirmToken();
  if (!confirm) return;

  try {
    await api('/api/admin/database', {
      method: 'POST',
      json: { subAction: 'destroy_doc', docId, confirm },
    });
    el.dbInspectOut.hidden = false;
    el.dbInspectOut.textContent = `Document ${docId} destroyed.`;
    showBanner(`Document ${docId} permanently destroyed.`);
    await loadDashboardData();
  } catch (err) {
    showBanner(err.message, true);
  }
});

el.dbCleanupBtn.addEventListener('click', async () => {
  clearBanners();
  const confirm = getConfirmToken();
  if (!confirm) return;
  try {
    const res = await api('/api/admin/database', {
      method: 'POST',
      json: { subAction: 'cleanup_orphans', confirm },
    });
    showBanner(`Index sweep complete: ${res.cleaned || 0} expired/orphaned document(s) removed.`);
    await loadDashboardData();
  } catch (err) {
    showBanner(err.message, true);
  }
});

el.umSavePlanBtn.addEventListener('click', async () => {
  clearBanners();
  const email = el.umEmail.value.trim();
  if (!email) {
    showBanner('Select or enter a target user email first.', true);
    return;
  }
  const confirm = getConfirmToken();
  if (!confirm) return;

  try {
    await api('/api/admin/users', {
      method: 'POST',
      json: {
        subAction: 'set_plan',
        email,
        plan: el.umPlan.value,
        credits: Number(el.umCredits.value || 0),
        confirm,
      },
    });
    showBanner(`Updated plan & credits for ${email}.`);
    await loadDashboardData();
  } catch (err) {
    showBanner(err.message, true);
  }
});

el.umRevokeBtn.addEventListener('click', async () => {
  clearBanners();
  const email = el.umEmail.value.trim();
  if (!email) {
    showBanner('Select or enter a target user email first.', true);
    return;
  }
  const confirm = getConfirmToken();
  if (!confirm) return;

  try {
    const res = await api('/api/admin/users', {
      method: 'POST',
      json: { subAction: 'revoke_sessions', email, confirm },
    });
    showBanner(`Revoked ${res.revokedCount || 0} active session(s) for ${email}.`);
    await loadDashboardData();
  } catch (err) {
    showBanner(err.message, true);
  }
});

el.umSaveRoleBtn.addEventListener('click', async () => {
  clearBanners();
  const email = el.umEmail.value.trim();
  if (!email) {
    showBanner('Select or enter a target user email first.', true);
    return;
  }
  const confirm = getConfirmToken();
  if (!confirm) return;

  try {
    const role = el.umRole.value;
    const permissions = getSelectedPermissions();
    await api('/api/admin/users', {
      method: 'POST',
      json: {
        subAction: 'set_role',
        email,
        role,
        permissions,
        confirm,
      },
    });
    showBanner(`Updated role (${role.toUpperCase()}) and granular permissions for ${email}.`);
    await loadDashboardData();
  } catch (err) {
    showBanner(err.message, true);
  }
});

el.cfgSaveBtn.addEventListener('click', async () => {
  clearBanners();
  const confirm = getConfirmToken();
  if (!confirm) return;

  try {
    const res = await api('/api/admin/settings', {
      method: 'POST',
      json: {
        maintenanceMode: el.cfgMaintenance.checked,
        uploadsEnabled: el.cfgUploads.checked,
        signupsEnabled: el.cfgSignups.checked,
        announcement: el.cfgAnnouncement.value.trim(),
        confirm,
      },
    });
    renderSettings(res.settings);
    showBanner('Runtime application settings saved.');
    await loadDashboardData();
  } catch (err) {
    showBanner(err.message, true);
  }
});

codeInputs.forEach((box, idx) => {
  box.addEventListener('input', () => {
    const clean = box.value.replace(/\D+/g, '').slice(-1);
    box.value = clean;
    box.classList.toggle('filled', clean.length === 1);
    if (clean && idx < codeInputs.length - 1) {
      codeInputs[idx + 1].focus();
    }
    if (getOtpValue().length === 6) {
      verifyCode();
    }
  });

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && idx > 0) {
      codeInputs[idx - 1].value = '';
      codeInputs[idx - 1].classList.remove('filled');
      codeInputs[idx - 1].focus();
    } else if (e.key === 'Enter' && getOtpValue().length === 6) {
      verifyCode();
    }
  });

  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const digits = (e.clipboardData?.getData('text') || '').replace(/\D+/g, '').slice(0, 6);
    if (!digits) return;
    for (let i = 0; i < codeInputs.length; i += 1) {
      const ch = digits[i] || '';
      codeInputs[i].value = ch;
      codeInputs[i].classList.toggle('filled', ch.length === 1);
    }
    const targetIdx = Math.min(digits.length, codeInputs.length - 1);
    codeInputs[targetIdx].focus();
    if (digits.length === 6) {
      verifyCode();
    }
  });
});

el.devSendCode.addEventListener('click', requestCode);
el.devEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') requestCode(); });
el.devBackBtn.addEventListener('click', () => {
  el.devStepCode.hidden = true;
  el.devStepEmail.hidden = false;
  el.devEmail.focus();
});
el.devVerifyBtn.addEventListener('click', verifyCode);
el.devRefreshBtn.addEventListener('click', loadDashboardData);
el.devLogoutBtn.addEventListener('click', handleLogout);
el.deniedLogoutBtn.addEventListener('click', handleLogout);

renderPermissionCheckboxes(grantablePerms);
bootSession();
